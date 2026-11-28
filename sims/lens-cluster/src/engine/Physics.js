/**
 * Physics.js — Exact analytical & numerical Gravitational Lensing physics in Float64.
 *
 * Canonical source of truth shared between main.js telemetry, renderers,
 * GLSL/WGSL parity checks, and unit tests.
 *
 * Units:
 *   - Angular coordinates (theta, beta): arcseconds (")
 *   - Einstein radius thetaE: arcseconds (")
 *   - Fermat potential tau(theta; beta): arcsec^2
 *   - Cosmological scaling: z_lens = 0.39, z_source = 1.45 (SMACS-0723 / JWST-like)
 */

export const LENS_MODEL_LABELS = Object.freeze([
  'Point Mass',
  'SIE Elliptical',
  'NFW Cluster',
]);

export const LENS_CONSTANTS = Object.freeze({
  Z_LENS: 0.39,
  Z_SOURCE: 1.45,
  // M(< theta_E) = (c^2 / 4G) * (D_L D_S / D_LS) * theta_E^2 in 10^12 M_sun for theta_E in arcsec
  MASS_PER_ARCSEC2_1E12_MSUN: 0.2279,
  // Time-delay distance factor: (1 + z_L) / c * (D_L D_S / D_LS) in days / arcsec^2
  TIME_DELAY_DAYS_PER_ARCSEC2: 72.24,
  POINT_SOFTENING_FRAC: 0.015,
  SIE_CORE_FRAC: 0.035,
  NFW_CORE_FRAC: 0.04,
  NFW_RS_RATIO: 2.6,
  // 6 deterministic 3D foreground cluster member galaxies (arcsec normalized to thetaE = 2.85")
  SUBHALOS: Object.freeze([
    Object.freeze({ x: -1.25, y:  0.72, z:  0.45, bFrac: 0.24, coreFrac: 0.14, ellip: 0.22, angleRad:  0.42, tempK: 4100 }),
    Object.freeze({ x:  1.48, y: -0.58, z: -0.55, bFrac: 0.22, coreFrac: 0.14, ellip: 0.28, angleRad: -0.65, tempK: 3850 }),
    Object.freeze({ x:  0.55, y:  1.42, z:  0.65, bFrac: 0.18, coreFrac: 0.12, ellip: 0.18, angleRad:  1.10, tempK: 4350 }),
    Object.freeze({ x: -1.62, y: -1.05, z: -0.40, bFrac: 0.20, coreFrac: 0.13, ellip: 0.30, angleRad: -0.25, tempK: 3700 }),
    Object.freeze({ x:  2.15, y:  1.10, z: -0.75, bFrac: 0.16, coreFrac: 0.12, ellip: 0.24, angleRad:  0.80, tempK: 4500 }),
    Object.freeze({ x: -0.42, y: -1.85, z:  0.60, bFrac: 0.17, coreFrac: 0.13, ellip: 0.20, angleRad: -1.05, tempK: 3950 }),
  ]),
});

const DEG2RAD = Math.PI / 180;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Computes C-infinity smooth NFW projection functions g(x), F(x), and h_psi(x)
 * across all x > 0 using exact analytic branches and Taylor matching near x = 1.
 *
 * g(x)   = ln(x/2) + C(x)
 * F(x)   = (1 - C(x)) / (x^2 - 1)
 * h_psi  = ln^2(x/2) + (x^2 - 1) * C(x)^2    [satisfies dh_psi/dx = 2*g(x)/x]
 */
export function evalNfwFunctions(rawX) {
  const x = Math.max(rawX, 1e-4);
  const lnHalfX = Math.log(0.5 * x);
  const d = x - 1.0;

  let C;
  let F;
  if (Math.abs(d) < 0.02) {
    // Exact Taylor series of C(1 + d) = acosh(1/x)/sqrt(1-x^2) = acos(1/x)/sqrt(x^2-1)
    C = 1.0 + d * (-2.0 / 3.0 + d * (7.0 / 15.0 + d * (-12.0 / 35.0 + d * (83.0 / 315.0))));
    F = (2.0 / 3.0 + d * (-7.0 / 15.0 + d * (12.0 / 35.0 - d * (83.0 / 315.0)))) / (2.0 + d);
  } else if (x < 1.0) {
    const oneMinusX2 = 1.0 - x * x;
    const sq = Math.sqrt(oneMinusX2);
    C = Math.acosh(1.0 / x) / sq;
    F = (C - 1.0) / oneMinusX2;
  } else {
    const x2Minus1 = x * x - 1.0;
    const sq = Math.sqrt(x2Minus1);
    C = Math.acos(1.0 / x) / sq;
    F = (1.0 - C) / x2Minus1;
  }

  const g = lnHalfX + C;
  const hPsi = lnHalfX * lnHalfX + (x * x - 1.0) * C * C;
  return { g, F, hPsi };
}

