# Interstellar Simulation — Project Organization Roadmap

**Baseline Commit:** `a9d0013` (`v0.1.2.1-beta`)  
**Execution Order:** **Execute FIRST** — completes structural unification, single-source WGSL, shared web post-processing pipelines, and CI/governance before executing [`docs/PERFORMANCE_ROADMAP.md`](./PERFORMANCE_ROADMAP.md).

---

## Architectural Decisions & Scope

All structural decisions below are locked in for this roadmap:

| Axis | Locked Decision | Rationale |
| :--- | :--- | :--- |
| **Root Layout** | Move all 7 `*-sim/` directories into `sims/<id>/` with **no** root redirect stubs | Cleanest repo root; legacy URLs route via `/?sim=<alias>` in `index.html` |
| **Canonical Slugs** | `blackhole`, `wormhole`, `binary`, `warp`, `supernova`, `pulsar`, `starflight` | Eliminates drift across `sims/<id>/`, `<id>.wgsl`, `<id>.webp`, and `desktop/src/sims/<id>.rs` |
| **Single-Source WGSL** | Raw `.wgsl` files (`sims/<id>/src/shaders/*.wgsl` + `shared/shaders/*.wgsl`) consumed by Rust `include_str!` and synced into zero-fetch `.wgsl.js` wrappers via `scripts/sync-wgsl.mjs --check` | Eliminates WebGPU ↔ Desktop shader drift; unifying `post_anamorphic`/`post_composite` optics into uniforms makes all sim, common, and post WGSL 100% single-source |
| **JS Refactoring Style** | Composable extractions (`SharedWebGLPostPipeline.js`, `SharedWebGPUPostPipeline.js`, `SimAppShell.js`, `BaseCamera.js`, `firefoxQaRunner.mjs`) + standard `CameraController.js` & `Physics.js` | Cuts boilerplate and enables 1-place performance fixes without rigid inheritance or breaking bespoke `ControlsHUD.js` / `index.html` UX |
| **Metadata Registry** | Canonical `shared/sims.json` + `scripts/sync-metadata.mjs --check` generating zero-fetch JS ESM and Rust `const` tables; `launch.sh` reads `shared/sims.json` directly | Eliminates 5-way catalog/alias edits; removes unused `glam` & `serde` from `desktop/Cargo.toml` without adding `serde_json` |
| **Governance & License** | **GPL-3.0** `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `.gitattributes`, move `ideas.md` → `docs/ideas.md` | Legal clarity and clean root while preserving `AGENTS.md` Hard Invariant #3 (`ideas.md` is not an active roadmap/spec) |
| **CI/CD Coverage** | Add Rust verification (`physics_parity`, `shader_validation`, `clippy`, `fmt`) + WGSL/metadata sync checks to `web-ci.yml`; add `shader_validation` to `build-macos.yml`; add native `ubuntu-latest` & `windows-latest` release jobs | Full cross-platform verification and release coverage |
| **Desktop UI Split** | Split `desktop/src/ui/mod.rs` (2,253 LOC) and `desktop/src/ui/home.rs` (1,741 LOC) into `desktop/src/ui/{mod.rs,theme.rs,home/,hud/,controls/}` | Cuts compile-edit friction before Desktop performance work |

> [!IMPORTANT]
> Follow [`AGENTS.md`](../AGENTS.md) Hard Invariants throughout execution: keep WebGL2 ↔ WebGPU parity intact, scope shader/engine changes carefully, and run `node scripts/run-tests.mjs --physics` and `node scripts/run-tests.mjs --desktop` at each phase gate.

---

## Target Repository Layout (Post-O6)

```text
Interstellar-Simulation/
├── index.html                        # Observatory Homepage & ?sim=<alias> router
├── launch.sh                         # Unified local launcher (reads aliases from shared/sims.json)
├── README.md                         # Project overview & quick start
├── LICENSE                           # GPL-3.0
├── CHANGELOG.md                      # Release history (v0.1.0-beta -> current)
├── CONTRIBUTING.md                   # Contributor guide, hooks & dual-backend parity rules
├── AGENTS.md                         # Updated paths, canonical slugs & guardrails
├── .gitattributes                    # LF normalization for source/shader/script files
├── docs/
│   ├── ORGANIZATION_ROADMAP.md       # This document (Phase O1 -> O6)
│   ├── PERFORMANCE_ROADMAP.md        # Subsequent perf roadmap (Phase P1 -> P4)
│   └── ideas.md                      # Archived concept backlog (not an active spec per AGENTS.md)
├── sims/
│   ├── blackhole/                    # src/engine/{CameraController,Physics,Presets,WebGLRenderer,WebGPURenderer}.js
│   ├── wormhole/                     # src/shaders/{<id>.frag.js,<id>.wgsl,<id>.wgsl.js}
│   ├── binary/                       # + tidal.glsl.js, tidal.wgsl, tidal.wgsl.js
│   ├── warp/
│   ├── supernova/
│   ├── pulsar/
│   └── starflight/
├── shared/
│   ├── sims.json                     # Canonical language-agnostic simulator manifest
│   ├── simRegistry.js                # Generated/verified from shared/sims.json
│   ├── assets/                       # milkyway_4k.jpg, physicalLuts.js, skyLoader.js
│   ├── engine/                       # SharedWebGLPostPipeline.js, SharedWebGPUPostPipeline.js, SimAppShell.js, BaseCamera.js
│   ├── shaders/                      # common.glsl.js, noise_bake.wgsl, mipmap.wgsl, post_*.wgsl, post.{glsl,wgsl}.js, postConfig.js
│   ├── testing/                      # staticServer.mjs, chromeCdp.mjs, firefoxHarness.mjs, firefoxQaRunner.mjs
│   ├── tests/                        # shared_check.mjs, homepage_qa.mjs
│   └── ui/                           # base.css, simSwitcher.js
├── home/                             # Observatory Homepage UI & <id>.webp previews
├── desktop/
│   ├── Cargo.toml                    # Unused glam & serde removed
│   ├── shaders/                      # Desktop-only shaders only: blit.wgsl, glass_blur.wgsl
│   └── src/
│       ├── sims/{mod.rs,registry.rs,blackhole.rs,wormhole.rs,binary.rs,warp.rs,supernova.rs,pulsar.rs,starflight.rs}
│       └── ui/{mod.rs,theme.rs,home/,hud/,controls/}
└── scripts/
    ├── run-tests.mjs                 # Unified CLI test runner
    ├── sync-wgsl.mjs                 # Raw .wgsl <-> .wgsl.js generator & --check guard
    └── sync-metadata.mjs             # shared/sims.json -> JS/Rust generator & --check guard
