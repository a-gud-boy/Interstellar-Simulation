use egui::epaint::{CornerRadius, Mesh};
use egui::text::LayoutJob;
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Key, Margin, Order, Painter, Pos2,
    Rect, ScrollArea, Sense, Shape, Stroke, StrokeKind, TextFormat, Ui, Vec2,
};

use crate::assets::previews::PreviewTextureCache;
use crate::sims::SimId;
use crate::ui::{draw_close_icon, semibold_family, tracked_job, with_alpha};

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CategoryFilter {
    All,
    GeneralRelativity,
    ExoticMetrics,
    Astrophysics,
    SpecialRelativity,
}

impl CategoryFilter {
    pub const ALL: [CategoryFilter; 5] = [
        CategoryFilter::All,
        CategoryFilter::GeneralRelativity,
        CategoryFilter::ExoticMetrics,
        CategoryFilter::Astrophysics,
        CategoryFilter::SpecialRelativity,
    ];

    pub fn label(self) -> &'static str {
        match self {
            CategoryFilter::All => "All 7",
            CategoryFilter::GeneralRelativity => "General Relativity",
            CategoryFilter::ExoticMetrics => "Exotic Metrics",
            CategoryFilter::Astrophysics => "Astrophysics",
            CategoryFilter::SpecialRelativity => "Special Relativity",
        }
    }

    pub fn count(self) -> usize {
        match self {
            CategoryFilter::All => CATALOG.len(),
            _ => CATALOG.iter().filter(|e| e.category == self).count(),
        }
    }
}

