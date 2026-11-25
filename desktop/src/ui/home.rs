use egui::epaint::CornerRadius;
use egui::text::LayoutJob;
use egui::{
    Align, Align2, Area, Color32, Context, CursorIcon, FontId, Id, Image, Key, Order, Painter,
    Pos2, Rect, ScrollArea, Sense, Shape, Stroke, StrokeKind, TextFormat, Ui, Vec2,
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
            CategoryFilter::All => "All Engines",
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
        description: "3D Outgoing Kerr–Schild ray-traced accretion disk, relativistic Doppler beaming, and 128-sample cinema still mode.",
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
    pub previews: PreviewTextureCache,
    pub scroll_to_catalog: bool,
}

impl Default for HomeState {
    fn default() -> Self {
        Self {
            spotlight: SimId::Blackhole,
            category: CategoryFilter::All,
            inspect_sim: None,
            previews: PreviewTextureCache::default(),
            scroll_to_catalog: false,
        }
    }
}

const BG_VOID: Color32 = Color32::from_rgb(0x03, 0x05, 0x0a);
const TEXT_PRIMARY: Color32 = Color32::from_rgb(0xee, 0xf2, 0xf7);
const TEXT_SECONDARY: Color32 = Color32::from_rgb(0xa2, 0xb1, 0xc6);
const TEXT_MUTED: Color32 = Color32::from_rgb(0x7c, 0x8b, 0xa1);

#[inline]
fn surface_card() -> Color32 {
    Color32::from_rgba_unmultiplied(12, 16, 26, 224)
}

#[inline]
fn surface_subtle() -> Color32 {
    Color32::from_rgba_unmultiplied(18, 23, 36, 175)
}

#[inline]
fn border_hairline() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 24)
}

#[inline]
fn border_strong() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 44)
}

fn wrapped_job(text: &str, font: FontId, color: Color32, max_w: f32) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = max_w.max(32.0);
    job.append(
        text,
        0.0,
        TextFormat {
            font_id: font,
            color,
            ..Default::default()
        },
    );
    job
}

fn draw_gargantua_mark(painter: &Painter, center: Pos2, accent: Color32, bright: Color32) {
    painter.circle_stroke(center, 8.5, Stroke::new(1.4, with_alpha(accent, 210)));
    let rot = -14.0_f32.to_radians();
    let (sr, cr) = rot.sin_cos();
    let mut pts = Vec::with_capacity(25);
    for i in 0..=24 {
        let a = (i as f32 / 24.0) * std::f32::consts::TAU;
        let lx = a.cos() * 12.5;
        let ly = a.sin() * 3.1;
        pts.push(Pos2::new(
            center.x + lx * cr - ly * sr,
            center.y + lx * sr + ly * cr,
        ));
    }
    painter.line(pts, Stroke::new(1.3, bright));
    painter.circle_filled(center, 5.2, Color32::BLACK);
}

fn draw_observatory_backdrop(ctx: &Context, screen: Rect, accent: Color32) {
    let painter = ctx.layer_painter(egui::LayerId::background());
    painter.rect_filled(screen, CornerRadius::ZERO, BG_VOID);

    // Subtle 48px deep-space observatory coordinate grid
    let grid_stroke = Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 7));
    let step = 48.0;
    let mut x = screen.left() + 24.0;
    while x < screen.right() {
        painter.line_segment([Pos2::new(x, screen.top()), Pos2::new(x, screen.bottom())], grid_stroke);
        x += step;
    }
    let mut y = screen.top() + 24.0;
    while y < screen.bottom() {
        painter.line_segment([Pos2::new(screen.left(), y), Pos2::new(screen.right(), y)], grid_stroke);
        y += step;
    }

    // Soft ambient radial glow behind the hero viewport (pure 2D circle layers, zero GPU shaders)
    let glow_center = Pos2::new(screen.left() + screen.width() * 0.72, screen.top() + 250.0);
    for (radius, alpha) in [(340.0, 6), (250.0, 9), (165.0, 11)] {
        painter.circle_filled(glow_center, radius, with_alpha(accent, alpha));
    }
}

fn draw_badge_pill(
    ui: &mut Ui,
    text: &str,
    dot: Option<Color32>,
    bg: Color32,
    border: Color32,
    fg: Color32,
    font_size: f32,
) {
    let font = FontId::new(font_size, semibold_family());
    let g = ui.painter().layout_job(tracked_job(text, font, fg, 0.45));
    let dot_w = if dot.is_some() { 11.0 } else { 0.0 };
    let h = (font_size + 10.0).max(20.0);
    let w = 10.0 * 2.0 + dot_w + g.size().x;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(w, h), Sense::hover());
    ui.painter().rect(
        rect,
        CornerRadius::same((h * 0.5).ceil() as u8),
        bg,
        Stroke::new(1.0, border),
        StrokeKind::Inside,
    );
    let mut x = rect.left() + 10.0;
    let cy = rect.center().y;
    if let Some(dot_c) = dot {
        ui.painter().circle_filled(Pos2::new(x + 3.0, cy), 3.0, dot_c);
        x += dot_w;
    }
    ui.painter()
        .galley(Pos2::new(x, cy - g.size().y * 0.5), g, fg);
}

fn draw_accent_button(
    ui: &mut Ui,
    label: &str,
    accent: Color32,
    bright: Color32,
    height: f32,
    pad_x: f32,
    font_size: f32,
) -> egui::Response {
    let font = FontId::new(font_size, semibold_family());
    let dark_fg = Color32::from_rgb(0x06, 0x08, 0x0f);
    let g = ui.painter().layout_job(tracked_job(label, font, dark_fg, 0.2));
    let w = pad_x * 2.0 + g.size().x;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, height), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    let fill = if resp.hovered() { bright } else { accent };
    ui.painter().rect_filled(
        rect,
        CornerRadius::same((height * 0.5).ceil() as u8),
        fill,
    );
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

fn draw_ghost_button(
    ui: &mut Ui,
    label: &str,
    accent_border: Color32,
    height: f32,
    pad_x: f32,
    font_size: f32,
) -> egui::Response {
    let font = FontId::new(font_size, semibold_family());
    let g = ui
        .painter()
        .layout_job(tracked_job(label, font, TEXT_PRIMARY, 0.2));
    let w = pad_x * 2.0 + g.size().x;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, height), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    let (fill, border) = if resp.hovered() {
        (Color32::from_rgba_unmultiplied(28, 34, 52, 230), accent_border)
    } else {
        (surface_subtle(), border_strong())
    };
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
        TEXT_PRIMARY,
    );
    resp
}

