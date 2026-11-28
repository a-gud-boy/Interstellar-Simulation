use egui::epaint::{CornerRadius, StrokeKind};
use egui::{
    Align2, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Shape,
    Stroke, TextureId, Vec2,
};

use crate::sims::{HudMetadata, SimTheme, Simulation};
use crate::ui::HudAction;
use crate::ui::theme::{
    HUD_PAD, build_glass_shapes, draw_camera_icon, draw_eye_icon, draw_orbit_icon, draw_pause_icon,
    draw_pill_button, draw_play_icon, draw_reset_icon, draw_swap_icon, semibold_family,
    tracked_job, with_alpha,
};

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_bottom_dock(
    ctx: &Context,
    sim: &dyn Simulation,
    meta: &HudMetadata,
    tour_open: bool,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let presets = sim.presets();
    let active_preset = sim.active_preset_index();
    let paused = sim.paused();
    let auto_orbit = sim.auto_orbit();

    Area::new(Id::unique("hud_bottom_dock"))
        .anchor(Align2::CENTER_BOTTOM, Vec2::new(0.0, -HUD_PAD))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let dock = egui::Frame::NONE
                .inner_margin(egui::Margin::symmetric(8, 5))
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(4.0, 0.0);
                    ui.horizontal_centered(|ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(4.0, 0.0);

                        // 6 Presets with [1]..[6] keycaps on the left
                        for (idx, preset) in presets.iter().enumerate() {
                            let is_act = active_preset == Some(idx);
                            let font = FontId::new(11.5, semibold_family());
                            let label_g = ui.painter().layout_job(tracked_job(
                                preset.short_label,
                                font,
                                Color32::PLACEHOLDER,
                                0.0,
                            ));
                            let k_w = 16.0;
                            let w = 9.0 + k_w + 5.0 + label_g.size().x + 9.0;
                            let (rect, resp) =
                                ui.allocate_exact_size(Vec2::new(w, 30.0), Sense::click());
                            if resp.hovered() {
                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                            }

                            let (fill, border, text_c) = if is_act {
                                (theme.accent_soft, theme.accent_border, theme.accent_bright)
                            } else if resp.hovered() {
                                (
                                    Color32::from_rgba_unmultiplied(255, 255, 255, 20),
                                    Color32::TRANSPARENT,
                                    theme.text_primary,
                                )
                            } else {
                                (
                                    Color32::TRANSPARENT,
                                    Color32::TRANSPARENT,
                                    theme.text_secondary,
                                )
                            };

                            ui.painter().rect(
                                rect,
                                CornerRadius::same(15),
                                fill,
                                Stroke::new(1.0, border),
                                StrokeKind::Inside,
                            );

                            let k_rect = Rect::from_center_size(
                                Pos2::new(rect.left() + 9.0 + k_w * 0.5, rect.center().y),
                                Vec2::new(k_w, 16.0),
                            );
                            ui.painter().rect(
                                k_rect,
                                CornerRadius::same(4),
                                Color32::from_rgba_unmultiplied(255, 255, 255, 13),
                                Stroke::new(
                                    1.0,
                                    if is_act {
                                        with_alpha(theme.accent, 110)
                                    } else {
                                        Color32::from_rgba_unmultiplied(255, 255, 255, 36)
                                    },
                                ),
                                StrokeKind::Inside,
                            );
                            let k_g = ui.painter().layout_job(tracked_job(
                                preset.hotkey,
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
                                    k_rect.center().x - k_g.size().x * 0.5,
                                    k_rect.center().y - k_g.size().y * 0.5,
                                ),
                                k_g,
                                theme.text_muted,
                            );

                            ui.painter().galley_with_override_text_color(
                                Pos2::new(
                                    k_rect.right() + 5.0,
                                    rect.center().y - label_g.size().y * 0.5,
                                ),
                                label_g,
                                text_c,
                            );

                            if resp.clicked() {
                                actions.push(HudAction::SelectPreset(idx));
                            }
                        }

                        // Divider
                        ui.add_space(3.0);
                        let (div_r, _) =
                            ui.allocate_exact_size(Vec2::new(1.0, 22.0), Sense::hover());
                        ui.painter().line_segment(
                            [div_r.center_top(), div_r.center_bottom()],
                            Stroke::new(1.0, theme.glass_border),
                        );
                        ui.add_space(3.0);

                        // Transport buttons
                        let play_resp = draw_pill_button(
                            ui,
                            if paused { "Resume" } else { "Pause" },
                            paused,
                            false,
                            theme,
                            30.0,
                            9.0,
                            Some(&|p, c, col| {
                                if paused {
                                    draw_play_icon(p, c, col);
                                } else {
                                    draw_pause_icon(p, c, col);
                                }
                            }),
                            None,
                        );
                        if play_resp.clicked() {
                            actions.push(HudAction::TogglePause);
                        }

                        if let Some(sp) = &meta.special_action
                            && draw_pill_button(
                                ui,
                                sp.label,
                                sp.active,
                                false,
                                theme,
                                30.0,
                                9.0,
                                Some(&draw_swap_icon),
                                Some(sp.key_hint),
                            )
                            .clicked()
                        {
                            actions.push(HudAction::TriggerSpecial);
                        }

                        if draw_pill_button(
                            ui,
                            meta.orbit_toggle_label,
                            auto_orbit,
                            false,
                            theme,
                            30.0,
                            9.0,
                            Some(&draw_orbit_icon),
                            Some("O"),
                        )
                        .clicked()
                        {
                            actions.push(HudAction::ToggleAutoOrbit);
                        }

                        if draw_pill_button(
                            ui,
                            "Reset",
                            false,
                            false,
                            theme,
                            30.0,
                            9.0,
                            Some(&draw_reset_icon),
                            Some("R"),
                        )
                        .clicked()
                        {
                            actions.push(HudAction::ResetCamera);
                        }

                        if draw_pill_button(
                            ui,
                            "PNG",
                            false,
                            false,
                            theme,
                            30.0,
                            9.0,
                            Some(&draw_camera_icon),
                            Some("P"),
                        )
                        .clicked()
                        {
                            actions.push(HudAction::CapturePng);
                        }

                        if screen_size.x >= 1180.0
                            && draw_pill_button(
                                ui,
                                "Tour",
                                tour_open,
                                false,
                                theme,
                                30.0,
                                8.0,
                                None,
                                Some("I"),
                            )
                            .clicked()
                        {
                            actions.push(HudAction::TogglePhysicsTour);
                        }

                        if draw_pill_button(
                            ui,
                            "Hide",
                            false,
                            false,
                            theme,
                            30.0,
                            9.0,
                            Some(&|p, c, col| draw_eye_icon(p, c, col, true)),
                            Some("H"),
                        )
                        .clicked()
                        {
                            actions.push(HudAction::ToggleHud);
                        }
                    });
                });

            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    dock.response.rect,
                    20.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg,
                    theme.glass_border,
                ),
            );
        });
}

pub(crate) fn draw_bottom_left_hint(ctx: &Context, hint_text: &str, screen_size: Vec2) {
    if screen_size.x < 1440.0 {
        return;
    }
    Area::new(Id::unique("hud_hint"))
        .fixed_pos(Pos2::new(
            HUD_PAD,
            (screen_size.y - HUD_PAD - 64.0).max(16.0),
        ))
        .interactable(false)
        .order(Order::Middle)
        .show(ctx, |ui| {
            let font = FontId::proportional(11.0);
            let galley =
                ui.painter()
                    .layout_job(tracked_job(hint_text, font, Color32::PLACEHOLDER, 0.2));
            let (rect, _) = ui.allocate_exact_size(galley.size(), Sense::hover());
            ui.painter().galley_with_override_text_color(
                rect.min + Vec2::new(0.0, 1.0),
                galley.clone(),
                Color32::from_rgba_unmultiplied(0, 0, 0, 200),
            );
            ui.painter().galley_with_override_text_color(
                rect.min,
                galley,
                Color32::from_rgba_unmultiplied(226, 232, 240, 126),
            );
        });
}
