/**
 * WebGLRenderer.js — WebGL2 RGBA16F multi-pass HDR rendering pipeline for
 * Binary Black Hole Inspiral & Gravitational Wave Lensing Simulator:
 *  - Startup GPU 128x128x128 3D volume noise baker (NOISE_BAKE_FRAG)
 *  - Per-frame 256x256 RGBA16F co-rotating tidal hydrodynamics & shockwave ping-pong (TIDAL_FIELD_FRAG)
 *  - Pass 1: Brill-Lindquist + 1PN GM + Cartesian TT GW geodesic ray-tracer (BINARY_BH_FRAG)
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + CA, vignette, film grain & sRGB composite
 */

import { FULLSCREEN_VERT, NOISE_BAKE_FRAG } from '../../../../shared/shaders/common.glsl.js';
import { TIDAL_FIELD_FRAG } from '../shaders/tidal.glsl.js';
import { BINARY_BH_FRAG } from '../shaders/binary.frag.js';
import {
  SharedWebGLPostPipeline,
  detectWebGLHdrFormats,
  MAX_PROGRESSIVE_SAMPLES,
  halton,
  formatShaderError,
} from '../../../../shared/engine/SharedWebGLPostPipeline.js';
import { createWebGLPassProfiler } from '../../../../shared/engine/gpuProfiler.js';
import {
  createProceduralSkyTextureWebGL,
  createPlaceholderSkyTextureWebGL,
} from '../../../../shared/assets/skyLoader.js';
import { createBlackbodyLUTWebGL, createBlueNoiseLUTWebGL } from '../../../../shared/assets/physicalLuts.js';
import { computeBinaryState } from './Physics.js';

