# Interstellar Simulation — Full-Stack Performance Roadmap

**Prerequisite:** Complete [`docs/ORGANIZATION_ROADMAP.md`](./ORGANIZATION_ROADMAP.md) (Phases O1–O6) first. This roadmap assumes single-source canonical `.wgsl` files (`sims/<id>/src/shaders/*.wgsl` + `shared/shaders/*.wgsl` synced by `scripts/sync-wgsl.mjs`), composable `SharedWebGLPostPipeline.js` / `SharedWebGPUPostPipeline.js` / `SimAppShell.js`, and modularized `desktop/src/ui/`.  
*(Legacy pre-O4 paths such as `blackhole-sim/` map 1:1 to `sims/blackhole/`, `binary-bh-sim/` → `sims/binary/`, `warp-drive-sim/` → `sims/warp/`, etc.)*

---

## Locked Performance Policy & Baseline Benchmarks

### Policy Decisions
| Lever | Locked Policy | Rationale |
| :--- | :--- | :--- |
| **HDR Target Precision** | **Hybrid HDR:** `R11F_G11F_B10F` / `rg11b10ufloat` (4 B/px) for `scene_rt`, bloom mip chain, and anamorphic targets; keep `taa_rts[0..1]` and `binary` `tidalFbos`/`tidal_tex` strictly on `RGBA16F` (8 B/px) | Saves ~50% VRAM/bandwidth across most HDR passes while preventing 5-bit blue quantization in 128-sample cinema stills and preserving signed `.ba` tidal velocities |
| **Desktop Resolution Cap** | Cap default Desktop render DPR at **`1.5`** (matching web `MAX_DPR = 1.5`), keeping `egui` swapchain crisp at native physical DPR | Cuts 2× Retina/4K raymarch pixels by **1.78×–4.0×** with override still available via resolution scale / CLI |
| **Interactive Drag Scaling** | Add optional **`0.75×` interactive drag downscaling** in `SimAppShell` / Desktop, snapping immediately back to `1.0×` at rest | **1.78×** faster orbit/pan responsiveness with zero loss at rest for progressive accumulation |
| **Supernova Volume Res** | Keep `sims/supernova/` volumetric nebula at **full resolution** (reject half-res upsampling) | Preserves razor-thin Rayleigh–Taylor filaments while still cutting 2×–4× cost via math/early-out/CPU fixes |

### Verified Baseline Metrics (Commit `a9d0013`)
- **Web Synchronous Startup CPU Synthesis** (Node.js 22 local benchmark → slower-CPU audit baseline):
  - `getBlackbodyData(512)`: **11.5 ms** (local) / **44.0 ms** (audit)
  - `getBlueNoiseData(128)`: **178.1 ms** (local) / **907.9 ms** (audit)
  - `getProceduralSkyPixelsA(2048, 1024)`: **1,101.7 ms** (local) / **3,920.6 ms** (audit)
  - `getExoticNebulaPixelsB(2048, 1024)`: **990.8 ms** (local) / **3,028.2 ms** (audit)
- **Desktop 4K (`3840×2160`) `PostPipeline` VRAM:** **275.51 MiB** total (`239.91 MiB` in 14 `Rgba16Float` targets + `35.60 MiB` in `Rgba8Unorm`).
- **Desktop Permanent CPU RAM Leak (`assets/sky.rs`):** **48.0 MiB** pinned forever in `'static OnceLock`s (`32 MiB` 4K sky + `8 MiB` Sky A + `8 MiB` Sky B), plus **10.67 MiB** VRAM for `exotic_sky_b` even outside `wormhole`.

> [!IMPORTANT]
> **Session Scoping & Parity (`AGENTS.md`):** Keep `shared/`, `desktop/`, and each `sims/<id>/` pass in scoped PRs/sessions. Whenever editing `.wgsl`, edit the canonical raw `.wgsl` file and run `node scripts/sync-wgsl.mjs --write` so WebGPU and Desktop stay 100% locked in step alongside WebGL2 `.frag.js`/`.glsl.js` edits.

---

## Phase P1 — Startup Elimination & Shared Asset Pipeline (`shared/assets/` & `shared/shaders/`)

