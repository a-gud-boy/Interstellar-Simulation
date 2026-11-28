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

const C_MS: f64 = 299792458.0;
const G0_MS2: f64 = 9.80665;
const SECONDS_PER_YEAR: f64 = 31557600.0;
const ACCEL_1G_PER_YR: f64 = (G0_MS2 * SECONDS_PER_YEAR) / C_MS;
const T_CMB_K: f64 = 2.7255;
const MAX_RAPIDITY: f64 = 7.65;
const BRACHISTOCHRONE_HALF_TAU_BASE_YR: f64 = 3.2;
const FLIGHT_PERIOD_Z: f32 = 34.0 * 16.0;

const MIN_LOOK_PITCH: f32 = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH: f32 = 85.0 * DEG2RAD;
const MIN_ROLL: f32 = -90.0 * DEG2RAD;
const MAX_ROLL: f32 = 90.0 * DEG2RAD;
const MIN_FOV: f32 = 8.0 * DEG2RAD;
const MAX_FOV: f32 = 95.0 * DEG2RAD;

const SPRING_OMEGA: f32 = 13.5;
const AUTO_PAN_YAW_AMP: f32 = 18.0 * DEG2RAD;
const AUTO_PAN_PITCH_AMP: f32 = 5.0 * DEG2RAD;
const AUTO_PAN_YAW_FREQ: f32 = 0.24;
const AUTO_PAN_PITCH_FREQ: f32 = 0.37;
const INTERACTION_COOLDOWN: f32 = 2.4;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct StarflightUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_prog: [f32; 4],
    cam_right_beta: [f32; 4],
    cam_up_gamma: [f32; 4],
    cam_fwd_one_minus_beta: [f32; 4],
    flight_kinematics: [f32; 4],
    spectral_params: [f32; 4],
    foreground_params: [f32; 4],
    sky_params: [f32; 4],
    quality_params: [f32; 4],
    extra_params: [f32; 4],
}

#[derive(Clone, Copy)]
struct StarflightPreset {
    meta: PresetMeta,
    flight_mode: i32,
    rapidity: f32,
    proper_accel_g: f32,
    proper_time_yr: f32,
    flight_dir: i32,
    aberration_mode: i32,
    geometry_visibility: f32,
    dust_density: f32,
    cmb_visibility: f32,
    star_density: f32,
    uv_ir_gain: f32,
    doppler_strength: f32,
    dust_streak_scale: f32,
    beaming_gain: f32,
    cmb_temp_scale: f32,
    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    look_yaw_deg: f32,
    look_pitch_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
    auto_orbit: bool,
}

const PRESETS: [StarflightPreset; 6] = [
    StarflightPreset {
        meta: PresetMeta {
            id: "sub_rel",
            full_name: "0.50c Sub-Relativistic",
            short_label: "0.50c Cruise",
            hotkey: "1",
        },
        flight_mode: 0,
        rapidity: 0.549306,
        proper_accel_g: 1.0,
        proper_time_yr: 0.0,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 1.3,
        dust_density: 0.9,
        cmb_visibility: 0.55,
        star_density: 1.15,
        uv_ir_gain: 1.0,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.32, 0.14],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 18.0,
        look_pitch_deg: 2.0,
        roll_deg: 0.0,
        fov_deg: 54.0,
        auto_orbit: false,
    },
    StarflightPreset {
        meta: PresetMeta {
            id: "headlight_90",
            full_name: "0.90c Headlight Cone",
            short_label: "0.90c Cone",
            hotkey: "2",
        },
        flight_mode: 0,
        rapidity: 1.472219,
        proper_accel_g: 1.0,
        proper_time_yr: 0.0,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 1.25,
        dust_density: 1.15,
        cmb_visibility: 0.75,
        star_density: 1.25,
        uv_ir_gain: 1.20,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.22, 0.16],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 0.0,
        look_pitch_deg: 1.5,
        roll_deg: 0.0,
        fov_deg: 64.0,
        auto_orbit: false,
    },
    StarflightPreset {
        meta: PresetMeta {
            id: "uv_milkyway",
            full_name: "0.995c UV Milky Way",
            short_label: "0.995c UV Sky",
            hotkey: "3",
        },
        flight_mode: 0,
        rapidity: 2.993223,
        proper_accel_g: 1.0,
        proper_time_yr: 0.0,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 0.9,
        dust_density: 1.25,
        cmb_visibility: 1.05,
        star_density: 1.45,
        uv_ir_gain: 1.60,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.18, 0.14],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 58.0,
        auto_orbit: false,
    },
    StarflightPreset {
        meta: PresetMeta {
            id: "cmb_glow",
            full_name: "0.9999c CMB Glow",
            short_label: "0.9999c CMB",
            hotkey: "4",
        },
        flight_mode: 0,
        rapidity: 4.951744,
        proper_accel_g: 1.0,
        proper_time_yr: 0.0,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 0.35,
        dust_density: 0.70,
        cmb_visibility: 1.85,
        star_density: 1.35,
        uv_ir_gain: 1.65,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.18, 0.14],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 34.0,
        auto_orbit: false,
    },
    StarflightPreset {
        meta: PresetMeta {
            id: "aft_redshift",
            full_name: "Aft Redshift View",
            short_label: "Aft Window",
            hotkey: "5",
        },
        flight_mode: 0,
        rapidity: 1.589027,
        proper_accel_g: 1.0,
        proper_time_yr: 0.0,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 1.25,
        dust_density: 1.0,
        cmb_visibility: 0.45,
        star_density: 1.30,
        uv_ir_gain: 1.80,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.22, 0.16],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 180.0,
        look_pitch_deg: 2.0,
        roll_deg: 0.0,
        fov_deg: 56.0,
        auto_orbit: false,
    },
    StarflightPreset {
        meta: PresetMeta {
            id: "brachistochrone",
            full_name: "1g Brachistochrone Cruise",
            short_label: "1g Cruise",
            hotkey: "6",
        },
        flight_mode: 1,
        rapidity: 1.3935,
        proper_accel_g: 1.0,
        proper_time_yr: 1.35,
        flight_dir: 1,
        aberration_mode: 1,
        geometry_visibility: 1.25,
        dust_density: 1.20,
        cmb_visibility: 1.0,
        star_density: 1.30,
        uv_ir_gain: 1.25,
        doppler_strength: 1.0,
        dust_streak_scale: 1.0,
        beaming_gain: 1.0,
        cmb_temp_scale: 1.0,
        sky_intensity: 0.95,
        sky_mode: 0,
        sky_rot: [0.22, 0.16],
        exposure: 1.08,
        bloom: 0.62,
        anamorphic: 0.36,
        look_yaw_deg: 12.0,
        look_pitch_deg: 2.0,
        roll_deg: 0.0,
        fov_deg: 58.0,
        auto_orbit: false,
    },
];

