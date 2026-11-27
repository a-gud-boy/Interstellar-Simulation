pub mod binary;
pub mod blackhole;
pub mod pulsar;
pub mod registry;
pub mod starflight;
pub mod supernova;
pub mod warp;
pub mod wormhole;

use egui::Color32;

use crate::renderer::SharedGpuAssets;
use crate::renderer::post::{PostFrameParams, PostTuning};

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub enum SimId {
    Blackhole,
    Wormhole,
    BinaryBh,
    WarpDrive,
    Supernova,
    Pulsar,
    Starflight,
}

impl SimId {
    pub const ALL: [SimId; 7] = [
        SimId::Blackhole,
        SimId::Wormhole,
        SimId::BinaryBh,
        SimId::WarpDrive,
        SimId::Supernova,
        SimId::Pulsar,
        SimId::Starflight,
    ];

    pub fn switch_label(self) -> &'static str {
        registry::registry_entry(self).switch_label
    }

    pub fn cli_name(self) -> &'static str {
        registry::registry_entry(self).cli_name
    }

    pub fn window_title(self) -> &'static str {
        registry::registry_entry(self).window_title
    }

    pub fn from_cli_name(s: &str) -> Option<Self> {
        registry::resolve_sim_id(s)
    }
}

#[derive(Copy, Clone, Debug)]
pub struct SimTheme {
    pub glass_bg: Color32,
    pub glass_bg_elevated: Color32,
    pub glass_border: Color32,
    pub glass_border_strong: Color32,
    pub text_primary: Color32,
    pub text_secondary: Color32,
    pub text_muted: Color32,
    pub accent: Color32,
    pub accent_bright: Color32,
    pub accent_soft: Color32,
    pub accent_border: Color32,
    pub warm: Option<(Color32, Color32, Color32)>, // (text/dot, soft, border)
    pub slider_track: Color32,
}

