/**
 * main.js — Tidal Disruption Event entrypoint wired to shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { CameraController } from './engine/CameraController.js';
import { computeTdeTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

async function bootstrap() {
  let sweeping = false;

  const app = await createSimApp({
    simId: 'tde',
    logPrefix: '[TDE]',
    canvasId: 'tde-canvas',
    canvasAriaLabel: 'Interactive relativistic tidal disruption event simulation',
    storageKey: 'tde-sim.backend',
    screenshotPrefix: 'tde',
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D tidal plasma volume…',
      webgl2: 'Compiling Kerr–Schild TDE geodesics & debris shock…',
    },
    createCamera: (canvas, initialCamera, ctx) =>
      new CameraController(canvas, initialCamera, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, { paused: state.paused, autoOrbit: state.autoOrbit });
    },
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const tel = computeTdeTelemetry(state);
      return {
        ...tel,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onPresetSelect: () => {
      sweeping = false;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName === 'disruptEvolve') {
        sweeping = true;
        ctx.state.paused = false;
        ctx.state.tdePhase = 0.06;
        ctx.hud?.syncState({ paused: false, tdePhase: 0.06, sweeping: true });
        resetRendererAccumulationCompat(ctx.renderer, true);
        return true;
      }
      return false;
    },
    onKeyDown: (e, _ctx, handleAction) => {
      if (e.code === 'KeyT') {
        e.preventDefault();
        handleAction('disruptEvolve');
        return true;
      }
      return false;
    },
    onTick: (dt, ctx) => {
      if (!ctx.state.paused) {
        ctx.simTime += dt;
        if (sweeping) {
          ctx.state.tdePhase = Math.min(0.98, (ctx.state.tdePhase || 0.06) + dt * 0.095);
          ctx.hud?.syncState({ tdePhase: ctx.state.tdePhase, sweeping: true });
          if (ctx.state.tdePhase >= 0.98) {
            sweeping = false;
            ctx.hud?.syncState({ sweeping: false });
          }
        }
      }
      const isMotion = Boolean(
        !ctx.state.paused && ((ctx.state.flowSpeed || 0) > 0 || sweeping)
      );
      return { forceComposite: false, dt: ctx.state.paused ? 0 : dt, isMotion };
    },
    extraApi: (_ctx, { selectPreset }) => ({
      applyPreset(id, instant = true) {
        return selectPreset(id, { instant: Boolean(instant) });
      },
      triggerDisruptSweep() {
        app?.handleAction?.('disruptEvolve');
      },
    }),
    onReady: ({ api }) => {
      window.__TDE__ = api;
    },
  });

  if (app) {
    window.__TDE__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
