# Changelog

All notable changes to **Interstellar Simulation** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [v0.1.4.1-beta] - 2026-11-28

- **Gravitational Lens & Cluster Caustic Ray-Tracer (`sims/lens-cluster`, WebGL2, WebGPU & Native Rust Desktop)**:
  - Added the 8th Observatory engine featuring exact Point-Mass, SIE elliptical, and NFW + subhalo dark-matter cluster halos, analytical magnification caustics (`det A = 1 / |μ|`), Fermat arrival-time contours, and interactive source-plane dragging (`T` toggles Drag Source ↔ Orbit View; `Shift+Drag` moves the background galaxy) with 6 observatory presets (`Perfect Einstein Ring`, `Einstein Cross`, `JWST Giant Cluster Arcs`, `Fold Caustic Merger`, `Microlensing Flash`, `Caustic & Fermat Bench`).
  - Integrated `lens-cluster` into unified metadata (`shared/sims.json`, `desktop/src/sims/registry.rs`, `home/catalogData.js`), `home/previews/lens-cluster.webp`, `shared/shaders/postConfig.js`, and CI/QA harnesses (`physics_check.mjs`, `physics_parity.rs`, `headless_render.rs`).
- **Canonical App Icon & Multi-Platform Desktop Branding**:
  - Designed the vector Observatory app icon (`shared/assets/app-icon.svg`) and added `scripts/generate-icons.mjs` to derive `shared/assets/app-icon-256.png`, `favicon.ico`, `desktop/assets/app-icon.ico`, and `desktop/assets/AppIcon.icns`.
  - Wired icons across web (`index.html`), native Windows PE resources (`desktop/build.rs`), macOS `.app` bundle (`desktop/build-macos.sh`), and Linux Wayland/X11 + `hicolor`/`.desktop` integration (`desktop/src/assets/icon.rs`, `desktop/src/main.rs`), and added `shared/tests/shared_check.mjs` + CI workflow path coverage.
- **Observatory Switcher & Topbar Polish**:
  - Updated the shared web switcher (`shared/ui/simSwitcher.js`, `shared/ui/base.css`) and native desktop topbar (`desktop/src/ui/hud/topbar.rs`), and bumped web and native desktop versions to `0.1.4.1 beta`.

## [v0.1.4.0-beta] - 2026-11-28

- **Full-Lifecycle Supernova Overhaul (WebGL2, WebGPU & Native Rust Desktop)**:
  - Replaced the uniform remnant nebula with a logarithmic full-lifecycle core-collapse detonation (`0.0005 yr` / ~4.4 hr) through aged Sedov–Taylor remnant (`18,000 yr`), driven by a new **Detonate / Stop (`T`)** live ~22 s evolution sweep and sub-year to light-year telemetry (`AU` / `ly`).
  - Added 3-octave Rayleigh–Taylor filament sculpting, turbulent boiling fireball with breakout dust sublimation and UV blast-wave shell, helical MHD bipolar jets with Mach bow-shock caps, SN 1987A clumpy beaded circumstellar ring, Chandra-style concentric synchrotron PWN torus, Veil folded silk shock curtains, forward blast-wave rim, and sculpted dark Bok pillars with Wrenninge multi-scattering rims.
  - Added 6 lifecycle presets (`Shock Breakout`, `SN 1987A Ring`, `Crab Filament Shell`, `Veil Shock Curtains`, `Hubble SHO Pillars`, `Pulsar Cathedral`), live **Bipolar Asymmetry** (`bipolarPower`) and **Relativistic Jets** (`jetPower`) controls (176-byte UBO across GLSL, WGSL, and Rust), and a third **`Chandra / JWST`** composite spectral palette alongside **Hubble SHO** and **True Color**.
  - Updated unified Observatory metadata (`shared/sims.json`, `desktop/src/sims/registry.rs`, `home/catalogData.js`), regenerated `home/previews/supernova.webp`, and bumped web + desktop app version to `0.1.4.0 beta`.

## [v0.1.3.1-beta] - 2026-11-27

- Performance Roadmap Phase P1 (Shared Runtime & Canvas):
  - Added converged-idle frame gating, default `1.5×` render DPR cap + `0.75×` interactive drag scale, zero-allocation hot loops, cached camera bases, 85 ms HUD telemetry throttling, and CSS compositing cleanup across all 7 simulators.
- Performance Roadmap Phase P2 (Post-Processing, Hybrid HDR & LUTs):
  - Switched shared scene/bloom/anamorphic targets to `rg11b10ufloat` / `r11f_g11f_b10f` while keeping `rgba16float` TAA history, hoisted static post UBOs, added pre-baked LUTs (`scripts/bake-luts.mjs`, `shared/assets/physicalLutsData.js`), GPU procedural sky bake (`shared/shaders/sky_bake.wgsl`), and non-blocking sky loading.
