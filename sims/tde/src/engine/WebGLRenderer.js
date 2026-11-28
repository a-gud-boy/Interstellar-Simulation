/**
 * WebGLRenderer.js — WebGL2 RGBA16F multi-pass HDR rendering pipeline for the
 * Relativistic Tidal Disruption Event (TDE) Observatory:
 *  - Startup GPU 128^3 3D volumetric plasma/dust noise baker (NOISE_BAKE_FRAG)
 *  - Pass 1: Outgoing Kerr-Schild geodesic ray-tracer + volumetric precessing stream,
 *            nozzle shock, stellar core, circularization disk & BZ polar jet (TDE_FRAG)
 *  - Pass 2..5: Shared HDR TAA/128-sample accumulation, 6-level bloom, anamorphic flare & AgX
 */

import { FULLSCREEN_VERT, NOISE_BAKE_FRAG } from '../../../../shared/shaders/common.glsl.js';
import { TDE_FRAG } from '../shaders/tde.frag.js';
import { computeTdeTelemetry, writeTdeFrameConstants } from './Physics.js';
import { createWebGLPassProfiler } from '../../../../shared/engine/gpuProfiler.js';
import {
  SharedWebGLPostPipeline,
  detectWebGLHdrFormats,
  MAX_PROGRESSIVE_SAMPLES,
  halton,
  formatShaderError,
} from '../../../../shared/engine/SharedWebGLPostPipeline.js';
import {
  createProceduralSkyTextureWebGL,
  createPlaceholderSkyTextureWebGL,
} from '../../../../shared/assets/skyLoader.js';
import {
  createBlackbodyLUTWebGL,
  createBlueNoiseLUTWebGL,
} from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.errors = [];
    this.shaderStatus = {};
    this.volumeBaked = false;
    this.skyMapLoaded = false;
    this.skyDimensions = [2048, 1024];
    this.hdrFormat = 'RGBA8';
    this.rendererName = 'WebGL2';

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

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!gl || gl.isContextLost()) {
      const msg = gl
        ? 'WebGL2 GPU context was lost during initialization. On Linux Wayland + NVIDIA PRIME laptops, run ./launch.sh (--ozone-platform=x11).'
        : 'WebGL2 context could not be initialized on this browser/GPU.';
      this.errors.push(msg);
      throw new Error(msg);
    }

    this.gl = gl;

    this.extColorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    this.extColorBufferHalfFloat = gl.getExtension('EXT_color_buffer_half_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.extAnisotropic =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_texture_filter_anisotropic');

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      this.rendererName =
        gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ||
        gl.getParameter(gl.RENDERER) ||
        'WebGL2';
    } else {
      this.rendererName = gl.getParameter(gl.RENDERER) || 'WebGL2';
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);

    this.emptyVao = gl.createVertexArray();
    this._hdrSpec = this._detectHdrFboFormat();

    this.programs = {
      noiseBake: this._createProgram('noiseBake', FULLSCREEN_VERT, NOISE_BAKE_FRAG),
      tde: this._createProgram('tde', FULLSCREEN_VERT, TDE_FRAG),
    };

    if (this.programs.tde) {
      const blockIdx = gl.getUniformBlockIndex(this.programs.tde.program, 'TdeUniforms');
      if (blockIdx !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(this.programs.tde.program, blockIdx, 0);
      }
    }

    this._tdeBufData = new ArrayBuffer(320);
    this._tdeF32 = new Float32Array(this._tdeBufData);
    this._tdeI32 = new Int32Array(this._tdeBufData);
    this.tdeUniformBuf = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.tdeUniformBuf);
    gl.bufferData(gl.UNIFORM_BUFFER, 320, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    const blackbodyRes = createBlackbodyLUTWebGL(gl);
    this.blackbodyTex = blackbodyRes?.texture || blackbodyRes;
    this.blueNoiseTex = createBlueNoiseLUTWebGL(gl);
    this.procSkyTex = createPlaceholderSkyTextureWebGL(gl);
    this._procSkyBaked = false;
    this.skyTex = this.procSkyTex;

    this.volumeNoiseTex = this._bakeVolumeNoise();

    this.profiler = createWebGLPassProfiler(gl);
    this.post = new SharedWebGLPostPipeline({
      profiler: this.profiler,
      gl,
      emptyVao: this.emptyVao,
      hdrSpec: this._hdrSpec,
      taaSpec: this._taaSpec,
      opticsProfile: 'tde',
      vertSrc: FULLSCREEN_VERT,
      compileProgram: (name, vs, fs) => this._createProgram(name, vs, fs),
      getUniform: (entry, name) => this._getUniform(entry, name),
      drawFullscreen: () => this._drawFullscreen(),
    });

    this.resize(1.0);
  }

  _detectHdrFboFormat() {
    const { hdrSpec, taaSpec } = detectWebGLHdrFormats(
      this.gl,
      this.extColorBufferFloat,
      this.extColorBufferHalfFloat
    );
    this._taaSpec = taaSpec;
    this.hdrFormat = hdrSpec.name;
    return hdrSpec;
  }

  _compileShader(name, type, source) {
    const gl = this.gl;
    if (gl.isContextLost()) {
      const msg = 'WebGL2 GPU context was lost while compiling shaders.';
      if (!this.errors.includes(msg)) this.errors.push(msg);
      return { shader: null, error: msg };
    }
    const shader = gl.createShader(type);
    if (!shader) {
      const msg = `[WebGLRenderer] Failed to allocate ${name} shader.`;
      if (!this.errors.includes(msg)) this.errors.push(msg);
      return { shader: null, error: msg };
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const stage = type === gl.VERTEX_SHADER ? 'VERT' : 'FRAG';
      const infoLog = gl.getShaderInfoLog(shader);
      const formatted = formatShaderError(name, stage, source, infoLog);
      console.error(formatted);
      this.errors.push(formatted);
      gl.deleteShader(shader);
      return { shader: null, error: formatted };
    }
    return { shader, error: null };
  }

  _createProgram(name, vertSrc, fragSrc) {
    const gl = this.gl;
    const vs = this._compileShader(name, gl.VERTEX_SHADER, vertSrc);
    const fs = this._compileShader(name, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs.shader || !fs.shader) {
      if (vs.shader) gl.deleteShader(vs.shader);
      if (fs.shader) gl.deleteShader(fs.shader);
      this.shaderStatus[name] = { ok: false, error: vs.error || fs.error };
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs.shader);
    gl.attachShader(program, fs.shader);
    gl.linkProgram(program);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const infoLog = gl.getProgramInfoLog(program);
      const err = `[WebGLRenderer] Program '${name}' link failed: ${infoLog}`;
      console.error(err);
      this.errors.push(err);
      this.shaderStatus[name] = { ok: false, error: err };
      gl.deleteProgram(program);
      return null;
    }

    this.shaderStatus[name] = { ok: true, error: null };
    return { program, uniforms: new Map() };
  }

  _getUniform(progEntry, name) {
    if (!progEntry) return null;
    let loc = progEntry.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(progEntry.program, name);
      progEntry.uniforms.set(name, loc);
    }
    return loc;
  }

  _drawFullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _bakeVolumeNoise() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);

    const prog = this.programs.noiseBake;
    if (!prog) return tex;

    const bakeFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
    gl.viewport(0, 0, VOLUME_SIZE, VOLUME_SIZE);
    gl.useProgram(prog.program);

    const uSliceZ = this._getUniform(prog, 'uSliceZ');
    const uSize = this._getUniform(prog, 'uSize');
    if (uSize) gl.uniform1f(uSize, VOLUME_SIZE);

    gl.bindVertexArray(this.emptyVao);
    for (let z = 0; z < VOLUME_SIZE; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      if (z === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        break;
      }
      if (uSliceZ) gl.uniform1f(uSliceZ, (z + 0.5) / VOLUME_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(bakeFbo);
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.volumeBaked = true;
    return tex;
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
      this.post?.getSceneFbo()
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
    if (!skyResult) return;
    const gl = this.gl;

    if (skyResult instanceof WebGLTexture) {
      if (this.skyTex && this.skyTex !== this.procSkyTex && this.skyTex !== skyResult) {
        gl.deleteTexture(this.skyTex);
      }
      this.skyTex = skyResult;
      this.skyMapLoaded = true;
      this.resetAccumulation(true);
      return;
    }

    const { texture, width, height, isRealMap } = skyResult;
    if (isRealMap && texture) {
      if (this.skyTex && this.skyTex !== this.procSkyTex && this.skyTex !== texture) {
        gl.deleteTexture(this.skyTex);
      }
      this.skyTex = texture;
      this.skyMapLoaded = true;
      this.skyDimensions = [width || 4096, height || 2048];
      this.resetAccumulation(true);
    } else {
      if (texture && !this._procSkyBaked) {
        const oldPlaceholder = this.procSkyTex;
        this.procSkyTex = texture;
        if (!this.skyMapLoaded) {
          this.skyTex = texture;
        }
        if (oldPlaceholder && oldPlaceholder !== texture) {
          gl.deleteTexture(oldPlaceholder);
        }
        this._procSkyBaked = true;
        this.resetAccumulation(true);
      } else if (texture && texture !== this.procSkyTex && texture !== this.skyTex) {
        gl.deleteTexture(texture);
      }
      this.skyMapLoaded = false;
    }
  }

  _ensureProceduralSky() {
    if (this._procSkyBaked || this._disposed || this.gl.isContextLost()) return;
    const oldPlaceholder = this.procSkyTex;
    const baked = createProceduralSkyTextureWebGL(this.gl, 2048, 1024);
    this.procSkyTex = baked;
    if (!this.skyMapLoaded && (!this.skyTex || this.skyTex === oldPlaceholder)) {
      this.skyTex = baked;
    }
    if (oldPlaceholder && oldPlaceholder !== baked && oldPlaceholder !== this.skyTex) {
      this.gl.deleteTexture(oldPlaceholder);
    }
    this._procSkyBaked = true;
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
  }

  _runTdePass(state, camData, simTime, jitterX, jitterY) {
    if ((state?.skyMode | 0) === 2 && !this._procSkyBaked) {
      this._ensureProceduralSky();
    }
    const gl = this.gl;
    const prog = this.programs.tde;
    if (!prog) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.getSceneFbo().fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(prog.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeNoiseTex);
    const uVolumeNoise = this._getUniform(prog, 'uVolumeNoise');
    if (uVolumeNoise) gl.uniform1i(uVolumeNoise, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    const uSkyMap = this._getUniform(prog, 'uSkyMap');
    if (uSkyMap) gl.uniform1i(uSkyMap, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.procSkyTex);
    const uProcSkyMap = this._getUniform(prog, 'uProcSkyMap');
    if (uProcSkyMap) gl.uniform1i(uProcSkyMap, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.blackbodyTex);
    const uBlackbodyLut = this._getUniform(prog, 'uBlackbodyLut');
    if (uBlackbodyLut) gl.uniform1i(uBlackbodyLut, 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.blueNoiseTex);
    const uBlueNoise = this._getUniform(prog, 'uBlueNoise');
    if (uBlueNoise) gl.uniform1i(uBlueNoise, 4);

    this._writeTdeUniforms(state, camData, simTime, jitterX, jitterY);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.tdeUniformBuf);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this._tdeBufData);

    this.profiler?.beginPass('raymarch');
    this._drawFullscreen();
    this.profiler?.endPass();
  }

  render(state, camData, simTime, options = {}) {
    if (this._disposed || this.gl.isContextLost() || !this.getAllShadersCompiled()) return false;

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

        this.profiler?.beginFrame();
        this._runTdePass(state, camData, simTime, jitterX, jitterY);
        this.post.runTaa(this.width, this.height, blendFactor, true);
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame();
        this._postDirty = false;
        return true;
      } else if (this._postDirty || options.forceComposite) {
        this.profiler?.beginFrame();
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame();
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
    this._runTdePass(state, camData, simTime, jitterX, jitterY);
    this.post.runTaa(this.width, this.height, blendFactor, false);
    this.post.runBloomAndAnamorphic(state, this.width, this.height);
    this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
    this.profiler?.endFrame();
    this._postDirty = false;
    return true;
  }

  capturePNG(state, camData, simTime) {
    this.render(state, camData, simTime, { forceComposite: true });
    this.gl.flush();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode canvas frame to PNG.'));
      }, 'image/png');
    });
  }

  dispose() {
    this._disposed = true;
    const gl = this.gl;
    try {
      this.profiler?.dispose();
      this.post?.dispose();
      if (this.tdeUniformBuf) gl.deleteBuffer(this.tdeUniformBuf);
      if (this.volumeNoiseTex) gl.deleteTexture(this.volumeNoiseTex);
      if (this.blackbodyTex) gl.deleteTexture(this.blackbodyTex);
      if (this.blueNoiseTex) gl.deleteTexture(this.blueNoiseTex);
      if (this.skyTex && this.skyTex !== this.procSkyTex) gl.deleteTexture(this.skyTex);
      if (this.procSkyTex) gl.deleteTexture(this.procSkyTex);
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      for (const entry of Object.values(this.programs)) {
        if (entry?.program) gl.deleteProgram(entry.program);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Best-effort cleanup
    }
  }
}
