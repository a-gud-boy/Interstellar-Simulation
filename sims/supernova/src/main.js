/**
 * main.js — Volumetric Supernova Remnant simulator entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { SupernovaCamera } from './engine/CameraController.js';
import { computeSupernovaTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import { createSimApp } from '../../../shared/engine/SimAppShell.js';

async function bootstrap() {
  const app = await createSimApp({
    simId: 'supernova',
    logPrefix: '[Supernova]',
    canvasId: 'supernova-canvas',
    canvasAriaLabel: 'Interactive volumetric multi-scattering supernova remnant simulation',
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
      webgpu: 'Initializing WebGPU & baking 3D multi-scattering nebula volume…',
      webgl2: 'Compiling Sedov-Taylor shock radiative transfer & 3D turbulence…',
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
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName !== 'resetCamera') return false;
      const active = getPresetById(ctx.state.presetId) || PRESETS[0];
      ctx.camera?.flyTo(active.camera, 1.0);
      ctx.renderer?.resetAccumulation(true);
      ctx.pushTelemetry();
      return true;
    },
    onTick: (dt, ctx) => {
      if (!ctx.state.paused) {
        ctx.simTime += dt;
      }
      return { forceComposite: false, dt: ctx.state.paused ? 0 : dt };
    },
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
