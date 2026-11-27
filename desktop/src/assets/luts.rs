use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const BLACKBODY_T_MIN: f32 = 800.0;
pub const BLACKBODY_T_MAX: f32 = 40000.0;

// Standard CIE 1931 2-degree color matching functions from 380 nm to 780 nm (5 nm step, 81 samples)
const CIE_1931_2DEG_5NM: [[f64; 3]; 81] = [
    [0.001368, 0.000039, 0.006450], // 380
    [0.002236, 0.000064, 0.010550], // 385
    [0.004243, 0.000120, 0.020050], // 390
    [0.007650, 0.000217, 0.036210], // 395
    [0.014310, 0.000396, 0.067850], // 400
    [0.023190, 0.000640, 0.110200], // 405
    [0.043510, 0.001210, 0.207400], // 410
    [0.077630, 0.002180, 0.371300], // 415
    [0.134380, 0.004000, 0.645600], // 420
    [0.214770, 0.007300, 1.039050], // 425
    [0.283900, 0.011600, 1.385600], // 430
    [0.328500, 0.016840, 1.622960], // 435
    [0.348280, 0.023000, 1.747060], // 440
    [0.348060, 0.029800, 1.782600], // 445
    [0.336200, 0.038000, 1.772110], // 450
    [0.318700, 0.048000, 1.744100], // 455
    [0.290800, 0.060000, 1.669200], // 460
    [0.251100, 0.073900, 1.528100], // 465
    [0.195360, 0.090980, 1.287640], // 470
    [0.142100, 0.112600, 1.041900], // 475
    [0.095640, 0.139020, 0.812950], // 480
    [0.057950, 0.169300, 0.616200], // 485
    [0.032010, 0.208020, 0.465180], // 490
    [0.014700, 0.258600, 0.353300], // 495
    [0.004900, 0.323000, 0.272000], // 500
    [0.002400, 0.407300, 0.212300], // 505
    [0.009300, 0.503000, 0.158200], // 510
    [0.029100, 0.608200, 0.111700], // 515
    [0.063270, 0.710000, 0.078250], // 520
    [0.109600, 0.793200, 0.057250], // 525
    [0.165500, 0.862000, 0.042160], // 530
    [0.225750, 0.914850, 0.029840], // 535
    [0.290400, 0.954000, 0.020300], // 540
    [0.359700, 0.980300, 0.013400], // 545
    [0.433450, 0.994950, 0.008750], // 550
    [0.512050, 1.000000, 0.005750], // 555
    [0.594500, 0.995000, 0.003900], // 560
    [0.678400, 0.978600, 0.002750], // 565
    [0.762100, 0.952000, 0.002100], // 570
    [0.842500, 0.915400, 0.001800], // 575
    [0.916300, 0.870000, 0.001650], // 580
    [0.978600, 0.816300, 0.001400], // 585
    [1.026300, 0.757000, 0.001100], // 590
    [1.056700, 0.694900, 0.001000], // 595
    [1.062200, 0.631000, 0.000800], // 600
    [1.045600, 0.566800, 0.000600], // 605
    [1.002600, 0.503000, 0.000340], // 610
    [0.938400, 0.441200, 0.000240], // 615
    [0.854450, 0.381000, 0.000190], // 620
    [0.751400, 0.321000, 0.000100], // 625
    [0.642400, 0.265000, 0.000050], // 630
    [0.541900, 0.217000, 0.000030], // 635
    [0.447900, 0.175000, 0.000020], // 640
    [0.360800, 0.138200, 0.000010], // 645
    [0.283500, 0.107000, 0.000000], // 650
    [0.218700, 0.081600, 0.000000], // 655
    [0.164900, 0.061000, 0.000000], // 660
    [0.121200, 0.044580, 0.000000], // 665
    [0.087400, 0.032000, 0.000000], // 670
    [0.063600, 0.023200, 0.000000], // 675
    [0.046770, 0.017000, 0.000000], // 680
    [0.032900, 0.011920, 0.000000], // 685
    [0.022700, 0.008210, 0.000000], // 690
    [0.015840, 0.005723, 0.000000], // 695
    [0.011359, 0.004102, 0.000000], // 700
    [0.008111, 0.002929, 0.000000], // 705
    [0.005790, 0.002091, 0.000000], // 710
    [0.004109, 0.001484, 0.000000], // 715
    [0.002899, 0.001047, 0.000000], // 720
    [0.002049, 0.000740, 0.000000], // 725
    [0.001440, 0.000520, 0.000000], // 730
    [0.001000, 0.000361, 0.000000], // 735
    [0.000690, 0.000249, 0.000000], // 740
    [0.000476, 0.000172, 0.000000], // 745
    [0.000332, 0.000120, 0.000000], // 750
    [0.000235, 0.000085, 0.000000], // 755
    [0.000166, 0.000060, 0.000000], // 760
    [0.000117, 0.000042, 0.000000], // 765
    [0.000083, 0.000030, 0.000000], // 770
    [0.000059, 0.000021, 0.000000], // 775
    [0.000042, 0.000015, 0.000000], // 780
];

