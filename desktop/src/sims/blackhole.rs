use std::f32::consts::{PI, TAU};

use bytemuck::{Pod, Zeroable};

use crate::renderer::SharedGpuAssets;
use crate::renderer::post::{PostFrameParams, PostTuning, make_fs_pipe, run_fs_pass};
use crate::shaders;
use crate::sims::{
    ControlItem, ControlKind, ControlSection, HudMetadata, PresetMeta, SimId, SimInput, Simulation,
    StepOutcome, TelemetryCell, ease_out_cubic, step_critically_damped, wrap_angle_delta,
};

const DEG2RAD: f32 = PI / 180.0;

const MIN_RADIUS: f32 = 2.8;
const MAX_RADIUS: f32 = 70.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 22.0 * DEG2RAD;
const MAX_FOV: f32 = 85.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_ORBIT_SPEED: f32 = 0.045;
const AUTO_BREATH_AMP: f32 = 0.010;
const AUTO_BREATH_FREQ: f32 = 0.22;
const INTERACTION_COOLDOWN: f32 = 2.4;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct BlackholeUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_spin: [f32; 4],
    cam_pos_rel_mode: [f32; 4],
    cam_right_lensing: [f32; 4],
    cam_up_disk_temp: [f32; 4],
    cam_forward_disk_dens: [f32; 4],
    disk_params: [f32; 4],
    jet_sky_params: [f32; 4],
    modes_pad: [i32; 4],
    zamo_e0: [f32; 4],
    zamo_e1: [f32; 4],
    zamo_e2: [f32; 4],
    zamo_e3: [f32; 4],
    cam_ks_l_2h: [f32; 4],
    kerr_consts: [f32; 4],
    ray_consts: [f32; 4],
    flow_consts: [f32; 4],
    opt_consts: [f32; 4],
    sky_trig: [f32; 4],
}

