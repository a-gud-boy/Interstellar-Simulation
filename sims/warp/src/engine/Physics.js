/**
 * WarpPhysics.js — ADM 3+1 warp-drive spacetimes (Alcubierre, Natário Zero-Expansion,
 * and Lentz Rhomboidal Soliton), analytical shift Jacobians, York expansion scalar,
 * Eulerian exotic energy density T_00, HUD telemetry, and CPU RK4 null geodesic tracer.
 *
 * Coordinate convention: flight along +Z (+Y up, +X right), bubble centered at (0, 0, 0).
 * ADM units: c = G = 1, lapse alpha = 1, spatial metric gamma_ij = delta_ij.
 */

const PI = Math.PI;
const INV_16_PI = 1.0 / (16.0 * PI);
const INV_32_PI = 1.0 / (32.0 * PI);
const RAD2DEG = 180.0 / PI;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Clamped tanh(u) avoiding overflow/NaN in GPU/CPU pipelines for |u| > 15.
 * @param {number} u
 * @returns {number}
 */
export function safeTanh(u) {
  return Math.tanh(clamp(u, -15.0, 15.0));
}

/**
 * Clamped sech^2(u) returning 0 cleanly for |u| > 15.
 * @param {number} u
 * @returns {number}
 */
export function safeSech2(u) {
  if (Math.abs(u) > 15.0) return 0.0;
  const c = Math.cosh(u);
  return 1.0 / (c * c);
}

/**
 * Evaluates Alcubierre smooth top-hat shaping function f(r), df/dr, d2f/dr2, and
 * regularised (df/dr)/r with analytical r -> 0 Taylor limit.
 *
 * @param {number} r
 * @param {number} R
 * @param {number} sigma
 * @returns {{ f: number, df: number, d2f: number, dfOverR: number, tanhSR: number }}
 */
export function evalShape(r, R = 3.0, sigma = 2.3) {
  const safeR = Math.max(0.0, Number.isFinite(r) ? r : 0.0);
  const safeBubbleR = Math.max(0.2, Number.isFinite(R) ? R : 3.0);
  const safeSigma = Math.max(0.1, Number.isFinite(sigma) ? sigma : 2.3);

  const sR = safeSigma * safeBubbleR;
  const tanhSR = Math.max(safeTanh(sR), 1e-8);
  const sech2SR = safeSech2(sR);

  const uPlus = safeSigma * (safeR + safeBubbleR);
  const uMinus = safeSigma * (safeR - safeBubbleR);
  const thP = safeTanh(uPlus);
  const thM = safeTanh(uMinus);
  const s2P = safeSech2(uPlus);
  const s2M = safeSech2(uMinus);

  const f = (thP - thM) / (2.0 * tanhSR);
  const df = (safeSigma / (2.0 * tanhSR)) * (s2P - s2M);
  const d2f = ((safeSigma * safeSigma) / tanhSR) * (-s2P * thP + s2M * thM);

  let dfOverR;
  if (safeR < 1e-3) {
    // Analytical r -> 0 limit: f'(r)/r -> f''(0) + (1/6)*f^(4)(0)*r^2
    const f4_0 = 8.0 * Math.pow(safeSigma, 4.0) * sech2SR * (3.0 * sech2SR - 1.0);
    dfOverR = -2.0 * safeSigma * safeSigma * sech2SR + (f4_0 * safeR * safeR) / 6.0;
  } else {
    dfOverR = df / safeR;
  }

  return { f, df, d2f, dfOverR, tanhSR };
}

function sanitizeParams(state = {}) {
  const rawR = Number(state?.bubbleRadius);
  const rawSigma = Number(state?.wallThickness);
  const rawVs = Number(state?.warpVelocity);
  const metricType = Number.isFinite(Number(state?.metricType)) ? (Number(state.metricType) | 0) : 0;

  return {
    R: clamp(Number.isFinite(rawR) ? rawR : 3.0, 0.2, 20.0),
    sigma: clamp(Number.isFinite(rawSigma) ? rawSigma : 2.3, 0.1, 20.0),
    vs: clamp(Number.isFinite(rawVs) ? rawVs : 2.5, 0.0, 10.0),
    metricType: metricType === 1 ? 1 : metricType === 2 ? 2 : 0,
  };
}

