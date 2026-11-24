# Interstellar Simulation — Agent Guide

Static, zero-dependency, dual-backend (**WebGL2 + WebGPU**) relativistic GPU ray-tracer suite. Pure ES modules (`<script type="module" src="./src/main.js">`), no bundler, no `package.json`, GitHub Pages compatible (`.nojekyll` at repo root).

## Repository Layout & Routing

| Path | Component | Debug Handle / Role |
| :--- | :--- | :--- |
| `shared/` | Canonical Registry, Sky Asset, LUTs, Common/Post Shaders, Observatory Base UI, Test Harnesses | Shared ES modules (`../shared/...`) |
| `scripts/run-tests.mjs` | Unified CLI test orchestrator (`--physics`, `--desktop`, `--browser`, `--firefox`, `--all`, `--sim`) | Repo-root verification entrypoint |
| `desktop/` | Native Rust (`wgpu` + `egui`) multi-simulator desktop app (`cargo test`, `./desktop/run.sh`) | Embeds `shared/assets/milkyway_4k.jpg` |
| `blackhole-sim/` | Gargantua (3D Outgoing Kerr–Schild Black Hole) | `window.__GARGANTUA__` |
| `wormhole-sim/` | Morris–Thorne / Ellis Traversable Wormhole | `window.__WORMHOLE__` |
| `binary-bh-sim/` | Binary Black Hole Inspiral & GW Lensing | `window.__BINARY_BH__` |
| `warp-drive-sim/` | Alcubierre / Natário / Lentz FTL Warp Drive | `window.__WARP_DRIVE__` |
| `supernova-sim/` | Volumetric Multi-Scattering Supernova Remnant & Nebula | `window.__SUPERNOVA__` |
| `pulsar-sim/` | Magnetar / Millisecond Pulsar Magnetosphere & GR Lensing | `window.__PULSAR__` |
| `starflight-sim/` | Relativistic Starflight (SR Aberration, Doppler & Terrell Sky) | `window.__STARFLIGHT__` |

- Root `index.html` resolves `?sim=<alias>` via `./shared/simRegistry.js` (defaulting to `./blackhole-sim/`, forwarding query params such as `?backend=webgpu`, or showing a `?hub` selector card view and `<noscript>` fallback).
- Cross-sim navigation (`nav[aria-label="Simulation switcher"]`) is mounted dynamically from `shared/ui/simSwitcher.js` and `shared/simRegistry.js` using relative `../<sim>/` links and canonical `#sim-switch-<id>` IDs; local HTTP servers **must serve the repository root**, not an individual simulator folder.

## Local Launch (`./launch.sh`)

Serves the repo root via `python3 -m http.server` on the first free port in `127.0.0.1:8080..8179` and launches Chrome or Firefox with NVIDIA PRIME/Vulkan offload, or launches the native Rust `desktop/` app:

```bash
# Default: blackhole-sim, WebGL2, headed X11 Google Chrome (dark mode)
./launch.sh

# Select simulator (--blackhole | --wormhole | --binary | --warp | --supernova | --pulsar | --starflight | --sim <name>)
./launch.sh --wormhole
./launch.sh --binary
./launch.sh --warp
./launch.sh --supernova
./launch.sh --pulsar
./launch.sh --starflight

# Start directly in WebGPU (?backend=webgpu) or WebGL2 (?backend=webgl2)
./launch.sh --webgpu
./launch.sh --sim warp --webgpu

# Launch in headed Wayland Firefox (NVIDIA WebGL2 + WebGPU readback prefs)
./launch.sh --firefox --warp

# Launch native Rust desktop simulator (desktop/run.sh --sim <target>)
./launch.sh --desktop --pulsar
```

Pass extra browser or desktop arguments after `--`. Prerequisites: `python3` + `google-chrome`/`chromium` (default) or `firefox` (`--firefox`), or `cargo`/Rust toolchain (`--desktop`).

## Verification Suites

Use either the unified runner (`scripts/run-tests.mjs`) or run individual suites from the repository root (`<sim>` ∈ `blackhole-sim`, `wormhole-sim`, `binary-bh-sim`, `warp-drive-sim`, `supernova-sim`, `pulsar-sim`, `starflight-sim`):

```bash
# Unified runner
node scripts/run-tests.mjs --physics            # shared/tests/shared_check.mjs + all 7 physics_check.mjs
node scripts/run-tests.mjs --desktop            # cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation
node scripts/run-tests.mjs --all --sim pulsar   # scoped full run (gracefully skips browser/firefox if display/GPU absent)

# 0. Shared layer contracts (registry, single milkyway_4k.jpg, shared LUTs/shaders/UI)
node shared/tests/shared_check.mjs

# 1. Physics math, syntax (--check), GLSL/WGSL contracts & LUT/sky checks (Node.js only, no browser/GPU)
node <sim>/tests/physics_check.mjs

# 2. Headed X11 Chrome NVIDIA QA (live WebGL2 <-> WebGPU switch, RAM sky cache, presets, switcher E2E)
node <sim>/tests/browser_qa.mjs

# 3. Headed Wayland Firefox NVIDIA WebGPU QA (MOZ_LOG=WebGPU:4, swapchain readback, zero device-lost)
node <sim>/tests/firefox_qa.mjs
```

