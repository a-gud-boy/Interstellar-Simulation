---
trigger: glob
globs: "**/starflight-sim/**"
---

# `starflight-sim/` (Relativistic Starflight — Aberration, Doppler & Terrell Sky)

## Unique Modules & Shaders
- `src/engine/StarflightPhysics.js`: CPU float64 Special Relativity source of truth imported by `main.js`, renderers, and `physics_check.mjs` — `STARFLIGHT_CONSTANTS`, `rapidityFromBeta`, `kinematicsFromRapidity`, `aberrateShipToRest`, `aberrateRestToShip`, `computeConstantAccelAtProperTime`, `computeBrachistochroneState`, `computeStarflightTelemetry`.
- `src/engine/StarflightCamera.js`: Panoramic bridge observatory camera at `[0, 0, 0]` (`lookYawDeg` full 360°, `lookPitchDeg ∈ [-85, 85]`, `rollDeg ∈ [-90, 90]`, `fovDeg ∈ [8, 95]`) with pole-free right-handed orthonormal basis (`cross(right, forward) === up`) and `flipAftForward()` (`T` key).
- `src/engine/Presets.js`: 6 presets — `sub_rel` (`0.50c`), `headlight_90` (default, `0.90c` Headlight Cone), `uv_milkyway` (`0.995c` UV Milky Way), `cmb_glow` (`0.9999c` CMB Glow), `aft_redshift` (Aft Redshift View at `180°`), `brachistochrone` (`1g` Brachistochrone Cruise).
- `src/shaders/starflight.frag.js` & `src/shaders/starflight.wgsl.js`: Cancellation-free Special Relativistic Lorentz null-ray aberration + exact Doppler factor $D = [\gamma(1 - \beta \cos\theta')]^{-1}$, CIE-1931 Planck blackbody spectral shift across 4K Milky Way + UV/IR procedural star bands + Planck-mottled CMB shell, Penrose–Terrell rotated 3D periodic navigation rings & beacon stations, and 128³ volumetric interstellar hydrogen dust streaks.
- Debug handle: `window.__STARFLIGHT__` (`src/main.js`).

## Uniform & Binding Contract
- **Shared 176-byte UBO**: Both WebGL2 (`layout(std140) uniform StarflightUniforms`, slot `0`) and WebGPU (`struct StarflightUniforms`) share an identical **176-byte** (`11 × vec4<f32>`, `Float32Array(44)`) all-float layout:
  - `f[0..3]` `resolution_time_frame`: `width`, `height`, `simTime`, `float(frameIndex)`
  - `f[4..7]` `jitter_fov_prog`: `jitterX`, `jitterY`, `fovY`, `isProgressive` (`0.0` or `1.0`)
  - `f[8..11]` `camRight_beta`: `right.xyz`, `beta` (`[0, 0.9999996]`)
  - `f[12..15]` `camUp_gamma`: `up.xyz`, `gamma` (`>= 1.0`)
  - `f[16..19]` `camFwd_oneMinusBeta`: `forward.xyz`, `oneMinusBeta` (`exp(-η)/cosh(η)`)
  - `f[20..23]` `flightKinematics`: `flightDir` (`+1.0` or `-1.0`), `flightPosZ`, `rapidity`, `dopplerStrength`
  - `f[24..27]` `spectralParams`: `cmbVisibility`, `starDensity`, `uvIrGain`, `aberrationStrength` (`1.0` Exact SR, `0.0` Rest Frame)
  - `f[28..31]` `foregroundParams`: `geometryVisibility`, `dustDensity`, `dustStreakScale`, `properAccelG`
  - `f[32..35]` `skyParams`: `skyIntensity`, `float(skyMode)`, `skyRotX`, `skyRotY`
  - `f[36..39]` `qualityParams`: `float(quality)`, `properTimeYr`, `coordTimeYr`, `visualPace`
  - `f[40..43]` `extraParams`: `beamingGain`, `cmbTempScale`, `0.0`, `0.0`
- **Bindings / Units**: WGSL `@group(0) @binding(0..8)` (`u`, `uVolumeNoise`, `sVolume`, `uSkyMap`, `uProcSkyMap`, `sSky`, `uBlackbodyLut`, `sLut`, `uBlueNoise`); GLSL UBO slot `0` + texture units `0..4`.

## Known Quirks
- **WGSL Uniformity Safeguard**: Zero bare `textureSample()` calls allowed in `starflight.wgsl.js` — `uVolumeNoise` and `uBlackbodyLut` strictly use `textureSampleLevel(..., 0.0)` / `textureLod(..., 0.0)`, `uBlueNoise` uses `textureLoad` / `texelFetch`, and equirectangular sky derivatives run in uniform control flow via `textureSampleGrad` / `textureGrad`.
- **Cancellation-Free High-γ Math**: At $\eta \to 7.65$ ($\gamma \approx 1050$), $1 - \beta$ MUST be computed as $\exp(-\eta) / \cosh(\eta)$ and $1 - \mu'$ in the forward hemisphere as $(n_x^2 + n_y^2) / (1 + \mu')$ to avoid catastrophic float32/float64 cancellation.
- **Motion Freeze on Pause**: `main.js` freezes `simTime`, `properTimeYr`, and `flightPosZ` when `state.paused === true`, enabling clean 128-sample progressive accumulation.
