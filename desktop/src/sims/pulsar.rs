use std::f64::consts::{PI, TAU};

use bytemuck::{Pod, Zeroable};

use crate::renderer::SharedGpuAssets;
use crate::renderer::post::{PostFrameParams, PostTuning, make_fs_pipe, run_fs_pass};
use crate::shaders;
use crate::sims::{
    ControlItem, ControlKind, ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation,
    StepOutcome, TelemetryCell, ease_out_cubic, step_critically_damped, wrap_angle_delta,
};

const DEG2RAD: f32 = std::f32::consts::PI / 180.0;

const SCHWARZSCHILD_RADIUS_1_4_KM: f64 = 4.13455;
const C_KMS: f64 = 299792.458;
const COMPACTNESS_MIN: f64 = 0.12;
const COMPACTNESS_MAX: f64 = 0.30;
const BETA_EQ_MAX: f64 = 0.38;
const CHI_MAX: f64 = 0.45;

const MIN_DISTANCE: f32 = 2.2;
const MAX_DISTANCE: f32 = 36.0;
const MAX_PIVOT_RADIUS: f32 = 0.5;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH: f32 = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 22.0 * DEG2RAD;
const MAX_FOV: f32 = 85.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.042;
const AUTO_BREATH_AMP: f32 = 0.010;
const AUTO_BREATH_FREQ: f32 = 0.20;
const INTERACTION_COOLDOWN: f32 = 2.4;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct PulsarUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_lensing: [f32; 4],
    cam_pos_compactness: [f32; 4],
    cam_right_spin_a: [f32; 4],
    cam_up_beta_eq: [f32; 4],
    cam_fwd_phase: [f32; 4],
    magnet_params: [f32; 4],
    beam_pwn_params: [f32; 4],
    sky_params: [f32; 4],
    quality_params: [f32; 4],
    extra_params: [f32; 4],
}

