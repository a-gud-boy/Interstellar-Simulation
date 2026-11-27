use std::path::Path;
use std::sync::Arc;

use egui::epaint::{Brush, CornerRadius, RectShape, StrokeKind};
use egui::text::{LayoutJob, TextFormat};
use egui::{
    Color32, Context, CursorIcon, FontData, FontDefinitions, FontFamily, FontId, Painter, Pos2,
    Rect, Sense, Shape, Stroke, TextureId, Ui, Vec2,
};

use crate::sims::SimTheme;

pub(crate) const HUD_PAD: f32 = 16.0;
pub(crate) const DRAWER_WIDTH: f32 = 352.0;

pub(crate) type IconPainter<'a> = &'a dyn Fn(&Painter, Pos2, Color32);

fn load_first_font<P: AsRef<Path>>(paths: &[P]) -> Option<FontData> {
    for p in paths {
        let path = p.as_ref();
        if path.exists()
            && let Ok(bytes) = std::fs::read(path)
        {
            return Some(FontData::from_owned(bytes));
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn load_windows_font(names: &[&str]) -> Option<FontData> {
    let mut dirs = Vec::with_capacity(2);
    if let Ok(local_app) = std::env::var("LOCALAPPDATA")
        && !local_app.is_empty()
    {
        dirs.push(
            std::path::PathBuf::from(local_app)
                .join("Microsoft")
                .join("Windows")
                .join("Fonts"),
        );
    }
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
    dirs.push(std::path::PathBuf::from(windir).join("Fonts"));

    let mut candidates = Vec::with_capacity(names.len() * dirs.len());
    for dir in &dirs {
        for name in names {
            candidates.push(dir.join(name));
        }
    }
    load_first_font(&candidates)
}

#[cfg(target_os = "macos")]
fn load_macos_font(names: &[&str]) -> Option<FontData> {
    let mut dirs = Vec::with_capacity(4);
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        dirs.push(std::path::PathBuf::from(home).join("Library").join("Fonts"));
    }
    dirs.push(std::path::PathBuf::from("/Library/Fonts"));
    dirs.push(std::path::PathBuf::from("/System/Library/Fonts"));
    dirs.push(std::path::PathBuf::from(
        "/System/Library/Fonts/Supplemental",
    ));

    let mut candidates = Vec::with_capacity(names.len() * dirs.len());
    for dir in &dirs {
        for name in names {
            candidates.push(dir.join(name));
        }
    }
    load_first_font(&candidates)
}

pub fn configure_fonts(ctx: &Context) {
    let mut fonts = FontDefinitions::default();

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (sans_reg, sans_semi, sans_fallback, math_fallback, mono_reg) = (
        load_first_font(&[
            "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]),
        load_first_font(&[
            "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
            "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ]),
        load_first_font(&[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        ]),
        load_first_font(&["/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf"]),
        load_first_font(&[
            "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ]),
    );

    #[cfg(target_os = "windows")]
    let (sans_reg, sans_semi, sans_fallback, math_fallback, mono_reg) = (
        load_windows_font(&[
            "Inter-Regular.otf",
            "Inter-Regular.ttf",
            "segoeui.ttf",
            "arial.ttf",
        ]),
        load_windows_font(&[
            "Inter-SemiBold.otf",
            "Inter-SemiBold.ttf",
            "seguisb.ttf",
            "segoeuib.ttf",
            "arialbd.ttf",
        ]),
        load_windows_font(&["segoeui.ttf", "arial.ttf"]),
        load_windows_font(&["seguisym.ttf", "arial.ttf"]),
        load_windows_font(&[
            "CascadiaMono.ttf",
            "JetBrainsMono-Regular.ttf",
            "consola.ttf",
            "lucon.ttf",
        ]),
    );

    #[cfg(target_os = "macos")]
    let (sans_reg, sans_semi, sans_fallback, math_fallback, mono_reg) = (
        load_macos_font(&[
            "Inter-Regular.otf",
            "Inter-Regular.ttf",
            "SFNS.ttf",
            "Arial.ttf",
            "HelveticaNeue.ttc",
        ]),
        load_macos_font(&[
            "Inter-SemiBold.otf",
            "Inter-SemiBold.ttf",
            "Arial Bold.ttf",
            "SFNS.ttf",
            "HelveticaNeue.ttc",
        ]),
        load_macos_font(&["SFNS.ttf", "Arial.ttf", "HelveticaNeue.ttc"]),
        load_macos_font(&[
            "Apple Symbols.ttf",
            "STIXTwoMath-Regular.otf",
            "STIXGeneral.otf",
            "Arial Unicode.ttf",
        ]),
        load_macos_font(&[
            "JetBrainsMono-Regular.ttf",
            "SFNSMono.ttf",
            "Menlo.ttc",
            "Monaco.ttf",
            "Andale Mono.ttf",
        ]),
    );

    let mut prop_list = Vec::new();
    let mut semi_list = Vec::new();
    let mut mono_list = Vec::new();

    if let Some(f) = sans_reg {
        fonts.font_data.insert("sys_sans".into(), Arc::new(f));
        prop_list.push("sys_sans".into());
    }
    if let Some(f) = sans_semi {
        fonts.font_data.insert("sys_semibold".into(), Arc::new(f));
        semi_list.push("sys_semibold".into());
    } else if fonts.font_data.contains_key("sys_sans") {
        semi_list.push("sys_sans".into());
    }
    if let Some(f) = mono_reg {
        fonts.font_data.insert("sys_mono".into(), Arc::new(f));
        mono_list.push("sys_mono".into());
    }
    if let Some(f) = sans_fallback {
        fonts
            .font_data
            .insert("sys_sans_fallback".into(), Arc::new(f));
        prop_list.push("sys_sans_fallback".into());
        semi_list.push("sys_sans_fallback".into());
        mono_list.push("sys_sans_fallback".into());
    }
    if let Some(f) = math_fallback {
        fonts
            .font_data
            .insert("sys_math_fallback".into(), Arc::new(f));
        prop_list.push("sys_math_fallback".into());
        semi_list.push("sys_math_fallback".into());
        mono_list.push("sys_math_fallback".into());
    }

    if let Some(existing) = fonts.families.get(&FontFamily::Proportional).cloned() {
        prop_list.extend(existing.clone());
        semi_list.extend(existing);
    }
    if let Some(existing) = fonts.families.get(&FontFamily::Monospace).cloned() {
        mono_list.extend(existing);
    }

    fonts.families.insert(FontFamily::Proportional, prop_list);
    fonts
        .families
        .insert(FontFamily::Name("semibold".into()), semi_list);
    fonts.families.insert(FontFamily::Monospace, mono_list);

    ctx.set_fonts(fonts);
}

pub(crate) fn semibold_family() -> FontFamily {
    FontFamily::Name("semibold".into())
}

pub(crate) fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

pub(crate) fn build_glass_shapes(
    rect: Rect,
    radius: f32,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    fill: Color32,
    border: Color32,
) -> Shape {
    let cr = CornerRadius::same(radius.round().clamp(0.0, 255.0) as u8);
    let mut shapes = Vec::with_capacity(3);

    let mut shadow = RectShape::filled(
        rect.translate(Vec2::new(0.0, 6.0)),
        cr,
        Color32::from_black_alpha(64),
    );
    shadow.blur_width = 14.0;
    shapes.push(Shape::Rect(shadow));

    if let Some(tex_id) = glass_tex_id {
        let w = screen_size.x.max(1.0);
        let h = screen_size.y.max(1.0);
        let uv = Rect::from_min_max(
            Pos2::new(
                (rect.min.x / w).clamp(0.0, 1.0),
                (rect.min.y / h).clamp(0.0, 1.0),
            ),
            Pos2::new(
                (rect.max.x / w).clamp(0.0, 1.0),
                (rect.max.y / h).clamp(0.0, 1.0),
            ),
        );
        let mut blur_shape = RectShape::filled(rect, cr, Color32::WHITE);
        blur_shape.brush = Some(Arc::new(Brush {
            fill_texture_id: tex_id,
            uv,
        }));
        shapes.push(Shape::Rect(blur_shape));
    }

    shapes.push(Shape::Rect(RectShape::new(
        rect,
        cr,
        fill,
        Stroke::new(1.0, border),
        StrokeKind::Inside,
    )));

    Shape::Vec(shapes)
}

pub(crate) fn paint_glass_panel(
    painter: &Painter,
    rect: Rect,
    radius: f32,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    fill: Color32,
    border: Color32,
) {
    painter.add(build_glass_shapes(
        rect,
        radius,
        screen_size,
        glass_tex_id,
        fill,
        border,
    ));
}

pub(crate) fn apply_dark_widget_visuals(ui: &mut Ui, theme: &SimTheme) {
    let v = ui.visuals_mut();
    v.dark_mode = true;
    v.panel_fill = Color32::from_rgba_unmultiplied(15, 19, 28, 240);
    v.window_fill = Color32::from_rgba_unmultiplied(15, 19, 28, 240);
    v.window_stroke = Stroke::new(1.0, theme.glass_border_strong);
    v.window_corner_radius = CornerRadius::same(8);
    v.popup_shadow.color = Color32::from_black_alpha(120);

    v.widgets.noninteractive.bg_fill = Color32::from_rgba_unmultiplied(15, 19, 28, 232);
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, theme.glass_border_strong);
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, theme.text_primary);
    v.widgets.noninteractive.corner_radius = CornerRadius::same(8);

    v.widgets.inactive.bg_fill = Color32::from_rgba_unmultiplied(15, 19, 28, 232);
    v.widgets.inactive.weak_bg_fill = Color32::from_rgba_unmultiplied(15, 19, 28, 232);
    v.widgets.inactive.bg_stroke = Stroke::new(1.0, theme.glass_border_strong);
    v.widgets.inactive.fg_stroke = Stroke::new(1.0, theme.text_primary);
    v.widgets.inactive.corner_radius = CornerRadius::same(8);

    v.widgets.hovered.bg_fill = Color32::from_rgba_unmultiplied(24, 30, 44, 242);
    v.widgets.hovered.weak_bg_fill = Color32::from_rgba_unmultiplied(24, 30, 44, 242);
    v.widgets.hovered.bg_stroke = Stroke::new(1.0, theme.accent_border);
    v.widgets.hovered.fg_stroke = Stroke::new(1.0, theme.text_primary);
    v.widgets.hovered.corner_radius = CornerRadius::same(8);

    v.widgets.active.bg_fill = theme.accent_soft;
    v.widgets.active.weak_bg_fill = theme.accent_soft;
    v.widgets.active.bg_stroke = Stroke::new(1.0, theme.accent_border);
    v.widgets.active.fg_stroke = Stroke::new(1.0, theme.accent_bright);
    v.widgets.active.corner_radius = CornerRadius::same(8);

    v.selection.bg_fill = theme.accent_soft;
    v.selection.stroke = Stroke::new(1.0, theme.accent_bright);

    ui.spacing_mut().scroll.bar_width = 5.0;
    ui.spacing_mut().scroll.handle_min_length = 24.0;
}

pub(crate) fn draw_sliders_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.4, color);
    let ys = [center.y - 4.0, center.y, center.y + 4.0];
    let knobs = [center.x - 2.4, center.x + 2.4, center.x - 1.2];
    for (y, kx) in ys.into_iter().zip(knobs) {
        painter.line_segment(
            [Pos2::new(center.x - 5.5, y), Pos2::new(center.x + 5.5, y)],
            stroke,
        );
        painter.circle_filled(Pos2::new(kx, y), 1.6, color);
    }
}

pub(crate) fn draw_eye_icon(painter: &Painter, center: Pos2, color: Color32, slashed: bool) {
    let stroke = Stroke::new(1.35, color);
    let mut top = Vec::with_capacity(9);
    let mut bot = Vec::with_capacity(9);
    for i in 0..=8 {
        let t = i as f32 / 8.0;
        let x = (t - 0.5) * 12.0;
        let arch = (std::f32::consts::PI * t).sin() * 3.6;
        top.push(Pos2::new(center.x + x, center.y - arch));
        bot.push(Pos2::new(center.x + x, center.y + arch));
    }
    painter.line(top, stroke);
    painter.line(bot, stroke);
    painter.circle_stroke(center, 1.8, stroke);
    if slashed {
        painter.line_segment(
            [
                Pos2::new(center.x - 5.2, center.y + 5.2),
                Pos2::new(center.x + 5.2, center.y - 5.2),
            ],
            stroke,
        );
    }
}

pub(crate) fn draw_pause_icon(painter: &Painter, center: Pos2, color: Color32) {
    painter.rect_filled(
        Rect::from_center_size(Pos2::new(center.x - 2.6, center.y), Vec2::new(2.8, 9.5)),
        CornerRadius::same(1),
        color,
    );
    painter.rect_filled(
        Rect::from_center_size(Pos2::new(center.x + 2.6, center.y), Vec2::new(2.8, 9.5)),
        CornerRadius::same(1),
        color,
    );
}

pub(crate) fn draw_play_icon(painter: &Painter, center: Pos2, color: Color32) {
    let pts = vec![
        Pos2::new(center.x - 3.5, center.y - 4.8),
        Pos2::new(center.x + 4.8, center.y),
        Pos2::new(center.x - 3.5, center.y + 4.8),
    ];
    painter.add(Shape::convex_polygon(pts, color, Stroke::NONE));
}

pub(crate) fn draw_swap_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.35, color);
    let y1 = center.y - 2.4;
    let y2 = center.y + 2.4;
    painter.line_segment(
        [Pos2::new(center.x - 5.0, y1), Pos2::new(center.x + 5.0, y1)],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x + 2.4, y1 - 2.2),
            Pos2::new(center.x + 5.0, y1),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x + 2.4, y1 + 2.2),
            Pos2::new(center.x + 5.0, y1),
        ],
        stroke,
    );

    painter.line_segment(
        [Pos2::new(center.x + 5.0, y2), Pos2::new(center.x - 5.0, y2)],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x - 2.4, y2 - 2.2),
            Pos2::new(center.x - 5.0, y2),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x - 2.4, y2 + 2.2),
            Pos2::new(center.x - 5.0, y2),
        ],
        stroke,
    );
}

