/**
 * Cinema-grade WebGPU WGSL relativistic black hole shader for
 * "Gargantua — Relativistic Black Hole Simulator".
 *
 * 1:1 exact physics & radiative-transfer port of blackhole.frag.js:
 *  - Exact 3D Cartesian Outgoing Kerr-Schild metric (G = c = M = 1, spin along +Y)
 *  - Exact 4D Lorentzian Gram-Schmidt ZAMO orthonormal observer tetrad at camPos
 *  - Exact analytical Hamiltonian gradients integrated via adaptive RK4 with
 *    blue-noise stratified sub-stepped volumetric disk quadrature
 *  - True 3D volumetric radiative transfer accretion disk: BPT ISCO + plunging region,
 *    dual-phase Keplerian flow-map advection, sheared plasma ribbons + MRI filaments +
 *    foreground cool-dust absorption, Novikov-Thorne temperature profile, CIE-1931 LUT,
 *    and exact relativistic frequency shift & beaming
 *  - Optional Blandford-Znajek parabolic helical polar jets (3D Cartesian, zero pole seam)
 *  - Wrap-safe, silhouette-safe textureSampleGrad equirectangular 4K Milky Way lensing +
 *    crisp 3D-cell spectral micro-stars
 */

import { FULLSCREEN_VERT_WGSL } from './common.wgsl.js';

export const BLACKHOLE_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

struct BlackholeUniforms {
  resolution_time_frame : vec4f, // x=res.x, y=res.y, z=time, w=f32(frameIndex)
  jitter_fov_spin       : vec4f, // x=jitterX, y=jitterY, z=fovY, w=spin
  camPos_relMode        : vec4f, // xyz=camPos, w=relativisticMode
  camRight_lensing      : vec4f, // xyz=camBasis[0], w=lensingStrength
  camUp_diskTemp        : vec4f, // xyz=camBasis[1], w=diskTemp
  camForward_diskDens   : vec4f, // xyz=camBasis[2], w=diskDensity
  diskParams            : vec4f, // x=diskThickness, y=diskOuterRadius, z=turbulence, w=orbitSpeed
  jet_skyParams         : vec4f, // x=jetIntensity, y=skyIntensity, z=skyRotation.x, w=skyRotation.y
  modes_pad             : vec4i, // x=frameIndex, y=skyMode, z=quality, w=0
  zamoE0                : vec4f, // CPU-precomputed ZAMO timelike basis vector e0
  zamoE1                : vec4f, // CPU-precomputed ZAMO right basis vector e1
  zamoE2                : vec4f, // CPU-precomputed ZAMO up basis vector e2
  zamoE3                : vec4f, // CPU-precomputed ZAMO forward basis vector e3
  camKS_l_2H            : vec4f, // xyz=fCam.l, w=2.0*fCam.H
  kerrConsts            : vec4f, // x=rPlus, y=rIsco, z=rOuter, w=tanHalfFov
  rayConsts             : vec4f, // x=escapeR, y=captureR, z=maxDiskSlabY, w=rPeak
  flowConsts            : vec4f, // x=flowBlend, y=dt0, z=dt1, w=globalRot
  optConsts             : vec4f, // x=rPeakComp, y=extPeakComp, z=cos(skyRot.x), w=sin(skyRot.x)
  skyTrig               : vec4f, // x=cos(skyRot.y), y=sin(skyRot.y), zw=0
};

@group(0) @binding(0) var<uniform> u: BlackholeUniforms;
@group(0) @binding(1) var uVolumeNoise: texture_3d<f32>;
@group(0) @binding(2) var sVolume: sampler;
@group(0) @binding(3) var uSkyMap: texture_2d<f32>;
@group(0) @binding(4) var uProcSkyMap: texture_2d<f32>;
@group(0) @binding(5) var sSky: sampler;
@group(0) @binding(6) var uBlackbodyLut: texture_2d<f32>;
@group(0) @binding(7) var sLut: sampler;
@group(0) @binding(8) var uBlueNoise: texture_2d<f32>;

const PI       : f32 = 3.14159265359;
const TAU      : f32 = 6.28318530718;
const INV_PI   : f32 = 0.31830988618;
const INV_TAU  : f32 = 0.15915494309;
const T_MIN    : f32 = 800.0;
const T_MAX    : f32 = 40000.0;
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
// 1. EXACT 3D CARTESIAN OUTGOING KERR-SCHILD METRIC & HAMILTONIAN
// ============================================================================

struct KSFields {
  r  : f32,
  r2 : f32,
  D  : f32,
  H  : f32,
  R2 : f32,
  l  : vec3f,
};

