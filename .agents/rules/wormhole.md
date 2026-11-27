---
trigger: glob
globs: "**/sims/wormhole/**"
---

# `sims/wormhole/` (Morris–Thorne / Ellis Traversable Wormhole)

## Unique Modules & Shaders
- `src/engine/CameraController.js`: Proper-distance coordinate camera (`l ∈ [-35, 35]`, unit direction `n0`, zero-flip `l = 0` throat traversal via `T`) and `computeWormholeTelemetry(state, lVal)`.
- `src/engine/Presets.js`: 6 presets — `interstellar`, `ellis`, `tunnel`, `crossing`, `universe_b`, `einstein`.
- `src/shaders/wormhole.frag.js` & `src/shaders/wormhole.wgsl.js`: Great-circle RK4 null geodesics for James–Thorne $D_{\text{neg}}$ (`metricType = 0`) and Ellis drainhole (`metricType = 1`), dual-universe equirectangular sky sampling + ringed gas giant landmark + optional throat volumetric halo/dust.
- Debug handle: `window.__WORMHOLE__` (`src/main.js`).

## Uniform & Binding Contract
- **WebGPU (`WormholeUniforms`)**: `ArrayBuffer(192)` = **192 bytes** (`12 × vec4`):
  - `f[0..35]` (`vec4f` × 9): resolution/time/frame, jitter/fov/camL, `camN0_tanHalfFov`, `camRight_rho`, `camUp_throatLen`, `camForward_lensingW`, `matter_skyParams`, `skyB_rotA_rotBx`, `rotBy_camR_escapeL_pad`.
  - `i[36..39]` (`modes: vec4i`): `frameIndex`, `metricType`, `quality`, `planetVisible`.
  - `f[40..47]` (`vec4f` × 2): `skyTrigA`, `skyTrigB`.
- **WebGL2**: Exactly 21 discrete value uniforms checked by `physics_check.mjs` (`uCamN0`, `uCamL`, `uMetricType`, `uThroatRadius`, `uThroatLength`, `uLensingWidth`, `uPlanetVisible`, dual `uSkyIntensity{A,B}`, `uSkyRotation{A,B}`, etc.).
- **Bindings / Units**:
  - WGSL `@binding(0..7)` (8 contiguous): uniform, `uVolumeNoise`, `sVolume`, `uSkyMapA`, `uProcSkyMapA`, `uSkyMapB`, `sSky`, `uBlueNoise`.
  - GLSL texture units `0..4`: `uVolumeNoise`, `uSkyMapA`, `uProcSkyMapA`, `uSkyMapB`, `uBlueNoise`.

## Intentional Divergences from Other Sims
- **No Blackbody LUT**: Imports only blue noise (`getBlueNoiseData`, `createBlueNoiseLUT*`) from `../../shared/assets/physicalLuts.js` (omits Planck blackbody LUT creation).
- **Dual-Universe Sky Loader**: Imports `getProceduralSkyPixelsA`, `getExoticNebulaPixelsB`, `createProceduralSkyTextureA*`, `createExoticNebulaTextureB*`, and `loadSkyTextureA*` from `../../shared/assets/skyLoader.js` (Universe A `shared/assets/milkyway_4k.jpg` + procedural fallback, Universe B golden-amber/teal nebula).
- **No `uSkyMode`**: Uses `uPlanetVisible` plus dual skies (`uSkyMapA`/`uProcSkyMapA` for Universe A, `uSkyMapB` for Universe B).
- `WebGPURenderer.js` precomputes `camR` (`evalWormholeR`) and `escapeL` on CPU; keep in sync with `wormhole.frag.js`.