fn draw_top_bar(
    ctx: &Context,
    screen: Rect,
    state: &mut HomeState,
    spot: &CatalogEntry,
    adapter_label: &str,
) {
    let bar_h = 54.0;
    let bar_rect = Rect::from_min_size(screen.min, Vec2::new(screen.width(), bar_h));
    Area::new(Id::unique("home_top_bar"))
        .fixed_pos(bar_rect.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.set_min_size(bar_rect.size());
            ui.set_max_size(bar_rect.size());
            ui.painter().rect_filled(
                bar_rect,
                CornerRadius::ZERO,
                Color32::from_rgba_unmultiplied(6, 9, 17, 238),
            );
            ui.painter().line_segment(
                [bar_rect.left_bottom(), bar_rect.right_bottom()],
                Stroke::new(1.0, border_hairline()),
            );

            let pad_x = ((screen.width() - 1140.0) * 0.5).max(20.0);
            let inner = Rect::from_min_max(
                Pos2::new(bar_rect.left() + pad_x, bar_rect.top()),
                Pos2::new(bar_rect.right() - pad_x, bar_rect.bottom()),
            );

            ui.scope_builder(egui::UiBuilder::new().max_rect(inner), |ui| {
                ui.horizontal_centered(|ui| {
                    ui.spacing_mut().item_spacing.x = 10.0;

                    let (mark_r, _) = ui.allocate_exact_size(Vec2::new(26.0, 26.0), Sense::hover());
                    draw_gargantua_mark(ui.painter(), mark_r.center(), spot.accent, spot.accent_bright);

                    let brand_g = ui.painter().layout_job(tracked_job(
                        "INTERSTELLAR",
                        FontId::new(13.0, semibold_family()),
                        TEXT_PRIMARY,
                        2.1,
                    ));
                    let (brand_r, _) =
                        ui.allocate_exact_size(Vec2::new(brand_g.size().x + 2.0, 22.0), Sense::hover());
                    ui.painter().galley(
                        Pos2::new(brand_r.left(), brand_r.center().y - brand_g.size().y * 0.5),
                        brand_g,
                        TEXT_PRIMARY,
                    );

                    draw_badge_pill(
                        ui,
                        "7 ENGINES",
                        None,
                        with_alpha(spot.accent, 28),
                        with_alpha(spot.accent, 115),
                        spot.accent_bright,
                        10.0,
                    );

                    let ver_txt = format!("v{}", crate::APP_VERSION);
                    draw_badge_pill(
                        ui,
                        &ver_txt,
                        None,
                        Color32::from_rgba_unmultiplied(255, 255, 255, 10),
                        border_hairline(),
                        TEXT_SECONDARY,
                        10.0,
                    );

                    ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;

                        draw_badge_pill(
                            ui,
                            adapter_label,
                            Some(Color32::from_rgb(0x34, 0xd3, 0x99)),
                            Color32::from_rgba_unmultiplied(15, 22, 34, 210),
                            border_hairline(),
                            TEXT_SECONDARY,
                            10.0,
                        );

                        if inner.width() >= 780.0
                            && ui
                                .add(
                                    egui::Button::new(
                                        egui::RichText::new("Browse Engines")
                                            .size(11.5)
                                            .color(TEXT_SECONDARY),
                                    )
                                    .frame(false),
                                )
                                .on_hover_cursor(CursorIcon::PointingHand)
                                .clicked()
                        {
                            state.scroll_to_catalog = true;
                        }
                    });
                });
            });
        });
}

fn draw_hero_viewport(
    ui: &mut Ui,
    state: &mut HomeState,
    spot: &CatalogEntry,
    width: f32,
    action: &mut Option<HomeAction>,
) {
    let tex_id = state.previews.get_or_load(ui.ctx(), spot.sim).id();
    let img_h = (width * 9.0 / 16.0).round();
    let (frame_rect, frame_resp) =
        ui.allocate_exact_size(Vec2::new(width, img_h), Sense::click());
    if frame_resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }

    // Outer Observatory Glass frame
    ui.painter().rect(
        frame_rect,
        CornerRadius::same(14),
        Color32::from_rgb(7, 10, 18),
        Stroke::new(1.0, with_alpha(spot.accent, 110)),
        StrokeKind::Outside,
    );

    // Rounded preview image inside frame
    ui.scope_builder(egui::UiBuilder::new().max_rect(frame_rect), |ui| {
        ui.add(
            Image::new((tex_id, frame_rect.size()))
                .fit_to_exact_size(frame_rect.size())
                .corner_radius(CornerRadius::same(14)),
        );
    });

    // Subtle dark gradient scrim along bottom edge for guaranteed caption contrast
    let scrim_rect = Rect::from_min_max(
        Pos2::new(frame_rect.left(), (frame_rect.bottom() - 82.0).max(frame_rect.top())),
        frame_rect.max,
    );
    ui.painter().rect_filled(
        scrim_rect,
        CornerRadius {
            nw: 0,
            ne: 0,
            sw: 14,
            se: 14,
        },
        Color32::from_rgba_unmultiplied(4, 6, 12, 212),
    );

    // Corner reticle brackets
    let ret_stroke = Stroke::new(1.2, with_alpha(spot.accent_bright, 145));
    let arm = 12.0;
    let ins = 10.0;
    for (cx, cy, dx, dy) in [
        (frame_rect.left() + ins, frame_rect.top() + ins, 1.0, 1.0),
        (frame_rect.right() - ins, frame_rect.top() + ins, -1.0, 1.0),
    ] {
        ui.painter()
            .line_segment([Pos2::new(cx, cy), Pos2::new(cx + dx * arm, cy)], ret_stroke);
        ui.painter()
            .line_segment([Pos2::new(cx, cy), Pos2::new(cx, cy + dy * arm)], ret_stroke);
    }

    // Top-left index + metric badge & top-right NATIVE WGPU pill
    let top_row = Rect::from_min_max(
        Pos2::new(frame_rect.left() + 14.0, frame_rect.top() + 14.0),
        Pos2::new(frame_rect.right() - 14.0, frame_rect.top() + 40.0),
    );
    ui.scope_builder(egui::UiBuilder::new().max_rect(top_row), |ui| {
        ui.horizontal(|ui| {
            let tag = format!("{}  ·  {}", spot.index, spot.metric_name);
            draw_badge_pill(
                ui,
                &tag,
                Some(spot.accent),
                Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                border_strong(),
                TEXT_PRIMARY,
                10.5,
            );
            ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                draw_badge_pill(
                    ui,
                    "NATIVE WGPU",
                    None,
                    Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                    with_alpha(spot.accent, 115),
                    spot.accent_bright,
                    10.0,
                );
            });
        });
    });

    // Bottom caption + Inspect / Launch buttons
    let cap_rect = Rect::from_min_max(
        Pos2::new(scrim_rect.left() + 16.0, scrim_rect.top() + 12.0),
        Pos2::new(scrim_rect.right() - 16.0, scrim_rect.bottom() - 12.0),
    );
    let mut clicked_button = false;
    ui.scope_builder(egui::UiBuilder::new().max_rect(cap_rect), |ui| {
        ui.horizontal(|ui| {
            let text_w = (cap_rect.width() - 185.0).max(140.0);
            ui.vertical(|ui| {
                ui.set_max_width(text_w);
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.label(
                    egui::RichText::new(spot.title)
                        .font(FontId::new(14.5, semibold_family()))
                        .color(TEXT_PRIMARY),
                );
                ui.label(
                    egui::RichText::new(spot.equation)
                        .font(FontId::monospace(10.8))
                        .color(TEXT_SECONDARY),
                );
            });
            ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                if draw_accent_button(ui, "Launch ->", spot.accent, spot.accent_bright, 30.0, 13.0, 11.5)
                    .clicked()
                {
                    clicked_button = true;
                    *action = Some(HomeAction::LaunchSim {
                        sim: spot.sim,
                        preset: None,
                    });
                }
                if draw_ghost_button(ui, "Inspect", with_alpha(spot.accent, 140), 30.0, 12.0, 11.5)
                    .clicked()
                {
                    clicked_button = true;
                    state.inspect_sim = Some(spot.sim);
                }
            });
        });
    });

    if frame_resp.clicked() && !clicked_button {
        *action = Some(HomeAction::LaunchSim {
            sim: spot.sim,
            preset: None,
        });
    }

    ui.add_space(10.0);

    // 7-engine spotlight selector pills
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = Vec2::new(5.0, 5.0);
        for entry in &CATALOG {
            let is_active = entry.sim == state.spotlight;
            let font = FontId::new(10.5, semibold_family());
            let fg = if is_active { TEXT_PRIMARY } else { TEXT_SECONDARY };
            let g = ui.painter().layout_job(tracked_job(
                entry.sim.switch_label(),
                font.clone(),
                fg,
                0.1,
            ));
            let w = 8.0 * 2.0 + 10.0 + g.size().x;
            let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 26.0), Sense::click());
            if resp.hovered() {
                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
            }
            let (fill, border, text_c) = if is_active {
                (
                    with_alpha(entry.accent, 38),
                    with_alpha(entry.accent, 150),
                    entry.accent_bright,
                )
            } else if resp.hovered() {
                (
                    Color32::from_rgba_unmultiplied(255, 255, 255, 16),
                    border_strong(),
                    TEXT_PRIMARY,
                )
            } else {
                (surface_subtle(), border_hairline(), TEXT_SECONDARY)
            };
            ui.painter().rect(
                rect,
                CornerRadius::same(13),
                fill,
                Stroke::new(1.0, border),
                StrokeKind::Inside,
            );
            let cy = rect.center().y;
            ui.painter()
                .circle_filled(Pos2::new(rect.left() + 10.5, cy), 2.8, entry.accent);
            let tg = ui
                .painter()
                .layout_job(tracked_job(entry.sim.switch_label(), font, text_c, 0.1));
            ui.painter().galley(
                Pos2::new(rect.left() + 17.5, cy - tg.size().y * 0.5),
                tg,
                text_c,
            );
            if resp.clicked() {
                state.spotlight = entry.sim;
            }
        }
    });
}

