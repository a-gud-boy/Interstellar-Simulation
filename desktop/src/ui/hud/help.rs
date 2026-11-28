use egui::epaint::{CornerRadius, StrokeKind};
use egui::text::LayoutJob;
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Margin, Order, Pos2, Rect, ScrollArea,
    Sense, Stroke, TextureId, Vec2,
};

use crate::APP_VERSION;
use crate::renderer::SharedGpuAssets;
use crate::sims::registry::registry_entry;
use crate::sims::{SimId, SimTheme, Simulation};
use crate::ui::theme::{
    apply_dark_widget_visuals, draw_close_icon, paint_glass_panel, semibold_family, tracked_job,
};
use crate::ui::{HudAction, HudState};

#[derive(Copy, Clone, Debug, Eq, PartialEq, Default)]
pub enum HelpTab {
    #[default]
    Controls,
    Physics,
    Tips,
}

impl HelpTab {
    const ALL: [(HelpTab, &'static str); 3] = [
        (HelpTab::Controls, "Controls & Keys"),
        (HelpTab::Physics, "Physics & Presets"),
        (HelpTab::Tips, "Observatory & Tips"),
    ];
}

fn sim_signature_title(id: SimId) -> &'static str {
    match id {
        SimId::Blackhole => "Kerr Horizon & Cinema Still",
        SimId::Wormhole => "Dual-Universe Throat Traversal",
        SimId::BinaryBh => "2.5PN Inspiral & Double Lensing",
        SimId::WarpDrive => "External Chase <-> Inside Bridge",
        SimId::Supernova => "Core-Collapse Detonation Sweep",
        SimId::Pulsar => "Kerr-Schild Neutron Star & Dipole",
        SimId::Starflight => "Relativistic Viewport & Aberration",
        SimId::LensCluster => "Interactive Source-Plane Dragging",
        SimId::Tde => "Tidal Disruption Evolution Sweep",
    }
}

fn sim_camera_bindings(id: SimId) -> &'static [(&'static str, &'static str)] {
    match id {
        SimId::Wormhole => &[
            ("Drag", "Orbit portal"),
            ("Scroll / W S", "Step proper coordinate l"),
            ("Shift-Drag", "Look locally"),
            ("Right-Drag / Q E", "Camera roll"),
            ("T", "Traverse throat (Univ A <-> B)"),
            ("Double-Click / R", "Reset camera"),
        ],
        SimId::WarpDrive => &[
            ("Drag", "Orbit bubble / Look from Bridge"),
            ("Scroll / W S", "Zoom / Bridge FOV"),
            ("T", "Toggle Chase <-> Inside Bridge"),
            ("Right-Drag / Q E", "Camera roll"),
            ("Shift-Drag", "Local look"),
            ("Double-Click / R", "Reset camera"),
        ],
        SimId::Supernova => &[
            ("Drag", "Orbit remnant"),
            ("W / S / Scroll", "Fly inside / outside blast shell"),
            ("T", "Detonate & Evolve lifecycle sweep"),
            ("Right-Drag / Q E", "Camera roll"),
            ("Shift-Drag", "Local look"),
            ("Double-Click / R", "Reset camera"),
        ],
        SimId::Starflight => &[
            ("Drag", "Look around relativistic sky"),
            ("Scroll / W S", "Optical FOV zoom"),
            ("T", "Flip Forward <-> Aft viewport"),
            ("Right-Drag / Q E", "Camera roll"),
            ("A / D / Arrows", "Smooth pan"),
            ("Double-Click / R", "Reset camera"),
        ],
        SimId::LensCluster => &[
            ("Drag", "Orbit view (or drag source)"),
            ("Shift-Drag", "Drag background galaxy directly"),
            ("T", "Toggle Drag Source <-> Orbit View"),
            ("Scroll / W S", "Optical zoom"),
            ("Right-Drag / Q E", "Roll camera"),
            ("Double-Click / R", "Reset camera"),
        ],
        SimId::Blackhole | SimId::BinaryBh | SimId::Pulsar | SimId::Tde => &[
            ("Drag", "Orbit azimuth & elevation"),
            ("Scroll / W S", "Radial zoom"),
            ("Right-Drag / Q E", "Camera roll"),
            ("Shift-Drag", "Local look / tilt"),
            ("A / D / Arrows", "Smooth orbit flight"),
            ("Double-Click / R", "Reset camera"),
        ],
    }
}