/**
 * Computes Lentz smooth rhomboidal Lp radius r_L(x, y, z) and its analytical gradient factors.
 */
function evalLentzRadius(x, y, z, R) {
  const p = 1.38;
  const eps = 0.12 * R;
  const eps2 = eps * eps;
  const rho2 = x * x + y * y;
  const a = rho2 + eps2;
  const b = z * z + eps2;
  const halfP = 0.5 * p;
  const ap = Math.pow(a, halfP);
  const bp = Math.pow(b, halfP);
  const sum = ap + bp;
  const rL = Math.pow(sum, 1.0 / p);
  const rL1mP = Math.pow(rL, 1.0 - p);
  const gRho = rL1mP * Math.pow(a, halfP - 1.0);
  const gZ = rL1mP * Math.pow(b, halfP - 1.0);
  return { rL, rho2, gRho, gZ };
}

/**
 * Evaluates ADM shift vector beta^j, spatial Jacobian J[i][j] = d_i beta^j,
 * York expansion theta = -div(beta), and Eulerian energy density T_00 = (K^2 - K_ij K^ij)/(16*pi).
 *
 * @param {[number, number, number]} pos
 * @param {object} state
 * @param {number} [frameBlend=0] 0 = External Chase (lab frame), 1 = Inside Bridge (comoving frame)
 * @returns {{
 *   beta: [number, number, number],
 *   J: [[number, number, number], [number, number, number], [number, number, number]],
 *   theta: number,
 *   t00: number,
 *   f: number,
 *   df: number
 * }}
 */
