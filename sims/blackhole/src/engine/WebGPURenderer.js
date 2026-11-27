/**
 * WebGPURenderer.js — WebGPU rgba16float multi-pass HDR rendering pipeline for Gargantua:
 *  - Startup 3D Compute Shader 128x128x128 volume noise baker (NOISE_BAKE_COMPUTE_WGSL)
 *  - Pass 1: Relativistic Kerr geodesic ray-tracer (BLACKHOLE_WGSL) with Halton(2,3) jitter
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + subtle CA, vignette, film grain & sRGB composite
 */

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../../../../shared/shaders/common.wgsl.js';
import { BLACKHOLE_WGSL } from '../shaders/blackhole.wgsl.js';
import {
  SharedWebGPUPostPipeline,
  MAX_PROGRESSIVE_SAMPLES,
  MAX_FRAMES_IN_FLIGHT,
  halton,
  formatAdapterName,
  formatWgslMessages,
} from '../../../../shared/engine/SharedWebGPUPostPipeline.js';
import { createProceduralSkyTextureWebGPU } from '../../../../shared/assets/skyLoader.js';
import { createBlackbodyLUTWebGPU, createBlueNoiseLUTWebGPU } from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;

export class WebGPURenderer {
  constructor({ canvas, adapter, adapterInfo, device, context, canvasFormat, hdrFormat, onDeviceLost }) {
    this.canvas = canvas;
    this.adapter = adapter;
    this.adapterInfo = adapterInfo;
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.onDeviceLost = onDeviceLost;

    this.errors = [];
    this.shaderStatus = {};
    this.volumeBaked = false;
    this.skyMapLoaded = false;
    this.skyDimensions = [2048, 1024];
    this.hdrFormat = hdrFormat || 'rgba16float';
    this.rendererName = formatAdapterName(adapterInfo);

    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.resolutionScale = 1.0;

    this.frameIndex = 0;
    this.sampleCount = 0;
    this._hardReset = true;
    this._postDirty = true;
    this._wasProgressive = false;
    this._disposed = false;
    this._inFlight = 0;
    this._useQueueBackpressure = true;

    this.bhBindGroup = null;
    this.post = null;

    // CPU-side uniform scratch views (304 bytes = 19 vec4 slots for BlackholeUniforms)
    this._bhBufData = new ArrayBuffer(304);
    this._bhF32 = new Float32Array(this._bhBufData);
    this._bhI32 = new Int32Array(this._bhBufData);
  }

  /**
   * Asynchronously initializes WebGPU adapter/device, compiles all WGSL shaders & pipelines,
   * bakes the 128^3 3D volumetric noise texture on GPU compute, and prepares HDR render targets.
   * @param {HTMLCanvasElement} canvas
   * @param {{ onDeviceLost?: (info: GPUDeviceLostInfo) => void }} [options]
   * @returns {Promise<WebGPURenderer>}
   */
  static async create(canvas, options = {}) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new Error(
        'WebGPU (navigator.gpu) is unavailable in this browser. Launch via ./launch.sh or ./launch.sh --firefox.'
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new Error(
        'No WebGPU GPU adapter found. On Linux Wayland + NVIDIA laptops, run ./launch.sh.'
      );
    }

    const rawInfo = adapter.info || {};
    const adapterInfo = {
      vendor: rawInfo.vendor || '',
      architecture: rawInfo.architecture || '',
      device: rawInfo.device || '',
      description: rawInfo.description || '',
      isFallbackAdapter: Boolean(rawInfo.isFallbackAdapter ?? adapter.isFallbackAdapter),
    };

    const requiredFeatures = [];
    if (adapter.features?.has('rg11b10ufloat-renderable')) {
      requiredFeatures.push('rg11b10ufloat-renderable');
    }

