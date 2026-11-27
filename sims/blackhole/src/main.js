/**
 * main.js — Gargantua entry point wired to shared SimAppShell.js:
 *  - WebGL2 + WebGPU dual-backend switching, 4K sky loading, HUD & keyboard shortcuts
 *  - Programmatic inspection and verification API on window.__GARGANTUA__
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { CameraController } from './engine/CameraController.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import { createSimApp } from '../../../shared/engine/SimAppShell.js';

async function bootstrap() {
  await createSimApp({
    simId: 'blackhole',
    logPrefix: '[Gargantua]',
    canvasId: 'blackhole-canvas',
    canvasAriaLabel: 'Interactive relativistic black hole simulation',
    storageKey: 'gargantua.backend',
    screenshotPrefix: 'gargantua',
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D volumetric plasma…',
      webgl2: 'Baking 3D volumetric plasma & Kerr geodesics…',
    },
    createCamera: (canvas, initialCamera, ctx) =>
      new CameraController(canvas, initialCamera, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    buildTelemetry: ({ state, camera, renderer, activeBackend, fpsSmoothed }) => {
      const kerr = camera
        ? camera.getRelativisticTelemetry(state.spin)
        : {
            rOverM: 25.0,
            rOverRs: 12.5,
            iscoR: 1.24,
            horizonR: 1.06,
            timeDilation: 1.04,
            orbitalVelocityC: 0.2,
            shadowAngularDeg: 22.0,
          };

      return {
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        rOverM: kerr.rOverM,
        rOverRs: kerr.rOverRs,
        iscoR: kerr.iscoR,
        horizonR: kerr.horizonR,
        timeDilation: kerr.timeDilation,
        orbitalVelocityC: kerr.orbitalVelocityC,
        shadowAngularDeg: kerr.shadowAngularDeg,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onReady: ({ api }) => {
      window.__GARGANTUA__ = api;
    },
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
