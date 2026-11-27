use std::path::PathBuf;
use std::sync::Arc;

use egui::{Pos2, RawInput, Rect, Vec2};

use interstellar_desktop::renderer::post::{MAX_PROGRESSIVE_SAMPLES, PostPipeline};
use interstellar_desktop::renderer::{
    SharedGpuAssets, format_adapter_label, readback_rgba8_texture,
};
use interstellar_desktop::sims::{SimId, SimInput, create_simulation};
use interstellar_desktop::ui::{HomeState, HudState, configure_fonts, draw_homepage, draw_hud};

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;

#[allow(clippy::too_many_arguments)]
fn render_home_and_capture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    egui_ctx: &egui::Context,
    egui_renderer: &mut egui_wgpu::Renderer,
    out_view: &wgpu::TextureView,
    out_tex: &wgpu::Texture,
    home: &mut HomeState,
    adapter_label: &str,
    out_name: &str,
) {
    for frame_idx in 0..3 {
        let raw_input = RawInput {
            screen_rect: Some(Rect::from_min_size(
                Pos2::ZERO,
                Vec2::new(WIDTH as f32, HEIGHT as f32),
            )),
            ..Default::default()
        };
        let mut full_output = egui_ctx.run_ui(raw_input, |ui| {
            let _ = draw_homepage(ui.ctx(), home, adapter_label);
        });

        for (id, deltas) in &full_output.textures_delta.set {
            for delta in deltas {
                egui_renderer.update_texture(device, queue, *id, delta);
            }
        }
        let paint_jobs = egui_ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
        let screen_desc = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [WIDTH, HEIGHT],
            pixels_per_point: full_output.pixels_per_point,
        };

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("headless-home-encoder"),
        });
        let extra_cmds =
            egui_renderer.update_buffers(device, queue, &mut encoder, &paint_jobs, &screen_desc);

        if frame_idx == 2 {
            let rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("headless-home-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: out_view,
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
            egui_renderer.render(&mut rpass_static, &paint_jobs, &screen_desc);
        }

        let mut cmd_bufs = extra_cmds;
        cmd_bufs.push(encoder.finish());
        queue.submit(cmd_bufs);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());

        for id in &full_output.textures_delta.free {
            egui_renderer.free_texture(id);
        }
        full_output.textures_delta.clear();
    }

    let rgba = readback_rgba8_texture(device, queue, out_tex, WIDTH, HEIGHT);
    assert_eq!(rgba.len(), (WIDTH * HEIGHT * 4) as usize);

    let mut sum_luma = 0.0_f64;
    let mut sum_luma2 = 0.0_f64;
    let pixel_count = (WIDTH * HEIGHT) as f64;
    for chunk in rgba.as_chunks::<4>().0 {
        let luma = 0.2126 * chunk[0] as f64 + 0.7152 * chunk[1] as f64 + 0.0722 * chunk[2] as f64;
        sum_luma += luma;
        sum_luma2 += luma * luma;
    }
    let mean = sum_luma / pixel_count;
    let var = (sum_luma2 / pixel_count - mean * mean).max(0.0);
    let std_dev = var.sqrt();
    println!(
        "[headless_render] {} -> mean_luma={:.2}, std_luma={:.2}",
        out_name, mean, std_dev
    );
    assert!(
        mean > 5.0 && std_dev > 10.0,
        "Homepage rendered output '{}' is blank or flat (mean={mean:.2}, std={std_dev:.2})",
        out_name
    );

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("screenshots");
    std::fs::create_dir_all(&dir).expect("Failed to create tests/screenshots dir");
    let out_path = dir.join(out_name);
    image::save_buffer(&out_path, &rgba, WIDTH, HEIGHT, image::ColorType::Rgba8)
        .expect("Failed to save homepage PNG screenshot");
}

