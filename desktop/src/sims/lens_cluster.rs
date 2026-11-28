use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::renderer::post::{PostFrameParams, PostTuning, run_fs_pass_timed};
use crate::renderer::{SharedGpuAssets, SimBglKind};
use crate::shaders;
use crate::sims::{
    ControlItem, ControlKind, ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation,
    SpecialActionUi, StepOutcome, TelemetryCell, ease_out_cubic, step_critically_damped,
    wrap_angle_delta,
};

const DEG2RAD: f32 = std::f32::consts::PI / 180.0;

pub const LENS_MODEL_LABELS: [&str; 3] = ["Point Mass", "SIE Elliptical", "NFW Cluster"];

pub const MASS_PER_ARCSEC2_1E12_MSUN: f64 = 0.2279;
pub const TIME_DELAY_DAYS_PER_ARCSEC2: f64 = 72.24;
const POINT_SOFTENING_FRAC: f64 = 0.015;
const SIE_CORE_FRAC: f64 = 0.035;
const NFW_CORE_FRAC: f64 = 0.04;
const NFW_RS_RATIO: f64 = 2.6;

struct SubhaloDef {
    x: f64,
    y: f64,
    _z: f64,
    b_frac: f64,
    core_frac: f64,
    ellip: f64,
    angle_rad: f64,
}

const SUBHALOS: [SubhaloDef; 6] = [
    SubhaloDef {
        x: -1.25,
        y: 0.72,
        _z: 0.45,
        b_frac: 0.24,
        core_frac: 0.14,
        ellip: 0.22,
        angle_rad: 0.42,
    },
    SubhaloDef {
        x: 1.48,
        y: -0.58,
        _z: -0.55,
        b_frac: 0.22,
        core_frac: 0.14,
        ellip: 0.28,
        angle_rad: -0.65,
    },
    SubhaloDef {
        x: 0.55,
        y: 1.42,
        _z: 0.65,
        b_frac: 0.18,
        core_frac: 0.12,
        ellip: 0.18,
        angle_rad: 1.10,
    },
    SubhaloDef {
        x: -1.62,
        y: -1.05,
        _z: -0.40,
        b_frac: 0.20,
        core_frac: 0.13,
        ellip: 0.30,
        angle_rad: -0.25,
    },
    SubhaloDef {
        x: 2.15,
        y: 1.10,
        _z: -0.75,
        b_frac: 0.16,
        core_frac: 0.12,
        ellip: 0.24,
        angle_rad: 0.80,
    },
    SubhaloDef {
        x: -0.42,
        y: -1.85,
        _z: 0.60,
        b_frac: 0.17,
        core_frac: 0.13,
        ellip: 0.20,
        angle_rad: -1.05,
    },
];

const MIN_RADIUS: f32 = 5.0;
const MAX_RADIUS: f32 = 36.0;
const MIN_ELEVATION: f32 = -82.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 82.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 20.0 * DEG2RAD;
const MAX_FOV: f32 = 75.0 * DEG2RAD;
const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.04;
const INTERACTION_COOLDOWN: f32 = 2.4;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct LensClusterUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_prog: [f32; 4],
    cam_pos_unused: [f32; 4],
    cam_right_model: [f32; 4],
    cam_up_theta_e: [f32; 4],
    cam_fwd_ellip: [f32; 4],
    lens_shape_params: [f32; 4],
    source_params: [f32; 4],
    overlay_params: [f32; 4],
    cluster_optics_params: [f32; 4],
    sky_quality_params: [f32; 4],
}

#[derive(Clone, Copy)]
struct LensPreset {
    meta: PresetMeta,
    lens_model: i32,
    einstein_radius: f32,
    ellipticity: f32,
    ext_shear: f32,
    lens_angle_deg: f32,
    shear_angle_deg: f32,
    subhalo_strength: f32,
    source_x: f32,
    source_y: f32,
    source_scale: f32,
    quasar_core: f32,
    source_orbit_speed: f32,
    extra_field_galaxies: f32,
    show_caustics: i32,
    show_fermat: i32,
    cluster_light: f32,
    icm_glow: f32,
    sky_intensity: f32,
    sky_mode: i32,
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    radius: f32,
    elevation_deg: f32,
    azimuth_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
    auto_orbit: bool,
}

const PRESETS: [LensPreset; 6] = [
    LensPreset {
        meta: PresetMeta {
            id: "einstein_ring",
            full_name: "Perfect Einstein Ring",
            short_label: "Einstein Ring",
            hotkey: "1",
        },
        lens_model: 0,
        einstein_radius: 2.10,
        ellipticity: 0.0,
        ext_shear: 0.0,
        lens_angle_deg: 0.0,
        shear_angle_deg: 22.0,
        subhalo_strength: 0.0,
        source_x: 0.0,
        source_y: 0.0,
        source_scale: 0.44,
        quasar_core: 0.45,
        source_orbit_speed: 0.0,
        extra_field_galaxies: 0.20,
        show_caustics: 0,
        show_fermat: 0,
        cluster_light: 0.35,
        icm_glow: 0.15,
        sky_intensity: 0.68,
        sky_mode: 0,
        exposure: 1.08,
        bloom: 0.58,
        anamorphic: 0.38,
        radius: 14.5,
        elevation_deg: 2.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 40.0,
        auto_orbit: false,
    },
    LensPreset {
        meta: PresetMeta {
            id: "einstein_cross",
            full_name: "Einstein Cross (Quad)",
            short_label: "Einstein Cross",
            hotkey: "2",
        },
        lens_model: 1,
        einstein_radius: 1.85,
        ellipticity: 0.34,
        ext_shear: 0.08,
        lens_angle_deg: 18.0,
        shear_angle_deg: -28.0,
        subhalo_strength: 0.0,
        source_x: 0.07,
        source_y: 0.05,
        source_scale: 0.20,
        quasar_core: 2.15,
        source_orbit_speed: 0.08,
        extra_field_galaxies: 0.20,
        show_caustics: 0,
        show_fermat: 0,
        cluster_light: 1.15,
        icm_glow: 0.25,
        sky_intensity: 0.66,
        sky_mode: 0,
        exposure: 1.12,
        bloom: 0.64,
        anamorphic: 0.44,
        radius: 12.6,
        elevation_deg: 4.0,
        azimuth_deg: 5.0,
        roll_deg: 0.0,
        fov_deg: 38.0,
        auto_orbit: false,
    },
    LensPreset {
        meta: PresetMeta {
            id: "jwst_cluster",
            full_name: "JWST Giant Cluster Arcs",
            short_label: "JWST Cluster",
            hotkey: "3",
        },
        lens_model: 2,
        einstein_radius: 2.55,
        ellipticity: 0.28,
        ext_shear: 0.06,
        lens_angle_deg: -22.0,
        shear_angle_deg: 34.0,
        subhalo_strength: 1.15,
        source_x: 0.42,
        source_y: -0.26,
        source_scale: 0.44,
        quasar_core: 0.55,
        source_orbit_speed: 0.06,
        extra_field_galaxies: 1.0,
        show_caustics: 0,
        show_fermat: 0,
        cluster_light: 1.35,
        icm_glow: 1.05,
        sky_intensity: 0.65,
        sky_mode: 0,
        exposure: 1.08,
        bloom: 0.56,
        anamorphic: 0.36,
        radius: 20.5,
        elevation_deg: 7.0,
        azimuth_deg: -8.0,
        roll_deg: -2.0,
        fov_deg: 42.0,
        auto_orbit: false,
    },
    LensPreset {
        meta: PresetMeta {
            id: "fold_caustic",
            full_name: "Fold Caustic Merger",
            short_label: "Fold Merger",
            hotkey: "4",
        },
        lens_model: 1,
        einstein_radius: 2.15,
        ellipticity: 0.42,
        ext_shear: 0.10,
        lens_angle_deg: 12.0,
        shear_angle_deg: -15.0,
        subhalo_strength: 0.0,
        source_x: 0.34,
        source_y: 0.22,
        source_scale: 0.46,
        quasar_core: 0.95,
        source_orbit_speed: 0.18,
        extra_field_galaxies: 0.35,
        show_caustics: 1,
        show_fermat: 0,
        cluster_light: 0.85,
        icm_glow: 0.30,
        sky_intensity: 0.68,
        sky_mode: 0,
        exposure: 1.10,
        bloom: 0.56,
        anamorphic: 0.34,
        radius: 13.0,
        elevation_deg: 4.0,
        azimuth_deg: 4.0,
        roll_deg: 0.0,
        fov_deg: 40.0,
        auto_orbit: false,
    },
    LensPreset {
        meta: PresetMeta {
            id: "microlensing",
            full_name: "Microlensing Flash",
            short_label: "Microlensing",
            hotkey: "5",
        },
        lens_model: 0,
        einstein_radius: 1.65,
        ellipticity: 0.0,
        ext_shear: 0.14,
        lens_angle_deg: 0.0,
        shear_angle_deg: 25.0,
        subhalo_strength: 0.0,
        source_x: 0.16,
        source_y: 0.05,
        source_scale: 0.24,
        quasar_core: 1.85,
        source_orbit_speed: 0.28,
        extra_field_galaxies: 0.30,
        show_caustics: 1,
        show_fermat: 0,
        cluster_light: 0.18,
        icm_glow: 0.12,
        sky_intensity: 0.78,
        sky_mode: 0,
        exposure: 1.15,
        bloom: 0.68,
        anamorphic: 0.48,
        radius: 11.2,
        elevation_deg: 2.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 38.0,
        auto_orbit: false,
    },
    LensPreset {
        meta: PresetMeta {
            id: "caustic_fermat",
            full_name: "Caustic & Fermat Bench",
            short_label: "Fermat Bench",
            hotkey: "6",
        },
        lens_model: 1,
        einstein_radius: 2.20,
        ellipticity: 0.38,
        ext_shear: 0.12,
        lens_angle_deg: 24.0,
        shear_angle_deg: -35.0,
        subhalo_strength: 0.0,
        source_x: 0.10,
        source_y: 0.05,
        source_scale: 0.32,
        quasar_core: 0.90,
        source_orbit_speed: 0.0,
        extra_field_galaxies: 0.18,
        show_caustics: 1,
        show_fermat: 1,
        cluster_light: 0.70,
        icm_glow: 0.20,
        sky_intensity: 0.62,
        sky_mode: 0,
        exposure: 1.08,
        bloom: 0.50,
        anamorphic: 0.30,
        radius: 13.8,
        elevation_deg: 0.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 40.0,
        auto_orbit: false,
    },
];