const PLANCK_H: f64 = 6.62607015e-34;
const SPEED_OF_LIGHT: f64 = 2.99792458e8;
const BOLTZMANN_K: f64 = 1.380649e-23;
const C1: f64 = 2.0 * PLANCK_H * SPEED_OF_LIGHT * SPEED_OF_LIGHT;
const C2: f64 = (PLANCK_H * SPEED_OF_LIGHT) / BOLTZMANN_K;

pub fn f32_to_f16_bits(value: f32) -> u16 {
    let x = value.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let mut mantissa = x & 0x007f_ffff;
    let exp = (x >> 23) & 0xff;

    if exp == 0xff {
        return sign | 0x7c00 | if mantissa != 0 { 0x0200 } else { 0 };
    }

    let half_exp = exp as i32 - 127 + 15;
    if half_exp >= 31 {
        return sign | 0x7c00;
    }
    if half_exp <= 0 {
        if half_exp < -10 {
            return sign;
        }
        mantissa = (mantissa | 0x0080_0000) >> (1 - half_exp);
        return sign | (((mantissa + 0x1000) >> 13) as u16);
    }

    sign | ((half_exp as u16) << 10) | (((mantissa + 0x1000) >> 13) as u16)
}

pub fn compute_blackbody_linear_rgb(temperature_k: f64) -> [f32; 3] {
    let mut x = 0.0_f64;
    let mut y = 0.0_f64;
    let mut z = 0.0_f64;

    for (i, &[xb, yb, zb]) in CIE_1931_2DEG_5NM.iter().enumerate() {
        let lambda_m = (380.0 + (i as f64) * 5.0) * 1e-9;
        let exponent = C2 / (lambda_m * temperature_k);
        let radiance = if exponent > 700.0 {
            0.0
        } else {
            C1 / (lambda_m.powi(5) * exponent.exp_m1())
        };
        x += radiance * xb;
        y += radiance * yb;
        z += radiance * zb;
    }

    let mut r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let mut g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let mut b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

    r = r.max(0.0);
    g = g.max(0.0);
    b = b.max(0.0);

    let peak = r.max(g).max(b).max(1e-12);
    [(r / peak) as f32, (g / peak) as f32, (b / peak) as f32]
}

pub struct BlackbodyLutData {
    pub half_data: Vec<u16>,
    pub byte_data: Vec<u8>,
}

