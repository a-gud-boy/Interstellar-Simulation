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
const RAD2DEG: f32 = 180.0 / PI;

const MIN_RADIUS: f32 = 3.2;
const MAX_RADIUS: f32 = 68.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 22.0 * DEG2RAD;
const MAX_FOV: f32 = 85.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.042;
const AUTO_BREATH_AMP: f32 = 0.010;
const AUTO_BREATH_FREQ: f32 = 0.22;
const INTERACTION_COOLDOWN: f32 = 2.4;

const RT_COEFF_SOLAR: f32 = 47.1;
const HILLS_COEFF_M6: f32 = 110.0;
const T_FB_DAYS_SOLAR: f32 = 41.0;
const MDOT_EDD_SOLAR: f32 = 133.0;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct TdeUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_spin: [f32; 4],
    cam_pos_rel_mode: [f32; 4],
    cam_right_lensing: [f32; 4],
    cam_up_tde_phase: [f32; 4],
    cam_fwd_beta: [f32; 4],
    stream_params: [f32; 4],
    visual_params: [f32; 4],
    sky_params: [f32; 4],
    modes_pad: [i32; 4],
    zamo_e0: [f32; 4],
    zamo_e1: [f32; 4],
    zamo_e2: [f32; 4],
    zamo_e3: [f32; 4],
    cam_ks_l_2h: [f32; 4],
    kerr_consts: [f32; 4],
    ray_consts: [f32; 4],
    shock_pos_consts: [f32; 4],
    star_core_consts: [f32; 4],
    sky_trig: [f32; 4],
}

#[derive(Clone, Copy)]
struct TdePreset {
    meta: PresetMeta,
    spin: f32,
    bh_mass_m6: f32,
    star_mass_solar: f32,
    beta: f32,
    tde_phase: f32,
    lensing: f32,
    rel_mode: f32,
    stream_tilt_deg: f32,
    stream_density: f32,
    shock_intensity: f32,
    disk_density: f32,
    disk_temp: f32,
    jet_intensity: f32,
    flow_speed: f32,
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    radius: f32,
    elevation_deg: f32,
    azimuth_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
}

const PRESETS: [TdePreset; 6] = [
    TdePreset {
        meta: PresetMeta {
            id: "self_intersection",
            full_name: "Self-Intersection Shock",
            short_label: "Nozzle Shock",
            hotkey: "1",
        },
        spin: 0.78,
        bh_mass_m6: 3.2,
        star_mass_solar: 1.0,
        beta: 1.85,
        tde_phase: 0.54,
        lensing: 1.0,
        rel_mode: 0.72,
        stream_tilt_deg: 7.0,
        stream_density: 1.35,
        shock_intensity: 1.45,
        disk_density: 0.92,
        disk_temp: 11200.0,
        jet_intensity: 0.18,
        flow_speed: 1.15,
        exposure: 1.04,
        bloom: 0.58,
        anamorphic: 0.34,
        sky_intensity: 0.88,
        sky_mode: 0,
        sky_rot: [0.38, 0.16],
        radius: 26.5,
        elevation_deg: 28.0,
        azimuth_deg: 24.0,
        roll_deg: -4.0,
        fov_deg: 46.0,
    },
    TdePreset {
        meta: PresetMeta {
            id: "tidal_rip",
            full_name: "Pericenter Tidal Rip",
            short_label: "Tidal Rip",
            hotkey: "2",
        },
        spin: 0.45,
        bh_mass_m6: 1.8,
        star_mass_solar: 1.4,
        beta: 1.30,
        tde_phase: 0.18,
        lensing: 1.0,
        rel_mode: 0.60,
        stream_tilt_deg: -5.0,
        stream_density: 1.55,
        shock_intensity: 0.35,
        disk_density: 0.22,
        disk_temp: 9400.0,
        jet_intensity: 0.0,
        flow_speed: 1.25,
        exposure: 1.02,
        bloom: 0.56,
        anamorphic: 0.28,
        sky_intensity: 0.92,
        sky_mode: 0,
        sky_rot: [0.74, 0.12],
        radius: 24.0,
        elevation_deg: 21.0,
        azimuth_deg: -38.0,
        roll_deg: 3.0,
        fov_deg: 46.0,
    },
    TdePreset {
        meta: PresetMeta {
            id: "deep_plunge",
            full_name: "Deep β=4.5 Kerr Plunge",
            short_label: "Deep β=4.5",
            hotkey: "3",
        },
        spin: 0.985,
        bh_mass_m6: 6.5,
        star_mass_solar: 1.2,
        beta: 4.5,
        tde_phase: 0.62,
        lensing: 1.0,
        rel_mode: 0.92,
        stream_tilt_deg: 11.0,
        stream_density: 1.45,
        shock_intensity: 1.95,
        disk_density: 1.25,
        disk_temp: 15500.0,
        jet_intensity: 0.35,
        flow_speed: 1.35,
        exposure: 0.96,
        bloom: 0.62,
        anamorphic: 0.38,
        sky_intensity: 0.85,
        sky_mode: 0,
        sky_rot: [-0.42, 0.22],
        radius: 20.5,
        elevation_deg: 16.0,
        azimuth_deg: 46.0,
        roll_deg: -6.0,
        fov_deg: 48.0,
    },
    TdePreset {
        meta: PresetMeta {
            id: "eddington_flare",
            full_name: "Super-Eddington Flare",
            short_label: "Eddington",
            hotkey: "4",
        },
        spin: 0.88,
        bh_mass_m6: 1.4,
        star_mass_solar: 2.2,
        beta: 2.6,
        tde_phase: 0.82,
        lensing: 1.0,
        rel_mode: 0.78,
        stream_tilt_deg: 4.0,
        stream_density: 1.15,
        shock_intensity: 1.65,
        disk_density: 1.75,
        disk_temp: 16800.0,
        jet_intensity: 0.28,
        flow_speed: 1.20,
        exposure: 0.94,
        bloom: 0.66,
        anamorphic: 0.42,
        sky_intensity: 0.82,
        sky_mode: 0,
        sky_rot: [1.12, -0.18],
        radius: 27.5,
        elevation_deg: 34.0,
        azimuth_deg: -14.0,
        roll_deg: -2.0,
        fov_deg: 45.0,
    },
    TdePreset {
        meta: PresetMeta {
            id: "jetted_tde",
            full_name: "Swift J1644 Jetted TDE",
            short_label: "Jetted TDE",
            hotkey: "5",
        },
        spin: 0.992,
        bh_mass_m6: 5.0,
        star_mass_solar: 1.6,
        beta: 3.1,
        tde_phase: 0.74,
        lensing: 1.0,
        rel_mode: 0.86,
        stream_tilt_deg: 8.5,
        stream_density: 1.20,
        shock_intensity: 1.25,
        disk_density: 1.30,
        disk_temp: 14200.0,
        jet_intensity: 1.45,
        flow_speed: 1.30,
        exposure: 0.95,
        bloom: 0.64,
        anamorphic: 0.46,
        sky_intensity: 0.80,
        sky_mode: 0,
        sky_rot: [-0.88, 0.26],
        radius: 31.0,
        elevation_deg: 18.0,
        azimuth_deg: 32.0,
        roll_deg: -5.0,
        fov_deg: 48.0,
    },
    TdePreset {
        meta: PresetMeta {
            id: "hills_horizon",
            full_name: "Hills Limit Threshold",
            short_label: "Hills Limit",
            hotkey: "6",
        },
        spin: 0.996,
        bh_mass_m6: 82.0,
        star_mass_solar: 1.0,
        beta: 2.2,
        tde_phase: 0.44,
        lensing: 1.0,
        rel_mode: 0.95,
        stream_tilt_deg: 3.5,
        stream_density: 1.30,
        shock_intensity: 1.15,
        disk_density: 0.65,
        disk_temp: 8200.0,
        jet_intensity: 0.08,
        flow_speed: 1.05,
        exposure: 1.06,
        bloom: 0.54,
        anamorphic: 0.30,
        sky_intensity: 0.92,
        sky_mode: 0,
        sky_rot: [0.22, -0.14],
        radius: 17.5,
        elevation_deg: 12.0,
        azimuth_deg: 18.0,
        roll_deg: -3.0,
        fov_deg: 45.0,
    },
];

