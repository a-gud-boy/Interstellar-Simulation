/**
 * BinaryPhysics.js — Pure-JS relativistic two-body spacetime, 1PN Padé orbital
 * dynamics, 2.5PN Peters-Mathews inspiral, Eggleton Roche lobes, Brill-Lindquist
 * optical metric, 1PN gravitomagnetic frame-dragging, and retarded Cartesian TT
 * quadrupole gravitational wave field (G = c = M = 1, orbital plane X-Z, L = +Y).
 */

const CLAMP_MIN_Q = 0.05;
const CLAMP_MAX_Q = 1.0;
const CLAMP_MIN_SEP = 1.4;
const CLAMP_MAX_SEP = 24.0;
const FIDUCIAL_TOTAL_MASS_SEC = 2.9553e-4; // G*(60 M_sun)/c^3 in seconds
const RINGDOWN_DURATION_SEC = 1.8;
const PLUNGE_SEP_THRESHOLD = 1.65;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Eggleton (1983) effective Roche lobe radius fraction R_L / d for mass ratio q_i = m_i / m_other.
 */
export function eggletonRocheRadius(d, mSelf, mOther) {
  if (mSelf <= 0) return 0.0;
  if (mOther <= 0) return d;
  const q = mSelf / mOther;
  const q13 = Math.cbrt(q);
  const q23 = q13 * q13;
  return d * ((0.49 * q23) / (0.6 * q23 + Math.log(1.0 + q13)));
}

/**
 * 2.5PN Peters-Mathews circular orbit separation decay rate dd/dt_geo = -64/5 * eta / d^3.
 */
export function petersMathewsRate(d, eta) {
  const safeD = Math.max(d, 1.0);
  return -(64.0 / 5.0) * (eta / (safeD * safeD * safeD));
}

/**
 * 2.5PN Peters-Mathews coalescence time T_coal = 5 / (256 * eta) * d^4 in geometrized units M.
 */
export function petersMathewsTimeToMerger(d, eta) {
  const safeD = Math.max(d, 0.0);
  const safeEta = Math.max(eta, 1e-8);
  return (5.0 / (256.0 * safeEta)) * Math.pow(safeD, 4.0);
}

/**
 * Computes instantaneous binary black hole kinematic, horizon, and GW telemetry state.
 */
export function computeBinaryState(params = {}, phaseRad = 0.0, options = {}) {
  const minQ = options.allowZeroMassRatio ? 0.0 : CLAMP_MIN_Q;
  const q = clamp(Number.isFinite(params.massRatio) ? params.massRatio : 1.0, minQ, CLAMP_MAX_Q);
  const d = clamp(Number.isFinite(params.separation) ? params.separation : 7.4, CLAMP_MIN_SEP, CLAMP_MAX_SEP);

  const m1 = 1.0 / (1.0 + q);
  const m2 = q / (1.0 + q);
  const eta = m1 * m2;
  const chirpMass = Math.pow(Math.max(eta, 0.0), 0.6);

  // Positive-definite 1PN Padé orbital frequency: exact 1PN expansion & monotonic to plunge
  const sqrtD = Math.sqrt(d);
  const omega = 1.0 / (d * sqrtD + 0.5 * (3.0 - eta) * sqrtD);
  const vOrbitalC = Math.min(0.99, Math.cbrt(omega));

  // Gravitational wave frequency & chirp phase
  const fGwDimless = omega / Math.PI;
  const fGwHz = fGwDimless / FIDUCIAL_TOTAL_MASS_SEC;
  const gwPhaseRad = 2.0 * phaseRad;
  const gwWaveOmega = clamp(omega * 2.8, 0.10, 0.42);

  // Co-rotating to lab positions (CCW around +Y so -X approaches +Z camera)
  const r1 = m2 * d;
  const r2 = m1 * d;
  const cPhi = Math.cos(phaseRad);
  const sPhi = Math.sin(phaseRad);

  const c1 = [-r1 * cPhi, 0.0, +r1 * sPhi];
  const c2 = [+r2 * cPhi, 0.0, -r2 * sPhi];
  const v1 = [+omega * c1[2], 0.0, -omega * c1[0]];
  const v2 = [+omega * c2[2], 0.0, -omega * c2[0]];

  // Isotropic horizons & saddle potential
  const rH1 = 0.5 * m1;
  const rH2 = 0.5 * m2;
  const phiSaddle = (1.0 + 2.0 * Math.sqrt(Math.max(eta, 0.0))) / (2.0 * d);

  // Roche lobes & circumbinary tidal cavity radius
  const rocheL1 = eggletonRocheRadius(d, m1, m2);
  const rocheL2 = eggletonRocheRadius(d, m2, m1);
  const rCavity = d * (1.65 + 0.55 * Math.sqrt(Math.max(4.0 * eta, 0.0)));

  return {
    q,
    d,
    m1,
    m2,
    eta,
    chirpMass,
    omega,
    gwWaveOmega,
    vOrbitalC,
    fGwDimless,
    fGwHz,
    phaseRad,
    gwPhaseRad,
    c1,
    c2,
    v1,
    v2,
    rH1,
    rH2,
    phiSaddle,
    rocheL1,
    rocheL2,
    rCavity,
    timeToMergerM: petersMathewsTimeToMerger(d, Math.max(eta, 1e-4)),
  };
}

