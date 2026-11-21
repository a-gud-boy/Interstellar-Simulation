# New Simulation Ideas for Interstellar Spacetime Simulators

## Current Project Foundation

Right now, the repository pairs seven zero-dependency, dual-backend (**WebGL2 + WebGPU**) GPU ray-tracers under a shared cinema-grade HDR pipeline:

- **`blackhole-sim/` (Gargantua) — ✅ Implemented:** Exact 3D Outgoing Kerr–Schild null geodesics, ZAMO observer tetrad, Bardeen–Press–Teukolsky ISCO, 128³ volumetric MHD accretion plasma with Doppler beaming + Planck blackbody LUT, and Blandford–Znajek polar jets.
- **`wormhole-sim/` (Morris–Thorne / Ellis) — ✅ Implemented:** Adaptive RK4 curved-space geodesics across $l \in (-\infty, +\infty)$, James–Thorne $D_{\text{neg}}$ and Ellis drainhole metrics, dual-universe equirectangular skies, and smooth $l = 0$ throat traversal.
- **`binary-bh-sim/` (Binary Black Hole Inspiral) — ✅ Implemented:** Two-body Brill–Lindquist Fermat optical metric + 1PN gravitomagnetic frame-dragging + pole-free Cartesian TT retarded quadrupole gravitational wave shear + ISW sky modulation, 2.5PN Peters–Mathews orbital inspiral, 256×256 co-rotating GPU tidal hydrodynamics resolving circumbinary disk cavities, spiral shocks, S-shaped tidal gas bridges, twin mini-disks, and fractal eyebrow shadows.
- **`warp-drive-sim/` (Alcubierre / Natário / Lentz Warp Drive) — ✅ Implemented:** Backward ADM null geodesic RK4 integration across Alcubierre, Natário Zero-Expansion ($\theta \equiv 0$), and Lentz Soliton ($L_p$ rhomboidal positive/negative $T_{00}$) warp bubbles up to $5.0c$, Cherenkov cyan 128³ volumetric exotic wall shimmer, relativistic Doppler bow-shock caustics, superluminal aft Causal Horizon, and live External Chase ↔ Inside Bridge view toggling (`T`).
- **`supernova-sim/` (Supernova Remnant & Nebula) — ✅ Implemented:** Volumetric multi-scattering radiative transfer across Sedov–Taylor / free-expansion shock shells, 4-octave Wrenninge multiple scattering + normalized dual-lobe Henyey–Greenstein phase function, pole-free 3D Rayleigh–Taylor filaments, dark Bok globules, `Hubble SHO` vs `True Color Broadband` narrowband palettes, and origin-safe `W`/`S` deep interior fly-through.
- **`pulsar-sim/` (Magnetar / Millisecond Pulsar) — ✅ Implemented:** 3D Outgoing Kerr–Schild light bending exposing $>50\%$ of the neutron star crust (`GR Curved` vs `Flat Space`), co-rotating Planck blackbody polar caps + molten magnetar tectonic cracks with relativistic Doppler/redshift beaming, twisted oblique dipole pair-plasma flux tubes up to the light cylinder $R_{\text{LC}}$, sweeping lighthouse beams with Deutsch retardation, and equatorial PWN torus & helical polar jets.
- **`starflight-sim/` (Relativistic Starflight) — ✅ Implemented:** Cancellation-free Special Relativistic Lorentz null-ray aberration up to $0.9999996c$ ($\gamma \approx 1050$), exact Doppler shift $D$ + CIE-1931 Planck blackbody temperature shift across the 4K Milky Way, UV/IR star bands, and Planck-mottled CMB shell ($T_{\text{fwd}} = 2.7255\,D_{\text{fwd}}$), Penrose–Terrell rotated 3D periodic navigation rings & beacon stations, 128³ volumetric hydrogen dust streaks, $1g$ brachistochrone cruise, and Forward ↔ Aft window flipping (`T`).

