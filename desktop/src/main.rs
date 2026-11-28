#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{KeyCode, ModifiersState, PhysicalKey};
use winit::window::{Window, WindowId};

use interstellar_desktop::APP_VERSION;
use interstellar_desktop::assets::{icon, sky};
use interstellar_desktop::recorder::{CinemaRecorder, RecorderMode};
use interstellar_desktop::renderer::post::{MAX_PROGRESSIVE_SAMPLES, MAX_RENDER_DPR, PostPipeline};
use interstellar_desktop::renderer::profiler::{GpuPassProfiler, PassCategory};
use interstellar_desktop::renderer::{
    SharedGpuAssets, format_adapter_label, readback_rgba8_texture,
};
use interstellar_desktop::settings::DesktopSettings;
use interstellar_desktop::sims::{SimId, SimInput, Simulation, create_simulation};
use interstellar_desktop::ui::tour_data::preset_tour;
use interstellar_desktop::ui::{
    HomeAction, HomeState, HudAction, HudState, configure_fonts, draw_homepage, draw_hud,
};

const DEFAULT_MAX_FPS: u32 = 165;

#[derive(Debug)]
enum AppEvent {
    SkyReady,
}

struct CliArgs {
    start_sim: Option<SimId>,
    width: u32,
    height: u32,
    vsync: bool,
    vsync_explicit: bool,
    max_fps: u32,
    max_fps_explicit: bool,
    max_dpr: f32,
    max_dpr_explicit: bool,
    smoke_frames: Option<u32>,
    export_parity: Option<PathBuf>,
    parity_sims: Option<String>,
}

fn parse_bool_flag(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

fn parse_sim_arg(val: &str) -> Result<Option<SimId>, String> {
    let key = val.trim().to_ascii_lowercase();
    if matches!(key.as_str(), "home" | "hub" | "index" | "observatory") {
        return Ok(None);
    }
    SimId::from_cli_name(val)
        .map(Some)
        .ok_or_else(|| val.to_string())
}

fn parse_cli_args() -> CliArgs {
    let mut out = CliArgs {
        start_sim: None,
        width: 1280,
        height: 720,
        vsync: true,
        vsync_explicit: false,
        max_fps: DEFAULT_MAX_FPS,
        max_fps_explicit: false,
        max_dpr: MAX_RENDER_DPR,
        max_dpr_explicit: false,
        smoke_frames: None,
        export_parity: None,
        parity_sims: None,
    };
    let mut width_explicit = false;
    let mut height_explicit = false;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--home" || arg == "--hub" {
            out.start_sim = None;
        } else if arg == "--sim" {
            if let Some(val) = it.next() {
                if val.contains(',') || val.eq_ignore_ascii_case("all") {
                    out.parity_sims = Some(val);
                } else {
                    match parse_sim_arg(&val) {
                        Ok(sim) => out.start_sim = sim,
                        Err(bad) => {
                            eprintln!(
                                "[interstellar-desktop] Unknown --sim '{bad}', opening homepage."
                            );
                        }
                    }
                }
            }
        } else if let Some(val) = arg.strip_prefix("--sim=") {
            if val.contains(',') || val.eq_ignore_ascii_case("all") {
                out.parity_sims = Some(val.to_string());
            } else if let Ok(sim) = parse_sim_arg(val) {
                out.start_sim = sim;
            }
        } else if arg == "--export-parity" {
            if let Some(val) = it.next() {
                out.export_parity = Some(PathBuf::from(val));
            }
        } else if let Some(val) = arg.strip_prefix("--export-parity=") {
            out.export_parity = Some(PathBuf::from(val));
        } else if arg == "--width" {
            if let Some(val) = it.next()
                && let Ok(w) = val.parse::<u32>()
            {
                out.width = w.clamp(640, 7680);
                width_explicit = true;
            }
        } else if let Some(val) = arg.strip_prefix("--width=") {
            if let Ok(w) = val.parse::<u32>() {
                out.width = w.clamp(640, 7680);
                width_explicit = true;
            }
        } else if arg == "--height" {
            if let Some(val) = it.next()
                && let Ok(h) = val.parse::<u32>()
            {
                out.height = h.clamp(360, 4320);
                height_explicit = true;
            }
        } else if let Some(val) = arg.strip_prefix("--height=") {
            if let Ok(h) = val.parse::<u32>() {
                out.height = h.clamp(360, 4320);
                height_explicit = true;
            }
        } else if arg == "--vsync" {
            if let Some(val) = it.next()
                && let Some(b) = parse_bool_flag(&val)
            {
                out.vsync = b;
                out.vsync_explicit = true;
            }
        } else if let Some(val) = arg.strip_prefix("--vsync=") {
            if let Some(b) = parse_bool_flag(val) {
                out.vsync = b;
                out.vsync_explicit = true;
            }
        } else if arg == "--max-fps" {
            if let Some(val) = it.next()
                && let Ok(n) = val.parse::<u32>()
            {
                out.max_fps = n.clamp(15, 1000);
                out.max_fps_explicit = true;
            }
        } else if let Some(val) = arg.strip_prefix("--max-fps=") {
            if let Ok(n) = val.parse::<u32>() {
                out.max_fps = n.clamp(15, 1000);
                out.max_fps_explicit = true;
            }
        } else if arg == "--max-dpr" {
            if let Some(val) = it.next()
                && let Ok(d) = val.parse::<f32>()
            {
                out.max_dpr = d.clamp(1.0, 4.0);
                out.max_dpr_explicit = true;
            }
        } else if let Some(val) = arg.strip_prefix("--max-dpr=") {
            if let Ok(d) = val.parse::<f32>() {
                out.max_dpr = d.clamp(1.0, 4.0);
                out.max_dpr_explicit = true;
            }
        } else if arg == "--smoke-frames" {
            if let Some(val) = it.next()
                && let Ok(n) = val.parse::<u32>()
            {
                out.smoke_frames = Some(n.max(1));
            }
        } else if let Some(val) = arg.strip_prefix("--smoke-frames=") {
            if let Ok(n) = val.parse::<u32>() {
                out.smoke_frames = Some(n.max(1));
            }
        } else if arg == "--version" || arg == "-V" {
            println!("Interstellar Desktop {APP_VERSION}");
            std::process::exit(0);
        } else if arg == "--help" || arg == "-h" {
            println!(
                "Interstellar Desktop {APP_VERSION} — Relativistic GPU Simulator Suite\n\n\
                 USAGE:\n  interstellar-desktop [OPTIONS]\n\n\
                 OPTIONS:\n  \
                   --home, --hub           Open Observatory Homepage (default)\n  \
                   --sim <name>            home | blackhole | wormhole | binary | warp | supernova | pulsar | starflight | lens-cluster | tde\n  \
                   --width <px>            Initial window width (default: 1280)\n  \
                   --height <px>           Initial window height (default: 720)\n  \
                   --vsync <on|off>        Initial VSync mode (default: on)\n  \
                   --max-fps <n>           Maximum frame rate cap (default: {DEFAULT_MAX_FPS})\n  \
                   --max-dpr <f>           Render target DPR cap (default: {MAX_RENDER_DPR:.1})\n  \
                   --smoke-frames <n>      Render N live windowed frames and exit cleanly\n  \
                   --export-parity <dir>   Headless clean-canvas PNG export for parity diffing\n  \
                   --version, -V           Print version information\n"
            );
            std::process::exit(0);
        }
    }
    if out.export_parity.is_some() {
        if !width_explicit {
            out.width = 960;
        }
        if !height_explicit {
            out.height = 540;
        }
    }
    out
}

fn pick_present_mode(present_modes: &[wgpu::PresentMode], vsync: bool) -> wgpu::PresentMode {
    if vsync {
        wgpu::PresentMode::Fifo
    } else if present_modes.contains(&wgpu::PresentMode::Mailbox) {
        wgpu::PresentMode::Mailbox
    } else if present_modes.contains(&wgpu::PresentMode::Immediate) {
        wgpu::PresentMode::Immediate
    } else {
        wgpu::PresentMode::Fifo
    }
}

fn screenshot_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join("Pictures").join("Interstellar");
        }
    }
    PathBuf::from("screenshots")
}

