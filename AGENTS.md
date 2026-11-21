# Interstellar Simulation — Agent Guide

Static, zero-dependency, dual-backend (**WebGL2 + WebGPU**) relativistic GPU ray-tracer suite. Pure ES modules (`<script type="module" src="./src/main.js">`), no bundler, no `package.json`, GitHub Pages compatible (`.nojekyll` at repo root).

## Repository Layout & Routing

| Directory | Simulator | Debug Handle |
| :--- | :--- | :--- |
| `blackhole-sim/` | Gargantua (3D Outgoing Kerr–Schild Black Hole) | `window.__GARGANTUA__` |
| `wormhole-sim/` | Morris–Thorne / Ellis Traversable Wormhole | `window.__WORMHOLE__` |
| `binary-bh-sim/` | Binary Black Hole Inspiral & GW Lensing | `window.__BINARY_BH__` |
| `warp-drive-sim/` | Alcubierre / Natário / Lentz FTL Warp Drive | `window.__WARP_DRIVE__` |

- Root `index.html` redirects to `./blackhole-sim/` by default or to `./wormhole-sim/`, `./binary-bh-sim/`, `./warp-drive-sim/` via `?sim=<alias>` (`wormhole|wh`, `binary|binary-bh|bbh`, `warp|warp-drive|alcubierre`), forwarding query params such as `?backend=webgpu`.
- Cross-sim navigation (`nav[aria-label="Simulation switcher"]`) uses relative `../<sim>/` links; local HTTP servers **must serve the repository root**, not an individual simulator folder.

## Local Launch (`./launch.sh`)

Serves the repo root via `python3 -m http.server` on the first free port in `127.0.0.1:8080..8179` and launches Chrome or Firefox with NVIDIA PRIME/Vulkan offload:

```bash
# Default: blackhole-sim, WebGL2, headed X11 Google Chrome (dark mode)
./launch.sh

# Select simulator (--blackhole | --wormhole | --binary | --warp | --sim <name>)
./launch.sh --wormhole
./launch.sh --binary
./launch.sh --warp

# Start directly in WebGPU (?backend=webgpu) or WebGL2 (?backend=webgl2)
./launch.sh --webgpu
./launch.sh --sim warp --webgpu

# Launch in headed Wayland Firefox (NVIDIA WebGL2 + WebGPU readback prefs)
./launch.sh --firefox --warp
```

Pass extra browser arguments after `--`. Prerequisites: `python3`, plus `google-chrome`/`chromium` (default) or `firefox` (`--firefox`).

## Verification Suites

All 12 scripts take **no CLI flags** and run from the repository root (`<sim>` ∈ `blackhole-sim`, `wormhole-sim`, `binary-bh-sim`, `warp-drive-sim`):

```bash
# 1. Physics math, syntax (--check), GLSL/WGSL contracts & LUT/sky checks (Node.js only, no browser/GPU)
node <sim>/tests/physics_check.mjs

# 2. Headed X11 Chrome NVIDIA QA (live WebGL2 <-> WebGPU switch, RAM sky cache, presets, switcher E2E)
node <sim>/tests/browser_qa.mjs

# 3. Headed Wayland Firefox NVIDIA WebGPU QA (MOZ_LOG=WebGPU:4, swapchain readback, zero device-lost)
node <sim>/tests/firefox_qa.mjs
```

- `browser_qa.mjs` prerequisites: Node.js, `/usr/bin/google-chrome`, headed X11 display, NVIDIA GPU. Writes PNGs + `qa_report.json` under `<sim>/tests/screenshots/`.
- `firefox_qa.mjs` prerequisites: Node.js, `firefox` in `PATH`, `nvidia-smi`, headed Wayland display, NVIDIA GPU. **Never** run Firefox WebGPU tests with `--headless`; the suite enforces `dom.webgpu.allow-present-without-readback = false`. Writes PNGs + `firefox_qa_report.json`.

### Verification Guardrails & Git Hooks

- **Antigravity Post-Edit Hook** (`.agents/hooks.json` + `.agents/hooks/post_edit_physics_check.mjs`): Automatically runs `node <sim>/tests/physics_check.mjs` after edits under `<sim>/src/engine/` or `<sim>/src/shaders/` and injects unresolved failures via `PostInvocation`.
- **Full Verification Skill** (`/verify-sim` via `.agents/skills/verify-sim/SKILL.md`): Runs `physics_check.mjs` (fail fast) → `browser_qa.mjs` → `firefox_qa.mjs` with graceful display/GPU prerequisite checks and JSON report summaries.
- **Tracked Git Hooks** (`.githooks/pre-commit`, `.githooks/pre-push`): Activate once per clone with:
  ```bash
  git config core.hooksPath .githooks
  ```
  `pre-commit` runs `physics_check.mjs` for staged `src/engine/` or `src/shaders/` changes; `pre-push` runs `physics_check.mjs` for all changed simulations (set `RUN_BROWSER_QA=1 git push` to also run Chrome & Firefox QA).

## Hard Invariants

1. **Dual-Backend Parity**: Never modify shader uniforms, physics math, buffer layouts, or post-processing in WebGPU (`src/engine/WebGPURenderer.js`, `src/shaders/*.wgsl.js`) without updating the WebGL2 counterpart (`src/engine/WebGLRenderer.js`, `src/shaders/*.frag.js`, `src/shaders/*.glsl.js`) and vice versa.
2. **Session Scoping**: Only edit **one** simulation directory per task unless cross-sim propagation is explicitly requested by the user.
3. **Ignore `ideas.md`**: Do **not** treat `ideas.md` as an active specification, roadmap, or requirements doc, and do **not** read it unless the user explicitly asks.
4. **Duplicated Files & Intentional `wormhole-sim/` Divergences**: `src/assets/physicalLuts.js`, `src/assets/skyLoader.js`, `src/shaders/common.*`, `src/shaders/post.*`, `src/ui/ControlsHUD.js`, and `styles.css` are duplicated per simulation rather than shared—**do not blindly copy-paste** between sims:
   - `ControlsHUD.js` and `styles.css` are unique to each simulator's controls, presets, and theme.
   - `physicalLuts.js` and `skyLoader.js` are identical across `blackhole-sim/`, `binary-bh-sim/`, and `warp-drive-sim/`, but **`wormhole-sim/` intentionally diverges**: its `physicalLuts.js` omits the CIE-1931 Planck blackbody LUT (exports blue noise only), and its `skyLoader.js` exposes dual-universe Universe A (`milkyway_4k.jpg` + procedural fallback) and Universe B (procedural golden-amber/teal nebula) loader APIs.
   - `common.{glsl,wgsl}.js` and `post.{glsl,wgsl}.js` also differ slightly in `wormhole-sim/` (and carry sim-specific headers elsewhere).
   - `assets/milkyway_4k.jpg` is duplicated per sim so each directory remains self-contained for static hosting.
