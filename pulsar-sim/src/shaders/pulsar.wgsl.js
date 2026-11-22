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
  var outD: GeodesicDeriv;
  let y2 = pos.y * pos.y;

  if (a2 < 1e-6) {
    let r2 = max(dot(pos, pos), 1e-8);
    let invR = inverseSqrt(r2);
    let r = r2 * invR;
    let l = pos * invR;
    let H = lensing * M * invR;
    let lp = dot(l, p);
    let L = pt + lp;
    let twoHL = 2.0 * H * L;

    outD.dpos = p - twoHL * l;
    outD.r = r;
    outD.dp = select(
      invR * (twoHL * p - (H * L * L + twoHL * lp) * l),
      vec3f(0.0),
      lensing <= 1e-6
    );
    return outD;
  }

  if (a2 < 1e-4) {
    let r2 = max(dot(pos, pos), 1e-8);
    let invR = inverseSqrt(r2);
    let r = r2 * invR;
    let invR2 = invR * invR;
    let rHat = pos * invR;
    let aInvR2 = a * invR2;
    let l = rHat + aInvR2 * vec3f(pos.z, 0.0, -pos.x);
    let H = lensing * M * invR;
    let L = pt + dot(l, p);
    let twoHL = 2.0 * H * L;

    outD.dpos = p - twoHL * l;
    outD.r = r;

    if (lensing <= 1e-6) {
      outD.dp = vec3f(0.0);
      return outD;
    }

    let S = -(dot(p, pos) + 2.0 * a * invR * (p.x * pos.z - p.z * pos.x)) * invR2;
    let w = p * invR + aInvR2 * vec3f(-p.z, 0.0, p.x) + S * rHat;
    outD.dp = (-H * invR * L * L) * rHat + twoHL * w;
    return outD;
  }

  let uVal = dot(pos, pos) - a2;
  let disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  let r2 = max(0.5 * (uVal + disc), 1e-8);
  let invR = inverseSqrt(r2);
  let r = r2 * invR;
  let r4 = r2 * r2;
  let a2y2 = a2 * y2;
  let invD = 1.0 / max(r4 + a2y2, 1e-10);
  let H = lensing * M * (r * r2) * invD;
  let R2 = r2 + a2;
  let invR2 = 1.0 / max(R2, 1e-8);
  let l = vec3f(
    (r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (r * pos.z - a * pos.x) * invR2
  );
  let L = pt + dot(l, p);
  let twoHL = 2.0 * H * L;

  outD.dpos = p - twoHL * l;
  outD.r = r;

  if (lensing <= 1e-6) {
    outD.dp = vec3f(0.0);
    return outD;
  }

  let gradR = vec3f(r * r2 * pos.x, r * R2 * pos.y, r * r2 * pos.z) * invD;
  let hFac = H * invR * invD;
  let cR = 3.0 * a2y2 - r4;
  var gradH = (hFac * cR) * gradR;
  gradH.y -= hFac * (2.0 * r * a2 * pos.y);

  let S = (p.x * (pos.x - 2.0 * r * l.x) + p.z * (pos.z - 2.0 * r * l.z)) * invR2
        - p.y * l.y * invR;

  let w = vec3f(
    (r * p.x - a * p.z) * invR2,
    p.y * invR,
    (a * p.x + r * p.z) * invR2
  ) + S * gradR;

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
  let normT = clamp(max(physTempK, 1.0e5) / 6.0e6, 0.02, 2.2);
  return clamp(11500.0 + 28500.0 * pow(normT, 0.55), 11500.0, T_MAX);
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

  let fw = clamp(pixelFw * scale, 0.024, 0.20);
  let starRad = mix(0.032, 0.096, mag) + fw * 0.48;
  let core = exp(-min((dist * dist) / max(starRad * starRad * 0.36, 1e-5), 40.0));
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
  simTime: f32,
  spinPhase: f32,
  sinObl: f32,
  cosObl: f32,
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

  let cosM = rHatBody.x * sinObl + rHatBody.y * cosObl;
  let sinM = sqrt(max(1.0 - cosM * cosM, 0.0));
  let xM = rHatBody.x * cosObl - rHatBody.y * sinObl;
  let yM = -rHatBody.z;
  let phiM = select(0.0, atan2(yM, xM), abs(xM) + abs(yM) > 1e-6);
  let signCosM = select(-1.0, 1.0, cosM >= 0.0);

  // Exact Greenstein & Hartke (1983) dipolar anisotropic electron thermal conduction
  let cos2M = cosM * cosM;
  let cos2B = (4.0 * cos2M) / (1.0 + 3.0 * cos2M);
  let anisoTemp = pow(max(cos2B + 0.26 * (1.0 - cos2B), 1e-4), 0.25);

  // Silky magnetized atmospheric plasma shimmer, meridian thermal striations & loop footpoint glow
  let shearCoord = pBody * 0.36 + vec3f(0.17, 0.31, 0.53);
  let nCrust = textureSampleLevel(uVolumeNoise, sVolume, shearCoord, 0.0);
  let fineCoord = pBody * 0.85 + (nCrust.rgb - vec3f(0.5)) * 0.26
                + vec3f(0.18 * twistShear * signCosM * pBody.z, 0.0, -0.18 * twistShear * signCosM * pBody.x);
  let nFine = textureSampleLevel(uVolumeNoise, sVolume, fineCoord, 0.0);
  let microCoord = pBody * 2.4 + vec3f(0.0, simTime * 0.08, 0.0);
  let nMicro = textureSampleLevel(uVolumeNoise, sVolume, microCoord, 0.0);
  let meridianWave = 0.5 + 0.5 * sin(phiM * 7.0 + twistShear * 2.2 * cosM + nCrust.g * 3.4);
  let meridianFine = 0.5 + 0.5 * cos(phiM * 15.0 - twistShear * 3.1 * cosM + nFine.r * 4.2);
  let meridianStreak = mix(1.0, 0.84 + 0.24 * meridianWave * (0.55 + 0.45 * meridianFine), sinM);
  let plasmaShimmer = (0.82 + 0.16 * nCrust.r + 0.14 * nFine.g + 0.12 * nMicro.a) * meridianStreak;
  let footGlow = smoothstep(0.56, 0.90, nFine.g * (0.50 + 0.50 * nMicro.r)) * sinM * (0.35 + 0.65 * meridianWave);

  let sinThetaPc = clamp(inverseSqrt(max(rLightCylVis, 1.5)), 0.16, 0.62);
  let sinPerturb = sinM + (nFine.r - 0.5) * 0.028 * sinM;

  let crownNorm = sinPerturb / max(sinThetaPc * 1.75, 0.12);
  let capCrown = exp(-min(crownNorm * crownNorm, 40.0));
  let capCore = 1.0 - smoothstep(sinThetaPc * 0.12, sinThetaPc * 0.96, sinPerturb);
  let capIn = sinPerturb / max(sinThetaPc * 0.50, 0.06);
  let capInner = exp(-min(capIn * capIn, 40.0));
  let capRimDist = (sinPerturb - sinThetaPc * 0.96) / max(sinThetaPc * 0.13, 0.028);
  let capRim = exp(-min(capRimDist * capRimDist, 40.0));

  let driftPhi = phiM - simTime * 0.65 * signCosM;
  let sparkWave = 0.5 + 0.5 * sin(5.0 * driftPhi + twistShear * 1.8 * signCosM + nCrust.g * 3.8);
  let sparkFine = 0.5 + 0.5 * cos(11.0 * driftPhi - 2.4 * twistShear * signCosM + nFine.a * 4.5);
  let auroralSparks = 0.35 + 0.65 * (sparkWave * sparkWave) * (0.45 + 0.55 * sparkFine);

  // Azimuthally-sheared branching magnetar plasma fault ribbons
  var faultHalo : f32 = 0.0;
  var faultCore : f32 = 0.0;
  var crackDrive : f32 = 0.0;
  if (magnetarCrackGlow > 0.001) {
    let arcCoordA = vec3f(
      cos(phiM * 2.0 + twistShear * 1.4 * cosM) * 0.42 + pBody.x * 0.35,
      sin(phiM * 2.0 + twistShear * 1.4 * cosM) * 0.42 + pBody.z * 0.35,
      cosM * 1.65 + 0.25 * nCrust.r
    );
    let nArcA = textureSampleLevel(uVolumeNoise, sVolume, arcCoordA, 0.0);
    let arcCoordB = pBody * 1.65 + (nArcA.rgb - vec3f(0.5)) * 0.55
                  + vec3f(0.35 * twistShear * signCosM * pBody.z, 0.0, -0.35 * twistShear * signCosM * pBody.x);
    let nArcB = textureSampleLevel(uVolumeNoise, sVolume, arcCoordB, 0.0);

    let shearBelt = 0.22 + 0.78 * (4.0 * cos2M * (1.0 - cos2M));
    let rA = clamp(nArcA.g, 1e-5, 1.0);
    let rB = clamp(nArcB.g * 0.72 + nArcB.a * 0.42, 1e-5, 1.0);
    let arcRibbon = pow(rA, 2.8) * pow(rB, 2.2) * (0.45 + 0.55 * nArcA.a);
    let faultNet = arcRibbon * shearBelt * 2.2;

    faultHalo = smoothstep(0.06, 0.36, faultNet);
    faultCore = smoothstep(0.24, 0.62, faultNet);
    crackDrive = pow(magnetarCrackGlow, 1.25) * (0.65 + 0.35 * clamp(twistShear, 0.0, 2.5));
  }

  let g = computeCrustFrequencyShift(posHit, f, pHit, pt, a, a2, betaEq);

  let vRayDir = select(surfNormal, normalize(velHit), dot(velHit, velHit) > 1e-10);
  let muLimb = clamp(dot(surfNormal, -vRayDir), 0.0, 1.0);
  let limbDark = mix(0.32, 1.0, pow(max(muLimb, 1e-5), 0.45));
  let atmoRim = pow(max(1.0 - muLimb, 1e-5), 2.8) * 1.35;

  let T_crust = crustTempK * anisoTemp * plasmaShimmer;
  let crustCol = sampleBlackbody(mapPulsarTempToLut(T_crust * g));
  let crustLum = 1.42 * pow(clamp(T_crust / 1.4e6, 0.35, 3.0), 1.22);
  let eqSapphire = vec3f(0.24, 0.56, 1.00);
  let hiIceCyan = crustCol * vec3f(0.72, 0.92, 1.20);
  let latBlend = smoothstep(0.70, 0.99, anisoTemp);
  let crustTint = mix(eqSapphire, hiIceCyan, latBlend);
  let latGain = mix(0.92, 1.95, latBlend);
  let crustEmit = crustTint * (crustLum * latGain) + hiIceCyan * (footGlow * crustLum * 0.72);

  let haloCol = vec3f(0.46, 0.22, 1.00);
  let coreCrackCol = mix(sampleBlackbody(mapPulsarTempToLut(max(crustTempK * 2.8, 6.0e6) * g)), vec3f(0.90, 0.97, 1.00), 0.65);
  let crackEmit = (haloCol * (faultHalo * 5.2) + coreCrackCol * (faultCore * 18.0)) * crackDrive;

  let sparkCore = 0.65 + 0.55 * nMicro.g * (0.55 + 0.45 * auroralSparks);
  let T_cap = polarCapTempK * (0.85 + 0.45 * capInner + 0.16 * nFine.g);
  let capCol = sampleBlackbody(mapPulsarTempToLut(T_cap * g));
  let crownTint = mix(vec3f(0.22, 0.72, 1.00), capCol, 0.55);
  let capStr = (capCore * 1.05 + capInner * 2.10) * sparkCore;
  let pairRimCol = mix(vec3f(0.28, 0.82, 1.00), vec3f(0.92, 0.98, 1.00), auroralSparks);
  let capEmit = crownTint * (capCrown * 3.2)
              + capCol * (capStr * 15.5)
              + pairRimCol * (capRim * auroralSparks * 10.5);

  let g2 = g * g;
  let g4 = g2 * g2;
  let relFlux = g4 / (1.0 + 0.05 * g4);

  let totalSurf = (crustEmit + crackEmit + capEmit) * limbDark * relFlux
                + vec3f(0.42, 0.84, 1.00) * (atmoRim * g * (0.95 + 0.45 * crackDrive));
  return max(totalSurf, vec3f(0.0));
}