#[derive(Debug, Clone, Copy)]
pub struct NfwFunctions {
    pub g: f64,
    pub f: f64,
    pub h_psi: f64,
}

pub fn eval_nfw_functions(raw_x: f64) -> NfwFunctions {
    let x = raw_x.max(1e-4);
    let ln_half_x = (0.5 * x).ln();
    let d = x - 1.0;

    let (c, f) = if d.abs() < 0.02 {
        let c_val =
            1.0 + d * (-2.0 / 3.0 + d * (7.0 / 15.0 + d * (-12.0 / 35.0 + d * (83.0 / 315.0))));
        let f_val =
            (2.0 / 3.0 + d * (-7.0 / 15.0 + d * (12.0 / 35.0 - d * (83.0 / 315.0)))) / (2.0 + d);
        (c_val, f_val)
    } else if x < 1.0 {
        let one_minus_x2 = 1.0 - x * x;
        let sq = one_minus_x2.sqrt();
        let c_val = (1.0 / x).acosh() / sq;
        let f_val = (c_val - 1.0) / one_minus_x2;
        (c_val, f_val)
    } else {
        let x2_minus_1 = x * x - 1.0;
        let sq = x2_minus_1.sqrt();
        let c_val = (1.0 / x).acos() / sq;
        let f_val = (1.0 - c_val) / x2_minus_1;
        (c_val, f_val)
    };

    let g = ln_half_x + c;
    let h_psi = ln_half_x * ln_half_x + (x * x - 1.0) * c * c;
    NfwFunctions { g, f, h_psi }
}

#[derive(Default)]
struct LensAcc {
    psi: f64,
    ax: f64,
    ay: f64,
    psi_xx: f64,
    psi_yy: f64,
    psi_xy: f64,
}

fn add_softened_sie(acc: &mut LensAcc, tx: f64, ty: f64, b: f64, q: f64, s: f64, angle_rad: f64) {
    let c = angle_rad.cos();
    let si = angle_rad.sin();
    let xp = c * tx + si * ty;
    let yp = -si * tx + c * ty;

    let q_clamped = q.clamp(0.25, 1.0);
    let q2 = q_clamped * q_clamped;
    let qp2 = 1.0 - q2;
    let psi_k = (q2 * (s * s + xp * xp) + yp * yp + 1e-12).sqrt();

    let (axp, ayp, d_psi, pxxp, pyyp, pxyp) = if qp2 < 1e-6 {
        let denom = (psi_k + s).max(1e-7);
        let inv_d = 1.0 / denom;
        let inv_psi = 1.0 / psi_k.max(1e-7);
        let ax = b * xp * inv_d;
        let ay = b * yp * inv_d;
        let dp = b * (psi_k - s - s * (0.5 * denom / s.max(1e-6)).ln());
        let pxx = b * inv_d * (1.0 - xp * xp * inv_psi * inv_d);
        let pyy = b * inv_d * (1.0 - yp * yp * inv_psi * inv_d);
        let pxy = -b * xp * yp * inv_psi * inv_d * inv_d;
        (ax, ay, dp, pxx, pyy, pxy)
    } else {
        let qp = qp2.sqrt();
        let ps = (psi_k + s).max(1e-7);
        let pqs = (psi_k + q2 * s).max(1e-7);
        let b_sqrt_q = b * q_clamped.sqrt();
        let ax = (b_sqrt_q / qp) * ((qp * xp) / ps).atan();
        let ay = (b_sqrt_q / qp) * ((qp * yp) / pqs).clamp(-0.999999, 0.999999).atanh();

        let d_k = (xp * xp + yp * yp + (1.0 + q2) * s * s + 2.0 * s * psi_k).max(1e-9);
        let inv_psi_dk = 1.0 / (psi_k * d_k).max(1e-10);
        let ref_dk = ((1.0 + q2) * s * s + 2.0 * s * q_clamped * s).max(1e-12);
        let dp = xp * ax + yp * ay - 0.5 * b_sqrt_q * s * (d_k / ref_dk).max(1e-12).ln();

        let pxx = b_sqrt_q * (q2 * s * s + yp * yp + s * psi_k) * inv_psi_dk;
        let pyy = b_sqrt_q * (xp * xp + s * s + s * psi_k) * inv_psi_dk;
        let pxy = -b_sqrt_q * xp * yp * inv_psi_dk;
        (ax, ay, dp, pxx, pyy, pxy)
    };

    acc.psi += d_psi;
    acc.ax += c * axp - si * ayp;
    acc.ay += si * axp + c * ayp;

    let c2 = c * c;
    let s2 = si * si;
    let cs = c * si;
    acc.psi_xx += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
    acc.psi_yy += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
    acc.psi_xy += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;
}