pub struct CatalogEntry {
    pub sim: SimId,
    pub index: &'static str,
    pub category: CategoryFilter,
    pub category_label: &'static str,
    pub title: &'static str,
    pub short_title: &'static str,
    pub tagline: &'static str,
    pub description: &'static str,
    pub equation: &'static str,
    pub metric_name: &'static str,
    pub accent: Color32,
    pub accent_bright: Color32,
    pub special_control: &'static str,
    pub highlights: [&'static str; 3],
    pub specs: [(&'static str, &'static str); 3],
    pub presets: [(&'static str, &'static str); 6],
}

pub const CATALOG: [CatalogEntry; 7] = [
    CatalogEntry {
        sim: SimId::Blackhole,
        index: "01",
        category: CategoryFilter::GeneralRelativity,
        category_label: "General Relativity",
        title: "Gargantua — Kerr Black Hole",
        short_title: "Gargantua",
        tagline: "Extremal Kerr black hole with volumetric accretion disk",
        description: "3D Outgoing Kerr–Schild ray-traced accretion disk, relativistic Doppler beaming, photon-ring caustic, and 128-sample cinema still mode.",
        equation: "g_μν = η_μν + 2H l_μ l_ν · a/M ≤ 0.998",
        metric_name: "3D Outgoing Kerr–Schild",
        accent: Color32::from_rgb(0xf0, 0xb3, 0x5a),
        accent_bright: Color32::from_rgb(0xf7, 0xca, 0x82),
        special_control: "Space freezes orbit for 128× cinema still accumulation",
        highlights: [
            "Outgoing Kerr–Schild",
            "Relativistic Beaming",
            "Photon Sub-Rings",
        ],
        specs: [
            ("Spin Limit", "a/M ≤ 0.998"),
            ("Cinema Still", "128× TAA"),
            ("Sky Map", "4K Milky Way"),
        ],
        presets: [
            ("Gargantua (Interstellar)", "Spinning a=0.998 Kerr horizon with luminous golden disk and subtle Doppler shift."),
            ("Relativistic Exact (a=0.998)", "Full physical beaming asymmetry with hot 9,200 K blue-white approaching plasma."),
            ("Schwarzschild (a=0)", "Non-rotating symmetric shadow with wider 6M ISCO and classic photon ring."),
            ("Miller's Horizon (Close)", "Grazing near-horizon vantage at 9.5M looking straight across the warped disk plane."),
            ("EHT M87* (Polar Ring)", "High-inclination 62° polar view with warm synchrotron crescent and faint relativistic jet."),
            ("Active Quasar Core", "Ultra-hot 12,500 K turbulent accretion torus paired with bipolar polar plasma jets."),
        ],
    },
    CatalogEntry {
        sim: SimId::Wormhole,
        index: "02",
        category: CategoryFilter::ExoticMetrics,
        category_label: "Exotic Metrics",
        title: "Morris–Thorne Traversable Wormhole",
        short_title: "Wormhole",
        tagline: "Traversable dual-universe throat linking two distant skies",
        description: "James–Thorne & Ellis spacetime throat linking Universe A (4K Milky Way) and Universe B (Exotic Golden–Teal Nebula).",
        equation: "ds² = −c²dt² + dl² + r(l)²(dθ² + sin²θ dφ²)",
        metric_name: "James–Thorne & Ellis",
        accent: Color32::from_rgb(0x4a, 0xd4, 0xc4),
        accent_bright: Color32::from_rgb(0x96, 0xf2, 0xe7),
        special_control: "T auto-traverses through the throat; W/S steps radial coordinate l",
        highlights: [
            "Dual-Universe Skies",
            "Live Throat Traversal",
            "Twin Einstein Rings",
        ],
        specs: [
            ("Metrics", "James–Thorne / Ellis"),
            ("Topology", "Universe A ⇄ B"),
            ("Traversal", "Smooth l → −l"),
        ],
        presets: [
            ("Interstellar Portal", "Compact crystalline throat linking the 4K Milky Way to an exotic golden-teal nebula."),
            ("Pure Ellis Throat", "Zero-length r(l)=√(ρ²+l²) drainhole metric with clean vacuum gravitational lensing."),
            ("Long Throat Tunnel", "Extended cylindrical throat filled with swirling luminous dust and nested reflections."),
            ("Inside the Throat", "Centered at l=0 looking simultaneously into both asymptotically flat universes."),
            ("Gargantua Side (Univ B)", "Emergent viewpoint on the far side looking back toward our Milky Way portal."),
            ("Twin Einstein Rings", "Tight lensing width emphasizing concentric multiple-orbit light rings around the sphere."),
        ],
    },
    CatalogEntry {
        sim: SimId::BinaryBh,
        index: "03",
        category: CategoryFilter::GeneralRelativity,
        category_label: "General Relativity",
        title: "Binary Black Hole Inspiral & GW Lensing",
        short_title: "Binary BH",
        tagline: "Two-body black hole inspiral with gravitational wave shear",
        description: "Two-body Brill–Lindquist + 2.5PN inspiral, retarded gravitational wave shear, fractal eyebrow shadows, and tidal gas bridges.",
        equation: "Ψ = 1 + M₁/2r₁ + M₂/2r₂ · h₊,×(t − r/c)",
        metric_name: "Brill–Lindquist + 2.5PN",
        accent: Color32::from_rgb(0xa7, 0x8b, 0xfa),
        accent_bright: Color32::from_rgb(0xc4, 0xb5, 0xfd),
        special_control: "Space triggers 128× cinema still on frozen inspiral phase",
        highlights: [
            "2.5PN Inspiral Decay",
            "Retarded GW Lensing",
            "Fractal Eyebrows",
        ],
        specs: [
            ("Mass Ratio", "q = 0.1 – 1.0"),
            ("Radiation", "h₊, h× Retarded"),
            ("Accretion", "Mini-Disks + Bridges"),
        ],
        presets: [
            ("Equal-Mass Inspiral", "Symmetric 1:1 binary spiraling inward with glowing tidal streams and circumbinary ring."),
            ("Extreme Mass Ratio (10:1)", "Secondary black hole carving bright tidal bridges around a dominant primary shadow."),
            ("Edge-On Eyebrow Shadows", "Near-equatorial 88° sightline revealing secondary crescent eyebrow shadows above each hole."),
            ("Tidal Gas Bridges", "Elevated 58° vantage highlighting spiral accretion streams feeding both mini-disks."),
            ("Pre-Merger Plunge", "Tight 3.4M separation with strong quadrupole gravitational-wave shear across the sky."),
            ("Pure Vacuum Binary", "Disk-free binary spacetime isolating pure double-lensing and retarded GW starfield ripples."),
        ],
    },
    CatalogEntry {
        sim: SimId::WarpDrive,
        index: "04",
        category: CategoryFilter::ExoticMetrics,
        category_label: "Exotic Metrics",
        title: "Alcubierre Warp Drive — FTL Spacetime",
        short_title: "Warp Drive",
        tagline: "Superluminal warp bubble with ADM null geodesic caustics",
        description: "Alcubierre, Natário zero-expansion, and Lentz soliton warp metrics with ADM null geodesic ray-tracing and Inside Bridge causal horizon.",
        equation: "ds² = −dt² + (dx − vₛ f(rₛ) dt)² + dy² + dz²",
        metric_name: "Alcubierre / Natário / Lentz",
        accent: Color32::from_rgb(0x38, 0xbd, 0xf8),
        accent_bright: Color32::from_rgb(0x7d, 0xd3, 0xfc),
        special_control: "T switches between External Chase and Inside Bridge cockpit",
        highlights: [
            "ADM Null Geodesics",
            "Doppler Bow Caustic",
            "Inside Bridge Mode",
        ],
        specs: [
            ("Speed Range", "0.1c – 5.0c FTL"),
            ("Metrics", "Alcubierre / Natário / Lentz"),
            ("Viewpoints", "Chase & Cockpit"),
        ],
        presets: [
            ("Subluminal Cruise (0.8c)", "Gentle expansion-contraction wall distortion and crisp forward blueshift at 0.8c."),
            ("Light Barrier (1.0c)", "Critical luminal threshold where forward horizon caustics sharpen into an intense ring."),
            ("Superluminal (2.5c)", "Iconic FTL transit with luminous cyan bow caustic, exotic wall shimmer, and star streaks."),
            ("Bridge View (Cockpit)", "First-person viewpoint inside the flat bubble interior facing the causal horizon wall."),
            ("Thin-Wall High-Energy", "High-sigma 3.5c compression shell amplifying York time-extrinsic curvature shimmer."),
            ("Natário Stealth Bubble", "Zero-expansion divergence-free shift vector sliding spacetime smoothly around the hull."),
        ],
    },
    CatalogEntry {
        sim: SimId::Supernova,
        index: "05",
        category: CategoryFilter::Astrophysics,
        category_label: "Astrophysics",
        title: "Supernova Remnant — Volumetric Nebula",
        short_title: "Supernova",
        tagline: "Volumetric multi-scattering remnant nebula & shock shell",
        description: "Multi-scattering radiative transfer across Sedov–Taylor shock shells, Rayleigh–Taylor filaments, Bok globules, and deep interior fly-through.",
        equation: "dI/ds = j(s) − κ(s)I + σₛ ∫ P_HG(g, cosθ) I dΩ",
        metric_name: "Sedov–Taylor Radiative Transfer",
        accent: Color32::from_rgb(0xfb, 0x92, 0x3c),
        accent_bright: Color32::from_rgb(0xfd, 0xba, 0x74),
        special_control: "W/S flies deep inside the expanding shock shell and dust cavity",
        highlights: [
            "Multi-Scattering Dust",
            "Rayleigh–Taylor Web",
            "Hubble SHO & True Color",
        ],
        specs: [
            ("Blast Model", "Sedov–Taylor"),
            ("Phase Function", "Henyey–Greenstein"),
            ("Palettes", "Broadband & SHO"),
        ],
        presets: [
            ("Crab Filament Shell", "970-year-old broadband remnant with tangled ionized filaments and bright pulsar synchrotron core."),
            ("Veil Shock Front", "Aged 10,500-year thin lacework blast wave sweeping cleanly through the interstellar medium."),
            ("Hubble SHO Narrowband", "Iconic S II / Hα / O III gold-and-cyan narrowband mapping across sculpted dust walls."),
            ("Dark Bok Globules", "Dense forward-scattering dust knots silhouetted against backlit glowing ionization fronts."),
            ("Central Pulsar Cavity", "Close interior vantage immersed in the radiant blue-white synchrotron wind bubble."),
            ("Deep Interior Flythrough", "Wide 62° cockpit framing drifting directly inside the turbulent SHO filament web."),
        ],
    },
    CatalogEntry {
        sim: SimId::Pulsar,
        index: "06",
        category: CategoryFilter::Astrophysics,
        category_label: "Astrophysics",
        title: "Magnetar & Millisecond Pulsar",
        short_title: "Pulsar",
        tagline: "Relativistically lensed neutron star, dipole & lighthouse beams",
        description: "Outgoing Kerr–Schild light bending exposing >50% of the neutron star crust, twisted pair-plasma dipole loops, and PWN torus & jets.",
        equation: "1 − cos α ≈ (1 − cos ψ)(1 − Rₛ/R) · Ω×μ",
        metric_name: "Kerr–Schild + Twisted Dipole",
        accent: Color32::from_rgb(0x67, 0xe8, 0xf9),
        accent_bright: Color32::from_rgb(0xa5, 0xf3, 0xfc),
        special_control: "Space freezes spin phase for 128× cinema still accumulation",
        highlights: [
            ">50% Crust Visible",
            "Twisted Dipole Loops",
            "PWN Torus & Jets",
        ],
        specs: [
            ("Compactness", "Rₛ/R ≤ 0.29"),
            ("Spin Period", "1.5 – 320 ms"),
            ("Emission", "Polar Caps & Beams"),
        ],
        presets: [
            ("Crab-like Young Pulsar", "33 ms oblique rotator with sweeping twin beams, dipolar loops, and equatorial PWN torus."),
            ("Millisecond Recycled Pulsar", "Rapid 1.5 ms compact rotator with strong Kerr–Schild light bending and broad radio cones."),
            ("Ultra-Compact Magnetar", "Extreme Rₛ/R=0.29 compactness with strongly twisted magnetosphere and glowing crust cracks."),
            ("Polar Cap View", "Close 58° polar inspection showing hot 8 MK magnetic footprints and gravitational self-lensing."),
            ("Edge-On Lighthouse", "72° obliquity sweeping razor-bright synchrotron beams straight across the camera lens."),
            ("Torus & Jet PWN", "Wide establishing shot emphasizing the Chandra-inspired synchrotron ring and polar outflows."),
        ],
    },
    CatalogEntry {
        sim: SimId::Starflight,
        index: "07",
        category: CategoryFilter::SpecialRelativity,
        category_label: "Special Relativity",
        title: "Relativistic Starflight — Aberration & Doppler Sky",
        short_title: "Starflight",
        tagline: "Exact Lorentz aberration, Doppler sky & Terrell rotation",
        description: "Exact Special Relativistic Lorentz null-ray aberration up to 0.9999996c, Planck UV/IR & CMB blue-shift, and Penrose–Terrell 3D beacons.",
        equation: "cos θ′ = (cos θ + β)/(1 + β cos θ) · D = [γ(1 − β cos θ)]⁻¹",
        metric_name: "Exact Lorentz Null-Ray SR",
        accent: Color32::from_rgb(0x60, 0xa5, 0xfa),
        accent_bright: Color32::from_rgb(0x93, 0xc5, 0xfd),
        special_control: "T flips Forward / Aft viewport; W/S adjusts optical FOV zoom",
        highlights: [
            "Up to 0.9999996c",
            "Planck UV/IR & CMB",
            "Terrell 3D Beacons",
        ],
        specs: [
            ("Peak Velocity", "0.9999996c"),
            ("Spectrum", "IR → Visible → UV"),
            ("Propulsion", "1g Brachistochrone"),
        ],
        presets: [
            ("0.50c Sub-Relativistic", "Clear forward star compression and early Penrose–Terrell apparent rotation on passing beacons."),
            ("0.90c Headlight Cone", "Classic relativistic beaming concentrating the Milky Way into an intense sapphire forward cone."),
            ("0.995c UV Milky Way", "γ≈10 boost shifting infrared dust into visible gold and optical stars into ultraviolet glow."),
            ("0.9999c CMB Glow", "Ultra-relativistic γ≈70 flight blue-shifting the 2.725 K Cosmic Microwave Background into sight."),
            ("Aft Redshift View", "Rear-facing window revealing deep crimson Doppler redshift and stretched receding starfields."),
            ("1g Brachistochrone Cruise", "Continuous 1g proper acceleration integrating ship proper time τ against external coordinate time."),
        ],
    },
];

pub fn catalog_entry(id: SimId) -> &'static CatalogEntry {
    CATALOG
        .iter()
        .find(|e| e.sim == id)
        .unwrap_or(&CATALOG[0])
}

