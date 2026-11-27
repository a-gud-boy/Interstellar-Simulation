/**
 * SharedWebGLPostPipeline.js — Shared WebGL2 RGBA16F HDR multi-pass post-processing pipeline:
 *  - Scene HDR target + ping-pong TAA history targets
 *  - HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Troy Sobotka AgX Filmic Tone Mapping + subtle CA, vignette, film grain & sRGB composite
 */

import { createPostShadersGLSL } from '../shaders/post.glsl.js';
import { resolvePostOpticsProfile } from '../shaders/postConfig.js';

export const BLOOM_MIP_COUNT = 6;
export const MAX_PROGRESSIVE_SAMPLES = 128;

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

export function formatShaderError(name, stage, source, infoLog) {
  const lines = source.split('\n');
  const errorLines = [];
  const lineMatchRegex = /ERROR:\s*\d+:(\d+):/g;
  const highlighted = new Set();
  let m;
  while ((m = lineMatchRegex.exec(infoLog || '')) !== null) {
    highlighted.add(parseInt(m[1], 10));
  }

  for (const ln of highlighted) {
    const start = Math.max(1, ln - 2);
    const end = Math.min(lines.length, ln + 2);
    for (let i = start; i <= end; i++) {
      const marker = i === ln ? '>>>' : '   ';
      errorLines.push(`${marker} ${String(i).padStart(4, ' ')} | ${lines[i - 1]}`);
    }
    errorLines.push('---');
  }

  return `[WebGLRenderer] ${name} (${stage}) compile failed:\n${infoLog || 'Unknown error'}\n${errorLines.join('\n')}`;
}