    const device = await adapter.requestDevice(
      requiredFeatures.length > 0 ? { requiredFeatures } : undefined
    );
    const hdrFormat = device.features?.has('rg11b10ufloat-renderable')
      ? 'rg11b10ufloat'
      : 'rgba16float';
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Could not acquire a WebGPU canvas context.');
    }

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format: canvasFormat,
      alphaMode: 'opaque',
    });

    const renderer = new WebGPURenderer({
      canvas,
      adapter,
      adapterInfo,
      device,
      context,
      canvasFormat,
      hdrFormat,
      onDeviceLost: options.onDeviceLost,
    });

    device.addEventListener?.('uncapturederror', (event) => {
      const msg = `[WebGPURenderer] Uncaptured GPU error: ${event?.error?.message || String(event?.error)}`;
      console.error(msg);
      if (!renderer.errors.includes(msg)) {
        renderer.errors.push(msg);
      }
    });

    device.lost.then((info) => {
      if (renderer._disposed) return;
      const msg = `WebGPU device lost (${info?.reason || 'unknown'}): ${info?.message || 'GPU reset'}`;
      console.error('[WebGPURenderer]', msg);
      if (!renderer.errors.includes(msg)) {
        renderer.errors.push(msg);
      }
      renderer.onDeviceLost?.(info);
    });

    await renderer._initResourcesAndPipelines();
    return renderer;
  }

  async _compileModule(name, code, recordStatus = true) {
    const mod = this.device.createShaderModule({ label: `${name}-wgsl`, code });
    const info = await mod.getCompilationInfo();
    const errText = formatWgslMessages(name, info.messages);
    if (errText) {
      console.error(errText);
      this.errors.push(errText);
      if (recordStatus) {
        this.shaderStatus[name] = { ok: false, error: errText };
      }
      return null;
    }
    if (recordStatus) {
      this.shaderStatus[name] = { ok: true, error: null };
    }
    return mod;
  }

  async _initResourcesAndPipelines() {
    const device = this.device;

    // 1. Samplers
    this.sLinearClamp = device.createSampler({
      label: 'linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.sVolumeRepeat = device.createSampler({
      label: 'volume-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });

    this.sSkyAniso = device.createSampler({
      label: 'sky-aniso',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8,
    });

    // 2. Compile & validate all WGSL shader modules
    device.pushErrorScope('validation');
    const [modNoise, modMipmap, modBlackhole] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('blackhole', BLACKHOLE_WGSL, true),
    ]);

    // 3. Explicit Bind Group Layouts & Pipelines
    if (modNoise) {
      this.noiseBgl = device.createBindGroupLayout({
        label: 'noise-bake-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' },
          },
        ],
      });
      this.noisePipeline = device.createComputePipeline({
        label: 'noise-bake-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.noiseBgl] }),
        compute: { module: modNoise, entryPoint: 'main' },
      });
    }

    if (modMipmap) {
      this.mipmapBgl = device.createBindGroupLayout({
        label: 'mipmap-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.mipmapPipeline = device.createRenderPipeline({
        label: 'mipmap-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.mipmapBgl] }),
        vertex: { module: modMipmap, entryPoint: 'vs_main' },
        fragment: {
          module: modMipmap,
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    if (modBlackhole) {
      this.bhBgl = device.createBindGroupLayout({
        label: 'blackhole-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      this.bhPipeline = device.createRenderPipeline({
        label: 'blackhole-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.bhBgl] }),
        vertex: { module: modBlackhole, entryPoint: 'vs_main' },
        fragment: {
          module: modBlackhole,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    this.post = new SharedWebGPUPostPipeline({
      device,
      context: this.context,
      canvasFormat: this.canvasFormat,
      hdrFormat: this.hdrFormat,
      sLinearClamp: this.sLinearClamp,
      opticsProfile: 'default',
    });
    await this.post.init((name, code, record) => this._compileModule(name, code, record));

    const validationErr = await device.popErrorScope();
    if (validationErr) {
      const msg = `[WebGPURenderer] Pipeline creation validation error: ${validationErr.message}`;
      console.error(msg);
      this.errors.push(msg);
    }

    // 4. Physics Uniform Buffer
    this.bhUniformBuf = device.createBuffer({
      label: 'bh-ubo',
      size: 304,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 5. Static Physical LUTs + Procedural Sky + 3D Compute Volume Bake
    const blackbodyRes = createBlackbodyLUTWebGPU(device, 512);
    this.blackbodyTex = blackbodyRes.texture;
    this.blackbodyView = blackbodyRes.view;

    this.blueNoiseTex = createBlueNoiseLUTWebGPU(device, 128);
    this.blueNoiseView = this.blueNoiseTex.createView();

    this.procSkyTex = createProceduralSkyTextureWebGPU(
      device,
      (t, w, h, m) => this.generateMipmaps(t, w, h, m),
      2048,
      1024
    );
    this.procSkyView = this.procSkyTex.createView();
    this.skyTex = this.procSkyTex;
    this.skyView = this.procSkyView;

    this.volumeNoiseTex = this._bakeVolumeNoise();
    this.volumeNoiseView = this.volumeNoiseTex.createView();

    // Flush startup compute/mipmap work, then benchmark empty onSubmittedWorkDone() latency.
    // Firefox wgpu polls queue completion on a 100ms timer (Bug 1870699); disable per-frame gating there.
    await device.queue.onSubmittedWorkDone();
    const syncStart = performance.now();
    const probeEnc = device.createCommandEncoder({ label: 'sync-probe' });
    device.queue.submit([probeEnc.finish()]);
    await device.queue.onSubmittedWorkDone();
    this._useQueueBackpressure = performance.now() - syncStart < 20.0;

    this._rebuildBlackholeBindGroup();
    this.resize(1.0);
  }

  /**
   * Generates all mip levels 1..(mipLevelCount-1) for a 2D rgba8unorm texture via GPU render passes.
   */
  generateMipmaps(texture, width, height, mipLevelCount) {
    if (!this.mipmapPipeline || !texture || mipLevelCount <= 1) return;
    const device = this.device;
    const encoder = device.createCommandEncoder({ label: 'mipmap-gen' });

    for (let level = 1; level < mipLevelCount; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = device.createBindGroup({
        layout: this.mipmapBgl,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.sLinearClamp },
        ],
      });

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.mipmapPipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  _bakeVolumeNoise() {
    const device = this.device;
    const tex = device.createTexture({
      label: 'volume-noise-3d',
      size: [VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    if (!this.noisePipeline) return tex;

    const bg = device.createBindGroup({
      layout: this.noiseBgl,
      entries: [{ binding: 0, resource: tex.createView() }],
    });

    const encoder = device.createCommandEncoder({ label: 'bake-3d-noise' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.noisePipeline);
    pass.setBindGroup(0, bg);
    const wg = Math.ceil(VOLUME_SIZE / 4);
    pass.dispatchWorkgroups(wg, wg, wg);
    pass.end();

    device.queue.submit([encoder.finish()]);
    this.volumeBaked = true;
    return tex;
  }

  _rebuildBlackholeBindGroup() {
    if (!this.bhBgl || !this.volumeNoiseView || !this.skyView || !this.procSkyView) return;
    this.bhBindGroup = this.device.createBindGroup({
      label: 'blackhole-bg',
      layout: this.bhBgl,
      entries: [
        { binding: 0, resource: { buffer: this.bhUniformBuf } },
        { binding: 1, resource: this.volumeNoiseView },
        { binding: 2, resource: this.sVolumeRepeat },
        { binding: 3, resource: this.skyView },
        { binding: 4, resource: this.procSkyView },
        { binding: 5, resource: this.sSkyAniso },
        { binding: 6, resource: this.blackbodyView },
        { binding: 7, resource: this.sLinearClamp },
        { binding: 8, resource: this.blueNoiseView },
      ],
    });
  }

  resize(resolutionScale = this.resolutionScale) {
    const scale = Math.max(0.25, Math.min(1.0, Number(resolutionScale) || 1.0));
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cssW = Math.max(1, this.canvas.clientWidth || window.innerWidth || 1280);
    const cssH = Math.max(1, this.canvas.clientHeight || window.innerHeight || 720);

    const nextW = Math.max(64, Math.round(cssW * dpr * scale));
    const nextH = Math.max(64, Math.round(cssH * dpr * scale));

    if (
      nextW === this.width &&
      nextH === this.height &&
      Math.abs(scale - this.resolutionScale) < 1e-4 &&
      this.post?.getSceneView()
    ) {
      return false;
    }

    this.width = nextW;
    this.height = nextH;
    this.dpr = dpr;
    this.resolutionScale = scale;

    if (this.canvas.width !== nextW || this.canvas.height !== nextH) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
    }

    this.post?.resize(nextW, nextH);
    this.resetAccumulation(true);
    return true;
  }

  /**
   * Swap in asynchronously loaded 4K real astronomical sky map.
   */
  setSkyTexture(skyResult) {
    if (!skyResult) return;

    const { texture, width, height, isRealMap } = skyResult;
    if (isRealMap && texture) {
      if (this.skyTex && this.skyTex !== this.procSkyTex && this.skyTex !== texture) {
        this.skyTex.destroy();
      }
      this.skyTex = texture;
      this.skyView = texture.createView();
      this.skyMapLoaded = true;
      this.skyDimensions = [width || 4096, height || 2048];
      this._rebuildBlackholeBindGroup();
      this.resetAccumulation(true);
    } else {
      if (texture && texture !== this.procSkyTex && texture !== this.skyTex) {
        texture.destroy();
      }
      this.skyMapLoaded = false;
    }
  }

  resetAccumulation(hard = false) {
    this.sampleCount = 0;
    this._postDirty = true;
    if (hard) {
      this._hardReset = true;
    }
  }

  markPostDirty() {
    this._postDirty = true;
  }

  getAllShadersCompiled() {
    const entries = Object.values(this.shaderStatus);
    return entries.length > 0 && entries.every((s) => s.ok);
  }

  _writeBlackholeUniforms(state, camData, simTime, jitterX, jitterY) {
    const f = this._bhF32;
    const i = this._bhI32;
    const basis = camData.basis;
    const skyRot = state.skyRotation || [0.45, 0.24];

    f[0] = this.width;
    f[1] = this.height;
    f[2] = simTime;
    f[3] = this.frameIndex;

    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = camData.fovY;
    f[7] = state.spin;

    f[8] = camData.pos[0];
    f[9] = camData.pos[1];
    f[10] = camData.pos[2];
    f[11] = state.relativisticMode;

    f[12] = basis[0];
    f[13] = basis[1];
    f[14] = basis[2];
    f[15] = state.lensingStrength;

    f[16] = basis[3];
    f[17] = basis[4];
    f[18] = basis[5];
    f[19] = state.diskTemp;

    f[20] = basis[6];
    f[21] = basis[7];
    f[22] = basis[8];
    f[23] = state.diskDensity;

    f[24] = state.diskThickness;
    f[25] = state.diskOuterRadius;
    f[26] = state.turbulence;
    f[27] = state.orbitSpeed;

    f[28] = state.jetIntensity;
    f[29] = state.skyIntensity;
    f[30] = skyRot[0] || 0;
    f[31] = skyRot[1] || 0;

    i[32] = this.frameIndex | 0;
    i[33] = state.skyMode | 0;
    i[34] = state.quality | 0;
    i[35] = 0;

    // Precompute frame-invariant ZAMO tetrad, Kerr constants & disk flow offsets once per frame on CPU
    const clampVal = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const a = clampVal(state.spin, 0.0, 0.998);
    const a2 = a * a;
    const lensing = clampVal(state.lensingStrength, 0.0, 1.0);
    const rPlus = 1.0 + Math.sqrt(Math.max(1.0 - a2, 1e-6));

    const c1 = Math.pow(Math.max(1.0 - a2, 1e-7), 1.0 / 3.0);
    const c2 = Math.pow(1.0 + a, 1.0 / 3.0) + Math.pow(Math.max(1.0 - a, 1e-7), 1.0 / 3.0);
    const Z1 = 1.0 + c1 * c2;
    const Z2 = Math.sqrt(3.0 * a2 + Z1 * Z1);
    const rIsco = 3.0 + Z2 - Math.sqrt(Math.max((3.0 - Z1) * (3.0 + Z1 + 2.0 * Z2), 0.0));
    const rOuter = Math.max(state.diskOuterRadius, rIsco + 2.5);
    const tanHalfFov = Math.tan(clampVal(camData.fovY, 0.1, 2.8) * 0.5);

    const px = camData.pos[0];
    const py = camData.pos[1];
    const pz = camData.pos[2];
    const uVal = px * px + py * py + pz * pz - a2;
    const disc = Math.sqrt(Math.max(uVal * uVal + 4.0 * a2 * py * py, 1e-12));
    const cr2 = Math.max(0.5 * (uVal + disc), 1e-8);
    const cr = Math.sqrt(cr2);
    const cD = cr2 * cr2 + a2 * py * py;
    const cH = (lensing * (cr * cr2)) / Math.max(cD, 1e-10);
    const cR2 = cr2 + a2;
    const cinvR2 = 1.0 / Math.max(cR2, 1e-8);
    const lx = (cr * px + a * pz) * cinvR2;
    const ly = py / Math.max(cr, 1e-5);
    const lz = (cr * pz - a * px) * cinvR2;

    const ksDot = (A, B) => {
      const lA = -A[0] + lx * A[1] + ly * A[2] + lz * A[3];
      const lB = -B[0] + lx * B[1] + ly * B[2] + lz * B[3];
      return -A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + A[3] * B[3] + 2.0 * cH * lA * lB;
    };

    const rho2 = px * px + pz * pz;
    const omega = (2.0 * cH * a * cR2) / Math.max(cR2 * cR2 + 2.0 * cH * a2 * rho2, 1e-8);
    const vzx = omega * pz;
    const vzz = -omega * px;
    const lPhi = (a * rho2) / Math.max(cR2, 1e-8);
    const oneMinusWl = 1.0 - omega * lPhi;
    const normSq = Math.max(1.0 - (vzx * vzx + vzz * vzz) - 2.0 * cH * oneMinusWl * oneMinusWl, 1e-5);
    const ut = 1.0 / Math.sqrt(normSq);
    const e0 = [ut, ut * vzx, 0.0, ut * vzz];

    const f4 = [0.0, basis[6], basis[7], basis[8]];
    const df0 = ksDot(f4, e0);
    for (let k = 0; k < 4; k++) f4[k] += df0 * e0[k];
    const f4InvLen = 1.0 / Math.sqrt(Math.max(ksDot(f4, f4), 1e-8));
    const e3 = [f4[0] * f4InvLen, f4[1] * f4InvLen, f4[2] * f4InvLen, f4[3] * f4InvLen];

    const r4 = [0.0, basis[0], basis[1], basis[2]];
    const dr0 = ksDot(r4, e0);
    const dr3 = ksDot(r4, e3);
    for (let k = 0; k < 4; k++) r4[k] += dr0 * e0[k] - dr3 * e3[k];
    const r4InvLen = 1.0 / Math.sqrt(Math.max(ksDot(r4, r4), 1e-8));
    const e1 = [r4[0] * r4InvLen, r4[1] * r4InvLen, r4[2] * r4InvLen, r4[3] * r4InvLen];

    const u4 = [0.0, basis[3], basis[4], basis[5]];
    const du0 = ksDot(u4, e0);
    const du3 = ksDot(u4, e3);
    const du1 = ksDot(u4, e1);
    for (let k = 0; k < 4; k++) u4[k] += du0 * e0[k] - du3 * e3[k] - du1 * e1[k];
    const u4InvLen = 1.0 / Math.sqrt(Math.max(ksDot(u4, u4), 1e-8));
    const e2 = [u4[0] * u4InvLen, u4[1] * u4InvLen, u4[2] * u4InvLen, u4[3] * u4InvLen];

    f[36] = e0[0]; f[37] = e0[1]; f[38] = e0[2]; f[39] = e0[3];
    f[40] = e1[0]; f[41] = e1[1]; f[42] = e1[2]; f[43] = e1[3];
    f[44] = e2[0]; f[45] = e2[1]; f[46] = e2[2]; f[47] = e2[3];
    f[48] = e3[0]; f[49] = e3[1]; f[50] = e3[2]; f[51] = e3[3];
    f[52] = lx;    f[53] = ly;    f[54] = lz;    f[55] = 2.0 * cH;

    f[56] = rPlus; f[57] = rIsco; f[58] = rOuter; f[59] = tanHalfFov;

    const camR = Math.hypot(px, py, pz);
    const escapeR = Math.max(Math.max(rOuter * 1.55, camR * 1.45), 48.0);
    const captureR = rPlus * 1.022;
    const outerH = (0.048 + 0.036 * rOuter * 1.30) * Math.max(state.diskThickness, 0.15);
    const maxDiskSlabY = outerH * 2.6;
    const rPeak = Math.max(rIsco * 1.55, rPlus * 1.45);
    f[60] = escapeR; f[61] = captureR; f[62] = maxDiskSlabY; f[63] = rPeak;

    const flowCycle = 15.0;
    const tNorm0 = simTime / flowCycle;
    const phase0 = tNorm0 - Math.floor(tNorm0);
    const tNorm1 = tNorm0 + 0.5;
    const phase1 = tNorm1 - Math.floor(tNorm1);
    f[64] = 0.5 - 0.5 * Math.cos(Math.PI * 2.0 * phase0);
    f[65] = (phase0 - 0.5) * flowCycle;
    f[66] = (phase1 - 0.5) * flowCycle;
    f[67] = simTime * state.orbitSpeed * 0.045;

    const rPeakBase = 2.2 / Math.max(rPeak, 1.5);
    f[68] = Math.pow(rPeakBase, 0.28);
    f[69] = Math.pow(rPeakBase, 0.18);
    f[70] = Math.cos(skyRot[0] || 0);
    f[71] = Math.sin(skyRot[0] || 0);

    f[72] = Math.cos(skyRot[1] || 0);
    f[73] = Math.sin(skyRot[1] || 0);
    f[74] = 0.0;
    f[75] = 0.0;

    this.device.queue.writeBuffer(this.bhUniformBuf, 0, this._bhBufData);
  }

  _encodeBlackholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, isProgressive) {
    this._writeBlackholeUniforms(state, camData, simTime, jitterX, jitterY);

    const sceneView = this.post?.getSceneView();
    if (this.bhPipeline && this.bhBindGroup && sceneView) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: sceneView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.bhPipeline);
      pass.setBindGroup(0, this.bhBindGroup);
      pass.draw(3);
      pass.end();
    }

    this.post.encodeTaa(encoder, this.width, this.height, blendFactor, isProgressive);
  }

  _submitFrame(commandBuffer) {
    this.device.queue.submit([commandBuffer]);
    if (this._useQueueBackpressure) {
      this._inFlight++;
      this.device.queue.onSubmittedWorkDone().then(
        () => {
          this._inFlight = Math.max(0, this._inFlight - 1);
        },
        () => {
          this._inFlight = 0;
        }
      );
    }
  }

  /**
   * Executes one full simulation & HDR post-processing frame into the WebGPU canvas.
   * Returns true if GPU work was submitted on this tick, false if skipped (backpressure/converged).
   */
  render(state, camData, simTime, options = {}) {
    if (this._disposed || !this.getAllShadersCompiled()) return false;

    this.resize(state.resolutionScale);

    // Prevent unthrottled rAF loops on Chrome Dawn without hitting Firefox 100ms polling cap
    if (
      this._useQueueBackpressure &&
      !options.forceComposite &&
      !options.ignoreBackpressure &&
      this._inFlight >= MAX_FRAMES_IN_FLIGHT
    ) {
      return false;
    }

    const isProgressive = Boolean(state.paused && !camData.moved);

    if (isProgressive !== this._wasProgressive) {
      this.sampleCount = 0;
      this._wasProgressive = isProgressive;
      this._postDirty = true;
    }

    if (camData.moved) {
      this._postDirty = true;
    }

    if (isProgressive) {
      if (this.sampleCount < MAX_PROGRESSIVE_SAMPLES) {
        this.frameIndex++;
        this.sampleCount++;

        const jitterX = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 2) - 0.5;
        const jitterY = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 3) - 0.5;
        const blendFactor = this._hardReset ? 1.0 : 1.0 / this.sampleCount;
        this._hardReset = false;

        const encoder = this.device.createCommandEncoder({ label: 'frame-progressive' });
        this._encodeBlackholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, true);
        this.post.encodeBloomAndAnamorphic(encoder, state);
        this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      } else if (this._postDirty || options.forceComposite) {
        const encoder = this.device.createCommandEncoder({ label: 'frame-regrade' });
        this.post.encodeBloomAndAnamorphic(encoder, state);
        this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      }
      return false;
    }

    // Real-time TAA mode
    this.frameIndex++;
    let blendFactor;
    if (this._hardReset || this.sampleCount === 0) {
      blendFactor = 1.0;
      this.sampleCount = 1;
      this._hardReset = false;
    } else if (camData.moved) {
      blendFactor = 0.28;
      this.sampleCount = 1;
    } else {
      blendFactor = 0.14;
      this.sampleCount = Math.min(16, this.sampleCount + 1);
    }

    const jitterIdx = (this.frameIndex % 16) + 1;
    const jitterX = blendFactor >= 0.999 ? 0.0 : halton(jitterIdx, 2) - 0.5;
    const jitterY = blendFactor >= 0.999 ? 0.0 : halton(jitterIdx, 3) - 0.5;

    const encoder = this.device.createCommandEncoder({ label: 'frame-taa' });
    this._encodeBlackholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, false);
    this.post.encodeBloomAndAnamorphic(encoder, state);
    this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
    this._submitFrame(encoder.finish());
    this._postDirty = false;
    return true;
  }

  /**
   * Renders the current frame into an offscreen COPY_SRC target, reads back via GPU staging buffer,
   * and encodes a PNG Blob (works reliably across both Chrome Dawn and Firefox wgpu).
   * @returns {Promise<Blob>}
   */
  async capturePNG(state, camData, simTime) {
    if (this._disposed || !this.getAllShadersCompiled()) {
      throw new Error('WebGPU renderer is unavailable.');
    }

    this.resize(state.resolutionScale);
    const w = this.width;
    const h = this.height;
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;

    const offscreenTex = this.device.createTexture({
      label: 'capture-png-rt',
      size: [w, h, 1],
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const stagingBuf = this.device.createBuffer({
      label: 'capture-png-staging',
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder({ label: 'capture-png' });
      if (this.sampleCount === 0 || this._hardReset) {
        this.frameIndex++;
        this.sampleCount = 1;
        this._hardReset = false;
        this._encodeBlackholeAndTaa(encoder, state, camData, simTime, 0.0, 0.0, 1.0, Boolean(state.paused));
      }
      this.post.encodeBloomAndAnamorphic(encoder, state);
      this.post.encodeComposite(encoder, state, w, h, simTime, this.frameIndex, offscreenTex.createView());
      encoder.copyTextureToBuffer(
        { texture: offscreenTex },
        { buffer: stagingBuf, bytesPerRow, rowsPerImage: h },
        [w, h, 1]
      );
      this.device.queue.submit([encoder.finish()]);

      await stagingBuf.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(stagingBuf.getMappedRange());
      const rgba = new Uint8ClampedArray(w * h * 4);
      const isBgra = this.canvasFormat.startsWith('bgra');

      for (let y = 0; y < h; y++) {
        const srcRow = y * bytesPerRow;
        const dstRow = y * w * 4;
        if (isBgra) {
          for (let x = 0; x < w; x++) {
            const si = srcRow + x * 4;
            const di = dstRow + x * 4;
            rgba[di + 0] = mapped[si + 2];
            rgba[di + 1] = mapped[si + 1];
            rgba[di + 2] = mapped[si + 0];
            rgba[di + 3] = 255;
          }
        } else {
          for (let x = 0; x < w; x++) {
            const si = srcRow + x * 4;
            const di = dstRow + x * 4;
            rgba[di + 0] = mapped[si + 0];
            rgba[di + 1] = mapped[si + 1];
            rgba[di + 2] = mapped[si + 2];
            rgba[di + 3] = 255;
          }
        }
      }
      stagingBuf.unmap();

      const outCanvas = document.createElement('canvas');
      outCanvas.width = w;
      outCanvas.height = h;
      const ctx2d = outCanvas.getContext('2d');
      ctx2d.putImageData(new ImageData(rgba, w, h), 0, 0);

      return await new Promise((resolve, reject) => {
        outCanvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode offscreen readback frame to PNG.'));
        }, 'image/png');
      });
    } finally {
      stagingBuf.destroy();
      offscreenTex.destroy();
    }
  }

  dispose() {
    this._disposed = true;
    this.post?.dispose();
    this.volumeNoiseTex?.destroy();
    this.blackbodyTex?.destroy();
    this.blueNoiseTex?.destroy();
    if (this.skyTex && this.skyTex !== this.procSkyTex) {
      this.skyTex.destroy();
    }
    this.procSkyTex?.destroy();
    this.bhUniformBuf?.destroy();
    try {
      this.context?.unconfigure?.();
    } catch {
      // Ignore context unconfigure errors on teardown
    }
    try {
      this.device?.destroy?.();
    } catch {
      // Ignore device destroy errors on teardown
    }
  }
}
