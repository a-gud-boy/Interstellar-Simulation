/**
 * PulsarPhysics.js — CPU relativistic astrophysics source of truth for the
 * Magnetar & Millisecond Pulsar Simulator:
 *  - Compactness u_c = M / R_* in [0.12, 0.30] (normalized stellar radius R_* = 1.0,
 *    geometric mass M = u_c, Schwarzschild radius R_s = 2 * u_c)
 *  - Canonical 1.4 M_sun neutron star radius, equatorial spin speed beta_eq,
 *    Hartle–Thorne dimensionless spin chi, and Kerr–Schild spin parameter a = chi * M
 *  - Gravitational surface redshift z = (1 - 2 * u_c)^(-1/2) - 1
 *  - Apparent lensed radius R_app = R_* / sqrt(1 - 2 * u_c)
 *  - Exact Schwarzschild maximum visible colatitude psi_max(u_c) via singularity-free
 *    64-point midpoint quadrature and visible crust fraction f_vis > 0.5
 *  - Light cylinder radius R_LC = c * P / (2 * pi) and visual compression R_LC,vis
 *  - 3D Outgoing Kerr–Schild RK4 light deflection & capture-threshold verifier
 */

const PI = Math.PI;
const TAU = 2.0 * PI;
const DEG2RAD = PI / 180.0;
const RAD2DEG = 180.0 / PI;

export const PULSAR_CONSTANTS = Object.freeze({
  STELLAR_RADIUS_NORM: 1.0,          // Normalized stellar radius R_* = 1.0
  CANONICAL_MASS_SOLAR: 1.4,         // Canonical neutron star mass (M_sun)
  SCHWARZSCHILD_RADIUS_1_4_KM: 4.13455, // R_s = 2 G (1.4 M_sun) / c^2 in km
  C_KMS: 299792.458,                 // Speed of light in km/s
  COMPACTNESS_MIN: 0.12,             // Minimum compactness u_c = M / R_*
  COMPACTNESS_MAX: 0.30,             // Maximum compactness u_c = M / R_*
  BETA_EQ_MAX: 0.38,                 // Maximum equatorial surface velocity v/c
  CHI_MAX: 0.45,                     // Hartle–Thorne dimensionless spin cap
  SPIN_PERIOD_MIN_MS: 1.4,           // Minimum millisecond pulsar spin period (ms)
  SPIN_PERIOD_MAX_MS: 500.0,         // Maximum magnetar spin period in UI (ms)
});

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function sanitizeCompactness(compactness, lo = 0.0, hi = 0.33) {
  const num = Number(compactness);
  return Number.isFinite(num) ? clamp(num, lo, hi) : 0.21;
}

function isLensingEnabled(lensingMode) {
  if (lensingMode === undefined || lensingMode === null) return true;
  if (typeof lensingMode === 'boolean') return lensingMode;
  const num = Number(lensingMode);
  return Number.isFinite(num) ? num !== 0 : Boolean(lensingMode);
}

/**
 * Exact Schwarzschild surface gravitational redshift:
 *   z = (1 - 2 * u_c)^(-1/2) - 1
 *
 * @param {number} [compactness=0.21]
 * @returns {number}
 */
export function computeSurfaceRedshift(compactness = 0.21) {
  const u = sanitizeCompactness(compactness, 0.0, 0.33);
  return 1.0 / Math.sqrt(1.0 - 2.0 * u) - 1.0;
}

/**
 * Apparent gravitationally lensed stellar radius at infinity (in R_* = 1 units):
 *   R_app = 1 / sqrt(1 - 2 * u_c) when GR lensing is active, 1.0 in flat space.
 *
 * @param {number} [compactness=0.21]
 * @param {number|boolean} [lensingMode=1]
 * @returns {number}
 */
export function computeApparentRadius(compactness = 0.21, lensingMode = 1) {
  if (!isLensingEnabled(lensingMode)) return 1.0;
  const u = sanitizeCompactness(compactness, 0.0, 0.33);
  return 1.0 / Math.sqrt(1.0 - 2.0 * u);
}

let _cachedPsiUc = Number.NaN;
let _cachedPsiVal = 0.0;