fn formatted_home_title() -> String {
    format!("Interstellar Observatory · v{}", APP_VERSION)
}

fn formatted_window_title(sim: SimId) -> String {
    format!("{} · v{}", sim.window_title(), APP_VERSION)
}

struct InputTracker {
    modifiers: ModifiersState,
    cursor_pos: Option<[f64; 2]>,
    pending_drag_delta: [f32; 2],
    pending_scroll_y: f32,
    left_down_canvas: bool,
    right_down_canvas: bool,
    middle_down_canvas: bool,
    last_left_click_at: Option<(Instant, [f64; 2])>,
    key_w: bool,
    key_s: bool,
    key_a: bool,
    key_d: bool,
    key_q: bool,
    key_e: bool,
    key_up: bool,
    key_down: bool,
    key_left: bool,
    key_right: bool,
}

impl Default for InputTracker {
    fn default() -> Self {
        Self {
            modifiers: ModifiersState::empty(),
            cursor_pos: None,
            pending_drag_delta: [0.0; 2],
            pending_scroll_y: 0.0,
            left_down_canvas: false,
            right_down_canvas: false,
            middle_down_canvas: false,
            last_left_click_at: None,
            key_w: false,
            key_s: false,
            key_a: false,
            key_d: false,
            key_q: false,
            key_e: false,
            key_up: false,
            key_down: false,
            key_left: false,
            key_right: false,
        }
    }
}

impl InputTracker {
    fn clear(&mut self) {
        self.pending_drag_delta = [0.0; 2];
        self.pending_scroll_y = 0.0;
        self.left_down_canvas = false;
        self.right_down_canvas = false;
        self.middle_down_canvas = false;
        self.key_w = false;
        self.key_s = false;
        self.key_a = false;
        self.key_d = false;
        self.key_q = false;
        self.key_e = false;
        self.key_up = false;
        self.key_down = false;
        self.key_left = false;
        self.key_right = false;
    }

    fn set_nav_key(&mut self, code: KeyCode, pressed: bool) {
        match code {
            KeyCode::KeyW => self.key_w = pressed,
            KeyCode::KeyS => self.key_s = pressed,
            KeyCode::KeyA => self.key_a = pressed,
            KeyCode::KeyD => self.key_d = pressed,
            KeyCode::KeyQ => self.key_q = pressed,
            KeyCode::KeyE => self.key_e = pressed,
            KeyCode::ArrowUp => self.key_up = pressed,
            KeyCode::ArrowDown => self.key_down = pressed,
            KeyCode::ArrowLeft => self.key_left = pressed,
            KeyCode::ArrowRight => self.key_right = pressed,
            _ => {}
        }
    }

    fn is_dragging(&self) -> bool {
        self.left_down_canvas || self.right_down_canvas || self.middle_down_canvas
    }

    fn any_key_held(&self) -> bool {
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

    fn take_sim_input(&mut self, viewport_w: f32, viewport_h: f32) -> SimInput {
        let delta = self.pending_drag_delta;
        let scroll = self.pending_scroll_y;
        self.pending_drag_delta = [0.0; 2];
        self.pending_scroll_y = 0.0;

        SimInput {
            viewport_w,
            viewport_h,
            primary_drag: self.left_down_canvas || self.middle_down_canvas,
            secondary_drag: self.right_down_canvas,
            shift_down: self.modifiers.shift_key() || self.middle_down_canvas,
            drag_delta: delta,
            scroll_y: scroll,
            key_w: self.key_w,
            key_s: self.key_s,
            key_a: self.key_a,
            key_d: self.key_d,
            key_q: self.key_q,
            key_e: self.key_e,
            key_up: self.key_up,
            key_down: self.key_down,
            key_left: self.key_left,
            key_right: self.key_right,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum AppScreen {
    Home,
    Sim,
}

struct SimRuntime {
    assets: SharedGpuAssets,
    post: PostPipeline,
    profiler: GpuPassProfiler,
    sim: Box<dyn Simulation>,
    glass_tex_id: egui::TextureId,
}

struct RuntimeState {
    egui_state: egui_winit::State,
    egui_renderer: egui_wgpu::Renderer,
    egui_ctx: egui::Context,
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    adapter_info: wgpu::AdapterInfo,
    adapter_label: String,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    supported_present_modes: Vec<wgpu::PresentMode>,
    window: Arc<Window>,
    proxy: EventLoopProxy<AppEvent>,

    screen: AppScreen,
    home: HomeState,
    sim_rt: Option<SimRuntime>,
    prestarted_sky_rx: Option<Receiver<sky::RgbaImageData>>,

    hud: HudState,
    settings: DesktopSettings,
    recorder: Option<CinemaRecorder>,
    input: InputTracker,
    frame_interval: Duration,
    max_fps_explicit: bool,
    max_dpr: f32,
    interactive_drag_scale_enabled: bool,
    drag_settle_until: Option<Instant>,
    interactive_scale_active: bool,
    next_frame_at: Instant,
    last_frame_at: Instant,
    fps_smoothed: f32,
    fps_initialized: bool,
    rendered_frames: u32,
    needs_redraw: bool,
    next_repaint_at: Option<Instant>,
    last_sim_idle: bool,
}

impl RuntimeState {
    fn new(window: Arc<Window>, cli: &CliArgs, proxy: EventLoopProxy<AppEvent>) -> Self {
        let size = window.inner_size();
        let win_w = size.width.max(1);
        let win_h = size.height.max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let surface = instance
            .create_surface(window.clone())
            .expect("Failed to create wgpu surface for window");

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .expect("No compatible GPU adapter found for wgpu surface");

        let adapter_info = adapter.get_info();
        let adapter_label = format_adapter_label(&adapter_info);
        let mut required_features = wgpu::Features::empty();
        if adapter
            .features()
            .contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE)
        {
            required_features |= wgpu::Features::RG11B10UFLOAT_RENDERABLE;
        }
        if adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            required_features |= wgpu::Features::TIMESTAMP_QUERY;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("interstellar-desktop-device"),
            required_features,
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
        }))
        .expect("Failed to open wgpu device");

        let device = Arc::new(device);
        let queue = Arc::new(queue);

        let settings = DesktopSettings::load();
        let effective_vsync = if cli.vsync_explicit {
            cli.vsync
        } else if settings.has_saved {
            settings.vsync
        } else {
            cli.vsync
        };
        let effective_max_dpr = if cli.max_dpr_explicit {
            cli.max_dpr
        } else if settings.has_saved {
            settings.dpr_cap
        } else {
            cli.max_dpr
        };
        let effective_drag_scale = cli.smoke_frames.is_none()
            && if settings.has_saved {
                settings.interactive_drag_scale
            } else {
                true
            };

        let caps = surface.get_capabilities(&adapter);
        let surface_format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let present_mode = pick_present_mode(&caps.present_modes, effective_vsync);
        let alpha_mode = caps.alpha_modes[0];

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: win_w,
            height: win_h,
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &surface_config);

        let egui_ctx = egui::Context::default();
        configure_fonts(&egui_ctx);

        let egui_state = egui_winit::State::new(
            egui_ctx.clone(),
            egui::ViewportId::ROOT,
            &window,
            Some(window.scale_factor() as f32),
            Some(winit::window::Theme::Dark),
            Some(device.limits().max_texture_dimension_2d as usize),
        );

        let egui_renderer = egui_wgpu::Renderer::new(
            &device,
            surface_format,
            egui_wgpu::RendererOptions::default(),
        );

        // Start 4K Milky Way decode immediately in background so Observatory Homepage / Sim warm-start finishes in parallel
        let (sky_tx, sky_rx) = mpsc::channel();
        let sky_proxy = proxy.clone();
        std::thread::spawn(move || {
            let real_sky = sky::decode_real_milkyway_4k();
            if sky_tx.send(real_sky).is_ok() {
                let _ = sky_proxy.send_event(AppEvent::SkyReady);
            }
        });