pub(crate) fn draw_orbit_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.3, color);
    let rot = -22.0_f32.to_radians();
    let (sr, cr) = rot.sin_cos();
    let mut pts = Vec::with_capacity(21);
    for i in 0..=20 {
        let a = (i as f32 / 20.0) * std::f32::consts::TAU;
        let lx = a.cos() * 6.0;
        let ly = a.sin() * 2.6;
        pts.push(Pos2::new(
            center.x + lx * cr - ly * sr,
            center.y + lx * sr + ly * cr,
        ));
    }
    painter.line(pts, stroke);
    painter.circle_filled(center, 2.0, color);
}

pub(crate) fn draw_reset_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.4, color);
    let mut pts = Vec::with_capacity(16);
    let r = 4.6;
    for i in 0..=14 {
        let a = (-155.0_f32 + (i as f32 / 14.0) * 285.0).to_radians();
        pts.push(Pos2::new(center.x + a.cos() * r, center.y + a.sin() * r));
    }
    painter.line(pts, stroke);
    let tip = Pos2::new(center.x - 4.2, center.y - 1.2);
    painter.line_segment([tip, Pos2::new(tip.x, tip.y - 3.2)], stroke);
    painter.line_segment([tip, Pos2::new(tip.x + 3.2, tip.y)], stroke);
}