**Target Impact:** Eliminate **~1.3–7.9 seconds** of synchronous main-thread boot freeze across all 7 web simulators.

### Deliverables
- [x] **Pre-Bake Static Blue-Noise & Blackbody LUTs (`shared/assets/physicalLuts.js`):**
  - Pre-bake the deterministic `128×128×4` toroidal void-and-cluster blue-noise table (compact ~40–64 KB lossless asset or precomputed typed-array payload) and 512×1 blackbody LUT instead of running `generateBlueNoiseChannel` + Planck integration synchronously on boot.
  - Eliminates **~190–950 ms** synchronous JS stall on every simulator boot with bit-exact LUT parity.
- [x] **Lazy Procedural Sky + GPU Procedural Sky Baker (`shared/assets/skyLoader.js`):**
  - Do **not** synthesize `2048×1024` procedural skies on boot when `skyMode: 0` (`milkyway_4k.jpg`) is active. Bind a 1×1 black placeholder texture to `uProcSkyMap` / `uProcSkyMapA` while `milkyway_4k.jpg` fetches (~50 ms).
  - Synthesize Universe A (`proc_sky_a`) and Universe B (`exotic_sky_b` for `wormhole`) lazily on first switch to procedural sky (or JPEG fetch failure) using a **GPU fullscreen/compute bake pass** (<2 ms on GPU vs 1,000–3,900 ms on JS CPU).
  - *Contract Note:* Ensure `wormhole` Universe A/B fallback works cleanly if `uProcSkyMapA` starts as a 1×1 placeholder until `milkyway_4k.jpg` arrives or procedural bake triggers.
- [x] **Branchless 3D Noise Bake (`shared/shaders/noise_bake.wgsl` + `shared/shaders/common.glsl.js`):**
  - Replace the 16-branch `if/else if` (`common.glsl.js:58-73`) and 16-case `switch` (`noise_bake.wgsl`) in `gradFromHash` (invoked `104×` per voxel across `128³ = 2.1M` voxels) with branchless bit-manipulated Perlin edge gradients / constant lookup array, preserving exact GLSL ↔ WGSL ↔ Desktop parity.

### Verification
- `node scripts/sync-wgsl.mjs --check && node scripts/run-tests.mjs --physics`
- Verify cold-load time-to-first-frame drops under ~250 ms in `sims/blackhole/` and `sims/wormhole/` via Chrome QA.

---

## Phase P2 — Shared HDR Post-Processing, Hybrid Precision & Web Engine Hygiene

**Target Impact:** ~40%–50% lower HDR scene/bloom VRAM & bandwidth in WebGL2, 20%–40% faster HDR post-processing, zero per-frame layout reads/GC churn, and 1.78× faster interactive drag. Implemented **once** inside Phase O5's shared modules.

### Deliverables
- [x] **Hybrid HDR Precision (`SharedWebGLPostPipeline.js` + `SharedWebGPUPostPipeline.js`):**
  - Update WebGL2 `_detectHdrFboFormat()` candidate order to test `gl.R11F_G11F_B10F` **before** `gl.RGBA16F` (gated by `EXT_color_buffer_float`, keeping `RGBA16F` fallback) for `sceneFbo`, `bloomDownFbos`, `bloomUpFbos`, and `anamorphicFboA/B`.
  - Keep `taaFbos[0..1]` (`taaRts[0..1]` on WebGPU as well) explicitly on **`RGBA16F` / `rgba16float`** so 128-sample progressive accumulation never quantizes dark skies in the 5-bit Blue mantissa.
  - **Binary BH Guardrail:** Keep `sims/binary/src/engine/WebGLRenderer.js` `tidalFbos` explicitly allocated as `RGBA16F` (never derived from the scene `R11F_G11F_B10F` spec), because `tidal` stores signed 2D velocities in `.ba`.