const VOLUME_SIZE = 128;
const TIDAL_SIZE = 256;
const MAX_DPR = 1.5;

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.errors = [];
    this.shaderStatus = {};
    this.volumeBaked = false;
    this.tidalComputed = false;
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
    this.taaReadIdx = 0;
    this.taaWriteIdx = 1;
    this.tidalReadIdx = 0;
    this.tidalWriteIdx = 1;
    this._tidalReset = true;
    this._lastTidalSig = null;
    this._tidalSigStore = new Float64Array(5);
    this._fallbackBinOpts = {
      out: { c1: [0, 0, 0], c2: [0, 0, 0], v1: [0, 0, 0], v2: [0, 0, 0] },
    };

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
        ? 'WebGL2 GPU context was lost during initialization. On Linux Wayland + NVIDIA PRIME laptops, run ./launch.sh.'
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
      tidal: this._createProgram('tidal', FULLSCREEN_VERT, TIDAL_FIELD_FRAG),
      binary: this._createProgram('binary', FULLSCREEN_VERT, BINARY_BH_FRAG),
    };

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
      opticsProfile: 'default',
      vertSrc: FULLSCREEN_VERT,
      compileProgram: (name, vs, fs) => this._createProgram(name, vs, fs),
      getUniform: (entry, name) => this._getUniform(entry, name),
      drawFullscreen: () => this._drawFullscreen(),
    });

    this.tidalFbos = [
      this.post.createRenderTarget(TIDAL_SIZE, TIDAL_SIZE, this._taaSpec),
      this.post.createRenderTarget(TIDAL_SIZE, TIDAL_SIZE, this._taaSpec),
    ];

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

  _set1f(prog, name, v) {
    const loc = this._getUniform(prog, name);
    if (loc) this.gl.uniform1f(loc, v);
  }

  _set2f(prog, name, x, y) {
    const loc = this._getUniform(prog, name);
    if (loc) this.gl.uniform2f(loc, x, y);
  }

  _set3f(prog, name, x, y, z) {
    const loc = this._getUniform(prog, name);
    if (loc) this.gl.uniform3f(loc, x, y, z);
  }

  _set4f(prog, name, x, y, z, w) {
    const loc = this._getUniform(prog, name);
    if (loc) this.gl.uniform4f(loc, x, y, z, w);
  }

  _set1i(prog, name, v) {
    const loc = this._getUniform(prog, name);
    if (loc) this.gl.uniform1i(loc, v);
  }

  _runTidalPass(state, binState, fieldHalfSize, simTime, dtSec, forceReset) {
    const gl = this.gl;
    const prog = this.programs.tidal;
    if (!prog) return;

    const prevRt = this.tidalFbos[this.tidalReadIdx];
    const nextRt = this.tidalFbos[this.tidalWriteIdx];

    gl.bindFramebuffer(gl.FRAMEBUFFER, nextRt.fbo);
    gl.viewport(0, 0, TIDAL_SIZE, TIDAL_SIZE);
    gl.useProgram(prog.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prevRt.texture);
    gl.uniform1i(this._getUniform(prog, 'uPrevTidal'), 0);

    gl.uniform2f(this._getUniform(prog, 'uTexelSize'), 1.0 / TIDAL_SIZE, 1.0 / TIDAL_SIZE);
    gl.uniform1f(this._getUniform(prog, 'uSeparation'), binState.d);
    gl.uniform1f(this._getUniform(prog, 'uMassRatio'), binState.q);
    gl.uniform1f(this._getUniform(prog, 'uOmega'), binState.omega);
    gl.uniform1f(this._getUniform(prog, 'uDiskDensity'), state.diskDensity);
    gl.uniform1f(this._getUniform(prog, 'uBridgeIntensity'), state.bridgeIntensity);
    gl.uniform1f(this._getUniform(prog, 'uDiskOuterRadius'), state.diskOuterRadius);
    gl.uniform1f(this._getUniform(prog, 'uFieldHalfSize'), fieldHalfSize);
    gl.uniform1f(this._getUniform(prog, 'uTime'), simTime);
    gl.uniform1f(this._getUniform(prog, 'uDt'), dtSec);
    gl.uniform1i(this._getUniform(prog, 'uReset'), forceReset ? 1 : 0);
    gl.uniform1f(this._getUniform(prog, 'uRocheL1'), binState.rocheL1);
    gl.uniform1f(this._getUniform(prog, 'uRocheL2'), binState.rocheL2);
    gl.uniform1f(this._getUniform(prog, 'uRCavity'), binState.rCavity);
    gl.uniform1f(this._getUniform(prog, 'uRingdown'), binState.ringdownFactor || 0.0);

    this._drawFullscreen();

    const tmp = this.tidalReadIdx;
    this.tidalReadIdx = this.tidalWriteIdx;
    this.tidalWriteIdx = tmp;
    this.tidalComputed = true;
  }

  _runBinaryPass(state, camData, simTime, binState, fieldHalfSize, jitterX, jitterY) {
    if ((state?.skyMode | 0) === 2 && !this._procSkyBaked) {
      this._ensureProceduralSky();
    }
    const gl = this.gl;
    const prog = this.programs.binary;
    if (!prog) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.getSceneFbo().fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(prog.program);

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

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.tidalFbos[this.tidalReadIdx].texture);
    gl.uniform1i(this._getUniform(prog, 'uTidalField'), 5);

    this._set2f(prog, 'uResolution', this.width, this.height);
    this._set1f(prog, 'uTime', simTime);
    this._set1i(prog, 'uFrameIndex', this.frameIndex);
    this._set2f(prog, 'uJitter', jitterX, jitterY);

    this._set3f(prog, 'uCamPos', camData.pos[0], camData.pos[1], camData.pos[2]);
    const uCamBasis = this._getUniform(prog, 'uCamBasis');
    if (uCamBasis) gl.uniformMatrix3fv(uCamBasis, false, camData.basis);
    this._set1f(prog, 'uFovY', camData.fovY);

    this._set1f(prog, 'uMass1', binState.m1);
    this._set1f(prog, 'uMass2', binState.m2);
    this._set1f(prog, 'uSeparation', binState.d);
    this._set1f(prog, 'uEta', binState.eta);
    this._set1f(prog, 'uPhase', binState.phaseRad);
    this._set1f(prog, 'uOmega', binState.omega);
    this._set1f(prog, 'uGwWaveOmega', binState.gwWaveOmega);
    this._set3f(prog, 'uBh1Pos', binState.c1[0], binState.c1[1], binState.c1[2]);
    this._set3f(prog, 'uBh2Pos', binState.c2[0], binState.c2[1], binState.c2[2]);
    this._set3f(prog, 'uBh1Vel', binState.v1[0], binState.v1[1], binState.v1[2]);
    this._set3f(prog, 'uBh2Vel', binState.v2[0], binState.v2[1], binState.v2[2]);

    this._set1f(prog, 'uGwAmplitude', state.gwAmplitude);
    this._set1f(prog, 'uLensingStrength', state.lensingStrength);
    this._set1f(prog, 'uRelativisticMode', state.relativisticMode);

    this._set1f(prog, 'uDiskTemp', state.diskTemp);
    this._set1f(prog, 'uDiskDensity', state.diskDensity);
    this._set1f(prog, 'uBridgeIntensity', state.bridgeIntensity);
    this._set1f(prog, 'uDiskThickness', state.diskThickness);
    this._set1f(prog, 'uDiskOuterRadius', state.diskOuterRadius);
    this._set1f(prog, 'uTurbulence', state.turbulence);
    this._set1f(prog, 'uFieldHalfSize', fieldHalfSize);
    this._set1f(prog, 'uRCavity', binState.rCavity);
    this._set1f(prog, 'uRingdown', binState.ringdownFactor || 0.0);

    this._set1f(prog, 'uSkyIntensity', state.skyIntensity);
    this._set1i(prog, 'uSkyMode', state.skyMode | 0);
    const skyRot = state.skyRotation || [0.42, 0.22];
    const skyRotX = skyRot[0] || 0;
    const skyRotY = skyRot[1] || 0;
    this._set2f(prog, 'uSkyRotation', skyRotX, skyRotY);
    this._set1i(prog, 'uQuality', state.quality | 0);

    const rOuter = Math.max(state.diskOuterRadius, binState.rCavity + 4.0);
    const camR = Math.hypot(camData.pos[0], camData.pos[1], camData.pos[2]);
    const escapeR = Math.max(Math.max(rOuter * 1.85, camR * 1.65), 62.0);
    const clampedFov = camData.fovY < 0.1 ? 0.1 : camData.fovY > 2.8 ? 2.8 : camData.fovY;
    const tanHalfFov = Math.tan(clampedFov * 0.5);
    const maxDiskSlabY = (0.054 + 0.033 * rOuter * 1.30) * Math.max(state.diskThickness, 0.15) * 2.75;

    const flowCycle = 15.0;
    const tNorm0 = simTime / flowCycle;
    const phase0 = tNorm0 - Math.floor(tNorm0);
    const tNorm1 = tNorm0 + 0.5;
    const phase1 = tNorm1 - Math.floor(tNorm1);

    this._set1f(prog, 'uTanHalfFov', tanHalfFov);
    this._set1f(prog, 'uEscapeR', escapeR);
    this._set1f(prog, 'uMaxDiskSlabY', maxDiskSlabY);
    this._set4f(
      prog,
      'uFlowConsts',
      0.5 - 0.5 * Math.cos(Math.PI * 2.0 * phase0),
      (phase0 - 0.5) * flowCycle,
      (phase1 - 0.5) * flowCycle,
      simTime * 0.038
    );
    this._set2f(prog, 'uOrbTrig', Math.cos(binState.phaseRad), Math.sin(binState.phaseRad));
    this._set4f(
      prog,
      'uSkyTrig',
      Math.cos(skyRotX),
      Math.sin(skyRotX),
      Math.cos(skyRotY),
      Math.sin(skyRotY)
    );

    this.profiler?.beginPass('raymarch');
    this._drawFullscreen();
    this.profiler?.endPass();
  }

  _maybeUpdateTidal(state, binState, fieldHalfSize, simTime, dtSec, isProgressive) {
    if (state.diskDensity <= 0.001 && state.bridgeIntensity <= 0.001) {
      this._tidalReset = true;
      this._lastTidalSig = null;
      return;
    }

    const q = binState.q;
    const dens = state.diskDensity;
    const bridge = state.bridgeIntensity;
    const outer = state.diskOuterRadius;
    const d = binState.d;

    let needReset = this._tidalReset || !this._lastTidalSig;
    if (!needReset) {
      const prev = this._lastTidalSig;
      if (
        Math.abs(q - prev[0]) > 1e-4 ||
        Math.abs(dens - prev[1]) > 1e-3 ||
        Math.abs(bridge - prev[2]) > 1e-3 ||
        Math.abs(outer - prev[3]) > 0.1 ||
        Math.abs(d - prev[4]) > 0.35
      ) {
        needReset = true;
      }
    }

    if (needReset || (!isProgressive && dtSec > 0.0)) {
      this._runTidalPass(state, binState, fieldHalfSize, simTime, isProgressive ? 0.0 : dtSec, needReset);
      this._tidalReset = false;
      this._tidalSigStore[0] = q;
      this._tidalSigStore[1] = dens;
      this._tidalSigStore[2] = bridge;
      this._tidalSigStore[3] = outer;
      this._tidalSigStore[4] = d;
      this._lastTidalSig = this._tidalSigStore;
    }
  }

  render(state, camData, simTime, binState = null, options = {}) {
    if (this._disposed || this.gl.isContextLost() || !this.getAllShadersCompiled()) return false;

    const targetScale = Number(options?.effectiveResolutionScale ?? state?.resolutionScale ?? this.resolutionScale) || 1.0;
    if (this.width === 0 || this.height === 0 || Math.abs(targetScale - this.resolutionScale) > 1e-4) {
      this.resize(targetScale);
    }

    const activeBin = binState || computeBinaryState(state, simTime * 0.25, this._fallbackBinOpts);
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
        this._maybeUpdateTidal(state, activeBin, fieldHalfSize, simTime, 0.0, true);
        this.frameIndex++;
        this.sampleCount++;

        const jitterX = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 2) - 0.5;
        const jitterY = this.sampleCount === 1 ? 0.0 : halton(this.sampleCount, 3) - 0.5;
        const blendFactor = this._hardReset ? 1.0 : 1.0 / this.sampleCount;
        this._hardReset = false;

        this.profiler?.beginFrame();

        this._runBinaryPass(state, camData, simTime, activeBin, fieldHalfSize, jitterX, jitterY);
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

    this._maybeUpdateTidal(state, activeBin, fieldHalfSize, simTime, dtSec, false);

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

    this._runBinaryPass(state, camData, simTime, activeBin, fieldHalfSize, jitterX, jitterY);
    this.post.runTaa(this.width, this.height, blendFactor, false);
    this.post.runBloomAndAnamorphic(state, this.width, this.height);
    this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
        this.profiler?.endFrame();
    this._postDirty = false;
    return true;
  }

  capturePNG(state, camData, simTime, binState = null) {
    this.render(state, camData, simTime, binState, { forceComposite: true, dt: 0 });
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
      this.post?.destroyRenderTarget(this.tidalFbos[0]);
      this.post?.destroyRenderTarget(this.tidalFbos[1]);
      this.profiler?.dispose();
      this.post?.dispose();
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
