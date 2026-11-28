use egui::epaint::CornerRadius;
use egui::{
    Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Stroke, TextureId,
    Vec2,
};

use crate::renderer::profiler::PassTimingsSnapshot;
use crate::sims::SimTheme;
use crate::ui::HudAction;
use crate::ui::theme::{HUD_PAD, paint_glass_panel, semibold_family, tracked_job, with_alpha};

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_gpu_profiler_card(
    ctx: &Context,
    snap: &PassTimingsSnapshot,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    let card_w = 276.0_f32;
    let card_h = 186.0_f32;
    let pos = Pos2::new(HUD_PAD, HUD_PAD + 114.0);
    let rect = Rect::from_min_size(pos, Vec2::new(card_w, card_h));

    Area::new(Id::unique("hud_gpu_profiler"))
        .fixed_pos(pos)
        .order(Order::Foreground)
        .show(ctx, |ui| {
            ui.set_min_size(rect.size());
            ui.set_max_size(rect.size());

            paint_glass_panel(
                ui.painter(),
                rect,
                12.0,
                screen_size,
                glass_tex_id,
                theme.glass_bg_elevated,
                theme.glass_border_strong,
            );

            let p = ui.painter();
            let left = rect.left() + 12.0;
            let right = rect.right() - 12.0;
            let mut y = rect.top() + 10.0;

            let title = p.layout_job(tracked_job(
                "GPU PASS PROFILER",
                FontId::new(9.5, semibold_family()),
                theme.accent_bright,
                1.3,
            ));
            p.galley(Pos2::new(left, y), title, theme.accent_bright);

            let total_text = format!("{:.2} ms", snap.total_ms);
            let total_g = p.layout_job(tracked_job(
                &total_text,
                FontId::monospace(12.0),
                theme.text_primary,
                0.0,
            ));
            p.galley(
                Pos2::new(right - 24.0 - total_g.size().x, y - 1.0),
                total_g,
                theme.text_primary,
            );

            let close_rect =
                Rect::from_center_size(Pos2::new(right - 8.0, y + 6.0), Vec2::new(18.0, 18.0));
            let close_resp = ui.interact(close_rect, Id::unique("gp_close_btn"), Sense::click());
            if close_resp.hovered() {
                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
            }
            p.circle_filled(
                close_rect.center(),
                8.5,
                Color32::from_rgba_unmultiplied(
                    255,
                    255,
                    255,
                    if close_resp.hovered() { 34 } else { 14 },
                ),
            );
            let xg = p.layout_job(tracked_job(
                "×",
                FontId::proportional(11.0),
                theme.text_secondary,
                0.0,
            ));
            p.galley(
                Pos2::new(
                    close_rect.center().x - xg.size().x * 0.5,
                    close_rect.center().y - xg.size().y * 0.5,
                ),
                xg,
                theme.text_secondary,
            );
            if close_resp.clicked() {
                actions.push(HudAction::ToggleProfiler);
            }

            y += 14.0;
            let badge_txt = if snap.hardware_supported {
                "WGPU · TIMESTAMP QUERY"
            } else {
                "WGPU · CPU FALLBACK"
            };
            let bg_g = p.layout_job(tracked_job(
                badge_txt,
                FontId::monospace(9.0),
                theme.text_muted,
                0.3,
            ));
            p.galley(Pos2::new(left, y), bg_g, theme.text_muted);
            y += 16.0;

            let denom = snap.total_ms.max(1.0);
            let rows = [
                ("Raymarch", snap.raymarch_ms, theme.accent),
                ("TAA", snap.taa_ms, Color32::from_rgb(0x38, 0xbd, 0xf8)),
                (
                    "Bloom + Flare",
                    snap.bloom_ms,
                    Color32::from_rgb(0xa7, 0x8b, 0xfa),
                ),
                (
                    "AgX Comp",
                    snap.composite_ms,
                    Color32::from_rgb(0x2d, 0xd4, 0xbf),
                ),
            ];

            for (label, val, col) in rows {
                let lg = p.layout_job(tracked_job(
                    label,
                    FontId::proportional(10.5),
                    theme.text_secondary,
                    0.0,
                ));
                p.galley(Pos2::new(left, y), lg, theme.text_secondary);

                let track = Rect::from_min_max(
                    Pos2::new(left + 78.0, y + 4.0),
                    Pos2::new(right - 46.0, y + 9.0),
                );
                p.rect_filled(
                    track,
                    CornerRadius::same(3),
                    Color32::from_rgba_unmultiplied(255, 255, 255, 22),
                );
                if snap.hardware_supported {
                    let frac = (val / denom).clamp(0.02, 1.0);
                    let fill = Rect::from_min_max(
                        track.min,
                        Pos2::new(track.left() + track.width() * frac, track.max.y),
                    );
                    p.rect_filled(fill, CornerRadius::same(3), col);
                }

                let ms_str = if snap.hardware_supported {
                    format!("{val:.2}")
                } else {
                    "—".to_string()
                };
                let mg = p.layout_job(tracked_job(
                    &ms_str,
                    FontId::monospace(10.0),
                    theme.text_primary,
                    0.0,
                ));
                p.galley(
                    Pos2::new(right - mg.size().x, y + 0.5),
                    mg,
                    theme.text_primary,
                );
                y += 19.0;
            }

            y += 4.0;
            p.line_segment(
                [Pos2::new(left, y), Pos2::new(right, y)],
                Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 18)),
            );
            y += 6.0;

            let spark_rect = Rect::from_min_max(Pos2::new(left, y), Pos2::new(right, y + 32.0));
            if snap.history.len() > 1 {
                let max_v = snap
                    .history
                    .iter()
                    .copied()
                    .fold(4.0_f32, f32::max)
                    .max(1.0);
                let n = snap.history.len();
                let mut pts = Vec::with_capacity(n);
                for (i, &v) in snap.history.iter().enumerate() {
                    let x =
                        spark_rect.left() + (i as f32 / (n - 1).max(1) as f32) * spark_rect.width();
                    let yy = spark_rect.bottom()
                        - (v / max_v).clamp(0.0, 1.0) * (spark_rect.height() - 4.0)
                        - 2.0;
                    pts.push(Pos2::new(x, yy));
                }
                p.line_segment(
                    [
                        Pos2::new(spark_rect.left(), spark_rect.center().y),
                        Pos2::new(spark_rect.right(), spark_rect.center().y),
                    ],
                    Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20)),
                );
                p.add(egui::Shape::line(
                    pts,
                    Stroke::new(1.5, with_alpha(theme.accent_bright, 235)),
                ));
            }

            let foot_y = spark_rect.bottom() + 4.0;
            let cpu_g = p.layout_job(tracked_job(
                &format!("CPU submit: {:.2} ms", snap.cpu_ms),
                FontId::monospace(9.0),
                theme.text_muted,
                0.0,
            ));
            p.galley(Pos2::new(left, foot_y), cpu_g, theme.text_muted);

            let hk_g = p.layout_job(tracked_job(
                "Hot-key: G",
                FontId::monospace(9.0),
                theme.text_muted,
                0.0,
            ));
            p.galley(
                Pos2::new(right - hk_g.size().x, foot_y),
                hk_g,
                theme.text_muted,
            );
        });
}