- [x] **Shared Post Shader Fixes (`shared/shaders/post_*.wgsl` + `shared/shaders/post.glsl.js`):**
  - **WGSL TAA Center Double-Fetch:** Replace `select(compressHdr(sRaw), curComp, dx == 0 && dy == 0)` (`post_taa.wgsl`) with `if (dx == 0 && dy == 0) { s = curComp; } else { ... }` (`textureSampleLevel` does not require uniform control flow; saves 1 full-res HDR fetch/px).
  - **WGSL Anamorphic OOB Fetch Order:** Move `if (uv.x < 0.0 || uv.x > 1.0) { continue; }` **before** the `textureSampleLevel` calls in `post_anamorphic.wgsl`.
  - **Anamorphic `const` Symmetric Folding:** Fold symmetric `±i` taps and precompute Lorentzian/Gaussian falloff weights and coating tints as compile-time `const` arrays in both GLSL and WGSL (eliminates **all 67 `exp()` calls/px** + 25 `smoothstep()`/px).
  - **Guardrail — Do NOT Shortcut Vertical Stabilize with Bilinear:** Keep the explicit 3-tap vertical `isolateHighlights()` in Pass 0. `isolateHighlights()` is nonlinear (soft-knee + clamp + NaN guard); bilinear averaging *before* thresholding alters highlight energy, dims 1 px lines, and leaks NaNs across neighbors.
  - **Composite Edge CA + Branching `pow()`:** Guard R/B chromatic aberration fetches behind `if (r2 > 0.04)` in `post_composite.wgsl` and `COMPOSITE_FRAG` (saves 2 full-res HDR fetches across the center viewport). Only fold `agxToneMap` `pow(2.2)` with `linearToSrgb` `pow(1/2.4)` inside an explicit `if (c >= 0.0031308)` branch (branchless `mix()` would still execute `pow(val, 2.2)` for the low toe).
  - **Optional Bloom Upsample Target Elimination:** Evaluate running Anamorphic *before* bloom upsampling and blending upsample passes directly into `bloomDownRts[i]` via hardware additive blend (`ONE, ONE`), eliminating 5 HDR render targets and 5 `uHighTex` fetches/frame (verify blend support on `rg11b10ufloat` and `EXT_color_buffer_float`).
  - **Remove Redundant Downsample Sanitize:** Drop per-tap NaN/Inf bitchecks in `BLOOM_DOWNSAMPLE` (inputs are already sanitized and clamped in `BLOOM_PREFILTER`).
- [x] **Shared Engine & Camera Hygiene (`SimAppShell.js`, `SharedWeb*PostPipeline.js`, `BaseCamera.js`):**
  - Remove `this.resize()` from `render()`; drive resize + `_resizeDirty` exclusively from `ResizeObserver` in `SimAppShell.js`, and cache `getBoundingClientRect()` inside `BaseCamera.js`.
  - Hoist all 13 invariant WebGPU post `queue.writeBuffer` calls and static WebGL2 sampler/bloom uniforms out of the per-frame path into `resize()` + tuning change.
  - Eliminate per-frame JS array/object churn in `BaseCamera.js` (reuse preallocated `Float32Array`s, skip `_recomputeBasis()` when idle) and replace O(N) `frameTimestamps.shift()` with a fixed ring buffer in `SimAppShell.js`.
  - Add optional **`0.75×` interactive drag resolution scaling** in `SimAppShell.js` (active during pointer/key motion, snapping immediately back to `1.0×` at rest for crisp progressive accumulation).
  - Add an optional **"Reduced Glass" HUD toggle** (disabling or lowering `.glass-surface` `backdrop-filter: blur(10px)` in `shared/ui/base.css` during active camera motion or low-power mode).

### Verification
- `node scripts/sync-wgsl.mjs --check && node scripts/run-tests.mjs --physics`
- Run `browser_qa.mjs` & `firefox_qa.mjs` across `blackhole`, `binary`, and `pulsar` to verify zero bloom/TAA/CA visual regressions and WebGL2 `tidalFbos` parity.

---

## Phase P3 — Per-Simulator GPU & Physics Passes