#[derive(Clone, Copy)]
struct PulsarPreset {
    meta: PresetMeta,
    compactness: f32,
    spin_period_ms: f32,
    obliquity_deg: f32,
    twist_shear: f32,
    beam_intensity: f32,
    plasma_density: f32,
    pwn_visibility: f32,
    polar_cap_temp_k: f32,
    crust_temp_k: f32,
    beam_cone_half_angle: f32,
    magnetar_crack_glow: f32,
    pwn_jet_power: f32,
    lensing_mode: i32,
    spin_visual_speed: f32,
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

const PRESETS: [PulsarPreset; 6] = [
    PulsarPreset {
        meta: PresetMeta {
            id: "crab",
            full_name: "Crab-like Young Pulsar",
            short_label: "Crab Pulsar",
            hotkey: "1",
        },
        compactness: 0.21,
        spin_period_ms: 33.0,
        obliquity_deg: 45.0,
        twist_shear: 0.45,
        beam_intensity: 1.35,
        plasma_density: 1.05,
        pwn_visibility: 1.05,
        polar_cap_temp_k: 6.5e6,
        crust_temp_k: 1.4e6,
        beam_cone_half_angle: 0.30,
        magnetar_crack_glow: 0.0,
        pwn_jet_power: 1.45,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 1.02,
        bloom: 0.62,
        anamorphic: 0.48,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [0.40, 0.14],
        distance: 12.0,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 28.0,
        elevation_deg: 22.0,
        roll_deg: -2.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    PulsarPreset {
        meta: PresetMeta {
            id: "millisecond",
            full_name: "Millisecond Recycled Pulsar",
            short_label: "Millisecond",
            hotkey: "2",
        },
        compactness: 0.24,
        spin_period_ms: 1.50,
        obliquity_deg: 52.0,
        twist_shear: 0.25,
        beam_intensity: 1.32,
        plasma_density: 0.92,
        pwn_visibility: 0.22,
        polar_cap_temp_k: 5.8e6,
        crust_temp_k: 1.1e6,
        beam_cone_half_angle: 0.34,
        magnetar_crack_glow: 0.0,
        pwn_jet_power: 0.50,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 0.98,
        bloom: 0.54,
        anamorphic: 0.44,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [-0.28, 0.18],
        distance: 9.6,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: -22.0,
        elevation_deg: 16.0,
        roll_deg: 2.0,
        fov_deg: 46.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    PulsarPreset {
        meta: PresetMeta {
            id: "magnetar",
            full_name: "Ultra-Compact Magnetar",
            short_label: "Magnetar",
            hotkey: "3",
        },
        compactness: 0.29,
        spin_period_ms: 320.0,
        obliquity_deg: 38.0,
        twist_shear: 2.10,
        beam_intensity: 0.90,
        plasma_density: 1.40,
        pwn_visibility: 0.15,
        polar_cap_temp_k: 9.0e6,
        crust_temp_k: 2.4e6,
        beam_cone_half_angle: 0.26,
        magnetar_crack_glow: 1.45,
        pwn_jet_power: 0.40,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 1.00,
        bloom: 0.62,
        anamorphic: 0.42,
        sky_intensity: 0.88,
        sky_mode: 0,
        sky_rot: [0.62, -0.10],
        distance: 7.2,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 42.0,
        elevation_deg: 20.0,
        roll_deg: -2.0,
        fov_deg: 44.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    PulsarPreset {
        meta: PresetMeta {
            id: "polar_cap",
            full_name: "Polar Cap View",
            short_label: "Polar Cap",
            hotkey: "4",
        },
        compactness: 0.26,
        spin_period_ms: 18.0,
        obliquity_deg: 36.0,
        twist_shear: 0.85,
        beam_intensity: 1.10,
        plasma_density: 1.05,
        pwn_visibility: 0.20,
        polar_cap_temp_k: 8.0e6,
        crust_temp_k: 1.6e6,
        beam_cone_half_angle: 0.28,
        magnetar_crack_glow: 0.0,
        pwn_jet_power: 0.45,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 1.02,
        bloom: 0.58,
        anamorphic: 0.38,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [0.18, 0.22],
        distance: 4.8,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 15.0,
        elevation_deg: 58.0,
        roll_deg: 0.0,
        fov_deg: 45.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    PulsarPreset {
        meta: PresetMeta {
            id: "edge_on",
            full_name: "Edge-On Lighthouse",
            short_label: "Lighthouse",
            hotkey: "5",
        },
        compactness: 0.22,
        spin_period_ms: 12.0,
        obliquity_deg: 72.0,
        twist_shear: 0.40,
        beam_intensity: 2.15,
        plasma_density: 1.05,
        pwn_visibility: 0.50,
        polar_cap_temp_k: 7.2e6,
        crust_temp_k: 1.3e6,
        beam_cone_half_angle: 0.24,
        magnetar_crack_glow: 0.0,
        pwn_jet_power: 0.80,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 1.05,
        bloom: 0.60,
        anamorphic: 0.65,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [-0.50, 0.08],
        distance: 10.8,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: 22.0,
        elevation_deg: 6.0,
        roll_deg: 0.0,
        fov_deg: 48.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
    PulsarPreset {
        meta: PresetMeta {
            id: "pwn_torus",
            full_name: "Torus & Jet PWN",
            short_label: "Torus & Jet",
            hotkey: "6",
        },
        compactness: 0.20,
        spin_period_ms: 33.0,
        obliquity_deg: 42.0,
        twist_shear: 0.35,
        beam_intensity: 1.25,
        plasma_density: 0.90,
        pwn_visibility: 1.55,
        polar_cap_temp_k: 6.5e6,
        crust_temp_k: 1.4e6,
        beam_cone_half_angle: 0.30,
        magnetar_crack_glow: 0.0,
        pwn_jet_power: 1.75,
        lensing_mode: 1,
        spin_visual_speed: 1.0,
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.44,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [0.32, -0.16],
        distance: 14.5,
        pivot: [0.0, 0.0, 0.0],
        azimuth_deg: -34.0,
        elevation_deg: 28.0,
        roll_deg: -3.0,
        fov_deg: 50.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        auto_orbit: true,
    },
];

#[derive(Clone, Debug)]
pub struct PulsarTelemetry {
    pub compactness: f64,
    pub stellar_radius_km: f64,
    pub schwarzschild_radius: f64,
    pub spin_a: f64,
    pub chi: f64,
    pub beta_eq: f64,
    pub surface_redshift_z: f64,
    pub apparent_radius: f64,
    pub max_visible_angle_rad: f64,
    pub visible_surface_fraction: f64,
    pub r_light_cyl_km: f64,
    pub r_light_cyl_norm: f64,
    pub r_light_cyl_vis: f64,
    pub spin_freq_hz: f64,
    pub omega_vis: f64,
    pub lensing_strength: f64,
    pub obliquity_rad: f64,
}

pub fn compute_surface_redshift(compactness: f64) -> f64 {
    let u = compactness.clamp(0.0, 0.33);
    1.0 / (1.0 - 2.0 * u).sqrt() - 1.0
}

pub fn compute_apparent_radius(compactness: f64, lensing_on: bool) -> f64 {
    if !lensing_on {
        return 1.0;
    }
    let u = compactness.clamp(0.0, 0.33);
    1.0 / (1.0 - 2.0 * u).sqrt()
}

pub fn compute_max_visible_angle(compactness: f64, lensing_on: bool) -> f64 {
    if !lensing_on {
        return PI * 0.5;
    }
    let u = compactness.clamp(0.0, 0.33);
    let steps = 64usize;
    let dt = 1.0 / steps as f64;
    let mut sum = 0.0;
    for i in 0..steps {
        let t = (i as f64 + 0.5) * dt;
        let t2 = t * t;
        let radicand = ((2.0 - t2) - 2.0 * u * (3.0 - 3.0 * t2 + t2 * t2)).max(1e-12);
        sum += (2.0 / radicand.sqrt()) * dt;
    }
    sum
}

pub fn compute_visible_surface_fraction(compactness: f64, lensing_on: bool) -> f64 {
    if !lensing_on {
        return 0.5;
    }
    let psi_max = compute_max_visible_angle(compactness, true);
    0.5 * (1.0 - psi_max.min(PI).cos())
}

pub fn compute_pulsar_telemetry(
    compactness: f64,
    spin_period_ms: f64,
    spin_visual_speed: f64,
    lensing_mode: i32,
    obliquity_deg: f64,
) -> PulsarTelemetry {
    let u = compactness.clamp(COMPACTNESS_MIN, COMPACTNESS_MAX);
    let p_ms = spin_period_ms.max(0.1);
    let vis_speed = spin_visual_speed.max(0.0);
    let p_sec = p_ms / 1000.0;

    let stellar_radius_km = SCHWARZSCHILD_RADIUS_1_4_KM / (2.0 * u);
    let schwarzschild_radius = 2.0 * u;

    let beta_eq = ((TAU * stellar_radius_km) / (C_KMS * p_sec)).clamp(0.0, BETA_EQ_MAX);
    let chi = ((0.35 * beta_eq) / u).clamp(0.0, CHI_MAX);
    let spin_a = chi * u;
    let spin_freq_hz = 1000.0 / p_ms;
    let omega_vis = vis_speed * (0.45 + 0.55 * (1.0 + spin_freq_hz / 10.0).ln()).clamp(0.35, 3.2);

    let r_light_cyl_km = (C_KMS * p_sec) / TAU;
    let r_light_cyl_norm = r_light_cyl_km / stellar_radius_km;
    let r_light_cyl_vis = (2.8 + 1.55 * (1.0 + p_ms / 1.5).ln()).clamp(3.4, 10.8);

    let lensing_on = lensing_mode != 0;
    let lensing_strength = if lensing_on { 1.0 } else { 0.0 };
    let obliquity_rad = obliquity_deg.clamp(0.0, 90.0).to_radians();

    let surface_redshift_z = compute_surface_redshift(u);
    let apparent_radius = compute_apparent_radius(u, lensing_on);
    let max_visible_angle_rad = compute_max_visible_angle(u, lensing_on);
    let visible_surface_fraction = compute_visible_surface_fraction(u, lensing_on);

    PulsarTelemetry {
        compactness: u,
        stellar_radius_km,
        schwarzschild_radius,
        spin_a,
        chi,
        beta_eq,
        surface_redshift_z,
        apparent_radius,
        max_visible_angle_rad,
        visible_surface_fraction,
        r_light_cyl_km,
        r_light_cyl_norm,
        r_light_cyl_vis,
        spin_freq_hz,
        omega_vis,
        lensing_strength,
        obliquity_rad,
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

#[derive(Clone, Copy)]
struct PulsarPose {
    pos: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

fn compute_pulsar_pose(
    distance: f32,
    pivot: [f32; 3],
    azimuth: f32,
    elevation: f32,
    roll: f32,
    look_yaw: f32,
    look_pitch: f32,
) -> PulsarPose {
    let safe_dist = distance.clamp(MIN_DISTANCE, MAX_DISTANCE);
    let (sel, cel) = elevation.sin_cos();
    let (saz, caz) = azimuth.sin_cos();

    let f0 = [cel * saz, -sel, -cel * caz];
    let r0 = [caz, 0.0, saz];
    let u0 = [sel * saz, cel, -sel * caz];

    let pos = [
        pivot[0] - f0[0] * safe_dist,
        pivot[1] - f0[1] * safe_dist,
        pivot[2] - f0[2] * safe_dist,
    ];

    let (sy, cy) = look_yaw.sin_cos();
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

    let (sp, cp) = look_pitch.sin_cos();
    let forward = [
        cp * fy[0] + sp * u0[0],
        cp * fy[1] + sp * u0[1],
        cp * fy[2] + sp * u0[2],
    ];
    let u_p = [
        -sp * fy[0] + cp * u0[0],
        -sp * fy[1] + cp * u0[1],
        -sp * fy[2] + cp * u0[2],
    ];

    let (sr, cr) = roll.sin_cos();
    let right = [
        cr * ry[0] + sr * u_p[0],
        cr * ry[1] + sr * u_p[1],
        cr * ry[2] + sr * u_p[2],
    ];
    let up = [
        -sr * ry[0] + cr * u_p[0],
        -sr * ry[1] + cr * u_p[1],
        -sr * ry[2] + cr * u_p[2],
    ];

    PulsarPose {
        pos,
        right,
        up,
        forward,
    }
}

struct PulsarFlight {
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

struct PulsarCamera {
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

    flight: Option<PulsarFlight>,
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    pose: PulsarPose,
    moved: bool,
    prev_sig: Option<[f32; 13]>,
}

impl PulsarCamera {
    fn from_preset(p: &PulsarPreset) -> Self {
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
            pose: compute_pulsar_pose(d0, piv0, az0, el0, roll0, yaw0, pitch0),
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn fly_to(&mut self, p: &PulsarPreset, duration: f32) {
        let dest_dist = p.distance.clamp(MIN_DISTANCE, MAX_DISTANCE);
        let dest_pivot = clamp_pivot(p.pivot);
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az = self.azimuth + wrap_angle_delta(p.azimuth_deg * DEG2RAD - self.azimuth);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let dest_yaw = self.look_yaw + wrap_angle_delta(p.look_yaw_deg * DEG2RAD - self.look_yaw);
        let dest_pitch = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);

        if duration <= 0.0 {
            self.flight = None;
            self.distance = dest_dist;
            self.target_distance = dest_dist;
            self.pivot = dest_pivot;
            self.target_pivot = dest_pivot;
            self.elevation = dest_el;
            self.target_elevation = dest_el;
            self.azimuth = dest_az;
            self.target_azimuth = dest_az;
            self.roll = dest_roll;
            self.target_roll = dest_roll;
            self.fov = dest_fov;
            self.target_fov = dest_fov;
            self.look_yaw = dest_yaw;
            self.target_look_yaw = dest_yaw;
            self.look_pitch = dest_pitch;
            self.target_look_pitch = dest_pitch;
            self.vel_distance = 0.0;
            self.vel_pivot = [0.0; 3];
            self.vel_elevation = 0.0;
            self.vel_azimuth = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.vel_look_yaw = 0.0;
            self.vel_look_pitch = 0.0;
            self.auto_base_elevation = dest_el;
            self.auto_orbit_time = 0.0;
            self.interaction_cooldown = 0.0;
            self.recompute_basis();
            self.moved = true;
        } else {
            self.flight = Some(PulsarFlight {
                elapsed: 0.0,
                duration,
                start_dist: self.distance,
                start_pivot: self.pivot,
                start_el: self.elevation,
                start_az: self.azimuth,
                start_roll: self.roll,
                start_fov: self.fov,
                start_yaw: self.look_yaw,
                start_pitch: self.look_pitch,
                end_dist: dest_dist,
                end_pivot: dest_pivot,
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
            let factor = (delta * 0.00115).exp();
            self.target_distance =
                (self.target_distance * factor).clamp(MIN_DISTANCE, MAX_DISTANCE);
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let orbit_rate = 0.85 * cdt;
            let elev_rate = 0.65 * cdt;
            let roll_rate = 0.75 * cdt;
            let zoom_factor = (0.75 * cdt).exp();

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
                self.target_distance =
                    (self.target_distance / zoom_factor).clamp(MIN_DISTANCE, MAX_DISTANCE);
            }
            if input.key_s {
                self.target_distance =
                    (self.target_distance * zoom_factor).clamp(MIN_DISTANCE, MAX_DISTANCE);
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

            self.distance =
                (f.start_dist + (f.end_dist - f.start_dist) * e).clamp(MIN_DISTANCE, MAX_DISTANCE);
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
                let (nd, vd) = step_critically_damped(
                    self.distance,
                    self.vel_distance,
                    self.target_distance,
                    SPRING_OMEGA,
                    cdt,
                );
                self.distance = nd.clamp(MIN_DISTANCE, MAX_DISTANCE);
                self.vel_distance = vd;

                for i in 0..3 {
                    let (np, vp) = step_critically_damped(
                        self.pivot[i],
                        self.vel_pivot[i],
                        self.target_pivot[i],
                        SPRING_OMEGA,
                        cdt,
                    );
                    self.pivot[i] = np;
                    self.vel_pivot[i] = vp;
                }

                let (ne, ve) = step_critically_damped(
                    self.elevation,
                    self.vel_elevation,
                    self.target_elevation,
                    SPRING_OMEGA,
                    cdt,
                );
                self.elevation = ne;
                self.vel_elevation = ve;

                let (na, va) = step_critically_damped(
                    self.azimuth,
                    self.vel_azimuth,
                    self.target_azimuth,
                    SPRING_OMEGA,
                    cdt,
                );
                self.azimuth = na;
                self.vel_azimuth = va;

                let (nr, vr) = step_critically_damped(
                    self.roll,
                    self.vel_roll,
                    self.target_roll,
                    SPRING_OMEGA,
                    cdt,
                );
                self.roll = nr;
                self.vel_roll = vr;

                let (nf, vf) = step_critically_damped(
                    self.fov,
                    self.vel_fov,
                    self.target_fov,
                    SPRING_OMEGA,
                    cdt,
                );
                self.fov = nf;
                self.vel_fov = vf;

                let (ny, vy) = step_critically_damped(
                    self.look_yaw,
                    self.vel_look_yaw,
                    self.target_look_yaw,
                    SPRING_OMEGA,
                    cdt,
                );
                self.look_yaw = ny;
                self.vel_look_yaw = vy;

                let (np, vp) = step_critically_damped(
                    self.look_pitch,
                    self.vel_look_pitch,
                    self.target_look_pitch,
                    SPRING_OMEGA,
                    cdt,
                );
                self.look_pitch = np;
                self.vel_look_pitch = vp;
            }
        }

        self.recompute_basis();
    }

    fn recompute_basis(&mut self) {
        self.pose = compute_pulsar_pose(
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
            for i in 0..13 {
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

pub struct PulsarSim {
    active_preset: Option<usize>,
    lensing_mode: i32,
    compactness: f32,
    spin_period_ms: f32,
    spin_visual_speed: f32,
    spin_phase: f32,

    obliquity_deg: f32,
    twist_shear: f32,
    beam_intensity: f32,
    plasma_density: f32,
    pwn_visibility: f32,
    polar_cap_temp_k: f32,
    crust_temp_k: f32,
    beam_cone_half_angle: f32,
    magnetar_crack_glow: f32,
    pwn_jet_power: f32,

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
    camera: PulsarCamera,

    pipeline: wgpu::RenderPipeline,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl PulsarSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];
        let shader = assets
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("pulsar-shader"),
                source: wgpu::ShaderSource::Wgsl(shaders::PULSAR.into()),
            });
        let pipeline = make_fs_pipe(
            &assets.device,
            "pulsar-pipeline",
            &assets.standard_sim_bgl,
            &shader,
            wgpu::TextureFormat::Rgba16Float,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pulsar-ubo"),
            size: std::mem::size_of::<PulsarUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("pulsar-bg", &ubo, None);

        Self {
            active_preset: Some(0),
            lensing_mode: p.lensing_mode,
            compactness: p.compactness,
            spin_period_ms: p.spin_period_ms,
            spin_visual_speed: p.spin_visual_speed,
            spin_phase: 0.0,
            obliquity_deg: p.obliquity_deg,
            twist_shear: p.twist_shear,
            beam_intensity: p.beam_intensity,
            plasma_density: p.plasma_density,
            pwn_visibility: p.pwn_visibility,
            polar_cap_temp_k: p.polar_cap_temp_k,
            crust_temp_k: p.crust_temp_k,
            beam_cone_half_angle: p.beam_cone_half_angle,
            magnetar_crack_glow: p.magnetar_crack_glow,
            pwn_jet_power: p.pwn_jet_power,
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
            camera: PulsarCamera::from_preset(p),
            pipeline,
            ubo,
            bind_group,
        }
    }

    fn telemetry(&self) -> PulsarTelemetry {
        compute_pulsar_telemetry(
            self.compactness as f64,
            self.spin_period_ms as f64,
            self.spin_visual_speed as f64,
            self.lensing_mode,
            self.obliquity_deg as f64,
        )
    }

    fn build_uniforms(
        &self,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        is_progressive: bool,
    ) -> PulsarUniforms {
        let tel = self.telemetry();
        PulsarUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_lensing: [
                jitter[0],
                jitter[1],
                self.camera.fov,
                tel.lensing_strength as f32,
            ],
            cam_pos_compactness: [
                self.camera.pose.pos[0],
                self.camera.pose.pos[1],
                self.camera.pose.pos[2],
                tel.compactness as f32,
            ],
            cam_right_spin_a: [
                self.camera.pose.right[0],
                self.camera.pose.right[1],
                self.camera.pose.right[2],
                tel.spin_a as f32,
            ],
            cam_up_beta_eq: [
                self.camera.pose.up[0],
                self.camera.pose.up[1],
                self.camera.pose.up[2],
                tel.beta_eq as f32,
            ],
            cam_fwd_phase: [
                self.camera.pose.forward[0],
                self.camera.pose.forward[1],
                self.camera.pose.forward[2],
                self.spin_phase,
            ],
            magnet_params: [
                tel.obliquity_rad as f32,
                self.twist_shear,
                tel.r_light_cyl_vis as f32,
                self.plasma_density,
            ],
            beam_pwn_params: [
                self.beam_intensity,
                self.pwn_visibility,
                self.polar_cap_temp_k,
                self.crust_temp_k,
            ],
            sky_params: [
                self.sky_intensity,
                self.sky_mode as f32,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            quality_params: [
                self.quality as f32,
                self.spin_visual_speed,
                if is_progressive { 1.0 } else { 0.0 },
                tel.surface_redshift_z as f32,
            ],
            extra_params: [
                self.beam_cone_half_angle,
                self.magnetar_crack_glow,
                self.pwn_jet_power,
                0.0,
            ],
        }
    }
}

impl Simulation for PulsarSim {
    fn id(&self) -> SimId {
        SimId::Pulsar
    }

    fn post_tuning(&self) -> PostTuning {
        PostTuning::pulsar()
    }

    fn post_params(&self, camera_moved: bool, sim_time: f32) -> PostFrameParams {
        let tel = self.telemetry();
        let motion = camera_moved || (!self.paused && tel.omega_vis > 0.0);
        PostFrameParams {
            exposure: self.exposure,
            bloom_intensity: self.bloom_intensity,
            anamorphic_intensity: self.anamorphic_intensity,
            paused: self.paused,
            camera_moved: motion,
            sim_time,
            resolution_scale: self.resolution_scale,
            tuning: PostTuning::pulsar(),
        }
    }

    fn presets(&self) -> Vec<PresetMeta> {
        PRESETS.iter().map(|p| p.meta).collect()
    }

    fn active_preset_index(&self) -> Option<usize> {
        self.active_preset
    }

    fn apply_preset(&mut self, index: usize) {
        if let Some(p) = PRESETS.get(index) {
            self.active_preset = Some(index);
            self.lensing_mode = p.lensing_mode;
            self.compactness = p.compactness;
            self.spin_period_ms = p.spin_period_ms;
            self.spin_visual_speed = p.spin_visual_speed;
            self.obliquity_deg = p.obliquity_deg;
            self.twist_shear = p.twist_shear;
            self.beam_intensity = p.beam_intensity;
            self.plasma_density = p.plasma_density;
            self.pwn_visibility = p.pwn_visibility;
            self.polar_cap_temp_k = p.polar_cap_temp_k;
            self.crust_temp_k = p.crust_temp_k;
            self.beam_cone_half_angle = p.beam_cone_half_angle;
            self.magnetar_crack_glow = p.magnetar_crack_glow;
            self.pwn_jet_power = p.pwn_jet_power;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.auto_orbit = p.auto_orbit;
            self.camera.fly_to(p, 1.1);
        }
    }

    fn control_sections(&self) -> Vec<ControlSection> {
        vec![
            ControlSection {
                id: "spacetime",
                title: "Spacetime & Spin",
                default_open: true,
                items: vec![
                    ControlItem {
                        key: "lensingMode",
                        label: "Spacetime Curvature",
                        kind: ControlKind::Segmented {
                            options: vec![(1, "GR Curved"), (0, "Flat Space")],
                        },
                    },
                    ControlItem {
                        key: "compactness",
                        label: "Compactness (M/R)",
                        kind: ControlKind::Range {
                            min: 0.12,
                            max: 0.30,
                            step: 0.005,
                            hints: Some(["0.12 (17.2 km)", "0.30 (6.9 km)"]),
                        },
                    },
                    ControlItem {
                        key: "spinPeriodMs",
                        label: "Spin Period (P)",
                        kind: ControlKind::Range {
                            min: 1.4,
                            max: 500.0,
                            step: 0.1,
                            hints: Some(["1.4 ms (MSP)", "500 ms (Magnetar)"]),
                        },
                    },
                    ControlItem {
                        key: "spinVisualSpeed",
                        label: "Spin Visual Speed",
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
                id: "magnetosphere",
                title: "Magnetosphere & PWN",
                default_open: true,
                items: vec![
                    ControlItem {
                        key: "obliquityDeg",
                        label: "Magnetic Obliquity (α)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 90.0,
                            step: 1.0,
                            hints: Some(["0° Aligned", "90° Orthogonal"]),
                        },
                    },
                    ControlItem {
                        key: "twistShear",
                        label: "Magnetospheric Twist",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "beamIntensity",
                        label: "Lighthouse Beam Gain",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "plasmaDensity",
                        label: "Pair-Plasma Density",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "pwnVisibility",
                        label: "PWN Torus & Jets",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "magnetarCrackGlow",
                        label: "Magnetar Shear Arcs",
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
                            options: vec![(0, "4K Milky Way"), (1, "Procedural")],
                        },
                    },
                    ControlItem {
                        key: "quality",
                        label: "Ray-Trace Quality",
                        kind: ControlKind::Segmented {
                            options: vec![(0, "Performance"), (1, "Balanced"), (2, "Cinema")],
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
            "compactness" => self.compactness,
            "spinPeriodMs" => self.spin_period_ms,
            "spinVisualSpeed" => self.spin_visual_speed,
            "obliquityDeg" => self.obliquity_deg,
            "twistShear" => self.twist_shear,
            "beamIntensity" => self.beam_intensity,
            "plasmaDensity" => self.plasma_density,
            "pwnVisibility" => self.pwn_visibility,
            "magnetarCrackGlow" => self.magnetar_crack_glow,
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
            "compactness" => self.compactness = val,
            "spinPeriodMs" => self.spin_period_ms = val,
            "spinVisualSpeed" => self.spin_visual_speed = val,
            "obliquityDeg" => self.obliquity_deg = val,
            "twistShear" => self.twist_shear = val,
            "beamIntensity" => self.beam_intensity = val,
            "plasmaDensity" => self.plasma_density = val,
            "pwnVisibility" => self.pwn_visibility = val,
            "magnetarCrackGlow" => self.magnetar_crack_glow = val,
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
            "lensingMode" => self.lensing_mode,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "lensingMode" => {
                self.lensing_mode = if val == 0 { 0 } else { 1 };
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
            "compactness" => format!("{:.3}", self.compactness),
            "spinPeriodMs" => {
                if self.spin_period_ms < 10.0 {
                    format!("{:.2} ms", self.spin_period_ms)
                } else {
                    format!("{:.1} ms", self.spin_period_ms)
                }
            }
            "spinVisualSpeed" => format!("{:.2}×", self.spin_visual_speed),
            "obliquityDeg" => format!("{}°", self.obliquity_deg.round() as i32),
            "twistShear" => format!("{:.2}", self.twist_shear),
            "beamIntensity" => format!("{:.2}", self.beam_intensity),
            "plasmaDensity" => format!("{:.2}", self.plasma_density),
            "pwnVisibility" => format!("{:.2}", self.pwn_visibility),
            "magnetarCrackGlow" => format!("{:.2}", self.magnetar_crack_glow),
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
        let secondary_badge = if assets.sky_map_loaded {
            "4K Milky Way".to_string()
        } else {
            "Procedural Sky".to_string()
        };

        let curv_label = if self.lensing_mode == 0 {
            "Flat Space"
        } else {
            "GR Curved"
        };

        let lc_km_str = if tel.r_light_cyl_km >= 10000.0 {
            format!("{:.1}k km", tel.r_light_cyl_km / 1000.0)
        } else {
            format!("{} km", tel.r_light_cyl_km.round() as i64)
        };
        let lc_norm_str = if tel.r_light_cyl_norm >= 100.0 {
            format!("{} R*", tel.r_light_cyl_norm.round() as i64)
        } else {
            format!("{:.1} R*", tel.r_light_cyl_norm)
        };
        let spin_freq_str = if tel.spin_freq_hz >= 10.0 {
            format!("{:.1} Hz", tel.spin_freq_hz)
        } else {
            format!("{:.2} Hz", tel.spin_freq_hz)
        };

        HudMetadata {
            brand_title: "MAGNETAR & PULSAR",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: true,
            drawer_title: "Magnetosphere & GR Optics",
            drawer_subtitle: format!(
                "{} · M/R {:.3} · z {:.3}",
                curv_label, tel.compactness, tel.surface_redshift_z
            ),
            hint_text: "Drag to orbit · Right-drag roll · Scroll zoom · Space 128× Still · H HUD",
            telemetry: [
                TelemetryCell {
                    label: "REDSHIFT",
                    unit: "z",
                    value: format!("{:.3}", tel.surface_redshift_z),
                },
                TelemetryCell {
                    label: "VISIBLE CRUST",
                    unit: "f_vis",
                    value: format!("{:.1}%", tel.visible_surface_fraction * 100.0),
                },
                TelemetryCell {
                    label: "LIGHT CYLINDER",
                    unit: "R_LC",
                    value: format!("{lc_km_str} / {lc_norm_str}"),
                },
                TelemetryCell {
                    label: "SPIN FREQ",
                    unit: "f_spin",
                    value: spin_freq_str,
                },
                TelemetryCell {
                    label: "COMPACTNESS",
                    unit: "M/R",
                    value: format!("{:.3} · {:.1} km", tel.compactness, tel.stellar_radius_km),
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: None,
            orbit_toggle_label: "Orbit",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        let cdt = dt.clamp(0.0, 0.05);
        let tel = self.telemetry();
        if !self.paused {
            self.sim_time += cdt;
            self.spin_phase =
                (self.spin_phase + cdt * tel.omega_vis as f32).rem_euclid(std::f32::consts::TAU);
        }
        self.camera.update(cdt, self.paused, self.auto_orbit, input);
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: false,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("pulsar-bg", &self.ubo, None);
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
        run_fs_pass(
            encoder,
            "pulsar-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
        );
    }
}
