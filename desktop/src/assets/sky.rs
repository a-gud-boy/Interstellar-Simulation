use std::f64::consts::PI;
use std::sync::OnceLock;

pub const MILKYWAY_4K_JPEG: &[u8] = include_bytes!("../../../shared/assets/milkyway_4k.jpg");

#[derive(Clone)]
pub struct RgbaImageData {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

const SRGB_LUT_SIZE: usize = 4096;

fn srgb_lut() -> &'static [u8] {
    static LUT: OnceLock<Vec<u8>> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut lut = vec![0u8; SRGB_LUT_SIZE + 1];
        for (i, item) in lut.iter_mut().enumerate() {
            let c = i as f64 / SRGB_LUT_SIZE as f64;
            let srgb = if c <= 0.0031308 {
                12.92 * c
            } else {
                1.055 * c.powf(1.0 / 2.4) - 0.055
            };
            *item = (srgb * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        lut
    })
}

#[inline]
fn linear_to_srgb_byte(c: f64, lut: &[u8]) -> u8 {
    if c <= 0.0 {
        return 0;
    }
    if c >= 1.0 {
        return 255;
    }
    let idx = ((c * SRGB_LUT_SIZE as f64 + 0.5) as usize).min(SRGB_LUT_SIZE);
    lut[idx]
}

struct Mulberry32(u32);

impl Mulberry32 {
    #[inline]
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

#[inline]
fn hash3(ix: i32, iy: i32, iz: i32) -> f64 {
    let mut h = ix
        .wrapping_mul(374_761_393)
        .wrapping_add(iy.wrapping_mul(668_265_263))
        .wrapping_add(iz.wrapping_mul(2_147_483_647));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    ((h as u32) as f64) * 2.3283064365386963e-10
}

#[inline]
fn smoothstep01(t: f64) -> f64 {
    if t <= 0.0 {
        0.0
    } else if t >= 1.0 {
        1.0
    } else {
        t * t * (3.0 - 2.0 * t)
    }
}

#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn value_noise_3d(x: f64, y: f64, z: f64) -> f64 {
    let ix_f = x.floor();
    let iy_f = y.floor();
    let iz_f = z.floor();
    let ix = ix_f as i32;
    let iy = iy_f as i32;
    let iz = iz_f as i32;
    let tx = x - ix_f;
    let ty = y - iy_f;
    let tz = z - iz_f;
    let fx = tx * tx * (3.0 - 2.0 * tx);
    let fy = ty * ty * (3.0 - 2.0 * ty);
    let fz = tz * tz * (3.0 - 2.0 * tz);

    let c000 = hash3(ix, iy, iz);
    let c100 = hash3(ix + 1, iy, iz);
    let c010 = hash3(ix, iy + 1, iz);
    let c110 = hash3(ix + 1, iy + 1, iz);
    let c001 = hash3(ix, iy, iz + 1);
    let c101 = hash3(ix + 1, iy, iz + 1);
    let c011 = hash3(ix, iy + 1, iz + 1);
    let c111 = hash3(ix + 1, iy + 1, iz + 1);

    let x00 = c000 + (c100 - c000) * fx;
    let x10 = c010 + (c110 - c010) * fx;
    let x01 = c001 + (c101 - c001) * fx;
    let x11 = c011 + (c111 - c011) * fx;

    let y0 = x00 + (x10 - x00) * fy;
    let y1 = x01 + (x11 - x01) * fy;
    y0 + (y1 - y0) * fz
}

fn fbm_3d(x: f64, y: f64, z: f64, octaves: usize) -> f64 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut norm = 0.0;
    for _ in 0..octaves {
        sum += amp * value_noise_3d(x * freq, y * freq, z * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.07;
    }
    sum / norm
}

