# Changelog

All notable changes to **Interstellar Simulation** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
