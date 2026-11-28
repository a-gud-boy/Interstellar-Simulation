# Interstellar Simulation — Next Steps

Suggested follow-ups and future directions following `v0.1.4.1-beta` (completion of the Organization Roadmap `O1–O6`, Performance Roadmap `P1–P4`, Supernova overhaul, `sims/lens-cluster`, and canonical app icons).

---

## 1. Quick Cleanup & Post-`v0.1.4.1` Housekeeping

Now that `sims/lens-cluster/` is the 8th simulator in the Observatory suite, a few docs and test labels still reference 7 simulators:

- [x] **Sync documentation counts to 8 engines**: Update `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, and `desktop/README.md` (which still lists 7 simulators, omits `lens-cluster` from CLI options, and references 7 WebP previews / 19 WGSL shaders).
- [x] **Update CI and test labels**: Rename `Shared & 7-Sim Physics Contracts` in `.github/workflows/web-ci.yml` and update stale `7` simulator comments in `shared/tests/shared_check.mjs` and `sims/starflight/tests/browser_qa.mjs`.

---

## 2. High-Value UX & Observatory Features (Web + Desktop)

- [x] **Shareable URL State & Deep-Linking**: Extend `index.html` and `shared/engine/SimAppShell.js` beyond `?sim=` and `?backend=` to serialize/restore active preset, camera pose, and physics parameters via URL query/hash params.
- [x] **Cinema Video / Turntable & Evolution Recorder**: Complement `P` (PNG screenshot) and `Space` (128-sample progressive accumulation) with deterministic frame-sequence or `MediaRecorder` WebM export for `supernova` detonations, `binary` inspirals, `wormhole` traversals, and `pulsar` lighthouse sweeps.
- [x] **Persistent Graphics & Quality Profiles**: Expand `localStorage` persistence in `SimAppShell.js` (and settings persistence in `desktop/`) to save DPR cap, resolution scale, and `Eco / Balanced / Ultra` quality profiles across sessions.
- [x] **Interactive Physics Tour / Annotated HUD Mode**: Add an optional, toggleable overlay per preset explaining live relativistic phenomena on screen (e.g., photon ring vs. ISCO in `blackhole`, critical curves vs. caustics in `lens-cluster`, Causal Horizon in `warp`, Penrose–Terrell rotation in `starflight`).

---

## 3. Physics, Sensory & Simulator Expansion

- [x] **Real-Time Audio / Sonification**:
  - **Binary BH**: Synthesize gravitational-wave chirp audio synced to the 2.5PN Peters–Mathews inspiral frequency and strain amplitude.
  - **Pulsar**: Synthesize beam-sweep pulse trains synced to spin period and magnetic inclination.
- [x] **9th Observatory Engine Candidates** (`sims/tde/` implemented):
  - [x] **Tidal Disruption Event (TDE)**: Stellar stream disruption around a Kerr SMBH with self-intersecting shock heating.
  - [ ] **Neutron Star Merger / Kilonova**: Binary neutron stars with tidal deformability, r-process ejecta cocoon, and off-axis short-GRB jet.
  - [ ] **AGN Blazar / Relativistic Jet**: Collimated parsec-scale MHD jet with apparent superluminal shock knots and viewing-angle Doppler boosting.

---

## 4. Engineering, Profiling & Distribution

- [x] **Live GPU Pass Profiler Overlay**: Add an optional HUD developer readout using WebGPU `timestamp-query`, WebGL2 `EXT_disjoint_timer_query_webgl2`, and `wgpu` timestamp queries in `desktop/` to measure raymarch vs. post-processing pass timings live.
- [x] **Cross-Backend Visual Parity Diffing**: Compare rendered PNGs across WebGL2, WebGPU, and `desktop/tests/headless_render.rs` using perceptual/PSNR thresholds per preset to catch shader or tone-mapping drift automatically.
- [x] **PWA / Offline Asset Caching**: Add a lightweight Service Worker (compatible with GitHub Pages and `.nojekyll`) to cache `shared/assets/milkyway_4k.jpg` and simulator ES modules for fast repeat and offline launches.
- [x] **Desktop Packaging Channels**: Build on `.github/workflows/release-desktop.yml` and `.github/workflows/build-macos.yml` with Linux AppImage/Flatpak, Homebrew cask, or Winget manifests for one-command installation and updates.