pub fn generate_blackbody_data(size: usize) -> BlackbodyLutData {
    let t_min = BLACKBODY_T_MIN as f64;
    let t_max = BLACKBODY_T_MAX as f64;
    let log_ratio = (t_max / t_min).ln();

    let mut half_data = vec![0u16; size * 4];
    let mut byte_data = vec![0u8; size * 4];
    let one_half = f32_to_f16_bits(1.0);

    for i in 0..size {
        let u = if size > 1 {
            i as f64 / (size - 1) as f64
        } else {
            0.0
        };
        let temp_k = t_min * (u * log_ratio).exp();
        let [r, g, b] = compute_blackbody_linear_rgb(temp_k);

        let base = i * 4;
        half_data[base] = f32_to_f16_bits(r);
        half_data[base + 1] = f32_to_f16_bits(g);
        half_data[base + 2] = f32_to_f16_bits(b);
        half_data[base + 3] = one_half;

        byte_data[base] = (r * 255.0).round() as u8;
        byte_data[base + 1] = (g * 255.0).round() as u8;
        byte_data[base + 2] = (b * 255.0).round() as u8;
        byte_data[base + 3] = 255;
    }

    BlackbodyLutData {
        half_data,
        byte_data,
    }
}

pub fn get_blackbody_data(size: usize) -> &'static BlackbodyLutData {
    static CACHE: OnceLock<Mutex<HashMap<usize, &'static BlackbodyLutData>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if let Some(&entry) = guard.get(&size) {
        return entry;
    }
    let leaked: &'static BlackbodyLutData = Box::leak(Box::new(generate_blackbody_data(size)));
    guard.insert(size, leaked);
    leaked
}

struct Mulberry32(u32);