/**
 * Exact Schwarzschild maximum visible colatitude psi_max(u_c) via singularity-free
 * 64-point midpoint quadrature on t in [0, 1] (substitution u' = 1 - t^2):
 *   psi_max(u_c) = integral_0^1 [ 2 / sqrt((2 - t^2) - 2 * u_c * (3 - 3 * t^2 + t^4)) ] dt
 *
 * Returns pi/2 in flat-space mode (lensingMode = 0).
 *
 * @param {number} [compactness=0.21]
 * @param {number|boolean} [lensingMode=1]
 * @returns {number} Maximum visible colatitude in radians
 */
export function computeMaxVisibleAngle(compactness = 0.21, lensingMode = 1) {
  if (!isLensingEnabled(lensingMode)) return PI * 0.5;
  const u = sanitizeCompactness(compactness, 0.0, 0.33);
  if (u === _cachedPsiUc) return _cachedPsiVal;

  const steps = 64;
  const dt = 1.0 / steps;
  let sum = 0.0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const t2 = t * t;
    const radicand = Math.max((2.0 - t2) - 2.0 * u * (3.0 - 3.0 * t2 + t2 * t2), 1e-12);
    sum += (2.0 / Math.sqrt(radicand)) * dt;
  }

  _cachedPsiUc = u;
  _cachedPsiVal = sum;
  return sum;
}

/**
 * Fraction of the neutron star surface visible to an observer at infinity:
 *   f_vis = (1 - cos(min(psi_max, pi))) / 2  (in GR curved mode)
 *   f_vis = 0.5                              (in flat space)
 * Guaranteed > 0.5 for u_c > 0 and reaches 1.0 when psi_max >= pi (u_c >= 0.284).
 *
 * @param {number} [compactness=0.21]
 * @param {number|boolean} [lensingMode=1]
 * @returns {number}
 */
export function computeVisibleSurfaceFraction(compactness = 0.21, lensingMode = 1) {
  if (!isLensingEnabled(lensingMode)) return 0.5;
  const psiMax = computeMaxVisibleAngle(compactness, 1);
  return 0.5 * (1.0 - Math.cos(Math.min(psiMax, PI)));
}

/**
 * Computes physical and compressed visual light-cylinder radii:
 *   R_LC,km   = c * P / (2 * pi)
 *   R_LC,norm = R_LC,km / R_km
 *   R_LC,vis  = clamp(2.8 + 1.55 * ln(1 + P_ms / 1.5), 3.4, 10.8)
 *
 * @param {number} [compactness=0.21]
 * @param {number} [spinPeriodMs=33.0]
 * @returns {{ rLightCylKm: number, rLightCylNorm: number, rLightCylVis: number }}
 */
export function computeLightCylinder(compactness = 0.21, spinPeriodMs = 33.0) {
  const u = sanitizeCompactness(compactness, 0.05, 0.33);
  const pMs = Math.max(0.1, Number.isFinite(Number(spinPeriodMs)) ? Number(spinPeriodMs) : 33.0);
  const pSec = pMs / 1000.0;

  const stellarRadiusKm = PULSAR_CONSTANTS.SCHWARZSCHILD_RADIUS_1_4_KM / (2.0 * u);
  const rLightCylKm = (PULSAR_CONSTANTS.C_KMS * pSec) / TAU;
  const rLightCylNorm = rLightCylKm / stellarRadiusKm;
  const rLightCylVis = clamp(2.8 + 1.55 * Math.log(1.0 + pMs / 1.5), 3.4, 10.8);

  return {
    rLightCylKm,
    rLightCylNorm,
    rLightCylVis,
  };
}

/**
 * Computes neutron star spin frequency, equatorial speed beta_eq, Hartle–Thorne
 * dimensionless spin chi, Kerr–Schild spin parameter a = chi * M, and visual angular rate.
 *
 * @param {number} [compactness=0.21]
 * @param {number} [spinPeriodMs=33.0]
 * @param {number} [spinVisualSpeed=1.0]
 * @returns {{ spinPeriodMs: number, spinFreqHz: number, betaEq: number, chi: number, spinA: number, omegaVis: number }}
 */
