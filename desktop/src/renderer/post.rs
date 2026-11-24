use bytemuck::{Pod, Zeroable};

use crate::shaders;

pub const BLOOM_MIP_COUNT: usize = 6;
pub const MAX_PROGRESSIVE_SAMPLES: u32 = 128;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct BloomPrefilterUniforms {
    texel_thresh_knee: [f32; 4],
    clamp_max_pad: [f32; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct AnamorphicUniforms {
    texel_thresh_spread: [f32; 4],
    pass_pad: [f32; 4],
    tint_inner_edge: [f32; 4],
    tint_outer_mix: [f32; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct CompositeUniforms {
    res_exposure_bloom: [f32; 4],
    ana_time_frame_pad: [f32; 4],
    weights_pad: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct PostTuning {
    pub bloom_threshold: f32,
    pub bloom_knee: f32,
    pub bloom_clamp: f32,
    pub ana_threshold: f32,
    pub ana_inner_tint: [f32; 3],
    pub ana_edge_start: f32,
    pub ana_outer_tint: [f32; 3],
    pub ana_mix_weight: f32,
    pub bloom_weight: f32,
    pub ana_weight: f32,
}

impl Default for PostTuning {
    fn default() -> Self {
        Self {
            bloom_threshold: 1.30,
            bloom_knee: 0.45,
            bloom_clamp: 11.0,
            ana_threshold: 1.85,
            ana_inner_tint: [1.04, 0.96, 0.87],
            ana_edge_start: 0.18,
            ana_outer_tint: [0.76, 0.90, 1.16],
            ana_mix_weight: 0.42,
            bloom_weight: 0.085,
            ana_weight: 0.22,
        }
    }
}

impl PostTuning {
    pub fn pulsar() -> Self {
        Self {
            bloom_threshold: 1.25,
            bloom_knee: 0.45,
            bloom_clamp: 16.0,
            ana_threshold: 1.85,
            ana_inner_tint: [0.96, 0.99, 1.05],
            ana_edge_start: 0.16,
            ana_outer_tint: [0.60, 0.86, 1.24],
            ana_mix_weight: 0.48,
            bloom_weight: 0.095,
            ana_weight: 0.28,
        }
    }

    pub fn starflight() -> Self {
        Self {
            bloom_threshold: 1.15,
            bloom_knee: 0.45,
            bloom_clamp: 16.0,
            ana_threshold: 2.45,
            ana_inner_tint: [1.02, 0.99, 0.96],
            ana_edge_start: 0.18,
            ana_outer_tint: [0.84, 0.92, 1.08],
            ana_mix_weight: 0.35,
            bloom_weight: 0.105,
            ana_weight: 0.14,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PostFrameParams {
    pub exposure: f32,
    pub bloom_intensity: f32,
    pub anamorphic_intensity: f32,
    pub paused: bool,
    pub camera_moved: bool,
    pub sim_time: f32,
    pub resolution_scale: f32,
    pub tuning: PostTuning,
}

pub struct RenderTarget {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

impl RenderTarget {
    pub fn new(
        device: &wgpu::Device,
        label: &str,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        extra_usage: wgpu::TextureUsages,
    ) -> Self {
        let w = width.max(1);
        let h = height.max(1);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | extra_usage,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            width: w,
            height: h,
        }
    }
}

pub fn halton(index: u32, base: u32) -> f32 {
    let mut result = 0.0_f32;
    let mut f = 1.0_f32 / base as f32;
    let mut i = index;
    while i > 0 {
        result += f * (i % base) as f32;
        i /= base;
        f /= base as f32;
    }
    result
}

pub struct PostPipeline {
    pub hdr_format: wgpu::TextureFormat,
    pub composite_format: wgpu::TextureFormat,
    pub target_format: wgpu::TextureFormat,

    pub render_width: u32,
    pub render_height: u32,
    pub window_width: u32,
    pub window_height: u32,
    pub resolution_scale: f32,

    pub frame_index: u32,
    pub sample_count: u32,
    pub taa_read_idx: usize,
    pub taa_write_idx: usize,
    hard_reset: bool,
    post_dirty: bool,
    was_progressive: bool,

    taa_bgl: wgpu::BindGroupLayout,
    single_src_post_bgl: wgpu::BindGroupLayout,
    bloom_up_bgl: wgpu::BindGroupLayout,
    comp_bgl: wgpu::BindGroupLayout,
    blit_bgl: wgpu::BindGroupLayout,

    taa_pipeline: wgpu::RenderPipeline,
    bloom_pre_pipeline: wgpu::RenderPipeline,
    bloom_down_pipeline: wgpu::RenderPipeline,
    bloom_up_pipeline: wgpu::RenderPipeline,
    ana_pipeline: wgpu::RenderPipeline,
    comp_pipeline: wgpu::RenderPipeline,
    glass_blur_pipeline: wgpu::RenderPipeline,
    blit_pipeline: wgpu::RenderPipeline,

    taa_ubo: wgpu::Buffer,
    bloom_pre_ubo: wgpu::Buffer,
    bloom_down_ubos: Vec<wgpu::Buffer>,
    bloom_up_ubos: Vec<wgpu::Buffer>,
    ana_ubo_0: wgpu::Buffer,
    ana_ubo_1: wgpu::Buffer,
    comp_ubo: wgpu::Buffer,
    glass_ubo_0: wgpu::Buffer,
    glass_ubo_1: wgpu::Buffer,

    pub scene_rt: RenderTarget,
    pub taa_rts: [RenderTarget; 2],
    pub bloom_down_rts: Vec<RenderTarget>,
    pub bloom_up_rts: Vec<RenderTarget>,
    pub ana_rt_a: RenderTarget,
    pub ana_rt_b: RenderTarget,
    pub composite_rt: RenderTarget,
    pub glass_temp_rt: RenderTarget,
    pub glass_backdrop_rt: RenderTarget,

    taa_bgs: [wgpu::BindGroup; 2],
    bloom_pre_bgs: [wgpu::BindGroup; 2],
    bloom_down_bgs: Vec<Option<wgpu::BindGroup>>,
    bloom_up_bgs: Vec<wgpu::BindGroup>,
    ana_bg_0: wgpu::BindGroup,
    ana_bg_1: wgpu::BindGroup,
    comp_bgs: [wgpu::BindGroup; 2],
    glass_bg_0: wgpu::BindGroup,
    glass_bg_1: wgpu::BindGroup,
    blit_bg: wgpu::BindGroup,

    s_linear_clamp: wgpu::Sampler,
}

impl PostPipeline {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        s_linear_clamp: wgpu::Sampler,
        target_format: wgpu::TextureFormat,
        window_width: u32,
        window_height: u32,
        resolution_scale: f32,
    ) -> Self {
        let hdr_format = wgpu::TextureFormat::Rgba16Float;
        let composite_format = wgpu::TextureFormat::Rgba8Unorm;

        let make_mod = |label, src: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(src.into()),
            })
        };

        let mod_taa = make_mod("post-taa", shaders::POST_TAA);
        let mod_bloom_pre = make_mod("post-bloom-pre", shaders::POST_BLOOM_PREFILTER);
        let mod_bloom_down = make_mod("post-bloom-down", shaders::POST_BLOOM_DOWNSAMPLE);
        let mod_bloom_up = make_mod("post-bloom-up", shaders::POST_BLOOM_UPSAMPLE);
        let mod_ana = make_mod("post-ana", shaders::POST_ANAMORPHIC);
        let mod_comp = make_mod("post-comp", shaders::POST_COMPOSITE);
        let mod_glass = make_mod("glass-blur", shaders::GLASS_BLUR);
        let mod_blit = make_mod("blit", shaders::BLIT);

        let taa_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("taa-bgl"),
            entries: &[
                ubo_entry(0),
                tex2d_entry(1),
                tex2d_entry(2),
                sampler_entry(3),
            ],
        });

        let single_src_post_bgl =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("single-src-post-bgl"),
                entries: &[ubo_entry(0), tex2d_entry(1), sampler_entry(2)],
            });

        let bloom_up_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bloom-up-bgl"),
            entries: &[
                ubo_entry(0),
                tex2d_entry(1),
                tex2d_entry(2),
                sampler_entry(3),
            ],
        });

        let comp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("comp-bgl"),
            entries: &[
                ubo_entry(0),
                tex2d_entry(1),
                tex2d_entry(2),
                tex2d_entry(3),
                sampler_entry(4),
            ],
        });

        let blit_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit-bgl"),
            entries: &[tex2d_entry(0), sampler_entry(1)],
        });

        let taa_pipeline = make_fs_pipe(device, "taa-pipe", &taa_bgl, &mod_taa, hdr_format);
        let bloom_pre_pipeline = make_fs_pipe(
            device,
            "bloom-pre-pipe",
            &single_src_post_bgl,
            &mod_bloom_pre,
            hdr_format,
        );
        let bloom_down_pipeline = make_fs_pipe(
            device,
            "bloom-down-pipe",
            &single_src_post_bgl,
            &mod_bloom_down,
            hdr_format,
        );
        let bloom_up_pipeline =
            make_fs_pipe(device, "bloom-up-pipe", &bloom_up_bgl, &mod_bloom_up, hdr_format);
        let ana_pipeline = make_fs_pipe(
            device,
            "ana-pipe",
            &single_src_post_bgl,
            &mod_ana,
            hdr_format,
        );
        let comp_pipeline = make_fs_pipe(
            device,
            "comp-pipe",
            &comp_bgl,
            &mod_comp,
            composite_format,
        );
        let glass_blur_pipeline = make_fs_pipe(
            device,
            "glass-blur-pipe",
            &single_src_post_bgl,
            &mod_glass,
            composite_format,
        );
        let blit_pipeline = make_fs_pipe(
            device,
            "blit-pipe",
            &blit_bgl,
            &mod_blit,
            target_format,
        );

        let make_ubo = |label: &str, size: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };

        let taa_ubo = make_ubo("taa-ubo", 16);
        let bloom_pre_ubo = make_ubo("bloom-pre-ubo", 32);
        let bloom_down_ubos = (0..BLOOM_MIP_COUNT)
            .map(|i| make_ubo(&format!("bloom-down-ubo-{i}"), 16))
            .collect::<Vec<_>>();
        let bloom_up_ubos = (0..(BLOOM_MIP_COUNT - 1))
            .map(|i| make_ubo(&format!("bloom-up-ubo-{i}"), 16))
            .collect::<Vec<_>>();
        let ana_ubo_0 = make_ubo("ana-ubo-0", std::mem::size_of::<AnamorphicUniforms>() as u64);
        let ana_ubo_1 = make_ubo("ana-ubo-1", std::mem::size_of::<AnamorphicUniforms>() as u64);
        let comp_ubo = make_ubo("comp-ubo", std::mem::size_of::<CompositeUniforms>() as u64);
        let glass_ubo_0 = make_ubo("glass-ubo-0", 16);
        let glass_ubo_1 = make_ubo("glass-ubo-1", 16);

        let (render_width, render_height) =
            compute_render_dims(window_width, window_height, resolution_scale);

        let targets = create_targets(
            device,
            queue,
            hdr_format,
            composite_format,
            render_width,
            render_height,
            window_width,
            window_height,
        );
        let bgs = create_bind_groups(
            device,
            &taa_bgl,
            &single_src_post_bgl,
            &bloom_up_bgl,
            &comp_bgl,
            &blit_bgl,
            &s_linear_clamp,
            &taa_ubo,
            &bloom_pre_ubo,
            &bloom_down_ubos,
            &bloom_up_ubos,
            &ana_ubo_0,
            &ana_ubo_1,
            &comp_ubo,
            &glass_ubo_0,
            &glass_ubo_1,
            &targets,
        );

        Self {
            hdr_format,
            composite_format,
            target_format,
            render_width,
            render_height,
            window_width: window_width.max(1),
            window_height: window_height.max(1),
            resolution_scale,
            frame_index: 0,
            sample_count: 0,
            taa_read_idx: 0,
            taa_write_idx: 1,
            hard_reset: true,
            post_dirty: true,
            was_progressive: false,
            taa_bgl,
            single_src_post_bgl,
            bloom_up_bgl,
            comp_bgl,
            blit_bgl,
            taa_pipeline,
            bloom_pre_pipeline,
            bloom_down_pipeline,
            bloom_up_pipeline,
            ana_pipeline,
            comp_pipeline,
            glass_blur_pipeline,
            blit_pipeline,
            taa_ubo,
            bloom_pre_ubo,
            bloom_down_ubos,
            bloom_up_ubos,
            ana_ubo_0,
            ana_ubo_1,
            comp_ubo,
            glass_ubo_0,
            glass_ubo_1,
            scene_rt: targets.scene_rt,
            taa_rts: targets.taa_rts,
            bloom_down_rts: targets.bloom_down_rts,
            bloom_up_rts: targets.bloom_up_rts,
            ana_rt_a: targets.ana_rt_a,
            ana_rt_b: targets.ana_rt_b,
            composite_rt: targets.composite_rt,
            glass_temp_rt: targets.glass_temp_rt,
            glass_backdrop_rt: targets.glass_backdrop_rt,
            taa_bgs: bgs.taa_bgs,
            bloom_pre_bgs: bgs.bloom_pre_bgs,
            bloom_down_bgs: bgs.bloom_down_bgs,
            bloom_up_bgs: bgs.bloom_up_bgs,
            ana_bg_0: bgs.ana_bg_0,
            ana_bg_1: bgs.ana_bg_1,
            comp_bgs: bgs.comp_bgs,
            glass_bg_0: bgs.glass_bg_0,
            glass_bg_1: bgs.glass_bg_1,
            blit_bg: bgs.blit_bg,
            s_linear_clamp,
        }
    }

    pub fn reset_accumulation(&mut self, hard: bool) {
        self.sample_count = 0;
        self.post_dirty = true;
        if hard {
            self.hard_reset = true;
        }
    }

    pub fn mark_post_dirty(&mut self) {
        self.post_dirty = true;
    }

    pub fn resize(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        window_width: u32,
        window_height: u32,
        resolution_scale: f32,
    ) -> bool {
        let win_w = window_width.max(1);
        let win_h = window_height.max(1);
        let scale = resolution_scale.clamp(0.25, 1.0);
        let (next_rw, next_rh) = compute_render_dims(win_w, win_h, scale);

        if next_rw == self.render_width
            && next_rh == self.render_height
            && win_w == self.window_width
            && win_h == self.window_height
            && (scale - self.resolution_scale).abs() < 1e-4
        {
            return false;
        }

        self.render_width = next_rw;
        self.render_height = next_rh;
        self.window_width = win_w;
        self.window_height = win_h;
        self.resolution_scale = scale;

        let targets = create_targets(
            device,
            queue,
            self.hdr_format,
            self.composite_format,
            next_rw,
            next_rh,
            win_w,
            win_h,
        );
        let bgs = create_bind_groups(
            device,
            &self.taa_bgl,
            &self.single_src_post_bgl,
            &self.bloom_up_bgl,
            &self.comp_bgl,
            &self.blit_bgl,
            &self.s_linear_clamp,
            &self.taa_ubo,
            &self.bloom_pre_ubo,
            &self.bloom_down_ubos,
            &self.bloom_up_ubos,
            &self.ana_ubo_0,
            &self.ana_ubo_1,
            &self.comp_ubo,
            &self.glass_ubo_0,
            &self.glass_ubo_1,
            &targets,
        );

        self.scene_rt = targets.scene_rt;
        self.taa_rts = targets.taa_rts;
        self.bloom_down_rts = targets.bloom_down_rts;
        self.bloom_up_rts = targets.bloom_up_rts;
        self.ana_rt_a = targets.ana_rt_a;
        self.ana_rt_b = targets.ana_rt_b;
        self.composite_rt = targets.composite_rt;
        self.glass_temp_rt = targets.glass_temp_rt;
        self.glass_backdrop_rt = targets.glass_backdrop_rt;

        self.taa_bgs = bgs.taa_bgs;
        self.bloom_pre_bgs = bgs.bloom_pre_bgs;
        self.bloom_down_bgs = bgs.bloom_down_bgs;
        self.bloom_up_bgs = bgs.bloom_up_bgs;
        self.ana_bg_0 = bgs.ana_bg_0;
        self.ana_bg_1 = bgs.ana_bg_1;
        self.comp_bgs = bgs.comp_bgs;
        self.glass_bg_0 = bgs.glass_bg_0;
        self.glass_bg_1 = bgs.glass_bg_1;
        self.blit_bg = bgs.blit_bg;

        self.reset_accumulation(true);
        true
    }

    /// Computes whether the primary raytrace pass should run this frame, and if so returns
    /// `(jitter_x, jitter_y, blend_factor, is_progressive)` and increments `frame_index`/`sample_count`.
    /// Returns `None` if progressive accumulation reached 128 samples (only regrade if `post_dirty`).
    pub fn plan_frame(&mut self, params: &PostFrameParams) -> FramePlan {
        let is_progressive = params.paused && !params.camera_moved;
        if is_progressive != self.was_progressive {
            self.sample_count = 0;
            self.was_progressive = is_progressive;
            self.post_dirty = true;
        }
        if params.camera_moved {
            self.post_dirty = true;
        }

        if is_progressive {
            if self.sample_count < MAX_PROGRESSIVE_SAMPLES {
                self.frame_index = self.frame_index.wrapping_add(1);
                self.sample_count += 1;
                let jitter_x = if self.sample_count == 1 {
                    0.0
                } else {
                    halton(self.sample_count, 2) - 0.5
                };
                let jitter_y = if self.sample_count == 1 {
                    0.0
                } else {
                    halton(self.sample_count, 3) - 0.5
                };
                let blend_factor = if self.hard_reset {
                    1.0
                } else {
                    1.0 / self.sample_count as f32
                };
                self.hard_reset = false;
                FramePlan {
                    run_raytrace: true,
                    run_post: true,
                    jitter: [jitter_x, jitter_y],
                    blend_factor,
                    is_progressive: true,
                }
            } else if self.post_dirty {
                FramePlan {
                    run_raytrace: false,
                    run_post: true,
                    jitter: [0.0, 0.0],
                    blend_factor: 0.0,
                    is_progressive: true,
                }
            } else {
                FramePlan {
                    run_raytrace: false,
                    run_post: false,
                    jitter: [0.0, 0.0],
                    blend_factor: 0.0,
                    is_progressive: true,
                }
            }
        } else {
            self.frame_index = self.frame_index.wrapping_add(1);
            let blend_factor = if self.hard_reset || self.sample_count == 0 {
                self.sample_count = 1;
                self.hard_reset = false;
                1.0
            } else if params.camera_moved {
                self.sample_count = 1;
                0.28
            } else {
                self.sample_count = (self.sample_count + 1).min(16);
                0.14
            };
            let jitter_idx = (self.frame_index % 16) + 1;
            let (jitter_x, jitter_y) = if blend_factor >= 0.999 {
                (0.0, 0.0)
            } else {
                (halton(jitter_idx, 2) - 0.5, halton(jitter_idx, 3) - 0.5)
            };
            FramePlan {
                run_raytrace: true,
                run_post: true,
                jitter: [jitter_x, jitter_y],
                blend_factor,
                is_progressive: false,
            }
        }
    }

    pub fn encode_taa(
        &mut self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        plan: &FramePlan,
    ) {
        let ubo: [f32; 4] = [
            1.0 / self.render_width as f32,
            1.0 / self.render_height as f32,
            plan.blend_factor,
            if plan.is_progressive { 1.0 } else { 0.0 },
        ];
        queue.write_buffer(&self.taa_ubo, 0, bytemuck::cast_slice(&ubo));

        let output_view = &self.taa_rts[self.taa_write_idx].view;
        let bg = &self.taa_bgs[self.taa_read_idx];
        run_fs_pass(encoder, "taa-pass", output_view, &self.taa_pipeline, bg);

        std::mem::swap(&mut self.taa_read_idx, &mut self.taa_write_idx);
    }

    pub fn encode_post_and_composite(
        &mut self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        params: &PostFrameParams,
        update_glass_blur: bool,
    ) {
        let tuning = &params.tuning;
        let need_bloom = params.bloom_intensity > 0.001;
        let need_ana = params.anamorphic_intensity > 0.001;

        if need_bloom || need_ana {
            // 1. Bloom prefilter
            let pre_ubo = BloomPrefilterUniforms {
                texel_thresh_knee: [
                    1.0 / self.render_width as f32,
                    1.0 / self.render_height as f32,
                    tuning.bloom_threshold,
                    tuning.bloom_knee,
                ],
                clamp_max_pad: [tuning.bloom_clamp, 0.0, 0.0, 0.0],
            };
            queue.write_buffer(&self.bloom_pre_ubo, 0, bytemuck::bytes_of(&pre_ubo));
            run_fs_pass(
                encoder,
                "bloom-prefilter",
                &self.bloom_down_rts[0].view,
                &self.bloom_pre_pipeline,
                &self.bloom_pre_bgs[self.taa_read_idx],
            );

            // 2. 6-level Jimenez 13-tap Downsample Chain
            let max_down = if need_bloom { BLOOM_MIP_COUNT - 1 } else { 1 };
            for i in 1..=max_down {
                let src = &self.bloom_down_rts[i - 1];
                let dst = &self.bloom_down_rts[i];
                if let Some(bg) = &self.bloom_down_bgs[i] {
                    let df: [f32; 4] = [
                        1.0 / src.width as f32,
                        1.0 / src.height as f32,
                        if i == 1 { 1.0 } else { 0.0 },
                        0.0,
                    ];
                    queue.write_buffer(&self.bloom_down_ubos[i], 0, bytemuck::cast_slice(&df));
                    run_fs_pass(
                        encoder,
                        "bloom-downsample",
                        &dst.view,
                        &self.bloom_down_pipeline,
                        bg,
                    );
                }
            }

            // 3. 9-tap tent upsample chain
            if need_bloom {
                for i in (0..=(BLOOM_MIP_COUNT - 2)).rev() {
                    let low_src = if i == BLOOM_MIP_COUNT - 2 {
                        &self.bloom_down_rts[i + 1]
                    } else {
                        &self.bloom_up_rts[i + 1]
                    };
                    let uf: [f32; 4] = [
                        1.0 / low_src.width as f32,
                        1.0 / low_src.height as f32,
                        1.05,
                        0.66,
                    ];
                    queue.write_buffer(&self.bloom_up_ubos[i], 0, bytemuck::cast_slice(&uf));
                    run_fs_pass(
                        encoder,
                        "bloom-upsample",
                        &self.bloom_up_rts[i].view,
                        &self.bloom_up_pipeline,
                        &self.bloom_up_bgs[i],
                    );
                }
            }

            // 4. 2-pass horizontal anamorphic optical streak
            if need_ana {
                let src0 = &self.bloom_down_rts[1];
                let a0 = AnamorphicUniforms {
                    texel_thresh_spread: [
                        1.0 / src0.width as f32,
                        1.0 / src0.height as f32,
                        tuning.ana_threshold,
                        1.05,
                    ],
                    pass_pad: [0.0; 4],
                    tint_inner_edge: [
                        tuning.ana_inner_tint[0],
                        tuning.ana_inner_tint[1],
                        tuning.ana_inner_tint[2],
                        tuning.ana_edge_start,
                    ],
                    tint_outer_mix: [
                        tuning.ana_outer_tint[0],
                        tuning.ana_outer_tint[1],
                        tuning.ana_outer_tint[2],
                        tuning.ana_mix_weight,
                    ],
                };
                queue.write_buffer(&self.ana_ubo_0, 0, bytemuck::bytes_of(&a0));
                run_fs_pass(
                    encoder,
                    "anamorphic-pass-0",
                    &self.ana_rt_a.view,
                    &self.ana_pipeline,
                    &self.ana_bg_0,
                );

                let a1 = AnamorphicUniforms {
                    texel_thresh_spread: [
                        1.0 / self.ana_rt_a.width as f32,
                        1.0 / self.ana_rt_a.height as f32,
                        0.0,
                        1.15,
                    ],
                    pass_pad: [1.0, 0.0, 0.0, 0.0],
                    tint_inner_edge: a0.tint_inner_edge,
                    tint_outer_mix: a0.tint_outer_mix,
                };
                queue.write_buffer(&self.ana_ubo_1, 0, bytemuck::bytes_of(&a1));
                run_fs_pass(
                    encoder,
                    "anamorphic-pass-1",
                    &self.ana_rt_b.view,
                    &self.ana_pipeline,
                    &self.ana_bg_1,
                );
            }
        }

        // 5. AgX Composite -> composite_rt (Rgba8Unorm)
        let comp_ubo = CompositeUniforms {
            res_exposure_bloom: [
                self.render_width as f32,
                self.render_height as f32,
                params.exposure,
                params.bloom_intensity,
            ],
            ana_time_frame_pad: [
                params.anamorphic_intensity,
                params.sim_time,
                (self.frame_index & 255) as f32,
                0.0,
            ],
            weights_pad: [tuning.bloom_weight, tuning.ana_weight, 0.0, 0.0],
        };
        queue.write_buffer(&self.comp_ubo, 0, bytemuck::bytes_of(&comp_ubo));
        run_fs_pass(
            encoder,
            "composite-pass",
            &self.composite_rt.view,
            &self.comp_pipeline,
            &self.comp_bgs[self.taa_read_idx],
        );

        self.post_dirty = false;

        if update_glass_blur {
            self.encode_glass_blur(queue, encoder);
        }
    }

    pub fn encode_glass_blur(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        let gw = self.glass_backdrop_rt.width as f32;
        let gh = self.glass_backdrop_rt.height as f32;
        let g0: [f32; 4] = [1.0 / gw, 0.0, 1.0, 0.0];
        let g1: [f32; 4] = [0.0, 1.0 / gh, 1.25, 0.0];
        queue.write_buffer(&self.glass_ubo_0, 0, bytemuck::cast_slice(&g0));
        queue.write_buffer(&self.glass_ubo_1, 0, bytemuck::cast_slice(&g1));

        run_fs_pass(
            encoder,
            "glass-blur-h",
            &self.glass_temp_rt.view,
            &self.glass_blur_pipeline,
            &self.glass_bg_0,
        );
        run_fs_pass(
            encoder,
            "glass-blur-v",
            &self.glass_backdrop_rt.view,
            &self.glass_blur_pipeline,
            &self.glass_bg_1,
        );
    }

    pub fn encode_blit_to_target(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target_view: &wgpu::TextureView,
    ) {
        run_fs_pass(
            encoder,
            "blit-composite",
            target_view,
            &self.blit_pipeline,
            &self.blit_bg,
        );
    }
}

