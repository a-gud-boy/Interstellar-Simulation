mod cards;
mod dossier;

use egui::epaint::{CornerRadius, Mesh};
use egui::text::LayoutJob;
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Key, Margin, Order, Painter, Pos2, Rect,
    Sense, Shape, Stroke, StrokeKind, TextFormat, Ui, Vec2,
};

use crate::assets::previews::PreviewTextureCache;
use crate::sims::SimId;
use crate::sims::registry::{SIM_REGISTRY, SimCategory, SimRegistryEntry};
use crate::ui::theme::{semibold_family, tracked_job, with_alpha};

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

const fn category_from_registry(cat: SimCategory) -> CategoryFilter {
    match cat {
        SimCategory::GeneralRelativity => CategoryFilter::GeneralRelativity,
        SimCategory::ExoticMetrics => CategoryFilter::ExoticMetrics,
        SimCategory::Astrophysics => CategoryFilter::Astrophysics,
        SimCategory::SpecialRelativity => CategoryFilter::SpecialRelativity,
    }
}

const fn entry_from_registry(r: &SimRegistryEntry) -> CatalogEntry {
    CatalogEntry {
        sim: r.id,
        index: r.index,
        category: category_from_registry(r.category),
        category_label: r.category_label,
        title: r.title,
        short_title: r.short_title,
        tagline: r.tagline,
        description: r.description,
        equation: r.equation,
        metric_name: r.metric_name,
        accent: Color32::from_rgb(r.accent_rgb[0], r.accent_rgb[1], r.accent_rgb[2]),
        accent_bright: Color32::from_rgb(
            r.accent_bright_rgb[0],
            r.accent_bright_rgb[1],
            r.accent_bright_rgb[2],
        ),
        special_control: r.special_control,
        highlights: r.highlights,
        specs: r.specs,
        presets: r.presets,
    }
}

pub const CATALOG: [CatalogEntry; 7] = [
    entry_from_registry(&SIM_REGISTRY[0]),
    entry_from_registry(&SIM_REGISTRY[1]),
    entry_from_registry(&SIM_REGISTRY[2]),
    entry_from_registry(&SIM_REGISTRY[3]),
    entry_from_registry(&SIM_REGISTRY[4]),
    entry_from_registry(&SIM_REGISTRY[5]),
    entry_from_registry(&SIM_REGISTRY[6]),
];

pub fn catalog_entry(id: SimId) -> &'static CatalogEntry {
    CATALOG.iter().find(|e| e.sim == id).unwrap_or(&CATALOG[0])
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

pub(super) const BG_VOID: Color32 = Color32::from_rgb(0x03, 0x05, 0x0a);
pub(super) const TEXT_PRIMARY: Color32 = Color32::from_rgb(0xf3, 0xf6, 0xfc);
pub(super) const TEXT_SECONDARY: Color32 = Color32::from_rgb(0xa2, 0xb1, 0xc6);
pub(super) const TEXT_MUTED: Color32 = Color32::from_rgb(0x78, 0x87, 0x9e);
pub(super) const EMERALD: Color32 = Color32::from_rgb(0x34, 0xd3, 0x99);
pub(super) const CYAN_GPU: Color32 = Color32::from_rgb(0x38, 0xbd, 0xf8);

#[inline]
pub(super) fn glass_pill() -> Color32 {
    Color32::from_rgba_unmultiplied(7, 10, 18, 178)
}

#[inline]
pub(super) fn glass_card() -> Color32 {
    Color32::from_rgba_unmultiplied(8, 12, 22, 204)
}

#[inline]
pub(super) fn dialog_surface() -> Color32 {
    Color32::from_rgba_unmultiplied(10, 14, 24, 248)
}

#[inline]
pub(super) fn hairline() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 28)
}

#[inline]
pub(super) fn hairline_soft() -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, 16)
}