const SKY_OPTIONS: &[(i32, &str)] = &[
    (0, "Deep-Field + Milky Way"),
    (1, "4K Milky Way Plate Only"),
    (2, "Procedural Galactic Core"),
];

const QUALITY_OPTIONS: &[(i32, &str)] = &[(0, "Fast"), (1, "Balanced"), (2, "Ultra")];

const SCALE_OPTIONS: &[(i32, &str)] = &[(100, "1.0×"), (75, "0.75×"), (50, "0.5×")];

const ENCOUNTER_CONTROLS: &[ControlItem] = &[
    ControlItem {
        key: "spin",
        label: "Kerr Spin (a/M)",
        kind: ControlKind::Range {
            min: 0.0,
            max: 0.998,
            step: 0.002,
            hints: None,
        },
    },
    ControlItem {
        key: "bhMassM6",
        label: "SMBH Mass (M_BH)",
        kind: ControlKind::Range {
            min: 0.2,
            max: 120.0,
            step: 0.2,
            hints: Some(["0.2×10⁶M☉", "120×10⁶M☉"]),
        },
    },
    ControlItem {
        key: "beta",
        label: "Penetration (β = r_t/r_p)",
        kind: ControlKind::Range {
            min: 0.4,
            max: 6.5,
            step: 0.05,
            hints: Some(["Grazing 0.4", "Deep 6.5"]),
        },
    },
    ControlItem {
        key: "starMassSolar",
        label: "Star Mass (M★)",
        kind: ControlKind::Range {
            min: 0.2,
            max: 10.0,
            step: 0.1,
            hints: None,
        },
    },
    ControlItem {
        key: "tdePhase",
        label: "Disruption Stage (τ)",
        kind: ControlKind::Range {
            min: 0.02,
            max: 1.0,
            step: 0.01,
            hints: Some(["Tidal Rip", "Circularized"]),
        },
    },
    ControlItem {
        key: "streamTiltDeg",
        label: "Orbital Inclination Tilt",
        kind: ControlKind::Range {
            min: -35.0,
            max: 35.0,
            step: 0.5,
            hints: None,
        },
    },
    ControlItem {
        key: "lensingStrength",
        label: "Gravitational Lensing",
        kind: ControlKind::Range {
            min: 0.0,
            max: 1.0,
            step: 0.01,
            hints: None,
        },
    },
    ControlItem {
        key: "relativisticMode",
        label: "Doppler Beaming",
        kind: ControlKind::Range {
            min: 0.0,
            max: 1.0,
            step: 0.01,
            hints: Some(["Cinematic", "Physical Exact"]),
        },
    },
];

