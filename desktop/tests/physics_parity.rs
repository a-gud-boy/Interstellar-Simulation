use std::f64::consts::PI;

use interstellar_desktop::sims::binary::{
    OrbitState, compute_binary_state, eggleton_roche_radius, peters_mathews_rate, step_binary_orbit,
};
use interstellar_desktop::sims::blackhole::compute_kerr_telemetry;
use interstellar_desktop::sims::pulsar::{
    compute_apparent_radius, compute_max_visible_angle, compute_pulsar_telemetry,
    compute_surface_redshift, compute_visible_surface_fraction,
};
use interstellar_desktop::sims::starflight::{
    compute_brachistochrone_rapidity_and_coord_time, compute_starflight_telemetry,
    kinematics_from_rapidity,
};
use interstellar_desktop::sims::supernova::{
    compute_supernova_telemetry, eval_dual_hg, eval_hg, eval_sedov_taylor,
};
use interstellar_desktop::sims::warp::{compute_warp_telemetry, eval_shape, eval_warp_metric};
use interstellar_desktop::sims::wormhole::{compute_wormhole_telemetry, eval_wormhole_r};

#[test]
fn blackhole_kerr_telem_parity() {
    let schw = compute_kerr_telemetry(0.0, 20.0, 0.0);
    assert!((schw.horizon_r - 2.0).abs() < 1e-6);
    assert!((schw.isco_r - 6.0).abs() < 1e-6);
    assert!((schw.photon_prograde_r - 3.0).abs() < 1e-6);
    assert!(schw.time_dilation > 1.0);

    let ext = compute_kerr_telemetry(0.998, 20.0, 0.14);
    assert!(ext.horizon_r > 1.0 && ext.horizon_r < 1.1);
    assert!(ext.isco_r < 1.3);
    assert!(ext.orbital_velocity_c > 0.0 && ext.orbital_velocity_c < 1.0);
    assert!(ext.shadow_angular_deg > 10.0 && ext.shadow_angular_deg < 45.0);
}

#[test]
fn wormhole_metric_parity() {
    for l in [0.0_f64, 0.5, 2.0, 12.0] {
        let r_pos = eval_wormhole_r(l, 0, 2.0, 0.5, 1.0);
        let r_neg = eval_wormhole_r(-l, 0, 2.0, 0.5, 1.0);
        assert!((r_pos - r_neg).abs() < 1e-12);
        assert!(r_pos >= 2.0);
    }
    assert!((eval_wormhole_r(0.0, 1, 2.2, 0.0, 1.0) - 2.2).abs() < 1e-12);

    let tel_a = compute_wormhole_telemetry(0, 2.2, 0.6, 1.4, 15.0);
    let tel_t = compute_wormhole_telemetry(0, 2.2, 0.6, 1.4, 0.1);
    let tel_b = compute_wormhole_telemetry(0, 2.2, 0.6, 1.4, -15.0);
    assert_eq!(tel_a.region, "Universe A");
    assert_eq!(tel_t.region, "Throat");
    assert_eq!(tel_b.region, "Universe B");
    assert!(tel_a.r_of_l > tel_t.r_of_l);
}

#[test]
fn binary_bh_inspiral_parity() {
    let r1 = eggleton_roche_radius(10.0, 0.5, 0.5);
    assert!((r1 - 3.79).abs() < 0.15);
    assert!(peters_mathews_rate(10.0, 0.25) < 0.0);

    let st = compute_binary_state(1.0, 12.0, 0.5);
    assert!((st.eta - 0.25).abs() < 1e-12);
    assert!(st.omega > 0.0 && st.v_orbital_c < 1.0);
    assert!(st.time_to_merger_m > 0.0);

    let mut orb = OrbitState {
        current_sep: 12.0,
        phase: 0.0,
        in_ringdown: false,
        ringdown_timer: 0.0,
        ringdown_factor: 0.0,
    };
    for _ in 0..100 {
        step_binary_orbit(&mut orb, 1.0, 12.0, 1, 1.0, 0.05);
    }
    assert!(
        orb.current_sep < 12.0,
        "2.5PN inspiral must shrink separation"
    );
    assert!(orb.phase.is_finite());
}

