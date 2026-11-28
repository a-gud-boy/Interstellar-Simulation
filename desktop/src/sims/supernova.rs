use std::f32::consts::PI;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::renderer::post::{PostFrameParams, PostTuning, run_fs_pass_timed};
use crate::renderer::{SharedGpuAssets, SimBglKind};
use crate::shaders;
use crate::sims::blackhole::format_thousands;
use crate::sims::{
    ControlItem, ControlKind, ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation,
    SpecialActionUi, StepOutcome, TelemetryCell, ease_out_cubic, step_critically_damped,
    wrap_angle_delta,
};

const DEG2RAD: f32 = PI / 180.0;

const MIN_DISTANCE: f32 = 0.0;
const MAX_DISTANCE: f32 = 32.0;
const MAX_PIVOT_RADIUS: f32 = 24.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH: f32 = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 24.0 * DEG2RAD;
const MAX_FOV: f32 = 90.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.042;
const AUTO_BREATH_AMP: f32 = 0.010;
const AUTO_BREATH_FREQ: f32 = 0.20;
const INTERACTION_COOLDOWN: f32 = 2.4;

const XI_0: f64 = 1.1517;
const E0_ERG: f64 = 1.0e51;
const M_H_G: f64 = 1.6735575e-24;
const MU_IONIZED: f64 = 0.61;
const RHO0_CGS: f64 = 1.0 * 1.4 * 1.6735575e-24;
const M_EJ_G: f64 = 3.0 * 1.98847e33;
const LY_CM: f64 = 9.4607304725808e17;
const LY_TO_AU: f64 = 63241.077;
const YR_S: f64 = 31557600.0;
const K_B: f64 = 1.380649e-16;
const INV_4_PI: f64 = 1.0 / (4.0 * std::f64::consts::PI);

pub const AGE_MIN_YR: f64 = 0.0005;
pub const AGE_MAX_YR: f64 = 18000.0;
const EVOLVE_DURATION_SEC: f32 = 22.0;
const EVOLVE_END_AGE_YR: f64 = 12000.0;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct SupernovaUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_palette: [f32; 4],
    cam_pos_r_shock: [f32; 4],
    cam_right_age: [f32; 4],
    cam_up_turb: [f32; 4],
    cam_fwd_dust: [f32; 4],
    scatter_params: [f32; 4],
    sky_params: [f32; 4],
    quality_params: [f32; 4],
    zone_params: [f32; 4],
    morph_params: [f32; 4],
}

#[derive(Clone, Copy)]
struct SupernovaPreset {
    meta: PresetMeta,
    shock_age: f32,
    bipolar_power: f32,
    jet_power: f32,
    ring_strength: f32,
    curtain_weight: f32,
    rt_turbulence: f32,
    dust_opacity: f32,
    hg_anisotropy: f32,
    star_luminosity: f32,
    palette_mode: i32,
    filament_contrast: f32,
    cavity_glow: f32,
    bok_density: f32,
    shell_thickness: f32,
    emission_gain: f32,
    expansion_speed: f32,
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    distance: f32,
    pivot: [f32; 3],
    azimuth_deg: f32,
    elevation_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
    look_yaw_deg: f32,
    look_pitch_deg: f32,
    auto_orbit: bool,
}

