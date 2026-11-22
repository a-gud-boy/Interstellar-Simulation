# New Simulation Ideas — Interstellar Spacetime Simulators

## Current Implemented Suite (7 Simulators)

The repository currently ships **seven** zero-dependency, dual-backend (**WebGL2 + WebGPU**) GPU ray-tracers under a unified cinema-grade HDR pipeline:

| Directory | Simulator | Implemented Physics & Visual Highlights |
| :--- | :--- | :--- |
| [`blackhole-sim/`](./blackhole-sim/) | **Gargantua Black Hole** | 3D Outgoing Kerr–Schild null geodesics, ZAMO observer tetrad, Bardeen–Press–Teukolsky ISCO, 128³ volumetric MHD accretion plasma with Doppler beaming + Planck blackbody LUT, and Blandford–Znajek polar jets. |
| [`wormhole-sim/`](./wormhole-sim/) | **Traversable Wormhole** | Adaptive RK4 curved-space geodesics across proper distance $l \in (-\infty, +\infty)$, James–Thorne $D_{\text{neg}}$ and Ellis drainhole metrics, dual-universe skies (Universe A ↔ Universe B), and zero-flip $l=0$ throat traversal (`T`). |
| [`binary-bh-sim/`](./binary-bh-sim/) | **Binary Black Hole Inspiral** | Brill–Lindquist Fermat optical metric + 1PN frame-dragging + pole-free Cartesian TT retarded quadrupole GW shear + ISW sky modulation, 2.5PN Peters–Mathews inspiral, 256×256 GPU tidal hydrodynamics (WebGPU compute / WebGL2 `RGBA16F` ping-pong), tidal gas bridges, and fractal eyebrow shadows. |
| [`warp-drive-sim/`](./warp-drive-sim/) | **FTL Warp Drive** | Backward ADM null geodesic RK4 integration across Alcubierre, Natário Zero-Expansion ($\theta \equiv 0$), and Lentz Soliton ($L_p$ positive/negative $T_{00}$) bubbles up to $5.0c$, Cherenkov 128³ wall shimmer, Doppler bow-shock caustics, aft Causal Horizon, and External Chase ↔ Inside Bridge view toggle (`T`). |
| [`supernova-sim/`](./supernova-sim/) | **Supernova Remnant & Nebula** | Analytic bounding-sphere radiative transfer across Sedov–Taylor / free-expansion blast shells, 4-octave Wrenninge multiple scattering + dual-lobe Henyey–Greenstein dust phase function, 3D Rayleigh–Taylor filaments, dark Bok globules, `Hubble SHO` / `True Color` palettes, and deep interior fly-through (`W`/`S`). |
| [`pulsar-sim/`](./pulsar-sim/) | **Magnetar / Millisecond Pulsar** | 3D Outgoing Kerr–Schild light bending exposing $>50\%$ of the neutron star crust (`GR Curved` vs `Flat Space`), relativistic redshift & Doppler beaming across $10^6\text{--}10^7\,\text{K}$ polar caps and molten crust cracks, twisted oblique dipole pair-plasma loops inside $R_{\text{LC}}$, sweeping lighthouse beams with Deutsch retardation, and equatorial PWN torus + jets. |
| [`starflight-sim/`](./starflight-sim/) | **Relativistic Starflight** | Cancellation-free Special Relativistic Lorentz aberration up to $0.9999996c$ ($\gamma \approx 1050$), exact Doppler shift $D$ + Planck blackbody shift across the 4K Milky Way, UV/IR star bands, and CMB shell ($T_{\text{fwd}} = 2.7255\,D_{\text{fwd}}$), Penrose–Terrell rotated 3D rings & beacons, $1g$ brachistochrone cruise, and Forward ↔ Aft flip (`T`). |

