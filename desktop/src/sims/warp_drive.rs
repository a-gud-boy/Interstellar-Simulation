use std::f32::consts::PI;

use bytemuck::{Pod, Zeroable};

use crate::renderer::post::{make_fs_pipe, run_fs_pass, PostFrameParams, PostTuning};
use crate::renderer::SharedGpuAssets;
use crate::shaders;
use crate::sims::{
    ease_out_cubic, step_critically_damped, wrap_angle_delta, ControlItem, ControlKind,
    ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation, SpecialActionUi,
    StepOutcome, TelemetryCell,
};

const DEG2RAD: f32 = PI / 180.0;
const INV_16_PI: f64 = 1.0 / (16.0 * std::f64::consts::PI);
const INV_32_PI: f64 = 1.0 / (32.0 * std::f64::consts::PI);
const RAD2DEG_64: f64 = 180.0 / std::f64::consts::PI;

const MIN_RADIUS: f32 = 3.5;
const MAX_RADIUS: f32 = 45.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH: f32 = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 22.0 * DEG2RAD;
const MAX_FOV: f32 = 90.0 * DEG2RAD;
const MIN_BRIDGE_FOV: f32 = 28.0 * DEG2RAD;
const MAX_BRIDGE_FOV: f32 = 90.0 * DEG2RAD;
const BRIDGE_POS: [f32; 3] = [0.0, 0.0, -0.15];

const SPRING_OMEGA: f32 = 13.5;
const FRAME_BLEND_OMEGA: f32 = 9.0;
const AUTO_ORBIT_SPEED: f32 = 0.042;
const AUTO_BREATH_AMP: f32 = 0.009;
const AUTO_BREATH_FREQ: f32 = 0.22;
const INTERACTION_COOLDOWN: f32 = 2.4;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct WarpUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_mode: [f32; 4],
    cam_pos_metric: [f32; 4],
    cam_right_vs: [f32; 4],
    cam_up_r: [f32; 4],
    cam_fwd_sigma: [f32; 4],
    physics_params: [f32; 4],
    sky_params: [f32; 4],
    quality_params: [f32; 4],
}

#[derive(Clone, Copy)]
struct WarpPreset {
    meta: PresetMeta,
    camera_mode: i32,
    metric_type: i32,
    warp_velocity: f32,
    bubble_radius: f32,
    wall_thickness: f32,
    doppler_strength: f32,
    wall_shimmer: f32,
    caustic_glow: f32,
    star_streaks: f32,
    flow_speed: f32,
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    radius: f32,
    azimuth_deg: f32,
    elevation_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
    look_yaw_deg: f32,
    look_pitch_deg: f32,
    auto_orbit: bool,
}

