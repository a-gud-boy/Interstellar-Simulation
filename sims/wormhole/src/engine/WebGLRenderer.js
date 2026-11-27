/**
 * WebGLRenderer.js — WebGL2 RGBA16F multi-pass HDR rendering pipeline for the Wormhole Simulator:
 *  - Startup GPU 128x128x128 3D volume noise baker (NOISE_BAKE_FRAG)
 *  - Pass 1: Morris-Thorne / Ellis wormhole geodesic ray-tracer (WORMHOLE_FRAG) with Halton(2,3) jitter
 *  - Pass 2: HDR YCoCg variance-clipped TAA + 128-sample unbiased progressive accumulation
 *  - Pass 3: Karis prefilter + 6-level Jimenez 13-tap downsample / 9-tap tent upsample HDR bloom
 *  - Pass 4: 2-pass separable 70mm Panavision horizontal anamorphic optical flare
 *  - Pass 5: Troy Sobotka AgX Filmic Tone Mapping + subtle CA, vignette, film grain & sRGB composite
 */

import { FULLSCREEN_VERT, NOISE_BAKE_FRAG } from '../../../../shared/shaders/common.glsl.js';
import { WORMHOLE_FRAG } from '../shaders/wormhole.frag.js';
import {
  SharedWebGLPostPipeline,
  MAX_PROGRESSIVE_SAMPLES,
  halton,
  formatShaderError,
} from '../../../../shared/engine/SharedWebGLPostPipeline.js';
import {
  createProceduralSkyTextureAWebGL,
  createExoticNebulaTextureBWebGL,
} from '../../../../shared/assets/skyLoader.js';
import { createBlueNoiseLUTWebGL } from '../../../../shared/assets/physicalLuts.js';

const VOLUME_SIZE = 128;
const MAX_DPR = 1.5;