        let now = Instant::now();
        let mut state = Self {
            window,
            proxy,
            surface,
            surface_config,
            supported_present_modes: caps.present_modes,
            device,
            queue,
            adapter_info,
            adapter_label,
            egui_ctx,
            egui_state,
            egui_renderer,
            screen: AppScreen::Home,
            home: HomeState::default(),
            sim_rt: None,
            prestarted_sky_rx: Some(sky_rx),
            hud: {
                let mut hud = HudState::default();
                hud.vsync = effective_vsync;
                hud.quality_profile = settings.quality_profile;
                hud.dpr_cap = effective_max_dpr;
                hud.interactive_drag_scale = effective_drag_scale;
                hud
            },
            settings,
            recorder: None,
            input: InputTracker::default(),
            frame_interval: Duration::from_secs_f64(1.0 / cli.max_fps.max(15) as f64),
            max_fps_explicit: cli.max_fps_explicit,
            max_dpr: effective_max_dpr,
            interactive_drag_scale_enabled: effective_drag_scale,
            drag_settle_until: None,
            interactive_scale_active: false,
            next_frame_at: now,
            last_frame_at: now,
            fps_smoothed: cli.max_fps.min(60) as f32,
            fps_initialized: false,
            rendered_frames: 0,
            needs_redraw: true,
            next_repaint_at: None,
            last_sim_idle: false,
        };

        if let Some(sim_id) = cli.start_sim {
            state.enter_sim(sim_id, None);
        } else {
            state.window.set_title(&formatted_home_title());
        }