### Proven Reusable Architecture
Every simulator builds on the same zero-dependency, GitHub Pages–ready stack:
- **Dual-Backend Parity:** Live **WebGL2** (`RGBA16F` multi-pass) ↔ **WebGPU** (`rg11b10ufloat`/`rgba16float` + compute passes) switching via `?backend=` with RAM-cached textures.
- **Temporal & Filmic Pipeline:** HDR YCoCg variance-clipped **TAA**, **128-sample progressive accumulation** on pause (`Space`), 6-mip Karis/Jimenez **HDR bloom**, 70mm **anamorphic flare**, and **AgX** tone mapping.
- **Procedural & Physical Primitives:** 128³ periodic 3D noise (FBM, ridged, Worley, micro), 128×128 blue-noise jitter, CIE-1931 **Planck blackbody LUT**, and dual-backend **256×256 GPU compute / `RGBA16F` ping-pong** dynamic field solvers (proven in `binary-bh-sim/`).
- **Observatory HUD & QA:** Live telemetry cards, `1`–`6` presets, cross-sim switcher, and automated `physics_check.mjs`, Chrome X11 `browser_qa.mjs`, and Firefox Wayland `firefox_qa.mjs` suites.

---

## New Standalone Simulator Ideas (`<name>-sim/`)

Below are **10 implementable, high-impact simulator concepts** chosen to expand the suite's physics breadth and visual diversity while fitting cleanly into the existing dual-backend architecture.

---

### 1. Gravitational Lensing Observatory — Einstein Rings & Galaxy Cluster (`lens-cluster-sim/`)

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
  - Fast single-pass analytical evaluation in both WebGL2 and WebGPU; 128-sample pause accumulation renders razor-sharp faint lensed arcs without aliasing.
- **Controls, Presets & Telemetry:**
  - *Controls:* Lens model (`Point Mass`, `SIE Elliptical`, `NFW Cluster`), Einstein radius $\theta_E$, ellipticity $e$, external shear $\gamma_{\text{ext}}$, interactive source offset $(x_s, y_s)$ (`T` toggles **Drag Source ↔ Orbit View**), critical/caustic & Fermat contour overlay toggles.
  - *Telemetry:* Total magnification $\mu_{\text{tot}}$, image multiplicity, Einstein radius ($\text{arcsec}$), enclosed lens mass ($10^{12}\,M_\odot$), Shapiro peak time delay ($\text{days}$).
  - *Presets (`1`–`6`):* `Perfect Einstein Ring`, `Einstein Cross (Quad)`, `JWST Giant Cluster Arcs`, `Fold Caustic Merger`, `Microlensing Flash`, `Caustic & Fermat Bench`.

---

### 2. Tidal Disruption Event — Relativistic Star Shredding (`tde-sim/`)

A time-evolving relativistic hydrodynamics and Kerr ray-tracing simulation of a main-sequence star spaghettified and circularized into a blazing shock-heated accretion torus by a supermassive black hole.

- **Core Physics & Math:**
  - Exact **3D Outgoing Kerr–Schild null geodesics** (matching `blackhole-sim/`) coupled to a **256×256 dual-backend GPU solver** (WebGPU compute / WebGL2 `RGBA16F` ping-pong, reusing the `binary-bh-sim/` pattern) evolving a relativistic precessing debris stream and eccentric accretion flow.
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

### 3. Kilonova & Binary Neutron Star Merger (`kilonova-sim/`)

A GW170817-inspired binary neutron star inspiral, tidal disruption, lanthanide-rich r-process **kilonova** explosion, and off-axis short gamma-ray burst (sGRB) jet breakout.

- **Core Physics & Math:**
  - Two ultra-compact, incandescent neutron stars spiraling via 2.5PN Peters–Mathews evolution with explicit **tidal deformability** $\Lambda = \frac{2}{3} k_2 (c^2 R / G M)^5$ distorting both stars into teardrop ellipsoids and tearing out twin spiral tidal tails right before coalescence.
  - Two-component volumetric **kilonova radiative transfer**:
    - **Polar lanthanide-free blue ejecta** ($\kappa \sim 0.5\,\text{cm}^2/\text{g}$, $T \sim 8000\text{--}12000\,\text{K}$, shock-heated dynamical & neutrino-driven wind),
    - **Equatorial lanthanide-rich red/IR ejecta** ($\kappa \sim 10\,\text{cm}^2/\text{g}$, $T \sim 2000\text{--}3500\,\text{K}$, gold/platinum r-process tidal torus).
  - Narrow relativistic **structured sGRB jet & cocoon** ($\Gamma \sim 10\text{--}50$) piercing the polar ejecta with angle-dependent Doppler beaming $\delta = [\Gamma(1 - \beta\cos\theta_{\text{obs}})]^{-1}$, paired with retarded quadrupole gravitational-wave sky shear.
