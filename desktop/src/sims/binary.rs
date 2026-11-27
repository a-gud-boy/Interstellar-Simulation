use std::f32::consts::{PI, TAU};
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::renderer::post::{PostFrameParams, PostTuning, run_fs_pass};
use crate::renderer::{SharedGpuAssets, SimBglKind};
use crate::shaders;
use crate::sims::blackhole::format_thousands;
use crate::sims::{
    ControlItem, ControlKind, ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation,
    StepOutcome, TelemetryCell, ease_out_cubic, step_critically_damped, wrap_angle_delta,
};

const DEG2RAD: f32 = PI / 180.0;
const RAD2DEG: f32 = 180.0 / PI;

const MIN_RADIUS: f32 = 5.0;
const MAX_RADIUS: f32 = 95.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 22.0 * DEG2RAD;
const MAX_FOV: f32 = 85.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.042;
const AUTO_BREATH_AMP: f32 = 0.009;
const AUTO_BREATH_FREQ: f32 = 0.22;
const INTERACTION_COOLDOWN: f32 = 2.4;

const TIDAL_SIZE: u32 = 256;

const CLAMP_MIN_Q: f64 = 0.05;
const CLAMP_MAX_Q: f64 = 1.0;
const CLAMP_MIN_SEP: f64 = 1.4;
const CLAMP_MAX_SEP: f64 = 24.0;
const FIDUCIAL_TOTAL_MASS_SEC: f64 = 2.9553e-4;
const RINGDOWN_DURATION_SEC: f64 = 1.8;
const PLUNGE_SEP_THRESHOLD: f64 = 1.65;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct TidalUniforms {
    sep_q_omega_dens: [f32; 4],
    bridge_outer_half_t: [f32; 4],
    dt_reset_roche: [f32; 4],
    cav_ringdown_pad: [f32; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct BinaryUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_phase: [f32; 4],
    cam_pos_rel_mode: [f32; 4],
    cam_right_lensing: [f32; 4],
    cam_up_disk_temp: [f32; 4],
    cam_forward_disk_dens: [f32; 4],
    disk_params: [f32; 4],
    gw_sky_params: [f32; 4],
    modes_pad: [i32; 4],
    binary_mass_sep: [f32; 4],
    binary_c1_omega: [f32; 4],
    binary_c2_gw_omega: [f32; 4],
    binary_v1_rh1: [f32; 4],
    binary_v2_rh2: [f32; 4],
    field_ray_consts: [f32; 4],
    flow_consts: [f32; 4],
    rot_trig_sky_trig: [f32; 4],
    sky_y_ringdown: [f32; 4],
}

#[derive(Clone, Copy)]
struct BinaryPreset {
    meta: PresetMeta,
    mass_ratio: f32,
    separation: f32,
    orbital_inclination: f32,
    gw_amplitude: f32,
    inspiral_mode: i32,
    time_warp: f32,
    lensing: f32,
    rel_mode: f32,
    initial_phase_deg: f32,
    disk_temp: f32,
    disk_density: f32,
    bridge_intensity: f32,
    disk_thickness: f32,
    disk_outer_radius: f32,
    turbulence: f32,
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
    auto_orbit: bool,
}

const PRESETS: [BinaryPreset; 6] = [
    BinaryPreset {
        meta: PresetMeta {
            id: "equal_mass",
            full_name: "Equal-Mass Inspiral",
            short_label: "Equal-Mass",
            hotkey: "1",
        },
        mass_ratio: 1.0,
        separation: 7.4,
        orbital_inclination: 74.0,
        gw_amplitude: 0.75,
        inspiral_mode: 1,
        time_warp: 1.0,
        lensing: 1.0,
        rel_mode: 0.65,
        initial_phase_deg: 22.0,
        disk_temp: 6600.0,
        disk_density: 1.15,
        bridge_intensity: 1.25,
        disk_thickness: 0.90,
        disk_outer_radius: 28.0,
        turbulence: 1.10,
        exposure: 1.05,
        bloom: 0.55,
        anamorphic: 0.25,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [0.42, 0.22],
        radius: 36.0,
        elevation_deg: 16.0,
        azimuth_deg: 0.0,
        roll_deg: -4.0,
        fov_deg: 46.0,
        auto_orbit: true,
    },
    BinaryPreset {
        meta: PresetMeta {
            id: "emri",
            full_name: "Extreme Mass Ratio (10:1)",
            short_label: "10:1 EMRI",
            hotkey: "2",
        },
        mass_ratio: 0.10,
        separation: 8.4,
        orbital_inclination: 70.0,
        gw_amplitude: 0.65,
        inspiral_mode: 0,
        time_warp: 1.0,
        lensing: 1.0,
        rel_mode: 0.72,
        initial_phase_deg: 18.0,
        disk_temp: 7200.0,
        disk_density: 1.10,
        bridge_intensity: 1.45,
        disk_thickness: 0.85,
        disk_outer_radius: 28.0,
        turbulence: 1.15,
        exposure: 1.05,
        bloom: 0.52,
        anamorphic: 0.22,
        sky_intensity: 0.92,
        sky_mode: 0,
        sky_rot: [0.85, 0.18],
        radius: 32.0,
        elevation_deg: 20.0,
        azimuth_deg: 0.0,
        roll_deg: -3.0,
        fov_deg: 46.0,
        auto_orbit: true,
    },
    BinaryPreset {
        meta: PresetMeta {
            id: "eyebrows",
            full_name: "Edge-On Eyebrow Shadows",
            short_label: "Eyebrows",
            hotkey: "3",
        },
        mass_ratio: 1.0,
        separation: 6.2,
        orbital_inclination: 88.2,
        gw_amplitude: 0.40,
        inspiral_mode: 0,
        time_warp: 0.55,
        lensing: 1.0,
        rel_mode: 0.55,
        initial_phase_deg: 74.0,
        disk_temp: 6200.0,
        disk_density: 0.42,
        bridge_intensity: 0.75,
        disk_thickness: 0.72,
        disk_outer_radius: 26.0,
        turbulence: 0.95,
        exposure: 1.08,
        bloom: 0.48,
        anamorphic: 0.18,
        sky_intensity: 1.35,
        sky_mode: 0,
        sky_rot: [0.28, 0.14],
        radius: 26.0,
        elevation_deg: 1.8,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 44.0,
        auto_orbit: false,
    },
    BinaryPreset {
        meta: PresetMeta {
            id: "tidal_bridges",
            full_name: "Tidal Gas Bridges",
            short_label: "Tidal Bridges",
            hotkey: "4",
        },
        mass_ratio: 0.85,
        separation: 8.8,
        orbital_inclination: 32.0,
        gw_amplitude: 0.50,
        inspiral_mode: 0,
        time_warp: 1.0,
        lensing: 1.0,
        rel_mode: 0.50,
        initial_phase_deg: 15.0,
        disk_temp: 6900.0,
        disk_density: 1.30,
        bridge_intensity: 1.90,
        disk_thickness: 0.95,
        disk_outer_radius: 32.0,
        turbulence: 1.25,
        exposure: 1.02,
        bloom: 0.60,
        anamorphic: 0.24,
        sky_intensity: 0.80,
        sky_mode: 0,
        sky_rot: [1.45, -0.22],
        radius: 40.0,
        elevation_deg: 58.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 48.0,
        auto_orbit: true,
    },
    BinaryPreset {
        meta: PresetMeta {
            id: "pre_merger",
            full_name: "Pre-Merger Plunge",
            short_label: "Plunge",
            hotkey: "5",
        },
        mass_ratio: 1.0,
        separation: 3.4,
        orbital_inclination: 76.0,
        gw_amplitude: 2.15,
        inspiral_mode: 1,
        time_warp: 1.35,
        lensing: 1.0,
        rel_mode: 0.85,
        initial_phase_deg: 30.0,
        disk_temp: 8200.0,
        disk_density: 1.15,
        bridge_intensity: 1.55,
        disk_thickness: 0.90,
        disk_outer_radius: 24.0,
        turbulence: 1.30,
        exposure: 0.98,
        bloom: 0.64,
        anamorphic: 0.34,
        sky_intensity: 1.10,
        sky_mode: 0,
        sky_rot: [-0.55, 0.28],
        radius: 24.0,
        elevation_deg: 14.0,
        azimuth_deg: 0.0,
        roll_deg: -6.0,
        fov_deg: 48.0,
        auto_orbit: true,
    },
    BinaryPreset {
        meta: PresetMeta {
            id: "vacuum",
            full_name: "Pure Vacuum Binary",
            short_label: "Vacuum GW",
            hotkey: "6",
        },
        mass_ratio: 1.0,
        separation: 5.8,
        orbital_inclination: 83.5,
        gw_amplitude: 2.40,
        inspiral_mode: 0,
        time_warp: 1.0,
        lensing: 1.0,
        rel_mode: 0.70,
        initial_phase_deg: 66.0,
        disk_temp: 6600.0,
        disk_density: 0.0,
        bridge_intensity: 0.0,
        disk_thickness: 0.90,
        disk_outer_radius: 26.0,
        turbulence: 1.0,
        exposure: 1.15,
        bloom: 0.36,
        anamorphic: 0.14,
        sky_intensity: 1.85,
        sky_mode: 0,
        sky_rot: [0.18, 0.12],
        radius: 24.5,
        elevation_deg: 6.5,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 45.0,
        auto_orbit: false,
    },
];

pub fn eggleton_roche_radius(d: f64, m_self: f64, m_other: f64) -> f64 {
    if m_self <= 0.0 {
        return 0.0;
    }
    if m_other <= 0.0 {
        return d;
    }
    let q = m_self / m_other;
    let q13 = q.cbrt();
    let q23 = q13 * q13;
    d * ((0.49 * q23) / (0.6 * q23 + (1.0 + q13).ln()))
}

pub fn peters_mathews_rate(d: f64, eta: f64) -> f64 {
    let safe_d = d.max(1.0);
    -(64.0 / 5.0) * (eta / (safe_d * safe_d * safe_d))
}

pub fn peters_mathews_time_to_merger(d: f64, eta: f64) -> f64 {
    let safe_d = d.max(0.0);
    let safe_eta = eta.max(1e-8);
    (5.0 / (256.0 * safe_eta)) * safe_d.powi(4)
}

#[derive(Clone, Debug)]
pub struct BinaryState {
    pub q: f64,
    pub d: f64,
    pub m1: f64,
    pub m2: f64,
    pub eta: f64,
    pub chirp_mass: f64,
    pub omega: f64,
    pub gw_wave_omega: f64,
    pub v_orbital_c: f64,
    pub f_gw_dimless: f64,
    pub f_gw_hz: f64,
    pub phase_rad: f64,
    pub gw_phase_rad: f64,
    pub c1: [f64; 3],
    pub c2: [f64; 3],
    pub v1: [f64; 3],
    pub v2: [f64; 3],
    pub r_h1: f64,
    pub r_h2: f64,
    pub phi_saddle: f64,
    pub roche_l1: f64,
    pub roche_l2: f64,
    pub r_cavity: f64,
    pub time_to_merger_m: f64,
    pub ringdown_factor: f64,
}

pub fn compute_binary_state(mass_ratio: f64, separation: f64, phase_rad: f64) -> BinaryState {
    let q = mass_ratio.clamp(CLAMP_MIN_Q, CLAMP_MAX_Q);
    let d = separation.clamp(CLAMP_MIN_SEP, CLAMP_MAX_SEP);

    let m1 = 1.0 / (1.0 + q);
    let m2 = q / (1.0 + q);
    let eta = m1 * m2;
    let chirp_mass = eta.max(0.0).powf(0.6);

    let sqrt_d = d.sqrt();
    let omega = 1.0 / (d * sqrt_d + 0.5 * (3.0 - eta) * sqrt_d);
    let v_orbital_c = omega.cbrt().min(0.99);

    let f_gw_dimless = omega / std::f64::consts::PI;
    let f_gw_hz = f_gw_dimless / FIDUCIAL_TOTAL_MASS_SEC;
    let gw_phase_rad = 2.0 * phase_rad;
    let gw_wave_omega = (omega * 2.8).clamp(0.10, 0.42);

    let r1 = m2 * d;
    let r2 = m1 * d;
    let c_phi = phase_rad.cos();
    let s_phi = phase_rad.sin();

    let c1 = [-r1 * c_phi, 0.0, r1 * s_phi];
    let c2 = [r2 * c_phi, 0.0, -r2 * s_phi];
    let v1 = [omega * c1[2], 0.0, -omega * c1[0]];
    let v2 = [omega * c2[2], 0.0, -omega * c2[0]];

    let r_h1 = 0.5 * m1;
    let r_h2 = 0.5 * m2;
    let phi_saddle = (1.0 + 2.0 * eta.max(0.0).sqrt()) / (2.0 * d);
    let roche_l1 = eggleton_roche_radius(d, m1, m2);
    let roche_l2 = eggleton_roche_radius(d, m2, m1);
    let r_cavity = d * (1.65 + 0.55 * (4.0 * eta).max(0.0).sqrt());

    BinaryState {
        q,
        d,
        m1,
        m2,
        eta,
        chirp_mass,
        omega,
        gw_wave_omega,
        v_orbital_c,
        f_gw_dimless,
        f_gw_hz,
        phase_rad,
        gw_phase_rad,
        c1,
        c2,
        v1,
        v2,
        r_h1,
        r_h2,
        phi_saddle,
        roche_l1,
        roche_l2,
        r_cavity,
        time_to_merger_m: peters_mathews_time_to_merger(d, eta.max(1e-4)),
        ringdown_factor: 0.0,
    }
}

#[derive(Clone, Debug)]
pub struct OrbitState {
    pub current_sep: f64,
    pub phase: f64,
    pub in_ringdown: bool,
    pub ringdown_timer: f64,
    pub ringdown_factor: f64,
}

pub fn step_binary_orbit(
    orbit: &mut OrbitState,
    mass_ratio: f64,
    target_separation: f64,
    inspiral_mode: i32,
    time_warp: f64,
    dt_sec: f64,
) {
    let tw = time_warp.clamp(0.0, 4.0);
    let dt = dt_sec.max(0.0);
    let geo_dt = dt * 15.0 * tw;
    let target_sep = target_separation.clamp(CLAMP_MIN_SEP, CLAMP_MAX_SEP);

    let q = mass_ratio.clamp(CLAMP_MIN_Q, CLAMP_MAX_Q);
    let m1 = 1.0 / (1.0 + q);
    let m2 = q / (1.0 + q);
    let eta = m1 * m2;

    if inspiral_mode == 1 {
        if orbit.in_ringdown {
            orbit.ringdown_timer += dt * tw;
            let u = (orbit.ringdown_timer / RINGDOWN_DURATION_SEC).clamp(0.0, 1.0);
            orbit.ringdown_factor = (std::f64::consts::PI * u).sin();
            let bin = compute_binary_state(q, PLUNGE_SEP_THRESHOLD, orbit.phase);
            orbit.phase = (orbit.phase + bin.omega * geo_dt) % (2.0 * std::f64::consts::PI);
            if orbit.ringdown_timer >= RINGDOWN_DURATION_SEC {
                orbit.in_ringdown = false;
                orbit.ringdown_timer = 0.0;
                orbit.ringdown_factor = 0.0;
                orbit.current_sep = target_sep;
            }
        } else {
            let d0 = orbit.current_sep.clamp(PLUNGE_SEP_THRESHOLD, CLAMP_MAX_SEP);
            let k1 = peters_mathews_rate(d0, eta) * 0.35;
            let d_mid = (d0 + 0.5 * geo_dt * k1).max(1.2);
            let k2 = peters_mathews_rate(d_mid, eta) * 0.35;
            let d_next = d0 + geo_dt * k2;

            let bin_mid = compute_binary_state(q, d_mid, orbit.phase);
            orbit.phase = (orbit.phase + bin_mid.omega * geo_dt) % (2.0 * std::f64::consts::PI);

            if d_next < PLUNGE_SEP_THRESHOLD {
                orbit.current_sep = PLUNGE_SEP_THRESHOLD;
                orbit.in_ringdown = true;
                orbit.ringdown_timer = 0.0;
                orbit.ringdown_factor = 0.0;
            } else {
                orbit.current_sep = d_next;
            }
        }
    } else {
        orbit.in_ringdown = false;
        orbit.ringdown_timer = 0.0;
        orbit.ringdown_factor = 0.0;
        orbit.current_sep = target_sep;
        let bin = compute_binary_state(q, target_sep, orbit.phase);
        orbit.phase = (orbit.phase + bin.omega * geo_dt) % (2.0 * std::f64::consts::PI);
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

struct BinaryCamera {
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
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    pos: [f32; 3],
    basis: [f32; 9],
    moved: bool,
    prev_sig: Option<[f32; 10]>,
}

impl BinaryCamera {
    fn from_preset(p: &BinaryPreset) -> Self {
        let r0 = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let el0 = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az0 = p.azimuth_deg * DEG2RAD;
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let mut cam = Self {
            log_radius: r0.ln(),
            elevation: el0,
            azimuth: az0,
            roll: roll0,
            fov: fov0,
            target_log_radius: r0.ln(),
            target_elevation: el0,
            target_azimuth: az0,
            target_roll: roll0,
            target_fov: fov0,
            vel_log_radius: 0.0,
            vel_elevation: 0.0,
            vel_azimuth: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            flight: None,
            auto_orbit_time: 0.0,
            auto_base_elevation: el0,
            interaction_cooldown: 0.0,
            pos: [0.0, 0.0, r0],
            basis: [0.0; 9],
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn inclination_deg(&self) -> f32 {
        (90.0 - (self.elevation * RAD2DEG).abs()).clamp(5.0, 90.0)
    }

    fn set_inclination_deg(&mut self, incl_deg: f32) {
        let safe_incl = incl_deg.clamp(5.0, 90.0);
        let sign = if self.elevation < -1e-4 { -1.0 } else { 1.0 };
        let target_el = (sign * (90.0 - safe_incl) * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        self.flight = None;
        self.auto_base_elevation = target_el;
        self.target_elevation = target_el;
    }

    fn fly_to(&mut self, p: &BinaryPreset, duration: f32) {
        let dest_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let dest_log_r = dest_r.ln();
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az_raw = p.azimuth_deg * DEG2RAD;
        let dest_az = self.azimuth + wrap_angle_delta(dest_az_raw - self.azimuth);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        self.flight = Some(CameraFlight {
            elapsed: 0.0,
            duration: duration.max(0.01),
            start_log_r: self.log_radius,
            start_el: self.elevation,
            start_az: self.azimuth,
            start_roll: self.roll,
            start_fov: self.fov,
            end_log_r: dest_log_r,
            end_el: dest_el,
            end_az: dest_az,
            end_roll: dest_roll,
            end_fov: dest_fov,
        });
        self.vel_log_radius = 0.0;
        self.vel_elevation = 0.0;
        self.vel_azimuth = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.interaction_cooldown = 0.0;
    }

    fn cancel_flight(&mut self) {
        if self.flight.take().is_some() {
            self.target_log_radius = self.log_radius;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
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
                if input.secondary_drag || input.shift_down {
                    self.target_roll =
                        (self.target_roll + dx * scale * 2.2).clamp(MIN_ROLL, MAX_ROLL);
                } else {
                    self.target_azimuth -= dx * scale * 3.1;
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
            self.target_log_radius =
                (self.target_log_radius + delta * 0.00115).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let orbit_rate = 0.85 * cdt;
            let elev_rate = 0.65 * cdt;
            let zoom_rate = 0.72 * cdt;
            let roll_rate = 0.75 * cdt;
            if input.key_a || input.key_left {
                self.target_azimuth -= orbit_rate;
            }
            if input.key_d || input.key_right {
                self.target_azimuth += orbit_rate;
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
                self.target_log_radius =
                    (self.target_log_radius - zoom_rate).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
            }
            if input.key_s {
                self.target_log_radius =
                    (self.target_log_radius + zoom_rate).clamp(MIN_RADIUS.ln(), MAX_RADIUS.ln());
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
        let fx = -px * inv_r;
        let fy = -py * inv_r;
        let fz = -pz * inv_r;

        let mut r0x = -fz;
        let r0y = 0.0_f32;
        let mut r0z = fx;
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

pub struct BinaryBhSim {
    active_preset: Option<usize>,

    mass_ratio: f32,
    separation: f32,
    orbital_inclination: f32,
    gw_amplitude: f32,
    inspiral_mode: i32,
    time_warp: f32,
    lensing: f32,
    rel_mode: f32,
    initial_phase_deg: f32,
    disk_temp: f32,
    disk_density: f32,
    bridge_intensity: f32,
    disk_thickness: f32,
    disk_outer_radius: f32,
    turbulence: f32,

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

    orbit: OrbitState,
    camera: BinaryCamera,

    tidal_pipeline: Arc<wgpu::ComputePipeline>,
    tidal_ubo: wgpu::Buffer,
    _tidal_tex_a: wgpu::Texture,
    _tidal_tex_b: wgpu::Texture,
    tidal_views: [wgpu::TextureView; 2],
    tidal_bgs: [wgpu::BindGroup; 2],
    tidal_read_idx: usize,
    tidal_write_idx: usize,
    tidal_reset: bool,
    last_tidal_sig: Option<[f32; 5]>,

    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bin_bgs: [wgpu::BindGroup; 2],
}

impl BinaryBhSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];

        let (tidal_bgl, tidal_pipeline) = assets.get_or_create_tidal_pipeline();

        let tidal_ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tidal-ubo"),
            size: std::mem::size_of::<TidalUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let make_tidal_tex = |label: &str| {
            assets.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: TIDAL_SIZE,
                    height: TIDAL_SIZE,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let tidal_tex_a = make_tidal_tex("tidal-field-a");
        let tidal_tex_b = make_tidal_tex("tidal-field-b");
        let tidal_views = [
            tidal_tex_a.create_view(&wgpu::TextureViewDescriptor::default()),
            tidal_tex_b.create_view(&wgpu::TextureViewDescriptor::default()),
        ];

        let tidal_bgs = [
            assets.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("tidal-bg-0"),
                layout: tidal_bgl.as_ref(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: tidal_ubo.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&tidal_views[0]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&assets.s_linear_clamp),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&tidal_views[1]),
                    },
                ],
            }),
            assets.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("tidal-bg-1"),
                layout: tidal_bgl.as_ref(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: tidal_ubo.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&tidal_views[1]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&assets.s_linear_clamp),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&tidal_views[0]),
                    },
                ],
            }),
        ];

        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::BinaryBh,
            "binary",
            SimBglKind::Binary,
            shaders::BINARY,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("binary-ubo"),
            size: std::mem::size_of::<BinaryUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bin_bgs = [
            assets.build_standard_bind_group("binary-bg-0", &ubo, Some(&tidal_views[0])),
            assets.build_standard_bind_group("binary-bg-1", &ubo, Some(&tidal_views[1])),
        ];

        let mut sim = Self {
            active_preset: Some(0),
            mass_ratio: p.mass_ratio,
            separation: p.separation,
            orbital_inclination: p.orbital_inclination,
            gw_amplitude: p.gw_amplitude,
            inspiral_mode: p.inspiral_mode,
            time_warp: p.time_warp,
            lensing: p.lensing,
            rel_mode: p.rel_mode,
            initial_phase_deg: p.initial_phase_deg,
            disk_temp: p.disk_temp,
            disk_density: p.disk_density,
            bridge_intensity: p.bridge_intensity,
            disk_thickness: p.disk_thickness,
            disk_outer_radius: p.disk_outer_radius,
            turbulence: p.turbulence,
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
            orbit: OrbitState {
                current_sep: p.separation as f64,
                phase: (p.initial_phase_deg as f64) * std::f64::consts::PI / 180.0,
                in_ringdown: false,
                ringdown_timer: 0.0,
                ringdown_factor: 0.0,
            },
            camera: BinaryCamera::from_preset(p),
            tidal_pipeline,
            tidal_ubo,
            _tidal_tex_a: tidal_tex_a,
            _tidal_tex_b: tidal_tex_b,
            tidal_views,
            tidal_bgs,
            tidal_read_idx: 0,
            tidal_write_idx: 1,
            tidal_reset: true,
            last_tidal_sig: None,
            pipeline,
            ubo,
            bin_bgs,
        };

        // Seed initial tidal field immediately on startup
        let mut enc = assets
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("init-tidal"),
            });
        let bin = sim.active_binary_state();
        let half_sz = (sim.disk_outer_radius * 1.15).max(bin.d as f32 * 3.8);
        sim.dispatch_tidal(assets, &mut enc, &bin, half_sz, 0.0, true);
        assets.queue.submit([enc.finish()]);

        sim
    }

    pub fn active_binary_state(&self) -> BinaryState {
        let sep = if self.inspiral_mode == 1 {
            self.orbit.current_sep
        } else {
            self.separation as f64
        };
        let mut s = compute_binary_state(self.mass_ratio as f64, sep, self.orbit.phase);
        s.ringdown_factor = self.orbit.ringdown_factor;
        s
    }

    fn dispatch_tidal(
        &mut self,
        assets: &SharedGpuAssets,
        encoder: &mut wgpu::CommandEncoder,
        bin: &BinaryState,
        field_half_size: f32,
        dt_sec: f32,
        force_reset: bool,
    ) {
        let ubo = TidalUniforms {
            sep_q_omega_dens: [
                bin.d as f32,
                bin.q as f32,
                bin.omega as f32,
                self.disk_density,
            ],
            bridge_outer_half_t: [
                self.bridge_intensity,
                self.disk_outer_radius,
                field_half_size,
                self.sim_time,
            ],
            dt_reset_roche: [
                dt_sec,
                if force_reset { 1.0 } else { 0.0 },
                bin.roche_l1 as f32,
                bin.roche_l2 as f32,
            ],
            cav_ringdown_pad: [bin.r_cavity as f32, bin.ringdown_factor as f32, 0.0, 0.0],
        };
        assets
            .queue
            .write_buffer(&self.tidal_ubo, 0, bytemuck::bytes_of(&ubo));

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("tidal-compute-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.tidal_pipeline);
            pass.set_bind_group(0, &self.tidal_bgs[self.tidal_read_idx], &[]);
            let wg = TIDAL_SIZE.div_ceil(8);
            pass.dispatch_workgroups(wg, wg, 1);
        }
        std::mem::swap(&mut self.tidal_read_idx, &mut self.tidal_write_idx);
        self.tidal_reset = false;
        self.last_tidal_sig = Some([
            bin.q as f32,
            self.disk_density,
            self.bridge_intensity,
            self.disk_outer_radius,
            bin.d as f32,
        ]);
    }

    fn build_uniforms(
        &self,
        bin: &BinaryState,
        field_half_size: f32,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
    ) -> BinaryUniforms {
        let b = self.camera.basis;
        let pos = self.camera.pos;
        let r_outer = self.disk_outer_radius.max(bin.r_cavity as f32 + 4.0);
        let cam_r = (pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]).sqrt();
        let escape_r = (r_outer * 1.85).max(cam_r * 1.65).max(62.0);
        let tan_half_fov = (self.camera.fov.clamp(0.1, 2.8) * 0.5).tan();
        let max_disk_slab_y =
            (0.054 + 0.033 * r_outer * 1.30) * self.disk_thickness.max(0.15) * 2.75;

        let flow_cycle = 15.0_f32;
        let t_norm0 = self.sim_time / flow_cycle;
        let phase0 = t_norm0 - t_norm0.floor();
        let t_norm1 = t_norm0 + 0.5;
        let phase1 = t_norm1 - t_norm1.floor();

        BinaryUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_phase: [jitter[0], jitter[1], self.camera.fov, bin.phase_rad as f32],
            cam_pos_rel_mode: [pos[0], pos[1], pos[2], self.rel_mode],
            cam_right_lensing: [b[0], b[1], b[2], self.lensing],
            cam_up_disk_temp: [b[3], b[4], b[5], self.disk_temp],
            cam_forward_disk_dens: [b[6], b[7], b[8], self.disk_density],
            disk_params: [
                self.disk_thickness,
                self.disk_outer_radius,
                self.turbulence,
                self.bridge_intensity,
            ],
            gw_sky_params: [
                self.gw_amplitude,
                self.sky_intensity,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            modes_pad: [frame_index as i32, self.sky_mode, self.quality, 0],
            binary_mass_sep: [bin.m1 as f32, bin.m2 as f32, bin.d as f32, bin.eta as f32],
            binary_c1_omega: [
                bin.c1[0] as f32,
                bin.c1[1] as f32,
                bin.c1[2] as f32,
                bin.omega as f32,
            ],
            binary_c2_gw_omega: [
                bin.c2[0] as f32,
                bin.c2[1] as f32,
                bin.c2[2] as f32,
                bin.gw_wave_omega as f32,
            ],
            binary_v1_rh1: [
                bin.v1[0] as f32,
                bin.v1[1] as f32,
                bin.v1[2] as f32,
                bin.r_h1 as f32,
            ],
            binary_v2_rh2: [
                bin.v2[0] as f32,
                bin.v2[1] as f32,
                bin.v2[2] as f32,
                bin.r_h2 as f32,
            ],
            field_ray_consts: [field_half_size, escape_r, tan_half_fov, bin.r_cavity as f32],
            flow_consts: [
                0.5 - 0.5 * (TAU * phase0).cos(),
                (phase0 - 0.5) * flow_cycle,
                (phase1 - 0.5) * flow_cycle,
                self.sim_time * 0.038,
            ],
            rot_trig_sky_trig: [
                (bin.phase_rad as f32).cos(),
                (bin.phase_rad as f32).sin(),
                self.sky_rot[0].cos(),
                self.sky_rot[0].sin(),
            ],
            sky_y_ringdown: [
                self.sky_rot[1].cos(),
                self.sky_rot[1].sin(),
                bin.ringdown_factor as f32,
                max_disk_slab_y,
            ],
        }
    }
}