#[derive(Debug, Clone, Copy)]
pub struct LensField {
    pub psi: f64,
    pub ax: f64,
    pub ay: f64,
    pub psi_xx: f64,
    pub psi_yy: f64,
    pub psi_xy: f64,
    pub kappa: f64,
    pub gamma1: f64,
    pub gamma2: f64,
    pub gamma: f64,
    pub det_a: f64,
    pub lambda_t: f64,
    pub lambda_r: f64,
    pub mu: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn eval_lens_field(
    tx: f64,
    ty: f64,
    lens_model: i32,
    einstein_radius: f64,
    ellipticity: f64,
    ext_shear: f64,
    lens_angle_deg: f64,
    shear_angle_deg: f64,
    subhalo_strength: f64,
) -> LensField {
    let theta_e = einstein_radius.max(0.25);
    let ellip = ellipticity.clamp(0.0, 0.72);
    let shear = ext_shear.clamp(0.0, 0.40);
    let lens_angle_rad = lens_angle_deg.to_radians();
    let shear_angle_rad = shear_angle_deg.to_radians();
    let subhalo = subhalo_strength.clamp(0.0, 3.0);

    let mut acc = LensAcc::default();

    if lens_model == 0 {
        let eps = POINT_SOFTENING_FRAC * theta_e;
        let r2 = tx * tx + ty * ty + eps * eps;
        let te2 = theta_e * theta_e;
        let inv_r2 = 1.0 / r2;
        let inv_r4 = inv_r2 * inv_r2;

        acc.psi += 0.5 * te2 * (r2 / (eps * eps).max(1e-12)).ln();
        acc.ax += te2 * tx * inv_r2;
        acc.ay += te2 * ty * inv_r2;
        acc.psi_xx += te2 * (r2 - 2.0 * tx * tx) * inv_r4;
        acc.psi_yy += te2 * (r2 - 2.0 * ty * ty) * inv_r4;
        acc.psi_xy += -2.0 * te2 * tx * ty * inv_r4;
    } else if lens_model == 1 {
        let q = (1.0 - ellip).clamp(0.25, 1.0);
        let s = SIE_CORE_FRAC * theta_e;
        add_softened_sie(&mut acc, tx, ty, theta_e, q, s, lens_angle_rad);
    } else {
        let c = lens_angle_rad.cos();
        let si = lens_angle_rad.sin();
        let xp = c * tx + si * ty;
        let yp = -si * tx + c * ty;

        let q = (1.0 - ellip).clamp(0.30, 1.0);
        let q2 = q * q;
        let q4 = q2 * q2;
        let rs = NFW_RS_RATIO * theta_e;
        let core = NFW_CORE_FRAC * theta_e;
        let x_e = theta_e / rs;
        let g_xe = eval_nfw_functions(x_e).g;
        let four_ks = (theta_e * x_e) / (rs * g_xe).max(1e-8);

        let r2 = q2 * xp * xp + yp * yp + core * core;
        let r = r2.sqrt();
        let u = r / rs;
        let nfw = eval_nfw_functions(u);

        let psi_norm = 0.5 * four_ks * rs * rs;
        let a1 = four_ks * (nfw.g / (u * u));
        let kappa_rad = 0.5 * four_ks * nfw.f;
        let a2 = (2.0 * (kappa_rad - a1)) / r2.max(1e-9);

        acc.psi += psi_norm * nfw.h_psi;
        let axp = a1 * q2 * xp;
        let ayp = a1 * yp;
        acc.ax += c * axp - si * ayp;
        acc.ay += si * axp + c * ayp;

        let pxxp = q2 * a1 + q4 * xp * xp * a2;
        let pyyp = a1 + yp * yp * a2;
        let pxyp = q2 * xp * yp * a2;

        let c2 = c * c;
        let s2 = si * si;
        let cs = c * si;
        acc.psi_xx += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
        acc.psi_yy += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
        acc.psi_xy += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;

        if subhalo > 1e-5 {
            let cluster_scale = theta_e / 2.85;
            for sh in &SUBHALOS {
                let sx0 = sh.x * cluster_scale;
                let sy0 = sh.y * cluster_scale;
                let b_sh = sh.b_frac * theta_e * subhalo;
                let s_sh = sh.core_frac * theta_e;
                let q_sh = (1.0 - sh.ellip).clamp(0.45, 1.0);
                add_softened_sie(&mut acc, tx - sx0, ty - sy0, b_sh, q_sh, s_sh, sh.angle_rad);
            }
        }
    }

    if shear > 1e-6 {
        let g1 = shear * (2.0 * shear_angle_rad).cos();
        let g2 = shear * (2.0 * shear_angle_rad).sin();
        acc.psi += 0.5 * (g1 * (tx * tx - ty * ty) + 2.0 * g2 * tx * ty);
        acc.ax += g1 * tx + g2 * ty;
        acc.ay += g2 * tx - g1 * ty;
        acc.psi_xx += g1;
        acc.psi_yy -= g1;
        acc.psi_xy += g2;
    }

    let kappa = 0.5 * (acc.psi_xx + acc.psi_yy);
    let gamma1 = 0.5 * (acc.psi_xx - acc.psi_yy);
    let gamma2 = acc.psi_xy;
    let gamma = gamma1.hypot(gamma2);

    let a11 = 1.0 - acc.psi_xx;
    let a22 = 1.0 - acc.psi_yy;
    let a12 = -acc.psi_xy;
    let det_a = a11 * a22 - a12 * a12;
    let lambda_t = 1.0 - kappa - gamma;
    let lambda_r = 1.0 - kappa + gamma;
    let mu = 1.0 / det_a.abs().max(1e-3);

    LensField {
        psi: acc.psi,
        ax: acc.ax,
        ay: acc.ay,
        psi_xx: acc.psi_xx,
        psi_yy: acc.psi_yy,
        psi_xy: acc.psi_xy,
        kappa,
        gamma1,
        gamma2,
        gamma,
        det_a,
        lambda_t,
        lambda_r,
        mu,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn eval_fermat_potential(
    tx: f64,
    ty: f64,
    sx: f64,
    sy: f64,
    lens_model: i32,
    einstein_radius: f64,
    ellipticity: f64,
    ext_shear: f64,
    lens_angle_deg: f64,
    shear_angle_deg: f64,
    subhalo_strength: f64,
) -> f64 {
    let field = eval_lens_field(
        tx,
        ty,
        lens_model,
        einstein_radius,
        ellipticity,
        ext_shear,
        lens_angle_deg,
        shear_angle_deg,
        subhalo_strength,
    );
    let dx = tx - sx;
    let dy = ty - sy;
    0.5 * (dx * dx + dy * dy) - field.psi
}

#[derive(Debug, Clone, Copy)]
pub struct PointMassExact {
    pub u: f64,
    pub theta_plus: f64,
    pub theta_minus: f64,
    pub mu_tot: f64,
    pub mu_plus: f64,
    pub mu_minus: f64,
    pub time_delay_days: f64,
}

pub fn eval_point_mass_exact(u_norm: f64, theta_e: f64) -> PointMassExact {
    let u = u_norm.abs().max(1e-4);
    let sq = (u * u + 4.0).sqrt();
    let theta_plus = 0.5 * theta_e * (u + sq);
    let theta_minus = 0.5 * theta_e * (u - sq);
    let mu_tot = (u * u + 2.0) / (u * sq);
    let mu_plus = 0.5 * (mu_tot + 1.0);
    let mu_minus = 0.5 * (1.0 - mu_tot);
    let d_tau_dimless = 0.5 * u * sq + ((sq + u) / (sq - u)).ln();
    let delta_tau_arcsec2 = theta_e * theta_e * d_tau_dimless;
    PointMassExact {
        u,
        theta_plus,
        theta_minus,
        mu_tot,
        mu_plus,
        mu_minus,
        time_delay_days: TIME_DELAY_DAYS_PER_ARCSEC2 * delta_tau_arcsec2,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LensedImage {
    pub x: f64,
    pub y: f64,
    pub mu: f64,
    pub parity: i32,
    pub tau: f64,
}

pub struct SolvedImages {
    pub is_einstein_ring: bool,
    pub images: Vec<LensedImage>,
    pub total_mag: f64,
    pub time_delay_days: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn solve_lensed_images(
    lens_model: i32,
    einstein_radius: f64,
    ellipticity: f64,
    ext_shear: f64,
    lens_angle_deg: f64,
    shear_angle_deg: f64,
    subhalo_strength: f64,
    source_x: f64,
    source_y: f64,
) -> SolvedImages {
    let theta_e = einstein_radius.max(0.25);
    let sx = source_x;
    let sy = source_y;
    let offset = sx.hypot(sy);

    if lens_model == 0 && ext_shear < 1e-4 && offset < 0.02 * theta_e {
        let u_eff = (offset / theta_e).max(0.015);
        let ex = eval_point_mass_exact(u_eff, theta_e);
        return SolvedImages {
            is_einstein_ring: true,
            images: vec![
                LensedImage {
                    x: theta_e,
                    y: 0.0,
                    mu: ex.mu_plus,
                    parity: 1,
                    tau: eval_fermat_potential(
                        theta_e,
                        0.0,
                        sx,
                        sy,
                        lens_model,
                        theta_e,
                        ellipticity,
                        ext_shear,
                        lens_angle_deg,
                        shear_angle_deg,
                        subhalo_strength,
                    ),
                },
                LensedImage {
                    x: -theta_e,
                    y: 0.0,
                    mu: ex.mu_minus.abs(),
                    parity: -1,
                    tau: eval_fermat_potential(
                        -theta_e,
                        0.0,
                        sx,
                        sy,
                        lens_model,
                        theta_e,
                        ellipticity,
                        ext_shear,
                        lens_angle_deg,
                        shear_angle_deg,
                        subhalo_strength,
                    ),
                },
            ],
            total_mag: ex.mu_tot,
            time_delay_days: 0.0,
        };
    }

    const N: usize = 40;
    let extent = 3.1 * theta_e;
    let step = (2.0 * extent) / (N as f64 - 1.0);
    let mut rx_grid = vec![0.0_f64; N * N];
    let mut ry_grid = vec![0.0_f64; N * N];
    let mut err2_grid = vec![0.0_f64; N * N];

    for iy in 0..N {
        let ty = -extent + (iy as f64) * step;
        for ix in 0..N {
            let tx = -extent + (ix as f64) * step;
            let f = eval_lens_field(
                tx,
                ty,
                lens_model,
                theta_e,
                ellipticity,
                ext_shear,
                lens_angle_deg,
                shear_angle_deg,
                subhalo_strength,
            );
            let rx = tx - f.ax - sx;
            let ry = ty - f.ay - sy;
            let idx = iy * N + ix;
            rx_grid[idx] = rx;
            ry_grid[idx] = ry;
            err2_grid[idx] = rx * rx + ry * ry;
        }
    }

    let mut seeds: Vec<(f64, f64, f64)> = Vec::new();
    for iy in 0..(N - 1) {
        for ix in 0..(N - 1) {
            let i00 = iy * N + ix;
            let i10 = i00 + 1;
            let i01 = i00 + N;
            let i11 = i01 + 1;
            let rx_min = rx_grid[i00]
                .min(rx_grid[i10])
                .min(rx_grid[i01])
                .min(rx_grid[i11]);
            let rx_max = rx_grid[i00]
                .max(rx_grid[i10])
                .max(rx_grid[i01])
                .max(rx_grid[i11]);
            let ry_min = ry_grid[i00]
                .min(ry_grid[i10])
                .min(ry_grid[i01])
                .min(ry_grid[i11]);
            let ry_max = ry_grid[i00]
                .max(ry_grid[i10])
                .max(ry_grid[i01])
                .max(ry_grid[i11]);
            if rx_min <= 0.0 && rx_max >= 0.0 && ry_min <= 0.0 && ry_max >= 0.0 {
                let cx = -extent + (ix as f64 + 0.5) * step;
                let cy = -extent + (iy as f64 + 0.5) * step;
                let v = err2_grid[i00]
                    .min(err2_grid[i10])
                    .min(err2_grid[i01])
                    .min(err2_grid[i11]);
                seeds.push((cx, cy, v));
            }
        }
    }

    for iy in 0..N {
        for ix in 0..N {
            let v = err2_grid[iy * N + ix];
            let mut is_local_min = true;
            for dy in -1_isize..=1 {
                if !is_local_min {
                    break;
                }
                for dx in -1_isize..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = ix as isize + dx;
                    let ny = iy as isize + dy;
                    if nx >= 0
                        && nx < N as isize
                        && ny >= 0
                        && ny < N as isize
                        && err2_grid[(ny as usize) * N + (nx as usize)] < v
                    {
                        is_local_min = false;
                        break;
                    }
                }
            }
            if is_local_min {
                seeds.push((
                    -extent + (ix as f64) * step,
                    -extent + (iy as f64) * step,
                    v,
                ));
            }
        }
    }

    for r_frac in [0.45_f64, 0.85, 1.0, 1.18, 1.5] {
        let r_seed = r_frac * theta_e;
        for k in 0..24 {
            let ang = (k as f64) * std::f64::consts::TAU / 24.0;
            seeds.push((sx + r_seed * ang.cos(), sy + r_seed * ang.sin(), 1.0));
        }
    }
    seeds.sort_by(|a, b| a.2.total_cmp(&b.2));

    let mut found: Vec<LensedImage> = Vec::new();
    let res_tol2 = (1e-4 * theta_e) * (1e-4 * theta_e);
    let merge_dist2 = (0.04 * theta_e) * (0.04 * theta_e);

    for &(s_tx, s_ty, _) in &seeds {
        let mut tx = s_tx;
        let mut ty = s_ty;
        let mut converged = false;

        for _ in 0..20 {
            let f = eval_lens_field(
                tx,
                ty,
                lens_model,
                theta_e,
                ellipticity,
                ext_shear,
                lens_angle_deg,
                shear_angle_deg,
                subhalo_strength,
            );
            let rx = tx - f.ax - sx;
            let ry = ty - f.ay - sy;
            if rx * rx + ry * ry < res_tol2 {
                converged = true;
                break;
            }
            let a11 = 1.0 - f.psi_xx;
            let a22 = 1.0 - f.psi_yy;
            let a12 = -f.psi_xy;
            let det = a11 * a22 - a12 * a12;
            if det.abs() < 1e-8 {
                break;
            }
            let dtx = (a22 * rx - a12 * ry) / det;
            let dty = (-a12 * rx + a11 * ry) / det;
            let step_len = dtx.hypot(dty);
            let max_step = 0.75 * step;
            let scale = if step_len > max_step {
                max_step / step_len
            } else {
                1.0
            };
            tx -= dtx * scale;
            ty -= dty * scale;
            if tx.hypot(ty) > 4.5 * theta_e {
                break;
            }
        }

        if !converged {
            continue;
        }
        let f_final = eval_lens_field(
            tx,
            ty,
            lens_model,
            theta_e,
            ellipticity,
            ext_shear,
            lens_angle_deg,
            shear_angle_deg,
            subhalo_strength,
        );
        let rx = tx - f_final.ax - sx;
        let ry = ty - f_final.ay - sy;
        if rx * rx + ry * ry >= res_tol2 {
            continue;
        }

        if found
            .iter()
            .any(|im| (tx - im.x) * (tx - im.x) + (ty - im.y) * (ty - im.y) < merge_dist2)
        {
            continue;
        }

        let abs_mu = 1.0 / f_final.det_a.abs().max(1e-3);
        if abs_mu < 0.04 {
            continue;
        }

        let tau = eval_fermat_potential(
            tx,
            ty,
            sx,
            sy,
            lens_model,
            theta_e,
            ellipticity,
            ext_shear,
            lens_angle_deg,
            shear_angle_deg,
            subhalo_strength,
        );
        found.push(LensedImage {
            x: tx,
            y: ty,
            mu: abs_mu.min(85.0),
            parity: if f_final.det_a >= 0.0 { 1 } else { -1 },
            tau,
        });
    }

    let mut total_mag = 0.0_f64;
    let mut tau_min = f64::INFINITY;
    let mut tau_max = f64::NEG_INFINITY;
    for im in &found {
        total_mag += im.mu;
        if im.tau < tau_min {
            tau_min = im.tau;
        }
        if im.tau > tau_max {
            tau_max = im.tau;
        }
    }
    total_mag = total_mag.clamp(1.0, 250.0);
    let delta_tau = if found.len() >= 2 {
        (tau_max - tau_min).max(0.0)
    } else {
        0.0
    };

    SolvedImages {
        is_einstein_ring: false,
        images: found,
        total_mag,
        time_delay_days: TIME_DELAY_DAYS_PER_ARCSEC2 * delta_tau,
    }
}

pub struct LensTelemetry {
    pub lens_model_label: &'static str,
    pub einstein_radius_arcsec: f64,
    pub enclosed_mass_1e12_msun: f64,
    pub total_magnification: f64,
    pub multiplicity_label: String,
    pub time_delay_days: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn compute_lens_telemetry(
    lens_model: i32,
    einstein_radius: f64,
    ellipticity: f64,
    ext_shear: f64,
    lens_angle_deg: f64,
    shear_angle_deg: f64,
    subhalo_strength: f64,
    source_x: f64,
    source_y: f64,
) -> LensTelemetry {
    let idx = (lens_model as usize).min(LENS_MODEL_LABELS.len() - 1);
    let lens_model_label = LENS_MODEL_LABELS[idx];
    let theta_e = einstein_radius.max(0.25);

    let solved = solve_lensed_images(
        lens_model,
        theta_e,
        ellipticity,
        ext_shear,
        lens_angle_deg,
        shear_angle_deg,
        subhalo_strength,
        source_x,
        source_y,
    );
    let image_count = if solved.is_einstein_ring {
        1
    } else {
        solved.images.len()
    };
    let multiplicity_label = if solved.is_einstein_ring {
        "Ring".to_string()
    } else if image_count == 2 {
        "2 (Double)".to_string()
    } else if image_count == 3 {
        "3 (Cusp)".to_string()
    } else if image_count == 4 {
        "4 (Quad)".to_string()
    } else if image_count >= 5 {
        format!("{image_count} (Cluster)")
    } else {
        format!("{} (Single)", image_count.max(1))
    };

    let subhalo_boost = if lens_model == 2 {
        1.0 + 0.08 * subhalo_strength
    } else {
        1.0
    };
    let enclosed_mass_1e12_msun = MASS_PER_ARCSEC2_1E12_MSUN * theta_e * theta_e * subhalo_boost;

    LensTelemetry {
        lens_model_label,
        einstein_radius_arcsec: theta_e,
        enclosed_mass_1e12_msun,
        total_magnification: solved.total_mag,
        multiplicity_label,
        time_delay_days: solved.time_delay_days,
    }
}

struct OrbitPose {
    pos: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

fn compute_orbit_pose(r: f32, azimuth: f32, elevation: f32, roll: f32) -> OrbitPose {
    let (cel, sel) = (elevation.cos(), elevation.sin());
    let (caz, saz) = (azimuth.cos(), azimuth.sin());
    let ux = cel * saz;
    let uy = sel;
    let uz = cel * caz;

    let (fx, fy, fz) = (-ux, -uy, -uz);
    let mut r0x = -fz;
    let mut r0z = fx;
    let r0_len = r0x.hypot(r0z);
    if r0_len < 1e-6 {
        r0x = caz;
        r0z = -saz;
    } else {
        r0x /= r0_len;
        r0z /= r0_len;
    }
    let mut u0x = -r0z * fy;
    let mut u0y = r0z * fx - r0x * fz;
    let mut u0z = r0x * fy;
    let u0_len = (u0x * u0x + u0y * u0y + u0z * u0z).sqrt().max(1e-6);
    u0x /= u0_len;
    u0y /= u0_len;
    u0z /= u0_len;

    let (cr, sr) = (roll.cos(), roll.sin());
    OrbitPose {
        pos: [ux * r, uy * r, uz * r],
        right: [cr * r0x + sr * u0x, sr * u0y, cr * r0z + sr * u0z],
        up: [-sr * r0x + cr * u0x, cr * u0y, -sr * r0z + cr * u0z],
        forward: [fx, fy, fz],
    }
}

struct CameraFlight {
    elapsed: f32,
    duration: f32,
    start_log_r: f32,
    start_el: f32,
    start_az: f32,
    start_roll: f32,
    start_fov: f32,
    end_log_r: f32,
    end_el: f32,
    end_az: f32,
    end_roll: f32,
    end_fov: f32,
}

struct LensCamera {
    log_r: f32,
    el: f32,
    az: f32,
    roll: f32,
    fov: f32,
    target_log_r: f32,
    target_el: f32,
    target_az: f32,
    target_roll: f32,
    target_fov: f32,
    vel_log_r: f32,
    vel_el: f32,
    vel_az: f32,
    vel_roll: f32,
    vel_fov: f32,
    flight: Option<CameraFlight>,
    auto_time: f32,
    auto_base_el: f32,
    cooldown: f32,
    pose: OrbitPose,
    moved: bool,
}

impl LensCamera {
    fn from_preset(p: &LensPreset) -> Self {
        let log_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS).ln();
        let el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az = p.azimuth_deg * DEG2RAD;
        let roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let pose = compute_orbit_pose(log_r.exp(), az, el, roll);
        Self {
            log_r,
            el,
            az,
            roll,
            fov,
            target_log_r: log_r,
            target_el: el,
            target_az: az,
            target_roll: roll,
            target_fov: fov,
            vel_log_r: 0.0,
            vel_el: 0.0,
            vel_az: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            flight: None,
            auto_time: 0.0,
            auto_base_el: el,
            cooldown: 0.0,
            pose,
            moved: true,
        }
    }

    fn radius(&self) -> f32 {
        self.log_r.exp()
    }

    fn fly_to(&mut self, p: &LensPreset, duration: f32) {
        let dest_log_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS).ln();
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az_raw = p.azimuth_deg * DEG2RAD;
        let dest_az = self.az + wrap_angle_delta(dest_az_raw - self.az);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        if duration <= 0.0 {
            self.flight = None;
            self.log_r = dest_log_r;
            self.target_log_r = dest_log_r;
            self.el = dest_el;
            self.target_el = dest_el;
            self.az = dest_az_raw;
            self.target_az = dest_az_raw;
            self.roll = dest_roll;
            self.target_roll = dest_roll;
            self.fov = dest_fov;
            self.target_fov = dest_fov;
            self.vel_log_r = 0.0;
            self.vel_el = 0.0;
            self.vel_az = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.auto_base_el = dest_el;
            self.auto_time = 0.0;
            self.cooldown = 0.0;
            self.pose = compute_orbit_pose(self.radius(), self.az, self.el, self.roll);
            self.moved = true;
            return;
        }

        self.flight = Some(CameraFlight {
            elapsed: 0.0,
            duration,
            start_log_r: self.log_r,
            start_el: self.el,
            start_az: self.az,
            start_roll: self.roll,
            start_fov: self.fov,
            end_log_r: dest_log_r,
            end_el: dest_el,
            end_az: dest_az,
            end_roll: dest_roll,
            end_fov: dest_fov,
        });
        self.vel_log_r = 0.0;
        self.vel_el = 0.0;
        self.vel_az = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.cooldown = 0.0;
    }

    fn mark_user_interaction(&mut self) {
        if let Some(_f) = self.flight.take() {
            self.target_log_r = self.log_r;
            self.target_el = self.el;
            self.target_az = self.az;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
        }
        self.cooldown = INTERACTION_COOLDOWN;
        self.auto_base_el = self.target_el;
        self.auto_time = 0.0;
    }

    fn update(
        &mut self,
        dt: f32,
        paused: bool,
        auto_orbit: bool,
        input: &SimInput,
        drag_mode: bool,
    ) {
        let min_dim = input.viewport_w.min(input.viewport_h).max(320.0);
        let scale = 1.0 / min_dim;

        if !drag_mode && !input.shift_down && input.primary_drag {
            self.target_az -= input.drag_delta[0] * scale * 2.8;
            self.target_el = (self.target_el + input.drag_delta[1] * scale * 2.2)
                .clamp(MIN_ELEVATION, MAX_ELEVATION);
            self.mark_user_interaction();
        }
        if input.secondary_drag {
            self.target_roll =
                (self.target_roll + input.drag_delta[0] * scale * 2.2).clamp(MIN_ROLL, MAX_ROLL);
            self.mark_user_interaction();
        }
        if input.scroll_y.abs() > 1e-4 {
            let delta = (input.scroll_y * 12.0).clamp(-240.0, 240.0);
            self.target_log_r =
                (self.target_log_r + delta * 0.0011).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            self.mark_user_interaction();
        }

        if input.any_key_held() {
            let mut key_moved = false;
            if input.key_w {
                self.target_log_r =
                    (self.target_log_r - 0.85 * dt).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
                key_moved = true;
            }
            if input.key_s {
                self.target_log_r =
                    (self.target_log_r + 0.85 * dt).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
                key_moved = true;
            }
            if input.key_a || input.key_left {
                self.target_az -= 0.95 * dt;
                key_moved = true;
            }
            if input.key_d || input.key_right {
                self.target_az += 0.95 * dt;
                key_moved = true;
            }
            if input.key_up {
                self.target_el = (self.target_el + 0.72 * dt).clamp(MIN_ELEVATION, MAX_ELEVATION);
                key_moved = true;
            }
            if input.key_down {
                self.target_el = (self.target_el - 0.72 * dt).clamp(MIN_ELEVATION, MAX_ELEVATION);
                key_moved = true;
            }
            if input.key_q {
                self.target_roll = (self.target_roll - 1.05 * dt).clamp(MIN_ROLL, MAX_ROLL);
                key_moved = true;
            }
            if input.key_e {
                self.target_roll = (self.target_roll + 1.05 * dt).clamp(MIN_ROLL, MAX_ROLL);
                key_moved = true;
            }
            if key_moved {
                self.mark_user_interaction();
            }
        }

        let prev = (self.log_r, self.el, self.az, self.roll, self.fov);
        if let Some(mut f) = self.flight.take() {
            f.elapsed += dt;
            let u = (f.elapsed / f.duration.max(1e-4)).clamp(0.0, 1.0);
            let e = ease_out_cubic(u);
            self.log_r = f.start_log_r + (f.end_log_r - f.start_log_r) * e;
            self.target_log_r = self.log_r;
            self.el = f.start_el + (f.end_el - f.start_el) * e;
            self.target_el = self.el;
            self.az = f.start_az + (f.end_az - f.start_az) * e;
            self.target_az = self.az;
            self.roll = f.start_roll + (f.end_roll - f.start_roll) * e;
            self.target_roll = self.roll;
            self.fov = f.start_fov + (f.end_fov - f.start_fov) * e;
            self.target_fov = self.fov;
            if u < 1.0 {
                self.flight = Some(f);
            } else {
                self.auto_base_el = self.el;
                self.auto_time = 0.0;
            }
        } else {
            if self.cooldown > 0.0 {
                self.cooldown = (self.cooldown - dt).max(0.0);
            } else if !paused && auto_orbit && !input.primary_drag && !input.secondary_drag {
                self.auto_time += dt;
                self.target_az += AUTO_ORBIT_SPEED * dt;
                self.target_el = (self.auto_base_el + (self.auto_time * 0.25).sin() * 0.012)
                    .clamp(MIN_ELEVATION, MAX_ELEVATION);
            }

            let (nlr, vlr) = step_critically_damped(
                self.log_r,
                self.vel_log_r,
                self.target_log_r,
                SPRING_OMEGA,
                dt,
            );
            let (nel, vel) =
                step_critically_damped(self.el, self.vel_el, self.target_el, SPRING_OMEGA, dt);
            let (naz, vaz) =
                step_critically_damped(self.az, self.vel_az, self.target_az, SPRING_OMEGA, dt);
            let (nro, vro) = step_critically_damped(
                self.roll,
                self.vel_roll,
                self.target_roll,
                SPRING_OMEGA,
                dt,
            );
            let (nfo, vfo) =
                step_critically_damped(self.fov, self.vel_fov, self.target_fov, SPRING_OMEGA, dt);
            self.log_r = nlr;
            self.vel_log_r = vlr;
            self.el = nel;
            self.vel_el = vel;
            self.az = naz;
            self.vel_az = vaz;
            self.roll = nro;
            self.vel_roll = vro;
            self.fov = nfo;
            self.vel_fov = vfo;
        }

        self.moved = (self.log_r - prev.0).abs() > 1e-6
            || (self.el - prev.1).abs() > 1e-6
            || (self.az - prev.2).abs() > 1e-6
            || (self.roll - prev.3).abs() > 1e-6
            || (self.fov - prev.4).abs() > 1e-6;
        self.pose = compute_orbit_pose(self.radius(), self.az, self.el, self.roll);
    }
}

pub struct LensClusterSim {
    active_preset: Option<usize>,
    lens_model: i32,
    einstein_radius: f32,
    ellipticity: f32,
    ext_shear: f32,
    lens_angle_deg: f32,
    shear_angle_deg: f32,
    subhalo_strength: f32,
    source_x: f32,
    source_y: f32,
    source_scale: f32,
    quasar_core: f32,
    source_orbit_speed: f32,
    extra_field_galaxies: f32,
    show_caustics: i32,
    show_fermat: i32,
    drag_mode: bool,
    cluster_light: f32,
    icm_glow: f32,
    sky_intensity: f32,
    sky_mode: i32,
    quality: i32,
    resolution_scale: f32,
    exposure: f32,
    bloom_intensity: f32,
    anamorphic_intensity: f32,

    paused: bool,
    auto_orbit: bool,
    sim_time: f32,
    orbit_angle: f32,
    orbit_angle_init: bool,
    camera: LensCamera,

    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl LensClusterSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[2]; // Default preset is jwst_cluster
        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::LensCluster,
            "lens-cluster",
            SimBglKind::Standard,
            shaders::LENS_CLUSTER,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lens-cluster-ubo"),
            size: std::mem::size_of::<LensClusterUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("lens-cluster-bg", &ubo, None);

        Self {
            active_preset: Some(2),
            lens_model: p.lens_model,
            einstein_radius: p.einstein_radius,
            ellipticity: p.ellipticity,
            ext_shear: p.ext_shear,
            lens_angle_deg: p.lens_angle_deg,
            shear_angle_deg: p.shear_angle_deg,
            subhalo_strength: p.subhalo_strength,
            source_x: p.source_x,
            source_y: p.source_y,
            source_scale: p.source_scale,
            quasar_core: p.quasar_core,
            source_orbit_speed: p.source_orbit_speed,
            extra_field_galaxies: p.extra_field_galaxies,
            show_caustics: p.show_caustics,
            show_fermat: p.show_fermat,
            drag_mode: false,
            cluster_light: p.cluster_light,
            icm_glow: p.icm_glow,
            sky_intensity: p.sky_intensity,
            sky_mode: p.sky_mode,
            quality: 1,
            resolution_scale: 1.0,
            exposure: p.exposure,
            bloom_intensity: p.bloom,
            anamorphic_intensity: p.anamorphic,
            paused: false,
            auto_orbit: p.auto_orbit,
            sim_time: 0.0,
            orbit_angle: 0.0,
            orbit_angle_init: false,
            camera: LensCamera::from_preset(p),
            pipeline,
            ubo,
            bind_group,
        }
    }

    fn telemetry(&self) -> LensTelemetry {
        compute_lens_telemetry(
            self.lens_model,
            self.einstein_radius as f64,
            self.ellipticity as f64,
            self.ext_shear as f64,
            self.lens_angle_deg as f64,
            self.shear_angle_deg as f64,
            self.subhalo_strength as f64,
            self.source_x as f64,
            self.source_y as f64,
        )
    }

    fn build_uniforms(
        &self,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        is_progressive: bool,
    ) -> LensClusterUniforms {
        LensClusterUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_prog: [
                jitter[0],
                jitter[1],
                self.camera.fov,
                if is_progressive { 1.0 } else { 0.0 },
            ],
            cam_pos_unused: [
                self.camera.pose.pos[0],
                self.camera.pose.pos[1],
                self.camera.pose.pos[2],
                0.0,
            ],
            cam_right_model: [
                self.camera.pose.right[0],
                self.camera.pose.right[1],
                self.camera.pose.right[2],
                self.lens_model as f32,
            ],
            cam_up_theta_e: [
                self.camera.pose.up[0],
                self.camera.pose.up[1],
                self.camera.pose.up[2],
                self.einstein_radius,
            ],
            cam_fwd_ellip: [
                self.camera.pose.forward[0],
                self.camera.pose.forward[1],
                self.camera.pose.forward[2],
                self.ellipticity,
            ],
            lens_shape_params: [
                self.ext_shear,
                self.lens_angle_deg * DEG2RAD,
                self.shear_angle_deg * DEG2RAD,
                self.subhalo_strength,
            ],
            source_params: [
                self.source_x,
                self.source_y,
                self.source_scale,
                self.quasar_core,
            ],
            overlay_params: [
                if self.show_caustics != 0 { 1.0 } else { 0.0 },
                if self.show_fermat != 0 { 1.0 } else { 0.0 },
                if self.drag_mode { 1.0 } else { 0.0 },
                self.extra_field_galaxies,
            ],
            cluster_optics_params: [
                self.cluster_light,
                self.icm_glow,
                self.sky_intensity,
                self.sky_mode as f32,
            ],
            sky_quality_params: [0.48, 0.22, self.quality as f32, 0.0],
        }
    }
}

impl Simulation for LensClusterSim {
    fn id(&self) -> SimId {
        SimId::LensCluster
    }

    fn post_tuning(&self) -> PostTuning {
        PostTuning::lens_cluster()
    }

    fn post_params(&self, camera_moved: bool, sim_time: f32) -> PostFrameParams {
        let motion = camera_moved || (!self.paused && self.source_orbit_speed > 1e-4);
        PostFrameParams {
            exposure: self.exposure,
            bloom_intensity: self.bloom_intensity,
            anamorphic_intensity: self.anamorphic_intensity,
            paused: self.paused,
            camera_moved: motion,
            sim_time,
            resolution_scale: self.resolution_scale,
            tuning: PostTuning::lens_cluster(),
        }
    }

    fn presets(&self) -> &'static [PresetMeta] {
        const METAS: [PresetMeta; 6] = [
            PRESETS[0].meta,
            PRESETS[1].meta,
            PRESETS[2].meta,
            PRESETS[3].meta,
            PRESETS[4].meta,
            PRESETS[5].meta,
        ];
        &METAS
    }

    fn active_preset_index(&self) -> Option<usize> {
        self.active_preset
    }

    fn apply_preset(&mut self, index: usize) {
        if let Some(p) = PRESETS.get(index) {
            self.active_preset = Some(index);
            self.lens_model = p.lens_model;
            self.einstein_radius = p.einstein_radius;
            self.ellipticity = p.ellipticity;
            self.ext_shear = p.ext_shear;
            self.lens_angle_deg = p.lens_angle_deg;
            self.shear_angle_deg = p.shear_angle_deg;
            self.subhalo_strength = p.subhalo_strength;
            self.source_x = p.source_x;
            self.source_y = p.source_y;
            self.source_scale = p.source_scale;
            self.quasar_core = p.quasar_core;
            self.source_orbit_speed = p.source_orbit_speed;
            self.extra_field_galaxies = p.extra_field_galaxies;
            self.show_caustics = p.show_caustics;
            self.show_fermat = p.show_fermat;
            self.drag_mode = false;
            self.cluster_light = p.cluster_light;
            self.icm_glow = p.icm_glow;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.auto_orbit = p.auto_orbit;
            self.orbit_angle_init = false;
            self.camera.fly_to(p, 1.05);
        }
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        const SECTIONS: &[ControlSection] = &[
            ControlSection {
                id: "lens",
                title: "GRAVITATIONAL LENS POTENTIAL",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "lensModel",
                        label: "Mass Model",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Point Mass"), (1, "SIE Ellip"), (2, "NFW Cluster")],
                        },
                    },
                    ControlItem {
                        key: "einsteinRadius",
                        label: "Einstein Radius θ_E",
                        kind: ControlKind::Range {
                            min: 0.4,
                            max: 5.0,
                            step: 0.05,
                            hints: Some(["0.4″ (Micro)", "5.0″ (Massive)"]),
                        },
                    },
                    ControlItem {
                        key: "ellipticity",
                        label: "Halo Ellipticity (e)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 0.68,
                            step: 0.01,
                            hints: Some(["0.00 (Circular)", "0.68 (Quad)"]),
                        },
                    },
                    ControlItem {
                        key: "extShear",
                        label: "External Shear (γ_ext)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 0.30,
                            step: 0.01,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "lensAngleDeg",
                        label: "Lens Orientation",
                        kind: ControlKind::Range {
                            min: -90.0,
                            max: 90.0,
                            step: 1.0,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "subhaloStrength",
                        label: "Cluster Subhalos",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.2,
                            step: 0.05,
                            hints: None,
                        },
                    },
                ],
            },
            ControlSection {
                id: "source",
                title: "SOURCE PLANE & CAUSTIC OVERLAYS",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "dragMode",
                        label: "Pointer Mode (T)",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Orbit View"), (1, "Drag Source")],
                        },
                    },
                    ControlItem {
                        key: "sourceX",
                        label: "Source Offset X (β_x)",
                        kind: ControlKind::Range {
                            min: -3.2,
                            max: 3.2,
                            step: 0.01,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "sourceY",
                        label: "Source Offset Y (β_y)",
                        kind: ControlKind::Range {
                            min: -3.2,
                            max: 3.2,
                            step: 0.01,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "sourceScale",
                        label: "Source Galaxy Size",
                        kind: ControlKind::Range {
                            min: 0.15,
                            max: 1.4,
                            step: 0.02,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "quasarCore",
                        label: "Quasar Core Luminosity",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "showCaustics",
                        label: "Critical Curves & Caustics",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Off"), (1, "Show Curves")],
                        },
                    },
                    ControlItem {
                        key: "showFermat",
                        label: "Fermat Time Contours",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Off"), (1, "Show τ(θ)")],
                        },
                    },
                ],
            },
            ControlSection {
                id: "optics",
                title: "CLUSTER LIGHT, OPTICS & QUALITY",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "clusterLight",
                        label: "Cluster Galaxies Light",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "icmGlow",
                        label: "X-Ray ICM Gas Glow",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
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
                        label: "Deep Sky Brightness",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "skyMode",
                        label: "Background Sky Source",
                        kind: ControlKind::Select {
                            options: &[(0, "4K Milky Way"), (1, "Procedural")],
                        },
                    },
                    ControlItem {
                        key: "quality",
                        label: "ICM Volume Quality",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Performance"), (1, "Balanced"), (2, "Cinema")],
                        },
                    },
                    ControlItem {
                        key: "resolutionScale",
                        label: "Render Resolution",
                        kind: ControlKind::Segmented {
                            options: &[(50, "0.5×"), (75, "0.75×"), (100, "1.0×")],
                        },
                    },
                ],
            },
        ];
        SECTIONS
    }

    fn get_f32(&self, key: &str) -> f32 {
        match key {
            "einsteinRadius" => self.einstein_radius,
            "ellipticity" => self.ellipticity,
            "extShear" => self.ext_shear,
            "lensAngleDeg" => self.lens_angle_deg,
            "subhaloStrength" => self.subhalo_strength,
            "sourceX" => self.source_x,
            "sourceY" => self.source_y,
            "sourceScale" => self.source_scale,
            "quasarCore" => self.quasar_core,
            "clusterLight" => self.cluster_light,
            "icmGlow" => self.icm_glow,
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
            "einsteinRadius" => self.einstein_radius = val.clamp(0.4, 5.0),
            "ellipticity" => self.ellipticity = val.clamp(0.0, 0.68),
            "extShear" => self.ext_shear = val.clamp(0.0, 0.30),
            "lensAngleDeg" => self.lens_angle_deg = val.clamp(-90.0, 90.0),
            "subhaloStrength" => self.subhalo_strength = val.clamp(0.0, 2.2),
            "sourceX" => {
                self.source_x = val.clamp(-3.2, 3.2);
                self.source_orbit_speed = 0.0;
            }
            "sourceY" => {
                self.source_y = val.clamp(-3.2, 3.2);
                self.source_orbit_speed = 0.0;
            }
            "sourceScale" => self.source_scale = val.clamp(0.15, 1.4),
            "quasarCore" => self.quasar_core = val.clamp(0.0, 2.5),
            "clusterLight" => self.cluster_light = val.clamp(0.0, 2.5),
            "icmGlow" => self.icm_glow = val.clamp(0.0, 2.5),
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
            "skyIntensity" => self.sky_intensity = val.clamp(0.0, 2.5),
            _ => {}
        }
        if reset_primary {
            self.active_preset = None;
        }
        reset_primary
    }

    fn get_i32(&self, key: &str) -> i32 {
        match key {
            "lensModel" => self.lens_model,
            "dragMode" => {
                if self.drag_mode {
                    1
                } else {
                    0
                }
            }
            "showCaustics" => self.show_caustics,
            "showFermat" => self.show_fermat,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "lensModel" => {
                self.lens_model = val.clamp(0, 2);
                self.active_preset = None;
                true
            }
            "dragMode" => {
                self.drag_mode = val != 0;
                false
            }
            "showCaustics" => {
                self.show_caustics = if val != 0 { 1 } else { 0 };
                true
            }
            "showFermat" => {
                self.show_fermat = if val != 0 { 1 } else { 0 };
                true
            }
            "skyMode" => {
                self.sky_mode = val;
                true
            }
            "quality" => {
                self.quality = val.clamp(0, 2);
                true
            }
            "resolutionScale" => {
                self.resolution_scale = (val as f32 / 100.0).clamp(0.5, 1.0);
                true
            }
            _ => false,
        }
    }

    fn format_value(&self, key: &str) -> String {
        match key {
            "einsteinRadius" => format!("{:.2}″", self.einstein_radius),
            "ellipticity" => format!("{:.2}", self.ellipticity),
            "extShear" => format!("{:.2}", self.ext_shear),
            "lensAngleDeg" => format!("{}°", self.lens_angle_deg.round() as i32),
            "subhaloStrength" => format!("{:.2}×", self.subhalo_strength),
            "sourceX" => format!("{:+.2}″", self.source_x),
            "sourceY" => format!("{:+.2}″", self.source_y),
            "sourceScale" => format!("{:.2}″", self.source_scale),
            "quasarCore" => format!("{:.2}", self.quasar_core),
            "clusterLight" => format!("{:.2}", self.cluster_light),
            "icmGlow" => format!("{:.2}", self.icm_glow),
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
        self.source_x = p.source_x;
        self.source_y = p.source_y;
        self.source_orbit_speed = p.source_orbit_speed;
        self.orbit_angle_init = false;
        self.camera.fly_to(p, 0.9);
    }

    fn trigger_special_action(&mut self) {
        self.drag_mode = !self.drag_mode;
    }

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let tel = self.telemetry();
        let preset_badge = self
            .active_preset
            .and_then(|i| PRESETS.get(i))
            .map(|p| p.meta.full_name.to_string())
            .unwrap_or_else(|| "Custom".to_string());
        let secondary_badge = if self.drag_mode {
            "Drag Source (β)".to_string()
        } else if assets.sky_map_loaded {
            "4K Milky Way".to_string()
        } else {
            "Procedural Sky".to_string()
        };

        let mag_str = if tel.total_magnification >= 100.0 {
            format!("{}×", tel.total_magnification.round() as i64)
        } else {
            format!("{:.1}×", tel.total_magnification)
        };
        let mass_str = if tel.enclosed_mass_1e12_msun >= 10.0 {
            format!("{:.1} T", tel.enclosed_mass_1e12_msun)
        } else {
            format!("{:.2} T", tel.enclosed_mass_1e12_msun)
        };

        HudMetadata {
            brand_title: "LENS OBSERVATORY",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: self.drag_mode,
            drawer_title: "LENS POTENTIAL & DEEP FIELD",
            drawer_subtitle: format!(
                "{} · θE {:.2}″ · z 0.39→1.45",
                tel.lens_model_label, tel.einstein_radius_arcsec
            ),
            hint_text: "Drag Orbit · Shift+Drag / T Drag Source · Scroll Zoom · Space 128× Still · H HUD",
            telemetry: [
                TelemetryCell {
                    label: "MAG",
                    unit: "μ_tot",
                    value: mag_str,
                },
                TelemetryCell {
                    label: "IMAGES",
                    unit: "N",
                    value: tel.multiplicity_label,
                },
                TelemetryCell {
                    label: "EINSTEIN",
                    unit: "θ_E",
                    value: format!("{:.2}″", tel.einstein_radius_arcsec),
                },
                TelemetryCell {
                    label: "MASS",
                    unit: "10¹²M☉",
                    value: mass_str,
                },
                TelemetryCell {
                    label: "DELAY",
                    unit: "Δt",
                    value: format!("{:.1} d", tel.time_delay_days),
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: if self.drag_mode {
                    "Drag Source"
                } else {
                    "Orbit View"
                },
                key_hint: "T",
                active: self.drag_mode,
            }),
            orbit_toggle_label: "Orbit",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        let cdt = dt.clamp(0.0, 0.05);
        let mut source_moved = false;

        if input.primary_drag && (self.drag_mode || input.shift_down) {
            let h = input.viewport_h.max(320.0);
            let arcsec_per_px = (2.0 * self.camera.radius() * (0.5 * self.camera.fov).tan()) / h;
            let (cr, sr) = (self.camera.roll.cos(), self.camera.roll.sin());
            let vx = input.drag_delta[0] * arcsec_per_px;
            let vy = -input.drag_delta[1] * arcsec_per_px;
            let dsx = vx * cr - vy * sr;
            let dsy = vx * sr + vy * cr;
            if dsx.abs() > 1e-6 || dsy.abs() > 1e-6 {
                self.source_x = (self.source_x + dsx).clamp(-3.2, 3.2);
                self.source_y = (self.source_y + dsy).clamp(-3.2, 3.2);
                self.source_orbit_speed = 0.0;
                source_moved = true;
            }
        }

        if !self.paused {
            self.sim_time += cdt;
            if self.source_orbit_speed > 1e-4 {
                if !self.orbit_angle_init {
                    self.orbit_angle = self.source_y.atan2(self.source_x);
                    self.orbit_angle_init = true;
                }
                let base_r = self.source_x.hypot(self.source_y).max(0.14);
                self.orbit_angle += self.source_orbit_speed * cdt;
                self.source_x = (base_r * self.orbit_angle.cos()).clamp(-3.2, 3.2);
                self.source_y = (base_r * self.orbit_angle.sin() * 0.72).clamp(-3.2, 3.2);
            }
        }

        self.camera
            .update(cdt, self.paused, self.auto_orbit, input, self.drag_mode);
        StepOutcome {
            camera_moved: self.camera.moved || source_moved,
            sim_time: self.sim_time,
            reset_accumulation: source_moved,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("lens-cluster-bg", &self.ubo, None);
    }

    fn encode_frame_timed(
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
        timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) {
        let is_progressive = self.paused && !self.camera.moved;
        let ubo_data = self.build_uniforms(
            render_width,
            render_height,
            frame_index,
            jitter,
            is_progressive,
        );
        assets
            .queue
            .write_buffer(&self.ubo, 0, bytemuck::bytes_of(&ubo_data));
        run_fs_pass_timed(
            encoder,
            "lens-cluster-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
            timestamp_writes,
        );
    }
}