const STREAM_CONTROLS: &[ControlItem] = &[
    ControlItem {
        key: "streamDensity",
        label: "Tidal Stream Density",
        kind: ControlKind::Range {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            hints: None,
        },
    },
    ControlItem {
        key: "shockIntensity",
        label: "Self-Intersection Shock",
        kind: ControlKind::Range {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            hints: None,
        },
    },
    ControlItem {
        key: "diskDensity",
        label: "Circularized Disk Density",
        kind: ControlKind::Range {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            hints: None,
        },
    },
    ControlItem {
        key: "diskTemp",
        label: "Disk Peak Temperature",
        kind: ControlKind::Range {
            min: 4000.0,
            max: 24000.0,
            step: 200.0,
            hints: None,
        },
    },
    ControlItem {
        key: "jetIntensity",
        label: "Relativistic Jet Power",
        kind: ControlKind::Range {
            min: 0.0,
            max: 1.8,
            step: 0.05,
            hints: None,
        },
    },
    ControlItem {
        key: "flowSpeed",
        label: "Fallback Advection Speed",
        kind: ControlKind::Range {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            hints: None,
        },
    },
];

const OPTICS_CONTROLS: &[ControlItem] = &[
    ControlItem {
        key: "exposure",
        label: "Exposure",
        kind: ControlKind::Range {
            min: 0.4,
            max: 2.4,
            step: 0.02,
            hints: None,
        },
    },
    ControlItem {
        key: "bloomIntensity",
        label: "HDR Bloom Intensity",
        kind: ControlKind::Range {
            min: 0.0,
            max: 1.5,
            step: 0.02,
            hints: None,
        },
    },
    ControlItem {
        key: "anamorphicIntensity",
        label: "Anamorphic Streak",
        kind: ControlKind::Range {
            min: 0.0,
            max: 1.5,
            step: 0.02,
            hints: None,
        },
    },
    ControlItem {
        key: "skyIntensity",
        label: "Sky & Starlight Brightness",
        kind: ControlKind::Range {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            hints: None,
        },
    },
    ControlItem {
        key: "skyMode",
        label: "Background Environment",
        kind: ControlKind::Select {
            options: SKY_OPTIONS,
        },
    },
    ControlItem {
        key: "quality",
        label: "Geodesic Step Precision",
        kind: ControlKind::Segmented {
            options: QUALITY_OPTIONS,
        },
    },
    ControlItem {
        key: "resolutionScale",
        label: "Render Resolution Scale",
        kind: ControlKind::Segmented {
            options: SCALE_OPTIONS,
        },
    },
];

const CONTROL_SECTIONS: &[ControlSection] = &[
    ControlSection {
        id: "encounter",
        title: "SMBH & Tidal Encounter",
        default_open: true,
        items: ENCOUNTER_CONTROLS,
    },
    ControlSection {
        id: "stream",
        title: "Debris Stream, Shock & Jet",
        default_open: true,
        items: STREAM_CONTROLS,
    },
    ControlSection {
        id: "optics",
        title: "Cinematic Optics & Quality",
        default_open: false,
        items: OPTICS_CONTROLS,
    },
];

#[derive(Clone, Copy, Debug)]
pub struct TdeTelemetry {
    pub r_tidal_rg: f64,
    pub r_peri_rg: f64,
    pub hills_mass_m6: f64,
    pub swallowed_direct: bool,
    pub precess_deg: f64,
    pub precess_rad_vis: f64,
    pub fallback_time_days: f64,
    pub eddington_ratio: f64,
    pub horizon_r: f64,
    pub isco_r: f64,
    pub ibco_r: f64,
    pub rp_vis: f64,
    pub ecc: f64,
    pub shock_pos_local: [f64; 3],
    pub shock_temp_k: f64,
    pub core_pos_local: [f64; 3],
    pub core_radius_vis: f64,
}

pub fn compute_kerr_radii(spin: f64) -> (f64, f64, f64) {
    let a = spin.clamp(0.0, 0.998);
    let a2 = a * a;
    let horizon_r = 1.0 + (1.0 - a2).max(0.0).sqrt();
    let c1 = (1.0 - a2).max(1e-7).cbrt();
    let c2 = (1.0 + a).cbrt() + (1.0 - a).max(1e-7).cbrt();
    let z1 = 1.0 + c1 * c2;
    let z2 = (3.0 * a2 + z1 * z1).sqrt();
    let isco_r = 3.0 + z2 - ((3.0 - z1) * (3.0 + z1 + 2.0 * z2)).max(0.0).sqrt();
    let ibco_r = 2.0 - a + 2.0 * (1.0 - a).max(0.0).sqrt();
    (horizon_r, isco_r, ibco_r)
}

