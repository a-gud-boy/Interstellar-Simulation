# Interstellar Simulation

Interactive, zero-dependency relativistic GPU ray-tracers inspired by *Interstellar* and numerical relativity — featuring a 3D Outgoing Kerr–Schild Black Hole simulator (**Gargantua**), a Morris–Thorne / Ellis Traversable Wormhole simulator (**Wormhole**), a **Binary Black Hole Inspiral & Gravitational Wave Lensing** simulator (**Binary BH**), and an **Alcubierre / Natário / Lentz FTL Warp Drive** simulator (**Warp Drive**) with dual live-switchable **WebGL2** and **WebGPU** rendering backends.

## Simulators

- **[`blackhole-sim/`](./blackhole-sim/)** — **Gargantua Relativistic Black Hole**: Exact 3D Outgoing Kerr–Schild geodesic integration, Bardeen–Press–Teukolsky ISCO & photon rings, 128³ volumetric MHD accretion plasma with Doppler beaming and Planck blackbody LUT, polar jets, and 6 presets (`Gargantua`, `Relativistic`, `Schwarzschild`, `Miller's`, `EHT M87*`, `Quasar`).
- **[`wormhole-sim/`](./wormhole-sim/)** — **Morris–Thorne / Ellis Traversable Wormhole**: RK4 curved-space geodesic integration across proper coordinate $l \in (-\infty, +\infty)$ linking **Universe A** (4K NASA SVS Milky Way + ringed gas giant landmark) and **Universe B** (exotic golden–amber & teal emission nebula + binary beacon), supporting both James–Thorne $D_{\text{neg}}$ and Ellis drainhole metrics, optional swirling throat matter, zero-flip $l=0$ throat traversal, and 6 presets (`Interstellar`, `Ellis`, `Long Tunnel`, `In Throat`, `Universe B`, `Einstein Rings`).
- **[`binary-bh-sim/`](./binary-bh-sim/)** — **Binary Black Hole Inspiral & Gravitational Wave Lensing**: Two-body Brill–Lindquist Fermat optical metric + 1PN gravitomagnetic frame-dragging + pole-free Cartesian TT retarded quadrupole gravitational wave shear + ISW sky modulation, 2.5PN Peters–Mathews orbital inspiral, 256×256 co-rotating GPU tidal hydrodynamics (WebGPU compute / WebGL2 `RGBA16F` ping-pong) resolving circumbinary disk cavities, spiral shocks, S-shaped tidal gas bridges, twin mini-disks, fractal eyebrow shadows, and 6 presets (`Equal-Mass`, `10:1 EMRI`, `Eyebrows`, `Tidal Bridges`, `Plunge`, `Vacuum GW`).
- **[`warp-drive-sim/`](./warp-drive-sim/)** — **Alcubierre Warp Drive Spacetime**: Backward ADM null geodesic RK4 integration across **Alcubierre**, **Natário Zero-Expansion** ($\theta \equiv 0$), and **Lentz Soliton** ($L_p$ rhomboidal positive/negative $T_{00}$) warp bubbles up to $5.0c$, featuring Cherenkov cyan 128³ volumetric exotic wall shimmer, relativistic Doppler bow-shock caustics with multi-spectral UV/IR star activation, superluminal aft **Causal Horizon**, live **External Chase ↔ Inside Bridge** view toggling (`T`), and 6 presets (`0.8c Cruise`, `1.0c Barrier`, `2.5c FTL`, `Bridge`, `Thin Wall`, `Natário`).

## Dual Rendering Backends & Cross-Sim Switcher

- **Live Backend Toggle**: Switch seamlessly between **WebGL2** (`RGBA16F` multi-pass HDR) and **WebGPU** (`rg11b10ufloat`/`rgba16float` HDR + compute 3D noise bake) inside the **Controls** drawer (`Optics, Sky & Quality` → `Rendering Backend`), preserving camera pose and reusing RAM-cached sky textures without re-fetching assets.
- **Cross-Simulation Switcher**: Use the top-right **Black Hole / Wormhole / Binary BH / Warp Drive** switcher (`nav[aria-label="Simulation switcher"]`) to jump directly between all four simulators while carrying the active backend (`?backend=webgl2` or `?backend=webgpu`).
- **Post-Processing Pipeline**: HDR YCoCg variance-clipped TAA + 128-sample progressive accumulation on pause, 6-mip Karis/Jimenez HDR bloom, 70mm Panavision horizontal anamorphic flare, and Troy Sobotka AgX filmic tone mapping.

## Quick Start

Serve the repository root (so relative `../blackhole-sim/`, `../wormhole-sim/`, `../binary-bh-sim/`, and `../warp-drive-sim/` switcher links resolve) or use the included launcher (configured for NVIDIA PRIME/Vulkan/Wayland on Linux):

```bash
# Launch Gargantua Black Hole (WebGL2 default, Google Chrome dark mode)
./launch.sh

# Launch Morris-Thorne Wormhole directly
./launch.sh --wormhole

# Launch Binary Black Hole Inspiral directly
./launch.sh --binary

# Launch Alcubierre Warp Drive directly
./launch.sh --warp

# Launch directly in WebGPU backend (?backend=webgpu)
./launch.sh --webgpu
./launch.sh --sim wormhole --webgpu
./launch.sh --sim binary --webgpu
./launch.sh --sim warp --webgpu

# Launch in Firefox (with NVIDIA WebGL2 + WebGPU prefs enabled)
./launch.sh --firefox --warp
```

### Controls & Keyboard Shortcuts

| Input | Action |
| :--- | :--- |
| Left-drag / `A`, `D`, `Arrows` | Orbit azimuth & elevation (or look around in Inside Bridge) |
| Scroll / Pinch / `W`, `S` | Zoom, move proper distance $l$ (Wormhole), or adjust FOV (Bridge) |
| Shift-drag / Middle-drag | Tilt / look yaw & pitch |
| Right-drag / `Q`, `E` | Camera roll |
| `1` – `6` | Select camera & physics preset |
| `Space` | Pause / Resume (triggers 128-sample cinema still accumulation) |
| `O` | Toggle gentle auto-orbit |
| `T` | **Traverse** wormhole throat (Wormhole Sim) or toggle **Inside Bridge / External Chase** (Warp Drive Sim) |
| `R` / Double-click | Reset camera to active preset |
| `P` | Capture PNG screenshot |
| `H` | Toggle HUD visibility |

## Verification Suites

All four simulators include physics/contract checks, automated NVIDIA Chrome hardware QA, and headed Firefox Wayland WebGPU QA:

```bash
# Physics & contract verification (no browser required)
node blackhole-sim/tests/physics_check.mjs
node wormhole-sim/tests/physics_check.mjs
node binary-bh-sim/tests/physics_check.mjs
node warp-drive-sim/tests/physics_check.mjs

# Headed Chrome GPU QA & 4-sim cross-switcher E2E
node blackhole-sim/tests/browser_qa.mjs
node wormhole-sim/tests/browser_qa.mjs
node binary-bh-sim/tests/browser_qa.mjs
node warp-drive-sim/tests/browser_qa.mjs

# Headed Firefox Wayland NVIDIA WebGPU QA
node blackhole-sim/tests/firefox_qa.mjs
node wormhole-sim/tests/firefox_qa.mjs
node binary-bh-sim/tests/firefox_qa.mjs
node warp-drive-sim/tests/firefox_qa.mjs
```