- **Visuals & Shader Architecture:**
  - Striking visual contrast to `binary-bh-sim/`: instead of dark horizons, two blazing blue-white stars splash into interlocking golden-crimson equatorial r-process plumes, cobalt polar winds, and a blindingly beamed needle-thin gamma-ray jet cocoon.
  - Continuous phase scrubber transitions smoothly across `Inspiral → Tidal Contact → Hypermassive Remnant → Kilonova & sGRB Breakout` using 128³ noise, multi-scattering radiative transfer, and Planck blackbody coloring.
- **Controls, Presets & Telemetry:**
  - *Controls:* Merger phase (`Inspiral` to `+3 days Kilonova`), tidal deformability $\Lambda$, mass ratio $q$, lanthanide opacity balance, sGRB jet Lorentz factor $\Gamma$, GW strain exaggeration (`T` toggles **Auto-Evolve Merger Timeline**).
  - *Telemetry:* Merger phase ($t - t_{\text{merge}}$), GW chirp frequency ($f_{\text{GW}}$ in $\text{Hz}$), ejecta velocity ($v_{\text{ej}}/c$), viewing angle $\theta_{\text{obs}}$, jet beaming factor $\delta$.
  - *Presets (`1`–`6`):* `Pre-Merger Tidal Contact`, `Hypermassive Remnant`, `GW170817 Off-Axis Kilonova`, `On-Axis sGRB Jet Breakout`, `Lanthanide Red Torus`, `Polar Blue Wind`.

---

### 4. Kerr–Newman Charged Black Hole & Naked Singularity (`kerr-newman-sim/`)

A direct relativistic companion to `blackhole-sim/` and `wormhole-sim/` exploring the full three-parameter **Kerr–Newman** spacetime ($M, a, Q$)—including the dramatic phase transition across the extremal limit $a^2 + Q^2 = M^2$ into a **naked ring singularity**.

- **Core Physics & Math:**
  - Exact 3D Outgoing **Kerr–Newman Kerr–Schild** metric with scalar potential $H = \frac{M r^3 - \frac{1}{2} Q^2 r^2}{r^4 + a^2 y^2}$ (in $G = c = 4\pi\varepsilon_0 = 1$, $y$-up spin axis).
  - **Sub-extremal ($a^2 + Q^2 < M^2$):** Twin horizons $r_\pm = M \pm \sqrt{M^2 - a^2 - Q^2}$, shrinking photon-sphere & shadow diameter as electric charge $Q/M$ rises, plus charged-metric ISCO shift.
  - **Super-extremal ($a^2 + Q^2 > M^2$):** Both horizons vanish completely, exposing the **naked ring singularity** ($r = 0, y = 0$ ring of radius $a$) and allowing null geodesics passing inside the ring to emerge onto the repulsive **$r < 0$ antiverse sheet** (where effective mass reverses sign!).
- **Visuals & Shader Architecture:**
  - Bridges the signature mechanics of `blackhole-sim/` and `wormhole-sim/`: sliding $a^2 + Q^2$ past $1.0$ dissolves the black event horizon shadow in real time, opening a warped crystalline window through the glowing ring singularity into a distinct $r < 0$ Universe B sky.
  - Optional rotating electromagnetic dipole / ergosphere synchrotron plasma shimmer tracing the Kerr–Newman $F_{\mu\nu}$ field around the charged ergoregion.
- **Controls, Presets & Telemetry:**
  - *Controls:* Spin $a/M$, electric charge $Q/M$, extremal clamp toggle (`Censored` vs `Naked Singularity`), disk density & temperature, EM ergosphere glow, $r < 0$ antiverse sky brightness (`T` toggles **Sub-Extremal ↔ Naked Singularity**).
  - *Telemetry:* $a^2 + Q^2$, horizons $r_+ / r_-$ (or `NAKED`), shadow angular diameter, photon-ring eccentricity, antiverse ray fraction.
  - *Presets (`1`–`6`):* `Sub-Extremal Kerr-Newman`, `Extremal Horizon (a²+Q²=1)`, `Reissner-Nordström (a=0)`, `Naked Ring Singularity`, `Antiverse Window (r<0)`, `Charged Quasar Ergosphere`.