/**
 * Evaluates a softened isothermal sphere / Keeton SIE component at (tx, ty)
 * with Einstein radius scale b, minor-to-major axis ratio q, core s, orientation angleRad.
 */
function addSoftenedSie(acc, tx, ty, b, q, s, angleRad) {
  const c = Math.cos(angleRad);
  const si = Math.sin(angleRad);
  const xp = c * tx + si * ty;
  const yp = -si * tx + c * ty;

  const qClamped = clamp(q, 0.25, 1.0);
  const q2 = qClamped * qClamped;
  const qp2 = 1.0 - q2;
  const psiK = Math.sqrt(q2 * (s * s + xp * xp) + yp * yp + 1e-12);

  let axp;
  let ayp;
  let dPsi;
  let pxxp;
  let pyyp;
  let pxyp;

  if (qp2 < 1e-6) {
    // Axisymmetric SIS with core s
    const denom = psiK + s;
    const invD = 1.0 / Math.max(denom, 1e-7);
    const invPsi = 1.0 / Math.max(psiK, 1e-7);
    axp = b * xp * invD;
    ayp = b * yp * invD;
    const r2 = xp * xp + yp * yp + s * s;
    dPsi = b * (Math.sqrt(r2) - s - s * Math.log(0.5 * (psiK + s) / Math.max(s, 1e-6)));
    pxxp = b * invD * (1.0 - xp * xp * invPsi * invD);
    pyyp = b * invD * (1.0 - yp * yp * invPsi * invD);
    pxyp = -b * xp * yp * invPsi * invD * invD;
  } else {
    const qp = Math.sqrt(qp2);
    const ps = psiK + s;
    const pqs = psiK + q2 * s;
    const bSqrtQ = b * Math.sqrt(qClamped);
    axp = (bSqrtQ / qp) * Math.atan((qp * xp) / Math.max(ps, 1e-7));
    ayp = (bSqrtQ / qp) * Math.atanh(clamp((qp * yp) / Math.max(pqs, 1e-7), -0.999999, 0.999999));

    const dK = Math.max(xp * xp + yp * yp + (1.0 + q2) * s * s + 2.0 * s * psiK, 1e-9);
    const invPsiDk = 1.0 / Math.max(psiK * dK, 1e-10);
    // Curl-free Keeton potential (shifted by finite constant at origin)
    const refDk = (1.0 + q2) * s * s + 2.0 * s * qClamped * s;
    dPsi = xp * axp + yp * ayp - 0.5 * bSqrtQ * s * Math.log(Math.max(dK / Math.max(refDk, 1e-12), 1e-12));

    pxxp = bSqrtQ * (q2 * s * s + yp * yp + s * psiK) * invPsiDk;
    pyyp = bSqrtQ * (xp * xp + s * s + s * psiK) * invPsiDk;
    pxyp = -bSqrtQ * xp * yp * invPsiDk;
  }

  acc.psi += dPsi;
  acc.ax += c * axp - si * ayp;
  acc.ay += si * axp + c * ayp;

  const c2 = c * c;
  const s2 = si * si;
  const cs = c * si;
  acc.psiXX += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
  acc.psiYY += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
  acc.psiXY += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;
}

/**
 * Evaluates full analytical lensing potential, deflection vector, Hessian,
 * convergence kappa, shear gamma, Jacobian eigenvalues lambdaT/lambdaR,
 * and scalar magnification mu at angular coordinate (tx, ty) [arcsec].
 */
