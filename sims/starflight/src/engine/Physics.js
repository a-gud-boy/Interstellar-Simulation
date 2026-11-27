/**
 * StarflightPhysics.js — Exact float64 Special Relativity source of truth for the
 * Relativistic Starflight Simulator:
 *  - Cancellation-free rapidity kinematics: beta = tanh(eta), gamma = cosh(eta),
 *    1 - beta = exp(-eta) / cosh(eta) (accurate past gamma ~ 1000 without subtractive loss)
 *  - Relativistic aberration & Doppler factor transforms (aberrateShipToRest & exact inverse
 *    aberrateRestToShip) using cancellation-free half-sphere identities
 *  - Constant proper-acceleration rocket equations (tau, t, x) & symmetric cyclic
 *    1g brachistochrone cruise integration
 *  - Unified HUD / UBO telemetry computation with continuous visual corridor cruise speed
 */

const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

export const STARFLIGHT_CONSTANTS = Object.freeze({
  C_MS: 299792458.0,
  G0_MS2: 9.80665,
  SECONDS_PER_YEAR: 31557600.0,
  ACCEL_1G_PER_YR: (9.80665 * 31557600.0) / 299792458.0,
  T_CMB_K: 2.7255,
  MIN_RAPIDITY: 0.0,
  MAX_RAPIDITY: 7.65,
  BRACHISTOCHRONE_HALF_TAU_BASE_YR: 3.2,
});

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeVec3(dir, fallback = [0.0, 0.0, 1.0]) {
  if (!Array.isArray(dir) || dir.length < 3) {
    return [...fallback];
  }
  const dx = Number(dir[0]);
  const dy = Number(dir[1]);
  const dz = Number(dir[2]);
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len <= 0.0) {
    return [...fallback];
  }
  const invLen = 1.0 / len;
  return [dx * invLen, dy * invLen, dz * invLen];
}

/**
 * Converts coordinate speed beta = v/c in [0, 1 - 1e-12] to rapidity eta = atanh(beta).
 * @param {number} beta
 * @returns {number}
 */
export function rapidityFromBeta(beta) {
  const b = clamp(Number.isFinite(Number(beta)) ? Number(beta) : 0.0, 0.0, 1.0 - 1e-12);
  return Math.atanh(b);
}

/**
 * Computes exact, cancellation-free Special Relativity kinematics from rapidity eta in [0, 7.65].
 * @param {number} rapidity
 */
export function kinematicsFromRapidity(rapidity = 0.0) {
  const eta = clamp(
    Number.isFinite(Number(rapidity)) ? Number(rapidity) : 0.0,
    STARFLIGHT_CONSTANTS.MIN_RAPIDITY,
    STARFLIGHT_CONSTANTS.MAX_RAPIDITY
  );
  const beta = Math.tanh(eta);
  const gamma = Math.cosh(eta);
  const gammaBeta = Math.sinh(eta);
  // Cancellation-free 1 - beta = (cosh(eta) - sinh(eta)) / cosh(eta) = exp(-eta) / cosh(eta)
  const oneMinusBeta = Math.exp(-eta) / gamma;
  const dopplerFwd = Math.exp(eta);
  const dopplerAft = Math.exp(-eta);
  const zeroShiftCosThetaPrime = Math.tanh(0.5 * eta);
  const zeroShiftAngleDeg = Math.acos(clamp(zeroShiftCosThetaPrime, -1.0, 1.0)) * RAD2DEG;
  const headlightHalfAngleDeg = Math.acos(clamp(beta, -1.0, 1.0)) * RAD2DEG;
  const terrellRotationDeg = Math.asin(clamp(beta, -1.0, 1.0)) * RAD2DEG;
  const timeDilationRate = gamma;
  const cmbPeakTempK = STARFLIGHT_CONSTANTS.T_CMB_K * dopplerFwd;

  return {
    rapidity: eta,
    beta,
    gamma,
    gammaBeta,
    oneMinusBeta,
    dopplerFwd,
    dopplerAft,
    zeroShiftCosThetaPrime,
    zeroShiftAngleDeg,
    headlightHalfAngleDeg,
    terrellRotationDeg,
    timeDilationRate,
    cmbPeakTempK,
  };
}