#[derive(Clone, Copy, Debug)]
pub struct Kinematics {
    pub rapidity: f64,
    pub beta: f64,
    pub gamma: f64,
    pub one_minus_beta: f64,
    pub doppler_fwd: f64,
    pub doppler_aft: f64,
    pub headlight_half_angle_deg: f64,
    pub terrell_rotation_deg: f64,
}

pub fn kinematics_from_rapidity(rapidity: f64) -> Kinematics {
    let eta = rapidity.clamp(0.0, MAX_RAPIDITY);
    let beta = eta.tanh();
    let gamma = eta.cosh();
    let one_minus_beta = (-eta).exp() / gamma;
    let doppler_fwd = eta.exp();
    let doppler_aft = (-eta).exp();
    let headlight_half_angle_deg = beta.clamp(-1.0, 1.0).acos().to_degrees();
    let terrell_rotation_deg = beta.clamp(-1.0, 1.0).asin().to_degrees();
    Kinematics {
        rapidity: eta,
        beta,
        gamma,
        one_minus_beta,
        doppler_fwd,
        doppler_aft,
        headlight_half_angle_deg,
        terrell_rotation_deg,
    }
}

#[derive(Clone, Debug)]
pub struct StarflightTelemetry {
    pub effective_rapidity: f64,
    pub eff_beta: f64,
    pub eff_gamma: f64,
    pub eff_one_minus_beta: f64,
    pub true_rapidity: f64,
    pub true_beta: f64,
    pub true_gamma: f64,
    pub true_doppler_fwd: f64,
    pub true_doppler_aft: f64,
    pub cmb_peak_temp_k: f64,
    pub coord_time_yr: f64,
    pub visual_pace: f64,
    pub phase_label: &'static str,
    pub aberration_strength: f64,
}

pub fn compute_brachistochrone_rapidity_and_coord_time(
    proper_time_yr: f64,
    accel_g: f64,
) -> (f64, f64, &'static str) {
    let tau = proper_time_yr.max(0.0);
    let safe_accel = accel_g.max(0.05);
    let half_tau = (BRACHISTOCHRONE_HALF_TAU_BASE_YR / safe_accel).max(0.25);
    let alpha = safe_accel * ACCEL_1G_PER_YR;

    let integrate_half_leg = |dur: f64| -> (f64, f64) {
        let d = dur.max(0.0);
        let tau_cap = MAX_RAPIDITY / alpha;
        if d <= tau_cap {
            let eta = alpha * d;
            (eta.sinh() / alpha, (eta.cosh() - 1.0) / alpha)
        } else {
            let coast = d - tau_cap;
            (
                MAX_RAPIDITY.sinh() / alpha + MAX_RAPIDITY.cosh() * coast,
                (MAX_RAPIDITY.cosh() - 1.0) / alpha + MAX_RAPIDITY.sinh() * coast,
            )
        }
    };

    let (full_half_t, _) = integrate_half_leg(half_tau);
    if tau <= 0.0 {
        return (0.0, 0.0, "accel");
    }

    let n_full_half = (tau / half_tau).floor() as i64;
    let tau_in_half = (tau - (n_full_half as f64) * half_tau).max(0.0);
    let is_odd_half = (n_full_half % 2) == 1;

    let (phase, tau_leg, partial_t) = if tau_in_half == 0.0 && is_odd_half {
        ("accel", half_tau, 0.0)
    } else if is_odd_half {
        let rem_tau = (half_tau - tau_in_half).max(0.0);
        let (rem_t, _) = integrate_half_leg(rem_tau);
        ("decel", rem_tau, full_half_t - rem_t)
    } else {
        let (prog_t, _) = integrate_half_leg(tau_in_half);
        ("accel", tau_in_half, prog_t)
    };

    let rapidity = (alpha * tau_leg).min(MAX_RAPIDITY);
    let coord_time_yr = (n_full_half as f64) * full_half_t + partial_t;
    (rapidity, coord_time_yr, phase)
}