export function evalLensField(tx, ty, params = {}) {
  const lensModel = (params.lensModel | 0);
  const thetaE = Math.max(0.25, Number(params.einsteinRadius) || 2.85);
  const ellip = clamp(Number(params.ellipticity) || 0.0, 0.0, 0.72);
  const extShear = clamp(Number(params.extShear) || 0.0, 0.0, 0.40);
  const lensAngleRad = (Number(params.lensAngleDeg) || 0.0) * DEG2RAD;
  const shearAngleRad = (Number(params.shearAngleDeg) || 0.0) * DEG2RAD;
  const subhaloStrength = clamp(Number(params.subhaloStrength) || 0.0, 0.0, 3.0);

  const acc = {
    psi: 0.0,
    ax: 0.0,
    ay: 0.0,
    psiXX: 0.0,
    psiYY: 0.0,
    psiXY: 0.0,
  };

  if (lensModel === 0) {
    // Model 0: Point-Mass / Schwarzschild Lens with tiny numerical softening
    const eps = LENS_CONSTANTS.POINT_SOFTENING_FRAC * thetaE;
    const r2 = tx * tx + ty * ty + eps * eps;
    const te2 = thetaE * thetaE;
    const invR2 = 1.0 / r2;
    const invR4 = invR2 * invR2;

    acc.psi += 0.5 * te2 * Math.log(r2 / Math.max(eps * eps, 1e-12));
    acc.ax += te2 * tx * invR2;
    acc.ay += te2 * ty * invR2;
    acc.psiXX += te2 * (r2 - 2.0 * tx * tx) * invR4;
    acc.psiYY += te2 * (r2 - 2.0 * ty * ty) * invR4;
    acc.psiXY += -2.0 * te2 * tx * ty * invR4;
  } else if (lensModel === 1) {
    // Model 1: Singular Isothermal Ellipsoid (SIE)
    const q = clamp(1.0 - ellip, 0.25, 1.0);
    const s = LENS_CONSTANTS.SIE_CORE_FRAC * thetaE;
    addSoftenedSie(acc, tx, ty, thetaE, q, s, lensAngleRad);
  } else {
    // Model 2: Pseudo-Elliptical NFW Dark Matter Halo + 6 Foreground Subhalos
    const c = Math.cos(lensAngleRad);
    const si = Math.sin(lensAngleRad);
    const xp = c * tx + si * ty;
    const yp = -si * tx + c * ty;

    const q = clamp(1.0 - ellip, 0.30, 1.0);
    const q2 = q * q;
    const q4 = q2 * q2;
    const rs = LENS_CONSTANTS.NFW_RS_RATIO * thetaE;
    const core = LENS_CONSTANTS.NFW_CORE_FRAC * thetaE;
    const xE = thetaE / rs;
    const gXE = evalNfwFunctions(xE).g;
    // Scale 4*kappa_s so radial circular deflection equals theta_E at r = theta_E
    const fourKs = (thetaE * xE) / Math.max(rs * gXE, 1e-8);

    const R2 = q2 * xp * xp + yp * yp + core * core;
    const R = Math.sqrt(R2);
    const u = R / rs;
    const nfw = evalNfwFunctions(u);

    const psiNorm = 0.5 * fourKs * rs * rs;
    const a1 = fourKs * (nfw.g / (u * u));
    const kappaRad = 0.5 * fourKs * nfw.F;
    const a2 = (2.0 * (kappaRad - a1)) / Math.max(R2, 1e-9);

    acc.psi += psiNorm * nfw.hPsi;
    const axp = a1 * q2 * xp;
    const ayp = a1 * yp;
    acc.ax += c * axp - si * ayp;
    acc.ay += si * axp + c * ayp;

    const pxxp = q2 * a1 + q4 * xp * xp * a2;
    const pyyp = a1 + yp * yp * a2;
    const pxyp = q2 * xp * yp * a2;

    const c2 = c * c;
    const s2 = si * si;
    const cs = c * si;
    acc.psiXX += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
    acc.psiYY += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
    acc.psiXY += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;

    if (subhaloStrength > 1e-5) {
      const clusterScale = thetaE / 2.85;
      for (let i = 0; i < LENS_CONSTANTS.SUBHALOS.length; i++) {
        const sh = LENS_CONSTANTS.SUBHALOS[i];
        const sx0 = sh.x * clusterScale;
        const sy0 = sh.y * clusterScale;
        const bSh = sh.bFrac * thetaE * subhaloStrength;
        const sSh = sh.coreFrac * thetaE;
        const qSh = clamp(1.0 - sh.ellip, 0.45, 1.0);
        addSoftenedSie(acc, tx - sx0, ty - sy0, bSh, qSh, sSh, sh.angleRad);
      }
    }
  }

  // External tidal shear contribution:
  // psi_ext = (gamma/2) * ( (tx^2 - ty^2)*cos(2 phi) + 2*tx*ty*sin(2 phi) )
  if (extShear > 1e-6) {
    const g1 = extShear * Math.cos(2.0 * shearAngleRad);
    const g2 = extShear * Math.sin(2.0 * shearAngleRad);
    acc.psi += 0.5 * (g1 * (tx * tx - ty * ty) + 2.0 * g2 * tx * ty);
    acc.ax += g1 * tx + g2 * ty;
    acc.ay += g2 * tx - g1 * ty;
    acc.psiXX += g1;
    acc.psiYY -= g1;
    acc.psiXY += g2;
  }

  const kappa = 0.5 * (acc.psiXX + acc.psiYY);
  const gamma1 = 0.5 * (acc.psiXX - acc.psiYY);
  const gamma2 = acc.psiXY;
  const gamma = Math.hypot(gamma1, gamma2);

  // Jacobian A_ij = delta_ij - Psi_ij
  const a11 = 1.0 - acc.psiXX;
  const a22 = 1.0 - acc.psiYY;
  const a12 = -acc.psiXY;
  const detA = a11 * a22 - a12 * a12;
  const lambdaT = 1.0 - kappa - gamma;
  const lambdaR = 1.0 - kappa + gamma;
  const mu = 1.0 / Math.max(Math.abs(detA), 1e-3);

  return {
    psi: acc.psi,
    ax: acc.ax,
    ay: acc.ay,
    psiXX: acc.psiXX,
    psiYY: acc.psiYY,
    psiXY: acc.psiXY,
    kappa,
    gamma1,
    gamma2,
    gamma,
    detA,
    lambdaT,
    lambdaR,
    mu,
  };
}