#[derive(Clone, Copy)]
struct BlackholePreset {
    meta: PresetMeta,
    spin: f32,
    rel_mode: f32,
    lensing: f32,
    disk_temp: f32,
    disk_density: f32,
    disk_thickness: f32,
    disk_outer_radius: f32,
    turbulence: f32,
    orbit_speed: f32,
    jet_intensity: f32,
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

const PRESETS: [BlackholePreset; 6] = [
    BlackholePreset {
        meta: PresetMeta {
            id: "gargantua",
            full_name: "Gargantua (Interstellar)",
            short_label: "Gargantua",
            hotkey: "1",
        },
        spin: 0.998,
        rel_mode: 0.18,
        lensing: 1.0,
        disk_temp: 6800.0,
        disk_density: 1.15,
        disk_thickness: 0.85,
        disk_outer_radius: 19.5,
        turbulence: 1.1,
        orbit_speed: 0.9,
        jet_intensity: 0.0,
        exposure: 1.05,
        bloom: 0.52,
        anamorphic: 0.24,
        sky_intensity: 0.85,
        sky_mode: 0,
        sky_rot: [0.45, 0.24],
        radius: 30.5,
        elevation_deg: 5.2,
        azimuth_deg: 0.0,
        roll_deg: -5.5,
        fov_deg: 44.0,
    },
    BlackholePreset {
        meta: PresetMeta {
            id: "relativistic",
            full_name: "Relativistic Exact (a=0.998)",
            short_label: "Relativistic",
            hotkey: "2",
        },
        spin: 0.998,
        rel_mode: 1.0,
        lensing: 1.0,
        disk_temp: 9200.0,
        disk_density: 1.05,
        disk_thickness: 0.95,
        disk_outer_radius: 23.0,
        turbulence: 1.1,
        orbit_speed: 0.9,
        jet_intensity: 0.0,
        exposure: 0.90,
        bloom: 0.50,
        anamorphic: 0.18,
        sky_intensity: 0.85,
        sky_mode: 0,
        sky_rot: [0.45, 0.24],
        radius: 23.0,
        elevation_deg: 9.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 46.0,
    },
    BlackholePreset {
        meta: PresetMeta {
            id: "schwarzschild",
            full_name: "Schwarzschild (a=0)",
            short_label: "Schwarzschild",
            hotkey: "3",
        },
        spin: 0.0,
        rel_mode: 0.65,
        lensing: 1.0,
        disk_temp: 6000.0,
        disk_density: 0.95,
        disk_thickness: 0.95,
        disk_outer_radius: 25.0,
        turbulence: 1.0,
        orbit_speed: 0.85,
        jet_intensity: 0.0,
        exposure: 0.80,
        bloom: 0.45,
        anamorphic: 0.16,
        sky_intensity: 0.90,
        sky_mode: 0,
        sky_rot: [1.05, 0.20],
        radius: 28.0,
        elevation_deg: 12.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 46.0,
    },
    BlackholePreset {
        meta: PresetMeta {
            id: "millers",
            full_name: "Miller's Horizon (Close)",
            short_label: "Miller's",
            hotkey: "4",
        },
        spin: 0.998,
        rel_mode: 0.25,
        lensing: 1.0,
        disk_temp: 6500.0,
        disk_density: 1.25,
        disk_thickness: 0.9,
        disk_outer_radius: 23.0,
        turbulence: 1.15,
        orbit_speed: 0.95,
        jet_intensity: 0.0,
        exposure: 1.0,
        bloom: 0.60,
        anamorphic: 0.30,
        sky_intensity: 0.85,
        sky_mode: 0,
        sky_rot: [0.38, 0.20],
        radius: 9.5,
        elevation_deg: 4.5,
        azimuth_deg: 0.0,
        roll_deg: -11.0,
        fov_deg: 58.0,
    },
    BlackholePreset {
        meta: PresetMeta {
            id: "m87",
            full_name: "EHT M87* (Polar Ring)",
            short_label: "EHT M87*",
            hotkey: "5",
        },
        spin: 0.94,
        rel_mode: 0.85,
        lensing: 1.0,
        disk_temp: 4200.0,
        disk_density: 1.2,
        disk_thickness: 1.35,
        disk_outer_radius: 16.0,
        turbulence: 1.15,
        orbit_speed: 0.75,
        jet_intensity: 0.16,
        exposure: 1.1,
        bloom: 0.62,
        anamorphic: 0.16,
        sky_intensity: 0.75,
        sky_mode: 0,
        sky_rot: [2.05, -0.32],
        radius: 24.5,
        elevation_deg: 62.0,
        azimuth_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 45.0,
    },
    BlackholePreset {
        meta: PresetMeta {
            id: "quasar",
            full_name: "Active Quasar Core",
            short_label: "Quasar",
            hotkey: "6",
        },
        spin: 0.99,
        rel_mode: 0.75,
        lensing: 1.0,
        disk_temp: 12500.0,
        disk_density: 1.45,
        disk_thickness: 1.3,
        disk_outer_radius: 28.0,
        turbulence: 1.45,
        orbit_speed: 1.35,
        jet_intensity: 0.75,
        exposure: 0.88,
        bloom: 0.60,
        anamorphic: 0.30,
        sky_intensity: 0.80,
        sky_mode: 0,
        sky_rot: [-0.82, 0.35],
        radius: 34.0,
        elevation_deg: 18.0,
        azimuth_deg: 0.0,
        roll_deg: -8.0,
        fov_deg: 50.0,
    },
];

pub struct KerrTelemetry {
    pub r_over_m: f64,
    pub r_over_rs: f64,
    pub isco_r: f64,
    pub horizon_r: f64,
    pub photon_prograde_r: f64,
    pub photon_retrograde_r: f64,
    pub time_dilation: f64,
    pub orbital_velocity_c: f64,
    pub shadow_angular_deg: f64,
}

pub fn compute_kerr_telemetry(
    spin: f64,
    radius_euclidean: f64,
    elevation_rad: f64,
) -> KerrTelemetry {
    let a = if spin.is_finite() {
        spin.clamp(0.0, 0.998)
    } else {
        0.0
    };
    let a2 = a * a;
    let horizon_r = 1.0 + (1.0 - a2).max(0.0).sqrt();

    let one_minus_a2 = (1.0 - a2).max(0.0);
    let z1 = 1.0 + one_minus_a2.cbrt() * ((1.0 + a).cbrt() + (1.0 - a).max(0.0).cbrt());
    let z2 = (3.0 * a2 + z1 * z1).sqrt();
    let isco_r = 3.0 + z2 - ((3.0 - z1) * (3.0 + z1 + 2.0 * z2)).max(0.0).sqrt();

    let photon_prograde_r = 2.0 * (1.0 + ((2.0 / 3.0) * (-a).clamp(-1.0, 1.0).acos()).cos());
    let photon_retrograde_r = 2.0 * (1.0 + ((2.0 / 3.0) * a.clamp(-1.0, 1.0).acos()).cos());

    let big_r = radius_euclidean.max(horizon_r + 0.02);
    let y = big_r * elevation_rad.sin();
    let u = big_r * big_r - a2;
    let r2 = 0.5 * (u + (u * u + 4.0 * a2 * y * y).max(0.0).sqrt());
    let r = r2.sqrt().max(horizon_r + 0.02);

    let cos_theta = (y / r).clamp(-1.0, 1.0);
    let sin2_theta = (1.0 - cos_theta * cos_theta).max(0.0);

    let sigma = r * r + a2 * cos_theta * cos_theta;
    let delta = (r * r - 2.0 * r + a2).max(1e-5);
    let big_a = (r * r + a2) * (r * r + a2) - a2 * delta * sin2_theta;

    let alpha_zamo = ((sigma * delta) / big_a.max(1e-6)).clamp(1e-6, 1.0).sqrt();
    let time_dilation = 1.0 / alpha_zamo;

    let r_orb = r.max(photon_prograde_r + 1e-3);
    let r_orb2 = r_orb * r_orb;
    let delta_eq = (r_orb2 - 2.0 * r_orb + a2).max(1e-6);
    let a_eq = (r_orb2 + a2) * (r_orb2 + a2) - a2 * delta_eq;
    let omega_kepler = 1.0 / (r_orb.powf(1.5) + a);
    let omega_frame = (2.0 * a * r_orb) / a_eq.max(1e-6);
    let orbital_velocity_c =
        ((a_eq / (r_orb2 * delta_eq.sqrt())) * (omega_kepler - omega_frame)).clamp(0.0, 0.9999);

    let b_crit_mean = 3.0 * 3.0_f64.sqrt() * (1.0 - 0.065 * a2);
    let sin_half_shadow = ((b_crit_mean * alpha_zamo) / r).clamp(0.0, 1.0);
    let mut half_angle_rad = sin_half_shadow.asin();
    if r < 3.0 && a < 0.5 {
        half_angle_rad = std::f64::consts::PI - half_angle_rad;
    }
    let shadow_angular_deg = 2.0 * half_angle_rad * (180.0 / std::f64::consts::PI);

    KerrTelemetry {
        r_over_m: r,
        r_over_rs: r * 0.5,
        isco_r,
        horizon_r,
        photon_prograde_r,
        photon_retrograde_r,
        time_dilation,
        orbital_velocity_c,
        shadow_angular_deg,
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
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    pos: [f32; 3],
    basis: [f32; 9],
    moved: bool,
    prev_sig: Option<[f32; 10]>,
}

impl OrbitCamera {
    fn from_preset(p: &BlackholePreset) -> Self {
        let r0 = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let el0 = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az0 = p.azimuth_deg * DEG2RAD;
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);
        let log_r = r0.ln();

        let mut cam = Self {
            log_radius: log_r,
            elevation: el0,
            azimuth: az0,
            roll: roll0,
            fov: fov0,
            target_log_radius: log_r,
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

    fn radius(&self) -> f32 {
        self.log_radius.exp()
    }

    fn fly_to(&mut self, p: &BlackholePreset, duration: f32) {
        let dest_r = p.radius.clamp(MIN_RADIUS, MAX_RADIUS);
        let dest_log_r = dest_r.ln();
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az_raw = p.azimuth_deg * DEG2RAD;
        let dest_az = self.azimuth + wrap_angle_delta(dest_az_raw - self.azimuth);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        if duration <= 0.0 {
            self.flight = None;
            self.log_radius = dest_log_r;
            self.target_log_radius = dest_log_r;
            self.elevation = dest_el;
            self.target_elevation = dest_el;
            self.azimuth = dest_az_raw;
            self.target_azimuth = dest_az_raw;
            self.roll = dest_roll;
            self.target_roll = dest_roll;
            self.fov = dest_fov;
            self.target_fov = dest_fov;
            self.vel_log_radius = 0.0;
            self.vel_elevation = 0.0;
            self.vel_azimuth = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.auto_base_elevation = dest_el;
            self.auto_orbit_time = 0.0;
            self.interaction_cooldown = 0.0;
            self.recompute_basis();
            self.moved = true;
            return;
        }

        self.flight = Some(CameraFlight {
            elapsed: 0.0,
            duration,
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

pub struct BlackholeSim {
    active_preset: Option<usize>,

    spin: f32,
    rel_mode: f32,
    lensing: f32,
    disk_temp: f32,
    disk_density: f32,
    disk_thickness: f32,
    disk_outer_radius: f32,
    turbulence: f32,
    orbit_speed: f32,
    jet_intensity: f32,

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

    camera: OrbitCamera,

    pipeline: wgpu::RenderPipeline,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl BlackholeSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];
        let shader = assets
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("blackhole-wgsl"),
                source: wgpu::ShaderSource::Wgsl(shaders::BLACKHOLE.into()),
            });
        let pipeline = make_fs_pipe(
            &assets.device,
            "blackhole-pipe",
            &assets.standard_sim_bgl,
            &shader,
            wgpu::TextureFormat::Rgba16Float,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("blackhole-ubo"),
            size: std::mem::size_of::<BlackholeUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("blackhole-bg", &ubo, None);

        Self {
            active_preset: Some(0),
            spin: p.spin,
            rel_mode: p.rel_mode,
            lensing: p.lensing,
            disk_temp: p.disk_temp,
            disk_density: p.disk_density,
            disk_thickness: p.disk_thickness,
            disk_outer_radius: p.disk_outer_radius,
            turbulence: p.turbulence,
            orbit_speed: p.orbit_speed,
            jet_intensity: p.jet_intensity,
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
    ) -> BlackholeUniforms {
        let basis = self.camera.basis;
        let pos = self.camera.pos;
        let a = self.spin.clamp(0.0, 0.998);
        let a2 = a * a;
        let lensing = self.lensing.clamp(0.0, 1.0);
        let r_plus = 1.0 + (1.0 - a2).max(1e-6).sqrt();

        let c1 = (1.0 - a2).max(1e-7).cbrt();
        let c2 = (1.0 + a).cbrt() + (1.0 - a).max(1e-7).cbrt();
        let z1 = 1.0 + c1 * c2;
        let z2 = (3.0 * a2 + z1 * z1).sqrt();
        let r_isco = 3.0 + z2 - ((3.0 - z1) * (3.0 + z1 + 2.0 * z2)).max(0.0).sqrt();
        let r_outer = self.disk_outer_radius.max(r_isco + 2.5);
        let tan_half_fov = (self.camera.fov.clamp(0.1, 2.8) * 0.5).tan();

        let (px, py, pz) = (pos[0], pos[1], pos[2]);
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
        let f4_inv_len = 1.0 / ks_dot(f4, f4).max(1e-8).sqrt();
        let e3 = [
            f4[0] * f4_inv_len,
            f4[1] * f4_inv_len,
            f4[2] * f4_inv_len,
            f4[3] * f4_inv_len,
        ];

        let mut r4 = [0.0, basis[0], basis[1], basis[2]];
        let dr0 = ks_dot(r4, e0);
        let dr3 = ks_dot(r4, e3);
        for k in 0..4 {
            r4[k] += dr0 * e0[k] - dr3 * e3[k];
        }
        let r4_inv_len = 1.0 / ks_dot(r4, r4).max(1e-8).sqrt();
        let e1 = [
            r4[0] * r4_inv_len,
            r4[1] * r4_inv_len,
            r4[2] * r4_inv_len,
            r4[3] * r4_inv_len,
        ];

        let mut u4 = [0.0, basis[3], basis[4], basis[5]];
        let du0 = ks_dot(u4, e0);
        let du3 = ks_dot(u4, e3);
        let du1 = ks_dot(u4, e1);
        for k in 0..4 {
            u4[k] += du0 * e0[k] - du3 * e3[k] - du1 * e1[k];
        }
        let u4_inv_len = 1.0 / ks_dot(u4, u4).max(1e-8).sqrt();
        let e2 = [
            u4[0] * u4_inv_len,
            u4[1] * u4_inv_len,
            u4[2] * u4_inv_len,
            u4[3] * u4_inv_len,
        ];

        let cam_r = (px * px + py * py + pz * pz).sqrt();
        let escape_r = (r_outer * 1.55).max(cam_r * 1.45).max(48.0);
        let capture_r = r_plus * 1.022;
        let outer_h = (0.048 + 0.036 * r_outer * 1.30) * self.disk_thickness.max(0.15);
        let max_disk_slab_y = outer_h * 2.6;
        let r_peak = (r_isco * 1.55).max(r_plus * 1.45);

        let flow_cycle = 15.0_f32;
        let t_norm0 = self.sim_time / flow_cycle;
        let phase0 = t_norm0 - t_norm0.floor();
        let t_norm1 = t_norm0 + 0.5;
        let phase1 = t_norm1 - t_norm1.floor();

        let r_peak_base = 2.2 / r_peak.max(1.5);

        BlackholeUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_spin: [jitter[0], jitter[1], self.camera.fov, self.spin],
            cam_pos_rel_mode: [px, py, pz, self.rel_mode],
            cam_right_lensing: [basis[0], basis[1], basis[2], self.lensing],
            cam_up_disk_temp: [basis[3], basis[4], basis[5], self.disk_temp],
            cam_forward_disk_dens: [basis[6], basis[7], basis[8], self.disk_density],
            disk_params: [
                self.disk_thickness,
                self.disk_outer_radius,
                self.turbulence,
                self.orbit_speed,
            ],
            jet_sky_params: [
                self.jet_intensity,
                self.sky_intensity,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            modes_pad: [frame_index as i32, self.sky_mode, self.quality, 0],
            zamo_e0: e0,
            zamo_e1: e1,
            zamo_e2: e2,
            zamo_e3: e3,
            cam_ks_l_2h: [lx, ly, lz, 2.0 * c_h],
            kerr_consts: [r_plus, r_isco, r_outer, tan_half_fov],
            ray_consts: [escape_r, capture_r, max_disk_slab_y, r_peak],
            flow_consts: [
                0.5 - 0.5 * (TAU * phase0).cos(),
                (phase0 - 0.5) * flow_cycle,
                (phase1 - 0.5) * flow_cycle,
                self.sim_time * self.orbit_speed * 0.045,
            ],
            opt_consts: [
                r_peak_base.powf(0.28),
                r_peak_base.powf(0.18),
                self.sky_rot[0].cos(),
                self.sky_rot[0].sin(),
            ],
            sky_trig: [self.sky_rot[1].cos(), self.sky_rot[1].sin(), 0.0, 0.0],
        }
    }
}

impl Simulation for BlackholeSim {
    fn id(&self) -> SimId {
        SimId::Blackhole
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
        PRESETS.iter().map(|p| p.meta).collect()
    }

    fn active_preset_index(&self) -> Option<usize> {
        self.active_preset
    }

    fn apply_preset(&mut self, index: usize) {
        if let Some(p) = PRESETS.get(index) {
            self.active_preset = Some(index);
            self.spin = p.spin;
            self.rel_mode = p.rel_mode;
            self.lensing = p.lensing;
            self.disk_temp = p.disk_temp;
            self.disk_density = p.disk_density;
            self.disk_thickness = p.disk_thickness;
            self.disk_outer_radius = p.disk_outer_radius;
            self.turbulence = p.turbulence;
            self.orbit_speed = p.orbit_speed;
            self.jet_intensity = p.jet_intensity;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.camera.fly_to(p, 1.15);
        }
    }

    fn control_sections(&self) -> Vec<ControlSection> {
        vec![
            ControlSection {
                id: "spacetime",
                title: "Spacetime Physics",
                default_open: true,
                items: vec![
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
                        key: "relativisticMode",
                        label: "Relativistic Mode",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.0,
                            step: 0.01,
                            hints: Some(["Cinematic", "Physical Exact"]),
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
                ],
            },
            ControlSection {
                id: "accretion",
                title: "Accretion Disk & Corona",
                default_open: true,
                items: vec![
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
                        label: "Plasma Density",
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
                            min: 10.0,
                            max: 40.0,
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
                    ControlItem {
                        key: "orbitSpeed",
                        label: "Keplerian Orbit Speed",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "jetIntensity",
                        label: "Relativistic Polar Jets",
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
            "spin" => self.spin,
            "relativisticMode" => self.rel_mode,
            "lensingStrength" => self.lensing,
            "diskTemp" => self.disk_temp,
            "diskDensity" => self.disk_density,
            "diskThickness" => self.disk_thickness,
            "diskOuterRadius" => self.disk_outer_radius,
            "turbulence" => self.turbulence,
            "orbitSpeed" => self.orbit_speed,
            "jetIntensity" => self.jet_intensity,
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
            "spin" => self.spin = val,
            "relativisticMode" => self.rel_mode = val,
            "lensingStrength" => self.lensing = val,
            "diskTemp" => self.disk_temp = val,
            "diskDensity" => self.disk_density = val,
            "diskThickness" => self.disk_thickness = val,
            "diskOuterRadius" => self.disk_outer_radius = val,
            "turbulence" => self.turbulence = val,
            "orbitSpeed" => self.orbit_speed = val,
            "jetIntensity" => self.jet_intensity = val,
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
            "relativisticMode" => format!("{}% Physical", (self.rel_mode * 100.0).round() as i32),
            "lensingStrength" => format!("{:.2}", self.lensing),
            "diskTemp" => format!("{} K", format_thousands(self.disk_temp.round() as i32)),
            "diskDensity" => format!("{:.2}", self.disk_density),
            "diskThickness" => format!("{:.2}×", self.disk_thickness),
            "diskOuterRadius" => format!("{:.1} M", self.disk_outer_radius),
            "turbulence" => format!("{:.2}", self.turbulence),
            "orbitSpeed" => format!("{:.2}×", self.orbit_speed),
            "jetIntensity" => format!("{:.2}", self.jet_intensity),
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

    fn hud_metadata(
        &self,
        assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let kerr = compute_kerr_telemetry(
            self.spin as f64,
            self.camera.radius() as f64,
            self.camera.elevation as f64,
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
            brand_title: "GARGANTUA",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: false,
            drawer_title: "Physics & Optics",
            drawer_subtitle: format!(
                "r+ {:.2} M · θsh {:.1}°",
                kerr.horizon_r, kerr.shadow_angular_deg
            ),
            hint_text: "Drag to orbit · Scroll to zoom · Right-drag to tilt · Space for Cinema Still · H hides HUD",
            telemetry: [
                TelemetryCell {
                    label: "DISTANCE",
                    unit: "r/M (r/rs)",
                    value: format!("{:.2} M ({:.2})", kerr.r_over_m, kerr.r_over_rs),
                },
                TelemetryCell {
                    label: "SPIN",
                    unit: "a/M",
                    value: format!("{:.3}", self.spin),
                },
                TelemetryCell {
                    label: "ISCO",
                    unit: "r_ISCO",
                    value: format!("{:.2} M", kerr.isco_r),
                },
                TelemetryCell {
                    label: "DILATION",
                    unit: "dt/dτ",
                    value: format!("{:.3}×", kerr.time_dilation),
                },
                TelemetryCell {
                    label: "ORBITAL",
                    unit: "v/c",
                    value: format!("{:.3} c", kerr.orbital_velocity_c),
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
        if !self.paused {
            self.sim_time += dt.clamp(0.0, 0.05);
        }
        self.camera.update(dt, self.paused, self.auto_orbit, input);
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: false,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("blackhole-bg", &self.ubo, None);
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
            "blackhole-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
        );
    }
}

pub fn format_thousands(n: i32) -> String {
    let neg = n < 0;
    let s = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (idx, ch) in s.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if neg {
        out.push('-');
    }
    out.chars().rev().collect()
}