/**
 * Advances orbital phase and optional 2.5PN Peters-Mathews inspiral + ringdown cycle.
 */
export function stepBinaryOrbit(orbitState, params, dtSec) {
  const timeWarp = clamp(Number.isFinite(params.timeWarp) ? params.timeWarp : 1.0, 0.0, 4.0);
  const dt = Math.max(0.0, Number.isFinite(dtSec) ? dtSec : 0.0);
  const geoDt = dt * 15.0 * timeWarp;
  const targetSep = clamp(Number.isFinite(params.separation) ? params.separation : 7.4, CLAMP_MIN_SEP, CLAMP_MAX_SEP);

  if (!Number.isFinite(orbitState.currentSep)) {
    orbitState.currentSep = targetSep;
  }
  if (!Number.isFinite(orbitState.phase)) {
    orbitState.phase = 0.0;
  }
  if (!Number.isFinite(orbitState.ringdownTimer)) {
    orbitState.ringdownTimer = 0.0;
  }
  if (typeof orbitState.inRingdown !== 'boolean') {
    orbitState.inRingdown = false;
  }
  if (!Number.isFinite(orbitState.ringdownFactor)) {
    orbitState.ringdownFactor = 0.0;
  }

  const q = clamp(Number.isFinite(params.massRatio) ? params.massRatio : 1.0, CLAMP_MIN_Q, CLAMP_MAX_Q);
  const m1 = 1.0 / (1.0 + q);
  const m2 = q / (1.0 + q);
  const eta = m1 * m2;

  if (params.inspiralMode === 1) {
    if (orbitState.inRingdown) {
      orbitState.ringdownTimer += dt * timeWarp;
      const u = clamp(orbitState.ringdownTimer / RINGDOWN_DURATION_SEC, 0.0, 1.0);
      orbitState.ringdownFactor = Math.sin(Math.PI * u);
      const bin = computeBinaryState({ massRatio: q, separation: PLUNGE_SEP_THRESHOLD }, orbitState.phase);
      orbitState.phase = (orbitState.phase + bin.omega * geoDt) % (2.0 * Math.PI);

      if (orbitState.ringdownTimer >= RINGDOWN_DURATION_SEC) {
        orbitState.inRingdown = false;
        orbitState.ringdownTimer = 0.0;
        orbitState.ringdownFactor = 0.0;
        orbitState.currentSep = targetSep;
      }
    } else {
      const d0 = clamp(orbitState.currentSep, PLUNGE_SEP_THRESHOLD, CLAMP_MAX_SEP);
      const k1 = petersMathewsRate(d0, eta) * 0.35;
      const dMid = Math.max(1.2, d0 + 0.5 * geoDt * k1);
      const k2 = petersMathewsRate(dMid, eta) * 0.35;
      const dNext = d0 + geoDt * k2;

      const binMid = computeBinaryState({ massRatio: q, separation: dMid }, orbitState.phase);
      orbitState.phase = (orbitState.phase + binMid.omega * geoDt) % (2.0 * Math.PI);

      if (dNext < PLUNGE_SEP_THRESHOLD) {
        orbitState.currentSep = PLUNGE_SEP_THRESHOLD;
        orbitState.inRingdown = true;
        orbitState.ringdownTimer = 0.0;
        orbitState.ringdownFactor = 0.0;
      } else {
        orbitState.currentSep = dNext;
      }
    }
  } else {
    orbitState.inRingdown = false;
    orbitState.ringdownTimer = 0.0;
    orbitState.ringdownFactor = 0.0;
    orbitState.currentSep = targetSep;
    const bin = computeBinaryState({ massRatio: q, separation: targetSep }, orbitState.phase);
    orbitState.phase = (orbitState.phase + bin.omega * geoDt) % (2.0 * Math.PI);
  }

  return orbitState;
}