#[allow(clippy::too_many_arguments)]
fn render_and_capture(
    assets: &mut SharedGpuAssets,
    post: &mut PostPipeline,
    egui_ctx: &egui::Context,
    egui_renderer: &mut egui_wgpu::Renderer,
    out_view: &wgpu::TextureView,
    out_tex: &wgpu::Texture,
    glass_tex_id: egui::TextureId,
    sim_id: SimId,
    drawer_open: bool,
    out_name: &str,
) {
    let mut sim = create_simulation(sim_id, assets);
    post.reset_accumulation(true);

    let mut hud = HudState {
        drawer_open,
        ..Default::default()
    };

    let mut sim_input = SimInput {
        viewport_w: WIDTH as f32,
        viewport_h: HEIGHT as f32,
        ..Default::default()
    };

    let frames = 8;
    for f_idx in 0..frames {
        let outcome = sim.step(1.0 / 60.0, &sim_input);
        sim_input.drag_delta = [0.0; 2];
        sim_input.scroll_y = 0.0;
        let post_params = sim.post_params(outcome.camera_moved, outcome.sim_time);
        let hard_reset = post.sample_count == 0;
        let plan = post.plan_frame(&post_params);

        let mut encoder = assets
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("headless-frame-encoder"),
            });

        if plan.run_raytrace {
            sim.encode_frame(
                assets,
                &mut encoder,
                &post.scene_rt.view,
                post.render_width,
                post.render_height,
                post.frame_index,
                plan.jitter,
                1.0 / 60.0,
                hard_reset,
            );
            post.encode_taa(&assets.queue, &mut encoder, &plan);
        }
        if plan.run_post {
            post.encode_post_and_composite(&assets.queue, &mut encoder, &post_params, true);
        } else {
            post.encode_glass_blur(&assets.queue, &mut encoder);
        }

        post.encode_blit_to_target(&mut encoder, out_view);

        let raw_input = RawInput {
            screen_rect: Some(Rect::from_min_size(
                Pos2::ZERO,
                Vec2::new(WIDTH as f32, HEIGHT as f32),
            )),
            ..Default::default()
        };
        let mut full_output = egui_ctx.run_ui(raw_input, |ui| {
            let _ = draw_hud(
                ui.ctx(),
                sim.as_mut(),
                assets,
                &mut hud,
                Some(glass_tex_id),
                60.0,
                post.sample_count,
                MAX_PROGRESSIVE_SAMPLES,
            );
        });

        for (id, deltas) in &full_output.textures_delta.set {
            for delta in deltas {
                egui_renderer.update_texture(&assets.device, &assets.queue, *id, delta);
            }
        }
        let paint_jobs = egui_ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
        let screen_desc = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [WIDTH, HEIGHT],
            pixels_per_point: full_output.pixels_per_point,
        };
        let extra_cmds = egui_renderer.update_buffers(
            &assets.device,
            &assets.queue,
            &mut encoder,
            &paint_jobs,
            &screen_desc,
        );

        if f_idx == frames - 1 {
            let rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("headless-egui-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: out_view,
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
            egui_renderer.render(&mut rpass_static, &paint_jobs, &screen_desc);
        }

        let mut cmd_bufs = extra_cmds;
        cmd_bufs.push(encoder.finish());
        assets.queue.submit(cmd_bufs);
        let _ = assets.device.poll(wgpu::PollType::wait_indefinitely());

        for id in &full_output.textures_delta.free {
            egui_renderer.free_texture(id);
        }
        full_output.textures_delta.clear();
    }

    let rgba = readback_rgba8_texture(&assets.device, &assets.queue, out_tex, WIDTH, HEIGHT);
    assert_eq!(rgba.len(), (WIDTH * HEIGHT * 4) as usize);

    let mut sum_luma = 0.0_f64;
    let mut sum_luma2 = 0.0_f64;
    let pixel_count = (WIDTH * HEIGHT) as f64;
    for chunk in rgba.as_chunks::<4>().0 {
        let luma = 0.2126 * chunk[0] as f64 + 0.7152 * chunk[1] as f64 + 0.0722 * chunk[2] as f64;
        sum_luma += luma;
        sum_luma2 += luma * luma;
    }
    let mean = sum_luma / pixel_count;
    let var = (sum_luma2 / pixel_count - mean * mean).max(0.0);
    let std_dev = var.sqrt();
    println!(
        "[headless_render] {} -> mean_luma={:.2}, std_luma={:.2}",
        out_name, mean, std_dev
    );
    assert!(
        mean > 2.0 && std_dev > 5.0,
        "Rendered output '{}' is blank or flat (mean={mean:.2}, std={std_dev:.2})",
        out_name
    );

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("screenshots");
    std::fs::create_dir_all(&dir).expect("Failed to create tests/screenshots dir");
    let out_path = dir.join(out_name);
    image::save_buffer(&out_path, &rgba, WIDTH, HEIGHT, image::ColorType::Rgba8)
        .expect("Failed to save PNG screenshot");
}