Execute **one simulator directory per session/PR** (`AGENTS.md` Hard Invariant #2), updating `.frag.js` + canonical `.wgsl` + `scripts/sync-wgsl.mjs --write` together. Ordered highest-to-lowest ROI:

### P3.1 `sims/blackhole/` — WebGL2 Parity + Shared Shader Cleanup (2×–3× WebGL2 FPS)
- [x] **Close WebGL2 Parity Gap in `blackhole.frag.js` & `WebGLRenderer.js`:**
  - Port CPU-precomputed ZAMO orthonormal tetrad (`e0..e3`) + `rIsco`, hybrid RK2 midpoint (`r >= 6.5 * rPlus`, `155/240/360` step tiers, `farOut` step cap `14.0`), hoisted per-segment `gSeg` (17 → 4 `pow()`), `lowDetail` 3D noise skip, `a == 0` Schwarzschild fast path, and early exit (`if (!escaped) return vec3(0.0);` *after* uniform-flow `dUVdx`/`dUVdy` derivatives and *before* `textureGrad` sky fetches).
- [x] **Optimize Both Backends (`blackhole.frag.js` + `blackhole.wgsl`):**
  - Compute `logR` once and pass into `sampleDiskPlasmaNoise`; reuse `exp2(e * log2R)` instead of repeated `pow()`.
  - Reuse `k2`'s `KSFields` in RK2 mode instead of re-calling `evalKSFields(midPos)`.
  - Fix WGSL eager `select(evalKerrR(sPos, a2), rMid, nSub == 1)` (`if (nSub == 1) { sR = rMid; } else { ... }`).
  - Skip second flow-advection sample when `orbitSpeed == 0.0`, and gate `laneFine`/`laneMicro` behind `!lowDetail`.
  - Cache `#ctrl-spin` element in `sims/blackhole/src/ui/ControlsHUD.js` (remove per-85 ms `document.getElementById('ctrl-spin')`).

### P3.2 `sims/warp/` — Hyperbolic Hoisting & Dust Decoupling (2.5×–6× FPS)
- [x] **Algebraic `sech²` & Hoisted Shape Invariants (`warp.frag.js` + `warp.wgsl`):**
  - Replace `safeSech2(a)` / `safeSech2(b)` with exact `1.0 - ta * ta` and `1.0 - tb * tb` (eliminates **100% of `cosh()`** calls).
  - Precompute `tanhSR = safeTanh(sigma * R)`, `invDenom2`, `invDenom1`, and `wallStep` once outside the ray loop (eliminates up to 2,880 `tanh` + 5,760 divisions/px).
  - Skip `s.d2f` calculation when `metricType == 0` (Alcubierre).
  - Delete dead `evalLentzR` and constant `sampleBlackbody(5800.0)` lookup.
- [x] **Volumetric Sub-Stepper Cleanup:**
  - Hoist the empty-wall guard (`max(|k1.t00|, |k4.t00|) <= 1e-5 && max(|k1.theta|, |k4.theta|) <= 1e-3`) **above** the `vsIdx` volumetric loop when dust isn't active (`evalWallShimmer` already early-outs internally, so hoisting skips the 5× sub-loop setup).
  - Decouple `evalDustStreak` from the 5× sub-stepper — evaluate **once per RK4 step** (5× fewer dust 3D fetches), reuse `length(sPos)`, and hoist `advZ`, `bridgeAtten`, `scaleGain`, and `speedGain`.
- [x] **Safe Flat-Space Jump & Hybrid RK2 (With Physics Guardrails):**
  - **Guardrail 1 (Lentz):** Restrict spherical analytic shell-entry jumps to `metricType != 2` (Lentz uses a `p = 1.38` superellipsoid, not a sphere).
  - **Guardrail 2 (Dust Shell):** Interstellar dust streaks occupy `r ∈ (1.04R, 2.85R)` — do not skip dust integration when jumping past outer flat vacuum.
  - **Guardrail 3 (External Frame Inside Bubble):** Inside `r < R - 4/sigma` when `frameBlend < 1.0`, the true ADM coordinate velocity is `-khat + m.beta` (`beta.z = -v_s`), not flat `rayDir`.
  - Switch from RK4 to 2-stage RK2 midpoint in weak outer wall tails (`|rEff - R| > 2.0 / sigma`) where `gradBeta` is tiny.

### P3.3 `sims/supernova/` — Full-Res Radiative Transfer & CPU Fix (2×–4× FPS)
- [x] **Eliminate Wasted 64-Step CPU Optical Depth (`WebGLRenderer.js` + `WebGPURenderer.js`):**
  - Call `evalSedovTaylor(state.shockAge)` directly inside `_writeSupernovaUniforms()` instead of calling `computeSupernovaTelemetry(state)` (which runs 64-step `estimateOpticalDepth` with 192 `Math.exp()` calls/frame only to discard `opticalDepth`).
- [x] **Shader Loop Invariants & Collinear Shadow Rays (`supernova.frag.js` + `supernova.wgsl`):**
  - Hoist `sampleBlackbody(clamp(centralTempK * 0.28, ...))` and the `paletteMode` color triplet (`cOIII`, `cHa`, `cSII`) above the primary march loop.
  - Share collinear `rHat`, the dipole asymmetry term `0.08 * (rHat.x * rHat.y - 0.55 * rHat.z)`, and `rTap = r * (1.0 - tapFrac[st])` across all 6 shadow taps (eliminates up to **864 `sqrt` + 864 divisions/px** while preserving per-tap `n1.r` warp in `asym`).
  - **Shadow Early-Out Guardrails:** Keep existing `vs.sigmaScat > 1e-4` and `starLuminosity > 1e-3` guards; add inner-cavity shadow skip only for `u < 0.35` (safe at high `rtTurbulence`); break inside the 6-tap shadow loop only at **`tauShadow > 40.0`** (do **not** use `12.0` — Wrenninge octave 3 uses `bPow = 0.48^3 ≈ 0.1106`, retaining ~26.5% transmission at `tau = 12.0`).
  - Keep volumetric nebula at **full resolution** (per policy — preserves thin Rayleigh–Taylor filaments).

### P3.4 `sims/starflight/` — Early-Outs, Uniform Derivatives & Safe Asteroid SDF (1.5×–3.5× FPS)
- [x] **CMB & Star-Layer Pruning (`starflight.frag.js` + `starflight.wgsl`):**
  - Guard `evalCmbShell` 3-tap 3D noise fetch at function entry with:
    `if (2.7255 * max(cmbTempScale, 0.0) * doppler * 1.07 < 45.0) return vec3(0.0);`
    (`max(cmbTempScale, 0.0)` is mandatory so `cmbTempScale > 1.0` stays accurate).
  - Hoist `exp(-dir.y * dir.y * 16.0)` once outside the 10 star layers.
  - Guard Brown Dwarf layers (class 1) with `if (uvIrGain > 0.001 && doppler > 1.30)` and UV O/B layers (class 2) with `if (doppler > 0.018 && doppler < 2.80)` (noting the `0.018` lower aft-view cutoff).
  - Hoist `dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0))` (computed 3×/px), hoist `glintAftFade`, and raise corridor volume `tStart` from `0.8` to `4.2` (`rangeMask` is 0 for `tMid <= 4.2`).
- [x] **Sky Occlusion Ordering (With Derivative Guardrail):**
  - Run `traceCorridorGeometry` before sky evaluation, **but unconditionally compute `dir`, `uv1`, `uv2`, and `dFdx`/`dFdy` (`dpdx`/`dpdy`) in uniform control flow first**, then gate sky texture fetches, star layers, and CMB behind `if (!opaqueHit)` (prevents WGSL validation errors and WebGL2 2×2 quad mip-seams).
- [x] **Asteroid & Ring Gate SDF Optimization (With Displacement Guardrail):**
  - Precompute each asteroid's 3×3 rotation matrix, `axes`, and `seedOff` **once per cell before `marchObject`** (eliminates up to 57× `hash33f` + 342 `sin/cos` per hit pixel with 100% exactness).
  - **Coarse Bound Guardrail:** Worst-case outward displacement in `sdFacetedAsteroid` is **`+0.373`** (`broadDisp` +0.271, `smallRim` +0.022, `heroCraters` +0.08). Use **`if (dEllip > 0.42) return dEllip - 0.38;`** (do **not** use `0.35 / -0.15`, which tunnels silhouettes).
  - Gate `sdRingGate` 24-rib `atan/cos/sin` behind `abs(rXY - 6.35) <= 0.85` (mathematically exact).
- [x] **CPU / HUD Cleanup:**
  - Compute `computeStarflightTelemetry` once per frame in `1g Accel` mode (`main.js` + renderer).
  - Gate `#ctrl-rapidity` slider DOM writes on `drawerOpen` (syncing latest rapidity when `setDrawerOpen(true)` opens the drawer) and cache `btnFlipView` `aria-pressed` state.

### P3.5 `sims/pulsar/` — WGSL Eager `select()`s & Chebyshev Magnetosphere
- [x] **Eliminate WGSL Hot-Loop Eager `select()`s (`pulsar.wgsl`):**
  - Replace eager `select(2.0, evalKerrR(posNext, a2), maybeHit)` (every geodesic step) and `select(..., evalKerrR(samplePos, a2) > 1.01, ...)` (every volumetric substep), plus eager `atan2`, `exp`, and `pow` `select()` calls, with `if` branches.
- [x] **Magnetosphere Transcendentals (`pulsar.frag.js` + `pulsar.wgsl`):**
  - Replace `needBeam` `atan(sinB, absCosB)` cone check with hoisted `cos(beamConeHalfAngle)` (using existing `rhoM2`) and `cos(8.0 * phiB)` with 3 Chebyshev complex doublings `(c2,s2) -> (c4,s4) -> (c8,s8)` (zero `atan`/`cos`).
  - Replace `inLoops` `pow(max(r - 1.0, 1e-5), 1.55)` with `(r - 1.0) * sqrt(max(r - 1.0, 0.0))` (keeping the ambient haze term intact).
  - Hoist `simTime * (0.35 + 0.45 * spinVisualSpeed)` above the ray loop.
  - Optional additive saturation early-out (`min(radiance) >= 36.0`): **must** set `hitStar = true; shadeStar = false;` (or `saturated = true` with `escFlag = 0.0`) so mid-orbit velocity does not pollute adjacent sky quad derivatives.
- [x] **CPU:** Compute `computePulsarTelemetry` once/frame instead of 2–3×; eliminate per-frame signature array allocations. *(Intentionally leave `PulsarUniforms` at 176 bytes / 11 `vec4`s unless explicitly expanding `physics_check.mjs` contract, as per-pixel ZAMO tetrad is <1% frame time.)*

### P3.6 `sims/wormhole/` — Sky Bandwidth, Safe Throat & Saturn Cull
- [x] **Branch Sky Fetches (`wormhole.frag.js` + `wormhole.wgsl`):**
  - Keep `dpdx`/`dpdy` (`dFdx`/`dFdy`) in uniform control flow *above* `if (onSideA)`, then move `uSkyMapA`/`uProcSkyMapA` vs `uSkyMapB` `textureGrad`/`textureSampleGrad` calls **inside** `if (onSideA) { ... } else { ... }` (cuts 50%–67% sky bandwidth while preserving the `uProcSkyMapA` binding asserted by `physics_check.mjs`).
- [x] **Hoist Uniforms & Clean WGSL `select()`s:**
  - Replace eager WGSL `select()` fallbacks (`tan`, `atan`, `log`, 8 `sin/cos`) with uniform `if` guards (or direct uniform reads) and hoist the matching fields in `sims/wormhole/src/engine/WebGLRenderer.js`.
  - Delete dead `evalMetricR(lSub)` in `wormhole.frag.js` and reuse `rNext`/`kNext` across matter substeps.
- [x] **Safe Throat Analytic Step & Weak-Exterior RK2:**
  - Use exact analytic cylindrical throat step **only** when `abs(l) <= a && abs(l + h * pl) <= a` (exiting step that overshoots `±a` falls back to RK4).
  - Gate outer-field RK2 midpoint on **both** `r > 2.5 * rho` (or `3.0 * rho`) **and** `distEdge > 2.5 * curvScale` (because on `Interstellar`, `2.5 * curvScale = 0.875` still sits inside the strong-lensing Einstein ring).
- [x] **Landmark Culling:**
  - Guard Sun `atan2` + 2 `exp()` with `if (sunCos > 0.75)` and guard Saturn globe + ring plane intersection with `if (dot(dir, saturnDir) > 0.985)` (skips ~99% of Side A pixels).

### P3.7 `sims/binary/` — Cavity Reuse, Tidal Bezier & Safe GW Stepping
- [x] **Cavity Field Reuse (No Non-Existent Mips):**
  - Reuse already-fetched `sig0` (as `p0Rot` inside `skipSub`) and `p1Rot` across consecutive steps to cut `uTidalField` fetches without new textures (**guardrail:** do **not** use `textureLod(..., 2.0)` — `uTidalField` is single-mip `mipLevelCount: 1`).
- [x] **Safe GW Stepping & Blackbody Approximation:**
  - Keep `gwLim` active in the far field (at `R = 35`, `decay = 24%` and `gwLim = 2.29 M` is near Nyquist for `pre_merger` `λ = 7.48 M` — relaxing it aliases GW ripples); only skip `gwLim` when `rCom <= gwc.r0` and gate 1PN frame-dragging `Bg` cross products to `phi > 0.012`.
  - Replace `pow(tr, 1.85)` with `(tr * tr) * inverseSqrt(sqrt(sqrt(tr)))` (`tr^1.875`, <3.5% error — do **not** use `tr * tr`, which over-brightens by +23% at `tr = 4.0`).
- [x] **GLSL Parity, WGSL Eager `select()` & Tidal 256×256 Solver:**
  - Fix WGSL eager `select(length(...), d1Mid, nSub == 1)`, skip computing `d1Mid`/`d2Mid` when `nSub > 1`, and hoist GLSL frame-invariants to `WebGLRenderer.js`.
  - In `tidal.glsl.js` / `tidal.wgsl`: compare squared distance `dot(dp, dp)` inside `evalBezierStream` and compute 1 `sqrt` + 1 `normalize` after the loop (**36 → 6 `sqrt`/texel**).
  - Skip the tidal pass when `diskDensity <= 0.001 && bridgeIntensity <= 0.001` (`vacuum` preset), **setting `this._tidalReset = true; this._lastTidalSig = null;`** so returning to a disk preset guarantees a clean reset. Reuse a single `binState` object on CPU.

---

## Phase P4 — Native Rust Desktop (`desktop/`)

**Target Impact:** **1.8×–4×** Retina/4K FPS, **~0%** idle CPU/GPU power when paused & converged, **48 MiB** CPU RAM freed, **~130 MiB** 4K HDR VRAM cut, and zero sim-switch recompile hitches.

### Deliverables
- [x] **Default 1.5× Render DPR Cap + Interactive `0.75×` Drag Scale (`desktop/src/renderer/post.rs`, `main.rs`):**
  - Cap effective render-target DPR in `compute_render_dims` at **`1.5`** (matching web `MAX_DPR = 1.5`) while keeping swapchain + `egui` crisp at native physical DPR (and honoring explicit CLI/UI resolution overrides).
  - Add optional `0.75×` interactive drag scale during camera motion, snapping back to `1.0×` at rest.
- [x] **Hybrid HDR Formats (`desktop/src/renderer/post.rs`, `sims/*.rs`, `tests/headless_render.rs`):**
  - Probe `adapter.features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE)` and request it on `request_device` (falling back to `Rgba16Float`).
  - Use `Rg11b10Ufloat` (4 B/px) for `scene_rt`, `bloom_down_rts`, `bloom_up_rts`, and `ana_rt_a/b`; keep `taa_rts[0..2]` and `binary.rs` `tidal_tex_a/b` explicitly on **`Rgba16Float`** (update `make_fs_pipe` across all 7 sims + `headless_render.rs`).
- [x] **Converged Idle Power, Glass Blur Gating & Frame Pacing (`desktop/src/main.rs`):**
  - Switch Sim mode to `ControlFlow::Wait` / `ControlFlow::WaitUntil` when `!plan.run_raytrace && !plan.run_post`, guarded by **all 7 safety invariants**:
    1. `sky_rx.is_none()` (or wake via winit `EventLoopProxy` custom `UserEvent` when background 4K sky finishes decoding).
    2. `!outcome.camera_moved` (flights and critically damped springs settled).
    3. `!input.any_key_held()` and not actively dragging.
    4. `WaitUntil(toast_expiry)` while `status_toast` is visible (2.8 s auto-dismiss).
    5. Honor `full_output.viewport_output[ROOT].repaint_delay` via `WaitUntil` + `needs_redraw` on `window_event` (matching `render_home_frame`).
    6. Keep polling when `self.cli.smoke_frames.is_some()`.
    7. Skip `fps_smoothed` EMA updates when waking from idle / not raytracing so sparse hover events don't drag HUD FPS to single digits.
  - Dirty-gate `encode_glass_blur` on `composite_rt` updates + `hud_hidden` transitions, eliminating the redundant `else if !self.hud.hud_hidden` blur pass on unchanged frames (`main.rs:985-987`). *(Keep `glass_backdrop_rt` valid or pass `glass_tex_id: None` when `hud_hidden == true`, since `draw_restore_hud_pill` and `draw_toast` still sample it.)*
  - Skip manual 165 Hz `spin_loop()` when `surface_config.present_mode == PresentMode::Fifo` (unless `--max-fps` was explicitly set below monitor refresh).
- [x] **Merge Swapchain Render Pass (`desktop/src/main.rs`):**
  - Run `egui_ctx.run_ui`, `update_texture`, `tessellate`, and `update_buffers` **before** opening the swapchain render pass on `frame_view`; draw `blit_pipeline` (`0..3`), call `rpass.forget_lifetime()`, and execute `egui_renderer.render(&mut rpass_static, ...)` inside the **single** `LoadOp::Clear -> StoreOp::Store` render pass (eliminates Apple Silicon / TBDR `LoadOp::Load` roundtrip).
- [x] **Startup, Memory Leak, Static UBOs & Pipeline Cache (`renderer/mod.rs`, `assets/sky.rs`, `post.rs`, `ui/home/`):**
  - **Fix 48 MiB CPU RAM leak:** Remove `'static OnceLock` caches (`REAL_SKY`, `SKY_A`, `SKY_B`) in `desktop/src/assets/sky.rs`; return owned `RgbaImageData` and drop immediately after `queue.write_texture`.
  - **Invert startup order:** Decode embedded `milkyway_4k.jpg` first / in background during Homepage idle; compute the 4 blue-noise channels in parallel across 4 threads (or embed pre-baked LUT matching web); lazily synthesize `proc_sky_a` & `exotic_sky_b` only when needed (also saves 10.67 MiB VRAM outside `wormhole`).
  - **Pipeline caching:** Cache compiled `wgpu::RenderPipeline`s (and `binary` compute pipeline) in `SharedGpuAssets` keyed by `SimId` to eliminate 50–300 ms `naga` recompile hitches on sim switch while preserving fresh reset-on-switch state.
  - **Hoist all 15 invariant `post.rs` UBO writes:** Populate `bloom_down_ubos[1..=5]`, `bloom_up_ubos[0..=4]`, `glass_ubo_0/1` on `resize()`, and `bloom_pre_ubo`, `ana_ubo_0/1` on `resize()` **or `PostTuning` change** (sim switch invalidation).
  - Lazy/async WebP decode for `ui/home/` preview cards instead of decoding all 7 on frame 0.
- [x] **CPU / `egui` / Release Profile (`main.rs`, `ui/`, `Cargo.toml`):**
  - Move `full_output.platform_output` and `full_output.shapes` by value in `render_frame` (return only `full_output.textures_delta.free` out of the inner block).
  - Throttle `hud_metadata()` to 85 ms (matching web) and remove per-frame `.to_uppercase()` / `adapter_label.clone()` allocations.
  - Deduplicate the 20–22 duplicate `layout_job` shapings/frame in `ui/` using `Color32::PLACEHOLDER` or `painter.galley_with_override_text_color(pos, galley, fg)` (**`egui 0.37` hover-color guardrail**).
  - Return `&'static [PresetMeta]` and `&'static [ControlSection]` instead of allocating `Vec`s every frame; deduplicate system font file reads by canonical path in `configure_fonts`.
  - Add `panic = "abort"` under `[profile.release]` in `desktop/Cargo.toml`.

### Verification
- `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation --test headless_render`
- `cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path desktop/Cargo.toml -- --check`
- Interactive manual / `--smoke-frames` check verifying: converged idle CPU/GPU near 0%, 4K sky background load wakes `ControlFlow::Wait` cleanly, hover colors & toast auto-dismiss work while paused, and `Rg11b10Ufloat` + `Rgba16Float` TAA produces clean 128-sample cinema stills.