const UNIVERSAL_SHORTCUTS: &[(&str, &str)] = &[
    ("1 - 6", "Load physics preset"),
    ("Space", "Pause & 128x Cinema Still"),
    ("O", "Toggle auto-orbit / cruise"),
    ("C", "Open / close Controls drawer"),
    ("I", "Interactive Physics Tour ([ / ])"),
    ("V", "Cinema PNG Sequence Recorder"),
    ("G", "Live GPU Pass Profiler overlay"),
    ("P", "Save PNG screenshot"),
    ("R", "Reset camera to preset"),
    ("H", "Hide / restore HUD"),
    ("? / F1", "Toggle this Help Menu"),
];

const OBSERVATORY_TIPS: &[(&str, &str)] = &[
    (
        "128x Cinema Still & PNG Capture",
        "Press Space to freeze simulation motion and accumulate up to 128 jittered TAA samples, then press P to save a lossless PNG frame.",
    ),
    (
        "Quality Profiles & Performance",
        "Open Controls (C) -> Display & Performance for Eco / Balanced / Ultra profiles, DPR Cap (1.0x-2.0x), 0.75x drag scaling, or press G for the live GPU Pass Profiler.",
    ),
    (
        "Cinema PNG Sequence Recorder",
        "Press V (or open Controls -> Cinema Recorder) to capture deterministic 24/30/60 fps turntable or evolution PNG sequences.",
    ),
    (
        "Navigation & Cross-Sim Switcher",
        "Use the top-right simulation switcher to filter and jump across all 9 native wgpu engines, or click Home to return to the Observatory Homepage.",
    ),
];