- Performance Roadmap Phase P3 (Per-Simulator Optimizations):
  - Applied algorithmic, shader, and engine optimizations across all 7 simulators (`blackhole`, `warp`, `supernova`, `starflight`, `pulsar`, `wormhole`, `binary`) with full WebGL2, WebGPU, and canonical `.wgsl` parity.
- Performance Roadmap Phase P4 (Native Rust Desktop):
  - Added default `1.5×` render DPR cap + `0.75×` drag scale, hybrid `Rg11b10Ufloat`/`Rgba16Float` HDR targets, converged `ControlFlow::Wait`/`WaitUntil` idle power mode, dirty-gated glass blur, merged single-pass swapchain blit + `egui`, removed the 48 MiB `'static OnceLock` sky RAM cache, parallelized blue-noise LUT generation, added async homepage WebP preview decoding, cached per-sim pipelines, hoisted static post UBOs, deduplicated `egui` text shaping, and enabled `panic = "abort"` in `[profile.release]`.

## [v0.1.3.0-beta] - 2026-11-27

- Organization Roadmap Phase O1:
  - Added GPL-3.0 `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `.gitattributes` (LF normalization).
  - Removed unused `glam` and `serde` dependencies from `desktop/Cargo.toml` and refreshed `desktop/Cargo.lock`.
  - Resolved all `cargo clippy --all-targets -- -D warnings` diagnostics and formatted `desktop/` with `rustfmt`.
  - Expanded `.github/workflows/web-ci.yml` with Linux Rust `fmt`, `clippy`, `physics_parity`, and `shader_validation` checks, added `shader_validation` to `.github/workflows/build-macos.yml`, and added native Linux & Windows release builds in `.github/workflows/release-desktop.yml`.
- Organization Roadmap Phases O2–O6:
  - Single-source `.wgsl` files with `scripts/sync-wgsl.mjs --check/--write` keeping all 10 `.wgsl.js` wrappers in lockstep.
  - Unified simulator metadata source of truth (`shared/sims.json`) with `scripts/sync-metadata.mjs --check/--write` generating `shared/simRegistry.js`, `home/catalogData.js`, `desktop/src/sims/registry.rs`, and dynamic flag discovery in `launch.sh`.
  - Migrated all 7 web simulators into canonical `sims/<id>/` directories with standardized 5-file `src/engine/{CameraController,Physics,Presets,WebGLRenderer,WebGPURenderer}.js` layouts, canonical Rust slugs (`binary.rs`, `warp.rs`), and relocated `docs/ideas.md`.
  - Extracted shared web engine and QA modules (`shared/engine/{SharedWebGLPostPipeline,SharedWebGPUPostPipeline,SimAppShell,BaseCamera}.js` and `shared/testing/firefoxQaRunner.mjs`) with extended `shared/tests/shared_check.mjs` contract checks.
  - Modularized `desktop/src/ui/` into `mod.rs`, `theme.rs`, `home/{mod,cards,dossier}.rs`, `hud/{mod,topbar,dock}.rs`, and `controls/{mod,widgets}.rs`.

## [v0.1.2.1-beta] - 2026-11-25

- Overhauled the Observatory Homepage layout, category filtering, and quick-inspect dossiers (`index.html`, `home/`, `desktop/src/ui/home.rs`).
- Fixed HUD centering and responsive alignment across web and desktop simulators.

## [v0.1.2-beta] - 2026-11-25

- Added the Observatory Homepage (`index.html`, `home/`, and native `desktop/` home screen) as the default landing experience with zero idle GPU usage and `?sim=<alias>` deep-link routing.
- Added WebP simulator preview assets (`home/previews/*.webp`) and headless rendering tests (`desktop/tests/headless_render.rs`).

## [v0.1.1-beta] - 2026-11-24

- Reorganized shared web assets, shaders, and UI components under `shared/`.
- Unified web and desktop verification under `scripts/run-tests.mjs` and added Git/agent verification hooks.
- Bumped native desktop crate to `0.1.1-beta`.

## [v0.1.0-beta] - 2026-11-24

- Initial native Rust (`wgpu` + `egui`) desktop suite (`desktop/`) with 1:1 parity across all 7 simulators and GitHub Actions macOS Universal Binary packaging.
- Completed 7 dual-backend **WebGL2 + WebGPU** relativistic simulators: Black Hole (**Gargantua**), Traversable Wormhole, Binary Black Hole Inspiral, Alcubierre/Natário/Lentz Warp Drive, Volumetric Supernova Remnant, Magnetar/Millisecond Pulsar, and Relativistic Starflight.