pub(crate) fn draw_camera_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.3, color);
    painter.rect_stroke(
        Rect::from_center_size(Pos2::new(center.x, center.y + 0.8), Vec2::new(11.5, 8.2)),
        CornerRadius::same(2),
        stroke,
        StrokeKind::Inside,
    );
    painter.line(
        vec![
            Pos2::new(center.x - 2.8, center.y - 3.3),
            Pos2::new(center.x - 1.8, center.y - 5.0),
            Pos2::new(center.x + 1.8, center.y - 5.0),
            Pos2::new(center.x + 2.8, center.y - 3.3),
        ],
        stroke,
    );
    painter.circle_stroke(Pos2::new(center.x, center.y + 0.8), 2.1, stroke);
}

pub(crate) fn draw_close_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.6, color);
    painter.line_segment(
        [
            Pos2::new(center.x - 4.0, center.y - 4.0),
            Pos2::new(center.x + 4.0, center.y + 4.0),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x + 4.0, center.y - 4.0),
            Pos2::new(center.x - 4.0, center.y + 4.0),
        ],
        stroke,
    );
}

pub(crate) fn draw_chevron_icon(painter: &Painter, center: Pos2, color: Color32, open: bool) {
    let stroke = Stroke::new(1.5, color);
    if open {
        painter.line(
            vec![
                Pos2::new(center.x - 3.5, center.y - 1.5),
                Pos2::new(center.x, center.y + 2.0),
                Pos2::new(center.x + 3.5, center.y - 1.5),
            ],
            stroke,
        );
    } else {
        painter.line(
            vec![
                Pos2::new(center.x - 1.5, center.y - 3.5),
                Pos2::new(center.x + 2.0, center.y),
                Pos2::new(center.x - 1.5, center.y + 3.5),
            ],
            stroke,
        );
    }
}

