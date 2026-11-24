pub mod post;

use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;

use crate::assets::{luts, sky};
use crate::shaders;

pub const VOLUME_SIZE: u32 = 128;

pub struct SharedGpuAssets {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub adapter_info: wgpu::AdapterInfo,
    pub adapter_label: String,

    pub s_linear_clamp: wgpu::Sampler,
    pub s_volume_repeat: wgpu::Sampler,
    pub s_sky_aniso: wgpu::Sampler,

    mipmap_bgl: wgpu::BindGroupLayout,
    mipmap_pipeline: wgpu::RenderPipeline,

    pub volume_noise_tex: wgpu::Texture,
    pub volume_noise_view: wgpu::TextureView,

    pub blackbody_tex: wgpu::Texture,
    pub blackbody_view: wgpu::TextureView,

    pub blue_noise_tex: wgpu::Texture,
    pub blue_noise_view: wgpu::TextureView,

    pub proc_sky_tex: wgpu::Texture,
    pub proc_sky_view: wgpu::TextureView,

    pub real_sky_tex: Option<wgpu::Texture>,
    pub real_sky_view: wgpu::TextureView,
    pub sky_map_loaded: bool,
    pub sky_dimensions: (u32, u32),

    pub exotic_sky_b_tex: Option<wgpu::Texture>,
    pub exotic_sky_b_view: Option<wgpu::TextureView>,

    pub standard_sim_bgl: wgpu::BindGroupLayout,
    pub binary_sim_bgl: wgpu::BindGroupLayout,
    pub wormhole_sim_bgl: wgpu::BindGroupLayout,

    sky_rx: Option<Receiver<SkyDecodeResult>>,
}

struct SkyDecodeResult {
    real_sky: &'static sky::RgbaImageData,
    exotic_b: &'static sky::RgbaImageData,
}

impl SharedGpuAssets {
    pub fn new(
        device: Arc<wgpu::Device>,
        queue: Arc<wgpu::Queue>,
        adapter_info: wgpu::AdapterInfo,
        sync_sky: bool,
    ) -> Self {
        let adapter_label = format_adapter_label(&adapter_info);

        let s_linear_clamp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("linear-clamp"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        let s_volume_repeat = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("volume-repeat"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            ..Default::default()
        });

        let s_sky_aniso = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("sky-aniso"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            anisotropy_clamp: 8,
            ..Default::default()
        });

