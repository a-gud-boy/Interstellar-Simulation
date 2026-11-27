/**
 * SharedWebGPUPostPipeline.js — Shared WebGPU rgba16float/rg11b10ufloat HDR post pipeline:
 *  - Scene HDR target + ping-pong TAA history targets
 *  - HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Troy Sobotka AgX Filmic Tone Mapping + subtle CA, vignette, film grain & sRGB composite
 */

import { createPostShadersWGSL } from '../shaders/post.wgsl.js';
import { resolvePostOpticsProfile } from '../shaders/postConfig.js';

export const BLOOM_MIP_COUNT = 6;
export const MAX_PROGRESSIVE_SAMPLES = 128;
export const MAX_FRAMES_IN_FLIGHT = 2;

export function halton(index, base) {
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

export function formatAdapterName(info) {
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

export function formatWgslMessages(name, messages) {
  const errs = messages.filter((m) => m.type === 'error');
  if (errs.length === 0) return null;
  return (
    `[WebGPURenderer] ${name} WGSL compile failed:\n` +
    errs.map((m) => `  line ${m.lineNum}:${m.linePos} — ${m.message}`).join('\n')
  );
}

export class SharedWebGPUPostPipeline {
  /**
   * @param {{
   *   device: GPUDevice,
   *   context: GPUCanvasContext,
   *   canvasFormat: string,
   *   hdrFormat: string,
   *   sLinearClamp: GPUSampler,
   *   opticsProfile?: string,
   * }} opts
   */
  constructor(opts) {
    this.device = opts.device;
    this.context = opts.context;
    this.canvasFormat = opts.canvasFormat;
    this.hdrFormat = opts.hdrFormat;
    this.sLinearClamp = opts.sLinearClamp;
    this.opticsProfile = opts.opticsProfile || 'default';
    this.optics = resolvePostOpticsProfile(this.opticsProfile);

    this.sceneRt = null;
    this.taaRts = [null, null];
    this.bloomDownRts = [];
    this.bloomUpRts = [];
    this.anaRtA = null;
    this.anaRtB = null;
    this.taaReadIdx = 0;
    this.taaWriteIdx = 1;

    this.taaBindGroups = [null, null];
    this.bloomPreBindGroups = [null, null];
    this.bloomDownBindGroups = [];
    this.bloomUpBindGroups = [];
    this.anaBindGroup0 = null;
    this.anaBindGroup1 = null;
    this.compBindGroups = [null, null];

    this._taaF32 = new Float32Array(4);
    this._bloomPreF32 = new Float32Array(8);
    this._bloomDownF32 = Array.from({ length: BLOOM_MIP_COUNT }, () => new Float32Array(4));
    this._bloomUpF32 = Array.from({ length: BLOOM_MIP_COUNT - 1 }, () => new Float32Array(4));
    this._anaF32_0 = new Float32Array(16);
    this._anaF32_1 = new Float32Array(16);
    this._compF32 = new Float32Array(12);
  }

  /**
   * Compiles the 6 post WGSL modules, creates render pipelines + dedicated per-pass uniform buffers.
   * @param {(name: string, code: string, recordStatus?: boolean) => Promise<GPUShaderModule|null>} compileModule
   */
  async init(compileModule) {
    const device = this.device;
    const shaders = createPostShadersWGSL(this.opticsProfile);

    const [modTaa, modBloomPre, modBloomDown, modBloomUp, modAna, modComp] = await Promise.all([
      compileModule('taa', shaders.TAA_WGSL, true),
      compileModule('bloomPrefilter', shaders.BLOOM_PREFILTER_WGSL, true),
      compileModule('bloomDownsample', shaders.BLOOM_DOWNSAMPLE_WGSL, true),
      compileModule('bloomUpsample', shaders.BLOOM_UPSAMPLE_WGSL, true),
      compileModule('anamorphic', shaders.ANAMORPHIC_WGSL, true),
      compileModule('composite', shaders.COMPOSITE_WGSL, true),
    ]);

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

    const makeUbo = (label, byteLength) =>
      device.createBuffer({
        label,
        size: byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.taaUniformBuf = makeUbo('taa-ubo', 16);
    this.bloomPreUniformBuf = makeUbo('bloom-pre-ubo', 32);
    this.bloomDownUniformBufs = Array.from({ length: BLOOM_MIP_COUNT }, (_, i) =>
      makeUbo(`bloom-down-ubo-${i}`, 16)
    );
    this.bloomUpUniformBufs = Array.from({ length: BLOOM_MIP_COUNT - 1 }, (_, i) =>
      makeUbo(`bloom-up-ubo-${i}`, 16)
    );
    this.anaUniformBuf0 = makeUbo('ana-ubo-0', 64);
    this.anaUniformBuf1 = makeUbo('ana-ubo-1', 64);
    this.compUniformBuf = makeUbo('comp-ubo', 48);
  }

  createRenderTarget(label, width, height) {
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

  destroyRenderTarget(rt) {
    if (rt?.texture) {
      rt.texture.destroy();
    }
  }

  destroyTargets() {
    this.destroyRenderTarget(this.sceneRt);
    this.destroyRenderTarget(this.taaRts[0]);
    this.destroyRenderTarget(this.taaRts[1]);
    for (const rt of this.bloomDownRts) this.destroyRenderTarget(rt);
    for (const rt of this.bloomUpRts) this.destroyRenderTarget(rt);
    this.destroyRenderTarget(this.anaRtA);
    this.destroyRenderTarget(this.anaRtB);

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

  _rebuildBindGroups(width, height) {
    const device = this.device;
    if (!this.sceneRt || !this.taaBgl || !this.singleSrcPostBgl || !this.bloomUpBgl || !this.compBgl) {
      return;
    }

    // Clear taaRts, bloomUpRts[0], anaRtB once on resize so skipping optional passes stays clean black
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

    // Write resolution-dependent static post uniforms once per resize across isolated pass UBOs
    const pre = this._bloomPreF32;
    pre[0] = 1.0 / width;
    pre[1] = 1.0 / height;
    pre[2] = this.optics.prefilterThreshold;
    pre[3] = this.optics.prefilterKnee;
    pre[4] = this.optics.prefilterClampMax;
    pre[5] = 0.0;
    pre[6] = 0.0;
    pre[7] = 0.0;
    device.queue.writeBuffer(this.bloomPreUniformBuf, 0, pre);

    for (let i = 1; i < BLOOM_MIP_COUNT; i++) {
      const src = this.bloomDownRts[i - 1];
      const f = this._bloomDownF32[i];
      f[0] = 1.0 / src.width;
      f[1] = 1.0 / src.height;
      f[2] = i === 1 ? 1.0 : 0.0;
      f[3] = 0.0;
      device.queue.writeBuffer(this.bloomDownUniformBufs[i], 0, f);
    }

    for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
      const lowSrc = i === BLOOM_MIP_COUNT - 2 ? this.bloomDownRts[i + 1] : this.bloomUpRts[i + 1];
      const f = this._bloomUpF32[i];
      f[0] = 1.0 / lowSrc.width;
      f[1] = 1.0 / lowSrc.height;
      f[2] = this.optics.upsampleRadius;
      f[3] = this.optics.upsampleWeight;
      device.queue.writeBuffer(this.bloomUpUniformBufs[i], 0, f);
    }

    const src0 = this.bloomDownRts[1];
    const f0 = this._anaF32_0;
    f0[0] = 1.0 / src0.width;
    f0[1] = 1.0 / src0.height;
    f0[2] = this.optics.anaThreshold;
    f0[3] = this.optics.anaSpread0;
    f0[4] = 0.0;
    f0[5] = 0.0;
    f0[6] = 0.0;
    f0[7] = 0.0;
    f0[8] = this.optics.coreTint[0];
    f0[9] = this.optics.coreTint[1];
    f0[10] = this.optics.coreTint[2];
    f0[11] = this.optics.fringeStart;
    f0[12] = this.optics.outerTint[0];
    f0[13] = this.optics.outerTint[1];
    f0[14] = this.optics.outerTint[2];
    f0[15] = this.optics.fringeMix;
    device.queue.writeBuffer(this.anaUniformBuf0, 0, f0);

    const f1 = this._anaF32_1;
    f1[0] = 1.0 / this.anaRtA.width;
    f1[1] = 1.0 / this.anaRtA.height;
    f1[2] = 0.0;
    f1[3] = this.optics.anaSpread1;
    f1[4] = 1.0;
    f1[5] = 0.0;
    f1[6] = 0.0;
    f1[7] = 0.0;
    f1[8] = this.optics.coreTint[0];
    f1[9] = this.optics.coreTint[1];
    f1[10] = this.optics.coreTint[2];
    f1[11] = this.optics.fringeStart;
    f1[12] = this.optics.outerTint[0];
    f1[13] = this.optics.outerTint[1];
    f1[14] = this.optics.outerTint[2];
    f1[15] = this.optics.fringeMix;
    device.queue.writeBuffer(this.anaUniformBuf1, 0, f1);
  }

  resize(nextW, nextH) {
    this.destroyTargets();

    this.sceneRt = this.createRenderTarget('scene-rt', nextW, nextH);
    this.taaRts = [
      this.createRenderTarget('taa-rt-0', nextW, nextH),
      this.createRenderTarget('taa-rt-1', nextW, nextH),
    ];

    let mipW = Math.max(1, nextW >> 1);
    let mipH = Math.max(1, nextH >> 1);
    for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
      this.bloomDownRts.push(this.createRenderTarget(`bloom-down-${i}`, mipW, mipH));
      if (i < BLOOM_MIP_COUNT - 1) {
        this.bloomUpRts.push(this.createRenderTarget(`bloom-up-${i}`, mipW, mipH));
      }
      mipW = Math.max(1, mipW >> 1);
      mipH = Math.max(1, mipH >> 1);
    }

    const anaW = Math.max(1, nextW >> 2);
    const anaH = Math.max(1, nextH >> 2);
    this.anaRtA = this.createRenderTarget('ana-rt-a', anaW, anaH);
    this.anaRtB = this.createRenderTarget('ana-rt-b', anaW, anaH);

    this._rebuildBindGroups(nextW, nextH);
  }

  getSceneView() {
    return this.sceneRt?.view || null;
  }

  encodeTaa(encoder, width, height, blendFactor, isProgressive) {
    if (!this.sceneRt) return;
    this._taaF32[0] = 1.0 / width;
    this._taaF32[1] = 1.0 / height;
    this._taaF32[2] = blendFactor;
    this._taaF32[3] = isProgressive ? 1.0 : 0.0;
    this.device.queue.writeBuffer(this.taaUniformBuf, 0, this._taaF32);

    const outputRt = this.taaRts[this.taaWriteIdx];
    const taaBg = this.taaBindGroups[this.taaReadIdx];
    if (this.taaPipeline && taaBg && outputRt) {
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

  encodeBloomAndAnamorphic(encoder, state) {
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : this.optics.defaultBloomIntensity;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : this.optics.defaultAnamorphicIntensity;
    const needBloom = bloomIntensity > 0.001;
    const needAnamorphic = anamorphicIntensity > 0.001;
    if (!needBloom && !needAnamorphic) return;

    // 1. Bloom prefilter
    const preBg = this.bloomPreBindGroups[this.taaReadIdx];
    if (this.bloomPrePipeline && preBg && this.bloomDownRts[0]) {
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

    // 2. 6-Level Jimenez 13-tap Downsample Chain
    if (this.bloomDownPipeline) {
      const maxDownLevel = needBloom ? BLOOM_MIP_COUNT - 1 : 1;
      for (let i = 1; i <= maxDownLevel; i++) {
        const dst = this.bloomDownRts[i];
        const bg = this.bloomDownBindGroups[i];
        if (!bg || !dst) continue;

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

    // 3. 9-Tap Tent Filter Upsample Chain
    if (needBloom && this.bloomUpPipeline) {
      for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
        const dst = this.bloomUpRts[i];
        const bg = this.bloomUpBindGroups[i];
        if (!bg || !dst) continue;

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

    // 4. 2-Pass Separable Horizontal Anamorphic Optical Streak
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

  encodeComposite(encoder, state, width, height, simTime, frameIndex, targetView = null) {
    const compBg = this.compBindGroups[this.taaReadIdx];
    if (!this.compPipeline || !compBg) return;

    const exposure = Number.isFinite(Number(state?.exposure)) ? Number(state.exposure) : 1.05;
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : this.optics.defaultBloomIntensity;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : this.optics.defaultAnamorphicIntensity;

    const f = this._compF32;
    f[0] = width;
    f[1] = height;
    f[2] = exposure;
    f[3] = bloomIntensity;
    f[4] = anamorphicIntensity;
    f[5] = Number.isFinite(simTime) ? simTime : 0.0;
    f[6] = frameIndex & 255;
    f[7] = 0.0;
    f[8] = this.optics.bloomGain;
    f[9] = this.optics.anamorphicGain;
    f[10] = 0.0;
    f[11] = 0.0;
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

  dispose() {
    this.destroyTargets();
    this.taaUniformBuf?.destroy();
    this.bloomPreUniformBuf?.destroy();
    for (const b of this.bloomDownUniformBufs || []) b.destroy();
    for (const b of this.bloomUpUniformBufs || []) b.destroy();
    this.anaUniformBuf0?.destroy();
    this.anaUniformBuf1?.destroy();
    this.compUniformBuf?.destroy();
  }
}
