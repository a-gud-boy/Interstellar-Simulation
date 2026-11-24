#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{KeyCode, ModifiersState, PhysicalKey};
use winit::window::{Window, WindowId};

use interstellar_desktop::renderer::post::{PostPipeline, MAX_PROGRESSIVE_SAMPLES};
use interstellar_desktop::renderer::{readback_rgba8_texture, SharedGpuAssets};
use interstellar_desktop::sims::{create_simulation, SimId, SimInput, Simulation};
use interstellar_desktop::ui::{configure_fonts, draw_hud, HudAction, HudState};
use interstellar_desktop::APP_VERSION;

const DEFAULT_MAX_FPS: u32 = 165;

struct CliArgs {
    sim: SimId,
    width: u32,
    height: u32,
    vsync: bool,
    max_fps: u32,
    smoke_frames: Option<u32>,
}

fn parse_bool_flag(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

fn parse_cli_args() -> CliArgs {
    let mut out = CliArgs {
        sim: SimId::Blackhole,
        width: 1280,
        height: 720,
        vsync: true,
        max_fps: DEFAULT_MAX_FPS,
        smoke_frames: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--sim" {
            if let Some(val) = it.next() {
                if let Some(id) = SimId::from_cli_name(&val) {
                    out.sim = id;
                } else {
                    eprintln!("[interstellar-desktop] Unknown --sim '{val}', using blackhole.");
                }
            }
        } else if let Some(val) = arg.strip_prefix("--sim=") {
            if let Some(id) = SimId::from_cli_name(val) {
                out.sim = id;
            }
        } else if arg == "--width" {
            if let Some(val) = it.next() {
                if let Ok(w) = val.parse::<u32>() {
                    out.width = w.clamp(640, 7680);
                }
            }
        } else if let Some(val) = arg.strip_prefix("--width=") {
            if let Ok(w) = val.parse::<u32>() {
                out.width = w.clamp(640, 7680);
            }
        } else if arg == "--height" {
            if let Some(val) = it.next() {
                if let Ok(h) = val.parse::<u32>() {
                    out.height = h.clamp(360, 4320);
                }
            }
        } else if let Some(val) = arg.strip_prefix("--height=") {
            if let Ok(h) = val.parse::<u32>() {
                out.height = h.clamp(360, 4320);
            }
        } else if arg == "--vsync" {
            if let Some(val) = it.next() {
                if let Some(b) = parse_bool_flag(&val) {
                    out.vsync = b;
                }
            }
        } else if let Some(val) = arg.strip_prefix("--vsync=") {
            if let Some(b) = parse_bool_flag(val) {
                out.vsync = b;
            }
        } else if arg == "--max-fps" {
            if let Some(val) = it.next() {
                if let Ok(n) = val.parse::<u32>() {
                    out.max_fps = n.clamp(15, 1000);
                }
            }
        } else if let Some(val) = arg.strip_prefix("--max-fps=") {
            if let Ok(n) = val.parse::<u32>() {
                out.max_fps = n.clamp(15, 1000);
            }
        } else if arg == "--smoke-frames" {
            if let Some(val) = it.next() {
                if let Ok(n) = val.parse::<u32>() {
                    out.smoke_frames = Some(n.max(1));
                }
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
                   --sim <name>            blackhole | wormhole | binary | warp | supernova | pulsar | starflight\n  \
                   --width <px>            Initial window width (default: 1280)\n  \
                   --height <px>           Initial window height (default: 720)\n  \
                   --vsync <on|off>        Initial VSync mode (default: on)\n  \
                   --max-fps <n>           Maximum frame rate cap (default: {DEFAULT_MAX_FPS})\n  \
                   --smoke-frames <n>      Render N live windowed frames and exit cleanly\n  \
                   --version, -V           Print version information\n"
            );
            std::process::exit(0);
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

struct RuntimeState {
    egui_state: egui_winit::State,
    egui_renderer: egui_wgpu::Renderer,
    egui_ctx: egui::Context,
    glass_tex_id: egui::TextureId,
    sim: Box<dyn Simulation>,
    post: PostPipeline,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    supported_present_modes: Vec<wgpu::PresentMode>,
    assets: SharedGpuAssets,
    window: Arc<Window>,

    hud: HudState,
    input: InputTracker,
    frame_interval: Duration,
    next_frame_at: Instant,
    last_frame_at: Instant,
    fps_smoothed: f32,
    fps_initialized: bool,
    rendered_frames: u32,
}

impl RuntimeState {
    fn new(window: Arc<Window>, cli: &CliArgs) -> Self {
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
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("interstellar-desktop-device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
        }))
        .expect("Failed to open wgpu device");

        let caps = surface.get_capabilities(&adapter);
        let surface_format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let present_mode = pick_present_mode(&caps.present_modes, cli.vsync);
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

        let mut assets = SharedGpuAssets::new(
            Arc::new(device),
            Arc::new(queue),
            adapter_info,
            false,
        );
        let sim = create_simulation(cli.sim, &mut assets);
        let post = PostPipeline::new(
            &assets.device,
            &assets.queue,
            assets.s_linear_clamp.clone(),
            surface_format,
            win_w,
            win_h,
            1.0,
        );

        let egui_ctx = egui::Context::default();
        configure_fonts(&egui_ctx);

        let egui_state = egui_winit::State::new(
            egui_ctx.clone(),
            egui::ViewportId::ROOT,
            &window,
            Some(window.scale_factor() as f32),
            Some(winit::window::Theme::Dark),
            Some(assets.device.limits().max_texture_dimension_2d as usize),
        );

        let mut egui_renderer = egui_wgpu::Renderer::new(
            &assets.device,
            surface_format,
            egui_wgpu::RendererOptions::default(),
        );
        let glass_tex_id = egui_renderer.register_native_texture(
            &assets.device,
            &post.glass_backdrop_rt.view,
            wgpu::FilterMode::Linear,
        );

        window.set_title(&formatted_window_title(sim.id()));

        let now = Instant::now();
        Self {
            window,
            surface,
            surface_config,
            supported_present_modes: caps.present_modes,
            assets,
            post,
            sim,
            egui_ctx,
            egui_state,
            egui_renderer,
            glass_tex_id,
            hud: HudState {
                vsync: cli.vsync,
                ..Default::default()
            },
            input: InputTracker::default(),
            frame_interval: Duration::from_secs_f64(1.0 / cli.max_fps.max(15) as f64),
            next_frame_at: now,
            last_frame_at: now,
            fps_smoothed: cli.max_fps.min(60) as f32,
            fps_initialized: false,
            rendered_frames: 0,
        }
    }

    fn reconfigure_surface(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface
            .configure(&self.assets.device, &self.surface_config);
        let res_scale = (self.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
        if self
            .post
            .resize(&self.assets.device, &self.assets.queue, width, height, res_scale)
        {
            self.egui_renderer.update_egui_texture_from_wgpu_texture(
                &self.assets.device,
                &self.post.glass_backdrop_rt.view,
                wgpu::FilterMode::Linear,
                self.glass_tex_id,
            );
        }
    }

    fn apply_vsync(&mut self, vsync: bool) {
        self.hud.vsync = vsync;
        self.surface_config.present_mode = pick_present_mode(&self.supported_present_modes, vsync);
        self.surface
            .configure(&self.assets.device, &self.surface_config);
    }

    fn capture_png(&mut self) {
        let dir = screenshot_dir();
        let _ = std::fs::create_dir_all(&dir);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("{}_{}.png", self.sim.id().cli_name(), ts));
        let rgba = readback_rgba8_texture(
            &self.assets.device,
            &self.assets.queue,
            &self.post.composite_rt.texture,
            self.post.composite_rt.width,
            self.post.composite_rt.height,
        );
        match image::save_buffer(
            &path,
            &rgba,
            self.post.composite_rt.width,
            self.post.composite_rt.height,
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
        for act in actions {
            match act {
                HudAction::SwitchSim(next_id) => {
                    if next_id != self.sim.id() {
                        self.sim = create_simulation(next_id, &mut self.assets);
                        self.hud.open_sections.clear();
                        self.window.set_title(&formatted_window_title(next_id));
                        let res_scale =
                            (self.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
                        if self.post.resize(
                            &self.assets.device,
                            &self.assets.queue,
                            self.surface_config.width,
                            self.surface_config.height,
                            res_scale,
                        ) {
                            self.egui_renderer.update_egui_texture_from_wgpu_texture(
                                &self.assets.device,
                                &self.post.glass_backdrop_rt.view,
                                wgpu::FilterMode::Linear,
                                self.glass_tex_id,
                            );
                        }
                        self.post.reset_accumulation(true);
                    }
                }
                HudAction::SelectPreset(idx) => {
                    self.sim.apply_preset(idx);
                    self.post.reset_accumulation(true);
                }
                HudAction::TogglePause => {
                    let next = !self.sim.paused();
                    self.sim.set_paused(next);
                }
                HudAction::ToggleAutoOrbit => {
                    self.sim.toggle_auto_orbit();
                }
                HudAction::TriggerSpecial => {
                    self.sim.trigger_special_action();
                }
                HudAction::ResetCamera => {
                    self.sim.reset_camera();
                    self.post.reset_accumulation(true);
                }
                HudAction::CapturePng => {
                    self.capture_png();
                }
                HudAction::ToggleHud => {
                    self.hud.hud_hidden = !self.hud.hud_hidden;
                }
                HudAction::ToggleDrawer => {
                    self.hud.drawer_open = !self.hud.drawer_open;
                }
                HudAction::SetVsync(v) => {
                    self.apply_vsync(v);
                }
                HudAction::ControlChanged {
                    reset_primary,
                    resolution_changed,
                } => {
                    if resolution_changed {
                        let res_scale =
                            (self.sim.get_i32("resolutionScale") as f32 / 100.0).clamp(0.5, 1.0);
                        if self.post.resize(
                            &self.assets.device,
                            &self.assets.queue,
                            self.surface_config.width,
                            self.surface_config.height,
                            res_scale,
                        ) {
                            self.egui_renderer.update_egui_texture_from_wgpu_texture(
                                &self.assets.device,
                                &self.post.glass_backdrop_rt.view,
                                wgpu::FilterMode::Linear,
                                self.glass_tex_id,
                            );
                        }
                    }
                    if reset_primary {
                        self.post.reset_accumulation(true);
                    } else {
                        self.post.mark_post_dirty();
                    }
                }
            }
        }
    }

    fn handle_shortcut(&mut self, code: KeyCode) {
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
            KeyCode::Escape if self.hud.drawer_open => actions.push(HudAction::ToggleDrawer),
            _ => {}
        }
        if !actions.is_empty() {
            self.handle_hud_actions(actions);
        }
    }

    fn render_frame(&mut self) {
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
        if raw_dt > 0.0005 && raw_dt < 0.5 {
            let inst_fps = 1.0 / raw_dt;
            self.fps_smoothed = if self.fps_initialized {
                self.fps_smoothed * 0.88 + inst_fps * 0.12
            } else {
                self.fps_initialized = true;
                inst_fps
            };
        }

        if self.assets.poll_background_sky() {
            self.sim.rebuild_bind_groups(&mut self.assets);
            self.post.reset_accumulation(true);
        }

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
        let sim_input = self.input.take_sim_input(vp_w, vp_h);
        let outcome = self.sim.step(dt, &sim_input);
        if outcome.reset_accumulation {
            self.post.reset_accumulation(true);
        }

        let post_params = self.sim.post_params(outcome.camera_moved, outcome.sim_time);
        let hard_reset = self.post.sample_count == 0;
        let plan = self.post.plan_frame(&post_params);

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

        let mut encoder =
            self.assets
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("desktop-frame-encoder"),
                });

        if plan.run_raytrace {
            self.sim.encode_frame(
                &self.assets,
                &mut encoder,
                &self.post.scene_rt.view,
                self.post.render_width,
                self.post.render_height,
                self.post.frame_index,
                plan.jitter,
                dt,
                hard_reset,
            );
            self.post.encode_taa(&self.assets.queue, &mut encoder, &plan);
        }

        if plan.run_post {
            self.post.encode_post_and_composite(
                &self.assets.queue,
                &mut encoder,
                &post_params,
                true,
            );
        } else if !self.hud.hud_hidden {
            self.post.encode_glass_blur(&self.assets.queue, &mut encoder);
        }

        self.post.encode_blit_to_target(&mut encoder, &frame_view);

        let raw_input = self.egui_state.take_egui_input(&self.window);
        let mut hud_actions = Vec::new();
        let fps = self.fps_smoothed;
        let sample_count = self.post.sample_count;
        let glass_tex_id = Some(self.glass_tex_id);

        let mut full_output = self.egui_ctx.run_ui(raw_input, |ui| {
            hud_actions = draw_hud(
                ui.ctx(),
                self.sim.as_mut(),
                &self.assets,
                &mut self.hud,
                glass_tex_id,
                fps,
                sample_count,
                MAX_PROGRESSIVE_SAMPLES,
            );
        });

        self.egui_state
            .handle_platform_output(&self.window, full_output.platform_output);

        for (id, deltas) in &full_output.textures_delta.set {
            for delta in deltas {
                self.egui_renderer.update_texture(
                    &self.assets.device,
                    &self.assets.queue,
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
            &self.assets.device,
            &self.assets.queue,
            &mut encoder,
            &paint_jobs,
            &screen_desc,
        );

        {
            let rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("egui-hud-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &frame_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
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
        self.assets.queue.submit(cmd_bufs);
        self.assets.queue.present(frame);

        if suboptimal {
            self.reconfigure_surface(size.width, size.height);
        }

        for id in &full_output.textures_delta.free {
            self.egui_renderer.free_texture(id);
        }
        full_output.textures_delta.clear();

        if !hud_actions.is_empty() {
            self.handle_hud_actions(hud_actions);
        }
        self.rendered_frames += 1;

        if let Some(rem) = self.next_frame_at.checked_duration_since(Instant::now()) {
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
    runtime: Option<RuntimeState>,
}

impl ApplicationHandler for DesktopApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.runtime.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title(formatted_window_title(self.cli.sim))
            .with_inner_size(LogicalSize::new(self.cli.width, self.cli.height))
            .with_min_inner_size(LogicalSize::new(640, 420));
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("Failed to create desktop window"),
        );
        self.runtime = Some(RuntimeState::new(window, &self.cli));
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
                let dragging_canvas = rt.input.left_down_canvas
                    || rt.input.right_down_canvas
                    || rt.input.middle_down_canvas;
                if dragging_canvas {
                    if let Some(p) = prev {
                        let ppp = rt.window.scale_factor() as f32;
                        rt.input.pending_drag_delta[0] += ((position.x - p[0]) as f32) / ppp.max(1.0);
                        rt.input.pending_drag_delta[1] += ((position.y - p[1]) as f32) / ppp.max(1.0);
                    }
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
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
                                            rt.sim.reset_camera();
                                            rt.post.reset_accumulation(true);
                                            rt.input.last_left_click_at = None;
                                        } else {
                                            rt.input.last_left_click_at = Some((Instant::now(), pos));
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
                if !pointer_over_hud {
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
                if pressed && !cmd_or_ctrl && !rt.egui_ctx.egui_wants_keyboard_input() {
                    rt.input.set_nav_key(code, true);
                } else if !pressed {
                    rt.input.set_nav_key(code, false);
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
                if pressed
                    && !repeat
                    && !cmd_or_ctrl
                    && !rt.input.modifiers.alt_key()
                {
                    rt.handle_shortcut(code);
                }
            }
            WindowEvent::RedrawRequested => {
                rt.render_frame();
                if let Some(target) = self.cli.smoke_frames {
                    if rt.rendered_frames >= target {
                        println!(
                            "[interstellar-desktop] Smoke OK: sim={}, adapter={}, frames={}, resolution={}x{}, fps={:.1}",
                            rt.sim.id().cli_name(),
                            rt.assets.adapter_label,
                            rt.rendered_frames,
                            rt.surface_config.width,
                            rt.surface_config.height,
                            rt.fps_smoothed,
                        );
                        event_loop.exit();
                    }
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(rt) = &self.runtime {
            rt.window.request_redraw();
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(rt) = self.runtime.take() {
            let _ = rt.assets.device.poll(wgpu::PollType::wait_indefinitely());
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

fn main() {
    #[cfg(target_os = "windows")]
    let _win_timer = win_timer::TimerPeriodGuard::new();

    let cli = parse_cli_args();
    let event_loop = EventLoop::new().expect("Failed to initialize winit EventLoop");
    let mut app = DesktopApp { cli, runtime: None };
    event_loop.run_app(&mut app).expect("Desktop event loop exited with error");
}
