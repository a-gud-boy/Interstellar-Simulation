/**
 * main.js — Relativistic Starflight simulator entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, DEFAULT_STATE, createInitialState, getPresetById } from './engine/Presets.js';
import { StarflightCamera } from './engine/CameraController.js';
import { computeStarflightTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  applyCameraPoseCompat,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

const FLIGHT_PERIOD_Z = 34.0 * 16.0;

async function bootstrap() {
  const app = await createSimApp({
    simId: 'starflight',
    logPrefix: '[Starflight]',
    canvasId: 'starflight-canvas',
    canvasAriaLabel: 'Interactive special-relativistic starflight simulation',
    storageKey: 'starflight-sim.backend',
    screenshotPrefix: 'starflight',
    presetFlightSec: 1.1,
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D volumetric star-corridor dust…',
      webgl2: 'Compiling Lorentz aberration, Planck Doppler sky & Terrell geometry…',
    },
    initState: (state) => {
      if (!Number.isFinite(state.flightPosZ)) state.flightPosZ = 0.0;
      if (!Number.isFinite(state.properTimeYr)) state.properTimeYr = 0.0;
    },
    createCamera: (canvas, camPreset, ctx) =>
      new StarflightCamera(canvas, camPreset, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, state.paused ? false : state.autoOrbit);
    },
    buildTelemetry: ({ state, camera, renderer, activeBackend, fpsSmoothed }) => {
      const physicsTel = computeStarflightTelemetry(state);
      let isAft = Boolean(physicsTel?.isAft);
      if (camera && typeof camera.getState === 'function') {
        const camYaw = Number(camera.getState()?.lookYawDeg) || 0;
        const wrappedYaw = (((camYaw % 360) + 540) % 360) - 180;
        isAft = Math.abs(wrappedYaw) > 90;
      }
      return {
        ...physicsTel,
        isAft,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, value, { syncUi }, ctx) => {
      const { state, renderer, hud } = ctx;
      if (!(key in state) && key !== 'skyRotation' && key !== 'flightPosZ' && key !== 'properTimeYr') {
        return true;
      }
      if (key === 'skyRotation' && Array.isArray(value)) {
        state.skyRotation = [Number(value[0]) || 0, Number(value[1]) || 0];
      } else if (typeof state[key] === 'boolean') {
        state[key] = Boolean(value);
      } else if (
        typeof state[key] === 'number' ||
        key === 'flightPosZ' ||
        key === 'properTimeYr' ||
        key === 'rapidity'
      ) {
        const num = Number(value);
        if (!Number.isFinite(num)) return true;
        if (key === 'flightPosZ') {
          state.flightPosZ = ((num % FLIGHT_PERIOD_Z) + FLIGHT_PERIOD_Z) % FLIGHT_PERIOD_Z;
        } else if (key === 'properTimeYr') {
          state.properTimeYr = Math.max(0.0, num);
        } else if (key === 'rapidity') {
          state.rapidity = Math.min(7.65, Math.max(0.0, num));
        } else if (key === 'flightMode') {
          state.flightMode = (num | 0) === 1 ? 1 : 0;
        } else if (key === 'flightDir') {
          state.flightDir = num >= 0 ? 1 : -1;
        } else if (key === 'aberrationMode') {
          state.aberrationMode = (num | 0) === 0 ? 0 : 1;
        } else {
          state[key] = num;
        }
      } else {
        state[key] = value;
      }

      if (key === 'rapidity' && !syncUi && (state.flightMode | 0) === 1) {
        state.flightMode = 0;
        hud?.syncState({ flightMode: 0 });
      }
      if ((state.flightMode | 0) === 1 && (key === 'flightMode' || key === 'properTimeYr' || key === 'properAccelG')) {
        const tel = computeStarflightTelemetry(state);
        state.rapidity = tel.rapidity;
        hud?.syncState({ rapidity: state.rapidity });
      }

      if (renderer) {
        if (key === 'resolutionScale') renderer.resize(state.resolutionScale);
        else if (key === 'exposure' || key === 'bloomIntensity' || key === 'anamorphicIntensity') {
          renderer.markPostDirty?.();
        } else if (key !== 'paused' && key !== 'autoOrbit') {
          resetRendererAccumulationCompat(renderer, true);
        }
      }
      if (syncUi && hud) hud.syncState({ [key]: state[key] });
      ctx.pushTelemetry();
      return true;
    },
    onPresetBeforeParams: (_preset, _opts, { state }) => {
      state.flightDir = DEFAULT_STATE.flightDir ?? 1;
      state.aberrationMode = DEFAULT_STATE.aberrationMode ?? 1;
      state.properAccelG = DEFAULT_STATE.properAccelG ?? 1.0;
      state.properTimeYr = DEFAULT_STATE.properTimeYr ?? 0.0;
      state.dopplerStrength = DEFAULT_STATE.dopplerStrength ?? 1.0;
      state.dustStreakScale = DEFAULT_STATE.dustStreakScale ?? 1.0;
      state.beamingGain = DEFAULT_STATE.beamingGain ?? 1.0;
      state.cmbTempScale = DEFAULT_STATE.cmbTempScale ?? 1.0;
    },
    onPresetSelect: (_preset, _opts, { state }) => {
      if ((state.flightMode | 0) === 1) {
        state.rapidity = computeStarflightTelemetry(state).rapidity;
      }
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName === 'flipView' || actionName === 'flipAftForward') {
        app?.api?.flipAftForward(false);
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
        handleAction('flipView');
        return true;
      }
      return false;
    },
    extraApi: (ctx, { selectPreset }) => ({
      getPresets() {
        return PRESETS;
      },
      applyPreset(id, instant = true) {
        return selectPreset(id, { instant: Boolean(instant) });
      },
      flipAftForward(instant = false) {
        const cam = ctx.camera;
        if (!cam) return null;
        const dur = instant ? 0 : 0.9;
        if (typeof cam.flipAftForward === 'function') {
          cam.flipAftForward(dur);
        } else {
          const curYaw = cam.getState().lookYawDeg || 0;
          const normYaw = (((curYaw % 360) + 540) % 360) - 180;
          const nextYaw = Math.abs(normYaw) < 90 ? 180 : 0;
          applyCameraPoseCompat(cam, { lookYawDeg: nextYaw }, dur);
        }
        resetRendererAccumulationCompat(ctx.renderer, true);
        if (instant && ctx.renderer && cam && !ctx.switchingBackend) {
          ctx.renderImmediate({ dt: 0, isMotion: false });
        }
        ctx.pushTelemetry();
        return cam.getState();
      },
      resetCamera(instant = false) {
        const active = getPresetById(ctx.state.presetId) || PRESETS[0];
        if (ctx.camera) applyCameraPoseCompat(ctx.camera, active.camera, instant ? 0 : 1.0);
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
      let frameTel = null;
      if (!s.paused) {
        ctx.simTime += dt;
        if ((s.flightMode | 0) === 1) {
          s.properTimeYr = (Number(s.properTimeYr) || 0) + dt * 0.14;
          frameTel = computeStarflightTelemetry(s);
          s.rapidity = frameTel.rapidity;
        } else {
          frameTel = computeStarflightTelemetry(s);
        }
        const dirSign = (Number(s.flightDir) || 1) >= 0 ? 1 : -1;
        const nextPosZ = (Number(s.flightPosZ) || 0) + dt * frameTel.visualPace * dirSign;
        s.flightPosZ = ((nextPosZ % FLIGHT_PERIOD_Z) + FLIGHT_PERIOD_Z) % FLIGHT_PERIOD_Z;
      }
      const camMoving = typeof ctx.camera?.hasMotion === 'function' ? ctx.camera.hasMotion() : false;
      const isMotion = Boolean(camMoving || !s.paused);
      return { forceComposite: false, dt: s.paused ? 0 : dt, isMotion, telemetry: frameTel };
    },
  });

  if (app) {
    window.__STARFLIGHT__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