export function computeSpinParameters(compactness = 0.21, spinPeriodMs = 33.0, spinVisualSpeed = 1.0) {
  const u = sanitizeCompactness(compactness, 0.05, 0.33);
  const pMs = Math.max(0.1, Number.isFinite(Number(spinPeriodMs)) ? Number(spinPeriodMs) : 33.0);
  const visSpeed = Number.isFinite(Number(spinVisualSpeed)) ? Math.max(0.0, Number(spinVisualSpeed)) : 1.0;

  const pSec = pMs / 1000.0;
  const stellarRadiusKm = PULSAR_CONSTANTS.SCHWARZSCHILD_RADIUS_1_4_KM / (2.0 * u);

  const betaEq = clamp(
    (TAU * stellarRadiusKm) / (PULSAR_CONSTANTS.C_KMS * pSec),
    0.0,
    PULSAR_CONSTANTS.BETA_EQ_MAX
  );
  const chi = clamp((0.35 * betaEq) / u, 0.0, PULSAR_CONSTANTS.CHI_MAX);
  const spinA = chi * u;
  const spinFreqHz = 1000.0 / pMs;
  const omegaVis = visSpeed * clamp(0.45 + 0.55 * Math.log(1.0 + spinFreqHz / 10.0), 0.35, 3.2);

  return {
    spinPeriodMs: pMs,
    spinFreqHz,
    betaEq,
    chi,
    spinA,
    omegaVis,
  };
}

// ============================================================================
// CPU 3D Outgoing Kerr–Schild Null Geodesic RK4 Integrator (Explicit Mass M)
// ============================================================================

function evalKerrSchildState(x, y, z, M, a) {
  const a2 = a * a;
  const u = x * x + y * y + z * z - a2;
  const r2 = 0.5 * (u + Math.sqrt(u * u + 4.0 * a2 * y * y));
  const r = Math.sqrt(Math.max(r2, 1e-18));
  const denom = r2 + a2;
  const r4ay2 = r2 * r2 + a2 * y * y;
  const H = (M * r2 * r) / r4ay2;

  const lt = -1.0;
  const lx = (r * x + a * z) / denom;
  const ly = y / r;
  const lz = (r * z - a * x) / denom;

  const drdx = (r2 * r * x) / r4ay2;
  const drdy = (r * denom * y) / r4ay2;
  const drdz = (r2 * r * z) / r4ay2;

  const invD2Sq = 1.0 / (r4ay2 * r4ay2);
  const dHdr = M * (3.0 * r2 * r4ay2 - 4.0 * r2 * r2 * r2) * invD2Sq;
  const dHdyExplicit = (-2.0 * M * a2 * y * r2 * r) * invD2Sq;
  const dH = [dHdr * drdx, dHdr * drdy + dHdyExplicit, dHdr * drdz];

  const invD = 1.0 / denom;
  const invD2 = invD * invD;
  const dlxDr = (x * denom - 2.0 * r * (r * x + a * z)) * invD2;
  const dlyDr = -y / r2;
  const dlzDr = (z * denom - 2.0 * r * (r * z - a * x)) * invD2;

  const dl = [
    [r * invD + dlxDr * drdx, dlxDr * drdy, a * invD + dlxDr * drdz],
    [dlyDr * drdx, 1.0 / r + dlyDr * drdy, dlyDr * drdz],
    [-a * invD + dlzDr * drdx, dlzDr * drdy, r * invD + dlzDr * drdz],
  ];

  return { r, H, l: [lt, lx, ly, lz], dH, dl };
}

function initPastNullMomentum(pos, dir, M, a) {
  const { H, l } = evalKerrSchildState(pos[0], pos[1], pos[2], M, a);
  const eta = [-1.0, 1.0, 1.0, 1.0];
  const g = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      g[mu][nu] = (mu === nu ? eta[mu] : 0.0) + 2.0 * H * l[mu] * l[nu];
    }
  }

  const A = g[0][0];
  let B = 0.0;
  let C = 0.0;
  for (let i = 0; i < 3; i++) {
    B += 2.0 * g[0][i + 1] * dir[i];
    for (let j = 0; j < 3; j++) {
      C += g[i + 1][j + 1] * dir[i] * dir[j];
    }
  }
  const disc = Math.sqrt(Math.max(0.0, B * B - 4.0 * A * C));
  const kt1 = (-B + disc) / (2.0 * A);
  const kt2 = (-B - disc) / (2.0 * A);
  const kt = Math.min(kt1, kt2);
  const k = [kt, dir[0], dir[1], dir[2]];

  const p = [0.0, 0.0, 0.0, 0.0];
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      p[mu] += g[mu][nu] * k[nu];
    }
  }
  const invPt = 1.0 / p[0];
  return [p[1] * invPt, p[2] * invPt, p[3] * invPt];
}