impl Mulberry32 {
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

fn generate_blue_noise_channel(size: usize, seed: u32) -> Vec<u8> {
    let n = size;
    let total = n * n;
    let sigma = 1.5_f64;
    let radius: isize = 5;
    let k_dim = (radius * 2 + 1) as usize;
    let mut kernel = vec![0.0_f64; k_dim * k_dim];
    let inv_two_sigma2 = 1.0 / (2.0 * sigma * sigma);

    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let idx = ((dy + radius) as usize) * k_dim + ((dx + radius) as usize);
            kernel[idx] = (-((dx * dx + dy * dy) as f64) * inv_two_sigma2).exp();
        }
    }

    let mut rand = Mulberry32(seed);
    let initial_count = ((total as f64) * 0.1).floor().max(1.0) as usize;
    let mut binary = vec![0u8; total];
    let mut energy = vec![0.0_f64; total];

    let mut placed = 0;
    while placed < initial_count {
        let idx = (rand.next_f64() * (total as f64)).floor() as usize % total;
        if binary[idx] == 0 {
            binary[idx] = 1;
            placed += 1;
        }
    }

    let splat = |idx: usize, sign: f64, energy: &mut [f64]| {
        let cx = (idx % n) as isize;
        let cy = (idx / n) as isize;
        for dy in -radius..=radius {
            let y = (cy + dy).rem_euclid(n as isize) as usize;
            let row_off = y * n;
            let k_row = ((dy + radius) as usize) * k_dim;
            for dx in -radius..=radius {
                let x = (cx + dx).rem_euclid(n as isize) as usize;
                energy[row_off + x] += sign * kernel[k_row + ((dx + radius) as usize)];
            }
        }
    };

    for (i, &b) in binary.iter().enumerate() {
        if b != 0 {
            splat(i, 1.0, &mut energy);
        }
    }

    let mut row_max_val = vec![0.0_f64; n];
    let mut row_max_idx = vec![0_usize; n];
    let mut row_min_val = vec![0.0_f64; n];
    let mut row_min_idx = vec![0_usize; n];

    let update_row = |y: usize,
                      binary: &[u8],
                      energy: &[f64],
                      row_max_val: &mut [f64],
                      row_max_idx: &mut [usize],
                      row_min_val: &mut [f64],
                      row_min_idx: &mut [usize]| {
        let row_off = y * n;
        let mut max_v = -1e30_f64;
        let mut max_i = 0_usize;
        let mut min_v = 1e30_f64;
        let mut min_i = 0_usize;
        for x in 0..n {
            let idx = row_off + x;
            let e = energy[idx];
            if binary[idx] != 0 {
                if e > max_v {
                    max_v = e;
                    max_i = idx;
                }
            } else if e < min_v {
                min_v = e;
                min_i = idx;
            }
        }
        row_max_val[y] = max_v;
        row_max_idx[y] = max_i;
        row_min_val[y] = min_v;
        row_min_idx[y] = min_i;
    };

    let update_all_rows = |binary: &[u8],
                           energy: &[f64],
                           row_max_val: &mut [f64],
                           row_max_idx: &mut [usize],
                           row_min_val: &mut [f64],
                           row_min_idx: &mut [usize]| {
        for y in 0..n {
            update_row(
                y,
                binary,
                energy,
                row_max_val,
                row_max_idx,
                row_min_val,
                row_min_idx,
            );
        }
    };

    let update_rows_around = |idx: usize,
                              binary: &[u8],
                              energy: &[f64],
                              row_max_val: &mut [f64],
                              row_max_idx: &mut [usize],
                              row_min_val: &mut [f64],
                              row_min_idx: &mut [usize]| {
        let cy = (idx / n) as isize;
        for dy in -radius..=radius {
            let y = (cy + dy).rem_euclid(n as isize) as usize;
            update_row(
                y,
                binary,
                energy,
                row_max_val,
                row_max_idx,
                row_min_val,
                row_min_idx,
            );
        }
    };

    let find_tightest_cluster = |row_max_val: &[f64], row_max_idx: &[usize]| -> usize {
        let mut best_v = -1e30_f64;
        let mut best_i = 0_usize;
        for y in 0..n {
            if row_max_val[y] > best_v {
                best_v = row_max_val[y];
                best_i = row_max_idx[y];
            }
        }
        best_i
    };

    let find_largest_void = |row_min_val: &[f64], row_min_idx: &[usize]| -> usize {
        let mut best_v = 1e30_f64;
        let mut best_i = 0_usize;
        for y in 0..n {
            if row_min_val[y] < best_v {
                best_v = row_min_val[y];
                best_i = row_min_idx[y];
            }
        }
        best_i
    };

    update_all_rows(
        &binary,
        &energy,
        &mut row_max_val,
        &mut row_max_idx,
        &mut row_min_val,
        &mut row_min_idx,
    );

    for _ in 0..(initial_count * 2) {
        let cluster_idx = find_tightest_cluster(&row_max_val, &row_max_idx);
        binary[cluster_idx] = 0;
        splat(cluster_idx, -1.0, &mut energy);
        update_rows_around(
            cluster_idx,
            &binary,
            &energy,
            &mut row_max_val,
            &mut row_max_idx,
            &mut row_min_val,
            &mut row_min_idx,
        );

        let void_idx = find_largest_void(&row_min_val, &row_min_idx);
        if void_idx == cluster_idx {
            binary[cluster_idx] = 1;
            splat(cluster_idx, 1.0, &mut energy);
            update_rows_around(
                cluster_idx,
                &binary,
                &energy,
                &mut row_max_val,
                &mut row_max_idx,
                &mut row_min_val,
                &mut row_min_idx,
            );
            break;
        }
        binary[void_idx] = 1;
        splat(void_idx, 1.0, &mut energy);
        update_rows_around(
            void_idx,
            &binary,
            &energy,
            &mut row_max_val,
            &mut row_max_idx,
            &mut row_min_val,
            &mut row_min_idx,
        );
    }

    let initial_binary = binary.clone();
    let initial_energy = energy.clone();
    let mut ranks = vec![0_usize; total];

    for rank in (0..initial_count).rev() {
        let cluster_idx = find_tightest_cluster(&row_max_val, &row_max_idx);
        ranks[cluster_idx] = rank;
        binary[cluster_idx] = 0;
        splat(cluster_idx, -1.0, &mut energy);
        update_rows_around(
            cluster_idx,
            &binary,
            &energy,
            &mut row_max_val,
            &mut row_max_idx,
            &mut row_min_val,
            &mut row_min_idx,
        );
    }

    binary.copy_from_slice(&initial_binary);
    energy.copy_from_slice(&initial_energy);
    update_all_rows(
        &binary,
        &energy,
        &mut row_max_val,
        &mut row_max_idx,
        &mut row_min_val,
        &mut row_min_idx,
    );

    let half = total >> 1;
    for rank in initial_count..half {
        let void_idx = find_largest_void(&row_min_val, &row_min_idx);
        ranks[void_idx] = rank;
        binary[void_idx] = 1;
        splat(void_idx, 1.0, &mut energy);
        update_rows_around(
            void_idx,
            &binary,
            &energy,
            &mut row_max_val,
            &mut row_max_idx,
            &mut row_min_val,
            &mut row_min_idx,
        );
    }

    for b in &mut binary {
        *b = if *b != 0 { 0 } else { 1 };
    }
    energy.fill(0.0);
    for (i, &b) in binary.iter().enumerate() {
        if b != 0 {
            splat(i, 1.0, &mut energy);
        }
    }
    update_all_rows(
        &binary,
        &energy,
        &mut row_max_val,
        &mut row_max_idx,
        &mut row_min_val,
        &mut row_min_idx,
    );
    for rank in half..total {
        let cluster_idx = find_tightest_cluster(&row_max_val, &row_max_idx);
        ranks[cluster_idx] = rank;
        binary[cluster_idx] = 0;
        splat(cluster_idx, -1.0, &mut energy);
        update_rows_around(
            cluster_idx,
            &binary,
            &energy,
            &mut row_max_val,
            &mut row_max_idx,
            &mut row_min_val,
            &mut row_min_idx,
        );
    }

    let mut bytes = vec![0u8; total];
    for i in 0..total {
        bytes[i] = ((ranks[i] * 256) / total).min(255) as u8;
    }
    bytes
}

