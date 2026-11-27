use egui::epaint::CornerRadius;
use egui::{
    Align, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Stroke,
    StrokeKind, Vec2,
};

use super::{
    CATALOG, CatalogEntry, CategoryFilter, HomeAction, HomeState, TEXT_MUTED, TEXT_PRIMARY,
    TEXT_SECONDARY, glass_card, paint_vertical_gradient,
};
use crate::ui::theme::{semibold_family, tracked_job, with_alpha};

pub(super) fn draw_filmstrip_dock(
    ctx: &Context,
    screen: Rect,
    pad_x: f32,
    dock_top_y: f32,
    card_size: Vec2,
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
                    let (card_rect, card_resp) = ui.allocate_exact_size(card_size, Sense::click());
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
                    let inner_rect = card_rect.shrink(1.0);
                    if let Some(tex) = state.previews.get(item.sim) {
                        let tint = if is_active || card_resp.hovered() {
                            Color32::WHITE
                        } else {
                            Color32::from_rgba_unmultiplied(210, 218, 230, 200)
                        };
                        ui.painter().image(
                            tex.id(),
                            inner_rect,
                            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                            tint,
                        );
                    } else {
                        paint_vertical_gradient(
                            ui.painter(),
                            inner_rect,
                            &[
                                (0.0, with_alpha(item.accent, 34)),
                                (0.55, Color32::from_rgb(7, 10, 18)),
                                (1.0, Color32::from_rgb(3, 5, 10)),
                            ],
                        );
                    }

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
                        ui.painter()
                            .rect_filled(bar, CornerRadius::same(2), item.accent_bright);
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
                            Pos2::new(
                                a_rect.left() + 5.0,
                                a_rect.center().y - act_g.size().y * 0.5,
                            ),
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
                        Pos2::new(
                            go_center.x - go_g.size().x * 0.5,
                            go_center.y - go_g.size().y * 0.5,
                        ),
                        go_g,
                        arrow_fg,
                    );

                    // Bottom-left title + metric (clamped before the bottom-right launch button)
                    let max_text_w = (card_rect.width() - 38.0).max(40.0);
                    let fit_job = |text: &str, font: FontId, color: Color32, spacing: f32| {
                        let full = ui.painter().layout_job(tracked_job(
                            text,
                            font.clone(),
                            color,
                            spacing,
                        ));
                        if full.size().x <= max_text_w {
                            return full;
                        }
                        let chars: Vec<char> = text.chars().collect();
                        let mut hi = chars.len();
                        while hi > 1 {
                            hi -= 1;
                            let candidate: String = chars[..hi].iter().collect::<String>() + "…";
                            let g = ui.painter().layout_job(tracked_job(
                                &candidate,
                                font.clone(),
                                color,
                                spacing,
                            ));
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

                    if card_resp.double_clicked() || (card_resp.clicked() && pointer_near_go) {
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
