/**
 * main.js — Binary Black Hole simulator entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { CameraController } from './engine/CameraController.js';
import { computeBinaryState, stepBinaryOrbit } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

const TIDAL_RESET_KEYS = new Set([
  'massRatio',
  'separation',
  'diskDensity',
  'bridgeIntensity',
  'diskOuterRadius',
]);

async function bootstrap() {
  let orbitState = null;
  const reusableBinState = { c1: [0, 0, 0], c2: [0, 0, 0], v1: [0, 0, 0], v2: [0, 0, 0] };
  const binParamsScratch = { massRatio: 1.0, separation: 7.4 };
  const binOptsScratch = { out: reusableBinState };

  function getActiveBinaryState(state) {
    binParamsScratch.massRatio = state.massRatio;
    binParamsScratch.separation = orbitState.currentSep;
    const bin = computeBinaryState(binParamsScratch, orbitState.phase, binOptsScratch);
    bin.ringdownFactor = orbitState.ringdownFactor || 0.0;
    return bin;
  }

  const app = await createSimApp({
    simId: 'binary',
    logPrefix: '[BinaryBH]',
    canvasId: 'binary-bh-canvas',
    canvasAriaLabel: 'Interactive relativistic binary black hole simulation',
    storageKey: 'interstellar.backend',
    screenshotPrefix: 'binary-bh',
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU compute tidal hydrodynamics & binary ray-tracer…',
      webgl2: 'Compiling 2.5PN binary spacetime & FBO tidal hydrodynamics…',
    },
    initState: (state) => {
      orbitState = {
        phase: ((state.initialPhaseDeg || 0) * Math.PI) / 180.0,
        currentSep: state.separation,
        ringdownTimer: 0.0,
        inRingdown: false,
        ringdownFactor: 0.0,
      };
    },
    createCamera: (canvas, camPreset, ctx) =>
      new CameraController(canvas, camPreset, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
        onInclinationChange: (inclDeg) => {
          ctx.state.orbitalInclination = inclDeg;
          ctx.hud?.syncState({ orbitalInclination: inclDeg });
        },
      }),
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const bin = getActiveBinaryState(state);
      return {
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        separationM: bin.d,
        fGwHz: bin.fGwHz,
        fGwDimless: bin.fGwDimless,
        chirpPhaseRad: bin.gwPhaseRad,
        gwStrain: bin.hPlusPeak,
        massRatio: bin.q,
        orbitalPeriodM: bin.orbitalPeriodM,
        vOrbitC: bin.vOrbitC,
        rIscoM: bin.rIsco1,
        rCavityM: bin.rCavity,
        tMergeM: bin.tMergeM,
        ringdown: orbitState.inRingdown,
        ringdownFactor: orbitState.ringdownFactor,
        tidalComputed: renderer ? renderer.tidalComputed : false,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, value, { syncUi }, ctx) => {
      const { state, camera, renderer, hud } = ctx;
      if (key === 'separation') {
        orbitState.currentSep = Number(value);
        orbitState.inRingdown = false;
        orbitState.ringdownTimer = 0.0;
        orbitState.ringdownFactor = 0.0;
      } else if (key === 'initialPhaseDeg') {
        orbitState.phase = ((Number(value) || 0) * Math.PI) / 180.0;
      } else if (key === 'orbitalInclination' && camera) {
        state.orbitalInclination = Number(value);
        camera.setInclinationDeg(state.orbitalInclination, false);
        renderer?.resetAccumulation(true);
        if (syncUi && hud) hud.syncState({ [key]: state[key] });
        return true;
      }
      if (renderer && TIDAL_RESET_KEYS.has(key)) {
        renderer.resetTidalField();
      }
      return false;
    },
    onPresetSelect: (preset, _opts, ctx) => {
      const { state, renderer } = ctx;
      orbitState.currentSep = state.separation;
      orbitState.phase = ((state.initialPhaseDeg || 0) * Math.PI) / 180.0;
      orbitState.ringdownTimer = 0.0;
      orbitState.inRingdown = false;
      orbitState.ringdownFactor = 0.0;
      renderer?.resetTidalField();
      void preset;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName !== 'resetCamera') return false;
      const active = getPresetById(ctx.state.presetId) || PRESETS[0];
      ctx.camera?.flyTo(active.camera, 1.0);
      if (typeof active.params?.orbitalInclination === 'number') {
        ctx.state.orbitalInclination = active.params.orbitalInclination;
        ctx.hud?.syncState({ orbitalInclination: ctx.state.orbitalInclination });
      }
      return true;
    },
    setStateCustom: (patch, { applyParamChange }, ctx) => {
      let cameraUpdated = false;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'camera' && v && typeof v === 'object') {
          ctx.camera?.setImmediate(v);
          if (ctx.camera) {
            ctx.state.orbitalInclination = Math.round(ctx.camera.getInclinationDeg() * 10) / 10;
            ctx.hud?.syncState({ orbitalInclination: ctx.state.orbitalInclination });
          }
          cameraUpdated = true;
        } else if (k === 'orbitalInclination') {
          ctx.state.orbitalInclination = Number(v) || ctx.state.orbitalInclination;
          ctx.camera?.setInclinationDeg(ctx.state.orbitalInclination, true);
          ctx.hud?.syncState({ orbitalInclination: ctx.state.orbitalInclination });
          cameraUpdated = true;
        } else {
          applyParamChange(k, v, { syncUi: true });
        }
      }
      return cameraUpdated;
    },
    extraApi: (ctx) => ({
      setCamera(camPatch = {}) {
        ctx.camera?.setImmediate(camPatch);
        if (ctx.camera) {
          ctx.state.orbitalInclination = Math.round(ctx.camera.getInclinationDeg() * 10) / 10;
          ctx.hud?.syncState({ orbitalInclination: ctx.state.orbitalInclination });
        }
        if (ctx.renderer && ctx.camera && !ctx.switchingBackend) {
          resetRendererAccumulationCompat(ctx.renderer, true);
          ctx.renderImmediate({ dt: 0 });
          ctx.pushTelemetry();
        }
        return ctx.camera ? ctx.camera.getState() : null;
      },
    }),
    getStateExtra: () => ({ orbit: { ...orbitState } }),
    getDiagnosticsExtra: ({ renderer }) => ({
      tidalComputed: renderer ? renderer.tidalComputed : false,
    }),
    onTick: (dt, ctx) => {
      if (!ctx.state.paused) {
        ctx.simTime += dt;
        stepBinaryOrbit(orbitState, ctx.state, dt);
      }
      return { dt: ctx.state.paused ? 0 : dt };
    },
    renderFrame: (renderer, state, camData, simTime, opts) =>
      renderer.render(state, camData, simTime, getActiveBinaryState(state), opts),
  });

  if (app) {
    window.__BINARY_BH__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