fn spectral_temp_to_linear_rgb(temp_k: f64) -> [f64; 3] {
    let t = temp_k / 100.0;
    let (r, g, b) = if t <= 66.0 {
        (
            1.0,
            0.390081578769 * t.max(1.0).ln() - 0.631841443788,
            if t <= 19.0 {
                0.0
            } else {
                0.54320678911 * (t - 10.0).ln() - 1.19625408914
            },
        )
    } else {
        (
            1.29293618606 * (t - 60.0).powf(-0.1332047592),
            1.1298908609 * (t - 60.0).powf(-0.0755148492),
            1.0,
        )
    };

    let to_lin = |v: f64| {
        let c = v.clamp(0.0, 1.0);
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let lr = to_lin(r);
    let lg = to_lin(g);
    let lb = to_lin(b);
    let peak = lr.max(lg).max(lb).max(1e-6);
    [lr / peak, lg / peak, lb / peak]
}

fn sample_spectral_temperature(rand: &mut Mulberry32, warm_bias: bool) -> f64 {
    let u = rand.next_f64();
    if warm_bias {
        if u < 0.08 {
            return 16000.0 + rand.next_f64() * 14000.0;
        }
        if u < 0.25 {
            return 7500.0 + rand.next_f64() * 4500.0;
        }
        if u < 0.62 {
            return 4600.0 + rand.next_f64() * 2400.0;
        }
        return 2800.0 + rand.next_f64() * 1600.0;
    }
    if u < 0.06 {
        return 18000.0 + rand.next_f64() * 17000.0;
    }
    if u < 0.22 {
        return 7800.0 + rand.next_f64() * 5200.0;
    }
    if u < 0.48 {
        return 5400.0 + rand.next_f64() * 2400.0;
    }
    if u < 0.78 {
        return 3800.0 + rand.next_f64() * 1600.0;
    }
    2600.0 + rand.next_f64() * 1200.0
}

#[allow(clippy::too_many_arguments)]
fn splat_star_on_equirect(
    accum: &mut [f32],
    width: usize,
    height: usize,
    dx: f64,
    dy: f64,
    dz: f64,
    brightness: f64,
    sr: f64,
    sg: f64,
    sb: f64,
) {
    let theta = dy.clamp(-1.0, 1.0).acos();
    let raw_sin = theta.sin();
    let pole_fade = smoothstep01((raw_sin - 0.06) * 8.0);
    if pole_fade <= 0.01 {
        return;
    }
    let sin_theta = raw_sin.max(0.06);

    let mut phi = dz.atan2(dx);
    if phi < 0.0 {
        phi += 2.0 * PI;
    }

    let fx = (phi / (2.0 * PI)) * width as f64;
    let fy = (theta / PI) * height as f64;

    let radius = if brightness > 1.8 { 1.32 } else { 0.72 };
    let ix0 = fx.floor() as isize;
    let iy0 = fy.floor() as isize;
    let span_y: isize = if radius > 1.0 { 2 } else { 1 };
    let span_x: isize = (((span_y as f64) / sin_theta).ceil() as isize).min(10);
    let inv_sigma2 = 1.0 / (radius * radius * 0.5);

    for oy in -span_y..=span_y {
        let py = iy0 + oy;
        if py < 0 || py >= height as isize {
            continue;
        }
        let ddy = py as f64 + 0.5 - fy;

        for ox in -span_x..=span_x {
            let px = (ix0 + ox).rem_euclid(width as isize) as usize;
            let ddx = ((ix0 + ox) as f64 + 0.5 - fx) * sin_theta;
            let dist2 = ddx * ddx + ddy * ddy;
            let w = (-dist2 * inv_sigma2).exp();
            if w < 0.01 {
                continue;
            }

            let contrib = brightness * pole_fade * w;
            let idx = (py as usize * width + px) * 3;
            accum[idx] += (sr * contrib) as f32;
            accum[idx + 1] += (sg * contrib) as f32;
            accum[idx + 2] += (sb * contrib) as f32;
        }
    }
}

fn encode_accum_to_rgba8(accum: &[f32], total_pixels: usize, shoulder: f64) -> Vec<u8> {
    let lut = srgb_lut();
    let mut pixels = vec![0u8; total_pixels * 4];
    for i in 0..total_pixels {
        let r = accum[i * 3] as f64;
        let g = accum[i * 3 + 1] as f64;
        let b = accum[i * 3 + 2] as f64;
        pixels[i * 4] = linear_to_srgb_byte(r / (1.0 + r * shoulder), lut);
        pixels[i * 4 + 1] = linear_to_srgb_byte(g / (1.0 + g * shoulder), lut);
        pixels[i * 4 + 2] = linear_to_srgb_byte(b / (1.0 + b * shoulder), lut);
        pixels[i * 4 + 3] = 255;
    }
    pixels
}

pub fn get_procedural_sky_a() -> &'static RgbaImageData {
    static SKY_A: OnceLock<RgbaImageData> = OnceLock::new();
    SKY_A.get_or_init(|| synthesize_procedural_sky_a(2048, 1024))
}