```

---

## Phase O1 — Governance, GPL-3.0 Licensing & Cross-Platform CI/CD

**Goal:** Establish legal clarity, clean dependency hygiene in Rust, line-ending consistency, and automated cross-platform CI safety nets before moving files or refactoring shaders.

### Deliverables
- [x] **GPL-3.0 License & Governance Files:**
  - Add root `LICENSE` containing the standard GNU General Public License v3.0 text.
  - Add `CHANGELOG.md` summarizing releases `v0.1.0-beta` through `v0.1.2.1-beta`.
  - Add `CONTRIBUTING.md` documenting local prerequisites, `./launch.sh`, `git config core.hooksPath .githooks`, dual-backend parity, and verification commands.
  - Add `.gitattributes` enforcing LF (`eol=lf`) for `.js`, `.mjs`, `.wgsl`, `.rs`, `.sh`, `.css`, `.html`, `.md`, `.toml`, `.yml`, `.json`.
- [x] **Remove Unused Rust Dependencies (`desktop/Cargo.toml`):**
  - Remove unused `glam = "0.34"` and `serde = { version = "1.0", features = ["derive"] }` from `[dependencies]` in `desktop/Cargo.toml`.
  - Run `cargo update` / `cargo check` inside `desktop/` to refresh `desktop/Cargo.lock` cleanly.
- [x] **Expand `.github/workflows/web-ci.yml`:**
  - Keep existing `node scripts/run-tests.mjs --physics` job on `ubuntu-latest` (Node 22).
  - Add a Linux Rust verification job (`ubuntu-latest`) running:
    - `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation`
    - `cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings`
    - `cargo fmt --manifest-path desktop/Cargo.toml -- --check`
  - **CI Scope Note:** Do **not** add `shared/tests/homepage_qa.mjs` to headless Ubuntu CI — it launches headed hardware Chrome via CDP (`launchChromeDualCDP`). Pure-Node homepage contracts remain enforced in CI by `shared/tests/shared_check.mjs`.
- [x] **Expand Desktop Release CI (`.github/workflows/build-macos.yml` + Cross-Platform Release Jobs):**
  - Update `.github/workflows/build-macos.yml` line 49 to run both parity and shader validation:
    `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation`
  - Add native `ubuntu-latest` (Linux x86_64 release binary + tarball) and `windows-latest` (Windows MSVC `.exe` + zip) build jobs on `main` pushes and `v*` tags (either in a consolidated `release-desktop.yml` or alongside `build-macos.yml`).
  - Keep `desktop/build-windows.sh` documented as a local Linux `cargo-xwin` cross-compile helper (not required on `windows-latest`).
- [x] **GitHub Repository Metadata:**
  - Update GitHub repository description to cover all 7 relativistic WebGL2/WebGPU simulators + native Rust (`wgpu` + `egui`) desktop suite, and add topics: `webgpu`, `webgl2`, `rust`, `wgpu`, `relativity`, `raytracing`.

### Exit Criteria & Verification
- `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation` passes with zero warnings under `cargo clippy --all-targets -- -D warnings`.
- `cargo fmt --manifest-path desktop/Cargo.toml -- --check` exits 0.
- `node scripts/run-tests.mjs --physics` passes.

---

## Phase O2 — Single-Source WGSL Pipeline (Sim + Post + Common)

**Goal:** Eliminate dual maintenance between web `.wgsl.js` wrappers and `desktop/shaders/*.wgsl` across all 8 simulation shaders, `common` bake/mipmap shaders, and all 6 post-processing shaders.

### Deliverables
- [x] **Unify Web & Desktop Post Optics Uniforms:**
  - Update `shared/shaders/post.wgsl.js` and `shared/shaders/post.glsl.js` (`ANAMORPHIC_*` and `COMPOSITE_*`) so `coreTint`, `outerTint`, `fringeStart`, `fringeMix`, `bloomGain`, and `anamorphicGain` are read from uniform buffer fields (matching `desktop/shaders/post_anamorphic.wgsl`'s `tint_inner_edge` / `tint_outer_mix` and `post_composite.wgsl`), rather than interpolated as JS string literals.
  - Update web `WebGLRenderer.js` and `WebGPURenderer.js` post uniform uploads across all 7 sims (preserving `default`, `pulsar`, and `starflight` optical profiles in `shared/shaders/postConfig.js` and strict GLSL ↔ WGSL parity).
- [x] **Make Raw `.wgsl` Files Canonical:**
  - Extract canonical raw `.wgsl` sources for all 8 simulation shaders (`<sim>/src/shaders/<id>.wgsl` plus `binary-bh-sim/src/shaders/tidal.wgsl`) and shared shaders (`shared/shaders/fullscreen_vert.wgsl`, `shared/shaders/mipmap.wgsl`, `shared/shaders/noise_bake.wgsl`, and `shared/shaders/post_{taa,bloom_prefilter,bloom_downsample,bloom_upsample,anamorphic,composite}.wgsl`).
  - Point Rust `include_str!` calls in `desktop/src/sims/*.rs` and `desktop/src/renderer/{mod.rs,post.rs}` directly at those canonical `.wgsl` files.
  - Remove duplicated `.wgsl` files from `desktop/shaders/`, retaining **only** desktop-exclusive shaders (`desktop/shaders/blit.wgsl` and `desktop/shaders/glass_blur.wgsl`).
  - Note: Check `desktop/build-macos.sh` / `.github/workflows/` path triggers so `shared/shaders/*.wgsl` and `*-sim/src/shaders/*.wgsl` changes re-trigger Desktop CI builds!
- [x] **Build `scripts/sync-wgsl.mjs` (`--write` / `--check`):**
  - Reads canonical raw `.wgsl` files and generates/verifies zero-fetch JS wrapper exports (inlining `FULLSCREEN_VERT_WGSL` / `IEEE_NAN_GUARD_WGSL` deterministically where needed so browser loading requires zero runtime `fetch()` calls).
  - `--check` fails with clear file diffs if any `.wgsl.js` wrapper is out of sync with its canonical `.wgsl` source.
- [x] **Wire Into Hooks & CI:**
  - Add `node scripts/sync-wgsl.mjs --check` to `.githooks/pre-commit`, `.githooks/pre-push`, and `.github/workflows/web-ci.yml`.

### Exit Criteria & Verification
- `node scripts/sync-wgsl.mjs --check` passes with 0 drift across all sim, common, and post WGSL files.
- `node scripts/run-tests.mjs --physics` passes.
- `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation` passes (`naga` parses every canonical `.wgsl` directly).

---

## Phase O3 — Unified Metadata Registry (`shared/sims.json`)

**Goal:** Replace 5-way duplicated simulator lists, CLI aliases, and catalog descriptions (`shared/simRegistry.js`, `home/catalogData.js`, `launch.sh`, `desktop/src/sims/mod.rs`, `desktop/src/ui/home.rs`) with one canonical manifest — with zero runtime `fetch()` and zero `serde_json` dependency.

### Deliverables
- [x] **Create `shared/sims.json`:**
  - Define each simulator's canonical `id`, `dir`, `shortLabel`, `title`, `ariaLabel`, `debugHandle`, `accentVar`, `cardClass`, `preview`, `category`, `aliases` (preserving every legacy alias: `blackhole-sim`, `binary-bh`, `binary-bh-sim`, `warp-drive`, `warp-drive-sim`, `gargantua`, `alcubierre`, etc.), `description`, and shared dossier metadata.
- [x] **Build `scripts/sync-metadata.mjs` (`--write` / `--check`):**
  - Generates/verifies zero-fetch JS ESM (`shared/simRegistry.js` + generated core consumed by `home/catalogData.js`).
  - Generates/verifies Rust `const` metadata tables in `desktop/src/sims/registry.rs` consumed by `desktop/src/sims/mod.rs` and `desktop/src/ui/home.rs` (zero runtime JSON parsing, keeping `desktop/Cargo.toml` free of `serde` / `serde_json`).
- [x] **Update `launch.sh`:**
  - Resolve simulator flags (`--<id>`, `--sim <alias>`) and directory paths dynamically from `shared/sims.json` via `python3` (already required by `launch.sh` for the HTTP server) or `node`, deleting the hardcoded parallel `case` table.
- [x] **Wire Into Hooks & CI:**
  - Add `node scripts/sync-metadata.mjs --check` to `.githooks/pre-commit`, `.githooks/pre-push`, and `.github/workflows/web-ci.yml`.

### Exit Criteria & Verification
- `node scripts/sync-metadata.mjs --check` passes.
- `./launch.sh --help` and alias resolution (`--binary`, `--sim warp-drive-sim`, etc.) resolve correctly.
- `node scripts/run-tests.mjs --physics` and `node scripts/run-tests.mjs --desktop` pass.

---

## Phase O4 — Naming Standardization, Canonical Slugs & `sims/<id>/` Migration

**Goal:** Move all 7 simulators under `sims/<id>/` without root redirect stubs, move `ideas.md` to `docs/ideas.md`, and unify file naming and canonical slugs across Web, Previews, and Rust Desktop.

> [!WARNING]
> This is the single coordinated migration phase touching paths across root, `sims/`, `shared/`, `home/`, `desktop/`, CI, and hooks. Execute in clean sub-commits or one dedicated session, updating `shared/sims.json` and running `scripts/sync-metadata.mjs --write` alongside the moves.

### Deliverables
- [x] **Standardize Per-Sim Engine Filenames (4-File Layout):**
  - Rename camera controllers to `src/engine/CameraController.js` in `wormhole`, `warp`, `supernova`, `pulsar`, and `starflight` (matching `blackhole` & `binary`).
  - Extract dedicated `src/engine/Physics.js` for `blackhole` and `wormhole`, and rename `*Physics.js` → `src/engine/Physics.js` in `binary`, `warp`, `supernova`, `pulsar`, and `starflight`.
  - Standard layout in every sim: `src/engine/{CameraController,Physics,Presets,WebGLRenderer,WebGPURenderer}.js`.
- [x] **Standardize Canonical Slugs Across All Layers:**
  - Rename `desktop/src/sims/binary_bh.rs` → `desktop/src/sims/binary.rs` and `desktop/src/sims/warp_drive.rs` → `desktop/src/sims/warp.rs` (plus internal module/enum references if aliased).
  - Ensure shader filenames (`<id>.frag.js`, `<id>.wgsl`, `<id>.wgsl.js`, plus `binary/src/shaders/tidal.*`) and preview assets (`home/previews/<id>.webp`) match canonical IDs.
- [x] **Migrate `*-sim/` → `sims/<id>/` (No Root Stubs) & `ideas.md` → `docs/ideas.md`:**
  - Move `blackhole-sim/` → `sims/blackhole/`, `wormhole-sim/` → `sims/wormhole/`, `binary-bh-sim/` → `sims/binary/`, `warp-drive-sim/` → `sims/warp/`, `supernova-sim/` → `sims/supernova/`, `pulsar-sim/` → `sims/pulsar/`, `starflight-sim/` → `sims/starflight/`.
  - Move `ideas.md` → `docs/ideas.md` and update `AGENTS.md` Hard Invariant #3 to reference `docs/ideas.md`.
- [x] **Update All Path References & Tooling:**
  - Update relative imports inside `sims/<id>/index.html`, `sims/<id>/src/**/*.js`, and `sims/<id>/tests/*.mjs` (`../shared/...` → `../../shared/...`).
  - Update `shared/sims.json` (`dir`: `sims/<id>`) and run `node scripts/sync-metadata.mjs --write`.
  - Update `shared/ui/simSwitcher.js` relative links (`../../sims/<id>/` + home `../../`), `index.html` `/?sim=<alias>` router (retaining all legacy aliases like `?sim=blackhole-sim`, `?sim=binary-bh`, `?sim=warp-drive`), `shared/tests/shared_check.mjs`, and `shared/tests/homepage_qa.mjs`.
  - Update `scripts/run-tests.mjs`, `.agents/hooks/post_edit_physics_check.mjs`, `.githooks/{pre-commit,pre-push}`, `.github/workflows/{web-ci.yml,build-macos.yml}`, `desktop/` `include_str!`/`include_bytes!` paths, and `AGENTS.md`.

### Exit Criteria & Verification
- Top-level root entry count reduced from 21 to clean 12-entry layout (no `*-sim/` directories or redirect stubs).
- `node scripts/sync-wgsl.mjs --check && node scripts/sync-metadata.mjs --check` passes.
- `node scripts/run-tests.mjs --physics && node scripts/run-tests.mjs --desktop` passes across all 7 sims + `shared/`.
- If headed Chrome/X11 + NVIDIA GPU is available locally: verify `node shared/tests/homepage_qa.mjs` and at least `node sims/blackhole/tests/browser_qa.mjs` confirm `/?sim=blackhole-sim` redirect and `#sim-switch-*` navigation work end-to-end.

---

## Phase O5 — Composable Web Engine Extractions (`shared/engine/` & `shared/testing/`)

**Goal:** Extract the high-duplication web rendering, app-shell, camera math, and Firefox QA scaffolding into composable shared modules — **directly unlocking single-place Performance Roadmap optimizations in Phases P1–P2** while leaving each simulator's custom `ControlsHUD.js` and `index.html` untouched.

### Deliverables
- [x] **Extract `shared/engine/SharedWebGLPostPipeline.js` & `shared/engine/SharedWebGPUPostPipeline.js`:**
  - Encapsulate HDR scene/TAA targets, 6-mip Karis/Jimenez bloom downsample/upsample chain, 2-pass Panavision anamorphic streak, AgX composite, ping-pong TAA history, and `POST_OPTICS_PROFILES` uniform binding.
  - Each simulator's `WebGLRenderer.js` / `WebGPURenderer.js` retains only its physics raytrace target/pass, simulator-specific bindings (e.g., `binary` tidal compute/FBOs, `wormhole` Universe B sky), and uniform marshalling.
- [x] **Extract `shared/engine/SimAppShell.js`:**
  - Centralize backend fallback (`webgpu` ↔ `webgl2`), `requestAnimationFrame` loop, 85 ms telemetry timer plumbing, `ResizeObserver` wiring, FPS smoothing, keyboard shortcuts (`Space`, `1`–`6`, `H`, `R`, `P`), and PNG export.
  - Each `sims/<id>/src/main.js` supplies simulator-specific state defaults, camera, renderer, HUD instance, and optional hooks (e.g. `wormhole` traverse animation, `starflight` 1g brachistochrone step).
- [x] **Extract `shared/engine/BaseCamera.js`:**
  - Share critically damped scalar/vector spring integrators, spherical/Cartesian basis helpers, preset flight easing, and pointer/wheel normalization while letting each `CameraController.js` keep its own kinematics (e.g., Wormhole traversal, Starflight Lorentz view).
- [x] **Extract `shared/testing/firefoxQaRunner.mjs`:**
  - Consolidate the 7 `sims/<id>/tests/firefox_qa.mjs` scripts (~1,692 LOC) into a single parameterized runner invoked with per-sim debug handle, preset assertions, and camera drag targets.
- [x] **Update `shared/tests/shared_check.mjs`:**
  - Add syntax/export checks covering `shared/engine/*.js` and `shared/testing/firefoxQaRunner.mjs`.

### Exit Criteria & Verification
- `node scripts/run-tests.mjs --physics` passes all 7 sims + `shared/`.
- Live Chrome & Firefox QA (`node scripts/run-tests.mjs --all --sim blackhole`, plus spot-checks on `binary` and `wormhole`) pass with 0 regressions.

---

## Phase O6 — Native Rust Desktop UI Modularization (`desktop/src/ui/`)

**Goal:** Break up the monolithic `desktop/src/ui/mod.rs` (2,253 LOC) and `desktop/src/ui/home.rs` (1,741 LOC) into focused submodules so Desktop UI and performance improvements (Phase P4) have minimal compile-edit blast radius.

### Deliverables
- [x] Split `desktop/src/ui/` into clean submodules:
  - `desktop/src/ui/mod.rs`: Top-level `HudState`, `HudAction`, public UI entrypoints.
  - `desktop/src/ui/theme.rs`: Observatory Glass colors, fonts (`configure_fonts`), spacing tokens, glass/pill widget primitives.
  - `desktop/src/ui/home/`: Homepage grid, hero spotlight, category filters, and dossier modal (`home/mod.rs`, `home/dossier.rs`, `home/cards.rs`).
  - `desktop/src/ui/hud/`: Top-left telemetry badge, top-right simulator switcher, bottom transport/preset dock, restore pill, status toast.
  - `desktop/src/ui/controls/`: Slide-over controls drawer, sliders, segmented/select widgets.

### Exit Criteria & Verification
- `cargo test --manifest-path desktop/Cargo.toml --test physics_parity --test shader_validation` passes.
- `cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path desktop/Cargo.toml -- --check` passes cleanly.

---

## Handoff Gate to `docs/PERFORMANCE_ROADMAP.md`

Before starting [`docs/PERFORMANCE_ROADMAP.md`](./PERFORMANCE_ROADMAP.md), verify:
1. All simulators live under `sims/<id>/` with standardized `CameraController.js` + `Physics.js` and canonical slugs.
2. `node scripts/sync-wgsl.mjs --check` and `node scripts/sync-metadata.mjs --check` pass in CI and Git hooks.
3. Web post-processing lives in `shared/engine/SharedWeb{GL,GPU}PostPipeline.js` and `desktop/src/ui/` is modularized.
4. `node scripts/run-tests.mjs --physics` and `node scripts/run-tests.mjs --desktop` are green on `main`.