export function evalMetric(pos, state = {}, frameBlend = 0.0) {
  const x = pos[0];
  const y = pos[1];
  const z = pos[2];
  const { R, sigma, vs, metricType } = sanitizeParams(state);
  const blend = clamp(Number.isFinite(Number(frameBlend)) ? Number(frameBlend) : 0.0, 0.0, 1.0);
  const frameShiftZ = -(1.0 - blend) * vs;

  if (metricType === 1) {
    // Natário Zero-Expansion Bubble (identically divergence-free: theta === 0 everywhere)
    const r = Math.hypot(x, y, z);
    const shape = evalShape(r, R, sigma);
    const { f, df, d2f, dfOverR } = shape;
    const h = dfOverR;

    let dhOverR;
    if (r < 2e-3) {
      const sR = sigma * R;
      const sech2SR = safeSech2(sR);
      // Exact r -> 0 limit: lim (f''(r) - f'(r)/r)/r^2 = (1/3) * f^(4)(0)
      dhOverR = (8.0 / 3.0) * Math.pow(sigma, 4.0) * sech2SR * (3.0 * sech2SR - 1.0);
    } else {
      dhOverR = (d2f - h) / (r * r);
    }

    const rho2 = x * x + y * y;
    const halfVs = 0.5 * vs;

    const bx = halfVs * h * x * z;
    const by = halfVs * h * y * z;
    const bz = vs * (1.0 - f) - halfVs * h * rho2 + frameShiftZ;

    const J00 = halfVs * (dhOverR * x * x * z + h * z);
    const J01 = halfVs * dhOverR * x * y * z;
    const J02 = -2.0 * vs * h * x - halfVs * dhOverR * x * rho2;

    const J10 = halfVs * dhOverR * x * y * z;
    const J11 = halfVs * (dhOverR * y * y * z + h * z);
    const J12 = -2.0 * vs * h * y - halfVs * dhOverR * y * rho2;

    const J20 = halfVs * (dhOverR * x * z * z + h * x);
    const J21 = halfVs * (dhOverR * y * z * z + h * y);
    const J22 = -vs * h * z - halfVs * dhOverR * z * rho2;

    // Extrinsic curvature K_ij = 0.5 * (J_ij + J_ji); K = div(beta) === 0 => theta = 0
    const K00 = J00;
    const K11 = J11;
    const K22 = J22;
    const K01 = 0.5 * (J01 + J10);
    const K02 = 0.5 * (J02 + J20);
    const K12 = 0.5 * (J12 + J21);

    const kSqSum =
      K00 * K00 + K11 * K11 + K22 * K22 +
      2.0 * (K01 * K01 + K02 * K02 + K12 * K12);
    const t00 = -kSqSum * INV_16_PI;

    return {
      beta: [bx, by, bz],
      J: [
        [J00, J01, J02],
        [J10, J11, J12],
        [J20, J21, J22],
      ],
      theta: 0.0,
      t00,
      f,
      df,
    };
  }

  if (metricType === 2) {
    // Lentz Rhomboidal Soliton with longitudinal-radial diversion producing T_00 > 0 bow/stern lobes
    const { rL, gRho, gZ } = evalLentzRadius(x, y, z, R);
    const shape = evalShape(rL, R, sigma);
    const { f, df, d2f } = shape;

    const invRL = 1.0 / Math.max(rL, 1e-3);
    const thArg = (2.0 * z) / R;
    const th = safeTanh(thArg);
    const s2 = safeSech2(thArg);

    // Since df < 0 on the wall, -0.28 * vs * df * tanh(2*z/R) diverts shift outward ahead (z>0)
    // and inward behind (z<0), giving K_xx = K_yy same sign as K_zz and positive T_00 lobes.
    const tiltCoeff = -0.28 * vs;
    const Q = tiltCoeff * df * th * invRL;

    const bx = Q * x;
    const by = Q * y;
    const bz = vs * (1.0 - f) + frameShiftZ;

    const dQdrL = tiltCoeff * th * (d2f - df * invRL) * invRL;
    const dQdx = dQdrL * gRho * x;
    const dQdy = dQdrL * gRho * y;
    const dQdz = dQdrL * gZ * z + tiltCoeff * df * invRL * (2.0 / R) * s2;

    const J00 = Q + x * dQdx;
    const J01 = y * dQdx;
    const J02 = -vs * df * gRho * x;

    const J10 = x * dQdy;
    const J11 = Q + y * dQdy;
    const J12 = -vs * df * gRho * y;

    const J20 = x * dQdz;
    const J21 = y * dQdz;
    const J22 = -vs * df * gZ * z;

    const K = J00 + J11 + J22;
    const theta = -K;

    const K00 = J00;
    const K11 = J11;
    const K22 = J22;
    const K01 = 0.5 * (J01 + J10);
    const K02 = 0.5 * (J02 + J20);
    const K12 = 0.5 * (J12 + J21);

    const kSqSum =
      K00 * K00 + K11 * K11 + K22 * K22 +
      2.0 * (K01 * K01 + K02 * K02 + K12 * K12);
    const t00 = (K * K - kSqSum) * INV_16_PI;

    return {
      beta: [bx, by, bz],
      J: [
        [J00, J01, J02],
        [J10, J11, J12],
        [J20, J21, J22],
      ],
      theta,
      t00,
      f,
      df,
    };
  }

  // metricType === 0: Alcubierre Warp Drive Metric
  const r = Math.hypot(x, y, z);
  const shape = evalShape(r, R, sigma);
  const { f, df, dfOverR } = shape;

  const bx = 0.0;
  const by = 0.0;
  const bz = vs * (1.0 - f) + frameShiftZ;

  const J02 = -vs * dfOverR * x;
  const J12 = -vs * dfOverR * y;
  const J22 = -vs * dfOverR * z;

  // theta = -div(beta) = +vs * (z/r) * df(r) = +vs * z * dfOverR
  const theta = vs * z * dfOverR;
  const rho2 = x * x + y * y;
  const t00 = -vs * vs * rho2 * dfOverR * dfOverR * INV_32_PI;

  return {
    beta: [bx, by, bz],
    J: [
      [0.0, 0.0, J02],
      [0.0, 0.0, J12],
      [0.0, 0.0, J22],
    ],
    theta,
    t00,
    f,
    df,
  };
}