const PRESETS: [WarpPreset; 6] = [
    WarpPreset {
        meta: PresetMeta {
            id: "subluminal",
            full_name: "Subluminal Cruise (0.8c)",
            short_label: "0.8c Cruise",
            hotkey: "1",
        },
        camera_mode: 0,
        metric_type: 0,
        warp_velocity: 0.80,
        bubble_radius: 3.0,
        wall_thickness: 2.2,
        doppler_strength: 1.0,
        wall_shimmer: 0.95,
        caustic_glow: 0.85,
        star_streaks: 0.90,
        flow_speed: 0.85,
        exposure: 1.05,
        bloom: 0.52,
        anamorphic: 0.25,
        sky_intensity: 1.0,
        sky_mode: 0,
        sky_rot: [0.35, 0.14],
        radius: 12.2,
        azimuth_deg: 38.0,
        elevation_deg: 16.0,
        roll_deg: -2.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    WarpPreset {
        meta: PresetMeta {
            id: "light_barrier",
            full_name: "Light Barrier (1.0c)",
            short_label: "1.0c Barrier",
            hotkey: "2",
        },
        camera_mode: 0,
        metric_type: 0,
        warp_velocity: 1.00,
        bubble_radius: 3.0,
        wall_thickness: 2.6,
        doppler_strength: 1.0,
        wall_shimmer: 1.15,
        caustic_glow: 1.25,
        star_streaks: 1.05,
        flow_speed: 1.00,
        exposure: 1.05,
        bloom: 0.58,
        anamorphic: 0.36,
        sky_intensity: 1.0,
        sky_mode: 0,
        sky_rot: [0.35, 0.14],
        radius: 11.0,
        azimuth_deg: 28.0,
        elevation_deg: 11.0,
        roll_deg: -2.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    WarpPreset {
        meta: PresetMeta {
            id: "superluminal",
            full_name: "Superluminal (2.5c)",
            short_label: "2.5c FTL",
            hotkey: "3",
        },
        camera_mode: 0,
        metric_type: 0,
        warp_velocity: 2.50,
        bubble_radius: 3.0,
        wall_thickness: 2.3,
        doppler_strength: 1.0,
        wall_shimmer: 1.25,
        caustic_glow: 1.35,
        star_streaks: 1.25,
        flow_speed: 1.15,
        exposure: 1.05,
        bloom: 0.62,
        anamorphic: 0.48,
        sky_intensity: 1.05,
        sky_mode: 0,
        sky_rot: [0.35, 0.14],
        radius: 11.8,
        azimuth_deg: 34.0,
        elevation_deg: 15.0,
        roll_deg: -3.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    WarpPreset {
        meta: PresetMeta {
            id: "bridge",
            full_name: "Bridge View (Cockpit)",
            short_label: "Bridge",
            hotkey: "4",
        },
        camera_mode: 1,
        metric_type: 0,
        warp_velocity: 2.20,
        bubble_radius: 3.2,
        wall_thickness: 2.2,
        doppler_strength: 1.0,
        wall_shimmer: 0.72,
        caustic_glow: 1.20,
        star_streaks: 0.85,
        flow_speed: 1.05,
        exposure: 1.02,
        bloom: 0.58,
        anamorphic: 0.55,
        sky_intensity: 1.15,
        sky_mode: 0,
        sky_rot: [0.22, 0.10],
        radius: 11.8,
        azimuth_deg: 34.0,
        elevation_deg: 15.0,
        roll_deg: 0.0,
        fov_deg: 60.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: false,
    },
    WarpPreset {
        meta: PresetMeta {
            id: "thin_wall",
            full_name: "Thin-Wall High-Energy",
            short_label: "Thin Wall",
            hotkey: "5",
        },
        camera_mode: 0,
        metric_type: 0,
        warp_velocity: 3.50,
        bubble_radius: 2.8,
        wall_thickness: 5.2,
        doppler_strength: 1.05,
        wall_shimmer: 1.65,
        caustic_glow: 1.45,
        star_streaks: 1.40,
        flow_speed: 1.35,
        exposure: 1.00,
        bloom: 0.66,
        anamorphic: 0.52,
        sky_intensity: 1.0,
        sky_mode: 0,
        sky_rot: [-0.42, 0.18],
        radius: 11.4,
        azimuth_deg: 42.0,
        elevation_deg: 18.0,
        roll_deg: -3.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    WarpPreset {
        meta: PresetMeta {
            id: "natario",
            full_name: "Natário Stealth Bubble",
            short_label: "Natário",
            hotkey: "6",
        },
        camera_mode: 0,
        metric_type: 1,
        warp_velocity: 2.00,
        bubble_radius: 3.2,
        wall_thickness: 2.4,
        doppler_strength: 1.0,
        wall_shimmer: 0.58,
        caustic_glow: 0.78,
        star_streaks: 0.90,
        flow_speed: 1.0,
        exposure: 1.08,
        bloom: 0.48,
        anamorphic: 0.28,
        sky_intensity: 1.10,
        sky_mode: 0,
        sky_rot: [0.68, -0.14],
        radius: 11.6,
        azimuth_deg: 36.0,
        elevation_deg: 14.0,
        roll_deg: -2.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
];

pub fn safe_tanh(u: f64) -> f64 {
    u.clamp(-15.0, 15.0).tanh()
}

pub fn safe_sech2(u: f64) -> f64 {
    if u.abs() > 15.0 {
        0.0
    } else {
        let c = u.cosh();
        1.0 / (c * c)
    }
}

pub struct ShapeEval {
    pub f: f64,
    pub df: f64,
    pub d2f: f64,
    pub df_over_r: f64,
}

pub fn eval_shape(r: f64, big_r: f64, sigma: f64) -> ShapeEval {
    let safe_r = r.max(0.0);
    let safe_bubble_r = big_r.max(0.2);
    let safe_sigma = sigma.max(0.1);
    let sr = safe_sigma * safe_bubble_r;
    let tanh_sr = safe_tanh(sr).max(1e-8);
    let sech2_sr = safe_sech2(sr);

    let u_plus = safe_sigma * (safe_r + safe_bubble_r);
    let u_minus = safe_sigma * (safe_r - safe_bubble_r);
    let th_p = safe_tanh(u_plus);
    let th_m = safe_tanh(u_minus);
    let s2_p = safe_sech2(u_plus);
    let s2_m = safe_sech2(u_minus);

    let f = (th_p - th_m) / (2.0 * tanh_sr);
    let df = (safe_sigma / (2.0 * tanh_sr)) * (s2_p - s2_m);
    let d2f = ((safe_sigma * safe_sigma) / tanh_sr) * (-s2_p * th_p + s2_m * th_m);

    let df_over_r = if safe_r < 1e-3 {
        let f4_0 = 8.0 * safe_sigma.powi(4) * sech2_sr * (3.0 * sech2_sr - 1.0);
        -2.0 * safe_sigma * safe_sigma * sech2_sr + (f4_0 * safe_r * safe_r) / 6.0
    } else {
        df / safe_r
    };

    ShapeEval {
        f,
        df,
        d2f,
        df_over_r,
    }
}

fn eval_lentz_radius(x: f64, y: f64, z: f64, big_r: f64) -> (f64, f64, f64) {
    let p = 1.38;
    let eps = 0.12 * big_r;
    let eps2 = eps * eps;
    let rho2 = x * x + y * y;
    let a = rho2 + eps2;
    let b = z * z + eps2;
    let half_p = 0.5 * p;
    let ap = a.powf(half_p);
    let bp = b.powf(half_p);
    let sum = ap + bp;
    let r_l = sum.powf(1.0 / p);
    let r_l_1mp = r_l.powf(1.0 - p);
    let g_rho = r_l_1mp * a.powf(half_p - 1.0);
    let g_z = r_l_1mp * b.powf(half_p - 1.0);
    (r_l, g_rho, g_z)
}

pub struct WarpMetricEval {
    pub theta: f64,
    pub t00: f64,
}

pub fn eval_warp_metric(
    pos: [f64; 3],
    metric_type: i32,
    big_r: f64,
    sigma: f64,
    vs: f64,
    frame_blend: f64,
) -> WarpMetricEval {
    let (x, y, z) = (pos[0], pos[1], pos[2]);
    let big_r = big_r.clamp(0.2, 20.0);
    let sigma = sigma.clamp(0.1, 20.0);
    let vs = vs.clamp(0.0, 10.0);
    let _shift_z = -(1.0 - frame_blend.clamp(0.0, 1.0)) * vs;

    if metric_type == 1 {
        let r = (x * x + y * y + z * z).sqrt();
        let shape = eval_shape(r, big_r, sigma);
        let h = shape.df_over_r;
        let dh_over_r = if r < 2e-3 {
            let sech2_sr = safe_sech2(sigma * big_r);
            (8.0 / 3.0) * sigma.powi(4) * sech2_sr * (3.0 * sech2_sr - 1.0)
        } else {
            (shape.d2f - h) / (r * r)
        };
        let rho2 = x * x + y * y;
        let half_vs = 0.5 * vs;

        let j00 = half_vs * (dh_over_r * x * x * z + h * z);
        let j01 = half_vs * dh_over_r * x * y * z;
        let j02 = -2.0 * vs * h * x - half_vs * dh_over_r * x * rho2;
        let j10 = half_vs * dh_over_r * x * y * z;
        let j11 = half_vs * (dh_over_r * y * y * z + h * z);
        let j12 = -2.0 * vs * h * y - half_vs * dh_over_r * y * rho2;
        let j20 = half_vs * (dh_over_r * x * z * z + h * x);
        let j21 = half_vs * (dh_over_r * y * z * z + h * y);
        let j22 = -vs * h * z - half_vs * dh_over_r * z * rho2;

        let k00 = j00;
        let k11 = j11;
        let k22 = j22;
        let k01 = 0.5 * (j01 + j10);
        let k02 = 0.5 * (j02 + j20);
        let k12 = 0.5 * (j12 + j21);
        let k_sq_sum = k00 * k00 + k11 * k11 + k22 * k22 + 2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
        return WarpMetricEval {
            theta: 0.0,
            t00: -k_sq_sum * INV_16_PI,
        };
    }

    if metric_type == 2 {
        let (r_l, g_rho, g_z) = eval_lentz_radius(x, y, z, big_r);
        let shape = eval_shape(r_l, big_r, sigma);
        let inv_rl = 1.0 / r_l.max(1e-3);
        let th_arg = (2.0 * z) / big_r;
        let th = safe_tanh(th_arg);
        let s2 = safe_sech2(th_arg);
        let tilt_coeff = -0.28 * vs;
        let q = tilt_coeff * shape.df * th * inv_rl;
        let dq_drl = tilt_coeff * th * (shape.d2f - shape.df * inv_rl) * inv_rl;
        let dq_dx = dq_drl * g_rho * x;
        let dq_dy = dq_drl * g_rho * y;
        let dq_dz = dq_drl * g_z * z + tilt_coeff * shape.df * inv_rl * (2.0 / big_r) * s2;

        let j00 = q + x * dq_dx;
        let j01 = y * dq_dx;
        let j02 = -vs * shape.df * g_rho * x;
        let j10 = x * dq_dy;
        let j11 = q + y * dq_dy;
        let j12 = -vs * shape.df * g_rho * y;
        let j20 = x * dq_dz;
        let j21 = y * dq_dz;
        let j22 = -vs * shape.df * g_z * z;

        let k = j00 + j11 + j22;
        let theta = -k;
        let k00 = j00;
        let k11 = j11;
        let k22 = j22;
        let k01 = 0.5 * (j01 + j10);
        let k02 = 0.5 * (j02 + j20);
        let k12 = 0.5 * (j12 + j21);
        let k_sq_sum = k00 * k00 + k11 * k11 + k22 * k22 + 2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
        return WarpMetricEval {
            theta,
            t00: (k * k - k_sq_sum) * INV_16_PI,
        };
    }

    let r = (x * x + y * y + z * z).sqrt();
    let shape = eval_shape(r, big_r, sigma);
    let theta = vs * z * shape.df_over_r;
    let rho2 = x * x + y * y;
    let t00 = -vs * vs * rho2 * shape.df_over_r * shape.df_over_r * INV_32_PI;
    WarpMetricEval { theta, t00 }
}

pub struct WarpTelemetry {
    pub warp_velocity: f64,
    pub peak_york: f64,
    pub g_forward: f64,
    pub g_aft: f64,
    pub has_horizon: bool,
    pub horizon_angle_deg: f64,
    pub peak_energy_density: f64,
    pub metric_label: &'static str,
}

pub fn compute_warp_telemetry(
    metric_type: i32,
    big_r: f64,
    sigma: f64,
    vs: f64,
) -> WarpTelemetry {
    let big_r = big_r.clamp(0.2, 20.0);
    let sigma = sigma.clamp(0.1, 20.0);
    let vs = vs.clamp(0.0, 10.0);

    let (metric_label, peak_york, peak_energy_density) = if metric_type == 0 {
        let wall = eval_shape(big_r, big_r, sigma);
        (
            "Alcubierre",
            vs * wall.df.abs(),
            -vs * vs * wall.df * wall.df * INV_32_PI,
        )
    } else if metric_type == 1 {
        let s2 = std::f64::consts::FRAC_1_SQRT_2;
        let samples = [[big_r, 0.0, 0.0], [0.0, 0.0, big_r], [big_r * s2, 0.0, big_r * s2]];
        let mut peak_t00 = 0.0_f64;
        for p in samples {
            let m = eval_warp_metric(p, 1, big_r, sigma, vs, 1.0);
            if m.t00.abs() > peak_t00.abs() {
                peak_t00 = m.t00;
            }
        }
        ("Natário", 0.0, peak_t00)
    } else {
        let samples = [
            [big_r, 0.0, 0.0],
            [0.0, 0.0, big_r],
            [0.0, 0.0, -big_r],
            [0.45 * big_r, 0.0, 0.55 * big_r],
            [0.55 * big_r, 0.0, 0.45 * big_r],
            [0.85 * big_r, 0.0, 0.15 * big_r],
        ];
        let mut peak_y = 0.0_f64;
        let mut peak_t00 = 0.0_f64;
        for p in samples {
            let m = eval_warp_metric(p, 2, big_r, sigma, vs, 1.0);
            if m.theta.abs() > peak_y {
                peak_y = m.theta.abs();
            }
            if m.t00.abs() > peak_t00.abs() {
                peak_t00 = m.t00;
            }
        }
        ("Lentz", peak_y, peak_t00)
    };

    let g_forward = 1.0 + vs;
    let has_horizon = vs >= 1.0;
    let g_aft = if has_horizon { 0.0 } else { 1.0 - vs };
    let horizon_angle_deg = if has_horizon {
        2.0 * (1.0 / vs).clamp(0.0, 1.0).acos() * RAD2DEG_64
    } else {
        0.0
    };

    WarpTelemetry {
        warp_velocity: vs,
        peak_york,
        g_forward,
        g_aft,
        has_horizon,
        horizon_angle_deg,
        peak_energy_density,
        metric_label,
    }
}

fn ease_in_out_cubic(t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) * 0.5
    }
}

#[derive(Clone, Copy)]
struct Basis {
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

fn apply_local_look(
    r0: [f32; 3],
    u0: [f32; 3],
    f0: [f32; 3],
    look_yaw: f32,
    look_pitch: f32,
    roll: f32,
) -> Basis {
    let cy = look_yaw.cos();
    let sy = look_yaw.sin();
    let fy = [
        cy * f0[0] + sy * r0[0],
        cy * f0[1] + sy * r0[1],
        cy * f0[2] + sy * r0[2],
    ];
    let ry = [
        cy * r0[0] - sy * f0[0],
        cy * r0[1] - sy * f0[1],
        cy * r0[2] - sy * f0[2],
    ];

    let cp = look_pitch.cos();
    let sp = look_pitch.sin();
    let f = [
        cp * fy[0] + sp * u0[0],
        cp * fy[1] + sp * u0[1],
        cp * fy[2] + sp * u0[2],
    ];
    let up_p = [
        -sp * fy[0] + cp * u0[0],
        -sp * fy[1] + cp * u0[1],
        -sp * fy[2] + cp * u0[2],
    ];

    let cr = roll.cos();
    let sr = roll.sin();
    let r = [
        cr * ry[0] + sr * up_p[0],
        cr * ry[1] + sr * up_p[1],
        cr * ry[2] + sr * up_p[2],
    ];
    let u = [
        -sr * ry[0] + cr * up_p[0],
        -sr * ry[1] + cr * up_p[1],
        -sr * ry[2] + cr * up_p[2],
    ];

    Basis {
        right: r,
        up: u,
        forward: f,
    }
}

fn basis_to_quat(b: Basis) -> [f32; 4] {
    let (m00, m01, m02) = (b.right[0], b.up[0], -b.forward[0]);
    let (m10, m11, m12) = (b.right[1], b.up[1], -b.forward[1]);
    let (m20, m21, m22) = (b.right[2], b.up[2], -b.forward[2]);
    let trace = m00 + m11 + m22;
    let (qx, qy, qz, qw) = if trace > 0.0 {
        let s = 0.5 / (trace + 1.0).sqrt();
        ((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s)
    } else if m00 > m11 && m00 > m22 {
        let s = 2.0 * (1.0 + m00 - m11 - m22).max(1e-12).sqrt();
        (0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s)
    } else if m11 > m22 {
        let s = 2.0 * (1.0 + m11 - m00 - m22).max(1e-12).sqrt();
        ((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s)
    } else {
        let s = 2.0 * (1.0 + m22 - m00 - m11).max(1e-12).sqrt();
        ((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s)
    };
    let inv = 1.0 / (qx * qx + qy * qy + qz * qz + qw * qw).sqrt().max(1e-12);
    [qx * inv, qy * inv, qz * inv, qw * inv]
}

fn slerp_bases(a: Basis, b: Basis, t: f32) -> Basis {
    let qa = basis_to_quat(a);
    let mut qb = basis_to_quat(b);
    let mut dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
    if dot < 0.0 {
        dot = -dot;
        qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
    }
    let (mut qx, mut qy, mut qz, mut qw) = if dot > 0.9995 {
        (
            qa[0] + t * (qb[0] - qa[0]),
            qa[1] + t * (qb[1] - qa[1]),
            qa[2] + t * (qb[2] - qa[2]),
            qa[3] + t * (qb[3] - qa[3]),
        )
    } else {
        let theta0 = dot.clamp(-1.0, 1.0).acos();
        let sin_theta0 = theta0.sin();
        let theta = theta0 * t;
        let sin_theta = theta.sin();
        let s0 = theta.cos() - (dot * sin_theta) / sin_theta0;
        let s1 = sin_theta / sin_theta0;
        (
            s0 * qa[0] + s1 * qb[0],
            s0 * qa[1] + s1 * qb[1],
            s0 * qa[2] + s1 * qb[2],
            s0 * qa[3] + s1 * qb[3],
        )
    };
    let inv = 1.0 / (qx * qx + qy * qy + qz * qz + qw * qw).sqrt().max(1e-12);
    qx *= inv;
    qy *= inv;
    qz *= inv;
    qw *= inv;
    let (xx, yy, zz) = (qx * qx, qy * qy, qz * qz);
    let (xy, xz, yz) = (qx * qy, qx * qz, qy * qz);
    let (wx, wy, wz) = (qw * qx, qw * qy, qw * qz);
    Basis {
        right: [1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy)],
        up: [2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx)],
        forward: [-(2.0 * (xz + wy)), -(2.0 * (yz - wx)), -(1.0 - 2.0 * (xx + yy))],
    }
}

struct WarpFlight {
    elapsed: f32,
    duration: f32,
    start_log_r: f32,
    start_el: f32,
    start_az: f32,
    start_roll: f32,
    start_fov: f32,
    start_yaw: f32,
    start_pitch: f32,
    start_blend: f32,
    end_log_r: f32,
    end_el: f32,
    end_az: f32,
    end_roll: f32,
    end_fov: f32,
    end_yaw: f32,
    end_pitch: f32,
    end_blend: f32,
}

struct WarpCamera {
    camera_mode: i32,
    frame_blend: f32,
    target_frame_blend: f32,
    vel_frame_blend: f32,

    log_radius: f32,
    elevation: f32,
    azimuth: f32,
    roll: f32,
    fov: f32,
    look_yaw: f32,
    look_pitch: f32,

    target_log_radius: f32,
    target_elevation: f32,
    target_azimuth: f32,
    target_roll: f32,
    target_fov: f32,
    target_look_yaw: f32,
    target_look_pitch: f32,

    vel_log_radius: f32,
    vel_elevation: f32,
    vel_azimuth: f32,
    vel_roll: f32,
    vel_fov: f32,
    vel_look_yaw: f32,
    vel_look_pitch: f32,

    flight: Option<WarpFlight>,
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    pos: [f32; 3],
    basis: Basis,
    moved: bool,
    prev_sig: Option<[f32; 15]>,
}

impl WarpCamera {
    fn from_preset(p: &WarpPreset) -> Self {
        let mode0 = if p.camera_mode == 1 { 1 } else { 0 };
        let r0 = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let el0 = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az0 = p.azimuth_deg * DEG2RAD;
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let yaw0 = p.look_yaw_deg * DEG2RAD;
        let pitch0 = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let blend0 = if mode0 == 1 { 1.0 } else { 0.0 };

        let mut cam = Self {
            camera_mode: mode0,
            frame_blend: blend0,
            target_frame_blend: blend0,
            vel_frame_blend: 0.0,
            log_radius: r0.ln(),
            elevation: el0,
            azimuth: az0,
            roll: roll0,
            fov: fov0,
            look_yaw: yaw0,
            look_pitch: pitch0,
            target_log_radius: r0.ln(),
            target_elevation: el0,
            target_azimuth: az0,
            target_roll: roll0,
            target_fov: fov0,
            target_look_yaw: yaw0,
            target_look_pitch: pitch0,
            vel_log_radius: 0.0,
            vel_elevation: 0.0,
            vel_azimuth: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            vel_look_yaw: 0.0,
            vel_look_pitch: 0.0,
            flight: None,
            auto_orbit_time: 0.0,
            auto_base_elevation: el0,
            interaction_cooldown: 0.0,
            pos: [0.0, 0.0, r0],
            basis: Basis {
                right: [1.0, 0.0, 0.0],
                up: [0.0, 1.0, 0.0],
                forward: [0.0, 0.0, -1.0],
            },
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn set_mode(&mut self, mode: i32) {
        let next = if mode == 1 { 1 } else { 0 };
        self.camera_mode = next;
        self.target_frame_blend = if next == 1 { 1.0 } else { 0.0 };
        self.flight = None;
        if next == 1 {
            self.target_look_yaw = 0.0;
            self.target_look_pitch = 0.0;
            self.target_roll = 0.0;
            self.target_fov = 60.0 * DEG2RAD;
        } else {
            self.target_look_yaw = 0.0;
            self.target_look_pitch = 0.0;
            self.target_fov = 48.0 * DEG2RAD;
        }
    }

    fn fly_to(&mut self, p: &WarpPreset, duration: f32) {
        let dest_mode = if p.camera_mode == 1 { 1 } else { 0 };
        self.camera_mode = dest_mode;
        let dest_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az_raw = p.azimuth_deg * DEG2RAD;
        let dest_az = self.azimuth + wrap_angle_delta(dest_az_raw - self.azimuth);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let dest_yaw_raw = p.look_yaw_deg * DEG2RAD;
        let dest_yaw = self.look_yaw + wrap_angle_delta(dest_yaw_raw - self.look_yaw);
        let dest_pitch = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let dest_blend = if dest_mode == 1 { 1.0 } else { 0.0 };

        self.flight = Some(WarpFlight {
            elapsed: 0.0,
            duration: duration.max(0.01),
            start_log_r: self.log_radius,
            start_el: self.elevation,
            start_az: self.azimuth,
            start_roll: self.roll,
            start_fov: self.fov,
            start_yaw: self.look_yaw,
            start_pitch: self.look_pitch,
            start_blend: self.frame_blend,
            end_log_r: dest_r.ln(),
            end_el: dest_el,
            end_az: dest_az,
            end_roll: dest_roll,
            end_fov: dest_fov,
            end_yaw: dest_yaw,
            end_pitch: dest_pitch,
            end_blend: dest_blend,
        });
        self.vel_log_radius = 0.0;
        self.vel_elevation = 0.0;
        self.vel_azimuth = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.vel_look_yaw = 0.0;
        self.vel_look_pitch = 0.0;
        self.vel_frame_blend = 0.0;
        self.interaction_cooldown = 0.0;
    }

    fn cancel_flight(&mut self) {
        if self.flight.take().is_some() {
            self.target_log_radius = self.log_radius;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
            self.target_frame_blend = if self.camera_mode == 1 { 1.0 } else { 0.0 };
        }
    }

    fn mark_interaction(&mut self) {
        self.cancel_flight();
        self.interaction_cooldown = INTERACTION_COOLDOWN;
        self.auto_base_elevation = self.target_elevation;
        self.auto_orbit_time = 0.0;
    }

    fn update(&mut self, dt: f32, paused: bool, auto_orbit: bool, input: &SimInput) {
        let cdt = dt.clamp(0.0, 0.05);
        let scale = 1.0 / input.viewport_w.min(input.viewport_h).max(320.0);
        let mut interacting = false;

        if input.primary_drag || input.secondary_drag {
            interacting = true;
            let dx = input.drag_delta[0];
            let dy = input.drag_delta[1];
            if dx.abs() > 0.0 || dy.abs() > 0.0 {
                if input.secondary_drag {
                    self.target_roll =
                        (self.target_roll + dx * scale * 2.2).clamp(MIN_ROLL, MAX_ROLL);
                } else if input.shift_down || self.camera_mode == 1 {
                    self.target_look_yaw += dx * scale * 2.6;
                    self.target_look_pitch = (self.target_look_pitch - dy * scale * 2.2)
                        .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
                } else {
                    self.target_azimuth += dx * scale * 3.1;
                    self.target_elevation = (self.target_elevation + dy * scale * 2.4)
                        .clamp(MIN_ELEVATION, MAX_ELEVATION);
                }
                self.mark_interaction();
            } else {
                self.cancel_flight();
                self.interaction_cooldown = INTERACTION_COOLDOWN;
            }
        }

        if input.scroll_y.abs() > 0.0 {
            interacting = true;
            let delta = input.scroll_y.clamp(-240.0, 240.0);
            if self.camera_mode == 1 {
                self.target_fov =
                    (self.target_fov + delta * 0.0009).clamp(MIN_BRIDGE_FOV, MAX_BRIDGE_FOV);
            } else {
                self.target_log_radius = (self.target_log_radius + delta * 0.00115)
                    .clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            }
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let orbit_rate = 0.85 * cdt;
            let elev_rate = 0.65 * cdt;
            let look_rate = 1.05 * cdt;
            let zoom_rate = 0.72 * cdt;
            let fov_rate = 0.52 * cdt;
            let roll_rate = 0.75 * cdt;

            if self.camera_mode == 1 {
                if input.key_a || input.key_left {
                    self.target_look_yaw -= look_rate;
                }
                if input.key_d || input.key_right {
                    self.target_look_yaw += look_rate;
                }
                if input.key_up {
                    self.target_look_pitch =
                        (self.target_look_pitch + look_rate).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
                }
                if input.key_down {
                    self.target_look_pitch =
                        (self.target_look_pitch - look_rate).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
                }
                if input.key_w {
                    self.target_fov =
                        (self.target_fov - fov_rate).clamp(MIN_BRIDGE_FOV, MAX_BRIDGE_FOV);
                }
                if input.key_s {
                    self.target_fov =
                        (self.target_fov + fov_rate).clamp(MIN_BRIDGE_FOV, MAX_BRIDGE_FOV);
                }
            } else {
                if input.key_a || input.key_left {
                    self.target_azimuth += orbit_rate;
                }
                if input.key_d || input.key_right {
                    self.target_azimuth -= orbit_rate;
                }
                if input.key_up {
                    self.target_elevation =
                        (self.target_elevation + elev_rate).clamp(MIN_ELEVATION, MAX_ELEVATION);
                }
                if input.key_down {
                    self.target_elevation =
                        (self.target_elevation - elev_rate).clamp(MIN_ELEVATION, MAX_ELEVATION);
                }
                if input.key_w {
                    self.target_log_radius = (self.target_log_radius - zoom_rate)
                        .clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
                }
                if input.key_s {
                    self.target_log_radius = (self.target_log_radius + zoom_rate)
                        .clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
                }
            }
            if input.key_q {
                self.target_roll = (self.target_roll - roll_rate).clamp(MIN_ROLL, MAX_ROLL);
            }
            if input.key_e {
                self.target_roll = (self.target_roll + roll_rate).clamp(MIN_ROLL, MAX_ROLL);
            }
            self.interaction_cooldown = INTERACTION_COOLDOWN;
            self.auto_base_elevation = self.target_elevation;
        }

        if let Some(mut f) = self.flight.take() {
            f.elapsed += cdt;
            let t = (f.elapsed / f.duration).clamp(0.0, 1.0);
            let e = ease_out_cubic(t);
            let eb = ease_in_out_cubic(t);

            self.log_radius = f.start_log_r + (f.end_log_r - f.start_log_r) * e;
            self.elevation = f.start_el + (f.end_el - f.start_el) * e;
            self.azimuth = f.start_az + (f.end_az - f.start_az) * e;
            self.roll = f.start_roll + (f.end_roll - f.start_roll) * e;
            self.fov = f.start_fov + (f.end_fov - f.start_fov) * e;
            self.look_yaw = f.start_yaw + (f.end_yaw - f.start_yaw) * e;
            self.look_pitch = f.start_pitch + (f.end_pitch - f.start_pitch) * e;
            self.frame_blend = f.start_blend + (f.end_blend - f.start_blend) * eb;

            self.target_log_radius = self.log_radius;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
            self.target_frame_blend = f.end_blend;

            if t >= 1.0 {
                self.auto_base_elevation = self.elevation;
                self.auto_orbit_time = 0.0;
            } else {
                self.flight = Some(f);
            }
        } else {
            if self.interaction_cooldown > 0.0 && !interacting {
                self.interaction_cooldown = (self.interaction_cooldown - cdt).max(0.0);
            }
            if self.camera_mode == 0
                && auto_orbit
                && !paused
                && !interacting
                && self.interaction_cooldown <= 0.0
            {
                self.auto_orbit_time += cdt;
                let ramp = (self.auto_orbit_time / 1.5).clamp(0.0, 1.0);
                self.target_azimuth += AUTO_ORBIT_SPEED * ramp * cdt;
                self.target_elevation = (self.auto_base_elevation
                    + (self.auto_orbit_time * AUTO_BREATH_FREQ).sin() * AUTO_BREATH_AMP * ramp)
                    .clamp(MIN_ELEVATION, MAX_ELEVATION);
            }

            if cdt > 0.0 {
                (self.log_radius, self.vel_log_radius) = step_critically_damped(
                    self.log_radius,
                    self.vel_log_radius,
                    self.target_log_radius,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.elevation, self.vel_elevation) = step_critically_damped(
                    self.elevation,
                    self.vel_elevation,
                    self.target_elevation,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.azimuth, self.vel_azimuth) = step_critically_damped(
                    self.azimuth,
                    self.vel_azimuth,
                    self.target_azimuth,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.roll, self.vel_roll) = step_critically_damped(
                    self.roll,
                    self.vel_roll,
                    self.target_roll,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.fov, self.vel_fov) = step_critically_damped(
                    self.fov,
                    self.vel_fov,
                    self.target_fov,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.look_yaw, self.vel_look_yaw) = step_critically_damped(
                    self.look_yaw,
                    self.vel_look_yaw,
                    self.target_look_yaw,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.look_pitch, self.vel_look_pitch) = step_critically_damped(
                    self.look_pitch,
                    self.vel_look_pitch,
                    self.target_look_pitch,
                    SPRING_OMEGA,
                    cdt,
                );
                (self.frame_blend, self.vel_frame_blend) = step_critically_damped(
                    self.frame_blend,
                    self.vel_frame_blend,
                    self.target_frame_blend,
                    FRAME_BLEND_OMEGA,
                    cdt,
                );
            }
        }

        self.recompute_basis();
    }

    fn compute_chase_pose(&self) -> ([f32; 3], Basis) {
        let r = self.log_radius.exp();
        let cos_el = self.elevation.cos();
        let sin_el = self.elevation.sin();
        let cos_az = self.azimuth.cos();
        let sin_az = self.azimuth.sin();

        let px = -r * cos_el * sin_az;
        let py = r * sin_el;
        let pz = r * cos_el * cos_az;

        let inv_r = 1.0 / r.max(1e-6);
        let f0 = [-px * inv_r, -py * inv_r, -pz * inv_r];

        let mut r0x = -f0[2];
        let mut r0z = f0[0];
        let r0_len = r0x.hypot(r0z);
        if r0_len < 1e-6 {
            r0x = cos_az;
            r0z = sin_az;
        } else {
            r0x /= r0_len;
            r0z /= r0_len;
        }
        let r0 = [r0x, 0.0, r0z];

        let u0x = -r0z * f0[1];
        let u0y = r0z * f0[0] - r0x * f0[2];
        let u0z = r0x * f0[1];
        let u0_len = (u0x * u0x + u0y * u0y + u0z * u0z).sqrt().max(1e-6);
        let u0 = [u0x / u0_len, u0y / u0_len, u0z / u0_len];

        let basis = apply_local_look(r0, u0, f0, self.look_yaw, self.look_pitch, self.roll);
        ([px, py, pz], basis)
    }

    fn compute_bridge_pose(&self) -> ([f32; 3], Basis) {
        let r0 = [-1.0, 0.0, 0.0];
        let u0 = [0.0, 1.0, 0.0];
        let f0 = [0.0, 0.0, 1.0];
        let basis = apply_local_look(r0, u0, f0, self.look_yaw, self.look_pitch, self.roll);
        (BRIDGE_POS, basis)
    }

    fn recompute_basis(&mut self) {
        let t = self.frame_blend.clamp(0.0, 1.0);
        let (pos, basis) = if t <= 1e-5 {
            self.compute_chase_pose()
        } else if t >= 1.0 - 1e-5 {
            self.compute_bridge_pose()
        } else {
            let (c_pos, c_b) = self.compute_chase_pose();
            let (b_pos, b_b) = self.compute_bridge_pose();
            let st = ease_in_out_cubic(t);
            let pos = [
                c_pos[0] + (b_pos[0] - c_pos[0]) * st,
                c_pos[1] + (b_pos[1] - c_pos[1]) * st,
                c_pos[2] + (b_pos[2] - c_pos[2]) * st,
            ];
            (pos, slerp_bases(c_b, b_b, st))
        };

        self.pos = pos;
        self.basis = basis;

        let sig = [
            pos[0],
            pos[1],
            pos[2],
            basis.right[0],
            basis.right[1],
            basis.right[2],
            basis.up[0],
            basis.up[1],
            basis.up[2],
            basis.forward[0],
            basis.forward[1],
            basis.forward[2],
            self.fov,
            self.camera_mode as f32,
            self.frame_blend,
        ];
        if let Some(prev) = self.prev_sig {
            let mut max_diff = 0.0_f32;
            for i in 0..sig.len() {
                max_diff = max_diff.max((sig[i] - prev[i]).abs());
            }
            self.moved = max_diff > 1e-6;
            if self.moved {
                self.prev_sig = Some(sig);
            }
        } else {
            self.moved = true;
            self.prev_sig = Some(sig);
        }
    }
}

pub struct WarpDriveSim {
    active_preset: Option<usize>,

    metric_type: i32,
    camera_mode: i32,
    warp_velocity: f32,
    bubble_radius: f32,
    wall_thickness: f32,
    doppler_strength: f32,
    wall_shimmer: f32,
    caustic_glow: f32,
    star_streaks: f32,
    flow_speed: f32,

    exposure: f32,
    bloom_intensity: f32,
    anamorphic_intensity: f32,
    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    quality: i32,
    resolution_scale: f32,

    paused: bool,
    auto_orbit: bool,
    sim_time: f32,

    camera: WarpCamera,
    pipeline: wgpu::RenderPipeline,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl WarpDriveSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[2]; // Default preset is 'superluminal' (index 2)
        let shader = assets
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("warp-wgsl"),
                source: wgpu::ShaderSource::Wgsl(shaders::WARP.into()),
            });
        let pipeline = make_fs_pipe(
            &assets.device,
            "warp-pipe",
            &assets.standard_sim_bgl,
            &shader,
            wgpu::TextureFormat::Rgba16Float,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("warp-ubo"),
            size: std::mem::size_of::<WarpUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("warp-bg", &ubo, None);

        Self {
            active_preset: Some(2),
            metric_type: p.metric_type,
            camera_mode: p.camera_mode,
            warp_velocity: p.warp_velocity,
            bubble_radius: p.bubble_radius,
            wall_thickness: p.wall_thickness,
            doppler_strength: p.doppler_strength,
            wall_shimmer: p.wall_shimmer,
            caustic_glow: p.caustic_glow,
            star_streaks: p.star_streaks,
            flow_speed: p.flow_speed,
            exposure: p.exposure,
            bloom_intensity: p.bloom,
            anamorphic_intensity: p.anamorphic,
            sky_intensity: p.sky_intensity,
            sky_mode: p.sky_mode,
            sky_rot: p.sky_rot,
            quality: 1,
            resolution_scale: 1.0,
            paused: false,
            auto_orbit: p.auto_orbit,
            sim_time: 0.0,
            camera: WarpCamera::from_preset(p),
            pipeline,
            ubo,
            bind_group,
        }
    }

    fn build_uniforms(
        &self,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
    ) -> WarpUniforms {
        WarpUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_mode: [jitter[0], jitter[1], self.camera.fov, self.camera_mode as f32],
            cam_pos_metric: [
                self.camera.pos[0],
                self.camera.pos[1],
                self.camera.pos[2],
                self.metric_type as f32,
            ],
            cam_right_vs: [
                self.camera.basis.right[0],
                self.camera.basis.right[1],
                self.camera.basis.right[2],
                self.warp_velocity,
            ],
            cam_up_r: [
                self.camera.basis.up[0],
                self.camera.basis.up[1],
                self.camera.basis.up[2],
                self.bubble_radius,
            ],
            cam_fwd_sigma: [
                self.camera.basis.forward[0],
                self.camera.basis.forward[1],
                self.camera.basis.forward[2],
                self.wall_thickness,
            ],
            physics_params: [
                self.doppler_strength,
                self.wall_shimmer,
                self.caustic_glow,
                self.star_streaks,
            ],
            sky_params: [
                self.sky_intensity,
                self.sky_mode as f32,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            quality_params: [
                self.quality as f32,
                self.flow_speed,
                self.camera.frame_blend,
                0.0,
            ],
        }
    }
}

impl Simulation for WarpDriveSim {
    fn id(&self) -> SimId {
        SimId::WarpDrive
    }

    fn post_params(&self, camera_moved: bool, sim_time: f32) -> PostFrameParams {
        PostFrameParams {
            exposure: self.exposure,
            bloom_intensity: self.bloom_intensity,
            anamorphic_intensity: self.anamorphic_intensity,
            paused: self.paused,
            camera_moved,
            sim_time,
            resolution_scale: self.resolution_scale,
            tuning: PostTuning::default(),
        }
    }

    fn presets(&self) -> Vec<PresetMeta> {
        PRESETS.iter().map(|p| p.meta.clone()).collect()
    }

    fn active_preset_index(&self) -> Option<usize> {
        self.active_preset
    }

    fn apply_preset(&mut self, index: usize) {
        if let Some(p) = PRESETS.get(index) {
            self.active_preset = Some(index);
            self.camera_mode = p.camera_mode;
            self.metric_type = p.metric_type;
            self.warp_velocity = p.warp_velocity;
            self.bubble_radius = p.bubble_radius;
            self.wall_thickness = p.wall_thickness;
            self.doppler_strength = p.doppler_strength;
            self.wall_shimmer = p.wall_shimmer;
            self.caustic_glow = p.caustic_glow;
            self.star_streaks = p.star_streaks;
            self.flow_speed = p.flow_speed;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.auto_orbit = p.auto_orbit;
            self.camera.fly_to(p, 1.2);
        }
    }

    fn control_sections(&self) -> Vec<ControlSection> {
        vec![
            ControlSection {
                id: "metric",
                title: "Warp Metric & Velocity",
                default_open: true,
                items: vec![
                    ControlItem {
                        key: "metricType",
                        label: "Spacetime Metric",
                        kind: ControlKind::Segmented {
                            options: vec![(0, "Alcubierre"), (1, "Natário"), (2, "Lentz")],
                        },
                    },
                    ControlItem {
                        key: "cameraMode",
                        label: "Observer Frame",
                        kind: ControlKind::Segmented {
                            options: vec![(0, "External Chase"), (1, "Inside Bridge")],
                        },
                    },
                    ControlItem {
                        key: "warpVelocity",
                        label: "Warp Velocity (v_s/c)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 5.0,
                            step: 0.05,
                            hints: Some(["Subluminal", "5.0c FTL"]),
                        },
                    },
                    ControlItem {
                        key: "bubbleRadius",
                        label: "Bubble Radius (R)",
                        kind: ControlKind::Range {
                            min: 1.5,
                            max: 6.0,
                            step: 0.1,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "wallThickness",
                        label: "Wall Sharpness (σ)",
                        kind: ControlKind::Range {
                            min: 0.8,
                            max: 6.5,
                            step: 0.1,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "dopplerStrength",
                        label: "Relativistic Doppler",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                ],
            },
            ControlSection {
                id: "exotic",
                title: "Exotic Wall & Starfield",
                default_open: true,
                items: vec![
                    ControlItem {
                        key: "wallShimmer",
                        label: "Exotic Wall Shimmer",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "causticGlow",
                        label: "Bow Caustic Glow",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "starStreaks",
                        label: "Interstellar Dust Streaks",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "flowSpeed",
                        label: "Plasma Flow Speed",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                ],
            },
            ControlSection {
                id: "optics",
                title: "Optics, Sky & Quality",
                default_open: true,
                items: vec![
                    ControlItem {
                        key: "exposure",
                        label: "Exposure",
                        kind: ControlKind::Range {
                            min: 0.3,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "bloomIntensity",
                        label: "HDR Bloom",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "anamorphicIntensity",
                        label: "Anamorphic Streak",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.2,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "skyIntensity",
                        label: "Sky Brightness",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "skyMode",
                        label: "Background Sky Source",
                        kind: ControlKind::Select {
                            options: vec![
                                (0, "Hybrid 4K + Micro-Stars"),
                                (1, "4K NASA/ESO Map"),
                                (2, "Procedural Deep Field"),
                            ],
                        },
                    },
                    ControlItem {
                        key: "quality",
                        label: "Ray-Trace Quality",
                        kind: ControlKind::Segmented {
                            options: vec![(0, "Medium"), (1, "High"), (2, "Ultra Cinema")],
                        },
                    },
                    ControlItem {
                        key: "resolutionScale",
                        label: "Render Resolution",
                        kind: ControlKind::Segmented {
                            options: vec![(50, "0.5×"), (75, "0.75×"), (100, "1.0×")],
                        },
                    },
                ],
            },
        ]
    }

    fn get_f32(&self, key: &str) -> f32 {
        match key {
            "warpVelocity" => self.warp_velocity,
            "bubbleRadius" => self.bubble_radius,
            "wallThickness" => self.wall_thickness,
            "dopplerStrength" => self.doppler_strength,
            "wallShimmer" => self.wall_shimmer,
            "causticGlow" => self.caustic_glow,
            "starStreaks" => self.star_streaks,
            "flowSpeed" => self.flow_speed,
            "exposure" => self.exposure,
            "bloomIntensity" => self.bloom_intensity,
            "anamorphicIntensity" => self.anamorphic_intensity,
            "skyIntensity" => self.sky_intensity,
            _ => 0.0,
        }
    }

    fn set_f32(&mut self, key: &str, val: f32) -> bool {
        let mut reset_primary = true;
        match key {
            "warpVelocity" => self.warp_velocity = val,
            "bubbleRadius" => self.bubble_radius = val,
            "wallThickness" => self.wall_thickness = val,
            "dopplerStrength" => self.doppler_strength = val,
            "wallShimmer" => self.wall_shimmer = val,
            "causticGlow" => self.caustic_glow = val,
            "starStreaks" => self.star_streaks = val,
            "flowSpeed" => self.flow_speed = val,
            "exposure" => {
                self.exposure = val;
                reset_primary = false;
            }
            "bloomIntensity" => {
                self.bloom_intensity = val;
                reset_primary = false;
            }
            "anamorphicIntensity" => {
                self.anamorphic_intensity = val;
                reset_primary = false;
            }
            "skyIntensity" => self.sky_intensity = val,
            _ => {}
        }
        if reset_primary {
            self.active_preset = None;
        }
        reset_primary
    }

    fn get_i32(&self, key: &str) -> i32 {
        match key {
            "metricType" => self.metric_type,
            "cameraMode" => self.camera_mode,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "metricType" => {
                self.metric_type = val;
                self.active_preset = None;
            }
            "cameraMode" => {
                self.camera_mode = if val == 1 { 1 } else { 0 };
                self.camera.set_mode(self.camera_mode);
                self.active_preset = None;
            }
            "skyMode" => self.sky_mode = val,
            "quality" => self.quality = val,
            "resolutionScale" => self.resolution_scale = (val as f32 / 100.0).clamp(0.5, 1.0),
            _ => {}
        }
        true
    }

    fn format_value(&self, key: &str) -> String {
        match key {
            "warpVelocity" => format!("{:.2} c", self.warp_velocity),
            "bubbleRadius" => format!("{:.1} M", self.bubble_radius),
            "wallThickness" => format!("{:.1}", self.wall_thickness),
            "dopplerStrength" => format!("{:.2}×", self.doppler_strength),
            "wallShimmer" => format!("{:.2}", self.wall_shimmer),
            "causticGlow" => format!("{:.2}", self.caustic_glow),
            "starStreaks" => format!("{:.2}", self.star_streaks),
            "flowSpeed" => format!("{:.2}×", self.flow_speed),
            "exposure" => format!("{:.2}", self.exposure),
            "bloomIntensity" => format!("{:.2}", self.bloom_intensity),
            "anamorphicIntensity" => format!("{:.2}", self.anamorphic_intensity),
            "skyIntensity" => format!("{:.2}", self.sky_intensity),
            _ => String::new(),
        }
    }

    fn paused(&self) -> bool {
        self.paused
    }

    fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    fn auto_orbit(&self) -> bool {
        self.auto_orbit
    }

    fn toggle_auto_orbit(&mut self) {
        self.auto_orbit = !self.auto_orbit;
    }

    fn reset_camera(&mut self) {
        let idx = self.active_preset.unwrap_or(2);
        let p = &PRESETS[idx];
        self.camera_mode = p.camera_mode;
        self.camera.fly_to(p, 1.0);
    }

    fn trigger_special_action(&mut self) {
        self.camera_mode = if self.camera_mode == 1 { 0 } else { 1 };
        self.camera.set_mode(self.camera_mode);
        self.active_preset = None;
    }

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let tel = compute_warp_telemetry(
            self.metric_type,
            self.bubble_radius as f64,
            self.sigma_safe(),
            self.warp_velocity as f64,
        );
        let preset_badge = self
            .active_preset
            .and_then(|i| PRESETS.get(i))
            .map(|p| p.meta.full_name.to_string())
            .unwrap_or_else(|| "Custom".to_string());
        let secondary_badge = if assets.sky_map_loaded {
            "4K Milky Way".to_string()
        } else {
            "Procedural Sky".to_string()
        };
        let york_str = if tel.peak_york.abs() < 1e-4 {
            "0.00".to_string()
        } else {
            format!("±{:.2}", tel.peak_york.abs())
        };
        let horizon_str = if tel.has_horizon {
            format!("{:.1}°", tel.horizon_angle_deg)
        } else {
            "None".to_string()
        };
        let t00_str = if tel.peak_energy_density.abs() < 1e-12 {
            "0.00e+0".to_string()
        } else {
            format!("{:.2e}", tel.peak_energy_density)
        };

        HudMetadata {
            brand_title: "ALCUBIERRE WARP",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: false,
            drawer_title: "Warp Physics & Optics",
            drawer_subtitle: format!("{} · T00 {}", tel.metric_label, t00_str),
            hint_text: "Drag to orbit/look · Scroll to zoom · T Bridge/Chase · Space Still · H HUD",
            telemetry: [
                TelemetryCell {
                    label: "WARP SPEED",
                    unit: "vs/c",
                    value: format!("{:.2} c", tel.warp_velocity),
                },
                TelemetryCell {
                    label: "PEAK YORK",
                    unit: "θmax",
                    value: york_str,
                },
                TelemetryCell {
                    label: "DOPPLER",
                    unit: "gfwd/gaft",
                    value: format!("{:.2} / {:.2}", tel.g_forward, tel.g_aft.max(0.0)),
                },
                TelemetryCell {
                    label: "CAUSAL HORIZON",
                    unit: "θH",
                    value: horizon_str,
                },
                TelemetryCell {
                    label: "CAMERA MODE",
                    unit: "",
                    value: if self.camera_mode == 1 {
                        "Inside Bridge".to_string()
                    } else {
                        "External Chase".to_string()
                    },
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: if self.camera_mode == 1 {
                    "Chase"
                } else {
                    "Bridge"
                },
                key_hint: "T",
                active: self.camera_mode == 1,
            }),
            orbit_toggle_label: "Orbit",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        if !self.paused {
            self.sim_time += dt.clamp(0.0, 0.05);
        }
        self.camera
            .update(dt, self.paused, self.auto_orbit, input);
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: false,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("warp-bg", &self.ubo, None);
    }

    fn encode_frame(
        &mut self,
        assets: &SharedGpuAssets,
        encoder: &mut wgpu::CommandEncoder,
        scene_view: &wgpu::TextureView,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        _dt: f32,
        _hard_reset: bool,
    ) {
        let ubo_data = self.build_uniforms(render_width, render_height, frame_index, jitter);
        assets
            .queue
            .write_buffer(&self.ubo, 0, bytemuck::bytes_of(&ubo_data));
        run_fs_pass(
            encoder,
            "warp-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
        );
    }
}

impl WarpDriveSim {
    fn sigma_safe(&self) -> f64 {
        self.wall_thickness as f64
    }
}
