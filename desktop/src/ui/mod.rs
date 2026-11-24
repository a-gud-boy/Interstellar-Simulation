use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use egui::epaint::{Brush, CornerRadius, RectShape, StrokeKind};
use egui::text::{LayoutJob, TextFormat};
use egui::{
    Align, Align2, Area, Color32, Context, CursorIcon, FontData, FontDefinitions, FontFamily,
    FontId, Id, Order, Painter, Pos2, Rect, ScrollArea, Sense, Shape, Stroke, TextureId, Ui, Vec2,
};

use crate::renderer::SharedGpuAssets;
use crate::sims::{ControlKind, HudMetadata, SimId, SimTheme, Simulation};

const HUD_PAD: f32 = 16.0;
const DRAWER_WIDTH: f32 = 352.0;

pub struct HudState {
    pub drawer_open: bool,
    pub hud_hidden: bool,
    pub vsync: bool,
    pub open_sections: HashMap<&'static str, bool>,
    pub status_toast: Option<(String, Instant)>,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            drawer_open: false,
            hud_hidden: false,
            vsync: true,
            open_sections: HashMap::new(),
            status_toast: None,
        }
    }
}

impl HudState {
    pub fn show_toast(&mut self, msg: impl Into<String>) {
        self.status_toast = Some((msg.into(), Instant::now()));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HudAction {
    SwitchSim(SimId),
    SelectPreset(usize),
    TogglePause,
    ToggleAutoOrbit,
    TriggerSpecial,
    ResetCamera,
    CapturePng,
    ToggleHud,
    ToggleDrawer,
    SetVsync(bool),
    ControlChanged {
        reset_primary: bool,
        resolution_changed: bool,
    },
}

fn load_first_font<P: AsRef<Path>>(paths: &[P]) -> Option<FontData> {
    for p in paths {
        let path = p.as_ref();
        if path.exists() {
            if let Ok(bytes) = std::fs::read(path) {
                return Some(FontData::from_owned(bytes));
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn load_windows_font(names: &[&str]) -> Option<FontData> {
    let mut dirs = Vec::with_capacity(2);
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        if !local_app.is_empty() {
            dirs.push(
                std::path::PathBuf::from(local_app)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
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
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            dirs.push(std::path::PathBuf::from(home).join("Library").join("Fonts"));
        }
    }
    dirs.push(std::path::PathBuf::from("/Library/Fonts"));
    dirs.push(std::path::PathBuf::from("/System/Library/Fonts"));
    dirs.push(std::path::PathBuf::from("/System/Library/Fonts/Supplemental"));

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
        load_first_font(&[
            "/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf",
        ]),
        load_first_font(&[
            "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ]),
    );

    #[cfg(target_os = "windows")]
    let (sans_reg, sans_semi, sans_fallback, math_fallback, mono_reg) = (
        load_windows_font(&["Inter-Regular.otf", "Inter-Regular.ttf", "segoeui.ttf", "arial.ttf"]),
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

fn semibold_family() -> FontFamily {
    FontFamily::Name("semibold".into())
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

fn build_glass_shapes(
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
            Pos2::new((rect.min.x / w).clamp(0.0, 1.0), (rect.min.y / h).clamp(0.0, 1.0)),
            Pos2::new((rect.max.x / w).clamp(0.0, 1.0), (rect.max.y / h).clamp(0.0, 1.0)),
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

fn paint_glass_panel(
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

fn apply_dark_widget_visuals(ui: &mut Ui, theme: &SimTheme) {
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

fn draw_sliders_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.4, color);
    let ys = [center.y - 4.0, center.y, center.y + 4.0];
    let knobs = [center.x - 2.4, center.x + 2.4, center.x - 1.2];
    for (y, kx) in ys.into_iter().zip(knobs.into_iter()) {
        painter.line_segment([Pos2::new(center.x - 5.5, y), Pos2::new(center.x + 5.5, y)], stroke);
        painter.circle_filled(Pos2::new(kx, y), 1.6, color);
    }
}

fn draw_eye_icon(painter: &Painter, center: Pos2, color: Color32, slashed: bool) {
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

fn draw_pause_icon(painter: &Painter, center: Pos2, color: Color32) {
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

fn draw_play_icon(painter: &Painter, center: Pos2, color: Color32) {
    let pts = vec![
        Pos2::new(center.x - 3.5, center.y - 4.8),
        Pos2::new(center.x + 4.8, center.y),
        Pos2::new(center.x - 3.5, center.y + 4.8),
    ];
    painter.add(Shape::convex_polygon(pts, color, Stroke::NONE));
}

fn draw_swap_icon(painter: &Painter, center: Pos2, color: Color32) {
    let stroke = Stroke::new(1.35, color);
    let y1 = center.y - 2.4;
    let y2 = center.y + 2.4;
    painter.line_segment([Pos2::new(center.x - 5.0, y1), Pos2::new(center.x + 5.0, y1)], stroke);
    painter.line_segment([Pos2::new(center.x + 2.4, y1 - 2.2), Pos2::new(center.x + 5.0, y1)], stroke);
    painter.line_segment([Pos2::new(center.x + 2.4, y1 + 2.2), Pos2::new(center.x + 5.0, y1)], stroke);

    painter.line_segment([Pos2::new(center.x + 5.0, y2), Pos2::new(center.x - 5.0, y2)], stroke);
    painter.line_segment([Pos2::new(center.x - 2.4, y2 - 2.2), Pos2::new(center.x - 5.0, y2)], stroke);
    painter.line_segment([Pos2::new(center.x - 2.4, y2 + 2.2), Pos2::new(center.x - 5.0, y2)], stroke);
}

fn draw_orbit_icon(painter: &Painter, center: Pos2, color: Color32) {
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

fn draw_reset_icon(painter: &Painter, center: Pos2, color: Color32) {
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

fn draw_camera_icon(painter: &Painter, center: Pos2, color: Color32) {
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

fn draw_close_icon(painter: &Painter, center: Pos2, color: Color32) {
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

fn draw_chevron_icon(painter: &Painter, center: Pos2, color: Color32, open: bool) {
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

fn tracked_job(
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

fn draw_badge(
    ui: &mut Ui,
    text: &str,
    bg: Color32,
    border: Color32,
    fg: Color32,
) {
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
    let text_pos = Pos2::new(
        rect.left() + 7.0,
        rect.center().y - galley.size().y * 0.5,
    );
    ui.painter().galley(text_pos, galley, fg);
}

fn draw_top_left_card(
    ctx: &Context,
    meta: &HudMetadata,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
) {
    Area::new(Id::unique("hud_top_left"))
        .fixed_pos(Pos2::new(HUD_PAD, HUD_PAD))
        .order(Order::Foreground)
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let card = ui.scope(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(5.0, 5.0);
                ui.add_space(9.0);

                ui.horizontal(|ui| {
                    ui.add_space(13.0);
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(10.0, 7.0);

                        // Top header row: glowing dot + brand title + preset/sky badges
                        let row_resp = ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 6.0;
                            let (dot_rect, _) =
                                ui.allocate_exact_size(Vec2::new(7.0, 19.0), Sense::hover());
                            let dot_c = dot_rect.center();
                            ui.painter().circle_filled(
                                dot_c,
                                5.5,
                                with_alpha(theme.accent, 68),
                            );
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
                            let lbl_g = ui.painter().layout_job(telemetry_label_job(
                                cell.label,
                                cell.unit,
                                theme,
                            ));
                            let val_g = ui.painter().layout_job(tracked_job(
                                &cell.value,
                                FontId::monospace(11.4),
                                theme.text_primary,
                                0.0,
                            ));
                            let cw = lbl_g.size().x.max(val_g.size().x);
                            grid_w += cw;
                            if idx > 0 {
                                grid_w += 12.0;
                            }
                            cell_galleys.push((lbl_g, val_g, cw));
                        }

                        let content_w = header_w.max(grid_w).max(380.0);

                        // Hairline divider
                        let (div_rect, _) = ui.allocate_exact_size(
                            Vec2::new(content_w, 1.0),
                            Sense::hover(),
                        );
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
                            cx += cw + 12.0;
                        }
                    });
                    ui.add_space(13.0);
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

fn draw_pill_button(
    ui: &mut Ui,
    label: &str,
    active: bool,
    warm_dot: bool,
    theme: &SimTheme,
    min_height: f32,
    pad_x: f32,
    icon: Option<&dyn Fn(&Painter, Pos2, Color32)>,
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
    let keycap_w = keycap.map(|k| (k.len() as f32 * 6.5 + 8.0).max(16.0) + 5.0).unwrap_or(0.0);
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
        (Color32::TRANSPARENT, Color32::TRANSPARENT, theme.text_secondary)
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

    let text_galley = ui
        .painter()
        .layout_job(tracked_job(label, font, fg, 0.25));
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
        let k_rect = Rect::from_center_size(Pos2::new(cursor_x + kw * 0.5, cy), Vec2::new(kw, 16.0));
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
        let k_galley =
            ui.painter()
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

fn draw_standalone_glass_pill(
    ui: &mut Ui,
    label: &str,
    active: bool,
    theme: &SimTheme,
    screen_size: Vec2,
    glass_tex_id: Option<TextureId>,
    icon: &dyn Fn(&Painter, Pos2, Color32),
    keycap: Option<&str>,
) -> egui::Response {
    let font = FontId::new(12.0, semibold_family());
    let galley = ui
        .painter()
        .layout_job(tracked_job(label, font.clone(), theme.text_primary, 0.35));
    let keycap_w = keycap.map(|k| (k.len() as f32 * 6.5 + 8.0).max(16.0) + 6.0).unwrap_or(0.0);
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

    let label_galley = ui
        .painter()
        .layout_job(tracked_job(label, font, fg, 0.35));
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

fn draw_top_right_bar(
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
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;

                // 7-Sim Switcher Glass Pill
                let sw_bg = ui.painter().add(Shape::Noop);
                let sw = ui.scope(|ui| {
                    ui.horizontal(|ui| {
                        ui.add_space(3.0);
                        ui.spacing_mut().item_spacing.x = 2.0;
                        ui.vertical(|ui| {
                            ui.add_space(3.0);
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 1.5;
                                for id in SimId::ALL {
                                    let is_curr = id == active_id;
                                    let resp = draw_pill_button(
                                        ui,
                                        id.switch_label(),
                                        is_curr,
                                        is_curr,
                                        theme,
                                        30.0,
                                        7.0,
                                        None,
                                        None,
                                    );
                                    if resp.clicked() && !is_curr {
                                        actions.push(HudAction::SwitchSim(id));
                                    }
                                }
                            });
                            ui.add_space(3.0);
                        });
                        ui.add_space(3.0);
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

                // Controls Pill
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

                // Hide UI Pill
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

fn draw_custom_slider(
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
            Pos2::new(row_rect.left(), row_rect.center().y - lbl_galley.size().y * 0.5),
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
    let (hit_rect, resp) = ui.allocate_exact_size(Vec2::new(track_w, 22.0), Sense::click_and_drag());
    if resp.hovered() || resp.dragged() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }

    let thumb_r = 6.5_f32;
    let span_x0 = hit_rect.left() + thumb_r;
    let span_x1 = (hit_rect.right() - thumb_r).max(span_x0 + 1.0);
    let mut changed_reset = None;

    if (resp.clicked() || resp.dragged()) && step > 0.0 {
        if let Some(pos) = resp.interact_pointer_pos() {
            let t = ((pos.x - span_x0) / (span_x1 - span_x0)).clamp(0.0, 1.0);
            let raw = min + t * (max - min);
            let stepped = ((raw / step).round() * step).clamp(min, max);
            if (stepped - val).abs() > step * 1e-3 {
                val = stepped;
                changed_reset = Some(sim.set_f32(key, stepped));
            }
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
        let g0 = ui
            .painter()
            .layout_job(tracked_job(h0, FontId::proportional(10.0), theme.text_muted, 0.0));
        let g1 = ui
            .painter()
            .layout_job(tracked_job(h1, FontId::proportional(10.0), theme.text_muted, 0.0));
        let (h_rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 13.0), Sense::hover());
        ui.painter().galley(h_rect.left_top(), g0, theme.text_muted);
        ui.painter().galley(
            Pos2::new(h_rect.right() - g1.size().x, h_rect.top()),
            g1,
            theme.text_muted,
        );
    }

    changed_reset
}

fn draw_segmented_control(
    ui: &mut Ui,
    label: &str,
    options: &[(i32, &'static str)],
    current_val: i32,
    theme: &SimTheme,
) -> Option<i32> {
    let lbl = ui
        .painter()
        .layout_job(tracked_job(label, FontId::proportional(12.0), theme.text_primary, 0.0));
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
        let btn_rect = Rect::from_min_size(Pos2::new(bx, outer_rect.top() + pad), Vec2::new(btn_w, btn_h));
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
            (Color32::TRANSPARENT, Color32::TRANSPARENT, theme.text_secondary)
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

fn draw_controls_drawer(
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
                                                            let lbl = ui.painter().layout_job(
                                                                tracked_job(
                                                                    item.label,
                                                                    FontId::proportional(12.0),
                                                                    theme.text_primary,
                                                                    0.0,
                                                                ),
                                                            );
                                                            ui.label(lbl);
                                                            let curr = sim.get_i32(item.key);
                                                            let curr_text = options
                                                                .iter()
                                                                .find(|(v, _)| *v == curr)
                                                                .map(|(_, l)| *l)
                                                                .unwrap_or("Select");
                                                            egui::ComboBox::from_id_salt((
                                                                "sel",
                                                                sim.id(),
                                                                item.key,
                                                            ))
                                                            .width(inner_w)
                                                            .selected_text(curr_text)
                                                            .show_ui(ui, |ui| {
                                                                apply_dark_widget_visuals(ui, theme);
                                                                for (v, opt_label) in options {
                                                                    if ui
                                                                        .selectable_label(
                                                                            curr == *v,
                                                                            *opt_label,
                                                                        )
                                                                        .clicked()
                                                                        && curr != *v
                                                                    {
                                                                        let reset =
                                                                            sim.set_i32(item.key, *v);
                                                                        actions.push(
                                                                            HudAction::ControlChanged {
                                                                                reset_primary: reset,
                                                                                resolution_changed: false,
                                                                            },
                                                                        );
                                                                    }
                                                                }
                                                            });
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
                let mut f_job = tracked_job(
                    &assets.adapter_label,
                    FontId::proportional(10.0),
                    theme.text_muted,
                    0.0,
                );
                f_job.wrap.max_width = drawer_rect.width() - 28.0;
                f_job.wrap.max_rows = 1;
                let f_galley = ui.painter().layout_job(f_job);
                ui.painter().galley(
                    Pos2::new(f_rect.left() + 14.0, f_rect.center().y - f_galley.size().y * 0.5),
                    f_galley,
                    theme.text_muted,
                );
            });
        });
}

fn draw_bottom_dock(
    ctx: &Context,
    sim: &dyn Simulation,
    meta: &HudMetadata,
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
        .show(ctx, |ui| {
            let bg_slot = ui.painter().add(Shape::Noop);
            let dock = ui.scope(|ui| {
                ui.horizontal(|ui| {
                    ui.add_space(8.0);
                    ui.vertical(|ui| {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 4.0;

                            // 6 Presets with [1]..[6] keycaps on the left
                            for (idx, preset) in presets.iter().enumerate() {
                                let is_act = active_preset == Some(idx);
                                let font = FontId::new(11.5, semibold_family());
                                let fg = if is_act {
                                    theme.accent_bright
                                } else {
                                    theme.text_secondary
                                };
                                let label_g = ui.painter().layout_job(tracked_job(
                                    preset.short_label,
                                    font.clone(),
                                    fg,
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
                                    (Color32::TRANSPARENT, Color32::TRANSPARENT, theme.text_secondary)
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

                                let t_g = ui.painter().layout_job(tracked_job(
                                    preset.short_label,
                                    font,
                                    text_c,
                                    0.0,
                                ));
                                ui.painter().galley(
                                    Pos2::new(
                                        k_rect.right() + 5.0,
                                        rect.center().y - t_g.size().y * 0.5,
                                    ),
                                    t_g,
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

                            if let Some(sp) = &meta.special_action {
                                if draw_pill_button(
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
                        ui.add_space(6.0);
                    });
                    ui.add_space(8.0);
                });
            });

            ui.painter().set(
                bg_slot,
                build_glass_shapes(
                    dock.response.rect,
                    22.0,
                    screen_size,
                    glass_tex_id,
                    theme.glass_bg,
                    theme.glass_border,
                ),
            );
        });
}

fn draw_bottom_left_hint(ctx: &Context, hint_text: &str, screen_size: Vec2) {
    Area::new(Id::unique("hud_hint"))
        .fixed_pos(Pos2::new(HUD_PAD, (screen_size.y - HUD_PAD - 64.0).max(16.0)))
        .interactable(false)
        .order(Order::Middle)
        .show(ctx, |ui| {
            let font = FontId::proportional(11.0);
            let shadow = ui.painter().layout_job(tracked_job(
                hint_text,
                font.clone(),
                Color32::from_rgba_unmultiplied(0, 0, 0, 200),
                0.2,
            ));
            let main = ui.painter().layout_job(tracked_job(
                hint_text,
                font,
                Color32::from_rgba_unmultiplied(226, 232, 240, 126),
                0.2,
            ));
            let (rect, _) = ui.allocate_exact_size(main.size(), Sense::hover());
            ui.painter().galley(
                rect.min + Vec2::new(0.0, 1.0),
                shadow,
                Color32::from_rgba_unmultiplied(0, 0, 0, 200),
            );
            ui.painter().galley(rect.min, main, Color32::WHITE);
        });
}

fn draw_restore_hud_pill(
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
            let label_g = ui.painter().layout_job(tracked_job(
                "Show UI",
                font.clone(),
                theme.text_primary,
                0.2,
            ));
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
            let g = ui.painter().layout_job(tracked_job("Show UI", font, fg, 0.2));
            let gw = g.size().x;
            ui.painter()
                .galley(Pos2::new(x, cy - g.size().y * 0.5), g, fg);
            x += gw + 6.0;

            let k_rect = Rect::from_center_size(Pos2::new(x + 8.0, cy), Vec2::new(16.0, 16.0));
            ui.painter().rect(
                k_rect,
                CornerRadius::same(4),
                Color32::from_rgba_unmultiplied(255, 255, 255, if resp.hovered() { 18 } else { 8 }),
                Stroke::new(1.0, with_alpha(theme.glass_border, 120)),
                StrokeKind::Inside,
            );
            let kg = ui.painter().layout_job(tracked_job(
                "H",
                FontId::monospace(10.0),
                fg,
                0.0,
            ));
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

fn draw_toast(
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

#[allow(clippy::too_many_arguments)]
pub fn draw_hud(
    ctx: &Context,
    sim: &mut dyn Simulation,
    assets: &SharedGpuAssets,
    hud: &mut HudState,
    glass_tex_id: Option<TextureId>,
    fps: f32,
    sample_count: u32,
    max_samples: u32,
) -> Vec<HudAction> {
    let mut actions = Vec::new();
    let theme = sim.theme();
    let screen_size = ctx.input(|i| i.content_rect().size());

    if hud.hud_hidden {
        draw_restore_hud_pill(ctx, &theme, screen_size, glass_tex_id, &mut actions);
        draw_toast(ctx, hud, &theme, screen_size, glass_tex_id);
        return actions;
    }

    let meta = sim.hud_metadata(assets, fps, sample_count, max_samples);
    draw_top_left_card(ctx, &meta, &theme, screen_size, glass_tex_id);
    draw_top_right_bar(
        ctx,
        sim.id(),
        &hud,
        &theme,
        screen_size,
        glass_tex_id,
        &mut actions,
    );

    if hud.drawer_open {
        draw_controls_drawer(
            ctx,
            sim,
            &meta,
            assets,
            hud,
            &theme,
            screen_size,
            glass_tex_id,
            &mut actions,
        );
    }

    draw_bottom_left_hint(ctx, meta.hint_text, screen_size);
    draw_bottom_dock(ctx, sim, &meta, &theme, screen_size, glass_tex_id, &mut actions);
    draw_toast(ctx, hud, &theme, screen_size, glass_tex_id);

    actions
}
