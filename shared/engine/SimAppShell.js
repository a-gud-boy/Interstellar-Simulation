/**
 * SimAppShell.js — Unified WebGL2 + WebGPU application shell shared by all 9
 * Interstellar Simulation `src/main.js` entrypoints:
 *  - Backend resolution (?backend= / localStorage / default webgl2) & live switcher
 *  - Serialized switch queue with WebGPU <-> WebGL2 fallback and canvas replacement
 *  - 750ms sliding-window FPS smoother, 85ms telemetry timer, ResizeObserver
 *  - Standard keyboard shortcuts (1-6, Space, H, O, P, R) + custom key/action hooks
 *  - PNG capture + programmatic inspection API
 */

import { loadSkyTextureWebGL, loadSkyTextureWebGPU } from '../assets/skyLoader.js';
import { mountSimSwitcher } from '../ui/simSwitcher.js';
import { createPhysicsTour } from '../ui/physicsTour.js';
import { createGpuProfilerOverlay } from '../ui/gpuProfilerOverlay.js';
import { createHelpMenu } from '../ui/helpMenu.js';
import { createSonificationEngine } from './sonification.js';
import { registerObservatorySw } from './pwaRegister.js';
import { buildShareableUrl, parseUrlState } from './urlState.js';
import {
  DPR_CAP_OPTIONS,
  GRAPHICS_PROFILES,
  clampDprCap,
  inferQualityProfile,
  loadGraphicsPrefs,
  saveGraphicsPrefs,
} from './graphicsProfile.js';
import {
  RECORDER_DURATIONS,
  RECORDER_FPS_OPTIONS,
  RECORDER_FORMATS,
  RECORDER_MODES,
  createCinemaRecorder,
} from './cinemaRecorder.js';

const DEFAULT_POST_ONLY_KEYS = new Set(['exposure', 'bloomIntensity', 'anamorphicIntensity']);
const TELEMETRY_INTERVAL_MS = 85;
const VALID_BACKENDS = new Set(['webgl2', 'webgpu']);
const FPS_RING_SIZE = 128;

export function normalizeBackend(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'webgl') return 'webgl2';
  return VALID_BACKENDS.has(v) ? v : null;
}

export function resolveInitialBackend(storageKey) {
  try {
    const queryBackend = normalizeBackend(new URLSearchParams(window.location.search).get('backend'));
    if (queryBackend) return queryBackend;
  } catch {
    // Ignore URL parsing issues
  }

  if (storageKey) {
    try {
      const stored = normalizeBackend(window.localStorage?.getItem(storageKey));
      if (stored) return stored;
    } catch {
      // Ignore restricted localStorage
    }
  }

  return 'webgl2';
}

export function backendLabel(backend) {
  return backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
}

export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function getCameraMatricesCompat(cam) {
  if (!cam) return null;
  if (typeof cam.getCameraMatrices === 'function') return cam.getCameraMatrices();
  if (typeof cam.getMatrices === 'function') return cam.getMatrices();
  return null;
}

function setCameraCanvasCompat(cam, nextCanvas) {
  if (!cam) return;
  if (typeof cam.setCanvas === 'function') {
    cam.setCanvas(nextCanvas);
    return;
  }
  cam.detachEvents?.();
  cam.canvas = nextCanvas;
  cam.attachEvents?.(nextCanvas);
}

export function applyCameraPoseCompat(cam, camPatch, duration = 0) {
  if (!cam || !camPatch) return;
  if (!duration || duration <= 0) {
    if (typeof cam.setImmediate === 'function') cam.setImmediate(camPatch);
    else if (typeof cam.setState === 'function') cam.setState(camPatch);
    else if (typeof cam.applyPreset === 'function') cam.applyPreset(camPatch, 0);
    else if (typeof cam.flyTo === 'function') cam.flyTo(camPatch, 0);
    return;
  }
  if (typeof cam.flyTo === 'function') cam.flyTo(camPatch, duration);
  else if (typeof cam.applyPreset === 'function') cam.applyPreset(camPatch, duration);
  else if (typeof cam.setState === 'function') cam.setState(camPatch);
}

export function resetRendererAccumulationCompat(targetRenderer, hard = true) {
  if (!targetRenderer) return;
  if (typeof targetRenderer.resetAccumulation === 'function') {
    targetRenderer.resetAccumulation(hard);
  } else if (typeof targetRenderer.markReset === 'function') {
    targetRenderer.markReset(hard);
  }
}