pub fn compute_tde_telemetry(
    bh_mass_m6: f64,
    star_mass_solar: f64,
    beta: f64,
    tde_phase: f64,
    spin: f64,
) -> TdeTelemetry {
    let m6 = bh_mass_m6.clamp(0.2, 150.0);
    let m_star = star_mass_solar.clamp(0.1, 15.0);
    let b = beta.clamp(0.4, 7.0);
    let phase = tde_phase.clamp(0.02, 1.0);
    let a = spin.clamp(0.0, 0.998);
    let (horizon_r, isco_r, ibco_r) = compute_kerr_radii(a);
    let r_star = m_star.powf(0.8);

    let r_tidal_rg = (RT_COEFF_SOLAR as f64) * m6.powf(-2.0 / 3.0) * (r_star / m_star.cbrt());
    let r_peri_rg = (r_tidal_rg / b).max(0.5);

    let hills_mass_m6 = (HILLS_COEFF_M6 as f64)
        * r_star.powf(1.5)
        * m_star.powf(-0.5)
        * (4.0 / ibco_r.max(1.0)).powf(1.5);
    let swallowed_direct = r_peri_rg <= ibco_r;

    let r_prec_eff = r_peri_rg.max(horizon_r * 1.45);
    let precess_rad_phys =
        ((6.0 * std::f64::consts::PI) / r_prec_eff) * (1.0 - (4.0 * a) / (3.0 * r_prec_eff.sqrt()));
    let precess_deg = (precess_rad_phys * (RAD2DEG as f64)).clamp(8.0, 170.0);
    let precess_rad_vis = (0.32 + 0.0115 * precess_deg).clamp(0.35, 2.25);

    let fallback_time_days = (T_FB_DAYS_SOLAR as f64) * m6.sqrt() * (r_star.powf(1.5) / m_star);
    let peak_edd = (MDOT_EDD_SOLAR as f64)
        * m6.powf(-1.5)
        * (m_star * m_star / r_star.powf(1.5))
        * b.powf(0.25);

    let tau_norm = (phase / 0.42).max(0.15);
    let lightcurve_factor = if phase <= 0.42 {
        (phase / 0.42).clamp(0.02, 1.0).powf(1.65)
    } else {
        tau_norm.powf(-5.0 / 3.0)
    };
    let eddington_ratio = if swallowed_direct {
        0.02
    } else {
        (peak_edd * lightcurve_factor).max(0.01)
    };

    let rp_vis = (horizon_r * 1.55).max(8.4 / b.powf(0.56));
    let ecc = (0.68 + 0.06 * b.min(2.5) - 0.14 * phase).clamp(0.46, 0.84);
    let semi_latus = rp_vis * (1.0 + ecc);

    let half_prec = 0.5 * precess_rad_vis;
    let shock_angle = std::f64::consts::PI - half_prec;
    let r_shock_vis = semi_latus / (1.0 + ecc * shock_angle.cos()).max(0.18);
    let shock_pos_local = [
        r_shock_vis * shock_angle.cos(),
        0.0,
        r_shock_vis * shock_angle.sin(),
    ];

    let shock_vel_c = ((2.0 / r_prec_eff.max(2.2)).sqrt() * half_prec.sin()).clamp(0.02, 0.58);
    let shock_temp_k = (16000.0 + 48000.0 * shock_vel_c * b.powf(0.25)).clamp(14000.0, 42000.0);

    let core_anomaly = -1.35 + phase * 2.95;
    let r_core_vis = semi_latus / (1.0 + ecc * core_anomaly.cos()).max(0.22);
    let core_pos_local = [
        r_core_vis * core_anomaly.cos(),
        0.0,
        r_core_vis * core_anomaly.sin(),
    ];
    let core_radius_vis = (0.78 * m_star.powf(0.15) * (1.0 - 0.55 * phase)).clamp(0.22, 1.25);

    TdeTelemetry {
        r_tidal_rg,
        r_peri_rg,
        hills_mass_m6,
        swallowed_direct,
        precess_deg,
        precess_rad_vis,
        fallback_time_days,
        eddington_ratio,
        horizon_r,
        isco_r,
        ibco_r,
        rp_vis,
        ecc,
        shock_pos_local,
        shock_temp_k,
        core_pos_local,
        core_radius_vis,
    }
}

fn rotate_tilt_local(v: [f64; 3], tilt_rad: f64) -> [f32; 3] {
    let c = tilt_rad.cos();
    let s = tilt_rad.sin();
    [
        v[0] as f32,
        (v[1] * c - v[2] * s) as f32,
        (v[1] * s + v[2] * c) as f32,
    ]
}

struct CameraFlight {
    elapsed: f32,
    duration: f32,
    start_log_r: f32,
    end_log_r: f32,
    start_el: f32,
    end_el: f32,
    start_az: f32,
    end_az: f32,
    start_roll: f32,
    end_roll: f32,
    start_fov: f32,
    end_fov: f32,
}

struct OrbitCamera {
    log_radius: f32,
    elevation: f32,
    azimuth: f32,
    roll: f32,
    fov: f32,
    target_log_radius: f32,
    target_elevation: f32,
    target_azimuth: f32,
    target_roll: f32,
    target_fov: f32,
    vel_log_radius: f32,
    vel_elevation: f32,
    vel_azimuth: f32,
    vel_roll: f32,
    vel_fov: f32,
    flight: Option<CameraFlight>,
    interaction_cooldown: f32,
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    pos: [f32; 3],
    basis: [f32; 9],
    moved: bool,
    prev_sig: Option<[f32; 10]>,
}

impl OrbitCamera {
    fn from_preset(p: &TdePreset) -> Self {
        let log_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS).ln();
        let el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az = p.azimuth_deg * DEG2RAD;
        let roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let mut cam = Self {
            log_radius: log_r,
            elevation: el,
            azimuth: az,
            roll,
            fov,
            target_log_radius: log_r,
            target_elevation: el,
            target_azimuth: az,
            target_roll: roll,
            target_fov: fov,
            vel_log_radius: 0.0,
            vel_elevation: 0.0,
            vel_azimuth: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            flight: None,
            interaction_cooldown: 0.0,
            auto_orbit_time: 0.0,
            auto_base_elevation: el,
            pos: [0.0; 3],
            basis: [0.0; 9],
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn fly_to(&mut self, p: &TdePreset, duration: f32) {
        let end_log_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS).ln();
        let end_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let end_az = self.azimuth + wrap_angle_delta(p.azimuth_deg * DEG2RAD - self.azimuth);
        let end_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let end_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        self.target_log_radius = end_log_r;
        self.target_elevation = end_el;
        self.target_azimuth = end_az;
        self.target_roll = end_roll;
        self.target_fov = end_fov;
        self.auto_base_elevation = end_el;
        self.interaction_cooldown = 0.0;
        self.auto_orbit_time = 0.0;

        self.flight = Some(CameraFlight {
            elapsed: 0.0,
            duration: duration.max(0.25),
            start_log_r: self.log_radius,
            end_log_r,
            start_el: self.elevation,
            end_el,
            start_az: self.azimuth,
            end_az,
            start_roll: self.roll,
            end_roll,
            start_fov: self.fov,
            end_fov,
        });
    }

