# Contributing to Interstellar Simulation

Thank you for contributing to **Interstellar Simulation**!

## Prerequisites

- **Web Suite**: Node.js 22+ and Python 3 (zero npm dependencies or bundlers; pure ES modules).
- **Headed Browser GPU QA (optional, Linux + NVIDIA)**: `/usr/bin/google-chrome` (X11) and `firefox` (Wayland) with NVIDIA drivers.
- **Native Desktop (`desktop/`)**: Rust 1.85+ (Edition 2024) with `clippy` and `rustfmt`.
  - Linux: Vulkan-capable GPU driver.
  - Windows: MSVC toolchain (`x86_64-pc-windows-msvc`). Note that [`desktop/build-windows.sh`](./desktop/build-windows.sh) is a local Linux `cargo-xwin` cross-compile helper; Windows CI builds natively on `windows-latest` in [`.github/workflows/release-desktop.yml`](./.github/workflows/release-desktop.yml).
  - macOS: Xcode Command Line Tools (`metal` via `wgpu`).

## Local Launch

Serve the repository root (not an individual simulator directory) using [`./launch.sh`](./launch.sh):

```bash
./launch.sh                  # Observatory Homepage (Chrome, WebGL2 default)
./launch.sh --blackhole      # Launch a specific simulator
./launch.sh --sim warp --webgpu
./launch.sh --firefox --pulsar
./launch.sh --desktop        # Native Rust desktop app
```

## Git Hooks

Enable the tracked repository hooks once per clone so `physics_check.mjs` and `desktop/` cargo tests run automatically before commits and pushes:

```bash
git config core.hooksPath .githooks
```

## Dual-Backend & Cross-Platform Parity

All simulators maintain strict parity across **WebGL2** (`*.frag.js` / `WebGLRenderer.js`), **WebGPU** (`*.wgsl.js` / `WebGPURenderer.js`), and the **Native Rust Desktop** (`desktop/`). Whenever you change shader uniforms, buffer layouts, physics equations, or post-processing parameters, update all corresponding backends and run the verification suite below.

## Verification

```bash
# Shared contracts + all 7 simulator physics/shader checks
node scripts/run-tests.mjs --physics

# Native Rust physics parity & WGSL shader validation
node scripts/run-tests.mjs --desktop

# Full suite for one simulator (includes Chrome/Firefox QA if display + NVIDIA GPU present)
node scripts/run-tests.mjs --all --sim blackhole

# Rust lint & formatting checks
cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path desktop/Cargo.toml -- --check
```

## License

This project is licensed under the **GNU General Public License v3.0** — see [`LICENSE`](./LICENSE) for details.