function evalGeodesicRHS(x, p, M, a) {
  const { H, l, dH, dl } = evalKerrSchildState(x[0], x[1], x[2], M, a);
  const lp = 1.0 + l[1] * p[0] + l[2] * p[1] + l[3] * p[2];
  const dx = [
    p[0] - 2.0 * H * lp * l[1],
    p[1] - 2.0 * H * lp * l[2],
    p[2] - 2.0 * H * lp * l[3],
  ];
  const dp = [0.0, 0.0, 0.0];
  for (let i = 0; i < 3; i++) {
    const pdl = p[0] * dl[0][i] + p[1] * dl[1][i] + p[2] * dl[2][i];
    dp[i] = lp * lp * dH[i] + 2.0 * H * lp * pdl;
  }
  return { dx, dp };
}

function evalNullHamiltonianError(x, p, M, a) {
  const { H, l } = evalKerrSchildState(x[0], x[1], x[2], M, a);
  const eta = [-1.0, 1.0, 1.0, 1.0];
  const lUp = [-l[0], l[1], l[2], l[3]];
  const p4 = [1.0, p[0], p[1], p[2]];
  let ham = 0.0;
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      const gInv = (mu === nu ? eta[mu] : 0.0) - 2.0 * H * lUp[mu] * lUp[nu];
      ham += 0.5 * gInv * p4[mu] * p4[nu];
    }
  }
  return Math.abs(ham);
}

/**
 * Traces an equatorial null geodesic through the 3D Outgoing Kerr–Schild spacetime
 * with explicit geometric mass M = compactness (R_* = 1.0) using 4th-order Runge–Kutta.
 *
 * Returns deflection angle in radians (unwrapped) for escaping rays and flags for both
 * Kerr–Schild horizon capture (`captured` / `hitHorizon`, threshold 3*sqrt(3)*M when a = 0)
 * and stellar surface intersection (`hitStar` / `hitSurface`, threshold R_* / sqrt(1 - 2*u_c)).
 *
 * @param {number} impactParam Impact parameter b in R_* = 1.0 units
 * @param {number} [compactness=0.21] Geometric mass M = u_c = M / R_*
 * @param {number} [spinA=0.0] Kerr–Schild spin parameter a = chi * M
 * @param {{ camZ?: number, maxSteps?: number }} [options]
 */