#[allow(clippy::too_many_arguments)]
pub fn compute_starflight_telemetry(
    flight_mode: i32,
    rapidity_state: f64,
    proper_accel_g: f64,
    proper_time_yr: f64,
    aberration_mode: i32,
    cmb_temp_scale: f64,
) -> StarflightTelemetry {
    let safe_accel = proper_accel_g.clamp(0.05, 20.0);
    let tau = proper_time_yr.max(0.0);
    let (rapidity, coord_time_yr, phase_label) = if flight_mode == 1 {
        compute_brachistochrone_rapidity_and_coord_time(tau, safe_accel)
    } else {
        let eta = rapidity_state.clamp(0.0, MAX_RAPIDITY);
        (eta, tau * eta.cosh(), "cruise")
    };

    let aberration_strength = if aberration_mode == 0 { 0.0 } else { 1.0 };
    let effective_rapidity = if aberration_mode == 0 { 0.0 } else { rapidity };
    let eff_kin = kinematics_from_rapidity(effective_rapidity);
    let true_kin = kinematics_from_rapidity(rapidity);
    let visual_pace = 1.6 + (11.5 * true_kin.rapidity.min(3.5)) / 3.5 + 0.8 * true_kin.beta;
    let scale = cmb_temp_scale.max(0.1);

    StarflightTelemetry {
        effective_rapidity: eff_kin.rapidity,
        eff_beta: eff_kin.beta,
        eff_gamma: eff_kin.gamma,
        eff_one_minus_beta: eff_kin.one_minus_beta,
        true_rapidity: true_kin.rapidity,
        true_beta: true_kin.beta,
        true_gamma: true_kin.gamma,
        true_doppler_fwd: true_kin.doppler_fwd,
        true_doppler_aft: true_kin.doppler_aft,
        cmb_peak_temp_k: T_CMB_K * scale * eff_kin.doppler_fwd,
        coord_time_yr,
        visual_pace,
        phase_label,
        aberration_strength,
    }
}

#[derive(Clone, Copy)]
struct BridgePose {
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
}

fn apply_local_look(look_yaw: f32, look_pitch: f32, roll: f32) -> BridgePose {
    let r0 = [-1.0_f32, 0.0, 0.0];
    let u0 = [0.0_f32, 1.0, 0.0];
    let f0 = [0.0_f32, 0.0, 1.0];

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

    BridgePose { right, up, forward }
}

struct BridgeFlight {
    elapsed: f32,
    duration: f32,
    start_yaw: f32,
    start_pitch: f32,
    start_roll: f32,
    start_fov: f32,
    end_yaw: f32,
    end_pitch: f32,
    end_roll: f32,
    end_fov: f32,
}

struct StarflightCamera {
    look_yaw: f32,
    look_pitch: f32,
    roll: f32,
    fov: f32,

    target_look_yaw: f32,
    target_look_pitch: f32,
    target_roll: f32,
    target_fov: f32,

    vel_look_yaw: f32,
    vel_look_pitch: f32,
    vel_roll: f32,
    vel_fov: f32,

    flight: Option<BridgeFlight>,
    auto_pan_time: f32,
    auto_base_yaw: f32,
    auto_base_pitch: f32,
    interaction_cooldown: f32,

    pose: BridgePose,
    moved: bool,
    prev_sig: Option<[f32; 10]>,
}