/**
 * Aberrates a ship-frame viewing direction `dirShip` into the cosmic rest-frame direction
 * `dirRest` and computes the relativistic Doppler factor D = nu_ship / nu_rest.
 * Uses cancellation-free algebra in the forward hemisphere so accuracy holds past gamma ~ 1000.
 *
 * @param {[number, number, number]} dirShip
 * @param {number} rapidity
 * @param {number} [flightDir=1] +1 for +Z cruise, -1 for -Z reverse
 * @returns {{
 *   dirRest: [number, number, number],
 *   doppler: number,
 *   cosThetaPrime: number,
 *   cosThetaRest: number
 * }}
 */
export function aberrateShipToRest(dirShip, rapidity = 0.0, flightDir = 1) {
  const s = Number(flightDir) >= 0 ? 1.0 : -1.0;
  const [nx, ny, nz] = normalizeVec3(dirShip, [0.0, 0.0, s]);
  const { beta, gamma, oneMinusBeta } = kinematicsFromRapidity(rapidity);

  const muP = s * nz;
  const oneMinusMuP = muP >= 0.0 ? (nx * nx + ny * ny) / (1.0 + muP) : 1.0 - muP;
  const denom = muP >= 0.0 ? oneMinusBeta + beta * oneMinusMuP : 1.0 - beta * muP;
  const muRest = (muP >= 0.0 ? oneMinusBeta - oneMinusMuP : muP - beta) / denom;
  const perpScale = 1.0 / (gamma * denom);

  return {
    dirRest: [nx * perpScale, ny * perpScale, s * muRest],
    doppler: perpScale,
    cosThetaPrime: muP,
    cosThetaRest: muRest,
  };
}

/**
 * Exact inverse of `aberrateShipToRest`: transforms rest-frame direction `dirRest`
 * into ship-frame viewing direction `dirShip` using cancellation-free algebra in both hemispheres.
 *
 * @param {[number, number, number]} dirRest
 * @param {number} rapidity
 * @param {number} [flightDir=1]
 * @returns {{
 *   dirShip: [number, number, number],
 *   doppler: number,
 *   cosThetaPrime: number,
 *   cosThetaRest: number
 * }}
 */
export function aberrateRestToShip(dirRest, rapidity = 0.0, flightDir = 1) {
  const s = Number(flightDir) >= 0 ? 1.0 : -1.0;
  const [rx, ry, rz] = normalizeVec3(dirRest, [0.0, 0.0, s]);
  const { beta, gamma, oneMinusBeta } = kinematicsFromRapidity(rapidity);

  const muRest = s * rz;
  const onePlusMuRest = muRest <= 0.0 ? (rx * rx + ry * ry) / (1.0 - muRest) : 1.0 + muRest;
  const denomShip = muRest <= 0.0 ? oneMinusBeta + beta * onePlusMuRest : 1.0 + beta * muRest;
  const muP = (muRest <= 0.0 ? onePlusMuRest - oneMinusBeta : muRest + beta) / denomShip;
  const perpScale = 1.0 / (gamma * denomShip);
  const doppler = gamma * denomShip;

  return {
    dirShip: [rx * perpScale, ry * perpScale, s * muP],
    doppler,
    cosThetaPrime: muP,
    cosThetaRest: muRest,
  };
}

/**
 * Evaluates the relativistic rocket equations under constant proper acceleration `accelG` (in g0).
 * @param {number} properTimeYr
 * @param {number} [accelG=1.0]
 */
export function computeConstantAccelAtProperTime(properTimeYr, accelG = 1.0) {
  const tau = Number.isFinite(Number(properTimeYr)) ? Number(properTimeYr) : 0.0;
  const safeAccel = Number.isFinite(Number(accelG)) ? Math.max(0.0, Number(accelG)) : 1.0;
  const alpha = safeAccel * STARFLIGHT_CONSTANTS.ACCEL_1G_PER_YR;
  const eta = alpha * tau;

  const coordTimeYr = alpha > 1e-9 ? Math.sinh(eta) / alpha : tau;
  const distanceLy = alpha > 1e-9 ? (Math.cosh(eta) - 1.0) / alpha : 0.0;
  const properTimeCheckYr = alpha > 1e-9 ? Math.asinh(alpha * coordTimeYr) / alpha : tau;

  return {
    properTimeYr: tau,
    accelG: safeAccel,
    alpha,
    rapidity: eta,
    gamma: Math.cosh(eta),
    beta: Math.tanh(eta),
    coordTimeYr,
    distanceLy,
    properTimeCheckYr,
  };
}