    fn snap_to(&mut self, p: &TdePreset) {
        let log_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS).ln();
        let el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az = p.azimuth_deg * DEG2RAD;
        let roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        self.flight = None;
        self.log_radius = log_r;
        self.elevation = el;
        self.azimuth = az;
        self.roll = roll;
        self.fov = fov;
        self.target_log_radius = log_r;
        self.target_elevation = el;
        self.target_azimuth = az;
        self.target_roll = roll;
        self.target_fov = fov;
        self.vel_log_radius = 0.0;
        self.vel_elevation = 0.0;
        self.vel_azimuth = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.interaction_cooldown = 0.0;
        self.auto_orbit_time = 0.0;
        self.auto_base_elevation = el;
        self.recompute_basis();
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
                if input.secondary_drag || input.shift_down {
                    self.target_roll =
                        (self.target_roll + dx * scale * 2.2).clamp(MIN_ROLL, MAX_ROLL);
                } else {
                    self.target_azimuth -= dx * scale * 3.1;
                    self.target_elevation = (self.target_elevation + dy * scale * 2.4)
                        .clamp(MIN_ELEVATION, MAX_ELEVATION);
                }
                self.flight = None;
                self.interaction_cooldown = INTERACTION_COOLDOWN;
                self.auto_base_elevation = self.target_elevation;
                self.auto_orbit_time = 0.0;
            }
        }

        if input.scroll_y.abs() > 0.0 {
            interacting = true;
            let delta = input.scroll_y.clamp(-240.0, 240.0);
            self.target_log_radius =
                (self.target_log_radius + delta * 0.00115).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            self.flight = None;
            self.interaction_cooldown = INTERACTION_COOLDOWN;
            self.auto_base_elevation = self.target_elevation;
            self.auto_orbit_time = 0.0;
        }

        if input.any_key_held() {
            interacting = true;
            self.flight = None;
            if input.key_a || input.key_left {
                self.target_azimuth -= 0.85 * cdt;
            }
            if input.key_d || input.key_right {
                self.target_azimuth += 0.85 * cdt;
            }
            if input.key_up {
                self.target_elevation =
                    (self.target_elevation + 0.65 * cdt).clamp(MIN_ELEVATION, MAX_ELEVATION);
            }
            if input.key_down {
                self.target_elevation =
                    (self.target_elevation - 0.65 * cdt).clamp(MIN_ELEVATION, MAX_ELEVATION);
            }
            if input.key_w {
                self.target_log_radius =
                    (self.target_log_radius - 0.72 * cdt).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            }
            if input.key_s {
                self.target_log_radius =
                    (self.target_log_radius + 0.72 * cdt).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            }
            if input.key_q {
                self.target_roll = (self.target_roll - 0.75 * cdt).clamp(MIN_ROLL, MAX_ROLL);
            }
            if input.key_e {
                self.target_roll = (self.target_roll + 0.75 * cdt).clamp(MIN_ROLL, MAX_ROLL);
            }
            self.interaction_cooldown = INTERACTION_COOLDOWN;
            self.auto_base_elevation = self.target_elevation;
        }

        if let Some(mut f) = self.flight.take() {
            f.elapsed += cdt;
            let t = (f.elapsed / f.duration).clamp(0.0, 1.0);
            let e = ease_out_cubic(t);
            self.log_radius = f.start_log_r + (f.end_log_r - f.start_log_r) * e;
            self.elevation = f.start_el + (f.end_el - f.start_el) * e;
            self.azimuth = f.start_az + (f.end_az - f.start_az) * e;
            self.roll = f.start_roll + (f.end_roll - f.start_roll) * e;
            self.fov = f.start_fov + (f.end_fov - f.start_fov) * e;
            self.target_log_radius = self.log_radius;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
            if t < 1.0 {
                self.flight = Some(f);
            } else {
                self.auto_base_elevation = self.elevation;
                self.auto_orbit_time = 0.0;
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
            }
        }
        self.recompute_basis();
    }

    fn recompute_basis(&mut self) {
        let r = self.log_radius.exp();
        let cos_el = self.elevation.cos();
        let sin_el = self.elevation.sin();
        let cos_az = self.azimuth.cos();
        let sin_az = self.azimuth.sin();

        let px = r * cos_el * sin_az;
        let py = r * sin_el;
        let pz = r * cos_el * cos_az;
        self.pos = [px, py, pz];

        let inv_r = 1.0 / r.max(1e-6);
        let (fx, fy, fz) = (-px * inv_r, -py * inv_r, -pz * inv_r);
        let (mut r0x, r0y, mut r0z) = (-fz, 0.0_f32, fx);
        let r0_len = r0x.hypot(r0z);
        if r0_len < 1e-6 {
            r0x = cos_az;
            r0z = -sin_az;
        } else {
            r0x /= r0_len;
            r0z /= r0_len;
        }
        let mut u0x = r0y * fz - r0z * fy;
        let mut u0y = r0z * fx - r0x * fz;
        let mut u0z = r0x * fy - r0y * fx;
        let u0_len = (u0x * u0x + u0y * u0y + u0z * u0z).sqrt().max(1e-6);
        u0x /= u0_len;
        u0y /= u0_len;
        u0z /= u0_len;

        let cos_r = self.roll.cos();
        let sin_r = self.roll.sin();
        let rx = cos_r * r0x + sin_r * u0x;
        let ry = cos_r * r0y + sin_r * u0y;
        let rz = cos_r * r0z + sin_r * u0z;
        let ux = -sin_r * r0x + cos_r * u0x;
        let uy = -sin_r * r0y + cos_r * u0y;
        let uz = -sin_r * r0z + cos_r * u0z;

        self.basis = [rx, ry, rz, ux, uy, uz, fx, fy, fz];
        let sig = [px, py, pz, rx, ry, rz, ux, uy, uz, self.fov];
        if let Some(prev) = self.prev_sig {
            let max_diff = sig
                .iter()
                .zip(prev.iter())
                .fold(0.0_f32, |m, (a, b)| m.max((a - b).abs()));
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

pub struct TdeSim {
    active_preset: Option<usize>,
    spin: f32,
    bh_mass_m6: f32,
    star_mass_solar: f32,
    beta: f32,
    tde_phase: f32,
    lensing: f32,
    rel_mode: f32,
    stream_tilt_deg: f32,
    stream_density: f32,
    shock_intensity: f32,
    disk_density: f32,
    disk_temp: f32,
    jet_intensity: f32,
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
    sweeping: bool,
    sim_time: f32,
    camera: OrbitCamera,
    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl TdeSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];
        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::Tde,
            "tde",
            SimBglKind::Standard,
            shaders::TDE,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tde-ubo"),
            size: std::mem::size_of::<TdeUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("tde-bg", &ubo, None);

        Self {
            active_preset: Some(0),
            spin: p.spin,
            bh_mass_m6: p.bh_mass_m6,
            star_mass_solar: p.star_mass_solar,
            beta: p.beta,
            tde_phase: p.tde_phase,
            lensing: p.lensing,
            rel_mode: p.rel_mode,
            stream_tilt_deg: p.stream_tilt_deg,
            stream_density: p.stream_density,
            shock_intensity: p.shock_intensity,
            disk_density: p.disk_density,
            disk_temp: p.disk_temp,
            jet_intensity: p.jet_intensity,
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
            auto_orbit: true,
            sweeping: false,
            sim_time: 0.0,
            camera: OrbitCamera::from_preset(p),
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
    ) -> TdeUniforms {
        let tel = compute_tde_telemetry(
            self.bh_mass_m6 as f64,
            self.star_mass_solar as f64,
            self.beta as f64,
            self.tde_phase as f64,
            self.spin as f64,
        );
        let a = self.spin.clamp(0.0, 0.998);
        let a2 = a * a;
        let lensing = self.lensing.clamp(0.0, 1.0);
        let r_plus = tel.horizon_r as f32;
        let r_isco = tel.isco_r as f32;
        let rp_vis = tel.rp_vis as f32;
        let r_outer = (rp_vis * 2.35 + 4.5).clamp(r_isco + 4.0, 26.0);
        let tan_half_fov = (self.camera.fov.clamp(0.1, 2.8) * 0.5).tan();

        let [px, py, pz] = self.camera.pos;
        let basis = self.camera.basis;
        let u_val = px * px + py * py + pz * pz - a2;
        let disc = (u_val * u_val + 4.0 * a2 * py * py).max(1e-12).sqrt();
        let cr2 = (0.5 * (u_val + disc)).max(1e-8);
        let cr = cr2.sqrt();
        let c_d = cr2 * cr2 + a2 * py * py;
        let c_h = (lensing * (cr * cr2)) / c_d.max(1e-10);
        let c_r2 = cr2 + a2;
        let c_inv_r2 = 1.0 / c_r2.max(1e-8);
        let lx = (cr * px + a * pz) * c_inv_r2;
        let ly = py / cr.max(1e-5);
        let lz = (cr * pz - a * px) * c_inv_r2;

        let ks_dot = |aa: [f32; 4], bb: [f32; 4]| -> f32 {
            let la = -aa[0] + lx * aa[1] + ly * aa[2] + lz * aa[3];
            let lb = -bb[0] + lx * bb[1] + ly * bb[2] + lz * bb[3];
            -aa[0] * bb[0] + aa[1] * bb[1] + aa[2] * bb[2] + aa[3] * bb[3] + 2.0 * c_h * la * lb
        };

        let rho2 = px * px + pz * pz;
        let omega = (2.0 * c_h * a * c_r2) / (c_r2 * c_r2 + 2.0 * c_h * a2 * rho2).max(1e-8);
        let vzx = omega * pz;
        let vzz = -omega * px;
        let l_phi = (a * rho2) / c_r2.max(1e-8);
        let one_minus_wl = 1.0 - omega * l_phi;
        let norm_sq =
            (1.0 - (vzx * vzx + vzz * vzz) - 2.0 * c_h * one_minus_wl * one_minus_wl).max(1e-5);
        let ut = 1.0 / norm_sq.sqrt();
        let e0 = [ut, ut * vzx, 0.0, ut * vzz];

        let mut f4 = [0.0, basis[6], basis[7], basis[8]];
        let df0 = ks_dot(f4, e0);
        for k in 0..4 {
            f4[k] += df0 * e0[k];
        }
        let f4_inv = 1.0 / ks_dot(f4, f4).max(1e-8).sqrt();
        let e3 = [
            f4[0] * f4_inv,
            f4[1] * f4_inv,
            f4[2] * f4_inv,
            f4[3] * f4_inv,
        ];

        let mut r4 = [0.0, basis[0], basis[1], basis[2]];
        let dr0 = ks_dot(r4, e0);
        let dr3 = ks_dot(r4, e3);
        for k in 0..4 {
            r4[k] += dr0 * e0[k] - dr3 * e3[k];
        }
        let r4_inv = 1.0 / ks_dot(r4, r4).max(1e-8).sqrt();
        let e1 = [
            r4[0] * r4_inv,
            r4[1] * r4_inv,
            r4[2] * r4_inv,
            r4[3] * r4_inv,
        ];

        let mut u4 = [0.0, basis[3], basis[4], basis[5]];
        let du0 = ks_dot(u4, e0);
        let du3 = ks_dot(u4, e3);
        let du1 = ks_dot(u4, e1);
        for k in 0..4 {
            u4[k] += du0 * e0[k] - du3 * e3[k] - du1 * e1[k];
        }
        let u4_inv = 1.0 / ks_dot(u4, u4).max(1e-8).sqrt();
        let e2 = [
            u4[0] * u4_inv,
            u4[1] * u4_inv,
            u4[2] * u4_inv,
            u4[3] * u4_inv,
        ];

        let cam_r = (px * px + py * py + pz * pz).sqrt();
        let escape_r = (r_outer * 2.2).max(cam_r * 1.45).max(62.0);
        let capture_r = r_plus * 1.022;
        let tilt_rad = (self.stream_tilt_deg as f64) * (DEG2RAD as f64);
        let max_slab_y = 2.6 + (tilt_rad.sin().abs() as f32) * 28.0;

        let shock_world = rotate_tilt_local(tel.shock_pos_local, tilt_rad);
        let core_world = rotate_tilt_local(tel.core_pos_local, tilt_rad);

        TdeUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_spin: [jitter[0], jitter[1], self.camera.fov, a],
            cam_pos_rel_mode: [px, py, pz, self.rel_mode],
            cam_right_lensing: [basis[0], basis[1], basis[2], self.lensing],
            cam_up_tde_phase: [basis[3], basis[4], basis[5], self.tde_phase],
            cam_fwd_beta: [basis[6], basis[7], basis[8], self.beta],
            stream_params: [
                self.stream_density,
                self.shock_intensity,
                self.disk_density,
                self.jet_intensity,
            ],
            visual_params: [
                self.flow_speed,
                tel.precess_rad_vis as f32,
                rp_vis,
                tilt_rad as f32,
            ],
            sky_params: [
                self.sky_intensity,
                self.sky_rot[0],
                self.sky_rot[1],
                self.disk_temp,
            ],
            modes_pad: [
                frame_index as i32,
                self.sky_mode,
                self.quality,
                i32::from(tel.swallowed_direct),
            ],
            zamo_e0: e0,
            zamo_e1: e1,
            zamo_e2: e2,
            zamo_e3: e3,
            cam_ks_l_2h: [lx, ly, lz, 2.0 * c_h],
            kerr_consts: [r_plus, r_isco, r_outer, tan_half_fov],
            ray_consts: [escape_r, capture_r, max_slab_y, tel.ecc as f32],
            shock_pos_consts: [
                shock_world[0],
                shock_world[1],
                shock_world[2],
                tel.shock_temp_k as f32,
            ],
            star_core_consts: [
                core_world[0],
                core_world[1],
                core_world[2],
                tel.core_radius_vis as f32,
            ],
            sky_trig: [
                self.sky_rot[0].cos(),
                self.sky_rot[0].sin(),
                self.sky_rot[1].cos(),
                self.sky_rot[1].sin(),
            ],
        }
    }
}