/**
 * Computes live physics telemetry for HUD & diagnostics.
 *
 * @param {object} state
 * @returns {{
 *   warpVelocity: number,
 *   peakYork: number,
 *   gForward: number,
 *   gAft: number,
 *   hasHorizon: boolean,
 *   horizonAngleDeg: number,
 *   peakEnergyDensity: number,
 *   metricLabel: string
 * }}
 */
export function computeWarpTelemetry(state = {}) {
  const { R, sigma, vs, metricType } = sanitizeParams(state);

  let metricLabel = 'Alcubierre';
  let peakYork = 0.0;
  let peakEnergyDensity = 0.0;

  if (metricType === 0) {
    metricLabel = 'Alcubierre';
    const wall = evalShape(R, R, sigma);
    peakYork = vs * Math.abs(wall.df);
    peakEnergyDensity = -vs * vs * wall.df * wall.df * INV_32_PI;
  } else if (metricType === 1) {
    metricLabel = 'Natário';
    peakYork = 0.0;
    const samples = [
      [R, 0.0, 0.0],
      [0.0, 0.0, R],
      [R * Math.SQRT1_2, 0.0, R * Math.SQRT1_2],
    ];
    for (const p of samples) {
      const m = evalMetric(p, state, 1.0);
      if (Math.abs(m.t00) > Math.abs(peakEnergyDensity)) {
        peakEnergyDensity = m.t00;
      }
    }
  } else {
    metricLabel = 'Lentz';
    const samples = [
      [R, 0.0, 0.0],
      [0.0, 0.0, R],
      [0.0, 0.0, -R],
      [0.45 * R, 0.0, 0.55 * R],
      [0.55 * R, 0.0, 0.45 * R],
      [0.85 * R, 0.0, 0.15 * R],
    ];
    for (const p of samples) {
      const m = evalMetric(p, state, 1.0);
      if (Math.abs(m.theta) > peakYork) {
        peakYork = Math.abs(m.theta);
      }
      if (Math.abs(m.t00) > Math.abs(peakEnergyDensity)) {
        peakEnergyDensity = m.t00;
      }
    }
  }

  const gForward = 1.0 + vs;
  const hasHorizon = vs >= 1.0;
  const gAft = hasHorizon ? 0.0 : 1.0 - vs;
  // Full aft causal shadow cone diameter: 2 * acos(1 / v_s) in degrees
  const horizonAngleDeg = hasHorizon
    ? 2.0 * Math.acos(clamp(1.0 / vs, 0.0, 1.0)) * RAD2DEG
    : 0.0;

  return {
    warpVelocity: vs,
    peakYork,
    gForward,
    gAft,
    hasHorizon,
    horizonAngleDeg,
    peakEnergyDensity,
    metricLabel,
  };
}

function evalRayDerivatives(pos, k, state, frameBlend) {
  const m = evalMetric(pos, state, frameBlend);
  const kLen = Math.max(Math.hypot(k[0], k[1], k[2]), 1e-8);
  const invK = 1.0 / kLen;

  const dpos = [
    -k[0] * invK + m.beta[0],
    -k[1] * invK + m.beta[1],
    -k[2] * invK + m.beta[2],
  ];

  // Hamilton's equations in s = -t: dk_i/ds = -k_j * d_i beta^j
  const J = m.J;
  const dk = [
    -(J[0][0] * k[0] + J[0][1] * k[1] + J[0][2] * k[2]),
    -(J[1][0] * k[0] + J[1][1] * k[1] + J[1][2] * k[2]),
    -(J[2][0] * k[0] + J[2][1] * k[1] + J[2][2] * k[2]),
  ];

  return { dpos, dk, m, kLen };
}