fn evalKerrR(pos: vec3f, a2: f32) -> f32 {
  if (a2 < 1e-8) {
    return sqrt(max(dot(pos, pos), 1e-8));
  }
  let uVal = dot(pos, pos) - a2;
  let ay = 2.0 * pos.y;
  let disc = sqrt(max(uVal * uVal + a2 * ay * ay, 1e-12));
  return sqrt(max(0.5 * (uVal + disc), 1e-8));
}

fn evalKSFields(pos: vec3f, a: f32, a2: f32, lensing: f32) -> KSFields {
  var f: KSFields;
  if (a2 < 1e-8) {
    f.r2 = max(dot(pos, pos), 1e-8);
    let invR = inverseSqrt(f.r2);
    f.r  = f.r2 * invR;
    f.D  = f.r2 * f.r2;
    f.H  = lensing * invR;
    f.R2 = f.r2;
    f.l  = pos * invR;
    return f;
  }
  let uVal = dot(pos, pos) - a2;
  let y2 = pos.y * pos.y;
  let disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  f.r2 = max(0.5 * (uVal + disc), 1e-8);
  let invR = inverseSqrt(f.r2);
  f.r  = f.r2 * invR;
  f.D  = f.r2 * f.r2 + a2 * y2;
  let invD = 1.0 / max(f.D, 1e-10);
  f.H  = lensing * (f.r * f.r2) * invD;
  f.R2 = f.r2 + a2;
  let invR2 = 1.0 / max(f.R2, 1e-8);
  f.l = vec3f(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (f.r * pos.z - a * pos.x) * invR2
  );
  return f;
}

struct GeodesicDeriv {
  dpos : vec3f,
  dp   : vec3f,
  r    : f32,
};

