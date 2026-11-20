/**
 * WebGPURenderer.js — WebGPU rgba16float/rg11b10ufloat multi-pass HDR rendering pipeline
 * for Binary Black Hole Inspiral & Gravitational Wave Lensing Simulator:
 *  - Startup 3D Compute Shader 128x128x128 volume noise baker (NOISE_BAKE_COMPUTE_WGSL)
 *  - Per-frame 256x256 rgba16float Compute Shader co-rotating tidal hydrodynamics (TIDAL_FIELD_COMPUTE_WGSL)
 *  - Pass 1: Brill-Lindquist + 1PN GM + Cartesian TT GW geodesic ray-tracer (BINARY_BH_WGSL)
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + CA, vignette, film grain & sRGB composite
 */

import { MIPMAP_WGSL, NOISE_BAKE_COMPUTE_WGSL } from '../shaders/common.wgsl.js';
import { TIDAL_FIELD_COMPUTE_WGSL } from '../shaders/tidal.wgsl.js';
import { BINARY_BH_WGSL } from '../shaders/binary.wgsl.js';
import {
  TAA_WGSL,
  BLOOM_PREFILTER_WGSL,
  BLOOM_DOWNSAMPLE_WGSL,
  BLOOM_UPSAMPLE_WGSL,
  ANAMORPHIC_WGSL,
  COMPOSITE_WGSL,
} from '../shaders/post.wgsl.js';
import { createProceduralSkyTextureWebGPU } from '../assets/skyLoader.js';
import { createBlackbodyLUTWebGPU, createBlueNoiseLUTWebGPU } from '../assets/physicalLuts.js';
import { computeBinaryState } from './BinaryPhysics.js';

