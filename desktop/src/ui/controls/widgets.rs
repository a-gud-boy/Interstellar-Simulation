use egui::epaint::{CornerRadius, StrokeKind};
use egui::{Color32, CursorIcon, FontId, Pos2, Rect, Sense, Stroke, Ui, Vec2};

use crate::sims::{SimTheme, Simulation};
use crate::ui::theme::{apply_dark_widget_visuals, semibold_family, tracked_job, with_alpha};

#[allow(clippy::too_many_arguments)]
pub(super) fn draw_custom_slider(
    ui: &mut Ui,
    sim: &mut dyn Simulation,
    key: &str,
    label: &str,
    min: f32,
    max: f32,
    step: f32,
    hints: Option<[&'static str; 2]>,
    theme: &SimTheme,
) -> Option<bool> {
    let mut val = sim.get_f32(key).clamp(min, max);
    let formatted = sim.format_value(key);

    ui.horizontal(|ui| {
        let lbl_galley = ui.painter().layout_job(tracked_job(
            label,
            FontId::proportional(12.0),
            theme.text_primary,
            0.0,
        ));
        let val_galley = ui.painter().layout_job(tracked_job(
            &formatted,
            FontId::monospace(11.5),
            theme.accent_bright,
            0.0,
        ));
        let w = ui.available_width();
        let (row_rect, _) = ui.allocate_exact_size(Vec2::new(w, 16.0), Sense::hover());
        ui.painter().galley(
            Pos2::new(
                row_rect.left(),
                row_rect.center().y - lbl_galley.size().y * 0.5,
            ),
            lbl_galley,
            theme.text_primary,
        );
        ui.painter().galley(
            Pos2::new(
                row_rect.right() - val_galley.size().x,
                row_rect.center().y - val_galley.size().y * 0.5,
            ),
            val_galley,
            theme.accent_bright,
        );
    });

    let track_w = ui.available_width();
    let (hit_rect, resp) =
        ui.allocate_exact_size(Vec2::new(track_w, 22.0), Sense::click_and_drag());
    if resp.hovered() || resp.dragged() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }

    let thumb_r = 6.5_f32;
    let span_x0 = hit_rect.left() + thumb_r;
    let span_x1 = (hit_rect.right() - thumb_r).max(span_x0 + 1.0);
    let mut changed_reset = None;

    if (resp.clicked() || resp.dragged())
        && step > 0.0
        && let Some(pos) = resp.interact_pointer_pos()
    {
        let t = ((pos.x - span_x0) / (span_x1 - span_x0)).clamp(0.0, 1.0);
        let raw = min + t * (max - min);
        let stepped = ((raw / step).round() * step).clamp(min, max);
        if (stepped - val).abs() > step * 1e-3 {
            val = stepped;
            changed_reset = Some(sim.set_f32(key, stepped));
        }
    }

    let t = if max > min {
        ((val - min) / (max - min)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let thumb_x = span_x0 + t * (span_x1 - span_x0);
    let cy = hit_rect.center().y;

    let track_rect = Rect::from_min_max(
        Pos2::new(hit_rect.left(), cy - 2.0),
        Pos2::new(hit_rect.right(), cy + 2.0),
    );
    ui.painter()
        .rect_filled(track_rect, CornerRadius::same(2), theme.slider_track);

    let fill_rect = Rect::from_min_max(
        Pos2::new(hit_rect.left(), cy - 2.0),
        Pos2::new(thumb_x.max(hit_rect.left()), cy + 2.0),
    );
    ui.painter()
        .rect_filled(fill_rect, CornerRadius::same(2), theme.accent);

    if resp.hovered() || resp.dragged() {
        ui.painter()
            .circle_filled(Pos2::new(thumb_x, cy), 9.5, with_alpha(theme.accent, 68));
    }
    ui.painter().circle(
        Pos2::new(thumb_x, cy),
        thumb_r,
        Color32::from_rgb(0xf8, 0xfa, 0xfc),
        Stroke::new(1.5, theme.accent),
    );

    if let Some([h0, h1]) = hints {
        let g0 = ui.painter().layout_job(tracked_job(
            h0,
            FontId::proportional(10.0),
            theme.text_muted,
            0.0,
        ));
        let g1 = ui.painter().layout_job(tracked_job(
            h1,
            FontId::proportional(10.0),
            theme.text_muted,
            0.0,
        ));
        let (h_rect, _) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 13.0), Sense::hover());
        ui.painter().galley(h_rect.left_top(), g0, theme.text_muted);
        ui.painter().galley(
            Pos2::new(h_rect.right() - g1.size().x, h_rect.top()),
            g1,
            theme.text_muted,
        );
    }

    changed_reset
}

