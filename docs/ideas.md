# Future Ideas — Interstellar Spacetime Simulators

> Living ideation catalog for future simulators, flagship engine upgrades, and cross-platform capabilities across **WebGL2**, **WebGPU**, and the native Rust **`wgpu` + `egui`** desktop app. Completed foundational refactors and optimization passes live in [`ORGANIZATION_ROADMAP.md`](./ORGANIZATION_ROADMAP.md) and [`PERFORMANCE_ROADMAP.md`](./PERFORMANCE_ROADMAP.md).

---

## Current Implemented Suite (7 Simulators — `v0.1.3.1-beta`)

The repository currently ships **seven** zero-dependency, triple-target (**WebGL2 + WebGPU + Native Rust `wgpu`**) GPU ray-tracers under a unified cinema-grade HDR pipeline:

| Directory | Category | Simulator | Implemented Physics & Visual Highlights |
| :--- | :--- | :--- | :--- |
| [`sims/blackhole/`](../sims/blackhole/) | `gr` | **Gargantua Black Hole** | 3D Outgoing Kerr–Schild null geodesics, ZAMO observer tetrad, Bardeen–Press–Teukolsky ISCO, 128³ volumetric MHD accretion plasma with Doppler beaming + Planck blackbody LUT, and Blandford–Znajek polar jets. |
| [`sims/wormhole/`](../sims/wormhole/) | `exotic` | **Traversable Wormhole** | Adaptive RK4 curved-space geodesics across proper distance $l \in (-\infty, +\infty)$, James–Thorne $D_{\text{neg}}$ and Ellis drainhole metrics, dual-universe skies (Universe A ↔ Universe B), and zero-flip $l=0$ throat traversal (`T`). |
| [`sims/binary/`](../sims/binary/) | `gr` | **Binary Black Hole Inspiral** | Brill–Lindquist Fermat optical metric + 1PN frame-dragging + pole-free Cartesian TT retarded quadrupole GW shear + ISW sky modulation, 2.5PN Peters–Mathews inspiral, 256×256 GPU tidal hydrodynamics (WebGPU compute / WebGL2 `RGBA16F` ping-pong), tidal gas bridges, and fractal eyebrow shadows. |
| [`sims/warp/`](../sims/warp/) | `exotic` | **FTL Warp Drive** | Backward ADM null geodesic RK4 integration across Alcubierre, Natário Zero-Expansion ($\theta \equiv 0$), and Lentz Soliton ($L_p$ positive/negative $T_{00}$) bubbles up to $5.0c$, Cherenkov 128³ wall shimmer, Doppler bow-shock caustics, aft Causal Horizon, and External Chase ↔ Inside Bridge view toggle (`T`). |
| [`sims/supernova/`](../sims/supernova/) | `astro` | **Supernova Remnant & Nebula** | Analytic bounding-sphere radiative transfer across Sedov–Taylor / free-expansion blast shells, 4-octave Wrenninge multiple scattering + dual-lobe Henyey–Greenstein dust phase function, 3D Rayleigh–Taylor filaments, dark Bok globules, `Hubble SHO` / `True Color` palettes, and deep interior fly-through (`W`/`S`). |
| [`sims/pulsar/`](../sims/pulsar/) | `gr` / `astro` | **Magnetar / Millisecond Pulsar** | 3D Outgoing Kerr–Schild light bending exposing $>50\%$ of the neutron star crust (`GR Curved` vs `Flat Space`), relativistic redshift & Doppler beaming across $10^6\text{--}10^7\,\text{K}$ polar caps and molten crust cracks, twisted oblique dipole pair-plasma loops inside $R_{\text{LC}}$, sweeping lighthouse beams with Deutsch retardation, and equatorial PWN torus + jets. |
| [`sims/starflight/`](../sims/starflight/) | `sr` | **Relativistic Starflight** | Cancellation-free Special Relativistic Lorentz aberration up to $0.9999996c$ ($\gamma \approx 1050$), exact Doppler shift $D$ + Planck blackbody shift across the 4K Milky Way, UV/IR star bands, and CMB shell ($T_{\text{fwd}} = 2.7255\,D_{\text{fwd}}$), Penrose–Terrell rotated 3D rings & beacons, $1g$ brachistochrone cruise, and Forward ↔ Aft flip (`T`). |

### Proven Reusable Architecture

Every simulator builds on the `v0.1.3.1-beta` zero-dependency static ES-module and native Rust stack:

- **Triple-Target Parity:** Live **WebGL2** ↔ **WebGPU** switching via `?backend=` with RAM-cached sky textures, plus 1:1 native Rust [`desktop/`](../desktop/) (`wgpu` + `egui`) parity. Canonical `.wgsl` shader sources stay in lockstep with `.wgsl.js` wrappers via [`scripts/sync-wgsl.mjs`](../scripts/sync-wgsl.mjs), and unified simulator metadata in [`shared/sims.json`](../shared/sims.json) syncs web, homepage, desktop, and `launch.sh` via [`scripts/sync-metadata.mjs`](../scripts/sync-metadata.mjs).
- **Shared Engine & Hybrid HDR Pipeline:** [`shared/engine/`](../shared/engine/) (`SimAppShell`, `BaseCamera`, `SharedWebGLPostPipeline`, `SharedWebGPUPostPipeline`) drives hybrid `rg11b10ufloat` scene/bloom/anamorphic targets + `rgba16float` YCoCg variance-clipped **TAA**, **128-sample progressive accumulation** on pause (`Space`), 6-mip Karis/Jimenez **HDR bloom**, 70mm **anamorphic flare**, **AgX** tone mapping, converged-idle frame gating, and default `1.5×` DPR cap / `0.75×` drag scaling.
- **Pre-Baked & Procedural Primitives:** Pre-baked CIE-1931 **Planck blackbody** & 128×128 **blue-noise** LUTs ([`scripts/bake-luts.mjs`](../scripts/bake-luts.mjs)), GPU procedural sky bake ([`sky_bake.wgsl`](../shared/shaders/sky_bake.wgsl)) + shared 4K Milky Way, 128³ periodic 3D noise compute bake, and dual-backend **256×256 GPU compute / `RGBA16F` ping-pong** dynamic field solvers (proven in `sims/binary/`).
- **Observatory Hub & Automated QA:** Zero-GPU static/native Observatory Homepage ([`index.html`](../index.html), [`home/`](../home/), [`desktop/src/ui/home/`](../desktop/src/ui/home/)), dynamic [`simSwitcher.js`](../shared/ui/simSwitcher.js), `1`–`6` presets, unified [`scripts/run-tests.mjs`](../scripts/run-tests.mjs) (`--physics`, `--desktop`, `--browser`, `--firefox`, `--all`), and cross-platform GitHub Actions CI/release workflows.

---

## New Standalone Simulator Ideas (`sims/<id>/`)

Below are **15 implementable, high-impact simulator concepts** spanning all four [`shared/sims.json`](../shared/sims.json) categories (`gr`, `exotic`, `astro`, `sr`) and designed for triple-target **WebGL2 + WebGPU + Native Desktop** parity.

---

### 1. Gravitational Lensing Observatory — Einstein Rings & Galaxy Cluster (`sims/lens-cluster/`, `gr`)

An interactive JWST / Hubble deep-field gravitational lensing bench featuring real-time caustic crossings, giant cluster arcs, and quadruple Einstein crosses.

