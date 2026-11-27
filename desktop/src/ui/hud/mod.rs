mod dock;
mod topbar;

use egui::epaint::{CornerRadius, StrokeKind};
use egui::{
    Align2, Area, Color32, Context, CursorIcon, FontId, Id, Order, Pos2, Rect, Sense, Shape,
    Stroke, TextureId, Vec2,
};

use crate::sims::SimTheme;
use crate::ui::theme::{
    HUD_PAD, build_glass_shapes, draw_eye_icon, paint_glass_panel, semibold_family, tracked_job,
    with_alpha,
};
use crate::ui::{HudAction, HudState};

pub(crate) use dock::{draw_bottom_dock, draw_bottom_left_hint};
pub(crate) use topbar::{draw_top_left_card, draw_top_right_bar};

pub(crate) fn draw_restore_hud_pill(
    ctx: &Context,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    actions: &mut Vec<HudAction>,
) {
    Area::new(Id::unique("hud_restore_pill"))
        .anchor(Align2::RIGHT_BOTTOM, Vec2::new(-HUD_PAD, -HUD_PAD))
        .order(Order::Foreground)
        .show(ctx, |ui| {
            let font = FontId::new(12.0, semibold_family());
            let label_g =
                ui.painter()
                    .layout_job(tracked_job("Show UI", font, Color32::PLACEHOLDER, 0.2));
            let w = 12.0 * 2.0 + 20.0 + label_g.size().x + 22.0;
            let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 36.0), Sense::click());
            if resp.hovered() {
                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
            }
            let alpha_mul = if resp.hovered() { 1.0 } else { 0.34 };
            let fill = with_alpha(
                theme.glass_bg,
                (theme.glass_bg.a() as f32 * alpha_mul) as u8,
            );
            let border = if resp.hovered() {
                theme.accent_border
            } else {
                with_alpha(theme.glass_border, 90)
            };
            let fg = with_alpha(theme.text_primary, (255.0 * alpha_mul).max(90.0) as u8);

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
            let mut x = rect.left() + 12.0;
            draw_eye_icon(ui.painter(), Pos2::new(x + 7.0, cy), fg, false);
            x += 20.0;
            let gw = label_g.size().x;
            ui.painter().galley_with_override_text_color(
                Pos2::new(x, cy - label_g.size().y * 0.5),
                label_g,
                fg,
            );
            x += gw + 6.0;

            let k_rect = Rect::from_center_size(Pos2::new(x + 8.0, cy), Vec2::new(16.0, 16.0));
            ui.painter().rect(
                k_rect,
                CornerRadius::same(4),
                Color32::from_rgba_unmultiplied(255, 255, 255, if resp.hovered() { 18 } else { 8 }),
                Stroke::new(1.0, with_alpha(theme.glass_border, 120)),
                StrokeKind::Inside,
            );
            let kg = ui
                .painter()
                .layout_job(tracked_job("H", FontId::monospace(10.0), fg, 0.0));
            ui.painter().galley(
                Pos2::new(
                    k_rect.center().x - kg.size().x * 0.5,
                    k_rect.center().y - kg.size().y * 0.5,
                ),
                kg,
                fg,
            );

            if resp.clicked() {
                actions.push(HudAction::ToggleHud);
            }
        });
}

pub(crate) fn draw_toast(
    ctx: &Context,
    hud: &mut HudState,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
) {
    let Some((msg, at)) = hud.status_toast.clone() else {
        return;
    };
    if at.elapsed().as_secs_f32() > 2.8 {
        hud.status_toast = None;
        return;
    }
    Area::new(Id::unique("hud_toast"))
        .anchor(Align2::CENTER_TOP, Vec2::new(0.0, HUD_PAD + 50.0))
        .interactable(false)
        .order(Order::Tooltip)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let inner = ui.scope(|ui| {
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    ui.vertical(|ui| {
                        ui.add_space(6.0);
                        ui.label(tracked_job(
                            &msg,
                            FontId::proportional(11.5),
                            theme.accent_bright,
                            0.2,
                        ));
                        ui.add_space(6.0);
                    });
                    ui.add_space(12.0);
                });
            });
            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    inner.response.rect,
                    16.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg_elevated,
                    theme.accent_border,
                ),
            );
        });
}