pub enum HomeAction {
    LaunchSim { sim: SimId, preset: Option<usize> },
}

pub struct HomeState {
    pub spotlight: SimId,
    pub category: CategoryFilter,
    pub inspect_sim: Option<SimId>,
    pub controls_open: bool,
    pub previews: PreviewTextureCache,
    pub scroll_to_catalog: bool,
}

impl Default for HomeState {
    fn default() -> Self {
        Self {
            spotlight: SimId::Blackhole,
            category: CategoryFilter::All,
            inspect_sim: None,
            controls_open: false,
            previews: PreviewTextureCache::default(),
            scroll_to_catalog: false,
        }
    }
}

const BG_VOID: Color32 = Color32::from_rgb(0x03, 0x05, 0x0a);
const TEXT_PRIMARY: Color32 = Color32::from_rgb(0xf3, 0xf6, 0xfc);
const TEXT_SECONDARY: Color32 = Color32::from_rgb(0xa2, 0xb1, 0xc6);
const TEXT_MUTED: Color32 = Color32::from_rgb(0x78, 0x87, 0x9e);
const EMERALD: Color32 = Color32::from_rgb(0x34, 0xd3, 0x99);
const CYAN_GPU: Color32 = Color32::from_rgb(0x38, 0xbd, 0xf8);

#[inline]
fn glass_pill() -> Color32 {
    Color32::from_rgba_unmultiplied(7, 10, 18, 178)
}

#[inline]
fn glass_card() -> Color32 {
    Color32::from_rgba_unmultiplied(8, 12, 22, 204)
}

#[inline]
fn dialog_surface() -> Color32 {
    Color32::from_rgba_unmultiplied(10, 14, 24, 248)
}

#[inline]
fn hairline() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 28)
}

#[inline]
fn hairline_soft() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 16)
}

fn paint_horizontal_gradient(painter: &Painter, rect: Rect, stops: &[(f32, Color32)]) {
    if stops.len() < 2 {
        return;
    }
    let mut mesh = Mesh::default();
    let y0 = rect.top();
    let y1 = rect.bottom();
    for (t, col) in stops {
        let x = rect.left() + rect.width() * t.clamp(0.0, 1.0);
        mesh.colored_vertex(Pos2::new(x, y0), *col);
        mesh.colored_vertex(Pos2::new(x, y1), *col);
    }
    for i in 0..(stops.len() - 1) {
        let base = (i * 2) as u32;
        mesh.add_triangle(base, base + 2, base + 3);
        mesh.add_triangle(base, base + 3, base + 1);
    }
    painter.add(Shape::mesh(mesh));
}

fn paint_vertical_gradient(painter: &Painter, rect: Rect, stops: &[(f32, Color32)]) {
    if stops.len() < 2 {
        return;
    }
    let mut mesh = Mesh::default();
    let x0 = rect.left();
    let x1 = rect.right();
    for (t, col) in stops {
        let y = rect.top() + rect.height() * t.clamp(0.0, 1.0);
        mesh.colored_vertex(Pos2::new(x0, y), *col);
        mesh.colored_vertex(Pos2::new(x1, y), *col);
    }
    for i in 0..(stops.len() - 1) {
        let base = (i * 2) as u32;
        mesh.add_triangle(base, base + 1, base + 3);
        mesh.add_triangle(base, base + 3, base + 2);
    }
    painter.add(Shape::mesh(mesh));
}

fn draw_brand_mark(painter: &Painter, center: Pos2, accent: Color32, bright: Color32) {
    painter.circle_stroke(center, 8.6, Stroke::new(1.35, with_alpha(accent, 220)));
    let angle = -0.24_f32;
    let (sr, cr) = angle.sin_cos();
    let mut pts = Vec::with_capacity(29);
    for i in 0..=28 {
        let a = (i as f32 / 28.0) * std::f32::consts::TAU;
        let lx = a.cos() * 12.2;
        let ly = a.sin() * 3.1;
        pts.push(Pos2::new(
            center.x + lx * cr - ly * sr,
            center.y + lx * sr + ly * cr,
        ));
    }
    painter.line(pts, Stroke::new(1.3, bright));
    painter.circle_filled(center, 4.9, Color32::from_rgb(0x03, 0x05, 0x0a));
}

fn draw_stage_backdrop(ctx: &Context, state: &mut HomeState, screen: Rect, entry: &CatalogEntry) {
    let painter = ctx.layer_painter(egui::LayerId::background());
    painter.rect_filled(screen, CornerRadius::ZERO, BG_VOID);

    let tex_id = {
        let tex = state.previews.get_or_load(ctx, entry.sim);
        let size = tex.size_vec2();
        (tex.id(), size)
    };
    let img_aspect = if tex_id.1.y > 1.0 {
        tex_id.1.x / tex_id.1.y
    } else {
        16.0 / 9.0
    };
    let screen_aspect = (screen.width() / screen.height().max(1.0)).max(0.1);

    // Overscan slightly (1.06x) and nudge focal framing toward the right stage so
    // the left editorial brief never obscures the center of the celestial phenomenon.
    let (cover_w, cover_h) = if screen_aspect >= img_aspect {
        let w = screen.width() * 1.06;
        (w, w / img_aspect)
    } else {
        let h = screen.height() * 1.06;
        (h * img_aspect, h)
    };
    let max_shift_x = ((cover_w - screen.width()) * 0.5).max(0.0);
    let shift_x = (screen.width() * 0.045).min(max_shift_x);
    let img_rect = Rect::from_center_size(
        Pos2::new(screen.center().x + shift_x, screen.center().y - (cover_h - screen.height()) * 0.05),
        Vec2::new(cover_w, cover_h),
    );
    painter.image(
        tex_id.0,
        img_rect,
        Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
        Color32::from_rgba_unmultiplied(245, 248, 255, 236),
    );

    // Left editorial readability vignette
    paint_horizontal_gradient(
        &painter,
        screen,
        &[
            (0.0, Color32::from_rgba_unmultiplied(3, 5, 10, 252)),
            (0.28, Color32::from_rgba_unmultiplied(3, 5, 10, 234)),
            (0.46, Color32::from_rgba_unmultiplied(3, 5, 10, 152)),
            (0.68, Color32::from_rgba_unmultiplied(3, 5, 10, 34)),
            (1.0, Color32::from_rgba_unmultiplied(3, 5, 10, 12)),
        ],
    );

    // Top bar contrast vignette
    paint_vertical_gradient(
        &painter,
        screen,
        &[
            (0.0, Color32::from_rgba_unmultiplied(3, 5, 10, 220)),
            (0.22, Color32::from_rgba_unmultiplied(3, 5, 10, 88)),
            (0.48, Color32::TRANSPARENT),
        ],
    );

    // Bottom filmstrip dock vignette
    paint_vertical_gradient(
        &painter,
        screen,
        &[
            (0.46, Color32::TRANSPARENT),
            (0.66, Color32::from_rgba_unmultiplied(3, 5, 10, 128)),
            (0.84, Color32::from_rgba_unmultiplied(3, 5, 10, 238)),
            (1.0, Color32::from_rgba_unmultiplied(3, 5, 10, 254)),
        ],
    );

    // Smooth radial ambient accent glow behind the focal phenomenon (zero discrete rings)
    let glow_center = Pos2::new(
        screen.left() + screen.width() * 0.68,
        screen.top() + screen.height() * 0.44,
    );
    let glow_radius = screen.height().max(720.0) * 0.46;
    let mut glow = Mesh::default();
    glow.colored_vertex(glow_center, with_alpha(entry.accent, 24));
    const STEPS: usize = 36;
    for i in 0..=STEPS {
        let theta = (i as f32 / STEPS as f32) * std::f32::consts::TAU;
        let p = glow_center + Vec2::new(theta.cos(), theta.sin()) * glow_radius;
        glow.colored_vertex(p, Color32::TRANSPARENT);
    }
    for i in 1..=STEPS as u32 {
        glow.add_triangle(0, i, i + 1);
    }
    painter.add(Shape::mesh(glow));
}

