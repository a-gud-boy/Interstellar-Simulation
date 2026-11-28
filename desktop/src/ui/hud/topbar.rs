use egui::epaint::{CornerRadius, StrokeKind};
use egui::text::{LayoutJob, TextFormat, TextWrapping};
use egui::{
    Align, Align2, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, ScrollArea,
    Sense, Shape, Stroke, TextureId, Vec2,
};

use crate::sims::registry::{SIM_REGISTRY, SimCategory, registry_entry};
use crate::sims::{HudMetadata, SimId, SimTheme};
use crate::ui::theme::{
    HUD_PAD, apply_dark_widget_visuals, build_glass_shapes, draw_badge, draw_chevron_down_icon,
    draw_eye_icon, draw_home_icon, draw_sliders_icon, draw_standalone_glass_pill,
    paint_glass_panel, semibold_family, tracked_job, with_alpha,
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
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let mut trigger_rect: Option<Rect> = None;

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

                // Compact Simulation Selector Pill (fixed width regardless of catalog size)
                let active_entry = registry_entry(active_id);
                let font = FontId::new(12.0, semibold_family());
                let label_galley = ui.painter().layout_job(tracked_job(
                    active_entry.switch_label,
                    font,
                    Color32::PLACEHOLDER,
                    0.25,
                ));
                let pill_w = 12.0 + 13.0 + label_galley.size().x + 20.0 + 10.0;
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(pill_w, 36.0), Sense::click());
                if resp.hovered() {
                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                }
                let (fill, border, fg, chev_col) = if hud.switcher_open {
                    (
                        with_alpha(theme.accent_soft, 210),
                        theme.accent_border,
                        theme.accent_bright,
                        theme.accent_bright,
                    )
                } else if resp.hovered() {
                    (
                        Color32::from_rgba_unmultiplied(20, 24, 34, 200),
                        theme.glass_border_strong,
                        theme.text_primary,
                        theme.text_primary,
                    )
                } else {
                    (
                        theme.glass_bg,
                        theme.glass_border,
                        theme.text_primary,
                        theme.text_secondary,
                    )
                };
                paint_glass_panel(
                    ui.painter(),
                    rect,
                    18.0,
                    screen_size,
                    glass_tex_id,
                    fill,
                    border,
                );

                let cy = rect.center().y;
                let dot_center = Pos2::new(rect.left() + 15.0, cy);
                let dot_col = if let Some((warm, _, _)) = theme.warm {
                    warm
                } else {
                    theme.accent
                };
                ui.painter()
                    .circle_filled(dot_center, 5.2, with_alpha(dot_col, 64));
                ui.painter().circle_filled(dot_center, 3.0, dot_col);

                let text_x = rect.left() + 25.0;
                let lw = label_galley.size().x;
                ui.painter().galley_with_override_text_color(
                    Pos2::new(text_x, cy - label_galley.size().y * 0.5),
                    label_galley,
                    fg,
                );
                draw_chevron_down_icon(
                    ui.painter(),
                    Pos2::new(text_x + lw + 10.0, cy),
                    chev_col,
                    hud.switcher_open,
                );
                if resp.clicked() {
                    actions.push(HudAction::ToggleSwitcher);
                }
                trigger_rect = Some(rect);

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

    if hud.switcher_open
        && let Some(t_rect) = trigger_rect
    {
        draw_sim_switcher_popover(
            ctx,
            active_id,
            t_rect,
            hud,
            theme,
            screen_size,
            glass_tex_id,
            actions,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_sim_switcher_popover(
    ctx: &Context,
    active_id: SimId,
    trigger_rect: Rect,
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let pop_w = 340.0_f32.min((screen_size.x - HUD_PAD * 2.0).max(220.0));
    let pop_x = (trigger_rect.right() - pop_w)
        .clamp(HUD_PAD, (screen_size.x - HUD_PAD - pop_w).max(HUD_PAD));
    let pop_y = trigger_rect.bottom() + 8.0;
    let max_list_h = (screen_size.y - pop_y - HUD_PAD - 96.0).clamp(160.0, 440.0);

    let area_resp = Area::new(Id::unique("hud_sim_switcher_popover"))
        .fixed_pos(Pos2::new(pop_x, pop_y))
        .order(Order::Foreground)
        .fade_in(false)
        .show(ctx, |ui| {
            apply_dark_widget_visuals(ui, theme);
            let bg_slot = ui.painter().add(Shape::Noop);
            let inner = ui.scope(|ui| {
                ui.set_min_width(pop_w);
                ui.set_max_width(pop_w);
                ui.spacing_mut().item_spacing = Vec2::ZERO;

                // Header + Filter Input
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    ui.vertical(|ui| {
                        let inner_w = pop_w - 24.0;
                        ui.set_min_width(inner_w);
                        ui.set_max_width(inner_w);
                        ui.spacing_mut().item_spacing = Vec2::new(0.0, 7.0);

                        ui.horizontal(|ui| {
                            ui.set_width(inner_w);
                            ui.label(tracked_job(
                                "SIMULATIONS",
                                FontId::new(10.5, semibold_family()),
                                theme.text_primary,
                                1.2,
                            ));
                            ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                                ui.label(tracked_job(
                                    &format!("{} engines", SIM_REGISTRY.len()),
                                    FontId::proportional(10.5),
                                    theme.text_muted,
                                    0.1,
                                ));
                            });
                        });

                        let edit_resp = ui.add(
                            egui::TextEdit::singleline(&mut hud.switcher_query)
                                .hint_text("Filter simulations…")
                                .desired_width(inner_w)
                                .margin(egui::Margin::symmetric(10, 6)),
                        );
                        if hud.switcher_focus_search {
                            edit_resp.request_focus();
                            hud.switcher_focus_search = false;
                        }
                    });
                    ui.add_space(12.0);
                });
                ui.add_space(10.0);

                // Divider
                let (div_rect, _) = ui.allocate_exact_size(Vec2::new(pop_w, 1.0), Sense::hover());
                ui.painter().line_segment(
                    [div_rect.left_center(), div_rect.right_center()],
                    Stroke::new(1.0, theme.glass_border),
                );

                // Categorized Scrollable List
                let query = hud.switcher_query.trim().to_ascii_lowercase();
                let mut first_match: Option<SimId> = None;
                let mut any_visible = false;
                let mut close_after_click = false;

                ScrollArea::vertical()
                    .id_salt("sim_switcher_scroll")
                    .max_height(max_list_h)
                    .auto_shrink([false, true])
                    .show(ui, |ui| {
                        ui.add_space(6.0);
                        let row_w = (pop_w - 16.0).max(160.0);
                        let mut first_group = true;

                        for cat in SimCategory::ALL {
                            let matches: Vec<_> = SIM_REGISTRY
                                .iter()
                                .filter(|entry| {
                                    if entry.category != cat {
                                        return false;
                                    }
                                    if query.is_empty() {
                                        return true;
                                    }
                                    entry.switch_label.to_ascii_lowercase().contains(&query)
                                        || entry.title.to_ascii_lowercase().contains(&query)
                                        || entry.tagline.to_ascii_lowercase().contains(&query)
                                        || entry
                                            .category_label
                                            .to_ascii_lowercase()
                                            .contains(&query)
                                        || entry.aliases.iter().any(|a| a.contains(&query))
                                })
                                .collect();

                            if matches.is_empty() {
                                continue;
                            }
                            any_visible = true;

                            ui.horizontal(|ui| {
                                ui.add_space(8.0);
                                ui.vertical(|ui| {
                                    ui.set_min_width(row_w);
                                    ui.set_max_width(row_w);
                                    ui.spacing_mut().item_spacing = Vec2::new(0.0, 2.0);

                                    if !first_group {
                                        ui.add_space(4.0);
                                        let (gdiv, _) = ui.allocate_exact_size(
                                            Vec2::new(row_w, 1.0),
                                            Sense::hover(),
                                        );
                                        ui.painter().line_segment(
                                            [gdiv.left_center(), gdiv.right_center()],
                                            Stroke::new(
                                                1.0,
                                                Color32::from_rgba_unmultiplied(255, 255, 255, 20),
                                            ),
                                        );
                                        ui.add_space(5.0);
                                    }
                                    first_group = false;

                                    let cat_job = tracked_job(
                                        &cat.label().to_ascii_uppercase(),
                                        FontId::new(9.8, semibold_family()),
                                        theme.text_muted,
                                        0.9,
                                    );
                                    let (cat_rect, _) = ui.allocate_exact_size(
                                        Vec2::new(row_w, 18.0),
                                        Sense::hover(),
                                    );
                                    let cat_g = ui.painter().layout_job(cat_job);
                                    ui.painter().galley(
                                        Pos2::new(
                                            cat_rect.left() + 8.0,
                                            cat_rect.center().y - cat_g.size().y * 0.5,
                                        ),
                                        cat_g,
                                        theme.text_muted,
                                    );

                                    for entry in matches {
                                        first_match.get_or_insert(entry.id);
                                        let is_curr = entry.id == active_id;
                                        let (row_rect, row_resp) = ui.allocate_exact_size(
                                            Vec2::new(row_w, 44.0),
                                            Sense::click(),
                                        );
                                        if row_resp.hovered() {
                                            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                        }

                                        let (bg, border) = if is_curr {
                                            (theme.accent_soft, theme.accent_border)
                                        } else if row_resp.hovered() {
                                            (
                                                Color32::from_rgba_unmultiplied(255, 255, 255, 20),
                                                Color32::TRANSPARENT,
                                            )
                                        } else {
                                            (Color32::TRANSPARENT, Color32::TRANSPARENT)
                                        };
                                        ui.painter().rect(
                                            row_rect,
                                            CornerRadius::same(8),
                                            bg,
                                            Stroke::new(1.0, border),
                                            StrokeKind::Inside,
                                        );

                                        let entry_accent = Color32::from_rgb(
                                            entry.accent_rgb[0],
                                            entry.accent_rgb[1],
                                            entry.accent_rgb[2],
                                        );
                                        let dot_pos = Pos2::new(
                                            row_rect.left() + 13.0,
                                            row_rect.top() + 15.0,
                                        );
                                        if is_curr {
                                            ui.painter().circle_filled(
                                                dot_pos,
                                                5.5,
                                                with_alpha(theme.accent, 68),
                                            );
                                            ui.painter().circle_filled(dot_pos, 3.3, theme.accent);
                                        } else {
                                            ui.painter().circle_filled(dot_pos, 3.3, entry_accent);
                                        }

                                        let text_left = row_rect.left() + 25.0;
                                        let title_col = if is_curr {
                                            theme.accent_bright
                                        } else {
                                            theme.text_primary
                                        };
                                        let title_g = ui.painter().layout_job(tracked_job(
                                            entry.switch_label,
                                            FontId::new(12.0, semibold_family()),
                                            title_col,
                                            0.15,
                                        ));
                                        ui.painter().galley(
                                            Pos2::new(text_left, row_rect.top() + 7.0),
                                            title_g,
                                            title_col,
                                        );

                                        if is_curr {
                                            let tag_g = ui.painter().layout_job(tracked_job(
                                                "ACTIVE",
                                                FontId::new(9.0, semibold_family()),
                                                theme.accent_bright,
                                                0.55,
                                            ));
                                            let tw = tag_g.size().x + 12.0;
                                            let tag_rect = Rect::from_min_size(
                                                Pos2::new(
                                                    row_rect.right() - tw - 8.0,
                                                    row_rect.top() + 6.5,
                                                ),
                                                Vec2::new(tw, 16.0),
                                            );
                                            ui.painter().rect(
                                                tag_rect,
                                                CornerRadius::same(8),
                                                theme.accent_soft,
                                                Stroke::new(1.0, theme.accent_border),
                                                StrokeKind::Inside,
                                            );
                                            ui.painter().galley(
                                                Pos2::new(
                                                    tag_rect.left() + 6.0,
                                                    tag_rect.center().y - tag_g.size().y * 0.5,
                                                ),
                                                tag_g,
                                                theme.accent_bright,
                                            );
                                        }

                                        let mut tag_job = LayoutJob {
                                            wrap: TextWrapping {
                                                max_width: (row_rect.right() - text_left - 10.0)
                                                    .max(40.0),
                                                max_rows: 1,
                                                break_anywhere: true,
                                                overflow_character: Some('…'),
                                            },
                                            ..Default::default()
                                        };
                                        tag_job.append(
                                            entry.tagline,
                                            0.0,
                                            TextFormat {
                                                font_id: FontId::proportional(10.8),
                                                color: theme.text_muted,
                                                ..Default::default()
                                            },
                                        );
                                        let tagline_g = ui.painter().layout_job(tag_job);
                                        ui.painter().galley(
                                            Pos2::new(text_left, row_rect.top() + 24.0),
                                            tagline_g,
                                            theme.text_muted,
                                        );

                                        if row_resp.clicked() {
                                            close_after_click = true;
                                            if !is_curr {
                                                actions.push(HudAction::SwitchSim(entry.id));
                                            }
                                        }
                                    }
                                });
                                ui.add_space(8.0);
                            });
                        }

                        if !any_visible {
                            ui.add_space(12.0);
                            ui.centered_and_justified(|ui| {
                                ui.label(tracked_job(
                                    "No matching simulations",
                                    FontId::proportional(11.8),
                                    theme.text_muted,
                                    0.1,
                                ));
                            });
                            ui.add_space(12.0);
                        }

                        ui.add_space(6.0);
                    });

                if close_after_click {
                    hud.switcher_open = false;
                    hud.switcher_query.clear();
                    hud.switcher_focus_search = false;
                } else if !query.is_empty()
                    && ctx.input(|i| i.key_pressed(egui::Key::Enter))
                    && let Some(target_id) = first_match
                {
                    hud.switcher_open = false;
                    hud.switcher_query.clear();
                    hud.switcher_focus_search = false;
                    if target_id != active_id {
                        actions.push(HudAction::SwitchSim(target_id));
                    }
                }
            });

            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    inner.response.rect,
                    12.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg_elevated,
                    theme.glass_border_strong,
                ),
            );
        });

    let pop_rect = area_resp.response.rect;
    let esc_pressed = ctx.input(|i| i.key_pressed(egui::Key::Escape));
    let clicked_outside = !hud.switcher_just_opened
        && ctx.input(|i| {
            i.pointer.any_pressed()
                && i.pointer
                    .interact_pos()
                    .is_some_and(|p| !pop_rect.contains(p) && !trigger_rect.contains(p))
        });
    if esc_pressed || clicked_outside {
        hud.switcher_open = false;
        hud.switcher_query.clear();
        hud.switcher_focus_search = false;
    }
    hud.switcher_just_opened = false;
}
