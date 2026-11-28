use egui::epaint::{CornerRadius, StrokeKind};
use egui::text::TextWrapping;
use egui::{
    Align, Align2, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Shape,
    Stroke, TextFormat, TextureId, Vec2,
};

use crate::sims::{SimId, SimTheme};
use crate::ui::theme::{
    HUD_PAD, build_glass_shapes, draw_badge, draw_close_icon, semibold_family, tracked_job,
    with_alpha,
};
use crate::ui::tour_data::preset_tour;
use crate::ui::{HudAction, HudState};

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_physics_tour(
    ctx: &Context,
    sim_id: SimId,
    preset_id: &str,
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let tour = preset_tour(sim_id, preset_id);
    if tour.callouts.is_empty() {
        return;
    }
    let count = tour.callouts.len();
    let active_idx = hud.physics_tour_step % count;
    hud.physics_tour_step = active_idx;
    let active_callout = &tour.callouts[active_idx];

    // 1. Floating reticle pins across the simulation viewport
    Area::new(Id::unique("hud_physics_tour_pins"))
        .fixed_pos(Pos2::ZERO)
        .order(Order::Middle)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.set_min_size(screen_size);
            ui.set_max_size(screen_size);

            for (idx, callout) in tour.callouts.iter().enumerate() {
                let is_active = idx == active_idx;
                let pin_pos = Pos2::new(
                    (callout.x * screen_size.x).clamp(80.0, (screen_size.x - 160.0).max(80.0)),
                    (callout.y * screen_size.y).clamp(96.0, (screen_size.y - 220.0).max(96.0)),
                );

                let lbl_font = FontId::new(11.0, semibold_family());
                let lbl_g = ui.painter().layout_job(tracked_job(
                    callout.title,
                    lbl_font,
                    theme.text_primary,
                    0.1,
                ));
                let show_label = screen_size.x >= 960.0;
                let pill_w = if show_label {
                    (28.0 + lbl_g.size().x + 10.0).min(210.0)
                } else {
                    26.0
                };
                let pill_rect = Rect::from_min_size(
                    Pos2::new(pin_pos.x - 13.0, pin_pos.y - 13.0),
                    Vec2::new(pill_w, 26.0),
                );
                let resp = ui.interact(
                    pill_rect,
                    ui.scope_id().with(("tour_pin", idx)),
                    Sense::click(),
                );
                if resp.hovered() {
                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                }

                let (fill, border) = if is_active {
                    (
                        Color32::from_rgba_unmultiplied(15, 22, 36, 236),
                        theme.accent_border,
                    )
                } else if resp.hovered() {
                    (
                        Color32::from_rgba_unmultiplied(15, 22, 36, 220),
                        theme.glass_border_strong,
                    )
                } else {
                    (
                        Color32::from_rgba_unmultiplied(9, 13, 22, 200),
                        theme.glass_border,
                    )
                };

                ui.painter().rect(
                    pill_rect,
                    CornerRadius::same(13),
                    fill,
                    Stroke::new(1.0, border),
                    StrokeKind::Inside,
                );

                let num_c = Pos2::new(pill_rect.left() + 13.0, pill_rect.center().y);
                if is_active {
                    ui.painter()
                        .circle_stroke(num_c, 12.0, Stroke::new(1.2, theme.accent_border));
                    ui.painter().circle_filled(num_c, 9.5, theme.accent);
                } else {
                    ui.painter().circle_filled(
                        num_c,
                        9.5,
                        Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                    );
                }

                let num_fg = if is_active {
                    Color32::from_rgb(6, 9, 17)
                } else {
                    theme.text_primary
                };
                let num_text = format!("{}", idx + 1);
                let num_g = ui.painter().layout_job(tracked_job(
                    &num_text,
                    FontId::monospace(10.5),
                    num_fg,
                    0.0,
                ));
                ui.painter().galley(
                    Pos2::new(
                        num_c.x - num_g.size().x * 0.5,
                        num_c.y - num_g.size().y * 0.5,
                    ),
                    num_g,
                    num_fg,
                );

                if show_label {
                    let mut job = egui::text::LayoutJob {
                        wrap: TextWrapping {
                            max_width: (pill_rect.width() - 32.0).max(40.0),
                            max_rows: 1,
                            break_anywhere: true,
                            overflow_character: Some('…'),
                        },
                        ..Default::default()
                    };
                    job.append(
                        callout.title,
                        0.0,
                        TextFormat {
                            font_id: FontId::new(11.0, semibold_family()),
                            color: if is_active {
                                theme.accent_bright
                            } else {
                                theme.text_primary
                            },
                            ..Default::default()
                        },
                    );
                    let g = ui.painter().layout_job(job);
                    ui.painter().galley(
                        Pos2::new(
                            pill_rect.left() + 27.0,
                            pill_rect.center().y - g.size().y * 0.5,
                        ),
                        g,
                        theme.text_primary,
                    );
                }

                if resp.clicked() {
                    actions.push(HudAction::SelectTourCallout(idx));
                }
            }
        });

    // 2. Bottom-left Observatory Glass Explanation Card
    let card_w = 392.0_f32.min((screen_size.x - HUD_PAD * 2.0).max(260.0));
    Area::new(Id::unique("hud_physics_tour_card"))
        .anchor(Align2::LEFT_BOTTOM, Vec2::new(HUD_PAD, -(HUD_PAD + 64.0)))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let inner = ui.scope(|ui| {
                ui.set_min_width(card_w);
                ui.set_max_width(card_w);
                ui.spacing_mut().item_spacing = Vec2::new(0.0, 6.0);

                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    let content_w = card_w - 24.0;
                    ui.vertical(|ui| {
                        ui.set_min_width(content_w);
                        ui.set_max_width(content_w);
                        ui.spacing_mut().item_spacing = Vec2::new(0.0, 7.0);

                        // Header row
                        ui.horizontal(|ui| {
                            ui.set_width(content_w);
                            ui.vertical(|ui| {
                                ui.set_max_width((content_w - 32.0).max(120.0));
                                ui.spacing_mut().item_spacing.y = 2.0;
                                let ey_text =
                                    format!("PHYSICS TOUR · {} / {}", active_idx + 1, count);
                                ui.label(tracked_job(
                                    &ey_text,
                                    FontId::new(10.0, semibold_family()),
                                    theme.accent_bright,
                                    1.0,
                                ));
                                let mut h_job = tracked_job(
                                    tour.headline,
                                    FontId::new(13.5, semibold_family()),
                                    theme.text_primary,
                                    0.1,
                                );
                                h_job.wrap.max_width = (content_w - 34.0).max(120.0);
                                ui.label(h_job);
                            });

                            ui.with_layout(egui::Layout::right_to_left(Align::TOP), |ui| {
                                let (c_rect, c_resp) =
                                    ui.allocate_exact_size(Vec2::new(26.0, 26.0), Sense::click());
                                if c_resp.hovered() {
                                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                }
                                ui.painter().rect(
                                    c_rect,
                                    CornerRadius::same(7),
                                    Color32::from_rgba_unmultiplied(
                                        255,
                                        255,
                                        255,
                                        if c_resp.hovered() { 28 } else { 14 },
                                    ),
                                    Stroke::new(1.0, theme.glass_border),
                                    StrokeKind::Inside,
                                );
                                draw_close_icon(
                                    ui.painter(),
                                    c_rect.center(),
                                    if c_resp.hovered() {
                                        theme.text_primary
                                    } else {
                                        theme.text_secondary
                                    },
                                );
                                if c_resp.clicked() {
                                    actions.push(HudAction::TogglePhysicsTour);
                                }
                            });
                        });

                        // Formula strip
                        let mut f_job = tracked_job(
                            tour.formula,
                            FontId::monospace(10.8),
                            theme.accent_bright,
                            0.0,
                        );
                        f_job.wrap.max_width = content_w - 16.0;
                        let f_galley = ui.painter().layout_job(f_job);
                        let (f_rect, _) = ui.allocate_exact_size(
                            Vec2::new(content_w, f_galley.size().y + 10.0),
                            Sense::hover(),
                        );
                        ui.painter().rect(
                            f_rect,
                            CornerRadius::same(6),
                            Color32::from_rgba_unmultiplied(255, 255, 255, 10),
                            Stroke::new(1.0, theme.glass_border),
                            StrokeKind::Inside,
                        );
                        ui.painter().galley(
                            Pos2::new(f_rect.left() + 8.0, f_rect.top() + 5.0),
                            f_galley,
                            theme.accent_bright,
                        );

                        // Summary
                        let mut s_job = tracked_job(
                            tour.summary,
                            FontId::proportional(11.6),
                            theme.text_secondary,
                            0.0,
                        );
                        s_job.wrap.max_width = content_w;
                        ui.label(s_job);

                        // Highlighted Callout Box
                        let callout_bg = ui.painter().add(Shape::Noop);
                        let c_inner = ui.scope(|ui| {
                            ui.set_min_width(content_w);
                            ui.set_max_width(content_w);
                            ui.add_space(7.0);
                            ui.horizontal(|ui| {
                                ui.add_space(9.0);
                                let box_w = content_w - 18.0;
                                ui.vertical(|ui| {
                                    ui.set_min_width(box_w);
                                    ui.set_max_width(box_w);
                                    ui.spacing_mut().item_spacing.y = 4.0;

                                    ui.horizontal_wrapped(|ui| {
                                        let title_s =
                                            format!("{}. {}", active_idx + 1, active_callout.title);
                                        ui.label(tracked_job(
                                            &title_s,
                                            FontId::new(12.0, semibold_family()),
                                            theme.text_primary,
                                            0.0,
                                        ));
                                        draw_badge(
                                            ui,
                                            active_callout.metric,
                                            theme.accent_soft,
                                            theme.accent_border,
                                            theme.accent_bright,
                                        );
                                    });

                                    let mut d_job = tracked_job(
                                        active_callout.detail,
                                        FontId::proportional(11.4),
                                        theme.text_primary,
                                        0.0,
                                    );
                                    d_job.wrap.max_width = box_w;
                                    ui.label(d_job);
                                });
                                ui.add_space(9.0);
                            });
                            ui.add_space(7.0);
                        });
                        ui.painter().set(
                            callout_bg,
                            Shape::rect_filled(
                                c_inner.response.rect,
                                CornerRadius::same(8),
                                with_alpha(theme.accent, 34),
                            ),
                        );
                        ui.painter().rect_stroke(
                            c_inner.response.rect,
                            CornerRadius::same(8),
                            Stroke::new(1.0, theme.accent_border),
                            StrokeKind::Inside,
                        );

                        // Stepper footer
                        ui.horizontal(|ui| {
                            ui.set_width(content_w);
                            if draw_step_btn(ui, "← Prev", theme).clicked() {
                                actions.push(HudAction::StepPhysicsTour(-1));
                            }
                            ui.add_space(6.0);
                            for idx in 0..count {
                                let is_cur = idx == active_idx;
                                let (d_rect, d_resp) =
                                    ui.allocate_exact_size(Vec2::new(22.0, 22.0), Sense::click());
                                if d_resp.hovered() {
                                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                }
                                ui.painter().rect(
                                    d_rect,
                                    CornerRadius::same(11),
                                    if is_cur {
                                        theme.accent_soft
                                    } else {
                                        Color32::from_rgba_unmultiplied(255, 255, 255, 13)
                                    },
                                    Stroke::new(
                                        1.0,
                                        if is_cur {
                                            theme.accent_border
                                        } else {
                                            theme.glass_border
                                        },
                                    ),
                                    StrokeKind::Inside,
                                );
                                let txt = format!("{}", idx + 1);
                                let dg = ui.painter().layout_job(tracked_job(
                                    &txt,
                                    FontId::monospace(10.5),
                                    if is_cur {
                                        theme.accent_bright
                                    } else {
                                        theme.text_secondary
                                    },
                                    0.0,
                                ));
                                ui.painter().galley(
                                    Pos2::new(
                                        d_rect.center().x - dg.size().x * 0.5,
                                        d_rect.center().y - dg.size().y * 0.5,
                                    ),
                                    dg,
                                    theme.text_primary,
                                );
                                if d_resp.clicked() {
                                    actions.push(HudAction::SelectTourCallout(idx));
                                }
                            }
                            ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                                if draw_step_btn(ui, "Next →", theme).clicked() {
                                    actions.push(HudAction::StepPhysicsTour(1));
                                }
                            });
                        });
                    });
                    ui.add_space(12.0);
                });
                ui.add_space(10.0);
            });

            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    inner.response.rect,
                    12.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg_elevated,
                    theme.glass_border,
                ),
            );
        });
}

