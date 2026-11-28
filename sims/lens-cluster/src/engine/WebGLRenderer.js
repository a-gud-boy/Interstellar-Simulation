/**
 * WebGLRenderer.js — WebGL2 RGBA16F multi-pass HDR rendering pipeline for
 * Gravitational Lensing Observatory (sims/lens-cluster/).
 *  - Startup GPU 128x128x128 3D volume noise baker (NOISE_BAKE_FRAG)
 *  - Pass 1: Analytical gravitational lensing + 3D cluster galaxies + ICM (LENS_CLUSTER_FRAG)
 *  - Pass 2..5: SharedWebGLPostPipeline (TAA 128x, Bloom, Anamorphic, AgX)
 */

import { FULLSCREEN_VERT, NOISE_BAKE_FRAG } from '../../../../shared/shaders/common.glsl.js';
import { LENS_CLUSTER_FRAG } from '../shaders/lens-cluster.frag.js';
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
import { createBlackbodyLUTWebGL, createBlueNoiseLUTWebGL } from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;
const DEG2RAD = Math.PI / 180;
const STATE_SIG_LEN = 18;

function extractCamVectors(camMatrices) {
  const pos = camMatrices?.pos || [0, 0, 16.5];
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
  const fovY = Number.isFinite(camMatrices?.fovY) ? camMatrices.fovY : (42 * Math.PI) / 180;
  return { pos, right, up, forward, fovY };
}