/**
 * Evaluates exact Brill-Lindquist conformal potential Phi, gradient gradPhi,
 * Fermat optical refractive index n = (1+Phi)^3 / (1-Phi), and optical gradient gradLnN.
 */
export function evalBrillLindquistFields(x, y, z, bin, lensing = 1.0) {
  const dx1 = x - bin.c1[0];
  const dy1 = y - bin.c1[1];
  const dz1 = z - bin.c1[2];
  const r1Sq = Math.max(dx1 * dx1 + dy1 * dy1 + dz1 * dz1, 1e-12);
  const r1 = Math.sqrt(r1Sq);

  const dx2 = x - bin.c2[0];
  const dy2 = y - bin.c2[1];
  const dz2 = z - bin.c2[2];
  const r2Sq = Math.max(dx2 * dx2 + dy2 * dy2 + dz2 * dz2, 1e-12);
  const r2 = Math.sqrt(r2Sq);

  const phi1 = bin.m1 > 0 ? bin.m1 / (2.0 * r1) : 0.0;
  const phi2 = bin.m2 > 0 ? bin.m2 / (2.0 * r2) : 0.0;
  const phi = phi1 + phi2;

  const invR1Cube = bin.m1 > 0 ? -0.5 * bin.m1 / (r1Sq * r1) : 0.0;
  const invR2Cube = bin.m2 > 0 ? -0.5 * bin.m2 / (r2Sq * r2) : 0.0;

  const gx = invR1Cube * dx1 + invR2Cube * dx2;
  const gy = invR1Cube * dy1 + invR2Cube * dy2;
  const gz = invR1Cube * dz1 + invR2Cube * dz2;

  const phiC = Math.min(phi, 0.95);
  const n = Math.pow(1.0 + phiC, 3.0) / Math.max(1.0 - phiC, 0.05);
  const blFactor = lensing * ((4.0 - 2.0 * phiC) / Math.max(1.0 - phiC * phiC, 0.05));

  return {
    r1,
    r2,
    phi,
    n,
    gradPhi: [gx, gy, gz],
    gradLnN: [blFactor * gx, blFactor * gy, blFactor * gz],
    d1: [dx1, dy1, dz1],
    d2: [dx2, dy2, dz2],
  };
}

/**
 * Evaluates pole-free Cartesian Transverse-Traceless (TT) retarded quadrupole GW
 * perturbation shear and wave-zone gradient (matches shader formulas 1:1).
 */
export function evalCartesianTTGW(x, y, z, vx, vy, vz, bin, gwAmplitude = 0.0) {
  if (Math.abs(gwAmplitude) <= 1e-8 || bin.eta <= 1e-8) {
    return { A: 0.0, dAdR: 0.0, S: 0.0, dSdPhi: 0.0, gradGW: [0.0, 0.0, 0.0], iswIntegrand: 0.0 };
  }

  const R2 = x * x + y * y + z * z;
  const R = Math.sqrt(R2);
  if (R < 1e-5) {
    return { A: 0.0, dAdR: 0.0, S: 0.0, dSdPhi: 0.0, gradGW: [0.0, 0.0, 0.0], iswIntegrand: 0.0 };
  }

  const invR = 1.0 / R;
  const nx = x * invR;
  const ny = y * invR;
  const nz = z * invR;

  const r0 = 0.8 * bin.d;
  const r1 = 2.2 * bin.d;
  if (R <= r0) {
    return { A: 0.0, dAdR: 0.0, S: 0.0, dSdPhi: 0.0, gradGW: [0.0, 0.0, 0.0], iswIntegrand: 0.0 };
  }

  const span = Math.max(r1 - r0, 1e-5);
  const t = clamp((R - r0) / span, 0.0, 1.0);
  const ramp = t * t * (3.0 - 2.0 * t);
  const dRamp = t > 0.0 && t < 1.0 ? (6.0 * t * (1.0 - t)) / span : 0.0;

  const decayDen = 1.0 + 0.055 * R;
  const decay = Math.exp(-R / 95.0) / decayDen;
  const dDecay = -decay * (0.055 / decayDen + 1.0 / 95.0);

  const A0 = gwAmplitude * (4.0 * bin.eta) * 0.035;
  const A = A0 * ramp * decay;
  const dAdR = A0 * (dRamp * decay + ramp * dDecay);

  const omegaWave = bin.gwWaveOmega;
  const phiRet = bin.phaseRad - omegaWave * R;
  const c = Math.cos(2.0 * phiRet);
  const s = Math.sin(2.0 * phiRet);

  const vn = vx * nx + vy * ny + vz * nz;
  const vpx = vx - vn * nx;
  const vpy = vy - vn * ny;
  const vpz = vz - vn * nz;
  const vp2 = vpx * vpx + vpy * vpy + vpz * vpz;

  const qv = vpx * vpx - vpz * vpz;
  const uv = 2.0 * vpx * vpz;
  const qn = nx * nx - nz * nz;
  const un = 2.0 * nx * nz;

  const C1 = qv + 0.5 * vp2 * qn;
  const C2 = uv + 0.5 * vp2 * un;

  const S = c * C1 + s * C2;
  const dSdPhi = s * C1 - c * C2; // dS/dR = 2 * omegaWave * dSdPhi at fixed n, v_perp

  const radialCoeff = 0.5 * (2.0 * omegaWave * A * dSdPhi + dAdR * S);
  const iswIntegrand = 1.8 * omegaWave * A * (-dSdPhi);

  return {
    A,
    dAdR,
    S,
    dSdPhi,
    gradGW: [radialCoeff * nx, radialCoeff * ny, radialCoeff * nz],
    iswIntegrand,
  };
}