fn evalGeodesicRHS(pos: vec3f, p: vec3f, pt: f32, a: f32, a2: f32, lensing: f32) -> GeodesicDeriv {
  var r2: f32;
  let y2 = pos.y * pos.y;
  if (a2 < 1e-8) {
    r2 = max(dot(pos, pos), 1e-8);
  } else {
    let uVal = dot(pos, pos) - a2;
    let disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
    r2 = max(0.5 * (uVal + disc), 1e-8);
  }
  let invR  = inverseSqrt(r2);
  let r     = r2 * invR;
  let D     = r2 * r2 + a2 * y2;
  let invD  = 1.0 / max(D, 1e-10);
  let H     = lensing * (r * r2) * invD;
  let R2    = r2 + a2;
  let invR2 = 1.0 / max(R2, 1e-8);
  let l     = vec3f(
    (r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (r * pos.z - a * pos.x) * invR2
  );

  let L = pt + dot(l, p);
  let twoHL = 2.0 * H * L;

  var outD: GeodesicDeriv;
  outD.dpos = p - twoHL * l;
  outD.r = r;

  if (lensing <= 1e-6) {
    outD.dp = vec3f(0.0);
    return outD;
  }

  let gradR = vec3f(
    r * r2 * pos.x,
    r * R2 * pos.y,
    r * r2 * pos.z
  ) * invD;

  let hFac = lensing * r2 * invD * invD;
  let cR = 3.0 * a2 * y2 - r2 * r2;
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

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY & COLOR UTILITIES
// ============================================================================

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
}

// ============================================================================
// 3. VOLUMETRIC ACCRETION DISK & RELATIVISTIC DOPPLER TRANSFER
// ============================================================================

fn diskScaleHeight(r: f32, rIsco: f32, rOuter: f32) -> f32 {
  let rNorm = clamp((r - rIsco) / max(rOuter - rIsco, 1.0), 0.0, 1.0);
  let sr = sqrt(rNorm);
  let powApprox = mix(sr, sr * sqrt(sr), 0.88);
  let baseH = 0.048 + 0.036 * r * (0.42 + 0.88 * powApprox);
  return baseH * max(u.diskParams.x, 0.15);
}

fn computeDiskFrequencyShiftFromFields(
  pos: vec3f,
  f: KSFields,
  p: vec3f,
  pt: f32,
  r: f32,
  rIsco: f32,
  rPlus: f32,
  a: f32,
  a2: f32,
  lensing: f32
) -> f32 {
  let rho2 = pos.x * pos.x + pos.z * pos.z;
  let invRho = inverseSqrt(max(rho2, 1e-6));

  let omegaZ = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  let vZamo = vec3f(omegaZ * pos.z, 0.0, -omegaZ * pos.x);

  var vEmit: vec3f;
  if (r >= rIsco) {
    let rm = max(r, 1.0);
    let omega = 1.0 / (rm * sqrt(rm) + a);
    vEmit = vec3f(omega * pos.z, 0.0, -omega * pos.x);
  } else {
    let plunge = clamp((rIsco - r) / max(rIsco - rPlus, 0.08), 0.0, 1.0);
    let rmIsco = max(rIsco, 1.0);
    let omegaIsco = 1.0 / (rmIsco * sqrt(rmIsco) + a);
    let ratio = rIsco / max(r, rPlus);
    let ratioPow = pow(ratio, 0.85);
    let omegaEff = mix(omegaIsco * ratioPow, omegaZ, plunge * plunge);
    let vRot = vec3f(omegaEff * pos.z, 0.0, -omegaEff * pos.x);
    let vRadMag = 0.62 * (plunge * mix(1.0, sqrt(plunge), 0.5)) * sqrt(max(lensing, 0.1));
    let radDir = vec3f(pos.x, 0.0, pos.z) * invRho;
    vEmit = vRot - vRadMag * radDir;
  }

  var lv = -1.0 + dot(f.l, vEmit);
  var ds2 = -1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv;
  if (ds2 > -0.05) {
    let dv = vEmit - vZamo;
    let lvZ = -1.0 + dot(f.l, vZamo);
    let ds2Z = min(-1.0 + dot(vZamo, vZamo) + 2.0 * f.H * lvZ * lvZ, -0.02);
    let shrink = sqrt(clamp((-0.05 - ds2Z) / max(ds2 - ds2Z, 1e-4), 0.0, 1.0)) * 0.92;
    vEmit = vZamo + dv * shrink;
    lv = -1.0 + dot(f.l, vEmit);
    ds2 = min(-1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv, -0.02);
  }

  let ut = inverseSqrt(max(-ds2, 0.02));
  let emitEnergy = ut * (pt + dot(p, vEmit));
  return clamp(1.0 / max(emitEnergy, 0.08), 0.06, 3.6);
}

fn sampleDiskPlasmaNoise(r: f32, phi: f32, yNorm: f32, a: f32, lowDetail: bool) -> vec4f {
  let orbitSpeed = u.diskParams.w;

  let logR = log(max(r, 0.6));
  let phiU = phi * INV_TAU;
  let rm = max(r, 1.0);
  let omegaVis = orbitSpeed * 1.65 / (rm * pow(rm, 0.28) + 0.45 * a);

  let blend     = u.flowConsts.x;
  let dt0       = u.flowConsts.y;
  let dt1       = u.flowConsts.z;
  let globalRot = u.flowConsts.w;

  let spiralU0 = phiU + 2.35 * logR - (omegaVis * dt0 + globalRot) * INV_TAU;
  let spiralU1 = phiU + 2.35 * logR - (omegaVis * dt1 + globalRot) * INV_TAU;
  let radV0    = logR * 1.15 + dt0 * 0.012 * orbitSpeed;
  let radV1    = logR * 1.15 + dt1 * 0.012 * orbitSpeed;
  let zCoord   = yNorm * 0.28 + 0.5;

  let n0 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(spiralU0, radV0, zCoord), 0.0);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(spiralU1, radV1, zCoord), 0.0);
  let primary = mix(n1, n0, blend);

  if (lowDetail) {
    return primary;
  }

  let mhdWarpU = (primary.r - 0.5) * 0.095 + (primary.b - 0.5) * 0.055;
  let mhdWarpV = (primary.r - 0.5) * 0.36  + (primary.g - 0.5) * 0.18;
  let fineU0 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt0 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
  let fineU1 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt1 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
  let fineV0 = logR * 3.15 + mhdWarpV;

  let d0 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(fineU0, fineV0, yNorm * 0.55 + 0.25), 0.0);
  let d1 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(fineU1, fineV0, yNorm * 0.55 + 0.25), 0.0);
  let detail = mix(d1, d0, blend);

  return vec4f(
    mix(primary.r, detail.r, 0.42),
    mix(primary.g, detail.g, 0.58),
    mix(primary.b, detail.b, 0.45),
    mix(primary.a, detail.a, 0.72)
  );
}

struct DiskSample {
  emission   : vec3f,
  extinction : f32,
};