impl Simulation for BinaryBhSim {
    fn id(&self) -> SimId {
        SimId::BinaryBh
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
            self.mass_ratio = p.mass_ratio;
            self.separation = p.separation;
            self.orbital_inclination = p.orbital_inclination;
            self.gw_amplitude = p.gw_amplitude;
            self.inspiral_mode = p.inspiral_mode;
            self.time_warp = p.time_warp;
            self.lensing = p.lensing;
            self.rel_mode = p.rel_mode;
            self.initial_phase_deg = p.initial_phase_deg;
            self.disk_temp = p.disk_temp;
            self.disk_density = p.disk_density;
            self.bridge_intensity = p.bridge_intensity;
            self.disk_thickness = p.disk_thickness;
            self.disk_outer_radius = p.disk_outer_radius;
            self.turbulence = p.turbulence;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.auto_orbit = p.auto_orbit;
            self.orbit = OrbitState {
                current_sep: p.separation as f64,
                phase: (p.initial_phase_deg as f64) * std::f64::consts::PI / 180.0,
                in_ringdown: false,
                ringdown_timer: 0.0,
                ringdown_factor: 0.0,
            };
            self.tidal_reset = true;
            self.camera.fly_to(p, 1.2);
        }
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        const SECTIONS: &[ControlSection] = &[
            ControlSection {
                id: "spacetime",
                title: "BINARY SPACETIME & GW",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "massRatio",
                        label: "Mass Ratio (q = m₂/m₁)",
                        kind: ControlKind::Range {
                            min: 0.05,
                            max: 1.0,
                            step: 0.01,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "separation",
                        label: "Orbital Separation (d/M)",
                        kind: ControlKind::Range {
                            min: 2.2,
                            max: 16.0,
                            step: 0.1,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "orbitalInclination",
                        label: "Orbital Inclination",
                        kind: ControlKind::Range {
                            min: 5.0,
                            max: 90.0,
                            step: 0.5,
                            hints: Some(["Face-On 5°", "Edge-On 90°"]),
                        },
                    },
                    ControlItem {
                        key: "gwAmplitude",
                        label: "GW Strain Exaggeration",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "inspiralMode",
                        label: "2.5PN Inspiral Evolution",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Orbital Lock"), (1, "2.5PN Inspiral")],
                        },
                    },
                    ControlItem {
                        key: "timeWarp",
                        label: "Time-Warp Speed",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
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
                        label: "Relativistic Beaming",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.0,
                            step: 0.01,
                            hints: Some(["Cinematic", "Physical Exact"]),
                        },
                    },
                ],
            },
            ControlSection {
                id: "accretion",
                title: "CIRCUMBINARY DISK & BRIDGES",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "diskTemp",
                        label: "Inner Temperature",
                        kind: ControlKind::Range {
                            min: 2500.0,
                            max: 18000.0,
                            step: 100.0,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "diskDensity",
                        label: "Circumbinary Density",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "bridgeIntensity",
                        label: "Tidal Bridges & Mini-Disks",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "diskThickness",
                        label: "Disk Scale Height",
                        kind: ControlKind::Range {
                            min: 0.25,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "diskOuterRadius",
                        label: "Outer Radius",
                        kind: ControlKind::Range {
                            min: 14.0,
                            max: 46.0,
                            step: 0.5,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "turbulence",
                        label: "Filament Turbulence",
                        kind: ControlKind::Range {
                            min: 0.0,
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
            "massRatio" => self.mass_ratio,
            "separation" => self.separation,
            "orbitalInclination" => self.orbital_inclination,
            "gwAmplitude" => self.gw_amplitude,
            "timeWarp" => self.time_warp,
            "lensingStrength" => self.lensing,
            "relativisticMode" => self.rel_mode,
            "diskTemp" => self.disk_temp,
            "diskDensity" => self.disk_density,
            "bridgeIntensity" => self.bridge_intensity,
            "diskThickness" => self.disk_thickness,
            "diskOuterRadius" => self.disk_outer_radius,
            "turbulence" => self.turbulence,
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
            "massRatio" => {
                self.mass_ratio = val;
                self.tidal_reset = true;
            }
            "separation" => {
                self.separation = val;
                self.orbit.current_sep = val as f64;
                self.orbit.in_ringdown = false;
                self.orbit.ringdown_timer = 0.0;
                self.orbit.ringdown_factor = 0.0;
                self.tidal_reset = true;
            }
            "orbitalInclination" => {
                self.orbital_inclination = val;
                self.camera.set_inclination_deg(val);
            }
            "gwAmplitude" => self.gw_amplitude = val,
            "timeWarp" => self.time_warp = val,
            "lensingStrength" => self.lensing = val,
            "relativisticMode" => self.rel_mode = val,
            "diskTemp" => self.disk_temp = val,
            "diskDensity" => {
                self.disk_density = val;
                self.tidal_reset = true;
            }
            "bridgeIntensity" => {
                self.bridge_intensity = val;
                self.tidal_reset = true;
            }
            "diskThickness" => self.disk_thickness = val,
            "diskOuterRadius" => {
                self.disk_outer_radius = val;
                self.tidal_reset = true;
            }
            "turbulence" => self.turbulence = val,
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
            "inspiralMode" => self.inspiral_mode,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "inspiralMode" => {
                self.inspiral_mode = val;
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
            "massRatio" => format!("{:.2}", self.mass_ratio),
            "separation" => format!("{:.1} M", self.separation),
            "orbitalInclination" => format!("{:.1}°", self.orbital_inclination),
            "gwAmplitude" => format!("{:.2}×", self.gw_amplitude),
            "timeWarp" => format!("{:.2}×", self.time_warp),
            "lensingStrength" => format!("{:.2}", self.lensing),
            "relativisticMode" => format!("{}% Physical", (self.rel_mode * 100.0).round() as i32),
            "diskTemp" => format!("{} K", format_thousands(self.disk_temp.round() as i32)),
            "diskDensity" => format!("{:.2}", self.disk_density),
            "bridgeIntensity" => format!("{:.2}", self.bridge_intensity),
            "diskThickness" => format!("{:.2}×", self.disk_thickness),
            "diskOuterRadius" => format!("{:.1} M", self.disk_outer_radius),
            "turbulence" => format!("{:.2}", self.turbulence),
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
        let p = &PRESETS[idx];
        self.camera.fly_to(p, 1.0);
        self.orbital_inclination = p.orbital_inclination;
    }

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let bin = self.active_binary_state();
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
        let deg = (bin.gw_phase_rad * 180.0 / std::f64::consts::PI).rem_euclid(360.0);

        HudMetadata {
            brand_title: "BINARY BH",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: false,
            drawer_title: "BINARY PHYSICS & OPTICS",
            drawer_subtitle: format!(
                "m1 {:.2} · m2 {:.2} · rcav {:.1} M",
                bin.m1, bin.m2, bin.r_cavity
            ),
            hint_text: "Drag to orbit · Scroll to zoom · Right-drag to tilt · Space for Cinema Still · H hides HUD",
            telemetry: [
                TelemetryCell {
                    label: "SEPARATION",
                    unit: "d/M",
                    value: format!("{:.2} M", bin.d),
                },
                TelemetryCell {
                    label: "GW FREQ",
                    unit: "f_GW",
                    value: format!("{:.1} Hz", bin.f_gw_hz),
                },
                TelemetryCell {
                    label: "CHIRP PHASE",
                    unit: "Φ_GW",
                    value: format!("{:.0}°", deg),
                },
                TelemetryCell {
                    label: "ORBITAL",
                    unit: "v/c",
                    value: format!("{:.3} c", bin.v_orbital_c),
                },
                TelemetryCell {
                    label: "MASS RATIO",
                    unit: "q",
                    value: format!("{:.2}", bin.q),
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
        if !self.paused {
            self.sim_time += cdt;
            step_binary_orbit(
                &mut self.orbit,
                self.mass_ratio as f64,
                self.separation as f64,
                self.inspiral_mode,
                self.time_warp as f64,
                cdt as f64,
            );
        }
        self.camera.update(cdt, self.paused, self.auto_orbit, input);
        let new_incl = (self.camera.inclination_deg() * 10.0).round() / 10.0;
        if (new_incl - self.orbital_inclination).abs() >= 0.09 {
            self.orbital_inclination = new_incl;
        }
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: false,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bin_bgs = [
            assets.build_standard_bind_group("binary-bg-0", &self.ubo, Some(&self.tidal_views[0])),
            assets.build_standard_bind_group("binary-bg-1", &self.ubo, Some(&self.tidal_views[1])),
        ];
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
        dt: f32,
        _hard_reset: bool,
    ) {
        let bin = self.active_binary_state();
        let field_half_size = (self.disk_outer_radius * 1.15).max(bin.d as f32 * 3.8);

        if self.disk_density <= 0.001 && self.bridge_intensity <= 0.001 {
            self.tidal_reset = true;
            self.last_tidal_sig = None;
        } else {
            let mut need_reset = self.tidal_reset || self.last_tidal_sig.is_none();
            if let Some(prev) = self.last_tidal_sig
                && ((bin.q as f32 - prev[0]).abs() > 1e-4
                    || (self.disk_density - prev[1]).abs() > 1e-3
                    || (self.bridge_intensity - prev[2]).abs() > 1e-3
                    || (self.disk_outer_radius - prev[3]).abs() > 0.1
                    || (bin.d as f32 - prev[4]).abs() > 0.35)
            {
                need_reset = true;
            }
            let is_progressive = self.paused && !self.camera.moved;
            if need_reset || (!is_progressive && dt > 0.0) {
                self.dispatch_tidal(
                    assets,
                    encoder,
                    &bin,
                    field_half_size,
                    if is_progressive { 0.0 } else { dt },
                    need_reset,
                );
            }
        }

        let ubo_data = self.build_uniforms(
            &bin,
            field_half_size,
            render_width,
            render_height,
            frame_index,
            jitter,
        );
        assets
            .queue
            .write_buffer(&self.ubo, 0, bytemuck::bytes_of(&ubo_data));
        run_fs_pass(
            encoder,
            "binary-raytrace",
            scene_view,
            &self.pipeline,
            &self.bin_bgs[self.tidal_read_idx],
        );
    }
}
