use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver};
use std::thread;

use egui::{ColorImage, Context, TextureHandle, TextureOptions};

use crate::sims::SimId;

pub const BLACKHOLE_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/blackhole.webp");
pub const WORMHOLE_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/wormhole.webp");
pub const BINARY_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/binary.webp");
pub const WARP_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/warp.webp");
pub const SUPERNOVA_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/supernova.webp");
pub const PULSAR_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/pulsar.webp");
pub const STARFLIGHT_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/starflight.webp");
pub const LENS_CLUSTER_PREVIEW_WEBP: &[u8] =
    include_bytes!("../../../home/previews/lens-cluster.webp");

pub fn preview_bytes(id: SimId) -> &'static [u8] {
    match id {
        SimId::Blackhole => BLACKHOLE_PREVIEW_WEBP,
        SimId::Wormhole => WORMHOLE_PREVIEW_WEBP,
        SimId::BinaryBh => BINARY_PREVIEW_WEBP,
        SimId::WarpDrive => WARP_PREVIEW_WEBP,
        SimId::Supernova => SUPERNOVA_PREVIEW_WEBP,
        SimId::Pulsar => PULSAR_PREVIEW_WEBP,
        SimId::Starflight => STARFLIGHT_PREVIEW_WEBP,
        SimId::LensCluster => LENS_CLUSTER_PREVIEW_WEBP,
    }
}

pub fn decode_preview_color_image(id: SimId) -> ColorImage {
    let img = image::load_from_memory_with_format(preview_bytes(id), image::ImageFormat::WebP)
        .expect("Embedded WebP preview must decode")
        .to_rgba8();
    let (width, height) = img.dimensions();
    ColorImage::from_rgba_unmultiplied([width as usize, height as usize], &img.into_raw())
}

#[derive(Default)]
pub struct PreviewTextureCache {
    textures: HashMap<SimId, TextureHandle>,
    bg_rx: Option<Receiver<(SimId, ColorImage)>>,
    bg_started: bool,
}

impl PreviewTextureCache {
    pub fn get(&self, id: SimId) -> Option<&TextureHandle> {
        self.textures.get(&id)
    }

    pub fn get_or_load_sync(&mut self, ctx: &Context, id: SimId) -> &TextureHandle {
        self.textures.entry(id).or_insert_with(|| {
            let color_image = decode_preview_color_image(id);
            ctx.load_texture(
                format!("home_preview_{}", id.cli_name()),
                color_image,
                TextureOptions::LINEAR,
            )
        })
    }

    pub fn preload_all_sync(&mut self, ctx: &Context) {
        self.bg_started = true;
        self.bg_rx = None;
        for id in SimId::ALL {
            let _ = self.get_or_load_sync(ctx, id);
        }
    }

    pub fn ensure_async_loading(&mut self, priority: SimId, ctx: &Context) {
        let _ = self.get_or_load_sync(ctx, priority);
        if self.bg_started {
            return;
        }
        self.bg_started = true;
        let pending: Vec<SimId> = SimId::ALL
            .iter()
            .copied()
            .filter(|id| !self.textures.contains_key(id))
            .collect();
        if pending.is_empty() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        self.bg_rx = Some(rx);
        let ctx_bg = ctx.clone();
        thread::spawn(move || {
            for id in pending {
                let img = decode_preview_color_image(id);
                if tx.send((id, img)).is_err() {
                    break;
                }
                ctx_bg.request_repaint();
            }
        });
    }

    pub fn poll_decoded(&mut self, ctx: &Context) -> bool {
        let Some(rx) = &self.bg_rx else {
            return false;
        };
        let mut loaded_any = false;
        loop {
            match rx.try_recv() {
                Ok((id, color_image)) => {
                    self.textures.entry(id).or_insert_with(|| {
                        ctx.load_texture(
                            format!("home_preview_{}", id.cli_name()),
                            color_image,
                            TextureOptions::LINEAR,
                        )
                    });
                    loaded_any = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.bg_rx = None;
                    break;
                }
            }
        }
        if loaded_any {
            ctx.request_repaint();
        }
        loaded_any
    }
}