All seven share a powerful reusable architecture:
- Live **WebGL2 / WebGPU** backend switching (`?backend=`) with RAM-cached assets
- **128-sample progressive accumulation** on pause (`Space`) + HDR YCoCg variance-clipped **TAA**
- 6-mip Karis/Jimenez **HDR bloom**, 70mm **anamorphic flare**, and **AgX** filmic tone mapping
- **128³ periodic 3D noise** (FBM, ridged, Worley, micro) + 128×128 blue-noise stratification + CIE-1931 Planck blackbody LUT
- Observatory HUD with live physics telemetry, `1`–`6` presets, and automated `physics_check.mjs` / `browser_qa.mjs` / `firefox_qa.mjs` verification suites

Below are new standalone simulators (`<name>-sim/`) that fit naturally into this exact architecture and visual standard.

---

## 1. [IMPLEMENTED] Binary Black Hole Inspiral & Gravitational Wave Lensing (`binary-bh-sim/`)

> **Status:** ✅ **Implemented** in [`binary-bh-sim/`](./binary-bh-sim/)

Two orbiting Kerr/Schwarzschild black holes spiraling toward merger, bending starlight and tidal accretion streams in real time.

- **Core Physics & Math:**
  - **Majumdar–Papapetrou / Post-Newtonian superposition** (two-center effective metric or quasi-circular 2.5PN orbital inspiral $r_{\text{sep}}(t)$, $\Omega(t)$) integrated via adaptive RK4 null geodesics.
  - Optional **retarded-time gravitational wave strain** $h_+, h_\times$ ripple field radiating outward in the wave zone, subtly shearing background starlight and caustic rings.
  - Dual photon spheres creating **fractal self-similar "eyebrow" lensing shadows** (as famously rendered by Kip Thorne / SXS numerical relativity visualizations).
- **Visuals & Shader Architecture:**
  - Twin horizon shadows against the 4K Milky Way sky, plus a **circumbinary accretion disk** with tidal gap clearing and **gas bridges (mini-disks)** feeding each black hole.
  - Real-time orbital phase animation (`Space` pauses into 128-sample cinema still mode to resolve ultra-sharp fractal secondary shadows).
  - **WebGPU compute opportunity:** Pre-solve or step a lightweight 2D/3D SPH or shallow-water tidal bridge density field each frame for authentic spiral shockwaves.
- **Controls, Presets & Telemetry:**
  - *Controls:* Mass ratio $q = m_2/m_1$, separation $d/M$, orbital inclination, GW amplitude exaggeration, circumbinary disk density, time-warp speed.
  - *Telemetry:* Orbital separation ($M$), orbital frequency ($f_{\text{GW}}$), chirp phase, and relativistic orbital velocity ($v/c$).
  - *Presets (`1`–`6`):* `Equal-Mass Inspiral`, `Extreme Mass Ratio (10:1)`, `Edge-On Eyebrow Shadows`, `Tidal Gas Bridges`, `Pre-Merger Plunge`, `Pure Vacuum Binary`.

---

## 2. [IMPLEMENTED] Alcubierre / Lentz Warp Bubble Transit (`warp-drive-sim/`)

> **Status:** ✅ **Implemented** in [`warp-drive-sim/`](./warp-drive-sim/)

A first-person and external-observer relativistic ray-tracer of an **Alcubierre warp metric** (and smooth Natário zero-expansion variant) cruising through the Milky Way at subluminal and superluminal apparent speeds.

- **Core Physics & Math:**
  - Exact **Alcubierre ADM metric** $ds^2 = -dt^2 + (dx - v_s(t) f(r_s) dt)^2 + dy^2 + dz^2$ with smooth wall shaping function $f(r_s)$ (radius $R$, wall thickness $\sigma$).
  - Ray-traced null geodesics from either an **external chase camera** (seeing the distorted refractive bubble and horizon) or a **bridge cockpit camera inside the flat interior** ($f \approx 1$).
  - **Relativistic aberration, Doppler shift, and Hawking-like bow/stern caustics** when $v_s > c$ (forward horizon blue-shifts and piles starlight into a blinding ring; aft view forms a dark causal horizon).