fn draw_flagship_card(
    ui: &mut Ui,
    entry: &CatalogEntry,
    state: &mut HomeState,
    width: f32,
    action: &mut Option<HomeAction>,
) {
    let tex_id = state.previews.get_or_load(ui.ctx(), entry.sim).id();
    let pad = 18.0;
    let gap = 22.0;
    let img_w = ((width - pad * 2.0 - gap) * 0.50).floor();
    let img_h = (img_w * 9.0 / 16.0).round();
    let right_w = width - pad * 2.0 - gap - img_w;

    let bg_slot = ui.painter().add(Shape::Noop);
    let inner = ui.scope(|ui| {
        ui.set_min_width(width);
        ui.set_max_width(width);
        ui.add_space(pad);
        ui.horizontal(|ui| {
            ui.add_space(pad);
            // Left: 16:9 preview image + badges
            let (img_rect, img_resp) =
                ui.allocate_exact_size(Vec2::new(img_w, img_h), Sense::click());
            if img_resp.hovered() {
                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
            }
            ui.scope_builder(egui::UiBuilder::new().max_rect(img_rect), |ui| {
                ui.add(
                    Image::new((tex_id, img_rect.size()))
                        .fit_to_exact_size(img_rect.size())
                        .corner_radius(CornerRadius::same(11)),
                );
            });
            ui.painter().rect_stroke(
                img_rect,
                CornerRadius::same(11),
                Stroke::new(1.0, border_hairline()),
                StrokeKind::Inside,
            );

            let top_overlay = Rect::from_min_max(
                Pos2::new(img_rect.left() + 12.0, img_rect.top() + 12.0),
                Pos2::new(img_rect.right() - 12.0, img_rect.top() + 36.0),
            );
            ui.scope_builder(egui::UiBuilder::new().max_rect(top_overlay), |ui| {
                ui.horizontal(|ui| {
                    let cat_txt = format!("{}  {}", entry.index, entry.category_label);
                    draw_badge_pill(
                        ui,
                        &cat_txt,
                        None,
                        Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                        border_strong(),
                        TEXT_PRIMARY,
                        10.0,
                    );
                    ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                        draw_badge_pill(
                            ui,
                            "FLAGSHIP ENGINE",
                            None,
                            Color32::from_rgba_unmultiplied(16, 14, 10, 220),
                            with_alpha(entry.accent, 140),
                            entry.accent_bright,
                            9.5,
                        );
                    });
                });
            });

            if img_resp.clicked() {
                *action = Some(HomeAction::LaunchSim {
                    sim: entry.sim,
                    preset: None,
                });
            }

            ui.add_space(gap);

            // Right: details, equation, specs, chips, actions
            ui.vertical(|ui| {
                ui.set_min_width(right_w);
                ui.set_max_width(right_w);
                ui.spacing_mut().item_spacing.y = 8.0;

                ui.label(
                    egui::RichText::new(entry.tagline.to_ascii_uppercase())
                        .font(FontId::new(10.0, semibold_family()))
                        .color(entry.accent),
                );
                ui.label(
                    egui::RichText::new(entry.title)
                        .font(FontId::new(20.0, semibold_family()))
                        .color(TEXT_PRIMARY),
                );
                ui.label(wrapped_job(
                    entry.description,
                    FontId::proportional(12.5),
                    TEXT_SECONDARY,
                    right_w,
                ));

                // Equation box
                let eq_w = right_w;
                let (eq_rect, _) = ui.allocate_exact_size(Vec2::new(eq_w, 30.0), Sense::hover());
                ui.painter().rect(
                    eq_rect,
                    CornerRadius::same(8),
                    Color32::from_rgba_unmultiplied(6, 9, 16, 220),
                    Stroke::new(1.0, border_hairline()),
                    StrokeKind::Inside,
                );
                let eq_g = ui.painter().layout_job(tracked_job(
                    entry.equation,
                    FontId::monospace(11.0),
                    TEXT_PRIMARY,
                    0.0,
                ));
                ui.painter().galley(
                    Pos2::new(eq_rect.left() + 10.0, eq_rect.center().y - eq_g.size().y * 0.5),
                    eq_g,
                    TEXT_PRIMARY,
                );

                // 3 Spec cells
                let cell_gap = 8.0;
                let cell_w = ((right_w - cell_gap * 2.0) / 3.0).floor();
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = cell_gap;
                    for (lbl, val) in entry.specs {
                        let (c_rect, _) =
                            ui.allocate_exact_size(Vec2::new(cell_w, 46.0), Sense::hover());
                        ui.painter().rect(
                            c_rect,
                            CornerRadius::same(8),
                            Color32::from_rgba_unmultiplied(255, 255, 255, 7),
                            Stroke::new(1.0, border_hairline()),
                            StrokeKind::Inside,
                        );
                        let l_g = ui.painter().layout_job(tracked_job(
                            &lbl.to_ascii_uppercase(),
                            FontId::new(9.0, semibold_family()),
                            TEXT_MUTED,
                            0.5,
                        ));
                        let v_g = ui.painter().layout_job(tracked_job(
                            val,
                            FontId::new(11.5, semibold_family()),
                            TEXT_PRIMARY,
                            0.0,
                        ));
                        ui.painter().galley(
                            Pos2::new(c_rect.left() + 10.0, c_rect.top() + 8.0),
                            l_g,
                            TEXT_MUTED,
                        );
                        ui.painter().galley(
                            Pos2::new(c_rect.left() + 10.0, c_rect.top() + 23.0),
                            v_g,
                            TEXT_PRIMARY,
                        );
                    }
                });

                // 3 Physics chips
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(6.0, 6.0);
                    for chip in entry.highlights {
                        draw_badge_pill(
                            ui,
                            chip,
                            None,
                            Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                            border_hairline(),
                            TEXT_SECONDARY,
                            10.0,
                        );
                    }
                });

                ui.add_space(2.0);
                ui.horizontal(|ui| {
                    if draw_ghost_button(ui, "Details", with_alpha(entry.accent, 140), 32.0, 14.0, 12.0)
                        .clicked()
                    {
                        state.inspect_sim = Some(entry.sim);
                    }
                    ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                        if draw_accent_button(
                            ui,
                            "Launch ->",
                            entry.accent,
                            entry.accent_bright,
                            32.0,
                            16.0,
                            12.0,
                        )
                        .clicked()
                        {
                            *action = Some(HomeAction::LaunchSim {
                                sim: entry.sim,
                                preset: None,
                            });
                        }
                    });
                });
            });
            ui.add_space(pad);
        });
        ui.add_space(pad);
    });

    ui.painter().set(
        bg_slot,
        Shape::Rect(egui::epaint::RectShape::new(
            inner.response.rect,
            CornerRadius::same(14),
            surface_card(),
            Stroke::new(1.0, border_hairline()),
            StrokeKind::Inside,
        )),
    );
}