impl StarflightCamera {
    fn from_preset(p: &StarflightPreset) -> Self {
        let yaw0 = p.look_yaw_deg * DEG2RAD;
        let pitch0 = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        let mut cam = Self {
            look_yaw: yaw0,
            look_pitch: pitch0,
            roll: roll0,
            fov: fov0,
            target_look_yaw: yaw0,
            target_look_pitch: pitch0,
            target_roll: roll0,
            target_fov: fov0,
            vel_look_yaw: 0.0,
            vel_look_pitch: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            flight: None,
            auto_pan_time: 0.0,
            auto_base_yaw: yaw0,
            auto_base_pitch: pitch0,
            interaction_cooldown: 0.0,
            pose: apply_local_look(yaw0, pitch0, roll0),
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn fly_to(&mut self, p: &StarflightPreset, duration: f32) {
        let dest_yaw_raw = p.look_yaw_deg * DEG2RAD;
        let mut delta_yaw = wrap_angle_delta(dest_yaw_raw - self.look_yaw);
        if (delta_yaw.abs() - std::f32::consts::PI).abs() < 1e-6 {
            delta_yaw = if dest_yaw_raw >= self.look_yaw {
                std::f32::consts::PI
            } else {
                -std::f32::consts::PI
            };
        }
        let dest_yaw = self.look_yaw + delta_yaw;
        let dest_pitch = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        if duration <= 0.0 {
            self.flight = None;
            self.look_yaw = dest_yaw_raw;
            self.target_look_yaw = dest_yaw_raw;
            self.look_pitch = dest_pitch;
            self.target_look_pitch = dest_pitch;
            self.roll = dest_roll;
            self.target_roll = dest_roll;
            self.fov = dest_fov;
            self.target_fov = dest_fov;
            self.vel_look_yaw = 0.0;
            self.vel_look_pitch = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.auto_base_yaw = dest_yaw_raw;
            self.auto_base_pitch = dest_pitch;
            self.auto_pan_time = 0.0;
            self.interaction_cooldown = 0.0;
            self.recompute_basis();
            self.moved = true;
        } else {
            self.flight = Some(BridgeFlight {
                elapsed: 0.0,
                duration,
                start_yaw: self.look_yaw,
                start_pitch: self.look_pitch,
                start_roll: self.roll,
                start_fov: self.fov,
                end_yaw: dest_yaw,
                end_pitch: dest_pitch,
                end_roll: dest_roll,
                end_fov: dest_fov,
            });
            self.vel_look_yaw = 0.0;
            self.vel_look_pitch = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.interaction_cooldown = 0.0;
        }
    }

    fn flip_aft_forward(&mut self, duration: f32) {
        let base_yaw = self
            .flight
            .as_ref()
            .map(|f| f.end_yaw)
            .unwrap_or(self.look_yaw);
        let wrapped = wrap_angle_delta(base_yaw);
        let abs_yaw = wrapped.abs();
        let near_forward = abs_yaw <= 30.0 * DEG2RAD;
        let near_aft = (abs_yaw - std::f32::consts::PI).abs() <= 30.0 * DEG2RAD;

        let dest_yaw = if near_forward {
            base_yaw
                + if base_yaw <= std::f32::consts::FRAC_PI_2 {
                    std::f32::consts::PI
                } else {
                    -std::f32::consts::PI
                }
        } else if near_aft {
            base_yaw
                + if base_yaw >= 0.0 {
                    -std::f32::consts::PI
                } else {
                    std::f32::consts::PI
                }
        } else {
            let target_wrapped = if abs_yaw <= std::f32::consts::FRAC_PI_2 {
                std::f32::consts::PI
            } else {
                0.0
            };
            base_yaw + wrap_angle_delta(target_wrapped - wrapped)
        };

        if duration <= 0.0 {
            self.flight = None;
            self.look_yaw = dest_yaw;
            self.target_look_yaw = dest_yaw;
            self.vel_look_yaw = 0.0;
            self.auto_base_yaw = dest_yaw;
            self.auto_pan_time = 0.0;
            self.interaction_cooldown = 0.0;
            self.recompute_basis();
            self.moved = true;
        } else {
            self.flight = Some(BridgeFlight {
                elapsed: 0.0,
                duration,
                start_yaw: self.look_yaw,
                start_pitch: self.look_pitch,
                start_roll: self.roll,
                start_fov: self.fov,
                end_yaw: dest_yaw,
                end_pitch: self.target_look_pitch,
                end_roll: self.target_roll,
                end_fov: self.target_fov,
            });
            self.vel_look_yaw = 0.0;
            self.vel_look_pitch = 0.0;
            self.vel_roll = 0.0;
            self.vel_fov = 0.0;
            self.interaction_cooldown = 0.0;
        }
    }

    fn cancel_flight(&mut self) {
        if self.flight.take().is_some() {
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
            self.target_roll = self.roll;
            self.target_fov = self.fov;
        }
    }

    fn mark_interaction(&mut self) {
        self.cancel_flight();
        self.interaction_cooldown = INTERACTION_COOLDOWN;
        self.auto_base_yaw = self.target_look_yaw;
        self.auto_base_pitch = self.target_look_pitch;
        self.auto_pan_time = 0.0;
    }

    fn is_aft(&self) -> bool {
        wrap_angle_delta(self.look_yaw).abs() > std::f32::consts::FRAC_PI_2
    }

    fn update(&mut self, dt: f32, paused: bool, auto_pan: bool, input: &SimInput) {
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
                } else {
                    let fov_gain = (self.fov / (55.0 * DEG2RAD)).clamp(0.25, 1.4);
                    self.target_look_yaw += dx * scale * 2.4 * fov_gain;
                    self.target_look_pitch = (self.target_look_pitch - dy * scale * 2.1 * fov_gain)
                        .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
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
            self.target_fov = (self.target_fov * factor).clamp(MIN_FOV, MAX_FOV);
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let fov_gain = (self.fov / (55.0 * DEG2RAD)).clamp(0.25, 1.4);
            let look_rate = 1.05 * fov_gain * cdt;
            let roll_rate = 0.75 * cdt;
            let zoom_factor = (0.75 * cdt).exp();

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
                self.target_fov = (self.target_fov / zoom_factor).clamp(MIN_FOV, MAX_FOV);
            }
            if input.key_s {
                self.target_fov = (self.target_fov * zoom_factor).clamp(MIN_FOV, MAX_FOV);
            }
            if input.key_q {
                self.target_roll = (self.target_roll - roll_rate).clamp(MIN_ROLL, MAX_ROLL);
            }
            if input.key_e {
                self.target_roll = (self.target_roll + roll_rate).clamp(MIN_ROLL, MAX_ROLL);
            }
            self.interaction_cooldown = INTERACTION_COOLDOWN;
            self.auto_base_yaw = self.target_look_yaw;
            self.auto_base_pitch = self.target_look_pitch;
        }

        if let Some(mut f) = self.flight.take() {
            f.elapsed += cdt;
            let t = (f.elapsed / f.duration).clamp(0.0, 1.0);
            let e = ease_out_cubic(t);

            self.look_yaw = f.start_yaw + (f.end_yaw - f.start_yaw) * e;
            self.look_pitch = (f.start_pitch + (f.end_pitch - f.start_pitch) * e)
                .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
            self.roll = (f.start_roll + (f.end_roll - f.start_roll) * e).clamp(MIN_ROLL, MAX_ROLL);
            self.fov = (f.start_fov + (f.end_fov - f.start_fov) * e).clamp(MIN_FOV, MAX_FOV);

            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
            self.target_roll = self.roll;
            self.target_fov = self.fov;

            if t >= 1.0 {
                self.auto_base_yaw = self.look_yaw;
                self.auto_base_pitch = self.look_pitch;
                self.auto_pan_time = 0.0;
            } else {
                self.flight = Some(f);
            }
        } else {
            if self.interaction_cooldown > 0.0 && !interacting {
                self.interaction_cooldown = (self.interaction_cooldown - cdt).max(0.0);
            }
            if auto_pan && !paused && !interacting && self.interaction_cooldown <= 0.0 {
                self.auto_pan_time += cdt;
                let ramp = (self.auto_pan_time / 1.5).clamp(0.0, 1.0);
                self.target_look_yaw = self.auto_base_yaw
                    + (self.auto_pan_time * AUTO_PAN_YAW_FREQ).sin() * AUTO_PAN_YAW_AMP * ramp;
                self.target_look_pitch = (self.auto_base_pitch
                    + (self.auto_pan_time * AUTO_PAN_PITCH_FREQ).sin() * AUTO_PAN_PITCH_AMP * ramp)
                    .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
            }

            if cdt > 0.0 {
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
                self.look_pitch = np.clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
                self.vel_look_pitch = vp;

                let (nr, vr) = step_critically_damped(
                    self.roll,
                    self.vel_roll,
                    self.target_roll,
                    SPRING_OMEGA,
                    cdt,
                );
                self.roll = nr.clamp(MIN_ROLL, MAX_ROLL);
                self.vel_roll = vr;

                let (nf, vf) = step_critically_damped(
                    self.fov,
                    self.vel_fov,
                    self.target_fov,
                    SPRING_OMEGA,
                    cdt,
                );
                self.fov = nf.clamp(MIN_FOV, MAX_FOV);
                self.vel_fov = vf;
            }
        }

        self.recompute_basis();
    }