export class SharedWebGLPostPipeline {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   emptyVao: WebGLVertexArrayObject | null,
   *   hdrSpec: { internalFormat: number, format: number, type: number },
   *   opticsProfile?: string,
   *   compileProgram: (name: string, vertSrc: string, fragSrc: string) => any,
   *   getUniform: (progEntry: any, name: string) => WebGLUniformLocation | null,
   *   drawFullscreen: () => void,
   *   vertSrc: string,
   * }} opts
   */
  constructor(opts) {
    this.gl = opts.gl;
    this.emptyVao = opts.emptyVao;
    this.hdrSpec = opts.hdrSpec;
    this.optics = resolvePostOpticsProfile(opts.opticsProfile || 'default');
    this._getUniform = opts.getUniform;
    this._drawFullscreen = opts.drawFullscreen;

    const shaders = createPostShadersGLSL(opts.opticsProfile || 'default');
    const vs = opts.vertSrc;

    this.programs = {
      taa: opts.compileProgram('taa', vs, shaders.TAA_FRAG),
      bloomPrefilter: opts.compileProgram('bloomPrefilter', vs, shaders.BLOOM_PREFILTER_FRAG),
      bloomDownsample: opts.compileProgram('bloomDownsample', vs, shaders.BLOOM_DOWNSAMPLE_FRAG),
      bloomUpsample: opts.compileProgram('bloomUpsample', vs, shaders.BLOOM_UPSAMPLE_FRAG),
      anamorphic: opts.compileProgram('anamorphic', vs, shaders.ANAMORPHIC_FRAG),
      composite: opts.compileProgram('composite', vs, shaders.COMPOSITE_FRAG),
    };

    this.sceneFbo = null;
    this.taaFbos = [null, null];
    this.bloomDownFbos = [];
    this.bloomUpFbos = [];
    this.anamorphicFboA = null;
    this.anamorphicFboB = null;
    this.taaReadIdx = 0;
    this.taaWriteIdx = 1;
  }

  createRenderTarget(width, height) {
    const gl = this.gl;
    const spec = this.hdrSpec;
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, spec.internalFormat, w, h, 0, spec.format, spec.type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    return { fbo, texture, width: w, height: h };
  }

  destroyRenderTarget(rt) {
    if (!rt) return;
    const gl = this.gl;
    if (rt.texture) gl.deleteTexture(rt.texture);
    if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
  }

  destroyTargets() {
    this.destroyRenderTarget(this.sceneFbo);
    this.destroyRenderTarget(this.taaFbos[0]);
    this.destroyRenderTarget(this.taaFbos[1]);
    for (const rt of this.bloomDownFbos) this.destroyRenderTarget(rt);
    for (const rt of this.bloomUpFbos) this.destroyRenderTarget(rt);
    this.destroyRenderTarget(this.anamorphicFboA);
    this.destroyRenderTarget(this.anamorphicFboB);

    this.sceneFbo = null;
    this.taaFbos = [null, null];
    this.bloomDownFbos = [];
    this.bloomUpFbos = [];
    this.anamorphicFboA = null;
    this.anamorphicFboB = null;
  }

  resize(nextW, nextH) {
    this.destroyTargets();

    this.sceneFbo = this.createRenderTarget(nextW, nextH);
    this.taaFbos = [
      this.createRenderTarget(nextW, nextH),
      this.createRenderTarget(nextW, nextH),
    ];

    let mipW = Math.max(1, nextW >> 1);
    let mipH = Math.max(1, nextH >> 1);
    for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
      this.bloomDownFbos.push(this.createRenderTarget(mipW, mipH));
      if (i < BLOOM_MIP_COUNT - 1) {
        this.bloomUpFbos.push(this.createRenderTarget(mipW, mipH));
      }
      mipW = Math.max(1, mipW >> 1);
      mipH = Math.max(1, mipH >> 1);
    }

    const anaW = Math.max(1, nextW >> 2);
    const anaH = Math.max(1, nextH >> 2);
    this.anamorphicFboA = this.createRenderTarget(anaW, anaH);
    this.anamorphicFboB = this.createRenderTarget(anaW, anaH);
  }

  getSceneFbo() {
    return this.sceneFbo;
  }

  runTaa(width, height, blendFactor, isProgressive) {
    const gl = this.gl;
    const prog = this.programs.taa;
    if (!prog || !this.sceneFbo) return;

    const historyRt = this.taaFbos[this.taaReadIdx];
    const outputRt = this.taaFbos[this.taaWriteIdx];

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputRt.fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(prog.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.texture);
    const uCurrentTex = this._getUniform(prog, 'uCurrentTex');
    if (uCurrentTex) gl.uniform1i(uCurrentTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, historyRt.texture);
    const uHistoryTex = this._getUniform(prog, 'uHistoryTex');
    if (uHistoryTex) gl.uniform1i(uHistoryTex, 1);

    const uTexelSize = this._getUniform(prog, 'uTexelSize');
    if (uTexelSize) gl.uniform2f(uTexelSize, 1.0 / width, 1.0 / height);

    const uBlendFactor = this._getUniform(prog, 'uBlendFactor');
    if (uBlendFactor) gl.uniform1f(uBlendFactor, blendFactor);

    const uProgressive = this._getUniform(prog, 'uProgressive');
    if (uProgressive) gl.uniform1i(uProgressive, isProgressive ? 1 : 0);

    this._drawFullscreen();

    const tmp = this.taaReadIdx;
    this.taaReadIdx = this.taaWriteIdx;
    this.taaWriteIdx = tmp;
  }

  runBloomAndAnamorphic(state, width, height) {
    const gl = this.gl;
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : this.optics.defaultBloomIntensity;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : this.optics.defaultAnamorphicIntensity;
    const needBloom = bloomIntensity > 0.001;
    const needAnamorphic = anamorphicIntensity > 0.001;
    if (!needBloom && !needAnamorphic) return;

    const hdrTex = this.taaFbos[this.taaReadIdx]?.texture;
    if (!hdrTex) return;

    // 1. Bloom Prefilter (full-res HDR -> mip 0 half-res)
    const preProg = this.programs.bloomPrefilter;
    if (preProg) {
      const dst = this.bloomDownFbos[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.width, dst.height);
      gl.useProgram(preProg.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrTex);
      gl.uniform1i(this._getUniform(preProg, 'uSrcTex'), 0);
      gl.uniform2f(this._getUniform(preProg, 'uTexelSize'), 1.0 / width, 1.0 / height);
      gl.uniform1f(this._getUniform(preProg, 'uThreshold'), this.optics.prefilterThreshold);
      gl.uniform1f(this._getUniform(preProg, 'uKnee'), this.optics.prefilterKnee);
      gl.uniform1f(this._getUniform(preProg, 'uClampMax'), this.optics.prefilterClampMax);
      this._drawFullscreen();
    }

    // 2. 6-Level Jimenez 13-tap Downsample Chain
    const downProg = this.programs.bloomDownsample;
    if (downProg) {
      gl.useProgram(downProg.program);
      const uSrc = this._getUniform(downProg, 'uSrcTex');
      const uTexel = this._getUniform(downProg, 'uTexelSize');
      const uKaris = this._getUniform(downProg, 'uUseKaris');

      const maxDownLevel = needBloom ? BLOOM_MIP_COUNT - 1 : 1;
      for (let i = 1; i <= maxDownLevel; i++) {
        const src = this.bloomDownFbos[i - 1];
        const dst = this.bloomDownFbos[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.width, dst.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(uSrc, 0);
        gl.uniform2f(uTexel, 1.0 / src.width, 1.0 / src.height);
        gl.uniform1i(uKaris, i === 1 ? 1 : 0);
        this._drawFullscreen();
      }
    }

    // 3. 9-Tap Tent Filter Upsample Chain
    const upProg = this.programs.bloomUpsample;
    if (needBloom && upProg) {
      gl.useProgram(upProg.program);
      const uLow = this._getUniform(upProg, 'uLowTex');
      const uHigh = this._getUniform(upProg, 'uHighTex');
      const uTexel = this._getUniform(upProg, 'uTexelSize');
      const uRadius = this._getUniform(upProg, 'uFilterRadius');
      const uWeight = this._getUniform(upProg, 'uMipWeight');

      for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
        const lowSrc = i === BLOOM_MIP_COUNT - 2 ? this.bloomDownFbos[i + 1] : this.bloomUpFbos[i + 1];
        const highSrc = this.bloomDownFbos[i];
        const dst = this.bloomUpFbos[i];

        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.width, dst.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, lowSrc.texture);
        gl.uniform1i(uLow, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, highSrc.texture);
        gl.uniform1i(uHigh, 1);

        gl.uniform2f(uTexel, 1.0 / lowSrc.width, 1.0 / lowSrc.height);
        gl.uniform1f(uRadius, this.optics.upsampleRadius);
        gl.uniform1f(uWeight, this.optics.upsampleWeight);
        this._drawFullscreen();
      }
    }

    // 4. 2-Pass Separable Horizontal Anamorphic Optical Streak (quarter-res)
    const anaProg = this.programs.anamorphic;
    if (needAnamorphic && anaProg) {
      gl.useProgram(anaProg.program);
      const uSrc = this._getUniform(anaProg, 'uSrcTex');
      const uTexel = this._getUniform(anaProg, 'uTexelSize');
      const uThresh = this._getUniform(anaProg, 'uThreshold');
      const uSpread = this._getUniform(anaProg, 'uSpread');
      const uPass = this._getUniform(anaProg, 'uPass');
      gl.uniform4f(
        this._getUniform(anaProg, 'uTintInnerEdge'),
        this.optics.coreTint[0],
        this.optics.coreTint[1],
        this.optics.coreTint[2],
        this.optics.fringeStart
      );
      gl.uniform4f(
        this._getUniform(anaProg, 'uTintOuterMix'),
        this.optics.outerTint[0],
        this.optics.outerTint[1],
        this.optics.outerTint[2],
        this.optics.fringeMix
      );

      const src0 = this.bloomDownFbos[1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.anamorphicFboA.fbo);
      gl.viewport(0, 0, this.anamorphicFboA.width, this.anamorphicFboA.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src0.texture);
      gl.uniform1i(uSrc, 0);
      gl.uniform2f(uTexel, 1.0 / src0.width, 1.0 / src0.height);
      gl.uniform1f(uThresh, this.optics.anaThreshold);
      gl.uniform1f(uSpread, this.optics.anaSpread0);
      gl.uniform1i(uPass, 0);
      this._drawFullscreen();

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.anamorphicFboB.fbo);
      gl.viewport(0, 0, this.anamorphicFboB.width, this.anamorphicFboB.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.anamorphicFboA.texture);
      gl.uniform1i(uSrc, 0);
      gl.uniform2f(uTexel, 1.0 / this.anamorphicFboA.width, 1.0 / this.anamorphicFboA.height);
      gl.uniform1f(uThresh, 0.0);
      gl.uniform1f(uSpread, this.optics.anaSpread1);
      gl.uniform1i(uPass, 1);
      this._drawFullscreen();
    }
  }

  runComposite(state, width, height, simTime, frameIndex) {
    const gl = this.gl;
    const prog = this.programs.composite;
    if (!prog || !this.taaFbos[this.taaReadIdx]) return;

    const exposure = Number.isFinite(Number(state?.exposure)) ? Number(state.exposure) : 1.05;
    const bloomIntensity = Number.isFinite(Number(state?.bloomIntensity))
      ? Number(state.bloomIntensity)
      : this.optics.defaultBloomIntensity;
    const anamorphicIntensity = Number.isFinite(Number(state?.anamorphicIntensity))
      ? Number(state.anamorphicIntensity)
      : this.optics.defaultAnamorphicIntensity;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(prog.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.taaFbos[this.taaReadIdx].texture);
    gl.uniform1i(this._getUniform(prog, 'uSceneTex'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomUpFbos[0].texture);
    gl.uniform1i(this._getUniform(prog, 'uBloomTex'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.anamorphicFboB.texture);
    gl.uniform1i(this._getUniform(prog, 'uAnamorphicTex'), 2);

    gl.uniform2f(this._getUniform(prog, 'uResolution'), width, height);
    gl.uniform1f(this._getUniform(prog, 'uExposure'), exposure);
    gl.uniform1f(this._getUniform(prog, 'uBloomIntensity'), bloomIntensity);
    gl.uniform1f(this._getUniform(prog, 'uAnamorphicIntensity'), anamorphicIntensity);
    gl.uniform1f(this._getUniform(prog, 'uBloomGain'), this.optics.bloomGain);
    gl.uniform1f(this._getUniform(prog, 'uAnamorphicGain'), this.optics.anamorphicGain);
    gl.uniform1f(this._getUniform(prog, 'uTime'), Number.isFinite(simTime) ? simTime : 0.0);
    gl.uniform1i(this._getUniform(prog, 'uFrameIndex'), frameIndex);

    this._drawFullscreen();
  }

  dispose() {
    this.destroyTargets();
    const gl = this.gl;
    for (const entry of Object.values(this.programs)) {
      if (entry?.program) gl.deleteProgram(entry.program);
    }
    this.programs = {};
  }
}
