mod widgets;

use egui::epaint::{CornerRadius, StrokeKind};
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, ScrollArea, Sense,
    Stroke, TextureId, Vec2,
};

use crate::renderer::SharedGpuAssets;
use crate::sims::{ControlKind, HudMetadata, SimTheme, Simulation};
use crate::ui::theme::{
    DRAWER_WIDTH, HUD_PAD, apply_dark_widget_visuals, draw_chevron_icon, draw_close_icon,
    paint_glass_panel, semibold_family, tracked_job, with_alpha,
};
use crate::ui::{HudAction, HudState};
use widgets::{draw_custom_slider, draw_segmented_control, draw_select_control};

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_controls_drawer(
    ctx: &Context,
    sim: &mut dyn Simulation,
    meta: &HudMetadata,
    assets: &SharedGpuAssets,
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let top_y = HUD_PAD + 46.0;
    let bot_y = (screen_size.y - HUD_PAD - 64.0).max(top_y + 220.0);
    let drawer_rect = Rect::from_min_max(
        Pos2::new((screen_size.x - HUD_PAD - DRAWER_WIDTH).max(HUD_PAD), top_y),
        Pos2::new(screen_size.x - HUD_PAD, bot_y),
    );

    Area::new(Id::unique("hud_controls_drawer"))
        .fixed_pos(drawer_rect.min)
        .order(Order::Foreground)
        .show(ctx, |ui| {
            apply_dark_widget_visuals(ui, theme);
            ui.set_min_size(drawer_rect.size());
            ui.set_max_size(drawer_rect.size());

            paint_glass_panel(
                ui.painter(),
                drawer_rect,
                12.0,
                screen_size,
                glass_tex_id,
                theme.glass_bg_elevated,
                theme.glass_border,
            );

            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing = Vec2::ZERO;

                // Drawer Header
                let header_h = 56.0;
                let (h_rect, _) =
                    ui.allocate_exact_size(Vec2::new(drawer_rect.width(), header_h), Sense::hover());

                let title_galley = ui.painter().layout_job(tracked_job(
                    &meta.drawer_title.to_uppercase(),
                    FontId::new(12.0, semibold_family()),
                    theme.text_primary,
                    1.4,
                ));
                let sub_color = if let Some((warm, _, _)) = theme.warm {
                    warm
                } else {
                    theme.text_secondary
                };
                let sub_galley = ui.painter().layout_job(tracked_job(
                    &meta.drawer_subtitle,
                    FontId::monospace(10.8),
                    sub_color,
                    0.0,
                ));
                ui.painter().galley(
                    Pos2::new(h_rect.left() + 14.0, h_rect.top() + 11.0),
                    title_galley,
                    theme.text_primary,
                );
                ui.painter().galley(
                    Pos2::new(h_rect.left() + 14.0, h_rect.top() + 29.0),
                    sub_galley,
                    sub_color,
                );

                // Close [×] button
                let close_rect = Rect::from_center_size(
                    Pos2::new(h_rect.right() - 29.0, h_rect.center().y),
                    Vec2::new(30.0, 30.0),
                );
                let close_resp = ui.interact(
                    close_rect,
                    ui.scope_id().with("drawer_close"),
                    Sense::click(),
                );
                if close_resp.hovered() {
                    ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                }
                ui.painter().rect(
                    close_rect,
                    CornerRadius::same(8),
                    if close_resp.hovered() {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 30)
                    } else {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 13)
                    },
                    Stroke::new(
                        1.0,
                        if close_resp.hovered() {
                            theme.glass_border
                        } else {
                            Color32::TRANSPARENT
                        },
                    ),
                    StrokeKind::Inside,
                );
                draw_close_icon(
                    ui.painter(),
                    close_rect.center(),
                    if close_resp.hovered() {
                        theme.text_primary
                    } else {
                        theme.text_secondary
                    },
                );
                if close_resp.clicked() {
                    actions.push(HudAction::ToggleDrawer);
                }

                ui.painter().line_segment(
                    [h_rect.left_bottom(), h_rect.right_bottom()],
                    Stroke::new(1.0, theme.glass_border),
                );

                // Scrollable Body
                let footer_h = 30.0;
                let scroll_h = (drawer_rect.height() - header_h - footer_h).max(80.0);
                let sections = sim.control_sections();
                let section_count = sections.len();

                ui.allocate_ui_with_layout(
                    Vec2::new(drawer_rect.width(), scroll_h),
                    egui::Layout::top_down(Align::LEFT),
                    |ui| {
                        ScrollArea::vertical()
                            .id_salt("controls_drawer_scroll")
                            .auto_shrink([false, false])
                            .max_height(scroll_h)
                            .show(ui, |ui| {
                                ui.add_space(6.0);
                                let inner_w = drawer_rect.width() - 28.0;

                                for (sec_idx, section) in sections.iter().enumerate() {
                                    let is_open = *hud
                                        .open_sections
                                        .entry(section.id)
                                        .or_insert(section.default_open);

                                    ui.horizontal(|ui| {
                                        ui.add_space(14.0);
                                        ui.vertical(|ui| {
                                            ui.set_min_width(inner_w);
                                            ui.set_max_width(inner_w);
                                            ui.spacing_mut().item_spacing.y = 6.0;

                                            // Collapsible Section Header
                                            let (sec_hdr, sec_resp) = ui.allocate_exact_size(
                                                Vec2::new(inner_w, 30.0),
                                                Sense::click(),
                                            );
                                            if sec_resp.hovered() {
                                                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                                            }
                                            let sec_title = ui.painter().layout_job(tracked_job(
                                                &section.title.to_uppercase(),
                                                FontId::new(11.0, semibold_family()),
                                                theme.accent_bright,
                                                1.2,
                                            ));
                                            ui.painter().galley(
                                                Pos2::new(
                                                    sec_hdr.left(),
                                                    sec_hdr.center().y - sec_title.size().y * 0.5,
                                                ),
                                                sec_title,
                                                theme.accent_bright,
                                            );
                                            draw_chevron_icon(
                                                ui.painter(),
                                                Pos2::new(sec_hdr.right() - 8.0, sec_hdr.center().y),
                                                with_alpha(theme.accent_bright, 210),
                                                is_open,
                                            );
                                            if sec_resp.clicked() {
                                                hud.open_sections.insert(section.id, !is_open);
                                            }

                                            if is_open {
                                                for item in &section.items {
                                                    match &item.kind {
                                                        ControlKind::Range {
                                                            min,
                                                            max,
                                                            step,
                                                            hints,
                                                        } => {
                                                            if let Some(reset) = draw_custom_slider(
                                                                ui,
                                                                sim,
                                                                item.key,
                                                                item.label,
                                                                *min,
                                                                *max,
                                                                *step,
                                                                *hints,
                                                                theme,
                                                            ) {
                                                                actions.push(
                                                                    HudAction::ControlChanged {
                                                                        reset_primary: reset,
                                                                        resolution_changed: false,
                                                                    },
                                                                );
                                                            }
                                                        }
                                                        ControlKind::Select { options } => {
                                                            if let Some(reset) =
                                                                draw_select_control(
                                                                    ui,
                                                                    sim,
                                                                    item.key,
                                                                    item.label,
                                                                    options,
                                                                    inner_w,
                                                                    theme,
                                                                )
                                                            {
                                                                actions.push(
                                                                    HudAction::ControlChanged {
                                                                        reset_primary: reset,
                                                                        resolution_changed: false,
                                                                    },
                                                                );
                                                            }
                                                        }
                                                        ControlKind::Segmented { options } => {
                                                            let curr = sim.get_i32(item.key);
                                                            if let Some(next_val) =
                                                                draw_segmented_control(
                                                                    ui,
                                                                    item.label,
                                                                    options,
                                                                    curr,
                                                                    theme,
                                                                )
                                                            {
                                                                let reset =
                                                                    sim.set_i32(item.key, next_val);
                                                                let res_changed = item.key
                                                                    == "resolutionScale";
                                                                actions.push(
                                                                    HudAction::ControlChanged {
                                                                        reset_primary: reset,
                                                                        resolution_changed:
                                                                            res_changed,
                                                                    },
                                                                );
                                                            }
                                                        }
                                                    }
                                                    ui.add_space(3.0);
                                                }

                                                // Add Native Present Mode control at end of optics section
                                                if sec_idx + 1 == section_count {
                                                    let curr_vsync = i32::from(hud.vsync);
                                                    if let Some(next_vsync) =
                                                        draw_segmented_control(
                                                            ui,
                                                            "Present Mode",
                                                            &[(1, "VSync"), (0, "165 FPS Cap")],
                                                            curr_vsync,
                                                            theme,
                                                        )
                                                    {
                                                        actions.push(HudAction::SetVsync(
                                                            next_vsync != 0,
                                                        ));
                                                    }
                                                }
                                            }

                                            ui.add_space(4.0);
                                            if sec_idx + 1 < section_count {
                                                let (d_rect, _) = ui.allocate_exact_size(
                                                    Vec2::new(inner_w, 1.0),
                                                    Sense::hover(),
                                                );
                                                ui.painter().line_segment(
                                                    [d_rect.left_center(), d_rect.right_center()],
                                                    Stroke::new(
                                                        1.0,
                                                        Color32::from_rgba_unmultiplied(
                                                            255, 255, 255, 20,
                                                        ),
                                                    ),
                                                );
                                            }
                                        });
                                        ui.add_space(14.0);
                                    });
                                }
                            });
                    },
                );

                // Drawer Footer
                let (f_rect, _) =
                    ui.allocate_exact_size(Vec2::new(drawer_rect.width(), footer_h), Sense::hover());
                ui.painter().line_segment(
                    [f_rect.left_top(), f_rect.right_top()],
                    Stroke::new(1.0, theme.glass_border),
                );
                let ver_text = format!("v{}", crate::APP_VERSION);
                let ver_galley = ui.painter().layout_job(tracked_job(
                    &ver_text,
                    FontId::monospace(9.5),
                    theme.text_muted,
                    0.0,
                ));
                let ver_w = ver_galley.size().x;
                let mut f_job = tracked_job(
                    &assets.adapter_label,
                    FontId::proportional(10.0),
                    theme.text_muted,
                    0.0,
                );
                f_job.wrap.max_width = (drawer_rect.width() - 28.0 - ver_w - 10.0).max(40.0);
                f_job.wrap.max_rows = 1;
                let f_galley = ui.painter().layout_job(f_job);
                ui.painter().galley(
                    Pos2::new(f_rect.left() + 14.0, f_rect.center().y - f_galley.size().y * 0.5),
                    f_galley,
                    theme.text_muted,
                );
                ui.painter().galley(
                    Pos2::new(
                        f_rect.right() - 14.0 - ver_w,
                        f_rect.center().y - ver_galley.size().y * 0.5,
                    ),
                    ver_galley,
                    theme.text_muted,
                );
            });
        });
}