impl Simulation for TdeSim {
    fn id(&self) -> SimId {
        SimId::Tde
    }

    fn post_tuning(&self) -> PostTuning {
        PostTuning::tde()
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
            tuning: PostTuning::tde(),
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
        let p = &PRESETS[index.min(PRESETS.len() - 1)];
        self.active_preset = Some(index.min(PRESETS.len() - 1));
        self.spin = p.spin;
        self.bh_mass_m6 = p.bh_mass_m6;
        self.star_mass_solar = p.star_mass_solar;
        self.beta = p.beta;
        self.tde_phase = p.tde_phase;
        self.lensing = p.lensing;
        self.rel_mode = p.rel_mode;
        self.stream_tilt_deg = p.stream_tilt_deg;
        self.stream_density = p.stream_density;
        self.shock_intensity = p.shock_intensity;
        self.disk_density = p.disk_density;
        self.disk_temp = p.disk_temp;
        self.jet_intensity = p.jet_intensity;
        self.flow_speed = p.flow_speed;
        self.exposure = p.exposure;
        self.bloom_intensity = p.bloom;
        self.anamorphic_intensity = p.anamorphic;
        self.sky_intensity = p.sky_intensity;
        self.sky_mode = p.sky_mode;
        self.sky_rot = p.sky_rot;
        self.sweeping = false;
        self.camera.snap_to(p);
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        CONTROL_SECTIONS
    }

