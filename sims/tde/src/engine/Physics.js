/**
 * Physics.js — Relativistic Tidal Disruption Event (TDE) physics, Hills criterion,
 * Rees–Phinney t^(-5/3) fallback luminosity, Kerr–Schild apsidal precession,
 * self-intersection nozzle shock geometry, CPU RK4 light-bending verifier,
 * and zero-allocation GPU uniform writer.
 */

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export const TDE_CONSTANTS = Object.freeze({
  RT_COEFF_SOLAR: 47.1,       // r_t / r_g for M6 = 1, 1 M_sun, 1 R_sun star
  HILLS_COEFF_M6: 110.0,      // M_Hills in 10^6 M_sun for solar star around Schwarzschild BH
  T_FB_DAYS_SOLAR: 41.0,      // Fallback timescale for 10^6 M_sun, 1 M_sun star
  MDOT_EDD_SOLAR: 133.0,      // Peak fallback Mdot / Mdot_Edd for M6 = 1, solar star
});

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Main-sequence mass-radius approximation R_* / R_sun = (M_* / M_sun)^0.8.
 */
export function stellarRadiusSolar(starMassSolar = 1.0) {
  const m = clamp(Number.isFinite(Number(starMassSolar)) ? Number(starMassSolar) : 1.0, 0.1, 25.0);
  return Math.pow(m, 0.8);
}

/**
 * Kerr outer event horizon r_+ / r_g = 1 + sqrt(1 - a^2) and prograde ISCO.
 */
export function computeKerrRadii(spin = 0.72) {
  const a = clamp(Number.isFinite(Number(spin)) ? Number(spin) : 0.72, 0.0, 0.998);
  const a2 = a * a;
  const horizonR = 1.0 + Math.sqrt(Math.max(0.0, 1.0 - a2));
  const c1 = Math.cbrt(Math.max(1.0 - a2, 1e-7));
  const c2 = Math.cbrt(1.0 + a) + Math.cbrt(Math.max(1.0 - a, 1e-7));
  const z1 = 1.0 + c1 * c2;
  const z2 = Math.sqrt(3.0 * a2 + z1 * z1);
  const iscoR = 3.0 + z2 - Math.sqrt(Math.max(0.0, (3.0 - z1) * (3.0 + z1 + 2.0 * z2)));
  // Prograde Innermost Bound Circular Orbit r_ibco = 2 - a + 2*sqrt(1 - a)
  const ibcoR = 2.0 - a + 2.0 * Math.sqrt(Math.max(0.0, 1.0 - a));
  return { a, a2, horizonR, iscoR, ibcoR };
}

/**
 * Computes complete physical & visual TDE telemetry.
 */