pub(super) fn draw_segmented_control(
    ui: &mut Ui,
    label: &str,
    options: &[(i32, &'static str)],
    current_val: i32,
    theme: &SimTheme,
) -> Option<i32> {
    let lbl = ui.painter().layout_job(tracked_job(
        label,
        FontId::proportional(12.0),
        theme.text_primary,
        0.0,
    ));
    ui.label(lbl);
    ui.add_space(2.0);

    let avail_w = ui.available_width();
    let count = options.len().max(1);
    let total_h = 34.0;
    let (outer_rect, _) = ui.allocate_exact_size(Vec2::new(avail_w, total_h), Sense::hover());
    ui.painter().rect(
        outer_rect,
        CornerRadius::same(8),
        Color32::from_rgba_unmultiplied(255, 255, 255, 10),
        Stroke::new(1.0, theme.glass_border),
        StrokeKind::Inside,
    );

    let gap = 4.0;
    let pad = 3.0;
    let inner_w = (avail_w - pad * 2.0 - gap * (count as f32 - 1.0)).max(20.0);
    let btn_w = inner_w / count as f32;
    let btn_h = total_h - pad * 2.0;

    let mut chosen = None;
    for (idx, (val, opt_label)) in options.iter().enumerate() {
        let bx = outer_rect.left() + pad + idx as f32 * (btn_w + gap);
        let btn_rect = Rect::from_min_size(
            Pos2::new(bx, outer_rect.top() + pad),
            Vec2::new(btn_w, btn_h),
        );
        let resp = ui.interact(
            btn_rect,
            ui.scope_id().with(("seg", label, *val)),
            Sense::click(),
        );
        if resp.hovered() {
            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        }

        let active = *val == current_val;
        let (fill, border, fg) = if active {
            (theme.accent_soft, theme.accent_border, theme.accent_bright)
        } else if resp.hovered() {
            (
                Color32::from_rgba_unmultiplied(255, 255, 255, 15),
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
            btn_rect,
            CornerRadius::same(6),
            fill,
            Stroke::new(1.0, border),
            StrokeKind::Inside,
        );
        let g = ui.painter().layout_job(tracked_job(
            opt_label,
            FontId::new(11.3, semibold_family()),
            fg,
            0.0,
        ));
        ui.painter().galley(
            Pos2::new(
                btn_rect.center().x - g.size().x * 0.5,
                btn_rect.center().y - g.size().y * 0.5,
            ),
            g,
            fg,
        );

        if resp.clicked() && !active {
            chosen = Some(*val);
        }
    }

    chosen
}

pub(super) fn draw_select_control(
    ui: &mut Ui,
    sim: &mut dyn Simulation,
    key: &str,
    label: &str,
    options: &[(i32, &'static str)],
    width: f32,
    theme: &SimTheme,
) -> Option<bool> {
    let lbl = ui.painter().layout_job(tracked_job(
        label,
        FontId::proportional(12.0),
        theme.text_primary,
        0.0,
    ));
    ui.label(lbl);
    let curr = sim.get_i32(key);
    let curr_text = options
        .iter()
        .find(|(v, _)| *v == curr)
        .map(|(_, l)| *l)
        .unwrap_or("Select");
    let mut changed_reset = None;
    egui::ComboBox::from_id_salt(("sel", sim.id(), key))
        .width(width)
        .selected_text(curr_text)
        .show_ui(ui, |ui| {
            apply_dark_widget_visuals(ui, theme);
            for (v, opt_label) in options {
                if ui.selectable_label(curr == *v, *opt_label).clicked() && curr != *v {
                    changed_reset = Some(sim.set_i32(key, *v));
                }
            }
        });
    changed_reset
}
