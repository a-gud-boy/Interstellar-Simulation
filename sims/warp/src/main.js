/**
 * main.js — Alcubierre Warp Drive simulator entrypoint powered by shared/engine/SimAppShell.js.
 */

import { PRESETS, createInitialState, getPresetById } from './engine/Presets.js';
import { WarpCamera } from './engine/CameraController.js';
import { computeWarpTelemetry } from './engine/Physics.js';
import { WebGLRenderer } from './engine/WebGLRenderer.js';
import { WebGPURenderer } from './engine/WebGPURenderer.js';
import { createHUD } from './ui/ControlsHUD.js';
import {
  createSimApp,
  resetRendererAccumulationCompat,
} from '../../../shared/engine/SimAppShell.js';

async function bootstrap() {
  let lastFrameBlend = 0.0;

  const app = await createSimApp({
    simId: 'warp',
    logPrefix: '[WarpDrive]',
    canvasId: 'warp-drive-canvas',
    canvasAriaLabel: 'Interactive relativistic Alcubierre warp drive simulation',
    storageKey: 'warp-drive.backend',
    screenshotPrefix: 'warp-drive',
    presetFlightSec: 1.1,
    presets: PRESETS,
    getPresetById,
    createInitialState,
    createHUD,
    WebGLRenderer,
    WebGPURenderer,
    loadingMessages: {
      webgpu: 'Initializing WebGPU & baking 3D exotic wall volume…',
      webgl2: 'Compiling ADM warp metric geodesics & 3D exotic wall…',
    },
    initState: (state) => {
      lastFrameBlend = state.cameraMode === 1 ? 1.0 : 0.0;
    },
    createCamera: (canvas, camPreset, ctx) =>
      new WarpCamera(canvas, camPreset, {
        cameraMode: ctx.state.cameraMode,
        onResetRequest: () => ctx.handleAction('resetCamera'),
        onModeChange: (mode) => {
          const normalized = Number(mode) === 1 ? 1 : 0;
          if (ctx.state.cameraMode !== normalized) {
            ctx.state.cameraMode = normalized;
            ctx.hud?.syncState({ cameraMode: normalized });
            ctx.pushTelemetry();
          }
        },
      }),
    updateCamera: (camera, dt, state) => {
      camera.update(dt, state.paused ? false : state.autoOrbit);
    },
    buildTelemetry: ({ state, renderer, activeBackend, fpsSmoothed }) => {
      const physicsTel = computeWarpTelemetry(state);
      return {
        ...physicsTel,
        backend: activeBackend,
        fps: fpsSmoothed,
        samples: renderer ? renderer.sampleCount : 0,
        cameraMode: state.cameraMode,
        rendererName: renderer ? renderer.rendererName : 'Unavailable',
      };
    },
    onParamChange: (key, value, { syncUi }, ctx) => {
      const { state, camera, renderer, hud } = ctx;
      if (key === 'cameraMode') {
        const nextMode = Number(value) === 1 ? 1 : 0;
        state.cameraMode = nextMode;
        camera?.setCameraMode(nextMode, false);
        renderer?.resetAccumulation(true);
        if (syncUi && hud) hud.syncState({ cameraMode: nextMode });
        ctx.pushTelemetry();
        return true;
      }
      queueMicrotask(() => ctx.pushTelemetry());
      void value;
      return false;
    },
    onPresetSelect: (preset, { instant }, ctx) => {
      const { state, camera } = ctx;
      const targetMode =
        typeof preset.params?.cameraMode === 'number'
          ? (Number(preset.params.cameraMode) === 1 ? 1 : 0)
          : state.cameraMode;
      state.cameraMode = targetMode;
      if (camera) {
        camera.flyTo(preset.camera, instant ? 0 : 1.1, targetMode);
        if (instant) {
          lastFrameBlend = camera.getCameraMatrices().frameBlend ?? (targetMode === 1 ? 1.0 : 0.0);
        }
      }
      return true;
    },
    onExtraAction: (actionName, _payload, ctx) => {
      const { state, camera, renderer, hud } = ctx;
      if (actionName === 'toggleCameraMode') {
        const nextMode = camera
          ? camera.toggleCameraMode(false)
          : state.cameraMode === 1
            ? 0
            : 1;
        state.cameraMode = Number(nextMode) === 1 ? 1 : 0;
        hud?.syncState({ cameraMode: state.cameraMode });
        renderer?.resetAccumulation(true);
        ctx.pushTelemetry();
        return true;
      }
      if (actionName === 'resetCamera') {
        const active = getPresetById(state.presetId) || PRESETS[0];
        const targetMode =
          typeof active.params?.cameraMode === 'number'
            ? (Number(active.params.cameraMode) === 1 ? 1 : 0)
            : state.cameraMode;
        state.cameraMode = targetMode;
        camera?.flyTo(active.camera, 1.0, targetMode);
        renderer?.resetAccumulation(true);
        hud?.syncState({ cameraMode: state.cameraMode });
        ctx.pushTelemetry();
        return true;
      }
      return false;
    },
    onKeyDown: (e, _ctx, handleAction) => {
      if (e.code === 'KeyT') {
        e.preventDefault();
        handleAction('toggleCameraMode');
        return true;
      }
      return false;
    },
    setStateCustom: (patch, { applyParamChange }, ctx) => {
      const { state, camera, hud } = ctx;
      let cameraUpdated = false;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'camera' || k === 'cameraMode') continue;
        applyParamChange(k, v, { syncUi: true });
      }
      if ('cameraMode' in patch && patch.cameraMode !== undefined) {
        const nextMode = Number(patch.cameraMode) === 1 ? 1 : 0;
        state.cameraMode = nextMode;
        camera?.setCameraMode(nextMode, true);
        cameraUpdated = true;
      }
      if (patch.camera && typeof patch.camera === 'object') {
        const camPatch =
          'cameraMode' in patch && patch.cameraMode !== undefined && patch.camera.cameraMode === undefined
            ? { ...patch.camera, cameraMode: state.cameraMode }
            : patch.camera;
        camera?.setImmediate(camPatch);
        if (typeof camPatch.cameraMode === 'number') {
          state.cameraMode = Number(camPatch.cameraMode) === 1 ? 1 : 0;
        }
        cameraUpdated = true;
      }
      if (cameraUpdated) {
        const camMatrices = camera?.getCameraMatrices();
        if (camMatrices && typeof camMatrices.frameBlend === 'number') {
          lastFrameBlend = camMatrices.frameBlend;
        }
        hud?.syncState({ cameraMode: state.cameraMode });
      }
      return cameraUpdated;
    },
    extraApi: (ctx) => ({
      setCamera(camPatch = {}) {
        ctx.camera?.setImmediate(camPatch);
        if (ctx.camera) {
          const camState = ctx.camera.getState();
          if (typeof camState.cameraMode === 'number') {
            ctx.state.cameraMode = Number(camState.cameraMode) === 1 ? 1 : 0;
            ctx.hud?.syncState({ cameraMode: ctx.state.cameraMode });
          }
          if (typeof camState.frameBlend === 'number') {
            lastFrameBlend = camState.frameBlend;
          }
        }
        if (ctx.renderer && ctx.camera && !ctx.switchingBackend) {
          resetRendererAccumulationCompat(ctx.renderer, true);
          ctx.renderImmediate({ dt: 0 });
          ctx.pushTelemetry();
        }
        return ctx.camera ? ctx.camera.getState() : null;
      },
      toggleCameraMode(instant = true) {
        const snap = Boolean(instant);
        const nextMode = ctx.camera
          ? ctx.camera.toggleCameraMode(snap)
          : ctx.state.cameraMode === 1
            ? 0
            : 1;
        ctx.state.cameraMode = Number(nextMode) === 1 ? 1 : 0;
        ctx.hud?.syncState({ cameraMode: ctx.state.cameraMode });
        if (ctx.renderer && ctx.camera && !ctx.switchingBackend) {
          ctx.renderer.resetAccumulation(true);
          const camMatrices = ctx.camera.getCameraMatrices();
          lastFrameBlend = camMatrices.frameBlend ?? (ctx.state.cameraMode === 1 ? 1.0 : 0.0);
          if (snap) {
            ctx.renderImmediate({ dt: 0 });
          }
        }
        ctx.pushTelemetry();
        return ctx.state.cameraMode;
      },
    }),
    getDiagnosticsExtra: ({ state }) => ({ cameraMode: state.cameraMode }),
    onTick: (dt, ctx) => {
      if (!ctx.state.paused) {
        ctx.simTime += dt;
      }
      return { dt: ctx.state.paused ? 0 : dt };
    },
    renderFrame: (renderer, state, camData, simTime, opts) => {
      if (!opts.forceComposite) {
        const blendChanged = Math.abs((camData.frameBlend ?? 0) - lastFrameBlend) > 1e-6;
        if (blendChanged) {
          lastFrameBlend = camData.frameBlend ?? 0;
          renderer.resetAccumulation(true);
        }
        return renderer.render(state, camData, simTime, {
          ...opts,
          forceComposite: blendChanged,
        });
      }
      return renderer.render(state, camData, simTime, opts);
    },
  });

  if (app) {
    window.__WARP_DRIVE__ = app.api;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
