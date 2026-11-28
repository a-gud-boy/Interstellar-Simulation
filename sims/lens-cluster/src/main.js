/**
 * main.js — Gravitational Lensing Observatory entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, DEFAULT_STATE, createInitialState, getPresetById } from './engine/Presets.js';
import { LensClusterCamera } from './engine/CameraController.js';
import { computeLensTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  applyCameraPoseCompat,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

async function bootstrap() {
  let orbitAngle = 0.0;
  let lastAutoOrbitSourceX = null;

  const app = await createSimApp({
    simId: 'lens-cluster',
    logPrefix: '[LensCluster]',
    canvasId: 'lens-cluster-canvas',
    canvasAriaLabel: 'Interactive gravitational lensing, Einstein rings, caustics, and galaxy cluster simulation',
    storageKey: 'lens-cluster-sim.backend',
    screenshotPrefix: 'lens-cluster',
    presetFlightSec: 1.05,
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D volumetric X-ray ICM cluster gas…',
      webgl2: 'Compiling analytical gravitational lens optics & caustic curves…',
    },
    WebGLRenderer,
    WebGPURenderer,
    createCamera: (canvas, camPreset, ctx) =>
      new LensClusterCamera(canvas, camPreset, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
        getDragMode: () => (ctx.state.dragMode ? 1 : 0),
        onSourceDrag: (dsx, dsy) => {
          const s = ctx.state;
          s.sourceOrbitSpeed = 0.0;
          s.sourceX = clamp((Number(s.sourceX) || 0) + dsx, -3.2, 3.2);
          s.sourceY = clamp((Number(s.sourceY) || 0) + dsy, -3.2, 3.2);
          ctx.hud?.syncState({ sourceX: s.sourceX, sourceY: s.sourceY });
          resetRendererAccumulationCompat(ctx.renderer, true);
          ctx.pushTelemetry();
        },
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, state.paused ? false : state.autoOrbit);
    },
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const physicsTel = computeLensTelemetry(state);
      return {
        ...physicsTel,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, value, { syncUi }, ctx) => {
      const { state, renderer, hud } = ctx;
      if (!(key in state) && key !== 'skyRotation') {
        return true;
      }
      if (key === 'skyRotation' && Array.isArray(value)) {
        state.skyRotation = [Number(value[0]) || 0, Number(value[1]) || 0];
      } else if (typeof state[key] === 'boolean') {
        state[key] = Boolean(value);
      } else if (typeof state[key] === 'number') {
        const num = Number(value);
        if (!Number.isFinite(num)) return true;
        if (key === 'lensModel') {
          state.lensModel = Math.max(0, Math.min(2, num | 0));
        } else if (key === 'einsteinRadius') {
          state.einsteinRadius = clamp(num, 0.4, 5.0);
        } else if (key === 'ellipticity') {
          state.ellipticity = clamp(num, 0.0, 0.68);
        } else if (key === 'extShear') {
          state.extShear = clamp(num, 0.0, 0.30);
        } else if (key === 'lensAngleDeg') {
          state.lensAngleDeg = clamp(num, -90, 90);
        } else if (key === 'shearAngleDeg') {
          state.shearAngleDeg = clamp(num, -90, 90);
        } else if (key === 'subhaloStrength') {
          state.subhaloStrength = clamp(num, 0.0, 2.2);
        } else if (key === 'sourceX') {
          state.sourceX = clamp(num, -3.2, 3.2);
          if (!syncUi) state.sourceOrbitSpeed = 0.0;
        } else if (key === 'sourceY') {
          state.sourceY = clamp(num, -3.2, 3.2);
          if (!syncUi) state.sourceOrbitSpeed = 0.0;
        } else if (key === 'sourceScale') {
          state.sourceScale = clamp(num, 0.15, 1.4);
        } else if (key === 'quasarCore') {
          state.quasarCore = clamp(num, 0.0, 2.5);
        } else if (key === 'showCaustics') {
          state.showCaustics = (num | 0) ? 1 : 0;
        } else if (key === 'showFermat') {
          state.showFermat = (num | 0) ? 1 : 0;
        } else if (key === 'dragMode') {
          state.dragMode = (num | 0) ? 1 : 0;
        } else {
          state[key] = num;
        }
      } else {
        state[key] = value;
      }

      if (renderer) {
        if (key === 'resolutionScale') renderer.resize(state.resolutionScale);
        else if (key === 'exposure' || key === 'bloomIntensity' || key === 'anamorphicIntensity') {
          renderer.markPostDirty?.();
        } else if (key !== 'paused' && key !== 'autoOrbit' && key !== 'dragMode') {
          resetRendererAccumulationCompat(renderer, true);
        }
      }
      if (syncUi && hud) hud.syncState({ [key]: state[key] });
      else if (key === 'dragMode' && hud) hud.syncState({ dragMode: state.dragMode });
      ctx.pushTelemetry();
      return true;
    },
    onPresetBeforeParams: (_preset, _opts, { state }) => {
      state.shearAngleDeg = DEFAULT_STATE.shearAngleDeg;
      state.dragMode = 0;
      orbitAngle = 0.0;
      lastAutoOrbitSourceX = null;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName === 'toggleDragMode') {
        app?.api?.toggleDragMode?.();
        return true;
      }
      if (actionName === 'resetCamera') {
        app?.api?.resetCamera(false);
        return true;
      }
      return false;
    },
    onKeyDown: (e, _ctx, handleAction) => {
      if (e.code === 'KeyT') {
        e.preventDefault();
        handleAction('toggleDragMode');
        return true;
      }
      return false;
    },
    extraApi: (ctx, { selectPreset }) => ({
      getPresets() {
        return PRESETS;
      },
      getCameraState() {
        return ctx.camera ? ctx.camera.getState() : null;
      },
      applyPreset(id, instant = true) {
        return selectPreset(id, { instant: Boolean(instant) });
      },
      toggleDragMode() {
        ctx.state.dragMode = ctx.state.dragMode ? 0 : 1;
        ctx.hud?.syncState({ dragMode: ctx.state.dragMode });
        ctx.pushTelemetry();
        return ctx.state.dragMode;
      },
      resetCamera(instant = false) {
        const active = getPresetById(ctx.state.presetId) || PRESETS[2];
        if (ctx.camera) applyCameraPoseCompat(ctx.camera, active.camera, instant ? 0 : 1.0);
        ctx.state.sourceX = active.params.sourceX;
        ctx.state.sourceY = active.params.sourceY;
        ctx.state.sourceOrbitSpeed = active.params.sourceOrbitSpeed;
        ctx.hud?.syncState({ sourceX: ctx.state.sourceX, sourceY: ctx.state.sourceY });
        resetRendererAccumulationCompat(ctx.renderer, true);
        if (instant && ctx.renderer && ctx.camera && !ctx.switchingBackend) {
          ctx.renderImmediate({ dt: 0, isMotion: false });
        }
        ctx.pushTelemetry();
        return ctx.camera ? ctx.camera.getState() : null;
      },
    }),
    onTick: (dt, ctx) => {
      const s = ctx.state;
      let drifted = false;
      if (!s.paused) {
        ctx.simTime += dt;
        const speed = Number(s.sourceOrbitSpeed) || 0.0;
        if (speed > 1e-4) {
          if (lastAutoOrbitSourceX === null) {
            orbitAngle = Math.atan2(s.sourceY, s.sourceX);
          }
          const baseRadius = Math.max(Math.hypot(s.sourceX, s.sourceY), 0.14);
          orbitAngle += speed * dt;
          s.sourceX = clamp(baseRadius * Math.cos(orbitAngle), -3.2, 3.2);
          s.sourceY = clamp(baseRadius * Math.sin(orbitAngle) * 0.72, -3.2, 3.2);
          lastAutoOrbitSourceX = s.sourceX;
          drifted = true;
        }
      }
      const camMoving = typeof ctx.camera?.hasMotion === 'function' ? ctx.camera.hasMotion() : false;
      const isMotion = Boolean(camMoving || drifted);
      return { forceComposite: false, dt: s.paused ? 0 : dt, isMotion };
    },
  });

  if (app) {
    window.__LENS_CLUSTER__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