export function computeTdeTelemetry(state = {}) {
  const bhMassM6 = clamp(Number.isFinite(Number(state.bhMassM6)) ? Number(state.bhMassM6) : 3.2, 0.2, 150.0);
  const starMassSolar = clamp(
    Number.isFinite(Number(state.starMassSolar)) ? Number(state.starMassSolar) : 1.0,
    0.1,
    15.0
  );
  const beta = clamp(Number.isFinite(Number(state.beta)) ? Number(state.beta) : 1.65, 0.4, 7.0);
  const tdePhase = clamp(Number.isFinite(Number(state.tdePhase)) ? Number(state.tdePhase) : 0.56, 0.02, 1.0);
  const streamTiltDeg = clamp(
    Number.isFinite(Number(state.streamTiltDeg)) ? Number(state.streamTiltDeg) : 8.0,
    -35.0,
    35.0
  );

  const { a, a2, horizonR, iscoR, ibcoR } = computeKerrRadii(state.spin ?? 0.72);
  const rStar = stellarRadiusSolar(starMassSolar);

  // Physical tidal radius and pericenter in r_g = GM/c^2
  const rTidalRg =
    TDE_CONSTANTS.RT_COEFF_SOLAR *
    Math.pow(bhMassM6, -2.0 / 3.0) *
    (rStar / Math.cbrt(starMassSolar));
  const rPeriRg = Math.max(0.5, rTidalRg / beta);

  // Hills Mass Limit (in 10^6 M_sun): if BH exceeds this, star crosses r_ibco before disruption
  const hillsMassM6 =
    TDE_CONSTANTS.HILLS_COEFF_M6 *
    Math.pow(rStar, 1.5) *
    Math.pow(starMassSolar, -0.5) *
    Math.pow(4.0 / Math.max(ibcoR, 1.0), 1.5);
  const swallowedDirect = rPeriRg <= ibcoR;

  // 1PN + Kerr spin relativistic apsidal precession per orbit (radians)
  const rPrecessEff = Math.max(rPeriRg, horizonR * 1.45);
  const precessRadPhys =
    ((6.0 * Math.PI) / rPrecessEff) * (1.0 - (4.0 * a) / (3.0 * Math.sqrt(rPrecessEff)));
  const precessDeg = clamp(precessRadPhys * RAD2DEG, 8.0, 170.0);
  const precessRadVis = clamp(0.32 + 0.0115 * precessDeg, 0.35, 2.25);

  // Rees-Phinney t^(-5/3) fallback timescale and Eddington accretion rate
  const fallbackTimeDays =
    TDE_CONSTANTS.T_FB_DAYS_SOLAR *
    Math.sqrt(bhMassM6) *
    (Math.pow(rStar, 1.5) / starMassSolar);
  const peakEddington =
    TDE_CONSTANTS.MDOT_EDD_SOLAR *
    Math.pow(bhMassM6, -1.5) *
    (Math.pow(starMassSolar, 2.0) / Math.pow(rStar, 1.5)) *
    Math.pow(beta, 0.25);

  // Phase-dependent fallback lightcurve: rises over tdePhase 0..0.42 then decays ~ t^(-5/3)
  const tauNorm = Math.max(tdePhase / 0.42, 0.15);
  const lightcurveFactor =
    tdePhase <= 0.42
      ? Math.pow(clamp(tdePhase / 0.42, 0.02, 1.0), 1.65)
      : Math.pow(tauNorm, -5.0 / 3.0);
  const eddingtonRatio = swallowedDirect ? 0.02 : Math.max(0.01, peakEddington * lightcurveFactor);

  // Visual orbital geometry in shader units (G=c=M=1 scale for crystal-clear lensing near r+)
  const rpVis = Math.max(horizonR * 1.55, 8.4 / Math.pow(beta, 0.56));
  const ecc = clamp(0.68 + 0.06 * Math.min(beta, 2.5) - 0.14 * tdePhase, 0.46, 0.84);
  const semiLatus = rpVis * (1.0 + ecc);

  // Self-intersection radius where outgoing and returning precessed ellipses cross: psi_int = pi - deltaPhi/2
  const halfPrec = 0.5 * precessRadVis;
  const rShockVis = semiLatus / Math.max(1.0 + ecc * Math.cos(Math.PI - halfPrec), 0.18);
  const shockAngle = Math.PI - halfPrec;
  const shockPosLocal = [
    rShockVis * Math.cos(shockAngle),
    0.0,
    rShockVis * Math.sin(shockAngle),
  ];

  // Stream collision speed and optical/UV nozzle shock temperature
  const shockVelocityC = clamp(Math.sqrt(2.0 / Math.max(rPrecessEff, 2.2)) * Math.sin(halfPrec), 0.02, 0.58);
  const shockTempK = clamp(16000.0 + 48000.0 * shockVelocityC * Math.pow(beta, 0.25), 14000.0, 42000.0);

  // Bound stellar core position advancing along Keplerian arc for early phases
  const coreAnomaly = -1.35 + tdePhase * 2.95;
  const rCoreVis = semiLatus / Math.max(1.0 + ecc * Math.cos(coreAnomaly), 0.22);
  const corePosLocal = [
    rCoreVis * Math.cos(coreAnomaly),
    0.0,
    rCoreVis * Math.sin(coreAnomaly),
  ];
  const coreRadiusVis = clamp(0.78 * Math.pow(starMassSolar, 0.15) * (1.0 - 0.55 * tdePhase), 0.22, 1.25);

  return {
    bhMassM6,
    starMassSolar,
    beta,
    tdePhase,
    streamTiltRad: streamTiltDeg * DEG2RAD,
    spin: a,
    spin2: a2,
    horizonR,
    iscoR,
    ibcoR,
    rTidalRg,
    rPeriRg,
    hillsMassM6,
    swallowedDirect,
    precessDeg,
    precessRadVis,
    fallbackTimeDays,
    eddingtonRatio,
    peakEddington,
    rpVis,
    ecc,
    semiLatus,
    rShockVis,
    shockPosLocal,
    shockVelocityC,
    shockTempK,
    corePosLocal,
    coreRadiusVis,
  };
}

