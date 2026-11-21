---
trigger: glob
globs: "**/warp-drive-sim/**"
---

# `warp-drive-sim/` (Alcubierre / Natário / Lentz Warp Drive)

## Unique Modules & Shaders
- `src/engine/WarpPhysics.js`: CPU physics source of truth imported by `main.js` and `physics_check.mjs` — `safeTanh`, `safeSech2`, `evalShape`, `evalMetric` (Alcubierre `0`, Natário zero-expansion `1`, Lentz $L_p$ soliton `2`), `computeWarpTelemetry`, `traceRayCPU`.
- `src/engine/WarpCamera.js`: Dual-mode camera — Mode `0` (External Chase orbit, `r ∈ [3.5, 45]`) and Mode `1` (Inside Bridge at `(0, 0, -0.15)` with 360° yaw for aft horizon inspection), toggled via `T` with smooth `frameBlend ∈ [0, 1]` SLERP.
- `src/engine/Presets.js`: 6 presets — `subluminal`, `light_barrier`, `superluminal` (default), `bridge` (`cameraMode: 1`), `thin_wall`, `natario`.
- `src/shaders/warp.frag.js` & `src/shaders/warp.wgsl.js`: Backward ADM null geodesic RK4 (`ds = -dt > 0`), aft causal horizon trapping (`|k| > 28`) + Hawking rim, Doppler blackbody shift + UV/IR stars, 128³ volumetric exotic wall shimmer & dust streaks.
- Debug handle: `window.__WARP_DRIVE__` (`src/main.js`).

## Uniform & Binding Contract
- **Unique Dual-Backend Shared UBO**: Unlike the other three sims, **both** WebGL2 (`layout(std140) uniform WarpUniforms` at UBO binding `0`) and WebGPU (`struct WarpUniforms`) share the exact same **144-byte** (`9 × vec4`, `Float32Array(36)`) all-float layout:
  - `f[0..3]` `resolution_time_frame`: `width`, `height`, `time`, `float(frameIndex)`
  - `f[4..7]` `jitter_fov_mode`: `jitterX`, `jitterY`, `fovY`, `float(cameraMode)`
  - `f[8..11]` `camPos_metric`: `camPos.xyz`, `float(metricType)`
  - `f[12..15]` `camRight_vs`: `right.xyz`, `warpVelocity`
  - `f[16..19]` `camUp_R`: `up.xyz`, `bubbleRadius`
  - `f[20..23]` `camFwd_sigma`: `forward.xyz`, `wallThickness`
  - `f[24..27]` `physicsParams`: `dopplerStrength`, `wallShimmer`, `causticGlow`, `starStreaks`
  - `f[28..31]` `skyParams`: `skyIntensity`, `float(skyMode)`, `skyRotX`, `skyRotY`
  - `f[32..35]` `qualityParams`: `float(quality)`, `flowSpeed`, `frameBlend`, `0.0`
- **Bindings / Units**:
  - WGSL `@binding(0..8)` (9 contiguous): `WarpUniforms`, `uVolumeNoise`, `sVolume`, `uSkyMap`, `uProcSkyMap`, `sSky`, `uBlackbodyLut`, `sLut`, `uBlueNoise`.
  - GLSL UBO slot `0` + texture units `0..4`: `uVolumeNoise`, `uSkyMap`, `uProcSkyMap`, `uBlackbodyLut`, `uBlueNoise`.

## Known Quirks
- Always clamp hyperbolic arguments to `[-15, 15]` (`safeTanh`/`safeSech2`) in CPU, GLSL, and WGSL to prevent NVIDIA `cosh` overflow NaNs at sharp wall thicknesses.
- Metric/shape math changes must remain in 3-way parity across `WarpPhysics.js`, `warp.frag.js`, and `warp.wgsl.js`.