#[test]
fn render_all_seven_sims_with_hud() {
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
    .expect("Expected GPU adapter");
    let adapter_info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("headless-render-device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .expect("Failed to create wgpu device");

    let mut assets = SharedGpuAssets::new(
        Arc::new(device),
        Arc::new(queue),
        adapter_info,
        true, // synchronous 4K Milky Way load
    );
    assert!(
        assets.sky_map_loaded,
        "4K Milky Way failed to load synchronously"
    );

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut post = PostPipeline::new(
        &assets.device,
        &assets.queue,
        assets.s_linear_clamp.clone(),
        format,
        WIDTH,
        HEIGHT,
        1.0,
    );

    let out_tex = assets.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("headless-out-tex"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let egui_ctx = egui::Context::default();
    configure_fonts(&egui_ctx);
    let mut egui_renderer = egui_wgpu::Renderer::new(
        &assets.device,
        format,
        egui_wgpu::RendererOptions::default(),
    );
    let glass_tex_id = egui_renderer.register_native_texture(
        &assets.device,
        &post.glass_backdrop_rt.view,
        wgpu::FilterMode::Linear,
    );

    let cases = [
        (SimId::Blackhole, false, "01_blackhole_hud.png"),
        (SimId::Blackhole, true, "02_blackhole_drawer.png"),
        (SimId::Wormhole, false, "03_wormhole_hud.png"),
        (SimId::BinaryBh, false, "04_binary_bh_hud.png"),
        (SimId::WarpDrive, false, "05_warp_drive_hud.png"),
        (SimId::Supernova, false, "06_supernova_hud.png"),
        (SimId::Pulsar, false, "07_pulsar_hud.png"),
        (SimId::Starflight, false, "08_starflight_hud.png"),
        (SimId::Starflight, true, "09_starflight_drawer.png"),
    ];

    for (sim_id, drawer_open, filename) in cases {
        render_and_capture(
            &mut assets,
            &mut post,
            &egui_ctx,
            &mut egui_renderer,
            &out_view,
            &out_tex,
            glass_tex_id,
            sim_id,
            drawer_open,
            filename,
        );
    }
}

#[test]
fn render_observatory_homepage_and_dossier() {
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
    .expect("Expected GPU adapter");
    let adapter_label = format_adapter_label(&adapter.get_info());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("headless-home-device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .expect("Failed to create wgpu device");

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let out_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("headless-home-out-tex"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let egui_ctx = egui::Context::default();
    configure_fonts(&egui_ctx);
    let mut egui_renderer =
        egui_wgpu::Renderer::new(&device, format, egui_wgpu::RendererOptions::default());

    let mut home = HomeState::default();
    render_home_and_capture(
        &device,
        &queue,
        &egui_ctx,
        &mut egui_renderer,
        &out_view,
        &out_tex,
        &mut home,
        &adapter_label,
        "00_homepage_desktop.png",
    );

    home.inspect_sim = Some(SimId::Blackhole);
    render_home_and_capture(
        &device,
        &queue,
        &egui_ctx,
        &mut egui_renderer,
        &out_view,
        &out_tex,
        &mut home,
        &adapter_label,
        "00_homepage_dossier.png",
    );
}