fn draw_step_btn(ui: &mut egui::Ui, label: &str, theme: &SimTheme) -> egui::Response {
    let g = ui.painter().layout_job(tracked_job(
        label,
        FontId::new(11.0, semibold_family()),
        theme.text_primary,
        0.0,
    ));
    let w = g.size().x + 18.0;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 26.0), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    ui.painter().rect(
        rect,
        CornerRadius::same(13),
        Color32::from_rgba_unmultiplied(255, 255, 255, if resp.hovered() { 26 } else { 14 }),
        Stroke::new(
            1.0,
            if resp.hovered() {
                theme.accent_border
            } else {
                theme.glass_border_strong
            },
        ),
        StrokeKind::Inside,
    );
    ui.painter().galley(
        Pos2::new(
            rect.center().x - g.size().x * 0.5,
            rect.center().y - g.size().y * 0.5,
        ),
        g,
        if resp.hovered() {
            theme.accent_bright
        } else {
            theme.text_primary
        },
    );
    resp
}

pub(crate) fn draw_recording_pill(
    ctx: &Context,
    hud: &HudState,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    if !hud.recording_active {
        return;
    }
    Area::new(Id::unique("hud_recording_pill"))
        .anchor(Align2::CENTER_TOP, Vec2::new(0.0, HUD_PAD))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let inner = ui.scope(|ui| {
                ui.horizontal(|ui| {
                    ui.add_space(10.0);
                    ui.vertical(|ui| {
                        ui.add_space(5.0);
                        ui.horizontal(|ui| {
                            let (dot_r, _) =
                                ui.allocate_exact_size(Vec2::new(10.0, 18.0), Sense::hover());
                            ui.painter().circle_filled(
                                dot_r.center(),
                                4.0,
                                Color32::from_rgb(239, 68, 68),
                            );
                            let txt = format!(
                                "REC PNG {} / {}",
                                hud.recording_frame, hud.recording_total_frames
                            );
                            ui.label(tracked_job(
                                &txt,
                                FontId::monospace(11.2),
                                Color32::from_rgb(254, 202, 202),
                                0.0,
                            ));
                            ui.add_space(6.0);
                            let stop_g = ui.painter().layout_job(tracked_job(
                                "Stop",
                                FontId::new(10.5, semibold_family()),
                                Color32::from_rgb(254, 226, 226),
                                0.0,
                            ));
                            let (s_rect, s_resp) = ui.allocate_exact_size(
                                Vec2::new(stop_g.size().x + 14.0, 20.0),
                                Sense::click(),
                            );
                            if s_resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }
                            ui.painter().rect(
                                s_rect,
                                CornerRadius::same(10),
                                Color32::from_rgba_unmultiplied(239, 68, 68, 70),
                                Stroke::new(
                                    1.0,
                                    Color32::from_rgba_unmultiplied(248, 113, 113, 160),
                                ),
                                StrokeKind::Inside,
                            );
                            ui.painter().galley(
                                Pos2::new(
                                    s_rect.center().x - stop_g.size().x * 0.5,
                                    s_rect.center().y - stop_g.size().y * 0.5,
                                ),
                                stop_g,
                                Color32::from_rgb(254, 226, 226),
                            );
                            if s_resp.clicked() {
                                actions.push(HudAction::ToggleRecording);
                            }
                        });
                        ui.add_space(5.0);
                    });
                    ui.add_space(10.0);
                });
            });
            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    inner.response.rect,
                    16.0,
                    screen_size,
                    glass_tex_id,
                    Color32::from_rgba_unmultiplied(24, 10, 14, 215),
                    Color32::from_rgba_unmultiplied(248, 113, 113, 170),
                ),
            );
        });
}