// ============================================================================
// 4. VOLUMETRIC MAGNETOSPHERE, LIGHTHOUSE BEAMS, PWN TORUS & POLAR JETS
// ============================================================================

fn evalPulsarVolume(
  pos: vec3f,
  toCamDir: vec3f,
  r: f32,
  invR: f32,
  simTime: f32,
  spinPhase: f32,
  sinObl: f32,
  cosObl: f32,
  twistShear: f32,
  twistFactor: f32,
  rLightCylVis: f32,
  invSepW: f32,
  retardFactor: f32,
  rMagLoopMax: f32,
  rSheetMin: f32,
  rSheetMax: f32,
  rMagOuter: f32,
  plasmaDensity: f32,
  beamIntensity: f32,
  beamConeHalfAngle: f32,
  cosMaxCone: f32,
  pwnVisibility: f32,
  jetAmp: f32,
  spinVisualSpeed: f32,
  camDistFade: f32,
  segCorotBeam: f32,
  segNeedsMag: bool,
  segNeedsBeam: bool,
  segNeedsPwn: bool,
  segNeedsJet: bool
) -> vec4f {
  var emission = vec3f(0.0);
  var nearMagFlag : f32 = 0.0;

  let needMag  = segNeedsMag && (r < rMagOuter);
  let needBeam = segNeedsBeam && (r < 18.0);
  var checkMagOrBeam = needMag;
  if (!checkMagOrBeam && needBeam) {
    let absCosSpin = abs(pos.y) * invR;
    let sinSpin = sqrt(max(1.0 - absCosSpin * absCosSpin, 0.0));
    let maxPossibleCosM = absCosSpin * abs(cosObl) + sinSpin * abs(sinObl);
    checkMagOrBeam = (maxPossibleCosM > cosMaxCone);
  }

  if (checkMagOrBeam) {
    let deltaPhi = -max(r - 1.0, 0.0) * retardFactor;
    let phaseRet = spinPhase + deltaPhi;
    let cRet = cos(phaseRet);
    let sRet = sin(phaseRet);
    let pRot = vec3f(cRet * pos.x - sRet * pos.z, pos.y, sRet * pos.x + cRet * pos.z);

    let zM = pRot.x * sinObl + pRot.y * cosObl;
    let xM = pRot.x * cosObl - pRot.y * sinObl;
    let yM = -pRot.z;
    let rhoM2 = xM * xM + yM * yM;
    let sin2Theta = max(rhoM2 * invR * invR, 1e-5);
    let cosThetaM = zM * invR;
    let L = r / sin2Theta;
    nearMagFlag = select(0.0, 1.0, L < rMagLoopMax * 1.18);

    let inCorona = segNeedsMag && (r < 2.05);
    let inLoops  = needMag && (L > 1.04 && L < rMagLoopMax);
    let inSheet  = segNeedsMag && (r > rSheetMin && r < rSheetMax && abs(cosThetaM) < 0.097);

    if (inCorona || inLoops || inSheet) {
      // 4A-0. Optically-Thin Relativistic Magnetized Inner Corona (1.01 < r < 2.05)
      if (inCorona) {
        let coronaRad = smoothstep(1.01, 1.035, r) * exp(-min((r - 1.0) * 5.4, 40.0));
        let poleBoost = 0.75 + 0.55 * abs(cosThetaM);
        let coronaDens = coronaRad * poleBoost * (0.18 + 0.12 * plasmaDensity) * segCorotBeam * camDistFade;
        let coronaCol = mix(vec3f(0.18, 0.64, 1.00), vec3f(0.84, 0.96, 1.00), exp(-min((r - 1.0) * 9.0, 40.0)));
        emission += coronaCol * (coronaDens * 0.48);
      }

      // 4A. Crisp Field-Aligned Dipole / Twisted-Dipole Flux Loops
      if (inLoops) {
        let logL = log(L);
        let sepDist = (L - rLightCylVis * 0.90) * invSepW;
        let sepSq = sepDist * sepDist * 2.5;
        let sBApprox = sin(logL * 9.5 + 0.225);
        let lEnv = smoothstep(1.04, 1.24, L) * (1.0 - smoothstep(rLightCylVis * 0.88, rMagLoopMax, L));
        let rFade = smoothstep(1.02, 1.15, r) / (1.0 + 0.36 * pow(max(r - 1.0, 1e-5), 1.55));

        let cIce    = vec3f(0.68, 0.94, 1.00);
        let cCyan   = vec3f(0.06, 0.44, 1.00);
        let cViolet = vec3f(0.32, 0.10, 0.98);
        var magCol = mix(cViolet, cCyan, smoothstep(rLightCylVis, 1.35, L));

        if (sBApprox < -0.525 && sepSq >= 12.0) {
          let magDens = lEnv * rFade * 0.00555 * plasmaDensity * segCorotBeam * camDistFade;
          if (twistFactor > 0.001) {
            magCol = mix(magCol, vec3f(0.48, 0.14, 1.00), twistFactor * 0.45);
          }
          emission += magCol * (magDens * 0.125);
        } else {
          let invL = sin2Theta * invR;
          let dTwist = twistShear * cosThetaM * (1.0 - invL) * 2.2;
          let hasAz = rhoM2 > 1e-10;
          let invRhoM = select(1.0, inverseSqrt(max(rhoM2, 1e-10)), hasAz);
          let cPhi = select(1.0, xM * invRhoM, hasAz);
          let sPhi = select(0.0, yM * invRhoM, hasAz);
          let cTw = cos(dTwist);
          let sTw = sin(dTwist);
          let cTwist = cPhi * cTw + sPhi * sTw;
          let sTwist = sPhi * cTw - cPhi * sTw;

          let qRad = 0.55 + 0.22 * logL;
          let flowMag = simTime * (0.35 + 0.45 * spinVisualSpeed);
          let qMag = vec3f(
            cTwist * qRad,
            sTwist * qRad,
            cosThetaM * 1.85 - flowMag
          );
          let nMag = textureSampleLevel(uVolumeNoise, sVolume, qMag, 0.0);

          let sB0 = clamp(0.5 + 0.5 * sin(logL * 9.5 + 0.45 * nMag.r), 0.0, 1.0);
          let sepEnv = select(0.0, exp(-sepSq), sepSq < 12.0);

          var filamentCore : f32 = 0.0;
          if (sB0 > 0.35 || sepEnv > 1e-4) {
            let c2 = cTwist * cTwist - sTwist * sTwist;
            let s2 = 2.0 * cTwist * sTwist;
            let c4 = c2 * c2 - s2 * s2;
            let s4 = 2.0 * c2 * s2;
            let c8 = c4 * c4 - s4 * s4;
            let s8 = 2.0 * c4 * s4;
            let c10 = c8 * c2 - s8 * s2;
            let s10 = s8 * c2 + c8 * s2;
            let c18 = c10 * c8 - s10 * s8;
            let s18 = s10 * c8 + c10 * s8;

            let angB = 0.65 * nMag.b - 1.4 * logL;
            let fB = clamp(0.5 + 0.5 * (c18 * cos(angB) - s18 * sin(angB)), 0.0, 1.0);
            let fB2 = fB * fB;
            let fB4 = fB2 * fB2;
            let tubeB = fB4 * fB4 * fB4;

            var shellBands : f32 = 0.0;
            var tubeA : f32 = 0.0;
            if (sB0 > 0.35) {
              let sB2 = sB0 * sB0;
              shellBands = sB2 * sB2 * sB2 * sB2 * sB2;
              let A = 0.55 * nMag.r;
              let A2 = A * A;
              let cosA = 1.0 - A2 * (0.5 - A2 * 0.0416667);
              let sinA = A * (1.0 - A2 * (0.1666667 - A2 * 0.0083333));
              let fA = clamp(0.5 + 0.5 * (c10 * cosA - s10 * sinA), 0.0, 1.0);
              let fA2 = fA * fA;
              let fA4 = fA2 * fA2;
              tubeA = fA4 * fA4 * fA4 * fA2;
            }

            filamentCore = min(
              1.85 * tubeA * shellBands + 0.85 * tubeB * shellBands + 1.10 * sepEnv * (0.25 + 0.95 * tubeB),
              2.5
            );
          }

          let tubeStruct = (0.006 + filamentCore * (0.45 + 0.75 * nMag.a)) * (0.65 + 0.55 * nMag.g);
          let magDens = lEnv * rFade * tubeStruct * plasmaDensity * segCorotBeam * camDistFade;

          magCol = mix(magCol, cIce, min(filamentCore * 0.55, 1.0));

          if (twistFactor > 0.001) {
            let twistCore = select(0.0, pow(min(filamentCore * 0.60, 1.0), 1.25), filamentCore > 1e-4);
            let jViolet = vec3f(0.48, 0.14, 1.00);
            let jWhiteViolet = vec3f(0.86, 0.82, 1.00);
            let twistCol = mix(jViolet, jWhiteViolet, twistCore);
            magCol = mix(magCol, twistCol, twistFactor * (0.45 + 0.55 * twistCore));
          }

          emission += magCol * (magDens * 0.125);
        }
      }

      // 4A-2. Delicate Retarded Equatorial Current Sheet & Y-Point Reconnection
      if (inSheet) {
        let sheetRatio = cosThetaM * (1.0 / 0.042);
        let sheetProf = exp(-sheetRatio * sheetRatio);
        if (sheetProf > 0.005) {
          let yPtDist = (r - 0.96 * rLightCylVis) / max(0.14 * rLightCylVis, 0.35);
          let yPoint = exp(-min(yPtDist * yPtDist, 40.0)) * 1.45;
          let sheetEnv = smoothstep(rSheetMin, 0.94 * rLightCylVis, r)
                       * (1.0 - smoothstep(rSheetMax * 0.72, rSheetMax, r))
                       / (1.0 + 0.18 * max(r - rSheetMin, 0.0));

          let hasAzS = rhoM2 > 1e-10;
          let invRhoS = select(1.0, inverseSqrt(max(rhoM2, 1e-10)), hasAzS);
          let cPhiS = select(1.0, xM * invRhoS, hasAzS);
          let sPhiS = select(0.0, yM * invRhoS, hasAzS);
          let flowSheet = r * 0.32 - simTime * (0.75 + 0.95 * spinVisualSpeed);
          let nSheet = textureSampleLevel(uVolumeNoise, sVolume, vec3f(cPhiS * 0.65, sPhiS * 0.65, flowSheet), 0.0);
          let plasmoids = 0.35 + 1.15 * pow(max(nSheet.g, 1e-5), 2.2) * (0.5 + 0.5 * nSheet.a);

          let sheetDens = sheetEnv * sheetProf * (plasmoids + yPoint * (0.65 + 0.55 * nSheet.g))
                        * plasmaDensity * segCorotBeam * camDistFade;
          let sheetCol = mix(
            vec3f(0.20, 0.30, 0.98),
            vec3f(0.68, 0.92, 1.00),
            clamp(sheetProf * 0.75 + yPoint * 0.45, 0.0, 1.0)
          );
          emission += sheetCol * (sheetDens * 0.045);
        }
      }
    }

    // 4B. Sweeping Lighthouse Synchrotron / Curvature Beams around +-muHat
    if (needBeam) {
      let absCosB = abs(cosThetaM);
      if (absCosB > cosMaxCone) {
        let sinB = sqrt(max(1.0 - absCosB * absCosB, 0.0));
        let thetaB = atan2(sinB, absCosB);
        let thetaCone = beamConeHalfAngle * mix(0.56, 1.04, smoothstep(1.0, 4.2, r));
        let coneW = max(thetaCone * 0.18, 0.030);
        let coreW = max(thetaCone * 0.22, 0.036);

        if (thetaB < thetaCone + 3.4 * coneW) {
          let cd = (thetaB - thetaCone) / coneW;
          let hollowCone = exp(-min(cd * cd, 40.0));
          let kd = thetaB / coreW;
          let coreBeam = exp(-min(kd * kd, 40.0)) * 0.92;

          let radialOnset = smoothstep(1.01, 1.18, r)
                          * (1.0 - smoothstep(10.5, 18.0, r))
                          / (1.0 + 0.22 * r * r);

          let hasAzB = rhoM2 > 1e-10;
          let invRhoB = select(1.0, inverseSqrt(max(rhoM2, 1e-10)), hasAzB);
          let cPhiB = select(1.0, xM * invRhoB, hasAzB);
          let sPhiB = select(0.0, yM * invRhoB, hasAzB);
          let phiB = select(0.0, atan2(yM, xM), hasAzB);
          let flowOut = r * 0.28 - simTime * (0.95 + 1.25 * spinVisualSpeed);
          let qBeam = vec3f(cPhiB * 0.68, sPhiB * 0.68, flowOut);
          let nBeam = textureSampleLevel(uVolumeNoise, sVolume, qBeam, 0.0);
          let streakCos = clamp(0.5 + 0.5 * cos(8.0 * phiB + 0.6 * nBeam.r + r * 0.35 - simTime * 2.2), 0.0, 1.0);
          let sc2 = streakCos * streakCos;
          let subPulses = (0.30 + 0.90 * nBeam.g * nBeam.g) * (0.40 + 0.60 * sc2 * sc2) * (0.65 + 0.35 * nBeam.a);

          let signMu = select(-1.0, 1.0, cosThetaM >= 0.0);
          let muRetLab = signMu * vec3f(cRet * sinObl, cosObl, -sRet * sinObl);
          let rHatLab = pos * invR;
          let beamDir = normalize(mix(muRetLab, rHatLab, 0.42));
          let cosForward = dot(beamDir, toCamDir);
          let dopplerBeam = 1.0 / max(1.0 - 0.62 * cosForward, 0.26);
          let beaming = pow(clamp(dopplerBeam, 0.35, 3.8), 1.75);

          var beamCol = mix(vec3f(0.32, 0.16, 1.00), vec3f(0.12, 0.68, 1.00), clamp(hollowCone + coreBeam, 0.0, 1.0));
          beamCol = mix(beamCol, vec3f(0.92, 0.98, 1.00), smoothstep(1.15, 3.0, beaming) * 0.88);

          let beamVal = beamIntensity * radialOnset * (hollowCone * 1.10 + coreBeam * 0.95)
                      * subPulses * beaming * camDistFade;
          emission += beamCol * (beamVal * 0.34);
        }
      }
    }
  }

  // 4C. Chandra/Hubble-Faithful PWN Equatorial Termination Shock Ring & Outward Synchrotron Wisps
  if (segNeedsPwn && r > 2.55 && r < 8.8 && abs(pos.y) < 1.32) {
    let hRing = 0.12 + 0.03 * r;
    let absY = abs(pos.y);
    if (absY < hRing * 3.4) {
      let yT = absY / max(hRing, 1e-4);
      let vertTorus = exp(-min(yT * yT * 1.85, 40.0));
      let dr = (yT - 0.62) / 0.30;
      let doubleRing = 0.62 + 0.58 * exp(-min(dr * dr, 40.0));

      let radEnv = smoothstep(2.55, 3.15, r)
                 * (1.0 - smoothstep(6.0, 8.8, r))
                 / (1.0 + 0.055 * r * r);
      let tsDist = (r - 3.25) / 0.20;
      let termShock = exp(-min(tsDist * tsDist, 40.0)) * 2.4;

      let rhoXZ2 = pos.x * pos.x + pos.z * pos.z;
      let invRhoXZ = inverseSqrt(max(rhoXZ2, 1e-12));
      let cAz = pos.x * invRhoXZ;
      let sAz = pos.z * invRhoXZ;
      let rotAngle = 0.18 * simTime * (0.4 + spinVisualSpeed) - 0.28 * r;
      let cr = cos(rotAngle);
      let sr = sin(rotAngle);
      let cp = cAz * cr - sAz * sr;
      let sp = sAz * cr + cAz * sr;

      let pwnCoordA = vec3f(cp * 0.32 + r * 0.09, sp * 0.32 + r * 0.09, pos.y * 0.65);
      let pwnCoordB = vec3f(cp * 0.72 - r * 0.16, sp * 0.72 + r * 0.16, pos.y * 1.15);
      let nPwnA = textureSampleLevel(uVolumeNoise, sVolume, pwnCoordA, 0.0);
      let nPwnB = textureSampleLevel(uVolumeNoise, sVolume, pwnCoordB, 0.0);

      let wispPhase = r * 2.55 - simTime * (0.55 + 0.75 * spinVisualSpeed) + (nPwnA.r - 0.5) * 1.45;
      let w0 = max(0.5 + 0.5 * sin(wispPhase), 0.0);
      let w2 = w0 * w0;
      let w4 = w2 * w2;
      let wisps = w4 * w2 * w0 * sqrt(max(w0, 1e-5));
      let filaments = (0.28 + 1.25 * nPwnA.g * nPwnA.g) * (0.45 + 0.75 * nPwnB.a);
      let tsKnots = 0.55 + 0.95 * pow(max(nPwnB.g, 1e-5), 1.6);

      // Authentic post-shock relativistic outflow Doppler asymmetry (beta_PWN = 0.42, capped cleanly)
      let radEqDir = vec3f(cAz, 0.0, sAz);
      let cosOut = dot(radEqDir, toCamDir);
      let dopPwn = 1.0 / max(1.0 - 0.42 * cosOut, 0.45);
      let pwnBeam = pow(clamp(dopPwn, 0.45, 1.85), 1.75);

      let torusDens = pwnVisibility * radEnv * vertTorus * doubleRing
                    * (0.01 * filaments + 1.55 * wisps * filaments + termShock * tsKnots)
                    * pwnBeam * camDistFade;

      var torusCol = mix(vec3f(0.24, 0.12, 0.95), vec3f(0.06, 0.56, 1.00), smoothstep(8.2, 3.1, r));
      torusCol = mix(
        torusCol,
        vec3f(0.82, 0.96, 1.00),
        clamp(wisps * 0.65 + termShock * 0.45 + smoothstep(1.25, 1.85, pwnBeam) * 0.35, 0.0, 1.0)
      );

      emission += torusCol * (torusDens * 0.062);
    }
  }

  // 4D. Sleek Kink-Braided Relativistic Polar Jets (+-Y)
  if (segNeedsJet) {
    let absY = abs(pos.y);
    let rhoXZ2 = dot(pos.xz, pos.xz);
    if (rhoXZ2 < 3.6 && absY >= 1.25 && absY <= 18.0) {
      let signY = select(-1.0, 1.0, pos.y >= 0.0);
      let kinkAmp = smoothstep(2.2, 11.5, absY) * 0.28;
      let kinkAng = signY * (absY * 0.42 - simTime * (0.45 + 0.75 * spinVisualSpeed));
      let jetCenter = vec2f(cos(kinkAng), sin(kinkAng)) * kinkAmp;
      let relXZ = pos.xz - jetCenter;
      let rho = length(relXZ);
      let jetRadius = 0.11 + 0.052 * pow(max(absY - 1.15, 0.0), 0.76);
      if (rho < jetRadius * 2.8) {
        let uRad = rho / max(jetRadius, 1e-4);
        let spine = exp(-min(uRad * uRad * 7.0, 40.0));
        let braidEnv = exp(-min(uRad * uRad * 2.4, 40.0));
        let halo = exp(-min(uRad * uRad * 0.85, 40.0)) * 0.16;

        let yEnv = smoothstep(1.25, 2.6, absY)
                 * (1.0 - smoothstep(10.5, 18.0, absY))
                 / (1.0 + 0.12 * absY);

        let helixAngle = signY * (absY * 0.92 - simTime * (0.75 + 1.45 * spinVisualSpeed));
        let ch = cos(helixAngle);
        let sh = sin(helixAngle);
        let rotXZ = vec2f(ch * relXZ.x - sh * relXZ.y, sh * relXZ.x + ch * relXZ.y);

        let flowY = absY * 0.22 - simTime * (0.42 + 0.75 * spinVisualSpeed);
        let jn = textureSampleLevel(uVolumeNoise, sVolume, vec3f(rotXZ * 0.62, flowY), 0.0);

        let rawFil = clamp(jn.y * 0.64 + jn.w * 0.54, 0.0, 1.0);
        let filaments = rawFil * rawFil * rawFil;
        let knotWave = max(0.5 + 0.5 * sin(absY * 1.45 - simTime * (0.85 + 1.25 * spinVisualSpeed) + jn.r * 2.2), 0.0);
        let kw2 = knotWave * knotWave;
        let knots = 0.35 + 1.25 * (kw2 * kw2);

        let radProf = spine * 0.85 + braidEnv * (0.35 + 0.95 * filaments) + halo;

        let cosTheta = signY * toCamDir.y;
        let dopplerJet = 1.0 / max(1.0 - 0.55 * cosTheta, 0.28);
        let jetBeam = pow(clamp(dopplerJet, 0.38, 2.6), 1.55);
        let viewColAtten = mix(1.0, 0.28, pow(max(abs(cosTheta), 1e-5), 1.55));

        let coreCol   = vec3f(0.86, 0.97, 1.00);
        let sheathCol = vec3f(0.08, 0.54, 1.00);
        let outerCol  = vec3f(0.36, 0.12, 0.96);
        var jetCol = mix(sheathCol, coreCol, clamp(spine * 0.90 + filaments * 0.45, 0.0, 1.0));
        jetCol = mix(jetCol, outerCol, smoothstep(0.55, 1.80, uRad) * 0.72);

        let rawInt = jetAmp * radProf * yEnv * knots * jetBeam * viewColAtten * camDistFade;
        let intensity = rawInt / (1.0 + rawInt * 0.38);
        emission += jetCol * (intensity * 0.28);
      }
    }
  }

  return vec4f(emission, nearMagFlag);
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

  let maxThetaCone = beamConeHalfAngle * 1.04;
  let maxConeW = max(maxThetaCone * 0.24, 0.038);
  let maxBeamAngle = maxThetaCone + 3.2 * maxConeW;
  let cosMaxCone = select(-0.01, cos(maxBeamAngle), maxBeamAngle < 1.56);

  let twistFactor = smoothstep(0.60, 1.85, twistShear);
  let invSepW = 1.0 / max(rLightCylVis * 0.11, 0.34);
  let invRLc = 1.0 / rLightCylVis;
  let retardFactor = (0.85 + 0.55 * betaEq) * invRLc;
  let rMagLoopMax = rLightCylVis * 1.14;
  let rSheetMin = 0.80 * rLightCylVis;
  let rSheetMax = min(rLightCylVis * 1.45, 10.5);
  let rMagOuter = max(rMagLoopMax, rSheetMax);
  let jetAmp = pwnVisibility * pwnJetPower;

  let hasMag  = (plasmaDensity > 0.001);
  let hasBeam = (beamIntensity > 0.001);
  let hasPwn  = (pwnVisibility > 0.001);
  let hasJet  = (jetAmp > 0.001);

  var volBoundR : f32 = 1.01;
  if (hasMag)  { volBoundR = max(volBoundR, rMagOuter); }
  if (hasPwn)  { volBoundR = max(volBoundR, 8.8); }
  if (hasBeam) { volBoundR = max(volBoundR, 18.0); }
  if (hasJet)  { volBoundR = max(volBoundR, 18.1); }

  let ray0 = initCameraRay(camPos, camRight, camUp, camFwd, localRay, M, a, a2, lensing);
  var pos = camPos;
  var p   = ray0.p;
  let pt  = ray0.pt;

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(frameIndex & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  var maxSteps : i32 = select(120, 160, isProgressive);
  var qualScale : f32 = select(0.92, 0.78, isProgressive);
  if (quality <= 0) {
    maxSteps = select(88, 115, isProgressive);
    qualScale = select(1.18, 1.05, isProgressive);
  } else if (quality >= 2) {
    maxSteps = select(176, 225, isProgressive);
    qualScale = select(0.70, 0.60, isProgressive);
  }

  let camR = length(camPos);
  let escapeR = max(20.0, camR * 1.35);

  var radiance = vec3f(0.0);
  var rayDist : f32 = 0.0;
  var hitStar = false;
  var shadeStar = false;
  var escaped = false;
  var nearMagShell = true;
  var hitPos = camPos;
  var hitP = p;
  var hitVel = localRay;
  var finalVel = localRay;

  for (var step: i32 = 0; step < 225; step++) {
    if (step >= maxSteps) { break; }

    var k1: GeodesicDeriv;
    if (lensing <= 1e-6) {
      k1.dpos = p;
      k1.dp = vec3f(0.0);
      k1.r = evalKerrR(pos, a2);
    } else {
      k1 = evalGeodesicRHS(pos, p, pt, M, a, a2, lensing);
    }
    let r = k1.r;
    finalVel = k1.dpos;

    if (r <= 1.0) {
      hitPos = pos;
      hitP = p;
      hitVel = k1.dpos;
      hitStar = true;
      shadeStar = true;
      break;
    }

    let outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    var h : f32;
    if (outbound && r > volBoundR) {
      h = clamp(0.50 * r * qualScale, 1.2, 6.0);
    } else if (r > volBoundR) {
      h = clamp(0.35 * r * qualScale, 0.50 * qualScale, max(r - volBoundR + 0.25, 0.50 * qualScale));
    } else if (r < 2.4) {
      h = (0.042 + 0.078 * max(r - 1.0, 0.0)) * qualScale;
    } else {
      h = clamp(0.13 * (r - 0.55) * qualScale, 0.08 * qualScale, 2.2 * qualScale);
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
    } else if (r >= 2.8) {
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

    let r2NextEuclid = dot(posNext, posNext);
    let maybeHit = (r2NextEuclid <= 1.0 + a2 + 1e-5);
    let rNext = select(2.0, evalKerrR(posNext, a2), maybeHit);

    var hitThisStep = false;
    var alphaHi : f32 = 1.0;
    var v0 = vec3f(0.0);
    var v1 = vec3f(0.0);
    if (rNext <= 1.0) {
      hitThisStep = true;
      alphaHi = 1.0;
      v0 = h * k1.dpos;
      v1 = h * velEnd;
    } else if (r < 1.18 && dot(pos, k1.dpos) < 0.0) {
      v0 = h * k1.dpos;
      v1 = h * velEnd;
      let midH = evalHermite(pos, v0, posNext, v1, 0.5);
      if (evalKerrR(midH, a2) <= 1.0) {
        hitThisStep = true;
        alphaHi = 0.5;
      }
    }

    var segEnd = posNext;
    var segVelEnd = velEnd;
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
      hitPos = evalHermite(pos, v0, posNext, v1, alphaHit);
      hitP   = mix(p, pNext, alphaHit);
      hitVel = mix(k1.dpos, velEnd, alphaHit);
      segEnd = hitPos;
      segVelEnd = hitVel;
    }

    let segVec = segEnd - pos;
    let segLen2 = dot(segVec, segVec);
    let segLen = sqrt(segLen2);
    if (segLen > 1e-5) {
      let tMin = clamp(-dot(pos, segVec) / segLen2, 0.0, 1.0);
      let closestP = pos + tMin * segVec;
      let minR2 = dot(closestP, closestP);

      if (minR2 < volBoundR * volBoundR) {
        let maxR2 = max(dot(pos, pos), dot(segEnd, segEnd));
        let segNeedsMag = hasMag && (minR2 < rMagOuter * rMagOuter);
        let segNeedsBeam = hasBeam && (minR2 < 324.0);
        let segNeedsPwn = hasPwn && (minR2 < 77.44) && (maxR2 > 6.5025)
                       && (min(abs(pos.y), abs(segEnd.y)) < 1.32 || pos.y * segEnd.y < 0.0);

        let segXZ2 = dot(segVec.xz, segVec.xz);
        let tXZ = select(0.0, clamp(-dot(pos.xz, segVec.xz) / segXZ2, 0.0, 1.0), segXZ2 > 1e-10);
        let clXZ = pos.xz + tXZ * segVec.xz;
        let segNeedsJet = hasJet && (dot(clXZ, clXZ) < 3.6)
                       && (min(abs(pos.y), abs(segEnd.y)) < 18.0)
                       && (max(abs(pos.y), abs(segEnd.y)) > 1.25);

        if (segNeedsMag || segNeedsBeam || segNeedsPwn || segNeedsJet) {
          let midPos = pos + 0.5 * segVec;
          let r2Mid = max(dot(midPos, midPos), 1e-8);
          let invRMid = inverseSqrt(r2Mid);
          let rMid = r2Mid * invRMid;

          var hVol = clamp(0.11 * (rMid - 0.55) * qualScale, 0.06 * qualScale, 1.65 * qualScale);
          if (rMid < 2.2) {
            hVol = min(hVol, (0.032 + 0.055 * max(rMid - 1.0, 0.0)) * qualScale);
          }
          if (segNeedsMag && minR2 < rMagLoopMax * rMagLoopMax && nearMagShell) {
            hVol = min(hVol, (0.072 + 0.050 * max(rMid - 1.0, 0.0)) * qualScale);
          }
          if (segNeedsJet) {
            hVol = min(hVol, 0.20 * qualScale);
          }
          if (segNeedsPwn) {
            hVol = min(hVol, 0.26 * qualScale);
          }

          let nSub = clamp(i32(floor(segLen / max(hVol, 0.03) + 0.5)), 1, 6);
          let invNSub = 1.0 / f32(nSub);
          let dsSub = segLen * invNSub;

          let segVelMid = 0.5 * (k1.dpos + segVelEnd);
          let segToCamDir = select(-midPos * invRMid, -normalize(segVelMid), dot(segVelMid, segVelMid) > 1e-10);

          var segCorotBeam : f32 = 1.0;
          if (segNeedsMag) {
            let rhoCyl2 = dot(midPos.xz, midPos.xz);
            let invRhoCyl = select(0.0, inverseSqrt(rhoCyl2), rhoCyl2 > 1e-10);
            let rhoCyl = rhoCyl2 * invRhoCyl;
            let betaCorotMag = clamp(rhoCyl * invRLc, 0.0, 0.72) * (0.35 + 0.65 * min(betaEq * 3.5, 1.0));
            let corotDot = (midPos.z * segToCamDir.x - midPos.x * segToCamDir.z) * invRhoCyl;
            let gammaCorot = inverseSqrt(max(1.0 - betaCorotMag * betaCorotMag, 0.15));
            let dopCorot = 1.0 / max(gammaCorot * (1.0 - betaCorotMag * corotDot), 0.30);
            segCorotBeam = pow(clamp(dopCorot, 0.35, 3.2), 1.8);
          }

          var segNearMag = false;
          let jBase = fract(bn.y + f32(step) * 0.61803399);
          for (var sub: i32 = 0; sub < 6; sub++) {
            if (sub >= nSub) { break; }
            let uSub = (f32(sub) + jBase) * invNSub;
            let samplePos = pos + uSub * segVec;
            let r2Samp = max(dot(samplePos, samplePos), 1e-8);
            let invRSamp = inverseSqrt(r2Samp);
            let rSamp = r2Samp * invRSamp;
            let outsideCrust = select(
              rSamp > 1.01,
              evalKerrR(samplePos, a2) > 1.01,
              a2 >= 1e-6 && r2Samp < 1.06 + a2
            );

            if (outsideCrust && rSamp < volBoundR) {
              let camDistFade = smoothstep(0.25, 1.75, rayDist + uSub * segLen);
              let volRes = evalPulsarVolume(
                samplePos, segToCamDir, rSamp, invRSamp, simTime, spinPhase, sinObl, cosObl,
                twistShear, twistFactor, rLightCylVis, invSepW, retardFactor, rMagLoopMax, rSheetMin,
                rSheetMax, rMagOuter, plasmaDensity, beamIntensity, beamConeHalfAngle, cosMaxCone,
                pwnVisibility, jetAmp, spinVisualSpeed, camDistFade, segCorotBeam,
                segNeedsMag, segNeedsBeam, segNeedsPwn, segNeedsJet
              );
              radiance += volRes.rgb * dsSub;
              if (rSamp >= rMagLoopMax || volRes.a > 0.5) {
                segNearMag = true;
              }
            } else if (rSamp >= rMagLoopMax) {
              segNearMag = true;
            }
          }
          nearMagShell = segNearMag;
        } else if (minR2 >= rMagLoopMax * rMagLoopMax) {
          nearMagShell = true;
        }
      } else {
        nearMagShell = true;
      }
    }

    if (hitThisStep) {
      hitStar = true;
      shadeStar = true;
      break;
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;
  }

  if (shadeStar) {
    radiance += shadeNeutronStarSurface(
      hitPos, hitP, pt, hitVel, M, a, a2, lensing, betaEq, simTime, spinPhase,
      sinObl, cosObl, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
    );
  }

  if (!hitStar && !escaped) {
    let rEnd = evalKerrR(pos, a2);
    if (rEnd <= 1.02) {
      hitStar = true;
    } else {
      escaped = true;
    }
  }

  let escFlag = select(0.0, 1.0, escaped && !hitStar);
  let edgeMask = fwidth(escFlag);
  let safeSkyDir = select(localRay, normalize(finalVel), dot(finalVel, finalVel) > 1e-10);
  let skyColor = sampleSkyBackground(safeSkyDir, skyIntensity, skyMode, skyRot, escFlag > 0.5, edgeMask);

  if (escFlag > 0.5) {
    radiance += skyColor;
  }

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(36.0));
  return vec4f(radiance, 1.0);
}
`;