/**
 * Evaluates dimensionless Fermat arrival-time surface tau(theta; beta) in arcsec^2.
 */
export function evalFermatPotential(tx, ty, sx, sy, params = {}) {
  const field = evalLensField(tx, ty, params);
  const dx = tx - sx;
  const dy = ty - sy;
  return 0.5 * (dx * dx + dy * dy) - field.psi;
}

/**
 * Exact Paczynski analytical formulas for an axisymmetric unsheared Point-Mass lens.
 */
export function evalPointMassExact(uNorm, thetaE) {
  const u = Math.max(Math.abs(uNorm), 1e-4);
  const sq = Math.sqrt(u * u + 4.0);
  const thetaPlus = 0.5 * thetaE * (u + sq);
  const thetaMinus = 0.5 * thetaE * (u - sq);
  const muTot = (u * u + 2.0) / (u * sq);
  const muPlus = 0.5 * (muTot + 1.0);
  const muMinus = 0.5 * (1.0 - muTot); // Negative parity
  const dTauDimless = 0.5 * u * sq + Math.log((sq + u) / (sq - u));
  const deltaTauArcsec2 = thetaE * thetaE * dTauDimless;
  return {
    u,
    thetaPlus,
    thetaMinus,
    muTot,
    muPlus,
    muMinus,
    deltaTauArcsec2,
    timeDelayDays: LENS_CONSTANTS.TIME_DELAY_DAYS_PER_ARCSEC2 * deltaTauArcsec2,
  };
}

/**
 * Finds all lensed images of point source (sourceX, sourceY) by scanning a 28x28 grid
 * over [-3.2*thetaE, +3.2*thetaE]^2 and polishing local minima with damped Newton-Raphson.
 */