pub fn generate_blue_noise_rgba(size: usize) -> Vec<u8> {
    let total = size * size;
    let (ch0, ch1, ch2, ch3) = std::thread::scope(|s| {
        let h0 = s.spawn(|| generate_blue_noise_channel(size, 0x1357_9bdf));
        let h1 = s.spawn(|| generate_blue_noise_channel(size, 0x2468_ace0));
        let h2 = s.spawn(|| generate_blue_noise_channel(size, 0x9e37_79b9));
        let h3 = s.spawn(|| generate_blue_noise_channel(size, 0xdead_beef));
        (
            h0.join().expect("blue noise thread 0"),
            h1.join().expect("blue noise thread 1"),
            h2.join().expect("blue noise thread 2"),
            h3.join().expect("blue noise thread 3"),
        )
    });

    let mut rgba = vec![0u8; total * 4];
    for i in 0..total {
        let base = i * 4;
        rgba[base] = ch0[i];
        rgba[base + 1] = ch1[i];
        rgba[base + 2] = ch2[i];
        rgba[base + 3] = ch3[i];
    }
    rgba
}

pub fn get_blue_noise_data(size: usize) -> &'static [u8] {
    static CACHE: OnceLock<Mutex<HashMap<usize, &'static [u8]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if let Some(&entry) = guard.get(&size) {
        return entry;
    }

    let leaked: &'static [u8] = Box::leak(generate_blue_noise_rgba(size).into_boxed_slice());
    guard.insert(size, leaked);
    leaked
}

pub fn create_blackbody_lut_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    size: u32,
) -> (wgpu::Texture, wgpu::TextureView) {
    let data = generate_blackbody_data(size as usize);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("blackbody-lut"),
        size: wgpu::Extent3d {
            width: size,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        bytemuck::cast_slice(&data.half_data),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(size * 8),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: size,
            height: 1,
            depth_or_array_layers: 1,
        },
    );

    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

pub fn create_blue_noise_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    size: u32,
) -> (wgpu::Texture, wgpu::TextureView) {
    let rgba = generate_blue_noise_rgba(size as usize);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("blue-noise-lut"),
        size: wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &rgba,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(size * 4),
            rows_per_image: Some(size),
        },
        wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        },
    );

    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}