fn evalDiskVolume(
  pos: vec3f,
  r: f32,
  gShift: f32,
  rIsco: f32,
  rOuter: f32,
  rPlus: f32,
  a: f32,
  camDistFade: f32,
  lowDetail: bool
) -> DiskSample {
  var outDisk: DiskSample;
  outDisk.emission = vec3f(0.0);
  outDisk.extinction = 0.0;

  if (r <= rPlus * 1.03 || r >= rOuter * 1.07) {
    return outDisk;
  }

  let H = diskScaleHeight(r, rIsco, rOuter);
  let absY = abs(pos.y);
  if (absY > H * 2.55) {
    return outDisk;
  }

  let yNorm = pos.y / max(H, 1e-4);
  let absYNorm = abs(yNorm);
  let phi = atan2(pos.z, pos.x);
  let logR = log(max(r, 0.6));

  let n = sampleDiskPlasmaNoise(r, phi, yNorm, a, lowDetail || absYNorm > 1.32);
  let turb = clamp(u.diskParams.z, 0.0, 2.2);

  let mainInner = smoothstep(rIsco * 0.90, rIsco * 1.16, r);
  let tendrilWarp = (n.x * 0.55 + n.y * 0.45 - 0.5) * 0.28 * clamp(turb, 0.3, 1.8);
  let rOuterEff = rOuter * (1.0 + tendrilWarp);
  let ob = max(1.0 - smoothstep(rOuterEff * 0.28, rOuterEff * 1.02, r), 0.0);
  let outerFade = ob * ob;
  let outerWisps = smoothstep(0.32, 0.85, n.y * 0.65 + n.w * 0.35);
  let outerEdgeSoft = (1.0 - smoothstep(rOuter * 0.72, rOuter * 1.07, r))
                    * mix(1.0, 0.35 + 0.95 * outerWisps, smoothstep(rOuter * 0.52, rOuter * 0.92, r));

  var plungeEnv = 0.0;
  if (mainInner < 0.999) {
    let plungeMask = (1.0 - mainInner) * smoothstep(rPlus * 1.04, rPlus * 1.32, r);
    let pf = clamp(n.y * 0.75 + n.w * 0.45, 0.0, 1.0);
    let plungeFilaments = pf * pf;
    plungeEnv = plungeMask * (0.14 + 0.38 * plungeFilaments);
  }

  let radialEnv = (mainInner * outerFade + plungeEnv) * outerEdgeSoft;
  if (radialEnv < 1e-4) {
    return outDisk;
  }

  let warpY = (n.x - 0.5) * 0.28 * turb;
  let yShifted = abs(yNorm + warpY);
  let yShiftedSq = yShifted * yShifted;
  let vertCore   = exp(-yShiftedSq * 2.75);
  let vertMid    = exp(-yShiftedSq * 5.60);
  let slabWindow = smoothstep(2.55, 1.80, absYNorm);
  let vertSheath = 0.22 * exp(-absYNorm * 1.65) * slabWindow;

  let rWarp = logR + (n.x - 0.5) * 0.24 * turb + (n.z - 0.5) * 0.12 * turb;
  let laneBroad = max(0.5 + 0.5 * sin(rWarp * 18.5 + 0.72 * sin(phi + logR * 3.5 + n.x * 2.6)), 0.0);
  let laneFine  = max(0.5 + 0.5 * sin(rWarp * 46.0 - 0.62 * cos(2.0 * phi - logR * 5.2 + n.z * 3.0)), 0.0);
  let laneMicro = max(0.5 + 0.5 * sin(rWarp * 94.0 + 0.50 * sin(3.0 * phi + logR * 7.0 - n.y * 2.4)), 0.0);

  let lbSqrt = sqrt(laneBroad);
  let lbPow = laneBroad * lbSqrt;
  let lmPow = laneMicro * laneMicro * sqrt(laneMicro);
  let concentricLanes = mix(
    0.56 + 0.44 * laneBroad,
    0.26 + 0.34 * lbPow
         + 0.36 * (laneFine * laneFine)
         + 0.24 * lmPow,
    0.76
  );

  let nyc = clamp(n.y, 0.0, 1.0);
  let ridgeSharp = nyc * sqrt(nyc);
  let nwc = clamp(n.w, 0.0, 1.0);
  let microSharp = nwc * mix(1.0, sqrt(nwc), 0.76);
  let ht = clamp(ridgeSharp * 0.62 + microSharp * 0.52, 0.0, 1.0);
  let hotThread = ht * ht * sqrt(ht);
  let mriFilaments = mix(0.68, 0.18 + 1.15 * ridgeSharp + 0.62 * microSharp + 0.85 * hotThread, clamp(turb, 0.0, 1.65));
  let eddyBoost = mix(1.0, 0.64 + 0.82 * n.z, clamp(turb * 0.80, 0.0, 1.2));
  let plasmaStructure = concentricLanes * mriFilaments * eddyBoost;

  let riftSignal = n.x * 0.50 + n.y * 0.35 + n.z * 0.15;
  let riftMask = smoothstep(0.24, 0.74, riftSignal);
  let structureContrast = mix(1.0, mix(0.20, 1.48, riftMask), clamp(turb * 0.85, 0.0, 1.0));

  let diskDensity = u.camForward_diskDens.w;
  let localDensity = radialEnv * (vertCore * plasmaStructure * structureContrast * slabWindow + vertSheath * (0.38 + 0.62 * ridgeSharp))
                   * diskDensity * camDistFade;
  if (localDensity < 1e-5) {
    return outDisk;
  }

  let rPeak = u.rayConsts.w;
  let rel = clamp(u.camPos_relMode.w, 0.0, 1.0);
  let tempExp = mix(0.42, 0.55, rel);
  let rRatio = max(r / rPeak, 0.52);
  let tempRadial = pow(rRatio, -tempExp);
  let plungeCool = mix(0.76, 1.0, mainInner);
  let filamentHeat = clamp(ridgeSharp * 0.46 + microSharp * 0.24 + laneFine * 0.22 + hotThread * 0.42, 0.0, 1.0);
  let T_local = u.camUp_diskTemp.w * tempRadial * plungeCool * mix(0.72, 1.34, filamentHeat);

  let gColor  = mix(mix(1.0, gShift, 0.26), gShift, rel);
  let gBeam   = mix(mix(1.0, gShift, 0.34), gShift, rel);
  let beamExp = mix(1.85, 3.35, rel);
  var beaming = pow(clamp(gBeam, 0.10, 2.75), beamExp);
  beaming = beaming / (1.0 + beaming * mix(0.055, 0.165, rel));
  beaming *= mix(1.0, 0.92, rel);

  let T_obs = clamp(T_local * gColor, T_MIN, T_MAX);
  let bbColor = sampleBlackbody(T_obs);

  let tr = clamp(T_local / 4750.0, 0.15, 3.8);
  let thermalPower = tr * tr;
  let heightComp = 1.0 / pow(max(H * 3.0, 0.38), 0.40);
  let rPeakComp  = u.optConsts.x;

  let rimDist = (r - rIsco * 1.18) / max(rIsco * 0.38, 0.42);
  let innerHotRim = 1.0 + 0.95 * exp(-rimDist * rimDist) * mainInner;

  let emitStrength = localDensity * thermalPower * beaming * heightComp * rPeakComp * innerHotRim * 1.38;
  outDisk.emission = bbColor * emitStrength;

  let dustZone = smoothstep(rIsco * 1.45 + 1.8, rIsco * 3.0 + 3.2, r);
  let dvRaw = smoothstep(0.32, 0.88, 1.0 - ridgeSharp * 0.72 + (n.x - 0.5) * 0.75);
  let dustVeins = dvRaw * mix(1.0, sqrt(dvRaw), 0.70);
  let dustLane  = 0.30 + 0.70 * (1.0 - lbPow);
  let coolDustExt = radialEnv * vertMid * dustZone * (0.42 + 1.85 * dustVeins * dustLane);
  let plasmaSelfExt = radialEnv * vertCore * (0.15 + 0.22 * n.x);

  let extPeakComp = u.optConsts.y;
  outDisk.extinction = (coolDustExt * 1.45 + plasmaSelfExt * 0.40) * diskDensity * heightComp * extPeakComp * camDistFade * slabWindow;
  return outDisk;
}

