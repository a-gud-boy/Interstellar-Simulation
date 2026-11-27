---
trigger: glob
globs: "**/sims/supernova/**"
---

# `sims/supernova/` (Volumetric Supernova Remnant & Nebula)

## Unique Modules & Shaders
- `src/engine/Physics.js`: CPU physics source of truth imported by `main.js`, renderers, and `physics_check.mjs` — `SEDOV_CONSTANTS`, `evalSedovTaylor`, `evalHG`, `evalDualHG`, `evalWrenningeMultiScatter`, `evalSpeciesProfile`, `estimateOpticalDepth`, `computeSupernovaTelemetry`.
- `src/engine/CameraController.js`: Origin-safe orbital + interior fly-through camera (`distance ∈ [0, 32]`, `pivot ∈ [-24, 24]`); `W`/`S` flies smoothly through `(0, 0, 0)` with division-free trigonometric right-handed basis (`cross(right, forward) === up`).
- `src/engine/Presets.js`: 6 presets — `crab` (default, True Color), `veil`, `hubble_sho` (Hubble SHO), `bok_globules`, `pulsar_cavity`, `flythrough`.
- `src/shaders/supernova.frag.js` & `src/shaders/supernova.wgsl.js`: Analytic bounding-sphere march (`1.68 * R_shock`), Beer–Lambert step integration, 6 shadow taps + 4-octave Wrenninge + dual-lobe HG scattering, layered PWN/[O III]/Hα/[S II]/Bok zones, `paletteMode` (`0` Hubble SHO, `1` True Color Broadband).
- Debug handle: `window.__SUPERNOVA__` (`src/main.js`).

## Uniform & Binding Contract
- **Shared 160-byte UBO**: Both WebGL2 (`layout(std140) uniform SupernovaUniforms`, slot `0`) and WebGPU (`struct SupernovaUniforms`) share an identical **160-byte** (`10 × vec4<f32>`, `Float32Array(40)`) all-float layout:
  - `f[0..3]` `resolution_time_frame`: `width`, `height`, `time`, `float(frameIndex)`
  - `f[4..7]` `jitter_fov_palette`: `jitterX`, `jitterY`, `fovY`, `float(paletteMode)`
  - `f[8..11]` `camPos_rShock`: `camPos.xyz`, `worldShockRadius`
  - `f[12..15]` `camRight_age`: `right.xyz`, `shockAgeNorm`
  - `f[16..19]` `camUp_turb`: `up.xyz`, `rtTurbulence`
  - `f[20..23]` `camFwd_dust`: `forward.xyz`, `dustOpacity`
  - `f[24..27]` `scatterParams`: `hgAnisotropy`, `starLuminosity`, `filamentContrast`, `cavityGlow`
  - `f[28..31]` `skyParams`: `skyIntensity`, `float(skyMode)`, `skyRotX`, `skyRotY`
  - `f[32..35]` `qualityParams`: `float(quality)`, `expansionSpeed`, `centralTempK`, `float(isProgressive)`
  - `f[36..39]` `zoneParams`: `bokDensity`, `shellThickness`, `emissionGain`, `0.0`
- **Bindings / Units**: WGSL `@group(0) @binding(0..8)` (`u`, `uVolumeNoise`, `sVolume`, `uSkyMap`, `uProcSkyMap`, `sSky`, `uBlackbodyLut`, `sLut`, `uBlueNoise`); GLSL UBO slot `0` + texture units `0..4`.

## Known Quirks
- **WGSL Uniformity Safeguard**: Zero bare `textureSample()` calls allowed in `supernova.wgsl.js` — `uVolumeNoise` and `uBlackbodyLut` strictly use `textureSampleLevel(..., 0.0)` / `textureLod(..., 0.0)`, and equirectangular sky derivatives run in uniform control flow.
- Keep `Physics.js`, `supernova.frag.js`, and `supernova.wgsl.js` in 3-way parity; keep central illuminator & radial norms origin-safe (`r -> 0`).
