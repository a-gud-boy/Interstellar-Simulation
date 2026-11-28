/**
 * main.js — Magnetar & Millisecond Pulsar simulator entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { PulsarCamera } from './engine/CameraController.js';
import { computePulsarTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  applyCameraPoseCompat,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

const TWO_PI = Math.PI * 2;

async function bootstrap() {
  const app = await createSimApp({
    simId: 'pulsar',
    logPrefix: '[Pulsar]',
    canvasId: 'pulsar-canvas',
    canvasAriaLabel: 'Interactive relativistic magnetar and millisecond pulsar simulation',
    storageKey: 'pulsar-sim.backend',
    screenshotPrefix: 'pulsar',
    presetFlightSec: 1.1,
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D synchrotron plasma volume…',
      webgl2: 'Compiling Kerr-Schild neutron star light bending & magnetosphere…',
    },
    initState: (state) => {
      if (!Number.isFinite(state.spinPhase)) {
        state.spinPhase = 0.0;
      }
    },
    createCamera: (canvas, camPreset, ctx) =>
      new PulsarCamera(canvas, camPreset, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, state.paused ? false : state.autoOrbit);
    },
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const physicsTel = computePulsarTelemetry(state);
      return {
        ...physicsTel,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, value, _opts, ctx) => {
      if (key === 'spinPhase') {
        const num = Number(value);
        if (!Number.isFinite(num)) return true;
        ctx.state.spinPhase = ((num % TWO_PI) + TWO_PI) % TWO_PI;
        resetRendererAccumulationCompat(ctx.renderer, true);
        if (_opts.syncUi) ctx.hud?.syncState({ spinPhase: ctx.state.spinPhase });
        ctx.pushTelemetry();
        return true;
      }
      queueMicrotask(() => ctx.pushTelemetry());
      return false;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName !== 'resetCamera') return false;
      const active = getPresetById(ctx.state.presetId) || PRESETS[0];
      if (ctx.camera) applyCameraPoseCompat(ctx.camera, active.camera, 1.0);
      resetRendererAccumulationCompat(ctx.renderer, true);
      ctx.pushTelemetry();
      return true;
    },
    extraApi: (ctx, { selectPreset }) => ({
      getPresets() {
        return PRESETS;
      },
      applyPreset(id, instant = true) {
        return selectPreset(id, { instant: Boolean(instant) });
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
      const tel = computePulsarTelemetry(ctx.state);
      if (!ctx.state.paused) {
        ctx.simTime += dt;
        ctx.state.spinPhase = ((ctx.state.spinPhase || 0) + dt * tel.omegaVis) % TWO_PI;
      }
      const camMoving = typeof ctx.camera?.hasMotion === 'function' ? ctx.camera.hasMotion() : false;
      const isMotion = Boolean(camMoving || (!ctx.state.paused && tel.omegaVis > 0));
      return { forceComposite: false, dt: ctx.state.paused ? 0 : dt, isMotion, telemetry: tel };
    },
    sonification: {
      label: 'Pulsar Pulse Train',
      getFramePayload: (ctx, camData) => ({
        state: ctx.state,
        camData,
        pulsarTel: computePulsarTelemetry(ctx.state),
      }),
    },
  });

  if (app) {
    window.__PULSAR__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