const VOLUME_SIZE = 128;
const TIDAL_SIZE = 256;
const BLOOM_MIP_COUNT = 6;
const MAX_PROGRESSIVE_SAMPLES = 128;
const MAX_DPR = 1.5;
const MAX_FRAMES_IN_FLIGHT = 2;

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
    this.tidalComputed = false;
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
    this.tidalReadIdx = 0;
    this.tidalWriteIdx = 1;
    this._tidalReset = true;
    this._lastTidalSig = null;

    this._hardReset = true;
    this._postDirty = true;
    this._wasProgressive = false;
    this._disposed = false;
    this._inFlight = 0;
    this._useQueueBackpressure = true;

    this.sceneRt = null;
    this.taaRts = [null, null];
    this.bloomDownRts = [];
    this.bloomUpRts = [];
    this.anaRtA = null;
    this.anaRtB = null;

    this.tidalBindGroups = [null, null];
    this.binBindGroups = [null, null];
    this.taaBindGroups = [null, null];
    this.bloomPreBindGroups = [null, null];
    this.bloomDownBindGroups = [];
    this.bloomUpBindGroups = [];
    this.anaBindGroup0 = null;
    this.anaBindGroup1 = null;
    this.compBindGroups = [null, null];

    // 288 bytes = 18 vec4 slots for BinaryUniforms; 64 bytes = 4 vec4 slots for TidalUniforms
    this._binBufData = new ArrayBuffer(288);
    this._binF32 = new Float32Array(this._binBufData);
    this._binI32 = new Int32Array(this._binBufData);
    this._tidalF32 = new Float32Array(16);

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
      throw new Error(
        'WebGPU (navigator.gpu) is unavailable in this browser. Launch via ./launch.sh or ./launch.sh --firefox.'
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new Error('No WebGPU GPU adapter found. On Linux Wayland + NVIDIA laptops, run ./launch.sh.');
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
      modTidal,
      modBinary,
      modTaa,
      modBloomPre,
      modBloomDown,
      modBloomUp,
      modAna,
      modComp,
    ] = await Promise.all([
      this._compileModule('noiseBake', NOISE_BAKE_COMPUTE_WGSL, true),
      this._compileModule('mipmap', MIPMAP_WGSL, false),
      this._compileModule('tidal', TIDAL_FIELD_COMPUTE_WGSL, true),
      this._compileModule('binary', BINARY_BH_WGSL, true),
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

    if (modTidal) {
      this.tidalBgl = device.createBindGroupLayout({
        label: 'tidal-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
          {
            binding: 3,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
          },
        ],
      });
      this.tidalPipeline = device.createComputePipeline({
        label: 'tidal-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.tidalBgl] }),
        compute: { module: modTidal, entryPoint: 'main' },
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

    if (modBinary) {
      this.binBgl = device.createBindGroupLayout({
        label: 'binary-bgl',
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
          { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      this.binPipeline = device.createRenderPipeline({
        label: 'binary-pipe',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.binBgl] }),
        vertex: { module: modBinary, entryPoint: 'vs_main' },
        fragment: {
          module: modBinary,
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

    this.binUniformBuf = makeUbo('binary-ubo', 288);
    this.tidalUniformBuf = makeUbo('tidal-ubo', 64);
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

    this._createTidalTextures();

    await device.queue.onSubmittedWorkDone();
    const syncStart = performance.now();
    const probeEnc = device.createCommandEncoder({ label: 'sync-probe' });
    device.queue.submit([probeEnc.finish()]);
    await device.queue.onSubmittedWorkDone();
    this._useQueueBackpressure = performance.now() - syncStart < 20.0;

    this._rebuildBinaryBindGroups();
    this.resize(1.0);
  }

  _createTidalTextures() {
    const device = this.device;
    const makeTidalTex = (label) =>
      device.createTexture({
        label,
        size: [TIDAL_SIZE, TIDAL_SIZE, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });

    this.tidalTexA = makeTidalTex('tidal-field-a');
    this.tidalTexB = makeTidalTex('tidal-field-b');
    this.tidalViews = [this.tidalTexA.createView(), this.tidalTexB.createView()];

    if (this.tidalBgl) {
      this.tidalBindGroups = [
        device.createBindGroup({
          label: 'tidal-bg-0',
          layout: this.tidalBgl,
          entries: [
            { binding: 0, resource: { buffer: this.tidalUniformBuf } },
            { binding: 1, resource: this.tidalViews[0] },
            { binding: 2, resource: this.sLinearClamp },
            { binding: 3, resource: this.tidalViews[1] },
          ],
        }),
        device.createBindGroup({
          label: 'tidal-bg-1',
          layout: this.tidalBgl,
          entries: [
            { binding: 0, resource: { buffer: this.tidalUniformBuf } },
            { binding: 1, resource: this.tidalViews[1] },
            { binding: 2, resource: this.sLinearClamp },
            { binding: 3, resource: this.tidalViews[0] },
          ],
        }),
      ];
    }

    // Seed initial tidal state immediately on startup
    if (this.tidalPipeline && this.tidalBindGroups[0]) {
      const defBin = computeBinaryState({ massRatio: 1.0, separation: 7.4 }, 0.0);
      const halfSz = Math.max(28.0 * 1.15, defBin.d * 3.8);
      this._writeTidalUniforms(
        { diskDensity: 1.15, bridgeIntensity: 1.25, diskOuterRadius: 28.0 },
        defBin,
        halfSz,
        0.0,
        0.0,
        true
      );
      const enc = device.createCommandEncoder({ label: 'init-tidal' });
      const pass = enc.beginComputePass();
      pass.setPipeline(this.tidalPipeline);
      pass.setBindGroup(0, this.tidalBindGroups[this.tidalReadIdx]);
      const wg = Math.ceil(TIDAL_SIZE / 8);
      pass.dispatchWorkgroups(wg, wg, 1);
      pass.end();
      device.queue.submit([enc.finish()]);
      const tmp = this.tidalReadIdx;
      this.tidalReadIdx = this.tidalWriteIdx;
      this.tidalWriteIdx = tmp;
      this.tidalComputed = true;
    }
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

  _rebuildBinaryBindGroups() {
    if (!this.binBgl || !this.volumeNoiseView || !this.skyView || !this.procSkyView || !this.tidalViews?.[0]) {
      return;
    }
    for (let idx = 0; idx < 2; idx++) {
      this.binBindGroups[idx] = this.device.createBindGroup({
        label: `binary-bg-${idx}`,
        layout: this.binBgl,
        entries: [
          { binding: 0, resource: { buffer: this.binUniformBuf } },
          { binding: 1, resource: this.volumeNoiseView },
          { binding: 2, resource: this.sVolumeRepeat },
          { binding: 3, resource: this.skyView },
          { binding: 4, resource: this.procSkyView },
          { binding: 5, resource: this.sSkyAniso },
          { binding: 6, resource: this.blackbodyView },
          { binding: 7, resource: this.sLinearClamp },
          { binding: 8, resource: this.blueNoiseView },
          { binding: 9, resource: this.tidalViews[idx] },
        ],
      });
    }
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
      this._rebuildBinaryBindGroups();
      this.resetAccumulation(true);
    } else {
      if (texture && texture !== this.procSkyTex && texture !== this.skyTex) {
        texture.destroy();
      }
      this.skyMapLoaded = false;
    }
  }

  resetTidalField() {
    this._tidalReset = true;
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

  _writeTidalUniforms(state, binState, fieldHalfSize, simTime, dtSec, forceReset) {
    const f = this._tidalF32;
    f[0] = binState.d;
    f[1] = binState.q;
    f[2] = binState.omega;
    f[3] = state.diskDensity;

    f[4] = state.bridgeIntensity;
    f[5] = state.diskOuterRadius;
    f[6] = fieldHalfSize;
    f[7] = simTime;

    f[8] = dtSec;
    f[9] = forceReset ? 1.0 : 0.0;
    f[10] = binState.rocheL1;
    f[11] = binState.rocheL2;

    f[12] = binState.rCavity;
    f[13] = binState.ringdownFactor || 0.0;
    f[14] = 0.0;
    f[15] = 0.0;

    this.device.queue.writeBuffer(this.tidalUniformBuf, 0, f);
  }

  _writeBinaryUniforms(state, camData, simTime, binState, fieldHalfSize, jitterX, jitterY) {
    const f = this._binF32;
    const i = this._binI32;
    const basis = camData.basis;
    const skyRot = state.skyRotation || [0.42, 0.22];

    f[0] = this.width;
    f[1] = this.height;
    f[2] = simTime;
    f[3] = this.frameIndex;

    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = camData.fovY;
    f[7] = binState.phaseRad;

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
    f[27] = state.bridgeIntensity;

    f[28] = state.gwAmplitude;
    f[29] = state.skyIntensity;
    f[30] = skyRot[0] || 0;
    f[31] = skyRot[1] || 0;

    i[32] = this.frameIndex | 0;
    i[33] = state.skyMode | 0;
    i[34] = state.quality | 0;
    i[35] = 0;

    f[36] = binState.m1;
    f[37] = binState.m2;
    f[38] = binState.d;
    f[39] = binState.eta;

    f[40] = binState.c1[0];
    f[41] = binState.c1[1];
    f[42] = binState.c1[2];
    f[43] = binState.omega;

    f[44] = binState.c2[0];
    f[45] = binState.c2[1];
    f[46] = binState.c2[2];
    f[47] = binState.gwWaveOmega;

    f[48] = binState.v1[0];
    f[49] = binState.v1[1];
    f[50] = binState.v1[2];
    f[51] = binState.rH1;

    f[52] = binState.v2[0];
    f[53] = binState.v2[1];
    f[54] = binState.v2[2];
    f[55] = binState.rH2;

    const rOuter = Math.max(state.diskOuterRadius, binState.rCavity + 4.0);
    const camR = Math.hypot(camData.pos[0], camData.pos[1], camData.pos[2]);
    const escapeR = Math.max(Math.max(rOuter * 1.85, camR * 1.65), 62.0);
    const clampVal = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const tanHalfFov = Math.tan(clampVal(camData.fovY, 0.1, 2.8) * 0.5);
    const maxDiskSlabY = (0.054 + 0.033 * rOuter * 1.30) * Math.max(state.diskThickness, 0.15) * 2.75;

    f[56] = fieldHalfSize;
    f[57] = escapeR;
    f[58] = tanHalfFov;
    f[59] = binState.rCavity;

    const flowCycle = 15.0;
    const tNorm0 = simTime / flowCycle;
    const phase0 = tNorm0 - Math.floor(tNorm0);
    const tNorm1 = tNorm0 + 0.5;
    const phase1 = tNorm1 - Math.floor(tNorm1);
    f[60] = 0.5 - 0.5 * Math.cos(Math.PI * 2.0 * phase0);
    f[61] = (phase0 - 0.5) * flowCycle;
    f[62] = (phase1 - 0.5) * flowCycle;
    f[63] = simTime * 0.038;

    f[64] = Math.cos(binState.phaseRad);
    f[65] = Math.sin(binState.phaseRad);
    f[66] = Math.cos(skyRot[0] || 0);
    f[67] = Math.sin(skyRot[0] || 0);

    f[68] = Math.cos(skyRot[1] || 0);
    f[69] = Math.sin(skyRot[1] || 0);
    f[70] = binState.ringdownFactor || 0.0;
    f[71] = maxDiskSlabY;

    this.device.queue.writeBuffer(this.binUniformBuf, 0, this._binBufData);
  }

  _encodeTidalIfNeeded(encoder, state, binState, fieldHalfSize, simTime, dtSec, isProgressive) {
    const sig = [
      binState.q,
      state.diskDensity,
      state.bridgeIntensity,
      state.diskOuterRadius,
      binState.d,
    ];
    let needReset = this._tidalReset || !this._lastTidalSig;
    if (!needReset) {
      if (
        Math.abs(sig[0] - this._lastTidalSig[0]) > 1e-4 ||
        Math.abs(sig[1] - this._lastTidalSig[1]) > 1e-3 ||
        Math.abs(sig[2] - this._lastTidalSig[2]) > 1e-3 ||
        Math.abs(sig[3] - this._lastTidalSig[3]) > 0.1 ||
        Math.abs(sig[4] - this._lastTidalSig[4]) > 0.35
      ) {
        needReset = true;
      }
    }

    if (needReset || (!isProgressive && dtSec > 0.0)) {
      if (this.tidalPipeline && this.tidalBindGroups[this.tidalReadIdx]) {
        this._writeTidalUniforms(
          state,
          binState,
          fieldHalfSize,
          simTime,
          isProgressive ? 0.0 : dtSec,
          needReset
        );
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.tidalPipeline);
        pass.setBindGroup(0, this.tidalBindGroups[this.tidalReadIdx]);
        const wg = Math.ceil(TIDAL_SIZE / 8);
        pass.dispatchWorkgroups(wg, wg, 1);
        pass.end();

        const tmp = this.tidalReadIdx;
        this.tidalReadIdx = this.tidalWriteIdx;
        this.tidalWriteIdx = tmp;
        this.tidalComputed = true;
      }
      this._tidalReset = false;
      this._lastTidalSig = sig;
    }
  }

  _encodeBinaryAndTaa(encoder, state, camData, simTime, binState, fieldHalfSize, jitterX, jitterY, blendFactor, isProgressive) {
    this._writeBinaryUniforms(state, camData, simTime, binState, fieldHalfSize, jitterX, jitterY);

    this._taaF32[0] = 1.0 / this.width;
    this._taaF32[1] = 1.0 / this.height;
    this._taaF32[2] = blendFactor;
    this._taaF32[3] = isProgressive ? 1.0 : 0.0;
    this.device.queue.writeBuffer(this.taaUniformBuf, 0, this._taaF32);

    const binBg = this.binBindGroups[this.tidalReadIdx];
    if (this.binPipeline && binBg) {
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
      pass.setPipeline(this.binPipeline);
      pass.setBindGroup(0, binBg);
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
    const needBloom = state.bloomIntensity > 0.001;
    const needAnamorphic = state.anamorphicIntensity > 0.001;
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

    const f = this._compF32;
    f[0] = this.width;
    f[1] = this.height;
    f[2] = state.exposure;
    f[3] = state.bloomIntensity;
    f[4] = state.anamorphicIntensity;
    f[5] = simTime;
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

  render(state, camData, simTime, binState = null, options = {}) {
    if (this._disposed || !this.getAllShadersCompiled()) return false;

    this.resize(state.resolutionScale);

    if (
      this._useQueueBackpressure &&
      !options.forceComposite &&
      !options.ignoreBackpressure &&
      this._inFlight >= MAX_FRAMES_IN_FLIGHT
    ) {
      return false;
    }

    const activeBin = binState || computeBinaryState(state, simTime * 0.25);
    const fieldHalfSize = Math.max(Math.max(state.diskOuterRadius, activeBin.rCavity + 4.0) * 1.15, activeBin.d * 3.8);
    const dtSec = Math.max(0.0, Math.min(0.05, Number(options.dt ?? 0.016)));

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
        this._encodeTidalIfNeeded(encoder, state, activeBin, fieldHalfSize, simTime, 0.0, true);
        this._encodeBinaryAndTaa(encoder, state, camData, simTime, activeBin, fieldHalfSize, jitterX, jitterY, blendFactor, true);
        this._encodeBloomAndAnamorphic(encoder, state);
        this._encodeComposite(encoder, state, simTime);
        this._submitFrame(encoder.finish());
        this._postDirty = false;
        return true;
      } else if (this._postDirty || options.forceComposite) {
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
    this._encodeTidalIfNeeded(encoder, state, activeBin, fieldHalfSize, simTime, dtSec, false);
    this._encodeBinaryAndTaa(encoder, state, camData, simTime, activeBin, fieldHalfSize, jitterX, jitterY, blendFactor, false);
    this._encodeBloomAndAnamorphic(encoder, state);
    this._encodeComposite(encoder, state, simTime);
    this._submitFrame(encoder.finish());
    this._postDirty = false;
    return true;
  }

  async capturePNG(state, camData, simTime, binState = null) {
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

    const activeBin = binState || computeBinaryState(state, simTime * 0.25);
    const fieldHalfSize = Math.max(Math.max(state.diskOuterRadius, activeBin.rCavity + 4.0) * 1.15, activeBin.d * 3.8);

    try {
      const encoder = this.device.createCommandEncoder({ label: 'capture-png' });
      if (this.sampleCount === 0 || this._hardReset) {
        this.frameIndex++;
        this.sampleCount = 1;
        this._hardReset = false;
        this._encodeTidalIfNeeded(encoder, state, activeBin, fieldHalfSize, simTime, 0.0, true);
        this._encodeBinaryAndTaa(encoder, state, camData, simTime, activeBin, fieldHalfSize, 0.0, 0.0, 1.0, Boolean(state.paused));
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
    this.tidalTexA?.destroy();
    this.tidalTexB?.destroy();
    this.volumeNoiseTex?.destroy();
    this.blackbodyTex?.destroy();
    this.blueNoiseTex?.destroy();
    if (this.skyTex && this.skyTex !== this.procSkyTex) {
      this.skyTex.destroy();
    }
    this.procSkyTex?.destroy();
    this.binUniformBuf?.destroy();
    this.tidalUniformBuf?.destroy();
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