pub(crate) fn draw_home_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.4, color);
    painter.line(
        vec![
            Pos2::new(center.x - 5.5, center.y - 0.5),
            Pos2::new(center.x, center.y - 5.2),
            Pos2::new(center.x + 5.5, center.y - 0.5),
        ],
        stroke,
    );
    painter.line(
        vec![
            Pos2::new(center.x - 4.0, center.y - 1.5),
            Pos2::new(center.x - 4.0, center.y + 4.8),
            Pos2::new(center.x + 4.0, center.y + 4.8),
            Pos2::new(center.x + 4.0, center.y - 1.5),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x - 1.5, center.y + 4.8),
            Pos2::new(center.x - 1.5, center.y + 1.2),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x - 1.5, center.y + 1.2),
            Pos2::new(center.x + 1.5, center.y + 1.2),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x + 1.5, center.y + 1.2),
            Pos2::new(center.x + 1.5, center.y + 4.8),
        ],
        stroke,
    );
}

pub(crate) fn tracked_job(
    text: &str,
    font_id: FontId,
    color: Color32,
    extra_letter_spacing: f32,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = f32::INFINITY;
    job.append(
        text,
        0.0,
        TextFormat {
            font_id,
            extra_letter_spacing,
            color,
            ..Default::default()
        },
    );
    job
}

