use egui::epaint::CornerRadius;
use egui::text::LayoutJob;
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Margin, Order, Pos2, Rect, ScrollArea,
    Sense, Stroke, StrokeKind, Vec2,
};

use super::{
    CYAN_GPU, CatalogEntry, HomeAction, HomeState, TEXT_MUTED, TEXT_PRIMARY, TEXT_SECONDARY,
    catalog_entry, dialog_surface, draw_accent_pill_button, draw_glass_pill_button, hairline,
    hairline_soft,
};
use crate::ui::theme::{draw_close_icon, semibold_family, tracked_job, with_alpha};

pub(super) fn draw_dossier_modal(
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
                                    "{} / 08 · {} · {}",
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
                            let (c_rect, c_resp) =
                                ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
                            if c_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().circle(
                                c_rect.center(),
                                15.0,
                                Color32::from_rgba_unmultiplied(
                                    255,
                                    255,
                                    255,
                                    if c_resp.hovered() { 32 } else { 14 },
                                ),
                                Stroke::new(1.0, hairline()),
                            );
                            draw_close_icon(ui.painter(), c_rect.center(), TEXT_PRIMARY);
                            if c_resp.clicked() {
                                close_now = true;
                            }
                        });
                    });

                    ui.add_space(10.0);
                    let sep = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter()
                        .rect_filled(sep, CornerRadius::ZERO, hairline_soft());
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
                                    let (m_rect, _) = ui.allocate_exact_size(
                                        Vec2::new(half_w, 58.0),
                                        Sense::hover(),
                                    );
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
                                        let (p_rect, p_resp) = ui.allocate_exact_size(
                                            Vec2::new(half_w, btn_h),
                                            Sense::click(),
                                        );
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
                    let sep2 = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter()
                        .rect_filled(sep2, CornerRadius::ZERO, hairline_soft());
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
                            if draw_glass_pill_button(ui, "Close", 34.0, 14.0, 12.0, None).clicked()
                            {
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

pub(super) fn draw_controls_modal(
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
                                egui::RichText::new(format!(
                                    "Active Native Backend: {adapter_label}"
                                ))
                                .size(12.0)
                                .monospace()
                                .color(CYAN_GPU),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(Align::TOP), |ui| {
                            let (c_rect, c_resp) =
                                ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
                            if c_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().circle(
                                c_rect.center(),
                                15.0,
                                Color32::from_rgba_unmultiplied(
                                    255,
                                    255,
                                    255,
                                    if c_resp.hovered() { 32 } else { 14 },
                                ),
                                Stroke::new(1.0, hairline()),
                            );
                            draw_close_icon(ui.painter(), c_rect.center(), TEXT_PRIMARY);
                            if c_resp.clicked() {
                                close_now = true;
                            }
                        });
                    });

                    ui.add_space(10.0);
                    let sep = ui
                        .allocate_exact_size(Vec2::new(inner_w, 1.0), Sense::hover())
                        .0;
                    ui.painter()
                        .rect_filled(sep, CornerRadius::ZERO, hairline_soft());
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
                                    Pos2::new(
                                        pill_rect.left() + 6.0,
                                        pill_rect.center().y - k_g.size().y * 0.5,
                                    ),
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
                                    Pos2::new(
                                        pill_rect.right() + 9.0,
                                        k_rect.center().y - d_g.size().y * 0.5,
                                    ),
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
                            if draw_glass_pill_button(ui, "Close", 34.0, 16.0, 12.5, None).clicked()
                            {
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
