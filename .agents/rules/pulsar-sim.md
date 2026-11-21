---
trigger: glob
globs: "**/pulsar-sim/**"
---

# `pulsar-sim/` (Magnetar & Millisecond Pulsar Magnetosphere)

## Unique Modules & Shaders
- `src/engine/PulsarPhysics.js`: CPU relativistic source of truth imported by `main.js`, renderers, and `physics_check.mjs` — `PULSAR_CONSTANTS`, `computeSurfaceRedshift`, `computeApparentRadius`, `computeMaxVisibleAngle`, `computeVisibleSurfaceFraction`, `computeLightCylinder`, `computeSpinParameters`, `integrateSchwarzschildDeflection`, `computePulsarTelemetry`.
- `src/engine/PulsarCamera.js`: Safe-distance orbital camera (`distance ∈ [2.2, 36.0]` $R_*$) with pole-free division-free right-handed orthonormal basis (`cross(right, forward) === up`).
- `src/engine/Presets.js`: 6 presets — `crab` (default, Crab-like Young Pulsar), `millisecond` (Millisecond Recycled Pulsar), `magnetar` (Ultra-Compact Magnetar), `polar_cap` (Polar Cap View), `edge_on` (Edge-On Lighthouse), `pwn_torus` (Torus & Jet PWN).
- `src/shaders/pulsar.frag.js` & `src/shaders/pulsar.wgsl.js`: 3D Outgoing Kerr–Schild null geodesics with explicit mass $M = u_c$ (`R_* = 1.0`), secant/bisection crust root refinement revealing >50% of the crust (`lensingMode` `1` GR Curved vs `0` Flat Space), relativistic Doppler/gravitational shift on co-rotating crust + polar caps + molten magnetar tectonic cracks, twisted oblique dipole pair-plasma loops (`L <= rLightCylVis`), sweeping lighthouse beams with Deutsch phase retardation, and equatorial PWN torus + helical polar jets.
- Debug handle: `window.__PULSAR__` (`src/main.js`).

## Uniform & Binding Contract
- **Shared 176-byte UBO**: Both WebGL2 (`layout(std140) uniform PulsarUniforms`, slot `0`) and WebGPU (`struct PulsarUniforms`) share an identical **176-byte** (`11 × vec4<f32>`, `Float32Array(44)`) all-float layout:
  - `f[0..3]` `resolution_time_frame`: `width`, `height`, `time`, `float(frameIndex)`
  - `f[4..7]` `jitter_fov_lensing`: `jitterX`, `jitterY`, `fovY`, `lensingStrength` (`1.0` GR curved, `0.0` flat)
  - `f[8..11]` `camPos_compactness`: `camPos.xyz`, `compactness` ($u_c = M/R \in [0.12, 0.30]$)
  - `f[12..15]` `camRight_spinA`: `right.xyz`, `spinA` ($\chi \cdot M$)
  - `f[16..19]` `camUp_betaEq`: `up.xyz`, `betaEq` (equatorial $v/c \in [0, 0.38]$)
  - `f[20..23]` `camFwd_phase`: `forward.xyz`, `spinPhase` (rad around $+Y$)
  - `f[24..27]` `magnetParams`: `obliquityRad`, `twistShear`, `rLightCylVis`, `plasmaDensity`
  - `f[28..31]` `beamPwnParams`: `beamIntensity`, `pwnVisibility`, `polarCapTempK`, `crustTempK`
  - `f[32..35]` `skyParams`: `skyIntensity`, `float(skyMode)`, `skyRotX`, `skyRotY`
  - `f[36..39]` `qualityParams`: `float(quality)`, `spinVisualSpeed`, `float(isProgressive)`, `surfaceRedshiftZ`
  - `f[40..43]` `extraParams`: `beamConeHalfAngle`, `magnetarCrackGlow`, `pwnJetPower`, `0.0`
- **Bindings / Units**: WGSL `@group(0) @binding(0..8)` (`u`, `uVolumeNoise`, `sVolume`, `uSkyMap`, `uProcSkyMap`, `sSky`, `uBlackbodyLut`, `sLut`, `uBlueNoise`); GLSL UBO slot `0` + texture units `0..4`.

## Known Quirks
- **WGSL Uniformity Safeguard**: Zero bare `textureSample()` calls allowed in `pulsar.wgsl.js` — `uVolumeNoise` and `uBlackbodyLut` strictly use `textureSampleLevel(..., 0.0)` / `textureLod(..., 0.0)`, and equirectangular sky derivatives run in uniform control flow via `textureSampleGrad` / `textureGrad`.
- **Spin Freeze on Pause**: `main.js` advances `state.spinPhase` only while `!state.paused` and passes `isMotion` so pausing locks `spinPhase` and triggers seamless 128-sample progressive accumulation.
