use egui::text::{LayoutJob, TextFormat};
use egui::{
    Align, Align2, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Sense, Shape,
    Stroke, TextureId, Vec2,
};

use crate::sims::{HudMetadata, SimId, SimTheme};
use crate::ui::theme::{
    HUD_PAD, build_glass_shapes, draw_badge, draw_eye_icon, draw_home_icon, draw_pill_button,
    draw_sliders_icon, draw_standalone_glass_pill, paint_glass_panel, semibold_family, tracked_job,
    with_alpha,
};
use crate::ui::{HudAction, HudState};

fn append_unit_with_subscripts(
    job: &mut LayoutJob,
    unit: &str,
    main_fmt: &TextFormat,
    sub_fmt: &TextFormat,
) {
    let mut i = 0;
    let bytes = unit.as_bytes();
    while i < unit.len() {
        if bytes[i] == b'_' && i + 1 < unit.len() {
            let sub_start = i + 1;
            let mut sub_end = sub_start;
            while sub_end < unit.len() {
                let ch = unit[sub_end..].chars().next().unwrap();
                if ch.is_alphanumeric() {
                    sub_end += ch.len_utf8();
                } else {
                    break;
                }
            }
            if sub_end > sub_start {
                job.append(&unit[sub_start..sub_end], 0.0, sub_fmt.clone());
                i = sub_end;
                continue;
            }
        }
        let ch = unit[i..].chars().next().unwrap();
        let next = i + ch.len_utf8();
        job.append(&unit[i..next], 0.0, main_fmt.clone());
        i = next;
    }
}

fn telemetry_label_job(label: &str, unit: &str, theme: &SimTheme) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = f32::INFINITY;
    let label_fmt = TextFormat {
        font_id: FontId::proportional(9.8),
        extra_letter_spacing: 0.65,
        color: theme.text_muted,
        valign: Align::Center,
        ..Default::default()
    };
    job.append(label, 0.0, label_fmt);

    if !unit.is_empty() {
        let unit_color = if let Some((warm, _, _)) = theme.warm {
            with_alpha(warm, 230)
        } else {
            with_alpha(theme.text_muted, 215)
        };
        let main_fmt = TextFormat {
            font_id: FontId::proportional(9.8),
            extra_letter_spacing: 0.15,
            color: unit_color,
            valign: Align::Center,
            ..Default::default()
        };
        let sub_fmt = TextFormat {
            font_id: FontId::proportional(7.6),
            extra_letter_spacing: 0.1,
            color: unit_color,
            valign: Align::BOTTOM,
            ..Default::default()
        };
        job.append("  ", 0.0, main_fmt.clone());
        append_unit_with_subscripts(&mut job, unit, &main_fmt, &sub_fmt);
    }
    job
}

pub(crate) fn draw_top_left_card(
    ctx: &Context,
    meta: &HudMetadata,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
) {
    Area::new(Id::unique("hud_top_left"))
        .fixed_pos(Pos2::new(HUD_PAD, HUD_PAD))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let card = ui.scope(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(5.0, 5.0);
                ui.add_space(9.0);

                ui.horizontal(|ui| {
                    ui.add_space(11.0);
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(10.0, 7.0);

                        // Top header row: glowing dot + brand title + preset/sky badges
                        let row_resp = ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 6.0;
                            let (dot_rect, _) =
                                ui.allocate_exact_size(Vec2::new(7.0, 19.0), Sense::hover());
                            let dot_c = dot_rect.center();
                            ui.painter()
                                .circle_filled(dot_c, 5.5, with_alpha(theme.accent, 68));
                            let core_color = if theme.warm.is_some() {
                                theme.accent_bright
                            } else {
                                theme.accent
                            };
                            ui.painter().circle_filled(dot_c, 3.2, core_color);

                            let title_job = tracked_job(
                                meta.brand_title,
                                FontId::new(12.6, semibold_family()),
                                theme.text_primary,
                                1.7,
                            );
                            let title_galley = ui.painter().layout_job(title_job);
                            let (title_rect, _) = ui.allocate_exact_size(
                                Vec2::new(title_galley.size().x + 4.0, 19.0),
                                Sense::hover(),
                            );
                            ui.painter().galley(
                                Pos2::new(
                                    title_rect.left(),
                                    title_rect.center().y - title_galley.size().y * 0.5,
                                ),
                                title_galley,
                                theme.text_primary,
                            );

                            draw_badge(
                                ui,
                                &meta.preset_badge,
                                theme.accent_soft,
                                theme.accent_border,
                                theme.accent_bright,
                            );

                            let (sec_bg, sec_border, sec_fg) = if meta.secondary_badge_warm {
                                if let Some((warm, warm_soft, warm_border)) = theme.warm {
                                    (warm_soft, warm_border, warm)
                                } else {
                                    (
                                        Color32::from_rgba_unmultiplied(255, 255, 255, 15),
                                        theme.glass_border,
                                        theme.text_secondary,
                                    )
                                }
                            } else {
                                (
                                    Color32::from_rgba_unmultiplied(255, 255, 255, 15),
                                    theme.glass_border,
                                    theme.text_secondary,
                                )
                            };
                            draw_badge(ui, &meta.secondary_badge, sec_bg, sec_border, sec_fg);
                        });

                        let header_w = row_resp.response.rect.width();

                        // Compute all telemetry galleys first so cells never wrap or collide
                        let mut cell_galleys = Vec::with_capacity(6);
                        let mut grid_w = 0.0_f32;
                        for (idx, cell) in meta.telemetry.iter().enumerate() {
                            let lbl_g = ui
                                .painter()
                                .layout_job(telemetry_label_job(cell.label, cell.unit, theme));
                            let val_g = ui.painter().layout_job(tracked_job(
                                &cell.value,
                                FontId::monospace(11.4),
                                theme.text_primary,
                                0.0,
                            ));
                            let cw = lbl_g.size().x.max(val_g.size().x);
                            grid_w += cw;
                            if idx > 0 {
                                grid_w += 9.5;
                            }
                            cell_galleys.push((lbl_g, val_g, cw));
                        }

                        let content_w = header_w.max(grid_w).max(372.0);

                        // Hairline divider
                        let (div_rect, _) =
                            ui.allocate_exact_size(Vec2::new(content_w, 1.0), Sense::hover());
                        let div_color = if theme.warm.is_some() {
                            Color32::from_rgba_unmultiplied(148, 197, 255, 32)
                        } else {
                            Color32::from_rgba_unmultiplied(255, 255, 255, 18)
                        };
                        ui.painter().line_segment(
                            [div_rect.left_center(), div_rect.right_center()],
                            Stroke::new(1.0, div_color),
                        );

                        // 6-column telemetry grid (explicit non-wrapping galley painting)
                        let (grid_rect, _) =
                            ui.allocate_exact_size(Vec2::new(content_w, 29.0), Sense::hover());
                        let mut cx = grid_rect.left();
                        for (lbl_g, val_g, cw) in cell_galleys {
                            ui.painter().galley(
                                Pos2::new(cx, grid_rect.top()),
                                lbl_g,
                                theme.text_muted,
                            );
                            ui.painter().galley(
                                Pos2::new(cx, grid_rect.top() + 14.0),
                                val_g,
                                theme.text_primary,
                            );
                            cx += cw + 9.5;
                        }
                    });
                    ui.add_space(11.0);
                });

                ui.add_space(9.0);
            });

            let rect = card.response.rect;
            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    rect,
                    12.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg,
                    theme.glass_border,
                ),
            );
        });
}