export function solveLensedImages(params = {}) {
  const thetaE = Math.max(0.25, Number(params.einsteinRadius) || 2.85);
  const sx = Number(params.sourceX) || 0.0;
  const sy = Number(params.sourceY) || 0.0;
  const extShear = Math.max(0.0, Number(params.extShear) || 0.0);
  const lensModel = (params.lensModel | 0);
  const offset = Math.hypot(sx, sy);

  // Axisymmetric Einstein ring special case
  if (lensModel === 0 && extShear < 1e-4 && offset < 0.02 * thetaE) {
    const uEff = Math.max(offset / thetaE, 0.015);
    const ex = evalPointMassExact(uEff, thetaE);
    return {
      isEinsteinRing: true,
      images: [
        { x: thetaE, y: 0.0, mu: ex.muPlus, parity: 1, tau: evalFermatPotential(thetaE, 0.0, sx, sy, params) },
        { x: -thetaE, y: 0.0, mu: Math.abs(ex.muMinus), parity: -1, tau: evalFermatPotential(-thetaE, 0.0, sx, sy, params) },
      ],
      totalMag: ex.muTot,
      timeDelayDays: 0.0,
    };
  }

  const N = 40;
  const extent = 3.1 * thetaE;
  const step = (2.0 * extent) / (N - 1);
  const rxGrid = new Float64Array(N * N);
  const ryGrid = new Float64Array(N * N);
  const err2Grid = new Float64Array(N * N);

  for (let iy = 0; iy < N; iy++) {
    const ty = -extent + iy * step;
    for (let ix = 0; ix < N; ix++) {
      const tx = -extent + ix * step;
      const f = evalLensField(tx, ty, params);
      const rx = tx - f.ax - sx;
      const ry = ty - f.ay - sy;
      const idx = iy * N + ix;
      rxGrid[idx] = rx;
      ryGrid[idx] = ry;
      err2Grid[idx] = rx * rx + ry * ry;
    }
  }

  const seeds = [];
  for (let iy = 0; iy < N - 1; iy++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const i00 = iy * N + ix;
      const i10 = i00 + 1;
      const i01 = i00 + N;
      const i11 = i01 + 1;
      const rxMin = Math.min(rxGrid[i00], rxGrid[i10], rxGrid[i01], rxGrid[i11]);
      const rxMax = Math.max(rxGrid[i00], rxGrid[i10], rxGrid[i01], rxGrid[i11]);
      const ryMin = Math.min(ryGrid[i00], ryGrid[i10], ryGrid[i01], ryGrid[i11]);
      const ryMax = Math.max(ryGrid[i00], ryGrid[i10], ryGrid[i01], ryGrid[i11]);
      if (rxMin <= 0.0 && rxMax >= 0.0 && ryMin <= 0.0 && ryMax >= 0.0) {
        const cx = -extent + (ix + 0.5) * step;
        const cy = -extent + (iy + 0.5) * step;
        const v = Math.min(err2Grid[i00], err2Grid[i10], err2Grid[i01], err2Grid[i11]);
        seeds.push([cx, cy, v]);
      }
    }
  }

  // Also add local minima and polar ring seeds around the tangential/radial critical curves
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const v = err2Grid[iy * N + ix];
      let isLocalMin = true;
      for (let dy = -1; dy <= 1 && isLocalMin; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ix + dx;
          const ny = iy + dy;
          if (nx >= 0 && nx < N && ny >= 0 && ny < N) {
            if (err2Grid[ny * N + nx] < v) {
              isLocalMin = false;
              break;
            }
          }
        }
      }
      if (isLocalMin) {
        seeds.push([(-extent + ix * step), (-extent + iy * step), v]);
      }
    }
  }
  for (const rFrac of [0.45, 0.85, 1.0, 1.18, 1.5]) {
    const rSeed = rFrac * thetaE;
    for (let k = 0; k < 24; k++) {
      const ang = (k * 2.0 * Math.PI) / 24.0;
      seeds.push([sx + rSeed * Math.cos(ang), sy + rSeed * Math.sin(ang), 1.0]);
    }
  }
  seeds.sort((a, b) => a[2] - b[2]);

  const found = [];
  const resTol2 = (1e-4 * thetaE) * (1e-4 * thetaE);
  const mergeDist2 = (0.04 * thetaE) * (0.04 * thetaE);

  for (let sIdx = 0; sIdx < seeds.length; sIdx++) {
    let tx = seeds[sIdx][0];
    let ty = seeds[sIdx][1];
    let converged = false;

    for (let iter = 0; iter < 20; iter++) {
      const f = evalLensField(tx, ty, params);
      const rx = tx - f.ax - sx;
      const ry = ty - f.ay - sy;
      const r2 = rx * rx + ry * ry;
      if (r2 < resTol2) {
        converged = true;
        break;
      }

      const a11 = 1.0 - f.psiXX;
      const a22 = 1.0 - f.psiYY;
      const a12 = -f.psiXY;
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-8) break;

      const dtx = (a22 * rx - a12 * ry) / det;
      const dty = (-a12 * rx + a11 * ry) / det;
      const stepLen = Math.hypot(dtx, dty);
      const maxStep = 0.75 * step;
      const scale = stepLen > maxStep ? maxStep / stepLen : 1.0;
      tx -= dtx * scale;
      ty -= dty * scale;

      if (Math.hypot(tx, ty) > 4.5 * thetaE) break;
    }

    if (!converged) continue;
    const fFinal = evalLensField(tx, ty, params);
    const rx = tx - fFinal.ax - sx;
    const ry = ty - fFinal.ay - sy;
    if (rx * rx + ry * ry >= resTol2) continue;

    let duplicate = false;
    for (let k = 0; k < found.length; k++) {
      const dx = tx - found[k].x;
      const dy = ty - found[k].y;
      if (dx * dx + dy * dy < mergeDist2) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    // Exclude ultra-demagnified central core image below observational threshold
    const absMu = 1.0 / Math.max(Math.abs(fFinal.detA), 1e-3);
    if (absMu < 0.04) continue;

    const tau = evalFermatPotential(tx, ty, sx, sy, params);
    found.push({
      x: tx,
      y: ty,
      mu: Math.min(absMu, 85.0),
      parity: fFinal.detA >= 0 ? 1 : -1,
      tau,
    });
  }

  let totalMag = 0.0;
  let tauMin = Infinity;
  let tauMax = -Infinity;
  for (let i = 0; i < found.length; i++) {
    totalMag += found[i].mu;
    if (found[i].tau < tauMin) tauMin = found[i].tau;
    if (found[i].tau > tauMax) tauMax = found[i].tau;
  }
  totalMag = clamp(totalMag, 1.0, 250.0);
  const deltaTau = found.length >= 2 ? Math.max(0.0, tauMax - tauMin) : 0.0;

  return {
    isEinsteinRing: false,
    images: found,
    totalMag,
    timeDelayDays: LENS_CONSTANTS.TIME_DELAY_DAYS_PER_ARCSEC2 * deltaTau,
  };
}

