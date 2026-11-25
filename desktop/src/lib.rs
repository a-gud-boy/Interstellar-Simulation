pub const APP_VERSION: &str = "0.1.2.1 beta";

pub mod assets;
pub mod renderer;
pub mod sims;
pub mod ui;

pub mod shaders {
    pub const FULLSCREEN_VERT: &str = include_str!("../shaders/fullscreen_vert.wgsl");
    pub const MIPMAP: &str = include_str!("../shaders/mipmap.wgsl");
    pub const NOISE_BAKE: &str = include_str!("../shaders/noise_bake.wgsl");
    pub const POST_TAA: &str = include_str!("../shaders/post_taa.wgsl");
    pub const POST_BLOOM_PREFILTER: &str = include_str!("../shaders/post_bloom_prefilter.wgsl");
    pub const POST_BLOOM_DOWNSAMPLE: &str = include_str!("../shaders/post_bloom_downsample.wgsl");
    pub const POST_BLOOM_UPSAMPLE: &str = include_str!("../shaders/post_bloom_upsample.wgsl");
    pub const POST_ANAMORPHIC: &str = include_str!("../shaders/post_anamorphic.wgsl");
    pub const POST_COMPOSITE: &str = include_str!("../shaders/post_composite.wgsl");
    pub const GLASS_BLUR: &str = include_str!("../shaders/glass_blur.wgsl");
    pub const BLIT: &str = include_str!("../shaders/blit.wgsl");

    pub const BLACKHOLE: &str = include_str!("../shaders/blackhole.wgsl");
    pub const WORMHOLE: &str = include_str!("../shaders/wormhole.wgsl");
    pub const BINARY: &str = include_str!("../shaders/binary.wgsl");
    pub const TIDAL: &str = include_str!("../shaders/tidal.wgsl");
    pub const WARP: &str = include_str!("../shaders/warp.wgsl");
    pub const SUPERNOVA: &str = include_str!("../shaders/supernova.wgsl");
    pub const PULSAR: &str = include_str!("../shaders/pulsar.wgsl");
    pub const STARFLIGHT: &str = include_str!("../shaders/starflight.wgsl");

    pub fn all_named() -> &'static [(&'static str, &'static str)] {
        &[
            ("fullscreen_vert", FULLSCREEN_VERT),
            ("mipmap", MIPMAP),
            ("noise_bake", NOISE_BAKE),
            ("post_taa", POST_TAA),
            ("post_bloom_prefilter", POST_BLOOM_PREFILTER),
            ("post_bloom_downsample", POST_BLOOM_DOWNSAMPLE),
            ("post_bloom_upsample", POST_BLOOM_UPSAMPLE),
            ("post_anamorphic", POST_ANAMORPHIC),
            ("post_composite", POST_COMPOSITE),
            ("glass_blur", GLASS_BLUR),
            ("blit", BLIT),
            ("blackhole", BLACKHOLE),
            ("wormhole", WORMHOLE),
            ("binary", BINARY),
            ("tidal", TIDAL),
            ("warp", WARP),
            ("supernova", SUPERNOVA),
            ("pulsar", PULSAR),
            ("starflight", STARFLIGHT),
        ]
    }
}