pub(crate) fn draw_badge(ui: &mut Ui, text: &str, bg: Color32, border: Color32, fg: Color32) {
    let font = FontId::new(10.3, semibold_family());
    let job = tracked_job(text, font, fg, 0.2);
    let galley = ui.painter().layout_job(job);
    let size = Vec2::new(galley.size().x + 14.0, 19.0);
    let (rect, _) = ui.allocate_exact_size(size, Sense::hover());
    ui.painter().rect(
        rect,
        CornerRadius::same(10),
        bg,
        Stroke::new(1.0, border),
        StrokeKind::Inside,
    );
    let text_pos = Pos2::new(rect.left() + 7.0, rect.center().y - galley.size().y * 0.5);
    ui.painter().galley(text_pos, galley, fg);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_pill_button(
    ui: &mut Ui,
    label: &str,
    active: bool,
    warm_dot: bool,
    theme: &SimTheme,
    min_height: f32,
    pad_x: f32,
    icon: Option<IconPainter<'_>>,
    keycap: Option<&str>,
) -> egui::Response {
    let font = FontId::new(11.5, semibold_family());
    let text_color = if active {
        theme.accent_bright
    } else {
        theme.text_secondary
    };
    let galley = ui
        .painter()
        .layout_job(tracked_job(label, font.clone(), text_color, 0.25));

    let dot_w = if warm_dot { 11.0 } else { 0.0 };
    let icon_w = if icon.is_some() { 18.0 } else { 0.0 };
    let keycap_w = keycap
        .map(|k| (k.len() as f32 * 6.5 + 8.0).max(16.0) + 5.0)
        .unwrap_or(0.0);
    let total_w = pad_x * 2.0 + dot_w + icon_w + galley.size().x + keycap_w;

    let (rect, resp) = ui.allocate_exact_size(Vec2::new(total_w, min_height), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }

    let (fill, border, fg) = if active {
        (theme.accent_soft, theme.accent_border, theme.accent_bright)
    } else if resp.hovered() {
        (
            Color32::from_rgba_unmultiplied(255, 255, 255, 22),
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

    let cr = CornerRadius::same((min_height * 0.5).ceil() as u8);
    ui.painter()
        .rect(rect, cr, fill, Stroke::new(1.0, border), StrokeKind::Inside);

    let mut cursor_x = rect.left() + pad_x;
    let cy = rect.center().y;

    if warm_dot {
        let dot_color = if let Some((warm, _, _)) = theme.warm {
            warm
        } else {
            theme.accent_bright
        };
        ui.painter()
            .circle_filled(Pos2::new(cursor_x + 3.0, cy), 3.0, dot_color);
        cursor_x += dot_w;
    }

    if let Some(draw_fn) = icon {
        draw_fn(ui.painter(), Pos2::new(cursor_x + 6.5, cy), fg);
        cursor_x += icon_w;
    }

    let text_galley = ui.painter().layout_job(tracked_job(label, font, fg, 0.25));
    let tw = text_galley.size().x;
    ui.painter().galley(
        Pos2::new(cursor_x, cy - text_galley.size().y * 0.5),
        text_galley,
        fg,
    );
    cursor_x += tw;

    if let Some(k) = keycap {
        cursor_x += 5.0;
        let kw = (k.len() as f32 * 6.5 + 8.0).max(16.0);
        let k_rect =
            Rect::from_center_size(Pos2::new(cursor_x + kw * 0.5, cy), Vec2::new(kw, 16.0));
        let k_border = if active {
            with_alpha(theme.accent, 110)
        } else {
            Color32::from_rgba_unmultiplied(255, 255, 255, 36)
        };
        let k_bg = Color32::from_rgba_unmultiplied(255, 255, 255, 13);
        let k_fg = if active {
            theme.accent_bright
        } else {
            theme.text_muted
        };
        ui.painter().rect(
            k_rect,
            CornerRadius::same(4),
            k_bg,
            Stroke::new(1.0, k_border),
            StrokeKind::Inside,
        );
        let k_galley = ui
            .painter()
            .layout_job(tracked_job(k, FontId::monospace(10.0), k_fg, 0.0));
        ui.painter().galley(
            Pos2::new(
                k_rect.center().x - k_galley.size().x * 0.5,
                k_rect.center().y - k_galley.size().y * 0.5,
            ),
            k_galley,
            k_fg,
        );
    }

    resp
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_standalone_glass_pill(
    ui: &mut Ui,
    label: &str,
    active: bool,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    icon: IconPainter<'_>,
    keycap: Option<&str>,
) -> egui::Response {
    let font = FontId::new(12.0, semibold_family());
    let galley =
        ui.painter()
            .layout_job(tracked_job(label, font.clone(), theme.text_primary, 0.35));
    let keycap_w = keycap
        .map(|k| (k.len() as f32 * 6.5 + 8.0).max(16.0) + 6.0)
        .unwrap_or(0.0);
    let w = 13.0 * 2.0 + 20.0 + galley.size().x + keycap_w;
    let h = 36.0;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, h), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }

    let (fill, border, fg) = if active {
        (
            with_alpha(theme.accent_soft, 210),
            theme.accent_border,
            theme.accent_bright,
        )
    } else if resp.hovered() {
        (
            Color32::from_rgba_unmultiplied(20, 24, 34, 200),
            theme.glass_border_strong,
            theme.text_primary,
        )
    } else {
        (theme.glass_bg, theme.glass_border, theme.text_primary)
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

    let mut x = rect.left() + 13.0;
    let cy = rect.center().y;
    icon(ui.painter(), Pos2::new(x + 7.0, cy), fg);
    x += 20.0;

    let label_galley = ui.painter().layout_job(tracked_job(label, font, fg, 0.35));
    let lw = label_galley.size().x;
    ui.painter().galley(
        Pos2::new(x, cy - label_galley.size().y * 0.5),
        label_galley,
        fg,
    );
    x += lw;

    if let Some(k) = keycap {
        x += 6.0;
        let kw = (k.len() as f32 * 6.5 + 8.0).max(16.0);
        let k_rect = Rect::from_center_size(Pos2::new(x + kw * 0.5, cy), Vec2::new(kw, 16.0));
        ui.painter().rect(
            k_rect,
            CornerRadius::same(4),
            Color32::from_rgba_unmultiplied(255, 255, 255, 13),
            Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 36)),
            StrokeKind::Inside,
        );
        let k_galley = ui.painter().layout_job(tracked_job(
            k,
            FontId::monospace(10.0),
            theme.text_muted,
            0.0,
        ));
        ui.painter().galley(
            Pos2::new(
                k_rect.center().x - k_galley.size().x * 0.5,
                k_rect.center().y - k_galley.size().y * 0.5,
            ),
            k_galley,
            theme.text_muted,
        );
    }

    resp
}