fn draw_accent_pill_button(
    ui: &mut Ui,
    label: &str,
    accent: Color32,
    bright: Color32,
    height: f32,
    pad_x: f32,
    font_size: f32,
) -> egui::Response {
    let dark_fg = Color32::from_rgb(0x05, 0x07, 0x0e);
    let g = ui.painter().layout_job(tracked_job(
        label,
        FontId::new(font_size, semibold_family()),
        dark_fg,
        0.2,
    ));
    let w = pad_x * 2.0 + g.size().x;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, height), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    let fill = if resp.hovered() { bright } else { accent };
    ui.painter().rect_filled(
        rect.expand(1.5),
        CornerRadius::same(((height * 0.5) + 2.0).ceil() as u8),
        with_alpha(accent, if resp.hovered() { 70 } else { 42 }),
    );
    ui.painter()
        .rect_filled(rect, CornerRadius::same((height * 0.5).ceil() as u8), fill);
    ui.painter().galley(
        Pos2::new(
            rect.center().x - g.size().x * 0.5,
            rect.center().y - g.size().y * 0.5,
        ),
        g,
        dark_fg,
    );
    resp
}

fn draw_glass_pill_button(
    ui: &mut Ui,
    label: &str,
    height: f32,
    pad_x: f32,
    font_size: f32,
    border_override: Option<Color32>,
) -> egui::Response {
    let fg = TEXT_PRIMARY;
    let g = ui.painter().layout_job(tracked_job(
        label,
        FontId::new(font_size, semibold_family()),
        fg,
        0.2,
    ));
    let w = pad_x * 2.0 + g.size().x;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, height), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    let fill = if resp.hovered() {
        Color32::from_rgba_unmultiplied(255, 255, 255, 24)
    } else {
        Color32::from_rgba_unmultiplied(10, 14, 24, 184)
    };
    let border = border_override.unwrap_or_else(|| {
        if resp.hovered() {
            Color32::from_rgba_unmultiplied(255, 255, 255, 76)
        } else {
            hairline()
        }
    });
    ui.painter().rect(
        rect,
        CornerRadius::same((height * 0.5).ceil() as u8),
        fill,
        Stroke::new(1.0, border),
        StrokeKind::Inside,
    );
    ui.painter().galley(
        Pos2::new(
            rect.center().x - g.size().x * 0.5,
            rect.center().y - g.size().y * 0.5,
        ),
        g,
        fg,
    );
    resp
}