- `browser_qa.mjs` & `firefox_qa.mjs` share `shared/testing/staticServer.mjs`, `chromeCdp.mjs`, and `firefoxHarness.mjs`, serving the repo root automatically.
- `browser_qa.mjs` prerequisites: Node.js, `/usr/bin/google-chrome`, headed X11 display, NVIDIA GPU. Writes PNGs + `qa_report.json` under `<sim>/tests/screenshots/`.
- `firefox_qa.mjs` prerequisites: Node.js, `firefox` in `PATH`, `nvidia-smi`, headed Wayland display, NVIDIA GPU. **Never** run Firefox WebGPU tests with `--headless`; the suite enforces `dom.webgpu.allow-present-without-readback = false`. Writes PNGs + `firefox_qa_report.json`.

### Verification Guardrails, Hooks & CI

- **Antigravity Post-Edit Hook** (`.agents/hooks.json` + `.agents/hooks/post_edit_physics_check.mjs`): Automatically runs `node <sim>/tests/physics_check.mjs` after edits under `<sim>/src/engine/` or `<sim>/src/shaders/`, or `node scripts/run-tests.mjs --physics` after edits under `shared/`, injecting unresolved failures via `PostInvocation`.
- **Full Verification Skill** (`/verify-sim` via `.agents/skills/verify-sim/SKILL.md`): Runs `physics_check.mjs` (fail fast) → `browser_qa.mjs` → `firefox_qa.mjs` with graceful display/GPU prerequisite checks and JSON report summaries.
- **Tracked Git Hooks** (`.githooks/pre-commit`, `.githooks/pre-push`): Activate once per clone with:
  ```bash
  git config core.hooksPath .githooks
  ```
  `pre-commit` runs `<sim>/tests/physics_check.mjs` for staged `<sim>/src/(engine|shaders)/`, `scripts/run-tests.mjs --physics` for `shared/`/`scripts/`, and `cargo test` for `desktop/`/`shared/assets/milkyway_4k.jpg`. `pre-push` covers changed `<sim>/`, `shared/`/`scripts/`/`index.html`, and `desktop/` (set `RUN_BROWSER_QA=1 git push` to also run Chrome & Firefox QA for changed sims).
- **GitHub Actions CI**: `.github/workflows/web-ci.yml` runs `node scripts/run-tests.mjs --physics` on `main` pushes/PRs; `.github/workflows/build-macos.yml` tests and packages `desktop/` (rebuilding when `desktop/**` or `shared/assets/milkyway_4k.jpg` changes).

## Hard Invariants

1. **Dual-Backend Parity**: Never modify shader uniforms, physics math, buffer layouts, or post-processing in WebGPU (`src/engine/WebGPURenderer.js`, `src/shaders/*.wgsl.js`, `shared/shaders/*.wgsl.js`) without updating the WebGL2 counterpart (`src/engine/WebGLRenderer.js`, `src/shaders/*.frag.js`, `src/shaders/*.glsl.js`, `shared/shaders/*.glsl.js`) and vice versa.
2. **Session Scoping**: Only edit **one** simulation directory per task unless cross-sim propagation is explicitly requested by the user.
3. **Ignore `ideas.md`**: Do **not** treat `ideas.md` as an active specification, roadmap, or requirements doc, and do **not** read it unless the user explicitly asks.
4. **Shared Layer vs. Per-Simulator Modules**:
   - **Shared in `shared/`**: `simRegistry.js`, single canonical `assets/milkyway_4k.jpg` (also embedded by `desktop/src/assets/sky.rs`), `assets/physicalLuts.js`, `assets/skyLoader.js`, `shaders/common.{glsl,wgsl}.js`, `shaders/postConfig.js`, `shaders/post.{glsl,wgsl}.js`, `ui/base.css`, `ui/simSwitcher.js`, and `testing/{staticServer,chromeCdp,firefoxHarness}.mjs`. Editing anything in `shared/` affects multiple simulators (or `desktop/` for the sky JPEG); verify all dependents.
   - **Per-simulator only**: `<sim>/styles.css` holds `:root` Observatory token overrides (+ small sim-specific rules like `#btn-traverse span` in `wormhole-sim`), `<sim>/src/ui/ControlsHUD.js` is unique per simulator, `<sim>/src/shaders/<sim>.*` and `<sim>/src/engine/` hold simulator physics, and `wormhole-sim/` intentionally uses the blue-noise-only subset of `physicalLuts.js` and dual-universe Universe A + B APIs from `skyLoader.js`. `pulsar-sim` and `starflight-sim` pass `'pulsar'` / `'starflight'` optical profile names into `createPostShaders{GLSL,WGSL}` from `shared/shaders/post.*.js`.