        state
    }

    fn enter_home(&mut self) {
        self.stop_recording(false);
        self.screen = AppScreen::Home;
        self.input.clear();
        self.hud.hud_hidden = false;
        self.hud.drawer_open = false;
        self.hud.physics_tour_open = false;
        self.hud.switcher_open = false;
        self.hud.switcher_query.clear();
        self.hud.switcher_focus_search = false;
        self.window.set_title(&formatted_home_title());
        self.needs_redraw = true;
        self.next_repaint_at = None;
    }

    fn enter_sim(&mut self, sim_id: SimId, preset: Option<usize>) {
        self.stop_recording(false);
        let win_w = self.surface_config.width.max(1);
        let win_h = self.surface_config.height.max(1);
        let scale_factor = self.window.scale_factor() as f32;
        let max_dpr = self.max_dpr;

        if self.sim_rt.is_none() {
            let wake_proxy = self.proxy.clone();
            let mut assets = SharedGpuAssets::new(
                self.device.clone(),
                self.queue.clone(),
                self.adapter_info.clone(),
                false,
                self.prestarted_sky_rx.take(),
                Some(Box::new(move || {
                    let _ = wake_proxy.send_event(AppEvent::SkyReady);
                })),
            );
            let mut sim = create_simulation(sim_id, &mut assets);
            if let Some(idx) = preset {
                sim.apply_preset(idx);
            }
            if self.settings.has_saved {
                sim.set_i32("quality", self.settings.quality_tier);
                sim.set_i32("resolutionScale", self.settings.resolution_scale);
            }
            if sim.get_i32("skyMode") == 2 && assets.ensure_procedural_sky_a() {
                sim.rebuild_bind_groups(&mut assets);
            }
            let res_scale = (sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
            let post = PostPipeline::new(
                &assets.device,
                &assets.queue,
                assets.s_linear_clamp.clone(),
                self.surface_config.format,
                win_w,
                win_h,
                scale_factor,
                max_dpr,
                res_scale,
            );
            let glass_tex_id = self.egui_renderer.register_native_texture(
                &assets.device,
                &post.glass_backdrop_rt.view,
                wgpu::FilterMode::Linear,
            );
            let profiler = GpuPassProfiler::new(&self.device, &self.queue);
            self.sim_rt = Some(SimRuntime {
                assets,
                post,
                profiler,
                sim,
                glass_tex_id,
            });
        } else if let Some(sr) = &mut self.sim_rt {
            if sr.sim.id() != sim_id {
                sr.sim = create_simulation(sim_id, &mut sr.assets);
                self.hud.open_sections.clear();
            }
            if let Some(idx) = preset {
                sr.sim.apply_preset(idx);
            }
            if self.settings.has_saved {
                sr.sim.set_i32("quality", self.settings.quality_tier);
                sr.sim
                    .set_i32("resolutionScale", self.settings.resolution_scale);
            }
            if sr.sim.get_i32("skyMode") == 2 && sr.assets.ensure_procedural_sky_a() {
                sr.sim.rebuild_bind_groups(&mut sr.assets);
            }
            let res_scale = (sr.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
            if sr.post.resize(
                &sr.assets.device,
                &sr.assets.queue,
                win_w,
                win_h,
                scale_factor,
                max_dpr,
                res_scale,
            ) {
                self.egui_renderer.update_egui_texture_from_wgpu_texture(
                    &sr.assets.device,
                    &sr.post.glass_backdrop_rt.view,
                    wgpu::FilterMode::Linear,
                    sr.glass_tex_id,
                );
            }
            sr.post.reset_accumulation(true);
        }

        self.screen = AppScreen::Sim;
        self.home.spotlight = sim_id;
        self.home.inspect_sim = None;
        self.hud.hud_hidden = false;
        self.hud.drawer_open = false;
        self.hud.physics_tour_step = 0;
        self.hud.switcher_open = false;
        self.hud.switcher_query.clear();
        self.hud.switcher_focus_search = false;
        self.hud.invalidate_metadata();
        self.input.clear();
        self.drag_settle_until = None;
        self.interactive_scale_active = false;
        self.last_sim_idle = false;
        let now = Instant::now();
        self.last_frame_at = now;
        self.next_frame_at = now;
        self.window.set_title(&formatted_window_title(sim_id));
        self.needs_redraw = true;
    }

    fn sync_post_resize(&mut self, effective_scale: f32) {
        let win_w = self.surface_config.width.max(1);
        let win_h = self.surface_config.height.max(1);
        let scale_factor = self.window.scale_factor() as f32;
        let max_dpr = self.max_dpr;
        if let Some(sr) = &mut self.sim_rt
            && sr.post.resize(
                &sr.assets.device,
                &sr.assets.queue,
                win_w,
                win_h,
                scale_factor,
                max_dpr,
                effective_scale,
            )
        {
            self.egui_renderer.update_egui_texture_from_wgpu_texture(
                &sr.assets.device,
                &sr.post.glass_backdrop_rt.view,
                wgpu::FilterMode::Linear,
                sr.glass_tex_id,
            );
        }
    }

    fn reconfigure_surface(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);

        if let Some(sr) = &self.sim_rt {
            let base = (sr.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
            let eff = if self.interactive_scale_active {
                (base * 0.75).max(0.375)
            } else {
                base
            };
            self.sync_post_resize(eff);
        }
        self.needs_redraw = true;
    }

    fn apply_vsync(&mut self, vsync: bool) {
        self.hud.vsync = vsync;
        self.surface_config.present_mode = pick_present_mode(&self.supported_present_modes, vsync);
        self.surface.configure(&self.device, &self.surface_config);
    }

    fn start_recording(&mut self) {
        if self.recorder.is_some() {
            return;
        }
        let Some(sr) = &mut self.sim_rt else {
            return;
        };
        sr.sim.set_paused(false);
        if self.hud.recorder_mode == RecorderMode::Turntable {
            let _ = sr.sim.set_i32("dragMode", 0);
        } else if self.hud.recorder_mode == RecorderMode::Evolution {
            match sr.sim.id() {
                SimId::Supernova | SimId::Wormhole => sr.sim.trigger_special_action(),
                SimId::BinaryBh => {
                    let _ = sr.sim.set_i32("inspiralEnabled", 1);
                }
                SimId::LensCluster => {
                    let _ = sr.sim.set_f32("sourceOrbitSpeed", 0.65);
                }
                SimId::WarpDrive => {
                    let _ = sr.sim.set_f32("warpSpeed", 0.6);
                }
                SimId::Starflight => {
                    let _ = sr.sim.set_i32("flightMode", 0);
                    let _ = sr.sim.set_f32("rapidity", 0.25);
                }
                _ => {}
            }
        }

        let base_dir = screenshot_dir();
        match CinemaRecorder::start(
            &base_dir,
            sr.sim.id().cli_name(),
            self.hud.recorder_mode,
            self.hud.recorder_fps,
            self.hud.recorder_duration_sec,
        ) {
            Ok(rec) => {
                self.hud.recording_active = true;
                self.hud.recording_frame = 0;
                self.hud.recording_total_frames = rec.total_frames;
                let msg = format!(
                    "Recording {} PNG sequence ({} frames)…",
                    rec.mode.slug(),
                    rec.total_frames
                );
                self.recorder = Some(rec);
                self.hud.show_toast(msg);
                self.needs_redraw = true;
            }
            Err(err) => {
                let msg = format!("Recorder failed to start: {err}");
                eprintln!("[interstellar-desktop] {msg}");
                self.hud.show_toast(msg);
            }
        }
    }

    fn stop_recording(&mut self, show_toast: bool) {
        let Some(rec) = self.recorder.take() else {
            return;
        };
        let (out_dir, count) = rec.finish();
        self.hud.recording_active = false;
        self.hud.recording_frame = 0;
        self.hud.recording_total_frames = 0;
        if show_toast {
            let msg = format!("Saved {} PNG frames → {}", count, out_dir.display());
            println!("[interstellar-desktop] {msg}");
            self.hud.show_toast(msg);
        }
    }

    fn capture_png(&mut self) {
        let Some(sr) = &self.sim_rt else {
            return;
        };
        let dir = screenshot_dir();
        let _ = std::fs::create_dir_all(&dir);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("{}_{}.png", sr.sim.id().cli_name(), ts));
        let rgba = readback_rgba8_texture(
            &sr.assets.device,
            &sr.assets.queue,
            &sr.post.composite_rt.texture,
            sr.post.composite_rt.width,
            sr.post.composite_rt.height,
        );
        match image::save_buffer(
            &path,
            &rgba,
            sr.post.composite_rt.width,
            sr.post.composite_rt.height,
            image::ColorType::Rgba8,
        ) {
            Ok(()) => {
                let msg = format!("Saved {}", path.display());
                println!("[interstellar-desktop] {msg}");
                self.hud.show_toast(msg);
            }
            Err(err) => {
                let msg = format!("PNG save failed: {err}");
                eprintln!("[interstellar-desktop] {msg}");
                self.hud.show_toast(msg);
            }
        }
    }

    fn handle_hud_actions(&mut self, actions: Vec<HudAction>) {
        self.hud.invalidate_metadata();
        for act in actions {
            match act {
                HudAction::GoHome => {
                    self.enter_home();
                    return;
                }
                HudAction::SwitchSim(next_id) => {
                    self.hud.switcher_open = false;
                    self.hud.switcher_query.clear();
                    self.hud.switcher_focus_search = false;
                    if self
                        .sim_rt
                        .as_ref()
                        .is_some_and(|sr| sr.sim.id() != next_id)
                    {
                        self.enter_sim(next_id, None);
                    }
                }
                HudAction::ToggleSwitcher => {
                    self.hud.switcher_open = !self.hud.switcher_open;
                    if self.hud.switcher_open {
                        self.hud.drawer_open = false;
                        self.hud.switcher_query.clear();
                        self.hud.switcher_focus_search = true;
                        self.hud.switcher_just_opened = true;
                    } else {
                        self.hud.switcher_query.clear();
                        self.hud.switcher_focus_search = false;
                    }
                }
                HudAction::SelectPreset(idx) => {
                    if let Some(sr) = &mut self.sim_rt {
                        sr.sim.apply_preset(idx);
                        sr.post.reset_accumulation(true);
                        self.hud.physics_tour_step = 0;
                    }
                }
                HudAction::TogglePause => {
                    if let Some(sr) = &mut self.sim_rt {
                        let next = !sr.sim.paused();
                        sr.sim.set_paused(next);
                    }
                }
                HudAction::ToggleAutoOrbit => {
                    if let Some(sr) = &mut self.sim_rt {
                        sr.sim.toggle_auto_orbit();
                    }
                }
                HudAction::TriggerSpecial => {
                    if let Some(sr) = &mut self.sim_rt {
                        sr.sim.trigger_special_action();
                    }
                }
                HudAction::ResetCamera => {
                    if let Some(sr) = &mut self.sim_rt {
                        sr.sim.reset_camera();
                        sr.post.reset_accumulation(true);
                    }
                }
                HudAction::CapturePng => {
                    self.capture_png();
                }
                HudAction::ToggleHud => {
                    self.hud.hud_hidden = !self.hud.hud_hidden;
                    if self.hud.hud_hidden {
                        self.hud.switcher_open = false;
                        self.hud.switcher_query.clear();
                        self.hud.switcher_focus_search = false;
                    }
                }
                HudAction::ToggleDrawer => {
                    self.hud.drawer_open = !self.hud.drawer_open;
                    if self.hud.drawer_open {
                        self.hud.switcher_open = false;
                        self.hud.switcher_query.clear();
                        self.hud.switcher_focus_search = false;
                    }
                }
                HudAction::SetVsync(v) => {
                    self.apply_vsync(v);
                    self.settings.vsync = v;
                    self.settings.has_saved = true;
                    self.settings.save();
                }
                HudAction::SetQualityProfile(profile) => {
                    self.settings.apply_profile(profile);
                    self.settings.has_saved = true;
                    self.max_dpr = self.settings.dpr_cap;
                    self.interactive_drag_scale_enabled = self.settings.interactive_drag_scale;
                    self.hud.quality_profile = profile;
                    self.hud.dpr_cap = self.settings.dpr_cap;
                    self.hud.interactive_drag_scale = self.settings.interactive_drag_scale;
                    if let Some(sr) = &mut self.sim_rt {
                        sr.sim.set_i32("quality", self.settings.quality_tier);
                        sr.sim
                            .set_i32("resolutionScale", self.settings.resolution_scale);
                        sr.post.reset_accumulation(true);
                    }
                    let base_scale =
                        (self.settings.resolution_scale as f32 / 100.0).clamp(0.5, 1.0);
                    self.sync_post_resize(base_scale);
                    self.settings.save();
                    self.hud
                        .show_toast(format!("Quality profile: {}", profile.as_str()));
                }
                HudAction::SetDprCap(cap) => {
                    let clamped = cap.clamp(1.0, 3.0);
                    self.max_dpr = clamped;
                    self.hud.dpr_cap = clamped;
                    self.settings.dpr_cap = clamped;
                    self.settings.quality_profile = self.settings.infer_profile();
                    self.hud.quality_profile = self.settings.quality_profile;
                    self.settings.has_saved = true;
                    let base_scale = self
                        .sim_rt
                        .as_ref()
                        .map(|sr| {
                            (sr.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0)
                        })
                        .unwrap_or(1.0);
                    self.sync_post_resize(base_scale);
                    if let Some(sr) = &mut self.sim_rt {
                        sr.post.reset_accumulation(true);
                    }
                    self.settings.save();
                }
                HudAction::SetInteractiveDragScale(enabled) => {
                    self.interactive_drag_scale_enabled = enabled;
                    self.hud.interactive_drag_scale = enabled;
                    self.settings.interactive_drag_scale = enabled;
                    if !enabled {
                        self.drag_settle_until = None;
                        self.interactive_scale_active = false;
                    }
                    self.settings.has_saved = true;
                    self.settings.save();
                }
                HudAction::ToggleProfiler => {
                    self.hud.profiler_open = !self.hud.profiler_open;
                    if let Some(sr) = &mut self.sim_rt {
                        sr.profiler.set_enabled(self.hud.profiler_open);
                        self.hud.profiler_snapshot = sr.profiler.snapshot();
                    }
                }
                HudAction::TogglePhysicsTour => {
                    self.hud.physics_tour_open = !self.hud.physics_tour_open;
                    if self.hud.physics_tour_open {
                        self.hud.physics_tour_step = 0;
                    }
                }
                HudAction::StepPhysicsTour(delta) => {
                    if let Some(sr) = &self.sim_rt {
                        let preset_id = sr
                            .sim
                            .active_preset_index()
                            .and_then(|i| sr.sim.presets().get(i))
                            .map(|p| p.id)
                            .unwrap_or("");
                        let len = preset_tour(sr.sim.id(), preset_id).callouts.len().max(1);
                        let cur = self.hud.physics_tour_step as isize;
                        let next = (cur + delta as isize).rem_euclid(len as isize) as usize;
                        self.hud.physics_tour_step = next;
                    }
                }
                HudAction::SelectTourCallout(idx) => {
                    self.hud.physics_tour_step = idx;
                }
                HudAction::ToggleRecording => {
                    if self.recorder.is_some() {
                        self.stop_recording(true);
                    } else {
                        self.start_recording();
                    }
                }
                HudAction::SetRecorderMode(mode) => {
                    self.hud.recorder_mode = mode;
                }
                HudAction::SetRecorderDuration(dur) => {
                    self.hud.recorder_duration_sec = dur.clamp(2, 30);
                }
                HudAction::SetRecorderFps(fps) => {
                    self.hud.recorder_fps = fps.clamp(15, 60);
                }
                HudAction::ControlChanged {
                    reset_primary,
                    resolution_changed,
                } => {
                    if resolution_changed {
                        self.drag_settle_until = None;
                        self.interactive_scale_active = false;
                        let base_scale = self
                            .sim_rt
                            .as_ref()
                            .map(|sr| {
                                (sr.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0)
                            })
                            .unwrap_or(1.0);
                        self.sync_post_resize(base_scale);
                    }
                    if let Some(sr) = &mut self.sim_rt {
                        let cur_q = sr.sim.get_i32("quality");
                        let cur_res = sr.sim.get_i32("resolutionScale");
                        if resolution_changed || cur_q != self.settings.quality_tier {
                            self.settings.quality_tier = cur_q.clamp(0, 2);
                            self.settings.resolution_scale = cur_res;
                            self.settings.quality_profile = self.settings.infer_profile();
                            self.hud.quality_profile = self.settings.quality_profile;
                            self.settings.has_saved = true;
                            self.settings.save();
                        }
                        if reset_primary {
                            sr.post.reset_accumulation(true);
                        } else {
                            sr.post.mark_post_dirty();
                        }
                    }
                }
            }
        }
    }

    fn handle_shortcut(&mut self, code: KeyCode) {
        if self.screen == AppScreen::Home {
            if !self.egui_ctx.egui_wants_keyboard_input()
                && self.home.inspect_sim.is_none()
                && !self.home.controls_open
            {
                if matches!(code, KeyCode::ArrowLeft | KeyCode::ArrowRight) {
                    use interstellar_desktop::ui::home::{CategoryFilter, catalog_entry};
                    let visible: Vec<SimId> = SimId::ALL
                        .iter()
                        .copied()
                        .filter(|&id| {
                            self.home.category == CategoryFilter::All
                                || catalog_entry(id).category == self.home.category
                        })
                        .collect();
                    if !visible.is_empty() {
                        let idx = visible
                            .iter()
                            .position(|&s| s == self.home.spotlight)
                            .unwrap_or(0);
                        let next = if code == KeyCode::ArrowRight {
                            (idx + 1) % visible.len()
                        } else {
                            (idx + visible.len() - 1) % visible.len()
                        };
                        self.home.spotlight = visible[next];
                        self.needs_redraw = true;
                    }
                } else if code == KeyCode::Enter {
                    self.enter_sim(self.home.spotlight, None);
                }
            }
            return;
        }

        if code == KeyCode::Escape && self.hud.switcher_open {
            self.hud.switcher_open = false;
            self.hud.switcher_query.clear();
            self.hud.switcher_focus_search = false;
            self.needs_redraw = true;
            return;
        }

        if self.egui_ctx.egui_wants_keyboard_input() {
            return;
        }
        let mut actions = Vec::new();
        match code {
            KeyCode::Digit1 => actions.push(HudAction::SelectPreset(0)),
            KeyCode::Digit2 => actions.push(HudAction::SelectPreset(1)),
            KeyCode::Digit3 => actions.push(HudAction::SelectPreset(2)),
            KeyCode::Digit4 => actions.push(HudAction::SelectPreset(3)),
            KeyCode::Digit5 => actions.push(HudAction::SelectPreset(4)),
            KeyCode::Digit6 => actions.push(HudAction::SelectPreset(5)),
            KeyCode::Space => actions.push(HudAction::TogglePause),
            KeyCode::KeyO => actions.push(HudAction::ToggleAutoOrbit),
            KeyCode::KeyR => actions.push(HudAction::ResetCamera),
            KeyCode::KeyP => actions.push(HudAction::CapturePng),
            KeyCode::KeyH => actions.push(HudAction::ToggleHud),
            KeyCode::KeyT => actions.push(HudAction::TriggerSpecial),
            KeyCode::KeyC => actions.push(HudAction::ToggleDrawer),
            KeyCode::KeyG => actions.push(HudAction::ToggleProfiler),
            KeyCode::KeyI => actions.push(HudAction::TogglePhysicsTour),
            KeyCode::KeyV => actions.push(HudAction::ToggleRecording),
            KeyCode::BracketLeft if self.hud.physics_tour_open => {
                actions.push(HudAction::StepPhysicsTour(-1));
            }
            KeyCode::BracketRight if self.hud.physics_tour_open => {
                actions.push(HudAction::StepPhysicsTour(1));
            }
            KeyCode::Escape if self.hud.drawer_open => actions.push(HudAction::ToggleDrawer),
            _ => {}
        }
        if !actions.is_empty() {
            self.handle_hud_actions(actions);
        }
    }

    fn render_home_frame(&mut self) {
        let size = self.window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }
        if size.width != self.surface_config.width || size.height != self.surface_config.height {
            self.reconfigure_surface(size.width, size.height);
        }

        let (frame, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(tex) => (tex, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(tex) => (tex, true),
            wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
                self.reconfigure_surface(size.width, size.height);
                return;
            }
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Validation => return,
        };
        let frame_view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let raw_input = self.egui_state.take_egui_input(&self.window);
        let mut home_action = None;

        let mut full_output = self.egui_ctx.run_ui(raw_input, |ui| {
            home_action = draw_homepage(ui.ctx(), &mut self.home, &self.adapter_label);
        });

        self.egui_state
            .handle_platform_output(&self.window, full_output.platform_output);

        let repaint_delay = full_output
            .viewport_output
            .get(&egui::ViewportId::ROOT)
            .map(|v| v.repaint_delay)
            .unwrap_or(Duration::MAX);

        self.needs_redraw = repaint_delay.is_zero();
        self.next_repaint_at = if repaint_delay.is_zero() || repaint_delay > Duration::from_secs(60)
        {
            None
        } else {
            Some(Instant::now() + repaint_delay)
        };

        for (id, deltas) in &full_output.textures_delta.set {
            for delta in deltas {
                self.egui_renderer
                    .update_texture(&self.device, &self.queue, *id, delta);
            }
        }

        let paint_jobs = self
            .egui_ctx
            .tessellate(full_output.shapes, full_output.pixels_per_point);
        let screen_desc = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [size.width, size.height],
            pixels_per_point: full_output.pixels_per_point,
        };

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("desktop-home-encoder"),
            });
        let extra_cmds = self.egui_renderer.update_buffers(
            &self.device,
            &self.queue,
            &mut encoder,
            &paint_jobs,
            &screen_desc,
        );

        {
            let rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("egui-home-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &frame_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.012,
                            g: 0.020,
                            b: 0.039,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            let mut rpass_static = rpass.forget_lifetime();
            self.egui_renderer
                .render(&mut rpass_static, &paint_jobs, &screen_desc);
        }

        let mut cmd_bufs = extra_cmds;
        cmd_bufs.push(encoder.finish());
        self.queue.submit(cmd_bufs);
        if let Some(sr) = &mut self.sim_rt {
            sr.profiler.after_submit();
        }
        self.queue.present(frame);

        if suboptimal {
            self.reconfigure_surface(size.width, size.height);
        }

        for id in &full_output.textures_delta.free {
            self.egui_renderer.free_texture(id);
        }
        full_output.textures_delta.clear();

        self.rendered_frames += 1;

        if let Some(HomeAction::LaunchSim { sim, preset }) = home_action {
            self.enter_sim(sim, preset);
        }
    }

    fn render_frame(&mut self) {
        if self.screen == AppScreen::Home {
            self.render_home_frame();
            return;
        }

        let now = Instant::now();
        let next = self.next_frame_at + self.frame_interval;
        self.next_frame_at = if now > next {
            now + self.frame_interval
        } else {
            next
        };

        let raw_dt = (now - self.last_frame_at).as_secs_f32();
        self.last_frame_at = now;
        let dt = raw_dt.clamp(0.0, 0.05);
        let was_sim_idle = self.last_sim_idle;

        let size = self.window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }
        if size.width != self.surface_config.width || size.height != self.surface_config.height {
            self.reconfigure_surface(size.width, size.height);
        }

        let ppp = self.window.scale_factor() as f32;
        let vp_w = size.width as f32 / ppp.max(1.0);
        let vp_h = size.height as f32 / ppp.max(1.0);
        let input_active = self.input.is_dragging()
            || self.input.any_key_held()
            || self.input.pending_scroll_y.abs() > 1e-4;
        if self.interactive_drag_scale_enabled && input_active {
            self.drag_settle_until = Some(now + Duration::from_millis(180));
        }
        if let Some(until) = self.drag_settle_until {
            if now >= until {
                self.drag_settle_until = None;
                self.interactive_scale_active = false;
            } else {
                self.interactive_scale_active = true;
            }
        } else {
            self.interactive_scale_active = false;
        }
        let drag_scale_factor = if self.interactive_scale_active && self.recorder.is_none() {
            0.75
        } else {
            1.0
        };
        let mut sim_input = self.input.take_sim_input(vp_w, vp_h);
        let mut step_dt = dt;
        let rec_mode_u = if let Some(rec) = &self.recorder {
            step_dt = rec.fixed_dt();
            if rec.mode == RecorderMode::Turntable {
                sim_input.primary_drag = true;
                sim_input.secondary_drag = false;
                sim_input.shift_down = false;
                sim_input.drag_delta = [rec.turntable_drag_delta(vp_w, vp_h), 0.0];
            }
            Some((rec.mode, rec.progress_u()))
        } else {
            None
        };

        let (frame, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(tex) => (tex, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(tex) => (tex, true),
            wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
                self.reconfigure_surface(size.width, size.height);
                return;
            }
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Validation => return,
        };
        let frame_view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut hud_actions = Vec::new();
        let fps = self.fps_smoothed;
        let raw_input = self.egui_state.take_egui_input(&self.window);
        let win_w = self.surface_config.width.max(1);
        let win_h = self.surface_config.height.max(1);
        let max_dpr = self.max_dpr;

        let (free_textures, cmd_bufs, repaint_delay, ran_raytrace, sim_idle_ready, sky_loaded_now) = {
            let sr = self
                .sim_rt
                .as_mut()
                .expect("SimRuntime must be initialized while on AppScreen::Sim");

            let sky_loaded_now = sr.assets.poll_background_sky();
            if sky_loaded_now
                || (sr.sim.get_i32("skyMode") == 2 && sr.assets.ensure_procedural_sky_a())
            {
                sr.sim.rebuild_bind_groups(&mut sr.assets);
                sr.post.reset_accumulation(true);
            }

            let base_scale = (sr.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
            let effective_scale = (base_scale * drag_scale_factor).clamp(0.375, 1.0);
            if sr.post.resize(
                &sr.assets.device,
                &sr.assets.queue,
                win_w,
                win_h,
                ppp,
                max_dpr,
                effective_scale,
            ) {
                self.egui_renderer.update_egui_texture_from_wgpu_texture(
                    &sr.assets.device,
                    &sr.post.glass_backdrop_rt.view,
                    wgpu::FilterMode::Linear,
                    sr.glass_tex_id,
                );
            }

            if let Some((RecorderMode::Evolution, u)) = rec_mode_u {
                match sr.sim.id() {
                    SimId::WarpDrive => {
                        let _ = sr.sim.set_f32("warpSpeed", 0.6 + 2.9 * u);
                    }
                    SimId::Starflight => {
                        let _ = sr.sim.set_f32("rapidity", 0.25 + 3.95 * u);
                    }
                    SimId::Tde => {
                        let _ = sr.sim.set_f32("tdePhase", 0.08 + 0.88 * u);
                    }
                    _ => {}
                }
            }

            let outcome = sr.sim.step(step_dt, &sim_input);
            if outcome.reset_accumulation {
                sr.post.reset_accumulation(true);
            }

            let post_params = sr.sim.post_params(outcome.camera_moved, outcome.sim_time);
            let hard_reset = sr.post.sample_count == 0;
            let plan = sr.post.plan_frame(&post_params);

            if plan.run_raytrace && !was_sim_idle && raw_dt > 0.0005 && raw_dt < 0.5 {
                let inst_fps = 1.0 / raw_dt;
                self.fps_smoothed = if self.fps_initialized {
                    self.fps_smoothed * 0.88 + inst_fps * 0.12
                } else {
                    self.fps_initialized = true;
                    inst_fps
                };
            }
            let hud_fps = self.fps_smoothed.max(fps * 0.0);

            let mut encoder =
                sr.assets
                    .device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("desktop-frame-encoder"),
                    });

            sr.profiler.set_enabled(self.hud.profiler_open);
            let prof_active = self.hud.profiler_open && (plan.run_raytrace || plan.run_post);
            if prof_active {
                sr.profiler.begin_frame();
            }

            if plan.run_raytrace {
                let ts_ray = sr.profiler.timestamp_writes_for(PassCategory::Raymarch);
                sr.sim.encode_frame_timed(
                    &sr.assets,
                    &mut encoder,
                    &sr.post.scene_rt.view,
                    sr.post.render_width,
                    sr.post.render_height,
                    sr.post.frame_index,
                    plan.jitter,
                    step_dt,
                    hard_reset,
                    ts_ray,
                );
                sr.post.encode_taa_timed(
                    &sr.assets.queue,
                    &mut encoder,
                    &plan,
                    Some(&mut sr.profiler),
                );
            }

            let show_glass = !self.hud.hud_hidden;
            if plan.run_post {
                sr.post.encode_post_and_composite_timed(
                    &sr.assets.queue,
                    &mut encoder,
                    &post_params,
                    show_glass,
                    Some(&mut sr.profiler),
                );
            } else if show_glass && sr.post.glass_blur_dirty {
                sr.post.encode_glass_blur(&mut encoder);
            }

            if prof_active {
                sr.profiler.end_frame(&mut encoder);
            }
            if self.hud.profiler_open {
                self.hud.profiler_snapshot = sr.profiler.snapshot();
            }

            let sample_count = sr.post.sample_count;
            let glass_tex_id = if self.hud.hud_hidden {
                None
            } else {
                Some(sr.glass_tex_id)
            };
            let sim_ref = sr.sim.as_mut();
            let assets_ref = &sr.assets;
            let hud_ref = &mut self.hud;
            if sky_loaded_now {
                hud_ref.invalidate_metadata();
            }

            let mut full_output = self.egui_ctx.run_ui(raw_input, |ui| {
                hud_actions = draw_hud(
                    ui.ctx(),
                    sim_ref,
                    assets_ref,
                    hud_ref,
                    glass_tex_id,
                    hud_fps,
                    sample_count,
                    MAX_PROGRESSIVE_SAMPLES,
                );
            });

            self.egui_state
                .handle_platform_output(&self.window, full_output.platform_output);

            let repaint_delay = full_output
                .viewport_output
                .get(&egui::ViewportId::ROOT)
                .map(|v| v.repaint_delay)
                .unwrap_or(Duration::MAX);

            for (id, deltas) in &full_output.textures_delta.set {
                for delta in deltas {
                    self.egui_renderer.update_texture(
                        &sr.assets.device,
                        &sr.assets.queue,
                        *id,
                        delta,
                    );
                }
            }

            let paint_jobs = self
                .egui_ctx
                .tessellate(full_output.shapes, full_output.pixels_per_point);
            let screen_desc = egui_wgpu::ScreenDescriptor {
                size_in_pixels: [size.width, size.height],
                pixels_per_point: full_output.pixels_per_point,
            };
            let extra_cmds = self.egui_renderer.update_buffers(
                &sr.assets.device,
                &sr.assets.queue,
                &mut encoder,
                &paint_jobs,
                &screen_desc,
            );

            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("merged-swapchain-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &frame_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                sr.post.draw_blit_into_pass(&mut rpass);
                let mut rpass_static = rpass.forget_lifetime();
                self.egui_renderer
                    .render(&mut rpass_static, &paint_jobs, &screen_desc);
            }

            let mut cmd_bufs = extra_cmds;
            cmd_bufs.push(encoder.finish());

            let sim_idle_ready = !plan.run_raytrace
                && !plan.run_post
                && !outcome.camera_moved
                && !sr.assets.is_sky_loading();

            let free_textures = std::mem::take(&mut full_output.textures_delta.free);
            full_output.textures_delta.clear();

            (
                free_textures,
                cmd_bufs,
                repaint_delay,
                plan.run_raytrace,
                sim_idle_ready,
                sky_loaded_now,
            )
        };

        self.queue.submit(cmd_bufs);
        if let Some(sr) = &mut self.sim_rt {
            sr.profiler.after_submit();
        }
        self.queue.present(frame);

        let mut rec_done = false;
        if let Some(rec) = &mut self.recorder
            && let Some(sr) = &self.sim_rt
        {
            let w = sr.post.composite_rt.width;
            let h = sr.post.composite_rt.height;
            let rgba = readback_rgba8_texture(
                &sr.assets.device,
                &sr.assets.queue,
                &sr.post.composite_rt.texture,
                w,
                h,
            );
            rec_done = rec.push_frame(w, h, rgba);
            self.hud.recording_frame = rec.frame_index;
            self.hud.recording_total_frames = rec.total_frames;
        }
        if rec_done {
            self.stop_recording(true);
        }

        if suboptimal {
            self.reconfigure_surface(size.width, size.height);
        }

        for id in &free_textures {
            self.egui_renderer.free_texture(id);
        }

        let had_actions = !hud_actions.is_empty();
        if had_actions {
            self.handle_hud_actions(hud_actions);
        }
        self.rendered_frames += 1;

        let toast_deadline = self
            .hud
            .status_toast
            .as_ref()
            .map(|(_, at)| *at + Duration::from_secs_f32(2.85));
        let egui_deadline = if repaint_delay.is_zero() || repaint_delay > Duration::from_secs(60) {
            None
        } else {
            Some(Instant::now() + repaint_delay)
        };
        let earliest_deadline = [toast_deadline, self.drag_settle_until, egui_deadline]
            .into_iter()
            .flatten()
            .min();

        let sim_still_active = !sim_idle_ready
            || self.recorder.is_some()
            || self.input.any_key_held()
            || self.input.is_dragging()
            || self.drag_settle_until.is_some()
            || had_actions
            || sky_loaded_now
            || repaint_delay.is_zero();

        if sim_still_active || !self.interactive_drag_scale_enabled {
            self.needs_redraw = true;
            self.next_repaint_at = None;
            self.last_sim_idle = false;
        } else {
            self.needs_redraw = false;
            self.next_repaint_at = earliest_deadline;
            self.last_sim_idle = true;
        }

        if self.screen == AppScreen::Sim
            && !self.last_sim_idle
            && ran_raytrace
            && (self.surface_config.present_mode != wgpu::PresentMode::Fifo
                || self.max_fps_explicit)
            && let Some(rem) = self.next_frame_at.checked_duration_since(Instant::now())
        {
            #[cfg(target_os = "windows")]
            let spin_margin = Duration::from_micros(1500);
            #[cfg(not(target_os = "windows"))]
            let spin_margin = Duration::from_micros(500);

            let sleep_dur = rem.saturating_sub(spin_margin);
            if !sleep_dur.is_zero() {
                std::thread::sleep(sleep_dur);
            }
            while Instant::now() < self.next_frame_at {
                std::hint::spin_loop();
            }
        }
    }
}