pub struct FramePlan {
    pub run_raytrace: bool,
    pub run_post: bool,
    pub jitter: [f32; 2],
    pub blend_factor: f32,
    pub is_progressive: bool,
}

fn compute_render_dims(window_width: u32, window_height: u32, scale: f32) -> (u32, u32) {
    let rw = ((window_width as f32) * scale).round().max(64.0) as u32;
    let rh = ((window_height as f32) * scale).round().max(64.0) as u32;
    (rw, rh)
}

struct Targets {
    scene_rt: RenderTarget,
    taa_rts: [RenderTarget; 2],
    bloom_down_rts: Vec<RenderTarget>,
    bloom_up_rts: Vec<RenderTarget>,
    ana_rt_a: RenderTarget,
    ana_rt_b: RenderTarget,
    composite_rt: RenderTarget,
    glass_temp_rt: RenderTarget,
    glass_backdrop_rt: RenderTarget,
}

#[allow(clippy::too_many_arguments)]
fn create_targets(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    hdr_format: wgpu::TextureFormat,
    composite_format: wgpu::TextureFormat,
    render_w: u32,
    render_h: u32,
    win_w: u32,
    win_h: u32,
) -> Targets {
    let scene_rt = RenderTarget::new(
        device,
        "scene-rt",
        render_w,
        render_h,
        hdr_format,
        wgpu::TextureUsages::empty(),
    );
    let taa_rts = [
        RenderTarget::new(
            device,
            "taa-rt-0",
            render_w,
            render_h,
            hdr_format,
            wgpu::TextureUsages::empty(),
        ),
        RenderTarget::new(
            device,
            "taa-rt-1",
            render_w,
            render_h,
            hdr_format,
            wgpu::TextureUsages::empty(),
        ),
    ];

    let mut bloom_down_rts = Vec::with_capacity(BLOOM_MIP_COUNT);
    let mut bloom_up_rts = Vec::with_capacity(BLOOM_MIP_COUNT - 1);
    let mut mip_w = (render_w >> 1).max(1);
    let mut mip_h = (render_h >> 1).max(1);
    for i in 0..BLOOM_MIP_COUNT {
        bloom_down_rts.push(RenderTarget::new(
            device,
            &format!("bloom-down-{i}"),
            mip_w,
            mip_h,
            hdr_format,
            wgpu::TextureUsages::empty(),
        ));
        if i < BLOOM_MIP_COUNT - 1 {
            bloom_up_rts.push(RenderTarget::new(
                device,
                &format!("bloom-up-{i}"),
                mip_w,
                mip_h,
                hdr_format,
                wgpu::TextureUsages::empty(),
            ));
        }
        mip_w = (mip_w >> 1).max(1);
        mip_h = (mip_h >> 1).max(1);
    }

    let ana_w = (render_w >> 2).max(1);
    let ana_h = (render_h >> 2).max(1);
    let ana_rt_a = RenderTarget::new(
        device,
        "ana-rt-a",
        ana_w,
        ana_h,
        hdr_format,
        wgpu::TextureUsages::empty(),
    );
    let ana_rt_b = RenderTarget::new(
        device,
        "ana-rt-b",
        ana_w,
        ana_h,
        hdr_format,
        wgpu::TextureUsages::empty(),
    );

    let composite_rt = RenderTarget::new(
        device,
        "composite-rt",
        render_w,
        render_h,
        composite_format,
        wgpu::TextureUsages::COPY_SRC,
    );

    let glass_w = (win_w / 4).max(64);
    let glass_h = (win_h / 4).max(64);
    let glass_temp_rt = RenderTarget::new(
        device,
        "glass-temp-rt",
        glass_w,
        glass_h,
        composite_format,
        wgpu::TextureUsages::empty(),
    );
    let glass_backdrop_rt = RenderTarget::new(
        device,
        "glass-backdrop-rt",
        glass_w,
        glass_h,
        composite_format,
        wgpu::TextureUsages::empty(),
    );

    // Clear taa_rts, bloom_up_rts[0], ana_rt_b, composite_rt, glass_backdrop_rt once on resize
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("clear-rts"),
    });
    for view in [
        &taa_rts[0].view,
        &taa_rts[1].view,
        &bloom_up_rts[0].view,
        &ana_rt_b.view,
        &composite_rt.view,
        &glass_backdrop_rt.view,
    ] {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear-rt"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
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
    }
    queue.submit([encoder.finish()]);

    Targets {
        scene_rt,
        taa_rts,
        bloom_down_rts,
        bloom_up_rts,
        ana_rt_a,
        ana_rt_b,
        composite_rt,
        glass_temp_rt,
        glass_backdrop_rt,
    }
}

