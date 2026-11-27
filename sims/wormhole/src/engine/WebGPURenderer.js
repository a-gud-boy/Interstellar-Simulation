/**
 * WebGPURenderer.js — WebGPU rg11b10ufloat/rgba16float multi-pass HDR pipeline for the Wormhole Simulator:
 *  - Startup 3D Compute Shader 128x128x128 volume noise baker (NOISE_BAKE_COMPUTE_WGSL)
 *  - Pass 1: Morris-Thorne / Ellis wormhole geodesic ray-tracer (WORMHOLE_WGSL) with Halton(2,3) jitter
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + subtle CA, vignette, film grain & sRGB composite
 */

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../../../../shared/shaders/common.wgsl.js';
import { WORMHOLE_WGSL } from '../shaders/wormhole.wgsl.js';
import {
  SharedWebGPUPostPipeline,
  MAX_PROGRESSIVE_SAMPLES,
  MAX_FRAMES_IN_FLIGHT,
  halton,
  formatAdapterName,
  formatWgslMessages,
} from '../../../../shared/engine/SharedWebGPUPostPipeline.js';
import {
  createPlaceholderSkyTextureWebGPU,
  createProceduralSkyTextureAWebGPU,
  createExoticNebulaTextureBWebGPU,
} from '../../../../shared/assets/skyLoader.js';
import { createBlueNoiseLUTWebGPU } from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function evalWormholeR(l, metricType, rho, a, M) {
  if (metricType === 1) {
    return Math.sqrt(rho * rho + l * l);
  }
  const absL = Math.abs(l);
  if (absL <= a) {
    return rho;
  }
  const x = (2.0 * (absL - a)) / (Math.PI * Math.max(M, 1e-6));
  return rho + M * (x * Math.atan(x) - 0.5 * Math.log(1.0 + x * x));
}

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

    this.whBindGroup = null;
    this.post = null;

    // CPU-side uniform scratch views (192 bytes = 12 vec4 slots for WormholeUniforms)
    this._whBufData = new ArrayBuffer(192);
    this._whF32 = new Float32Array(this._whBufData);
    this._whI32 = new Int32Array(this._whBufData);
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
    const [modNoise, modMipmap, modWormhole] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('wormhole', WORMHOLE_WGSL, true),
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

    if (modWormhole) {
      // Exact bindings 0..7 contract matching WORMHOLE_WGSL
      this.whBgl = device.createBindGroupLayout({
        label: 'wormhole-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      this.whPipeline = device.createRenderPipeline({
        label: 'wormhole-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.whBgl] }),
        vertex: { module: modWormhole, entryPoint: 'vs_main' },
        fragment: {
          module: modWormhole,
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
    this.whUniformBuf = device.createBuffer({
      label: 'wh-ubo',
      size: 192,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 5. Blue-Noise LUT + Universe A Procedural Sky + Universe B Exotic Nebula + 3D Volume Bake
    const blueRes = createBlueNoiseLUTWebGPU(device, 128);
    this.blueNoiseTex = blueRes?.texture || blueRes;
    this.blueNoiseView = blueRes?.view || this.blueNoiseTex.createView();

    const mipGen = (t, w, h, m) => this.generateMipmaps(t, w, h, m);

    this.procSkyTexA = createPlaceholderSkyTextureWebGPU(device, 'proc-sky-a-placeholder');
    this._procSkyBakedA = false;
    this.procSkyViewA = this.procSkyTexA.createView();
    this.skyTexA = this.procSkyTexA;
    this.skyViewA = this.procSkyViewA;

    const skyBRes = createExoticNebulaTextureBWebGPU(device, mipGen, 2048, 1024);
    this.skyTexB = skyBRes?.texture || skyBRes;
    this.skyViewB = skyBRes?.view || this.skyTexB.createView();

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

    this._rebuildWormholeBindGroup();
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

  _rebuildWormholeBindGroup() {
    if (!this.whBgl || !this.volumeNoiseView || !this.skyViewA || !this.procSkyViewA || !this.skyViewB) {
      return;
    }
    this.whBindGroup = this.device.createBindGroup({
      label: 'wormhole-bg',
      layout: this.whBgl,
      entries: [
        { binding: 0, resource: { buffer: this.whUniformBuf } },
        { binding: 1, resource: this.volumeNoiseView },
        { binding: 2, resource: this.sVolumeRepeat },
        { binding: 3, resource: this.skyViewA },
        { binding: 4, resource: this.procSkyViewA },
        { binding: 5, resource: this.skyViewB },
        { binding: 6, resource: this.sSkyAniso },
        { binding: 7, resource: this.blueNoiseView },
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
   * Swap in asynchronously loaded 4K real astronomical sky map for Universe A.
   */
  setSkyTexture(skyResult) {
    if (!skyResult) return;

    const { texture, width, height, isRealMap } = skyResult;
    if (isRealMap && texture) {
      if (this.skyTexA && this.skyTexA !== this.procSkyTexA && this.skyTexA !== texture) {
        this.skyTexA.destroy();
      }
      this.skyTexA = texture;
      this.skyViewA = texture.createView();
      this.skyMapLoaded = true;
      this.skyDimensions = [width || 4096, height || 2048];
      this._rebuildWormholeBindGroup();
      this.resetAccumulation(true);
    } else {
      if (texture && !this._procSkyBakedA) {
        const oldPlaceholder = this.procSkyTexA;
        this.procSkyTexA = texture;
        this.procSkyViewA = texture.createView();
        if (!this.skyMapLoaded) {
          this.skyTexA = texture;
          this.skyViewA = this.procSkyViewA;
        }
        this._procSkyBakedA = true;
        this._rebuildWormholeBindGroup();
        if (oldPlaceholder && oldPlaceholder !== texture && oldPlaceholder !== this.skyTexA) {
          oldPlaceholder.destroy();
        }
        this.resetAccumulation(true);
      } else if (texture && texture !== this.procSkyTexA && texture !== this.skyTexA) {
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

  _writeWormholeUniforms(state, camData, simTime, jitterX, jitterY) {
    const f = this._whF32;
    const i = this._whI32;
    const basis = camData.basis;
    const n0 = camData.n0;
    const camL = Number.isFinite(camData.l) ? camData.l : 0.0;

    const metricType = (state.metricType | 0) === 1 ? 1 : 0;
    const rho = Math.max(
      0.25,
      Number.isFinite(Number(state.throatRadius)) ? Number(state.throatRadius) : 2.0
    );
    const throatLen = Math.max(
      0.0,
      Number.isFinite(Number(state.throatLength)) ? Number(state.throatLength) : 0.25
    );
    const lensingW = Math.max(
      0.05,
      Number.isFinite(Number(state.lensingWidth)) ? Number(state.lensingWidth) : 0.32
    );

    const rotA = state.skyRotationA || [0.4, 0.2];
    const rotB = state.skyRotationB || [1.1, -0.15];
    const rotAx = rotA[0] ?? 0.4;
    const rotAy = rotA[1] ?? 0.2;
    const rotBx = rotB[0] ?? 1.1;
    const rotBy = rotB[1] ?? -0.15;

    const tanHalfFov = Math.tan(clamp(camData.fovY, 0.1, 2.8) * 0.5);
    const camR = evalWormholeR(camL, metricType, rho, throatLen, lensingW);
    const escapeL = Math.max(Math.abs(camL) * 3.0 + 40.0, throatLen + 4.0 * Math.max(lensingW, 0.35) + 80.0);

    // 1. resolution_time_frame
    f[0] = this.width;
    f[1] = this.height;
    f[2] = simTime;
    f[3] = this.frameIndex;

    // 2. jitter_fov_camL
    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = camData.fovY;
    f[7] = camL;

    // 3. camN0_tanHalfFov
    f[8] = n0[0];
    f[9] = n0[1];
    f[10] = n0[2];
    f[11] = tanHalfFov;

    // 4. camRight_rho
    f[12] = basis[0];
    f[13] = basis[1];
    f[14] = basis[2];
    f[15] = rho;

    // 5. camUp_throatLen
    f[16] = basis[3];
    f[17] = basis[4];
    f[18] = basis[5];
    f[19] = throatLen;

    // 6. camForward_lensingW
    f[20] = basis[6];
    f[21] = basis[7];
    f[22] = basis[8];
    f[23] = lensingW;

    // 7. matter_skyParams
    f[24] = state.throatGlow ?? 0.22;
    f[25] = state.dustDensity ?? 0.35;
    f[26] = state.swirlSpeed ?? 0.85;
    f[27] = state.skyIntensityA ?? 1.0;

    // 8. skyB_rotA_rotBx
    f[28] = state.skyIntensityB ?? 1.15;
    f[29] = rotAx;
    f[30] = rotAy;
    f[31] = rotBx;

    // 9. rotBy_camR_escapeL_pad
    f[32] = rotBy;
    f[33] = camR;
    f[34] = escapeL;
    f[35] = 0.0;

    // 10. modes (vec4i)
    i[36] = this.frameIndex | 0;
    i[37] = metricType;
    i[38] = state.quality | 0;
    i[39] = state.planetVisible | 0;

    // 11. skyTrigA
    f[40] = Math.cos(rotAx);
    f[41] = Math.sin(rotAx);
    f[42] = Math.cos(rotAy);
    f[43] = Math.sin(rotAy);

    // 12. skyTrigB
    f[44] = Math.cos(rotBx);
    f[45] = Math.sin(rotBx);
    f[46] = Math.cos(rotBy);
    f[47] = Math.sin(rotBy);

    this.device.queue.writeBuffer(this.whUniformBuf, 0, this._whBufData);
  }

  _encodeWormholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, isProgressive) {
    this._writeWormholeUniforms(state, camData, simTime, jitterX, jitterY);

    const sceneView = this.post?.getSceneView();
    if (this.whPipeline && this.whBindGroup && sceneView) {
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
      pass.setPipeline(this.whPipeline);
      pass.setBindGroup(0, this.whBindGroup);
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

    const targetScale = Number(options?.effectiveResolutionScale ?? state?.resolutionScale ?? this.resolutionScale) || 1.0;
    if (this.width === 0 || this.height === 0 || Math.abs(targetScale - this.resolutionScale) > 1e-4) {
      this.resize(targetScale);
    }

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
        this._encodeWormholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, true);
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
    this._encodeWormholeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, false);
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
        this._encodeWormholeAndTaa(encoder, state, camData, simTime, 0.0, 0.0, 1.0, Boolean(state.paused));
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
    this.blueNoiseTex?.destroy();
    if (this.skyTexA && this.skyTexA !== this.procSkyTexA) {
      this.skyTexA.destroy();
    }
    this.procSkyTexA?.destroy();
    this.skyTexB?.destroy();
    this.whUniformBuf?.destroy();
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
