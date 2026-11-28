use std::f32::consts::PI;
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

const DEG2RAD: f32 = PI / 180.0;

const MIN_L: f32 = -35.0;
const MAX_L: f32 = 35.0;
const MIN_ELEVATION: f32 = -85.0 * DEG2RAD;
const MAX_ELEVATION: f32 = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH: f32 = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH: f32 = 85.0 * DEG2RAD;
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
struct WormholeUniforms {
    resolution_time_frame: [f32; 4],
    jitter_fov_cam_l: [f32; 4],
    cam_n0_tan_half_fov: [f32; 4],
    cam_right_rho: [f32; 4],
    cam_up_throat_len: [f32; 4],
    cam_forward_lensing_w: [f32; 4],
    matter_sky_params: [f32; 4],
    sky_b_rot_a_rot_bx: [f32; 4],
    rot_by_cam_r_escape_l_pad: [f32; 4],
    modes: [i32; 4],
    sky_trig_a: [f32; 4],
    sky_trig_b: [f32; 4],
}

#[derive(Clone, Copy)]
struct WormholePreset {
    meta: PresetMeta,
    metric_type: i32,
    throat_radius: f32,
    throat_length: f32,
    lensing_width: f32,
    throat_glow: f32,
    dust_density: f32,
    swirl_speed: f32,
    sky_intensity_a: f32,
    sky_intensity_b: f32,
    planet_visible: i32,
    sky_rot_a: [f32; 2],
    sky_rot_b: [f32; 2],
    exposure: f32,
    bloom: f32,
    anamorphic: f32,
    l: f32,
    elevation_deg: f32,
    azimuth_deg: f32,
    look_yaw_deg: f32,
    look_pitch_deg: f32,
    roll_deg: f32,
    fov_deg: f32,
    auto_orbit: bool,
}

const PRESETS: [WormholePreset; 6] = [
    WormholePreset {
        meta: PresetMeta {
            id: "interstellar",
            full_name: "Interstellar Portal",
            short_label: "Interstellar",
            hotkey: "1",
        },
        metric_type: 0,
        throat_radius: 2.0,
        throat_length: 0.25,
        lensing_width: 0.32,
        throat_glow: 0.22,
        dust_density: 0.35,
        swirl_speed: 0.85,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: 10.5,
        elevation_deg: 6.0,
        azimuth_deg: 0.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: -4.0,
        fov_deg: 48.0,
        auto_orbit: true,
    },
    WormholePreset {
        meta: PresetMeta {
            id: "ellis",
            full_name: "Pure Ellis Throat",
            short_label: "Ellis",
            hotkey: "2",
        },
        metric_type: 1,
        throat_radius: 2.2,
        throat_length: 0.0,
        lensing_width: 1.0,
        throat_glow: 0.0,
        dust_density: 0.0,
        swirl_speed: 0.85,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: 9.5,
        elevation_deg: 8.0,
        azimuth_deg: 18.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 46.0,
        auto_orbit: true,
    },
    WormholePreset {
        meta: PresetMeta {
            id: "tunnel",
            full_name: "Long Throat Tunnel",
            short_label: "Long Tunnel",
            hotkey: "3",
        },
        metric_type: 0,
        throat_radius: 1.8,
        throat_length: 4.5,
        lensing_width: 0.65,
        throat_glow: 0.55,
        dust_density: 0.75,
        swirl_speed: 1.1,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: 11.0,
        elevation_deg: 3.0,
        azimuth_deg: 0.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: -6.0,
        fov_deg: 52.0,
        auto_orbit: true,
    },
    WormholePreset {
        meta: PresetMeta {
            id: "crossing",
            full_name: "Inside the Throat",
            short_label: "In Throat",
            hotkey: "4",
        },
        metric_type: 0,
        throat_radius: 2.2,
        throat_length: 1.2,
        lensing_width: 0.55,
        throat_glow: 0.45,
        dust_density: 0.55,
        swirl_speed: 1.0,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: 0.0,
        elevation_deg: 0.0,
        azimuth_deg: 0.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: -5.0,
        fov_deg: 62.0,
        auto_orbit: false,
    },
    WormholePreset {
        meta: PresetMeta {
            id: "universe_b",
            full_name: "Gargantua Side (Univ B)",
            short_label: "Universe B",
            hotkey: "5",
        },
        metric_type: 0,
        throat_radius: 2.0,
        throat_length: 0.25,
        lensing_width: 0.32,
        throat_glow: 0.22,
        dust_density: 0.35,
        swirl_speed: 0.85,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: -10.5,
        elevation_deg: 7.0,
        azimuth_deg: 10.0,
        look_yaw_deg: 180.0,
        look_pitch_deg: 0.0,
        roll_deg: 4.0,
        fov_deg: 48.0,
        auto_orbit: true,
    },
    WormholePreset {
        meta: PresetMeta {
            id: "einstein",
            full_name: "Twin Einstein Rings",
            short_label: "Einstein Rings",
            hotkey: "6",
        },
        metric_type: 0,
        throat_radius: 1.6,
        throat_length: 0.25,
        lensing_width: 0.45,
        throat_glow: 0.12,
        dust_density: 0.15,
        swirl_speed: 0.85,
        sky_intensity_a: 1.0,
        sky_intensity_b: 1.15,
        planet_visible: 1,
        sky_rot_a: [0.4, 0.2],
        sky_rot_b: [1.1, -0.15],
        exposure: 1.05,
        bloom: 0.48,
        anamorphic: 0.20,
        l: 13.0,
        elevation_deg: 4.0,
        azimuth_deg: -22.0,
        look_yaw_deg: 0.0,
        look_pitch_deg: 0.0,
        roll_deg: 0.0,
        fov_deg: 42.0,
        auto_orbit: true,
    },
];