- **Core Physics & Math:**
  - Exact thin-lens and multi-plane ray deflection $\vec{\beta} = \vec{\theta} - \vec{\alpha}(\vec{\theta})$ across three selectable mass profiles:
    - **Point-Mass / Schwarzschild Lens** (symmetric Einstein ring and photometric microlensing magnification),
    - **Singular Isothermal Ellipsoid (SIE) + External Shear** (quadruple **Einstein Cross**, fold arcs, and cusp triplets),
    - **NFW Dark Matter Halo + Subhalo Cluster Galaxies** (Abell-2218 / SMACS-0723 giant tangential and radial arcs).
  - Exact analytical inverse magnification matrix $A_{ij} = \delta_{ij} - \partial\alpha_i / \partial\theta_j$ evaluated per pixel to compute magnification $\mu = |\det A|^{-1}$, **critical curves** ($\det A = 0$), **caustic curves** in the source plane, and **Fermat arrival-time contours** $\tau(\vec{\theta}; \vec{\beta}) = \frac{1}{2}|\vec{\theta} - \vec{\beta}|^2 - \psi(\vec{\theta})$.
- **Visuals & Shader Architecture:**
  - Procedural high-detail **background source plane** containing inclined spiral galaxies with HII star-forming knots, dusty bars, and bright quasar cores—draggable directly with the mouse so users watch multiple lensed images form, invert parity, merge into luminous arcs, and flash upon crossing diamond/ellipse caustics.
  - Foreground glowing golden elliptical cluster galaxies + faint volumetric X-ray intracluster medium (ICM) haze using 128³ noise.
  - Fast single-pass analytical evaluation across WebGL2, WebGPU, and native `wgpu`; 128-sample pause accumulation renders razor-sharp faint lensed arcs without aliasing.
- **Controls, Presets & Telemetry:**
  - *Controls:* Lens model (`Point Mass`, `SIE Elliptical`, `NFW Cluster`), Einstein radius $\theta_E$, ellipticity $e$, external shear $\gamma_{\text{ext}}$, interactive source offset $(x_s, y_s)$ (`T` toggles **Drag Source ↔ Orbit View**), critical/caustic & Fermat contour overlay toggles.
  - *Telemetry:* Total magnification $\mu_{\text{tot}}$, image multiplicity, Einstein radius ($\text{arcsec}$), enclosed lens mass ($10^{12}\,M_\odot$), Shapiro peak time delay ($\text{days}$).
  - *Presets (`1`–`6`):* `Perfect Einstein Ring`, `Einstein Cross (Quad)`, `JWST Giant Cluster Arcs`, `Fold Caustic Merger`, `Microlensing Flash`, `Caustic & Fermat Bench`.

---

### 2. Tidal Disruption Event — Relativistic Star Shredding (`sims/tde/`, `gr`)

A time-evolving relativistic hydrodynamics and Kerr ray-tracing simulation of a main-sequence star spaghettified and circularized into a blazing shock-heated accretion torus by a supermassive black hole.

