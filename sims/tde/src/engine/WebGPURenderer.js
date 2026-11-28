/**
 * WebGPURenderer.js — WebGPU rgba16float multi-pass HDR rendering pipeline for the
 * Relativistic Tidal Disruption Event (TDE) Observatory:
 *  - Startup 3D Compute Shader 128^3 volume noise baker (NOISE_BAKE_COMPUTE_WGSL)
 *  - Pass 1: Outgoing Kerr-Schild TDE geodesic & tidal debris ray-tracer (TDE_WGSL)
 *  - Pass 2..5: Shared HDR TAA/128-sample accumulation, 6-level bloom, anamorphic flare & AgX
 */

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../../../../shared/shaders/common.wgsl.js';
import { TDE_WGSL } from '../shaders/tde.wgsl.js';
import { computeTdeTelemetry, writeTdeFrameConstants } from './Physics.js';
import {
  SharedWebGPUPostPipeline,
  MAX_PROGRESSIVE_SAMPLES,
  MAX_FRAMES_IN_FLIGHT,
  halton,
  formatAdapterName,
  formatWgslMessages,
} from '../../../../shared/engine/SharedWebGPUPostPipeline.js';
import { createWebGPUPassProfiler } from '../../../../shared/engine/gpuProfiler.js';
import {
  createProceduralSkyTextureWebGPU,
  createPlaceholderSkyTextureWebGPU,
} from '../../../../shared/assets/skyLoader.js';
import {
  createBlackbodyLUTWebGPU,
  createBlueNoiseLUTWebGPU,
} from '../../../../shared/assets/physicalLuts.js';

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
    this.maxDpr = MAX_DPR;
    this.resolutionScale = 1.0;

    this.frameIndex = 0;
    this.sampleCount = 0;
    this._hardReset = true;
    this._postDirty = true;
    this._wasProgressive = false;
    this._disposed = false;
    this._inFlight = 0;
    this._useQueueBackpressure = true;

    this.tdeBindGroup = null;
    this.post = null;

    // CPU-side uniform scratch views (320 bytes = 20 vec4 slots for TdeUniforms)
    this._tdeBufData = new ArrayBuffer(320);
    this._tdeF32 = new Float32Array(this._tdeBufData);
    this._tdeI32 = new Int32Array(this._tdeBufData);
  }

  static async create(canvas, options = {}) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new Error(
        'WebGPU (navigator.gpu) is unavailable in this browser. Launch via ./launch.sh or ./launch.sh --firefox.'
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new Error('No WebGPU GPU adapter found.');
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
    if (adapter.features?.has('timestamp-query')) {
      requiredFeatures.push('timestamp-query');
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
      if (!renderer.errors.includes(msg)) renderer.errors.push(msg);
    });

    device.lost.then((info) => {
      if (renderer._disposed) return;
      const msg = `WebGPU device lost (${info?.reason || 'unknown'}): ${info?.message || 'GPU reset'}`;
      console.error('[WebGPURenderer]', msg);
      if (!renderer.errors.includes(msg)) renderer.errors.push(msg);
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
      if (recordStatus) this.shaderStatus[name] = { ok: false, error: errText };
      return null;
    }
    if (recordStatus) this.shaderStatus[name] = { ok: true, error: null };
    return mod;
  }

  async _initResourcesAndPipelines() {
    const device = this.device;

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

    device.pushErrorScope('validation');
    const [modNoise, modMipmap, modTde] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('tde', TDE_WGSL, true),
    ]);

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

    if (modTde) {
      this.tdeBgl = device.createBindGroupLayout({
        label: 'tde-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'float', viewDimension: '3d' },
          },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      this.tdePipeline = device.createRenderPipeline({
        label: 'tde-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.tdeBgl] }),
        vertex: { module: modTde, entryPoint: 'vs_main' },
        fragment: {
          module: modTde,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    this.profiler = createWebGPUPassProfiler(device);
    this.post = new SharedWebGPUPostPipeline({
      profiler: this.profiler,
      device,
      context: this.context,
      canvasFormat: this.canvasFormat,
      hdrFormat: this.hdrFormat,
      sLinearClamp: this.sLinearClamp,
      opticsProfile: 'tde',
    });
    await this.post.init((name, code, record) => this._compileModule(name, code, record));

    const validationErr = await device.popErrorScope();
    if (validationErr) {
      const msg = `[WebGPURenderer] Pipeline creation validation error: ${validationErr.message}`;
      console.error(msg);
      this.errors.push(msg);
    }

    this.tdeUniformBuf = device.createBuffer({
      label: 'tde-ubo',
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const blackbodyRes = createBlackbodyLUTWebGPU(device, 512);
    this.blackbodyTex = blackbodyRes.texture;
    this.blackbodyView = blackbodyRes.view;

    this.blueNoiseTex = createBlueNoiseLUTWebGPU(device, 128);
    this.blueNoiseView = this.blueNoiseTex.createView();

    this.procSkyTex = createPlaceholderSkyTextureWebGPU(device);
    this._procSkyBaked = false;
    this.procSkyView = this.procSkyTex.createView();
    this.skyTex = this.procSkyTex;
    this.skyView = this.procSkyView;

    this.volumeNoiseTex = this._bakeVolumeNoise();
    this.volumeNoiseView = this.volumeNoiseTex.createView();

    await device.queue.onSubmittedWorkDone();
    const syncStart = performance.now();
    const probeEnc = device.createCommandEncoder({ label: 'sync-probe' });
    device.queue.submit([probeEnc.finish()]);
    await device.queue.onSubmittedWorkDone();
    this._useQueueBackpressure = performance.now() - syncStart < 20.0;

    this._rebuildTdeBindGroup();
    this.resize(1.0);
  }

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

  _rebuildTdeBindGroup() {
    if (!this.tdeBgl || !this.volumeNoiseView || !this.skyView || !this.procSkyView) return;
    this.tdeBindGroup = this.device.createBindGroup({
      label: 'tde-bg',
      layout: this.tdeBgl,
      entries: [
        { binding: 0, resource: { buffer: this.tdeUniformBuf } },
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

  resize(resolutionScale = this.resolutionScale, maxDpr = this.maxDpr) {
    const scale = Math.max(0.25, Math.min(1.0, Number(resolutionScale) || 1.0));
    const dprCap = Math.max(0.5, Math.min(3.0, Number(maxDpr) || MAX_DPR));
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const cssW = Math.max(1, this.canvas.clientWidth || window.innerWidth || 1280);
    const cssH = Math.max(1, this.canvas.clientHeight || window.innerHeight || 720);

    const nextW = Math.max(64, Math.round(cssW * dpr * scale));
    const nextH = Math.max(64, Math.round(cssH * dpr * scale));

    if (
      nextW === this.width &&
      nextH === this.height &&
      Math.abs(scale - this.resolutionScale) < 1e-4 &&
      Math.abs(dprCap - this.maxDpr) < 1e-4 &&
      this.post?.getSceneView()
    ) {
      return false;
    }

    this.width = nextW;
    this.height = nextH;
    this.dpr = dpr;
    this.maxDpr = dprCap;
    this.resolutionScale = scale;

    if (this.canvas.width !== nextW || this.canvas.height !== nextH) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
    }

    this.post?.resize(nextW, nextH);
    this.resetAccumulation(true);
    return true;
  }

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
      this._rebuildTdeBindGroup();
      this.resetAccumulation(true);
    } else {
      if (texture && !this._procSkyBaked) {
        const oldPlaceholder = this.procSkyTex;
        this.procSkyTex = texture;
        this.procSkyView = texture.createView();
        if (!this.skyMapLoaded) {
          this.skyTex = texture;
          this.skyView = this.procSkyView;
        }
        this._procSkyBaked = true;
        this._rebuildTdeBindGroup();
        if (oldPlaceholder && oldPlaceholder !== texture && oldPlaceholder !== this.skyTex) {
          oldPlaceholder.destroy();
        }
        this.resetAccumulation(true);
      } else if (texture && texture !== this.procSkyTex && texture !== this.skyTex) {
        texture.destroy();
      }
      this.skyMapLoaded = false;
    }
  }

  _ensureProceduralSky() {
    if (this._procSkyBaked || this._disposed) return;
    const oldPlaceholder = this.procSkyTex;
    const baked = createProceduralSkyTextureWebGPU(
      this.device,
      (t, w, h, m) => this.generateMipmaps(t, w, h, m),
      2048,
      1024
    );
    this.procSkyTex = baked;
    this.procSkyView = baked.createView();
    if (!this.skyMapLoaded && (!this.skyTex || this.skyTex === oldPlaceholder)) {
      this.skyTex = baked;
      this.skyView = this.procSkyView;
    }
    this._procSkyBaked = true;
    this._rebuildTdeBindGroup();
    if (oldPlaceholder && oldPlaceholder !== baked && oldPlaceholder !== this.skyTex) {
      oldPlaceholder.destroy();
    }
  }

  resetAccumulation(hard = false) {
    this.sampleCount = 0;
    this._postDirty = true;
    if (hard) this._hardReset = true;
  }

  markPostDirty() {
    this._postDirty = true;
  }

  setProfilerEnabled(enabled) {
    this.profiler?.setEnabled(enabled);
  }

  getProfilerMetrics() {
    return this.profiler ? this.profiler.getMetrics() : null;
  }

  getAllShadersCompiled() {
    const entries = Object.values(this.shaderStatus);
    return entries.length > 0 && entries.every((s) => s.ok);
  }

  _writeTdeUniforms(state, camData, simTime, jitterX, jitterY) {
    const f = this._tdeF32;
    const i = this._tdeI32;
    const basis = camData.basis;
    const skyRot = state.skyRotation || [0.38, 0.16];
    const tel = computeTdeTelemetry(state);

    f[0] = this.width;
    f[1] = this.height;
    f[2] = simTime;
    f[3] = this.frameIndex;

    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = camData.fovY;
    f[7] = tel.spin;

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
    f[19] = tel.tdePhase;

    f[20] = basis[6];
    f[21] = basis[7];
    f[22] = basis[8];
    f[23] = tel.beta;

    f[24] = state.streamDensity;
    f[25] = state.shockIntensity;
    f[26] = state.diskDensity;
    f[27] = state.jetIntensity;

    f[28] = state.flowSpeed;
    f[29] = tel.precessRadVis;
    f[30] = tel.rpVis;
    f[31] = tel.streamTiltRad;

    f[32] = state.skyIntensity;
    f[33] = skyRot[0] || 0;
    f[34] = skyRot[1] || 0;
    f[35] = state.diskTemp;

    i[36] = this.frameIndex | 0;
    i[37] = state.skyMode | 0;
    i[38] = state.quality | 0;
    i[39] = tel.swallowedDirect ? 1 : 0;

    writeTdeFrameConstants(f, 40, state, camData);
    this.device.queue.writeBuffer(this.tdeUniformBuf, 0, this._tdeBufData);
  }

  _encodeTdeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, isProgressive) {
    if ((state?.skyMode | 0) === 2 && !this._procSkyBaked) {
      this._ensureProceduralSky();
    }
    this._writeTdeUniforms(state, camData, simTime, jitterX, jitterY);

    const sceneView = this.post?.getSceneView();
    if (this.tdePipeline && this.tdeBindGroup && sceneView) {
      const ts = this.profiler?.timestampWritesFor('raymarch');
      const pass = encoder.beginRenderPass({
        ...(ts ? { timestampWrites: ts } : {}),
        colorAttachments: [
          {
            view: sceneView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.tdePipeline);
      pass.setBindGroup(0, this.tdeBindGroup);
      pass.draw(3);
      pass.end();
    }

    this.post.encodeTaa(encoder, this.width, this.height, blendFactor, isProgressive);
  }

  _submitFrame(commandBuffer) {
    this.device.queue.submit([commandBuffer]);
    this.profiler?.afterSubmit();
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

  render(state, camData, simTime, options = {}) {
    if (this._disposed || !this.getAllShadersCompiled()) return false;

    const targetScale =
      Number(options?.effectiveResolutionScale ?? state?.resolutionScale ?? this.resolutionScale) ||
      1.0;
    if (
      this.width === 0 ||
      this.height === 0 ||
      Math.abs(targetScale - this.resolutionScale) > 1e-4
    ) {
      this.resize(targetScale);
    }

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
    if (camData.moved) this._postDirty = true;

    if (isProgressive) {
      if (this.sampleCount < MAX_PROGRESSIVE_SAMPLES) {
        this.frameIndex++;
        this.sampleCount++;

        const jitterX = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 2) - 0.5;
        const jitterY = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 3) - 0.5;
        const blendFactor = this._hardReset ? 1.0 : 1.0 / this.sampleCount;
        this._hardReset = false;

        this.profiler?.beginFrame();
        const encoder = this.device.createCommandEncoder({ label: 'frame-progressive' });
        this._encodeTdeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, true);
        this.post.encodeBloomAndAnamorphic(encoder, state);
        this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame(encoder);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      } else if (this._postDirty || options.forceComposite) {
        this.profiler?.beginFrame();
        const encoder = this.device.createCommandEncoder({ label: 'frame-regrade' });
        this.post.encodeBloomAndAnamorphic(encoder, state);
        this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame(encoder);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      }
      return false;
    }

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

    this.profiler?.beginFrame();
    const encoder = this.device.createCommandEncoder({ label: 'frame-taa' });
    this._encodeTdeAndTaa(encoder, state, camData, simTime, jitterX, jitterY, blendFactor, false);
    this.post.encodeBloomAndAnamorphic(encoder, state);
    this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
    this.profiler?.endFrame(encoder);
    this._submitFrame(encoder.finish());
    this._postDirty = false;
    return true;
  }

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
        this._encodeTdeAndTaa(encoder, state, camData, simTime, 0.0, 0.0, 1.0, Boolean(state.paused));
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
      outCanvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);

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
    this.profiler?.dispose();
    this.post?.dispose();
    this.volumeNoiseTex?.destroy();
    this.blackbodyTex?.destroy();
    this.blueNoiseTex?.destroy();
    if (this.skyTex && this.skyTex !== this.procSkyTex) {
      this.skyTex.destroy();
    }
    this.procSkyTex?.destroy();
    this.tdeUniformBuf?.destroy();
    try {
      this.context?.unconfigure?.();
    } catch {
      // Ignore context unconfigure errors
    }
    try {
      this.device?.destroy?.();
    } catch {
      // Ignore device destroy errors
    }
  }
}
