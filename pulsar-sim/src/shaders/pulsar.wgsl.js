/**
 * Cinema-grade WebGPU WGSL Relativistic Magnetar & Millisecond Pulsar
 * Ray-Tracer for "Magnetar & Millisecond Pulsar Simulator".
 *
 * 1:1 exact physics & radiative-transfer port of pulsar.frag.js:
 *  - Locked 176-byte PulsarUniforms (11 x vec4<f32>) and @group(0) @binding(0..8)
 *  - Exact 3D Cartesian Outgoing Kerr-Schild metric with explicit geometric mass
 *    M = compactness (R_* = 1.0, spin axis = +Y), analytical Hamiltonian gradients,
 *    and exact 4D Lorentzian Gram-Schmidt ZAMO observer tetrad.
 *  - Adaptive RK4 geodesic marching with cubic-Hermite + 6-step bisection +
 *    secant root refinement at r <= 1.0.
 *  - Solid neutron star crust, antipodal polar caps + pair-cascade rim,
 *    molten magnetic tectonic cracks, twisted dipole magnetosphere, sweeping
 *    lighthouse beams, equatorial PWN torus & shock wisps, and helical jets.
 *  - Strict WGSL uniformity compliance: uVolumeNoise & uBlackbodyLut strictly
 *    use textureSampleLevel at LOD 0; uBlueNoise uses textureLoad; sky
 *    derivatives run in uniform control flow with textureSampleGrad.
 */

import { FULLSCREEN_VERT_WGSL } from './common.wgsl.js';

export const PULSAR_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

struct PulsarUniforms {
  resolution_time_frame : vec4<f32>,  // (width, height, time, float(frameIndex))
  jitter_fov_lensing    : vec4<f32>,  // (jitterX, jitterY, fovY, lensingStrength)
  camPos_compactness    : vec4<f32>,  // (camX, camY, camZ, compactness)
  camRight_spinA        : vec4<f32>,  // (rightX, rightY, rightZ, spinA)
  camUp_betaEq          : vec4<f32>,  // (upX, upY, upZ, betaEq)
  camFwd_phase          : vec4<f32>,  // (fwdX, fwdY, fwdZ, spinPhase)
  magnetParams          : vec4<f32>,  // (obliquityRad, twistShear, rLightCylVis, plasmaDensity)
  beamPwnParams         : vec4<f32>,  // (beamIntensity, pwnVisibility, polarCapTempK, crustTempK)
  skyParams             : vec4<f32>,  // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  qualityParams         : vec4<f32>,  // (float(quality), spinVisualSpeed, float(isProgressive), surfaceRedshiftZ)
  extraParams           : vec4<f32>,  // (beamConeHalfAngle, magnetarCrackGlow, pwnJetPower, 0.0)
};

@group(0) @binding(0) var<uniform> u: PulsarUniforms;
@group(0) @binding(1) var uVolumeNoise: texture_3d<f32>;
@group(0) @binding(2) var sVolume: sampler;
@group(0) @binding(3) var uSkyMap: texture_2d<f32>;
@group(0) @binding(4) var uProcSkyMap: texture_2d<f32>;
@group(0) @binding(5) var sSky: sampler;
@group(0) @binding(6) var uBlackbodyLut: texture_2d<f32>;
@group(0) @binding(7) var sLut: sampler;
@group(0) @binding(8) var uBlueNoise: texture_2d<f32>;

const PI             : f32 = 3.14159265359;
const TAU            : f32 = 6.28318530718;
const INV_PI         : f32 = 0.31830988618;
const INV_TAU        : f32 = 0.15915494309;
const T_MIN          : f32 = 800.0;
const T_MAX          : f32 = 40000.0;
const INV_LOG_T_SPAN : f32 = 1.0 / 3.91202300543; // 1 / ln(40000 / 800)

fn isBadFloat(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}

fn sanitizeVec3Zero(v: vec3f) -> vec3f {
  return vec3f(
    select(v.x, 0.0, isBadFloat(v.x)),
    select(v.y, 0.0, isBadFloat(v.y)),
    select(v.z, 0.0, isBadFloat(v.z))
  );
}

// ============================================================================
// 1. EXACT 3D CARTESIAN OUTGOING KERR-SCHILD METRIC (EXPLICIT MASS M = u_c)
// ============================================================================

struct KSFields {
  r     : f32,
  r2    : f32,
  D     : f32,
  H     : f32,
  R2    : f32,
  l     : vec3f,
  gradR : vec3f,
};

fn evalKerrR(pos: vec3f, a2: f32) -> f32 {
  if (a2 < 1e-6) {
    return sqrt(max(dot(pos, pos), 1e-8));
  }
  let uVal = dot(pos, pos) - a2;
  let y2 = pos.y * pos.y;
  let disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  return sqrt(max(0.5 * (uVal + disc), 1e-8));
}

fn evalKSFields(pos: vec3f, M: f32, a: f32, a2: f32, lensing: f32) -> KSFields {
  var f: KSFields;
  let y2 = pos.y * pos.y;
  if (a2 < 1e-6) {
    f.r2 = max(dot(pos, pos), 1e-8);
    let invR = inverseSqrt(f.r2);
    f.r = f.r2 * invR;
    f.D = f.r2 * f.r2;
    f.H = lensing * M * invR;
    f.R2 = f.r2;
    f.l = pos * invR;
    f.gradR = f.l;
    return f;
  }

  let uVal = dot(pos, pos) - a2;
  let disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  f.r2 = max(0.5 * (uVal + disc), 1e-8);
  let invR = inverseSqrt(f.r2);
  f.r = f.r2 * invR;
  f.D = f.r2 * f.r2 + a2 * y2;
  let invD = 1.0 / max(f.D, 1e-10);
  f.H = lensing * M * (f.r * f.r2) * invD;
  f.R2 = f.r2 + a2;
  let invR2 = 1.0 / max(f.R2, 1e-8);
  f.l = vec3f(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (f.r * pos.z - a * pos.x) * invR2
  );
  f.gradR = vec3f(
    f.r * f.r2 * pos.x,
    f.r * f.R2 * pos.y,
    f.r * f.r2 * pos.z
  ) * invD;
  return f;
}