        // Mipmap generator pipeline
        let mipmap_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mipmap-wgsl"),
            source: wgpu::ShaderSource::Wgsl(shaders::MIPMAP.into()),
        });
        let mipmap_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mipmap-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let mipmap_pipeline = post::make_fs_pipe(
            &device,
            "mipmap-pipe",
            &mipmap_bgl,
            &mipmap_mod,
            wgpu::TextureFormat::Rgba8Unorm,
        );

        // Bake 128^3 3D volume noise via GPU compute shader
        let (volume_noise_tex, volume_noise_view) = bake_volume_noise(&device, &queue);

        // Static physical LUTs
        let (blackbody_tex, blackbody_view) =
            luts::create_blackbody_lut_texture(&device, &queue, 512);
        let (blue_noise_tex, blue_noise_view) =
            luts::create_blue_noise_texture(&device, &queue, 128);

        // Procedural Universe A sky (2048x1024) + GPU mip chain
        let proc_img = sky::get_procedural_sky_a();
        let (proc_sky_tex, proc_sky_view) = upload_rgba8_sky_with_mips(
            &device,
            &queue,
            &mipmap_bgl,
            &mipmap_pipeline,
            &s_linear_clamp,
            "proc-sky-map",
            proc_img,
        );

        let standard_sim_bgl = make_standard_sim_bgl(&device, "standard-sim-bgl", false);
        let binary_sim_bgl = make_standard_sim_bgl(&device, "binary-sim-bgl", true);
        let wormhole_sim_bgl = make_wormhole_sim_bgl(&device);

        let mut assets = Self {
            device,
            queue,
            adapter_info,
            adapter_label,
            s_linear_clamp,
            s_volume_repeat,
            s_sky_aniso,
            mipmap_bgl,
            mipmap_pipeline,
            volume_noise_tex,
            volume_noise_view,
            blackbody_tex,
            blackbody_view,
            blue_noise_tex,
            blue_noise_view,
            proc_sky_tex,
            proc_sky_view: proc_sky_view.clone(),
            real_sky_tex: None,
            real_sky_view: proc_sky_view,
            sky_map_loaded: false,
            sky_dimensions: (proc_img.width, proc_img.height),
            exotic_sky_b_tex: None,
            exotic_sky_b_view: None,
            standard_sim_bgl,
            binary_sim_bgl,
            wormhole_sim_bgl,
            sky_rx: None,
        };

        if sync_sky {
            let real_img = sky::get_real_milkyway_4k();
            let exotic_b = sky::get_exotic_nebula_b();
            assets.install_sky_data(real_img, exotic_b);
        } else {
            let (tx, rx) = mpsc::channel();
            assets.sky_rx = Some(rx);
            thread::spawn(move || {
                let real_sky = sky::get_real_milkyway_4k();
                let exotic_b = sky::get_exotic_nebula_b();
                let _ = tx.send(SkyDecodeResult { real_sky, exotic_b });
            });
        }

        assets
    }

    /// Returns `true` if new sky textures were uploaded on this tick (caller should rebuild bind groups).
    pub fn poll_background_sky(&mut self) -> bool {
        let Some(rx) = &self.sky_rx else {
            return false;
        };
        match rx.try_recv() {
            Ok(res) => {
                self.sky_rx = None;
                self.install_sky_data(res.real_sky, res.exotic_b);
                true
            }
            Err(mpsc::TryRecvError::Empty) => false,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.sky_rx = None;
                false
            }
        }
    }

    pub fn ensure_exotic_sky_b(&mut self) -> &wgpu::TextureView {
        if self.exotic_sky_b_view.is_none() {
            let img = sky::get_exotic_nebula_b();
            let (tex, view) = upload_rgba8_sky_with_mips(
                &self.device,
                &self.queue,
                &self.mipmap_bgl,
                &self.mipmap_pipeline,
                &self.s_linear_clamp,
                "exotic-nebula-b-map",
                img,
            );
            self.exotic_sky_b_tex = Some(tex);
            self.exotic_sky_b_view = Some(view);
        }
        self.exotic_sky_b_view.as_ref().unwrap()
    }

    fn install_sky_data(
        &mut self,
        real_img: &'static sky::RgbaImageData,
        exotic_b: &'static sky::RgbaImageData,
    ) {
        let (real_tex, real_view) = upload_rgba8_sky_with_mips(
            &self.device,
            &self.queue,
            &self.mipmap_bgl,
            &self.mipmap_pipeline,
            &self.s_linear_clamp,
            "real-sky-map",
            real_img,
        );
        self.real_sky_tex = Some(real_tex);
        self.real_sky_view = real_view;
        self.sky_map_loaded = true;
        self.sky_dimensions = (real_img.width, real_img.height);

        if self.exotic_sky_b_tex.is_none() {
            let (b_tex, b_view) = upload_rgba8_sky_with_mips(
                &self.device,
                &self.queue,
                &self.mipmap_bgl,
                &self.mipmap_pipeline,
                &self.s_linear_clamp,
                "exotic-nebula-b-map",
                exotic_b,
            );
            self.exotic_sky_b_tex = Some(b_tex);
            self.exotic_sky_b_view = Some(b_view);
        }
    }

    pub fn build_standard_bind_group(
        &self,
        label: &str,
        ubo: &wgpu::Buffer,
        extra_tidal_view: Option<&wgpu::TextureView>,
    ) -> wgpu::BindGroup {
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 0,
                resource: ubo.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&self.volume_noise_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&self.s_volume_repeat),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&self.real_sky_view),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::TextureView(&self.proc_sky_view),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::Sampler(&self.s_sky_aniso),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: wgpu::BindingResource::TextureView(&self.blackbody_view),
            },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: wgpu::BindingResource::Sampler(&self.s_linear_clamp),
            },
            wgpu::BindGroupEntry {
                binding: 8,
                resource: wgpu::BindingResource::TextureView(&self.blue_noise_view),
            },
        ];

        let layout = if let Some(tidal_view) = extra_tidal_view {
            entries.push(wgpu::BindGroupEntry {
                binding: 9,
                resource: wgpu::BindingResource::TextureView(tidal_view),
            });
            &self.binary_sim_bgl
        } else {
            &self.standard_sim_bgl
        };

        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &entries,
        })
    }

    pub fn build_wormhole_bind_group(&mut self, ubo: &wgpu::Buffer) -> wgpu::BindGroup {
        self.ensure_exotic_sky_b();
        let b_view = self.exotic_sky_b_view.as_ref().unwrap();
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wormhole-bg"),
            layout: &self.wormhole_sim_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: ubo.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.volume_noise_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.s_volume_repeat),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.real_sky_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&self.proc_sky_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(b_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(&self.s_sky_aniso),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::TextureView(&self.blue_noise_view),
                },
            ],
        })
    }
}