/**
 * Evaluates a symmetric cyclic relativistic brachistochrone trajectory (accelerate for `halfTau`,
 * flip & decelerate for `halfTau`), accumulating monotonic coordinate time and distance across legs.
 *
 * @param {number} properTimeYr
 * @param {number} [accelG=1.0]
 * @param {number} [halfTauYr]
 */
export function computeBrachistochroneState(properTimeYr, accelG = 1.0, halfTauYr = undefined) {
  const tau = Number.isFinite(Number(properTimeYr)) ? Math.max(0.0, Number(properTimeYr)) : 0.0;
  const safeAccel = Math.max(Number(accelG) || 1.0, 0.05);
  const halfTau = Math.max(
    Number(halfTauYr) || STARFLIGHT_CONSTANTS.BRACHISTOCHRONE_HALF_TAU_BASE_YR / safeAccel,
    0.25
  );
  const alpha = safeAccel * STARFLIGHT_CONSTANTS.ACCEL_1G_PER_YR;
  const period = 2.0 * halfTau;
  const tauMod = ((tau % period) + period) % period;

  const integrateHalfLeg = (dur) => {
    const d = Math.max(0.0, dur);
    const tauCap = STARFLIGHT_CONSTANTS.MAX_RAPIDITY / alpha;
    if (d <= tauCap) {
      const eta = alpha * d;
      return {
        t: Math.sinh(eta) / alpha,
        x: (Math.cosh(eta) - 1.0) / alpha,
      };
    }
    const etaMax = STARFLIGHT_CONSTANTS.MAX_RAPIDITY;
    const coast = d - tauCap;
    return {
      t: Math.sinh(etaMax) / alpha + Math.cosh(etaMax) * coast,
      x: (Math.cosh(etaMax) - 1.0) / alpha + Math.sinh(etaMax) * coast,
    };
  };

  const fullHalf = integrateHalfLeg(halfTau);

  if (tau <= 0.0) {
    return {
      properTimeYr: 0.0,
      accelG: safeAccel,
      alpha,
      halfTauYr: halfTau,
      periodYr: period,
      tauMod: 0.0,
      tauLeg: 0.0,
      phase: 'accel',
      rapidity: 0.0,
      coordTimeYr: 0.0,
      distanceLy: 0.0,
      halfCoordTimeYr: fullHalf.t,
      halfDistanceLy: fullHalf.x,
    };
  }

  const nFullHalf = Math.floor(tau / halfTau);
  const tauInHalf = Math.max(0.0, tau - nFullHalf * halfTau);
  const isOddHalf = (nFullHalf % 2) === 1;

  let phase;
  let tauLeg;
  let partialT;
  let partialX;

  if (tauInHalf === 0.0 && isOddHalf) {
    // Exact turnaround peak tau = (2k + 1) * halfTau
    phase = 'accel';
    tauLeg = halfTau;
    partialT = 0.0;
    partialX = 0.0;
  } else if (isOddHalf) {
    phase = 'decel';
    tauLeg = Math.max(0.0, halfTau - tauInHalf);
    const rem = integrateHalfLeg(tauLeg);
    partialT = fullHalf.t - rem.t;
    partialX = fullHalf.x - rem.x;
  } else {
    phase = 'accel';
    tauLeg = tauInHalf;
    const prog = integrateHalfLeg(tauLeg);
    partialT = prog.t;
    partialX = prog.x;
  }

  const rapidity = Math.min(STARFLIGHT_CONSTANTS.MAX_RAPIDITY, alpha * tauLeg);
  const coordTimeYr = nFullHalf * fullHalf.t + partialT;
  const distanceLy = nFullHalf * fullHalf.x + partialX;

  return {
    properTimeYr: tau,
    accelG: safeAccel,
    alpha,
    halfTauYr: halfTau,
    periodYr: period,
    tauMod,
    tauLeg,
    phase,
    rapidity,
    coordTimeYr,
    distanceLy,
    halfCoordTimeYr: fullHalf.t,
    halfDistanceLy: fullHalf.x,
  };
}

