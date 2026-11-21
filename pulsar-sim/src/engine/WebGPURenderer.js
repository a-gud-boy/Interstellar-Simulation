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

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../shaders/common.wgsl.js';
import { PULSAR_WGSL } from '../shaders/pulsar.wgsl.js';
import {
  TAA_WGSL,
  BLOOM_PREFILTER_WGSL,
  BLOOM_DOWNSAMPLE_WGSL,
  BLOOM_UPSAMPLE_WGSL,
  ANAMORPHIC_WGSL,
  COMPOSITE_WGSL,
} from '../shaders/post.wgsl.js';
import { computePulsarTelemetry } from './PulsarPhysics.js';
import { createProceduralSkyTextureWebGPU } from '../assets/skyLoader.js';
import { createBlackbodyLUTWebGPU, createBlueNoiseLUTWebGPU } from '../assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const BLOOM_MIP_COUNT = 6;
const MAX_PROGRESSIVE_SAMPLES = 128;
const MAX_DPR = 1.5;
const MAX_FRAMES_IN_FLIGHT = 3;

function halton(index, base) {
  let result = 0.0;
  let f = 1.0 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

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

function buildPhysicsStateSignature(state) {
  const skyRot = Array.isArray(state?.skyRotation) ? state.skyRotation : [0.40, 0.14];
  return [
    Number(state?.lensingMode ?? 1) ? 1 : 0,
    Number.isFinite(Number(state?.compactness)) ? Number(state.compactness) : 0.21,
    Number.isFinite(Number(state?.spinPeriodMs)) ? Number(state.spinPeriodMs) : 33.0,
    Number.isFinite(Number(state?.spinVisualSpeed)) ? Number(state.spinVisualSpeed) : 1.0,
    Number.isFinite(Number(state?.obliquityDeg)) ? Number(state.obliquityDeg) : 45.0,
    Number.isFinite(Number(state?.twistShear)) ? Number(state.twistShear) : 0.45,
    Number.isFinite(Number(state?.plasmaDensity)) ? Number(state.plasmaDensity) : 1.15,
    Number.isFinite(Number(state?.beamIntensity)) ? Number(state.beamIntensity) : 1.35,
    Number.isFinite(Number(state?.pwnVisibility)) ? Number(state.pwnVisibility) : 1.10,
    Number.isFinite(Number(state?.polarCapTempK)) ? Number(state.polarCapTempK) : 6.5e6,
    Number.isFinite(Number(state?.crustTempK)) ? Number(state.crustTempK) : 1.4e6,
    Number.isFinite(Number(state?.skyIntensity)) ? Number(state.skyIntensity) : 0.90,
    Number.isFinite(Number(state?.skyMode)) ? (Number(state.skyMode) | 0) : 0,
    Number.isFinite(Number(skyRot[0])) ? Number(skyRot[0]) : 0.40,
    Number.isFinite(Number(skyRot[1])) ? Number(skyRot[1]) : 0.14,
    Number.isFinite(Number(state?.quality)) ? (Number(state.quality) | 0) : 1,
    Number.isFinite(Number(state?.beamConeHalfAngle)) ? Number(state.beamConeHalfAngle) : 0.30,
    Number.isFinite(Number(state?.magnetarCrackGlow)) ? Number(state.magnetarCrackGlow) : 0.25,
    Number.isFinite(Number(state?.pwnJetPower)) ? Number(state.pwnJetPower) : 1.15,
  ];
}

function formatAdapterName(info) {
  if (!info) return 'WebGPU (Hardware GPU)';
  const vendor = (info.vendor || '').trim();
  const arch = (info.architecture || '').trim();
  const desc = (info.description || '').trim();
  const dev = (info.device || '').trim();
  if (info.isFallbackAdapter) {
    return `WebGPU (Software Fallback${desc ? `: ${desc}` : ''})`;
  }
  if (desc) {
    if (vendor && !desc.toLowerCase().includes(vendor.toLowerCase())) {
      return `WebGPU (${vendor.toUpperCase()} ${desc})`;
    }
    return `WebGPU (${desc})`;
  }
  const parts = [vendor ? vendor.toUpperCase() : '', arch, dev].filter(Boolean);
  if (parts.length > 0) {
    return `WebGPU (${parts.join(' · ')})`;
  }
  return 'WebGPU (Hardware GPU)';
}

function formatWgslMessages(name, messages) {
  const errs = messages.filter((m) => m.type === 'error');
  if (errs.length === 0) return null;
  return (
    `[WebGPURenderer] ${name} WGSL compile failed:\n` +
    errs.map((m) => `  line ${m.lineNum}:${m.linePos} — ${m.message}`).join('\n')
  );
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
    this.taaReadIdx = 0;
    this.taaWriteIdx = 1;

    this._hardReset = true;
    this._postDirty = true;
    this._wasProgressive = false;
    this._disposed = false;
    this._deviceLost = false;
    this._inFlight = 0;
    this._useQueueBackpressure = true;
    this._prevCamSig = null;
    this._prevStateSig = null;
    this._prevSpinPhase = null;

    this.sceneRt = null;
    this.taaRts = [null, null];
    this.bloomDownRts = [];
    this.bloomUpRts = [];
    this.anaRtA = null;
    this.anaRtB = null;

    this.pulsarBindGroup = null;
    this.taaBindGroups = [null, null];
    this.bloomPreBindGroups = [null, null];
    this.bloomDownBindGroups = [];
    this.bloomUpBindGroups = [];
    this.anaBindGroup0 = null;
    this.anaBindGroup1 = null;
    this.compBindGroups = [null, null];

    // Locked 176 bytes = 11 vec4<f32> slots for PulsarUniforms
    this._pulsarBufData = new ArrayBuffer(176);
    this._pulsarF32 = new Float32Array(this._pulsarBufData);

    this._taaF32 = new Float32Array(4);
    this._bloomPreF32 = new Float32Array(8);
    this._bloomDownF32 = Array.from({ length: BLOOM_MIP_COUNT }, () => new Float32Array(4));
    this._bloomUpF32 = Array.from({ length: BLOOM_MIP_COUNT - 1 }, () => new Float32Array(4));
    this._anaF32_0 = new Float32Array(8);
    this._anaF32_1 = new Float32Array(8);
    this._compF32 = new Float32Array(8);
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
      modTaa,
      modBloomPre,
      modBloomDown,
      modBloomUp,
      modAna,
      modComp,
    ] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('pulsar', PULSAR_WGSL, true),
      this._compileModule('taa', TAA_WGSL, true),
      this._compileModule('bloomPrefilter', BLOOM_PREFILTER_WGSL, true),
      this._compileModule('bloomDownsample', BLOOM_DOWNSAMPLE_WGSL, true),
      this._compileModule('bloomUpsample', BLOOM_UPSAMPLE_WGSL, true),
      this._compileModule('anamorphic', ANAMORPHIC_WGSL, true),
      this._compileModule('composite', COMPOSITE_WGSL, true),
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

    if (modTaa) {
      this.taaBgl = device.createBindGroupLayout({
        label: 'taa-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.taaPipeline = device.createRenderPipeline({
        label: 'taa-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.taaBgl] }),
        vertex: { module: modTaa, entryPoint: 'vs_main' },
        fragment: {
          module: modTaa,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    this.singleSrcPostBgl = device.createBindGroupLayout({
      label: 'single-src-post-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    if (modBloomPre) {
      this.bloomPrePipeline = device.createRenderPipeline({
        label: 'bloom-prefilter-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.singleSrcPostBgl] }),
        vertex: { module: modBloomPre, entryPoint: 'vs_main' },
        fragment: {
          module: modBloomPre,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    if (modBloomDown) {
      this.bloomDownPipeline = device.createRenderPipeline({
        label: 'bloom-downsample-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.singleSrcPostBgl] }),
        vertex: { module: modBloomDown, entryPoint: 'vs_main' },
        fragment: {
          module: modBloomDown,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    if (modBloomUp) {
      this.bloomUpBgl = device.createBindGroupLayout({
        label: 'bloom-upsample-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.bloomUpPipeline = device.createRenderPipeline({
        label: 'bloom-upsample-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.bloomUpBgl] }),
        vertex: { module: modBloomUp, entryPoint: 'vs_main' },
        fragment: {
          module: modBloomUp,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    if (modAna) {
      this.anaPipeline = device.createRenderPipeline({
        label: 'anamorphic-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.singleSrcPostBgl] }),
        vertex: { module: modAna, entryPoint: 'vs_main' },
        fragment: {
          module: modAna,
          entryPoint: 'fs_main',
          targets: [{ format: this.hdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

    if (modComp) {
      this.compBgl = device.createBindGroupLayout({
        label: 'composite-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.compPipeline = device.createRenderPipeline({
        label: 'composite-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.compBgl] }),
        vertex: { module: modComp, entryPoint: 'vs_main' },
        fragment: {
          module: modComp,
          entryPoint: 'fs_main',
          targets: [{ format: this.canvasFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }

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
    this.taaUniformBuf = makeUbo('taa-ubo', 16);
    this.bloomPreUniformBuf = makeUbo('bloom-pre-ubo', 32);
    this.bloomDownUniformBufs = Array.from({ length: BLOOM_MIP_COUNT }, (_, i) =>
      makeUbo(`bloom-down-ubo-${i}`, 16)
    );
    this.bloomUpUniformBufs = Array.from({ length: BLOOM_MIP_COUNT - 1 }, (_, i) =>
      makeUbo(`bloom-up-ubo-${i}`, 16)
    );
    this.anaUniformBuf0 = makeUbo('ana-ubo-0', 32);
    this.anaUniformBuf1 = makeUbo('ana-ubo-1', 32);
    this.compUniformBuf = makeUbo('comp-ubo', 32);

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

  _createRenderTarget(label, width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const texture = this.device.createTexture({
      label,
      size: [w, h, 1],
      format: this.hdrFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { texture, view: texture.createView(), width: w, height: h };
  }

  _destroyRenderTarget(rt) {
    if (rt?.texture) {
      rt.texture.destroy();
    }
  }

  _destroyPipelineTargets() {
    this._destroyRenderTarget(this.sceneRt);
    this._destroyRenderTarget(this.taaRts[0]);
    this._destroyRenderTarget(this.taaRts[1]);
    for (const rt of this.bloomDownRts) this._destroyRenderTarget(rt);
    for (const rt of this.bloomUpRts) this._destroyRenderTarget(rt);
    this._destroyRenderTarget(this.anaRtA);
    this._destroyRenderTarget(this.anaRtB);

    this.sceneRt = null;
    this.taaRts = [null, null];
    this.bloomDownRts = [];
    this.bloomUpRts = [];
    this.anaRtA = null;
    this.anaRtB = null;

    this.taaBindGroups = [null, null];
    this.bloomPreBindGroups = [null, null];
    this.bloomDownBindGroups = [];
    this.bloomUpBindGroups = [];
    this.anaBindGroup0 = null;
    this.anaBindGroup1 = null;
    this.compBindGroups = [null, null];
  }

  _rebuildPostBindGroups() {
    const device = this.device;
    if (!this.sceneRt || !this.taaBgl || !this.singleSrcPostBgl || !this.bloomUpBgl || !this.compBgl) {
      return;
    }

    const clearEnc = device.createCommandEncoder({ label: 'clear-rts' });
    for (const rt of [this.taaRts[0], this.taaRts[1], this.bloomUpRts[0], this.anaRtB]) {
      if (!rt) continue;
      const p = clearEnc.beginRenderPass({
        colorAttachments: [
          {
            view: rt.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      p.end();
    }
    device.queue.submit([clearEnc.finish()]);

    for (let readIdx = 0; readIdx < 2; readIdx++) {
      this.taaBindGroups[readIdx] = device.createBindGroup({
        label: `taa-bg-${readIdx}`,
        layout: this.taaBgl,
        entries: [
          { binding: 0, resource: { buffer: this.taaUniformBuf } },
          { binding: 1, resource: this.sceneRt.view },
          { binding: 2, resource: this.taaRts[readIdx].view },
          { binding: 3, resource: this.sLinearClamp },
        ],
      });

      this.bloomPreBindGroups[readIdx] = device.createBindGroup({
        label: `bloom-pre-bg-${readIdx}`,
        layout: this.singleSrcPostBgl,
        entries: [
          { binding: 0, resource: { buffer: this.bloomPreUniformBuf } },
          { binding: 1, resource: this.taaRts[readIdx].view },
          { binding: 2, resource: this.sLinearClamp },
        ],
      });

      this.compBindGroups[readIdx] = device.createBindGroup({
        label: `comp-bg-${readIdx}`,
        layout: this.compBgl,
        entries: [
          { binding: 0, resource: { buffer: this.compUniformBuf } },
          { binding: 1, resource: this.taaRts[readIdx].view },
          { binding: 2, resource: this.bloomUpRts[0].view },
          { binding: 3, resource: this.anaRtB.view },
          { binding: 4, resource: this.sLinearClamp },
        ],
      });
    }

    this.bloomDownBindGroups = new Array(BLOOM_MIP_COUNT).fill(null);
    for (let i = 1; i < BLOOM_MIP_COUNT; i++) {
      this.bloomDownBindGroups[i] = device.createBindGroup({
        label: `bloom-down-bg-${i}`,
        layout: this.singleSrcPostBgl,
        entries: [
          { binding: 0, resource: { buffer: this.bloomDownUniformBufs[i] } },
          { binding: 1, resource: this.bloomDownRts[i - 1].view },
          { binding: 2, resource: this.sLinearClamp },
        ],
      });
    }

    this.bloomUpBindGroups = new Array(BLOOM_MIP_COUNT - 1).fill(null);
    for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
      const lowSrc = i === BLOOM_MIP_COUNT - 2 ? this.bloomDownRts[i + 1] : this.bloomUpRts[i + 1];
      const highSrc = this.bloomDownRts[i];
      this.bloomUpBindGroups[i] = device.createBindGroup({
        label: `bloom-up-bg-${i}`,
        layout: this.bloomUpBgl,
        entries: [
          { binding: 0, resource: { buffer: this.bloomUpUniformBufs[i] } },
          { binding: 1, resource: lowSrc.view },
          { binding: 2, resource: highSrc.view },
          { binding: 3, resource: this.sLinearClamp },
        ],
      });
    }

    this.anaBindGroup0 = device.createBindGroup({
      label: 'ana-bg-0',
      layout: this.singleSrcPostBgl,
      entries: [
        { binding: 0, resource: { buffer: this.anaUniformBuf0 } },
        { binding: 1, resource: this.bloomDownRts[1].view },
        { binding: 2, resource: this.sLinearClamp },
      ],
    });
    this.anaBindGroup1 = device.createBindGroup({
      label: 'ana-bg-1',
      layout: this.singleSrcPostBgl,
      entries: [
        { binding: 0, resource: { buffer: this.anaUniformBuf1 } },
        { binding: 1, resource: this.anaRtA.view },
        { binding: 2, resource: this.sLinearClamp },
      ],
    });

    this._writeStaticPostUniforms();
  }

  _writeStaticPostUniforms() {
    const device = this.device;
    if (!this.bloomDownRts.length || !this.anaRtA) return;

    const pf = this._bloomPreF32;
    pf[0] = 1.0 / this.width;
    pf[1] = 1.0 / this.height;
    pf[2] = 1.30;
    pf[3] = 0.45;
    pf[4] = 11.0;
    pf[5] = 0.0;
    pf[6] = 0.0;
    pf[7] = 0.0;
    device.queue.writeBuffer(this.bloomPreUniformBuf, 0, pf);

    for (let i = 1; i < BLOOM_MIP_COUNT; i++) {
      const src = this.bloomDownRts[i - 1];
      const df = this._bloomDownF32[i];
      df[0] = 1.0 / src.width;
      df[1] = 1.0 / src.height;
      df[2] = i === 1 ? 1.0 : 0.0;
      df[3] = 0.0;
      device.queue.writeBuffer(this.bloomDownUniformBufs[i], 0, df);
    }

    for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
      const lowSrc = i === BLOOM_MIP_COUNT - 2 ? this.bloomDownRts[i + 1] : this.bloomUpRts[i + 1];
      const uf = this._bloomUpF32[i];
      uf[0] = 1.0 / lowSrc.width;
      uf[1] = 1.0 / lowSrc.height;
      uf[2] = 1.05;
      uf[3] = 0.66;
      device.queue.writeBuffer(this.bloomUpUniformBufs[i], 0, uf);
    }

    const src0 = this.bloomDownRts[1];
    const f0 = this._anaF32_0;
    f0[0] = 1.0 / src0.width;
    f0[1] = 1.0 / src0.height;
    f0[2] = 1.85;
    f0[3] = 1.05;
    f0[4] = 0.0;
    device.queue.writeBuffer(this.anaUniformBuf0, 0, f0);

    const f1 = this._anaF32_1;
    f1[0] = 1.0 / this.anaRtA.width;
    f1[1] = 1.0 / this.anaRtA.height;
    f1[2] = 0.0;
    f1[3] = 1.15;
    f1[4] = 1.0;
    device.queue.writeBuffer(this.anaUniformBuf1, 0, f1);
  }

  resize(resolutionScale = this.resolutionScale) {
    if (this._disposed || this._deviceLost) return false;

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
      this.sceneRt
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

    this._destroyPipelineTargets();

    this.sceneRt = this._createRenderTarget('scene-rt', nextW, nextH);
    this.taaRts = [
      this._createRenderTarget('taa-rt-0', nextW, nextH),
      this._createRenderTarget('taa-rt-1', nextW, nextH),
    ];

    let mipW = Math.max(1, nextW >> 1);
    let mipH = Math.max(1, nextH >> 1);
    for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
      this.bloomDownRts.push(this._createRenderTarget(`bloom-down-${i}`, mipW, mipH));
      if (i < BLOOM_MIP_COUNT - 1) {
        this.bloomUpRts.push(this._createRenderTarget(`bloom-up-${i}`, mipW, mipH));
      }
      mipW = Math.max(1, mipW >> 1);
      mipH = Math.max(1, mipH >> 1);
    }

    const anaW = Math.max(1, nextW >> 2);
    const anaH = Math.max(1, nextH >> 2);
    this.anaRtA = this._createRenderTarget('ana-rt-a', anaW, anaH);
    this.anaRtB = this._createRenderTarget('ana-rt-b', anaW, anaH);

    this._rebuildPostBindGroups();
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

  markReset(hard = true) {
    this.resetAccumulation(hard);
  }

  markPostDirty() {
    this._postDirty = true;
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
    const sig = [
      cam.pos[0], cam.pos[1], cam.pos[2],
      cam.right[0], cam.right[1], cam.right[2],
      cam.up[0], cam.up[1], cam.up[2],
      cam.forward[0], cam.forward[1], cam.forward[2],
      cam.fovY,
    ];
    let sigChanged = false;
    if (!this._prevCamSig) {
      sigChanged = true;
      this._prevCamSig = sig;
    } else {
      for (let i = 0; i < sig.length; i++) {
        if (Math.abs(sig[i] - this._prevCamSig[i]) > 1e-6) {
          sigChanged = true;
          break;
        }
      }
      if (sigChanged) this._prevCamSig = sig;
    }
    return typeof camMatrices?.moved === 'boolean' ? (camMatrices.moved || sigChanged) : sigChanged;
  }

  _syncStateChangeTracking(state, opts) {
    const sig = buildPhysicsStateSignature(state);
    let paramsChanged = false;
    if (!this._prevStateSig) {
      this._prevStateSig = sig;
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
        this._prevStateSig = sig;
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

  _writePulsarUniforms(state, cam, simTime, jitterX, jitterY, isProgressive) {
    const f = this._pulsarF32;
    const tel = computePulsarTelemetry(state);
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

  _encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, isProgressive) {
    this._writePulsarUniforms(state, cam, simTime, jitterX, jitterY, isProgressive);

    this._taaF32[0] = 1.0 / this.width;
    this._taaF32[1] = 1.0 / this.height;
    this._taaF32[2] = blendFactor;
    this._taaF32[3] = isProgressive ? 1.0 : 0.0;
    this.device.queue.writeBuffer(this.taaUniformBuf, 0, this._taaF32);

    if (this.pulsarPipeline && this.pulsarBindGroup) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.sceneRt.view,
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

    const outputRt = this.taaRts[this.taaWriteIdx];
    const taaBg = this.taaBindGroups[this.taaReadIdx];
    if (this.taaPipeline && taaBg) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: outputRt.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.taaPipeline);
      pass.setBindGroup(0, taaBg);
      pass.draw(3);
      pass.end();

      const tmp = this.taaReadIdx;
      this.taaReadIdx = this.taaWriteIdx;
      this.taaWriteIdx = tmp;
    }
  }

  _encodeBloomAndAnamorphic(encoder, state) {
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : 0.62;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : 0.42;
    const needBloom = bloomIntensity > 0.001;
    const needAnamorphic = anamorphicIntensity > 0.001;
    if (!needBloom && !needAnamorphic) return;

    const preBg = this.bloomPreBindGroups[this.taaReadIdx];
    if (this.bloomPrePipeline && preBg) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.bloomDownRts[0].view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.bloomPrePipeline);
      pass.setBindGroup(0, preBg);
      pass.draw(3);
      pass.end();
    }

    if (this.bloomDownPipeline) {
      const maxDownLevel = needBloom ? BLOOM_MIP_COUNT - 1 : 1;
      for (let i = 1; i <= maxDownLevel; i++) {
        const dst = this.bloomDownRts[i];
        const bg = this.bloomDownBindGroups[i];
        if (!bg) continue;

        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: dst.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(this.bloomDownPipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      }
    }

    if (needBloom && this.bloomUpPipeline) {
      for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
        const dst = this.bloomUpRts[i];
        const bg = this.bloomUpBindGroups[i];
        if (!bg) continue;

        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: dst.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(this.bloomUpPipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      }
    }

    if (needAnamorphic && this.anaPipeline && this.anaBindGroup0 && this.anaBindGroup1) {
      const pass0 = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.anaRtA.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass0.setPipeline(this.anaPipeline);
      pass0.setBindGroup(0, this.anaBindGroup0);
      pass0.draw(3);
      pass0.end();

      const pass1 = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.anaRtB.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass1.setPipeline(this.anaPipeline);
      pass1.setBindGroup(0, this.anaBindGroup1);
      pass1.draw(3);
      pass1.end();
    }
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

  _encodeComposite(encoder, state, simTime, targetView = null) {
    const compBg = this.compBindGroups[this.taaReadIdx];
    if (!this.compPipeline || !compBg) return;

    const exposure = Number.isFinite(Number(state?.exposure)) ? Number(state.exposure) : 1.05;
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : 0.62;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : 0.42;

    const f = this._compF32;
    f[0] = this.width;
    f[1] = this.height;
    f[2] = exposure;
    f[3] = bloomIntensity;
    f[4] = anamorphicIntensity;
    f[5] = Number.isFinite(simTime) ? simTime : 0.0;
    f[6] = this.frameIndex & 255;
    f[7] = 0.0;
    this.device.queue.writeBuffer(this.compUniformBuf, 0, f);

    const view = targetView || this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.compPipeline);
    pass.setBindGroup(0, compBg);
    pass.draw(3);
    pass.end();
  }

  render(state, camMatrices, simTime = 0, options = {}) {
    if (this._disposed || this._deviceLost || !this.getAllShadersCompiled()) return false;

    const opts = options || {};
    this.resize(state?.resolutionScale ?? this.resolutionScale);

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

        const encoder = this.device.createCommandEncoder({ label: 'frame-progressive' });
        this._encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, true);
        this._encodeBloomAndAnamorphic(encoder, state);
        this._encodeComposite(encoder, state, simTime);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      } else if (this._postDirty || opts.forceComposite) {
        const encoder = this.device.createCommandEncoder({ label: 'frame-regrade' });
        this._encodeBloomAndAnamorphic(encoder, state);
        this._encodeComposite(encoder, state, simTime);
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

    const encoder = this.device.createCommandEncoder({ label: 'frame-taa' });
    this._encodePulsarAndTaa(encoder, state, cam, simTime, jitterX, jitterY, blendFactor, false);
    this._encodeBloomAndAnamorphic(encoder, state);
    this._encodeComposite(encoder, state, simTime);
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
      this._encodeBloomAndAnamorphic(encoder, state);
      this._encodeComposite(encoder, state, simTime, offscreenTex.createView());
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
    this._destroyPipelineTargets();
    this.volumeNoiseTex?.destroy();
    this.blackbodyTex?.destroy();
    this.blueNoiseTex?.destroy();
    if (this.skyTex && this.skyTex !== this.procSkyTex) {
      this.skyTex.destroy();
    }
    this.procSkyTex?.destroy();
    this.pulsarUniformBuf?.destroy();
    this.taaUniformBuf?.destroy();
    this.bloomPreUniformBuf?.destroy();
    for (const b of this.bloomDownUniformBufs || []) b.destroy();
    for (const b of this.bloomUpUniformBufs || []) b.destroy();
    this.anaUniformBuf0?.destroy();
    this.anaUniformBuf1?.destroy();
    this.compUniformBuf?.destroy();
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