struct BindGroups {
    taa_bgs: [wgpu::BindGroup; 2],
    bloom_pre_bgs: [wgpu::BindGroup; 2],
    bloom_down_bgs: Vec<Option<wgpu::BindGroup>>,
    bloom_up_bgs: Vec<wgpu::BindGroup>,
    ana_bg_0: wgpu::BindGroup,
    ana_bg_1: wgpu::BindGroup,
    comp_bgs: [wgpu::BindGroup; 2],
    glass_bg_0: wgpu::BindGroup,
    glass_bg_1: wgpu::BindGroup,
    blit_bg: wgpu::BindGroup,
}

#[allow(clippy::too_many_arguments)]
fn create_bind_groups(
    device: &wgpu::Device,
    taa_bgl: &wgpu::BindGroupLayout,
    single_src_bgl: &wgpu::BindGroupLayout,
    bloom_up_bgl: &wgpu::BindGroupLayout,
    comp_bgl: &wgpu::BindGroupLayout,
    blit_bgl: &wgpu::BindGroupLayout,
    s_linear: &wgpu::Sampler,
    taa_ubo: &wgpu::Buffer,
    bloom_pre_ubo: &wgpu::Buffer,
    bloom_down_ubos: &[wgpu::Buffer],
    bloom_up_ubos: &[wgpu::Buffer],
    ana_ubo_0: &wgpu::Buffer,
    ana_ubo_1: &wgpu::Buffer,
    comp_ubo: &wgpu::Buffer,
    glass_ubo_0: &wgpu::Buffer,
    glass_ubo_1: &wgpu::Buffer,
    t: &Targets,
) -> BindGroups {
    let make_taa_bg = |read_idx: usize| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("taa-bg-{read_idx}")),
            layout: taa_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: taa_ubo.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&t.scene_rt.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&t.taa_rts[read_idx].view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(s_linear),
                },
            ],
        })
    };

    let make_bloom_pre_bg = |read_idx: usize| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("bloom-pre-bg-{read_idx}")),
            layout: single_src_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: bloom_pre_ubo.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&t.taa_rts[read_idx].view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(s_linear),
                },
            ],
        })
    };

    let make_comp_bg = |read_idx: usize| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("comp-bg-{read_idx}")),
            layout: comp_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: comp_ubo.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&t.taa_rts[read_idx].view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&t.bloom_up_rts[0].view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&t.ana_rt_b.view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(s_linear),
                },
            ],
        })
    };

    let taa_bgs = [make_taa_bg(0), make_taa_bg(1)];
    let bloom_pre_bgs = [make_bloom_pre_bg(0), make_bloom_pre_bg(1)];
    let comp_bgs = [make_comp_bg(0), make_comp_bg(1)];

    let mut bloom_down_bgs = vec![None];
    for i in 1..BLOOM_MIP_COUNT {
        bloom_down_bgs.push(Some(device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some(&format!("bloom-down-bg-{i}")),
                layout: single_src_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: bloom_down_ubos[i].as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&t.bloom_down_rts[i - 1].view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(s_linear),
                    },
                ],
            },
        )));
    }

    let mut bloom_up_bgs = Vec::with_capacity(BLOOM_MIP_COUNT - 1);
    for i in 0..(BLOOM_MIP_COUNT - 1) {
        let low_src = if i == BLOOM_MIP_COUNT - 2 {
            &t.bloom_down_rts[i + 1].view
        } else {
            &t.bloom_up_rts[i + 1].view
        };
        let high_src = &t.bloom_down_rts[i].view;
        bloom_up_bgs.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("bloom-up-bg-{i}")),
            layout: bloom_up_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: bloom_up_ubos[i].as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(low_src),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(high_src),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(s_linear),
                },
            ],
        }));
    }

    let ana_bg_0 = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ana-bg-0"),
        layout: single_src_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: ana_ubo_0.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&t.bloom_down_rts[1].view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(s_linear),
            },
        ],
    });
    let ana_bg_1 = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ana-bg-1"),
        layout: single_src_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: ana_ubo_1.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&t.ana_rt_a.view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(s_linear),
            },
        ],
    });

    let glass_bg_0 = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("glass-bg-0"),
        layout: single_src_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: glass_ubo_0.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&t.composite_rt.view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(s_linear),
            },
        ],
    });
    let glass_bg_1 = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("glass-bg-1"),
        layout: single_src_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: glass_ubo_1.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&t.glass_temp_rt.view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(s_linear),
            },
        ],
    });

    let blit_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("blit-bg"),
        layout: blit_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&t.composite_rt.view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(s_linear),
            },
        ],
    });

    BindGroups {
        taa_bgs,
        bloom_pre_bgs,
        bloom_down_bgs,
        bloom_up_bgs,
        ana_bg_0,
        ana_bg_1,
        comp_bgs,
        glass_bg_0,
        glass_bg_1,
        blit_bg,
    }
}

pub fn run_fs_pass(
    encoder: &mut wgpu::CommandEncoder,
    label: &str,
    dst_view: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: dst_view,
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
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

fn ubo_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn tex2d_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

pub fn make_fs_pipe(
    device: &wgpu::Device,
    label: &str,
    bgl: &wgpu::BindGroupLayout,
    module: &wgpu::ShaderModule,
    target_format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(&format!("{label}-layout")),
        bind_group_layouts: &[Some(bgl)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: target_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}