pub fn get_exotic_nebula_b() -> &'static RgbaImageData {
    static SKY_B: OnceLock<RgbaImageData> = OnceLock::new();
    SKY_B.get_or_init(|| synthesize_exotic_nebula_b(2048, 1024))
}

pub fn get_real_milkyway_4k() -> &'static RgbaImageData {
    static REAL_SKY: OnceLock<RgbaImageData> = OnceLock::new();
    REAL_SKY.get_or_init(|| {
        let img = image::load_from_memory_with_format(MILKYWAY_4K_JPEG, image::ImageFormat::Jpeg)
            .expect("Embedded milkyway_4k.jpg must decode")
            .to_rgba8();
        let (width, height) = img.dimensions();
        RgbaImageData {
            width,
            height,
            pixels: img.into_raw(),
        }
    })
}

pub fn synthesize_procedural_sky_a(width: usize, height: usize) -> RgbaImageData {
    let total_pixels = width * height;
    let mut accum = vec![0.0_f32; total_pixels * 3];

    let tilt = (60.0 * PI) / 180.0;
    let cos_tilt = tilt.cos();
    let sin_tilt = tilt.sin();
    let yaw = 0.55_f64;
    let cos_yaw = yaw.cos();
    let sin_yaw = yaw.sin();

    let mut cos_phi = vec![0.0_f64; width];
    let mut sin_phi = vec![0.0_f64; width];
    for x in 0..width {
        let phi = ((x as f64 + 0.5) / width as f64) * 2.0 * PI;
        cos_phi[x] = phi.cos();
        sin_phi[x] = phi.sin();
    }

    for y in 0..height {
        let theta = ((y as f64 + 0.5) / height as f64) * PI;
        let sin_theta = theta.sin();
        let cos_theta = theta.cos();
        let row_off = y * width;

        for x in 0..width {
            let dx = sin_theta * cos_phi[x];
            let dy = cos_theta;
            let dz = sin_theta * sin_phi[x];

            let rx = dx * cos_yaw - dz * sin_yaw;
            let rz = dx * sin_yaw + dz * cos_yaw;
            let gx = rx;
            let gy = dy * cos_tilt - rz * sin_tilt;
            let gz = dy * sin_tilt + rz * cos_tilt;

            let band_dist2 = gy * gy;
            let band_profile = (-band_dist2 * 26.0).exp();
            let wide_glow = (-band_dist2 * 5.2).exp();

            let bulge_dot = gx.max(0.0);
            let bulge = bulge_dot * bulge_dot * bulge_dot * (-band_dist2 * 14.0).exp();

            let cloud_noise = fbm_3d(gx * 3.4 + 4.1, gy * 5.5 - 1.7, gz * 3.4 + 2.3, 4);
            let fine_cloud = fbm_3d(gx * 9.5 - 2.2, gy * 12.0 + 3.8, gz * 9.5 + 1.1, 3);
            let dust_fbm = fbm_3d(gx * 7.2 + 11.4, gy * 16.0 - 5.2, gz * 7.2 - 3.6, 4);

            let rift_coord = (gy - (cloud_noise - 0.5) * 0.08) * 18.0;
            let rift_band = (-rift_coord * rift_coord).exp();
            let dust_extinction =
                (1.0 - rift_band * (0.45 + 0.5 * smoothstep01((dust_fbm - 0.35) * 2.2))).max(0.18);

            let base_intensity = (band_profile * (0.045 + 0.095 * cloud_noise * fine_cloud)
                + wide_glow * 0.012 * cloud_noise
                + bulge * (0.09 + 0.08 * fine_cloud))
                * dust_extinction;

            let core_warmth = (bulge * 1.4 + 0.15).min(1.0);
            let neb_cool = (fine_cloud - 0.55).max(0.0) * band_profile * 0.045;
            let neb_warm = (cloud_noise - 0.58).max(0.0) * bulge * 0.05;

            let idx = (row_off + x) * 3;
            accum[idx] = (0.0008
                + base_intensity * lerp(0.72, 1.18, core_warmth)
                + neb_warm * 1.1
                + neb_cool * 0.35) as f32;
            accum[idx + 1] = (0.0010
                + base_intensity * lerp(0.84, 0.96, core_warmth)
                + neb_warm * 0.55
                + neb_cool * 0.65) as f32;
            accum[idx + 2] = (0.0016
                + base_intensity * lerp(1.12, 0.72, core_warmth)
                + neb_warm * 0.25
                + neb_cool * 1.25) as f32;
        }
    }

    let mut rand = Mulberry32(0x5a7a_9c31);
    let star_count = (total_pixels as f64 * 0.012).round() as usize;

    for _ in 0..star_count {
        let (gx, gy, gz) = if rand.next_f64() < 0.55 {
            let lon = rand.next_f64() * 2.0 * PI;
            let u1 = rand.next_f64().max(1e-6);
            let u2 = rand.next_f64();
            let lat = (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos() * 0.16;
            let clamped_lat = lat.clamp(-PI * 0.49, PI * 0.49);
            let cos_lat = clamped_lat.cos();
            (cos_lat * lon.cos(), clamped_lat.sin(), cos_lat * lon.sin())
        } else {
            let z = rand.next_f64() * 2.0 - 1.0;
            let lon = rand.next_f64() * 2.0 * PI;
            let rxy = (1.0 - z * z).max(0.0).sqrt();
            (rxy * lon.cos(), z, rxy * lon.sin())
        };

        let ry = gy * cos_tilt + gz * sin_tilt;
        let rz = -gy * sin_tilt + gz * cos_tilt;
        let dx = gx * cos_yaw + rz * sin_yaw;
        let dy = ry;
        let dz = -gx * sin_yaw + rz * cos_yaw;

        let p = rand.next_f64().max(1e-5);
        let clamped_brightness = (0.04 * p.powf(-0.78)).min(8.5);
        let [sr, sg, sb] =
            spectral_temp_to_linear_rgb(sample_spectral_temperature(&mut rand, false));
        splat_star_on_equirect(
            &mut accum,
            width,
            height,
            dx,
            dy,
            dz,
            clamped_brightness,
            sr,
            sg,
            sb,
        );
    }

    RgbaImageData {
        width: width as u32,
        height: height as u32,
        pixels: encode_accum_to_rgba8(&accum, total_pixels, 0.35),
    }
}

pub fn synthesize_exotic_nebula_b(width: usize, height: usize) -> RgbaImageData {
    let total_pixels = width * height;
    let mut accum = vec![0.0_f32; total_pixels * 3];

    let f_len = (-0.886_f64).hypot(-0.171_f64).hypot(-0.430_f64);
    let fx = -0.886 / f_len;
    let fy = -0.171 / f_len;
    let fz = -0.430 / f_len;

    let up_ref_x = 0.36;
    let up_ref_y = 0.88;
    let up_ref_z = -0.31;
    let mut rx = up_ref_y * fz - up_ref_z * fy;
    let mut ry = up_ref_z * fx - up_ref_x * fz;
    let mut rz = up_ref_x * fy - up_ref_y * fx;
    let r_len = rx.hypot(ry).hypot(rz);
    rx /= r_len;
    ry /= r_len;
    rz /= r_len;

    let ux = fy * rz - fz * ry;
    let uy = fz * rx - fx * rz;
    let uz = fx * ry - fy * rx;

    let mut cos_phi = vec![0.0_f64; width];
    let mut sin_phi = vec![0.0_f64; width];
    for x in 0..width {
        let phi = ((x as f64 + 0.5) / width as f64) * 2.0 * PI;
        cos_phi[x] = phi.cos();
        sin_phi[x] = phi.sin();
    }

    for y in 0..height {
        let theta = ((y as f64 + 0.5) / height as f64) * PI;
        let sin_theta = theta.sin();
        let cos_theta = theta.cos();
        let row_off = y * width;

        for x in 0..width {
            let dx = sin_theta * cos_phi[x];
            let dy = cos_theta;
            let dz = sin_theta * sin_phi[x];

            let nx = dx * rx + dy * ry + dz * rz;
            let ny = dx * ux + dy * uy + dz * uz;
            let nz = dx * fx + dy * fy + dz * fz;

            let warp_a = fbm_3d(nx * 2.8 + 1.3, ny * 2.8 - 0.8, nz * 2.8 + 3.1, 3) - 0.5;
            let wx = nx + warp_a * 0.48;
            let wy = ny - warp_a * 0.34;
            let wz = nz + warp_a * 0.28;

            let cloud_base = fbm_3d(wx * 3.4 + 7.2, wy * 4.2 - 2.4, wz * 3.4 + 5.6, 4);
            let fine_fbm = fbm_3d(wx * 9.8 - 3.3, wy * 11.4 + 4.9, wz * 9.8 + 2.1, 3);

            let raw_ridge = 1.0 - (fine_fbm * 2.0 - 1.0).abs();
            let ridge = raw_ridge * raw_ridge * raw_ridge;

            let band_dist = ny + warp_a * 0.24;
            let band_env = (-band_dist * band_dist * 16.0).exp();
            let wide_teal_halo = (-band_dist * band_dist * 4.2).exp();

            let heart_dot = (nz * 0.84 + 0.16).max(0.0);
            let heart_focus = heart_dot * heart_dot * heart_dot * (0.28 + 0.72 * band_env);

            let pillar_field = cloud_base * 0.52 + fine_fbm * 0.48;
            let pillar_core = smoothstep01((pillar_field - 0.54) * 5.0) * (0.25 + 0.75 * band_env);
            let dust_transmit = 1.0 - pillar_core * 0.90;
            let pillar_rim = smoothstep01((pillar_field - 0.48) * 11.0)
                * (1.0 - smoothstep01((pillar_field - 0.57) * 9.0))
                * band_env;

            let ion_balance = smoothstep01((cloud_base - 0.44) * 4.2);

            let gold_core = heart_focus * (0.14 + 0.78 * ion_balance)
                + band_env * ridge * (0.18 + 0.44 * ion_balance);
            let gold_weight = gold_core * dust_transmit + pillar_rim * 0.56;

            let teal_pockets = (1.0 - ion_balance * 0.75) * smoothstep01((fine_fbm - 0.30) * 2.8);
            let teal_weight = (wide_teal_halo * 0.055 * (0.4 + 0.6 * teal_pockets)
                + band_env * (0.16 * teal_pockets + 0.34 * ridge * (1.0 - ion_balance * 0.6)))
                * (0.22 + 0.78 * dust_transmit);

            let mut r = 0.0007 + gold_weight * 1.15 + teal_weight * 0.025;
            let mut g = 0.0016 + gold_weight * 0.46 + teal_weight * 0.52;
            let mut b = 0.0032 + gold_weight * 0.05 + teal_weight * 0.68;

            let core_spark = (cloud_base - 0.58).max(0.0) * heart_focus * dust_transmit;
            r += core_spark * 0.95;
            g += core_spark * 0.58;
            b += core_spark * 0.18;

            let idx = (row_off + x) * 3;
            accum[idx] = r as f32;
            accum[idx + 1] = g as f32;
            accum[idx + 2] = b as f32;
        }
    }

    let mut rand = Mulberry32(0x9b3e_7c41);
    let star_count = (total_pixels as f64 * 0.015).round() as usize;

    for _ in 0..star_count {
        let mode = rand.next_f64();
        let (lx, ly, lz) = if mode < 0.22 {
            let spread = 0.36;
            let tx = (rand.next_f64() * 2.0 - 1.0) * spread;
            let ty = (rand.next_f64() * 2.0 - 1.0) * spread * 0.65;
            let tz = 1.0;
            let inv = 1.0 / tx.hypot(ty).hypot(tz);
            (tx * inv, ty * inv, tz * inv)
        } else if mode < 0.66 {
            let lon = rand.next_f64() * 2.0 * PI;
            let u1 = rand.next_f64().max(1e-6);
            let u2 = rand.next_f64();
            let lat = (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos() * 0.20;
            let clamped_lat = lat.clamp(-PI * 0.49, PI * 0.49);
            let cos_lat = clamped_lat.cos();
            (cos_lat * lon.cos(), clamped_lat.sin(), cos_lat * lon.sin())
        } else {
            let z = rand.next_f64() * 2.0 - 1.0;
            let lon = rand.next_f64() * 2.0 * PI;
            let rxy = (1.0 - z * z).max(0.0).sqrt();
            (rxy * lon.cos(), z, rxy * lon.sin())
        };

        let dx = lx * rx + ly * ux + lz * fx;
        let dy = lx * ry + ly * uy + lz * fy;
        let dz = lx * rz + ly * uz + lz * fz;

        let p = rand.next_f64().max(1e-5);
        let clamped_brightness = (0.055 * p.powf(-0.78)).min(10.0);
        let [sr, sg, sb] =
            spectral_temp_to_linear_rgb(sample_spectral_temperature(&mut rand, true));
        splat_star_on_equirect(
            &mut accum,
            width,
            height,
            dx,
            dy,
            dz,
            clamped_brightness,
            sr,
            sg,
            sb,
        );
    }

    RgbaImageData {
        width: width as u32,
        height: height as u32,
        pixels: encode_accum_to_rgba8(&accum, total_pixels, 0.42),
    }
}