fn draw_floating_topbar(
    ctx: &Context,
    screen: Rect,
    pad_x: f32,
    state: &mut HomeState,
    active: &CatalogEntry,
) {
    let bar_w = (screen.width() - pad_x * 2.0).max(320.0);
    let bar_h = 46.0;
    let bar_rect = Rect::from_min_size(Pos2::new(screen.left() + pad_x, screen.top() + 16.0), Vec2::new(bar_w, bar_h));

    Area::new(Id::unique("home_topbar_area"))
        .fixed_pos(bar_rect.min)
        .order(Order::Middle)
        .fade_in(false)
        .interactable(!state.controls_open && state.inspect_sim.is_none())
        .show(ctx, |ui| {
            ui.set_min_size(bar_rect.size());
            ui.set_max_size(bar_rect.size());

            ui.painter().rect(
                bar_rect,
                CornerRadius::same(23),
                glass_pill(),
                Stroke::new(1.0, hairline()),
                StrokeKind::Inside,
            );

            egui::Frame::NONE
                .inner_margin(Margin::symmetric(14, 0))
                .show(ui, |ui| {
                    ui.set_width((bar_w - 28.0).max(120.0));
                    ui.set_height(bar_h);
                    ui.with_layout(egui::Layout::left_to_right(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;

                        // Brand lockup
                        let (mark_rect, _) = ui.allocate_exact_size(Vec2::new(26.0, 26.0), Sense::hover());
                        draw_brand_mark(ui.painter(), mark_rect.center(), active.accent, active.accent_bright);

                        let mut wordmark = LayoutJob::default();
                        wordmark.append(
                            "INTERSTELLAR  ",
                            0.0,
                            TextFormat {
                                font_id: FontId::new(12.0, semibold_family()),
                                color: TEXT_PRIMARY,
                                extra_letter_spacing: 1.4,
                                ..Default::default()
                            },
                        );
                        wordmark.append(
                            "OBSERVATORY",
                            0.0,
                            TextFormat {
                                font_id: FontId::new(12.0, semibold_family()),
                                color: active.accent_bright,
                                extra_letter_spacing: 1.4,
                                ..Default::default()
                            },
                        );
                        ui.label(wordmark);

                        if screen.width() >= 1180.0 {
                            let sep = ui.allocate_exact_size(Vec2::new(1.0, 14.0), Sense::hover()).0;
                            ui.painter().rect_filled(sep, CornerRadius::ZERO, hairline());
                            ui.label(tracked_job(
                                "v0.1.2.1 · 7 ENGINES",
                                FontId::new(10.5, egui::FontFamily::Monospace),
                                TEXT_SECONDARY,
                                0.5,
                            ));
                        }

                        // Centered Category Filter Pills
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;

                            // Native GPU indicator pill (far right)
                            let gpu_label = "Native wgpu";
                            let gpu_font = FontId::new(10.5, egui::FontFamily::Monospace);
                            let gpu_g = ui.painter().layout_job(tracked_job(gpu_label, gpu_font, CYAN_GPU, 0.3));
                            let gpu_w = 24.0 + gpu_g.size().x;
                            let (gpu_rect, _) = ui.allocate_exact_size(Vec2::new(gpu_w, 28.0), Sense::hover());
                            ui.painter().rect(
                                gpu_rect,
                                CornerRadius::same(14),
                                Color32::from_rgba_unmultiplied(56, 189, 248, 28),
                                Stroke::new(1.0, Color32::from_rgba_unmultiplied(56, 189, 248, 120)),
                                StrokeKind::Inside,
                            );
                            ui.painter().circle_filled(
                                Pos2::new(gpu_rect.left() + 10.0, gpu_rect.center().y),
                                3.0,
                                CYAN_GPU,
                            );
                            ui.painter().galley(
                                Pos2::new(gpu_rect.left() + 16.0, gpu_rect.center().y - gpu_g.size().y * 0.5),
                                gpu_g,
                                CYAN_GPU,
                            );

                            // Controls modal pill
                            if draw_glass_pill_button(ui, "Controls", 28.0, 12.0, 11.5, None).clicked() {
                                state.controls_open = true;
                            }

                            // Category filter bar sitting nicely in the middle-right area
                            if screen.width() >= 920.0 {
                                ui.add_space(6.0);
                                for cat in CategoryFilter::ALL.iter().rev() {
                                    let is_selected = state.category == *cat;
                                    let fg = if is_selected { TEXT_PRIMARY } else { TEXT_SECONDARY };
                                    let g = ui.painter().layout_job(tracked_job(
                                        cat.label(),
                                        FontId::new(11.0, semibold_family()),
                                        fg,
                                        0.15,
                                    ));
                                    let pill_w = 18.0 + g.size().x;
                                    let (p_rect, p_resp) =
                                        ui.allocate_exact_size(Vec2::new(pill_w, 28.0), Sense::click());
                                    if p_resp.hovered() {
                                        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                    }
                                    if is_selected {
                                        ui.painter().rect(
                                            p_rect,
                                            CornerRadius::same(14),
                                            with_alpha(active.accent, 38),
                                            Stroke::new(1.0, with_alpha(active.accent, 145)),
                                            StrokeKind::Inside,
                                        );
                                    } else if p_resp.hovered() {
                                        ui.painter().rect_filled(
                                            p_rect,
                                            CornerRadius::same(14),
                                            Color32::from_rgba_unmultiplied(255, 255, 255, 16),
                                        );
                                    }
                                    ui.painter().galley(
                                        Pos2::new(p_rect.center().x - g.size().x * 0.5, p_rect.center().y - g.size().y * 0.5),
                                        g,
                                        fg,
                                    );
                                    if p_resp.clicked() {
                                        state.category = *cat;
                                        let visible: Vec<&CatalogEntry> = CATALOG
                                            .iter()
                                            .filter(|e| *cat == CategoryFilter::All || e.category == *cat)
                                            .collect();
                                        if let Some(first) = visible.first() {
                                            if !visible.iter().any(|e| e.sim == state.spotlight) {
                                                state.spotlight = first.sim;
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    });
                });
        });
}

fn draw_mission_brief(
    ctx: &Context,
    screen: Rect,
    pad_x: f32,
    dock_top_y: f32,
    state: &mut HomeState,
    entry: &CatalogEntry,
    action: &mut Option<HomeAction>,
) {
    let stage_top = screen.top() + 74.0;
    let stage_bottom = (dock_top_y - 14.0).max(stage_top + 260.0);
    let brief_w = (screen.width() * 0.45).clamp(430.0, 560.0);
    let est_h = 330.0;
    let brief_y = ((stage_top + stage_bottom - est_h) * 0.5).max(stage_top);

    Area::new(Id::unique("home_mission_brief"))
        .fixed_pos(Pos2::new(screen.left() + pad_x, brief_y))
        .order(Order::Middle)
        .fade_in(false)
        .interactable(!state.controls_open && state.inspect_sim.is_none())
        .show(ctx, |ui| {
            ui.set_max_width(brief_w);
            ui.spacing_mut().item_spacing.y = 9.0;

            // Eyebrow with glowing accent dot
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (dot_rect, _) = ui.allocate_exact_size(Vec2::new(10.0, 14.0), Sense::hover());
                let dc = dot_rect.center();
                ui.painter().circle_filled(dc, 6.5, with_alpha(entry.accent, 65));
                ui.painter().circle_filled(dc, 3.2, entry.accent_bright);

                let eyebrow = format!(
                    "{} / 07 · {}",
                    entry.index,
                    entry.category_label.to_uppercase()
                );
                ui.label(tracked_job(
                    &eyebrow,
                    FontId::new(11.0, egui::FontFamily::Monospace),
                    entry.accent_bright,
                    1.2,
                ));
            });

            // Display Title
            ui.label(
                egui::RichText::new(entry.short_title)
                    .size(44.0)
                    .family(semibold_family())
                    .color(Color32::WHITE),
            );

            // Subtitle
            let subtitle = format!("{} · {}", entry.title, entry.metric_name);
            ui.label(tracked_job(
                &subtitle,
                FontId::new(12.0, egui::FontFamily::Monospace),
                with_alpha(entry.accent_bright, 232),
                0.35,
            ));

            // Concise Editorial Copy
            ui.label(
                egui::RichText::new(entry.description)
                    .size(14.0)
                    .color(Color32::from_rgb(0xc7, 0xd2, 0xe1)),
            );

            // Metric Equation Ribbon
            egui::Frame::NONE
                .fill(Color32::from_rgba_unmultiplied(7, 10, 18, 178))
                .stroke(Stroke::new(1.0, hairline()))
                .corner_radius(CornerRadius::same(9))
                .inner_margin(Margin::symmetric(12, 7))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 10.0;
                        ui.label(tracked_job(
                            "METRIC",
                            FontId::new(9.5, egui::FontFamily::Monospace),
                            TEXT_MUTED,
                            1.1,
                        ));
                        ui.label(
                            egui::RichText::new(entry.equation)
                                .size(12.0)
                                .monospace()
                                .color(TEXT_PRIMARY),
                        );
                    });
                });

            // 3 Hairline Telemetry Columns (no outer boxes, only top/bottom & inner vertical hairlines)
            let specs_w = brief_w;
            let specs_h = 46.0;
            let (specs_rect, _) = ui.allocate_exact_size(Vec2::new(specs_w, specs_h), Sense::hover());
            let sp = ui.painter();
            sp.line_segment(
                [Pos2::new(specs_rect.left(), specs_rect.top()), Pos2::new(specs_rect.right(), specs_rect.top())],
                Stroke::new(1.0, hairline()),
            );
            sp.line_segment(
                [Pos2::new(specs_rect.left(), specs_rect.bottom()), Pos2::new(specs_rect.right(), specs_rect.bottom())],
                Stroke::new(1.0, hairline()),
            );
            let col_w = specs_w / 3.0;
            for (i, (k, v)) in entry.specs.iter().enumerate() {
                let x0 = specs_rect.left() + col_w * i as f32;
                let pad_l = if i == 0 { 0.0 } else { 12.0 };
                if i > 0 {
                    sp.line_segment(
                        [Pos2::new(x0, specs_rect.top() + 8.0), Pos2::new(x0, specs_rect.bottom() - 8.0)],
                        Stroke::new(1.0, hairline_soft()),
                    );
                }
                let kg = sp.layout_job(tracked_job(
                    &k.to_uppercase(),
                    FontId::new(9.5, egui::FontFamily::Monospace),
                    TEXT_MUTED,
                    0.9,
                ));
                let vg = sp.layout_job(tracked_job(
                    v,
                    FontId::new(13.0, semibold_family()),
                    TEXT_PRIMARY,
                    0.1,
                ));
                sp.galley(Pos2::new(x0 + pad_l, specs_rect.top() + 7.0), kg, TEXT_MUTED);
                sp.galley(Pos2::new(x0 + pad_l, specs_rect.top() + 22.0), vg, TEXT_PRIMARY);
            }

            ui.add_space(2.0);

            // Primary Actions Row
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                if draw_accent_pill_button(
                    ui,
                    "Enter Simulation  →",
                    entry.accent,
                    entry.accent_bright,
                    38.0,
                    18.0,
                    13.0,
                )
                .clicked()
                {
                    *action = Some(HomeAction::LaunchSim {
                        sim: entry.sim,
                        preset: None,
                    });
                }

                if draw_glass_pill_button(ui, "Presets & Dossier", 38.0, 16.0, 12.5, None).clicked() {
                    state.inspect_sim = Some(entry.sim);
                }

                // Zero idle GPU readout pill
                let status_txt = "0% Idle GPU · 42 Presets";
                let sg = ui.painter().layout_job(tracked_job(
                    status_txt,
                    FontId::new(10.5, egui::FontFamily::Monospace),
                    TEXT_SECONDARY,
                    0.2,
                ));
                let sw = 28.0 + sg.size().x;
                let (s_rect, _) = ui.allocate_exact_size(Vec2::new(sw, 32.0), Sense::hover());
                ui.painter().rect(
                    s_rect,
                    CornerRadius::same(16),
                    Color32::from_rgba_unmultiplied(7, 10, 18, 165),
                    Stroke::new(1.0, hairline_soft()),
                    StrokeKind::Inside,
                );
                ui.painter().circle_filled(
                    Pos2::new(s_rect.left() + 12.0, s_rect.center().y),
                    3.0,
                    EMERALD,
                );
                ui.painter().galley(
                    Pos2::new(s_rect.left() + 20.0, s_rect.center().y - sg.size().y * 0.5),
                    sg,
                    TEXT_SECONDARY,
                );
            });
        });
}