/**
 * Computes full physical telemetry for the HUD & unit tests.
 */
export function computeLensTelemetry(state = {}) {
  const lensModel = (state.lensModel | 0);
  const lensModelLabel = LENS_MODEL_LABELS[lensModel] || 'NFW Cluster';
  const thetaE = Math.max(0.25, Number(state.einsteinRadius) || 2.85);
  const sx = Number(state.sourceX) || 0.0;
  const sy = Number(state.sourceY) || 0.0;
  const sourceOffsetArcsec = Math.hypot(sx, sy);

  const solved = solveLensedImages(state);
  const totalMagnification = solved.totalMag;
  const imageCount = solved.isEinsteinRing ? 1 : solved.images.length;

  let multiplicityLabel;
  if (solved.isEinsteinRing) {
    multiplicityLabel = 'Ring';
  } else if (imageCount === 2) {
    multiplicityLabel = '2 (Double)';
  } else if (imageCount === 3) {
    multiplicityLabel = '3 (Cusp)';
  } else if (imageCount === 4) {
    multiplicityLabel = '4 (Quad)';
  } else if (imageCount >= 5) {
    multiplicityLabel = `${imageCount} (Cluster)`;
  } else {
    multiplicityLabel = `${Math.max(1, imageCount)} (Single)`;
  }

  // Enclosed lens mass M(< theta_E) inside Einstein radius (scaled for NFW/SIE halo richness)
  const subhaloBoost = lensModel === 2 ? 1.0 + 0.08 * (Number(state.subhaloStrength) || 0.0) : 1.0;
  const enclosedMass1e12Msun =
    LENS_CONSTANTS.MASS_PER_ARCSEC2_1E12_MSUN * thetaE * thetaE * subhaloBoost;

  const isNearCaustic = solved.images.some((im) => im.mu >= 18.0) || solved.isEinsteinRing;

  return {
    lensModel,
    lensModelLabel,
    einsteinRadiusArcsec: thetaE,
    enclosedMass1e12Msun,
    totalMagnification,
    imageCount,
    multiplicityLabel,
    timeDelayDays: solved.timeDelayDays,
    sourceOffsetArcsec,
    isEinsteinRing: solved.isEinsteinRing,
    isNearCaustic,
    images: solved.images,
  };
}
