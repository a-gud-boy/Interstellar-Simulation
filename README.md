# Interstellar Simulation

Interactive, zero-dependency relativistic GPU ray-tracers inspired by *Interstellar* and numerical relativity — featuring a 3D Outgoing Kerr–Schild Black Hole simulator (**Gargantua**), a Morris–Thorne / Ellis Traversable Wormhole simulator (**Wormhole**), a **Binary Black Hole Inspiral & Gravitational Wave Lensing** simulator (**Binary BH**), an **Alcubierre / Natário / Lentz FTL Warp Drive** simulator (**Warp Drive**), a **Volumetric Multi-Scattering Supernova Remnant & Nebula** simulator (**Supernova**), a **Magnetar / Millisecond Pulsar Magnetosphere** simulator (**Pulsar**), a **Special-Relativistic Starflight Aberration & Doppler Sky** simulator (**Starflight**), and a **Gravitational Lensing Observatory** (**Lens Cluster**), and a **Tidal Disruption Event Observatory** (**TDE Shred**) with dual live-switchable **WebGL2** and **WebGPU** rendering backends.

## Simulators

- **[`sims/blackhole/`](./sims/blackhole/)** — **Gargantua Relativistic Black Hole**: Exact 3D Outgoing Kerr–Schild geodesic integration, Bardeen–Press–Teukolsky ISCO & photon rings, 128³ volumetric MHD accretion plasma with Doppler beaming and Planck blackbody LUT, polar jets, and 6 presets (`Gargantua`, `Relativistic`, `Schwarzschild`, `Miller's`, `EHT M87*`, `Quasar`).
- **[`sims/wormhole/`](./sims/wormhole/)** — **Morris–Thorne / Ellis Traversable Wormhole**: RK4 curved-space geodesic integration across proper coordinate $l \in (-\infty, +\infty)$ linking **Universe A** (4K NASA SVS Milky Way + ringed gas giant landmark) and **Universe B** (exotic golden–amber & teal emission nebula + binary beacon), supporting both James–Thorne $D_{\text{neg}}$ and Ellis drainhole metrics, optional swirling throat matter, zero-flip $l=0$ throat traversal, and 6 presets (`Interstellar`, `Ellis`, `Long Tunnel`, `In Throat`, `Universe B`, `Einstein Rings`).
- **[`sims/binary/`](./sims/binary/)** — **Binary Black Hole Inspiral & Gravitational Wave Lensing**: Two-body Brill–Lindquist Fermat optical metric + 1PN gravitomagnetic frame-dragging + pole-free Cartesian TT retarded quadrupole gravitational wave shear + ISW sky modulation, 2.5PN Peters–Mathews orbital inspiral, 256×256 co-rotating GPU tidal hydrodynamics (WebGPU compute / WebGL2 `RGBA16F` ping-pong) resolving circumbinary disk cavities, spiral shocks, S-shaped tidal gas bridges, twin mini-disks, fractal eyebrow shadows, and 6 presets (`Equal-Mass`, `10:1 EMRI`, `Eyebrows`, `Tidal Bridges`, `Plunge`, `Vacuum GW`).
- **[`sims/warp/`](./sims/warp/)** — **Alcubierre Warp Drive Spacetime**: Backward ADM null geodesic RK4 integration across **Alcubierre**, **Natário Zero-Expansion** ($\theta \equiv 0$), and **Lentz Soliton** ($L_p$ rhomboidal positive/negative $T_{00}$) warp bubbles up to $5.0c$, featuring Cherenkov cyan 128³ volumetric exotic wall shimmer, relativistic Doppler bow-shock caustics with multi-spectral UV/IR star activation, superluminal aft **Causal Horizon**, live **External Chase ↔ Inside Bridge** view toggling (`T`), and 6 presets (`0.8c Cruise`, `1.0c Barrier`, `2.5c FTL`, `Bridge`, `Thin Wall`, `Natário`).
- **[`sims/supernova/`](./sims/supernova/)** — **Supernova Remnant & Volumetric Nebula**: Analytic bounding-sphere radiative transfer across Sedov–Taylor and free-expansion blast waves, 4-octave Wrenninge multiple scattering + dual-lobe Henyey–Greenstein anisotropic dust scattering, 6 exponential shadow taps, pole-free 3D Rayleigh–Taylor filaments, dark Bok globules, `Hubble SHO` vs `True Color Broadband` narrowband palettes, origin-safe `W`/`S` deep interior fly-through, and 6 presets (`Crab Shell`, `Veil Shock`, `Hubble SHO`, `Bok Globules`, `Pulsar Cavity`, `Flythrough`).
- **[`sims/pulsar/`](./sims/pulsar/)** — **Magnetar & Millisecond Pulsar Magnetosphere**: 3D Outgoing Kerr–Schild null geodesics with explicit compactness $M/R \in [0.12, 0.30]$ exposing $>50\%$ of the solid neutron star crust (`GR Curved` vs `Flat Space`), relativistic gravitational redshift & rotational Doppler beaming across $10^6$–$10^7\,\text{K}$ polar caps and molten magnetar tectonic cracks, twisted oblique dipole pair-plasma flux tubes inside the light cylinder $R_{\text{LC}}$, sweeping lighthouse beams with Deutsch retardation, equatorial PWN torus & helical polar jets, and 6 presets (`Crab Pulsar`, `Millisecond`, `Magnetar`, `Polar Cap`, `Lighthouse`, `Torus & Jet`).
- **[`sims/starflight/`](./sims/starflight/)** — **Relativistic Starflight — Aberration, Doppler & Terrell Sky**: Cancellation-free Special Relativistic Lorentz null-ray aberration up to $0.9999996c$ ($\gamma \approx 1050$, `Exact SR` vs `Rest Frame`), exact Doppler shift $D = [\gamma(1 - \beta\cos\theta')]^{-1}$ with CIE-1931 Planck blackbody temperature shift across the 4K Milky Way, UV/IR procedural star bands, and Planck-mottled Cosmic Microwave Background shell ($T_{\text{fwd}} = 2.7255\,D_{\text{fwd}}$), Penrose–Terrell rotated 3D periodic navigation rings & beacon stations, 128³ volumetric hydrogen dust streaks, $1g$ constant proper-acceleration brachistochrone cruise, live Forward ↔ Aft window flipping (`T`), and 6 presets (`0.50c Cruise`, `0.90c Cone`, `0.995c UV Sky`, `0.9999c CMB`, `Aft Window`, `1g Cruise`).
- **[`sims/lens-cluster/`](./sims/lens-cluster/)** — **Gravitational Lensing Observatory — Einstein Rings & Cluster**: JWST deep-field gravitational lensing observatory with exact Point-Mass, Singular Isothermal Ellipsoid (SIE), and NFW dark-matter cluster halos plus 3D elliptical member galaxies, analytical Jacobian magnification caustics & critical curves, Fermat arrival-time contours, interactive source-plane dragging (`T`), and 6 presets (`Einstein Ring`, `Einstein Cross`, `JWST Cluster`, `Fold Caustic`, `Microlensing`, `Caustic Bench`).
- **[`sims/tde/`](./sims/tde/)** — **Tidal Disruption Event — Stellar Shredding & Nozzle Shock**: 3D Outgoing Kerr–Schild ray-tracer modeling relativistic tidal stellar disruption: elliptical precessing debris streams ($\Delta\varphi \approx 6\pi M/r_p$), unbound escaping tails, nozzle self-intersection shock ($T \sim 25{,}000\,\text{K}$), Rees–Phinney $t^{-5/3}$ circularization disk, Blandford–Znajek polar jet, Hills direct-capture limit, Disruption Evolution Sweep (`T`), and 6 presets (`Nozzle Shock`, `Tidal Rip`, `Deep β=4.5`, `Eddington`, `Jetted TDE`, `Hills Limit`).

- **[`index.html`](./index.html)** — **Observatory Homepage (Default Landing Screen)**: Lightweight, zero-GPU static hub showcasing all nine engines with real ray-traced WebP previews, category filtering, global `WebGL2` / `WebGPU` backend selector, Quick-Inspect physics dossiers, and `?sim=<alias>` deep-link routing (`./launch.sh`).
- **[`shared/`](./shared/)** — **Canonical Shared Layer**: Unified simulator registry ([`simRegistry.js`](./shared/simRegistry.js)), single 4K Milky Way sky texture ([`milkyway_4k.jpg`](./shared/assets/milkyway_4k.jpg)), Planck blackbody & blue-noise LUTs, sky loaders, shared GLSL/WGSL post-processing (`TAA`, bloom, anamorphic flare, AgX), Observatory Glass base CSS & dynamic switcher, URL deep-link state, graphics profiles, Cinema Recorder, Interactive Physics Tour, and QA test harnesses.
- **[`desktop/`](./desktop/)** — **Native Rust Desktop App (`wgpu` + `egui`)**: Hardware-accelerated native executable launching into the native Observatory Homepage by default (`./desktop/run.sh` or `./launch.sh --desktop`) and supporting all nine simulators (`./desktop/run.sh --sim <name>` or `./launch.sh --desktop --<sim>`), persistent graphics profiles (`Eco / Balanced / Ultra`), Physics Tour overlay, PNG sequence recorder, cross-platform Windows & macOS build scripts, and headless WGSL/physics parity tests (`cargo test`).

## Dual Rendering Backends & Cross-Sim Switcher

- **Live Backend Toggle**: Switch seamlessly between **WebGL2** (`RGBA16F` multi-pass HDR) and **WebGPU** (`rg11b10ufloat`/`rgba16float` HDR + compute 3D noise bake) inside the **Controls** drawer (`Optics, Sky & Quality` → `Rendering Backend`), preserving camera pose and reusing RAM-cached sky textures without re-fetching assets.
- **Cross-Simulation Switcher & Observatory Home**: Use the top-right **Home** button (`#sim-switch-home`) and **Black Hole / Wormhole / Binary BH / Warp Drive / Supernova / Pulsar / Starflight / Lens Cluster / TDE Shred** switcher (`nav[aria-label="Simulation switcher"]`, dynamically rendered via [`shared/ui/simSwitcher.js`](./shared/ui/simSwitcher.js)) to return to the Observatory Homepage or jump directly between all nine simulators while carrying the active backend (`?backend=webgl2` or `?backend=webgpu`).
- **Post-Processing Pipeline**: HDR YCoCg variance-clipped TAA + 128-sample progressive accumulation on pause, 6-mip Karis/Jimenez HDR bloom, 70mm Panavision horizontal anamorphic flare, and Troy Sobotka AgX filmic tone mapping.

## Quick Start

Serve the repository root (so relative `../../shared/` and `../../sims/<id>/` switcher links resolve) or use the included launcher (configured for NVIDIA PRIME/Vulkan/Wayland on Linux):

```bash
# Launch the lightweight Observatory Homepage (default: all 9 engines, presets & backend picker)
./launch.sh

# Launch any simulator directly
./launch.sh --blackhole
./launch.sh --wormhole
./launch.sh --binary
./launch.sh --warp
./launch.sh --supernova
./launch.sh --pulsar
./launch.sh --starflight
./launch.sh --lens-cluster
./launch.sh --tde

# Launch directly in WebGPU backend (?backend=webgpu)
./launch.sh --webgpu
./launch.sh --sim blackhole --webgpu
./launch.sh --sim wormhole --webgpu
./launch.sh --sim binary --webgpu
./launch.sh --sim warp --webgpu
./launch.sh --sim supernova --webgpu
./launch.sh --sim pulsar --webgpu
./launch.sh --sim starflight --webgpu
./launch.sh --sim lens-cluster --webgpu
./launch.sh --sim tde --webgpu

# Launch in Firefox (with NVIDIA WebGL2 + WebGPU prefs enabled)
./launch.sh --firefox --starflight

# Launch the native Rust desktop app (Observatory Homepage by default, or pass --<sim>)
./launch.sh --desktop
./launch.sh --desktop --pulsar
```

### Controls & Keyboard Shortcuts

| Input | Action |
| :--- | :--- |
| Left-drag / `A`, `D`, `Arrows` | Orbit azimuth & elevation (or look around in Bridge / Starflight, or drag source in Lens Cluster) |
| Scroll / Pinch / `W`, `S` | Zoom, move proper distance $l$ (Wormhole), fly through shell (Supernova), or adjust FOV (Bridge / Starflight) |
| Shift-drag / Middle-drag | Tilt / look yaw & pitch |
| Right-drag / `Q`, `E` | Camera roll |
| `1` – `6` | Select camera & physics preset |
| `Space` | Pause / Resume (triggers 128-sample cinema still accumulation) |
| `O` | Toggle gentle auto-orbit / auto-pan |
| `T` | **Traverse** wormhole throat (Wormhole), toggle **Inside Bridge / External Chase** (Warp Drive), **Detonate & Evolve** (Supernova), flip **Forward / Aft** (Starflight), toggle **Drag Source / Orbit** (Lens Cluster), or trigger **Disrupt & Evolve** (TDE) |
| `C` | Open / close **Controls** drawer |
| `I` | Toggle **Interactive Physics Tour** overlay (`[` / `]` steps callout pins) |
| `V` | Start / Stop **Cinema Recorder** (WebM video or deterministic PNG frame sequence) |
| `G` | Toggle live **GPU Pass Profiler** overlay |
| `M` | Toggle **Audio Sonification** (Binary BH & Pulsar) |
| `L` | Copy **Shareable URL** encoding active preset, camera pose, and physics parameters |
| `R` / Double-click | Reset camera to active preset |
| `P` | Capture PNG screenshot |
| `H` | Toggle HUD visibility |
| `?` / `F1` | Open / close in-sim **Help Menu** |

## Verification Suites

All nine simulators include physics/contract checks, automated NVIDIA Chrome hardware QA, and headed Firefox Wayland WebGPU QA, alongside [`shared/tests/shared_check.mjs`](./shared/tests/shared_check.mjs), native [`desktop/`](./desktop/) Rust tests, and the unified runner [`scripts/run-tests.mjs`](./scripts/run-tests.mjs):

```bash
# Unified runner (recommended)
node scripts/run-tests.mjs --physics            # Shared contracts + all 9 physics checks
node scripts/run-tests.mjs --desktop            # Native Rust physics parity & WGSL validation
node scripts/run-tests.mjs --all                # All physics, desktop, Chrome & Firefox QA suites
node scripts/run-tests.mjs --all --sim pulsar   # Scoped full run for one simulator

# Shared layer & individual per-simulator physics checks (no browser required)
node shared/tests/shared_check.mjs
node sims/blackhole/tests/physics_check.mjs
node sims/wormhole/tests/physics_check.mjs
node sims/binary/tests/physics_check.mjs
node sims/warp/tests/physics_check.mjs
node sims/supernova/tests/physics_check.mjs
node sims/pulsar/tests/physics_check.mjs
node sims/starflight/tests/physics_check.mjs
node sims/lens-cluster/tests/physics_check.mjs
node sims/tde/tests/physics_check.mjs

# Headed Chrome GPU QA & 9-sim cross-switcher E2E
node sims/blackhole/tests/browser_qa.mjs
node sims/wormhole/tests/browser_qa.mjs
node sims/binary/tests/browser_qa.mjs
node sims/warp/tests/browser_qa.mjs
node sims/supernova/tests/browser_qa.mjs
node sims/pulsar/tests/browser_qa.mjs
node sims/starflight/tests/browser_qa.mjs
node sims/lens-cluster/tests/browser_qa.mjs
node sims/tde/tests/browser_qa.mjs

# Headed Firefox Wayland NVIDIA WebGPU QA
node sims/blackhole/tests/firefox_qa.mjs
node sims/wormhole/tests/firefox_qa.mjs
node sims/binary/tests/firefox_qa.mjs
node sims/warp/tests/firefox_qa.mjs
node sims/supernova/tests/firefox_qa.mjs
node sims/pulsar/tests/firefox_qa.mjs
node sims/starflight/tests/firefox_qa.mjs
node sims/lens-cluster/tests/firefox_qa.mjs
node sims/tde/tests/firefox_qa.mjs
```
