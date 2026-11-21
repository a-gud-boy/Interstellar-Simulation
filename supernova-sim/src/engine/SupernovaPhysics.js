/**
 * SupernovaPhysics.js — CPU astrophysical source of truth for the Volumetric
 * Multi-Scattering Supernova Remnant & Nebula Simulator:
 *  - Sedov–Taylor self-similar blast wave (R_sh = xi_0 * (E t^2 / rho_0)^(1/5))
 *    smoothly joined to young free-expansion ejecta kinematics (v_ej = sqrt(2E/M_ej))
 *  - Analytical shock velocity v_sh = dR_sh/dt and Rankine–Hugoniot post-shock temp
 *  - Normalized dual-lobe Henyey–Greenstein phase function (singularity-safe)
 *  - Wrenninge 4-octave multiple scattering evaluator for optically thick dust/Bok knots
 *  - Multi-species radial ionization / dust density profiles, optical depth tau, & telemetry
 */

const PI = Math.PI;
const INV_4_PI = 1.0 / (4.0 * PI);

export const SEDOV_CONSTANTS = Object.freeze({
  XI_0: 1.1517,                      // Sedov-Taylor dimensionless constant for adiabatic gamma = 5/3
  E0_ERG: 1.0e51,                    // Canonical Type II / PWN supernova explosion energy (1 foe)
  M_H_G: 1.6735575e-24,              // Hydrogen atomic mass (g)
  MU_ISM: 1.4,                       // Mean molecular weight per H atom in neutral ISM
  MU_IONIZED: 0.61,                  // Mean molecular weight of fully ionized cosmic plasma
  N0_ISM: 1.0,                       // Ambient ISM hydrogen number density (cm^-3)
  RHO0_CGS: 1.0 * 1.4 * 1.6735575e-24,
  M_SUN_G: 1.98847e33,               // Solar mass (g)
  M_EJ_G: 3.0 * 1.98847e33,          // Ejecta mass (3 M_sun)
  V_EJ_CMS: Math.sqrt((2.0 * 1.0e51) / (3.0 * 1.98847e33)), // ~5790 km/s free-expansion velocity
  LY_CM: 9.4607304725808e17,         // Light-year in cm
  YR_S: 31557600.0,                  // Julian year in seconds
  K_B: 1.380649e-16,                 // Boltzmann constant (erg / K)
});

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

function gaussian(x, center, width) {
  const u = (x - center) / Math.max(width, 1e-4);
  return Math.exp(-Math.min(u * u, 40.0));
}

/**
 * Evaluates Sedov–Taylor self-similar blast-wave kinematics smoothly transitioned from
 * early free-expansion ejecta:
 *   R_free(t) = v_ej * t
 *   R_ST(t)   = xi_0 * (E * t^2 / rho_0)^(1/5)
 *   R_sh(t)   = (R_free * R_ST) / sqrt(R_free^2 + R_ST^2)
 *   v_sh(t)   = dR_sh/dt = (R_sh / t) * (R_ST^2 + 0.4 * R_free^2) / (R_free^2 + R_ST^2)
 *
 * @param {number} ageYears Remnant age in years
 * @param {{ energyScale?: number, densityScale?: number }} [opts]
 */
export function evalSedovTaylor(ageYears = 970.0, opts = {}) {
  const ageYr = Math.max(1.0, Number.isFinite(Number(ageYears)) ? Number(ageYears) : 970.0);
  const energyScale = clamp(Number.isFinite(Number(opts.energyScale)) ? Number(opts.energyScale) : 1.0, 0.1, 10.0);
  const densityScale = clamp(Number.isFinite(Number(opts.densityScale)) ? Number(opts.densityScale) : 1.0, 0.1, 10.0);

  const tSec = ageYr * SEDOV_CONSTANTS.YR_S;
  const energy = SEDOV_CONSTANTS.E0_ERG * energyScale;
  const rho0 = SEDOV_CONSTANTS.RHO0_CGS * densityScale;
  const vEj = SEDOV_CONSTANTS.V_EJ_CMS * Math.sqrt(energyScale);

  const rFree = vEj * tSec;
  const rST = SEDOV_CONSTANTS.XI_0 * Math.pow((energy * tSec * tSec) / rho0, 0.2);

  const rFree2 = rFree * rFree;
  const rST2 = rST * rST;
  const denom2 = Math.max(rFree2 + rST2, 1e-30);
  const rShockCm = (rFree * rST) / Math.sqrt(denom2);

  // Exact analytical derivative v_sh = dR_sh/dt
  const vShockCms = (rShockCm / tSec) * ((rST2 + 0.4 * rFree2) / denom2);

  const shockRadiusLy = rShockCm / SEDOV_CONSTANTS.LY_CM;
  const expansionVelocityKms = vShockCms / 1.0e5;

  // Rankine–Hugoniot strong-shock post-shock ion/electron mean temperature (gamma = 5/3)
  const shockTempK =
    (3.0 / 16.0) * ((SEDOV_CONSTANTS.MU_IONIZED * SEDOV_CONSTANTS.M_H_G) / SEDOV_CONSTANTS.K_B) * vShockCms * vShockCms;

  // Visual world-space radius scaled gently across [2.2, 5.4] so presets stay well-framed
  const worldShockRadius = clamp(1.42 * Math.pow(Math.max(shockRadiusLy, 0.05), 0.34), 2.2, 5.4);
  const shockAgeNorm = clamp(Math.log(ageYr / 150.0) / Math.log(18000.0 / 150.0), 0.0, 1.0);

  const ratio = rFree / Math.max(rST, 1.0);
  let regimeLabel = 'Sedov–Taylor';
  if (ratio < 0.65) {
    regimeLabel = 'Free Expansion';
  } else if (ratio < 1.65) {
    regimeLabel = 'Transition';
  }

  return {
    ageYears: ageYr,
    shockRadiusCm: rShockCm,
    shockRadiusLy,
    expansionVelocityCms: vShockCms,
    expansionVelocityKms,
    shockTempK,
    freeRadiusLy: rFree / SEDOV_CONSTANTS.LY_CM,
    sedovRadiusLy: rST / SEDOV_CONSTANTS.LY_CM,
    worldShockRadius,
    shockAgeNorm,
    regimeLabel,
  };
}