fn draw_engine_card(
    ui: &mut Ui,
    entry: &CatalogEntry,
    state: &mut HomeState,
    width: f32,
    min_height: f32,
    action: &mut Option<HomeAction>,
) {
    let tex_id = state.previews.get_or_load(ui.ctx(), entry.sim).id();
    let pad = 14.0;
    let inner_w = width - pad * 2.0;
    let img_h = (inner_w * 9.0 / 16.0).round();

    let bg_slot = ui.painter().add(Shape::Noop);
    let inner = ui.scope(|ui| {
        ui.set_min_width(width);
        ui.set_max_width(width);
        ui.set_min_height(min_height);
        ui.add_space(pad);
        ui.horizontal(|ui| {
            ui.add_space(pad);
            ui.vertical(|ui| {
                ui.set_min_width(inner_w);
                ui.set_max_width(inner_w);
                ui.spacing_mut().item_spacing.y = 8.0;

                // 16:9 Preview thumbnail
                let (img_rect, img_resp) =
                    ui.allocate_exact_size(Vec2::new(inner_w, img_h), Sense::click());
                if img_resp.hovered() {
                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                }
                ui.scope_builder(egui::UiBuilder::new().max_rect(img_rect), |ui| {
                    ui.add(
                        Image::new((tex_id, img_rect.size()))
                            .fit_to_exact_size(img_rect.size())
                            .corner_radius(CornerRadius::same(10)),
                    );
                });
                ui.painter().rect_stroke(
                    img_rect,
                    CornerRadius::same(10),
                    Stroke::new(1.0, border_hairline()),
                    StrokeKind::Inside,
                );
                let ov_rect = Rect::from_min_max(
                    Pos2::new(img_rect.left() + 10.0, img_rect.top() + 10.0),
                    Pos2::new(img_rect.right() - 10.0, img_rect.top() + 34.0),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(ov_rect), |ui| {
                    let cat_txt = format!("{}  {}", entry.index, entry.category_label);
                    draw_badge_pill(
                        ui,
                        &cat_txt,
                        None,
                        Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                        border_strong(),
                        TEXT_PRIMARY,
                        10.0,
                    );
                });
                if img_resp.clicked() {
                    *action = Some(HomeAction::LaunchSim {
                        sim: entry.sim,
                        preset: None,
                    });
                }

                ui.label(
                    egui::RichText::new(entry.tagline.to_ascii_uppercase())
                        .font(FontId::new(9.5, semibold_family()))
                        .color(entry.accent),
                );
                ui.label(
                    egui::RichText::new(entry.title)
                        .font(FontId::new(15.5, semibold_family()))
                        .color(TEXT_PRIMARY),
                );
                ui.label(wrapped_job(
                    entry.description,
                    FontId::proportional(12.0),
                    TEXT_SECONDARY,
                    inner_w,
                ));

                // Monospace equation bar
                let (eq_rect, _) = ui.allocate_exact_size(Vec2::new(inner_w, 28.0), Sense::hover());
                ui.painter().rect(
                    eq_rect,
                    CornerRadius::same(7),
                    Color32::from_rgba_unmultiplied(6, 9, 16, 220),
                    Stroke::new(1.0, border_hairline()),
                    StrokeKind::Inside,
                );
                let mut eq_job = tracked_job(
                    entry.equation,
                    FontId::monospace(10.2),
                    TEXT_PRIMARY,
                    0.0,
                );
                eq_job.wrap.max_width = (inner_w - 18.0).max(40.0);
                eq_job.wrap.max_rows = 1;
                let eq_g = ui.painter().layout_job(eq_job);
                ui.painter().galley(
                    Pos2::new(eq_rect.left() + 9.0, eq_rect.center().y - eq_g.size().y * 0.5),
                    eq_g,
                    TEXT_PRIMARY,
                );

                // 3 Highlight chips
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(5.0, 5.0);
                    for chip in entry.highlights {
                        draw_badge_pill(
                            ui,
                            chip,
                            None,
                            Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                            border_hairline(),
                            TEXT_SECONDARY,
                            9.8,
                        );
                    }
                });

                ui.add_space(2.0);
                ui.horizontal(|ui| {
                    if draw_ghost_button(ui, "Details", with_alpha(entry.accent, 140), 30.0, 12.0, 11.5)
                        .clicked()
                    {
                        state.inspect_sim = Some(entry.sim);
                    }
                    ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                        if draw_accent_button(
                            ui,
                            "Launch ->",
                            entry.accent,
                            entry.accent_bright,
                            30.0,
                            14.0,
                            11.5,
                        )
                        .clicked()
                        {
                            *action = Some(HomeAction::LaunchSim {
                                sim: entry.sim,
                                preset: None,
                            });
                        }
                    });
                });
            });
            ui.add_space(pad);
        });
        ui.add_space(pad);
    });

    ui.painter().set(
        bg_slot,
        Shape::Rect(egui::epaint::RectShape::new(
            inner.response.rect,
            CornerRadius::same(14),
            surface_card(),
            Stroke::new(1.0, border_hairline()),
            StrokeKind::Inside,
        )),
    );
}

