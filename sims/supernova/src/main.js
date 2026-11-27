/**
 * main.js — Full-Lifecycle Supernova & Volumetric Remnant simulator entrypoint
 * powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { SupernovaCamera } from './engine/CameraController.js';
import {
  AGE_MIN_YR,
  ageToNorm,
  normToAge,
  clamp,
  evalLifecycleMorphology,
  computeSupernovaTelemetry,
} from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import { createSimApp } from '../../../shared/engine/SimAppShell.js';

const EVOLVE_DURATION_SEC = 22.0;
const EVOLVE_END_AGE_YR = 12000.0;

function applyMorphologyForAge(state, ageYears) {
  const m = evalLifecycleMorphology(ageYears);
  state.bipolarPower = m.bipolarPower;
  state.jetPower = m.jetPower;
  state.ringStrength = m.ringStrength;
  state.curtainWeight = m.curtainWeight;
  state.dustOpacity = m.dustOpacity;
  state.bokDensity = m.bokDensity;
  state.starLuminosity = m.starLuminosity;
  state.cavityGlow = m.cavityGlow;
  state.filamentContrast = m.filamentContrast;
  state.shellThickness = m.shellThickness;
  state.emissionGain = m.emissionGain;
}

function startDetonationEvolution(ctx) {
  ctx.state.evolving = true;
  ctx.state.paused = false;
  ctx.state.presetId = null;
  ctx.state.shockAge = AGE_MIN_YR;
  applyMorphologyForAge(ctx.state, AGE_MIN_YR);
  if (ctx.camera && ctx.camera.distance < 5.0) {
    ctx.camera.flyTo(PRESETS[0].camera, 1.0);
  }
  ctx.renderer?.resetAccumulation(true);
  ctx.hud?.syncState(ctx.state);
  ctx.hud?.setActivePreset('Evolving Lifecycle');
  ctx.pushTelemetry();
}

function stopDetonationEvolution(ctx) {
  if (!ctx.state.evolving) return;
  ctx.state.evolving = false;
  ctx.hud?.syncState({ evolving: false });
}

async function bootstrap() {
  const app = await createSimApp({
    simId: 'supernova',
    logPrefix: '[Supernova]',
    canvasId: 'supernova-canvas',
    canvasAriaLabel: 'Interactive full-lifecycle supernova explosion and volumetric remnant simulation',
    storageKey: 'supernova-sim.backend',
    screenshotPrefix: 'supernova',
    presetFlightSec: 1.1,
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D multi-scattering supernova volume…',
      webgl2: 'Compiling shock-breakout radiative transfer & 3D turbulence…',
    },
    createCamera: (canvas, camPreset, ctx) =>
      new SupernovaCamera(canvas, camPreset, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, state.paused ? false : state.autoOrbit);
    },
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const physicsTel = computeSupernovaTelemetry(state);
      return {
        ...physicsTel,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, _value, _opts, ctx) => {
      if (key === 'shockAge' && ctx.state.evolving) {
        stopDetonationEvolution(ctx);
      }
      return false;
    },
    onPresetBeforeParams: (_preset, _opts, ctx) => {
      ctx.state.evolving = false;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName === 'resetCamera') {
        const active = getPresetById(ctx.state.presetId) || PRESETS[0];
        ctx.camera?.flyTo(active.camera, 1.0);
        ctx.renderer?.resetAccumulation(true);
        ctx.pushTelemetry();
        return true;
      }
      if (actionName === 'toggleDetonate') {
        if (ctx.state.evolving) {
          stopDetonationEvolution(ctx);
        } else {
          startDetonationEvolution(ctx);
        }
        return true;
      }
      if (actionName === 'detonate') {
        startDetonationEvolution(ctx);
        return true;
      }
      return false;
    },
    onKeyDown: (e, _ctx, handleAction) => {
      if (e.code === 'KeyT') {
        e.preventDefault();
        handleAction('toggleDetonate');
        return true;
      }
      return false;
    },
    onTick: (dt, ctx) => {
      if (!ctx.state.paused) {
        ctx.simTime += dt;
        if (ctx.state.evolving) {
          const speed = clamp(ctx.state.expansionSpeed ?? 1.0, 0.25, 2.5);
          const endNorm = ageToNorm(EVOLVE_END_AGE_YR);
          const nextNorm = Math.min(endNorm, ageToNorm(ctx.state.shockAge) + (dt * speed) / EVOLVE_DURATION_SEC);
          ctx.state.shockAge = normToAge(nextNorm);
          applyMorphologyForAge(ctx.state, ctx.state.shockAge);
          if (nextNorm >= endNorm - 1e-4) {
            ctx.state.evolving = false;
          }
          ctx.hud?.syncState(ctx.state);
        }
      }
      return { forceComposite: false, dt: ctx.state.paused ? 0 : dt };
    },
    extraApi: (ctx) => ({
      detonate() {
        startDetonationEvolution(ctx);
        return ctx.state;
      },
      stopEvolution() {
        stopDetonationEvolution(ctx);
        return ctx.state;
      },
    }),
  });

  if (app) {
    window.__SUPERNOVA__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