fn ksMetricDot(A: vec4f, B: vec4f, f: KSFields) -> f32 {
  let lA = -A.x + dot(f.l, A.yzw);
  let lB = -B.x + dot(f.l, B.yzw);
  return -A.x * B.x + dot(A.yzw, B.yzw) + 2.0 * f.H * lA * lB;
}

struct GeodesicDeriv {
  dpos : vec3f,
  dp   : vec3f,
  r    : f32,
};

fn evalGeodesicRHS(pos: vec3f, p: vec3f, pt: f32, M: f32, a: f32, a2: f32, lensing: f32) -> GeodesicDeriv {
  let f = evalKSFields(pos, M, a, a2, lensing);
  let L = pt + dot(f.l, p);
  let twoHL = 2.0 * f.H * L;

  var outD: GeodesicDeriv;
  outD.dpos = p - twoHL * f.l;
  outD.r = f.r;

  if (lensing <= 1e-6) {
    outD.dp = vec3f(0.0);
    return outD;
  }

  let invD = 1.0 / max(f.D, 1e-10);
  let hFac = lensing * M * f.r2 * invD * invD;
  let cR = 3.0 * a2 * pos.y * pos.y - f.r2 * f.r2;
  var gradH = (hFac * cR) * f.gradR;
  gradH.y -= hFac * (2.0 * f.r * a2 * pos.y);

  let invR2 = 1.0 / max(f.R2, 1e-8);
  let invR = 1.0 / max(f.r, 1e-5);
  let S = (p.x * (pos.x - 2.0 * f.r * f.l.x) + p.z * (pos.z - 2.0 * f.r * f.l.z)) * invR2
        - p.y * f.l.y * invR;

  let w = vec3f(
    (f.r * p.x - a * p.z) * invR2,
    p.y * invR,
    (a * p.x + f.r * p.z) * invR2
  ) + S * f.gradR;

  outD.dp = (L * L) * gradH + twoHL * w;
  return outD;
}

struct CameraRayInit {
  p  : vec3f,
  pt : f32,
};

fn initCameraRay(
  camPos: vec3f,
  camRight: vec3f,
  camUp: vec3f,
  camFwd: vec3f,
  localRay: vec3f,
  M: f32,
  a: f32,
  a2: f32,
  lensing: f32
) -> CameraRayInit {
  let f = evalKSFields(camPos, M, a, a2, lensing);
  let rho2 = camPos.x * camPos.x + camPos.z * camPos.z;

  let omega = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  let vZamo = vec3f(omega * camPos.z, 0.0, -omega * camPos.x);
  let lPhi = a * rho2 / max(f.R2, 1e-8);
  let oneMinusWl = 1.0 - omega * lPhi;
  let normSq = max(1.0 - dot(vZamo, vZamo) - 2.0 * f.H * oneMinusWl * oneMinusWl, 1e-5);
  let ut = inverseSqrt(normSq);
  let e0 = vec4f(ut, ut * vZamo);

  var f4 = vec4f(0.0, camFwd);
  f4 += ksMetricDot(f4, e0, f) * e0;
  let e3 = f4 * inverseSqrt(max(ksMetricDot(f4, f4, f), 1e-8));

  var r4 = vec4f(0.0, camRight);
  r4 += ksMetricDot(r4, e0, f) * e0;
  r4 -= ksMetricDot(r4, e3, f) * e3;
  let e1 = r4 * inverseSqrt(max(ksMetricDot(r4, r4, f), 1e-8));

  var u4 = vec4f(0.0, camUp);
  u4 += ksMetricDot(u4, e0, f) * e0;
  u4 -= ksMetricDot(u4, e3, f) * e3;
  u4 -= ksMetricDot(u4, e1, f) * e1;
  let e2 = u4 * inverseSqrt(max(ksMetricDot(u4, u4, f), 1e-8));

  let pUp = -e0 + localRay.x * e1 + localRay.y * e2 + localRay.z * e3;
  let lp = -pUp.x + dot(f.l, pUp.yzw);

  var outRay: CameraRayInit;
  outRay.pt = -pUp.x - 2.0 * f.H * lp;
  outRay.p  =  pUp.yzw + (2.0 * f.H * lp) * f.l;
  return outRay;
}

fn evalHermite(x0: vec3f, v0: vec3f, x1: vec3f, v1: vec3f, t: f32) -> vec3f {
  let t2 = t * t;
  let t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * x0
       + (t3 - 2.0 * t2 + t) * v0
       + (-2.0 * t3 + 3.0 * t2) * x1
       + (t3 - t2) * v1;
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT & SEAMLESS 4K SKY + MICRO-STARS
// ============================================================================

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
}

fn mapPulsarTempToLut(physTempK: f32) -> f32 {
  let scaled = 2800.0 * pow(max(physTempK, 1.0e5) * 1.0e-6, 1.15);
  return clamp(scaled, T_MIN, T_MAX);
}