/**
 * Integrates backward ADM null geodesics (ds = -dt > 0) via adaptive 4th-order Runge-Kutta.
 * Conserves p_0 = dot(beta, k) - |k| along stationary slices.
 *
 * @param {[number, number, number]} pos0
 * @param {[number, number, number]} dir0
 * @param {object} state
 * @param {number} [frameBlend=0]
 * @param {{ maxSteps?: number, escapeRadius?: number, horizonKLimit?: number }} [opts]
 * @returns {{
 *   escaped: boolean,
 *   horizonCaptured: boolean,
 *   pos: [number, number, number],
 *   k: [number, number, number],
 *   p0Initial: number,
 *   p0Final: number,
 *   p0Drift: number,
 *   dopplerFactor: number
 * }}
 */
export function traceRayCPU(pos0, dir0, state = {}, frameBlend = 0.0, opts = {}) {
  const { R, sigma, vs, metricType } = sanitizeParams(state);
  const blend = clamp(Number.isFinite(Number(frameBlend)) ? Number(frameBlend) : 0.0, 0.0, 1.0);

  const dirLen = Math.max(Math.hypot(dir0[0], dir0[1], dir0[2]), 1e-8);
  const rayDir = [dir0[0] / dirLen, dir0[1] / dirLen, dir0[2] / dirLen];

  const pos = [pos0[0], pos0[1], pos0[2]];
  const k = [-rayDir[0], -rayDir[1], -rayDir[2]];

  const maxSteps = Math.max(1, Number(opts.maxSteps ?? 700) | 0);
  const shellMargin = 6.0 / sigma;
  const minEscapeR = Math.max(R + shellMargin, 1.8 * R + 3.0);
  const escapeRadius = Math.max(minEscapeR, Number(opts.escapeRadius ?? Math.max(R * 3.0 + shellMargin, 22.0)));
  const horizonKLimit = Math.max(5.0, Number(opts.horizonKLimit ?? 28.0));

  const mInit = evalMetric(pos, state, blend);
  const kInitLen = Math.hypot(k[0], k[1], k[2]);
  const p0Initial =
    mInit.beta[0] * k[0] + mInit.beta[1] * k[1] + mInit.beta[2] * k[2] - kInitLen;

  let escaped = false;
  let horizonCaptured = false;
  let integratedNegTheta = 0.0;

  const baseWallDs = Math.min(0.025, 0.035 / Math.max(sigma / 2.3, 0.6));
  const farDs = Math.min(0.22 * R, 0.75);
  const shellWidth = 2.8 / sigma;

  for (let step = 0; step < maxSteps; step++) {
    const rCart = Math.hypot(pos[0], pos[1], pos[2]);
    const rEff = metricType === 2 ? evalLentzRadius(pos[0], pos[1], pos[2], R).rL : rCart;
    const wallDist = Math.abs(rEff - R);

    const s1 = evalRayDerivatives(pos, k, state, blend);
    if (s1.kLen > horizonKLimit) {
      horizonCaptured = true;
      break;
    }

    const radialOut = pos[0] * s1.dpos[0] + pos[1] * s1.dpos[1] + pos[2] * s1.dpos[2];
    if (rEff > minEscapeR && rCart > escapeRadius && radialOut > 0.0 && Math.abs(s1.m.df) < 1e-6) {
      escaped = true;
      break;
    }

    const tWall = clamp((wallDist - shellWidth) / Math.max(1.5 * R, 2.0), 0.0, 1.0);
    let ds = baseWallDs * (1.0 - tWall) + farDs * tWall;
    if (s1.kLen > 2.0) {
      ds /= 1.0 + 0.04 * (s1.kLen - 2.0);
    }

    const halfDs = 0.5 * ds;
    const p2 = [pos[0] + halfDs * s1.dpos[0], pos[1] + halfDs * s1.dpos[1], pos[2] + halfDs * s1.dpos[2]];
    const k2 = [k[0] + halfDs * s1.dk[0], k[1] + halfDs * s1.dk[1], k[2] + halfDs * s1.dk[2]];
    const s2 = evalRayDerivatives(p2, k2, state, blend);

    const p3 = [pos[0] + halfDs * s2.dpos[0], pos[1] + halfDs * s2.dpos[1], pos[2] + halfDs * s2.dpos[2]];
    const k3 = [k[0] + halfDs * s2.dk[0], k[1] + halfDs * s2.dk[1], k[2] + halfDs * s2.dk[2]];
    const s3 = evalRayDerivatives(p3, k3, state, blend);

    const p4 = [pos[0] + ds * s3.dpos[0], pos[1] + ds * s3.dpos[1], pos[2] + ds * s3.dpos[2]];
    const k4 = [k[0] + ds * s3.dk[0], k[1] + ds * s3.dk[1], k[2] + ds * s3.dk[2]];
    const s4 = evalRayDerivatives(p4, k4, state, blend);

    const w = ds / 6.0;
    pos[0] += w * (s1.dpos[0] + 2.0 * s2.dpos[0] + 2.0 * s3.dpos[0] + s4.dpos[0]);
    pos[1] += w * (s1.dpos[1] + 2.0 * s2.dpos[1] + 2.0 * s3.dpos[1] + s4.dpos[1]);
    pos[2] += w * (s1.dpos[2] + 2.0 * s2.dpos[2] + 2.0 * s3.dpos[2] + s4.dpos[2]);

    k[0] += w * (s1.dk[0] + 2.0 * s2.dk[0] + 2.0 * s3.dk[0] + s4.dk[0]);
    k[1] += w * (s1.dk[1] + 2.0 * s2.dk[1] + 2.0 * s3.dk[1] + s4.dk[1]);
    k[2] += w * (s1.dk[2] + 2.0 * s2.dk[2] + 2.0 * s3.dk[2] + s4.dk[2]);

    const thetaAvg = (s1.m.theta + 2.0 * s2.m.theta + 2.0 * s3.m.theta + s4.m.theta) / 6.0;
    integratedNegTheta += -thetaAvg * ds;

    const kNowLen = Math.hypot(k[0], k[1], k[2]);
    if (kNowLen > horizonKLimit) {
      horizonCaptured = true;
      break;
    }
  }

  const mFinal = evalMetric(pos, state, blend);
  const kFinalLen = Math.hypot(k[0], k[1], k[2]);
  const p0Final =
    mFinal.beta[0] * k[0] + mFinal.beta[1] * k[1] + mFinal.beta[2] * k[2] - kFinalLen;
  const p0Drift = Math.abs(p0Final - p0Initial);

  if (!escaped && !horizonCaptured) {
    const rFinal = Math.hypot(pos[0], pos[1], pos[2]);
    if (rFinal > minEscapeR && Math.abs(mFinal.df) < 1e-4) {
      escaped = true;
    } else if (vs >= 0.99 || kFinalLen > 6.0) {
      horizonCaptured = true;
    }
  }

  let dopplerFactor;
  if (blend > 0.5) {
    dopplerFactor = horizonCaptured
      ? 0.0
      : Math.max(-p0Initial, 1e-6) / Math.max(kFinalLen, 1e-4);
  } else {
    const invKFinal = 1.0 / Math.max(kFinalLen, 1e-6);
    const fx = -k[0] * invKFinal + mFinal.beta[0];
    const fy = -k[1] * invKFinal + mFinal.beta[1];
    const fz = -k[2] * invKFinal + mFinal.beta[2];
    const fLen = Math.max(Math.hypot(fx, fy, fz), 1e-6);
    const finalDirZ = fz / fLen;
    dopplerFactor = Math.exp(clamp(integratedNegTheta + vs * (finalDirZ - rayDir[2]), -2.4, 2.4));
  }

  return {
    escaped,
    horizonCaptured,
    pos,
    k,
    p0Initial,
    p0Final,
    p0Drift,
    dopplerFactor,
  };
}