    fn recompute_basis(&mut self) {
        self.pose = apply_local_look(self.look_yaw, self.look_pitch, self.roll);
        let sig = [
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
            for i in 0..10 {
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

pub struct StarflightSim {
    active_preset: Option<usize>,
    flight_mode: i32,
    rapidity: f32,
    proper_accel_g: f32,
    proper_time_yr: f32,
    flight_pos_z: f32,
    flight_dir: i32,
    aberration_mode: i32,

    doppler_strength: f32,
    cmb_visibility: f32,
    star_density: f32,
    uv_ir_gain: f32,
    geometry_visibility: f32,
    dust_density: f32,
    dust_streak_scale: f32,
    beaming_gain: f32,
    cmb_temp_scale: f32,

    sky_intensity: f32,
    sky_mode: i32,
    sky_rot: [f32; 2],
    quality: i32,
    resolution_scale: f32,
    exposure: f32,
    bloom_intensity: f32,
    anamorphic_intensity: f32,

    paused: bool,
    auto_orbit: bool,
    sim_time: f32,
    camera: StarflightCamera,

    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl StarflightSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[1]; // Default preset is headlight_90
        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::Starflight,
            "starflight",
            SimBglKind::Standard,
            shaders::STARFLIGHT,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("starflight-ubo"),
            size: std::mem::size_of::<StarflightUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_standard_bind_group("starflight-bg", &ubo, None);

        Self {
            active_preset: Some(1),
            flight_mode: p.flight_mode,
            rapidity: p.rapidity,
            proper_accel_g: p.proper_accel_g,
            proper_time_yr: p.proper_time_yr,
            flight_pos_z: 0.0,
            flight_dir: p.flight_dir,
            aberration_mode: p.aberration_mode,
            doppler_strength: p.doppler_strength,
            cmb_visibility: p.cmb_visibility,
            star_density: p.star_density,
            uv_ir_gain: p.uv_ir_gain,
            geometry_visibility: p.geometry_visibility,
            dust_density: p.dust_density,
            dust_streak_scale: p.dust_streak_scale,
            beaming_gain: p.beaming_gain,
            cmb_temp_scale: p.cmb_temp_scale,
            sky_intensity: p.sky_intensity,
            sky_mode: p.sky_mode,
            sky_rot: p.sky_rot,
            quality: 1,
            resolution_scale: 1.0,
            exposure: p.exposure,
            bloom_intensity: p.bloom,
            anamorphic_intensity: p.anamorphic,
            paused: false,
            auto_orbit: p.auto_orbit,
            sim_time: 0.0,
            camera: StarflightCamera::from_preset(p),
            pipeline,
            ubo,
            bind_group,
        }
    }

    fn telemetry(&self) -> StarflightTelemetry {
        compute_starflight_telemetry(
            self.flight_mode,
            self.rapidity as f64,
            self.proper_accel_g as f64,
            self.proper_time_yr as f64,
            self.aberration_mode,
            self.cmb_temp_scale as f64,
        )
    }

    fn build_uniforms(
        &self,
        render_width: u32,
        render_height: u32,
        frame_index: u32,
        jitter: [f32; 2],
        is_progressive: bool,
    ) -> StarflightUniforms {
        let tel = self.telemetry();
        let fdir = if self.flight_dir >= 0 {
            1.0_f32
        } else {
            -1.0_f32
        };
        StarflightUniforms {
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
            cam_right_beta: [
                self.camera.pose.right[0],
                self.camera.pose.right[1],
                self.camera.pose.right[2],
                tel.eff_beta as f32,
            ],
            cam_up_gamma: [
                self.camera.pose.up[0],
                self.camera.pose.up[1],
                self.camera.pose.up[2],
                tel.eff_gamma as f32,
            ],
            cam_fwd_one_minus_beta: [
                self.camera.pose.forward[0],
                self.camera.pose.forward[1],
                self.camera.pose.forward[2],
                tel.eff_one_minus_beta as f32,
            ],
            flight_kinematics: [
                fdir,
                self.flight_pos_z,
                tel.effective_rapidity as f32,
                self.doppler_strength,
            ],
            spectral_params: [
                self.cmb_visibility,
                self.star_density,
                self.uv_ir_gain,
                tel.aberration_strength as f32,
            ],
            foreground_params: [
                self.geometry_visibility,
                self.dust_density,
                self.dust_streak_scale,
                self.proper_accel_g,
            ],
            sky_params: [
                self.sky_intensity,
                self.sky_mode as f32,
                self.sky_rot[0],
                self.sky_rot[1],
            ],
            quality_params: [
                self.quality as f32,
                self.proper_time_yr,
                tel.coord_time_yr as f32,
                tel.visual_pace as f32,
            ],
            extra_params: [self.beaming_gain, self.cmb_temp_scale, 0.0, 0.0],
        }
    }
}

fn format_beta(beta: f64) -> String {
    if beta >= 0.999999 {
        format!("{:.7}c", beta)
    } else if beta >= 0.9999 {
        format!("{:.6}c", beta)
    } else if beta >= 0.99 {
        format!("{:.5}c", beta)
    } else {
        format!("{:.4}c", beta)
    }
}

fn format_gamma(gamma: f64) -> String {
    if gamma >= 100.0 {
        format!("{:.1}", gamma)
    } else if gamma >= 10.0 {
        format!("{:.2}", gamma)
    } else {
        format!("{:.3}", gamma)
    }
}

fn format_doppler(d: f64) -> String {
    if d >= 100.0 {
        format!("{}×", d.round() as i64)
    } else if d >= 10.0 {
        format!("{:.1}×", d)
    } else if d >= 0.1 {
        format!("{:.2}×", d)
    } else if d >= 0.01 {
        format!("{:.3}×", d)
    } else {
        format!("{:.1e}×", d)
    }
}

impl Simulation for StarflightSim {
    fn id(&self) -> SimId {
        SimId::Starflight
    }

    fn post_tuning(&self) -> PostTuning {
        PostTuning::starflight()
    }

    fn post_params(&self, camera_moved: bool, sim_time: f32) -> PostFrameParams {
        let motion = camera_moved || !self.paused;
        PostFrameParams {
            exposure: self.exposure,
            bloom_intensity: self.bloom_intensity,
            anamorphic_intensity: self.anamorphic_intensity,
            paused: self.paused,
            camera_moved: motion,
            sim_time,
            resolution_scale: self.resolution_scale,
            tuning: PostTuning::starflight(),
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
            self.flight_mode = p.flight_mode;
            self.rapidity = p.rapidity;
            self.proper_accel_g = p.proper_accel_g;
            self.proper_time_yr = p.proper_time_yr;
            self.flight_dir = p.flight_dir;
            self.aberration_mode = p.aberration_mode;
            self.geometry_visibility = p.geometry_visibility;
            self.dust_density = p.dust_density;
            self.cmb_visibility = p.cmb_visibility;
            self.star_density = p.star_density;
            self.uv_ir_gain = p.uv_ir_gain;
            self.doppler_strength = p.doppler_strength;
            self.dust_streak_scale = p.dust_streak_scale;
            self.beaming_gain = p.beaming_gain;
            self.cmb_temp_scale = p.cmb_temp_scale;
            self.sky_intensity = p.sky_intensity;
            self.sky_mode = p.sky_mode;
            self.sky_rot = p.sky_rot;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.auto_orbit = p.auto_orbit;
            if self.flight_mode == 1 {
                let tel = self.telemetry();
                self.rapidity = tel.true_rapidity as f32;
            }
            self.camera.fly_to(p, 1.1);
        }
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        const SECTIONS: &[ControlSection] = &[
            ControlSection {
                id: "flight",
                title: "RELATIVISTIC FLIGHT",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "flightMode",
                        label: "Flight Mode",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Manual v/c"), (1, "1g Accel")],
                        },
                    },
                    ControlItem {
                        key: "rapidity",
                        label: "Rapidity / Velocity (η · v/c)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 7.65,
                            step: 0.01,
                            hints: Some(["0.00c (Rest)", "0.9999996c (γ 1050)"]),
                        },
                    },
                    ControlItem {
                        key: "properAccelG",
                        label: "Proper Acceleration",
                        kind: ControlKind::Range {
                            min: 0.1,
                            max: 5.0,
                            step: 0.1,
                            hints: Some(["0.1 g", "5.0 g"]),
                        },
                    },
                    ControlItem {
                        key: "flightDir",
                        label: "Thrust Direction",
                        kind: ControlKind::Segmented {
                            options: &[(1, "Forward"), (-1, "Reverse")],
                        },
                    },
                    ControlItem {
                        key: "aberrationMode",
                        label: "Lorentz Aberration",
                        kind: ControlKind::Segmented {
                            options: &[(1, "Exact SR"), (0, "Rest Frame")],
                        },
                    },
                ],
            },
            ControlSection {
                id: "spectral",
                title: "SPECTRAL SKY & FOREGROUND",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "cmbVisibility",
                        label: "CMB Shell Gain",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "starDensity",
                        label: "Starfield Density",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "uvIrGain",
                        label: "UV / IR Star Shift Gain",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "geometryVisibility",
                        label: "Terrell Beacons & Rings",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "dustDensity",
                        label: "Hydrogen Dust Streaks",
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
                            options: &[(0, "4K Milky Way"), (1, "Procedural")],
                        },
                    },
                    ControlItem {
                        key: "quality",
                        label: "Ray-Trace Quality",
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
            "rapidity" => self.rapidity,
            "properAccelG" => self.proper_accel_g,
            "cmbVisibility" => self.cmb_visibility,
            "starDensity" => self.star_density,
            "uvIrGain" => self.uv_ir_gain,
            "geometryVisibility" => self.geometry_visibility,
            "dustDensity" => self.dust_density,
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
            "rapidity" => {
                self.rapidity = val.clamp(0.0, 7.65);
                if self.flight_mode == 1 {
                    self.flight_mode = 0;
                }
            }
            "properAccelG" => {
                self.proper_accel_g = val;
                if self.flight_mode == 1 {
                    self.rapidity = self.telemetry().true_rapidity as f32;
                }
            }
            "cmbVisibility" => self.cmb_visibility = val,
            "starDensity" => self.star_density = val,
            "uvIrGain" => self.uv_ir_gain = val,
            "geometryVisibility" => self.geometry_visibility = val,
            "dustDensity" => self.dust_density = val,
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
            "flightMode" => self.flight_mode,
            "flightDir" => self.flight_dir,
            "aberrationMode" => self.aberration_mode,
            "skyMode" => self.sky_mode,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "flightMode" => {
                self.flight_mode = if val == 1 { 1 } else { 0 };
                if self.flight_mode == 1 {
                    self.rapidity = self.telemetry().true_rapidity as f32;
                }
                self.active_preset = None;
            }
            "flightDir" => {
                self.flight_dir = if val >= 0 { 1 } else { -1 };
                self.active_preset = None;
            }
            "aberrationMode" => {
                self.aberration_mode = if val == 0 { 0 } else { 1 };
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
            "rapidity" => {
                let eta = (self.rapidity as f64).clamp(0.0, MAX_RAPIDITY);
                let beta = eta.tanh();
                let gamma = eta.cosh();
                let beta_str = format_beta(beta);
                let gamma_str = if gamma >= 100.0 {
                    format!("{:.1}", gamma)
                } else {
                    format!("{:.2}", gamma)
                };
                format!("{beta_str} (γ {gamma_str})")
            }
            "properAccelG" => format!("{:.1} g", self.proper_accel_g),
            "cmbVisibility" => format!("{:.2}", self.cmb_visibility),
            "starDensity" => format!("{:.2}", self.star_density),
            "uvIrGain" => format!("{:.2}", self.uv_ir_gain),
            "geometryVisibility" => format!("{:.2}", self.geometry_visibility),
            "dustDensity" => format!("{:.2}", self.dust_density),
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
        let idx = self.active_preset.unwrap_or(1);
        self.camera.fly_to(&PRESETS[idx], 0.9);
    }

    fn trigger_special_action(&mut self) {
        self.camera.flip_aft_forward(0.9);
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

        let clock_str = if self.flight_mode == 1 {
            format!("{:.2} / {:.2} yr", self.proper_time_yr, tel.coord_time_yr)
        } else {
            let rate = if tel.true_gamma >= 100.0 {
                format!("{:.1}", tel.true_gamma)
            } else {
                format!("{:.2}", tel.true_gamma)
            };
            format!("{rate}×")
        };

        let cmb_str = if tel.cmb_peak_temp_k >= 100.0 {
            format!("{} K", tel.cmb_peak_temp_k.round() as i64)
        } else {
            format!("{:.1} K", tel.cmb_peak_temp_k)
        };

        let sr_label = if self.aberration_mode == 0 {
            "Rest Frame"
        } else {
            "Exact SR"
        };
        let drawer_subtitle = if self.flight_mode == 1 {
            format!(
                "{sr_label} · η {:.2} · γ {} · {}",
                tel.true_rapidity,
                format_gamma(tel.true_gamma),
                tel.phase_label
            )
        } else {
            format!(
                "{sr_label} · η {:.2} · γ {}",
                tel.true_rapidity,
                format_gamma(tel.true_gamma)
            )
        };

        HudMetadata {
            brand_title: "RELATIVISTIC STARFLIGHT",
            preset_badge,
            secondary_badge,
            secondary_badge_warm: true,
            drawer_title: "SR FLIGHT & SPECTRAL OPTICS",
            drawer_subtitle,
            hint_text: "Drag to look · Right-drag roll · Scroll/W/S FOV · T Aft/Fwd · Space 128× Still · H HUD",
            telemetry: [
                TelemetryCell {
                    label: "VELOCITY",
                    unit: "v/c",
                    value: format_beta(tel.true_beta),
                },
                TelemetryCell {
                    label: "LORENTZ",
                    unit: "γ",
                    value: format_gamma(tel.true_gamma),
                },
                TelemetryCell {
                    label: "DOPPLER",
                    unit: "D_fwd/D_aft",
                    value: format!(
                        "{} / {}",
                        format_doppler(tel.true_doppler_fwd),
                        format_doppler(tel.true_doppler_aft)
                    ),
                },
                TelemetryCell {
                    label: "CLOCK",
                    unit: "τ / t",
                    value: clock_str,
                },
                TelemetryCell {
                    label: "CMB FWD",
                    unit: "T_fwd",
                    value: cmb_str,
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: "Aft / Fwd",
                key_hint: "T",
                active: self.camera.is_aft(),
            }),
            orbit_toggle_label: "Pan",
        }
    }

    fn step(&mut self, dt: f32, input: &SimInput) -> StepOutcome {
        let cdt = dt.clamp(0.0, 0.05);
        if !self.paused {
            self.sim_time += cdt;
            if self.flight_mode == 1 {
                self.proper_time_yr += cdt * 0.14;
                let tel = self.telemetry();
                self.rapidity = tel.true_rapidity as f32;
            }
            let tel = self.telemetry();
            let dir_sign = if self.flight_dir >= 0 {
                1.0_f32
            } else {
                -1.0_f32
            };
            self.flight_pos_z = (self.flight_pos_z + cdt * (tel.visual_pace as f32) * dir_sign)
                .rem_euclid(FLIGHT_PERIOD_Z);
        }
        self.camera.update(cdt, self.paused, self.auto_orbit, input);
        StepOutcome {
            camera_moved: self.camera.moved,
            sim_time: self.sim_time,
            reset_accumulation: false,
        }
    }

    fn rebuild_bind_groups(&mut self, assets: &mut SharedGpuAssets) {
        self.bind_group = assets.build_standard_bind_group("starflight-bg", &self.ubo, None);
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
            "starflight-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
            timestamp_writes,
        );
    }
}