impl SimTheme {
    pub fn for_sim(id: SimId) -> Self {
        match id {
            SimId::Blackhole => Self {
                glass_bg: Color32::from_rgba_unmultiplied(10, 12, 18, 143),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(11, 14, 22, 194),
                glass_border: Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                glass_border_strong: Color32::from_rgba_unmultiplied(255, 255, 255, 46),
                text_primary: Color32::from_rgb(0xee, 0xf2, 0xf7),
                text_secondary: Color32::from_rgb(0xa2, 0xb1, 0xc6),
                text_muted: Color32::from_rgba_unmultiplied(203, 213, 225, 158),
                accent: Color32::from_rgb(0xf0, 0xb3, 0x5a),
                accent_bright: Color32::from_rgb(0xf7, 0xca, 0x82),
                accent_soft: Color32::from_rgba_unmultiplied(240, 179, 90, 41),
                accent_border: Color32::from_rgba_unmultiplied(240, 179, 90, 122),
                warm: None,
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 56),
            },
            SimId::Wormhole => Self {
                glass_bg: Color32::from_rgba_unmultiplied(10, 12, 18, 143),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(11, 14, 22, 194),
                glass_border: Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                glass_border_strong: Color32::from_rgba_unmultiplied(255, 255, 255, 46),
                text_primary: Color32::from_rgb(0xee, 0xf2, 0xf7),
                text_secondary: Color32::from_rgb(0xa2, 0xb1, 0xc6),
                text_muted: Color32::from_rgba_unmultiplied(203, 213, 225, 158),
                accent: Color32::from_rgb(0x4a, 0xd4, 0xc4),
                accent_bright: Color32::from_rgb(0x96, 0xf2, 0xe7),
                accent_soft: Color32::from_rgba_unmultiplied(74, 212, 196, 41),
                accent_border: Color32::from_rgba_unmultiplied(74, 212, 196, 122),
                warm: None,
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 56),
            },
            SimId::BinaryBh => Self {
                glass_bg: Color32::from_rgba_unmultiplied(10, 12, 18, 143),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(11, 14, 22, 199),
                glass_border: Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                glass_border_strong: Color32::from_rgba_unmultiplied(255, 255, 255, 46),
                text_primary: Color32::from_rgb(0xee, 0xf2, 0xf7),
                text_secondary: Color32::from_rgb(0xa2, 0xb1, 0xc6),
                text_muted: Color32::from_rgba_unmultiplied(203, 213, 225, 163),
                accent: Color32::from_rgb(0xa7, 0x8b, 0xfa),
                accent_bright: Color32::from_rgb(0xc4, 0xb5, 0xfd),
                accent_soft: Color32::from_rgba_unmultiplied(167, 139, 250, 46),
                accent_border: Color32::from_rgba_unmultiplied(167, 139, 250, 133),
                warm: None,
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 61),
            },
            SimId::WarpDrive => Self {
                glass_bg: Color32::from_rgba_unmultiplied(10, 12, 18, 143),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(11, 14, 22, 199),
                glass_border: Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                glass_border_strong: Color32::from_rgba_unmultiplied(255, 255, 255, 46),
                text_primary: Color32::from_rgb(0xee, 0xf2, 0xf7),
                text_secondary: Color32::from_rgb(0xa2, 0xb1, 0xc6),
                text_muted: Color32::from_rgba_unmultiplied(203, 213, 225, 163),
                accent: Color32::from_rgb(0x38, 0xbd, 0xf8),
                accent_bright: Color32::from_rgb(0x7d, 0xd3, 0xfc),
                accent_soft: Color32::from_rgba_unmultiplied(56, 189, 248, 46),
                accent_border: Color32::from_rgba_unmultiplied(56, 189, 248, 133),
                warm: None,
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 61),
            },
            SimId::Supernova => Self {
                glass_bg: Color32::from_rgba_unmultiplied(10, 12, 18, 143),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(11, 14, 22, 199),
                glass_border: Color32::from_rgba_unmultiplied(255, 255, 255, 26),
                glass_border_strong: Color32::from_rgba_unmultiplied(255, 255, 255, 46),
                text_primary: Color32::from_rgb(0xee, 0xf2, 0xf7),
                text_secondary: Color32::from_rgb(0xa2, 0xb1, 0xc6),
                text_muted: Color32::from_rgba_unmultiplied(203, 213, 225, 163),
                accent: Color32::from_rgb(0x2d, 0xd4, 0xbf),
                accent_bright: Color32::from_rgb(0x5e, 0xea, 0xd4),
                accent_soft: Color32::from_rgba_unmultiplied(45, 212, 191, 46),
                accent_border: Color32::from_rgba_unmultiplied(45, 212, 191, 133),
                warm: None,
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 61),
            },
            SimId::Pulsar => Self {
                glass_bg: Color32::from_rgba_unmultiplied(8, 12, 22, 153),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(9, 14, 26, 209),
                glass_border: Color32::from_rgba_unmultiplied(148, 197, 255, 36),
                glass_border_strong: Color32::from_rgba_unmultiplied(148, 197, 255, 61),
                text_primary: Color32::from_rgb(0xee, 0xf4, 0xfc),
                text_secondary: Color32::from_rgb(0xa7, 0xb8, 0xd0),
                text_muted: Color32::from_rgba_unmultiplied(203, 218, 238, 168),
                accent: Color32::from_rgb(0x38, 0xbd, 0xf8),
                accent_bright: Color32::from_rgb(0x67, 0xe8, 0xf9),
                accent_soft: Color32::from_rgba_unmultiplied(56, 189, 248, 46),
                accent_border: Color32::from_rgba_unmultiplied(56, 189, 248, 138),
                warm: Some((
                    Color32::from_rgb(0xfb, 0xbf, 0x24),
                    Color32::from_rgba_unmultiplied(251, 191, 36, 41),
                    Color32::from_rgba_unmultiplied(251, 191, 36, 122),
                )),
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 56),
            },
            SimId::Starflight => Self {
                glass_bg: Color32::from_rgba_unmultiplied(7, 11, 20, 158),
                glass_bg_elevated: Color32::from_rgba_unmultiplied(8, 13, 24, 214),
                glass_border: Color32::from_rgba_unmultiplied(148, 197, 255, 36),
                glass_border_strong: Color32::from_rgba_unmultiplied(148, 197, 255, 61),
                text_primary: Color32::from_rgb(0xee, 0xf4, 0xfc),
                text_secondary: Color32::from_rgb(0xa8, 0xbb, 0xd4),
                text_muted: Color32::from_rgba_unmultiplied(203, 218, 238, 173),
                accent: Color32::from_rgb(0x38, 0xbd, 0xf8),
                accent_bright: Color32::from_rgb(0x7d, 0xd3, 0xfc),
                accent_soft: Color32::from_rgba_unmultiplied(56, 189, 248, 46),
                accent_border: Color32::from_rgba_unmultiplied(56, 189, 248, 143),
                warm: Some((
                    Color32::from_rgb(0xfb, 0xbf, 0x24),
                    Color32::from_rgba_unmultiplied(251, 191, 36, 41),
                    Color32::from_rgba_unmultiplied(251, 191, 36, 122),
                )),
                slider_track: Color32::from_rgba_unmultiplied(255, 255, 255, 56),
            },
        }
    }
}

#[derive(Clone, Copy)]
pub struct PresetMeta {
    pub id: &'static str,
    pub full_name: &'static str,
    pub short_label: &'static str,
    pub hotkey: &'static str,
}

