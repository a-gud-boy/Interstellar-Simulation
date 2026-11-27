/**
 * Physics.js — Exact Kerr metric relativistic telemetry in geometrised units (G = c = M = 1).
 */

const RAD2DEG = 180 / Math.PI;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Exact Kerr metric relativistic quantities in geometrised units (G = c = M = 1).
 * Exported as a pure function as well for testing/verification.
 */
export function computeKerrTelemetry(spin, radiusEuclidean, elevationRad) {
  const a = clamp(Number.isFinite(spin) ? spin : 0, 0, 0.998);
  const a2 = a * a;

  // Event horizon r+ = 1 + sqrt(1 - a^2)
  const horizonR = 1.0 + Math.sqrt(Math.max(0, 1.0 - a2));

  // Exact Bardeen-Press-Teukolsky (1972) prograde ISCO radius
  const oneMinusA2 = Math.max(0, 1.0 - a2);
  const z1 =
    1.0 +
    Math.cbrt(oneMinusA2) * (Math.cbrt(1.0 + a) + Math.cbrt(Math.max(0, 1.0 - a)));
  const z2 = Math.sqrt(3.0 * a2 + z1 * z1);
  const iscoR = 3.0 + z2 - Math.sqrt(Math.max(0, (3.0 - z1) * (3.0 + z1 + 2.0 * z2)));

  // Exact prograde & retrograde equatorial photon radii (Bardeen 1972)
  const photonProgradeR = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(clamp(-a, -1, 1))));
  const photonRetrogradeR = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(clamp(a, -1, 1))));

  // Convert camera Euclidean Kerr-Schild coordinates to exact Boyer-Lindquist / KS radius r
  const R = Math.max(horizonR + 0.02, radiusEuclidean);
  const y = R * Math.sin(elevationRad);
  const u = R * R - a2;
  const r2 = 0.5 * (u + Math.sqrt(Math.max(0, u * u + 4.0 * a2 * y * y)));
  const r = Math.max(horizonR + 0.02, Math.sqrt(r2));

  const cosTheta = clamp(y / r, -1, 1);
  const sin2Theta = Math.max(0, 1.0 - cosTheta * cosTheta);

  // Kerr metric functions at observer (r, theta)
  const sigma = r * r + a2 * cosTheta * cosTheta;
  const delta = Math.max(1e-5, r * r - 2.0 * r + a2);
  const A = (r * r + a2) * (r * r + a2) - a2 * delta * sin2Theta;

  // ZAMO lapse alpha = sqrt(Sigma * Delta / A); reduces identically to sqrt(1 - 2/r) for a = 0
  const alphaZamo = Math.sqrt(clamp((sigma * delta) / Math.max(A, 1e-6), 1e-6, 1.0));
  const timeDilation = 1.0 / alphaZamo;

  // Local prograde circular orbital velocity v/c measured by a ZAMO (Bardeen-Press-Teukolsky eq. 3.10)
  const rOrb = Math.max(r, photonProgradeR + 1e-3);
  const rOrb2 = rOrb * rOrb;
  const deltaEq = Math.max(1e-6, rOrb2 - 2.0 * rOrb + a2);
  const Aeq = (rOrb2 + a2) * (rOrb2 + a2) - a2 * deltaEq;
  const omegaKepler = 1.0 / (Math.pow(rOrb, 1.5) + a);
  const omegaFrame = (2.0 * a * rOrb) / Math.max(Aeq, 1e-6);
  const orbitalVelocityC = clamp(
    (Aeq / (rOrb2 * Math.sqrt(deltaEq))) * (omegaKepler - omegaFrame),
    0.0,
    0.9999
  );

  // Apparent shadow angular diameter (degrees) using exact critical impact parameter
  // Schwarzschild: b_c = 3*sqrt(3) M = 5.19615 M; Kerr mean shadow radius contracts slightly with a^2
  const bCritMean = 3.0 * Math.sqrt(3.0) * (1.0 - 0.065 * a2);
  const sinHalfShadow = clamp((bCritMean * alphaZamo) / r, 0.0, 1.0);
  let halfAngleRad = Math.asin(sinHalfShadow);
  if (r < 3.0 && a < 0.5) {
    halfAngleRad = Math.PI - halfAngleRad;
  }
  const shadowAngularDeg = 2.0 * halfAngleRad * RAD2DEG;

  return {
    rOverM: r,
    rOverRs: r * 0.5,
    iscoR,
    horizonR,
    photonProgradeR,
    photonRetrogradeR,
    timeDilation,
    orbitalVelocityC,
    shadowAngularDeg,
  };
}