---

### 5. Relativistic Blazar Jet & AGN Dusty Torus (`blazar-jet-sim/`)

A parsec-scale **Active Galactic Nucleus (AGN)** / M87* / 3C 273 simulator exploring the **AGN Unified Model**—where orbiting from the equatorial plane to the polar jet axis transforms a dusty obscured Seyfert galaxy into a blinding superluminal **blazar**.

- **Core Physics & Math:**
  - **Blandford–Königl parabolic-to-conical magnetized jet** with helical magnetic field lines, synchrotron emission spectrum ($I_\nu \propto \nu^{-\alpha}$), and propagating **internal-shock plasmoid knots** traveling at $\Gamma_{\text{jet}} \in [2, 20]$.
  - Exact relativistic beaming $\delta = [\Gamma(1 - \beta\cos\theta_{\text{obs}})]^{-1}$ producing a stark **jet-to-counterjet brightness asymmetry** $R = \left(\frac{1 + \beta\cos\theta_{\text{obs}}}{1 - \beta\cos\theta_{\text{obs}}}\right)^{3+\alpha}$ (the receding counter-jet fades from view as you orbit toward the pole) and live **apparent superluminal transverse velocity** $\beta_{\text{app}} = \frac{\beta\sin\theta_{\text{obs}}}{1 - \beta\cos\theta_{\text{obs}}} > 1$.
  - Clumpy 3D volumetric **molecular dusty torus** + narrow-line **biconical ionization cones** illuminated by an intense central UV/X-ray accretion engine and lamppost corona.
- **Visuals & Shader Architecture:**
  - Multi-scale volumetric ray-marching combining crisp helical synchrotron jet filaments, glowing diamond recollimation shocks, animated superluminal knots, dark dusty torus clouds casting dramatic volumetric god-ray ionization cones, and fierce horizontal anamorphic flares when peering straight down the blazar barrel.
  - Pure analytical + 128³ noise volumetric shader with 100% WebGL2/WebGPU parity.
- **Controls, Presets & Telemetry:**
  - *Controls:* Jet Lorentz factor $\Gamma_{\text{jet}}$, helical pitch angle, internal-shock knot cadence, dusty torus optical depth, ionization cone intensity, viewing preset (`T` flips **Side-On Radio Galaxy ↔ On-Axis Blazar**).
  - *Telemetry:* Viewing angle $\theta_{\text{obs}}$ ($^\circ$), Doppler factor $\delta$, apparent knot speed $\beta_{\text{app}}$ ($\times c$), jet/counterjet flux ratio $R$, AGN classification (`Blazar` / `Quasar` / `Seyfert 2`).
  - *Presets (`1`–`6`):* `On-Axis Blazar Barrel`, `M87* Helical Jet (17°)`, `Side-On Radio Galaxy`, `Seyfert 2 Dusty Torus`, `Superluminal Shock Knots`, `Ionization Cones`.

---

### 6. Solar Corona, Magnetic Reconnection & Total Eclipse (`solar-corona-sim/`)

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

### 7. Exoplanet Atmosphere, Volumetric Rings & Transit Eclipse (`exoplanet-sim/`)

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

### 8. Protoplanetary Disk & Planet-Carved Spiral Gaps (`protoplanetary-sim/`)

An ALMA DSHARP–inspired (HL Tauri / PDS 70) volumetric circumstellar disk simulator with embedded protoplanets carving live Lindblad spiral density waves and annular dust gaps.