#[test]
fn warp_drive_metric_parity() {
    let core = eval_shape(0.0, 2.0, 3.0);
    let outside = eval_shape(12.0, 2.0, 3.0);
    assert!((core.f - 1.0).abs() < 1e-4);
    assert!(outside.f < 1e-4);

    let alc = eval_warp_metric([2.0, 0.0, 0.8], 0, 2.0, 3.0, 2.5, 1.0);
    let nat = eval_warp_metric([2.0, 0.0, 0.8], 1, 2.0, 3.0, 2.5, 1.0);
    let len = eval_warp_metric([2.0, 0.0, 0.8], 2, 2.0, 3.0, 2.5, 1.0);
    assert!(alc.theta.abs() > 0.0);
    assert!(alc.t00 < 0.0);
    assert!(
        (nat.theta - 0.0).abs() < 1e-12,
        "Natario metric is expansion-free"
    );
    assert!(nat.t00.is_finite() && len.t00.is_finite());

    let tel = compute_warp_telemetry(0, 2.0, 3.0, 2.5);
    assert_eq!(tel.metric_label, "Alcubierre");
    assert!(tel.has_horizon);
    assert!(tel.peak_york > 0.0);
}

#[test]
fn supernova_sedov_and_hg_parity() {
    let e_breakout = eval_sedov_taylor(0.002);
    assert_eq!(e_breakout.regime_label, "Shock Breakout");
    assert!(e_breakout.shock_radius_ly > 0.0 && e_breakout.shock_radius_ly < 0.01);

    let e_early = eval_sedov_taylor(20_000.0);
    let e_late = eval_sedov_taylor(640_000.0);
    // Deep in Sedov-Taylor regime, R ~ t^(2/5), so 32^(2/5) = 4.0
    let ratio = e_late.shock_radius_ly / e_early.shock_radius_ly;
    assert!(
        (ratio - 4.0).abs() < 0.25,
        "unexpected expansion ratio: {ratio}"
    );
    assert!(e_early.expansion_velocity_kms > e_late.expansion_velocity_kms);

    assert!(eval_hg(1.0, 0.65) > eval_hg(-1.0, 0.65));
    assert!(eval_dual_hg(1.0, 0.65) > eval_dual_hg(0.0, 0.65));

    let tel = compute_supernova_telemetry(972.0, 1.0, 1.0, 1.0, 1.0, 1.2, 1.0, 2);
    assert_eq!(tel.palette_label, "Chandra / JWST");
    assert!(tel.optical_depth > 0.0);
    assert!(tel.central_temp_k > 1000.0);
}

#[test]
fn pulsar_gr_lightbending_parity() {
    let z = compute_surface_redshift(0.21);
    assert!((z - ((1.0 / (1.0 - 0.42_f64).sqrt()) - 1.0)).abs() < 1e-9);
    assert!((compute_apparent_radius(0.21, true) - 1.0 / 0.58_f64.sqrt()).abs() < 1e-9);
    assert!((compute_apparent_radius(0.21, false) - 1.0).abs() < 1e-12);

    let psi_gr = compute_max_visible_angle(0.21, true);
    let psi_flat = compute_max_visible_angle(0.21, false);
    assert!(psi_gr > PI * 0.5);
    assert!((psi_flat - PI * 0.5).abs() < 1e-12);
    assert!(compute_visible_surface_fraction(0.21, true) > 0.5);
    assert!((compute_visible_surface_fraction(0.21, false) - 0.5).abs() < 1e-12);

    let tel = compute_pulsar_telemetry(0.21, 33.0, 1.0, 1, 45.0);
    assert!((tel.spin_freq_hz - (1000.0 / 33.0)).abs() < 1e-9);
    assert!(tel.omega_vis > 0.0);
}

#[test]
fn starflight_cancellation_free_sr_parity() {
    let k = kinematics_from_rapidity(7.65);
    let expected_one_minus_beta = (-7.65_f64).exp() / 7.65_f64.cosh();
    assert!((k.one_minus_beta - expected_one_minus_beta).abs() < 1e-14);
    assert!(k.gamma > 1000.0);
    assert!(k.doppler_fwd > 2000.0);

    let (eta_b, coord_t, phase) = compute_brachistochrone_rapidity_and_coord_time(1.35, 1.0);
    assert!(eta_b > 0.0 && coord_t > 1.35);
    assert_eq!(phase, "accel");

    let tel = compute_starflight_telemetry(0, 1.472219, 1.0, 0.0, 1, 1.0);
    assert!((tel.true_beta - 1.472219_f64.tanh()).abs() < 1e-7);
    assert!(tel.cmb_peak_temp_k > 2.7255);
}