function fillPhysicsStateSignature(state, out) {
  const skyRot = Array.isArray(state?.skyRotation) ? state.skyRotation : null;
  out[0] = Number.isFinite(Number(state?.lensModel)) ? (Number(state.lensModel) | 0) : 2;
  out[1] = Number.isFinite(Number(state?.einsteinRadius)) ? Number(state.einsteinRadius) : 2.85;
  out[2] = Number.isFinite(Number(state?.ellipticity)) ? Number(state.ellipticity) : 0.28;
  out[3] = Number.isFinite(Number(state?.extShear)) ? Number(state.extShear) : 0.06;
  out[4] = Number.isFinite(Number(state?.lensAngleDeg)) ? Number(state.lensAngleDeg) : -22.0;
  out[5] = Number.isFinite(Number(state?.shearAngleDeg)) ? Number(state.shearAngleDeg) : 34.0;
  out[6] = Number.isFinite(Number(state?.subhaloStrength)) ? Number(state.subhaloStrength) : 1.15;
  out[7] = Number.isFinite(Number(state?.sourceScale)) ? Number(state.sourceScale) : 0.68;
  out[8] = Number.isFinite(Number(state?.quasarCore)) ? Number(state.quasarCore) : 0.48;
  out[9] = Number(state?.showCaustics) ? 1 : 0;
  out[10] = Number(state?.showFermat) ? 1 : 0;
  out[11] = Number.isFinite(Number(state?.extraFieldGalaxies)) ? Number(state.extraFieldGalaxies) : 1.0;
  out[12] = Number.isFinite(Number(state?.clusterLight)) ? Number(state.clusterLight) : 1.25;
  out[13] = Number.isFinite(Number(state?.icmGlow)) ? Number(state.icmGlow) : 1.10;
  out[14] = Number.isFinite(Number(state?.skyIntensity)) ? Number(state.skyIntensity) : 0.72;
  out[15] = Number.isFinite(Number(state?.skyMode)) ? (Number(state.skyMode) | 0) : 0;
  out[16] = skyRot && Number.isFinite(Number(skyRot[0])) ? Number(skyRot[0]) : 0.48;
  out[17] = Number.isFinite(Number(state?.quality)) ? (Number(state.quality) | 0) : 1;
}

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.errors = [];
    this.shaderStatus = {};
    this.volumeBaked = false;
    this.skyMapLoaded = false;
    this.skyDimensions = [2048, 1024];
    this.adapterInfo = null;
    this.canvasFormat = 'rgba8';
    this.hdrFormat = 'RGBA8';
    this.rendererName = 'WebGL2';

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
    this._prevCamSig = null;
    this._prevStateSig = null;
    this._prevSourceX = null;
    this._prevSourceY = null;

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
        ? 'WebGL2 GPU context was lost during initialization.'
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
      lensCluster: this._createProgram('lensCluster', FULLSCREEN_VERT, LENS_CLUSTER_FRAG),
    };

    // Locked 176-byte std140 UBO matching LensClusterUniforms (11 x vec4<f32>)
    this._lensF32 = new Float32Array(44);
    this.lensUniformBuf = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lensUniformBuf);
    gl.bufferData(gl.UNIFORM_BUFFER, 176, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    if (this.programs.lensCluster) {
      const blockIdx = gl.getUniformBlockIndex(this.programs.lensCluster.program, 'LensClusterUniforms');
      if (blockIdx !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(this.programs.lensCluster.program, blockIdx, 0);
      }
    }

    const blackbodyRes = createBlackbodyLUTWebGL(gl);
    this.blackbodyTex = blackbodyRes?.texture || blackbodyRes;
    this.blueNoiseTex = createBlueNoiseLUTWebGL(gl);
    this.procSkyTex = createPlaceholderSkyTextureWebGL(gl);
    this._procSkyBaked = false;
    this.skyTex = this.procSkyTex;

    this.volumeNoiseTex = this._bakeVolumeNoise();

    this.post = new SharedWebGLPostPipeline({
      gl,
      emptyVao: this.emptyVao,
      hdrSpec: this._hdrSpec,
      taaSpec: this._taaSpec,
      opticsProfile: 'lensCluster',
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
      if (z === 0) {
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          const err = `[WebGLRenderer] 3D volume bake FBO incomplete (status 0x${status.toString(16)})`;
          console.error(err);
          this.errors.push(err);
          break;
        }
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

  resize(resolutionScale = this.resolutionScale) {
    if (this._disposed || this.gl.isContextLost()) return false;

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
      this.post?.getSceneFbo()
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

    this.post.resize(nextW, nextH);
    this.resetAccumulation(true);
    return true;
  }

  setSkyTexture(skyResult) {
    if (!skyResult || this._disposed || this.gl.isContextLost()) return;
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
        if (oldPlaceholder && oldPlaceholder !== texture && oldPlaceholder !== this.skyTex) {
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
    let prev = this._prevCamSig;
    let sigChanged = false;
    if (!prev) {
      prev = new Float64Array(13);
      this._prevCamSig = prev;
      sigChanged = true;
    } else if (
      Math.abs(cam.pos[0] - prev[0]) > 1e-6 ||
      Math.abs(cam.pos[1] - prev[1]) > 1e-6 ||
      Math.abs(cam.pos[2] - prev[2]) > 1e-6 ||
      Math.abs(cam.right[0] - prev[3]) > 1e-6 ||
      Math.abs(cam.right[1] - prev[4]) > 1e-6 ||
      Math.abs(cam.right[2] - prev[5]) > 1e-6 ||
      Math.abs(cam.up[0] - prev[6]) > 1e-6 ||
      Math.abs(cam.up[1] - prev[7]) > 1e-6 ||
      Math.abs(cam.up[2] - prev[8]) > 1e-6 ||
      Math.abs(cam.forward[0] - prev[9]) > 1e-6 ||
      Math.abs(cam.forward[1] - prev[10]) > 1e-6 ||
      Math.abs(cam.forward[2] - prev[11]) > 1e-6 ||
      Math.abs(cam.fovY - prev[12]) > 1e-6
    ) {
      sigChanged = true;
    }
    if (sigChanged) {
      prev[0] = cam.pos[0]; prev[1] = cam.pos[1]; prev[2] = cam.pos[2];
      prev[3] = cam.right[0]; prev[4] = cam.right[1]; prev[5] = cam.right[2];
      prev[6] = cam.up[0]; prev[7] = cam.up[1]; prev[8] = cam.up[2];
      prev[9] = cam.forward[0]; prev[10] = cam.forward[1]; prev[11] = cam.forward[2];
      prev[12] = cam.fovY;
    }
    return typeof camMatrices?.moved === 'boolean' ? (camMatrices.moved || sigChanged) : sigChanged;
  }

  _syncStateChangeTracking(state, opts) {
    let scratch = this._stateSigScratch;
    if (!scratch) {
      scratch = new Float64Array(STATE_SIG_LEN);
      this._stateSigScratch = scratch;
    }
    fillPhysicsStateSignature(state, scratch);
    let prev = this._prevStateSig;
    let paramsChanged = false;
    if (!prev) {
      prev = new Float64Array(STATE_SIG_LEN);
      prev.set(scratch);
      this._prevStateSig = prev;
    } else {
      for (let i = 0; i < STATE_SIG_LEN; i++) {
        const a = scratch[i];
        const b = prev[i];
        const tol = 1e-6 * Math.max(1.0, Math.abs(a), Math.abs(b));
        if (!Number.isFinite(a) || Math.abs(a - b) > tol) {
          paramsChanged = true;
          break;
        }
      }
      if (paramsChanged) {
        prev.set(scratch);
      }
    }

    const sx = Number.isFinite(Number(state?.sourceX)) ? Number(state.sourceX) : 0.46;
    const sy = Number.isFinite(Number(state?.sourceY)) ? Number(state.sourceY) : -0.30;
    let sourceChanged = false;
    let sourceJump = false;
    if (this._prevSourceX === null || this._prevSourceY === null) {
      this._prevSourceX = sx;
      this._prevSourceY = sy;
    } else {
      const dist = Math.hypot(sx - this._prevSourceX, sy - this._prevSourceY);
      if (dist > 1e-6) {
        sourceChanged = true;
        if (dist > 0.08) {
          sourceJump = true;
        }
        this._prevSourceX = sx;
        this._prevSourceY = sy;
      }
    }

    const paused = Boolean(state?.paused);
    if (paramsChanged || (sourceChanged && (paused || (sourceJump && !opts?.isMotion)))) {
      this.resetAccumulation(true);
    }

    return { paramsChanged, sourceChanged };
  }

  _writeLensUniforms(state, cam, simTime, jitterX, jitterY, isProgressive) {
    const f = this._lensF32;
    const skyRot = Array.isArray(state?.skyRotation) ? state.skyRotation : [0.48, 0.22];

    f[0] = this.width;
    f[1] = this.height;
    f[2] = Number.isFinite(simTime) ? simTime : 0.0;
    f[3] = this.frameIndex;

    f[4] = jitterX;
    f[5] = jitterY;
    f[6] = cam.fovY;
    f[7] = isProgressive ? 1.0 : 0.0;

    f[8] = cam.pos[0];
    f[9] = cam.pos[1];
    f[10] = cam.pos[2];
    f[11] = 0.0;

    f[12] = cam.right[0];
    f[13] = cam.right[1];
    f[14] = cam.right[2];
    f[15] = Number.isFinite(Number(state?.lensModel)) ? (Number(state.lensModel) | 0) : 2;

    f[16] = cam.up[0];
    f[17] = cam.up[1];
    f[18] = cam.up[2];
    f[19] = Number.isFinite(Number(state?.einsteinRadius)) ? Number(state.einsteinRadius) : 2.85;

    f[20] = cam.forward[0];
    f[21] = cam.forward[1];
    f[22] = cam.forward[2];
    f[23] = Number.isFinite(Number(state?.ellipticity)) ? Number(state.ellipticity) : 0.28;

    f[24] = Number.isFinite(Number(state?.extShear)) ? Number(state.extShear) : 0.06;
    f[25] = (Number.isFinite(Number(state?.lensAngleDeg)) ? Number(state.lensAngleDeg) : -22.0) * DEG2RAD;
    f[26] = (Number.isFinite(Number(state?.shearAngleDeg)) ? Number(state.shearAngleDeg) : 34.0) * DEG2RAD;
    f[27] = Number.isFinite(Number(state?.subhaloStrength)) ? Number(state.subhaloStrength) : 1.15;

    f[28] = Number.isFinite(Number(state?.sourceX)) ? Number(state.sourceX) : 0.46;
    f[29] = Number.isFinite(Number(state?.sourceY)) ? Number(state.sourceY) : -0.30;
    f[30] = Number.isFinite(Number(state?.sourceScale)) ? Number(state.sourceScale) : 0.68;
    f[31] = Number.isFinite(Number(state?.quasarCore)) ? Number(state.quasarCore) : 0.48;

    f[32] = Number(state?.showCaustics) ? 1.0 : 0.0;
    f[33] = Number(state?.showFermat) ? 1.0 : 0.0;
    f[34] = Number(state?.dragMode) ? 1.0 : 0.0;
    f[35] = Number.isFinite(Number(state?.extraFieldGalaxies)) ? Number(state.extraFieldGalaxies) : 1.0;

    f[36] = Number.isFinite(Number(state?.clusterLight)) ? Number(state.clusterLight) : 1.25;
    f[37] = Number.isFinite(Number(state?.icmGlow)) ? Number(state.icmGlow) : 1.10;
    f[38] = Number.isFinite(Number(state?.skyIntensity)) ? Number(state.skyIntensity) : 0.72;
    f[39] = Number.isFinite(Number(state?.skyMode)) ? (Number(state.skyMode) | 0) : 0;

    f[40] = Number.isFinite(Number(skyRot[0])) ? Number(skyRot[0]) : 0.48;
    f[41] = Number.isFinite(Number(skyRot[1])) ? Number(skyRot[1]) : 0.22;
    f[42] = Number.isFinite(Number(state?.quality)) ? (Number(state.quality) | 0) : 1;
    f[43] = 0.0;

    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lensUniformBuf);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.lensUniformBuf);
  }

  _runLensPass(state, cam, simTime, jitterX, jitterY, isProgressive) {
    if ((state?.skyMode | 0) === 1 && !this._procSkyBaked) {
      this._ensureProceduralSky();
    }
    const gl = this.gl;
    const prog = this.programs.lensCluster;
    if (!prog) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.getSceneFbo().fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(prog.program);

    this._writeLensUniforms(state, cam, simTime, jitterX, jitterY, isProgressive);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeNoiseTex);
    gl.uniform1i(this._getUniform(prog, 'uVolumeNoise'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.uniform1i(this._getUniform(prog, 'uSkyMap'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.procSkyTex);
    gl.uniform1i(this._getUniform(prog, 'uProcSkyMap'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.blackbodyTex);
    gl.uniform1i(this._getUniform(prog, 'uBlackbodyLut'), 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.blueNoiseTex);
    gl.uniform1i(this._getUniform(prog, 'uBlueNoise'), 4);

    this._drawFullscreen();
  }

  render(state, camMatrices, simTime = 0, options = {}) {
    if (this._disposed || this.gl.isContextLost() || !this.getAllShadersCompiled()) return false;

    const opts = options || {};
    const targetScale = Number(opts.effectiveResolutionScale ?? state?.resolutionScale ?? this.resolutionScale) || 1.0;
    if (this.width === 0 || this.height === 0 || Math.abs(targetScale - this.resolutionScale) > 1e-4) {
      this.resize(targetScale);
    }

    const cam = extractCamVectors(camMatrices);
    const camMoved = this._didCameraMove(camMatrices, cam);
    const { sourceChanged } = this._syncStateChangeTracking(state, opts);

    const motionFlag = typeof opts.isMotion === 'boolean' ? opts.isMotion : false;
    const isMotion = camMoved || motionFlag || (!state?.paused && sourceChanged);
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

        this._runLensPass(state, cam, simTime, jitterX, jitterY, true);
        this.post.runTaa(this.width, this.height, blendFactor, true);
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
        this._postDirty = false;
        return true;
      } else if (this._postDirty || opts.forceComposite) {
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
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

    this._runLensPass(state, cam, simTime, jitterX, jitterY, false);
    this.post.runTaa(this.width, this.height, blendFactor, false);
    this.post.runBloomAndAnamorphic(state, this.width, this.height);
    this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
    this._postDirty = false;
    return true;
  }

  capturePNG(state, camMatrices, simTime = 0) {
    this.render(state, camMatrices, simTime, { forceComposite: true, dt: 0 });
    this.gl.flush();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to encode canvas frame to PNG.'));
        }
      }, 'image/png');
    });
  }

  dispose() {
    this._disposed = true;
    const gl = this.gl;
    try {
      this.post?.dispose();
      if (this.lensUniformBuf) gl.deleteBuffer(this.lensUniformBuf);
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
