---
trigger: glob
globs: "**/binary-bh-sim/**"
---

# `binary-bh-sim/` (Binary Black Hole Inspiral & GW Lensing)

## Unique Modules & Shaders
- `src/engine/BinaryPhysics.js`: CPU physics source of truth imported by renderers, `main.js`, and `physics_check.mjs` — `computeBinaryState`, `stepBinaryOrbit` (2.5PN Peters–Mathews inspiral + 1PN Padé $\Omega$), `eggletonRocheRadius`, `evalBrillLindquistFields`, `evalCartesianTTGW`, `traceBinaryRay`.
- `src/engine/CameraController.js`: Spherical orbit camera (`r ∈ [5, 95]`) with bidirectional orbital inclination sync.
- `src/engine/Presets.js`: 6 presets — `equal_mass`, `emri`, `eyebrows`, `tidal_bridges`, `pre_merger`, `vacuum`.
- `src/shaders/binary.frag.js` & `src/shaders/binary.wgsl.js`: Brill–Lindquist optical metric + 1PN frame-dragging + pole-free Cartesian TT retarded GW shear/ISW + fractal eyebrow shadows.
- `src/shaders/tidal.glsl.js` & `src/shaders/tidal.wgsl.js`: 256×256 co-rotating tidal hydrodynamics solver (circumbinary disk cavity, spiral shocks, S-shaped tidal bridges, twin mini-disks).
- Debug handle: `window.__BINARY_BH__` (`src/main.js`).

## Uniform & Binding Contract
- **WebGPU `BinaryUniforms`**: `ArrayBuffer(288)` = **288 bytes** (`18 × vec4`):
  - `f[0..31]` (`vec4f` × 8): resolution/time/frame, jitter/fov/phase, camPos/relMode, camRight/lensing, camUp/diskTemp, camForward/diskDens, diskParams (`bridgeIntensity` in `w`), `gw_skyParams`.
  - `i[32..35]` (`modes_pad: vec4i`): `frameIndex`, `skyMode`, `quality`, `0`.
  - `f[36..71]` (`vec4f` × 9): `binaryMass_sep`, `binaryC1_omega`, `binaryC2_gwOmega`, `binaryV1_rH1`, `binaryV2_rH2`, `field_rayConsts`, `flowConsts`, `rotTrig_skyTrig`, `skyY_ringdown`.
- **WebGPU `TidalUniforms`**: `Float32Array(16)` = **64 bytes** (`4 × vec4f`): `sep_q_omega_dens`, `bridge_outer_half_t`, `dt_reset_roche`, `cav_ringdown_pad`.
- **WebGL2**: Discrete uniforms (`>=34` in `binary.frag.js`, `>=15` in `tidal.glsl.js`) + `RGBA16F` ping-pong FBOs for the tidal pass.
- **Bindings / Units**:
  - WGSL binary `@binding(0..9)` (10 contiguous, adding `uTidalField` at `9`); tidal compute `@binding(0..3)` (4 contiguous, writing `texture_storage_2d<rgba16float, write>` at `3`).
  - GLSL texture units `0..5`: `uVolumeNoise`, `uSkyMap`, `uProcSkyMap`, `uBlackbodyLut`, `uBlueNoise`, `uTidalField`.

## Known Quirks
- Tidal texture channel layout is locked across both backends: `R` = surface density $\Sigma$, `G` = thermal/shock temp multiplier ($\ge 1$), `B/A` = lab-frame velocity $(v_x, v_z)$ projected into co-rotating basis.
- Any Brill–Lindquist, 1PN, or Cartesian TT GW formula change must stay consistent across `BinaryPhysics.js`, `binary.frag.js`, and `binary.wgsl.js` (verified by `physics_check.mjs`).