// ============================================================================
// 4. RELATIVISTIC BLANDFORD-ZNAJEK POLAR JETS (3D CARTESIAN, ZERO POLE SEAM)
// ============================================================================

fn evalPolarJet(pos: vec3f, vel: vec3f, rPlus: f32, a: f32, camDistFade: f32) -> vec3f {
  let absY = abs(pos.y);
  if (absY < rPlus * 1.35 || absY > 44.0) {
    return vec3f(0.0);
  }

  let rho = length(pos.xz);
  let jetRadius = 0.14 * rPlus + 0.088 * pow(absY, 0.72);
  if (rho > jetRadius * 2.4) {
    return vec3f(0.0);
  }

  let uRad = rho / max(jetRadius, 1e-4);
  let spine     = exp(-uRad * uRad * 5.2);
  let sd        = uRad - 0.76;
  let sheath    = exp(-sd * sd * 10.5) * 0.88;
  let outerHalo = exp(-uRad * uRad * 1.4) * 0.16;
  let radialProfile = spine * 0.52 + sheath + outerHalo;

  let yEnv = smoothstep(rPlus * 1.35, rPlus * 3.9, absY)
           * (1.0 - smoothstep(16.0, 42.0, absY))
           / (1.0 + 0.11 * absY);

  let simTime = u.resolution_time_frame.z;
  let orbitSpeed = u.diskParams.w;
  let signY = select(-1.0, 1.0, pos.y >= 0.0);
  let helixAngle = signY * (absY * 0.72 - simTime * orbitSpeed * 1.85) * (0.55 + 0.45 * a);
  let ch = cos(helixAngle);
  let sh = sin(helixAngle);
  let rotXZ = vec2f(ch * pos.x - sh * pos.z, sh * pos.x + ch * pos.z);

  let flowY = absY * 0.17 - simTime * orbitSpeed * 0.48;
  let jetUvw = vec3f(rotXZ * 0.48, flowY);
  let jn     = textureSampleLevel(uVolumeNoise, sVolume, jetUvw, 0.0);
  let jnFine = textureSampleLevel(uVolumeNoise, sVolume, vec3f(rotXZ * 1.08, flowY * 2.15 + 0.37), 0.0);

  let rawFil = clamp(jn.y * 0.55 + jnFine.w * 0.60, 0.0, 1.0);
  let filaments = rawFil * rawFil * sqrt(rawFil);
  let knots = 0.40 + 0.90 * pow(max(jn.z, 0.0), 1.3);

  let jetDir = vec3f(0.0, signY, 0.0);
  let cosTheta = dot(jetDir, -normalize(vel));
  let betaJet = 0.48 + 0.20 * a;
  let dopplerJet = 1.0 / max(1.0 - betaJet * cosTheta, 0.30);
  let jetBeam = pow(clamp(dopplerJet, 0.40, 2.2), mix(0.85, 1.65, u.camPos_relMode.w));
  let viewColumnAtten = mix(1.0, 0.24, pow(max(abs(cosTheta), 0.0), 1.55));

  let coreCol   = vec3f(0.62, 0.86, 1.00);
  let sheathCol = vec3f(0.20, 0.46, 1.00);
  let outerCol  = vec3f(0.46, 0.22, 1.00);
  var jetCol = mix(sheathCol, coreCol, clamp(spine * 0.85 + filaments * 0.55, 0.0, 1.0));
  jetCol = mix(jetCol, outerCol, smoothstep(0.75, 1.85, uRad) * 0.68);

  let rawInt = u.jet_skyParams.x * radialProfile * yEnv * (0.18 + 1.55 * filaments) * knots * jetBeam * viewColumnAtten * camDistFade;
  let intensity = rawInt / (1.0 + rawInt * 0.45);
  return jetCol * (intensity * 0.165);
}