#[derive(Clone)]
pub enum ControlKind {
    Range {
        min: f32,
        max: f32,
        step: f32,
        hints: Option<[&'static str; 2]>,
    },
    Select {
        options: Vec<(i32, &'static str)>,
    },
    Segmented {
        options: Vec<(i32, &'static str)>,
    },
}

#[derive(Clone)]
pub struct ControlItem {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ControlKind,
}

#[derive(Clone)]
pub struct ControlSection {
    pub id: &'static str,
    pub title: &'static str,
    pub default_open: bool,
    pub items: Vec<ControlItem>,
}

#[derive(Clone)]
pub struct TelemetryCell {
    pub label: &'static str,
    pub unit: &'static str,
    pub value: String,
}

#[derive(Clone)]
pub struct SpecialActionUi {
    pub label: &'static str,
    pub key_hint: &'static str,
    pub active: bool,
}

#[derive(Clone)]
pub struct HudMetadata {
    pub brand_title: &'static str,
    pub preset_badge: String,
    pub secondary_badge: String,
    pub secondary_badge_warm: bool,
    pub drawer_title: &'static str,
    pub drawer_subtitle: String,
    pub hint_text: &'static str,
    pub telemetry: [TelemetryCell; 6],
    pub special_action: Option<SpecialActionUi>,
    pub orbit_toggle_label: &'static str,
}

#[derive(Default, Clone, Debug)]
pub struct SimInput {
    pub viewport_w: f32,
    pub viewport_h: f32,
    pub primary_drag: bool,
    pub secondary_drag: bool,
    pub shift_down: bool,
    pub drag_delta: [f32; 2],
    pub scroll_y: f32,
    pub key_w: bool,
    pub key_s: bool,
    pub key_a: bool,
    pub key_d: bool,
    pub key_q: bool,
    pub key_e: bool,
    pub key_up: bool,
    pub key_down: bool,
    pub key_left: bool,
    pub key_right: bool,
}

impl SimInput {
    pub fn any_key_held(&self) -> bool {
        self.key_w
            || self.key_s
            || self.key_a
            || self.key_d
            || self.key_q
            || self.key_e
            || self.key_up
            || self.key_down
            || self.key_left
            || self.key_right
    }
}

pub struct StepOutcome {
    pub camera_moved: bool,
    pub sim_time: f32,
    pub reset_accumulation: bool,
}

pub trait Simulation {
    fn id(&self) -> SimId;
    fn theme(&self) -> SimTheme {
        SimTheme::for_sim(self.id())
    }
    fn post_tuning(&self) -> PostTuning {
        PostTuning::default()
    }
    fn post_params(&self, camera_moved: bool, sim_time: f32) -> PostFrameParams;

    fn presets(&self) -> Vec<PresetMeta>;
    fn active_preset_index(&self) -> Option<usize>;
    fn apply_preset(&mut self, index: usize);

    fn control_sections(&self) -> Vec<ControlSection>;
    fn get_f32(&self, key: &str) -> f32;
    /// Sets a float control. Returns `true` if primary ray-tracing accumulation must reset.
    fn set_f32(&mut self, key: &str, val: f32) -> bool;
    fn get_i32(&self, key: &str) -> i32;
    /// Sets an integer/select/segmented control. Returns `true` if primary accumulation must reset.
    fn set_i32(&mut self, key: &str, val: i32) -> bool;
    fn format_value(&self, key: &str) -> String;

    fn paused(&self) -> bool;
    fn set_paused(&mut self, paused: bool);
    fn auto_orbit(&self) -> bool;
    fn toggle_auto_orbit(&mut self);
    fn reset_camera(&mut self);
    fn trigger_special_action(&mut self) {}

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata;

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome;
    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets);
    #[allow(clippy::too_many_arguments)]
    fn encode_frame(
        &mut self,
        assets: &SharedGpuAssets,
        encoder: &mut wgpu::CommandEncoder,
        scene_view: &wgpu::TextureView,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        dt: f32,
        hard_reset: bool,
    );
}

pub fn create_simulation(id: SimId, assets: &mut SharedGpuAssets) -> Box<dyn Simulation> {
    match id {
        SimId::Blackhole => Box::new(blackhole::BlackholeSim::new(assets)),
        SimId::Wormhole => Box::new(wormhole::WormholeSim::new(assets)),
        SimId::BinaryBh => Box::new(binary::BinaryBhSim::new(assets)),
        SimId::WarpDrive => Box::new(warp::WarpDriveSim::new(assets)),
        SimId::Supernova => Box::new(supernova::SupernovaSim::new(assets)),
        SimId::Pulsar => Box::new(pulsar::PulsarSim::new(assets)),
        SimId::Starflight => Box::new(starflight::StarflightSim::new(assets)),
    }
}

pub fn step_critically_damped(
    current: f32,
    velocity: f32,
    target: f32,
    omega: f32,
    dt: f32,
) -> (f32, f32) {
    let diff = current - target;
    let exp = (-omega * dt).exp();
    let next = target + (diff + (velocity + omega * diff) * dt) * exp;
    let next_vel = (velocity - omega * (velocity + omega * diff) * dt) * exp;
    if (next - target).abs() < 1e-6 && next_vel.abs() < 1e-6 {
        (target, 0.0)
    } else {
        (next, next_vel)
    }
}

pub fn wrap_angle_delta(delta: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let mut d = (delta + std::f32::consts::PI).rem_euclid(tau);
    if d < 0.0 {
        d += tau;
    }
    d - std::f32::consts::PI
}

pub fn ease_out_cubic(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}