/**
 * Computes complete relativistic telemetry and UBO-ready quantities from simulator state.
 * @param {object} [state]
 */
export function computeStarflightTelemetry(state = {}) {
  const flightMode = (Number(state?.flightMode) | 0) === 1 ? 1 : 0;
  const flightDir = Number(state?.flightDir) < 0 ? -1 : 1;
  const aberrationMode =
    state?.aberrationMode === undefined
      ? 1
      : Number(state.aberrationMode) === 0 || state.aberrationMode === false
        ? 0
        : 1;
  const aberrationStrength = aberrationMode === 1 ? 1.0 : 0.0;

  const rawAccel = Number(state?.properAccelG);
  const properAccelG = clamp(Number.isFinite(rawAccel) ? rawAccel : 1.0, 0.05, 20.0);
  const properTimeYr = Number.isFinite(Number(state?.properTimeYr))
    ? Math.max(0.0, Number(state.properTimeYr))
    : 0.0;

  let rapidity;
  let coordTimeYr;
  let distanceLy;
  let phase;
  let halfTauYr = null;

  if (flightMode === 1) {
    const brach = computeBrachistochroneState(properTimeYr, properAccelG, state?.halfTauYr);
    rapidity = brach.rapidity;
    coordTimeYr = brach.coordTimeYr;
    distanceLy = brach.distanceLy;
    phase = brach.phase;
    halfTauYr = brach.halfTauYr;
  } else {
    rapidity = clamp(
      Number.isFinite(Number(state?.rapidity)) ? Number(state.rapidity) : 1.472219,
      STARFLIGHT_CONSTANTS.MIN_RAPIDITY,
      STARFLIGHT_CONSTANTS.MAX_RAPIDITY
    );
    const gammaCruise = Math.cosh(rapidity);
    const gammaBetaCruise = Math.sinh(rapidity);
    coordTimeYr = properTimeYr * gammaCruise;
    distanceLy = properTimeYr * gammaBetaCruise;
    phase = 'cruise';
  }

  const effectiveRapidity = aberrationMode === 1 ? rapidity : 0.0;
  const kin = kinematicsFromRapidity(effectiveRapidity);
  const trueKin = kinematicsFromRapidity(rapidity);

  const visualPace = 1.6 + (11.5 * Math.min(trueKin.rapidity, 3.5)) / 3.5 + 0.8 * trueKin.beta;
  const cmbTempScale = Number.isFinite(Number(state?.cmbTempScale))
    ? Math.max(0.1, Number(state.cmbTempScale))
    : 1.0;

  return {
    ...kin,
    cmbPeakTempK: STARFLIGHT_CONSTANTS.T_CMB_K * cmbTempScale * kin.dopplerFwd,
    rapidity: trueKin.rapidity,
    effectiveRapidity: kin.rapidity,
    trueBeta: trueKin.beta,
    trueGamma: trueKin.gamma,
    trueGammaBeta: trueKin.gammaBeta,
    trueOneMinusBeta: trueKin.oneMinusBeta,
    trueDopplerFwd: trueKin.dopplerFwd,
    trueDopplerAft: trueKin.dopplerAft,
    trueZeroShiftCosThetaPrime: trueKin.zeroShiftCosThetaPrime,
    trueZeroShiftAngleDeg: trueKin.zeroShiftAngleDeg,
    trueHeadlightHalfAngleDeg: trueKin.headlightHalfAngleDeg,
    trueTerrellRotationDeg: trueKin.terrellRotationDeg,
    trueTimeDilationRate: trueKin.timeDilationRate,
    trueCmbPeakTempK: STARFLIGHT_CONSTANTS.T_CMB_K * cmbTempScale * trueKin.dopplerFwd,
    flightMode,
    flightDir,
    aberrationMode,
    aberrationStrength,
    properAccelG,
    properTimeYr,
    coordTimeYr,
    distanceLy,
    phase,
    halfTauYr,
    visualPace,
  };
}