- **Core Physics & Math:**
  - Exact **3D Outgoing Kerr–Schild null geodesics** (matching `sims/blackhole/`) coupled to a **256×256 dual-backend GPU solver** (WebGPU compute / WebGL2 `RGBA16F` ping-pong, reusing `sims/binary/`'s solver pattern) evolving a relativistic precessing debris stream and eccentric accretion flow.
  - Tidal disruption criteria via tidal radius $R_t = R_\star (M_{\text{BH}}/M_\star)^{1/3}$ and penetration factor $\beta = R_t / R_p$; relativistic apsidal precession $\Delta\phi \approx \frac{6\pi G M_{\text{BH}}}{c^2 R_p(1+e)}$ bends the returning bound debris tail directly into the outgoing stream, driving a **self-intersection nozzle shock** ($T_{\text{shock}} \sim 10^4\text{--}10^5\,\text{K}$) mapped through the Planck blackbody LUT.
  - Optional **Lense–Thirring nodal precession** tilting the forming debris torus when $a/M > 0$ and the stellar orbit is inclined.
- **Visuals & Shader Architecture:**
  - Full visual story arc: intact limb-darkened star approaching pericenter → luminous spaghettified tidal noodle wrapping around the Kerr shadow → violent blue-white stream collision shock → warped, optically thick Eddington-flaring torus + transient relativistic jet.
  - Volumetric ray-marching samples both the dynamic 2D/2.5D GPU debris field and 128³ turbulent outflow wind plumes, with relativistic Doppler beaming and gravitational lensing of the far stream arc.
- **Controls, Presets & Telemetry:**
  - *Controls:* Penetration factor $\beta = R_t/R_p$, black hole spin $a/M$, orbital inclination, stream shock heating, playback phase / time-lapse speed (`T` resets and replays the disruption pass).
  - *Telemetry:* Tidal radius ($R_g$), penetration $\beta$, apsidal precession $\Delta\phi$ ($^\circ$), fallback rate ($\dot{M}/\dot{M}_{\text{Edd}}$), peak shock temperature ($\text{K}$).
  - *Presets (`1`–`6`):* `First Passage (Spaghettification)`, `Self-Intersection Shock`, `Eccentric Debris Torus`, `Retrograde Deep Plunge`, `Inclined Lense-Thirring Warp`, `Eddington Outflow & Jet`.

---

### 3. Black Hole Horizon Infall & Cauchy Interior (`sims/infall/`, `gr`)

An immersive first-person free-fall descent into a rotating Kerr black hole using horizon-regular coordinates—letting the observer cross the outer event horizon $r_+$ smoothly without coordinate singularities and witness the relativistic interior up to the inner Cauchy horizon $r_-$.

- **Core Physics & Math:**
  - Exact **horizon-regular Painlevé–Gullstrand / Doran (infalling Kerr) coordinates** where the metric and radial infalling observer tetrad remain finite and smooth across $r_+ = M + \sqrt{M^2 - a^2}$ and down to $r_- = M - \sqrt{M^2 - a^2}$.
  - Continuous geodesic ray-tracing from an accelerating **rain-frame observer** ($E = 1, L_z = 0$ free-fall from rest at infinity, or boosted plunge):
    - **Exterior ($r > r_+$):** Apparent horizon swells above $90^\circ$ angular radius; external starfield and accretion disk wrap overhead.
    - **Horizon Crossing ($r = r_+$):** No solid wall—outgoing photons remain momentarily frozen beside the observer, creating the illusion of the black horizon receding beneath while external stars compress into an intensely **blueshifted overhead skylight**.
    - **Interior ($r_- < r < r_+$) & Cauchy Sheet:** Radial coordinate $r$ turns timelike; light from the external universe focuses into a brilliant blue-violet polar ring while approaching $r_-$ triggers a razor-sharp **Poisson–Israel mass-inflation blueshift sheet**.
- **Visuals & Shader Architecture:**
  - Seamless transition from blazing exterior accretion-disk glare to deep interior cathedral-like skylight optics: Doppler-shifted Milky Way stars crush into an iridescent violet-white zenith cone surrounded by plunging infalling plasma filaments.
  - Optional coordinate grid rings & free-falling radial tracer beacons illustrating tidal radial stretching and transverse compression ($\Delta r \propto \tau^{-2/3}$, $\Delta\Omega \propto \tau^{2/3}$).
- **Controls, Presets & Telemetry:**
  - *Controls:* Radial coordinate / plunge phase $r/M \in [r_- + \epsilon, 15M]$, black hole spin $a/M$, infall velocity boost, tidal tracer beacons toggle, Cauchy mass-inflation glow (`T` toggles **Auto Free-Fall Infall ↔ Hover / Scrub Radius**).
  - *Telemetry:* Radius ($r/M$), proper time remaining to singularity ($\tau/M$), sky angular radius ($^\circ$), peak zenith blueshift ($g_{\max}$), causal sector (`Exterior` / `Trapped Interior` / `Near Cauchy r-`).
  - *Presets (`1`–`6`):* `Photon Sphere Crossing`, `Event Horizon Drop`, `Interior Skylight`, `Cauchy Blueshift Sheet`, `Kerr Ring Approach`, `Schwarzschild Plunge`.

---

### 4. Kilonova & Binary Neutron Star Merger (`sims/kilonova/`, `gr`)

A GW170817-inspired binary neutron star inspiral, tidal disruption, lanthanide-rich r-process **kilonova** explosion, and off-axis short gamma-ray burst (sGRB) jet breakout.

- **Core Physics & Math:**
  - Two ultra-compact, incandescent neutron stars spiraling via 2.5PN Peters–Mathews evolution with explicit **tidal deformability** $\Lambda = \frac{2}{3} k_2 (c^2 R / G M)^5$ distorting both stars into teardrop ellipsoids and tearing out twin spiral tidal tails right before coalescence.
  - Two-component volumetric **kilonova radiative transfer**:
    - **Polar lanthanide-free blue ejecta** ($\kappa \sim 0.5\,\text{cm}^2/\text{g}$, $T \sim 8000\text{--}12000\,\text{K}$, shock-heated dynamical & neutrino-driven wind),
    - **Equatorial lanthanide-rich red/IR ejecta** ($\kappa \sim 10\,\text{cm}^2/\text{g}$, $T \sim 2000\text{--}3500\,\text{K}$, gold/platinum r-process tidal torus).
  - Narrow relativistic **structured sGRB jet & cocoon** ($\Gamma \sim 10\text{--}50$) piercing the polar ejecta with angle-dependent Doppler beaming $\delta = [\Gamma(1 - \beta\cos\theta_{\text{obs}})]^{-1}$, paired with retarded quadrupole gravitational-wave sky shear.
- **Visuals & Shader Architecture:**
  - Striking visual contrast to `sims/binary/`: instead of dark horizons, two blazing blue-white stars splash into interlocking golden-crimson equatorial r-process plumes, cobalt polar winds, and a blindingly beamed needle-thin gamma-ray jet cocoon.
  - Continuous phase scrubber transitions smoothly across `Inspiral → Tidal Contact → Hypermassive Remnant → Kilonova & sGRB Breakout` using 128³ noise, multi-scattering radiative transfer, and Planck blackbody coloring.
- **Controls, Presets & Telemetry:**
  - *Controls:* Merger phase (`Inspiral` to `+3 days Kilonova`), tidal deformability $\Lambda$, mass ratio $q$, lanthanide opacity balance, sGRB jet Lorentz factor $\Gamma$, GW strain exaggeration (`T` toggles **Auto-Evolve Merger Timeline**).
  - *Telemetry:* Merger phase ($t - t_{\text{merge}}$), GW chirp frequency ($f_{\text{GW}}$ in $\text{Hz}$), ejecta velocity ($v_{\text{ej}}/c$), viewing angle $\theta_{\text{obs}}$, jet beaming factor $\delta$.
  - *Presets (`1`–`6`):* `Pre-Merger Tidal Contact`, `Hypermassive Remnant`, `GW170817 Off-Axis Kilonova`, `On-Axis sGRB Jet Breakout`, `Lanthanide Red Torus`, `Polar Blue Wind`.

---

### 5. Kerr–Newman Charged Black Hole & Naked Singularity (`sims/kerr-newman/`, `exotic`)

A direct relativistic companion to `sims/blackhole/` and `sims/wormhole/` exploring the full three-parameter **Kerr–Newman** spacetime ($M, a, Q$)—including the dramatic phase transition across the extremal limit $a^2 + Q^2 = M^2$ into a **naked ring singularity**.

- **Core Physics & Math:**
  - Exact 3D Outgoing **Kerr–Newman Kerr–Schild** metric with scalar potential $H = \frac{M r^3 - \frac{1}{2} Q^2 r^2}{r^4 + a^2 y^2}$ (in $G = c = 4\pi\varepsilon_0 = 1$, $y$-up spin axis).
  - **Sub-extremal ($a^2 + Q^2 < M^2$):** Twin horizons $r_\pm = M \pm \sqrt{M^2 - a^2 - Q^2}$, shrinking photon-sphere & shadow diameter as electric charge $Q/M$ rises, plus charged-metric ISCO shift.
  - **Super-extremal ($a^2 + Q^2 > M^2$):** Both horizons vanish completely, exposing the **naked ring singularity** ($r = 0, y = 0$ ring of radius $a$) and allowing null geodesics passing inside the ring to emerge onto the repulsive **$r < 0$ antiverse sheet** (where effective mass reverses sign!).
- **Visuals & Shader Architecture:**
  - Bridges the signature mechanics of `sims/blackhole/` and `sims/wormhole/`: sliding $a^2 + Q^2$ past $1.0$ dissolves the black event horizon shadow in real time, opening a warped crystalline window through the glowing ring singularity into a distinct $r < 0$ Universe B sky.
  - Optional rotating electromagnetic dipole / ergosphere synchrotron plasma shimmer tracing the Kerr–Newman $F_{\mu\nu}$ field around the charged ergoregion.
- **Controls, Presets & Telemetry:**
  - *Controls:* Spin $a/M$, electric charge $Q/M$, extremal clamp toggle (`Censored` vs `Naked Singularity`), disk density & temperature, EM ergosphere glow, $r < 0$ antiverse sky brightness (`T` toggles **Sub-Extremal ↔ Naked Singularity**).
  - *Telemetry:* $a^2 + Q^2$, horizons $r_+ / r_-$ (or `NAKED`), shadow angular diameter, photon-ring eccentricity, antiverse ray fraction.
  - *Presets (`1`–`6`):* `Sub-Extremal Kerr-Newman`, `Extremal Horizon (a²+Q²=1)`, `Reissner-Nordström (a=0)`, `Naked Ring Singularity`, `Antiverse Window (r<0)`, `Charged Quasar Ergosphere`.

---

### 6. Relativistic Blazar Jet & AGN Dusty Torus (`sims/blazar/`, `astro`)

A parsec-scale **Active Galactic Nucleus (AGN)** / M87* / 3C 273 simulator exploring the **AGN Unified Model**—where orbiting from the equatorial plane to the polar jet axis transforms a dusty obscured Seyfert galaxy into a blinding superluminal **blazar**.

- **Core Physics & Math:**
  - **Blandford–Königl parabolic-to-conical magnetized jet** with helical magnetic field lines, synchrotron emission spectrum ($I_\nu \propto \nu^{-\alpha}$), and propagating **internal-shock plasmoid knots** traveling at $\Gamma_{\text{jet}} \in [2, 20]$.
  - Exact relativistic beaming $\delta = [\Gamma(1 - \beta\cos\theta_{\text{obs}})]^{-1}$ producing a stark **jet-to-counterjet brightness asymmetry** $R = \left(\frac{1 + \beta\cos\theta_{\text{obs}}}{1 - \beta\cos\theta_{\text{obs}}}\right)^{3+\alpha}$ (the receding counter-jet fades from view as you orbit toward the pole) and live **apparent superluminal transverse velocity** $\beta_{\text{app}} = \frac{\beta\sin\theta_{\text{obs}}}{1 - \beta\cos\theta_{\text{obs}}} > 1$.
  - Clumpy 3D volumetric **molecular dusty torus** + narrow-line **biconical ionization cones** illuminated by an intense central UV/X-ray accretion engine and lamppost corona.
- **Visuals & Shader Architecture:**
  - Multi-scale volumetric ray-marching combining crisp helical synchrotron jet filaments, glowing diamond recollimation shocks, animated superluminal knots, dark dusty torus clouds casting dramatic volumetric god-ray ionization cones, and fierce horizontal anamorphic flares when peering straight down the blazar barrel.
  - Pure analytical + 128³ noise volumetric shader with 100% WebGL2, WebGPU, and native desktop parity.
- **Controls, Presets & Telemetry:**
  - *Controls:* Jet Lorentz factor $\Gamma_{\text{jet}}$, helical pitch angle, internal-shock knot cadence, dusty torus optical depth, ionization cone intensity, viewing preset (`T` flips **Side-On Radio Galaxy ↔ On-Axis Blazar**).
  - *Telemetry:* Viewing angle $\theta_{\text{obs}}$ ($^\circ$), Doppler factor $\delta$, apparent knot speed $\beta_{\text{app}}$ ($\times c$), jet/counterjet flux ratio $R$, AGN classification (`Blazar` / `Quasar` / `Seyfert 2`).
  - *Presets (`1`–`6`):* `On-Axis Blazar Barrel`, `M87* Helical Jet (17°)`, `Side-On Radio Galaxy`, `Seyfert 2 Dusty Torus`, `Superluminal Shock Knots`, `Ionization Cones`.

---

### 7. Solar Corona, Magnetic Reconnection & Total Eclipse (`sims/solar-corona/`, `astro`)

A high-dynamic-range stellar-atmosphere ray-tracer capturing boiling convective granulation, arched coronal magnetic loops, an erupting **X-class solar flare / CME flux rope**, and a **Total Solar Eclipse** coronagraph mode.

- **Core Physics & Math:**
  - Limb-darkened spherical photosphere ($I(\mu)/I(1) = 1 - u_1(1-\mu) - u_2(1-\mu)^2$) with multi-octave animated **convective granulation cells**, dark **sunspot umbra/penumbra** ($5778\,\text{K} \to 3800\,\text{K}$ mapped via the Planck LUT), and glowing chromospheric spicules.
  - Analytical **sheared bipolar & nonlinear force-free coronal magnetic arcades** carrying optically thin glowing plasma loops + **magnetic reconnection X-point** pinch launching an expanding twisted **Coronal Mass Ejection (CME) flux rope**.
  - **Thomson-scattered white-light K-corona** radial streamers + toggleable **Extreme-UV narrowband** rendering (`True White-Light`, `SDO AIA 171Å Gold / 304Å Crimson`, `Total Eclipse Corona`).
- **Visuals & Shader Architecture:**
  - Volumetric ray-marching around the solar limb resolves delicate, layered magnetic plasma arches, falling coronal rain beads, and silky radial eclipse streamers silhouetted against the 4K Milky Way sky.
  - Pressing `T` slides a textured, cratered **lunar occulting disk** smoothly across the photosphere—triggering a blinding **diamond-ring anamorphic flare** before revealing the faint outer pearlescent corona!
- **Controls, Presets & Telemetry:**
  - *Controls:* Magnetic shear / flare phase, coronal loop density, CME eruption height, spectral band (`White-Light`, `AIA 304Å EUV`, `AIA 171Å EUV`, `H-Alpha`), sunspot activity, lunar occulter toggle (`T`).
  - *Telemetry:* Photosphere / loop / flare peak temperature ($\text{K}$), magnetic field strength ($B$ in $\text{G}$), CME radial velocity ($\text{km/s}$), GOES flare class (`C` / `M` / `X`).
  - *Presets (`1`–`6`):* `Active Region Loops`, `X-Class Flare & CME`, `Total Solar Eclipse`, `Diamond Ring Contact`, `SDO AIA 171Å Gold EUV`, `Sunspot Close-Up`.

---

### 8. Exoplanet Atmosphere, Volumetric Rings & Transit Eclipse (`sims/exoplanet/`, `astro`)

A Cassini Grand Finale / *Interstellar* Saturn-inspired planetary ray-tracer combining exact Rayleigh/Mie atmospheric limb scattering, volumetric ice-ring self-shadowing, and an Ultra-Hot Jupiter photoevaporation mode.

- **Core Physics & Math:**
  - Dual-layer spherical **atmospheric radiative transfer** integrating optical depth along both view and solar-shadow rays: wavelength-dependent **Rayleigh scattering** ($\sigma_R \propto \lambda^{-4}$) + **Henyey–Greenstein Mie** haze aerosols producing electric-blue daytime limbs, golden twilight bands, and deep crimson refraction halos during solar eclipses.
  - Volumetric **Roche-limit planetary ring disk** ($d_{\text{Roche}} \approx 2.44\,R_p(\rho_p/\rho_m)^{1/3}$) with orbital Lindblad resonance gaps (Cassini/Encke), vertical ring-particle thickness, directional ice back/forward-scattering phase function, and **mutual planet-on-ring & ring-on-planet soft penumbra shadows**.
  - Animated **zonal jet bands, Kelvin–Helmholtz eddies, and anticyclonic storms** (plus an optional **Hot Jupiter Roche-lobe comet tail** stripped by stellar UV radiation).
- **Visuals & Shader Architecture:**
  - Dramatic backlit crescents where starlight filters through both translucent ice rings and the glowing atmospheric rim—showcasing soft volumetric shadowing, AgX highlight roll-off, and subtle anamorphic star glints.
  - Pure analytical + 128³ noise ray-marcher (or optional 256×256 GPU barotropic storm texture for live evolving vortices).
- **Controls, Presets & Telemetry:**
  - *Controls:* Planet archetype (`Saturnian Gas Giant`, `Super-Saturn J1407b`, `Oceanic Super-Earth`, `Ultra-Hot Jupiter`), solar phase angle, ring optical depth & gap sharpness, atmospheric scale height, Mie haze anisotropy, solar eclipse alignment (`T` toggles **Backlit Eclipse ↔ Sunlit Crescent**).
  - *Telemetry:* Equilibrium temperature ($T_{\text{eq}}$), atmospheric scale height ($H$ in $\text{km}$), Roche limit ($R_p$), transit depth ($\Delta F / F$ in $\text{ppm}$), phase angle ($\alpha^\circ$).
  - *Presets (`1`–`6`):* `Cassini Backlit Eclipse`, `Saturnian Ring Dive`, `Super-Saturn Giant Rings`, `Oceanic Twilight Limb`, `Ultra-Hot Jupiter Tail`, `Transit Silhouette`.

---

### 9. Protoplanetary Disk & Planet-Carved Spiral Gaps (`sims/protoplanetary/`, `astro`)

An ALMA DSHARP–inspired (HL Tauri / PDS 70) volumetric circumstellar disk simulator with embedded protoplanets carving live Lindblad spiral density waves and annular dust gaps.

- **Core Physics & Math:**
  - Hydrostatic **flared disk geometry** $H(r) = H_0 (r/r_0)^{1.25}$ with radial irradiation temperature profile $T(r) \propto r^{-0.5}$ crossing the **water ($\sim 170\,\text{K}$) and CO ($\sim 20\,\text{K}$) snowlines** (where dust opacity and icy grain albedo jump sharply).
  - **256×256 dual-backend GPU hydrodynamic solver** (WebGPU compute / WebGL2 `RGBA16F` ping-pong, extending `sims/binary/`'s solver) evolving 1–3 orbiting protoplanets: each planet's **Hill sphere** $R_H = a_p (M_p / 3 M_\star)^{1/3}$ carves an annular dust gap, launches inner/outer **Lindblad spiral wakes**, and collects a glowing **circumplanetary mini-disk**.
  - Dual radiative transfer mode switching smoothly between **Optical / Near-IR Scattered Starlight** (bright flared surface casting a dark midplane shadow onto the outer disk) and **ALMA 1.3mm Thermal Dust Continuum** (piercing optically thin dust to reveal crisp concentric rings and spiral arms).
- **Visuals & Shader Architecture:**
  - Sculpted golden-ivory concentric rings, luminous warm inner dust wall, dark flared shadow lane when viewed near edge-on, and glowing baby planets orbiting inside cleared gaps—paired with subtle protostellar bipolar Herbig–Haro jets.
- **Controls, Presets & Telemetry:**
  - *Controls:* Protoplanet count (`1`–`3`) & mass ($M_{\text{Jup}}$), disk flaring index $\psi$, dust-to-gas opacity, snowline contrast, orbital speed, spectral view (`Optical Scattered`, `ALMA 1.3mm Thermal`, `Midplane Gas`, toggled via `T`).
  - *Telemetry:* Protoplanet orbital radius ($\text{AU}$), Hill radius ($R_H$), $\text{H}_2\text{O}$ / $\text{CO}$ snowline radii ($\text{AU}$), gap depth contrast, disk mass ($M_\odot$).
  - *Presets (`1`–`6`):* `HL Tauri Concentric Rings`, `PDS 70 Twin Protoplanets`, `Edge-On Flared Shadow`, `ALMA 1.3mm Continuum`, `Lindblad Spiral Wakes`, `T Tauri Bipolar Jet`.

---

### 10. Roche-Lobe Overflow & X-Ray Binary Star (`sims/roche-binary/`, `astro`)

A high-energy interacting binary system (Cygnus X-1 / SS 433 / Cataclysmic Variable) pairing a tidally distorted giant donor star filling its **Roche equipotential surface** with a blazing accretion disk, L1 impact hot-spot, and precessing relativistic microquasar jets.

- **Core Physics & Math:**
  - Exact dimensionless **Roche potential** $\Phi_{\text{Roche}}(\vec{r}) = -\frac{1}{1+q}\frac{1}{r_1} - \frac{q}{1+q}\frac{1}{r_2} - \frac{1}{2}\left[(x - x_{\text{cm}})^2 + z^2\right]$ solved cleanly via ray-marched Newton/sphere-tracing root refinement to sculpt the authentic teardrop donor star pointing toward the inner **L1 Lagrange point**.
  - **von Zeipel gravity darkening** ($T_{\text{eff}} \propto |\nabla\Phi_{\text{Roche}}|^\beta$) cooling the pointed L1 tidal nose into deep orange-crimson while keeping the poles blazing blue-white, mapped via the Planck LUT.
  - **Ballistic Coriolis-curved accretion stream** escaping L1 ($v_{\text{stream}}$ determined by the restricted three-body equations) and slamming into the outer disk rim to ignite a superheated **accretion hot-spot plume** ($T \sim 2\times10^4\text{--}10^5\,\text{K}$), plus an inner warped X-ray corona and precessing SS 433–style jets (or a **Classical Nova** thermonuclear shell eruption).
- **Visuals & Shader Architecture:**
  - Immediate visual storytelling: a massive boiling convective blue/red supergiant teardropped toward a compact black hole or white dwarf, connected by an incandescent twisting plasma waterfall that splatters onto a glowing accretion disk.
  - Pure analytical + 128³ turbulent stream/jet ray-marcher (or optional 256×256 GPU disk spiral solver) with full triple-target parity.
- **Controls, Presets & Telemetry:**
  - *Controls:* Mass ratio $q = M_2/M_1$, Roche fill factor $f_{\text{Roche}} \in [0.7, 1.05]$, compact accretor (`Black Hole` / `Neutron Star` / `White Dwarf`), accretion rate $\dot{M}$, jet precession angle, nova eruption trigger (`T` toggles **Co-Rotating Frame ↔ Inertial Orbit**).
  - *Telemetry:* Mass ratio $q$, Roche fill factor ($\%$), L1 stream impact velocity ($\text{km/s}$), hot-spot temperature ($\text{K}$), orbital period ($\text{hr}$).
  - *Presets (`1`–`6`):* `Cygnus X-1 Overflow`, `L1 Impact Hot-Spot`, `SS 433 Precessing Jets`, `Cataclysmic Variable`, `Classical Nova Eruption`, `Common-Envelope Merge`.

---

### 11. White Hole, Kruskal–Szekeres Bridge & Planck-Star Bounce (`sims/whitehole/`, `exotic`)

A time-reversed relativistic counterpart to `sims/blackhole/` visualizing an anti-trapped **white-hole horizon**, the **maximally extended Kruskal–Szekeres spacetime**, and a **Loop Quantum Gravity Planck-star black-to-white-hole bounce**.

- **Core Physics & Math:**
  - Exact **Eddington–Finkelstein / Kruskal–Szekeres** geodesics contrasting a future trapping horizon (black hole) against a **past anti-trapping horizon** (white hole, $UV = (1 - r/2M)e^{r/2M}$): no geodesic can cross inward into the white hole; instead, approaching rays skim an infinitely blueshifted **Eardley instability sheet** while outrushing matter and light erupt outward across the past horizon.
  - Smooth **Rovelli–Vidotto Planck-star quantum bounce** metric parameter interpolating continuously from collapsing black hole ($t < 0$) → quantum-gravity core bounce ($t = 0$) → erupting white hole ($t > 0$) ejecting luminous expanding shock shells.
  - Optional **Region I ↔ Region III** asymptotic window glimpse across the transient Einstein–Rosen bridge pinch.
- **Visuals & Shader Architecture:**
  - Completely inverts the visual mood of `sims/blackhole/`: instead of an absorbing black void, an incandescent pearlescent-violet relativistic horizon rim expels time-reversed plasma streams, expanding concentric gravitational-redshift light echoes, and intense blueshifted caustic rings.
  - Reuses the RK4 curved-spacetime ray-tracer, Planck blackbody LUT, and 128³ volumetric plume shaders with full triple-target parity.
- **Controls, Presets & Telemetry:**
  - *Controls:* Bounce phase (`Black Hole` → `Planck Core` → `White Hole`), Eardley blueshift intensity, ejected shell rate, spin $a/M$, Region III sky bleed, time-reversal arrow (`T` toggles **Black Hole ↔ White Hole Inversion**).
  - *Telemetry:* Horizon state (`Trapped` / `Bounce` / `Anti-Trapped`), peak blueshift factor $g_{\max}$, Kruskal $(U, V)$ observer sector, bounce proper time ($\tau/M$).
  - *Presets (`1`–`6`):* `Pure White Hole Eruption`, `Eardley Blueshift Sheet`, `Planck-Star Bounce (t=0)`, `Time-Reversed Accretion`, `Kruskal Bridge Glimpse`, `Black-to-White Cycle`.

---

### 12. Cosmic String, Conical Deficit & Gott Time-Machine (`sims/cosmic-string/`, `exotic`)

An exotic topological-defect ray-tracer visualizing **conical spacetime** around GUT-scale cosmic strings, **Kaiser–Stebbins** sharp sky temperature wakes, superconducting Higgs-vortex cores, and boosted twin-string **Gott closed-timelike-curve (CTC)** flybys.

- **Core Physics & Math:**
  - Locally flat Riemann curvature ($R_{\mu\nu\rho\sigma} = 0$ outside the core) paired with a global **conical wedge deficit angle** $\Delta\phi = 8\pi G\mu / c^2$ identified smoothly across a branch-cut wedge: rays passing on opposite sides of the string remain straight locally yet produce **crisp, undistorted double images** of background galaxies, stars, and landmarks!
  - Transverse moving string velocity $v_\perp$ induces the exact **Gott–Kaiser–Stebbins effect**: a razor-sharp step discontinuity $\Delta T / T = 8\pi (G\mu / c^2) \gamma v_\perp$ across the string line on the Cosmic Microwave Background and background starlight.
  - Multi-defect modes: **oscillating relativistic cosmic-string loop**, **Global Monopole** solid-angle deficit ($\Delta\Omega = 32\pi^2 G\eta^2$), and **Gott's anti-parallel boosted twin-string flyby** where increasing $\gamma\beta$ past the critical boost threshold reveals extreme frame-crossing light-cone shear.
- **Visuals & Shader Architecture:**
  - Unmistakable visual signature unlike smooth black-hole lensing: a razor-sharp optical seam slicing across the Milky Way and procedural deep-field galaxies, duplicating entire spiral galaxies cleanly on both sides without spherical distortion—paired with a subtle iridescent **superconducting Higgs-vortex core** filament and CMB anisotropy overlay.
  - Fast exact geometric wedge-transport ray-tracer (zero slow numerical integration needed in static mode; piecewise Minkowski boost transforms for moving Gott pairs).
- **Controls, Presets & Telemetry:**
  - *Controls:* String tension $G\mu/c^2$ (deficit angle $\Delta\phi \in [0^\circ, 60^\circ]$), string transverse velocity $\beta_\perp$, vortex core glow, CMB Kaiser–Stebbins contrast, topology (`Single String`, `Oscillating Loop`, `Gott Twin Pair`, `Global Monopole`), `T` toggles **Single Static String ↔ Boosted Gott Pair**.
  - *Telemetry:* Tension ($G\mu/c^2$), deficit angle $\Delta\phi$ ($^\circ$), double-image separation ($\text{arcsec}$ / $^\circ$), Kaiser–Stebbins $\Delta T/T$, Gott CTC parameter ($\gamma\beta \sin(\Delta\phi/2)$).
  - *Presets (`1`–`6`):* `Double-Image Lensing`, `Kaiser-Stebbins Wake`, `Superconducting Vortex`, `Oscillating String Loop`, `Gott Twin-String Flyby`, `Global Monopole Sky`.

---

### 13. Rindler Causal Horizon & Unruh Radiation (`sims/rindler/`, `sr`)

A Special-Relativistic companion to `sims/starflight/` placing the observer inside a **uniformly accelerating spacecraft** ($a$ constant proper acceleration) to visualize the **Rindler causal horizon**, the **Equivalence Principle**, **Bell's Spaceship Paradox**, and quantum **Unruh thermal radiation**.

- **Core Physics & Math:**
  - Exact **Rindler coordinate null-ray mapping** in flat Minkowski spacetime: an observer accelerating along $+z$ with proper acceleration $a$ sees a glowing, impenetrable **causal Rindler horizon** trailing at constant proper distance $d_H = c^2 / a$ behind the ship—no photon emitted past the horizon can ever catch up!
  - **Equivalence Principle Optics:** Objects dropped astern (reference clocks, glowing beacons, starship probes) accelerate downward into a uniform pseudo-gravitational field, asymptotically freezing, Lorentz-flattening, and exponentially redshifting onto the horizon wall just like matter falling toward a Schwarzschild horizon.
  - **Unruh Effect Visualizer:** Renders the observer-dependent **Unruh quantum vacuum bath** ($T_U = \frac{\hbar a}{2\pi c k_B}$, scaled cleanly by an adjustable quantum-coupling amplifier) radiating upward from the trailing horizon through the Planck blackbody LUT, alongside **Bell's Spaceship Paradox** stress-tether between identically accelerated ships and a **Born-rigid fleet** where rear ships accelerate harder ($a_{\text{rear}} > a_{\text{front}}$).
- **Visuals & Shader Architecture:**
  - Looking forward: stars bunch via relativistic aberration into a shifting forward cone while proper distance ticks by; looking aft: an eerie glowing thermal fog wall (`Rindler Horizon`) swallows trailing probes and beacons in slow-motion crimson redshift, proving gravity-like horizons emerge even in completely flat spacetime.
- **Controls, Presets & Telemetry:**
  - *Controls:* Proper acceleration $a$ (in $g$ and $c^2/\text{ly}$), Unruh vacuum glow amplifier, probe drop cadence, fleet mode (`Single Probe Drop`, `Bell Paradox Tether`, `Born-Rigid Fleet`), grid overlay (`T` toggles **Accelerating Rindler Cabin ↔ Inertial Minkowski Frame**).
  - *Telemetry:* Proper acceleration $a$ ($g$), Rindler horizon distance $d_H$, Unruh temperature $T_U$, ship proper time $\tau$, local gravitational-equivalent redshift $g_{\text{eff}}$.
  - *Presets (`1`–`6`):* `Rindler Horizon Wall`, `Unruh Thermal Glow`, `Equivalence Principle Drop`, `Bell Spaceship Tether`, `Born-Rigid Fleet`, `Minkowski Wedge View`.

---

### 14. Galactic Collision, Tidal Tails & Starburst (`sims/galaxy-merger/`, `astro`)

An Antennae / Mice Galaxies–inspired major collision between two spiral galaxies, coupling a real-time **256×256 GPU particle-mesh / density-field solver** with volumetric 3D dust lanes, shock-triggered H-alpha pink starburst knots, and sweeping 100-kpc tidal tails.

- **Core Physics & Math:**
  - **256×256 dual-backend GPU dynamical solver** (WebGPU compute / WebGL2 `RGBA16F` ping-pong) advancing disk star + gas-cloud orbits inside twin live-moving **Hernquist bulge + NFW dark matter halo** gravitational potentials with **Chandrasekhar dynamical friction** spiraling the two galactic nuclei toward eventual coalescence.
  - Local gas compression $\nabla \cdot \vec{v} < 0$ triggers **Kennicutt–Schmidt starburst ignition** ($\Sigma_{\text{SFR}} \propto \Sigma_{\text{gas}}^{1.4}$), lighting up brilliant crimson/magenta **H-alpha star-forming clusters** and young OB-blue spiral shocks along the colliding interface while gravitational torques fling out sweeping **tidal tails and bridges**.
- **Visuals & Shader Architecture:**
  - Multi-layer volumetric ray-marching across two tilted, colliding spiral disks: warm golden galactic bulges, intricate dark dust silhouettes against glowing stellar arms, neon-magenta starburst knots, and vast ethereal blue stellar streams stretching across dark intergalactic space.
- **Controls, Presets & Telemetry:**
  - *Controls:* Merger orbital inclination (`Prograde-Prograde` / `Retrograde` / `Polar Ring`), mass ratio $q$, impact parameter, dynamical friction strength, dust optical depth, playback speed (`T` toggles **Auto-Evolve Merger ↔ Freeze & Orbit**).
  - *Telemetry:* Nuclear separation ($\text{kpc}$), merger elapsed time ($\text{Myr}$), star-formation rate ($M_\odot/\text{yr}$), tidal tail span ($\text{kpc}$), relative velocity ($\text{km/s}$).
  - *Presets (`1`–`6`):* `First Pericenter Passage`, `Antennae Twin Tails`, `Mice Tidal Bridge`, `Ring Galaxy (Cartwheel)`, `Nuclear Starburst Core`, `Elliptical Remnant`.

---

### 15. Cosmic Web, Dark Matter Filaments & FLRW Horizon (`sims/cosmic-web/`, `astro`)

A gigaparsec-scale cosmological fly-through inside an expanding **$\Lambda$CDM cosmic web** of dark matter filaments, glowing galaxy clusters, deep cosmic voids, and live cosmological redshift out to Cosmic Dawn.

- **Core Physics & Math:**
  - Multi-scale 3D **Voronoi-ridge / Zel'dovich cellular sheet–filament–node** density field evaluated volumetrically along each ray, forming authentic interconnected cosmic filaments, bright cluster nodes at ridge intersections, and vast dark voids.
  - Live **Friedmann–Lemaître–Robertson–Walker (FLRW)** cosmological expansion ($H_0, \Omega_m, \Omega_\Lambda$): distant filaments experience real **cosmological redshift** $1 + z = a_0 / a(t_{\text{emit}})$ shifting starlight and Lyman-$\alpha$ emission redward along the line of sight via the Planck LUT, while scrubbing cosmic epoch ($z = 0 \leftrightarrow z = 12$) visibly tightens and brightens the early universe!
  - Optional subtle **weak-lensing convergence ($\kappa$)** background galaxy shear along high-density dark-matter filaments.
- **Visuals & Shader Architecture:**
  - Ethereal 3D spiderweb of glowing violet-gold dark-matter filaments, sparkling point-like galaxy cluster supernodes, and warm-hot intergalactic medium (WHIM) gas—built for smooth origin-safe `W`/`S` deep-space fly-through (building on `sims/supernova/`'s flight controller) and noise-free 128-sample pause stills.
- **Controls, Presets & Telemetry:**
  - *Controls:* Cosmic redshift epoch $z \in [0, 12]$, matter/dark-energy balance ($\Omega_m / \Omega_\Lambda$), filament sharpness, cluster luminosity, fly-through velocity, visualization channel (`Dark Matter Web`, `Visible Galaxies`, `WHIM X-Ray Gas`, `Lyman-Alpha Glow`, cycled via `T`).
  - *Telemetry:* Current epoch redshift ($z$), universe age ($\text{Gyr}$), Hubble parameter $H(z)$ ($\text{km/s/Mpc}$), comoving box span ($\text{Mpc}$), mean void fraction.
  - *Presets (`1`–`6`):* `Present-Day Cosmic Web (z=0)`, `Supercluster Node Core`, `Cosmic Void Flythrough`, `Cosmic Noon (z=2)`, `Cosmic Dawn (z=10)`, `WHIM Plasma Filaments`.

---

## Flagship Upgrades for Existing 7 Simulators

Even before adding new simulators, each existing engine has high-impact depth upgrades ready to build on its current shader and HUD architecture:

- **[`sims/blackhole/`](../sims/blackhole/) — EHT Polarimetry & Orbiting Sgr A\* Hot-Spots:** Add a **Stokes $(Q, U)$ synchrotron polarization tick/streamline overlay** (recreating the iconic Event Horizon Telescope magnetic spiral swirl around M87\*) plus orbiting **magnetic-reconnection flare hot-spots** near the ISCO that produce real-time Doppler-beamed light echoes around the photon ring.
- **[`sims/wormhole/`](../sims/wormhole/) — Dynamic Throat Pinch & Custom Dual-Sky Drops:** Let users drag-and-drop custom equirectangular HDR/JPEG panoramas into Universe A or Universe B, add **Morris–Thorne exotic-matter throat ripple perturbations** (visualizing gravitational wave echoes bouncing inside a long throat), and add a **multi-mouth wormhole fork** preset.
- **[`sims/binary/`](../sims/binary/) — Post-Merger Ringdown, Recoil Kick & Live GW Waveform:** Extend the 2.5PN inspiral past coalescence into an **exponentially damped Kerr ringdown** with **anisotropic GW recoil kick** displacing the remnant out of the circumbinary cavity, paired with a live HUD **$h_+(t) / h_\times(t)$ chirp oscilloscope**.
- **[`sims/warp/`](../sims/warp/) — Deceleration Hawking Burst & York Expansion Overlay:** Add a `Stop / Decelerate` sequence emitting the **Finazzi–Liberati–Barceló blueshifted radiation burst** accumulated on the forward horizon during FTL cruise, plus a toggleable **York expansion scalar $\theta(x,y,z)$ volumetric cutaway** contrasting Alcubierre's dual expansion/contraction lobes against Natário's $\theta \equiv 0$ zero-expansion flow.
- **[`sims/supernova/`](../sims/supernova/) — Time-Lapse Blast Age Scrubber & Multi-Observatory Bands:** Add a continuous **remnant age scrubber ($10\,\text{yr} \to 10,000\,\text{yr}$)** evolving the shell smoothly from free-expansion ejecta to Sedov–Taylor radiative shock filaments, plus toggleable **Chandra X-ray / JWST Mid-IR / ALMA Sub-mm** false-color spectral filters.
- **[`sims/pulsar/`](../sims/pulsar/) — Phase-Folded Radio Profile & Magnetar Starquake Glitches:** Add a live **rotating radio light-curve strip chart** synchronized to the Deutsch-retarded lighthouse beam sweep (showing primary + interpulse peaks vs inclination), plus a **`Starquake Glitch` trigger** firing twisted magnetospheric Alfvén waves and X-ray crust bursts.
- **[`sims/starflight/`](../sims/starflight/) — Real Hipparcos/Gaia Bright-Star Parallax & Spacetime Diagram:** Embed a compact procedural/JSON catalog of the **1,000 brightest real stars** with 3D coordinates so flying at $0.99c$ produces true **stellar parallax** alongside SR aberration, paired with an interactive **Minkowski $(ct, x)$ light-cone & worldline mini-diagram** in the HUD.

---

## Recommended Next Builds (Prioritized)

### Top 4 Highest-Impact New Simulators
1. **`sims/lens-cluster/` (Gravitational Lensing Observatory):** Introduces an entirely new interactive paradigm (real-time **source-plane dragging across caustics** + live Jacobian critical curves and Fermat contours) with unmistakable JWST-style deep-field visual drama and fast analytical triple-target shaders.
2. **`sims/tde/` (Tidal Disruption Event):** Highest physics-and-motion "wow factor"—directly builds on `sims/blackhole/`'s Kerr–Schild ray-tracer and `sims/binary/`'s **WebGPU compute / WebGL2 `RGBA16F` ping-pong** GPU solver to tell a dramatic visual story from intact star to spaghettified shock flare.
3. **`sims/infall/` (Black Hole Horizon Infall & Cauchy Interior):** Delivers the most requested experiential moment in general relativity—crossing $r_+$ in smooth free-fall—by adapting existing Kerr–Schild geodesics into horizon-regular Doran coordinates with zero extra dynamic fluid pass required.
4. **`sims/solar-corona/` (Solar Corona & Total Eclipse)** *(or **`sims/exoplanet/`**)*: Gives the suite a brilliant, warm, luminous astrophysics showcase (magnetic coronal loops, CME eruptions, and a `T`-key **Total Solar Eclipse diamond ring**) that contrasts sharply with the suite's deep-space palette.

### Top 3 Highest-Leverage Platform Upgrades
1. **New-Simulator Scaffolder (`scripts/new-sim.mjs`):** Automates the canonical 5-file web engine + `.wgsl` + `sims.json` + Rust `desktop/src/sims/` + QA suite boilerplate so adding Simulator #8 takes minutes instead of hours.
2. **Reusable Dual-Backend GPU Field Solver (`shared/engine/GpuFieldSolver.js` + `desktop/src/renderer/solver.rs`):** Unlocks dynamic 2D/2.5D physics (`tde`, `protoplanetary`, `galaxy-merger`, `kilonova`, `exoplanet` storms) without duplicating ping-pong / compute boilerplate.
3. **Cinema Keyframe Sequencer & 4K / OpenEXR / WebM Exporter:** Turns the 128-sample cinema accumulation pipeline into an astronomical filmmaking and wallpaper-generation studio on both web and native desktop.

### Quick Comparison Matrix

| Simulator | Category | Core Technique | Dynamic GPU Sim? | Visual Signature | Complexity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sims/lens-cluster/` | `gr` | Analytical thin-lens + Jacobian | No | JWST arcs, Einstein Cross, interactive caustics | Low–Medium |
| `sims/cosmic-string/` | `exotic` | Conical wedge transport + boost | No | Crisp double-galaxy seams, Kaiser–Stebbins wake | Low–Medium |
| `sims/rindler/` | `sr` | Rindler null map + Unruh bath | No | Glowing trailing horizon wall, falling probe freeze | Low–Medium |
| `sims/kerr-newman/` | `exotic` | Kerr–Newman Kerr–Schild RK4 | No | Shrinking shadow → naked ring & $r<0$ antiverse | Low–Medium |
| `sims/infall/` | `gr` | Horizon-regular Doran geodesics | No | Smooth $r_+$ crossing, zenith skylight, Cauchy sheet | Medium |
| `sims/solar-corona/` | `astro` | Volumetric loops + limb transfer | No | Golden magnetic arches, CME, total eclipse ring | Medium |
| `sims/exoplanet/` | `astro` | Rayleigh/Mie + ring shadow march | Optional | Cassini backlit rings, twilight limb, shadows | Medium |
| `sims/blazar/` | `astro` | Volumetric beamed helical jet | No | Blazar barrel flare, disappearing counter-jet | Medium |
| `sims/whitehole/` | `exotic` | Kruskal / bounce geodesic RK4 | No | Incandescent anti-trapped horizon & blueshift ring | Medium |
| `sims/cosmic-web/` | `astro` | Multi-scale Voronoi/FLRW march | No | Violet-gold Mpc filament web & void fly-through | Medium |
| `sims/roche-binary/` | `astro` | Roche equipotential + L1 stream | Optional | Teardrop star, gravity darkening, disk hot-spot | Medium |
| `sims/protoplanetary/` | `astro` | Flared dust transfer + 2D hydro | Yes (256²) | ALMA rings, Lindblad spirals, protoplanets | Medium–High |
| `sims/galaxy-merger/` | `astro` | 256² particle-mesh + dust volume | Yes (256²) | Antennae tidal tails, H-alpha starburst knots | Medium–High |
| `sims/tde/` | `gr` | Kerr–Schild + 2D/2.5D debris | Yes (256²) | Spaghettified star, self-intersection shock | High |
| `sims/kilonova/` | `gr` | Compact tidal + 2-comp ejecta | Optional | Twin glowing NS, red/blue kilonova, sGRB jet | High |

---

## Cross-Sim Platform, Engine & Desktop Upgrades

With the Observatory Homepage, `shared/sims.json` registry, single-source `.wgsl` sync, `shared/engine/` extraction, and hybrid HDR performance architecture already shipped in `v0.1.3.1-beta`, these **10 platform upgrades** multiply velocity, scientific depth, and visual capability across every existing and future simulator:

1. **Reusable Dual-Backend 2D/3D GPU Physics Solver (`shared/engine/GpuFieldSolver.js` + `desktop/src/renderer/solver.rs`):**
   Generalize `sims/binary/`'s 256×256 WebGPU compute / WebGL2 `RGBA16F` ping-pong pipeline into a clean multi-target primitive (supporting ping-pong advection, Poisson/FFT gravity steps, and readback-free mip sampling) to power `sims/tde/`, `sims/protoplanetary/`, `sims/galaxy-merger/`, and `sims/kilonova/`.

2. **New-Simulator Scaffolder & Parity Generator (`scripts/new-sim.mjs`):**
   Single-command generator (`node scripts/new-sim.mjs --id tde --category gr`) that stubs the canonical 5-file `sims/<id>/src/engine/` layout, dual-backend `shaders/`, `styles.css`, `tests/{physics_check,browser_qa,firefox_qa}.mjs`, `shared/sims.json` entry, `desktop/src/sims/<id>.rs` module, and runs `sync-metadata.mjs --write` + `sync-wgsl.mjs --write`.

3. **Real-Time Telemetry Oscilloscopes & Analytical 3D Diagnostic Overlays:**
   Add an optional HUD science toggle rendering analytical 3D guides directly in shader or crisp screen-space projection—photon-sphere/ergosphere wireframes, critical/caustic curves, light-cylinder $R_{\text{LC}}$, live sample photon trajectories—paired with compact sparkline oscilloscopes (GW $h_+/h_\times$ strain, pulsar light curves, relativistic Doppler spectrum).

4. **Cinema Keyframe Sequencer & 4K / OpenEXR / WebM Exporter:**
   Zero-dependency smooth Catmull-Rom spline camera & physics-parameter keyframe sequencer (`0`–`9` waypoints) with one-click `MediaRecorder` WebM capture, deterministic frame-by-frame 128-sample accumulated turntable PNG sequences, and **headless native Rust CLI batch rendering** (`desktop --sim blackhole --preset 1 --render-4k out.exr`) saving raw linear HDR frames prior to AgX tone mapping.

5. **Interactive Split-Screen & Metric Comparator (`?compare=`):**
   Side-by-side or draggable wipe-divider comparison mode rendering two metrics or backends simultaneously (e.g., `GR Curved` vs `Flat Space` in `sims/pulsar/`, `Alcubierre` vs `Natário` in `sims/warp/`, `Kerr a=0.998` vs `Schwarzschild a=0` in `sims/blackhole/`, or live `WebGL2` vs `WebGPU` pixel-diff inspection).

6. **VR / WebXR Stereoscopic, 360° Equirectangular & Planetarium Fulldome Projections:**
   Because every simulator already marches arbitrary per-pixel ray directions $\vec{d}(\text{uv})$, adding a shared projection uniform (`Rectilinear` / `360° Equirectangular` / `180° Fisheye Fulldome` / `Side-by-Side Stereo`) in [`shared/shaders/`](../shared/shaders/) immediately unlocks planetarium dome playback, YouTube VR 360° renders, and **WebXR** stereo headset exploration across all simulators!

7. **Procedural Physics-Driven Sonification (Web Audio API + Native Rust Audio):**
   Mute-by-default, zero-asset synthesizer driven directly by live telemetry—2.5PN gravitational-wave chirp frequency in `sims/binary/` & `sims/kilonova/`, millisecond radio-pulse ticks in `sims/pulsar/`, relativistic Doppler pitch shift in `sims/starflight/` & `sims/warp/`, and horizon/plasma ambience in `sims/blackhole/` & `sims/supernova/`.

8. **Shareable Deep-Link State URLs & Custom Preset Import/Export:**
   Serialize the full camera pose, active preset, and slider state into compact Base64/query-param URLs (`?sim=blackhole&state=...`) plus one-click JSON preset import/export so users and researchers can share exact relativistic viewpoints and custom parameter configurations.

9. **Native Desktop Power-User Features (`desktop/`):**
   Unlock capabilities impossible in sandboxes browsers: **true 10-bit HDR10 / Apple EDR swapchain output** bypassing SDR sRGB clamping so AgX highlights glow natively on OLED/Mini-LED displays, `--watch-shaders` live `.wgsl` hot-reload for shader authors, per-pass GPU timestamp profiling in the HUD, and a borderless **native screensaver / live-wallpaper mode**.

10. **Guided Interactive Physics Tours & Annotated Science Mode:**
    Optional curated 5–7 stop interactive tours inside each simulator (e.g., *Interstellar's* Gargantua tour: `Photon Sphere → Innermost Stable Orbit → Doppler Asymmetry → Polar Jet Launch`) that smoothly glide the camera, highlight the relevant physics telemetry, and explain the equations in concise non-intrusive Observatory cards.