/**
 * Zero-allocation frame constants writer for both WebGL2 and WebGPU Gargantua renderers.
 * Packs 10 vec4f blocks (40 floats starting at `offset`):
 *   +0..15:  zamoE0..zamoE3 (4D Lorentzian Gram-Schmidt ZAMO tetrad)
 *   +16..19: camKS_l_2H (lx, ly, lz, 2.0 * H)
 *   +20..23: kerrConsts (rPlus, rIsco, rOuter, tanHalfFov)
 *   +24..27: rayConsts  (escapeR, captureR, maxDiskSlabY, rPeak)
 *   +28..31: flowConsts (flowBlend, dt0, dt1, globalRot)
 *   +32..35: optConsts  (rPeakComp, extPeakComp, cos(skyRot.x), sin(skyRot.x))
 *   +36..39: skyTrig    (cos(skyRot.y), sin(skyRot.y), 0.0, 0.0)
 */
export function writeBlackholeFrameConstants(outF32, offset, state, camData, simTime) {
  const a = clamp(state.spin, 0.0, 0.998);
  const a2 = a * a;
  const lensing = clamp(state.lensingStrength, 0.0, 1.0);
  const rPlus = 1.0 + Math.sqrt(Math.max(1.0 - a2, 1e-6));

  const c1 = Math.pow(Math.max(1.0 - a2, 1e-7), 1.0 / 3.0);
  const c2 = Math.pow(1.0 + a, 1.0 / 3.0) + Math.pow(Math.max(1.0 - a, 1e-7), 1.0 / 3.0);
  const Z1 = 1.0 + c1 * c2;
  const Z2 = Math.sqrt(3.0 * a2 + Z1 * Z1);
  const rIsco = 3.0 + Z2 - Math.sqrt(Math.max((3.0 - Z1) * (3.0 + Z1 + 2.0 * Z2), 0.0));
  const rOuter = Math.max(state.diskOuterRadius, rIsco + 2.5);
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

  // f4 projected into ZAMO rest 3-space -> e3
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

  // r4 projected & g-orthonormalized -> e1
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

  // u4 projected & g-orthonormalized -> e2
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
  const escapeR = Math.max(Math.max(rOuter * 1.55, camR * 1.45), 48.0);
  const captureR = rPlus * 1.022;
  const outerH = (0.048 + 0.036 * rOuter * 1.30) * Math.max(state.diskThickness, 0.15);
  const maxDiskSlabY = outerH * 2.6;
  const rPeak = Math.max(rIsco * 1.55, rPlus * 1.45);
  outF32[offset + 24] = escapeR;
  outF32[offset + 25] = captureR;
  outF32[offset + 26] = maxDiskSlabY;
  outF32[offset + 27] = rPeak;

  const flowCycle = 15.0;
  const tNorm0 = simTime / flowCycle;
  const phase0 = tNorm0 - Math.floor(tNorm0);
  const tNorm1 = tNorm0 + 0.5;
  const phase1 = tNorm1 - Math.floor(tNorm1);
  outF32[offset + 28] = 0.5 - 0.5 * Math.cos(Math.PI * 2.0 * phase0);
  outF32[offset + 29] = (phase0 - 0.5) * flowCycle;
  outF32[offset + 30] = (phase1 - 0.5) * flowCycle;
  outF32[offset + 31] = simTime * state.orbitSpeed * 0.045;

  const rPeakBase = 2.2 / Math.max(rPeak, 1.5);
  const skyRot = state.skyRotation || [0.45, 0.24];
  const rotX = skyRot[0] || 0.0;
  const rotY = skyRot[1] || 0.0;
  outF32[offset + 32] = Math.pow(rPeakBase, 0.28);
  outF32[offset + 33] = Math.pow(rPeakBase, 0.18);
  outF32[offset + 34] = Math.cos(rotX);
  outF32[offset + 35] = Math.sin(rotX);

  outF32[offset + 36] = Math.cos(rotY);
  outF32[offset + 37] = Math.sin(rotY);
  outF32[offset + 38] = 0.0;
  outF32[offset + 39] = 0.0;
}