- **Visuals & Shader Architecture:**
  - Uses the existing Planck blackbody / spectral shift math to shift the 4K Milky Way starfield across UV/IR extremes as $v_s / c$ crosses $1.0$.
  - Translucent volumetric **Cherenkov / exotic-energy wall shimmer** along the negative energy density torus $T_{00} \propto -\frac{v_s^2 (y^2 + z^2)}{4 r_s^2} (df/dr_s)^2$.
  - Dramatic anamorphic horizontal lens flares off the forward blue-shifted star bow-shock.
- **Controls, Presets & Telemetry:**
  - *Controls:* Warp factor $v_s / c$ (`0.0` to `5.0c`), bubble radius $R$, wall thickness $\sigma$, metric variant (`Alcubierre` vs `Natário Zero-Expansion`), camera mode (`Inside Bridge` vs `External Chase` toggled with `T`).
  - *Telemetry:* Apparent velocity ($v_s/c$), peak York expansion $\theta$, forward/aft Doppler factor $g$, causal horizon angle.
  - *Presets (`1`–`6`):* `Subluminal Cruise (0.8c)`, `Light Barrier (1.0c)`, `Superluminal (2.5c)`, `Bridge View (Cockpit)`, `Thin-Wall High-Energy`, `Natário Stealth Bubble`.

---

## 3. [IMPLEMENTED] Magnetar / Millisecond Pulsar Magnetosphere (`pulsar-sim/`)

> **Status:** ✅ **Implemented** in [`pulsar-sim/`](./pulsar-sim/)

A rapidly spinning, ultra-magnetized neutron star combining **Schwarzschild/Hartle–Thorne spacetime curvature** with curved dipole/twisted magnetic fields and rotating synchrotron beams.

- **Core Physics & Math:**
  - **Light bending near $R \approx 2.2\,R_s$–$3\,R_s$**: Because a neutron star is nearly compact enough to expose its back hemisphere via gravitational lensing, ray-traced curved geodesics reveal **more than 50% of the stellar surface** simultaneously (causing pulsed hot spots to never fully disappear).
  - **Rotating oblique dipole + Deutsch vacuum / force-free magnetosphere** with magnetic axis tilted by $\alpha$ relative to the spin axis, plus **light cylinder** radius $R_{\text{LC}} = c/\Omega$.
  - **Gravitational redshift** $z = (1 - R_s/R)^{-1/2} - 1$ and rotational Doppler shift across the fast-spinning crust.
- **Visuals & Shader Architecture:**
  - Procedural 3D crustal hot spots (polar caps glowing at $10^6$–$10^7\,\text{K}$ mapped via the Planck blackbody LUT) + glowing magnetic **pair-plasma flux loops** rendered via volumetric ray-marching.
  - Sweeping **lighthouse synchrotron / curvature radiation cones** + surrounding **pulsar wind nebula (PWN) torus and polar jets** (reusing and extending the `blackhole-sim` 128³ noise & jet machinery).
- **Controls, Presets & Telemetry:**
  - *Controls:* Compactness $M/R$, spin period (ms), magnetic obliquity $\alpha$, twist shear, beam intensity, magnetosphere plasma density, PWN nebula visibility.
  - *Telemetry:* Surface gravity redshift $z$, visible surface fraction ($>50\%$), light-cylinder radius $R_{\text{LC}}$, spin frequency (Hz).
  - *Presets (`1`–`6`):* `Crab-like Young Pulsar`, `Millisecond Recycled Pulsar`, `Ultra-Compact Magnetar`, `Polar Cap View`, `Edge-On Lighthouse`, `Torus & Jet PWN`.

---

## 4. [IMPLEMENTED] Relativistic Starflight — Aberration & Doppler Sky (`starflight-sim/`)

> **Status:** ✅ **Implemented** in [`starflight-sim/`](./starflight-sim/)

An interactive *Tau Zero* / *Project Hail Mary* / relativistic-rocket simulator exploring how the universe visually transforms when accelerating from $0c$ to $0.9999c$.