export function integrateSchwarzschildDeflection(
  impactParam,
  compactness = 0.21,
  spinA = 0.0,
  options = {}
) {
  const b = Number.isFinite(Number(impactParam)) ? Number(impactParam) : 10.0;
  const M = sanitizeCompactness(compactness, 0.0, 0.33);
  const a = M > 1e-9
    ? clamp(Number.isFinite(Number(spinA)) ? Number(spinA) : 0.0, -0.998 * M, 0.998 * M)
    : 0.0;

  if (M <= 1e-9) {
    const absB = Math.abs(b);
    return {
      impactParam: b,
      compactness: 0.0,
      spinA: 0.0,
      captured: false,
      hitHorizon: false,
      hitStar: absB <= 1.0,
      hitSurface: absB <= 1.0,
      escaped: true,
      rMin: absB,
      deflectionRad: 0.0,
      deflectionDeg: 0.0,
      maxHamErr: 0.0,
      steps: 0,
    };
  }

  if (Math.abs(b) < 1e-8) {
    const rHor = M + Math.sqrt(Math.max(0.0, M * M - a * a));
    return {
      impactParam: b,
      compactness: M,
      spinA: a,
      captured: true,
      hitHorizon: true,
      hitStar: true,
      hitSurface: true,
      escaped: false,
      rMin: rHor,
      deflectionRad: null,
      deflectionDeg: null,
      maxHamErr: 0.0,
      steps: 0,
    };
  }

  const camZ = Number.isFinite(Number(options?.camZ)) ? Math.max(40.0, Number(options.camZ)) : 300.0;
  const maxSteps = Number.isFinite(Number(options?.maxSteps)) ? Math.max(500, options.maxSteps | 0) : 8000;
  const rHor = M + Math.sqrt(Math.max(0.0, M * M - a * a));

  const x = [b, 0.0, camZ];
  let p = initPastNullMomentum(x, [0.0, 0.0, -1.0], M, a);

  const d0 = evalGeodesicRHS(x, p, M, a).dx;
  const d0Len = Math.hypot(d0[0], d0[1], d0[2]) || 1.0;
  let prevDir = [d0[0] / d0Len, d0[1] / d0Len, d0[2] / d0Len];

  let accumSigned = 0.0;
  let rMin = Infinity;
  let maxHamErr = 0.0;

  for (let step = 0; step < maxSteps; step++) {
    const r = evalKerrSchildState(x[0], x[1], x[2], M, a).r;
    if (r < rMin) rMin = r;

    if (r <= rHor * 1.02) {
      return {
        impactParam: b,
        compactness: M,
        spinA: a,
        captured: true,
        hitHorizon: true,
        hitStar: true,
        hitSurface: true,
        escaped: false,
        rMin,
        deflectionRad: null,
        deflectionDeg: null,
        maxHamErr,
        steps: step,
      };
    }

    const k1 = evalGeodesicRHS(x, p, M, a);
    const outbound = x[0] * k1.dx[0] + x[1] * k1.dx[1] + x[2] * k1.dx[2] > 0.0;

    let h = Math.max(0.008 * M, Math.min(2.5, 0.06 * Math.max(r - 0.85 * rHor, 0.04)));
    if (r < 2.2) {
      h = Math.min(h, Math.max(0.004 * M, 0.03 * Math.max(r - 0.85 * rHor, 0.03)));
    }

    const x2 = [x[0] + 0.5 * h * k1.dx[0], x[1] + 0.5 * h * k1.dx[1], x[2] + 0.5 * h * k1.dx[2]];
    const p2 = [p[0] + 0.5 * h * k1.dp[0], p[1] + 0.5 * h * k1.dp[1], p[2] + 0.5 * h * k1.dp[2]];
    const k2 = evalGeodesicRHS(x2, p2, M, a);

    const x3 = [x[0] + 0.5 * h * k2.dx[0], x[1] + 0.5 * h * k2.dx[1], x[2] + 0.5 * h * k2.dx[2]];
    const p3 = [p[0] + 0.5 * h * k2.dp[0], p[1] + 0.5 * h * k2.dp[1], p[2] + 0.5 * h * k2.dp[2]];
    const k3 = evalGeodesicRHS(x3, p3, M, a);

    const x4 = [x[0] + h * k3.dx[0], x[1] + h * k3.dx[1], x[2] + h * k3.dx[2]];
    const p4 = [p[0] + h * k3.dp[0], p[1] + h * k3.dp[1], p[2] + h * k3.dp[2]];
    const k4 = evalGeodesicRHS(x4, p4, M, a);

    for (let i = 0; i < 3; i++) {
      x[i] += (h / 6.0) * (k1.dx[i] + 2.0 * k2.dx[i] + 2.0 * k3.dx[i] + k4.dx[i]);
      p[i] += (h / 6.0) * (k1.dp[i] + 2.0 * k2.dp[i] + 2.0 * k3.dp[i] + k4.dp[i]);
    }

    const nextRaw = evalGeodesicRHS(x, p, M, a).dx;
    const nextLen = Math.hypot(nextRaw[0], nextRaw[1], nextRaw[2]) || 1.0;
    const nextDir = [nextRaw[0] / nextLen, nextRaw[1] / nextLen, nextRaw[2] / nextLen];

    const crossY = prevDir[2] * nextDir[0] - prevDir[0] * nextDir[2];
    const dotDir = clamp(
      prevDir[0] * nextDir[0] + prevDir[1] * nextDir[1] + prevDir[2] * nextDir[2],
      -1.0,
      1.0
    );
    accumSigned += Math.atan2(crossY, dotDir);
    prevDir = nextDir;

    if (step % 20 === 0) {
      maxHamErr = Math.max(maxHamErr, evalNullHamiltonianError(x, p, M, a));
    }

    const rNew = Math.hypot(x[0], x[1], x[2]);
    if (rNew < rMin) rMin = rNew;

    if (rNew > camZ * 1.45 && outbound) {
      const deflectionRad = Math.abs(accumSigned);
      const hitStar = rMin <= 1.0;
      return {
        impactParam: b,
        compactness: M,
        spinA: a,
        captured: false,
        hitHorizon: false,
        hitStar,
        hitSurface: hitStar,
        escaped: true,
        rMin,
        deflectionRad,
        deflectionDeg: deflectionRad * RAD2DEG,
        maxHamErr,
        steps: step + 1,
      };
    }
  }

  return {
    impactParam: b,
    compactness: M,
    spinA: a,
    captured: true,
    hitHorizon: true,
    hitStar: true,
    hitSurface: true,
    escaped: false,
    rMin,
    deflectionRad: null,
    deflectionDeg: null,
    maxHamErr,
    steps: maxSteps,
  };
}