/**
 * Single-lobe normalized Henyey–Greenstein phase function with strict singularity guard:
 *   Phi(mu, g) = (1 - g^2) / (4 * pi * (1 + g^2 - 2*g*mu)^(3/2))
 * Integral over 4*pi steradians equals 1.0 identically for all g in [-0.95, 0.95].
 *
 * @param {number} cosTheta Cosine of scattering angle (viewDir . lightDir)
 * @param {number} g Anisotropy parameter in [-0.95, 0.95]
 * @returns {number}
 */
export function evalHG(cosTheta, g = 0.0) {
  const gc = clamp(Number.isFinite(Number(g)) ? Number(g) : 0.0, -0.95, 0.95);
  const mu = clamp(Number.isFinite(Number(cosTheta)) ? Number(cosTheta) : 0.0, -1.0, 1.0);
  const denom = Math.max(1.0 + gc * gc - 2.0 * gc * mu, 1e-4);
  return ((1.0 - gc * gc) * INV_4_PI) / (denom * Math.sqrt(denom));
}

/**
 * Normalized dual-lobe Henyey–Greenstein phase function combining primary forward peak
 * with a gentle backscatter/isotropic secondary lobe (weights sum to 1.0):
 *   Phi_dual(mu, g) = 0.82 * Phi_HG(mu, g1) + 0.18 * Phi_HG(mu, g2)
 *
 * @param {number} cosTheta
 * @param {number} g
 * @returns {number}
 */
export function evalDualHG(cosTheta, g = 0.58) {
  const g1 = clamp(Number.isFinite(Number(g)) ? Number(g) : 0.0, -0.95, 0.95);
  const g2 = clamp(-0.35 * g1, -0.55, 0.55);
  return 0.82 * evalHG(cosTheta, g1) + 0.18 * evalHG(cosTheta, g2);
}

/**
 * Wrenninge multi-octave multiple-scattering approximation (4 octaves):
 *   L_ms(tau_s, mu, g) = sum_{n=0}^{3} a^n * exp(-b^n * tau_s) * Phi_dual(mu, c^n * g)
 * Matches the GLSL and WGSL shader implementation identically.
 *
 * @param {number} tauShadow Optical depth along ray to central illuminator (>= 0)
 * @param {number} cosTheta Scattering angle cosine
 * @param {number} g Forward-scattering anisotropy
 * @returns {number}
 */
export function evalWrenningeMultiScatter(tauShadow, cosTheta, g = 0.58) {
  const tau = Math.max(0.0, Number.isFinite(Number(tauShadow)) ? Number(tauShadow) : 0.0);
  const gc = clamp(Number.isFinite(Number(g)) ? Number(g) : 0.0, -0.95, 0.95);

  const a = 0.55;
  const b = 0.48;
  const c = 0.65;

  let sum = 0.0;
  let aPow = 1.0;
  let bPow = 1.0;
  let cPow = 1.0;

  for (let oct = 0; oct < 4; oct++) {
    const extAtten = Math.exp(-Math.min(bPow * tau, 40.0));
    sum += aPow * extAtten * evalDualHG(cosTheta, gc * cPow);
    aPow *= a;
    bPow *= b;
    cPow *= c;
  }

  return sum;
}

/**
 * Evaluates mean radial profiles of the layered supernova remnant zones at normalized
 * radius rNorm = r / R_shock >= 0.
 *
 * @param {number} rNorm
 * @param {object} [state]
 */