/**
 * Evaluates full geodesic RHS (dx/ds, dv/ds) for Fermat unit-tangent integration.
 */
export function evalBinaryGeodesicRHS(pos, dir, bin, opts = {}) {
  const lensing = opts.lensing ?? 1.0;
  const gwAmplitude = opts.gwAmplitude ?? 0.0;
  const includeGm = opts.gravitomagnetic !== false;

  const f = evalBrillLindquistFields(pos[0], pos[1], pos[2], bin, lensing);
  let gx = f.gradLnN[0];
  let gy = f.gradLnN[1];
  let gz = f.gradLnN[2];

  if (gwAmplitude !== 0.0) {
    const gw = evalCartesianTTGW(pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], bin, gwAmplitude);
    gx += gw.gradGW[0];
    gy += gw.gradGW[1];
    gz += gw.gradGW[2];
  }

  // Orthogonal projection of scalar optical gradient perpendicular to unit tangent dir
  const gDotV = gx * dir[0] + gy * dir[1] + gz * dir[2];
  let ax = gx - gDotV * dir[0];
  let ay = gy - gDotV * dir[1];
  let az = gz - gDotV * dir[2];

  // 1PN gravitomagnetic orbital frame-dragging: (lensing / n) * (v x B_g)
  if (includeGm && lensing > 1e-6) {
    const r1c = f.r1 * f.r1 * f.r1;
    const r2c = f.r2 * f.r2 * f.r2;
    const c1x = bin.m1 > 0 ? (bin.m1 / r1c) * (f.d1[1] * bin.v1[2] - f.d1[2] * bin.v1[1]) : 0.0;
    const c1y = bin.m1 > 0 ? (bin.m1 / r1c) * (f.d1[2] * bin.v1[0] - f.d1[0] * bin.v1[2]) : 0.0;
    const c1z = bin.m1 > 0 ? (bin.m1 / r1c) * (f.d1[0] * bin.v1[1] - f.d1[1] * bin.v1[0]) : 0.0;

    const c2x = bin.m2 > 0 ? (bin.m2 / r2c) * (f.d2[1] * bin.v2[2] - f.d2[2] * bin.v2[1]) : 0.0;
    const c2y = bin.m2 > 0 ? (bin.m2 / r2c) * (f.d2[2] * bin.v2[0] - f.d2[0] * bin.v2[2]) : 0.0;
    const c2z = bin.m2 > 0 ? (bin.m2 / r2c) * (f.d2[0] * bin.v2[1] - f.d2[1] * bin.v2[0]) : 0.0;

    const bgx = -4.0 * (c1x + c2x);
    const bgy = -4.0 * (c1y + c2y);
    const bgz = -4.0 * (c1z + c2z);

    const invN = lensing / Math.max(f.n, 1.0);
    ax += invN * (dir[1] * bgz - dir[2] * bgy);
    ay += invN * (dir[2] * bgx - dir[0] * bgz);
    az += invN * (dir[0] * bgy - dir[1] * bgx);
  }

  return {
    dx: [dir[0], dir[1], dir[2]],
    dv: [ax, ay, az],
    fields: f,
  };
}

/**
 * Reference adaptive RK4 ray-tracer in CPU JS for automated physics verification.
 */