let _cachedTelKey0 = Number.NaN;
let _cachedTelKey1 = Number.NaN;
let _cachedTelKey2 = Number.NaN;
let _cachedTelKey3 = false;
let _cachedTelKey4 = Number.NaN;
let _cachedTelVal = null;

/**
 * Computes complete relativistic neutron star, magnetosphere, and telemetry state
 * from the active simulator state object.
 *
 * @param {object} [state]
 */
export function computePulsarTelemetry(state = {}) {
  const compactness = clamp(
    Number.isFinite(Number(state.compactness)) ? Number(state.compactness) : 0.21,
    PULSAR_CONSTANTS.COMPACTNESS_MIN,
    PULSAR_CONSTANTS.COMPACTNESS_MAX
  );
  const spinPeriodMs = Math.max(
    0.1,
    Number.isFinite(Number(state.spinPeriodMs)) ? Number(state.spinPeriodMs) : 33.0
  );
  const spinVisualSpeed = Number.isFinite(Number(state.spinVisualSpeed))
    ? Math.max(0.0, Number(state.spinVisualSpeed))
    : 1.0;

  const lensingOn = isLensingEnabled(state.lensingMode);
  const obliquityDeg = clamp(
    Number.isFinite(Number(state.obliquityDeg)) ? Number(state.obliquityDeg) : 45.0,
    0.0,
    90.0
  );

  if (
    _cachedTelVal &&
    compactness === _cachedTelKey0 &&
    spinPeriodMs === _cachedTelKey1 &&
    spinVisualSpeed === _cachedTelKey2 &&
    lensingOn === _cachedTelKey3 &&
    obliquityDeg === _cachedTelKey4
  ) {
    return _cachedTelVal;
  }

  const lensingStrength = lensingOn ? 1.0 : 0.0;
  const obliquityRad = obliquityDeg * DEG2RAD;

  const stellarRadiusKm = PULSAR_CONSTANTS.SCHWARZSCHILD_RADIUS_1_4_KM / (2.0 * compactness);
  const schwarzschildRadius = 2.0 * compactness;

  const spin = computeSpinParameters(compactness, spinPeriodMs, spinVisualSpeed);
  const lightCyl = computeLightCylinder(compactness, spinPeriodMs);
  const surfaceRedshiftZ = computeSurfaceRedshift(compactness);
  const apparentRadius = computeApparentRadius(compactness, lensingOn);
  const maxVisibleAngleRad = lensingOn ? computeMaxVisibleAngle(compactness, 1) : PI * 0.5;
  const maxVisibleAngleDeg = maxVisibleAngleRad * RAD2DEG;
  const visibleSurfaceFraction = computeVisibleSurfaceFraction(compactness, lensingOn);

  _cachedTelKey0 = compactness;
  _cachedTelKey1 = spinPeriodMs;
  _cachedTelKey2 = spinVisualSpeed;
  _cachedTelKey3 = lensingOn;
  _cachedTelKey4 = obliquityDeg;
  _cachedTelVal = {
    compactness,
    massSolar: PULSAR_CONSTANTS.CANONICAL_MASS_SOLAR,
    stellarRadiusKm,
    schwarzschildRadius,
    spinA: spin.spinA,
    chi: spin.chi,
    betaEq: spin.betaEq,
    surfaceRedshiftZ,
    apparentRadius,
    maxVisibleAngleRad,
    maxVisibleAngleDeg,
    visibleSurfaceFraction,
    rLightCylKm: lightCyl.rLightCylKm,
    rLightCylNorm: lightCyl.rLightCylNorm,
    rLightCylVis: lightCyl.rLightCylVis,
    spinPeriodMs: spin.spinPeriodMs,
    spinFreqHz: spin.spinFreqHz,
    omegaVis: spin.omegaVis,
    lensingStrength,
    obliquityRad,
  };
  return _cachedTelVal;
}