export function evalSpeciesProfile(rNorm, state = {}) {
  const u = Math.max(0.0, Number.isFinite(Number(rNorm)) ? Number(rNorm) : 0.0);
  const dustOpacity = clamp(Number(state.dustOpacity ?? 0.72), 0.0, 3.0);
  const bokDensity = clamp(Number(state.bokDensity ?? 0.55), 0.0, 2.5);
  const cavityGlow = clamp(Number(state.cavityGlow ?? 1.25), 0.0, 3.0);
  const shellThickness = clamp(Number(state.shellThickness ?? 1.0), 0.3, 2.5);
  const emissionGain = clamp(Number(state.emissionGain ?? 1.15), 0.1, 3.0);

  const pwnCavity =
    smoothstep(0.03, 0.14, u) * (1.0 - smoothstep(0.36, 0.64, u)) * cavityGlow;
  const oiiiShell = gaussian(u, 0.72, 0.21 * shellThickness);
  const hAlphaShell = gaussian(u, 0.96, 0.15 * shellThickness);
  const siiRidge = gaussian(u, 1.09, 0.11 * shellThickness);

  const dustBand =
    smoothstep(0.76, 1.04, u) * (1.0 - smoothstep(1.34, 1.66, u));
  const dustEnvelope = dustBand * dustOpacity;
  const bokBand =
    smoothstep(0.86, 1.06, u) * (1.0 - smoothstep(1.32, 1.58, u));
  const bokEnvelope = bokBand * dustOpacity * bokDensity;

  // Effective radial extinction & scattering coefficients matching mean shader density
  const gasDensity =
    (0.18 * pwnCavity + 0.55 * oiiiShell + 0.95 * hAlphaShell + 0.65 * siiRidge) *
    emissionGain;
  const sigmaScat = 0.08 * gasDensity + 0.52 * dustEnvelope + 0.42 * bokEnvelope;
  const sigmaAbs = 0.02 * gasDensity + 0.26 * dustEnvelope + 0.48 * bokEnvelope;
  const sigmaExt = sigmaScat + sigmaAbs;

  return {
    pwnCavity,
    oiiiShell,
    hAlphaShell,
    siiRidge,
    dustEnvelope,
    bokEnvelope,
    sigmaScat,
    sigmaAbs,
    sigmaExt,
  };
}

/**
 * Integrates mean radial extinction from the central remnant core (r = 0) through the outer
 * dust boundary (r = 1.68 * R_shock) to estimate characteristic optical depth tau and transmittance.
 *
 * @param {object} [state]
 * @returns {{ opticalDepth: number, transmittance: number }}
 */
export function estimateOpticalDepth(state = {}) {
  const st = evalSedovTaylor(state.shockAge);
  const rMax = st.worldShockRadius * 1.68;
  const steps = 64;
  const dr = rMax / steps;

  let opticalDepth = 0.0;
  for (let i = 0; i < steps; i++) {
    const r = (i + 0.5) * dr;
    const rNorm = r / Math.max(st.worldShockRadius, 1e-4);
    const prof = evalSpeciesProfile(rNorm, state);
    opticalDepth += prof.sigmaExt * dr;
  }

  const transmittance = Math.exp(-Math.min(opticalDepth, 40.0));
  return { opticalDepth, transmittance };
}

/**
 * Computes live HUD and shader telemetry from current simulator state.
 *
 * @param {object} [state]
 * @returns {{
 *   shockRadiusLy: number,
 *   expansionVelocityKms: number,
 *   opticalDepth: number,
 *   transmittance: number,
 *   centralTempK: number,
 *   shockTempK: number,
 *   worldShockRadius: number,
 *   shockAgeNorm: number,
 *   regimeLabel: string,
 *   paletteLabel: string
 * }}
 */
export function computeSupernovaTelemetry(state = {}) {
  const st = evalSedovTaylor(state.shockAge);
  const { opticalDepth, transmittance } = estimateOpticalDepth(state);

  const starLuminosity = clamp(Number(state.starLuminosity ?? 1.4), 0.05, 5.0);
  const centralTempK =
    125000.0 *
    Math.pow(1000.0 / Math.max(st.ageYears, 50.0), 0.28) *
    Math.pow(starLuminosity, 0.25);

  const paletteMode = (Number(state.paletteMode) | 0) === 1 ? 1 : 0;

  return {
    shockRadiusLy: st.shockRadiusLy,
    expansionVelocityKms: st.expansionVelocityKms,
    opticalDepth,
    transmittance,
    centralTempK,
    shockTempK: st.shockTempK,
    worldShockRadius: st.worldShockRadius,
    shockAgeNorm: st.shockAgeNorm,
    regimeLabel: st.regimeLabel,
    paletteLabel: paletteMode === 1 ? 'True Color' : 'Hubble SHO',
  };
}