fn draw_filmstrip_dock(
    ctx: &Context,
    screen: Rect,
    pad_x: f32,
    dock_top_y: f32,
    card_w: f32,
    card_h: f32,
    state: &mut HomeState,
    action: &mut Option<HomeAction>,
) {
    let dock_w = (screen.width() - pad_x * 2.0).max(320.0);

    Area::new(Id::unique("home_filmstrip_dock"))
        .fixed_pos(Pos2::new(screen.left() + pad_x, dock_top_y))
        .order(Order::Middle)
        .fade_in(false)
        .interactable(!state.controls_open && state.inspect_sim.is_none())
        .show(ctx, |ui| {
            ui.set_min_width(dock_w);
            ui.set_max_width(dock_w);
            ui.spacing_mut().item_spacing.y = 7.0;

            // Micro dock header
            ui.horizontal(|ui| {
                ui.set_width(dock_w);
                ui.label(tracked_job(
                    "SIMULATION ENGINES · SECTOR ARCHIVE",
                    FontId::new(10.0, egui::FontFamily::Monospace),
                    TEXT_SECONDARY,
                    1.2,
                ));
                ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                    ui.label(tracked_job(
                        "Click to preview · Double-click or ↗ to launch · ← / → · Enter",
                        FontId::new(10.0, egui::FontFamily::Monospace),
                        TEXT_MUTED,
                        0.4,
                    ));
                });
            });

            // Single-row 16:9 horizontal filmstrip cards
            let filtered: Vec<&CatalogEntry> = CATALOG
                .iter()
                .filter(|e| state.category == CategoryFilter::All || e.category == state.category)
                .collect();

            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                for item in filtered {
                    let is_active = item.sim == state.spotlight;
                    let (card_rect, card_resp) =
                        ui.allocate_exact_size(Vec2::new(card_w, card_h), Sense::click());
                    if card_resp.hovered() {
                        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                    }

                    // Card container + thumbnail image
                    let radius = CornerRadius::same(10);
                    let border_col = if is_active {
                        with_alpha(item.accent, 235)
                    } else if card_resp.hovered() {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 86)
                    } else {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 34)
                    };
                    let border_w = if is_active { 1.6 } else { 1.0 };

                    if is_active {
                        ui.painter().rect_filled(
                            card_rect.expand(2.0),
                            CornerRadius::same(12),
                            with_alpha(item.accent, 32),
                        );
                    }
                    ui.painter().rect_filled(card_rect, radius, glass_card());

                    // Thumbnail
                    let tex = state.previews.get_or_load(ctx, item.sim);
                    let tint = if is_active || card_resp.hovered() {
                        Color32::WHITE
                    } else {
                        Color32::from_rgba_unmultiplied(210, 218, 230, 200)
                    };
                    let inner_rect = card_rect.shrink(1.0);
                    ui.painter().image(
                        tex.id(),
                        inner_rect,
                        Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                        tint,
                    );

                    // Top + bottom thumbnail legibility gradient
                    paint_vertical_gradient(
                        ui.painter(),
                        inner_rect,
                        &[
                            (0.0, Color32::from_rgba_unmultiplied(3, 5, 10, 148)),
                            (0.42, Color32::from_rgba_unmultiplied(3, 5, 10, 22)),
                            (1.0, Color32::from_rgba_unmultiplied(3, 5, 10, 232)),
                        ],
                    );

                    // Outer rounded stroke + active top accent bar
                    ui.painter().rect_stroke(
                        card_rect,
                        radius,
                        Stroke::new(border_w, border_col),
                        StrokeKind::Inside,
                    );
                    if is_active {
                        let bar = Rect::from_min_max(
                            Pos2::new(card_rect.left() + 10.0, card_rect.top() + 1.0),
                            Pos2::new(card_rect.right() - 10.0, card_rect.top() + 3.8),
                        );
                        ui.painter().rect_filled(bar, CornerRadius::same(2), item.accent_bright);
                    }

                    // Index badge (top-left) + ACTIVE chip (top-right)
                    let idx_g = ui.painter().layout_job(tracked_job(
                        item.index,
                        FontId::new(9.5, egui::FontFamily::Monospace),
                        Color32::from_rgba_unmultiplied(243, 246, 252, 200),
                        0.4,
                    ));
                    ui.painter().galley(
                        Pos2::new(card_rect.left() + 9.0, card_rect.top() + 7.0),
                        idx_g,
                        TEXT_PRIMARY,
                    );

                    if is_active {
                        let act_g = ui.painter().layout_job(tracked_job(
                            "ACTIVE",
                            FontId::new(8.0, egui::FontFamily::Monospace),
                            item.accent_bright,
                            0.8,
                        ));
                        let aw = act_g.size().x + 10.0;
                        let a_rect = Rect::from_min_size(
                            Pos2::new(card_rect.right() - 8.0 - aw, card_rect.top() + 6.0),
                            Vec2::new(aw, 15.0),
                        );
                        ui.painter().rect(
                            a_rect,
                            CornerRadius::same(8),
                            with_alpha(item.accent, 52),
                            Stroke::new(1.0, with_alpha(item.accent, 175)),
                            StrokeKind::Inside,
                        );
                        ui.painter().galley(
                            Pos2::new(a_rect.left() + 5.0, a_rect.center().y - act_g.size().y * 0.5),
                            act_g,
                            item.accent_bright,
                        );
                    }

                    // Launch circle indicator bottom-right
                    let go_center = Pos2::new(card_rect.right() - 16.0, card_rect.bottom() - 16.0);
                    let pointer_near_go = card_resp
                        .hover_pos()
                        .is_some_and(|p| p.distance(go_center) <= 12.0);
                    ui.painter().circle(
                        go_center,
                        9.5,
                        if pointer_near_go {
                            item.accent_bright
                        } else {
                            Color32::from_rgba_unmultiplied(5, 7, 14, 188)
                        },
                        Stroke::new(
                            1.0,
                            if pointer_near_go {
                                item.accent_bright
                            } else {
                                Color32::from_rgba_unmultiplied(255, 255, 255, 52)
                            },
                        ),
                    );
                    let arrow_fg = if pointer_near_go {
                        Color32::from_rgb(0x05, 0x07, 0x0e)
                    } else {
                        TEXT_PRIMARY
                    };
                    let go_g = ui.painter().layout_job(tracked_job(
                        "↗",
                        FontId::new(10.5, semibold_family()),
                        arrow_fg,
                        0.0,
                    ));
                    ui.painter().galley(
                        Pos2::new(go_center.x - go_g.size().x * 0.5, go_center.y - go_g.size().y * 0.5),
                        go_g,
                        arrow_fg,
                    );

                    // Bottom-left title + metric (clamped before the bottom-right launch button)
                    let max_text_w = (card_rect.width() - 38.0).max(40.0);
                    let fit_job = |text: &str, font: FontId, color: Color32, spacing: f32| {
                        let full = ui.painter().layout_job(tracked_job(text, font.clone(), color, spacing));
                        if full.size().x <= max_text_w {
                            return full;
                        }
                        let chars: Vec<char> = text.chars().collect();
                        let mut hi = chars.len();
                        while hi > 1 {
                            hi -= 1;
                            let candidate: String = chars[..hi].iter().collect::<String>() + "…";
                            let g = ui.painter().layout_job(tracked_job(&candidate, font.clone(), color, spacing));
                            if g.size().x <= max_text_w {
                                return g;
                            }
                        }
                        full
                    };
                    let title_g = fit_job(
                        item.short_title,
                        FontId::new(12.0, semibold_family()),
                        Color32::WHITE,
                        0.1,
                    );
                    let metric_g = fit_job(
                        item.metric_name,
                        FontId::new(8.5, egui::FontFamily::Monospace),
                        item.accent_bright,
                        0.2,
                    );
                    ui.painter().galley(
                        Pos2::new(card_rect.left() + 9.0, card_rect.bottom() - 29.0),
                        metric_g,
                        item.accent_bright,
                    );
                    ui.painter().galley(
                        Pos2::new(card_rect.left() + 9.0, card_rect.bottom() - 18.0),
                        title_g,
                        Color32::WHITE,
                    );

                    if card_resp.double_clicked()
                        || (card_resp.clicked() && pointer_near_go)
                    {
                        *action = Some(HomeAction::LaunchSim {
                            sim: item.sim,
                            preset: None,
                        });
                    } else if card_resp.clicked() {
                        state.spotlight = item.sim;
                    }
                }
            });
        });
}

