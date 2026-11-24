/**
 * main.js — Unified WebGL2 + WebGPU application bootstrap, live backend switcher,
 * ADM warp animation loop with 750ms sliding-window FPS measurement, keyboard shortcuts
 * (including T for Bridge/Chase toggle), asynchronous 4K sky acquisition, HUD wiring,
 * and window.__WARP_DRIVE__ programmatic API.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { WarpCamera } from './engine/WarpCamera.js';
import { computeWarpTelemetry } from './engine/WarpPhysics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { loadSkyTextureWebGL, loadSkyTextureWebGPU } from '../../shared/assets/skyLoader.js';
import { mountSimSwitcher } from '../../shared/ui/simSwitcher.js';
import { createHUD } from './ui/ControlsHUD.js';

const POST_ONLY_KEYS = new Set(['exposure', 'bloomIntensity', 'anamorphicIntensity']);
const TELEMETRY_INTERVAL_MS = 85;
const BACKEND_STORAGE_KEY = 'warp-drive.backend';
const VALID_BACKENDS = new Set(['webgl2', 'webgpu']);

function normalizeBackend(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'webgl') return 'webgl2';
  return VALID_BACKENDS.has(v) ? v : null;
}

function resolveInitialBackend() {
  try {
    const queryBackend = normalizeBackend(new URLSearchParams(window.location.search).get('backend'));
    if (queryBackend) return queryBackend;
  } catch {
    // Ignore URL parsing issues
  }

  try {
    const stored = normalizeBackend(window.localStorage?.getItem(BACKEND_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Ignore restricted localStorage
  }

  return 'webgl2';
}

function backendLabel(backend) {
  return backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function bootstrap() {
  let canvas = document.getElementById('warp-drive-canvas');
  if (!canvas) {
    console.error('[WarpDrive] Missing <canvas id="warp-drive-canvas"> element.');
    return;
  }

  const canvasFallbackText = canvas.textContent;
  const state = createInitialState();
  let activeBackend = resolveInitialBackend();
  state.backend = activeBackend;
  const simSwitcher = mountSimSwitcher({
    currentSimId: 'warp',
    initialBackend: activeBackend,
  });

  function syncSimSwitchLinks(backend) {
    simSwitcher.syncBackend(backend);
  }

  const initialPreset = getPresetById(state.presetId) || PRESETS[0];

  let renderer = null;
  let camera = null;
  let hud = null;
  let resizeObserver = null;

  let simTime = 0;
  let fpsSmoothed = 0;
  let fpsInitialized = false;
  const frameTimestamps = [];
  let lastFrameTime = performance.now();
  let lastSubmitTime = 0;
  let lastTelemetryPush = 0;
  let lastFrameBlend = state.cameraMode === 1 ? 1.0 : 0.0;
  let skyLoadPromise = Promise.resolve(null);
  let contextLost = false;
  let switchingBackend = false;
  let switchTail = Promise.resolve();
  let rendererGeneration = 0;
  let canvasTouched = false;
  const runtimeErrors = [];

  window.addEventListener('error', (ev) => {
    runtimeErrors.push(String(ev?.message || ev?.error || 'Window error'));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    runtimeErrors.push(String(ev?.reason?.message || ev?.reason || 'Unhandled rejection'));
  });

  function replaceCanvas() {
    if (resizeObserver && canvas) {
      resizeObserver.unobserve(canvas);
    }
    const nextCanvas = document.createElement('canvas');
    nextCanvas.id = 'warp-drive-canvas';
    nextCanvas.className = canvas?.className || 'sim-canvas';
    nextCanvas.setAttribute(
      'aria-label',
      canvas?.getAttribute('aria-label') || 'Interactive relativistic Alcubierre warp drive simulation'
    );
    nextCanvas.textContent = canvasFallbackText;
    canvas.replaceWith(nextCanvas);
    canvas = nextCanvas;
    if (resizeObserver) {
      resizeObserver.observe(canvas);
    }
    camera?.setCanvas(canvas);
    return canvas;
  }

  function resetFpsTracker() {
    frameTimestamps.length = 0;
    fpsSmoothed = 0;
    fpsInitialized = false;
    lastSubmitTime = 0;
  }

  function buildTelemetry() {
    const physicsTel = computeWarpTelemetry(state);
    return {
      ...physicsTel,
      backend: activeBackend,
      fps: fpsSmoothed,
      samples: renderer ? renderer.sampleCount : 0,
      cameraMode: state.cameraMode,
      rendererName: renderer ? renderer.rendererName : 'Unavailable',
    };
  }

  function disposeOrphanedSky(targetBackend, targetRenderer, result) {
    if (!result?.texture) return;
    try {
      if (targetBackend === 'webgpu') {
        result.texture.destroy?.();
      } else {
        targetRenderer.gl?.deleteTexture(result.texture);
      }
    } catch {
      // Ignore cleanup errors on disposed context
    }
  }

  function attachSkyTexture(targetBackend, targetRenderer, generation) {
    hud.setSkyStatus('Procedural Sky');
    const loader =
      targetBackend === 'webgpu'
        ? loadSkyTextureWebGPU(
            targetRenderer.device,
            (tex, w, h, m) => targetRenderer.generateMipmaps(tex, w, h, m)
          )
        : loadSkyTextureWebGL(targetRenderer.gl);

    return loader
      .then((result) => {
        if (generation !== rendererGeneration || targetRenderer._disposed) {
          disposeOrphanedSky(targetBackend, targetRenderer, result);
          return null;
        }
        targetRenderer.setSkyTexture(result);
        hud.setSkyStatus(result?.isRealMap ? '4K Milky Way' : 'Procedural Sky');
        if (state.paused && camera && !targetRenderer._disposed) {
          targetRenderer.render(state, camera.getCameraMatrices(), simTime, {
            forceComposite: true,
            dt: 0,
          });
        }
        return result;
      })
      .catch((err) => {
        if (generation === rendererGeneration && !targetRenderer._disposed) {
          console.warn('[WarpDrive] Async sky texture load failed:', err);
          hud.setSkyStatus('Procedural Sky');
        }
        return null;
      });
  }

  async function createRendererForBackend(targetBackend, targetCanvas, generation) {
    canvasTouched = true;

    if (targetBackend === 'webgpu') {
      const gpuRenderer = await WebGPURenderer.create(targetCanvas, {
        onDeviceLost: (info) => {
          if (generation !== rendererGeneration || gpuRenderer._disposed) return;
          contextLost = true;
          targetCanvas.style.visibility = 'hidden';
          hud.setError?.(
            `WebGPU device was lost (${info?.reason || 'unknown'}). Switch to WebGL2 in Controls or reload if this persists.`
          );
        },
      });
      if (!gpuRenderer.getAllShadersCompiled()) {
        const errSummary =
          gpuRenderer.errors.join('\n') || 'One or more WebGPU WGSL shaders failed to compile.';
        gpuRenderer.dispose();
        throw new Error(errSummary);
      }
      gpuRenderer.resize(state.resolutionScale);
      return gpuRenderer;
    }

    const glRenderer = new WebGLRenderer(targetCanvas);
    targetCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (generation !== rendererGeneration || glRenderer._disposed) return;
      contextLost = true;
      targetCanvas.style.visibility = 'hidden';
      hud.setError?.(
        'WebGL2 GPU context was lost. Waiting for GPU recovery — reload or relaunch via ./launch.sh if this persists.'
      );
    });
    targetCanvas.addEventListener('webglcontextrestored', () => {
      if (generation !== rendererGeneration || glRenderer._disposed) return;
      window.location.reload();
    });

    if (!glRenderer.getAllShadersCompiled()) {
      const errSummary =
        glRenderer.errors.join('\n') || 'One or more WebGL2 shaders failed to compile.';
      glRenderer.dispose();
      throw new Error(errSummary);
    }
    glRenderer.resize(state.resolutionScale);
    return glRenderer;
  }

  function persistBackendChoice(backend) {
    try {
      window.localStorage?.setItem(BACKEND_STORAGE_KEY, backend);
    } catch {
      // Ignore restricted storage
    }
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('backend')) {
        url.searchParams.set('backend', backend);
        window.history?.replaceState?.(null, '', url.toString());
      }
    } catch {
      // Ignore history API errors
    }
  }

  function activateRenderer(nextRenderer, targetBackend, generation, { persist = true, statusNote = '' } = {}) {
    renderer = nextRenderer;
    activeBackend = targetBackend;
    state.backend = targetBackend;
    syncSimSwitchLinks(activeBackend);
    contextLost = false;
    resetFpsTracker();

    if (!camera) {
      camera = new WarpCamera(canvas, initialPreset.camera, {
        cameraMode: state.cameraMode,
        onResetRequest: () => handleAction('resetCamera'),
        onModeChange: (nextMode) => {
          const normalized = Number(nextMode) === 1 ? 1 : 0;
          if (state.cameraMode !== normalized) {
            state.cameraMode = normalized;
            hud?.syncState({ cameraMode: normalized });
            renderer?.resetAccumulation(true);
            hud?.updateTelemetry(buildTelemetry());
          }
        },
      });
    } else {
      camera.setCanvas(canvas);
    }

    const camMatrices = camera.getCameraMatrices();
    lastFrameBlend = camMatrices.frameBlend ?? (state.cameraMode === 1 ? 1.0 : 0.0);
    renderer.resize(state.resolutionScale);
    renderer.render(state, camMatrices, simTime, {
      forceComposite: true,
      dt: 0,
    });
    skyLoadPromise = attachSkyTexture(targetBackend, renderer, generation);

    if (persist) {
      persistBackendChoice(targetBackend);
    }

    hud.setError?.(null);
    hud.setLoading?.(false);
    hud.setBackendState({ backend: activeBackend, busy: false, statusNote });
    hud.updateTelemetry(buildTelemetry());
  }

  async function performBackendSwitch(nextBackend, { isInitial = false, persist = true } = {}) {
    const target = normalizeBackend(nextBackend);
    if (!target) {
      return {
        ok: false,
        backend: activeBackend,
        previousBackend: activeBackend,
        error: `Unsupported backend: ${nextBackend}`,
      };
    }

    if (!isInitial && target === activeBackend && renderer) {
      hud.setBackendState({ backend: activeBackend, busy: false, statusNote: '' });
      return { ok: true, backend: activeBackend, previousBackend: activeBackend };
    }

    if (!isInitial && target === 'webgpu' && (typeof navigator === 'undefined' || !navigator.gpu)) {
      const note = 'WebGPU unavailable in this browser — staying on WebGL2';
      hud.setBackendState({ backend: activeBackend, busy: false, statusNote: note });
      return { ok: false, backend: activeBackend, previousBackend: activeBackend, error: note };
    }

    if (!isInitial && target === 'webgl2' && (typeof window === 'undefined' || !window.WebGL2RenderingContext)) {
      const note = 'WebGL2 unavailable in this browser — staying on WebGPU';
      hud.setBackendState({ backend: activeBackend, busy: false, statusNote: note });
      return { ok: false, backend: activeBackend, previousBackend: activeBackend, error: note };
    }

    const previousBackend = renderer ? activeBackend : null;
    switchingBackend = true;

    try {
      hud.setError?.(null);
      hud.setBackendState({
        backend: target,
        busy: true,
        statusNote: isInitial ? '' : `Switching to ${backendLabel(target)}…`,
      });
      hud.setLoading?.(
        true,
        target === 'webgpu'
          ? 'Initializing WebGPU & baking 3D warp turbulence…'
          : 'Baking 3D warp turbulence & ADM geodesics…'
      );

      const gen = ++rendererGeneration;
      if (renderer) {
        try {
          renderer.dispose();
        } catch {
          // Best-effort disposal
        }
        renderer = null;
      }

      if (!isInitial || canvasTouched) {
        replaceCanvas();
      }

      const nextRenderer = await createRendererForBackend(target, canvas, gen);
      if (gen !== rendererGeneration) {
        nextRenderer.dispose();
        return { ok: false, backend: activeBackend, previousBackend, error: 'Superseded by newer switch.' };
      }

      activateRenderer(nextRenderer, target, gen, { persist, statusNote: '' });
      return { ok: true, backend: activeBackend, previousBackend };
    } catch (err) {
      const primaryErrMsg = err?.message || `${backendLabel(target)} initialization failed.`;
      console.warn(`[WarpDrive] ${backendLabel(target)} initialization failed, attempting fallback:`, err);

      const fallback = target === 'webgpu' ? 'webgl2' : 'webgpu';
      const fbGen = ++rendererGeneration;

      if (renderer) {
        try {
          renderer.dispose();
        } catch {
          // Ignore
        }
        renderer = null;
      }
      if (canvasTouched) {
        replaceCanvas();
      }

      try {
        hud.setLoading?.(true, `Falling back to ${backendLabel(fallback)}…`);
        const fbRenderer = await createRendererForBackend(fallback, canvas, fbGen);
        const note = `${backendLabel(target)} unavailable — using ${backendLabel(fallback)}`;
        activateRenderer(fbRenderer, fallback, fbGen, { persist: false, statusNote: note });
        return {
          ok: false,
          backend: fallback,
          previousBackend,
          error: primaryErrMsg,
          fellBackTo: fallback,
        };
      } catch (fbErr) {
        const fbMsg = fbErr?.message || `${backendLabel(fallback)} fallback failed.`;
        const combined = `${primaryErrMsg}\n\nFallback (${backendLabel(fallback)}) failed: ${fbMsg}`;
        runtimeErrors.push(primaryErrMsg, fbMsg);
        canvas.style.visibility = 'hidden';
        hud.setLoading?.(false);
        hud.setBackendState({
          backend: target,
          busy: false,
          statusNote: 'Both WebGL2 and WebGPU failed to initialize',
        });
        hud.setError?.(combined);
        console.error('[WarpDrive] Both backends failed:', combined);
        return { ok: false, backend: null, previousBackend, error: combined };
      }
    } finally {
      switchingBackend = false;
    }
  }

  function switchBackend(nextBackend, options = {}) {
    const run = switchTail.then(() => performBackendSwitch(nextBackend, options));
    switchTail = run.catch(() => {});
    return run;
  }

  function applyParamChange(key, value, { syncUi = false } = {}) {
    if (key === 'backend') {
      void switchBackend(value, { isInitial: false, persist: true });
      return;
    }

    if (!(key in state) && key !== 'skyRotation') return;

    if (key === 'skyRotation' && Array.isArray(value)) {
      state.skyRotation = [Number(value[0]) || 0, Number(value[1]) || 0];
    } else if (key === 'cameraMode') {
      const nextMode = Number(value) === 1 ? 1 : 0;
      state.cameraMode = nextMode;
      camera?.setCameraMode(nextMode, false);
    } else if (typeof state[key] === 'boolean') {
      state[key] = Boolean(value);
    } else if (typeof state[key] === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) return;
      state[key] = num;
    } else {
      state[key] = value;
    }

    if (renderer) {
      if (key === 'resolutionScale') {
        renderer.resize(state.resolutionScale);
      } else if (POST_ONLY_KEYS.has(key)) {
        renderer.markPostDirty();
      } else if (key !== 'paused' && key !== 'autoOrbit') {
        renderer.resetAccumulation(true);
      }
    }

    if (syncUi && hud) {
      hud.syncState({ [key]: state[key] });
    }
    hud?.updateTelemetry(buildTelemetry());
  }

  function selectPreset(presetId, { instant = false } = {}) {
    const preset = getPresetById(presetId);
    if (!preset) return false;

    state.presetId = preset.id;
    for (const [k, v] of Object.entries(preset.params)) {
      if (k === 'skyRotation' && Array.isArray(v)) {
        state.skyRotation = [...v];
      } else {
        state[k] = v;
      }
    }

    if (typeof preset.camera?.autoOrbit === 'boolean') {
      state.autoOrbit = preset.camera.autoOrbit;
    }

    const targetMode =
      typeof preset.params?.cameraMode === 'number'
        ? (Number(preset.params.cameraMode) === 1 ? 1 : 0)
        : state.cameraMode;
    state.cameraMode = targetMode;

    if (camera) {
      camera.flyTo(preset.camera, instant ? 0 : 1.1, targetMode);
      if (instant) {
        lastFrameBlend = camera.getCameraMatrices().frameBlend ?? (targetMode === 1 ? 1.0 : 0.0);
      }
    }

    if (renderer) {
      renderer.resetAccumulation(true);
    }

    if (hud) {
      hud.syncState(state);
      hud.setActivePreset(preset.id);
    }

    if (instant && renderer && camera && !switchingBackend) {
      renderer.render(state, camera.getCameraMatrices(), simTime, {
        forceComposite: true,
        dt: 0,
      });
    }
    hud?.updateTelemetry(buildTelemetry());

    return true;
  }

  async function handleScreenshot() {
    if (!renderer || !camera || switchingBackend) return;
    try {
      const blob = await renderer.capturePNG(state, camera.getCameraMatrices(), simTime);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(blob, `warp-drive-${activeBackend}-${state.presetId}-${stamp}.png`);
    } catch (err) {
      console.error('[WarpDrive] Screenshot failed:', err);
      runtimeErrors.push(String(err?.message || err));
    }
  }

  function handleAction(actionName) {
    switch (actionName) {
      case 'togglePause':
        state.paused = !state.paused;
        hud?.syncState({ paused: state.paused });
        break;

      case 'toggleCameraMode': {
        const nextMode = camera
          ? camera.toggleCameraMode(false)
          : state.cameraMode === 1
            ? 0
            : 1;
        state.cameraMode = Number(nextMode) === 1 ? 1 : 0;
        hud?.syncState({ cameraMode: state.cameraMode });
        renderer?.resetAccumulation(true);
        hud?.updateTelemetry(buildTelemetry());
        break;
      }

      case 'toggleAutoOrbit':
        state.autoOrbit = !state.autoOrbit;
        hud?.syncState({ autoOrbit: state.autoOrbit });
        break;

      case 'resetCamera': {
        const active = getPresetById(state.presetId) || PRESETS[0];
        const targetMode =
          typeof active.params?.cameraMode === 'number'
            ? (Number(active.params.cameraMode) === 1 ? 1 : 0)
            : state.cameraMode;
        state.cameraMode = targetMode;
        camera?.flyTo(active.camera, 1.0, targetMode);
        renderer?.resetAccumulation(true);
        hud?.syncState({ cameraMode: state.cameraMode });
        hud?.updateTelemetry(buildTelemetry());
        break;
      }

      case 'screenshot':
        handleScreenshot();
        break;

      case 'toggleHud':
        hud?.toggleHud();
        break;

      default:
        break;
    }
  }

  hud = createHUD({
    state,
    presets: PRESETS,
    onParamChange: (key, value) => applyParamChange(key, value, { syncUi: false }),
    onPresetSelect: (presetId) => selectPreset(presetId, { instant: false }),
    onAction: handleAction,
  });

  hud.setActivePreset(initialPreset.id);
  hud.setSkyStatus('Procedural Sky');

  const onResize = () => {
    if (!switchingBackend) {
      renderer?.resize(state.resolutionScale);
    }
  };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);
  }

  const initResult = await switchBackend(activeBackend, { isInitial: true, persist: false });
  if (!initResult.backend) {
    return;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;

    if (e.key >= '1' && e.key <= '6') {
      const idx = Number(e.key) - 1;
      if (PRESETS[idx]) {
        e.preventDefault();
        selectPreset(PRESETS[idx].id, { instant: false });
      }
      return;
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        handleAction('togglePause');
        break;
      case 'KeyH':
        e.preventDefault();
        handleAction('toggleHud');
        break;
      case 'KeyO':
        e.preventDefault();
        handleAction('toggleAutoOrbit');
        break;
      case 'KeyT':
        e.preventDefault();
        handleAction('toggleCameraMode');
        break;
      case 'KeyP':
        e.preventDefault();
        handleAction('screenshot');
        break;
      case 'KeyR':
        e.preventDefault();
        handleAction('resetCamera');
        break;
      default:
        break;
    }
  });

  window.__WARP_DRIVE__ = {
    get backend() {
      return activeBackend;
    },
    presets: PRESETS,

    getBackend() {
      return activeBackend;
    },

    async setBackend(nextBackend) {
      return switchBackend(nextBackend, { isInitial: false, persist: true });
    },

    getState() {
      return {
        ...state,
        backend: activeBackend,
        skyRotation: [...state.skyRotation],
        camera: camera ? camera.getState() : null,
      };
    },

    setState(patch = {}) {
      if (!patch || typeof patch !== 'object') return this.getState();
      let cameraUpdated = false;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'camera' || k === 'cameraMode') continue;
        applyParamChange(k, v, { syncUi: true });
      }
      if ('cameraMode' in patch && patch.cameraMode !== undefined) {
        const nextMode = Number(patch.cameraMode) === 1 ? 1 : 0;
        state.cameraMode = nextMode;
        camera?.setCameraMode(nextMode, true);
        cameraUpdated = true;
      }
      if (patch.camera && typeof patch.camera === 'object') {
        const camPatch =
          'cameraMode' in patch && patch.cameraMode !== undefined && patch.camera.cameraMode === undefined
            ? { ...patch.camera, cameraMode: state.cameraMode }
            : patch.camera;
        camera?.setImmediate(camPatch);
        if (typeof camPatch.cameraMode === 'number') {
          state.cameraMode = Number(camPatch.cameraMode) === 1 ? 1 : 0;
        }
        cameraUpdated = true;
      }
      if (cameraUpdated) {
        const camMatrices = camera?.getCameraMatrices();
        if (camMatrices && typeof camMatrices.frameBlend === 'number') {
          lastFrameBlend = camMatrices.frameBlend;
        }
        hud?.syncState({ cameraMode: state.cameraMode });
      }
      if (renderer && camera && !switchingBackend) {
        if (cameraUpdated) {
          renderer.resetAccumulation(true);
        }
        renderer.render(state, camera.getCameraMatrices(), simTime, {
          forceComposite: true,
          dt: 0,
        });
        hud.updateTelemetry(buildTelemetry());
      }
      return this.getState();
    },

    selectPreset(id, instant = true) {
      return selectPreset(id, { instant: Boolean(instant) });
    },

    setCamera(camPatch = {}) {
      camera?.setImmediate(camPatch);
      if (camera) {
        const camState = camera.getState();
        if (typeof camState.cameraMode === 'number') {
          state.cameraMode = Number(camState.cameraMode) === 1 ? 1 : 0;
          hud?.syncState({ cameraMode: state.cameraMode });
        }
        if (typeof camState.frameBlend === 'number') {
          lastFrameBlend = camState.frameBlend;
        }
      }
      if (renderer && camera && !switchingBackend) {
        renderer.resetAccumulation(true);
        renderer.render(state, camera.getCameraMatrices(), simTime, {
          forceComposite: true,
          dt: 0,
        });
        hud.updateTelemetry(buildTelemetry());
      }
      return camera ? camera.getState() : null;
    },

    toggleCameraMode(instant = true) {
      const snap = Boolean(instant);
      const nextMode = camera
        ? camera.toggleCameraMode(snap)
        : state.cameraMode === 1
          ? 0
          : 1;
      state.cameraMode = Number(nextMode) === 1 ? 1 : 0;
      hud?.syncState({ cameraMode: state.cameraMode });
      if (renderer && camera && !switchingBackend) {
        renderer.resetAccumulation(true);
        const camMatrices = camera.getCameraMatrices();
        lastFrameBlend = camMatrices.frameBlend ?? (state.cameraMode === 1 ? 1.0 : 0.0);
        if (snap) {
          renderer.render(state, camMatrices, simTime, {
            forceComposite: true,
            dt: 0,
          });
        }
      }
      hud?.updateTelemetry(buildTelemetry());
      return state.cameraMode;
    },

    toggleHud(visible) {
      return hud.toggleHud(visible);
    },

    renderNow() {
      if (!renderer || !camera || switchingBackend) return;
      renderer.render(state, camera.getCameraMatrices(), simTime, {
        forceComposite: true,
        dt: 0,
      });
      hud.updateTelemetry(buildTelemetry());
    },

    capturePNG() {
      if (!renderer || !camera || switchingBackend) {
        return Promise.reject(new Error('Renderer is currently unavailable.'));
      }
      return renderer.capturePNG(state, camera.getCameraMatrices(), simTime);
    },

    waitForSky() {
      return skyLoadPromise;
    },

    getTelemetry() {
      return buildTelemetry();
    },

    getDiagnostics() {
      return {
        backend: activeBackend,
        availableBackends: {
          webgl2: typeof window !== 'undefined' && Boolean(window.WebGL2RenderingContext),
          webgpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
        },
        switchingBackend,
        shaderStatus: renderer ? { ...renderer.shaderStatus } : {},
        allShadersCompiled: renderer ? renderer.getAllShadersCompiled() : false,
        webglRenderer: renderer ? renderer.rendererName : 'Unavailable',
        gpuRenderer: renderer ? renderer.rendererName : 'Unavailable',
        adapterInfo: renderer?.adapterInfo ? { ...renderer.adapterInfo } : null,
        canvasFormat: renderer?.canvasFormat || 'default',
        hdrFormat: renderer ? renderer.hdrFormat : 'Unavailable',
        volumeBaked: renderer ? renderer.volumeBaked : false,
        skyMapLoaded: renderer ? renderer.skyMapLoaded : false,
        skyDimensions: renderer ? [...renderer.skyDimensions] : [0, 0],
        resolution: renderer ? [renderer.width, renderer.height] : [0, 0],
        dpr: renderer ? renderer.dpr : 1,
        fps: Math.round(fpsSmoothed * 10) / 10,
        samples: renderer ? renderer.sampleCount : 0,
        cameraMode: state.cameraMode,
        paused: state.paused,
        activePreset: state.presetId,
        runtimeErrors: [...runtimeErrors],
        errors: [...runtimeErrors, ...(renderer?.errors || [])],
      };
    },
  };

  function frame(now) {
    const rawDt = (now - lastFrameTime) * 0.001;
    lastFrameTime = now;

    if (switchingBackend || !renderer || !camera) {
      requestAnimationFrame(frame);
      return;
    }

    if (contextLost) {
      requestAnimationFrame(frame);
      return;
    }

    const dt = Math.min(Math.max(rawDt, 0), 0.05);
    if (!state.paused) {
      simTime += dt;
    }

    camera.update(dt, state.paused ? false : state.autoOrbit);
    const camData = camera.getCameraMatrices();
    const blendChanged = Math.abs((camData.frameBlend ?? 0) - lastFrameBlend) > 1e-6;
    if (blendChanged) {
      lastFrameBlend = camData.frameBlend ?? 0;
      renderer.resetAccumulation(true);
    }

    const submitted = Boolean(
      renderer.render(state, camData, simTime, {
        forceComposite: blendChanged,
        dt: state.paused ? 0 : dt,
      })
    );

    if (submitted) {
      lastSubmitTime = now;
      frameTimestamps.push(now);
      const cutoff = now - 750;
      while (frameTimestamps.length > 2 && frameTimestamps[0] < cutoff) {
        frameTimestamps.shift();
      }
      if (frameTimestamps.length >= 2) {
        const spanSec = (now - frameTimestamps[0]) / 1000;
        if (spanSec >= 0.15) {
          const measuredFps = (frameTimestamps.length - 1) / spanSec;
          fpsSmoothed = fpsInitialized ? fpsSmoothed * 0.7 + measuredFps * 0.3 : measuredFps;
          fpsInitialized = true;
        }
      }
    } else if (lastSubmitTime > 0 && now - lastSubmitTime > 1000) {
      if (state.paused && renderer.sampleCount >= 128) {
        fpsSmoothed = 0;
        fpsInitialized = false;
        frameTimestamps.length = 0;
      } else if (frameTimestamps.length >= 1) {
        const spanSec = Math.max((now - frameTimestamps[0]) / 1000, 1.0);
        const liveRate = frameTimestamps.length / spanSec;
        fpsSmoothed = fpsSmoothed * 0.7 + liveRate * 0.3;
      }
    }

    if (now - lastTelemetryPush >= TELEMETRY_INTERVAL_MS) {
      lastTelemetryPush = now;
      hud.updateTelemetry(buildTelemetry());
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