// ============================================================================
// 5. SEAMLESS 4K MILKY WAY LENSING + CRISP 3D MICRO-STARS
// ============================================================================

fn rotateSkyDir(d: vec3f) -> vec3f {
  let cy = u.optConsts.z;
  let sy = u.optConsts.w;
  let r1 = vec3f(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  let cp = u.skyTrig.x;
  let sp = u.skyTrig.y;
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
  let mag  = mag2 * mag2 * sqrt(magU);

  let fw = clamp(pixelFw * scale, 0.018, 0.14);
  let starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  let core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let ry = max(rnd.y, 0.0);
  let specT = mix(3000.0, 22000.0, ry * ry);
  let col = sampleBlackbody(specT);

  let lum = (0.08 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

fn sampleSkyBackground(rawDir: vec3f, escaped: bool, edgeMask: f32) -> vec3f {
  let dir = normalize(rotateSkyDir(rawDir));

  // Wrap-safe & pole-safe equirectangular coordinates (MUST run in uniform control flow!)
  let u1 = atan2(dir.z, dir.x) * INV_TAU + 0.5;
  let v  = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
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

  var dirFw = length(fwidth(dir));
  if (edgeMask > 0.01) {
    dirFw = 0.0012;
  }

  if (!escaped) {
    return vec3f(0.0);
  }

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.005, 0.995));
  let skyMode = u.modes_pad.y;
  var mapSrgb: vec3f;
  // Uniform branch on u.modes_pad.y ensures only the active 4K/2K sky map is fetched
  if (skyMode == 2) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(0.0)), vec3f(2.2));

  let brightCores = max(skyLin - vec3f(0.32), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.4;

  if (skyMode == 0 || skyMode == 2) {
    let starGain = select(0.95, 0.55, skyMode == 0);
    let microStars = evalMicroStarLayer(dir, 105.0, 0.915, 0.95 * starGain, dirFw)
                   + evalMicroStarLayer(dir, 225.0, 0.885, 0.42 * starGain, dirFw);
    skyLin += microStars;
  }

  return skyLin * max(u.jet_skyParams.y, 0.0);
}

