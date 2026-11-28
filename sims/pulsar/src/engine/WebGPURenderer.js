/**
 * WebGPURenderer.js — WebGPU rg11b10ufloat/rgba16float multi-pass HDR rendering pipeline
 * for Relativistic Magnetar & Millisecond Pulsar Simulator:
 *  - Startup 3D Compute Shader 128x128x128 volume noise baker (NOISE_BAKE_COMPUTE_WGSL)
 *  - Pass 1: Kerr-Schild curved relativistic pulsar, magnetosphere & PWN ray-tracer (PULSAR_WGSL)
 *            with Halton(2,3) sub-pixel jitter
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + CA, vignette, film grain & sRGB composite
 */

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../../../../shared/shaders/common.wgsl.js';
import { PULSAR_WGSL } from '../shaders/pulsar.wgsl.js';
import {
  SharedWebGPUPostPipeline,
  MAX_PROGRESSIVE_SAMPLES,
  halton,
  formatAdapterName,
  formatWgslMessages,
} from '../../../../shared/engine/SharedWebGPUPostPipeline.js';
import { createWebGPUPassProfiler } from '../../../../shared/engine/gpuProfiler.js';
import { computePulsarTelemetry } from './Physics.js';
import {
  createProceduralSkyTextureWebGPU,
  createPlaceholderSkyTextureWebGPU,
} from '../../../../shared/assets/skyLoader.js';
import { createBlackbodyLUTWebGPU, createBlueNoiseLUTWebGPU } from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;
const MAX_FRAMES_IN_FLIGHT = 3;

function extractCamVectors(camMatrices) {
  const pos = camMatrices?.pos || [0, 0, 10.5];
  let right = camMatrices?.right;
  let up = camMatrices?.up;
  let forward = camMatrices?.forward;
  if ((!right || !up || !forward) && camMatrices?.basis) {
    const b = camMatrices.basis;
    right = right || [b[0], b[1], b[2]];
    up = up || [b[3], b[4], b[5]];
    forward = forward || [b[6], b[7], b[8]];
  }
  right = right || [1, 0, 0];
  up = up || [0, 1, 0];
  forward = forward || [0, 0, -1];
  const fovY = Number.isFinite(camMatrices?.fovY) ? camMatrices.fovY : (48 * Math.PI) / 180;
  return { pos, right, up, forward, fovY };
}