    fn get_f32(&self, key: &str) -> f32 {
        match key {
            "spin" => self.spin,
            "bhMassM6" => self.bh_mass_m6,
            "beta" => self.beta,
            "starMassSolar" => self.star_mass_solar,
            "tdePhase" => self.tde_phase,
            "streamTiltDeg" => self.stream_tilt_deg,
            "lensingStrength" => self.lensing,
            "relativisticMode" => self.rel_mode,
            "streamDensity" => self.stream_density,
            "shockIntensity" => self.shock_intensity,
            "diskDensity" => self.disk_density,
            "diskTemp" => self.disk_temp,
            "jetIntensity" => self.jet_intensity,
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
            "spin" => self.spin = val.clamp(0.0, 0.998),
            "bhMassM6" => self.bh_mass_m6 = val.clamp(0.2, 120.0),
            "beta" => self.beta = val.clamp(0.4, 6.5),
            "starMassSolar" => self.star_mass_solar = val.clamp(0.2, 10.0),
            "tdePhase" => self.tde_phase = val.clamp(0.02, 1.0),
            "streamTiltDeg" => self.stream_tilt_deg = val.clamp(-35.0, 35.0),
            "lensingStrength" => self.lensing = val.clamp(0.0, 1.0),
            "relativisticMode" => self.rel_mode = val.clamp(0.0, 1.0),
            "streamDensity" => self.stream_density = val.clamp(0.0, 2.5),
            "shockIntensity" => self.shock_intensity = val.clamp(0.0, 2.5),
            "diskDensity" => self.disk_density = val.clamp(0.0, 2.5),
            "diskTemp" => self.disk_temp = val.clamp(4000.0, 24000.0),
            "jetIntensity" => self.jet_intensity = val.clamp(0.0, 1.8),
            "flowSpeed" => self.flow_speed = val.clamp(0.0, 2.5),
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
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "skyMode" => self.sky_mode = val,
            "quality" => self.quality = val,
            "resolutionScale" => self.resolution_scale = (val as f32 / 100.0).clamp(0.5, 1.0),
            _ => {}
        }
        true
    }