- **Core Physics & Math:**
  - Exact **Special Relativistic Lorentz transformation of null rays**:
    - **Relativistic aberration** (headlight effect) compressing the entire $4\pi$ sky into a forward cone: $\cos\theta' = \frac{\cos\theta - \beta}{1 - \beta\cos\theta}$.
    - **Exact Doppler factor** $D = [\gamma(1 - \beta\cos\theta')]^{-1}$ scaling spectral radiance by $D^3$ (or $D^{3+\alpha}$) and shifting star/CMB/nebula color temperatures via blackbody spectral shift.
    - **Penrose–Terrell rotation** on foreground reference geometry (asteroids, beacon ships, space stations, Dyson rings, or a 3D procedurally placed starfield catalog) so passing objects appear rotated rather than flattened.
  - Optional **1g / constant proper-acceleration flight mode** tracking coordinate time $t$ vs ship proper time $\tau = \frac{c}{a}\operatorname{arsinh}(at/c)$ as you fly past foreground stars and dust lanes.
- **Visuals & Shader Architecture:**
  - Samples the 4K Milky Way sky + procedural high-dynamic-range multi-spectral stars (UV and IR bands that become visible only when Doppler-shifted into the visible spectrum!).
  - Includes a **cosmic microwave background (CMB)** shell that blue-shifts into a glowing visible ring at $\gamma \gtrsim 1000$.
  - Volumetric interstellar hydrogen dust streaks rushing past the viewport with authentic Terrell rotation and relativistic beaming.
- **Controls, Presets & Telemetry:**
  - *Controls:* Velocity $\beta = v/c$ (logarithmic slider down to `0.99999c`), proper acceleration ($g$), camera look yaw/pitch (`Shift-drag` to look out the aft window!), CMB visibility, foreground star density, flight forward/reverse.
  - *Telemetry:* Velocity ($\beta$), Lorentz factor ($\gamma$), forward/aft Doppler shift ($D_{\text{fwd}}, D_{\text{aft}}$), proper-to-coordinate time dilation rate.
  - *Presets (`1`–`6`):* `0.50c Sub-Relativistic`, `0.90c Headlight Cone`, `0.995c UV Milky Way`, `0.9999c CMB Glow`, `Aft Redshift View`, `1g Brachistochrone Cruise`.

---

## 5. Gravitational Lensing Observatory — Einstein Rings & Galaxy Cluster (`lens-cluster-sim/`)

An interactive deep-field gravitational lens simulator inspired by *JWST* / *Hubble* galaxy clusters and strong-lensing Einstein crosses.

- **Core Physics & Math:**
  - Multi-plane or thin-lens **ray deflection equation** $\vec{\beta} = \vec{\theta} - \vec{\alpha}(\vec{\theta})$ supporting:
    - **Point-mass / Schwarzschild lens** (classic Einstein ring & microlensing magnification),
    - **Singular Isothermal Ellipsoid (SIE)** + external shear (producing **quadruple Einstein crosses**, fold arcs, and cusp triplets),
    - **NFW dark matter halo + cluster member galaxies** (Abell-style giant tangential & radial arcs).
  - Exact analytical **caustic and critical curve overlay toggle** (computed directly from the Jacobian determinant $\det A(\vec{\theta}) = 0$ in shader).
- **Visuals & Shader Architecture:**
  - Ray-traces a rich procedural **background source plane** containing spiral galaxies, star-forming HII knots, and quasar cores that can be dragged in real time across the source plane to watch arcs merge, split, and flash as they cross caustics.
  - Foreground glowing elliptical cluster galaxies + faint X-ray intracluster gas halo using 128³ volumetric noise.
  - Clean 128-sample progressive accumulation on pause for razor-sharp faint lensed arcs.
- **Controls, Presets & Telemetry:**
  - *Controls:* Lens model (`Point Mass`, `SIE Elliptical`, `NFW Cluster`), Einstein radius $\theta_E$, ellipticity $e$, external shear $\gamma_{\text{ext}}$, source offset $(x_s, y_s)$ (interactive mouse drag mode!), caustic/critical curve overlay toggle.
  - *Telemetry:* Total magnification $\mu$, image multiplicity, Einstein radius ($\text{arcsec}$), lens mass ($M_\odot$).
  - *Presets (`1`–`6`):* `Perfect Einstein Ring`, `Einstein Cross (Quad)`, `Abell Cluster Giant Arcs`, `Fold Caustic Merger`, `Microlensing Transit`, `Caustic Diagnostic View`.

---

## 6. Kerr–Newman Charged Black Hole & Naked Singularity (`kerr-newman-sim/`)

An extension—or dedicated companion—to Gargantua exploring the three-parameter **Kerr–Newman** spacetime ($M, a, Q$) and the transition across the extremal limit $a^2 + Q^2 = M^2$ into a **naked ring singularity**.

- **Core Physics & Math:**
  - Exact **Kerr–Schild charged metric** where $H = \frac{M r^3 - \frac{1}{2} Q^2 r^2}{r^4 + a^2 y^2}$ (in $G=c=4\pi\varepsilon_0=1$ units).
  - When $a^2 + Q^2 < M^2$: double horizons $r_\pm = M \pm \sqrt{M^2 - a^2 - Q^2}$, modified ISCO and photon sphere radii, and a shrinking shadow size as charge $Q$ increases.
  - When $a^2 + Q^2 > M^2$: the event horizon vanishes, exposing the **naked ring singularity** ($r = 0, y = 0$ ring of radius $a$) and **$r < 0$ antiverse sheet** accessible through the ring (continuing the dual-universe concept from `wormhole-sim`!).
- **Visuals & Shader Architecture:**
  - Connects the visual language of `blackhole-sim` and `wormhole-sim`: as you push $a^2 + Q^2 > M^2$, the black shadow dissolves and rays passing through the $r = 0$ ring emerge into the $r < 0$ negative-gravity sheet with its own distinct sky!
  - Optional electromagnetic field lines / synchrotron glow around the charged rotating ergosphere.
- **Controls, Presets & Telemetry:**
  - *Controls:* Spin $a/M$, electric charge $Q/M$, extremal clamp toggle (safe vs naked singularity mode), disk temperature & density, $r<0$ sheet sky intensity.
  - *Telemetry:* $a^2 + Q^2$, outer/inner horizon $r_\pm$, shadow angular diameter, naked-singularity status.
  - *Presets (`1`–`6`):* `Sub-Extremal Kerr-Newman`, `Extremal Horizon`, `Reissner-Nordström (a=0)`, `Naked Ring Singularity`, `Antiverse Window (r<0)`, `Charged Quasar`.

---

## 7. Protoplanetary Disk & Tidal Disruption Event (`tde-sim/`)

A time-evolving relativistic hydrodynamics + radiative transfer simulation of a **star shredded by a supermassive black hole (TDE)**—directly leveraging WebGPU compute shaders with a WebGL2 ping-pong fallback.

- **Core Physics & Math:**
  - Combines the **Kerr–Schild ray-tracer** from `blackhole-sim` with a **dynamic 3D/2D relativistic debris stream** evolving under apsidal precession (relativistically precessing elliptical orbits causing the returning debris stream to self-intersect and shock-heat into an asymmetric accretion torus).
  - Real-time stream self-intersection shock heating ($T_{\text{shock}} \sim 10^4$–$10^5\,\text{K}$) mapped through the Planck blackbody LUT.
- **Visuals & Shader Architecture:**
  - **WebGPU compute particle/grid advector** (or WebGL2 `RGBA16F` transform-feedback / texture ping-pong) updating debris stream density and temperature, sampled volumetrically by the curved-spacetime ray-tracer.
  - Dramatic visual narrative: an intact star approaches the tidal radius $R_t = R_\star (M_{\text{BH}}/M_\star)^{1/3}$, stretches into a luminous spaghettified arc, wraps around the Kerr shadow, collides with itself, and ignites a lensed asymmetric disk + transient jet.
- **Controls, Presets & Telemetry:**
  - *Controls:* Penetration factor $\beta = R_t / R_p$, black hole spin $a/M$, impact inclination, stream shock heating, playback scrubbing / time-lapse speed.
  - *Telemetry:* Tidal radius $R_t$, orbital eccentricity $e$, apsidal precession angle $\Delta\phi$, peak shock temperature (K).
  - *Presets (`1`–`6`):* `First Passage (Spaghettification)`, `Self-Intersection Shock`, `Eccentric Debris Torus`, `Retrograde Plunge`, `Hills Mechanism Binary`, `Late-Time Circularized Disk`.

---

## 8. [IMPLEMENTED] Cosmic Ray-Traced Nebula & Supernova Remnant (`supernova-sim/`)

> **Status:** ✅ **Implemented** in [`supernova-sim/`](./supernova-sim/)

A pure volumetric multi-scattering & emission-line astrophysical nebula simulator (Crab / Veil / Pillars-style) built on the project's 128³ 3D noise and HDR pipeline.

- **Core Physics & Math:**
  - **Multi-species radiative transfer** along curved or straight rays: separating hot ionized inner shock shells ($\text{O III}$ teal, $\text{H}\alpha$ crimson, $\text{S II}$ gold) from cold dark foreground dust lanes with **Henyey–Greenstein anisotropic forward scattering** from a central white dwarf / pulsar illuminator.
  - **Expanding blast-wave Sedov–Taylor / Rayleigh–Taylor instability** filaments animated in 3D spherical coordinates.
- **Visuals & Shader Architecture:**
  - Deep parallax fly-through inside a 3D volumetric supernova remnant (`W`/`S` flies into the shell, `Space` accumulates 128 samples for crisp noise-free astrophotography stills).
  - Uses blue-noise ray jittering + TAA so fine Rayleigh–Taylor fingers render smoothly at 60 FPS even at full 4K resolution.
- **Controls, Presets & Telemetry:**
  - *Controls:* Shock expansion age, Rayleigh–Taylor turbulence, dust absorption opacity, forward-scattering anisotropy $g_{\text{HG}}$, central star luminosity, narrowband palette (`Hubble SHO` vs `True Color Broadband`).
  - *Telemetry:* Shock radius (ly), expansion velocity ($\text{km/s}$), optical depth $\tau$, central remnant temperature (K).
  - *Presets (`1`–`6`):* `Crab Filament Shell`, `Veil Shock Front`, `Hubble SHO Narrowband`, `Dark Bok Globules`, `Central Pulsar Cavity`, `Deep Interior Flythrough`.

---

## Recommended Next Builds & Platform Evolution

### Top 3 Highest-Impact Additions
1. ~~**`warp-drive-sim/` (Alcubierre Warp Bubble):**~~ ✅ **Implemented** — Best visual contrast to Black Hole & Wormhole, completes the *Interstellar / Sci-Fi Spacetime* trilogy, reuses the exact 4K Milky Way sky + RK4 geodesic integrator + Planck spectral shift, and supports an awesome `T` key toggle between **External Chase** and **Inside Bridge** views.
2. ~~**`binary-bh-sim/` (Binary Black Hole Merger):**~~ ✅ **Implemented** — Highest physics "wow factor" — fractal eyebrow lensing shadows and tidal accretion bridges directly build on `blackhole-sim`'s Kerr–Schild + volumetric disk math while showcasing WebGPU's performance advantage.
3. ~~**`pulsar-sim/` (Magnetar / Millisecond Pulsar):**~~ ✅ **Implemented** — Directly complements `blackhole-sim` (compact object comparison: horizon vs solid relativistic surface showing >50% of the crust due to light bending) and reuses volumetric plasma + polar jets.

### Architectural Upgrades Across All Simulators
- **Shared Core Library (`shared/`):** Extract the duplicated `post.glsl.js` / `post.wgsl.js`, `physicalLuts.js`, `skyLoader.js`, `CameraController` math, and `ControlsHUD.js` shell into a shared ES module directory so every new `<name>-sim/` only needs to author its physics metric, shader, presets, and HUD schema.
- **Multi-Sim Hub (`index.html` & `launch.sh`):** Turn the root `index.html` from an immediate redirect into an interactive **Observatory Hub** gallery (preserving `?sim=` / `--sim <name>` in `launch.sh`) and upgrade the top-right `#sim-switch-link` pill into a compact **Simulator Switcher dropdown** carrying the active `?backend=webgl2|webgpu` across all simulators.