pub fn format_adapter_label(info: &wgpu::AdapterInfo) -> String {
    let backend = match info.backend {
        wgpu::Backend::Vulkan => "Vulkan",
        wgpu::Backend::Metal => "Metal",
        wgpu::Backend::Dx12 => "DX12",
        wgpu::Backend::Gl => "OpenGL",
        wgpu::Backend::BrowserWebGpu => "WebGPU",
        wgpu::Backend::Noop => "Noop",
    };
    if info.name.is_empty() {
        format!("Native wgpu · {backend}")
    } else {
        format!("Native wgpu · {backend} ({})", info.name)
    }
}

fn bake_volume_noise(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> (wgpu::Texture, wgpu::TextureView) {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("volume-noise-3d"),
        size: wgpu::Extent3d {
            width: VOLUME_SIZE,
            height: VOLUME_SIZE,
            depth_or_array_layers: VOLUME_SIZE,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

    let noise_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("noise-bake-wgsl"),
        source: wgpu::ShaderSource::Wgsl(shaders::NOISE_BAKE.into()),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("noise-bake-bgl"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba8Unorm,
                view_dimension: wgpu::TextureViewDimension::D3,
            },
            count: None,
        }],
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("noise-bake-layout"),
        bind_group_layouts: &[Some(&bgl)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("noise-bake-pipe"),
        layout: Some(&layout),
        module: &noise_mod,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("noise-bake-bg"),
        layout: &bgl,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&view),
        }],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("bake-3d-noise"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("bake-3d-noise-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bg, &[]);
        let wg = VOLUME_SIZE.div_ceil(4);
        pass.dispatch_workgroups(wg, wg, wg);
    }
    queue.submit([encoder.finish()]);
    (tex, view)
}

fn upload_rgba8_sky_with_mips(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    mipmap_bgl: &wgpu::BindGroupLayout,
    mipmap_pipeline: &wgpu::RenderPipeline,
    s_linear_clamp: &wgpu::Sampler,
    label: &str,
    img: &sky::RgbaImageData,
) -> (wgpu::Texture, wgpu::TextureView) {
    let mip_level_count = (img.width.max(img.height) as f32).log2().floor() as u32 + 1;
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: img.width,
            height: img.height,
            depth_or_array_layers: 1,
        },
        mip_level_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });

    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &img.pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(img.width * 4),
            rows_per_image: Some(img.height),
        },
        wgpu::Extent3d {
            width: img.width,
            height: img.height,
            depth_or_array_layers: 1,
        },
    );

    if mip_level_count > 1 {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("mipmap-gen"),
        });
        for level in 1..mip_level_count {
            let src_view = tex.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level - 1,
                mip_level_count: Some(1),
                ..Default::default()
            });
            let dst_view = tex.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level,
                mip_level_count: Some(1),
                ..Default::default()
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("mipmap-bg"),
                layout: mipmap_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(s_linear_clamp),
                    },
                ],
            });
            post::run_fs_pass(&mut encoder, "mipmap-pass", &dst_view, mipmap_pipeline, &bg);
        }
        queue.submit([encoder.finish()]);
    }

    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    (tex, view)
}

fn make_standard_sim_bgl(
    device: &wgpu::Device,
    label: &str,
    with_tidal: bool,
) -> wgpu::BindGroupLayout {
    let mut entries = vec![
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D3,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        tex2d_frag(3),
        tex2d_frag(4),
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        tex2d_frag(6),
        wgpu::BindGroupLayoutEntry {
            binding: 7,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        tex2d_frag(8),
    ];

    if with_tidal {
        entries.push(tex2d_frag(9));
    }

    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &entries,
    })
}

fn make_wormhole_sim_bgl(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("wormhole-sim-bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D3,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            tex2d_frag(3),
            tex2d_frag(4),
            tex2d_frag(5),
            wgpu::BindGroupLayoutEntry {
                binding: 6,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            tex2d_frag(7),
        ],
    })
}

fn tex2d_frag(binding: u32) -> wgpu::BindGroupLayoutEntry {
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

pub fn readback_rgba8_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let unpadded_bytes_per_row = width * 4;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bytes_per_row = unpadded_bytes_per_row.div_ceil(align) * align;

    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("capture-staging"),
        size: (padded_bytes_per_row as u64) * (height as u64),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("capture-copy"),
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);

    let slice = staging.slice(..);
    let (tx, rx) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    rx.recv().unwrap().expect("Failed to map readback buffer");

    let mapped = slice.get_mapped_range().expect("Failed to get mapped buffer view");
    let mut out = vec![0u8; (width * height * 4) as usize];
    for y in 0..height as usize {
        let src_start = y * padded_bytes_per_row as usize;
        let dst_start = y * (width as usize * 4);
        out[dst_start..dst_start + (width as usize * 4)]
            .copy_from_slice(&mapped[src_start..src_start + (width as usize * 4)]);
    }
    drop(mapped);
    staging.unmap();
    out
}