    fn format_value(&self, key: &str) -> String {
        match key {
            "spin" => format!("{:.3}", self.spin),
            "bhMassM6" => format!("{:.1}×10⁶M☉", self.bh_mass_m6),
            "beta" => format!("{:.2}", self.beta),
            "starMassSolar" => format!("{:.1} M☉", self.star_mass_solar),
            "tdePhase" => format!("{}%", (self.tde_phase * 100.0).round() as i32),
            "streamTiltDeg" => format!("{:.1}°", self.stream_tilt_deg),
            "lensingStrength" => format!("{:.2}", self.lensing),
            "relativisticMode" => format!("{}%", (self.rel_mode * 100.0).round() as i32),
            "streamDensity" => format!("{:.2}", self.stream_density),
            "shockIntensity" => format!("{:.2}", self.shock_intensity),
            "diskDensity" => format!("{:.2}", self.disk_density),
            "diskTemp" => format!("{} K", format_thousands(self.disk_temp.round() as i32)),
            "jetIntensity" => format!("{:.2}", self.jet_intensity),
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
        let idx = self.active_preset.unwrap_or(0);
        self.camera.fly_to(&PRESETS[idx], 1.1);
    }

    fn trigger_special_action(&mut self) {
        self.sweeping = true;
        self.paused = false;
        self.tde_phase = 0.06;
    }

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let tel = compute_tde_telemetry(
            self.bh_mass_m6 as f64,
            self.star_mass_solar as f64,
            self.beta as f64,
            self.tde_phase as f64,
            self.spin as f64,
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

        HudMetadata {
            brand_title: "TIDAL DISRUPTION",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: tel.swallowed_direct,
            drawer_title: "TDE STREAM & SHOCK",
            drawer_subtitle: format!(
                "M_BH {:.1}M6 · r_p {:.1}r_g · β {:.2}",
                self.bh_mass_m6, tel.r_peri_rg, self.beta
            ),
            hint_text: "Drag to orbit · Scroll to zoom · T Disrupt Evolution · Space Cinema Still · H hides HUD",
            telemetry: [
                TelemetryCell {
                    label: "TIDAL r_t",
                    unit: "r_g",
                    value: format!("{:.1} r_g", tel.r_tidal_rg),
                },
                TelemetryCell {
                    label: "PERI r_p",
                    unit: "β = r_t/r_p",
                    value: format!("{:.1} r_g ({:.2})", tel.r_peri_rg, self.beta),
                },
                TelemetryCell {
                    label: "PRECESS",
                    unit: "Δφ/orbit",
                    value: format!("{:.1}°", tel.precess_deg),
                },
                TelemetryCell {
                    label: "FALLBACK",
                    unit: "Ṁ/Ṁ_Edd",
                    value: format!("{:.1}×", tel.eddington_ratio),
                },
                TelemetryCell {
                    label: "HILLS LIMIT",
                    unit: "M_Hills",
                    value: if tel.swallowed_direct {
                        "SWALLOWED".to_string()
                    } else {
                        format!("{:.0}M₆", tel.hills_mass_m6)
                    },
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: if self.sweeping {
                    "Disrupting..."
                } else {
                    "Disrupt"
                },
                key_hint: "T",
                active: self.sweeping,
            }),
            orbit_toggle_label: "Orbit",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        let mut reset_acc = false;
        if !self.paused {
            self.sim_time += dt.clamp(0.0, 0.05);
            if self.sweeping {
                self.tde_phase = (self.tde_phase + dt * 0.095).min(0.98);
                reset_acc = true;
                if self.tde_phase >= 0.98 {
                    self.sweeping = false;
                }
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
        self.bind_group = assets.build_standard_bind_group("tde-bg", &self.ubo, None);
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
        let ubo_data = self.build_uniforms(render_width, render_height, frame_index, jitter);
        assets
            .queue
            .write_buffer(&self.ubo, 0, bytemuck::bytes_of(&ubo_data));
        run_fs_pass_timed(
            encoder,
            "tde-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
            timestamp_writes,
        );
    }
}