fn draw_keycap_grid(ui: &mut egui::Ui, rows: &[(&str, &str)], inner_w: f32, theme: &SimTheme) {
    let col_w = (inner_w - 8.0) * 0.5;
    for pair in rows.chunks(2) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            for (keys, desc) in pair {
                let (r, _) = ui.allocate_exact_size(Vec2::new(col_w, 32.0), Sense::hover());
                ui.painter().rect(
                    r,
                    CornerRadius::same(8),
                    Color32::from_rgba_unmultiplied(255, 255, 255, 9),
                    Stroke::new(1.0, theme.glass_border),
                    StrokeKind::Inside,
                );

                let kg = ui.painter().layout_job(tracked_job(
                    keys,
                    FontId::monospace(10.5),
                    theme.accent_bright,
                    0.1,
                ));
                let kw = (kg.size().x + 12.0).max(24.0);
                let k_rect = Rect::from_min_size(
                    Pos2::new(r.left() + 8.0, r.center().y - 10.0),
                    Vec2::new(kw, 20.0),
                );
                ui.painter().rect(
                    k_rect,
                    CornerRadius::same(5),
                    Color32::from_rgba_unmultiplied(0, 0, 0, 120),
                    Stroke::new(1.0, theme.glass_border_strong),
                    StrokeKind::Inside,
                );
                ui.painter().galley(
                    Pos2::new(k_rect.left() + 6.0, k_rect.center().y - kg.size().y * 0.5),
                    kg,
                    theme.accent_bright,
                );

                let text_left = k_rect.right() + 8.0;
                let mut d_job = LayoutJob::simple(
                    (*desc).to_string(),
                    FontId::proportional(11.4),
                    theme.text_primary,
                    (r.right() - text_left - 8.0).max(40.0),
                );
                d_job.wrap.max_rows = 1;
                d_job.wrap.overflow_character = Some('…');
                let dg = ui.painter().layout_job(d_job);
                ui.painter().galley(
                    Pos2::new(text_left, r.center().y - dg.size().y * 0.5),
                    dg,
                    theme.text_primary,
                );
            }
        });
        ui.add_space(5.0);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_help_modal(
    ctx: &Context,
    sim: &dyn Simulation,
    assets: &SharedGpuAssets,
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let entry = registry_entry(sim.id());

    // Full-screen dimmed backdrop (captures clicks so canvas doesn't orbit underneath)
    Area::new(Id::unique("hud_help_scrim"))
        .fixed_pos(Pos2::ZERO)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let (bg_rect, bg_resp) = ui.allocate_exact_size(screen_size, Sense::click());
            ui.painter().rect_filled(
                bg_rect,
                CornerRadius::ZERO,
                Color32::from_rgba_unmultiplied(2, 4, 10, 196),
            );
            if bg_resp.clicked() {
                actions.push(HudAction::ToggleHelp);
            }
        });

    let dlg_w = (screen_size.x - 36.0).clamp(340.0, 680.0);
    let dlg_h = (screen_size.y - 48.0).clamp(320.0, 580.0);
    let dlg_rect = Rect::from_center_size((screen_size * 0.5).to_pos2(), Vec2::new(dlg_w, dlg_h));

    Area::new(Id::unique("hud_help_modal"))
        .fixed_pos(dlg_rect.min)
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            apply_dark_widget_visuals(ui, theme);
            ui.set_min_size(dlg_rect.size());
            ui.set_max_size(dlg_rect.size());

            paint_glass_panel(
                ui.painter(),
                dlg_rect,
                16.0,
                screen_size,
                glass_tex_id,
                Color32::from_rgba_unmultiplied(11, 14, 24, 240),
                theme.glass_border_strong,
            );

            egui::Frame::NONE
                .inner_margin(Margin::symmetric(18, 14))
                .show(ui, |ui| {
                    let inner_w = (dlg_w - 36.0).max(240.0);
                    ui.set_min_width(inner_w);
                    ui.set_max_width(inner_w);
                    ui.spacing_mut().item_spacing = Vec2::new(0.0, 0.0);

                    // Header
                    ui.horizontal(|ui| {
                        ui.set_width(inner_w);
                        ui.vertical(|ui| {
                            ui.set_max_width(inner_w - 40.0);
                            ui.spacing_mut().item_spacing.y = 3.0;
                            ui.label(tracked_job(
                                &format!(
                                    "HELP & FLIGHT MANUAL · {} / 09 · {}",
                                    entry.index,
                                    entry.category_label.to_ascii_uppercase()
                                ),
                                FontId::monospace(10.0),
                                theme.accent_bright,
                                1.0,
                            ));
                            ui.label(
                                egui::RichText::new(entry.title)
                                    .size(18.0)
                                    .family(semibold_family())
                                    .color(theme.text_primary),
                            );
                            ui.label(
                                egui::RichText::new(entry.tagline)
                                    .size(12.0)
                                    .color(theme.text_secondary),
                            );

                            // Equation ribbon
                            egui::Frame::NONE
                                .fill(Color32::from_rgba_unmultiplied(255, 255, 255, 10))
                                .stroke(Stroke::new(1.0, theme.glass_border))
                                .corner_radius(CornerRadius::same(7))
                                .inner_margin(Margin::symmetric(9, 4))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = 8.0;
                                        ui.label(tracked_job(
                                            "METRIC",
                                            FontId::monospace(9.5),
                                            theme.text_muted,
                                            0.9,
                                        ));
                                        ui.label(
                                            egui::RichText::new(entry.equation)
                                                .size(11.2)
                                                .monospace()
                                                .color(theme.accent_bright),
                                        );
                                    });
                                });
                        });

                        ui.with_layout(egui::Layout::right_to_left(Align::TOP), |ui| {
                            let (c_rect, c_resp) =
                                ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
                            if c_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().rect(
                                c_rect,
                                CornerRadius::same(8),
                                Color32::from_rgba_unmultiplied(
                                    255,
                                    255,
                                    255,
                                    if c_resp.hovered() { 30 } else { 13 },
                                ),
                                Stroke::new(1.0, theme.glass_border),
                                StrokeKind::Inside,
                            );
                            draw_close_icon(ui.painter(), c_rect.center(), theme.text_primary);
                            if c_resp.clicked() {
                                actions.push(HudAction::ToggleHelp);
                            }
                        });
                    });

                    ui.add_space(10.0);
                    let sep1 = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter().line_segment(
                        [sep1.left_center(), sep1.right_center()],
                        Stroke::new(1.0, theme.glass_border),
                    );
                    ui.add_space(8.0);

                    // 3 Segmented Tabs
                    let tab_w = (inner_w - 12.0) / 3.0;
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        for (tab_id, label) in HelpTab::ALL {
                            let selected = hud.help_tab == tab_id;
                            let (t_rect, t_resp) =
                                ui.allocate_exact_size(Vec2::new(tab_w, 32.0), Sense::click());
                            if t_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            let (bg, border, fg) = if selected {
                                (theme.accent_soft, theme.accent_border, theme.accent_bright)
                            } else if t_resp.hovered() {
                                (
                                    Color32::from_rgba_unmultiplied(255, 255, 255, 16),
                                    Color32::TRANSPARENT,
                                    theme.text_primary,
                                )
                            } else {
                                (
                                    Color32::from_rgba_unmultiplied(255, 255, 255, 6),
                                    Color32::TRANSPARENT,
                                    theme.text_secondary,
                                )
                            };
                            ui.painter().rect(
                                t_rect,
                                CornerRadius::same(8),
                                bg,
                                Stroke::new(1.0, border),
                                StrokeKind::Inside,
                            );
                            let tg = ui.painter().layout_job(tracked_job(
                                label,
                                FontId::new(11.8, semibold_family()),
                                fg,
                                0.15,
                            ));
                            ui.painter().galley(
                                Pos2::new(
                                    t_rect.center().x - tg.size().x * 0.5,
                                    t_rect.center().y - tg.size().y * 0.5,
                                ),
                                tg,
                                fg,
                            );
                            if t_resp.clicked() {
                                hud.help_tab = tab_id;
                            }
                        }
                    });

                    ui.add_space(10.0);
                    let sep2 = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter().line_segment(
                        [sep2.left_center(), sep2.right_center()],
                        Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20)),
                    );
                    ui.add_space(10.0);

                    // Scrollable Body (compute exact remaining space before footer)
                    let body_h = (ui.available_height() - 47.0).max(140.0);
                    ui.allocate_ui_with_layout(
                        Vec2::new(inner_w, body_h),
                        egui::Layout::top_down(Align::LEFT),
                        |ui| {
                            ScrollArea::vertical()
                                .id_salt("help_modal_scroll")
                                .max_height(body_h)
                                .auto_shrink([false, false])
                                .show(ui, |ui| {
                                    ui.set_min_width(inner_w);
                                    ui.set_max_width(inner_w);

                                    match hud.help_tab {
                                        HelpTab::Controls => {
                                            // Signature control callout banner
                                            egui::Frame::NONE
                                                .fill(theme.accent_soft)
                                                .stroke(Stroke::new(1.0, theme.accent_border))
                                                .corner_radius(CornerRadius::same(10))
                                                .inner_margin(Margin::symmetric(12, 9))
                                                .show(ui, |ui| {
                                                    ui.set_min_width(inner_w - 24.0);
                                                    ui.label(tracked_job(
                                                        &sim_signature_title(sim.id())
                                                            .to_ascii_uppercase(),
                                                        FontId::new(10.2, semibold_family()),
                                                        theme.accent_bright,
                                                        0.9,
                                                    ));
                                                    ui.add_space(3.0);
                                                    ui.label(
                                                        egui::RichText::new(entry.special_control)
                                                            .size(12.2)
                                                            .color(theme.text_primary),
                                                    );
                                                });

                                            ui.add_space(10.0);
                                            ui.label(tracked_job(
                                                "CAMERA & NAVIGATION",
                                                FontId::new(10.2, semibold_family()),
                                                theme.text_muted,
                                                1.0,
                                            ));
                                            ui.add_space(6.0);
                                            draw_keycap_grid(
                                                ui,
                                                sim_camera_bindings(sim.id()),
                                                inner_w,
                                                theme,
                                            );

                                            ui.add_space(6.0);
                                            ui.label(tracked_job(
                                                "UNIVERSAL OBSERVATORY SHORTCUTS",
                                                FontId::new(10.2, semibold_family()),
                                                theme.text_muted,
                                                1.0,
                                            ));
                                            ui.add_space(6.0);
                                            draw_keycap_grid(
                                                ui,
                                                UNIVERSAL_SHORTCUTS,
                                                inner_w,
                                                theme,
                                            );
                                        }
                                        HelpTab::Physics => {
                                            ui.label(
                                                egui::RichText::new(entry.description)
                                                    .size(12.6)
                                                    .color(theme.text_secondary),
                                            );
                                            ui.add_space(10.0);

                                            // 3 Specs cells
                                            let spec_w = (inner_w - 16.0) / 3.0;
                                            ui.horizontal(|ui| {
                                                ui.spacing_mut().item_spacing.x = 8.0;
                                                for (lbl, val) in entry.specs {
                                                    let (s_rect, _) = ui.allocate_exact_size(
                                                        Vec2::new(spec_w, 44.0),
                                                        Sense::hover(),
                                                    );
                                                    ui.painter().rect(
                                                        s_rect,
                                                        CornerRadius::same(8),
                                                        Color32::from_rgba_unmultiplied(
                                                            255, 255, 255, 9,
                                                        ),
                                                        Stroke::new(1.0, theme.glass_border),
                                                        StrokeKind::Inside,
                                                    );
                                                    let lg = ui.painter().layout_job(tracked_job(
                                                        &lbl.to_ascii_uppercase(),
                                                        FontId::monospace(9.3),
                                                        theme.text_muted,
                                                        0.8,
                                                    ));
                                                    let vg = ui.painter().layout_job(tracked_job(
                                                        val,
                                                        FontId::new(11.8, semibold_family()),
                                                        theme.text_primary,
                                                        0.1,
                                                    ));
                                                    ui.painter().galley(
                                                        Pos2::new(
                                                            s_rect.left() + 10.0,
                                                            s_rect.top() + 7.0,
                                                        ),
                                                        lg,
                                                        theme.text_muted,
                                                    );
                                                    ui.painter().galley(
                                                        Pos2::new(
                                                            s_rect.left() + 10.0,
                                                            s_rect.top() + 21.0,
                                                        ),
                                                        vg,
                                                        theme.text_primary,
                                                    );
                                                }
                                            });

                                            ui.add_space(10.0);
                                            ui.horizontal(|ui| {
                                                ui.label(tracked_job(
                                                    "CURATED PHYSICS PRESETS",
                                                    FontId::new(10.2, semibold_family()),
                                                    theme.text_muted,
                                                    1.0,
                                                ));
                                                ui.with_layout(
                                                    egui::Layout::right_to_left(Align::Center),
                                                    |ui| {
                                                        ui.label(
                                                            egui::RichText::new(
                                                                "Click any preset to apply",
                                                            )
                                                            .size(11.0)
                                                            .color(theme.text_muted),
                                                        );
                                                    },
                                                );
                                            });
                                            ui.add_space(6.0);

                                            let active_idx = sim.active_preset_index();
                                            let card_w = (inner_w - 8.0) * 0.5;
                                            for (row_idx, pair) in
                                                entry.presets.chunks(2).enumerate()
                                            {
                                                ui.horizontal(|ui| {
                                                    ui.spacing_mut().item_spacing.x = 8.0;
                                                    for (col_idx, (p_name, p_desc)) in
                                                        pair.iter().enumerate()
                                                    {
                                                        let preset_idx = row_idx * 2 + col_idx;
                                                        let is_act = active_idx == Some(preset_idx);
                                                        let (p_rect, p_resp) = ui
                                                            .allocate_exact_size(
                                                                Vec2::new(card_w, 64.0),
                                                                Sense::click(),
                                                            );
                                                        if p_resp.hovered() {
                                                            ui.ctx().set_cursor_icon(
                                                                CursorIcon::PointingHand,
                                                            );
                                                        }
                                                        let (bg, border) = if is_act
                                                            || p_resp.hovered()
                                                        {
                                                            (theme.accent_soft, theme.accent_border)
                                                        } else {
                                                            (
                                                                Color32::from_rgba_unmultiplied(
                                                                    255, 255, 255, 9,
                                                                ),
                                                                theme.glass_border,
                                                            )
                                                        };
                                                        ui.painter().rect(
                                                            p_rect,
                                                            CornerRadius::same(8),
                                                            bg,
                                                            Stroke::new(1.0, border),
                                                            StrokeKind::Inside,
                                                        );

                                                        let k_rect = Rect::from_min_size(
                                                            Pos2::new(
                                                                p_rect.left() + 9.0,
                                                                p_rect.top() + 8.0,
                                                            ),
                                                            Vec2::new(16.0, 16.0),
                                                        );
                                                        ui.painter().rect(
                                                            k_rect,
                                                            CornerRadius::same(4),
                                                            Color32::from_rgba_unmultiplied(
                                                                255, 255, 255, 13,
                                                            ),
                                                            Stroke::new(
                                                                1.0,
                                                                theme.glass_border_strong,
                                                            ),
                                                            StrokeKind::Inside,
                                                        );
                                                        let kg =
                                                            ui.painter().layout_job(tracked_job(
                                                                &(preset_idx + 1).to_string(),
                                                                FontId::monospace(10.0),
                                                                if is_act {
                                                                    theme.accent_bright
                                                                } else {
                                                                    theme.text_muted
                                                                },
                                                                0.0,
                                                            ));
                                                        ui.painter().galley(
                                                            Pos2::new(
                                                                k_rect.center().x
                                                                    - kg.size().x * 0.5,
                                                                k_rect.center().y
                                                                    - kg.size().y * 0.5,
                                                            ),
                                                            kg,
                                                            theme.text_muted,
                                                        );

                                                        let title_x = k_rect.right() + 6.0;
                                                        let title_col = if is_act {
                                                            theme.accent_bright
                                                        } else {
                                                            theme.text_primary
                                                        };
                                                        let ng =
                                                            ui.painter().layout_job(tracked_job(
                                                                p_name,
                                                                FontId::new(
                                                                    11.8,
                                                                    semibold_family(),
                                                                ),
                                                                title_col,
                                                                0.1,
                                                            ));
                                                        ui.painter().galley(
                                                            Pos2::new(title_x, p_rect.top() + 8.0),
                                                            ng,
                                                            title_col,
                                                        );

                                                        if is_act {
                                                            let tag_g = ui.painter().layout_job(
                                                                tracked_job(
                                                                    "ACTIVE",
                                                                    FontId::new(
                                                                        9.0,
                                                                        semibold_family(),
                                                                    ),
                                                                    theme.accent_bright,
                                                                    0.5,
                                                                ),
                                                            );
                                                            let tw = tag_g.size().x + 10.0;
                                                            let tag_rect = Rect::from_min_size(
                                                                Pos2::new(
                                                                    p_rect.right() - tw - 8.0,
                                                                    p_rect.top() + 7.5,
                                                                ),
                                                                Vec2::new(tw, 15.0),
                                                            );
                                                            ui.painter().rect(
                                                                tag_rect,
                                                                CornerRadius::same(7),
                                                                theme.accent_soft,
                                                                Stroke::new(
                                                                    1.0,
                                                                    theme.accent_border,
                                                                ),
                                                                StrokeKind::Inside,
                                                            );
                                                            ui.painter().galley(
                                                                Pos2::new(
                                                                    tag_rect.left() + 5.0,
                                                                    tag_rect.center().y
                                                                        - tag_g.size().y * 0.5,
                                                                ),
                                                                tag_g,
                                                                theme.accent_bright,
                                                            );
                                                        }

                                                        let mut d_job = LayoutJob::simple(
                                                            (*p_desc).to_string(),
                                                            FontId::proportional(10.8),
                                                            theme.text_secondary,
                                                            card_w - 20.0,
                                                        );
                                                        d_job.wrap.max_rows = 2;
                                                        d_job.wrap.overflow_character = Some('…');
                                                        let dg = ui.painter().layout_job(d_job);
                                                        ui.painter().galley(
                                                            Pos2::new(
                                                                p_rect.left() + 9.0,
                                                                p_rect.top() + 28.0,
                                                            ),
                                                            dg,
                                                            theme.text_secondary,
                                                        );

                                                        if p_resp.clicked() {
                                                            actions.push(HudAction::SelectPreset(
                                                                preset_idx,
                                                            ));
                                                            actions.push(HudAction::ToggleHelp);
                                                        }
                                                    }
                                                });
                                                ui.add_space(6.0);
                                            }

                                            ui.add_space(4.0);
                                            if draw_help_action_btn(
                                                ui,
                                                "Launch Interactive Physics Tour (I)",
                                                232.0,
                                                theme,
                                            )
                                            .clicked()
                                            {
                                                actions.push(HudAction::ToggleHelp);
                                                if !hud.physics_tour_open {
                                                    actions.push(HudAction::TogglePhysicsTour);
                                                }
                                            }
                                        }
                                        HelpTab::Tips => {
                                            let card_w = (inner_w - 8.0) * 0.5;
                                            for pair in OBSERVATORY_TIPS.chunks(2) {
                                                ui.horizontal(|ui| {
                                                    ui.spacing_mut().item_spacing.x = 8.0;
                                                    for (title, body) in pair {
                                                        let (t_rect, _) = ui.allocate_exact_size(
                                                            Vec2::new(card_w, 96.0),
                                                            Sense::hover(),
                                                        );
                                                        ui.painter().rect(
                                                            t_rect,
                                                            CornerRadius::same(8),
                                                            Color32::from_rgba_unmultiplied(
                                                                255, 255, 255, 9,
                                                            ),
                                                            Stroke::new(1.0, theme.glass_border),
                                                            StrokeKind::Inside,
                                                        );
                                                        let tg =
                                                            ui.painter().layout_job(tracked_job(
                                                                title,
                                                                FontId::new(
                                                                    11.8,
                                                                    semibold_family(),
                                                                ),
                                                                theme.accent_bright,
                                                                0.1,
                                                            ));
                                                        ui.painter().galley(
                                                            Pos2::new(
                                                                t_rect.left() + 11.0,
                                                                t_rect.top() + 9.0,
                                                            ),
                                                            tg,
                                                            theme.accent_bright,
                                                        );
                                                        let mut b_job = LayoutJob::simple(
                                                            (*body).to_string(),
                                                            FontId::proportional(11.0),
                                                            theme.text_secondary,
                                                            card_w - 22.0,
                                                        );
                                                        b_job.wrap.max_rows = 4;
                                                        b_job.wrap.overflow_character = Some('…');
                                                        let bg = ui.painter().layout_job(b_job);
                                                        ui.painter().galley(
                                                            Pos2::new(
                                                                t_rect.left() + 11.0,
                                                                t_rect.top() + 28.0,
                                                            ),
                                                            bg,
                                                            theme.text_secondary,
                                                        );
                                                    }
                                                });
                                                ui.add_space(6.0);
                                            }

                                            ui.add_space(6.0);
                                            ui.label(tracked_job(
                                                "QUICK ACTIONS",
                                                FontId::new(10.2, semibold_family()),
                                                theme.text_muted,
                                                1.0,
                                            ));
                                            ui.add_space(6.0);

                                            let btn_w = (inner_w - 16.0) / 3.0;
                                            ui.horizontal(|ui| {
                                                ui.spacing_mut().item_spacing.x = 8.0;
                                                if draw_help_action_btn(
                                                    ui,
                                                    "Controls (C)",
                                                    btn_w,
                                                    theme,
                                                )
                                                .clicked()
                                                {
                                                    actions.push(HudAction::ToggleHelp);
                                                    actions.push(HudAction::ToggleDrawer);
                                                }
                                                if draw_help_action_btn(
                                                    ui,
                                                    "Physics Tour (I)",
                                                    btn_w,
                                                    theme,
                                                )
                                                .clicked()
                                                {
                                                    actions.push(HudAction::ToggleHelp);
                                                    if !hud.physics_tour_open {
                                                        actions.push(HudAction::TogglePhysicsTour);
                                                    }
                                                }
                                                if draw_help_action_btn(
                                                    ui,
                                                    "GPU Profiler (G)",
                                                    btn_w,
                                                    theme,
                                                )
                                                .clicked()
                                                {
                                                    actions.push(HudAction::ToggleProfiler);
                                                }
                                            });
                                            ui.add_space(6.0);
                                            ui.horizontal(|ui| {
                                                ui.spacing_mut().item_spacing.x = 8.0;
                                                if draw_help_action_btn(
                                                    ui,
                                                    "Capture PNG (P)",
                                                    btn_w,
                                                    theme,
                                                )
                                                .clicked()
                                                {
                                                    actions.push(HudAction::CapturePng);
                                                }
                                                if draw_help_action_btn(
                                                    ui,
                                                    "Reset Camera (R)",
                                                    btn_w,
                                                    theme,
                                                )
                                                .clicked()
                                                {
                                                    actions.push(HudAction::ResetCamera);
                                                }
                                            });
                                        }
                                    }
                                });
                        },
                    );

                    ui.add_space(8.0);
                    let sep3 = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter().line_segment(
                        [sep3.left_center(), sep3.right_center()],
                        Stroke::new(1.0, theme.glass_border),
                    );
                    ui.add_space(8.0);

                    // Footer
                    ui.horizontal(|ui| {
                        ui.set_width(inner_w);
                        let left_w = (inner_w - 196.0).max(80.0);
                        let (l_rect, _) =
                            ui.allocate_exact_size(Vec2::new(left_w, 30.0), Sense::hover());
                        let mut foot_job = tracked_job(
                            &format!(
                                "Interstellar Observatory · v{APP_VERSION} · {}",
                                assets.adapter_label
                            ),
                            FontId::monospace(10.0),
                            theme.text_muted,
                            0.1,
                        );
                        foot_job.wrap.max_width = left_w;
                        foot_job.wrap.max_rows = 1;
                        foot_job.wrap.overflow_character = Some('…');
                        let fg = ui.painter().layout_job(foot_job);
                        ui.painter().galley(
                            Pos2::new(l_rect.left(), l_rect.center().y - fg.size().y * 0.5),
                            fg,
                            theme.text_muted,
                        );
                        ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 10.0;
                            if draw_help_action_btn(ui, "Close", 74.0, theme).clicked() {
                                actions.push(HudAction::ToggleHelp);
                            }
                            ui.label(
                                egui::RichText::new("Esc or ? to close")
                                    .size(10.5)
                                    .color(theme.text_muted),
                            );
                        });
                    });
                });
        });
}

fn draw_help_action_btn(
    ui: &mut egui::Ui,
    label: &str,
    width: f32,
    theme: &SimTheme,
) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 30.0), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    let (bg, border, fg) = if resp.hovered() {
        (theme.accent_soft, theme.accent_border, theme.accent_bright)
    } else {
        (
            Color32::from_rgba_unmultiplied(255, 255, 255, 16),
            theme.glass_border_strong,
            theme.text_primary,
        )
    };
    ui.painter().rect(
        rect,
        CornerRadius::same(8),
        bg,
        Stroke::new(1.0, border),
        StrokeKind::Inside,
    );
    let g = ui.painter().layout_job(tracked_job(
        label,
        FontId::new(11.3, semibold_family()),
        fg,
        0.1,
    ));
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