fn rotateY(v: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

fn rotateSkyDir(d: vec3f, rot: vec2f) -> vec3f {
  let cy = cos(rot.x);
  let sy = sin(rot.x);
  let r1 = vec3f(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  let cp = cos(rot.y);
  let sp = sin(rot.y);
  return vec3f(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

fn hash33f(pIn: vec3f) -> vec3f {
  var p = fract(pIn * vec3f(0.1031, 0.1030, 0.0973));
  p += vec3f(dot(p, p.yxz + vec3f(33.33)));
  return fract((p.xxy + p.yxx) * p.zyx);
}

fn evalMicroStarLayer(dir: vec3f, scale: f32, densityThresh: f32, boost: f32, pixelFw: f32) -> vec3f {
  let p = dir * scale;
  let cell = floor(p);
  let rnd = hash33f(cell);
  if (rnd.x < densityThresh) {
    return vec3f(0.0);
  }

  let starPos = cell + vec3f(0.22) + 0.56 * hash33f(cell + vec3f(19.17, 73.41, 41.83));
  let dist = length(p - starPos);

  let magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  let mag2 = magU * magU;
  let mag = mag2 * mag2 * sqrt(magU);

  let fw = clamp(pixelFw * scale, 0.018, 0.18);
  let starRad = mix(0.028, 0.088, mag) + fw * 0.40;
  let core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let ry = max(rnd.y, 0.0);
  let tEmit = mix(3100.0, 22000.0, ry * ry);
  let col = sampleBlackbody(tEmit);

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let lum = (0.09 + 3.1 * mag) * boost * energyComp;
  return col * (core * lum);
}

fn sampleSkyBackground(rawDir: vec3f, skyIntensity: f32, skyMode: i32, skyRot: vec2f, escaped: bool, edgeMask: f32) -> vec3f {
  let dir = normalize(rotateSkyDir(rawDir, skyRot));

  // Wrap-safe & pole-safe equirectangular derivatives in uniform control flow
  let azim = select(0.0, atan2(dir.z, dir.x), abs(dir.x) + abs(dir.z) > 1e-6);
  let u1 = azim * INV_TAU + 0.5;
  let v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  let uv1 = vec2f(u1, v);
  let uv2 = vec2f(fract(u1 + 0.5), v);

  let dx1 = dpdx(uv1);
  let dy1 = dpdy(uv1);
  let dx2 = dpdx(uv2);
  let dy2 = dpdy(uv2);

  var dUVdx = vec2f(select(dx2.x, dx1.x, abs(dx1.x) < abs(dx2.x)), dx1.y);
  var dUVdy = vec2f(select(dy2.x, dy1.x, abs(dy1.x) < abs(dy2.x)), dy1.y);

  if (edgeMask > 0.01) {
    dUVdx = vec2f(1.0 / 4096.0, 0.0);
    dUVdy = vec2f(0.0, 1.0 / 2048.0);
  } else {
    dUVdx = clamp(dUVdx, vec2f(-0.045), vec2f(0.045));
    dUVdy = clamp(dUVdy, vec2f(-0.045), vec2f(0.045));
  }

  var dirFw = min(length(fwidth(dir)), 0.12);
  if (edgeMask > 0.01) {
    dirFw = 0.0012;
  }

  if (!escaped) {
    return vec3f(0.0);
  }

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.005, 0.995));
  var mapSrgb: vec3f;
  if (skyMode >= 1) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(1e-5)), vec3f(2.2));

  let skyLuma = dot(skyLin, vec3f(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.32, 1.0, smoothstep(0.002, 0.042, skyLuma));

  let brightCores = max(skyLin - vec3f(0.28), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.2;

  let starGain = select(0.72, 1.05, skyMode >= 1);
  skyLin += evalMicroStarLayer(dir, 100.0, 0.912, 0.92 * starGain, dirFw)
          + evalMicroStarLayer(dir, 210.0, 0.884, 0.42 * starGain, dirFw);

  return skyLin * max(skyIntensity, 0.0);
}

// ============================================================================
// 3. NEUTRON STAR SOLID CRUST (r = 1.0): POLAR CAPS, CRACKS & RELATIVISTIC SHIFT
// ============================================================================

fn computeCrustFrequencyShift(
  pos: vec3f,
  f: KSFields,
  p: vec3f,
  pt: f32,
  a: f32,
  a2: f32,
  betaEq: f32
) -> f32 {
  let rho2 = pos.x * pos.x + pos.z * pos.z;
  let omegaZ = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  let vZamo = vec3f(omegaZ * pos.z, 0.0, -omegaZ * pos.x);

  var vEmit = vec3f(betaEq * pos.z, 0.0, -betaEq * pos.x);
  var lv = -1.0 + dot(f.l, vEmit);
  var ds2 = -1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv;

  if (ds2 > -0.04) {
    let dv = vEmit - vZamo;
    let lvZ = -1.0 + dot(f.l, vZamo);
    let ds2Z = min(-1.0 + dot(vZamo, vZamo) + 2.0 * f.H * lvZ * lvZ, -0.02);
    let shrink = sqrt(clamp((-0.04 - ds2Z) / max(ds2 - ds2Z, 1e-4), 0.0, 1.0)) * 0.92;
    vEmit = vZamo + dv * shrink;
    lv = -1.0 + dot(f.l, vEmit);
    ds2 = min(-1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv, -0.02);
  }

  let ut = inverseSqrt(max(-ds2, 0.02));
  let emitEnergy = ut * (pt + dot(p, vEmit));
  return clamp(1.0 / max(emitEnergy, 0.08), 0.12, 2.65);
}

fn shadeNeutronStarSurface(
  posHit: vec3f,
  pHit: vec3f,
  pt: f32,
  velHit: vec3f,
  M: f32,
  a: f32,
  a2: f32,
  lensing: f32,
  betaEq: f32,
  spinPhase: f32,
  mu0: vec3f,
  em1_0: vec3f,
  em2_0: vec3f,
  twistShear: f32,
  rLightCylVis: f32,
  polarCapTempK: f32,
  crustTempK: f32,
  magnetarCrackGlow: f32
) -> vec3f {
  let f = evalKSFields(posHit, M, a, a2, lensing);
  let surfNormal = normalize(f.gradR);

  let pBody = rotateY(posHit, -spinPhase);
  let rHatBody = normalize(pBody);

  let cosM = dot(rHatBody, mu0);
  let absCosM = abs(cosM);
  let sinM = sqrt(max(1.0 - cosM * cosM, 0.0));
  let xM = dot(rHatBody, em1_0);
  let yM = dot(rHatBody, em2_0);
  let phiM = select(0.0, atan2(yM, xM), abs(xM) + abs(yM) > 1e-6);
  let signCosM = select(-1.0, 1.0, cosM >= 0.0);

  let shearCoord = pBody * 0.48 + vec3f(0.17, 0.31, 0.53);
  let nCrust = textureSampleLevel(uVolumeNoise, sVolume, shearCoord, 0.0);
  let fineCoord = pBody * 1.12 + (nCrust.rgb - vec3f(0.5)) * 0.42
                + vec3f(0.16 * twistShear * signCosM * pBody.z, 0.0, -0.16 * twistShear * signCosM * pBody.x);
  let nFine = textureSampleLevel(uVolumeNoise, sVolume, fineCoord, 0.0);

  let sinThetaPc = clamp(inverseSqrt(max(rLightCylVis, 1.5)), 0.16, 0.62);
  let sinPerturb = sinM + (nFine.r - 0.5) * 0.042 * sinM;

  let capCore = 1.0 - smoothstep(sinThetaPc * 0.28, sinThetaPc * 0.96, sinPerturb);
  let capIn = sinPerturb / max(sinThetaPc * 0.48, 0.06);
  let capInner = exp(-min(capIn * capIn, 40.0));
  let capRimDist = (sinPerturb - sinThetaPc * 0.96) / max(sinThetaPc * 0.20, 0.045);
  let capRim = exp(-min(capRimDist * capRimDist, 40.0));
  let auroralMod = 0.58 + 0.42 * sin(2.0 * phiM + twistShear * 1.45 * signCosM + nCrust.g * 3.4);

  let latThermal = 0.22 + 0.78 * pow(max(absCosM, 1e-5), 1.45);
  let crustGran = 0.54 + 0.68 * nCrust.r * (0.55 + 0.45 * nFine.b);

  let lineA = 1.0 - abs(nCrust.r * 2.0 - 1.0);
  let lineB = 1.0 - abs(nFine.r * 2.0 - 1.0);
  let pA = clamp(lineA, 1e-5, 1.0);
  let pB = clamp(lineB, 1e-5, 1.0);
  let faultNet = max(pow(pA, 8.0), 0.78 * pow(pB, 10.0) * smoothstep(0.28, 0.78, nCrust.g));
  let faultMod = 0.55 + 0.45 * nFine.g;
  let faultHalo = smoothstep(0.14, 0.68, faultNet) * faultMod;
  let faultCore = smoothstep(0.48, 0.92, faultNet) * faultMod;
  let crackDrive = pow(max(magnetarCrackGlow, 1e-5), 1.35) * (0.65 + 0.35 * clamp(twistShear, 0.0, 2.5));

  let g = computeCrustFrequencyShift(posHit, f, pHit, pt, a, a2, betaEq);

  let vRayDir = select(surfNormal, normalize(velHit), dot(velHit, velHit) > 1e-10);
  let muLimb = clamp(dot(surfNormal, -vRayDir), 0.0, 1.0);
  let limbDark = mix(0.30, 1.0, pow(max(muLimb, 1e-5), 0.58));
  let atmoRim = pow(max(1.0 - muLimb, 1e-5), 4.2) * 0.12;

  let T_crust = crustTempK * (0.52 + 0.56 * latThermal) * crustGran;
  let crustCol = sampleBlackbody(mapPulsarTempToLut(T_crust * g));
  let crustLum = 0.38 * pow(clamp(T_crust / 1.4e6, 0.30, 3.2), 1.35);
  let ironTint = vec3f(0.055, 0.070, 0.115);
  let crustEmit = mix(ironTint, crustCol * crustLum, clamp(0.35 + 0.65 * latThermal, 0.0, 1.0));

  let haloCol = vec3f(1.00, 0.24, 0.03);
  let coreCrackCol = mix(sampleBlackbody(mapPulsarTempToLut(max(crustTempK * 2.1, 3.2e6) * g)), vec3f(1.00, 0.72, 0.20), 0.55);
  let crackEmit = (haloCol * (faultHalo * 2.6) + coreCrackCol * (faultCore * 8.5)) * crackDrive;

  let T_cap = polarCapTempK * (0.78 + 0.42 * capInner + 0.18 * nFine.g);
  let capCol = sampleBlackbody(mapPulsarTempToLut(T_cap * g));
  let capStr = (capCore * 0.85 + capInner * 1.25) * (0.80 + 0.35 * nFine.g);
  let pairRimCol = mix(vec3f(0.16, 0.60, 1.00), vec3f(0.58, 0.90, 1.00), auroralMod);
  let capEmit = capCol * (capStr * 16.5) + pairRimCol * (capRim * auroralMod * 9.5);

  let g2 = g * g;
  let g4 = g2 * g2;
  let relFlux = g4 / (1.0 + 0.08 * g4);

  let totalSurf = (crustEmit + crackEmit + capEmit) * limbDark * relFlux
                + vec3f(0.30, 0.70, 1.00) * (atmoRim * g * (0.7 + 0.5 * crackDrive));
  return max(totalSurf, vec3f(0.0));
}

// ============================================================================
// 4. VOLUMETRIC MAGNETOSPHERE, LIGHTHOUSE BEAMS, PWN TORUS & POLAR JETS
// ============================================================================

struct VolAccum {
  emission   : vec3f,
  extinction : f32,
};

fn evalPulsarVolume(
  pos: vec3f,
  vel: vec3f,
  r: f32,
  simTime: f32,
  betaEq: f32,
  spinPhase: f32,
  mu0: vec3f,
  em1_0: vec3f,
  em2_0: vec3f,
  twistShear: f32,
  rLightCylVis: f32,
  plasmaDensity: f32,
  beamIntensity: f32,
  beamConeHalfAngle: f32,
  cosMaxCone: f32,
  pwnVisibility: f32,
  pwnJetPower: f32,
  spinVisualSpeed: f32,
  camDistFade: f32
) -> VolAccum {
  var va: VolAccum;
  va.emission = vec3f(0.0);
  va.extinction = 0.0;

  if (r <= 1.025) {
    return va;
  }

  let needMag  = (plasmaDensity > 0.001 && r < rLightCylVis * 1.18);
  let needBeam = (beamIntensity > 0.001 && r < 18.0);

  if (needMag || needBeam) {
    let deltaPhi = -(max(r - 1.0, 0.0) / max(rLightCylVis, 1.5)) * (0.85 + 0.55 * betaEq);
    let phaseRet = spinPhase + deltaPhi;
    let pRot = rotateY(pos, -phaseRet);

    let zM = dot(pRot, mu0);
    let xM = dot(pRot, em1_0);
    let yM = dot(pRot, em2_0);
    let rhoM2 = xM * xM + yM * yM;
    let r2M = max(dot(pRot, pRot), 1e-6);
    let rM = sqrt(r2M);
    let sin2Theta = max(rhoM2 / r2M, 1e-5);
    let cosThetaM = zM / max(rM, 1e-5);
    let L = rM / sin2Theta;

    // 4A. Closed Twisted Dipole Magnetosphere
    if (needMag && L > 1.04 && L < rLightCylVis * 1.14) {
      let phiM = select(0.0, atan2(yM, xM), rhoM2 > 1e-10);
      let phiTwist = phiM - twistShear * cosThetaM * (1.0 - 1.0 / max(L, 1.0)) * 2.2;
      let logL = log(max(L, 1.01));

      let flowMag = simTime * (0.35 + 0.45 * spinVisualSpeed);
      let qMag = vec3f(
        cos(phiTwist) * (0.42 + 0.14 * logL),
        sin(phiTwist) * (0.42 + 0.14 * logL),
        cosThetaM * 1.35 - flowMag
      );
      let nMag = textureSampleLevel(uVolumeNoise, sVolume, qMag, 0.0);

      let tA0 = clamp(0.5 + 0.5 * cos(7.0 * phiTwist + 1.6 * nMag.r), 0.0, 1.0);
      let tA2 = tA0 * tA0;
      let tubeA = tA2 * tA2 * tA2;
      let tB0 = clamp(0.5 + 0.5 * cos(13.0 * phiTwist - 2.2 * logL + 2.0 * nMag.b), 0.0, 1.0);
      let tB2 = tB0 * tB0;
      let tubeB = tB2 * tB2 * tB0;
      let sB0 = max(0.5 + 0.5 * sin(logL * 10.5 + 1.8 * nMag.r), 1e-5);
      let shellBands = sB0 * sB0 * sB0 * sqrt(sB0);
      let sepDist = (L - rLightCylVis * 0.88) / max(rLightCylVis * 0.14, 0.40);
      let sepEnv = exp(-min(sepDist * sepDist * 2.2, 40.0));

      let lEnv = smoothstep(1.04, 1.25, L) * (1.0 - smoothstep(rLightCylVis * 0.86, rLightCylVis * 1.12, L));
      let rFade = smoothstep(1.03, 1.16, rM) / (1.0 + 0.42 * pow(max(rM - 1.0, 1e-5), 1.65));
      let tubeStruct = (1.55 * tubeA * shellBands + 0.65 * tubeB * shellBands + 0.85 * sepEnv * (0.35 + 0.65 * tubeA))
                     * (0.28 + 1.10 * nMag.g * nMag.g + 0.40 * nMag.a);
      let magDens = lEnv * rFade * tubeStruct * plasmaDensity * camDistFade;

      let cCyan   = vec3f(0.10, 0.58, 1.00);
      let cViolet = vec3f(0.42, 0.16, 1.00);
      let cIce    = vec3f(0.66, 0.92, 1.00);
      var magCol = mix(cViolet, cCyan, smoothstep(rLightCylVis, 1.4, L));
      magCol = mix(magCol, cIce, clamp(tubeA * shellBands * 0.72 + sepEnv * 0.35, 0.0, 1.0));

      let twistFactor = smoothstep(0.55, 1.85, twistShear);
      if (twistFactor > 0.001) {
        let twistCore = pow(clamp(tubeA * (0.5 + 0.5 * nMag.g) + sepEnv * 0.35, 1e-5, 1.0), 1.35);
        let twistGold = mix(vec3f(1.00, 0.52, 0.08), vec3f(1.00, 0.86, 0.42), twistCore);
        magCol = mix(magCol, twistGold, twistFactor * clamp(0.40 + 0.60 * twistCore, 0.0, 1.0));
      }

      va.emission += magCol * (magDens * 0.12);
      va.extinction += magDens * 0.025;
    }

    // 4B. Sweeping Lighthouse Synchrotron / Curvature Beams around +-muHat
    if (needBeam) {
      let absCosB = abs(cosThetaM);
      if (absCosB > cosMaxCone) {
        let sinB = sqrt(max(1.0 - absCosB * absCosB, 0.0));
        let thetaB = atan2(sinB, absCosB);
        let thetaCone = beamConeHalfAngle * mix(0.58, 1.04, smoothstep(1.0, 4.2, rM));
        let coneW = max(thetaCone * 0.24, 0.038);
        let coreW = max(thetaCone * 0.26, 0.042);

        if (thetaB < thetaCone + 3.2 * coneW) {
          let cd = (thetaB - thetaCone) / coneW;
          let hollowCone = exp(-min(cd * cd, 40.0));
          let kd = thetaB / coreW;
          let coreBeam = exp(-min(kd * kd, 40.0)) * 0.90;

          let radialOnset = smoothstep(1.04, 1.38, rM)
                          * (1.0 - smoothstep(10.0, 18.0, rM))
                          / (1.0 + 0.25 * rM * rM);

          let phiB = select(0.0, atan2(yM, xM), rhoM2 > 1e-10);
          let flowOut = rM * 0.24 - simTime * (0.85 + 1.15 * spinVisualSpeed);
          let qBeam = vec3f(cos(phiB) * 0.55, sin(phiB) * 0.55, flowOut);
          let nBeam = textureSampleLevel(uVolumeNoise, sVolume, qBeam, 0.0);
          let streakCos = clamp(0.5 + 0.5 * cos(6.0 * phiB + rM * 0.45 - simTime * 2.4), 0.0, 1.0);
          let subPulses = (0.28 + 0.92 * nBeam.g * nBeam.g) * (0.45 + 0.55 * streakCos * streakCos);

          let signMu = select(-1.0, 1.0, cosThetaM >= 0.0);
          let muRetLab = rotateY(signMu * mu0, phaseRet);
          let rHatLab = pos / max(r, 1e-5);
          let beamDir = normalize(mix(muRetLab, rHatLab, 0.42));
          let toCamDir = select(-rHatLab, -normalize(vel), dot(vel, vel) > 1e-10);
          let cosForward = dot(beamDir, toCamDir);
          let dopplerBeam = 1.0 / max(1.0 - 0.54 * cosForward, 0.34);
          let beaming = pow(clamp(dopplerBeam, 0.45, 3.0), 1.55);

          var beamCol = mix(vec3f(0.42, 0.22, 1.00), vec3f(0.16, 0.68, 1.00), clamp(hollowCone + coreBeam, 0.0, 1.0));
          beamCol = mix(beamCol, vec3f(0.86, 0.95, 1.00), smoothstep(1.5, 3.6, beaming) * 0.80);

          let beamVal = beamIntensity * radialOnset * (hollowCone * 1.05 + coreBeam * 0.95)
                      * subPulses * beaming * camDistFade;
          va.emission += beamCol * (beamVal * 0.20);
          va.extinction += beamVal * 0.005;
        }
      }
    }
  }

  // 4C. Pulsar Wind Nebula (PWN) Equatorial Synchrotron Torus & Outward Shock Wisps
  if (pwnVisibility > 0.001 && r > 2.15 && r < 11.8) {
    let hTorus = 0.15 + 0.068 * r;
    let absY = abs(pos.y);
    if (absY < hTorus * 2.8) {
      let yT = absY / max(hTorus, 1e-4);
      let vertTorus = exp(-min(yT * yT * 1.75, 40.0));
      let dr = (yT - 0.56) / 0.32;
      let doubleRing = 0.68 + 0.55 * exp(-min(dr * dr, 40.0));
      let radEnv = smoothstep(2.40, 3.30, r)
                 * (1.0 - smoothstep(7.8, 11.5, r))
                 / (1.0 + 0.065 * r * r);
      let ts = (r - 3.15) / 0.48;
      let termShock = exp(-min(ts * ts * 1.4, 40.0)) * 1.15;

      let rotAngle = 0.14 * simTime * (0.4 + spinVisualSpeed) - 0.22 * r;
      let cr = cos(rotAngle);
      let sr = sin(rotAngle);
      let rotXZ = vec2f(cr * pos.x - sr * pos.z, sr * pos.x + cr * pos.z);
      let nPwn  = textureSampleLevel(uVolumeNoise, sVolume, vec3f(rotXZ * 0.19, pos.y * 0.32), 0.0);

      let wispPhase = r * 2.35 - simTime * (0.55 + 0.75 * spinVisualSpeed) + (nPwn.r - 0.5) * 2.6;
      let wisps = pow(max(0.5 + 0.5 * sin(wispPhase), 1e-5), 4.5);
      let filaments = (0.18 + 1.35 * pow(max(nPwn.g, 1e-5), 1.8)) * (0.45 + 0.75 * nPwn.a);
      let torusDens = pwnVisibility * radEnv * vertTorus * doubleRing
                    * (0.14 * filaments + 1.25 * wisps * filaments + termShock * (0.45 + 0.85 * nPwn.g))
                    * camDistFade;

      var torusCol = mix(vec3f(0.36, 0.20, 0.92), vec3f(0.12, 0.56, 1.00), smoothstep(10.2, 3.2, r));
      torusCol = mix(torusCol, vec3f(0.60, 0.88, 1.00), clamp(wisps * 0.68 + termShock * 0.42, 0.0, 1.0));

      va.emission += torusCol * (torusDens * 0.09);
      va.extinction += torusDens * 0.018;
    }
  }

  // 4D. Helical Spin-Axis Polar Jets (+-Y)
  let jetAmp = pwnVisibility * pwnJetPower;
  if (jetAmp > 0.001) {
    let absY = abs(pos.y);
    if (absY >= 1.55 && absY <= 18.5) {
      let rho = length(pos.xz);
      let jetRadius = 0.18 + 0.082 * pow(absY, 0.72);
      if (rho < jetRadius * 2.3) {
        let uRad = rho / max(jetRadius, 1e-4);
        let spine = exp(-min(uRad * uRad * 5.2, 40.0));
        let sd = uRad - 0.75;
        let sheath = exp(-min(sd * sd * 10.5, 40.0)) * 0.85;
        let outerHalo = exp(-min(uRad * uRad * 1.4, 40.0)) * 0.14;
        let radProf = spine * 0.55 + sheath + outerHalo;

        let yEnv = smoothstep(1.55, 3.2, absY)
                 * (1.0 - smoothstep(10.0, 18.0, absY))
                 / (1.0 + 0.14 * absY);

        let signY = select(-1.0, 1.0, pos.y >= 0.0);
        let helixAngle = signY * (absY * 0.82 - simTime * (0.65 + 1.35 * spinVisualSpeed));
        let ch = cos(helixAngle);
        let sh = sin(helixAngle);
        let rotXZ = vec2f(ch * pos.x - sh * pos.z, sh * pos.x + ch * pos.z);

        let flowY = absY * 0.19 - simTime * (0.35 + 0.65 * spinVisualSpeed);
        let jn = textureSampleLevel(uVolumeNoise, sVolume, vec3f(rotXZ * 0.48, flowY), 0.0);

        let rawFil = clamp(jn.y * 0.62 + jn.w * 0.52, 0.0, 1.0);
        let filaments = rawFil * rawFil * rawFil;
        let knots = 0.40 + 0.90 * pow(max(jn.z, 1e-5), 1.3);

        let jetDir = vec3f(0.0, signY, 0.0);
        let toCamDirJet = select(-jetDir, -normalize(vel), dot(vel, vel) > 1e-10);
        let cosTheta = dot(jetDir, toCamDirJet);
        let dopplerJet = 1.0 / max(1.0 - 0.52 * cosTheta, 0.28);
        let jetBeam = pow(clamp(dopplerJet, 0.40, 2.4), 1.45);
        let viewColAtten = mix(1.0, 0.28, pow(max(abs(cosTheta), 1e-5), 1.55));

        let coreCol   = vec3f(0.60, 0.86, 1.00);
        let sheathCol = vec3f(0.18, 0.46, 1.00);
        let outerCol  = vec3f(0.44, 0.20, 1.00);
        var jetCol = mix(sheathCol, coreCol, clamp(spine * 0.85 + filaments * 0.55, 0.0, 1.0));
        jetCol = mix(jetCol, outerCol, smoothstep(0.75, 1.85, uRad) * 0.68);

        let rawInt = jetAmp * radProf * yEnv * (0.16 + 1.55 * filaments) * knots
                   * jetBeam * viewColAtten * camDistFade;
        let intensity = rawInt / (1.0 + rawInt * 0.45);
        va.emission += jetCol * (intensity * 0.095);
      }
    }
  }

  return va;
}

// ============================================================================
// 5. MAIN ADAPTIVE HYBRID RK4/RK2 GEODESIC RAY-MARCHER & TRANSFER
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_lensing.x, -u.jitter_fov_lensing.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = tan(clamp(u.jitter_fov_lensing.z, 0.1, 2.8) * 0.5);
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let simTime = u.resolution_time_frame.z;
  let frameIndex = i32(round(u.resolution_time_frame.w));
  let lensing = clamp(u.jitter_fov_lensing.w, 0.0, 1.0);

  let camPos   = u.camPos_compactness.xyz;
  let M        = clamp(u.camPos_compactness.w, 0.05, 0.35);
  let camRight = u.camRight_spinA.xyz;
  let a        = clamp(u.camRight_spinA.w, 0.0, 0.25);
  let a2       = a * a;
  let camUp    = u.camUp_betaEq.xyz;
  let betaEq   = clamp(u.camUp_betaEq.w, 0.0, 0.45);
  let camFwd   = u.camFwd_phase.xyz;
  let spinPhase = u.camFwd_phase.w;

  let obliquityRad  = u.magnetParams.x;
  let twistShear    = max(u.magnetParams.y, 0.0);
  let rLightCylVis  = max(u.magnetParams.z, 1.5);
  let plasmaDensity = max(u.magnetParams.w, 0.0);

  let beamIntensity = max(u.beamPwnParams.x, 0.0);
  let pwnVisibility = max(u.beamPwnParams.y, 0.0);
  let polarCapTempK = max(u.beamPwnParams.z, 1.0e5);
  let crustTempK    = max(u.beamPwnParams.w, 1.0e5);

  let skyIntensity = max(u.skyParams.x, 0.0);
  let skyMode      = i32(round(u.skyParams.y));
  let skyRot       = u.skyParams.zw;

  let quality         = i32(round(u.qualityParams.x));
  let spinVisualSpeed = max(u.qualityParams.y, 0.0);
  let isProgressive   = u.qualityParams.z > 0.5;

  let beamConeHalfAngle = clamp(u.extraParams.x, 0.08, 0.90);
  let magnetarCrackGlow = max(u.extraParams.y, 0.0);
  let pwnJetPower       = max(u.extraParams.z, 0.0);

  // Frame-constant magnetic basis, cone early-out bound, and volume outer bound
  let cosObl = cos(obliquityRad);
  let sinObl = sin(obliquityRad);
  let mu0   = vec3f(sinObl, cosObl, 0.0);
  let em1_0 = vec3f(cosObl, -sinObl, 0.0);
  let em2_0 = vec3f(0.0, 0.0, -1.0);

  let maxThetaCone = beamConeHalfAngle * 1.04;
  let maxConeW = max(maxThetaCone * 0.24, 0.038);
  let maxBeamAngle = maxThetaCone + 3.2 * maxConeW;
  let cosMaxCone = select(-0.01, cos(maxBeamAngle), maxBeamAngle < 1.56);

  var volBoundR : f32 = 1.025;
  if (plasmaDensity > 0.001) { volBoundR = max(volBoundR, rLightCylVis * 1.18); }
  if (pwnVisibility > 0.001) { volBoundR = max(volBoundR, 11.8); }
  if (beamIntensity > 0.001) { volBoundR = max(volBoundR, 18.0); }
  if (pwnVisibility * pwnJetPower > 0.001) { volBoundR = max(volBoundR, 19.2); }

  let ray0 = initCameraRay(camPos, camRight, camUp, camFwd, localRay, M, a, a2, lensing);
  var pos = camPos;
  var p   = ray0.p;
  let pt  = ray0.pt;

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(frameIndex & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  var maxSteps : i32 = select(128, 170, isProgressive);
  var qualScale : f32 = select(1.02, 0.88, isProgressive);
  if (quality <= 0) {
    maxSteps = select(88, 120, isProgressive);
    qualScale = select(1.32, 1.18, isProgressive);
  } else if (quality >= 2) {
    maxSteps = select(190, 250, isProgressive);
    qualScale = select(0.78, 0.68, isProgressive);
  }

  let camR = length(camPos);
  let escapeR = max(20.0, camR * 1.35);

  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;
  var rayDist : f32 = 0.0;
  var hitStar = false;
  var escaped = false;
  var finalVel = localRay;

  for (var step: i32 = 0; step < 250; step++) {
    if (step >= maxSteps) { break; }

    let k1 = evalGeodesicRHS(pos, p, pt, M, a, a2, lensing);
    let r = k1.r;
    finalVel = k1.dpos;

    if (r <= 1.0) {
      let surfRad = shadeNeutronStarSurface(
        pos, p, pt, k1.dpos, M, a, a2, lensing, betaEq, spinPhase,
        mu0, em1_0, em2_0, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
      );
      radiance += transmittance * surfRad;
      hitStar = true;
      break;
    }

    let outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    let outsideVol = outbound && r > max(volBoundR, 12.5);
    var h = select(
      clamp(0.135 * (r - 0.55) * qualScale, 0.042 * qualScale, 0.78 * qualScale),
      clamp(0.32 * r * qualScale, 0.9, 4.8),
      outsideVol
    );

    if (r < 2.25) {
      h = min(h, (0.030 + 0.064 * max(r - 1.0, 0.0)) * qualScale);
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    var posNext : vec3f;
    var pNext   : vec3f;
    var velEnd  : vec3f;
    if (lensing <= 1e-6) {
      posNext = pos + h * k1.dpos;
      pNext   = p;
      velEnd  = k1.dpos;
    } else if (r >= 4.2) {
      let posMid = pos + (0.5 * h) * k1.dpos;
      let pMid   = p   + (0.5 * h) * k1.dp;
      let k2 = evalGeodesicRHS(posMid, pMid, pt, M, a, a2, lensing);
      posNext = pos + h * k2.dpos;
      pNext   = p   + h * k2.dp;
      velEnd  = k2.dpos;
    } else {
      let pos2 = pos + (0.5 * h) * k1.dpos;
      let p2   = p   + (0.5 * h) * k1.dp;
      let k2 = evalGeodesicRHS(pos2, p2, pt, M, a, a2, lensing);

      let pos3 = pos + (0.5 * h) * k2.dpos;
      let p3   = p   + (0.5 * h) * k2.dp;
      let k3 = evalGeodesicRHS(pos3, p3, pt, M, a, a2, lensing);

      let pos4 = pos + h * k3.dpos;
      let p4   = p   + h * k3.dp;
      let k4 = evalGeodesicRHS(pos4, p4, pt, M, a, a2, lensing);

      posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
      pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);
      velEnd  = k4.dpos;
    }

    let rNext = evalKerrR(posNext, a2);
    let v0 = h * k1.dpos;
    let v1 = h * velEnd;

    var hitThisStep = false;
    var alphaHi : f32 = 1.0;
    if (rNext <= 1.0) {
      hitThisStep = true;
      alphaHi = 1.0;
    } else if (r < 1.18 && dot(pos, k1.dpos) < 0.0) {
      let midH = evalHermite(pos, v0, posNext, v1, 0.5);
      if (evalKerrR(midH, a2) <= 1.0) {
        hitThisStep = true;
        alphaHi = 0.5;
      }
    }

    if (hitThisStep) {
      var aLo : f32 = 0.0;
      var aHi : f32 = alphaHi;
      var rLo : f32 = r;
      var rHi : f32 = select(evalKerrR(evalHermite(pos, v0, posNext, v1, alphaHi), a2), rNext, alphaHi > 0.75);

      for (var bi: i32 = 0; bi < 6; bi++) {
        let aMid = 0.5 * (aLo + aHi);
        let xMid = evalHermite(pos, v0, posNext, v1, aMid);
        let rMid = evalKerrR(xMid, a2);
        if (rMid <= 1.0) {
          aHi = aMid;
          rHi = rMid;
        } else {
          aLo = aMid;
          rLo = rMid;
        }
      }

      let denomR = rLo - rHi;
      let secFrac = select(0.5, clamp((rLo - 1.0) / denomR, 0.0, 1.0), abs(denomR) > 1e-6);
      let alphaHit = mix(aLo, aHi, secFrac);
      let posHit = evalHermite(pos, v0, posNext, v1, alphaHit);
      let pHit   = mix(p, pNext, alphaHit);
      let velHit = mix(k1.dpos, velEnd, alphaHit);

      let segHit = length(posHit - pos);
      if (segHit > 1e-5) {
        let jF = fract(bn.y + f32(step) * 0.61803399);
        let samplePos = mix(pos, posHit, jF);
        let rSamp = evalKerrR(samplePos, a2);
        if (rSamp > 1.025 && rSamp < volBoundR) {
          let camDistFade = smoothstep(0.25, 1.75, rayDist + jF * segHit);

          let va = evalPulsarVolume(
            samplePos, velHit, rSamp, simTime, betaEq, spinPhase, mu0, em1_0, em2_0,
            twistShear, rLightCylVis, plasmaDensity, beamIntensity, beamConeHalfAngle,
            cosMaxCone, pwnVisibility, pwnJetPower, spinVisualSpeed, camDistFade
          );

          let tau = max(va.extinction, 0.0) * segHit;
          if (tau > 1e-5 || dot(va.emission, va.emission) > 1e-10) {
            let stepT = exp(-min(tau, 40.0));
            let stepRad = select(
              va.emission * segHit,
              va.emission * ((1.0 - stepT) / max(va.extinction, 1e-5)),
              tau > 1e-4
            );
            radiance += transmittance * stepRad;
            transmittance *= stepT;
          }
        }
      }

      let surfRad = shadeNeutronStarSurface(
        posHit, pHit, pt, velHit, M, a, a2, lensing, betaEq, spinPhase,
        mu0, em1_0, em2_0, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
      );
      radiance += transmittance * surfRad;
      hitStar = true;
      break;
    }

    let segLen = length(posNext - pos);
    let jFrac = fract(bn.y + f32(step) * 0.61803399);
    let samplePos = mix(pos, posNext, jFrac);
    let rSamp = evalKerrR(samplePos, a2);
    if (rSamp > 1.025 && rSamp < volBoundR) {
      let sampleVel = mix(k1.dpos, velEnd, jFrac);
      let camDistFade = smoothstep(0.25, 1.75, rayDist + jFrac * segLen);

      let va = evalPulsarVolume(
        samplePos, sampleVel, rSamp, simTime, betaEq, spinPhase, mu0, em1_0, em2_0,
        twistShear, rLightCylVis, plasmaDensity, beamIntensity, beamConeHalfAngle,
        cosMaxCone, pwnVisibility, pwnJetPower, spinVisualSpeed, camDistFade
      );

      let tau = max(va.extinction, 0.0) * segLen;
      if (tau > 1e-5 || dot(va.emission, va.emission) > 1e-10) {
        let stepT = exp(-min(tau, 40.0));
        let stepRad = select(
          va.emission * segLen,
          va.emission * ((1.0 - stepT) / max(va.extinction, 1e-5)),
          tau > 1e-4
        );
        radiance += transmittance * stepRad;
        transmittance *= stepT;
      }
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;

    if (transmittance < 0.004) {
      break;
    }
  }

  if (!hitStar && !escaped) {
    let rEnd = evalKerrR(pos, a2);
    if (rEnd <= 1.02) {
      hitStar = true;
    } else {
      escaped = true;
    }
  }

  let escFlag = select(0.0, 1.0, escaped && !hitStar && transmittance > 0.004);
  let edgeMask = fwidth(escFlag);
  let safeSkyDir = select(localRay, normalize(finalVel), dot(finalVel, finalVel) > 1e-10);
  let skyColor = sampleSkyBackground(safeSkyDir, skyIntensity, skyMode, skyRot, escFlag > 0.5, edgeMask);

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  }

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));
  return vec4f(radiance, 1.0);
}
`;