fn draw_controls_section(ui: &mut Ui, width: f32) {
    ui.label(
        egui::RichText::new("UNIVERSAL CONTROLS")
            .font(FontId::new(10.5, semibold_family()))
            .color(Color32::from_rgb(0xf0, 0xb3, 0x5a)),
    );
    ui.add_space(4.0);
    ui.label(
        egui::RichText::new("Consistent Flight & Capture Keys")
            .font(FontId::new(22.0, semibold_family()))
            .color(TEXT_PRIMARY),
    );
    ui.add_space(4.0);
    ui.label(wrapped_job(
        "Every native simulator shares the same Observatory Glass HUD, camera flight bindings, and 128-sample cinema still capture.",
        FontId::proportional(13.0),
        TEXT_SECONDARY,
        width.min(620.0),
    ));
    ui.add_space(14.0);

    let items: [(&str, &str); 9] = [
        ("Drag", "Orbit / Look"),
        ("Scroll / W S", "Zoom / Fly"),
        ("1 – 6", "Physics Presets"),
        ("Space", "128× Cinema Still"),
        ("O", "Auto-Orbit"),
        ("T", "Traverse / Bridge / Aft"),
        ("C", "Controls Drawer"),
        ("P", "PNG Screenshot"),
        ("H", "Hide / Restore HUD"),
    ];

    let cols = if width >= 820.0 {
        3
    } else if width >= 540.0 {
        2
    } else {
        1
    };
    let gap = 10.0;
    let cell_w = ((width - gap * (cols as f32 - 1.0)) / cols as f32).floor();

    for row in items.chunks(cols) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = gap;
            for (key_txt, desc) in row {
                let (rect, _) = ui.allocate_exact_size(Vec2::new(cell_w, 42.0), Sense::hover());
                ui.painter().rect(
                    rect,
                    CornerRadius::same(10),
                    surface_card(),
                    Stroke::new(1.0, border_hairline()),
                    StrokeKind::Inside,
                );
                let kg = ui.painter().layout_job(tracked_job(
                    key_txt,
                    FontId::monospace(10.8),
                    TEXT_PRIMARY,
                    0.0,
                ));
                let k_rect = Rect::from_min_size(
                    Pos2::new(rect.left() + 12.0, rect.center().y - 11.0),
                    Vec2::new(kg.size().x + 14.0, 22.0),
                );
                ui.painter().rect(
                    k_rect,
                    CornerRadius::same(6),
                    Color32::from_rgba_unmultiplied(255, 255, 255, 14),
                    Stroke::new(1.0, border_strong()),
                    StrokeKind::Inside,
                );
                ui.painter().galley(
                    Pos2::new(
                        k_rect.center().x - kg.size().x * 0.5,
                        k_rect.center().y - kg.size().y * 0.5,
                    ),
                    kg,
                    TEXT_PRIMARY,
                );

                let dg = ui.painter().layout_job(tracked_job(
                    desc,
                    FontId::proportional(12.0),
                    TEXT_SECONDARY,
                    0.0,
                ));
                ui.painter().galley(
                    Pos2::new(
                        (rect.right() - 14.0 - dg.size().x).max(k_rect.right() + 10.0),
                        rect.center().y - dg.size().y * 0.5,
                    ),
                    dg,
                    TEXT_SECONDARY,
                );
            }
        });
        ui.add_space(8.0);
    }
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
    let mut close_modal = ctx.input(|i| i.key_pressed(Key::Escape));

    // Full-screen input-blocking dimmed backdrop
    Area::new(Id::unique("home_dossier_backdrop"))
        .fixed_pos(screen.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let (_, bg_resp) = ui.allocate_exact_size(screen.size(), Sense::click());
            ui.painter().rect_filled(
                screen,
                CornerRadius::ZERO,
                Color32::from_rgba_unmultiplied(2, 4, 9, 204),
            );
            if bg_resp.clicked() {
                close_modal = true;
            }
        });

    let modal_w = (screen.width() - 48.0).clamp(320.0, 740.0);
    let modal_h = (screen.height() - 36.0).clamp(360.0, 680.0);
    let banner_h = (modal_w * 0.29).clamp(155.0, 208.0);
    let footer_h = 54.0;
    let body_h = (modal_h - banner_h - footer_h).max(160.0);
    let tex_id = state.previews.get_or_load(ctx, entry.sim).id();

    Area::new(Id::unique("home_dossier_modal"))
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .order(Order::Tooltip)
        .fade_in(false)
        .show(ctx, |ui| {
            let modal_slot = ui.painter().add(Shape::Noop);
            let modal = ui.scope(|ui| {
                ui.set_min_width(modal_w);
                ui.set_max_width(modal_w);
                ui.set_max_height(modal_h);

                // Top preview banner
                let (banner_rect, _) =
                    ui.allocate_exact_size(Vec2::new(modal_w, banner_h), Sense::hover());
                ui.scope_builder(egui::UiBuilder::new().max_rect(banner_rect), |ui| {
                    ui.add(
                        Image::new((tex_id, banner_rect.size()))
                            .fit_to_exact_size(banner_rect.size())
                            .corner_radius(CornerRadius {
                                nw: 14,
                                ne: 14,
                                sw: 0,
                                se: 0,
                            }),
                    );
                });
                let scrim = Rect::from_min_max(
                    Pos2::new(banner_rect.left(), banner_rect.bottom() - 88.0),
                    banner_rect.max,
                );
                ui.painter().rect_filled(
                    scrim,
                    CornerRadius::ZERO,
                    Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                );

                // Top overlay bar inside banner: Category pill + Close X button
                let top_ov = Rect::from_min_max(
                    Pos2::new(banner_rect.left() + 18.0, banner_rect.top() + 14.0),
                    Pos2::new(banner_rect.right() - 18.0, banner_rect.top() + 44.0),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(top_ov), |ui| {
                    ui.horizontal(|ui| {
                        let cat_txt = format!("{}  ·  {}", entry.index, entry.category_label);
                        draw_badge_pill(
                            ui,
                            &cat_txt,
                            Some(entry.accent),
                            Color32::from_rgba_unmultiplied(7, 10, 18, 215),
                            border_strong(),
                            TEXT_PRIMARY,
                            10.5,
                        );
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            let (x_rect, x_resp) =
                                ui.allocate_exact_size(Vec2::new(30.0, 30.0), Sense::click());
                            if x_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().rect(
                                x_rect,
                                CornerRadius::same(15),
                                Color32::from_rgba_unmultiplied(7, 10, 18, 220),
                                Stroke::new(
                                    1.0,
                                    if x_resp.hovered() {
                                        entry.accent_bright
                                    } else {
                                        border_strong()
                                    },
                                ),
                                StrokeKind::Inside,
                            );
                            draw_close_icon(
                                ui.painter(),
                                x_rect.center(),
                                if x_resp.hovered() {
                                    TEXT_PRIMARY
                                } else {
                                    TEXT_SECONDARY
                                },
                            );
                            if x_resp.clicked() {
                                close_modal = true;
                            }
                        });
                    });
                });

                // Banner title overlay
                let title_ov = Rect::from_min_max(
                    Pos2::new(banner_rect.left() + 20.0, banner_rect.bottom() - 62.0),
                    Pos2::new(banner_rect.right() - 20.0, banner_rect.bottom() - 10.0),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(title_ov), |ui| {
                    ui.spacing_mut().item_spacing.y = 3.0;
                    ui.label(
                        egui::RichText::new(entry.tagline.to_ascii_uppercase())
                            .font(FontId::new(10.0, semibold_family()))
                            .color(entry.accent),
                    );
                    ui.label(
                        egui::RichText::new(entry.title)
                            .font(FontId::new(20.0, semibold_family()))
                            .color(TEXT_PRIMARY),
                    );
                });

                // Scrollable body
                let pad = 20.0;
                let inner_w = modal_w - pad * 2.0 - 8.0;
                ScrollArea::vertical()
                    .id_salt(("dossier_scroll", entry.sim))
                    .max_height(body_h)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.add_space(12.0);
                        ui.horizontal(|ui| {
                            ui.add_space(pad);
                            ui.vertical(|ui| {
                                ui.set_min_width(inner_w);
                                ui.set_max_width(inner_w);
                                ui.spacing_mut().item_spacing.y = 10.0;

                                ui.label(wrapped_job(
                                    entry.description,
                                    FontId::proportional(12.8),
                                    TEXT_SECONDARY,
                                    inner_w,
                                ));

                                // Metric & equation strip
                                let (eq_r, _) = ui
                                    .allocate_exact_size(Vec2::new(inner_w, 34.0), Sense::hover());
                                ui.painter().rect(
                                    eq_r,
                                    CornerRadius::same(8),
                                    Color32::from_rgba_unmultiplied(6, 9, 16, 225),
                                    Stroke::new(1.0, border_hairline()),
                                    StrokeKind::Inside,
                                );
                                let mg = ui.painter().layout_job(tracked_job(
                                    entry.metric_name,
                                    FontId::new(11.5, semibold_family()),
                                    entry.accent_bright,
                                    0.1,
                                ));
                                let eg = ui.painter().layout_job(tracked_job(
                                    entry.equation,
                                    FontId::monospace(10.8),
                                    TEXT_PRIMARY,
                                    0.0,
                                ));
                                ui.painter().galley(
                                    Pos2::new(eq_r.left() + 12.0, eq_r.center().y - mg.size().y * 0.5),
                                    mg,
                                    entry.accent_bright,
                                );
                                ui.painter().galley(
                                    Pos2::new(
                                        (eq_r.right() - 12.0 - eg.size().x).max(eq_r.left() + 190.0),
                                        eq_r.center().y - eg.size().y * 0.5,
                                    ),
                                    eg,
                                    TEXT_PRIMARY,
                                );

                                // 3 Spec cells
                                let gap = 8.0;
                                let sw = ((inner_w - gap * 2.0) / 3.0).floor();
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = gap;
                                    for (lbl, val) in entry.specs {
                                        let (sr, _) = ui.allocate_exact_size(
                                            Vec2::new(sw, 46.0),
                                            Sense::hover(),
                                        );
                                        ui.painter().rect(
                                            sr,
                                            CornerRadius::same(8),
                                            surface_subtle(),
                                            Stroke::new(1.0, border_hairline()),
                                            StrokeKind::Inside,
                                        );
                                        let lg = ui.painter().layout_job(tracked_job(
                                            &lbl.to_ascii_uppercase(),
                                            FontId::new(9.0, semibold_family()),
                                            TEXT_MUTED,
                                            0.5,
                                        ));
                                        let vg = ui.painter().layout_job(tracked_job(
                                            val,
                                            FontId::new(11.5, semibold_family()),
                                            TEXT_PRIMARY,
                                            0.0,
                                        ));
                                        ui.painter().galley(
                                            Pos2::new(sr.left() + 10.0, sr.top() + 8.0),
                                            lg,
                                            TEXT_MUTED,
                                        );
                                        ui.painter().galley(
                                            Pos2::new(sr.left() + 10.0, sr.top() + 23.0),
                                            vg,
                                            TEXT_PRIMARY,
                                        );
                                    }
                                });

                                ui.label(
                                    egui::RichText::new("CURATED PHYSICS PRESETS (CLICK TO LAUNCH)")
                                        .font(FontId::new(10.0, semibold_family()))
                                        .color(TEXT_MUTED),
                                );

                                // 6 Clickable preset cards in 2 columns
                                let p_gap = 8.0;
                                let p_w = ((inner_w - p_gap) * 0.5).floor();
                                for pair in entry.presets.iter().enumerate().collect::<Vec<_>>().chunks(2) {
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = p_gap;
                                        for (p_idx, (p_name, p_desc)) in pair {
                                            let p_slot = ui.painter().add(Shape::Noop);
                                            let (p_rect, p_resp) = ui.allocate_exact_size(
                                                Vec2::new(p_w, 66.0),
                                                Sense::click(),
                                            );
                                            if p_resp.hovered() {
                                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                            }
                                            ui.painter().set(
                                                p_slot,
                                                Shape::Rect(egui::epaint::RectShape::new(
                                                    p_rect,
                                                    CornerRadius::same(9),
                                                    if p_resp.hovered() {
                                                        with_alpha(entry.accent, 22)
                                                    } else {
                                                        surface_subtle()
                                                    },
                                                    Stroke::new(
                                                        1.0,
                                                        if p_resp.hovered() {
                                                            with_alpha(entry.accent, 140)
                                                        } else {
                                                            border_hairline()
                                                        },
                                                    ),
                                                    StrokeKind::Inside,
                                                )),
                                            );

                                            let k_rect = Rect::from_min_size(
                                                Pos2::new(p_rect.left() + 10.0, p_rect.top() + 10.0),
                                                Vec2::new(18.0, 18.0),
                                            );
                                            ui.painter().rect(
                                                k_rect,
                                                CornerRadius::same(4),
                                                with_alpha(entry.accent, 26),
                                                Stroke::new(1.0, with_alpha(entry.accent, 110)),
                                                StrokeKind::Inside,
                                            );
                                            let k_str = format!("{}", p_idx + 1);
                                            let kg = ui.painter().layout_job(tracked_job(
                                                &k_str,
                                                FontId::monospace(10.0),
                                                entry.accent_bright,
                                                0.0,
                                            ));
                                            ui.painter().galley(
                                                Pos2::new(
                                                    k_rect.center().x - kg.size().x * 0.5,
                                                    k_rect.center().y - kg.size().y * 0.5,
                                                ),
                                                kg,
                                                entry.accent_bright,
                                            );

                                            let ng = ui.painter().layout_job(tracked_job(
                                                p_name,
                                                FontId::new(12.0, semibold_family()),
                                                TEXT_PRIMARY,
                                                0.0,
                                            ));
                                            ui.painter().galley(
                                                Pos2::new(k_rect.right() + 8.0, k_rect.top() + 1.0),
                                                ng,
                                                TEXT_PRIMARY,
                                            );

                                            let dg = ui.painter().layout_job(wrapped_job(
                                                p_desc,
                                                FontId::proportional(10.8),
                                                TEXT_SECONDARY,
                                                p_w - 44.0,
                                            ));
                                            ui.painter().galley(
                                                Pos2::new(k_rect.right() + 8.0, k_rect.top() + 20.0),
                                                dg,
                                                TEXT_SECONDARY,
                                            );

                                            if p_resp.clicked() {
                                                *action = Some(HomeAction::LaunchSim {
                                                    sim: entry.sim,
                                                    preset: Some(*p_idx),
                                                });
                                                close_modal = true;
                                            }
                                        }
                                    });
                                }

                                // Special control note
                                let note_txt = format!("Special Control: {}", entry.special_control);
                                ui.label(
                                    egui::RichText::new(note_txt)
                                        .font(FontId::proportional(11.5))
                                        .color(entry.accent_bright),
                                );
                                ui.add_space(6.0);
                            });
                            ui.add_space(pad);
                        });
                    });

                // Modal footer bar
                let (f_rect, _) =
                    ui.allocate_exact_size(Vec2::new(modal_w, footer_h), Sense::hover());
                ui.painter().line_segment(
                    [f_rect.left_top(), f_rect.right_top()],
                    Stroke::new(1.0, border_hairline()),
                );
                let f_inner = Rect::from_min_max(
                    Pos2::new(f_rect.left() + 20.0, f_rect.top()),
                    Pos2::new(f_rect.right() - 20.0, f_rect.bottom()),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(f_inner), |ui| {
                    ui.horizontal_centered(|ui| {
                        let cli_hint = format!("./desktop/run.sh --sim {}", entry.sim.cli_name());
                        ui.label(
                            egui::RichText::new(cli_hint)
                                .font(FontId::monospace(11.0))
                                .color(TEXT_MUTED),
                        );
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;
                            if draw_accent_button(
                                ui,
                                "Launch Simulator ->",
                                entry.accent,
                                entry.accent_bright,
                                32.0,
                                16.0,
                                12.0,
                            )
                            .clicked()
                            {
                                *action = Some(HomeAction::LaunchSim {
                                    sim: entry.sim,
                                    preset: None,
                                });
                                close_modal = true;
                            }
                            if draw_ghost_button(ui, "Close", border_strong(), 32.0, 14.0, 12.0)
                                .clicked()
                            {
                                close_modal = true;
                            }
                        });
                    });
                });
            });

            ui.painter().set(
                modal_slot,
                Shape::Rect(egui::epaint::RectShape::new(
                    modal.response.rect,
                    CornerRadius::same(14),
                    Color32::from_rgb(10, 14, 24),
                    Stroke::new(1.0, with_alpha(entry.accent, 110)),
                    StrokeKind::Outside,
                )),
            );
        });

    if close_modal {
        state.inspect_sim = None;
    }
}

