use std::collections::HashMap;
use std::time::{Duration, Instant};

use egui::{Context, TextureId};

pub mod controls;
pub mod home;
pub mod hud;
pub mod theme;
pub mod tour_data;

pub use home::{HomeAction, HomeState, draw_homepage};
pub use theme::configure_fonts;

use crate::recorder::RecorderMode;
use crate::renderer::SharedGpuAssets;
use crate::renderer::profiler::PassTimingsSnapshot;
use crate::settings::QualityProfile;
use crate::sims::{HudMetadata, SimId, Simulation};

pub struct HudState {
    pub drawer_open: bool,
    pub help_open: bool,
    pub help_tab: hud::HelpTab,
    pub hud_hidden: bool,
    pub vsync: bool,
    pub quality_profile: QualityProfile,
    pub dpr_cap: f32,
    pub interactive_drag_scale: bool,
    pub profiler_open: bool,
    pub profiler_snapshot: PassTimingsSnapshot,
    pub physics_tour_open: bool,
    pub physics_tour_step: usize,
    pub recorder_mode: RecorderMode,
    pub recorder_duration_sec: u32,
    pub recorder_fps: u32,
    pub recording_active: bool,
    pub recording_frame: u32,
    pub recording_total_frames: u32,
    pub switcher_open: bool,
    pub switcher_query: String,
    pub switcher_focus_search: bool,
    pub switcher_just_opened: bool,
    pub open_sections: HashMap<&'static str, bool>,
    pub status_toast: Option<(String, Instant)>,
    cached_meta: Option<(SimId, Instant, HudMetadata)>,
    meta_dirty: bool,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            drawer_open: false,
            help_open: false,
            help_tab: hud::HelpTab::Controls,
            hud_hidden: false,
            vsync: true,
            quality_profile: QualityProfile::Balanced,
            dpr_cap: 1.5,
            interactive_drag_scale: true,
            profiler_open: false,
            profiler_snapshot: PassTimingsSnapshot::default(),
            physics_tour_open: false,
            physics_tour_step: 0,
            recorder_mode: RecorderMode::Turntable,
            recorder_duration_sec: 8,
            recorder_fps: 30,
            recording_active: false,
            recording_frame: 0,
            recording_total_frames: 0,
            switcher_open: false,
            switcher_query: String::new(),
            switcher_focus_search: false,
            switcher_just_opened: false,
            open_sections: HashMap::new(),
            status_toast: None,
            cached_meta: None,
            meta_dirty: true,
        }
    }
}

impl HudState {
    pub fn show_toast(&mut self, msg: impl Into<String>) {
        self.status_toast = Some((msg.into(), Instant::now()));
    }

    pub fn invalidate_metadata(&mut self) {
        self.meta_dirty = true;
    }

    fn get_or_refresh_metadata(
        &mut self,
        sim: &dyn Simulation,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let now = Instant::now();
        let sim_id = sim.id();
        let need_refresh = self.meta_dirty
            || match &self.cached_meta {
                Some((cached_id, at, _)) => {
                    *cached_id != sim_id || now.duration_since(*at) >= Duration::from_millis(85)
                }
                None => true,
            };
        if need_refresh {
            let fresh = sim.hud_metadata(assets, fps, sample_count, max_samples);
            self.cached_meta = Some((sim_id, now, fresh.clone()));
            self.meta_dirty = false;
            fresh
        } else {
            self.cached_meta.as_ref().unwrap().2.clone()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum HudAction {
    GoHome,
    SwitchSim(SimId),
    ToggleSwitcher,
    SelectPreset(usize),
    TogglePause,
    ToggleAutoOrbit,
    TriggerSpecial,
    ResetCamera,
    CapturePng,
    ToggleHud,
    ToggleDrawer,
    ToggleHelp,
    SetVsync(bool),
    SetQualityProfile(QualityProfile),
    SetDprCap(f32),
    SetInteractiveDragScale(bool),
    ToggleProfiler,
    TogglePhysicsTour,
    StepPhysicsTour(i32),
    SelectTourCallout(usize),
    ToggleRecording,
    SetRecorderMode(RecorderMode),
    SetRecorderDuration(u32),
    SetRecorderFps(u32),
    ControlChanged {
        reset_primary: bool,
        resolution_changed: bool,
    },
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
        hud::draw_restore_hud_pill(ctx, &theme, screen_size, glass_tex_id, &mut actions);
        hud::draw_toast(ctx, hud, &theme, screen_size, glass_tex_id);
        return actions;
    }

    let meta = hud.get_or_refresh_metadata(sim, assets, fps, sample_count, max_samples);
    hud::draw_top_left_card(ctx, &meta, &theme, screen_size, glass_tex_id);
    hud::draw_top_right_bar(
        ctx,
        sim.id(),
        hud,
        &theme,
        screen_size,
        glass_tex_id,
        &mut actions,
    );

    if hud.drawer_open {
        controls::draw_controls_drawer(
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

    if hud.help_open {
        hud::draw_help_modal(
            ctx,
            sim,
            assets,
            hud,
            &theme,
            screen_size,
            glass_tex_id,
            &mut actions,
        );
    }

    if hud.profiler_open {
        hud::draw_gpu_profiler_card(
            ctx,
            &hud.profiler_snapshot,
            &theme,
            screen_size,
            glass_tex_id,
            &mut actions,
        );
    }

    if hud.physics_tour_open {
        let preset_id = sim
            .active_preset_index()
            .and_then(|idx| sim.presets().get(idx))
            .map(|p| p.id)
            .unwrap_or("");
        hud::draw_physics_tour(
            ctx,
            sim.id(),
            preset_id,
            hud,
            &theme,
            screen_size,
            glass_tex_id,
            &mut actions,
        );
    }

    hud::draw_recording_pill(ctx, hud, screen_size, glass_tex_id, &mut actions);
    if !hud.physics_tour_open {
        hud::draw_bottom_left_hint(ctx, meta.hint_text, screen_size);
    }
    hud::draw_bottom_dock(
        ctx,
        sim,
        &meta,
        hud.physics_tour_open,
        &theme,
        screen_size,
        glass_tex_id,
        &mut actions,
    );
    hud::draw_toast(ctx, hud, &theme, screen_size, glass_tex_id);

    actions
}