fn draw_dossier_modal(
    ctx: &Context,
    screen: Rect,
    state: &mut HomeState,
    action: &mut Option<HomeAction>,
) {
    let Some(sim_id) = state.inspect_sim else {
        return;
    };
    let entry = catalog_entry(sim_id);

    // Full-screen dim backdrop
    Area::new(Id::unique("home_dossier_scrim"))
        .fixed_pos(screen.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let (bg_rect, bg_resp) = ui.allocate_exact_size(screen.size(), Sense::click());
            ui.painter().rect_filled(
                bg_rect,
                CornerRadius::ZERO,
                Color32::from_rgba_unmultiplied(2, 4, 9, 208),
            );
            if bg_resp.clicked() {
                state.inspect_sim = None;
            }
        });

    let dlg_w = (screen.width() - 48.0).clamp(320.0, 660.0);
    let dlg_h = (screen.height() - 56.0).clamp(320.0, 540.0);
    let dlg_rect = Rect::from_center_size(screen.center(), Vec2::new(dlg_w, dlg_h));

    Area::new(Id::unique("home_dossier_dialog"))
        .fixed_pos(dlg_rect.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.set_min_size(dlg_rect.size());
            ui.set_max_size(dlg_rect.size());

            ui.painter().rect(
                dlg_rect,
                CornerRadius::same(16),
                dialog_surface(),
                Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 42)),
                StrokeKind::Inside,
            );

            let mut close_now = false;
            egui::Frame::NONE
                .inner_margin(Margin::same(20))
                .show(ui, |ui| {
                    let inner_w = (dlg_w - 40.0).max(200.0);
                    ui.set_min_width(inner_w);
                    ui.set_max_width(inner_w);

                    // Header
                    ui.horizontal(|ui| {
                        ui.set_width(inner_w);
                        ui.vertical(|ui| {
                            ui.set_max_width(inner_w - 40.0);
                            ui.label(tracked_job(
                                &format!(
                                    "{} / 07 · {} · {}",
                                    entry.index,
                                    entry.category_label.to_uppercase(),
                                    entry.metric_name.to_uppercase()
                                ),
                                FontId::new(10.0, egui::FontFamily::Monospace),
                                entry.accent_bright,
                                1.0,
                            ));
                            ui.label(
                                egui::RichText::new(entry.title)
                                    .size(20.0)
                                    .family(semibold_family())
                                    .color(Color32::WHITE),
                            );
                            ui.label(
                                egui::RichText::new(entry.tagline)
                                    .size(12.5)
                                    .color(TEXT_SECONDARY),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(Align::TOP), |ui| {
                            let (c_rect, c_resp) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
                            if c_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().circle(
                                c_rect.center(),
                                15.0,
                                Color32::from_rgba_unmultiplied(255, 255, 255, if c_resp.hovered() { 32 } else { 14 }),
                                Stroke::new(1.0, hairline()),
                            );
                            draw_close_icon(ui.painter(), c_rect.center(), TEXT_PRIMARY);
                            if c_resp.clicked() {
                                close_now = true;
                            }
                        });
                    });

                    ui.add_space(10.0);
                    let sep = ui.allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover()).0;
                    ui.painter().rect_filled(sep, CornerRadius::ZERO, hairline_soft());
                    ui.add_space(10.0);

                    ScrollArea::vertical()
                        .max_height((dlg_h - 178.0).max(160.0))
                        .show(ui, |ui| {
                            ui.set_min_width(inner_w);
                            ui.set_max_width(inner_w);
                            ui.spacing_mut().item_spacing.y = 10.0;
                            ui.label(
                                egui::RichText::new(entry.description)
                                    .size(13.0)
                                    .color(Color32::from_rgb(0xcb, 0xd5, 0xe3)),
                            );

                            let half_w = (inner_w - 10.0) * 0.5;

                            // Formulation & Signature control cards (fixed size + wrapped galley)
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 10.0;
                                for (k, v, is_mono) in [
                                    ("SPACETIME FORMULATION", entry.equation, true),
                                    ("SIGNATURE CONTROL", entry.special_control, false),
                                ] {
                                    let (m_rect, _) =
                                        ui.allocate_exact_size(Vec2::new(half_w, 58.0), Sense::hover());
                                    ui.painter().rect(
                                        m_rect,
                                        CornerRadius::same(10),
                                        Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                                        Stroke::new(1.0, hairline_soft()),
                                        StrokeKind::Inside,
                                    );
                                    let kg = ui.painter().layout_job(tracked_job(
                                        k,
                                        FontId::new(9.5, egui::FontFamily::Monospace),
                                        TEXT_MUTED,
                                        0.9,
                                    ));
                                    ui.painter().galley(
                                        Pos2::new(m_rect.left() + 10.0, m_rect.top() + 8.0),
                                        kg,
                                        TEXT_MUTED,
                                    );
                                    let mut v_job = LayoutJob::simple(
                                        v.to_string(),
                                        FontId::new(
                                            11.0,
                                            if is_mono {
                                                egui::FontFamily::Monospace
                                            } else {
                                                egui::FontFamily::Proportional
                                            },
                                        ),
                                        TEXT_PRIMARY,
                                        half_w - 20.0,
                                    );
                                    v_job.wrap.max_rows = 2;
                                    v_job.wrap.break_anywhere = false;
                                    let vg = ui.painter().layout_job(v_job);
                                    ui.painter().galley(
                                        Pos2::new(m_rect.left() + 10.0, m_rect.top() + 23.0),
                                        vg,
                                        TEXT_PRIMARY,
                                    );
                                }
                            });

                            ui.label(tracked_job(
                                "CURATED PHYSICS PRESETS (CLICK TO LAUNCH DIRECTLY)",
                                FontId::new(10.0, egui::FontFamily::Monospace),
                                TEXT_SECONDARY,
                                0.8,
                            ));

                            for pair in entry.presets.chunks(2).enumerate() {
                                let (row_idx, slice) = pair;
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 10.0;
                                    for (col_idx, (p_name, p_desc)) in slice.iter().enumerate() {
                                        let preset_idx = row_idx * 2 + col_idx;
                                        let btn_h = 58.0;
                                        let (p_rect, p_resp) =
                                            ui.allocate_exact_size(Vec2::new(half_w, btn_h), Sense::click());
                                        if p_resp.hovered() {
                                            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                        }
                                        ui.painter().rect(
                                            p_rect,
                                            CornerRadius::same(10),
                                            if p_resp.hovered() {
                                                with_alpha(entry.accent, 26)
                                            } else {
                                                Color32::from_rgba_unmultiplied(255, 255, 255, 8)
                                            },
                                            Stroke::new(
                                                1.0,
                                                if p_resp.hovered() {
                                                    with_alpha(entry.accent, 150)
                                                } else {
                                                    hairline_soft()
                                                },
                                            ),
                                            StrokeKind::Inside,
                                        );
                                        let n_g = ui.painter().layout_job(tracked_job(
                                            p_name,
                                            FontId::new(12.0, semibold_family()),
                                            Color32::WHITE,
                                            0.1,
                                        ));
                                        ui.painter().galley(
                                            Pos2::new(p_rect.left() + 10.0, p_rect.top() + 8.0),
                                            n_g,
                                            Color32::WHITE,
                                        );
                                        let mut d_job = LayoutJob::simple(
                                            (*p_desc).to_string(),
                                            FontId::new(10.5, egui::FontFamily::Proportional),
                                            TEXT_SECONDARY,
                                            half_w - 20.0,
                                        );
                                        d_job.wrap.max_rows = 2;
                                        d_job.wrap.break_anywhere = false;
                                        let d_g = ui.painter().layout_job(d_job);
                                        ui.painter().galley(
                                            Pos2::new(p_rect.left() + 10.0, p_rect.top() + 25.0),
                                            d_g,
                                            TEXT_SECONDARY,
                                        );
                                        if p_resp.clicked() {
                                            *action = Some(HomeAction::LaunchSim {
                                                sim: entry.sim,
                                                preset: Some(preset_idx),
                                            });
                                        }
                                    }
                                });
                            }
                        });

                    ui.add_space(10.0);
                    let sep2 = ui.allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover()).0;
                    ui.painter().rect_filled(sep2, CornerRadius::ZERO, hairline_soft());
                    ui.add_space(10.0);

                    ui.allocate_ui(Vec2::new(inner_w, 36.0), |ui| {
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 10.0;
                            if draw_accent_pill_button(
                                ui,
                                "Enter Simulation  →",
                                entry.accent,
                                entry.accent_bright,
                                34.0,
                                16.0,
                                12.5,
                            )
                            .clicked()
                            {
                                *action = Some(HomeAction::LaunchSim {
                                    sim: entry.sim,
                                    preset: None,
                                });
                            }
                            if draw_glass_pill_button(ui, "Close", 34.0, 14.0, 12.0, None).clicked() {
                                close_now = true;
                            }
                        });
                    });
                });

            if close_now {
                state.inspect_sim = None;
            }
        });
}