- **Core Physics & Math:**
  - Hydrostatic **flared disk geometry** $H(r) = H_0 (r/r_0)^{1.25}$ with radial irradiation temperature profile $T(r) \propto r^{-0.5}$ crossing the **water ($\sim 170\,\text{K}$) and CO ($\sim 20\,\text{K}$) snowlines** (where dust opacity and icy grain albedo jump sharply).
  - **256×256 dual-backend GPU hydrodynamic solver** (WebGPU compute / WebGL2 `RGBA16F` ping-pong, extending `binary-bh-sim/`'s solver) evolving 1–3 orbiting protoplanets: each planet's **Hill sphere** $R_H = a_p (M_p / 3 M_\star)^{1/3}$ carves an annular dust gap, launches inner/outer **Lindblad spiral wakes**, and collects a glowing **circumplanetary mini-disk**.
  - Dual radiative transfer mode switching smoothly between **Optical / Near-IR Scattered Starlight** (bright flared surface casting a dark midplane shadow onto the outer disk) and **ALMA 1.3mm Thermal Dust Continuum** (piercing optically thin dust to reveal crisp concentric rings and spiral arms).
- **Visuals & Shader Architecture:**
  - Sculpted golden-ivory concentric rings, luminous warm inner dust wall, dark flared shadow lane when viewed near edge-on, and glowing baby planets orbiting inside cleared gaps—paired with subtle protostellar bipolar Herbig–Haro jets.
- **Controls, Presets & Telemetry:**
  - *Controls:* Protoplanet count (`1`–`3`) & mass ($M_{\text{Jup}}$), disk flaring index $\psi$, dust-to-gas opacity, snowline contrast, orbital speed, spectral view (`Optical Scattered`, `ALMA 1.3mm Thermal`, `Midplane Gas`, toggled via `T`).
  - *Telemetry:* Protoplanet orbital radius ($\text{AU}$), Hill radius ($R_H$), $\text{H}_2\text{O}$ / $\text{CO}$ snowline radii ($\text{AU}$), gap depth contrast, disk mass ($M_\odot$).
  - *Presets (`1`–`6`):* `HL Tauri Concentric Rings`, `PDS 70 Twin Protoplanets`, `Edge-On Flared Shadow`, `ALMA 1.3mm Continuum`, `Lindblad Spiral Wakes`, `T Tauri Bipolar Jet`.

---

### 9. White Hole, Kruskal–Szekeres Bridge & Planck-Star Bounce (`whitehole-sim/`)

A time-reversed relativistic counterpart to `blackhole-sim/` visualizing an anti-trapped **white-hole horizon**, the **maximally extended Kruskal–Szekeres spacetime**, and a **Loop Quantum Gravity Planck-star black-to-white-hole bounce**.

- **Core Physics & Math:**
  - Exact **Eddington–Finkelstein / Kruskal–Szekeres** geodesics contrasting a future trapping horizon (black hole) against a **past anti-trapping horizon** (white hole, $UV = (1 - r/2M)e^{r/2M}$): no geodesic can cross inward into the white hole; instead, approaching rays skim an infinitely blueshifted **Eardley instability sheet** while outrushing matter and light erupt outward across the past horizon.
  - Smooth **Rovelli–Vidotto Planck-star quantum bounce** metric parameter interpolating continuously from collapsing black hole ($t < 0$) → quantum-gravity core bounce ($t = 0$) → erupting white hole ($t > 0$) ejecting luminous expanding shock shells.
  - Optional **Region I ↔ Region III** asymptotic window glimpse across the transient Einstein–Rosen bridge pinch.
- **Visuals & Shader Architecture:**
  - Completely inverts the visual mood of `blackhole-sim/`: instead of an absorbing black void, an incandescent pearlescent-violet relativistic horizon rim expels time-reversed plasma streams, expanding concentric gravitational-redshift light echoes, and intense blueshifted caustic rings.
  - Reuses the RK4 curved-spacetime ray-tracer, Planck blackbody LUT, and 128³ volumetric plume shaders with dual-backend WebGL2/WebGPU parity.
- **Controls, Presets & Telemetry:**
  - *Controls:* Bounce phase (`Black Hole` → `Planck Core` → `White Hole`), Eardley blueshift intensity, ejected shell rate, spin $a/M$, Region III sky bleed, time-reversal arrow (`T` toggles **Black Hole ↔ White Hole Inversion**).
  - *Telemetry:* Horizon state (`Trapped` / `Bounce` / `Anti-Trapped`), peak blueshift factor $g_{\max}$, Kruskal $(U, V)$ observer sector, bounce proper time ($\tau/M$).
  - *Presets (`1`–`6`):* `Pure White Hole Eruption`, `Eardley Blueshift Sheet`, `Planck-Star Bounce (t=0)`, `Time-Reversed Accretion`, `Kruskal Bridge Glimpse`, `Black-to-White Cycle`.

---

### 10. Cosmic Web, Dark Matter Filaments & FLRW Horizon (`cosmic-web-sim/`)

A gigaparsec-scale cosmological fly-through inside an expanding **$\Lambda$CDM cosmic web** of dark matter filaments, glowing galaxy clusters, deep cosmic voids, and live cosmological redshift out to Cosmic Dawn.

- **Core Physics & Math:**
  - Multi-scale 3D **Voronoi-ridge / Zel'dovich cellular sheet–filament–node** density field evaluated volumetrically along each ray, forming authentic interconnected cosmic filaments, bright cluster nodes at ridge intersections, and vast dark voids.
  - Live **Friedmann–Lemaître–Robertson–Walker (FLRW)** cosmological expansion ($H_0, \Omega_m, \Omega_\Lambda$): distant filaments experience real **cosmological redshift** $1 + z = a_0 / a(t_{\text{emit}})$ shifting starlight and Lyman-$\alpha$ emission redward along the line of sight via the Planck LUT, while scrubbing cosmic epoch ($z = 0 \leftrightarrow z = 12$) visibly tightens and brightens the early universe!
  - Optional subtle **weak-lensing convergence ($\kappa$)** background galaxy shear along high-density dark-matter filaments.
- **Visuals & Shader Architecture:**
  - Ethereal 3D spiderweb of glowing violet-gold dark-matter filaments, sparkling point-like galaxy cluster supernodes, and warm-hot intergalactic medium (WHIM) gas—built for smooth origin-safe `W`/`S` deep-space fly-through (building on `supernova-sim/`'s flight controller) and noise-free 128-sample pause stills.
- **Controls, Presets & Telemetry:**
  - *Controls:* Cosmic redshift epoch $z \in [0, 12]$, matter/dark-energy balance ($\Omega_m / \Omega_\Lambda$), filament sharpness, cluster luminosity, fly-through velocity, visualization channel (`Dark Matter Web`, `Visible Galaxies`, `WHIM X-Ray Gas`, `Lyman-Alpha Glow`, cycled via `T`).
  - *Telemetry:* Current epoch redshift ($z$), universe age ($\text{Gyr}$), Hubble parameter $H(z)$ ($\text{km/s/Mpc}$), comoving box span ($\text{Mpc}$), mean void fraction.
  - *Presets (`1`–`6`):* `Present-Day Cosmic Web (z=0)`, `Supercluster Node Core`, `Cosmic Void Flythrough`, `Cosmic Noon (z=2)`, `Cosmic Dawn (z=10)`, `WHIM Plasma Filaments`.

---

## Recommended Next Builds (Prioritized)

### Top 3 Highest-Impact Additions
1. **`lens-cluster-sim/` (Gravitational Lensing Observatory):** Introduces an entirely new interactive paradigm (real-time **source-plane dragging across caustics** + live Jacobian critical curves and Fermat contours) with unmistakable JWST-style deep-field visual drama and fast analytical dual-backend shaders.
2. **`tde-sim/` (Tidal Disruption Event):** Highest physics-and-motion "wow factor" — directly builds on `blackhole-sim/`'s Kerr–Schild ray-tracer and `binary-bh-sim/`'s proven **WebGPU compute / WebGL2 `RGBA16F` ping-pong** GPU solver to tell a dramatic visual story from intact star to spaghettified shock flare.
3. **`solar-corona-sim/` (Solar Corona & Total Eclipse)** *(or **`exoplanet-sim/`**)*: Gives the suite a brilliant, warm, luminous astrophysics showcase (magnetic coronal loops, CME eruptions, and a `T`-key **Total Solar Eclipse diamond ring**) that contrasts sharply with the suite's deep-space black-hole/nebula palette.

### Quick Comparison Matrix

| Simulator | Core Technique | Dynamic GPU Sim? | Visual Signature | Complexity |
| :--- | :--- | :--- | :--- | :--- |
| `lens-cluster-sim/` | Analytical thin-lens + Jacobian | No | JWST arcs, Einstein Cross, interactive caustics | Low–Medium |
| `kerr-newman-sim/` | Kerr–Newman Kerr–Schild RK4 | No | Shrinking shadow → naked ring & $r<0$ antiverse | Low–Medium |
| `solar-corona-sim/` | Volumetric loops + limb transfer | No | Golden magnetic arches, CME, total eclipse ring | Medium |
| `exoplanet-sim/` | Rayleigh/Mie + ring shadow march | Optional | Cassini backlit rings, twilight limb, shadows | Medium |
| `blazar-jet-sim/` | Volumetric beamed helical jet | No | Blazar barrel flare, disappearing counter-jet | Medium |
| `whitehole-sim/` | Kruskal / bounce geodesic RK4 | No | Incandescent anti-trapped horizon & blueshift ring | Medium |
| `cosmic-web-sim/` | Multi-scale Voronoi/FLRW march | No | Violet-gold Mpc filament web & void fly-through | Medium |
| `protoplanetary-sim/` | Flared dust transfer + 2D hydro | Yes (256²) | ALMA rings, Lindblad spirals, protoplanets | Medium–High |
| `tde-sim/` | Kerr–Schild + 2D/2.5D debris | Yes (256²) | Spaghettified star, self-intersection shock | High |
| `kilonova-sim/` | Compact tidal + 2-comp ejecta | Optional | Twin glowing NS, red/blue kilonova, sGRB jet | High |

---

## Cross-Sim Platform & Engine Upgrades

As the suite grows past 7 simulators, these architectural upgrades multiply velocity and polish across every existing and future simulator without breaking the zero-dependency static ES-module guarantee:

1. **Observatory Hub (`index.html`) & Scalable Switcher Menu:** Turn root `index.html` from an immediate `meta refresh` redirect into a live interactive **Observatory Gallery** (preserving `?sim=` / `--sim <name>` direct redirects for `launch.sh` and deep links), and upgrade the top-right 7-button horizontal `nav[aria-label="Simulation switcher"]` bar into a compact **dropdown / quick-switcher palette** carrying `?backend=webgl2|webgpu` cleanly across 10+ simulators on desktop and mobile.
2. **Shared Core Module Directory (`shared/`):** Extract the duplicated `post.glsl.js` / `post.wgsl.js`, `physicalLuts.js` (with optional Planck LUT export), `skyLoader.js`, `CameraController`, and `ControlsHUD` base shell into `shared/` so every new `<name>-sim/` only needs to author its metric/volume shader, presets, HUD schema, and tests.
3. **Reusable Dual-Backend 2D GPU Solver (`shared/gpuSim2D.js`):** Generalize `binary-bh-sim/`'s `256×256` WebGPU compute / WebGL2 `RGBA16F` ping-pong pipeline into a clean reusable primitive to power `tde-sim/`, `protoplanetary-sim/`, `exoplanet-sim/` storms, and `kilonova-sim/` ejecta without duplicating texture/bind-group boilerplate.
4. **3D Physics & Geodesic Overlay Layer:** Add an optional HUD toggle rendering analytical diagnostic guides directly in shader or crisp 2D projection—photon-sphere/ergosphere wireframes, critical/caustic curves, light-cylinder radius $R_{\text{LC}}$, or live sample photon trajectories for educational exploration.
5. **Cinema Keyframe Sequencer & WebM / 4K Still Exporter:** Zero-dependency smooth spline camera path recorder between presets/custom waypoints with one-click `MediaRecorder` WebM capture or deterministic frame-by-frame 128-sample accumulated turntable stills.
6. **Optional Procedural Web Audio Sonification:** Mute-by-default, zero-asset Web Audio API synthesizer driven directly by live physics telemetry—e.g., 2.5PN gravitational-wave chirp frequency in `binary-bh-sim/` & `kilonova-sim/`, millisecond radio-pulse ticks in `pulsar-sim/`, relativistic Doppler pitch shift in `starflight-sim/` & `warp-drive-sim/`, and coronal/shock ambience in `supernova-sim/`.