pub fn draw_homepage(
    ctx: &Context,
    state: &mut HomeState,
    adapter_label: &str,
) -> Option<HomeAction> {
    let screen = ctx.input(|i| i.content_rect());
    let spot = catalog_entry(state.spotlight);
    draw_observatory_backdrop(ctx, screen, spot.accent);
    draw_top_bar(ctx, screen, state, spot, adapter_label);

    let mut action: Option<HomeAction> = None;

    let body_rect = Rect::from_min_max(
        Pos2::new(screen.left(), screen.top() + 54.0),
        screen.max,
    );

    Area::new(Id::unique("home_scroll_area"))
        .fixed_pos(body_rect.min)
        .order(Order::Middle)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.set_min_size(body_rect.size());
            ui.set_max_size(body_rect.size());

            ScrollArea::vertical()
                .id_salt("home_main_scroll")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    let side_pad = ((screen.width() - 1140.0) * 0.5).max(20.0);
                    let content_w = (screen.width() - side_pad * 2.0).max(320.0);

                    ui.horizontal(|ui| {
                        ui.add_space(side_pad);
                        ui.vertical(|ui| {
                            ui.set_min_width(content_w);
                            ui.set_max_width(content_w);

                            ui.add_space(28.0);

                            // ============================================================
                            // HERO SHOWCASE
                            // ============================================================
                            if content_w >= 880.0 {
                                let gap = 28.0;
                                let left_w = ((content_w - gap) * 0.42).floor();
                                let right_w = content_w - gap - left_w;
                                ui.horizontal(|ui| {
                                    ui.vertical(|ui| {
                                        ui.set_min_width(left_w);
                                        ui.set_max_width(left_w);
                                        draw_hero_left(ui, state, spot, left_w, &mut action);
                                    });
                                    ui.add_space(gap);
                                    ui.vertical(|ui| {
                                        ui.set_min_width(right_w);
                                        ui.set_max_width(right_w);
                                        draw_hero_viewport(ui, state, spot, right_w, &mut action);
                                    });
                                });
                            } else {
                                draw_hero_left(ui, state, spot, content_w, &mut action);
                                ui.add_space(20.0);
                                draw_hero_viewport(ui, state, spot, content_w, &mut action);
                            }

                            ui.add_space(38.0);

                            // ============================================================
                            // THE 7 SPACETIME ENGINES CATALOG
                            // ============================================================
                            let catalog_top_resp = ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.set_max_width((content_w * 0.62).max(280.0));
                                    ui.label(
                                        egui::RichText::new("OBSERVATORY CATALOG")
                                            .font(FontId::new(10.5, semibold_family()))
                                            .color(Color32::from_rgb(0xf0, 0xb3, 0x5a)),
                                    );
                                    ui.add_space(3.0);
                                    ui.label(
                                        egui::RichText::new("The 7 Spacetime Engines")
                                            .font(FontId::new(24.0, semibold_family()))
                                            .color(TEXT_PRIMARY),
                                    );
                                    ui.add_space(3.0);
                                    ui.label(wrapped_job(
                                        "Every engine runs natively on your GPU via wgpu with identical WGSL physics, a 4K NASA Milky Way sky, and 6 curated presets.",
                                        FontId::proportional(13.0),
                                        TEXT_SECONDARY,
                                        (content_w * 0.62).max(280.0),
                                    ));
                                });
                            });
                            if state.scroll_to_catalog {
                                catalog_top_resp.response.scroll_to_me(Some(Align::TOP));
                                state.scroll_to_catalog = false;
                            }

                            ui.add_space(12.0);
                            // Category filter bar
                            ui.horizontal_wrapped(|ui| {
                                ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
                                for cat in CategoryFilter::ALL {
                                    let is_act = state.category == cat;
                                    let txt = format!("{}  ({})", cat.label(), cat.count());
                                    let font = FontId::new(11.5, semibold_family());
                                    let fg = if is_act {
                                        Color32::from_rgb(0xf7, 0xca, 0x82)
                                    } else {
                                        TEXT_SECONDARY
                                    };
                                    let g = ui.painter().layout_job(tracked_job(&txt, font.clone(), fg, 0.15));
                                    let w = 24.0 + g.size().x;
                                    let (rect, resp) =
                                        ui.allocate_exact_size(Vec2::new(w, 30.0), Sense::click());
                                    if resp.hovered() {
                                        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                    }
                                    let (fill, border) = if is_act {
                                        (
                                            Color32::from_rgba_unmultiplied(240, 179, 90, 38),
                                            Color32::from_rgba_unmultiplied(240, 179, 90, 145),
                                        )
                                    } else if resp.hovered() {
                                        (
                                            Color32::from_rgba_unmultiplied(255, 255, 255, 16),
                                            border_strong(),
                                        )
                                    } else {
                                        (surface_subtle(), border_hairline())
                                    };
                                    ui.painter().rect(
                                        rect,
                                        CornerRadius::same(15),
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
                                    if resp.clicked() {
                                        state.category = cat;
                                    }
                                }
                            });

                            ui.add_space(16.0);

                            let filtered: Vec<&CatalogEntry> = CATALOG
                                .iter()
                                .filter(|e| {
                                    state.category == CategoryFilter::All
                                        || e.category == state.category
                                })
                                .collect();

                            let rest: &[&CatalogEntry] =
                                if state.category == CategoryFilter::All && content_w >= 880.0 {
                                    draw_flagship_card(ui, filtered[0], state, content_w, &mut action);
                                    ui.add_space(16.0);
                                    &filtered[1..]
                                } else {
                                    &filtered[..]
                                };

                            let cols = if content_w >= 960.0 {
                                3
                            } else if content_w >= 620.0 {
                                2
                            } else {
                                1
                            };
                            let grid_gap = 16.0;
                            let card_w =
                                ((content_w - grid_gap * (cols as f32 - 1.0)) / cols as f32).floor();

                            for row in rest.chunks(cols) {
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = grid_gap;
                                    for entry in row {
                                        ui.vertical(|ui| {
                                            draw_engine_card(
                                                ui,
                                                entry,
                                                state,
                                                card_w,
                                                428.0,
                                                &mut action,
                                            );
                                        });
                                    }
                                });
                                ui.add_space(16.0);
                            }

                            ui.add_space(20.0);
                            draw_controls_section(ui, content_w);

                            // Footer
                            ui.add_space(22.0);
                            let (f_div, _) =
                                ui.allocate_exact_size(Vec2::new(content_w, 1.0), Sense::hover());
                            ui.painter().line_segment(
                                [f_div.left_center(), f_div.right_center()],
                                Stroke::new(1.0, border_hairline()),
                            );
                            ui.add_space(14.0);
                            ui.horizontal_wrapped(|ui| {
                                ui.spacing_mut().item_spacing = Vec2::new(10.0, 8.0);
                                ui.label(
                                    egui::RichText::new("INTERSTELLAR OBSERVATORY")
                                        .font(FontId::new(11.0, semibold_family()))
                                        .color(TEXT_PRIMARY),
                                );
                                draw_badge_pill(
                                    ui,
                                    "Native Desktop · 0% Idle GPU",
                                    Some(Color32::from_rgb(0x34, 0xd3, 0x99)),
                                    Color32::from_rgba_unmultiplied(16, 42, 34, 180),
                                    Color32::from_rgba_unmultiplied(52, 211, 153, 110),
                                    Color32::from_rgb(0x6e, 0xe7, 0xb7),
                                    10.0,
                                );
                                for entry in &CATALOG {
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                egui::RichText::new(entry.sim.switch_label())
                                                    .size(11.5)
                                                    .color(TEXT_SECONDARY),
                                            )
                                            .frame(false),
                                        )
                                        .on_hover_cursor(CursorIcon::PointingHand)
                                        .clicked()
                                    {
                                        action = Some(HomeAction::LaunchSim {
                                            sim: entry.sim,
                                            preset: None,
                                        });
                                    }
                                }
                            });
                            ui.add_space(28.0);
                        });
                        ui.add_space(side_pad);
                    });
                });
        });

    if state.inspect_sim.is_some() {
        draw_dossier_modal(ctx, screen, state, &mut action);
    }

    action
}