fn draw_controls_modal(
    ctx: &Context,
    screen: Rect,
    state: &mut HomeState,
    active: &CatalogEntry,
    adapter_label: &str,
) {
    if !state.controls_open {
        return;
    }

    Area::new(Id::unique("home_controls_scrim"))
        .fixed_pos(screen.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let (bg_rect, bg_resp) = ui.allocate_exact_size(screen.size(), Sense::click());
            ui.painter().rect_filled(
                bg_rect,
                CornerRadius::ZERO,
                Color32::from_rgba_unmultiplied(2, 4, 9, 208),
            );
            if bg_resp.clicked() {
                state.controls_open = false;
            }
        });

    let dlg_w = (screen.width() - 48.0).clamp(320.0, 620.0);
    let dlg_h = (screen.height() - 72.0).clamp(300.0, 480.0);
    let dlg_rect = Rect::from_center_size(screen.center(), Vec2::new(dlg_w, dlg_h));

    Area::new(Id::unique("home_controls_dialog"))
        .fixed_pos(dlg_rect.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.set_min_size(dlg_rect.size());
            ui.set_max_size(dlg_rect.size());

            ui.painter().rect(
                dlg_rect,
                CornerRadius::same(16),
                dialog_surface(),
                Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 42)),
                StrokeKind::Inside,
            );

            let mut close_now = false;
            egui::Frame::NONE
                .inner_margin(Margin::same(20))
                .show(ui, |ui| {
                    let inner_w = (dlg_w - 40.0).max(200.0);
                    ui.set_min_width(inner_w);
                    ui.set_max_width(inner_w);

                    ui.horizontal(|ui| {
                        ui.set_width(inner_w);
                        ui.vertical(|ui| {
                            ui.set_max_width(inner_w - 40.0);
                            ui.label(tracked_job(
                                "INTERSTELLAR OBSERVATORY · FLIGHT REFERENCE",
                                FontId::new(10.0, egui::FontFamily::Monospace),
                                active.accent_bright,
                                1.0,
                            ));
                            ui.label(
                                egui::RichText::new("Universal Controls & Hardware")
                                    .size(20.0)
                                    .family(semibold_family())
                                    .color(Color32::WHITE),
                            );
                            ui.label(
                                egui::RichText::new(format!("Active Native Backend: {adapter_label}"))
                                    .size(12.0)
                                    .monospace()
                                    .color(CYAN_GPU),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(Align::TOP), |ui| {
                            let (c_rect, c_resp) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
                            if c_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().circle(
                                c_rect.center(),
                                15.0,
                                Color32::from_rgba_unmultiplied(255, 255, 255, if c_resp.hovered() { 32 } else { 14 }),
                                Stroke::new(1.0, hairline()),
                            );
                            draw_close_icon(ui.painter(), c_rect.center(), TEXT_PRIMARY);
                            if c_resp.clicked() {
                                close_now = true;
                            }
                        });
                    });

                    ui.add_space(10.0);
                    let sep = ui.allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover()).0;
                    ui.painter().rect_filled(sep, CornerRadius::ZERO, hairline_soft());
                    ui.add_space(10.0);

                    let bindings = [
                        ("Drag", "Orbit observer camera"),
                        ("Scroll / W S", "Radial zoom / altitude"),
                        ("Right-Drag", "Camera tilt & roll"),
                        ("1 – 6", "Load physics preset"),
                        ("Space", "Pause / 128× cinema still"),
                        ("O", "Toggle orbital cruise"),
                        ("T", "Toggle special mode / telemetry"),
                        ("R", "Reset camera & accumulation"),
                        ("P", "Save PNG capture"),
                        ("H", "Hide / restore HUD overlay"),
                    ];
                    let half_w = (inner_w - 10.0) * 0.5;
                    for pair in bindings.chunks(2) {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 10.0;
                            for (key_txt, desc_txt) in pair {
                                let (k_rect, _) =
                                    ui.allocate_exact_size(Vec2::new(half_w, 32.0), Sense::hover());
                                ui.painter().rect(
                                    k_rect,
                                    CornerRadius::same(8),
                                    Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                                    Stroke::new(1.0, hairline_soft()),
                                    StrokeKind::Inside,
                                );
                                let k_g = ui.painter().layout_job(tracked_job(
                                    key_txt,
                                    FontId::new(10.5, egui::FontFamily::Monospace),
                                    active.accent_bright,
                                    0.2,
                                ));
                                let pill_w = k_g.size().x + 12.0;
                                let pill_rect = Rect::from_min_size(
                                    Pos2::new(k_rect.left() + 8.0, k_rect.center().y - 10.0),
                                    Vec2::new(pill_w, 20.0),
                                );
                                ui.painter().rect(
                                    pill_rect,
                                    CornerRadius::same(5),
                                    Color32::from_rgba_unmultiplied(0, 0, 0, 125),
                                    Stroke::new(1.0, hairline()),
                                    StrokeKind::Inside,
                                );
                                ui.painter().galley(
                                    Pos2::new(pill_rect.left() + 6.0, pill_rect.center().y - k_g.size().y * 0.5),
                                    k_g,
                                    active.accent_bright,
                                );
                                let d_g = ui.painter().layout_job(tracked_job(
                                    desc_txt,
                                    FontId::new(11.5, egui::FontFamily::Proportional),
                                    TEXT_PRIMARY,
                                    0.0,
                                ));
                                ui.painter().galley(
                                    Pos2::new(pill_rect.right() + 9.0, k_rect.center().y - d_g.size().y * 0.5),
                                    d_g,
                                    TEXT_PRIMARY,
                                );
                            }
                        });
                        ui.add_space(5.0);
                    }

                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(format!(
                            "CLI Launchers: ./launch.sh --desktop  ·  ./launch.sh --desktop --{}",
                            active.sim.cli_name()
                        ))
                        .size(11.0)
                        .monospace()
                        .color(TEXT_SECONDARY),
                    );

                    ui.add_space(12.0);
                    ui.allocate_ui(Vec2::new(inner_w, 36.0), |ui| {
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            if draw_glass_pill_button(ui, "Close", 34.0, 16.0, 12.5, None).clicked() {
                                close_now = true;
                            }
                        });
                    });
                });

            if close_now {
                state.controls_open = false;
            }
        });
}

pub fn draw_homepage(
    ctx: &Context,
    state: &mut HomeState,
    adapter_label: &str,
) -> Option<HomeAction> {
    let mut action: Option<HomeAction> = None;
    let screen = ctx.input(|i| i.content_rect());

    // Ensure spotlight stays valid inside the active category filter
    let filtered_count = state.category.count();
    let visible: Vec<&CatalogEntry> = CATALOG
        .iter()
        .filter(|e| state.category == CategoryFilter::All || e.category == state.category)
        .collect();
    if filtered_count > 0 && !visible.iter().any(|e| e.sim == state.spotlight) {
        state.spotlight = visible[0].sim;
    }

    let active = catalog_entry(state.spotlight);

    // Handle Escape cleanly for overlays
    if ctx.input(|i| i.key_pressed(Key::Escape)) {
        if state.controls_open {
            state.controls_open = false;
        } else if state.inspect_sim.is_some() {
            state.inspect_sim = None;
        }
    }

    let pad_x = if screen.width() >= 1100.0 { 26.0 } else { 16.0 };
    let dock_w = (screen.width() - pad_x * 2.0).max(320.0);
    let slot_count = visible.len().max(1);
    let total_gap = 10.0 * (slot_count.saturating_sub(1) as f32);
    let max_card_w = if screen.width() >= 1400.0 { 224.0 } else { 205.0 };
    let card_w = ((dock_w - total_gap) / slot_count as f32).clamp(112.0, max_card_w);
    let card_h = (card_w * 9.0 / 16.0).clamp(68.0, 124.0);
    let dock_h = 20.0 + card_h;
    let dock_top_y = (screen.bottom() - 16.0 - dock_h).max(screen.top() + 360.0);

    draw_stage_backdrop(ctx, state, screen, active);
    draw_floating_topbar(ctx, screen, pad_x, state, active);
    draw_mission_brief(ctx, screen, pad_x, dock_top_y, state, active, &mut action);
    draw_filmstrip_dock(ctx, screen, pad_x, dock_top_y, card_w, card_h, state, &mut action);

    if state.controls_open {
        draw_controls_modal(ctx, screen, state, active, adapter_label);
    } else if state.inspect_sim.is_some() {
        draw_dossier_modal(ctx, screen, state, &mut action);
    }

    action
}