pub(super) fn paint_horizontal_gradient(painter: &Painter, rect: Rect, stops: &[(f32, Color32)]) {
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

pub(super) fn paint_vertical_gradient(painter: &Painter, rect: Rect, stops: &[(f32, Color32)]) {
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
        Pos2::new(
            screen.center().x + shift_x,
            screen.center().y - (cover_h - screen.height()) * 0.05,
        ),
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

pub(super) fn draw_accent_pill_button(
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

pub(super) fn draw_glass_pill_button(
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
    let bar_rect = Rect::from_min_size(
        Pos2::new(screen.left() + pad_x, screen.top() + 16.0),
        Vec2::new(bar_w, bar_h),
    );

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
                        let (mark_rect, _) =
                            ui.allocate_exact_size(Vec2::new(26.0, 26.0), Sense::hover());
                        draw_brand_mark(
                            ui.painter(),
                            mark_rect.center(),
                            active.accent,
                            active.accent_bright,
                        );

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
                            let sep = ui
                                .allocate_exact_size(Vec2::new(1.0, 14.0), Sense::hover())
                                .0;
                            ui.painter()
                                .rect_filled(sep, CornerRadius::ZERO, hairline());
                            ui.label(tracked_job(
                                "v0.1.3.0 · 7 ENGINES",
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
                            let gpu_g = ui
                                .painter()
                                .layout_job(tracked_job(gpu_label, gpu_font, CYAN_GPU, 0.3));
                            let gpu_w = 24.0 + gpu_g.size().x;
                            let (gpu_rect, _) =
                                ui.allocate_exact_size(Vec2::new(gpu_w, 28.0), Sense::hover());
                            ui.painter().rect(
                                gpu_rect,
                                CornerRadius::same(14),
                                Color32::from_rgba_unmultiplied(56, 189, 248, 28),
                                Stroke::new(
                                    1.0,
                                    Color32::from_rgba_unmultiplied(56, 189, 248, 120),
                                ),
                                StrokeKind::Inside,
                            );
                            ui.painter().circle_filled(
                                Pos2::new(gpu_rect.left() + 10.0, gpu_rect.center().y),
                                3.0,
                                CYAN_GPU,
                            );
                            ui.painter().galley(
                                Pos2::new(
                                    gpu_rect.left() + 16.0,
                                    gpu_rect.center().y - gpu_g.size().y * 0.5,
                                ),
                                gpu_g,
                                CYAN_GPU,
                            );

                            // Controls modal pill
                            if draw_glass_pill_button(ui, "Controls", 28.0, 12.0, 11.5, None)
                                .clicked()
                            {
                                state.controls_open = true;
                            }

                            // Category filter bar sitting nicely in the middle-right area
                            if screen.width() >= 920.0 {
                                ui.add_space(6.0);
                                for cat in CategoryFilter::ALL.iter().rev() {
                                    let is_selected = state.category == *cat;
                                    let fg = if is_selected {
                                        TEXT_PRIMARY
                                    } else {
                                        TEXT_SECONDARY
                                    };
                                    let g = ui.painter().layout_job(tracked_job(
                                        cat.label(),
                                        FontId::new(11.0, semibold_family()),
                                        fg,
                                        0.15,
                                    ));
                                    let pill_w = 18.0 + g.size().x;
                                    let (p_rect, p_resp) = ui.allocate_exact_size(
                                        Vec2::new(pill_w, 28.0),
                                        Sense::click(),
                                    );
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
                                        Pos2::new(
                                            p_rect.center().x - g.size().x * 0.5,
                                            p_rect.center().y - g.size().y * 0.5,
                                        ),
                                        g,
                                        fg,
                                    );
                                    if p_resp.clicked() {
                                        state.category = *cat;
                                        let visible: Vec<&CatalogEntry> = CATALOG
                                            .iter()
                                            .filter(|e| {
                                                *cat == CategoryFilter::All || e.category == *cat
                                            })
                                            .collect();
                                        if let Some(first) = visible.first()
                                            && !visible.iter().any(|e| e.sim == state.spotlight)
                                        {
                                            state.spotlight = first.sim;
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
                ui.painter()
                    .circle_filled(dc, 6.5, with_alpha(entry.accent, 65));
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
            let (specs_rect, _) =
                ui.allocate_exact_size(Vec2::new(specs_w, specs_h), Sense::hover());
            let sp = ui.painter();
            sp.line_segment(
                [
                    Pos2::new(specs_rect.left(), specs_rect.top()),
                    Pos2::new(specs_rect.right(), specs_rect.top()),
                ],
                Stroke::new(1.0, hairline()),
            );
            sp.line_segment(
                [
                    Pos2::new(specs_rect.left(), specs_rect.bottom()),
                    Pos2::new(specs_rect.right(), specs_rect.bottom()),
                ],
                Stroke::new(1.0, hairline()),
            );
            let col_w = specs_w / 3.0;
            for (i, (k, v)) in entry.specs.iter().enumerate() {
                let x0 = specs_rect.left() + col_w * i as f32;
                let pad_l = if i == 0 { 0.0 } else { 12.0 };
                if i > 0 {
                    sp.line_segment(
                        [
                            Pos2::new(x0, specs_rect.top() + 8.0),
                            Pos2::new(x0, specs_rect.bottom() - 8.0),
                        ],
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
                sp.galley(
                    Pos2::new(x0 + pad_l, specs_rect.top() + 7.0),
                    kg,
                    TEXT_MUTED,
                );
                sp.galley(
                    Pos2::new(x0 + pad_l, specs_rect.top() + 22.0),
                    vg,
                    TEXT_PRIMARY,
                );
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

                if draw_glass_pill_button(ui, "Presets & Dossier", 38.0, 16.0, 12.5, None).clicked()
                {
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
    let max_card_w = if screen.width() >= 1400.0 {
        224.0
    } else {
        205.0
    };
    let card_w = ((dock_w - total_gap) / slot_count as f32).clamp(112.0, max_card_w);
    let card_h = (card_w * 9.0 / 16.0).clamp(68.0, 124.0);
    let dock_h = 20.0 + card_h;
    let dock_top_y = (screen.bottom() - 16.0 - dock_h).max(screen.top() + 360.0);

    draw_stage_backdrop(ctx, state, screen, active);
    draw_floating_topbar(ctx, screen, pad_x, state, active);
    draw_mission_brief(ctx, screen, pad_x, dock_top_y, state, active, &mut action);
    cards::draw_filmstrip_dock(
        ctx,
        screen,
        pad_x,
        dock_top_y,
        Vec2::new(card_w, card_h),
        state,
        &mut action,
    );

    if state.controls_open {
        dossier::draw_controls_modal(ctx, screen, state, active, adapter_label);
    } else if state.inspect_sim.is_some() {
        dossier::draw_dossier_modal(ctx, screen, state, &mut action);
    }

    action
}
