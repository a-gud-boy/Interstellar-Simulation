/**
 * main.js — Wormhole Simulator entry point wired to shared SimAppShell.js:
 *  - WebGL2 + WebGPU dual-backend switching, Universe A 4K sky loading, HUD & keyboard shortcuts
 *  - Through-throat traversal action (T / button / window.__WORMHOLE__.traverse)
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { WormholeCamera } from './engine/CameraController.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { loadSkyTextureAWebGL, loadSkyTextureAWebGPU } from '../../../shared/assets/skyLoader.js';
import { createHUD } from './ui/ControlsHUD.js';
import { createSimApp } from '../../../shared/engine/SimAppShell.js';

async function bootstrap() {
  await createSimApp({
    simId: 'wormhole',
    logPrefix: '[Wormhole]',
    canvasId: 'wormhole-canvas',
    canvasAriaLabel: 'Interactive relativistic traversable wormhole simulation',
    storageKey: 'wormhole.backend',
    screenshotPrefix: 'wormhole',
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D portal vortex noise…',
      webgl2: 'Baking 3D portal vortex & Morris–Thorne geodesics…',
    },
    createCamera: (canvas, initialCamera, ctx) =>
      new WormholeCamera(canvas, initialCamera, {
        onResetRequest: () => ctx.handleAction('resetCamera'),
      }),
    attachSky: (targetBackend, targetRenderer, generation, ctx) => {
      ctx.hud.setSkyStatus('Procedural Sky');
      const loader =
        targetBackend === 'webgpu'
          ? loadSkyTextureAWebGPU(
              targetRenderer.device,
              (tex, w, h, m) => targetRenderer.generateMipmaps(tex, w, h, m)
            )
          : loadSkyTextureAWebGL(targetRenderer.gl);

      return loader
        .then((result) => {
          if (generation !== ctx.rendererGeneration || targetRenderer._disposed) {
            if (result?.texture) {
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
            return null;
          }
          targetRenderer.setSkyTexture(result);
          ctx.hud.setSkyStatus(result?.isRealMap ? '4K Milky Way' : 'Procedural Sky');
          if (ctx.state.paused && ctx.camera && !targetRenderer._disposed) {
            ctx.renderImmediate({ dt: 0, isMotion: false });
          }
          return result;
        })
        .catch((err) => {
          if (generation === ctx.rendererGeneration && !targetRenderer._disposed) {
            console.warn('[Wormhole] Async sky texture load failed:', err);
            ctx.hud.setSkyStatus('Procedural Sky');
          }
          return null;
        });
    },
    buildTelemetry: ({ state, camera, renderer, activeBackend, fpsSmoothed }) => {
      const wh = camera
        ? camera.getWormholeTelemetry(state)
        : {
            l: 10.5,
            rOfL: 10.5,
            drdl: 0.9,
            region: 'Universe A',
            throatRadius: state.throatRadius ?? 2.0,
            apparentThroatDeg: 22.0,
          };

      return {
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        l: wh.l,
        rOfL: wh.rOfL,
        drdl: wh.drdl,
        region: wh.region,
        throatRadius: wh.throatRadius,
        apparentThroatDeg: wh.apparentThroatDeg,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onExtraAction: (actionName, _payload, ctx) => {
      if (actionName === 'traverse') {
        ctx.camera?.traverse();
        return true;
      }
      return false;
    },
    onKeyDown: (e, _ctx, handleAction) => {
      if (e.code === 'KeyT') {
        e.preventDefault();
        handleAction('traverse');
        return true;
      }
      return false;
    },
    extraApi: (ctx) => ({
      traverse(duration = 3.2) {
        return ctx.camera ? ctx.camera.traverse(duration) : null;
      },
    }),
    onReady: ({ api }) => {
      window.__WORMHOLE__ = api;
    },
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