export function traceBinaryRay(startPos, startDir, bin, opts = {}) {
  const maxSteps = opts.maxSteps ?? 1200;
  const qualScale = opts.qualScale ?? 0.65;
  const escapeR = opts.escapeR ?? Math.max(85.0, Math.hypot(...startPos) * 1.5);
  const capturePhi = opts.capturePhi ?? 0.92;
  const gwAmplitude = opts.gwAmplitude ?? 0.0;

  let pos = [...startPos];
  const dLen = Math.hypot(...startDir) || 1.0;
  let dir = [startDir[0] / dLen, startDir[1] / dLen, startDir[2] / dLen];
  let maxUnitErr = 0.0;

  for (let step = 0; step < maxSteps; step++) {
    const k1 = evalBinaryGeodesicRHS(pos, dir, bin, opts);
    const f = k1.fields;
    if (f.phi >= capturePhi) {
      return {
        captured: true,
        capturedBy: f.r1 / Math.max(bin.m1, 1e-5) <= f.r2 / Math.max(bin.m2, 1e-5) ? 1 : 2,
        steps: step,
        pos,
        dir,
        maxUnitErr,
      };
    }

    const rCom = Math.hypot(pos[0], pos[1], pos[2]);
    const outbound = pos[0] * dir[0] + pos[1] * dir[1] + pos[2] * dir[2] > 0.0;
    if (rCom > escapeR && outbound) {
      return { captured: false, capturedBy: 0, steps: step, pos, dir, maxUnitErr };
    }

    const minClear = Math.min(
      bin.m1 > 0 ? f.r1 - 0.82 * bin.rH1 : 1e6,
      bin.m2 > 0 ? f.r2 - 0.82 * bin.rH2 : 1e6
    );
    const minMassR = Math.min(
      bin.m1 > 0 ? f.r1 : 1e6,
      bin.m2 > 0 ? f.r2 : 1e6
    );
    const minH = Math.max(0.0012, 0.055 * minMassR) * qualScale;
    let h = clamp(0.11 * Math.max(minClear, 0.005) * qualScale, minH, 3.2);
    if (Math.abs(gwAmplitude) > 0.01) {
      h = Math.min(h, Math.PI / (6.0 * bin.gwWaveOmega));
    }

    const p2 = [pos[0] + 0.5 * h * k1.dx[0], pos[1] + 0.5 * h * k1.dx[1], pos[2] + 0.5 * h * k1.dx[2]];
    const v2 = [dir[0] + 0.5 * h * k1.dv[0], dir[1] + 0.5 * h * k1.dv[1], dir[2] + 0.5 * h * k1.dv[2]];
    const k2 = evalBinaryGeodesicRHS(p2, v2, bin, opts);

    const p3 = [pos[0] + 0.5 * h * k2.dx[0], pos[1] + 0.5 * h * k2.dx[1], pos[2] + 0.5 * h * k2.dx[2]];
    const v3 = [dir[0] + 0.5 * h * k2.dv[0], dir[1] + 0.5 * h * k2.dv[1], dir[2] + 0.5 * h * k2.dv[2]];
    const k3 = evalBinaryGeodesicRHS(p3, v3, bin, opts);

    const p4 = [pos[0] + h * k3.dx[0], pos[1] + h * k3.dx[1], pos[2] + h * k3.dx[2]];
    const v4 = [dir[0] + h * k3.dv[0], dir[1] + h * k3.dv[1], dir[2] + h * k3.dv[2]];
    const k4 = evalBinaryGeodesicRHS(p4, v4, bin, opts);

    pos = [
      pos[0] + (h / 6.0) * (k1.dx[0] + 2.0 * k2.dx[0] + 2.0 * k3.dx[0] + k4.dx[0]),
      pos[1] + (h / 6.0) * (k1.dx[1] + 2.0 * k2.dx[1] + 2.0 * k3.dx[1] + k4.dx[1]),
      pos[2] + (h / 6.0) * (k1.dx[2] + 2.0 * k2.dx[2] + 2.0 * k3.dx[2] + k4.dx[2]),
    ];
    const nextV = [
      dir[0] + (h / 6.0) * (k1.dv[0] + 2.0 * k2.dv[0] + 2.0 * k3.dv[0] + k4.dv[0]),
      dir[1] + (h / 6.0) * (k1.dv[1] + 2.0 * k2.dv[1] + 2.0 * k3.dv[1] + k4.dv[1]),
      dir[2] + (h / 6.0) * (k1.dv[2] + 2.0 * k2.dv[2] + 2.0 * k3.dv[2] + k4.dv[2]),
    ];
    const vLen = Math.hypot(nextV[0], nextV[1], nextV[2]);
    maxUnitErr = Math.max(maxUnitErr, Math.abs(vLen - 1.0));
    dir = [nextV[0] / vLen, nextV[1] / vLen, nextV[2] / vLen];
  }

  return { captured: true, capturedBy: 0, steps: maxSteps, pos, dir, maxUnitErr };
}
