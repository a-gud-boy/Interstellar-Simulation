use std::collections::HashMap;

use egui::{ColorImage, Context, TextureHandle, TextureOptions};

use crate::sims::SimId;

pub const BLACKHOLE_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/blackhole.webp");
pub const WORMHOLE_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/wormhole.webp");
pub const BINARY_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/binary.webp");
pub const WARP_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/warp.webp");
pub const SUPERNOVA_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/supernova.webp");
pub const PULSAR_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/pulsar.webp");
pub const STARFLIGHT_PREVIEW_WEBP: &[u8] = include_bytes!("../../../home/previews/starflight.webp");

pub fn preview_bytes(id: SimId) -> &'static [u8] {
    match id {
        SimId::Blackhole => BLACKHOLE_PREVIEW_WEBP,
        SimId::Wormhole => WORMHOLE_PREVIEW_WEBP,
        SimId::BinaryBh => BINARY_PREVIEW_WEBP,
        SimId::WarpDrive => WARP_PREVIEW_WEBP,
        SimId::Supernova => SUPERNOVA_PREVIEW_WEBP,
        SimId::Pulsar => PULSAR_PREVIEW_WEBP,
        SimId::Starflight => STARFLIGHT_PREVIEW_WEBP,
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
}

impl PreviewTextureCache {
    pub fn get_or_load(&mut self, ctx: &Context, id: SimId) -> &TextureHandle {
        self.textures.entry(id).or_insert_with(|| {
            let color_image = decode_preview_color_image(id);
            ctx.load_texture(
                format!("home_preview_{}", id.cli_name()),
                color_image,
                TextureOptions::LINEAR,
            )
        })
    }
}