const PRESETS: [SupernovaPreset; 6] = [
    SupernovaPreset {
        meta: PresetMeta {
            id: "breakout",
            full_name: "Shock Breakout",
            short_label: "Breakout",
            hotkey: "1",
        },
        shock_age: 0.002,
        bipolar_power: 0.45,
        jet_power: 1.55,
        ring_strength: 1.15,
        curtain_weight: 0.0,
        rt_turbulence: 1.45,
        dust_opacity: 0.45,
        hg_anisotropy: 0.62,
        star_luminosity: 2.35,
        palette_mode: 1,
        filament_contrast: 1.45,
        cavity_glow: 1.15,
        bok_density: 0.35,
        shell_thickness: 0.92,
        emission_gain: 1.15,
        expansion_speed: 1.25,
        exposure: 0.98,
        bloom: 0.72,
        anamorphic: 0.52,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.38, 0.14],
        distance: 11.4,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 24.0,
        elevation_deg: 18.0,
        roll_deg: -8.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    SupernovaPreset {
        meta: PresetMeta {
            id: "sn1987a",
            full_name: "SN 1987A Ring",
            short_label: "SN 1987A",
            hotkey: "2",
        },
        shock_age: 35.0,
        bipolar_power: 1.35,
        jet_power: 0.45,
        ring_strength: 1.75,
        curtain_weight: 0.15,
        rt_turbulence: 1.35,
        dust_opacity: 0.52,
        hg_anisotropy: 0.64,
        star_luminosity: 1.50,
        palette_mode: 1,
        filament_contrast: 1.52,
        cavity_glow: 0.75,
        bok_density: 0.42,
        shell_thickness: 0.82,
        emission_gain: 1.12,
        expansion_speed: 1.00,
        exposure: 1.02,
        bloom: 0.62,
        anamorphic: 0.34,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [-0.22, 0.18],
        distance: 11.8,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: -28.0,
        elevation_deg: 34.0,
        roll_deg: 6.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    SupernovaPreset {
        meta: PresetMeta {
            id: "crab",
            full_name: "Crab Filament Shell",
            short_label: "Crab Shell",
            hotkey: "3",
        },
        shock_age: 970.0,
        bipolar_power: 0.50,
        jet_power: 0.85,
        ring_strength: 0.15,
        curtain_weight: 0.12,
        rt_turbulence: 1.42,
        dust_opacity: 0.55,
        hg_anisotropy: 0.60,
        star_luminosity: 1.65,
        palette_mode: 1,
        filament_contrast: 1.58,
        cavity_glow: 1.25,
        bok_density: 0.48,
        shell_thickness: 0.84,
        emission_gain: 1.15,
        expansion_speed: 0.95,
        exposure: 1.05,
        bloom: 0.56,
        anamorphic: 0.28,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.42, 0.16],
        distance: 13.4,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 32.0,
        elevation_deg: 14.0,
        roll_deg: -4.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    SupernovaPreset {
        meta: PresetMeta {
            id: "veil",
            full_name: "Veil Shock Curtains",
            short_label: "Veil Shock",
            hotkey: "4",
        },
        shock_age: 10500.0,
        bipolar_power: 0.30,
        jet_power: 0.0,
        ring_strength: 0.0,
        curtain_weight: 1.0,
        rt_turbulence: 1.58,
        dust_opacity: 0.22,
        hg_anisotropy: 0.48,
        star_luminosity: 0.65,
        palette_mode: 1,
        filament_contrast: 1.65,
        cavity_glow: 0.22,
        bok_density: 0.12,
        shell_thickness: 0.55,
        emission_gain: 1.25,
        expansion_speed: 0.80,
        exposure: 1.08,
        bloom: 0.48,
        anamorphic: 0.22,
        sky_intensity: 0.92,
        sky_mode: 0,
        sky_rot: [0.65, -0.10],
        distance: 11.4,
        pivot: [2.4, 0.3, 0.0],
        azimuth_deg: 16.0,
        elevation_deg: 8.0,
        roll_deg: -5.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    SupernovaPreset {
        meta: PresetMeta {
            id: "hubble_sho",
            full_name: "Hubble SHO Pillars",
            short_label: "SHO Pillars",
            hotkey: "5",
        },
        shock_age: 2800.0,
        bipolar_power: 0.42,
        jet_power: 0.30,
        ring_strength: 0.20,
        curtain_weight: 0.22,
        rt_turbulence: 1.38,
        dust_opacity: 1.75,
        hg_anisotropy: 0.76,
        star_luminosity: 2.10,
        palette_mode: 0,
        filament_contrast: 1.55,
        cavity_glow: 0.90,
        bok_density: 1.65,
        shell_thickness: 0.98,
        emission_gain: 1.32,
        expansion_speed: 0.85,
        exposure: 1.08,
        bloom: 0.58,
        anamorphic: 0.30,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [-0.28, 0.20],
        distance: 12.2,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: -38.0,
        elevation_deg: 10.0,
        roll_deg: 2.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    SupernovaPreset {
        meta: PresetMeta {
            id: "pulsar_cathedral",
            full_name: "Pulsar Cathedral",
            short_label: "Pulsar Core",
            hotkey: "6",
        },
        shock_age: 650.0,
        bipolar_power: 0.65,
        jet_power: 1.45,
        ring_strength: 0.35,
        curtain_weight: 0.12,
        rt_turbulence: 1.25,
        dust_opacity: 0.45,
        hg_anisotropy: 0.68,
        star_luminosity: 2.15,
        palette_mode: 2,
        filament_contrast: 1.65,
        cavity_glow: 1.75,
        bok_density: 0.40,
        shell_thickness: 0.82,
        emission_gain: 0.95,
        expansion_speed: 1.05,
        exposure: 0.94,
        bloom: 0.56,
        anamorphic: 0.42,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.52, 0.12],
        distance: 2.85,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 22.0,
        elevation_deg: 38.0,
        roll_deg: -4.0,
        fov_deg: 58.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
];

pub fn age_to_norm(age_years: f64) -> f64 {
    let age = age_years.clamp(AGE_MIN_YR, AGE_MAX_YR);
    ((age / AGE_MIN_YR).ln() / (AGE_MAX_YR / AGE_MIN_YR).ln()).clamp(0.0, 1.0)
}

pub fn norm_to_age(norm: f64) -> f64 {
    let t = norm.clamp(0.0, 1.0);
    AGE_MIN_YR * (AGE_MAX_YR / AGE_MIN_YR).powf(t)
}

pub struct SedovTaylorEval {
    pub age_years: f64,
    pub shock_radius_ly: f64,
    pub expansion_velocity_kms: f64,
    pub shock_temp_k: f64,
    pub world_shock_radius: f64,
    pub shock_age_norm: f64,
    pub regime_label: &'static str,
}

pub fn eval_sedov_taylor(age_years: f64) -> SedovTaylorEval {
    let age_yr = age_years.max(1e-4);
    let t_sec = age_yr * YR_S;
    let v_ej = ((2.0 * E0_ERG) / M_EJ_G).sqrt();
    let r_free = v_ej * t_sec;
    let r_st = XI_0 * ((E0_ERG * t_sec * t_sec) / RHO0_CGS).powf(0.2);

    let r_free2 = r_free * r_free;
    let r_st2 = r_st * r_st;
    let denom2 = (r_free2 + r_st2).max(1e-30);
    let r_shock_cm = (r_free * r_st) / denom2.sqrt();
    let v_shock_cms = (r_shock_cm / t_sec) * ((r_st2 + 0.4 * r_free2) / denom2);

    let shock_radius_ly = r_shock_cm / LY_CM;
    let expansion_velocity_kms = v_shock_cms / 1.0e5;
    let shock_temp_k = (3.0 / 16.0) * ((MU_IONIZED * M_H_G) / K_B) * v_shock_cms * v_shock_cms;
    let shock_age_norm = age_to_norm(age_yr);
    let world_shock_radius = (1.55 + 3.05 * shock_age_norm.powf(0.72)).clamp(1.55, 4.65);

    let ratio = r_free / r_st.max(1.0);
    let regime_label = if age_yr < 0.05 {
        "Shock Breakout"
    } else if ratio < 0.65 {
        "Free Expansion"
    } else if ratio < 1.65 {
        "Transition"
    } else {
        "Sedov–Taylor"
    };

    SedovTaylorEval {
        age_years: age_yr,
        shock_radius_ly,
        expansion_velocity_kms,
        shock_temp_k,
        world_shock_radius,
        shock_age_norm,
        regime_label,
    }
}

pub fn eval_hg(cos_theta: f64, g: f64) -> f64 {
    let gc = g.clamp(-0.95, 0.95);
    let mu = cos_theta.clamp(-1.0, 1.0);
    let denom = (1.0 + gc * gc - 2.0 * gc * mu).max(1e-4);
    ((1.0 - gc * gc) * INV_4_PI) / (denom * denom.sqrt())
}

pub fn eval_dual_hg(cos_theta: f64, g: f64) -> f64 {
    let g1 = g.clamp(-0.95, 0.95);
    let g2 = (-0.35 * g1).clamp(-0.55, 0.55);
    0.82 * eval_hg(cos_theta, g1) + 0.18 * eval_hg(cos_theta, g2)
}

fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    let t = ((x - edge0) / (edge1 - edge0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn gaussian(x: f64, center: f64, width: f64) -> f64 {
    let u = (x - center) / width.max(1e-4);
    (-(u * u).min(40.0)).exp()
}

pub struct SupernovaTelemetry {
    pub shock_radius_ly: f64,
    pub expansion_velocity_kms: f64,
    pub optical_depth: f64,
    pub central_temp_k: f64,
    pub world_shock_radius: f64,
    pub shock_age_norm: f64,
    pub regime_label: &'static str,
    pub palette_label: &'static str,
}

#[allow(clippy::too_many_arguments)]
pub fn compute_supernova_telemetry(
    shock_age: f64,
    dust_opacity: f64,
    bok_density: f64,
    cavity_glow: f64,
    shell_thickness: f64,
    emission_gain: f64,
    star_luminosity: f64,
    palette_mode: i32,
) -> SupernovaTelemetry {
    let st = eval_sedov_taylor(shock_age);
    let r_max = st.world_shock_radius * 1.68;
    let steps = 64;
    let dr = r_max / steps as f64;
    let dust_op = dust_opacity.clamp(0.0, 3.0);
    let bok = bok_density.clamp(0.0, 2.5);
    let cav = cavity_glow.clamp(0.0, 3.0);
    let thick = shell_thickness.clamp(0.3, 2.5);
    let gain = emission_gain.clamp(0.1, 3.0);

    let mut optical_depth = 0.0_f64;
    for i in 0..steps {
        let r = (i as f64 + 0.5) * dr;
        let u = (r / st.world_shock_radius.max(1e-4)).max(0.0);
        let pwn_cavity = smoothstep(0.04, 0.16, u) * (1.0 - smoothstep(0.32, 0.58, u)) * cav;
        let oiii = gaussian(u, 0.68, 0.16 * thick);
        let h_alpha = gaussian(u, 0.92, 0.14 * thick);
        let sii = gaussian(u, 1.04, 0.10 * thick);
        let dust_env = smoothstep(0.76, 1.00, u) * (1.0 - smoothstep(1.22, 1.44, u)) * dust_op;
        let bok_env = smoothstep(0.82, 1.02, u) * (1.0 - smoothstep(1.18, 1.38, u)) * dust_op * bok;
        let gas = (0.14 * pwn_cavity + 0.45 * oiii + 0.85 * h_alpha + 0.58 * sii) * gain;
        let sigma_scat = 0.06 * gas + 0.36 * dust_env + 0.38 * bok_env;
        let sigma_abs = 0.02 * gas + 0.24 * dust_env + 0.52 * bok_env;
        optical_depth += (sigma_scat + sigma_abs) * dr;
    }

    let star_lum = star_luminosity.clamp(0.05, 5.0);
    let central_temp_k =
        125000.0 * (1000.0 / st.age_years.max(0.002)).powf(0.14) * star_lum.powf(0.25);

    let palette_label = match palette_mode {
        0 => "Hubble SHO",
        2 => "Chandra / JWST",
        _ => "True Color",
    };

    SupernovaTelemetry {
        shock_radius_ly: st.shock_radius_ly,
        expansion_velocity_kms: st.expansion_velocity_kms,
        optical_depth,
        central_temp_k,
        world_shock_radius: st.world_shock_radius,
        shock_age_norm: st.shock_age_norm,
        regime_label: st.regime_label,
        palette_label,
    }
}

struct LifecycleMorphology {
    bipolar_power: f32,
    jet_power: f32,
    ring_strength: f32,
    curtain_weight: f32,
    dust_opacity: f32,
    bok_density: f32,
    star_luminosity: f32,
    cavity_glow: f32,
    filament_contrast: f32,
    shell_thickness: f32,
    emission_gain: f32,
}

fn eval_lifecycle_morphology(age_years: f64) -> LifecycleMorphology {
    let n = age_to_norm(age_years);
    let w_break = 1.0 - smoothstep(0.08, 0.34, n);
    let w_ring = smoothstep(0.18, 0.52, n) * (1.0 - smoothstep(0.66, 0.80, n));
    let w_crab = smoothstep(0.68, 0.82, n) * (1.0 - smoothstep(0.88, 0.95, n));
    let w_veil = smoothstep(0.88, 0.97, n);
    let w_rem = 1.0 - w_break - w_ring - w_crab - w_veil;

    let bipolar_power =
        (0.95 * w_break + 1.35 * w_ring + 0.55 * w_crab + 0.35 * w_veil + 0.65 * w_rem)
            .clamp(0.25, 1.6) as f32;
    let jet_power = (1.65 * w_break
        + 0.55 * smoothstep(0.28, 0.60, n) * (1.0 - smoothstep(0.68, 0.88, n))
        + 0.85 * w_crab)
        .clamp(0.0, 1.8) as f32;
    let ring_strength = (1.30 * w_break + 1.85 * w_ring + 0.20 * w_crab).clamp(0.0, 2.0) as f32;
    let curtain_weight = (0.15 * w_ring + 0.15 * w_crab + 1.0 * w_veil).clamp(0.0, 1.0) as f32;

    let star_luminosity =
        (2.35 + (0.65 - 2.35) * smoothstep(0.10, 0.96, n) + 0.55 * w_crab).clamp(0.5, 2.5) as f32;
    let cavity_glow = (1.15 * w_break + 0.85 * w_ring + 1.35 * w_crab + 0.25 * w_veil + 0.7 * w_rem)
        .clamp(0.2, 1.8) as f32;
    let dust_opacity =
        (0.45 * w_break + 0.58 * w_ring + 0.55 * w_crab + 0.25 * w_veil + 0.50 * w_rem)
            .clamp(0.2, 1.2) as f32;
    let bok_density =
        (0.35 * w_break + 0.45 * w_ring + 0.48 * w_crab + 0.15 * w_veil + 0.40 * w_rem)
            .clamp(0.1, 1.0) as f32;
    let filament_contrast = (1.35 + 0.28 * smoothstep(0.45, 0.96, n)).clamp(1.1, 1.7) as f32;
    let shell_thickness = (0.95 + (0.58 - 0.95) * smoothstep(0.70, 0.97, n)).clamp(0.5, 1.2) as f32;
    let emission_gain = (1.20 + 0.15 * smoothstep(0.75, 0.97, n)).clamp(1.0, 1.5) as f32;

    LifecycleMorphology {
        bipolar_power,
        jet_power,
        ring_strength,
        curtain_weight,
        dust_opacity,
        bok_density,
        star_luminosity,
        cavity_glow,
        filament_contrast,
        shell_thickness,
        emission_gain,
    }
}

fn clamp_pivot(p: [f32; 3]) -> [f32; 3] {
    let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
    if len > MAX_PIVOT_RADIUS {
        let s = MAX_PIVOT_RADIUS / len;
        [p[0] * s, p[1] * s, p[2] * s]
    } else {
        p
    }
}

struct SnPose {
    pos: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

fn compute_sn_pose(
    distance: f32,
    pivot: [f32; 3],
    azimuth: f32,
    elevation: f32,
    roll: f32,
    look_yaw: f32,
    look_pitch: f32,
) -> SnPose {
    let (cel, sel) = (elevation.cos(), elevation.sin());
    let (caz, saz) = (azimuth.cos(), azimuth.sin());
    let f0 = [cel * saz, -sel, -cel * caz];
    let r0 = [caz, 0.0, saz];
    let u0 = [sel * saz, cel, -sel * caz];
    let pos = [
        pivot[0] - f0[0] * distance,
        pivot[1] - f0[1] * distance,
        pivot[2] - f0[2] * distance,
    ];

    let (cy, sy) = (look_yaw.cos(), look_yaw.sin());
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
    let (cp, sp) = (look_pitch.cos(), look_pitch.sin());
    let forward = [
        cp * fy[0] + sp * u0[0],
        cp * fy[1] + sp * u0[1],
        cp * fy[2] + sp * u0[2],
    ];
    let up_p = [
        -sp * fy[0] + cp * u0[0],
        -sp * fy[1] + cp * u0[1],
        -sp * fy[2] + cp * u0[2],
    ];
    let (cr, sr) = (roll.cos(), roll.sin());
    let right = [
        cr * ry[0] + sr * up_p[0],
        cr * ry[1] + sr * up_p[1],
        cr * ry[2] + sr * up_p[2],
    ];
    let up = [
        -sr * ry[0] + cr * up_p[0],
        -sr * ry[1] + cr * up_p[1],
        -sr * ry[2] + cr * up_p[2],
    ];
    SnPose {
        pos,
        right,
        up,
        forward,
    }
}

struct SnFlight {
    elapsed: f32,
    duration: f32,
    start_dist: f32,
    start_pivot: [f32; 3],
    start_el: f32,
    start_az: f32,
    start_roll: f32,
    start_fov: f32,
    start_yaw: f32,
    start_pitch: f32,
    end_dist: f32,
    end_pivot: [f32; 3],
    end_el: f32,
    end_az: f32,
    end_roll: f32,
    end_fov: f32,
    end_yaw: f32,
    end_pitch: f32,
}

struct SupernovaCamera {
    distance: f32,
    pivot: [f32; 3],
    elevation: f32,
    azimuth: f32,
    roll: f32,
    fov: f32,
    look_yaw: f32,
    look_pitch: f32,

    target_distance: f32,
    target_pivot: [f32; 3],
    target_elevation: f32,
    target_azimuth: f32,
    target_roll: f32,
    target_fov: f32,
    target_look_yaw: f32,
    target_look_pitch: f32,

    vel_distance: f32,
    vel_pivot: [f32; 3],
    vel_elevation: f32,
    vel_azimuth: f32,
    vel_roll: f32,
    vel_fov: f32,
    vel_look_yaw: f32,
    vel_look_pitch: f32,

    flight: Option<SnFlight>,
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    pose: SnPose,
    moved: bool,
    prev_sig: Option<[f32; 13]>,
}

impl SupernovaCamera {
    fn from_preset(p: &SupernovaPreset) -> Self {
        let d0 = p.distance.clamp(MIN_DISTANCE, MAX_DISTANCE);
        let piv0 = clamp_pivot(p.pivot);
        let el0 = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az0 = p.azimuth_deg * DEG2RAD;
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let yaw0 = p.look_yaw_deg * DEG2RAD;
        let pitch0 = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);

        let mut cam = Self {
            distance: d0,
            pivot: piv0,
            elevation: el0,
            azimuth: az0,
            roll: roll0,
            fov: fov0,
            look_yaw: yaw0,
            look_pitch: pitch0,
            target_distance: d0,
            target_pivot: piv0,
            target_elevation: el0,
            target_azimuth: az0,
            target_roll: roll0,
            target_fov: fov0,
            target_look_yaw: yaw0,
            target_look_pitch: pitch0,
            vel_distance: 0.0,
            vel_pivot: [0.0; 3],
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
            pose: compute_sn_pose(d0, piv0, az0, el0, roll0, yaw0, pitch0),
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn fly_step(&mut self, step_dist: f32) {
        let pose = compute_sn_pose(
            self.target_distance,
            self.target_pivot,
            self.target_azimuth,
            self.target_elevation,
            self.target_roll,
            self.target_look_yaw,
            self.target_look_pitch,
        );
        let fwd = pose.forward;
        let straight = self.target_look_yaw.hypot(self.target_look_pitch) < 0.05;
        if step_dist > 0.0 {
            let mut rem = step_dist;
            if straight && self.target_distance > 0.0 {
                let pull = self.target_distance.min(rem);
                self.target_distance -= pull;
                rem -= pull;
            }
            if rem > 0.0 {
                self.target_pivot = clamp_pivot([
                    self.target_pivot[0] + fwd[0] * rem,
                    self.target_pivot[1] + fwd[1] * rem,
                    self.target_pivot[2] + fwd[2] * rem,
                ]);
            }
        } else {
            let back = -step_dist;
            if straight && self.target_distance > 0.05 {
                self.target_distance =
                    (self.target_distance + back).clamp(MIN_DISTANCE, MAX_DISTANCE);
            } else {
                self.target_pivot = clamp_pivot([
                    self.target_pivot[0] - fwd[0] * back,
                    self.target_pivot[1] - fwd[1] * back,
                    self.target_pivot[2] - fwd[2] * back,
                ]);
            }
        }
    }

    fn fly_to(&mut self, p: &SupernovaPreset, duration: f32) {
        let dest_dist = p.distance.clamp(MIN_DISTANCE, MAX_DISTANCE);
        let dest_piv = clamp_pivot(p.pivot);
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az = self.azimuth + wrap_angle_delta(p.azimuth_deg * DEG2RAD - self.azimuth);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let dest_yaw = self.look_yaw + wrap_angle_delta(p.look_yaw_deg * DEG2RAD - self.look_yaw);
        let dest_pitch = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);

        self.flight = Some(SnFlight {
            elapsed: 0.0,
            duration: duration.max(0.01),
            start_dist: self.distance,
            start_pivot: self.pivot,
            start_el: self.elevation,
            start_az: self.azimuth,
            start_roll: self.roll,
            start_fov: self.fov,
            start_yaw: self.look_yaw,
            start_pitch: self.look_pitch,
            end_dist: dest_dist,
            end_pivot: dest_piv,
            end_el: dest_el,
            end_az: dest_az,
            end_roll: dest_roll,
            end_fov: dest_fov,
            end_yaw: dest_yaw,
            end_pitch: dest_pitch,
        });
        self.vel_distance = 0.0;
        self.vel_pivot = [0.0; 3];
        self.vel_elevation = 0.0;
        self.vel_azimuth = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.vel_look_yaw = 0.0;
        self.vel_look_pitch = 0.0;
        self.interaction_cooldown = 0.0;
    }

    fn cancel_flight(&mut self) {
        if self.flight.take().is_some() {
            self.target_distance = self.distance;
            self.target_pivot = self.pivot;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
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
                } else if input.shift_down {
                    self.target_look_yaw += dx * scale * 2.5;
                    self.target_look_pitch = (self.target_look_pitch - dy * scale * 2.1)
                        .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
                } else {
                    self.target_azimuth += dx * scale * 3.0;
                    self.target_elevation = (self.target_elevation + dy * scale * 2.3)
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
            let step = -delta * 0.0085 * (0.4 + 0.14 * self.target_distance);
            self.fly_step(step);
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let orbit_rate = 0.85 * cdt;
            let elev_rate = 0.65 * cdt;
            let roll_rate = 0.75 * cdt;
            let fly_speed = (2.8 + 0.35 * self.distance) * cdt;
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
                self.fly_step(fly_speed);
            }
            if input.key_s {
                self.fly_step(-fly_speed);
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

            self.distance = f.start_dist + (f.end_dist - f.start_dist) * e;
            for i in 0..3 {
                self.pivot[i] = f.start_pivot[i] + (f.end_pivot[i] - f.start_pivot[i]) * e;
            }
            self.elevation = f.start_el + (f.end_el - f.start_el) * e;
            self.azimuth = f.start_az + (f.end_az - f.start_az) * e;
            self.roll = f.start_roll + (f.end_roll - f.start_roll) * e;
            self.fov = f.start_fov + (f.end_fov - f.start_fov) * e;
            self.look_yaw = f.start_yaw + (f.end_yaw - f.start_yaw) * e;
            self.look_pitch = f.start_pitch + (f.end_pitch - f.start_pitch) * e;

            self.target_distance = self.distance;
            self.target_pivot = self.pivot;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;

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
            if auto_orbit && !paused && !interacting && self.interaction_cooldown <= 0.0 {
                self.auto_orbit_time += cdt;
                let ramp = (self.auto_orbit_time / 1.5).clamp(0.0, 1.0);
                self.target_azimuth += AUTO_ORBIT_SPEED * ramp * cdt;
                self.target_elevation = (self.auto_base_elevation
                    + (self.auto_orbit_time * AUTO_BREATH_FREQ).sin() * AUTO_BREATH_AMP * ramp)
                    .clamp(MIN_ELEVATION, MAX_ELEVATION);
            }

            if cdt > 0.0 {
                (self.distance, self.vel_distance) = step_critically_damped(
                    self.distance,
                    self.vel_distance,
                    self.target_distance,
                    SPRING_OMEGA,
                    cdt,
                );
                for i in 0..3 {
                    (self.pivot[i], self.vel_pivot[i]) = step_critically_damped(
                        self.pivot[i],
                        self.vel_pivot[i],
                        self.target_pivot[i],
                        SPRING_OMEGA,
                        cdt,
                    );
                }
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
            }
        }

        self.recompute_basis();
    }

    fn recompute_basis(&mut self) {
        self.pose = compute_sn_pose(
            self.distance,
            self.pivot,
            self.azimuth,
            self.elevation,
            self.roll,
            self.look_yaw,
            self.look_pitch,
        );
        let sig = [
            self.pose.pos[0],
            self.pose.pos[1],
            self.pose.pos[2],
            self.pose.right[0],
            self.pose.right[1],
            self.pose.right[2],
            self.pose.up[0],
            self.pose.up[1],
            self.pose.up[2],
            self.pose.forward[0],
            self.pose.forward[1],
            self.pose.forward[2],
            self.fov,
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

pub struct SupernovaSim {
    active_preset: Option<usize>,

    shock_age: f32,
    bipolar_power: f32,
    jet_power: f32,
    ring_strength: f32,
    curtain_weight: f32,
    rt_turbulence: f32,
    dust_opacity: f32,
    hg_anisotropy: f32,
    star_luminosity: f32,
    palette_mode: i32,
    filament_contrast: f32,
    cavity_glow: f32,
    bok_density: f32,
    shell_thickness: f32,
    emission_gain: f32,
    expansion_speed: f32,

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
    evolving: bool,
    sim_time: f32,

    camera: SupernovaCamera,
    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl SupernovaSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];
        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::Supernova,
            "supernova",
            SimBglKind::Standard,
            shaders::SUPERNOVA,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("supernova-ubo"),
            size: std::mem::size_of::<SupernovaUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("supernova-bg", &ubo, None);

        Self {
            active_preset: Some(0),
            shock_age: p.shock_age,
            bipolar_power: p.bipolar_power,
            jet_power: p.jet_power,
            ring_strength: p.ring_strength,
            curtain_weight: p.curtain_weight,
            rt_turbulence: p.rt_turbulence,
            dust_opacity: p.dust_opacity,
            hg_anisotropy: p.hg_anisotropy,
            star_luminosity: p.star_luminosity,
            palette_mode: p.palette_mode,
            filament_contrast: p.filament_contrast,
            cavity_glow: p.cavity_glow,
            bok_density: p.bok_density,
            shell_thickness: p.shell_thickness,
            emission_gain: p.emission_gain,
            expansion_speed: p.expansion_speed,
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
            evolving: false,
            sim_time: 0.0,
            camera: SupernovaCamera::from_preset(p),
            pipeline,
            ubo,
            bind_group,
        }
    }

    fn apply_morphology_for_age(&mut self, age_years: f64) {
        let m = eval_lifecycle_morphology(age_years);
        self.bipolar_power = m.bipolar_power;
        self.jet_power = m.jet_power;
        self.ring_strength = m.ring_strength;
        self.curtain_weight = m.curtain_weight;
        self.dust_opacity = m.dust_opacity;
        self.bok_density = m.bok_density;
        self.star_luminosity = m.star_luminosity;
        self.cavity_glow = m.cavity_glow;
        self.filament_contrast = m.filament_contrast;
        self.shell_thickness = m.shell_thickness;
        self.emission_gain = m.emission_gain;
    }

    fn telemetry(&self) -> SupernovaTelemetry {
        compute_supernova_telemetry(
            self.shock_age as f64,
            self.dust_opacity as f64,
            self.bok_density as f64,
            self.cavity_glow as f64,
            self.shell_thickness as f64,
            self.emission_gain as f64,
            self.star_luminosity as f64,
            self.palette_mode,
        )
    }

    fn build_uniforms(
        &self,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        is_progressive: bool,
    ) -> SupernovaUniforms {
        let tel = self.telemetry();
        SupernovaUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_palette: [
                jitter[0],
                jitter[1],
                self.camera.fov,
                self.palette_mode as f32,
            ],
            cam_pos_r_shock: [
                self.camera.pose.pos[0],
                self.camera.pose.pos[1],
                self.camera.pose.pos[2],
                tel.world_shock_radius as f32,
            ],
            cam_right_age: [
                self.camera.pose.right[0],
                self.camera.pose.right[1],
                self.camera.pose.right[2],
                tel.shock_age_norm as f32,
            ],
            cam_up_turb: [
                self.camera.pose.up[0],
                self.camera.pose.up[1],
                self.camera.pose.up[2],
                self.rt_turbulence,
            ],
            cam_fwd_dust: [
                self.camera.pose.forward[0],
                self.camera.pose.forward[1],
                self.camera.pose.forward[2],
                self.dust_opacity,
            ],
            scatter_params: [
                self.hg_anisotropy,
                self.star_luminosity,
                self.filament_contrast,
                self.cavity_glow,
            ],
            sky_params: [
                self.sky_intensity,
                self.sky_mode as f32,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            quality_params: [
                self.quality as f32,
                self.expansion_speed,
                tel.central_temp_k as f32,
                if is_progressive { 1.0 } else { 0.0 },
            ],
            zone_params: [
                self.bok_density,
                self.shell_thickness,
                self.emission_gain,
                0.0,
            ],
            morph_params: [
                self.bipolar_power,
                self.jet_power,
                self.ring_strength,
                self.curtain_weight,
            ],
        }
    }
}

impl Simulation for SupernovaSim {
    fn id(&self) -> SimId {
        SimId::Supernova
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
            self.evolving = false;
            self.shock_age = p.shock_age;
            self.bipolar_power = p.bipolar_power;
            self.jet_power = p.jet_power;
            self.ring_strength = p.ring_strength;
            self.curtain_weight = p.curtain_weight;
            self.rt_turbulence = p.rt_turbulence;
            self.dust_opacity = p.dust_opacity;
            self.hg_anisotropy = p.hg_anisotropy;
            self.star_luminosity = p.star_luminosity;
            self.palette_mode = p.palette_mode;
            self.filament_contrast = p.filament_contrast;
            self.cavity_glow = p.cavity_glow;
            self.bok_density = p.bok_density;
            self.shell_thickness = p.shell_thickness;
            self.emission_gain = p.emission_gain;
            self.expansion_speed = p.expansion_speed;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.auto_orbit = p.auto_orbit;
            self.camera.fly_to(p, 1.05);
        }
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        const SECTIONS: &[ControlSection] = &[
            ControlSection {
                id: "blast",
                title: "BLAST WAVE & IONIZATION",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "paletteMode",
                        label: "Emission Palette",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Hubble SHO"), (1, "True Color"), (2, "Chandra / JWST")],
                        },
                    },
                    ControlItem {
                        key: "shockAgeLog",
                        label: "Shock Expansion Age",
                        kind: ControlKind::Range {
                            min: -3.30103,
                            max: 4.25527,
                            step: 0.01,
                            hints: Some(["4.4 hr (Breakout)", "18 kyr (Veil)"]),
                        },
                    },
                    ControlItem {
                        key: "bipolarPower",
                        label: "Bipolar Asymmetry",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "jetPower",
                        label: "Relativistic Jets",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "rtTurbulence",
                        label: "Rayleigh–Taylor Turbulence",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "expansionSpeed",
                        label: "Blast Flow Speed",
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
                id: "scatter",
                title: "DUST & MULTI-SCATTERING",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "dustOpacity",
                        label: "Dust Absorption Opacity",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "hgAnisotropy",
                        label: "Forward Scattering (g_HG)",
                        kind: ControlKind::Range {
                            min: -0.95,
                            max: 0.95,
                            step: 0.02,
                            hints: Some(["Backscatter", "Forward Peak"]),
                        },
                    },
                    ControlItem {
                        key: "starLuminosity",
                        label: "Central Star Luminosity",
                        kind: ControlKind::Range {
                            min: 0.1,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "bokDensity",
                        label: "Dark Bok Globules",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "cavityGlow",
                        label: "Pulsar Wind Cavity",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "shellThickness",
                        label: "Shell Thickness",
                        kind: ControlKind::Range {
                            min: 0.4,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                ],
            },
            ControlSection {
                id: "optics",
                title: "OPTICS, SKY & QUALITY",
                default_open: true,
                items: &[
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
                            options: &[
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
                            options: &[(0, "Medium"), (1, "High"), (2, "Ultra Cinema")],
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
            "shockAgeLog" => self.shock_age.max(AGE_MIN_YR as f32).log10(),
            "bipolarPower" => self.bipolar_power,
            "jetPower" => self.jet_power,
            "rtTurbulence" => self.rt_turbulence,
            "expansionSpeed" => self.expansion_speed,
            "dustOpacity" => self.dust_opacity,
            "hgAnisotropy" => self.hg_anisotropy,
            "starLuminosity" => self.star_luminosity,
            "bokDensity" => self.bok_density,
            "cavityGlow" => self.cavity_glow,
            "shellThickness" => self.shell_thickness,
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
            "shockAgeLog" => {
                self.shock_age = 10.0_f32
                    .powf(val)
                    .clamp(AGE_MIN_YR as f32, AGE_MAX_YR as f32);
                self.evolving = false;
            }
            "bipolarPower" => self.bipolar_power = val,
            "jetPower" => self.jet_power = val,
            "rtTurbulence" => self.rt_turbulence = val,
            "expansionSpeed" => self.expansion_speed = val,
            "dustOpacity" => self.dust_opacity = val,
            "hgAnisotropy" => self.hg_anisotropy = val,
            "starLuminosity" => self.star_luminosity = val,
            "bokDensity" => self.bok_density = val,
            "cavityGlow" => self.cavity_glow = val,
            "shellThickness" => self.shell_thickness = val,
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
            "paletteMode" => self.palette_mode,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "paletteMode" => {
                self.palette_mode = val;
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
            "shockAgeLog" => {
                if self.shock_age < 0.005 {
                    format!("{:.1} hr", self.shock_age * 8766.0)
                } else if self.shock_age < 0.25 {
                    format!("{} d", (self.shock_age * 365.25).round().max(1.0) as i32)
                } else if self.shock_age < 2.0 {
                    format!("{:.2} yr", self.shock_age)
                } else if self.shock_age >= 1000.0 {
                    format!("{:.2} kyr", self.shock_age / 1000.0)
                } else {
                    format!("{} yr", self.shock_age.round() as i32)
                }
            }
            "bipolarPower" => format!("{:.2}", self.bipolar_power),
            "jetPower" => format!("{:.2}", self.jet_power),
            "rtTurbulence" => format!("{:.2}", self.rt_turbulence),
            "expansionSpeed" => format!("{:.2}×", self.expansion_speed),
            "dustOpacity" => format!("{:.2}", self.dust_opacity),
            "hgAnisotropy" => format!("{:.2}", self.hg_anisotropy),
            "starLuminosity" => format!("{:.2}×", self.star_luminosity),
            "bokDensity" => format!("{:.2}", self.bok_density),
            "cavityGlow" => format!("{:.2}", self.cavity_glow),
            "shellThickness" => format!("{:.2}×", self.shell_thickness),
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
        let idx = self.active_preset.unwrap_or(0);
        self.camera.fly_to(&PRESETS[idx], 1.0);
    }

    fn trigger_special_action(&mut self) {
        if self.evolving {
            self.evolving = false;
        } else {
            self.evolving = true;
            self.paused = false;
            self.active_preset = None;
            self.shock_age = AGE_MIN_YR as f32;
            self.apply_morphology_for_age(AGE_MIN_YR);
            if self.camera.distance < 5.0 {
                self.camera.fly_to(&PRESETS[0], 1.0);
            }
        }
    }

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let tel = self.telemetry();
        let preset_badge = if self.evolving {
            "Evolving Lifecycle".to_string()
        } else {
            self.active_preset
                .and_then(|i| PRESETS.get(i))
                .map(|p| p.meta.full_name.to_string())
                .unwrap_or_else(|| "Custom".to_string())
        };
        let secondary_badge = if assets.sky_map_loaded {
            "4K Milky Way".to_string()
        } else {
            "Procedural Sky".to_string()
        };
        let temp_str = if tel.central_temp_k >= 100000.0 {
            format!("{}k K", (tel.central_temp_k / 1000.0).round() as i32)
        } else if tel.central_temp_k >= 10000.0 {
            format!("{:.1}k K", tel.central_temp_k / 1000.0)
        } else {
            format!("{} K", tel.central_temp_k.round() as i32)
        };
        let radius_str = if tel.shock_radius_ly < 0.01 {
            let au = tel.shock_radius_ly * LY_TO_AU;
            if au >= 100.0 {
                format!("{} AU", format_thousands(au.round() as i32))
            } else {
                format!("{au:.1} AU")
            }
        } else if tel.shock_radius_ly < 0.5 {
            format!("{:.3} ly", tel.shock_radius_ly)
        } else {
            format!("{:.2} ly", tel.shock_radius_ly)
        };

        HudMetadata {
            brand_title: "SUPERNOVA",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: false,
            drawer_title: "NEBULA PHYSICS & OPTICS",
            drawer_subtitle: format!("{} · τ {:.2}", tel.palette_label, tel.optical_depth),
            hint_text: "Drag to orbit · W/S fly through · T Detonate & Evolve · Space 128× Still · H HUD",
            telemetry: [
                TelemetryCell {
                    label: "SHOCK RADIUS",
                    unit: "R_sh",
                    value: radius_str,
                },
                TelemetryCell {
                    label: "EXPANSION VEL",
                    unit: "v_sh",
                    value: format!(
                        "{} km/s",
                        format_thousands(tel.expansion_velocity_kms.round() as i32)
                    ),
                },
                TelemetryCell {
                    label: "OPTICAL DEPTH",
                    unit: "τ",
                    value: format!("{:.2}", tel.optical_depth),
                },
                TelemetryCell {
                    label: "CENTRAL TEMP",
                    unit: "T_core",
                    value: temp_str,
                },
                TelemetryCell {
                    label: "BLAST REGIME",
                    unit: "",
                    value: tel.regime_label.to_string(),
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: if self.evolving { "Stop" } else { "Detonate" },
                key_hint: "T",
                active: self.evolving,
            }),
            orbit_toggle_label: "Orbit",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        let mut reset_acc = false;
        if !self.paused {
            let cdt = dt.clamp(0.0, 0.05);
            self.sim_time += cdt;
            if self.evolving {
                let speed = self.expansion_speed.clamp(0.25, 2.5) as f64;
                let end_norm = age_to_norm(EVOLVE_END_AGE_YR);
                let next_norm = (age_to_norm(self.shock_age as f64)
                    + (cdt as f64 * speed) / EVOLVE_DURATION_SEC as f64)
                    .min(end_norm);
                let next_age = norm_to_age(next_norm);
                self.shock_age = next_age as f32;
                self.apply_morphology_for_age(next_age);
                if next_norm >= end_norm - 1e-4 {
                    self.evolving = false;
                }
                reset_acc = true;
            }
        }
        self.camera.update(dt, self.paused, self.auto_orbit, input);
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: reset_acc,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("supernova-bg", &self.ubo, None);
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
            "supernova-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
            timestamp_writes,
        );
    }
}
