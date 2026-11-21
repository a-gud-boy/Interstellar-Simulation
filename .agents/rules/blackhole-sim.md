---
trigger: glob
globs: "**/blackhole-sim/**"
---

# `blackhole-sim/` (Gargantua — Kerr–Schild Black Hole)

## Unique Modules & Shaders
- `src/engine/CameraController.js`: Spherical orbit camera (`r ∈ [2.8, 70]`) and `computeKerrTelemetry(spin, radiusEuclidean, elevationRad)` (exact horizon $r_+$, BPT ISCO, ergosphere, gravitational redshift).
- `src/engine/Presets.js`: 6 presets — `gargantua`, `relativistic`, `schwarzschild`, `millers`, `m87`, `quasar`.
- `src/shaders/blackhole.frag.js` & `src/shaders/blackhole.wgsl.js`: 3D Cartesian Outgoing Kerr–Schild ($G=c=M=1$, spin $+Y$, disk $X$-$Z$), ZAMO tetrad, volumetric MHD disk + Novikov–Thorne temperature + CIE-1931 blackbody LUT + Blandford–Znajek polar jets.
- Debug handle: `window.__GARGANTUA__` (`src/main.js`).

## Uniform & Binding Contract
- **WebGPU (`BlackholeUniforms`)**: `ArrayBuffer(304)` = **304 bytes** (`19 × vec4`):
  - `f[0..31]` (`vec4f` × 8): resolution/time/frame, jitter/fov/spin, camPos/relMode, camRight/lensing, camUp/diskTemp, camForward/diskDens, diskParams, jet/skyParams.
  - `i[32..35]` (`modes_pad: vec4i`): `frameIndex`, `skyMode`, `quality`, `0`.
  - `f[36..75]` (`vec4f` × 10): CPU-precomputed `zamoE0..zamoE3`, `camKS_l_2H`, `kerrConsts` (`rPlus`, `rIsco`, `rOuter`, `tanHalfFov`), `rayConsts` (`escapeR`, `captureR`, `maxDiskSlabY`, `rPeak`), `flowConsts`, `optConsts`, `skyTrig`.
- **WebGL2**: Discrete `gl.uniform*` calls (`uResolution`, `uCamPos`, `uCamBasis`, `uSpin`, etc.); computes ZAMO tetrad on GPU inside `blackhole.frag.js`.
- **Bindings / Units**:
  - WGSL `@binding(0..8)` (9 contiguous): uniform, `uVolumeNoise`, `sVolume`, `uSkyMap`, `uProcSkyMap`, `sSky`, `uBlackbodyLut`, `sLut`, `uBlueNoise`.
  - GLSL texture units `0..4`: `uVolumeNoise`, `uSkyMap`, `uProcSkyMap`, `uBlackbodyLut`, `uBlueNoise`.

## Known Quirks
- Because `WebGPURenderer.js` precomputes the 4D Lorentzian Gram–Schmidt ZAMO tetrad and Kerr constants on CPU (`_writeBlackholeUniforms`), any change to ZAMO math, `rPlus`, `rIsco`, `escapeR`, or `maxDiskSlabY` must be updated in **both** `WebGPURenderer.js` (CPU) and `blackhole.frag.js` (GPU).
- `physics_check.mjs` enforces all 9 WGSL bindings, every `BlackholeUniforms` field name, every GLSL uniform binding, and `BLACKBODY_T_MIN`/`MAX` (`800..40000 K`).