pub(crate) fn draw_top_right_bar(
    ctx: &Context,
    active_id: SimId,
    hud: &HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    Area::new(Id::unique("hud_top_right"))
        .anchor(Align2::RIGHT_TOP, Vec2::new(-HUD_PAD, HUD_PAD))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            ui.with_layout(egui::Layout::left_to_right(Align::Center), |ui| {
                ui.set_height(36.0);
                ui.spacing_mut().item_spacing = Vec2::new(6.0, 0.0);

                // Compact Observatory Home Button (exact 36x36 aligned to row center)
                let (home_rect, home_resp) =
                    ui.allocate_exact_size(Vec2::new(36.0, 36.0), Sense::click());
                if home_resp.hovered() {
                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                }
                let (home_fill, home_border, home_fg) = if home_resp.hovered() {
                    (
                        Color32::from_rgba_unmultiplied(20, 24, 34, 200),
                        theme.accent_border,
                        theme.accent_bright,
                    )
                } else {
                    (theme.glass_bg, theme.glass_border, theme.text_secondary)
                };
                paint_glass_panel(
                    ui.painter(),
                    home_rect,
                    18.0,
                    screen_size,
                    glass_tex_id,
                    home_fill,
                    home_border,
                );
                draw_home_icon(ui.painter(), home_rect.center(), home_fg);
                if home_resp
                    .on_hover_text("Return to Observatory Home")
                    .clicked()
                {
                    actions.push(HudAction::GoHome);
                }

                // 7-Sim Switcher Glass Pill (exact 36px height: 3px top + 30px pills + 3px bottom)
                let sw_bg = ui.painter().add(Shape::Noop);
                let sw = egui::Frame::NONE
                    .inner_margin(egui::Margin {
                        left: 4,
                        right: 4,
                        top: 3,
                        bottom: 3,
                    })
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(1.5, 0.0);
                        ui.horizontal_centered(|ui| {
                            ui.spacing_mut().item_spacing = Vec2::new(1.5, 0.0);
                            for id in SimId::ALL {
                                let is_curr = id == active_id;
                                let resp = draw_pill_button(
                                    ui,
                                    id.switch_label(),
                                    is_curr,
                                    is_curr,
                                    theme,
                                    30.0,
                                    5.5,
                                    None,
                                    None,
                                );
                                if resp.clicked() && !is_curr {
                                    actions.push(HudAction::SwitchSim(id));
                                }
                            }
                        });
                    });
                ui.painter().set(
                    sw_bg,
                    build_glass_shapes(
                        sw.response.rect,
                        18.0,
                        screen_size,
                        glass_tex_id,
                        theme.glass_bg,
                        theme.glass_border,
                    ),
                );

                // Controls Pill (36px height)
                if draw_standalone_glass_pill(
                    ui,
                    "Controls",
                    hud.drawer_open,
                    theme,
                    screen_size,
                    glass_tex_id,
                    &draw_sliders_icon,
                    None,
                )
                .clicked()
                {
                    actions.push(HudAction::ToggleDrawer);
                }

                // Hide UI Pill (36px height)
                if draw_standalone_glass_pill(
                    ui,
                    "Hide UI",
                    false,
                    theme,
                    screen_size,
                    glass_tex_id,
                    &|p, c, col| draw_eye_icon(p, c, col, true),
                    None,
                )
                .clicked()
                {
                    actions.push(HudAction::ToggleHud);
                }
            });
        });
}
