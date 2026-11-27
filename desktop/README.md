# Interstellar Desktop (Native Rust + wgpu + egui)

Native Linux, Windows, and macOS desktop port of all 7 dual-backend relativistic GPU ray-tracing simulators from the Interstellar Simulation suite, matching the web version 1:1 in physics, shaders, HDR post-processing, and Observatory HUD styling.

## Included Simulators

- `blackhole` — Gargantua (3D Outgoing Kerr–Schild Black Hole)
- `wormhole` — Morris–Thorne / Ellis Traversable Wormhole (dual-universe A ↔ B)
- `binary` — Binary Black Hole Inspiral & Gravitational-Wave Lensing
- `warp` — Alcubierre / Natário / Lentz FTL Warp Drive
- `supernova` — Volumetric Multi-Scattering Supernova Remnant & Nebula
- `pulsar` — Magnetar & Millisecond Pulsar Magnetosphere & GR Lensing
- `starflight` — Relativistic Starflight (SR Aberration, Doppler & Terrell Sky)

## Prerequisites

- **Linux**: Rust toolchain (`rustc` / `cargo` 1.85+ with edition 2024 support) and a Vulkan-capable GPU driver (NVIDIA / AMD / Intel) under Wayland or X11.
- **Windows**: Windows 10/11 (x86-64) with DX12 or Vulkan GPU drivers (no external DLLs or Visual C++ Redistributable required for the static-CRT `.exe`); to build natively on Windows, install Rust (`x86_64-pc-windows-msvc`).
- **Linux → Windows Cross-Compile**: `rustup target add x86_64-pc-windows-msvc` and `cargo install --locked cargo-xwin`.
- **macOS**: macOS 12.0+ (Apple Silicon or Intel, Metal GPU) with Xcode Command Line Tools (`xcode-select --install`) and Rust 1.85+—or use the GitHub Actions workflow below to build `.dmg` / `.zip` bundles without a Mac.

## Build & Launch (Linux)

```bash
cd desktop
cargo build --release
./run.sh                    # Opens Observatory Homepage by default (zero idle GPU)
./run.sh --sim blackhole    # Launch directly into Gargantua
./run.sh --sim starflight   # Start in a specific simulator
./run.sh --sim wormhole --vsync off --width 1600 --height 900
```

## Windows Build & Executable

Pre-configured cross-compilation from Linux (using `cargo-xwin`, `x86_64-pc-windows-msvc`, and `-C target-feature=+crt-static`) is available via the local Linux helper script (not required on Windows CI, where [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml) builds Linux x86_64 and Windows MSVC binaries natively on `ubuntu-latest` and `windows-latest`):

```bash
cd desktop
./build-windows.sh
```

Output executable:

- `desktop/target/x86_64-pc-windows-msvc/release/interstellar-desktop.exe`

On a Windows machine directly:

```powershell
cd desktop
cargo build --release
.\target\release\interstellar-desktop.exe --sim blackhole
```

Notes:
- Standalone PE32+ Windows GUI (`WINDOWS_GUI` subsystem, no console window on double-click) with `milkyway_4k.jpg`, all 7 WebP Observatory previews, and all 19 WGSL shaders embedded directly in the binary.
- Uses DirectX 12 or Vulkan via `wgpu 30` with static MSVC CRT (`+crt-static` and static `libucrt`), Windows system font discovery (`Inter`, `Segoe UI`, `Cascadia Mono`, `Consolas`, `Segoe UI Symbol`), and 1ms timer resolution (`timeBeginPeriod(1)`) for the 165 FPS frame cap.
- Zero external DLL dependencies beyond built-in Windows OS DLLs (`KERNEL32.dll`, `USER32.dll`, `GDI32.dll`, `WINMM.dll`, `DXGI.dll`, etc.).

## macOS Build & GitHub Actions

If you are developing on Linux without a Mac, `.github/workflows/build-macos.yml` builds a Universal macOS `.app` bundle on GitHub's `macos-latest` runner:

- **Automatic**: Runs on pushes to `main` touching `desktop/**` or `.github/workflows/build-macos.yml`, uploading `.dmg` and `.zip` workflow artifacts.
- **Manual**: Run via **Actions → Build macOS Desktop → Run workflow** with architecture selection (`universal`, `arm64`, or `x86_64`).
- **Tag Releases**: Pushing a `v*` tag automatically attaches the `.dmg` and `.zip` bundles to the GitHub Release.

On a Mac directly:

```bash
cd desktop
./build-macos.sh              # Universal Binary (arm64 + x86_64 via lipo) -> .app, .zip, .dmg
./build-macos.sh --arm64      # Apple Silicon only (aarch64-apple-darwin)
./build-macos.sh --x86_64     # Intel only (x86_64-apple-darwin)
./build-macos.sh --native     # Host architecture only
```

Output artifacts are written under `desktop/target/macos-bundle/` (`Interstellar.app`, `Interstellar-macos-<arch>.zip`, and `Interstellar-macos-<arch>.dmg`).

Notes:
- Uses Apple Metal via `wgpu 30` (`wgpu::Backends::PRIMARY`), Retina HiDPI (`NSHighResolutionCapable = true`), macOS system font discovery (`$HOME/Library/Fonts`, `/Library/Fonts`, `/System/Library/Fonts`, `/System/Library/Fonts/Supplemental`), `Cmd+Q` / `Cmd+W` quit shortcuts, and saves `P` screenshots to `~/Pictures/Interstellar/`.
- Ad-hoc signed (`codesign --force --deep --sign -`) by default (or pass `APPLE_SIGN_IDENTITY` for Developer ID signing). On first launch of an unsigned/ad-hoc downloaded build, macOS Gatekeeper users should **Right-click → Open** (or run `xattr -cr Interstellar.app`).

### CLI Options

- `--home`, `--hub`: Open the Observatory Homepage (default)
- `--sim <name>`: `home`, `blackhole`, `wormhole`, `binary`, `warp`, `supernova`, `pulsar`, `starflight`
- `--width <px>` / `--height <px>`: Initial window dimensions (default `1280x720`)
- `--vsync <on|off>`: Toggle Fifo VSync vs Mailbox/Immediate presentation (frame-capped at `--max-fps`)
- `--max-fps <n>`: Maximum frame rate limit (default `165`)
- `--smoke-frames <n>`: Render `n` live windowed frames and exit cleanly

## Controls & Shortcuts

- **Mouse Drag**: Orbit / Look (Shift-drag or middle-drag for local look)
- **Right-Drag**: Camera roll
- **Scroll Wheel**: Zoom / FOV
- **Double-Click**: Reset camera
- **`W`/`A`/`S`/`D`/`Q`/`E` & Arrow Keys**: Smooth camera flight / roll
- **`1`–`6`**: Select simulation presets
- **`Space`**: Freeze simulation & trigger 128-sample Cinema Still progressive accumulation
- **`T`**: Special action (`Traverse` in Wormhole, `Bridge` in Warp Drive, `Aft / Fwd` in Starflight)
- **`O`**: Toggle Auto-Orbit / Auto-Pan
- **`C`**: Open/close Controls drawer
- **`P`**: Save composite PNG to `./screenshots/` (`~/Pictures/Interstellar/` on macOS)
- **`R`**: Reset camera
- **`H`**: Toggle HUD visibility (`Esc` closes Controls drawer or Quick-Inspect Dossier; top-right Home button returns to Observatory Homepage; `Cmd+Q`/`Cmd+W` quits on macOS)

## Verification

```bash
cd desktop
cargo test
```

## Cross-Platform Architecture

The crate uses portable `wgpu 30` (Vulkan / DX12 / Metal), `winit 0.30`, `egui 0.37`, pure WGSL shaders, and embedded assets (`include_bytes!`) with platform-specific font discovery in `src/ui/mod.rs` and macOS `.app`/`.dmg` packaging via `build-macos.sh` and `.github/workflows/build-macos.yml`.
