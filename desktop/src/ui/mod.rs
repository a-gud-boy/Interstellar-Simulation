use std::collections::HashMap;
use std::time::{Duration, Instant};

use egui::{Context, TextureId};

pub mod controls;
pub mod home;
pub mod hud;
pub mod theme;

pub use home::{HomeAction, HomeState, draw_homepage};
pub use theme::configure_fonts;

use crate::renderer::SharedGpuAssets;
use crate::sims::{HudMetadata, SimId, Simulation};

pub struct HudState {
    pub drawer_open: bool,
    pub hud_hidden: bool,
    pub vsync: bool,
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
            hud_hidden: false,
            vsync: true,
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

#[derive(Clone, Debug, PartialEq, Eq)]
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
    SetVsync(bool),
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

    hud::draw_bottom_left_hint(ctx, meta.hint_text, screen_size);
    hud::draw_bottom_dock(
        ctx,
        sim,
        &meta,
        &theme,
        screen_size,
        glass_tex_id,
        &mut actions,
    );
    hud::draw_toast(ctx, hud, &theme, screen_size, glass_tex_id);

    actions
}