pub fn eval_wormhole_r(l: f64, metric_type: i32, rho: f64, a: f64, big_m: f64) -> f64 {
    if metric_type == 1 {
        return (rho * rho + l * l).sqrt();
    }
    let abs_l = l.abs();
    if abs_l <= a {
        return rho;
    }
    let x = (2.0 * (abs_l - a)) / (std::f64::consts::PI * big_m.max(1e-6));
    rho + big_m * (x * x.atan() - 0.5 * (1.0 + x * x).ln())
}

pub struct WormholeTelemetry {
    pub l: f64,
    pub r_of_l: f64,
    pub drdl: f64,
    pub region: &'static str,
    pub throat_radius: f64,
    pub apparent_throat_deg: f64,
}

pub fn compute_wormhole_telemetry(
    metric_type: i32,
    throat_radius: f64,
    throat_length: f64,
    lensing_width: f64,
    l_val: f64,
) -> WormholeTelemetry {
    let l = if l_val.is_finite() { l_val } else { 0.0 };
    let rho = throat_radius.max(0.25);
    let a = throat_length.max(0.0);
    let big_m = lensing_width.max(0.05);

    let (r_of_l, drdl) = if metric_type == 1 {
        let r = (rho * rho + l * l).sqrt();
        (r, l / r.max(1e-8))
    } else {
        let abs_l = l.abs();
        if abs_l <= a {
            (rho, 0.0)
        } else {
            let x = (2.0 * (abs_l - a)) / (std::f64::consts::PI * big_m);
            let r = rho + big_m * (x * x.atan() - 0.5 * (1.0 + x * x).ln());
            let sign_l = if l >= 0.0 { 1.0 } else { -1.0 };
            let slope = sign_l * (2.0 / std::f64::consts::PI) * x.atan();
            (r, slope)
        }
    };

    let throat_boundary = if metric_type == 0 { a.max(0.35) } else { 0.35 };
    let region = if l.abs() <= throat_boundary {
        "Throat"
    } else if l > 0.0 {
        "Universe A"
    } else {
        "Universe B"
    };

    let sin_half = (rho / r_of_l.max(1e-6)).clamp(0.0, 1.0);
    let apparent_throat_deg = 2.0 * sin_half.asin() * (180.0 / std::f64::consts::PI);

    WormholeTelemetry {
        l,
        r_of_l,
        drdl,
        region,
        throat_radius: rho,
        apparent_throat_deg,
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

struct WormholeFlight {
    elapsed: f32,
    duration: f32,
    in_out: bool,
    start_l: f32,
    start_el: f32,
    start_az: f32,
    start_yaw: f32,
    start_pitch: f32,
    start_roll: f32,
    start_fov: f32,
    end_l: f32,
    end_el: f32,
    end_az: f32,
    end_yaw: f32,
    end_pitch: f32,
    end_roll: f32,
    end_fov: f32,
}

struct WormholeCamera {
    l: f32,
    elevation: f32,
    azimuth: f32,
    look_yaw: f32,
    look_pitch: f32,
    roll: f32,
    fov: f32,

    target_l: f32,
    target_elevation: f32,
    target_azimuth: f32,
    target_look_yaw: f32,
    target_look_pitch: f32,
    target_roll: f32,
    target_fov: f32,

    vel_l: f32,
    vel_elevation: f32,
    vel_azimuth: f32,
    vel_look_yaw: f32,
    vel_look_pitch: f32,
    vel_roll: f32,
    vel_fov: f32,

    flight: Option<WormholeFlight>,
    auto_orbit_time: f32,
    auto_base_elevation: f32,
    interaction_cooldown: f32,

    n0: [f32; 3],
    basis: [f32; 9],
    moved: bool,
    prev_sig: Option<[f32; 14]>,
}

impl WormholeCamera {
    fn from_preset(p: &WormholePreset) -> Self {
        let l0 = p.l.clamp(MIN_L, MAX_L);
        let el0 = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let az0 = p.azimuth_deg * DEG2RAD;
        let yaw0 = p.look_yaw_deg * DEG2RAD;
        let pitch0 = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let roll0 = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let fov0 = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        let mut cam = Self {
            l: l0,
            elevation: el0,
            azimuth: az0,
            look_yaw: yaw0,
            look_pitch: pitch0,
            roll: roll0,
            fov: fov0,
            target_l: l0,
            target_elevation: el0,
            target_azimuth: az0,
            target_look_yaw: yaw0,
            target_look_pitch: pitch0,
            target_roll: roll0,
            target_fov: fov0,
            vel_l: 0.0,
            vel_elevation: 0.0,
            vel_azimuth: 0.0,
            vel_look_yaw: 0.0,
            vel_look_pitch: 0.0,
            vel_roll: 0.0,
            vel_fov: 0.0,
            flight: None,
            auto_orbit_time: 0.0,
            auto_base_elevation: el0,
            interaction_cooldown: 0.0,
            n0: [0.0, 0.0, 1.0],
            basis: [0.0; 9],
            moved: true,
            prev_sig: None,
        };
        cam.recompute_basis();
        cam
    }

    fn fly_to(&mut self, p: &WormholePreset, duration: f32) {
        let dest_l = p.l.clamp(MIN_L, MAX_L);
        let dest_el = (p.elevation_deg * DEG2RAD).clamp(MIN_ELEVATION, MAX_ELEVATION);
        let dest_az_raw = p.azimuth_deg * DEG2RAD;
        let dest_az = self.azimuth + wrap_angle_delta(dest_az_raw - self.azimuth);
        let dest_yaw_raw = p.look_yaw_deg * DEG2RAD;
        let dest_yaw = self.look_yaw + wrap_angle_delta(dest_yaw_raw - self.look_yaw);
        let dest_pitch = (p.look_pitch_deg * DEG2RAD).clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
        let dest_roll = (p.roll_deg * DEG2RAD).clamp(MIN_ROLL, MAX_ROLL);
        let dest_fov = (p.fov_deg * DEG2RAD).clamp(MIN_FOV, MAX_FOV);

        self.flight = Some(WormholeFlight {
            elapsed: 0.0,
            duration: duration.max(0.01),
            in_out: false,
            start_l: self.l,
            start_el: self.elevation,
            start_az: self.azimuth,
            start_yaw: self.look_yaw,
            start_pitch: self.look_pitch,
            start_roll: self.roll,
            start_fov: self.fov,
            end_l: dest_l,
            end_el: dest_el,
            end_az: dest_az,
            end_yaw: dest_yaw,
            end_pitch: dest_pitch,
            end_roll: dest_roll,
            end_fov: dest_fov,
        });
        self.vel_l = 0.0;
        self.vel_elevation = 0.0;
        self.vel_azimuth = 0.0;
        self.vel_look_yaw = 0.0;
        self.vel_look_pitch = 0.0;
        self.vel_roll = 0.0;
        self.vel_fov = 0.0;
        self.interaction_cooldown = 0.0;
    }

    fn traverse(&mut self) {
        let start_l = self.l;
        let target_l = if start_l.abs() < 0.5 {
            if self.look_yaw.cos() >= 0.0 {
                -10.5
            } else {
                10.5
            }
        } else {
            let mag = start_l.abs().max(2.0);
            if start_l > 0.0 { -mag } else { mag }
        }
        .clamp(MIN_L, MAX_L);

        self.flight = Some(WormholeFlight {
            elapsed: 0.0,
            duration: 3.2,
            in_out: true,
            start_l: self.l,
            start_el: self.elevation,
            start_az: self.azimuth,
            start_yaw: self.look_yaw,
            start_pitch: self.look_pitch,
            start_roll: self.roll,
            start_fov: self.fov,
            end_l: target_l,
            end_el: self.elevation,
            end_az: self.azimuth,
            end_yaw: self.look_yaw,
            end_pitch: self.look_pitch,
            end_roll: self.roll,
            end_fov: self.fov,
        });
        self.vel_l = 0.0;
        self.interaction_cooldown = 0.0;
    }

    fn forward_move_sign(&self) -> f32 {
        if self.target_look_yaw.cos() >= 0.0 {
            -1.0
        } else {
            1.0
        }
    }

    fn cancel_flight(&mut self) {
        if self.flight.take().is_some() {
            self.target_l = self.l;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
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
                if input.secondary_drag {
                    self.target_roll =
                        (self.target_roll + dx * scale * 2.2).clamp(MIN_ROLL, MAX_ROLL);
                } else if input.shift_down {
                    self.target_look_yaw += dx * scale * 2.6;
                    self.target_look_pitch = (self.target_look_pitch - dy * scale * 2.2)
                        .clamp(MIN_LOOK_PITCH, MAX_LOOK_PITCH);
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
            let speed = 0.0022 * (2.5 + self.target_l.abs());
            let sign = self.forward_move_sign();
            self.target_l = (self.target_l + (-sign) * delta * speed).clamp(MIN_L, MAX_L);
            self.mark_interaction();
        }

        if input.any_key_held() {
            interacting = true;
            self.cancel_flight();
            let orbit_rate = 0.85 * cdt;
            let elev_rate = 0.65 * cdt;
            let move_rate = (3.4 + 0.55 * self.target_l.abs()) * cdt;
            let roll_rate = 0.75 * cdt;
            let sign = self.forward_move_sign();

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
                self.target_l = (self.target_l + sign * move_rate).clamp(MIN_L, MAX_L);
            }
            if input.key_s {
                self.target_l = (self.target_l - sign * move_rate).clamp(MIN_L, MAX_L);
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
            let e = if f.in_out {
                ease_in_out_cubic(t)
            } else {
                ease_out_cubic(t)
            };

            self.l = f.start_l + (f.end_l - f.start_l) * e;
            self.elevation = f.start_el + (f.end_el - f.start_el) * e;
            self.azimuth = f.start_az + (f.end_az - f.start_az) * e;
            self.look_yaw = f.start_yaw + (f.end_yaw - f.start_yaw) * e;
            self.look_pitch = f.start_pitch + (f.end_pitch - f.start_pitch) * e;
            self.roll = f.start_roll + (f.end_roll - f.start_roll) * e;
            self.fov = f.start_fov + (f.end_fov - f.start_fov) * e;

            self.target_l = self.l;
            self.target_elevation = self.elevation;
            self.target_azimuth = self.azimuth;
            self.target_look_yaw = self.look_yaw;
            self.target_look_pitch = self.look_pitch;
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
                (self.l, self.vel_l) =
                    step_critically_damped(self.l, self.vel_l, self.target_l, SPRING_OMEGA, cdt);
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
        let cos_el = self.elevation.cos();
        let sin_el = self.elevation.sin();
        let cos_az = self.azimuth.cos();
        let sin_az = self.azimuth.sin();

        let nx = cos_el * sin_az;
        let ny = sin_el;
        let nz = cos_el * cos_az;
        self.n0 = [nx, ny, nz];

        let f0x = -nx;
        let f0y = -ny;
        let f0z = -nz;

        let mut r0x = -f0z;
        let r0y = 0.0_f32;
        let mut r0z = f0x;
        let r0_len = r0x.hypot(r0z);
        if r0_len < 1e-6 {
            r0x = cos_az;
            r0z = -sin_az;
        } else {
            r0x /= r0_len;
            r0z /= r0_len;
        }

        let mut u0x = r0y * f0z - r0z * f0y;
        let mut u0y = r0z * f0x - r0x * f0z;
        let mut u0z = r0x * f0y - r0y * f0x;
        let u0_len = (u0x * u0x + u0y * u0y + u0z * u0z).sqrt().max(1e-6);
        u0x /= u0_len;
        u0y /= u0_len;
        u0z /= u0_len;

        let cos_y = self.look_yaw.cos();
        let sin_y = self.look_yaw.sin();
        let fyx = cos_y * f0x + sin_y * r0x;
        let fyy = cos_y * f0y + sin_y * r0y;
        let fyz = cos_y * f0z + sin_y * r0z;

        let ryx = cos_y * r0x - sin_y * f0x;
        let ryy = cos_y * r0y - sin_y * f0y;
        let ryz = cos_y * r0z - sin_y * f0z;

        let cos_p = self.look_pitch.cos();
        let sin_p = self.look_pitch.sin();
        let fx = cos_p * fyx + sin_p * u0x;
        let fy = cos_p * fyy + sin_p * u0y;
        let fz = cos_p * fyz + sin_p * u0z;

        let upx = -sin_p * fyx + cos_p * u0x;
        let upy = -sin_p * fyy + cos_p * u0y;
        let upz = -sin_p * fyz + cos_p * u0z;

        let cos_r = self.roll.cos();
        let sin_r = self.roll.sin();
        let rx = cos_r * ryx + sin_r * upx;
        let ry = cos_r * ryy + sin_r * upy;
        let rz = cos_r * ryz + sin_r * upz;

        let ux = -sin_r * ryx + cos_r * upx;
        let uy = -sin_r * ryy + cos_r * upy;
        let uz = -sin_r * ryz + cos_r * upz;

        self.basis = [rx, ry, rz, ux, uy, uz, fx, fy, fz];

        let sig = [
            self.l, nx, ny, nz, rx, ry, rz, ux, uy, uz, fx, fy, fz, self.fov,
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

pub struct WormholeSim {
    active_preset: Option<usize>,

    metric_type: i32,
    throat_radius: f32,
    throat_length: f32,
    lensing_width: f32,
    throat_glow: f32,
    dust_density: f32,
    swirl_speed: f32,
    sky_intensity_a: f32,
    sky_intensity_b: f32,
    planet_visible: i32,
    sky_rot_a: [f32; 2],
    sky_rot_b: [f32; 2],

    exposure: f32,
    bloom_intensity: f32,
    anamorphic_intensity: f32,
    quality: i32,
    resolution_scale: f32,

    paused: bool,
    auto_orbit: bool,
    sim_time: f32,

    camera: WormholeCamera,
    pipeline: Arc<wgpu::RenderPipeline>,
    ubo: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl WormholeSim {
    pub fn new(assets: &mut SharedGpuAssets) -> Self {
        let p = &PRESETS[0];
        assets.ensure_procedural_sky_a();
        let pipeline = assets.get_or_create_sim_pipeline(
            SimId::Wormhole,
            "wormhole",
            SimBglKind::Wormhole,
            shaders::WORMHOLE,
        );
        let ubo = assets.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wormhole-ubo"),
            size: std::mem::size_of::<WormholeUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = assets.build_wormhole_bind_group(&ubo);

        Self {
            active_preset: Some(0),
            metric_type: p.metric_type,
            throat_radius: p.throat_radius,
            throat_length: p.throat_length,
            lensing_width: p.lensing_width,
            throat_glow: p.throat_glow,
            dust_density: p.dust_density,
            swirl_speed: p.swirl_speed,
            sky_intensity_a: p.sky_intensity_a,
            sky_intensity_b: p.sky_intensity_b,
            planet_visible: p.planet_visible,
            sky_rot_a: p.sky_rot_a,
            sky_rot_b: p.sky_rot_b,
            exposure: p.exposure,
            bloom_intensity: p.bloom,
            anamorphic_intensity: p.anamorphic,
            quality: 1,
            resolution_scale: 1.0,
            paused: false,
            auto_orbit: p.auto_orbit,
            sim_time: 0.0,
            camera: WormholeCamera::from_preset(p),
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
    ) -> WormholeUniforms {
        let rho = self.throat_radius.max(0.25);
        let throat_len = self.throat_length.max(0.0);
        let lensing_w = self.lensing_width.max(0.05);
        let metric_type = if self.metric_type == 1 { 1 } else { 0 };
        let tan_half_fov = (self.camera.fov.clamp(0.1, 2.8) * 0.5).tan();
        let cam_r = eval_wormhole_r(
            self.camera.l as f64,
            metric_type,
            rho as f64,
            throat_len as f64,
            lensing_w as f64,
        ) as f32;
        let escape_l =
            (self.camera.l.abs() * 3.0 + 40.0).max(throat_len + 4.0 * lensing_w.max(0.35) + 80.0);
        let b = self.camera.basis;
        let n0 = self.camera.n0;

        WormholeUniforms {
            resolution_time_frame: [
                render_width as f32,
                render_height as f32,
                self.sim_time,
                frame_index as f32,
            ],
            jitter_fov_cam_l: [jitter[0], jitter[1], self.camera.fov, self.camera.l],
            cam_n0_tan_half_fov: [n0[0], n0[1], n0[2], tan_half_fov],
            cam_right_rho: [b[0], b[1], b[2], rho],
            cam_up_throat_len: [b[3], b[4], b[5], throat_len],
            cam_forward_lensing_w: [b[6], b[7], b[8], lensing_w],
            matter_sky_params: [
                self.throat_glow,
                self.dust_density,
                self.swirl_speed,
                self.sky_intensity_a,
            ],
            sky_b_rot_a_rot_bx: [
                self.sky_intensity_b,
                self.sky_rot_a[0],
                self.sky_rot_a[1],
                self.sky_rot_b[0],
            ],
            rot_by_cam_r_escape_l_pad: [self.sky_rot_b[1], cam_r, escape_l, 0.0],
            modes: [
                frame_index as i32,
                metric_type,
                self.quality,
                self.planet_visible,
            ],
            sky_trig_a: [
                self.sky_rot_a[0].cos(),
                self.sky_rot_a[0].sin(),
                self.sky_rot_a[1].cos(),
                self.sky_rot_a[1].sin(),
            ],
            sky_trig_b: [
                self.sky_rot_b[0].cos(),
                self.sky_rot_b[0].sin(),
                self.sky_rot_b[1].cos(),
                self.sky_rot_b[1].sin(),
            ],
        }
    }
}

impl Simulation for WormholeSim {
    fn id(&self) -> SimId {
        SimId::Wormhole
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
            self.metric_type = p.metric_type;
            self.throat_radius = p.throat_radius;
            self.throat_length = p.throat_length;
            self.lensing_width = p.lensing_width;
            self.throat_glow = p.throat_glow;
            self.dust_density = p.dust_density;
            self.swirl_speed = p.swirl_speed;
            self.sky_intensity_a = p.sky_intensity_a;
            self.sky_intensity_b = p.sky_intensity_b;
            self.planet_visible = p.planet_visible;
            self.sky_rot_a = p.sky_rot_a;
            self.sky_rot_b = p.sky_rot_b;
            self.exposure = p.exposure;
            self.bloom_intensity = p.bloom;
            self.anamorphic_intensity = p.anamorphic;
            self.auto_orbit = p.auto_orbit;
            self.camera.fly_to(p, 1.15);
        }
    }

    fn control_sections(&self) -> &'static [ControlSection] {
        const SECTIONS: &[ControlSection] = &[
            ControlSection {
                id: "spacetime",
                title: "WORMHOLE METRIC & THROAT",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "metricType",
                        label: "Spacetime Metric",
                        kind: ControlKind::Segmented {
                            options: &[(0, "Interstellar"), (1, "Ellis")],
                        },
                    },
                    ControlItem {
                        key: "throatRadius",
                        label: "Throat Radius (ρ)",
                        kind: ControlKind::Range {
                            min: 0.8,
                            max: 4.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "throatLength",
                        label: "Throat Length (a)",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 6.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "lensingWidth",
                        label: "Lensing Width (M)",
                        kind: ControlKind::Range {
                            min: 0.05,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                ],
            },
            ControlSection {
                id: "matter",
                title: "THROAT MATTER & DUAL UNIVERSES",
                default_open: true,
                items: &[
                    ControlItem {
                        key: "throatGlow",
                        label: "Refractive Throat Glow",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.5,
                            step: 0.02,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "dustDensity",
                        label: "Portal Dust Density",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 1.8,
                            step: 0.02,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "swirlSpeed",
                        label: "Vortex Swirl Speed",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 2.5,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "skyIntensityA",
                        label: "Universe A Brightness",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "skyIntensityB",
                        label: "Universe B Brightness",
                        kind: ControlKind::Range {
                            min: 0.0,
                            max: 3.0,
                            step: 0.05,
                            hints: None,
                        },
                    },
                    ControlItem {
                        key: "planetVisible",
                        label: "Cosmic Landmarks",
                        kind: ControlKind::Segmented {
                            options: &[(1, "Visible"), (0, "Hidden")],
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
            "throatRadius" => self.throat_radius,
            "throatLength" => self.throat_length,
            "lensingWidth" => self.lensing_width,
            "throatGlow" => self.throat_glow,
            "dustDensity" => self.dust_density,
            "swirlSpeed" => self.swirl_speed,
            "skyIntensityA" => self.sky_intensity_a,
            "skyIntensityB" => self.sky_intensity_b,
            "exposure" => self.exposure,
            "bloomIntensity" => self.bloom_intensity,
            "anamorphicIntensity" => self.anamorphic_intensity,
            _ => 0.0,
        }
    }

    fn set_f32(&mut self, key: &str, val: f32) -> bool {
        let mut reset_primary = true;
        match key {
            "throatRadius" => self.throat_radius = val,
            "throatLength" => self.throat_length = val,
            "lensingWidth" => self.lensing_width = val,
            "throatGlow" => self.throat_glow = val,
            "dustDensity" => self.dust_density = val,
            "swirlSpeed" => self.swirl_speed = val,
            "skyIntensityA" => self.sky_intensity_a = val,
            "skyIntensityB" => self.sky_intensity_b = val,
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
            "planetVisible" => self.planet_visible,
            "quality" => self.quality,
            "resolutionScale" => (self.resolution_scale * 100.0).round() as i32,
            _ => 0,
        }
    }

    fn set_i32(&mut self, key: &str, val: i32) -> bool {
        match key {
            "metricType" => self.metric_type = val,
            "planetVisible" => self.planet_visible = val,
            "quality" => self.quality = val,
            "resolutionScale" => self.resolution_scale = (val as f32 / 100.0).clamp(0.5, 1.0),
            _ => {}
        }
        if key == "metricType" || key == "planetVisible" {
            self.active_preset = None;
        }
        true
    }

    fn format_value(&self, key: &str) -> String {
        match key {
            "throatRadius" => format!("{:.2} M", self.throat_radius),
            "throatLength" => format!("{:.2} M", self.throat_length),
            "lensingWidth" => format!("{:.2} M", self.lensing_width),
            "throatGlow" => format!("{:.2}", self.throat_glow),
            "dustDensity" => format!("{:.2}", self.dust_density),
            "swirlSpeed" => format!("{:.2}×", self.swirl_speed),
            "skyIntensityA" => format!("{:.2}", self.sky_intensity_a),
            "skyIntensityB" => format!("{:.2}", self.sky_intensity_b),
            "exposure" => format!("{:.2}", self.exposure),
            "bloomIntensity" => format!("{:.2}", self.bloom_intensity),
            "anamorphicIntensity" => format!("{:.2}", self.anamorphic_intensity),
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
        self.camera.traverse();
    }

    fn hud_metadata(
        &self,
        _assets: &SharedGpuAssets,
        fps: f32,
        sample_count: u32,
        max_samples: u32,
    ) -> HudMetadata {
        let tel = compute_wormhole_telemetry(
            self.metric_type,
            self.throat_radius as f64,
            self.throat_length as f64,
            self.lensing_width as f64,
            self.camera.l as f64,
        );
        let preset_badge = self
            .active_preset
            .and_then(|i| PRESETS.get(i))
            .map(|p| p.meta.full_name.to_string())
            .unwrap_or_else(|| "Custom".to_string());
        let side = match tel.region {
            "Universe A" => "Univ A",
            "Universe B" => "Univ B",
            other => other,
        };
        let l_sign = if tel.l > 0.004 { "+" } else { "" };
        let slope_sign = if tel.drdl > 0.0004 { "+" } else { "" };

        HudMetadata {
            brand_title: "WORMHOLE",
            preset_badge,
            secondary_badge: tel.region.to_string(),
            secondary_badge_warm: false,
            drawer_title: "PHYSICS & OPTICS",
            drawer_subtitle: format!(
                "ρ {:.2} M · θportal {:.1}°",
                tel.throat_radius, tel.apparent_throat_deg
            ),
            hint_text: "Drag to orbit · Scroll / W,S to move l · Shift-drag to look · T traverses throat · H hides HUD",
            telemetry: [
                TelemetryCell {
                    label: "PROPER DIST",
                    unit: "l/M (Side)",
                    value: format!("{}{:.2} M ({})", l_sign, tel.l, side),
                },
                TelemetryCell {
                    label: "THROAT RADIUS",
                    unit: "ρ",
                    value: format!("{:.2} M", tel.throat_radius),
                },
                TelemetryCell {
                    label: "CIRCUMF",
                    unit: "r(l)/M",
                    value: format!("{:.2} M", tel.r_of_l),
                },
                TelemetryCell {
                    label: "SLOPE",
                    unit: "dr/dl",
                    value: format!("{}{:.3}", slope_sign, tel.drdl),
                },
                TelemetryCell {
                    label: "PORTAL ANGLE",
                    unit: "θportal",
                    value: format!("{:.1}°", tel.apparent_throat_deg),
                },
                TelemetryCell {
                    label: "FRAME",
                    unit: "FPS · AA",
                    value: format!("{} · {}/{}", fps.round() as u32, sample_count, max_samples),
                },
            ],
            special_action: Some(SpecialActionUi {
                label: "Traverse",
                key_hint: "T",
                active: tel.l < 0.0,
            }),
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
        self.bind_group = assets.build_wormhole_bind_group(&self.ubo);
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
            "wormhole-raytrace",
            scene_view,
            &self.pipeline,
            &self.bind_group,
            timestamp_writes,
        );
    }
}