function rotateLocalTilt(vec, tiltRad) {
  const c = Math.cos(tiltRad);
  const s = Math.sin(tiltRad);
  return [vec[0], vec[1] * c - vec[2] * s, vec[1] * s + vec[2] * c];
}

/**
 * Zero-allocation frame constants writer for both WebGL2 and WebGPU TDE renderers.
 * Packs 10 vec4f blocks (40 floats starting at `offset`):
 *   +0..15:  zamoE0..zamoE3 (4D Lorentzian Gram-Schmidt ZAMO tetrad)
 *   +16..19: camKS_l_2H (lx, ly, lz, 2.0 * H)
 *   +20..23: kerrConsts (rPlus, rIsco, rOuter, tanHalfFov)
 *   +24..27: rayConsts  (escapeR, captureR, maxSlabY, streamEcc)
 *   +28..31: shockPosConsts (shockX, shockY, shockZ, shockTempK)
 *   +32..35: starCoreConsts (coreX, coreY, coreZ, coreRadius)
 *   +36..39: skyTrig    (cosRotX, sinRotX, cosRotY, sinRotY)
 */
export function writeTdeFrameConstants(outF32, offset, state, camData) {
  const tel = computeTdeTelemetry(state);
  const a = tel.spin;
  const a2 = tel.spin2;
  const lensing = clamp(Number.isFinite(Number(state.lensingStrength)) ? Number(state.lensingStrength) : 1.0, 0.0, 1.0);
  const rPlus = tel.horizonR;
  const rIsco = tel.iscoR;
  const rOuter = clamp(tel.rpVis * 2.35 + 4.5, rIsco + 4.0, 26.0);
  const tanHalfFov = Math.tan(clamp(camData.fovY, 0.1, 2.8) * 0.5);

  const px = camData.pos[0];
  const py = camData.pos[1];
  const pz = camData.pos[2];
  const uVal = px * px + py * py + pz * pz - a2;
  const disc = Math.sqrt(Math.max(uVal * uVal + 4.0 * a2 * py * py, 1e-12));
  const cr2 = Math.max(0.5 * (uVal + disc), 1e-8);
  const cr = Math.sqrt(cr2);
  const cD = cr2 * cr2 + a2 * py * py;
  const cH = (lensing * (cr * cr2)) / Math.max(cD, 1e-10);
  const cR2 = cr2 + a2;
  const cinvR2 = 1.0 / Math.max(cR2, 1e-8);
  const lx = (cr * px + a * pz) * cinvR2;
  const ly = py / Math.max(cr, 1e-5);
  const lz = (cr * pz - a * px) * cinvR2;
  const twoH = 2.0 * cH;

  const rho2 = px * px + pz * pz;
  const omega = (twoH * a * cR2) / Math.max(cR2 * cR2 + twoH * a2 * rho2, 1e-8);
  const vzx = omega * pz;
  const vzz = -omega * px;
  const lPhi = (a * rho2) / Math.max(cR2, 1e-8);
  const oneMinusWl = 1.0 - omega * lPhi;
  const normSq = Math.max(1.0 - (vzx * vzx + vzz * vzz) - twoH * oneMinusWl * oneMinusWl, 1e-5);
  const ut = 1.0 / Math.sqrt(normSq);
  const e00 = ut;
  const e01 = ut * vzx;
  const e02 = 0.0;
  const e03 = ut * vzz;
  const le0 = -e00 + lx * e01 + ly * e02 + lz * e03;

  const basis = camData.basis;

  let f40 = 0.0;
  let f41 = basis[6];
  let f42 = basis[7];
  let f43 = basis[8];
  const lf4 = lx * f41 + ly * f42 + lz * f43;
  const df0 = f41 * e01 + f42 * e02 + f43 * e03 + twoH * lf4 * le0;
  f40 += df0 * e00;
  f41 += df0 * e01;
  f42 += df0 * e02;
  f43 += df0 * e03;
  const lf4n = -f40 + lx * f41 + ly * f42 + lz * f43;
  const f4LenSq = -f40 * f40 + f41 * f41 + f42 * f42 + f43 * f43 + twoH * lf4n * lf4n;
  const f4InvLen = 1.0 / Math.sqrt(Math.max(f4LenSq, 1e-8));
  const e30 = f40 * f4InvLen;
  const e31 = f41 * f4InvLen;
  const e32 = f42 * f4InvLen;
  const e33 = f43 * f4InvLen;
  const le3 = -e30 + lx * e31 + ly * e32 + lz * e33;

  let r40 = 0.0;
  let r41 = basis[0];
  let r42 = basis[1];
  let r43 = basis[2];
  const lr4 = lx * r41 + ly * r42 + lz * r43;
  const dr0 = r41 * e01 + r42 * e02 + r43 * e03 + twoH * lr4 * le0;
  const dr3 = r41 * e31 + r42 * e32 + r43 * e33 + twoH * lr4 * le3;
  r40 += dr0 * e00 - dr3 * e30;
  r41 += dr0 * e01 - dr3 * e31;
  r42 += dr0 * e02 - dr3 * e32;
  r43 += dr0 * e03 - dr3 * e33;
  const lr4n = -r40 + lx * r41 + ly * r42 + lz * r43;
  const r4LenSq = -r40 * r40 + r41 * r41 + r42 * r42 + r43 * r43 + twoH * lr4n * lr4n;
  const r4InvLen = 1.0 / Math.sqrt(Math.max(r4LenSq, 1e-8));
  const e10 = r40 * r4InvLen;
  const e11 = r41 * r4InvLen;
  const e12 = r42 * r4InvLen;
  const e13 = r43 * r4InvLen;
  const le1 = -e10 + lx * e11 + ly * e12 + lz * e13;

  let u40 = 0.0;
  let u41 = basis[3];
  let u42 = basis[4];
  let u43 = basis[5];
  const lu4 = lx * u41 + ly * u42 + lz * u43;
  const du0 = u41 * e01 + u42 * e02 + u43 * e03 + twoH * lu4 * le0;
  const du3 = u41 * e31 + u42 * e32 + u43 * e33 + twoH * lu4 * le3;
  const du1 = u41 * e11 + u42 * e12 + u43 * e13 + twoH * lu4 * le1;
  u40 += du0 * e00 - du3 * e30 - du1 * e10;
  u41 += du0 * e01 - du3 * e31 - du1 * e11;
  u42 += du0 * e02 - du3 * e32 - du1 * e12;
  u43 += du0 * e03 - du3 * e33 - du1 * e13;
  const lu4n = -u40 + lx * u41 + ly * u42 + lz * u43;
  const u4LenSq = -u40 * u40 + u41 * u41 + u42 * u42 + u43 * u43 + twoH * lu4n * lu4n;
  const u4InvLen = 1.0 / Math.sqrt(Math.max(u4LenSq, 1e-8));

  outF32[offset + 0] = e00;
  outF32[offset + 1] = e01;
  outF32[offset + 2] = e02;
  outF32[offset + 3] = e03;

  outF32[offset + 4] = e10;
  outF32[offset + 5] = e11;
  outF32[offset + 6] = e12;
  outF32[offset + 7] = e13;

  outF32[offset + 8] = u40 * u4InvLen;
  outF32[offset + 9] = u41 * u4InvLen;
  outF32[offset + 10] = u42 * u4InvLen;
  outF32[offset + 11] = u43 * u4InvLen;

  outF32[offset + 12] = e30;
  outF32[offset + 13] = e31;
  outF32[offset + 14] = e32;
  outF32[offset + 15] = e33;

  outF32[offset + 16] = lx;
  outF32[offset + 17] = ly;
  outF32[offset + 18] = lz;
  outF32[offset + 19] = twoH;

  outF32[offset + 20] = rPlus;
  outF32[offset + 21] = rIsco;
  outF32[offset + 22] = rOuter;
  outF32[offset + 23] = tanHalfFov;

  const camR = Math.hypot(px, py, pz);
  const escapeR = Math.max(Math.max(rOuter * 2.2, camR * 1.45), 62.0);
  const captureR = rPlus * 1.022;
  const maxSlabY = 2.6 + Math.abs(Math.sin(tel.streamTiltRad)) * 28.0;

  outF32[offset + 24] = escapeR;
  outF32[offset + 25] = captureR;
  outF32[offset + 26] = maxSlabY;
  outF32[offset + 27] = tel.ecc;

  const shockWorld = rotateLocalTilt(tel.shockPosLocal, tel.streamTiltRad);
  outF32[offset + 28] = shockWorld[0];
  outF32[offset + 29] = shockWorld[1];
  outF32[offset + 30] = shockWorld[2];
  outF32[offset + 31] = tel.shockTempK;

  const coreWorld = rotateLocalTilt(tel.corePosLocal, tel.streamTiltRad);
  outF32[offset + 32] = coreWorld[0];
  outF32[offset + 33] = coreWorld[1];
  outF32[offset + 34] = coreWorld[2];
  outF32[offset + 35] = tel.coreRadiusVis;

  const skyRot = state.skyRotation || [0.38, 0.16];
  const rx = skyRot[0] || 0.0;
  const ry = skyRot[1] || 0.0;
  outF32[offset + 36] = Math.cos(rx);
  outF32[offset + 37] = Math.sin(rx);
  outF32[offset + 38] = Math.cos(ry);
  outF32[offset + 39] = Math.sin(ry);
}