// ============================================================================
// 6. MAIN RELATIVISTIC GEODESIC RAY-MARCHER & RADIATIVE TRANSFER
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  // WebGPU pos.xy has Y=0 at top, Y=res.y at bottom; flip Y and jitter.y so +Y matches WebGL up
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_spin.x, -u.jitter_fov_spin.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = u.kerrConsts.w;
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let a = clamp(u.jitter_fov_spin.w, 0.0, 0.998);
  let a2 = a * a;
  let lensing = clamp(u.camRight_lensing.w, 0.0, 1.0);
  let rPlus  = u.kerrConsts.x;
  let rIsco  = u.kerrConsts.y;
  let rOuter = u.kerrConsts.z;

  // Initialize exact ZAMO orthonormal null momentum using CPU-precomputed tetrad
  let pUp = -u.zamoE0 + localRay.x * u.zamoE1 + localRay.y * u.zamoE2 + localRay.z * u.zamoE3;
  let lp = -pUp.x + dot(u.camKS_l_2H.xyz, pUp.yzw);
  let twoHL = u.camKS_l_2H.w * lp;
  let pt = -pUp.x - twoHL;
  var p  = pUp.yzw + twoHL * u.camKS_l_2H.xyz;
  var pos = u.camPos_relMode.xyz;

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(u.modes_pad.x & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  let quality = u.modes_pad.z;
  var maxSteps : i32 = 240;
  var qualScale : f32 = 0.96;
  if (quality <= 0) {
    maxSteps = 155;
    qualScale = 1.25;
  } else if (quality >= 2) {
    maxSteps = 360;
    qualScale = 0.66;
  }

  let escapeR      = u.rayConsts.x;
  let captureR     = u.rayConsts.y;
  let maxDiskSlabY = u.rayConsts.z;
  let hasDisk = (u.camForward_diskDens.w > 0.001);
  let hasJet  = (u.jet_skyParams.x > 0.001);
  let lowDetailBase = (quality <= 0);

  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;
  var rayDist : f32 = 0.0;
  var captured = false;
  var escaped  = false;
  var finalVel = localRay;

  for (var step: i32 = 0; step < 360; step++) {
    if (step >= maxSteps) { break; }

    let k1 = evalGeodesicRHS(pos, p, pt, a, a2, lensing);
    let r = k1.r;
    finalVel = k1.dpos;

    if (r <= captureR) {
      captured = true;
      break;
    }

    let outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    let rAboveHor = max(r - rPlus * 0.72, 0.06);
    let farOut = outbound && r > rOuter * 1.10 && (!hasJet || abs(pos.y) > 42.0 || dot(pos.xz, pos.xz) > 25.0);
    var h = clamp(select(0.12, 0.32, farOut) * rAboveHor * qualScale, 0.024 * qualScale, select(4.8, 14.0, farOut));

    if (r < 4.8 * rPlus) {
      h = min(h, (0.028 + 0.035 * max(r - rPlus, 0.05)) * qualScale);
    }

    if (hasDisk && r < rOuter * 1.10) {
      let localH = diskScaleHeight(r, rIsco, rOuter);
      let absY = abs(pos.y);
      if (absY < localH * 2.8) {
        let diskHStep = max(localH * 1.15, 0.085) * qualScale;
        let prox = smoothstep(localH * 2.8, localH * 0.9, absY);
        h = min(h, mix(h, diskHStep, prox));
      }
    }

    if (hasJet && abs(pos.y) > rPlus * 1.1 && abs(pos.y) < 42.0) {
      let rho = length(pos.xz);
      let jRad = 0.14 * rPlus + 0.088 * pow(max(abs(pos.y), 0.1), 0.72);
      if (rho < jRad * 2.6) {
        h = min(h, max(jRad * 0.36, 0.075) * qualScale);
      }
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    var posNext: vec3f;
    var pNext: vec3f;
    if (r < 6.5 * rPlus) {
      // Exact 4th-order Runge-Kutta in strong gravity & photon sphere
      let pos2 = pos + (0.5 * h) * k1.dpos;
      let p2   = p   + (0.5 * h) * k1.dp;
      let k2 = evalGeodesicRHS(pos2, p2, pt, a, a2, lensing);

      let pos3 = pos + (0.5 * h) * k2.dpos;
      let p3   = p   + (0.5 * h) * k2.dp;
      let k3 = evalGeodesicRHS(pos3, p3, pt, a, a2, lensing);

      let pos4 = pos + h * k3.dpos;
      let p4   = p   + h * k3.dp;
      let k4 = evalGeodesicRHS(pos4, p4, pt, a, a2, lensing);

      posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
      pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);
    } else {
      // Symplectic/Midpoint RK2 in weak/medium field
      let pos2 = pos + (0.5 * h) * k1.dpos;
      let p2   = p   + (0.5 * h) * k1.dp;
      let k2 = evalGeodesicRHS(pos2, p2, pt, a, a2, lensing);

      posNext = pos + h * k2.dpos;
      pNext   = p   + h * k2.dp;
    }

    let segLen = length(posNext - pos);
    let midDist = rayDist + 0.5 * segLen;
    let camDistFade = smoothstep(0.0, 0.75, midDist);

    if (hasDisk) {
      let yMin = min(pos.y, posNext.y);
      let yMax = max(pos.y, posNext.y);
      let crossesPlane = (yMin <= 0.0 && yMax >= 0.0);
      let inSlab = (yMin <= maxDiskSlabY && yMax >= -maxDiskSlabY);

      if (inSlab || crossesPlane) {
        let midPos = 0.5 * (pos + posNext);
        let fMid = evalKSFields(midPos, a, a2, lensing);
        let rMid = fMid.r;

        if (rMid > rPlus * 1.025 && rMid < rOuter * 1.07) {
          let hMid = diskScaleHeight(rMid, rIsco, rOuter);
          if (crossesPlane || abs(midPos.y) < hMid * 2.55 || abs(pos.y) < hMid * 2.55 || abs(posNext.y) < hMid * 2.55) {
            let midP = 0.5 * (p + pNext);
            let gSeg = computeDiskFrequencyShiftFromFields(midPos, fMid, midP, pt, rMid, rIsco, rPlus, a, a2, lensing);
            var nSub : i32 = 1;
            let targetDs = max(hMid * 0.95, 0.075) * qualScale;
            if (crossesPlane || segLen > targetDs) {
              nSub = clamp(i32(ceil(segLen / targetDs)), select(1, 2, crossesPlane), select(2, 3, quality >= 2));
            }
            let dsSub = segLen / f32(nSub);
            let jitterBase = fract(bn.y + f32(step) * 0.61803399);
            let lowDet = lowDetailBase || (transmittance < 0.08);

            for (var s: i32 = 0; s < 3; s++) {
              if (s >= nSub) { break; }
              let frac = (f32(s) + jitterBase) / f32(nSub);
              let sPos = mix(pos, posNext, frac);
              let sR   = select(evalKerrR(sPos, a2), rMid, nSub == 1);

              let dsamp = evalDiskVolume(sPos, sR, gSeg, rIsco, rOuter, rPlus, a, camDistFade, lowDet);
              let emit = dsamp.emission;
              let ext  = dsamp.extinction;

              if (ext > 1e-6 || dot(emit, emit) > 1e-10) {
                let tau = ext * dsSub;
                let stepT = exp(-tau);
                let stepRad = select(
                  emit * dsSub,
                  emit * ((1.0 - stepT) / max(ext, 1e-5)),
                  tau > 1e-4
                );
                radiance += transmittance * stepRad;
                transmittance *= stepT;
                if (transmittance < 0.008) { break; }
              }
            }
          }
        }
      }
    }

    if (hasJet && transmittance > 0.008) {
      let jFrac = fract(bn.z + f32(step) * 0.38196601);
      let jPos = mix(pos, posNext, jFrac);
      let jetEmit = evalPolarJet(jPos, k1.dpos, rPlus, a, camDistFade);
      radiance += transmittance * jetEmit * segLen;
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;

    if (transmittance < 0.008) {
      break;
    }
  }

  if (!captured && !escaped) {
    let rEnd = evalKerrR(pos, a2);
    if (rEnd < rPlus * 1.65 || (rEnd < 4.0 * rPlus && dot(pos, finalVel) < 0.0)) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  let escFlag = select(0.0, 1.0, escaped && !captured && transmittance > 0.008);
  let edgeMask = fwidth(escFlag);
  let safeSkyDir = select(localRay, normalize(finalVel), dot(finalVel, finalVel) > 1e-10);
  let skyColor = sampleSkyBackground(safeSkyDir, escFlag > 0.5, edgeMask);

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  }

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));
  return vec4f(radiance, 1.0);
}
`;
