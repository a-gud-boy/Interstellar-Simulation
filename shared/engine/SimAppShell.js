/**
 * SimAppShell.js — Unified WebGL2 + WebGPU application shell shared by all 7
 * Interstellar Simulation `src/main.js` entrypoints:
 *  - Backend resolution (?backend= / localStorage / default webgl2) & live switcher
 *  - Serialized switch queue with WebGPU <-> WebGL2 fallback and canvas replacement
 *  - 750ms sliding-window FPS smoother, 85ms telemetry timer, ResizeObserver
 *  - Standard keyboard shortcuts (1-6, Space, H, O, P, R) + custom key/action hooks
 *  - PNG capture + programmatic inspection API
 */

import { loadSkyTextureWebGL, loadSkyTextureWebGPU } from '../assets/skyLoader.js';
import { mountSimSwitcher } from '../ui/simSwitcher.js';

const DEFAULT_POST_ONLY_KEYS = new Set(['exposure', 'bloomIntensity', 'anamorphicIntensity']);
const TELEMETRY_INTERVAL_MS = 85;
const VALID_BACKENDS = new Set(['webgl2', 'webgpu']);
const FPS_RING_SIZE = 128;
const PERF_DRAG_SCALE_KEY = 'interstellar_perf_drag_scale';
const PERF_REDUCED_GLASS_KEY = 'interstellar_perf_reduced_glass';

function readStoredPerfFlag(storageKey, fallback = false) {
  try {
    const raw = window.localStorage?.getItem(storageKey);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // Ignore restricted localStorage
  }
  return fallback;
}

function writeStoredPerfFlag(storageKey, value) {
  try {
    window.localStorage?.setItem(storageKey, value ? '1' : '0');
  } catch {
    // Ignore restricted localStorage
  }
}

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
  } = config;

  let canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.error(`${logPrefix} Missing <canvas id="${canvasId}"> element.`);
    return null;
  }

  const canvasFallbackText = canvas.textContent;
  const state = createInitialState();
  if (typeof initState === 'function') initState(state);

  let activeBackend = resolveInitialBackend(storageKey);
  state.backend = activeBackend;

  const simSwitcher = mountSimSwitcher({
    currentSimId: simId,
    initialBackend: activeBackend,
  });

  const initialPreset = getPresetById(state.presetId) || presets[0];

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
  let interactiveDragScale = readStoredPerfFlag(PERF_DRAG_SCALE_KEY, false);
  let reducedGlass = readStoredPerfFlag(PERF_REDUCED_GLASS_KEY, false);
  let isPointerDragging = false;
  let perfDragCheckbox = null;
  let perfGlassCheckbox = null;
  const frameRenderOpts = { dt: 0, effectiveResolutionScale: 1.0 };
  const runtimeErrors = [];

  if (typeof document !== 'undefined') {
    document.body?.classList.toggle('reduced-glass', reducedGlass);
  }

  function setInteractiveDragScale(enabled, { persist = true, syncUi = true } = {}) {
    interactiveDragScale = Boolean(enabled);
    if (persist) writeStoredPerfFlag(PERF_DRAG_SCALE_KEY, interactiveDragScale);
    if (syncUi && perfDragCheckbox) perfDragCheckbox.checked = interactiveDragScale;
    if (!interactiveDragScale && renderer && !switchingBackend) {
      renderer.resize(state.resolutionScale);
    }
    return interactiveDragScale;
  }

  function setReducedGlass(enabled, { persist = true, syncUi = true } = {}) {
    reducedGlass = Boolean(enabled);
    if (typeof document !== 'undefined') {
      document.body?.classList.toggle('reduced-glass', reducedGlass);
    }
    if (persist) writeStoredPerfFlag(PERF_REDUCED_GLASS_KEY, reducedGlass);
    if (syncUi && perfGlassCheckbox) perfGlassCheckbox.checked = reducedGlass;
    return reducedGlass;
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
    glRenderer.resize(state.resolutionScale);
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
    contextLost = false;
    resetFpsTracker();

    if (!camera) {
      camera = createCamera(canvas, initialPreset.camera, ctx);
    } else {
      setCameraCanvasCompat(camera, canvas);
    }

    renderer.resize(state.resolutionScale);
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

    if (typeof onParamChange === 'function') {
      const handled = onParamChange(key, value, { syncUi }, ctx);
      if (handled === true) return;
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
        renderer.resize(state.resolutionScale);
      } else if (postOnlyKeys.has(key)) {
        renderer.markPostDirty?.();
      } else if (key !== 'paused' && key !== 'autoOrbit') {
        resetRendererAccumulationCompat(renderer, true);
      }
    }

    if (syncUi && hud) {
      hud.syncState({ [key]: state[key] });
    }
  }

  function selectPreset(presetId, { instant = false } = {}) {
    const preset = getPresetById(presetId);
    if (!preset) return false;

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

    if (typeof preset.camera?.autoOrbit === 'boolean') {
      state.autoOrbit = preset.camera.autoOrbit;
    }

    const handledCam = onPresetSelect?.(preset, { instant }, ctx);
    if (handledCam !== true && camera) {
      applyCameraPoseCompat(camera, preset.camera, instant ? 0 : presetFlightSec);
    }

    resetRendererAccumulationCompat(renderer, true);

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

      case 'toggleHud':
        hud?.toggleHud();
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

  if (typeof document !== 'undefined') {
    const sectionsEl = document.getElementById('controls-sections');
    if (sectionsEl && !document.getElementById('section-performance')) {
      const details = document.createElement('details');
      details.className = 'control-section';
      details.id = 'section-performance';
      const summary = document.createElement('summary');
      summary.textContent = 'Display & Performance';
      const body = document.createElement('div');
      body.className = 'control-section-body';

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

      details.appendChild(summary);
      details.appendChild(body);
      sectionsEl.appendChild(details);
    }
  }

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
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;

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
        interactiveDragScale,
        reducedGlass,
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
      return hud.toggleHud(visible);
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
        fps: Math.round(fpsSmoothed * 10) / 10,
        samples: renderer ? renderer.sampleCount : 0,
        paused: state.paused,
        activePreset: state.presetId,
        interactiveDragScale,
        reducedGlass,
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
    const camData = getCameraMatricesCompat(camera);
    const isDraggingCanvas =
      isPointerDragging ||
      Boolean(camera && ((camera._pointers && camera._pointers.size > 0) || camera._dragMode));
    const baseScale = Number(state.resolutionScale) || 1.0;
    const effectiveResolutionScale =
      interactiveDragScale && isDraggingCanvas ? Math.max(0.25, baseScale * 0.75) : baseScale;

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
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return { api, ctx, applyParamChange, selectPreset, handleAction };
}