export class WebGLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
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
        ? 'WebGL2 GPU context was lost during initialization (browser GPU process crashed or reset). On Linux Wayland + NVIDIA PRIME laptops, run ./launch.sh (which uses --ozone-platform=x11).'
        : 'WebGL2 context could not be initialized on this browser/GPU.';
      this.errors.push(msg);
      throw new Error(msg);
    }

    this.gl = gl;

    // Query extensions & GPU identity
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

    // Core GL state for fullscreen post/ray-trace passes
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);

    this.emptyVao = gl.createVertexArray();
    this._hdrSpec = this._detectHdrFboFormat();

    // Compile all shader programs
    this.programs = {
      noiseBake: this._createProgram('noiseBake', FULLSCREEN_VERT, NOISE_BAKE_FRAG),
      wormhole: this._createProgram('wormhole', FULLSCREEN_VERT, WORMHOLE_FRAG),
    };

    // Static blue-noise LUT + procedural Universe A sky fallback + Universe B exotic nebula
    const blueRes = createBlueNoiseLUTWebGL(gl, 128);
    this.blueNoiseTex = blueRes?.texture || blueRes;

    const procSkyRes = createProceduralSkyTextureAWebGL(gl, 2048, 1024);
    this.procSkyTexA = procSkyRes?.texture || procSkyRes;
    this.skyTexA = this.procSkyTexA;

    const skyBRes = createExoticNebulaTextureBWebGL(gl, 2048, 1024);
    this.skyTexB = skyBRes?.texture || skyBRes;

    // Startup GPU 3D volume noise texture bake (128x128x128 RGBA8)
    this.volumeNoiseTex = this._bakeVolumeNoise();

    // Shared HDR post-processing pipeline
    this.post = new SharedWebGLPostPipeline({
      gl,
      emptyVao: this.emptyVao,
      hdrSpec: this._hdrSpec,
      opticsProfile: 'default',
      vertSrc: FULLSCREEN_VERT,
      compileProgram: (name, vs, fs) => this._createProgram(name, vs, fs),
      getUniform: (entry, name) => this._getUniform(entry, name),
      drawFullscreen: () => this._drawFullscreen(),
    });

    this.resize(1.0);
  }

  _detectHdrFboFormat() {
    const gl = this.gl;
    const candidates = [];

    if (this.extColorBufferFloat || this.extColorBufferHalfFloat) {
      candidates.push({
        name: 'RGBA16F',
        internalFormat: gl.RGBA16F,
        format: gl.RGBA,
        type: gl.HALF_FLOAT,
      });
    }
    if (this.extColorBufferFloat) {
      candidates.push({
        name: 'R11F_G11F_B10F',
        internalFormat: gl.R11F_G11F_B10F,
        format: gl.RGB,
        type: gl.HALF_FLOAT,
      });
    }
    candidates.push({
      name: 'RGBA8',
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });

    const probeFbo = gl.createFramebuffer();
    const probeTex = gl.createTexture();

    for (const spec of candidates) {
      gl.bindTexture(gl.TEXTURE_2D, probeTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, spec.internalFormat, 4, 4, 0, spec.format, spec.type, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

      if (status === gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(probeTex);
        gl.deleteFramebuffer(probeFbo);
        this.hdrFormat = spec.name;
        return spec;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(probeTex);
    gl.deleteFramebuffer(probeFbo);
    const fallback = candidates[candidates.length - 1];
    this.hdrFormat = fallback.name;
    return fallback;
  }

  _compileShader(name, type, source) {
    const gl = this.gl;
    if (gl.isContextLost()) {
      const msg =
        'WebGL2 GPU context was lost while compiling shaders. On Linux Wayland + NVIDIA PRIME laptops, launch with ./launch.sh (--ozone-platform=x11).';
      if (!this.errors.includes(msg)) {
        console.error('[WebGLRenderer]', msg);
        this.errors.push(msg);
      }
      return { shader: null, error: msg };
    }
    const shader = gl.createShader(type);
    if (!shader) {
      const msg = `[WebGLRenderer] Failed to allocate ${name} shader (GPU context lost).`;
      if (!this.errors.includes(msg)) {
        console.error(msg);
        this.errors.push(msg);
      }
      return { shader: null, error: msg };
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      if (gl.isContextLost()) {
        gl.deleteShader(shader);
        const msg =
          'WebGL2 GPU context was lost while compiling shaders. On Linux Wayland + NVIDIA PRIME laptops, launch with ./launch.sh (--ozone-platform=x11).';
        if (!this.errors.includes(msg)) {
          console.error('[WebGLRenderer]', msg);
          this.errors.push(msg);
        }
        return { shader: null, error: msg };
      }
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
    if (!prog) {
      return tex;
    }

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

  /**
   * Swap in asynchronously loaded 4K real astronomical sky map for Universe A.
   * Accepts either `{ texture, width, height, isRealMap }` or a raw WebGLTexture.
   */
  setSkyTexture(skyResult) {
    if (!skyResult) return;
    const gl = this.gl;

    if (typeof WebGLTexture !== 'undefined' && skyResult instanceof WebGLTexture) {
      if (this.skyTexA && this.skyTexA !== this.procSkyTexA && this.skyTexA !== skyResult) {
        gl.deleteTexture(this.skyTexA);
      }
      this.skyTexA = skyResult;
      this.skyMapLoaded = true;
      this.resetAccumulation(true);
      return;
    }

    const { texture, width, height, isRealMap } = skyResult;
    if (isRealMap && texture) {
      if (this.skyTexA && this.skyTexA !== this.procSkyTexA && this.skyTexA !== texture) {
        gl.deleteTexture(this.skyTexA);
      }
      this.skyTexA = texture;
      this.skyMapLoaded = true;
      this.skyDimensions = [width || 4096, height || 2048];
      this.resetAccumulation(true);
    } else {
      if (texture && texture !== this.procSkyTexA && texture !== this.skyTexA) {
        gl.deleteTexture(texture);
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

  _runWormholePass(state, camData, simTime, jitterX, jitterY) {
    const gl = this.gl;
    const prog = this.programs.wormhole;
    const sceneFbo = this.post?.getSceneFbo();
    if (!prog || !sceneFbo) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(prog.program);

    // Texture bindings (exact unit contract 0..4)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeNoiseTex);
    const uVolumeNoise = this._getUniform(prog, 'uVolumeNoise');
    if (uVolumeNoise) gl.uniform1i(uVolumeNoise, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTexA);
    const uSkyMapA = this._getUniform(prog, 'uSkyMapA');
    if (uSkyMapA) gl.uniform1i(uSkyMapA, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.procSkyTexA);
    const uProcSkyMapA = this._getUniform(prog, 'uProcSkyMapA');
    if (uProcSkyMapA) gl.uniform1i(uProcSkyMapA, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTexB);
    const uSkyMapB = this._getUniform(prog, 'uSkyMapB');
    if (uSkyMapB) gl.uniform1i(uSkyMapB, 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.blueNoiseTex);
    const uBlueNoise = this._getUniform(prog, 'uBlueNoise');
    if (uBlueNoise) gl.uniform1i(uBlueNoise, 4);

    const set2f = (name, x, y) => {
      const loc = this._getUniform(prog, name);
      if (loc) gl.uniform2f(loc, x, y);
    };
    const set3f = (name, x, y, z) => {
      const loc = this._getUniform(prog, name);
      if (loc) gl.uniform3f(loc, x, y, z);
    };
    const set1f = (name, v) => {
      const loc = this._getUniform(prog, name);
      if (loc) gl.uniform1f(loc, v);
    };
    const set1i = (name, v) => {
      const loc = this._getUniform(prog, name);
      if (loc) gl.uniform1i(loc, v);
    };

    set2f('uResolution', this.width, this.height);
    set1f('uTime', simTime);
    set1i('uFrameIndex', this.frameIndex);
    set2f('uJitter', jitterX, jitterY);

    set3f('uCamN0', camData.n0[0], camData.n0[1], camData.n0[2]);
    set1f('uCamL', camData.l);
    const uCamBasis = this._getUniform(prog, 'uCamBasis');
    if (uCamBasis) gl.uniformMatrix3fv(uCamBasis, false, camData.basis);
    set1f('uFovY', camData.fovY);

    // Wormhole metric, throat matter, dual-universe skies & quality (exact 21-uniform contract)
    set1i('uMetricType', state.metricType | 0);
    set1f('uThroatRadius', state.throatRadius ?? 2.0);
    set1f('uThroatLength', state.throatLength ?? 0.25);
    set1f('uLensingWidth', state.lensingWidth ?? 0.32);
    set1f('uThroatGlow', state.throatGlow ?? 0.22);
    set1f('uDustDensity', state.dustDensity ?? 0.35);
    set1f('uSwirlSpeed', state.swirlSpeed ?? 0.85);
    set1f('uSkyIntensityA', state.skyIntensityA ?? 1.0);
    set1f('uSkyIntensityB', state.skyIntensityB ?? 1.15);
    set1i('uPlanetVisible', state.planetVisible | 0);

    const rotA = state.skyRotationA || [0.4, 0.2];
    const rotB = state.skyRotationB || [1.1, -0.15];
    set2f('uSkyRotationA', rotA[0] ?? 0, rotA[1] ?? 0);
    set2f('uSkyRotationB', rotB[0] ?? 0, rotB[1] ?? 0);
    set1i('uQuality', state.quality | 0);

    this._drawFullscreen();
  }

  /**
   * Execute a full multi-pass render frame.
   * Returns true if GPU work was submitted on this tick, false if skipped (disposed/converged).
   */
  render(state, camData, simTime, options = {}) {
    if (this._disposed || this.gl.isContextLost() || !this.getAllShadersCompiled()) return false;

    this.resize(state.resolutionScale);

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

        this._runWormholePass(state, camData, simTime, jitterX, jitterY);
        this.post.runTaa(this.width, this.height, blendFactor, true);
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
        this._postDirty = false;
        return true;
      } else if (this._postDirty || options.forceComposite) {
        this.post.runBloomAndAnamorphic(state, this.width, this.height);
        this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
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

    this._runWormholePass(state, camData, simTime, jitterX, jitterY);
    this.post.runTaa(this.width, this.height, blendFactor, false);
    this.post.runBloomAndAnamorphic(state, this.width, this.height);
    this.post.runComposite(state, this.width, this.height, simTime, this.frameIndex);
    this._postDirty = false;
    return true;
  }

  /**
   * Renders the current frame into the default framebuffer and exports a PNG Blob.
   * @returns {Promise<Blob>}
   */
  capturePNG(state, camData, simTime) {
    this.render(state, camData, simTime, { forceComposite: true });
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
      if (this.volumeNoiseTex) gl.deleteTexture(this.volumeNoiseTex);
      if (this.blueNoiseTex) gl.deleteTexture(this.blueNoiseTex);
      if (this.skyTexA && this.skyTexA !== this.procSkyTexA) gl.deleteTexture(this.skyTexA);
      if (this.procSkyTexA) gl.deleteTexture(this.procSkyTexA);
      if (this.skyTexB) gl.deleteTexture(this.skyTexB);
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      for (const entry of Object.values(this.programs)) {
        if (entry?.program) gl.deleteProgram(entry.program);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Best-effort cleanup during backend teardown
    }
  }
}