function defaultDisposeOrphanedSky(targetBackend, targetRenderer, result) {
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

/**
 * Bootstraps a simulator with unified dual-backend rendering, switcher, loop, and API.
 */
export async function createSimApp(config) {
  const {
    simId,
    logPrefix = `[${simId}]`,
    canvasId,
    canvasAriaLabel = 'Interactive relativistic simulation',
    storageKey,
    screenshotPrefix = simId,
    presets,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    createCamera,
    buildTelemetry,
    postOnlyKeys = DEFAULT_POST_ONLY_KEYS,
    loadingMessages = {
      webgpu: 'Initializing WebGPU & baking 3D volume…',
      webgl2: 'Compiling relativistic ray-tracer…',
    },
    presetFlightSec = 1.2,
    initState = null,
    attachSky = null,
    onParamChange = null,
    onPresetBeforeParams = null,
    onPresetSelect = null,
    renderFrame = null,
    onTick = null,
    updateCamera = null,
    onExtraAction = null,
    onKeyDown = null,
    onAfterSwitch = null,
    setStateCustom = null,
    getStateExtra = null,
    getDiagnosticsExtra = null,
    extraApi = null,
    onReady = null,
    sonification = null,
  } = config;

  let canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.error(`${logPrefix} Missing <canvas id="${canvasId}"> element.`);
    return null;
  }

  const canvasFallbackText = canvas.textContent;
  const baseDefaults = createInitialState();
  const state = createInitialState();
  if (typeof initState === 'function') initState(state);

  const urlState =
    typeof window !== 'undefined'
      ? parseUrlState(window.location?.search, window.location?.hash)
      : { hasState: false, backend: null, presetId: null, tour: null, camera: null, params: null };
  const graphicsPrefs = loadGraphicsPrefs();

  let activeBackend = urlState.backend || resolveInitialBackend(storageKey);
  state.backend = activeBackend;

  const simSwitcher = mountSimSwitcher({
    currentSimId: simId,
    initialBackend: activeBackend,
  });
  registerObservatorySw();

  const initialPreset =
    (urlState.presetId && getPresetById(urlState.presetId)) ||
    getPresetById(state.presetId) ||
    presets[0];

  if (graphicsPrefs.hasStoredPrefs) {
    if (graphicsPrefs.resolutionScale !== null && 'resolutionScale' in state) {
      state.resolutionScale = graphicsPrefs.resolutionScale;
    }
    if (graphicsPrefs.quality !== null && 'quality' in state) {
      state.quality = graphicsPrefs.quality;
    }
  }

  let renderer = null;
  let camera = null;
  let hud = null;
  let resizeObserver = null;

  let simTime = 0;
  let fpsSmoothed = 0;
  let fpsInitialized = false;
  const fpsRing = new Float64Array(FPS_RING_SIZE);
  let fpsHead = 0;
  let fpsCount = 0;
  let lastFrameTime = performance.now();
  let lastSubmitTime = 0;
  let lastTelemetryPush = 0;
  let skyLoadPromise = Promise.resolve(null);
  let contextLost = false;
  let switchingBackend = false;
  let switchTail = Promise.resolve();
  let rendererGeneration = 0;
  let canvasTouched = false;
  let dprCap = clampDprCap(graphicsPrefs.dprCap, 1.5);
  let interactiveDragScale = Boolean(graphicsPrefs.interactiveDragScale);
  let reducedGlass = Boolean(graphicsPrefs.reducedGlass);
  let qualityProfile =
    graphicsPrefs.profileId ||
    inferQualityProfile({
      quality: state.quality ?? 1,
      resolutionScale: state.resolutionScale ?? 1.0,
      dprCap,
    });
  let isPointerDragging = false;
  let perfDragCheckbox = null;
  let perfGlassCheckbox = null;
  let profileControlBinding = null;
  let dprControlBinding = null;
  let tourBtn = null;
  let drawerTourBtn = null;
  let recBtn = null;
  let drawerRecBtn = null;
  let recStatusEl = null;
  let recPillEl = null;
  let recPillTextEl = null;
  let audioBtn = null;
  let drawerAudioBtn = null;
  let audioStatusEl = null;
  let toastEl = null;
  let toastTimer = null;
  const frameRenderOpts = { dt: 0, effectiveResolutionScale: 1.0 };
  const runtimeErrors = [];

  if (typeof document !== 'undefined') {
    document.body?.classList.toggle('reduced-glass', reducedGlass);
  }

  function showToast(msg, durationMs = 2800) {
    if (typeof document === 'undefined') return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'obs-toast';
      toastEl.className = 'obs-toast glass-surface';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      toastEl.hidden = true;
      document.getElementById('hud-chrome')?.appendChild(toastEl) || document.body?.appendChild(toastEl);
    }
    toastEl.textContent = String(msg);
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.hidden = true;
    }, durationMs);
  }

  function persistGraphics({ profileOverride = null } = {}) {
    qualityProfile =
      profileOverride ||
      inferQualityProfile({
        quality: state.quality ?? 1,
        resolutionScale: state.resolutionScale ?? 1.0,
        dprCap,
      });
    saveGraphicsPrefs({
      profileId: qualityProfile,
      quality: typeof state.quality === 'number' ? state.quality : null,
      resolutionScale: typeof state.resolutionScale === 'number' ? state.resolutionScale : null,
      dprCap,
      interactiveDragScale,
      reducedGlass,
    });
    profileControlBinding?.set(qualityProfile);
    dprControlBinding?.set(dprCap);
  }

  function setInteractiveDragScale(enabled, { persist = true, syncUi = true } = {}) {
    interactiveDragScale = Boolean(enabled);
    if (persist) persistGraphics();
    if (syncUi && perfDragCheckbox) perfDragCheckbox.checked = interactiveDragScale;
    if (!interactiveDragScale && renderer && !switchingBackend) {
      renderer.resize(state.resolutionScale, dprCap);
    }
    return interactiveDragScale;
  }

  function setReducedGlass(enabled, { persist = true, syncUi = true } = {}) {
    reducedGlass = Boolean(enabled);
    if (typeof document !== 'undefined') {
      document.body?.classList.toggle('reduced-glass', reducedGlass);
    }
    if (persist) persistGraphics();
    if (syncUi && perfGlassCheckbox) perfGlassCheckbox.checked = reducedGlass;
    return reducedGlass;
  }

  function setDprCap(nextCap, { persist = true } = {}) {
    dprCap = clampDprCap(nextCap, 1.5);
    if (renderer && !switchingBackend) {
      renderer.resize(state.resolutionScale, dprCap);
      if (state.paused && camera) {
        ctx.renderImmediate({ dt: 0, isMotion: false });
      }
      ctx.pushTelemetry();
    }
    if (persist) persistGraphics();
    else dprControlBinding?.set(dprCap);
    return dprCap;
  }

  function setQualityProfile(profileId, { persist = true } = {}) {
    const profile = GRAPHICS_PROFILES[String(profileId || '').toLowerCase()];
    if (!profile) return null;
    dprCap = profile.dprCap;
    setInteractiveDragScale(profile.interactiveDragScale, { persist: false, syncUi: true });
    setReducedGlass(profile.reducedGlass, { persist: false, syncUi: true });
    if ('quality' in state) {
      state.quality = profile.quality;
      hud?.syncState({ quality: state.quality });
    }
    if ('resolutionScale' in state) {
      state.resolutionScale = profile.resolutionScale;
      hud?.syncState({ resolutionScale: state.resolutionScale });
    }
    if (renderer && !switchingBackend) {
      renderer.resize(state.resolutionScale, dprCap);
      resetRendererAccumulationCompat(renderer, true);
      if (state.paused && camera) {
        ctx.renderImmediate({ dt: 0, isMotion: false });
      }
      ctx.pushTelemetry();
    }
    if (persist) persistGraphics({ profileOverride: profile.id });
    else {
      qualityProfile = profile.id;
      profileControlBinding?.set(profile.id);
      dprControlBinding?.set(dprCap);
    }
    showToast(`Graphics profile: ${profile.label}`);
    return profile.id;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pointerdown',
      (ev) => {
        if (ev.target === canvas) {
          isPointerDragging = true;
        }
      },
      { passive: true }
    );
    const endPointerDrag = () => {
      if (isPointerDragging) {
        isPointerDragging = false;
      }
    };
    window.addEventListener('pointerup', endPointerDrag, { passive: true });
    window.addEventListener('pointercancel', endPointerDrag, { passive: true });
    window.addEventListener('blur', endPointerDrag, { passive: true });
  }

  window.addEventListener('error', (ev) => {
    runtimeErrors.push(String(ev?.message || ev?.error || 'Window error'));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    runtimeErrors.push(String(ev?.reason?.message || ev?.reason || 'Unhandled rejection'));
  });

  const ctx = {
    get state() { return state; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    get hud() { return hud; },
    get canvas() { return canvas; },
    get activeBackend() { return activeBackend; },
    get switchingBackend() { return switchingBackend; },
    get simTime() { return simTime; },
    set simTime(v) { simTime = v; },
    get fpsSmoothed() { return fpsSmoothed; },
    get rendererGeneration() { return rendererGeneration; },
    get runtimeErrors() { return runtimeErrors; },
    buildTelemetry: () =>
      buildTelemetry({ state, camera, renderer, activeBackend, fpsSmoothed, simTime }),
    pushTelemetry: () => {
      hud?.updateTelemetry(ctx.buildTelemetry(), state);
    },
    renderImmediate: (options = {}) => {
      if (!renderer || !camera || switchingBackend) return;
      const camData = getCameraMatricesCompat(camera);
      const effScale = Number(options.effectiveResolutionScale ?? state.resolutionScale) || 1.0;
      const merged = { forceComposite: true, effectiveResolutionScale: effScale, ...options };
      if (typeof renderFrame === 'function') {
        renderFrame(renderer, state, camData, simTime, merged, ctx);
      } else {
        renderer.render(state, camData, simTime, merged);
      }
    },
    handleAction: (actionName, payload) => handleAction(actionName, payload),
  };

  function replaceCanvas() {
    isPointerDragging = false;
    if (resizeObserver && canvas) {
      resizeObserver.unobserve(canvas);
    }
    const nextCanvas = document.createElement('canvas');
    nextCanvas.id = canvasId;
    nextCanvas.className = canvas?.className || 'sim-canvas';
    nextCanvas.setAttribute(
      'aria-label',
      canvas?.getAttribute('aria-label') || canvasAriaLabel
    );
    nextCanvas.textContent = canvasFallbackText;
    canvas.replaceWith(nextCanvas);
    canvas = nextCanvas;
    if (resizeObserver) {
      resizeObserver.observe(canvas);
    }
    setCameraCanvasCompat(camera, canvas);
    return canvas;
  }

  function resetFpsTracker() {
    fpsHead = 0;
    fpsCount = 0;
    fpsSmoothed = 0;
    fpsInitialized = false;
    lastSubmitTime = 0;
  }

  function defaultAttachSky(targetBackend, targetRenderer, generation) {
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
          defaultDisposeOrphanedSky(targetBackend, targetRenderer, result);
          return null;
        }
        targetRenderer.setSkyTexture(result);
        hud.setSkyStatus(result?.isRealMap ? '4K Milky Way' : 'Procedural Sky');
        if (state.paused && camera && !targetRenderer._disposed) {
          ctx.renderImmediate({ dt: 0, isMotion: false });
        }
        return result;
      })
      .catch((err) => {
        if (generation === rendererGeneration && !targetRenderer._disposed) {
          console.warn(`${logPrefix} Async sky texture load failed:`, err);
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
      gpuRenderer.resize(state.resolutionScale, dprCap);
      return gpuRenderer;
    }

    const glRenderer = new WebGLRenderer(targetCanvas);
    targetCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (generation !== rendererGeneration || glRenderer._disposed) return;
      contextLost = true;
      targetCanvas.style.visibility = 'hidden';
      hud.setError?.(
        'WebGL2 GPU context was lost. Waiting for GPU recovery — reload the page or relaunch via ./launch.sh if this persists.'
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
    glRenderer.resize(state.resolutionScale, dprCap);
    return glRenderer;
  }

  function persistBackendChoice(backend) {
    if (storageKey) {
      try {
        window.localStorage?.setItem(storageKey, backend);
      } catch {
        // Ignore restricted storage
      }
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
    simSwitcher.syncBackend(activeBackend);
    helpMenu?.syncBackend(activeBackend);
    contextLost = false;
    resetFpsTracker();

    if (!camera) {
      camera = createCamera(canvas, initialPreset.camera, ctx);
    } else {
      setCameraCanvasCompat(camera, canvas);
    }

    renderer.resize(state.resolutionScale, dprCap);
    renderer.setProfilerEnabled?.(profilerOpen);
    ctx.renderImmediate({ dt: 0, isMotion: false });
    skyLoadPromise =
      typeof attachSky === 'function'
        ? attachSky(targetBackend, renderer, generation, ctx)
        : defaultAttachSky(targetBackend, renderer, generation);

    if (persist) {
      persistBackendChoice(targetBackend);
    }

    hud.setError?.(null);
    hud.setLoading?.(false);
    hud.setBackendState({ backend: activeBackend, busy: false, statusNote });
    ctx.pushTelemetry();
    onAfterSwitch?.(targetBackend, ctx);
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
        target === 'webgpu' ? loadingMessages.webgpu : loadingMessages.webgl2
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
      console.warn(`${logPrefix} ${backendLabel(target)} initialization failed, attempting fallback:`, err);

      const fallback = target === 'webgpu' ? 'webgl2' : 'webgpu';
      const fbGen = ++rendererGeneration;

      if (renderer) {
        try {
          renderer.dispose();
        } catch {
          // Ignore disposal errors
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
        console.error(`${logPrefix} Both backends failed:`, combined);
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
    if (key === 'interactiveDragScale') {
      setInteractiveDragScale(value, { persist: true, syncUi });
      return;
    }
    if (key === 'reducedGlass') {
      setReducedGlass(value, { persist: true, syncUi });
      return;
    }
    if (key === 'dprCap') {
      setDprCap(value, { persist: true });
      return;
    }
    if (key === 'qualityProfile') {
      setQualityProfile(value, { persist: true });
      return;
    }

    if (typeof onParamChange === 'function') {
      const handled = onParamChange(key, value, { syncUi }, ctx);
      if (handled === true) {
        if (key === 'resolutionScale') {
          renderer?.resize(state.resolutionScale, dprCap);
          persistGraphics();
        } else if (key === 'quality') {
          persistGraphics();
        }
        return;
      }
    }

    if (!(key in state) && key !== 'skyRotation' && key !== 'skyRotationA' && key !== 'skyRotationB') {
      return;
    }

    if (
      (key === 'skyRotation' || key === 'skyRotationA' || key === 'skyRotationB') &&
      Array.isArray(value)
    ) {
      state[key] = [Number(value[0]) || 0, Number(value[1]) || 0];
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
        renderer.resize(state.resolutionScale, dprCap);
      } else if (postOnlyKeys.has(key)) {
        renderer.markPostDirty?.();
      } else if (key !== 'paused' && key !== 'autoOrbit') {
        resetRendererAccumulationCompat(renderer, true);
      }
    }

    if (key === 'resolutionScale' || key === 'quality') {
      persistGraphics();
    }

    if (syncUi && hud) {
      hud.syncState({ [key]: state[key] });
    }
  }

  function selectPreset(presetId, { instant = false, preserveDisplayPrefs = false } = {}) {
    const preset = getPresetById(presetId);
    if (!preset) return false;

    const prevQuality = state.quality;
    const prevResScale = state.resolutionScale;
    state.presetId = preset.id;
    onPresetBeforeParams?.(preset, { instant }, ctx);

    for (const [k, v] of Object.entries(preset.params)) {
      if (
        (k === 'skyRotation' || k === 'skyRotationA' || k === 'skyRotationB') &&
        Array.isArray(v)
      ) {
        state[k] = [...v];
      } else {
        state[k] = v;
      }
    }

    if (preserveDisplayPrefs) {
      if (typeof prevQuality === 'number') state.quality = prevQuality;
      if (typeof prevResScale === 'number') state.resolutionScale = prevResScale;
    }

    if (typeof preset.camera?.autoOrbit === 'boolean') {
      state.autoOrbit = preset.camera.autoOrbit;
    }

    const handledCam = onPresetSelect?.(preset, { instant }, ctx);
    if (handledCam !== true && camera) {
      applyCameraPoseCompat(camera, preset.camera, instant ? 0 : presetFlightSec);
    }

    renderer?.resize(state.resolutionScale, dprCap);
    resetRendererAccumulationCompat(renderer, true);
    physicsTour.setPreset(preset.id);
    helpMenu?.syncPreset(preset.id);

    if (hud) {
      hud.syncState(state);
      hud.setActivePreset(preset.id);
    }

    if (instant && renderer && camera && !switchingBackend) {
      ctx.renderImmediate({ dt: 0, isMotion: false });
      ctx.pushTelemetry();
    }

    return true;
  }

  async function handleScreenshot() {
    if (!renderer || !camera || switchingBackend) return;
    try {
      const blob = await renderer.capturePNG(state, getCameraMatricesCompat(camera), simTime);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(blob, `${screenshotPrefix}-${activeBackend}-${state.presetId}-${stamp}.png`);
    } catch (err) {
      console.error(`${logPrefix} Screenshot failed:`, err);
      runtimeErrors.push(String(err?.message || err));
    }
  }

  let physicsTour = null;
  let helpMenu = null;
  let profilerOpen = false;
  let perfProfilerCheckbox = null;
  const profilerOverlay = createGpuProfilerOverlay(document.body);
  profilerOverlay.onClose(() => {
    profilerOpen = false;
    if (perfProfilerCheckbox) perfProfilerCheckbox.checked = false;
    renderer?.setProfilerEnabled?.(false);
  });

  function toggleProfiler(forceVisible) {
    profilerOpen = typeof forceVisible === 'boolean' ? forceVisible : !profilerOpen;
    if (perfProfilerCheckbox) perfProfilerCheckbox.checked = profilerOpen;
    profilerOverlay.setVisible(profilerOpen);
    renderer?.setProfilerEnabled?.(profilerOpen);
    if (profilerOpen && renderer?.getProfilerMetrics) {
      profilerOverlay.update(renderer.getProfilerMetrics());
    }
    return profilerOpen;
  }

  const audioEngine = sonification
    ? createSonificationEngine({
        simId,
        onStateChange: (audioState) => syncAudioUi(audioState),
      })
    : null;

  function syncAudioUi(audioState) {
    const active = Boolean(audioState?.enabled);
    if (audioBtn) {
      audioBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (drawerAudioBtn) {
      drawerAudioBtn.classList.toggle('is-active', active);
      drawerAudioBtn.textContent = active ? 'Mute Audio (M)' : 'Enable Audio (M)';
    }
    if (audioStatusEl) {
      audioStatusEl.textContent = active
        ? audioState.readout || `${sonification?.label || 'Sonification'} active`
        : `${sonification?.label || 'Sonification'} muted`;
    }
  }

  function syncTourUi(isOpen) {
    if (tourBtn) tourBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    if (drawerTourBtn) {
      drawerTourBtn.classList.toggle('is-active', isOpen);
      drawerTourBtn.textContent = isOpen ? 'Hide Physics Tour (I)' : 'Physics Tour (I)';
    }
  }

  function syncRecorderUi(recState) {
    const isRec = Boolean(recState?.active);
    if (recBtn) {
      recBtn.classList.toggle('is-recording', isRec);
      recBtn.setAttribute('aria-pressed', isRec ? 'true' : 'false');
    }
    if (drawerRecBtn) {
      drawerRecBtn.classList.toggle('is-recording', isRec);
      drawerRecBtn.textContent = isRec ? 'Stop Recording (V)' : 'Start Recording (V)';
    }
    if (recStatusEl) {
      recStatusEl.textContent = isRec
        ? recState.format === 'frames'
          ? `Rendering frame ${recState.frameIndex}/${recState.totalFrames}…`
          : `Recording ${recState.elapsedSec.toFixed(1)}s / ${recState.durationSec}s (${recState.mode})…`
        : `${recState.evolutionLabel} ready`;
    }
    if (recPillEl && recPillTextEl) {
      recPillEl.hidden = !isRec;
      if (isRec) {
        recPillTextEl.textContent =
          recState.format === 'frames'
            ? `REC PNG ${recState.frameIndex}/${recState.totalFrames}`
            : `REC ${recState.elapsedSec.toFixed(1)}s / ${recState.durationSec}s`;
      }
    }
  }

  function getShareUrl(opts = {}) {
    if (typeof window === 'undefined') return '';
    const activePreset = getPresetById(state.presetId);
    const baseParams = activePreset ? { ...baseDefaults, ...activePreset.params } : baseDefaults;
    return buildShareableUrl(window.location.href, {
      backend: activeBackend,
      presetId: state.presetId || null,
      cameraState: camera ? camera.getState() : null,
      state,
      baseParams,
      tourOpen: Boolean(opts.includeTour ?? physicsTour?.isOpen?.()),
    });
  }

  async function copyShareUrl() {
    const shareUrl = getShareUrl();
    if (!shareUrl) return '';
    try {
      window.history?.replaceState?.(null, '', shareUrl);
    } catch {
      // Ignore history API limits
    }
    try {
      await navigator.clipboard?.writeText?.(shareUrl);
      showToast('Shareable state URL copied to clipboard');
    } catch {
      showToast('URL updated in address bar');
    }
    return shareUrl;
  }

  const cinemaRecorder = createCinemaRecorder({
    simId,
    screenshotPrefix,
    getCanvas: () => canvas,
    getState: () => state,
    getCamera: () => camera,
    getRenderer: () => renderer,
    getBackend: () => activeBackend,
    getSimTime: () => simTime,
    setSimTime: (v) => {
      simTime = v;
    },
    stepSimulation: (dt) => {
      if (typeof onTick === 'function') {
        onTick(dt, ctx);
      } else if (!state.paused) {
        simTime += dt;
      }
      if (typeof updateCamera === 'function') {
        updateCamera(camera, dt, state, ctx);
      } else {
        camera?.update(dt, { paused: state.paused, autoOrbit: state.autoOrbit });
      }
    },
    renderImmediate: (opts) => ctx.renderImmediate(opts),
    handleAction: (name, p) => handleAction(name, p),
    applyParamChange: (k, v, o) => applyParamChange(k, v, o),
    downloadBlob,
    onStateChange: syncRecorderUi,
    onToast: (msg) => showToast(msg),
  });

  function handleAction(actionName, payload) {
    if (typeof onExtraAction === 'function') {
      const handled = onExtraAction(actionName, payload, ctx);
      if (handled === true) return;
    }

    switch (actionName) {
      case 'togglePause':
        state.paused = !state.paused;
        hud?.syncState({ paused: state.paused });
        break;

      case 'toggleAutoOrbit':
        state.autoOrbit = !state.autoOrbit;
        hud?.syncState({ autoOrbit: state.autoOrbit });
        break;

      case 'resetCamera': {
        const active = getPresetById(state.presetId) || presets[0];
        applyCameraPoseCompat(camera, active.camera, 1.0);
        break;
      }

      case 'screenshot':
        handleScreenshot();
        break;

      case 'toggleHud': {
        const hudVisible = hud?.toggleHud();
        if (typeof hudVisible === 'boolean') {
          const isHidden = !hudVisible;
          profilerOverlay.setHudHidden(isHidden);
          if (isHidden) {
            helpMenu?.close({ returnFocus: false });
          }
        }
        break;
      }

      case 'toggleHelp':
        helpMenu?.toggle(typeof payload === 'boolean' ? payload : undefined);
        break;

      case 'toggleControls': {
        const drawer = document.getElementById('controls-drawer');
        if (drawer?.classList.contains('is-open')) {
          document.getElementById('controls-close')?.click();
        } else {
          document.getElementById('controls-toggle')?.click();
        }
        break;
      }

      case 'toggleProfiler':
        toggleProfiler(typeof payload === 'boolean' ? payload : undefined);
        break;

      case 'togglePhysicsTour':
        physicsTour?.toggle(typeof payload === 'boolean' ? payload : undefined);
        break;

      case 'stepPhysicsTour':
        physicsTour?.step(Number(payload) || 1);
        break;

      case 'toggleRecording':
        if (cinemaRecorder.isRecording()) {
          cinemaRecorder.stop();
        } else {
          void cinemaRecorder.start(payload && typeof payload === 'object' ? payload : {});
        }
        break;

      case 'copyShareUrl':
        void copyShareUrl();
        break;

      case 'toggleAudio':
        if (audioEngine) {
          const nextAudio = audioEngine.toggle(
            typeof payload === 'boolean' ? payload : undefined
          );
          if (nextAudio) {
            const audioPayload = sonification?.getFramePayload?.(ctx) || { state };
            audioEngine.update(audioPayload);
          }
          showToast(
            nextAudio
              ? `${sonification?.label || 'Sonification'} enabled`
              : `${sonification?.label || 'Sonification'} muted`
          );
        }
        break;

      default:
        break;
    }
  }

  hud = createHUD({
    state,
    presets,
    onParamChange: (key, value) => applyParamChange(key, value, { syncUi: false }),
    onPresetSelect: (presetId) => selectPreset(presetId, { instant: false }),
    onAction: handleAction,
  });

  physicsTour = createPhysicsTour({
    simId,
    getPresetId: () => state.presetId || initialPreset.id,
    getTelemetrySummary: () => {
      const t = ctx.buildTelemetry?.();
      if (!t) return '';
      const fpsStr = Number.isFinite(t.fps) ? `${Math.round(t.fps)} FPS` : '';
      return [backendLabel(activeBackend), fpsStr].filter(Boolean).join(' · ');
    },
    onOpenChange: (isOpen) => syncTourUi(isOpen),
  });

  helpMenu = createHelpMenu({
    simId,
    presets,
    getActivePresetId: () => state.presetId || initialPreset.id,
    getBackend: () => activeBackend,
    hasAudio: Boolean(audioEngine),
    audioLabel: sonification?.label || '',
    onSelectPreset: (presetId) => selectPreset(presetId, { instant: false }),
    onAction: handleAction,
    onOpenChange: (isOpen) => {
      if (isOpen) {
        const drawer = document.getElementById('controls-drawer');
        if (drawer?.classList.contains('is-open')) {
          document.getElementById('controls-close')?.click();
        }
        simSwitcher.close?.();
        const hudChromeEl = document.getElementById('hud-chrome');
        if (hudChromeEl?.classList.contains('is-hud-hidden')) {
          const hudVisible = hud?.toggleHud(true);
          if (typeof hudVisible === 'boolean') {
            profilerOverlay.setHudHidden(!hudVisible);
          }
        }
      }
    },
  });

  if (typeof document !== 'undefined') {
    document.getElementById('controls-toggle')?.addEventListener('click', () => {
      if (helpMenu?.isOpen()) helpMenu.close({ returnFocus: false });
    });
    simSwitcher.trigger?.addEventListener('click', () => {
      if (simSwitcher.isOpen() && helpMenu?.isOpen()) {
        helpMenu.close({ returnFocus: false });
      }
    });
  }

  if (typeof document !== 'undefined') {
    const makeDrawerSegmented = (parent, id, labelText, options, initialVal, onSelect) => {
      const row = document.createElement('div');
      row.className = 'control-row';
      const labelId = `${id}-label`;
      const lbl = document.createElement('span');
      lbl.id = labelId;
      lbl.className = 'control-label';
      lbl.textContent = labelText;
      const group = document.createElement('div');
      group.id = id;
      group.className = 'segmented-group';
      group.style.setProperty('--seg-cols', String(options.length));
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', labelId);

      const buttons = [];
      const matches = (a, b) =>
        typeof a === 'number' ? Math.abs(a - Number(b)) < 1e-4 : String(a) === String(b);

      const syncVal = (val) => {
        for (const entry of buttons) {
          entry.btn.setAttribute('aria-checked', matches(entry.value, val) ? 'true' : 'false');
        }
      };

      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = `${id}-${opt.value}`;
        btn.className = 'segmented-btn';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          syncVal(opt.value);
          onSelect(opt.value);
        });
        buttons.push({ btn, value: opt.value });
        group.appendChild(btn);
      }

      syncVal(initialVal);
      row.append(lbl, group);
      parent.appendChild(row);
      return { set: syncVal };
    };

    const hudChromeEl = document.getElementById('hud-chrome');
    if (hudChromeEl && !document.getElementById('rec-indicator')) {
      recPillEl = document.createElement('div');
      recPillEl.id = 'rec-indicator';
      recPillEl.className = 'rec-indicator glass-surface';
      recPillEl.hidden = true;
      const dot = document.createElement('span');
      dot.className = 'rec-dot';
      dot.setAttribute('aria-hidden', 'true');
      recPillTextEl = document.createElement('span');
      recPillTextEl.className = 'tabular';
      recPillTextEl.textContent = 'REC';
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'rec-stop-btn';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => cinemaRecorder.stop());
      recPillEl.append(dot, recPillTextEl, stopBtn);
      hudChromeEl.appendChild(recPillEl);
    }

    const transportStrip = document.querySelector('.transport-strip');
    const screenshotBtn = document.getElementById('btn-screenshot');
    if (transportStrip && !document.getElementById('btn-physics-tour')) {
      const makeDockIconBtn = (id, label, tooltipText, svgPathMarkup, actionName) => {
        const wrap = document.createElement('div');
        wrap.className = 'tooltip-wrap';
        const btn = document.createElement('button');
        btn.id = id;
        btn.type = 'button';
        btn.className = 'transport-btn is-icon-only';
        btn.setAttribute('aria-label', tooltipText);
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = `<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${svgPathMarkup}</svg>`;
        btn.addEventListener('click', () => handleAction(actionName));
        const tip = document.createElement('span');
        tip.role = 'tooltip';
        tip.className = 'action-tooltip';
        tip.textContent = tooltipText;
        wrap.append(btn, tip);
        return { wrap, btn };
      };

      const tourDock = makeDockIconBtn(
        'btn-physics-tour',
        'Tour',
        'Interactive Physics Tour (I)',
        '<circle cx="10" cy="10" r="7.2" /><circle cx="10" cy="6.6" r="0.9" fill="currentColor" stroke="none" /><path d="M10 9.4v4.4" stroke-linecap="round" />',
        'togglePhysicsTour'
      );
      tourBtn = tourDock.btn;

      const recDock = makeDockIconBtn(
        'btn-cinema-record',
        'Rec',
        'Cinema Recorder WebM / PNG Zip (V)',
        '<rect x="3" y="5.5" width="9.8" height="9" rx="1.8" /><path d="M12.8 8.4l4.2-2.2v7.6l-4.2-2.2z" stroke-linejoin="round" />',
        'toggleRecording'
      );
      recBtn = recDock.btn;

      const shareDock = makeDockIconBtn(
        'btn-share-link',
        'Share',
        'Copy Shareable URL State (L)',
        '<path d="M8.5 11.5l3-3" stroke-linecap="round" /><path d="M7.2 8.2L5.6 9.8a3.2 3.2 0 1 0 4.5 4.5l1.6-1.6M12.8 11.8l1.6-1.6a3.2 3.2 0 0 0-4.5-4.5L8.3 7.3" stroke-linecap="round" />',
        'copyShareUrl'
      );

      let audioDock = null;
      if (audioEngine) {
        audioDock = makeDockIconBtn(
          'btn-audio-sonify',
          'Audio',
          `${sonification?.label || 'Audio Sonification'} (M)`,
          '<path d="M3.5 8.2h2.8l3.9-3.2v10l-3.9-3.2H3.5z" stroke-linejoin="round" /><path d="M13.2 7.3a3.8 3.8 0 0 1 0 5.4M15.4 5.2a6.8 6.8 0 0 1 0 9.6" stroke-linecap="round" />',
          'toggleAudio'
        );
        audioBtn = audioDock.btn;
      }

      const hideBtn = document.getElementById('btn-hide-hud');
      if (hideBtn && hideBtn.parentElement === transportStrip) {
        if (audioDock) transportStrip.insertBefore(audioDock.wrap, hideBtn);
        transportStrip.insertBefore(tourDock.wrap, hideBtn);
        transportStrip.insertBefore(recDock.wrap, hideBtn);
        transportStrip.insertBefore(shareDock.wrap, hideBtn);
      } else if (screenshotBtn && screenshotBtn.nextSibling) {
        if (audioDock) transportStrip.insertBefore(audioDock.wrap, screenshotBtn.nextSibling);
        transportStrip.insertBefore(tourDock.wrap, screenshotBtn.nextSibling);
        transportStrip.insertBefore(recDock.wrap, tourDock.wrap.nextSibling);
        transportStrip.insertBefore(shareDock.wrap, recDock.wrap.nextSibling);
      } else {
        if (audioDock) transportStrip.appendChild(audioDock.wrap);
        transportStrip.append(tourDock.wrap, recDock.wrap, shareDock.wrap);
      }
    }

    const sectionsEl = document.getElementById('controls-sections');
    if (sectionsEl && !document.getElementById('section-performance')) {
      const details = document.createElement('details');
      details.className = 'control-section';
      details.id = 'section-performance';
      const summary = document.createElement('summary');
      summary.textContent = 'Display & Performance';
      const body = document.createElement('div');
      body.className = 'section-body';

      profileControlBinding = makeDrawerSegmented(
        body,
        'ctrl-quality-profile',
        'Quality Profile',
        Object.values(GRAPHICS_PROFILES).map((p) => ({ value: p.id, label: p.label })),
        qualityProfile,
        (v) => setQualityProfile(v, { persist: true })
      );

      dprControlBinding = makeDrawerSegmented(
        body,
        'ctrl-dpr-cap',
        'DPR Cap',
        DPR_CAP_OPTIONS.map((v) => ({ value: v, label: `${v.toFixed(1)}×` })),
        dprCap,
        (v) => setDprCap(v, { persist: true })
      );

      const makeToggleRow = (id, labelText, initialChecked, onChange) => {
        const row = document.createElement('label');
        row.className = 'control-label-row';
        row.style.cursor = 'pointer';
        row.htmlFor = id;
        const span = document.createElement('span');
        span.className = 'control-label';
        span.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = initialChecked;
        input.style.accentColor = 'var(--accent)';
        input.style.cursor = 'pointer';
        input.addEventListener('change', () => onChange(input.checked));
        row.appendChild(span);
        row.appendChild(input);
        body.appendChild(row);
        return input;
      };

      perfDragCheckbox = makeToggleRow(
        'ctrl-drag-scale',
        '0.75× Scale While Dragging',
        interactiveDragScale,
        (v) => setInteractiveDragScale(v, { persist: true, syncUi: false })
      );
      perfGlassCheckbox = makeToggleRow(
        'ctrl-reduced-glass',
        'Reduced Glass (No Blur)',
        reducedGlass,
        (v) => setReducedGlass(v, { persist: true, syncUi: false })
      );
      perfProfilerCheckbox = makeToggleRow(
        'ctrl-gpu-profiler',
        'GPU Pass Profiler (G)',
        profilerOpen,
        (v) => toggleProfiler(v)
      );

      const actionRow = document.createElement('div');
      actionRow.className = 'drawer-action-row';
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.id = 'btn-drawer-share';
      shareBtn.className = 'drawer-action-btn';
      shareBtn.textContent = 'Copy URL (L)';
      shareBtn.addEventListener('click', () => handleAction('copyShareUrl'));

      drawerTourBtn = document.createElement('button');
      drawerTourBtn.type = 'button';
      drawerTourBtn.id = 'btn-drawer-tour';
      drawerTourBtn.className = 'drawer-action-btn';
      drawerTourBtn.textContent = 'Physics Tour (I)';
      drawerTourBtn.addEventListener('click', () => handleAction('togglePhysicsTour'));

      actionRow.append(shareBtn, drawerTourBtn);
      body.appendChild(actionRow);

      details.appendChild(summary);
      details.appendChild(body);
      sectionsEl.appendChild(details);
    }

    if (sectionsEl && !document.getElementById('section-cinema-recorder')) {
      const recDetails = document.createElement('details');
      recDetails.className = 'control-section';
      recDetails.id = 'section-cinema-recorder';
      const recSummary = document.createElement('summary');
      recSummary.textContent = 'Cinema Recorder';
      const recBody = document.createElement('div');
      recBody.className = 'section-body';

      const initialRec = cinemaRecorder.getState();
      makeDrawerSegmented(
        recBody,
        'ctrl-rec-mode',
        'Shot Mode',
        RECORDER_MODES.map((m) => ({ value: m.id, label: m.label })),
        initialRec.mode,
        (v) => cinemaRecorder.configure({ mode: v })
      );
      makeDrawerSegmented(
        recBody,
        'ctrl-rec-format',
        'Export Format',
        RECORDER_FORMATS.map((f) => ({ value: f.id, label: f.label })),
        initialRec.format,
        (v) => cinemaRecorder.configure({ format: v })
      );
      makeDrawerSegmented(
        recBody,
        'ctrl-rec-duration',
        'Duration',
        RECORDER_DURATIONS.map((d) => ({ value: d, label: `${d}s` })),
        initialRec.durationSec,
        (v) => cinemaRecorder.configure({ durationSec: v })
      );
      makeDrawerSegmented(
        recBody,
        'ctrl-rec-fps',
        'Frame Rate',
        RECORDER_FPS_OPTIONS.map((f) => ({ value: f, label: `${f} fps` })),
        initialRec.fps,
        (v) => cinemaRecorder.configure({ fps: v })
      );

      const recActRow = document.createElement('div');
      recActRow.className = 'drawer-action-row';
      drawerRecBtn = document.createElement('button');
      drawerRecBtn.type = 'button';
      drawerRecBtn.id = 'btn-drawer-record';
      drawerRecBtn.className = 'drawer-action-btn is-full';
      drawerRecBtn.textContent = 'Start Recording (V)';
      drawerRecBtn.addEventListener('click', () => handleAction('toggleRecording'));
      recActRow.appendChild(drawerRecBtn);
      recBody.appendChild(recActRow);

      recStatusEl = document.createElement('p');
      recStatusEl.id = 'rec-status-note';
      recStatusEl.className = 'control-status-note tabular';
      recStatusEl.textContent = `${initialRec.evolutionLabel} ready`;
      recBody.appendChild(recStatusEl);

      recDetails.append(recSummary, recBody);
      sectionsEl.appendChild(recDetails);
    }

    if (audioEngine && sectionsEl && !document.getElementById('section-sonification')) {
      const audDetails = document.createElement('details');
      audDetails.className = 'control-section';
      audDetails.id = 'section-sonification';
      const audSummary = document.createElement('summary');
      audSummary.textContent = sonification?.label || 'Audio Sonification';
      const audBody = document.createElement('div');
      audBody.className = 'section-body';

      const audActRow = document.createElement('div');
      audActRow.className = 'drawer-action-row';
      drawerAudioBtn = document.createElement('button');
      drawerAudioBtn.type = 'button';
      drawerAudioBtn.id = 'btn-drawer-audio';
      drawerAudioBtn.className = 'drawer-action-btn is-full';
      drawerAudioBtn.textContent = 'Enable Audio (M)';
      drawerAudioBtn.addEventListener('click', () => handleAction('toggleAudio'));
      audActRow.appendChild(drawerAudioBtn);
      audBody.appendChild(audActRow);

      const volRow = document.createElement('div');
      volRow.className = 'control-row';
      const volLabelRow = document.createElement('div');
      volLabelRow.className = 'control-label-row';
      const volLabel = document.createElement('label');
      volLabel.className = 'control-label';
      volLabel.htmlFor = 'ctrl-audio-volume';
      volLabel.textContent = 'Audio Volume';
      const volOut = document.createElement('output');
      volOut.className = 'control-value tabular';
      volOut.htmlFor = 'ctrl-audio-volume';
      const volSlider = document.createElement('input');
      volSlider.type = 'range';
      volSlider.id = 'ctrl-audio-volume';
      volSlider.className = 'hud-slider';
      volSlider.min = '0';
      volSlider.max = '1';
      volSlider.step = '0.01';
      const initVol = audioEngine.getState().volume;
      volSlider.value = String(initVol);
      const syncVolRange = (val) => {
        const pct = `${Math.round(Number(val) * 100)}%`;
        volSlider.style.setProperty('--attr-min', '0');
        volSlider.style.setProperty('--attr-max', '1');
        volSlider.style.setProperty('--control-value', String(val));
        volOut.textContent = pct;
      };
      syncVolRange(initVol);
      volSlider.addEventListener('input', () => {
        const v = audioEngine.setVolume(Number(volSlider.value));
        syncVolRange(v);
      });
      volLabelRow.append(volLabel, volOut);
      volRow.append(volLabelRow, volSlider);
      audBody.appendChild(volRow);

      audioStatusEl = document.createElement('p');
      audioStatusEl.id = 'audio-status-note';
      audioStatusEl.className = 'control-status-note tabular';
      audioStatusEl.textContent = `${sonification?.label || 'Sonification'} muted`;
      audBody.appendChild(audioStatusEl);

      audDetails.append(audSummary, audBody);
      sectionsEl.appendChild(audDetails);
    }
  }

  hud.setActivePreset(initialPreset.id);
  hud.setSkyStatus('Procedural Sky');

  const onResize = () => {
    if (!switchingBackend) {
      renderer?.resize(state.resolutionScale, dprCap);
    }
  };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);
  }

  const initResult = await switchBackend(activeBackend, { isInitial: true, persist: false });
  if (!initResult.backend) {
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;

    if (e.key === '?' || e.code === 'F1') {
      e.preventDefault();
      handleAction('toggleHelp');
      return;
    }

    if (e.key === 'Escape' && helpMenu?.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      helpMenu.close({ returnFocus: true });
      return;
    }

    if (e.key >= '1' && e.key <= '6') {
      const idx = Number(e.key) - 1;
      if (presets[idx]) {
        e.preventDefault();
        selectPreset(presets[idx].id, { instant: false });
      }
      return;
    }

    if (typeof onKeyDown === 'function' && onKeyDown(e, ctx, handleAction) === true) {
      return;
    }

    switch (e.code) {
      case 'KeyC':
        e.preventDefault();
        handleAction('toggleControls');
        break;
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
      case 'KeyP':
        e.preventDefault();
        handleAction('screenshot');
        break;
      case 'KeyR':
        e.preventDefault();
        handleAction('resetCamera');
        break;
      case 'KeyI':
        e.preventDefault();
        handleAction('togglePhysicsTour');
        break;
      case 'KeyV':
        e.preventDefault();
        handleAction('toggleRecording');
        break;
      case 'KeyL':
        e.preventDefault();
        handleAction('copyShareUrl');
        break;
      case 'KeyM':
        if (audioEngine) {
          e.preventDefault();
          handleAction('toggleAudio');
        }
        break;
      case 'KeyG':
        e.preventDefault();
        handleAction('toggleProfiler');
        break;
      case 'BracketLeft':
        if (physicsTour?.isOpen()) {
          e.preventDefault();
          handleAction('stepPhysicsTour', -1);
        }
        break;
      case 'BracketRight':
        if (physicsTour?.isOpen()) {
          e.preventDefault();
          handleAction('stepPhysicsTour', 1);
        }
        break;
      default:
        break;
    }
  });

  const api = {
    get backend() {
      return activeBackend;
    },
    presets,

    getBackend() {
      return activeBackend;
    },

    async setBackend(nextBackend) {
      return switchBackend(nextBackend, { isInitial: false, persist: true });
    },

    getState() {
      const out = {
        ...state,
        backend: activeBackend,
        dprCap,
        qualityProfile,
        interactiveDragScale,
        reducedGlass,
        physicsTourOpen: Boolean(physicsTour?.isOpen()),
        helpOpen: Boolean(helpMenu?.isOpen()),
        recording: cinemaRecorder.isRecording(),
        camera: camera ? camera.getState() : null,
      };
      if (Array.isArray(state.skyRotation)) out.skyRotation = [...state.skyRotation];
      if (Array.isArray(state.skyRotationA)) out.skyRotationA = [...state.skyRotationA];
      if (Array.isArray(state.skyRotationB)) out.skyRotationB = [...state.skyRotationB];
      if (typeof getStateExtra === 'function') {
        Object.assign(out, getStateExtra(ctx));
      }
      return out;
    },

    setInteractiveDragScale(enabled) {
      return setInteractiveDragScale(enabled, { persist: true, syncUi: true });
    },

    setReducedGlass(enabled) {
      return setReducedGlass(enabled, { persist: true, syncUi: true });
    },

    getGraphicsPrefs() {
      return {
        profileId: qualityProfile,
        quality: state.quality ?? null,
        resolutionScale: state.resolutionScale ?? null,
        dprCap,
        interactiveDragScale,
        reducedGlass,
      };
    },

    setQualityProfile(profileId) {
      return setQualityProfile(profileId, { persist: true });
    },

    setDprCap(nextCap) {
      return setDprCap(nextCap, { persist: true });
    },

    getShareUrl(opts) {
      return getShareUrl(opts);
    },

    copyShareUrl() {
      return copyShareUrl();
    },

    togglePhysicsTour(visible) {
      return physicsTour.toggle(visible);
    },

    toggleHelp(visible) {
      return helpMenu.toggle(visible);
    },

    getHelpState() {
      return helpMenu.getState();
    },

    stepPhysicsTour(delta = 1) {
      physicsTour.step(delta);
      return physicsTour.getState();
    },

    getPhysicsTourState() {
      return physicsTour.getState();
    },

    startRecording(opts) {
      return cinemaRecorder.start(opts);
    },

    stopRecording() {
      return cinemaRecorder.stop();
    },

    getRecordingState() {
      return cinemaRecorder.getState();
    },

    toggleAudio(enabled) {
      return audioEngine ? audioEngine.toggle(enabled) : false;
    },

    setAudioVolume(v) {
      return audioEngine ? audioEngine.setVolume(v) : 0;
    },

    getAudioState() {
      return audioEngine ? audioEngine.getState() : { supported: false, enabled: false, volume: 0 };
    },

    async captureRawPngDataUrl(timeOverride = null) {
      if (!renderer || !camera) return null;
      if (timeOverride !== null) {
        resetRendererAccumulationCompat(renderer, true);
        if (typeof renderer.frameIndex === 'number') {
          renderer.frameIndex = 0;
        }
      }
      const camMatrices = camera.getCameraMatrices ? camera.getCameraMatrices() : camera.getMatrices?.();
      const tVal = timeOverride === null ? ctx.simTime : Number(timeOverride) || 0;
      const blob = await renderer.capturePNG(state, camMatrices, tVal);
      if (!blob) return null;
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to encode raw PNG DataURL.'));
        reader.readAsDataURL(blob);
      });
    },

    setState(patch = {}) {
      if (!patch || typeof patch !== 'object') return api.getState();
      let cameraUpdated = false;
      if (typeof setStateCustom === 'function') {
        cameraUpdated = Boolean(setStateCustom(patch, { applyParamChange, camera }, ctx));
      } else {
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'camera' && v && typeof v === 'object') {
            applyCameraPoseCompat(camera, v, 0);
            cameraUpdated = true;
          } else {
            applyParamChange(k, v, { syncUi: true });
          }
        }
      }
      if (renderer && camera && !switchingBackend) {
        if (cameraUpdated) {
          resetRendererAccumulationCompat(renderer, true);
        }
        ctx.renderImmediate({ dt: 0, isMotion: false });
        ctx.pushTelemetry();
      }
      return api.getState();
    },

    selectPreset(id, instant = true) {
      return selectPreset(id, { instant: Boolean(instant) });
    },

    setCamera(camPatch = {}) {
      applyCameraPoseCompat(camera, camPatch, 0);
      if (renderer && camera && !switchingBackend) {
        resetRendererAccumulationCompat(renderer, true);
        ctx.renderImmediate({ dt: 0, isMotion: false });
        ctx.pushTelemetry();
      }
      return camera ? camera.getState() : null;
    },

    toggleHud(visible) {
      const hudVisible = hud.toggleHud(visible);
      if (typeof hudVisible === 'boolean') {
        const isHidden = !hudVisible;
        profilerOverlay.setHudHidden(isHidden);
        if (isHidden) {
          helpMenu?.close({ returnFocus: false });
        }
      }
      return hudVisible;
    },

    toggleProfiler(visible) {
      return toggleProfiler(visible);
    },

    getProfilerMetrics() {
      return renderer?.getProfilerMetrics ? renderer.getProfilerMetrics() : null;
    },

    renderNow() {
      if (!renderer || !camera || switchingBackend) return;
      ctx.renderImmediate({ dt: 0, isMotion: false });
      ctx.pushTelemetry();
    },

    capturePNG() {
      if (!renderer || !camera || switchingBackend) {
        return Promise.reject(new Error('Renderer is currently unavailable.'));
      }
      return renderer.capturePNG(state, getCameraMatricesCompat(camera), simTime);
    },

    waitForSky() {
      return skyLoadPromise;
    },

    getTelemetry() {
      return ctx.buildTelemetry();
    },

    getDiagnostics() {
      const base = {
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
        volumeBaked: renderer ? Boolean(renderer.volumeBaked) : false,
        skyMapLoaded: renderer ? Boolean(renderer.skyMapLoaded) : false,
        skyDimensions: renderer?.skyDimensions ? [...renderer.skyDimensions] : [0, 0],
        resolution: renderer ? [renderer.width, renderer.height] : [0, 0],
        dpr: renderer ? renderer.dpr : 1,
        dprCap,
        qualityProfile,
        fps: Math.round(fpsSmoothed * 10) / 10,
        samples: renderer ? renderer.sampleCount : 0,
        paused: state.paused,
        activePreset: state.presetId,
        interactiveDragScale,
        reducedGlass,
        physicsTourOpen: Boolean(physicsTour?.isOpen()),
        helpOpen: Boolean(helpMenu?.isOpen()),
        recording: cinemaRecorder.isRecording(),
        profiler: renderer?.getProfilerMetrics ? renderer.getProfilerMetrics() : { enabled: profilerOpen },
        ...(audioEngine ? { audio: audioEngine.getState() } : {}),
        runtimeErrors: [...runtimeErrors],
        errors: [...runtimeErrors, ...(renderer?.errors || [])],
        ...(typeof renderer?.getDiagnostics === 'function' && renderer.getDiagnostics() && typeof renderer.getDiagnostics() === 'object'
          ? { rendererDiag: renderer.getDiagnostics() }
          : {}),
      };
      if (typeof getDiagnosticsExtra === 'function') {
        Object.assign(base, getDiagnosticsExtra(ctx));
      }
      return base;
    },
  };

  if (typeof extraApi === 'function') {
    Object.assign(api, extraApi(ctx, { api, applyParamChange, selectPreset, handleAction }));
  }

  // Apply deep-linked URL state (?preset=, ?tour=, #s=<base64url>) after renderer + extraApi boot
  if (urlState.hasState) {
    if (urlState.presetId && getPresetById(urlState.presetId)) {
      selectPreset(urlState.presetId, {
        instant: true,
        preserveDisplayPrefs: graphicsPrefs.hasStoredPrefs,
      });
    }
    if (urlState.params) {
      api.setState(urlState.params);
    }
    if (urlState.camera) {
      api.setCamera(urlState.camera);
    }
    if (urlState.tour === true) {
      physicsTour.setOpen(true);
    }
  }

  onReady?.({ api, ctx, handleAction, applyParamChange, selectPreset });

  function frame(now) {
    const rawDt = (now - lastFrameTime) * 0.001;
    lastFrameTime = now;

    if (switchingBackend || !renderer || !camera || contextLost) {
      requestAnimationFrame(frame);
      return;
    }

    const dt = Math.min(Math.max(rawDt, 0), 0.05);
    let tickMeta = null;
    if (typeof onTick === 'function') {
      tickMeta = onTick(dt, ctx) || null;
    } else if (!state.paused) {
      simTime += dt;
    }

    if (typeof updateCamera === 'function') {
      updateCamera(camera, dt, state, ctx);
    } else {
      camera.update(dt, { paused: state.paused, autoOrbit: state.autoOrbit });
    }
    cinemaRecorder.tick(dt);
    const camData = getCameraMatricesCompat(camera);
    if (audioEngine) {
      const audioPayload = sonification?.getFramePayload?.(ctx, camData) || { state, camData };
      audioEngine.update(audioPayload);
      if (audioStatusEl && audioEngine.getState().enabled) {
        audioStatusEl.textContent = audioEngine.getState().readout;
      }
    }
    const isDraggingCanvas =
      isPointerDragging ||
      Boolean(camera && ((camera._pointers && camera._pointers.size > 0) || camera._dragMode));
    const baseScale = Number(state.resolutionScale) || 1.0;
    const effectiveResolutionScale =
      interactiveDragScale && isDraggingCanvas && !cinemaRecorder.isRecording()
        ? Math.max(0.25, baseScale * 0.75)
        : baseScale;

    let renderOpts;
    if (tickMeta) {
      renderOpts = { dt, effectiveResolutionScale, ...tickMeta };
    } else {
      frameRenderOpts.dt = dt;
      frameRenderOpts.effectiveResolutionScale = effectiveResolutionScale;
      renderOpts = frameRenderOpts;
    }

    const submitted = Boolean(
      typeof renderFrame === 'function'
        ? renderFrame(renderer, state, camData, simTime, renderOpts, ctx)
        : renderer.render(state, camData, simTime, renderOpts)
    );

    if (submitted) {
      lastSubmitTime = now;
      if (fpsCount === FPS_RING_SIZE) {
        fpsHead = (fpsHead + 1) % FPS_RING_SIZE;
        fpsCount--;
      }
      fpsRing[(fpsHead + fpsCount) % FPS_RING_SIZE] = now;
      fpsCount++;
      const cutoff = now - 750;
      while (fpsCount > 2 && fpsRing[fpsHead] < cutoff) {
        fpsHead = (fpsHead + 1) % FPS_RING_SIZE;
        fpsCount--;
      }
      if (fpsCount >= 2) {
        const spanSec = (now - fpsRing[fpsHead]) / 1000;
        if (spanSec >= 0.15) {
          const measuredFps = (fpsCount - 1) / spanSec;
          fpsSmoothed = fpsInitialized ? fpsSmoothed * 0.7 + measuredFps * 0.3 : measuredFps;
          fpsInitialized = true;
        }
      }
    } else if (lastSubmitTime > 0 && now - lastSubmitTime > 1000) {
      if (state.paused && renderer.sampleCount >= 128) {
        fpsSmoothed = 0;
        fpsInitialized = false;
        fpsHead = 0;
        fpsCount = 0;
      } else if (fpsCount >= 1) {
        const spanSec = Math.max((now - fpsRing[fpsHead]) / 1000, 1.0);
        const liveRate = fpsCount / spanSec;
        fpsSmoothed = fpsSmoothed * 0.7 + liveRate * 0.3;
      }
    }

    if (now - lastTelemetryPush >= TELEMETRY_INTERVAL_MS) {
      lastTelemetryPush = now;
      ctx.pushTelemetry();
      if (profilerOpen && renderer?.getProfilerMetrics) {
        profilerOverlay.update(renderer.getProfilerMetrics());
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return { api, ctx, applyParamChange, selectPreset, handleAction };
}