/**
 * Reference CPU equatorial Outgoing Kerr-Schild RK4 geodesic integrator for TDE physics_check.mjs.
 */
export function integrateTdeGeodesic(impactParam, spin = 0.72, { camZ = 180.0, maxSteps = 5000 } = {}) {
  const b = Number.isFinite(Number(impactParam)) ? Number(impactParam) : 10.0;
  const a = clamp(Number.isFinite(Number(spin)) ? Number(spin) : 0.72, 0.0, 0.998);
  const a2 = a * a;
  const rHor = 1.0 + Math.sqrt(Math.max(0.0, 1.0 - a2));

  function evalKS(x, y, z) {
    const u = x * x + y * y + z * z - a2;
    const r2 = 0.5 * (u + Math.sqrt(Math.max(1e-12, u * u + 4.0 * a2 * y * y)));
    const r = Math.sqrt(Math.max(r2, 1e-12));
    const denom = r2 + a2;
    const d = r2 * r2 + a2 * y * y;
    const H = (r2 * r) / Math.max(d, 1e-10);
    const lx = (r * x + a * z) / denom;
    const ly = y / r;
    const lz = (r * z - a * x) / denom;
    return { r, r2, H, lx, ly, lz, d, denom };
  }

  let x = b;
  let z = camZ;
  const f0 = evalKS(x, 0.0, z);
  const gtt = -1.0 + 2.0 * f0.H;
  const gtz = -2.0 * f0.H * f0.lz;
  const gzz = 1.0 + 2.0 * f0.H * f0.lz * f0.lz;
  const disc = Math.sqrt(Math.max(0.0, 4.0 * gtz * gtz - 4.0 * gtt * gzz));
  const kt = Math.min((-(-2.0 * gtz) + disc) / (2.0 * gtt), (-(-2.0 * gtz) - disc) / (2.0 * gtt));
  const kz = -1.0;
  const ptRaw = gtt * kt + gtz * kz;
  const invPt = 1.0 / ptRaw;
  let px = (2.0 * f0.H * f0.lx * (-kt + f0.lz * kz)) * invPt;
  let pz = (kz + 2.0 * f0.H * f0.lz * (-kt + f0.lz * kz)) * invPt;

  function rhs(rx, rz, rpx, rpz) {
    const f = evalKS(rx, 0.0, rz);
    const L = 1.0 + f.lx * rpx + f.lz * rpz;
    const twoHL = 2.0 * f.H * L;
    const dx = rpx - twoHL * f.lx;
    const dz = rpz - twoHL * f.lz;
    const invD = 1.0 / Math.max(f.d, 1e-10);
    const invR2 = 1.0 / Math.max(f.denom, 1e-8);
    const gradRx = (f.r * f.r2 * rx) * invD;
    const gradRz = (f.r * f.r2 * rz) * invD;
    const cR = -f.r2 * f.r2;
    const hFac = f.r2 * invD * invD;
    const dHx = hFac * cR * gradRx;
    const dHz = hFac * cR * gradRz;
    const S = (rpx * (rx - 2.0 * f.r * f.lx) + rpz * (rz - 2.0 * f.r * f.lz)) * invR2;
    const wx = (f.r * rpx - a * rpz) * invR2 + S * gradRx;
    const wz = (a * rpx + f.r * rpz) * invR2 + S * gradRz;
    const dpx = L * L * dHx + twoHL * wx;
    const dpz = L * L * dHz + twoHL * wz;
    return { dx, dz, dpx, dpz, r: f.r };
  }

  let prevDx = 0.0;
  let prevDz = -1.0;
  let accumAngle = 0.0;
  let rMin = Infinity;

  for (let step = 0; step < maxSteps; step++) {
    const k1 = rhs(x, z, px, pz);
    if (k1.r < rMin) rMin = k1.r;
    if (k1.r <= rHor * 1.022) {
      return { captured: true, escaped: false, rMin, deflectionDeg: null, steps: step };
    }
    const outbound = x * k1.dx + z * k1.dz > 0.0;
    const h = clamp(0.05 * Math.max(k1.r - 0.85 * rHor, 0.04), 0.008, 2.2);
    const k2 = rhs(x + 0.5 * h * k1.dx, z + 0.5 * h * k1.dz, px + 0.5 * h * k1.dpx, pz + 0.5 * h * k1.dpz);
    const k3 = rhs(x + 0.5 * h * k2.dx, z + 0.5 * h * k2.dz, px + 0.5 * h * k2.dpx, pz + 0.5 * h * k2.dpz);
    const k4 = rhs(x + h * k3.dx, z + h * k3.dz, px + h * k3.dpx, pz + h * k3.dpz);

    x += (h / 6.0) * (k1.dx + 2.0 * k2.dx + 2.0 * k3.dx + k4.dx);
    z += (h / 6.0) * (k1.dz + 2.0 * k2.dz + 2.0 * k3.dz + k4.dz);
    px += (h / 6.0) * (k1.dpx + 2.0 * k2.dpx + 2.0 * k3.dpx + k4.dpx);
    pz += (h / 6.0) * (k1.dpz + 2.0 * k2.dpz + 2.0 * k3.dpz + k4.dpz);

    const kN = rhs(x, z, px, pz);
    const nLen = Math.hypot(kN.dx, kN.dz) || 1.0;
    const ndx = kN.dx / nLen;
    const ndz = kN.dz / nLen;
    const cross = prevDz * ndx - prevDx * ndz;
    const dot = clamp(prevDx * ndx + prevDz * ndz, -1.0, 1.0);
    accumAngle += Math.atan2(cross, dot);
    prevDx = ndx;
    prevDz = ndz;

    const rNow = Math.hypot(x, z);
    if (rNow > camZ * 1.4 && outbound) {
      return {
        captured: false,
        escaped: true,
        rMin,
        deflectionDeg: Math.abs(accumAngle) * RAD2DEG,
        steps: step + 1,
      };
    }
  }

  return { captured: true, escaped: false, rMin, deflectionDeg: null, steps: maxSteps };
}