fn draw_hero_left(
    ui: &mut Ui,
    state: &mut HomeState,
    spot: &CatalogEntry,
    width: f32,
    action: &mut Option<HomeAction>,
) {
    draw_badge_pill(
        ui,
        "RELATIVISTIC GPU RAY-TRACING SUITE",
        Some(spot.accent),
        with_alpha(spot.accent, 24),
        with_alpha(spot.accent, 110),
        spot.accent_bright,
        10.0,
    );
    ui.add_space(14.0);

    // Split display title: "Explore Curved " + accent "Spacetime."
    let mut h1 = LayoutJob::default();
    h1.wrap.max_width = width;
    h1.append(
        "Explore Curved\n",
        0.0,
        TextFormat {
            font_id: FontId::new(38.0, semibold_family()),
            color: TEXT_PRIMARY,
            ..Default::default()
        },
    );
    h1.append(
        "Spacetime.",
        0.0,
        TextFormat {
            font_id: FontId::new(38.0, semibold_family()),
            color: spot.accent_bright,
            ..Default::default()
        },
    );
    ui.label(h1);
    ui.add_space(10.0);

    ui.label(wrapped_job(
        "Exact null geodesic integration, volumetric radiative transfer, and Special Relativistic optics across seven interactive spacetime engines — running natively on your GPU.",
        FontId::proportional(13.5),
        TEXT_SECONDARY,
        width,
    ));
    ui.add_space(18.0);

    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = Vec2::new(10.0, 8.0);
        let launch_lbl = format!("Launch {}  ->", spot.short_title);
        if draw_accent_button(ui, &launch_lbl, spot.accent, spot.accent_bright, 38.0, 20.0, 12.5)
            .clicked()
        {
            *action = Some(HomeAction::LaunchSim {
                sim: spot.sim,
                preset: None,
            });
        }
        if draw_ghost_button(ui, "Inspect Dossier", with_alpha(spot.accent, 140), 38.0, 18.0, 12.5)
            .clicked()
        {
            state.inspect_sim = Some(spot.sim);
        }
    });

    ui.add_space(22.0);
    let (div_r, _) = ui.allocate_exact_size(Vec2::new(width, 1.0), Sense::hover());
    ui.painter().line_segment(
        [div_r.left_center(), div_r.right_center()],
        Stroke::new(1.0, border_hairline()),
    );
    ui.add_space(12.0);

    let stats = [
        ("7", "Spacetime Engines"),
        ("42", "Physics Presets"),
        ("Native wgpu", "Hardware GPU"),
        ("0%", "Idle Homepage GPU"),
    ];
    let stat_gap = 12.0;
    let stat_w = ((width - stat_gap * 3.0) / 4.0).floor().max(72.0);
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = Vec2::new(stat_gap, 10.0);
        for (val, lbl) in stats {
            ui.vertical(|ui| {
                ui.set_min_width(stat_w);
                ui.label(
                    egui::RichText::new(val)
                        .font(FontId::new(14.5, semibold_family()))
                        .color(TEXT_PRIMARY),
                );
                ui.label(
                    egui::RichText::new(lbl)
                        .font(FontId::proportional(11.0))
                        .color(TEXT_MUTED),
                );
            });
        }
    });
}