struct DesktopApp {
    cli: CliArgs,
    proxy: EventLoopProxy<AppEvent>,
    runtime: Option<RuntimeState>,
}

impl ApplicationHandler<AppEvent> for DesktopApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.runtime.is_some() {
            return;
        }
        let initial_title = self
            .cli
            .start_sim
            .map(formatted_window_title)
            .unwrap_or_else(formatted_home_title);
        let mut attrs = Window::default_attributes()
            .with_title(initial_title)
            .with_inner_size(LogicalSize::new(self.cli.width, self.cli.height))
            .with_min_inner_size(LogicalSize::new(640, 420));
        if let Some(window_icon) = icon::load_window_icon() {
            attrs = attrs.with_window_icon(Some(window_icon));
        }
        #[cfg(target_os = "linux")]
        {
            use winit::platform::wayland::WindowAttributesExtWayland;
            use winit::platform::x11::WindowAttributesExtX11;
            attrs = WindowAttributesExtWayland::with_name(
                attrs,
                icon::LINUX_APP_ID,
                "interstellar-desktop",
            );
            attrs = WindowAttributesExtX11::with_name(
                attrs,
                icon::LINUX_APP_ID,
                "interstellar-desktop",
            );
        }
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("Failed to create desktop window"),
        );
        self.runtime = Some(RuntimeState::new(window, &self.cli, self.proxy.clone()));
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: AppEvent) {
        if let Some(rt) = &mut self.runtime {
            match event {
                AppEvent::SkyReady => {
                    rt.needs_redraw = true;
                    rt.last_sim_idle = false;
                }
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(rt) = &mut self.runtime else {
            return;
        };

        let egui_resp = rt.egui_state.on_window_event(&rt.window, &event);
        if !matches!(event, WindowEvent::RedrawRequested) {
            rt.needs_redraw = true;
            rt.last_sim_idle = false;
        }
        let pointer_over_hud = rt.egui_ctx.is_pointer_over_egui() || egui_resp.consumed;

        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Focused(false) => {
                rt.input.clear();
            }
            WindowEvent::ModifiersChanged(mods) => {
                rt.input.modifiers = mods.state();
            }
            WindowEvent::Resized(new_size) => {
                rt.reconfigure_surface(new_size.width, new_size.height);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let prev = rt.input.cursor_pos;
                rt.input.cursor_pos = Some([position.x, position.y]);
                if rt.screen == AppScreen::Sim {
                    let dragging_canvas = rt.input.left_down_canvas
                        || rt.input.right_down_canvas
                        || rt.input.middle_down_canvas;
                    if dragging_canvas && let Some(p) = prev {
                        let ppp = rt.window.scale_factor() as f32;
                        rt.input.pending_drag_delta[0] +=
                            ((position.x - p[0]) as f32) / ppp.max(1.0);
                        rt.input.pending_drag_delta[1] +=
                            ((position.y - p[1]) as f32) / ppp.max(1.0);
                    }
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if rt.screen != AppScreen::Sim {
                    return;
                }
                let pressed = state == ElementState::Pressed;
                match button {
                    MouseButton::Left => {
                        if pressed {
                            if !pointer_over_hud {
                                rt.input.left_down_canvas = true;
                                if let Some(pos) = rt.input.cursor_pos {
                                    if let Some((prev_at, prev_pos)) = rt.input.last_left_click_at {
                                        let dist_sq = (pos[0] - prev_pos[0]).powi(2)
                                            + (pos[1] - prev_pos[1]).powi(2);
                                        if prev_at.elapsed().as_millis() < 320 && dist_sq < 25.0 {
                                            if let Some(sr) = &mut rt.sim_rt {
                                                sr.sim.reset_camera();
                                                sr.post.reset_accumulation(true);
                                            }
                                            rt.input.last_left_click_at = None;
                                        } else {
                                            rt.input.last_left_click_at =
                                                Some((Instant::now(), pos));
                                        }
                                    } else {
                                        rt.input.last_left_click_at = Some((Instant::now(), pos));
                                    }
                                }
                            }
                        } else {
                            rt.input.left_down_canvas = false;
                        }
                    }
                    MouseButton::Right => {
                        if pressed {
                            if !pointer_over_hud {
                                rt.input.right_down_canvas = true;
                            }
                        } else {
                            rt.input.right_down_canvas = false;
                        }
                    }
                    MouseButton::Middle => {
                        if pressed {
                            if !pointer_over_hud {
                                rt.input.middle_down_canvas = true;
                            }
                        } else {
                            rt.input.middle_down_canvas = false;
                        }
                    }
                    _ => {}
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if rt.screen == AppScreen::Sim && !pointer_over_hud {
                    let dy = match delta {
                        MouseScrollDelta::LineDelta(_, y) => -y * 36.0,
                        MouseScrollDelta::PixelDelta(p) => -p.y as f32,
                    };
                    rt.input.pending_scroll_y += dy;
                }
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        physical_key: PhysicalKey::Code(code),
                        state,
                        repeat,
                        ..
                    },
                ..
            } => {
                let pressed = state == ElementState::Pressed;
                let cmd_or_ctrl =
                    rt.input.modifiers.super_key() || rt.input.modifiers.control_key();
                if rt.screen == AppScreen::Sim {
                    if pressed && !cmd_or_ctrl && !rt.egui_ctx.egui_wants_keyboard_input() {
                        rt.input.set_nav_key(code, true);
                    } else if !pressed {
                        rt.input.set_nav_key(code, false);
                    }
                }
                #[cfg(target_os = "macos")]
                if pressed
                    && !repeat
                    && rt.input.modifiers.super_key()
                    && matches!(code, KeyCode::KeyQ | KeyCode::KeyW)
                {
                    event_loop.exit();
                    return;
                }
                if pressed && !repeat && !cmd_or_ctrl && !rt.input.modifiers.alt_key() {
                    rt.handle_shortcut(code);
                }
            }
            WindowEvent::RedrawRequested => {
                rt.render_frame();
                if let Some(target) = self.cli.smoke_frames
                    && rt.rendered_frames >= target
                {
                    let active_label = match rt.screen {
                        AppScreen::Home => "home",
                        AppScreen::Sim => rt
                            .sim_rt
                            .as_ref()
                            .map(|sr| sr.sim.id().cli_name())
                            .unwrap_or("sim"),
                    };
                    println!(
                        "[interstellar-desktop] Smoke OK: sim={}, adapter={}, frames={}, resolution={}x{}, fps={:.1}",
                        active_label,
                        rt.adapter_label,
                        rt.rendered_frames,
                        rt.surface_config.width,
                        rt.surface_config.height,
                        rt.fps_smoothed,
                    );
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(rt) = &mut self.runtime {
            if rt.needs_redraw || self.cli.smoke_frames.is_some() {
                event_loop.set_control_flow(ControlFlow::Poll);
                rt.window.request_redraw();
            } else if let Some(t) = rt.next_repaint_at {
                if Instant::now() >= t {
                    rt.next_repaint_at = None;
                    rt.needs_redraw = true;
                    event_loop.set_control_flow(ControlFlow::Poll);
                    rt.window.request_redraw();
                } else {
                    event_loop.set_control_flow(ControlFlow::WaitUntil(t));
                }
            } else {
                event_loop.set_control_flow(ControlFlow::Wait);
            }
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(rt) = self.runtime.take() {
            let _ = rt.device.poll(wgpu::PollType::wait_indefinitely());
        }
    }
}

#[cfg(target_os = "windows")]
mod win_timer {
    #[link(name = "winmm")]
    unsafe extern "system" {
        fn timeBeginPeriod(uperiod: u32) -> u32;
        fn timeEndPeriod(uperiod: u32) -> u32;
    }

    pub struct TimerPeriodGuard;

    impl TimerPeriodGuard {
        pub fn new() -> Self {
            unsafe {
                let _ = timeBeginPeriod(1);
            }
            Self
        }
    }

    impl Drop for TimerPeriodGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = timeEndPeriod(1);
            }
        }
    }
}

fn run_export_parity(cli: &CliArgs, out_dir: &std::path::Path) {
    std::fs::create_dir_all(out_dir).expect("Failed to create parity export directory");
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .or_else(|_| {
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: true,
            ..Default::default()
        }))
    })
    .expect("No GPU adapter available for --export-parity");

    let adapter_info = adapter.get_info();
    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE)
    {
        required_features |= wgpu::Features::RG11B10UFLOAT_RENDERABLE;
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("export-parity-device"),
        required_features,
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .expect("Failed to create device for --export-parity");

    let device = Arc::new(device);
    let queue = Arc::new(queue);
    let mut assets = SharedGpuAssets::new(
        device.clone(),
        queue.clone(),
        adapter_info,
        true,
        None,
        None,
    );

    let targets: Vec<SimId> = if let Some(csv) = &cli.parity_sims {
        if csv.eq_ignore_ascii_case("all") {
            SimId::ALL.to_vec()
        } else {
            csv.split(',')
                .filter_map(|s| SimId::from_cli_name(s.trim()))
                .collect()
        }
    } else if let Some(one) = cli.start_sim {
        vec![one]
    } else {
        SimId::ALL.to_vec()
    };

    let mut post = PostPipeline::new(
        &assets.device,
        &assets.queue,
        assets.s_linear_clamp.clone(),
        wgpu::TextureFormat::Rgba8Unorm,
        cli.width,
        cli.height,
        1.0,
        1.5,
        1.0,
    );

    let mut manifest_entries = Vec::new();
    for sim_id in targets {
        let mut sim = create_simulation(sim_id, &mut assets);
        sim.apply_preset(0);
        sim.set_paused(true);
        let input = SimInput {
            viewport_w: cli.width as f32,
            viewport_h: cli.height as f32,
            ..Default::default()
        };
        let _ = sim.step(0.0, &input);
        for _ in 0..40 {
            let _ = sim.step(0.05, &input);
        }
        if sim.get_i32("skyMode") == 2 && assets.ensure_procedural_sky_a() {
            sim.rebuild_bind_groups(&mut assets);
        }
        post.reset_accumulation(true);
        let mut post_params = sim.post_params(false, 0.0);
        post_params.paused = true;

        let plan = interstellar_desktop::renderer::post::FramePlan {
            run_raytrace: true,
            run_post: true,
            jitter: [0.0, 0.0],
            blend_factor: 1.0,
            is_progressive: true,
        };
        let mut encoder = assets
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("parity-export-enc"),
            });
        sim.encode_frame(
            &assets,
            &mut encoder,
            &post.scene_rt.view,
            post.render_width,
            post.render_height,
            1,
            [0.0, 0.0],
            0.0,
            true,
        );
        post.encode_taa(&assets.queue, &mut encoder, &plan);
        post.encode_post_and_composite(&assets.queue, &mut encoder, &post_params, false);
        assets.queue.submit([encoder.finish()]);
        let _ = assets.device.poll(wgpu::PollType::wait_indefinitely());

        let rgba = readback_rgba8_texture(
            &assets.device,
            &assets.queue,
            &post.composite_rt.texture,
            post.render_width,
            post.render_height,
        );
        let filename = format!("{}.png", sim_id.cli_name());
        image::save_buffer(
            out_dir.join(&filename),
            &rgba,
            post.render_width,
            post.render_height,
            image::ColorType::Rgba8,
        )
        .expect("Failed to write parity PNG");
        println!(
            "[export-parity] {} -> {} ({}x{})",
            sim_id.cli_name(),
            filename,
            post.render_width,
            post.render_height
        );
        manifest_entries.push(format!(
            "  {{\"id\":\"{}\",\"file\":\"{}\",\"width\":{},\"height\":{}}}",
            sim_id.cli_name(),
            filename,
            post.render_width,
            post.render_height
        ));
    }

    let manifest = format!("[\n{}\n]\n", manifest_entries.join(",\n"));
    std::fs::write(out_dir.join("manifest.json"), manifest)
        .expect("Failed to write parity manifest.json");
}

fn main() {
    let cli = parse_cli_args();
    if let Some(ref parity_dir) = cli.export_parity {
        run_export_parity(&cli, parity_dir);
        return;
    }

    #[cfg(target_os = "windows")]
    let _win_timer = win_timer::TimerPeriodGuard::new();
    #[cfg(target_os = "linux")]
    icon::ensure_linux_desktop_integration();

    let event_loop = EventLoop::<AppEvent>::with_user_event()
        .build()
        .expect("Failed to initialize winit EventLoop");
    let proxy = event_loop.create_proxy();
    let mut app = DesktopApp {
        cli,
        proxy,
        runtime: None,
    };
    event_loop
        .run_app(&mut app)
        .expect("Desktop event loop exited with error");
}