function fillPhysicsStateSignature(state, out) {
  const skyRot = Array.isArray(state?.skyRotation) ? state.skyRotation : null;
  out[0] = Number(state?.lensingMode ?? 1) ? 1 : 0;
  out[1] = Number.isFinite(Number(state?.compactness)) ? Number(state.compactness) : 0.21;
  out[2] = Number.isFinite(Number(state?.spinPeriodMs)) ? Number(state.spinPeriodMs) : 33.0;
  out[3] = Number.isFinite(Number(state?.spinVisualSpeed)) ? Number(state.spinVisualSpeed) : 1.0;
  out[4] = Number.isFinite(Number(state?.obliquityDeg)) ? Number(state.obliquityDeg) : 45.0;
  out[5] = Number.isFinite(Number(state?.twistShear)) ? Number(state.twistShear) : 0.45;
  out[6] = Number.isFinite(Number(state?.plasmaDensity)) ? Number(state.plasmaDensity) : 1.15;
  out[7] = Number.isFinite(Number(state?.beamIntensity)) ? Number(state.beamIntensity) : 1.35;
  out[8] = Number.isFinite(Number(state?.pwnVisibility)) ? Number(state.pwnVisibility) : 1.10;
  out[9] = Number.isFinite(Number(state?.polarCapTempK)) ? Number(state.polarCapTempK) : 6.5e6;
  out[10] = Number.isFinite(Number(state?.crustTempK)) ? Number(state.crustTempK) : 1.4e6;
  out[11] = Number.isFinite(Number(state?.skyIntensity)) ? Number(state.skyIntensity) : 0.90;
  out[12] = Number.isFinite(Number(state?.skyMode)) ? (Number(state.skyMode) | 0) : 0;
  out[13] = skyRot && Number.isFinite(Number(skyRot[0])) ? Number(skyRot[0]) : 0.40;
  out[14] = skyRot && Number.isFinite(Number(skyRot[1])) ? Number(skyRot[1]) : 0.14;
  out[15] = Number.isFinite(Number(state?.quality)) ? (Number(state.quality) | 0) : 1;
  out[16] = Number.isFinite(Number(state?.beamConeHalfAngle)) ? Number(state.beamConeHalfAngle) : 0.30;
  out[17] = Number.isFinite(Number(state?.magnetarCrackGlow)) ? Number(state.magnetarCrackGlow) : 0.25;
  out[18] = Number.isFinite(Number(state?.pwnJetPower)) ? Number(state.pwnJetPower) : 1.15;
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
    this.maxDpr = MAX_DPR;
    this.resolutionScale = 1.0;

    this.frameIndex = 0;
    this.sampleCount = 0;

    this._hardReset = true;
    this._postDirty = true;
    this._wasProgressive = false;
    this._disposed = false;
    this._deviceLost = false;
    this._inFlight = 0;
    this._useQueueBackpressure = true;
    this._prevCamSig = new Float64Array(13);
    this._currCamSig = new Float64Array(13);
    this._hasPrevCamSig = false;
    this._prevStateSig = new Float64Array(19);
    this._currStateSig = new Float64Array(19);
    this._hasPrevStateSig = false;
    this._prevSpinPhase = null;

    this.pulsarBindGroup = null;
    this.post = null;

    // Locked 176 bytes = 11 vec4<f32> slots for PulsarUniforms
    this._pulsarBufData = new ArrayBuffer(176);
    this._pulsarF32 = new Float32Array(this._pulsarBufData);
  }

  static async create(canvas, options = {}) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new Error('WebGPU (navigator.gpu) is unavailable in this browser.');
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
      if (!renderer.errors.includes(msg)) {
        renderer.errors.push(msg);
      }
    });

    device.lost.then(
      (info) => {
        if (renderer._disposed) return;
        renderer._deviceLost = true;
        renderer._inFlight = 0;
        const msg = `WebGPU device lost (${info?.reason || 'unknown'}): ${info?.message || 'GPU reset'}`;
        console.error('[WebGPURenderer]', msg);
        if (!renderer.errors.includes(msg)) {
          renderer.errors.push(msg);
        }
        try {
          renderer.onDeviceLost?.(info);
        } catch {
          // Ignore callback error on device loss
        }
      },
      () => {
        renderer._deviceLost = true;
        renderer._inFlight = 0;
      }
    );

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
    const [
      modNoise,
      modMipmap,
      modPulsar,
    ] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('pulsar', PULSAR_WGSL, true),
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

    if (modPulsar) {
      this.pulsarBgl = device.createBindGroupLayout({
        label: 'pulsar-bgl',
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
      this.pulsarPipeline = device.createRenderPipeline({
        label: 'pulsar-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.pulsarBgl] }),
        vertex: { module: modPulsar, entryPoint: 'vs_main' },
        fragment: {
          module: modPulsar,
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
      opticsProfile: 'pulsar',
    });
    await this.post.init((name, code, record) => this._compileModule(name, code, record));

    const validationErr = await device.popErrorScope();
    if (validationErr) {
      const msg = `[WebGPURenderer] Pipeline creation validation error: ${validationErr.message}`;
      console.error(msg);
      this.errors.push(msg);
    }

    const makeUbo = (label, byteLength) =>
      device.createBuffer({
        label,
        size: byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.pulsarUniformBuf = makeUbo('pulsar-ubo', 176);

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

    this._rebuildPulsarBindGroup();
    this.resize(1.0);
  }

  generateMipmaps(texture, width, height, mipLevelCount) {
    if (this._disposed || this._deviceLost || !this.mipmapPipeline || !texture || mipLevelCount <= 1) {
      return;
    }
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

  _rebuildPulsarBindGroup() {
    if (!this.pulsarBgl || !this.volumeNoiseView || !this.skyView || !this.procSkyView) {
      return;
    }
    this.pulsarBindGroup = this.device.createBindGroup({
      label: 'pulsar-bg',
      layout: this.pulsarBgl,
      entries: [
        { binding: 0, resource: { buffer: this.pulsarUniformBuf } },
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
    if (this._disposed || this._deviceLost) return false;

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

    this.post.resize(nextW, nextH);
    this.resetAccumulation(true);
    return true;
  }

  setSkyTexture(skyResult) {
    if (!skyResult || this._disposed || this._deviceLost) return;

    const { texture, width, height, isRealMap } = skyResult;
    if (isRealMap && texture) {
      if (this.skyTex && this.skyTex !== this.procSkyTex && this.skyTex !== texture) {
        this.skyTex.destroy();
      }
      this.skyTex = texture;
      this.skyView = texture.createView();
      this.skyMapLoaded = true;
      this.skyDimensions = [width || 4096, height || 2048];
      this._rebuildPulsarBindGroup();
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
        this._rebuildPulsarBindGroup();
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
    if (this._procSkyBaked || this._disposed || this._deviceLost) return;
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
    this._rebuildPulsarBindGroup();
    if (oldPlaceholder && oldPlaceholder !== baked && oldPlaceholder !== this.skyTex) {
      oldPlaceholder.destroy();
    }
  }

  resetAccumulation(hard = false) {
    this.sampleCount = 0;
    this._postDirty = true;
    if (hard) {
      this._hardReset = true;
    }
  }

  markReset(hard = true) {
    this.resetAccumulation(hard);
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

  getDiagnostics() {
    return {
      shaderStatus: { ...this.shaderStatus },
      allShadersCompiled: this.getAllShadersCompiled(),
      rendererName: this.rendererName,
      adapterInfo: this.adapterInfo ? { ...this.adapterInfo } : null,
      canvasFormat: this.canvasFormat,
      hdrFormat: this.hdrFormat,
      volumeBaked: this.volumeBaked,
      skyMapLoaded: this.skyMapLoaded,
      skyDimensions: [...this.skyDimensions],
      resolution: [this.width, this.height],
      dpr: this.dpr,
      samples: this.sampleCount,
      frameIndex: this.frameIndex,
      errors: [...this.errors],
    };
  }

  _didCameraMove(camMatrices, cam) {
    const sig = this._currCamSig;
    sig[0] = cam.pos[0];
    sig[1] = cam.pos[1];
    sig[2] = cam.pos[2];
    sig[3] = cam.right[0];
    sig[4] = cam.right[1];
    sig[5] = cam.right[2];
    sig[6] = cam.up[0];
    sig[7] = cam.up[1];
    sig[8] = cam.up[2];
    sig[9] = cam.forward[0];
    sig[10] = cam.forward[1];
    sig[11] = cam.forward[2];
    sig[12] = cam.fovY;

    let sigChanged = false;
    if (!this._hasPrevCamSig) {
      sigChanged = true;
      this._hasPrevCamSig = true;
      this._prevCamSig.set(sig);
    } else {
      for (let i = 0; i < sig.length; i++) {
        if (Math.abs(sig[i] - this._prevCamSig[i]) > 1e-6) {
          sigChanged = true;
          break;
        }
      }
      if (sigChanged) this._prevCamSig.set(sig);
    }
    return typeof camMatrices?.moved === 'boolean' ? (camMatrices.moved || sigChanged) : sigChanged;
  }

  _syncStateChangeTracking(state, opts) {
    const sig = this._currStateSig;
    fillPhysicsStateSignature(state, sig);
    let paramsChanged = false;
    if (!this._hasPrevStateSig) {
      this._hasPrevStateSig = true;
      this._prevStateSig.set(sig);
    } else {
      for (let i = 0; i < sig.length; i++) {
        const a = sig[i];
        const b = this._prevStateSig[i];
        const tol = 1e-6 * Math.max(1.0, Math.abs(a), Math.abs(b));
        if (!Number.isFinite(a) || Math.abs(a - b) > tol) {
          paramsChanged = true;
          break;
        }
      }
      if (paramsChanged) {
        this._prevStateSig.set(sig);
      }
    }

    const spinPhase = Number.isFinite(Number(state?.spinPhase)) ? Number(state.spinPhase) : 0.0;
    let spinPhaseChanged = false;
    let spinPhaseJump = false;
    if (this._prevSpinPhase === null) {
      this._prevSpinPhase = spinPhase;
    } else {
      const rawDelta = Math.abs(spinPhase - this._prevSpinPhase);
      if (rawDelta > 1e-6) {
        spinPhaseChanged = true;
        const wrappedDelta = Math.abs(
          Math.atan2(
            Math.sin(spinPhase - this._prevSpinPhase),
            Math.cos(spinPhase - this._prevSpinPhase)
          )
        );
        if (wrappedDelta > 0.6) {
          spinPhaseJump = true;
        }
        this._prevSpinPhase = spinPhase;
      }
    }

    const paused = Boolean(state?.paused);
    if (paramsChanged || (spinPhaseChanged && (paused || (spinPhaseJump && !opts?.isMotion)))) {
      this.resetAccumulation(true);
    }

    return { paramsChanged, spinPhaseChanged };
  }

  _writePulsarUniforms(state, cam, simTime, jitterX, jitterY, isProgressive, telemetry = null) {
    const f = this._pulsarF32;
    const tel = telemetry || computePulsarTelemetry(state);
    const skyRot = Array.isArray(state?.skyRotation) ? state.skyRotation : [0.40, 0.14];

    f[0] = this.width;
    f[1] = this.height;
    f[2] = Number.isFinite(simTime) ? simTime : 0.0;
    f[3] = this.frameIndex;

    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = cam.fovY;
    f[7] = Number.isFinite(tel?.lensingStrength)
      ? tel.lensingStrength
      : ((state?.lensingMode ?? 1) ? 1.0 : 0.0);

    f[8] = cam.pos[0];
    f[9] = cam.pos[1];
    f[10] = cam.pos[2];
    f[11] = Number.isFinite(tel?.compactness) ? tel.compactness : 0.21;

    f[12] = cam.right[0];
    f[13] = cam.right[1];
    f[14] = cam.right[2];
    f[15] = Number.isFinite(tel?.spinA) ? tel.spinA : 0.0;

    f[16] = cam.up[0];
    f[17] = cam.up[1];
    f[18] = cam.up[2];
    f[19] = Number.isFinite(tel?.betaEq) ? tel.betaEq : 0.0;

    f[20] = cam.forward[0];
    f[21] = cam.forward[1];
    f[22] = cam.forward[2];
    f[23] = Number.isFinite(Number(state?.spinPhase)) ? Number(state.spinPhase) : 0.0;

    f[24] = Number.isFinite(tel?.obliquityRad) ? tel.obliquityRad : (45 * Math.PI) / 180;
    f[25] = Number.isFinite(Number(state?.twistShear)) ? Number(state.twistShear) : 0.45;
    f[26] = Number.isFinite(tel?.rLightCylVis) ? tel.rLightCylVis : 7.6;
    f[27] = Number.isFinite(Number(state?.plasmaDensity)) ? Number(state.plasmaDensity) : 1.15;

    f[28] = Number.isFinite(Number(state?.beamIntensity)) ? Number(state.beamIntensity) : 1.35;
    f[29] = Number.isFinite(Number(state?.pwnVisibility)) ? Number(state.pwnVisibility) : 1.10;
    f[30] = Number.isFinite(Number(state?.polarCapTempK)) ? Number(state.polarCapTempK) : 6.5e6;
    f[31] = Number.isFinite(Number(state?.crustTempK)) ? Number(state.crustTempK) : 1.4e6;

    f[32] = Number.isFinite(Number(state?.skyIntensity)) ? Number(state.skyIntensity) : 0.90;
    f[33] = Number.isFinite(Number(state?.skyMode)) ? (Number(state.skyMode) | 0) : 0;
    f[34] = Number.isFinite(Number(skyRot[0])) ? Number(skyRot[0]) : 0.40;
    f[35] = Number.isFinite(Number(skyRot[1])) ? Number(skyRot[1]) : 0.14;

    f[36] = Number.isFinite(Number(state?.quality)) ? (Number(state.quality) | 0) : 1;
    f[37] = Number.isFinite(Number(state?.spinVisualSpeed)) ? Number(state.spinVisualSpeed) : 1.0;
    f[38] = isProgressive ? 1.0 : 0.0;
    f[39] = Number.isFinite(tel?.surfaceRedshiftZ) ? tel.surfaceRedshiftZ : 0.313;

    f[40] = Number.isFinite(Number(state?.beamConeHalfAngle)) ? Number(state.beamConeHalfAngle) : 0.30;
    f[41] = Number.isFinite(Number(state?.magnetarCrackGlow)) ? Number(state.magnetarCrackGlow) : 0.25;
    f[42] = Number.isFinite(Number(state?.pwnJetPower)) ? Number(state.pwnJetPower) : 1.15;
    f[43] = 0.0;

    this.device.queue.writeBuffer(this.pulsarUniformBuf, 0, this._pulsarBufData);
  }

  _encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, isProgressive, telemetry = null) {
    if ((state?.skyMode | 0) === 2 && !this._procSkyBaked) {
      this._ensureProceduralSky();
    }
    this._writePulsarUniforms(state, cam, simTime, jitterX, jitterY, isProgressive, telemetry);

    const sceneView = this.post.getSceneView();
    if (this.pulsarPipeline && this.pulsarBindGroup && sceneView) {
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
      pass.setPipeline(this.pulsarPipeline);
      pass.setBindGroup(0, this.pulsarBindGroup);
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

  render(state, camMatrices, simTime = 0, options = {}) {
    if (this._disposed || this._deviceLost || !this.getAllShadersCompiled()) return false;

    const opts = options || {};
    const targetScale = Number(opts.effectiveResolutionScale ?? state?.resolutionScale ?? this.resolutionScale) || 1.0;
    if (this.width === 0 || this.height === 0 || Math.abs(targetScale - this.resolutionScale) > 1e-4) {
      this.resize(targetScale);
    }

    if (
      this._useQueueBackpressure &&
      !opts.forceComposite &&
      !opts.ignoreBackpressure &&
      this._inFlight >= MAX_FRAMES_IN_FLIGHT
    ) {
      return false;
    }

    const cam = extractCamVectors(camMatrices);
    const camMoved = this._didCameraMove(camMatrices, cam);
    const { spinPhaseChanged } = this._syncStateChangeTracking(state, opts);

    const motionFlag = typeof opts.isMotion === 'boolean' ? opts.isMotion : false;
    const isMotion = camMoved || motionFlag || (!state?.paused && spinPhaseChanged);
    const isProgressive = Boolean(state?.paused && !camMoved && !motionFlag);

    if (isProgressive !== this._wasProgressive) {
      this.sampleCount = 0;
      this._wasProgressive = isProgressive;
      this._postDirty = true;
    }

    if (camMoved) {
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

        this.profiler?.beginFrame();

        const encoder = this.device.createCommandEncoder({ label: 'frame-progressive' });
        this._encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, true, opts.telemetry || null);
        this.post.encodeBloomAndAnamorphic(encoder, state);
        this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame(encoder);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      } else if (this._postDirty || opts.forceComposite) {
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
    } else if (isMotion) {
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
    this._encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, false, opts.telemetry || null);
    this.post.encodeBloomAndAnamorphic(encoder, state);
    this.post.encodeComposite(encoder, state, this.width, this.height, simTime, this.frameIndex);
    this.profiler?.endFrame(encoder);
    this._submitFrame(encoder.finish());
    this._postDirty = false;
    return true;
  }

  async capturePNG(state, camMatrices, simTime = 0) {
    if (this._disposed || this._deviceLost || !this.getAllShadersCompiled()) {
      throw new Error('WebGPU renderer is unavailable.');
    }

    this.resize(state?.resolutionScale ?? this.resolutionScale);
    const cam = extractCamVectors(camMatrices);
    const camMoved = this._didCameraMove(camMatrices, cam);
    this._syncStateChangeTracking(state, { isMotion: false });

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
      if (this.sampleCount === 0 || this._hardReset || camMoved) {
        this.frameIndex++;
        this.sampleCount = 1;
        this._hardReset = false;
        this._encodePulsarAndTaa(encoder, state, cam, simTime, 0.0, 0.0, 1.0, Boolean(state?.paused));
      }
      this.post.encodeBloomAndAnamorphic(encoder, state);
      this.post.encodeComposite(
        encoder,
        state,
        this.width,
        this.height,
        simTime,
        this.frameIndex,
        offscreenTex.createView()
      );
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
    this.profiler?.dispose();
    this.post?.dispose();
    this.volumeNoiseTex?.destroy();
    this.blackbodyTex?.destroy();
    this.blueNoiseTex?.destroy();
    if (this.skyTex && this.skyTex !== this.procSkyTex) {
      this.skyTex.destroy();
    }
    this.procSkyTex?.destroy();
    this.pulsarUniformBuf?.destroy();
    try {
      this.context?.unconfigure?.();
    } catch {
      // Ignore
    }
    try {
      this.device?.destroy?.();
    } catch {
      // Ignore
    }
  }
}
