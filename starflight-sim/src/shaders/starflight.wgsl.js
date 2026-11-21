/**
 * Cinema-grade WebGPU WGSL Relativistic Starflight Ray-Tracer
 * for "Relativistic Starflight Simulator".
 *
 * 1:1 exact physics & radiative-transfer port of starflight.frag.js:
 *  - Locked 176-byte StarflightUniforms (11 x vec4<f32>) and @group(0) @binding(0..8)
 *  - Exact cancellation-free Special Relativity (SR) Lorentz aberration &
 *    relativistic Doppler factor D = 1 / (gamma * (1 - beta * mu')) in both
 *    forward and aft hemispheres, valid up to eta = 7.65 (gamma > 1000).
 *  - Multi-spectral 4K Milky Way / Procedural sky with physical CIE-1931 Planck
 *    blackbody temperature shift T_obs = T_base * D^dopplerStrength and soft-shoulder
 *    relativistic beaming + 3 rest-frame procedural star layers (main sequence,
 *    IR brown dwarfs 750K..1750K, UV O-stars / white dwarfs 26000K..80000K).
 *  - Cosmic Microwave Background (CMB) shell at T_0 = 2.7255K * cmbTempScale * D
 *    with exact Solar dipole (0.00123) and 128^3 Planck-style acoustic mottling.
 *  - Penrose-Terrell rotated 3D periodic foreground corridor (CELL_Z = 34.0)
 *    with Navigation/Dyson Beacon Ring, Flanking Beacon Station & Faceted Asteroid.
 *  - 14/20/28 blue-noise-jittered volumetric 128^3 interstellar H-alpha / O-III
 *    dust streaks and sparse 3D parallax star knots outside r_xy > 1.6.
 *  - Strict WGSL uniformity compliance: uVolumeNoise & uBlackbodyLut strictly
 *    use textureSampleLevel at LOD 0; uBlueNoise uses textureLoad; sky
 *    derivatives run in uniform control flow with textureSampleGrad.
 */

import { FULLSCREEN_VERT_WGSL } from './common.wgsl.js';

export const STARFLIGHT_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

struct StarflightUniforms {
  resolution_time_frame : vec4<f32>,  // (width, height, simTime, float(frameIndex))
  jitter_fov_prog       : vec4<f32>,  // (jitterX, jitterY, fovY, isProgressive)
  camRight_beta         : vec4<f32>,  // (right.x, right.y, right.z, beta)
  camUp_gamma           : vec4<f32>,  // (up.x, up.y, up.z, gamma)
  camFwd_oneMinusBeta   : vec4<f32>,  // (forward.x, forward.y, forward.z, oneMinusBeta)
  flightKinematics      : vec4<f32>,  // (flightDir, flightPosZ, rapidity, dopplerStrength)
  spectralParams        : vec4<f32>,  // (cmbVisibility, starDensity, uvIrGain, aberrationStrength)
  foregroundParams      : vec4<f32>,  // (geometryVisibility, dustDensity, dustStreakScale, properAccelG)
  skyParams             : vec4<f32>,  // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  qualityParams         : vec4<f32>,  // (float(quality), properTimeYr, coordTimeYr, visualPace)
  extraParams           : vec4<f32>,  // (beamingGain, cmbTempScale, 0.0, 0.0)
};

@group(0) @binding(0) var<uniform> u: StarflightUniforms;
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
const CELL_Z         : f32 = 34.0;
const MAX_TRACE_DIST : f32 = 88.0;

// ============================================================================
// 1. IEEE-754 SANITIZER, BLACKBODY LUT & RELATIVISTIC DOPPLER HELPERS
// ============================================================================

fn isBadFloat(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}

fn sanitizeHdr(v: vec3f) -> vec3f {
  let clean = vec3f(
    select(v.x, 0.0, isBadFloat(v.x)),
    select(v.y, 0.0, isBadFloat(v.y)),
    select(v.z, 0.0, isBadFloat(v.z))
  );
  return clamp(clean, vec3f(0.0), vec3f(28.0));
}

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
}

fn evalSoftBeam(dBeam: f32, beamingGain: f32) -> f32 {
  let d = max(dBeam, 1e-4);
  var baseBeam : f32;
  if (d >= 1.0) {
    let dp = pow(d, 1.32);
    let dm = select(0.0, pow(max(d - 1.0, 1e-5), 1.32), d > 1.0001);
    baseBeam = dp / (1.0 + 0.22 * dm);
  } else {
    baseBeam = pow(clamp(d, 0.02, 1.0), 0.72) * smoothstep(0.015, 0.22, d);
  }
  return pow(max(baseBeam, 1e-4), clamp(beamingGain, 0.0, 2.0));
}

fn applyRelativisticShift(baseCol: vec3f, tBase: f32, dColor: f32, dBeam: f32, beamingGain: f32, beamMix: f32) -> vec3f {
  let tObs = tBase * dColor;
  let bbRef = max(sampleBlackbody(tBase), vec3f(0.06));
  let bbObs = sampleBlackbody(tObs);
  var shiftRatio = bbObs / bbRef;

  if (dColor > 1.0) {
    shiftRatio = mix(shiftRatio, vec3f(0.62, 0.86, 1.26), smoothstep(1.3, 6.0, dColor) * 0.36);
  } else {
    let wienCut = mix(0.22, 1.0, smoothstep(220.0, 800.0, tObs));
    shiftRatio *= wienCut;
  }

  let softBeam = evalSoftBeam(dBeam, beamingGain);
  let gain = mix(1.0, softBeam, beamMix);
  return baseCol * shiftRatio * gain;
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

// ============================================================================
// 2. MULTI-SPECTRAL STAR LAYERS, SKY & COSMIC MICROWAVE BACKGROUND (CMB)
// ============================================================================

fn evalSpectralStarLayer(
  dir: vec3f,
  scale: f32,
  densityThresh: f32,
  boost: f32,
  pixelFwRest: f32,
  doppler: f32,
  dColor: f32,
  beamingGain: f32,
  uvIrGain: f32,
  spectralClass: i32,
  lodLimit: f32
) -> vec3f {
  let cellFw = pixelFwRest * scale;
  let lodFade = 1.0 - smoothstep(lodLimit * 0.45, lodLimit, cellFw);
  if (lodFade <= 0.002) {
    return vec3f(0.0);
  }

  let p = dir * scale;
  let cell = floor(p);
  let rnd = hash33f(cell);
  if (rnd.x < densityThresh) {
    return vec3f(0.0);
  }

  let starPos = cell + vec3f(0.24) + 0.52 * hash33f(cell + vec3f(19.17, 73.41, 41.83));
  let dist = length(p - starPos);

  let magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  let mag2 = magU * magU;
  let mag = mag2 * mag2 * sqrt(magU);

  let fw = clamp(cellFw, 0.014, 0.28);
  let starRad = mix(0.025, 0.080, mag) + fw * 0.40;
  let core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let ry = max(rnd.y, 0.0);
  var tEmit : f32;
  var bandpassGain : f32;
  var beamFactor : f32;
  var tint = vec3f(1.0);

  if (spectralClass == 1) {
    tEmit = mix(750.0, 1750.0, ry);
    let fwdIgnite = smoothstep(1.20, 2.25, doppler);
    bandpassGain = fwdIgnite * uvIrGain * 1.85;
    let irBeam = pow(clamp(doppler, 1.0, 12.0), 0.70);
    beamFactor = pow(irBeam / (1.0 + 0.20 * (irBeam - 1.0)), clamp(beamingGain, 0.0, 2.0));
  } else if (spectralClass == 2) {
    tEmit = mix(26000.0, 80000.0, ry * ry);
    let aftWindow = smoothstep(0.018, 0.048, doppler) * (1.0 - smoothstep(0.42, 0.88, doppler));
    let restViolet = 0.065 * smoothstep(0.65, 1.05, doppler) * (1.0 - smoothstep(1.4, 3.0, doppler));
    bandpassGain = restViolet + aftWindow * uvIrGain * 3.45;
    if (doppler > 0.72) {
      tint = vec3f(0.76, 0.62, 1.18);
    }
    let uvBeam = mix(0.80, 1.35, smoothstep(0.03, 0.45, doppler));
    beamFactor = pow(uvBeam, clamp(beamingGain, 0.0, 2.0));
  } else {
    tEmit = mix(3000.0, 18000.0, ry * ry);
    bandpassGain = smoothstep(0.05, 0.35, doppler);
    let msBeam = evalSoftBeam(doppler, beamingGain);
    beamFactor = mix(1.0, msBeam, 0.85);
  }

  if (bandpassGain <= 0.002) {
    return vec3f(0.0);
  }

  let tObs = tEmit * dColor;
  var col = sampleBlackbody(tObs) * tint;
  let wienCut = select(
    smoothstep(220.0, 780.0, tObs),
    smoothstep(520.0, 900.0, tObs),
    spectralClass == 1
  );
  if (dColor > 1.5 && spectralClass != 2) {
    col = mix(col, vec3f(0.70, 0.90, 1.22), smoothstep(2.0, 14.0, dColor) * 0.25);
  }

  let energyComp = 1.0 / (1.0 + fw * 5.2);
  let lum = (0.14 + 3.8 * mag) * boost * energyComp * bandpassGain * beamFactor * wienCut * lodFade;
  return col * (core * lum);
}

fn evalCmbShell(rdRest: vec3f, doppler: f32, cmbVisibility: f32, cmbTempScale: f32) -> vec3f {
  if (cmbVisibility <= 0.001) {
    return vec3f(0.0);
  }

  let nCmb = textureSampleLevel(uVolumeNoise, sVolume, rdRest * 3.5, 0.0);
  let nFine = textureSampleLevel(uVolumeNoise, sVolume, rdRest * 9.5 + vec3f(0.23, 0.41, 0.17), 0.0);
  let acousticMottle = ((nCmb.r * 0.62 + nCmb.b * 0.26 + nFine.g * 0.12) - 0.5) * 2.0;

  let dipoleDir = normalize(vec3f(0.45, 0.35, 0.82));
  let dipoleTerm = 0.00123 * dot(rdRest, dipoleDir);
  let tCmbObs = 2.7255 * max(cmbTempScale, 0.0) * doppler * (1.0 + dipoleTerm + 0.04 * acousticMottle);

  if (tCmbObs < 95.0) {
    return vec3f(0.0);
  }

  let nirEnv = smoothstep(105.0, 220.0, tCmbObs) * (1.0 - 0.82 * smoothstep(660.0, 1350.0, tCmbObs));
  let nirWarm = smoothstep(115.0, 420.0, tCmbObs);
  var nirCol = mix(vec3f(0.64, 0.06, 0.015), vec3f(1.00, 0.48, 0.09), nirWarm);
  nirCol = mix(nirCol, vec3f(1.00, 0.80, 0.36), smoothstep(390.0, 760.0, tCmbObs));
  let nirLum = select(
    0.0,
    pow(clamp((tCmbObs - 102.0) / 290.0, 1e-5, 2.6), 1.35) * 1.95 * nirEnv,
    tCmbObs > 102.0
  );

  let optMask = smoothstep(620.0, 920.0, tCmbObs);
  let optCol = sampleBlackbody(tCmbObs);
  let optRaw = select(
    0.0,
    pow(clamp((tCmbObs - 560.0) / 2100.0, 1e-5, 6.0), 1.25) * 5.2 * optMask,
    tCmbObs > 560.0
  );
  let optLum = optRaw / (1.0 + 0.14 * optRaw);

  let mottleContrast = 1.0 + 0.16 * acousticMottle;
  let cmbColor = (nirCol * nirLum + optCol * optLum) * mottleContrast * cmbVisibility;
  return max(cmbColor, vec3f(0.0));
}

fn sampleSkyBackground(
  rdRest: vec3f,
  pixelFwRest: f32,
  doppler: f32,
  dopplerStrength: f32,
  beamingGain: f32,
  skyIntensity: f32,
  skyMode: i32,
  skyRot: vec2f,
  starDensity: f32,
  uvIrGain: f32,
  cmbVisibility: f32,
  cmbTempScale: f32
) -> vec3f {
  let dir = normalize(rotateSkyDir(rdRest, skyRot));

  // Seam-safe & pole-safe equirectangular derivatives strictly in uniform control flow
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
  dUVdx = clamp(dUVdx, vec2f(-0.25), vec2f(0.25));
  dUVdy = clamp(dUVdy, vec2f(-0.25), vec2f(0.25));

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.002, 0.998));
  var mapSrgb : vec3f;
  if (skyMode >= 1) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(1e-5)), vec3f(2.2));

  let skyLuma = dot(skyLin, vec3f(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.22, 1.0, smoothstep(0.002, 0.045, skyLuma));
  let brightCores = max(skyLin - vec3f(0.28), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.4;

  let dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  let blueRed = clamp((skyLin.b - skyLin.r) / max(skyLin.r + skyLin.g + skyLin.b, 1e-4), -0.6, 0.6);
  let tBaseMw = mix(5200.0, 9200.0, clamp(blueRed * 0.8 + 0.35, 0.0, 1.0));
  var shiftedSky = applyRelativisticShift(skyLin, tBaseMw, dColor, dColor, beamingGain, 0.85);

  let coreMask = smoothstep(0.03, 0.38, skyLuma);
  let irAftBand = smoothstep(0.022, 0.060, dColor) * (1.0 - smoothstep(0.16, 0.45, dColor));
  shiftedSky += vec3f(0.52, 0.045, 0.012) * (coreMask * irAftBand * 0.42);
  skyLin = shiftedSky;

  if (starDensity > 0.001) {
    let starGain = select(0.85, 1.10, skyMode >= 1) * starDensity;
    var stars = vec3f(0.0);
    // Main sequence octaves
    stars += evalSpectralStarLayer(dir,  12.0, 0.785, 0.65 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.55);
    stars += evalSpectralStarLayer(dir,  34.0, 0.880, 0.90 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.20);
    stars += evalSpectralStarLayer(dir,  88.0, 0.896, 0.95 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.15);
    stars += evalSpectralStarLayer(dir, 195.0, 0.878, 0.45 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.15);
    // Cool IR brown dwarfs (750K..1750K)
    stars += evalSpectralStarLayer(dir,  15.0, 0.820, 0.90 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.55);
    stars += evalSpectralStarLayer(dir,  48.0, 0.875, 1.25 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.20);
    stars += evalSpectralStarLayer(dir, 115.0, 0.888, 1.05 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.15);
    // Hot UV O-stars / white dwarfs (26000K..80000K)
    stars += evalSpectralStarLayer(dir,  52.0, 0.855, 1.35 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.20);
    stars += evalSpectralStarLayer(dir,  92.0, 0.842, 1.65 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.15);
    stars += evalSpectralStarLayer(dir, 215.0, 0.848, 1.25 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.15);
    skyLin += stars;
  }

  let cmbCol = evalCmbShell(rdRest, doppler, cmbVisibility, cmbTempScale);
  return skyLin * max(skyIntensity, 0.0) + cmbCol;
}

// ============================================================================
// 3. PENROSE-TERRELL ROTATED 3D FOREGROUND REFERENCE GEOMETRY (REST FRAME S)
// ============================================================================

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdRingGate(p: vec3f) -> f32 {
  let qr = vec2f(abs(length(p.xy) - 5.4) - 0.16, abs(p.z) - 0.24);
  let dTorus = length(max(qr, vec2f(0.0))) + min(max(qr.x, qr.y), 0.0) - 0.06;

  let ap = abs(p.xy);
  let mxy = select(ap.yx, ap.xy, ap.x > ap.y);
  let dPylon = sdBox(vec3f(mxy.x - 5.78, mxy.y, p.z), vec3f(0.56, 0.24, 0.56)) - 0.05;
  return min(dTorus, dPylon);
}

fn sdBeaconStation(p: vec3f) -> f32 {
  let dCore = sdBox(p, vec3f(0.54, 0.54, 1.02)) - 0.10;
  let dWing = sdBox(vec3f(p.x, abs(p.y) - 1.32, p.z), vec3f(0.56, 0.52, 0.66)) - 0.03;
  let dStrut = sdBox(p, vec3f(0.22, 0.85, 0.34));

  let qDock = vec2f(abs(length(p.xy) - 0.38) - 0.05, abs(p.z + 1.12) - 0.08);
  let dDock = length(max(qDock, vec2f(0.0))) + min(max(qDock.x, qDock.y), 0.0) - 0.02;

  let engineRad = mix(0.28, 0.44, clamp((p.z - 0.95) / 0.45, 0.0, 1.0));
  let qEng = vec2f(length(p.xy) - engineRad, abs(p.z - 1.18) - 0.22);
  let dEng = length(max(qEng, vec2f(0.0))) + min(max(qEng.x, qEng.y), 0.0) - 0.02;

  return min(min(dCore, dWing), min(dStrut, min(dDock, dEng)));
}

fn sdFacetedAsteroid(p: vec3f) -> f32 {
  const cy : f32 = 0.87758256;
  const sy : f32 = 0.47942554;
  const cx : f32 = 0.96891242;
  const sx : f32 = 0.24740396;
  let r1 = vec3f(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  let pa = vec3f(r1.x, cx * r1.y - sx * r1.z, sx * r1.y + cx * r1.z);

  let dBoxA = sdBox(pa, vec3f(1.14, 0.88, 1.20)) - 0.14;
  let dOctA = (abs(pa.x) * 0.86 + abs(pa.y) * 1.05 + abs(pa.z) * 0.82 - 1.62) * 0.56;
  let ridge = 0.08 * sin(pa.x * 3.1 + 0.7) * cos(pa.y * 3.7 - 0.4) * sin(pa.z * 2.9 + 1.1);
  let dRock = max(dBoxA, dOctA) + ridge;

  let pPod = p - vec3f(0.0, 1.12, 0.0);
  let dPod = sdBox(pPod, vec3f(0.32, 0.28, 0.68)) - 0.04;
  let dFin = sdBox(vec3f(abs(pPod.x) - 0.56, pPod.y, pPod.z), vec3f(0.24, 0.05, 0.36)) - 0.01;
  return min(dRock, min(dPod, dFin));
}

fn evalObjSdf(pLocal: vec3f, objId: i32) -> f32 {
  if (objId == 0) {
    return sdRingGate(pLocal);
  }
  if (objId == 1) {
    return sdBeaconStation(pLocal);
  }
  return sdFacetedAsteroid(pLocal);
}

fn calcObjNormal(pLocal: vec3f, objId: i32) -> vec3f {
  const eps : f32 = 0.004;
  let n = vec3f( 1.0, -1.0, -1.0) * evalObjSdf(pLocal + vec3f( 1.0, -1.0, -1.0) * eps, objId)
        + vec3f(-1.0, -1.0,  1.0) * evalObjSdf(pLocal + vec3f(-1.0, -1.0,  1.0) * eps, objId)
        + vec3f(-1.0,  1.0, -1.0) * evalObjSdf(pLocal + vec3f(-1.0,  1.0, -1.0) * eps, objId)
        + vec3f( 1.0,  1.0,  1.0) * evalObjSdf(pLocal + vec3f( 1.0,  1.0,  1.0) * eps, objId);
  let len = length(n);
  return select(vec3f(0.0, 0.0, 1.0), n / max(len, 1e-6), len > 1e-6);
}

fn intersectSphere(ro: vec3f, rd: vec3f, center: vec3f, radius: f32) -> vec2f {
  let oc = ro - center;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - radius * radius;
  let h = b * b - c;
  if (h < 0.0) {
    return vec2f(1e9, -1e9);
  }
  let s = sqrt(h);
  return vec2f(-b - s, -b + s);
}

struct HitInfo {
  hit      : bool,
  t        : f32,
  objId    : i32,
  localPos : vec3f,
};

fn marchObject(ro: vec3f, rd: vec3f, center: vec3f, radius: f32, tMin: f32, tMax: f32, objId: i32, zSlab: bool) -> HitInfo {
  var res: HitInfo;
  res.hit = false;
  res.t = tMax;
  res.objId = objId;
  res.localPos = vec3f(0.0);

  let sp = intersectSphere(ro, rd, center, radius);
  var t0 = max(tMin, sp.x);
  var t1 = min(tMax, sp.y);

  if (zSlab) {
    if (abs(rd.z) > 1e-5) {
      let tzA = (center.z - 0.85 - ro.z) / rd.z;
      let tzB = (center.z + 0.85 - ro.z) / rd.z;
      t0 = max(t0, min(tzA, tzB));
      t1 = min(t1, max(tzA, tzB));
    } else if (abs(ro.z - center.z) > 0.85) {
      return res;
    }
  }

  if (t0 >= t1) {
    return res;
  }

  var t = t0;
  let stepFactor = select(0.78, 0.92, objId == 0);
  for (var i: i32 = 0; i < 42; i++) {
    let pLocal = (ro + t * rd) - center;
    let d = evalObjSdf(pLocal, objId);
    if (d < 0.0025 * max(1.0, t * 0.04)) {
      res.hit = true;
      res.t = t;
      res.localPos = pLocal;
      return res;
    }
    t += max(d * stepFactor, 0.008);
    if (t > t1) {
      break;
    }
  }
  return res;
}

fn traceCorridorGeometry(ro: vec3f, rd: vec3f) -> HitInfo {
  var best: HitInfo;
  best.hit = false;
  best.t = MAX_TRACE_DIST;
  best.objId = -1;
  best.localPos = vec3f(0.0);

  let kBase = i32(floor(ro.z / CELL_Z + 0.5));
  let stepK = select(-1, 1, rd.z >= 0.0);

  for (var c: i32 = 0; c < 4; c++) {
    let cellZ = f32(kBase + stepK * c) * CELL_Z;
    let minPossibleT = select(0.0, max(0.0, (abs(cellZ - ro.z) - 9.5) / max(abs(rd.z), 1e-3)), c >= 2);
    if (minPossibleT > best.t) {
      break;
    }

    let h0 = marchObject(ro, rd, vec3f(0.0, 0.0, cellZ), 6.65, 0.4, best.t, 0, true);
    if (h0.hit && h0.t < best.t) {
      best = h0;
    }

    let h1 = marchObject(ro, rd, vec3f(-6.8, -1.2, cellZ + 5.5), 2.65, 0.4, best.t, 1, false);
    if (h1.hit && h1.t < best.t) {
      best = h1;
    }

    let h2 = marchObject(ro, rd, vec3f(6.8, 1.5, cellZ - 6.5), 2.45, 0.4, best.t, 2, false);
    if (h2.hit && h2.t < best.t) {
      best = h2;
    }
  }

  return best;
}

fn shadeForegroundHit(
  h: HitInfo,
  rdRest: vec3f,
  doppler: f32,
  dopplerStrength: f32,
  beamingGain: f32,
  geometryVisibility: f32
) -> vec3f {
  let p = h.localPos;
  let n = calcObjNormal(p, h.objId);
  let v = -rdRest;

  let keyDir = normalize(vec3f(0.55, 0.68, -0.48));
  let rimDir = normalize(vec3f(-0.62, -0.35, 0.70));
  let ndlKey = max(dot(n, keyDir), 0.0);
  let ndlRim = max(dot(n, rimDir), 0.0);
  let halfV = normalize(keyDir + v);
  let spec = pow(max(dot(n, halfV), 1e-5), 28.0);
  let fresnel = pow(clamp(1.0 - max(dot(n, v), 0.0), 1e-5, 1.0), 3.2);

  let ao = clamp(0.45 + 0.55 * (evalObjSdf(p + n * 0.22, h.objId) / 0.22), 0.25, 1.0);

  var albedo = vec3f(0.18, 0.21, 0.27);
  var emissive = vec3f(0.0);
  var emTemp : f32 = 6500.0;
  var metalSpec : f32 = 0.75;

  if (h.objId == 0) {
    let angle = select(0.0, atan2(p.y, p.x), abs(p.x) + abs(p.y) > 1e-6);
    let rXY = length(p.xy);
    let seg = smoothstep(0.35, 0.85, cos(angle * 24.0));
    let ribs = 0.82 + 0.18 * cos(angle * 48.0);
    albedo = mix(vec3f(0.14, 0.17, 0.22), vec3f(0.28, 0.33, 0.40), seg) * ribs;

    let stripMask = smoothstep(0.18, 0.04, abs(rXY - 5.4)) * step(0.1, seg);
    let pylonStrip = smoothstep(0.16, 0.04, min(abs(p.x), abs(p.y))) * step(5.2, rXY);
    if (p.z < -0.14) {
      emissive = vec3f(0.14, 0.88, 1.00) * (stripMask * 2.8 + pylonStrip * 1.2);
      emTemp = 11500.0;
    } else if (p.z > 0.14) {
      emissive = vec3f(1.00, 0.48, 0.09) * (stripMask * 2.8 + pylonStrip * 1.2);
      emTemp = 2600.0;
    }
  } else if (h.objId == 1) {
    if (abs(p.y) > 0.75) {
      let finRib = smoothstep(0.75, 0.96, cos(p.z * 22.0));
      albedo = mix(vec3f(0.06, 0.15, 0.34), vec3f(0.45, 0.34, 0.14), finRib);
      metalSpec = 1.15;
    } else {
      let hullPanel = 0.85 + 0.15 * sin(p.z * 12.0);
      albedo = vec3f(0.22, 0.25, 0.30) * hullPanel;
    }
    if (p.z < -0.96) {
      let ringGlow = smoothstep(0.55, 0.32, abs(length(p.xy) - 0.38));
      emissive = vec3f(0.10, 0.86, 1.00) * (1.2 + 3.4 * ringGlow);
      emTemp = 12000.0;
    } else if (p.z > 0.96) {
      let nozzle = smoothstep(0.52, 0.12, length(p.xy));
      emissive = vec3f(1.00, 0.42, 0.08) * (1.4 + 4.2 * nozzle);
      emTemp = 2400.0;
    }
  } else {
    if (p.y < 0.82) {
      let nRock = textureSampleLevel(uVolumeNoise, sVolume, p * 0.52 + vec3f(0.11, 0.37, 0.29), 0.0);
      albedo = mix(vec3f(0.11, 0.10, 0.12), vec3f(0.28, 0.25, 0.23), nRock.r * 0.7 + nRock.b * 0.3);
      metalSpec = 0.22;
    } else {
      let finGrid = 0.8 + 0.2 * cos(p.z * 26.0);
      albedo = vec3f(0.24, 0.28, 0.34) * finGrid;
      if (p.z < -0.50) {
        emissive = vec3f(0.12, 0.84, 1.00) * 3.2;
        emTemp = 11000.0;
      } else if (p.z > 0.50) {
        emissive = vec3f(1.00, 0.46, 0.10) * 3.4;
        emTemp = 2500.0;
      }
    }
  }

  let litSurface = albedo * (0.20 * ao + 1.15 * ndlKey * ao + 0.45 * ndlRim)
                 + vec3f(0.75, 0.86, 1.00) * (spec * metalSpec + fresnel * 0.24);

  let dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  let shiftedLit = applyRelativisticShift(litSurface, 5800.0, dColor, dColor, beamingGain, 0.72);
  let emGain = 0.70 + 0.35 * max(geometryVisibility, 0.0);
  let shiftedEm = applyRelativisticShift(emissive * emGain, emTemp, dColor, dColor, beamingGain, 0.75);

  let distFade = 1.0 - smoothstep(64.0, MAX_TRACE_DIST, h.t);
  return max((shiftedLit + shiftedEm) * distFade, vec3f(0.0));
}

// ============================================================================
// 4. VOLUMETRIC 128^3 INTERSTELLAR DUST STREAKS & 3D PARALLAX STAR KNOTS
// ============================================================================

fn integrateCorridorVolume(
  ro: vec3f,
  rdRest: vec3f,
  tEnd: f32,
  bn: vec4f,
  quality: i32,
  simTime: f32,
  doppler: f32,
  dopplerStrength: f32,
  beamingGain: f32,
  dustDensity: f32,
  dustStreakScale: f32,
  starDensity: f32
) -> vec4f {
  const tStart : f32 = 0.6;
  if (tEnd <= tStart) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (dustDensity <= 0.001 && starDensity <= 0.001) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  var nSteps : i32 = 20;
  if (quality <= 0) {
    nSteps = 14;
  } else if (quality >= 2) {
    nSteps = 28;
  }

  let dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  let invStreakZ = 0.045 / max(dustStreakScale, 0.25);
  let invStreakFineZ = 0.095 / max(dustStreakScale, 0.25);
  let fSteps = f32(nSteps);

  var volRad = vec3f(0.0);
  var trans : f32 = 1.0;

  for (var i: i32 = 0; i < 28; i++) {
    if (i >= nSteps) {
      break;
    }
    let j0 = fract(bn.y + f32(i) * 0.61803399);
    let u0 = f32(i) / fSteps;
    let u1 = f32(i + 1) / fSteps;
    let t0 = mix(tStart, tEnd, u0 * (0.45 + 0.55 * u0));
    let t1 = mix(tStart, tEnd, u1 * (0.45 + 0.55 * u1));
    let tMid = mix(t0, t1, j0);
    let dt = t1 - t0;

    let p = ro + rdRest * tMid;
    let rangeMask = smoothstep(2.5, 11.0, tMid) * (1.0 - smoothstep(46.0, 72.0, tMid));

    if (rangeMask > 0.001) {
      if (dustDensity > 0.001) {
        let uvw1 = vec3f(p.xy * 0.11, p.z * invStreakZ) + vec3f(0.37, 0.61, 0.19);
        let uvw2 = vec3f(p.xy * 0.22, p.z * invStreakFineZ) + vec3f(0.73, 0.29, 0.53);
        let n1 = textureSampleLevel(uVolumeNoise, sVolume, uvw1, 0.0);
        let n2 = textureSampleLevel(uVolumeNoise, sVolume, uvw2, 0.0);

        let wisp = smoothstep(0.58, 0.94, n1.r * 0.55 + n1.g * 0.45);
        let fil = smoothstep(0.60, 0.95, n1.g * 0.52 + n2.a * 0.58);
        let clump = smoothstep(0.45, 0.82, n1.b);
        let dustRedFade = smoothstep(0.30, 0.95, doppler);
        let dens = (wisp * wisp * 0.25 + fil * fil * fil * 0.90) * clump * rangeMask * dustDensity;

        if (dens > 0.002 && dustRedFade > 0.001) {
          let hAlpha = vec3f(0.95, 0.20, 0.34);
          let oThree = vec3f(0.14, 0.72, 0.94);
          var nebCol = mix(hAlpha, oThree, smoothstep(0.28, 0.78, n1.b));
          nebCol = mix(nebCol, vec3f(0.86, 0.94, 1.00), fil * 0.35);

          let shiftedNeb = applyRelativisticShift(nebCol, 5600.0, dColor, dColor, beamingGain, 0.55);
          let ext = dens * 0.0025;
          let stepT = exp(-ext * dt);
          volRad += trans * shiftedNeb * (dens * 0.0060 * dustRedFade * dt);
          trans *= stepT;
        }
      }

      let knotRange = smoothstep(5.5, 13.0, tMid) * (1.0 - smoothstep(48.0, 72.0, tMid));
      if (starDensity > 0.001 && knotRange > 0.001 && length(p.xy) > 1.2) {
        const knotScale : f32 = 0.18;
        let pScaled = p * knotScale;
        let cell = floor(pScaled);
        let rnd = hash33f(cell + vec3f(7.13, 19.41, 31.77));
        if (rnd.x > 0.948) {
          let starWorld = (cell + vec3f(0.26) + 0.48 * hash33f(cell + vec3f(53.1, 11.7, 97.3))) / knotScale;
          let tProj = dot(starWorld - ro, rdRest);
          if (tProj >= t0 && tProj < t1) {
            let dPerp = length((ro + rdRest * tProj) - starWorld);
            let knotR = mix(0.045, 0.105, fract(rnd.y * 13.7));
            let glow = exp(-min((dPerp * dPerp) / (knotR * knotR), 32.0));
            if (glow > 0.005) {
              let tKnot = mix(3400.0, 14000.0, rnd.z);
              let knotCol = sampleBlackbody(tKnot * dColor);
              let knotBeam = evalSoftBeam(doppler, beamingGain);
              let wienCut = smoothstep(220.0, 780.0, tKnot * dColor);
              volRad += trans * knotCol * (glow * 1.95 * knotBeam * wienCut * starDensity * knotRange);
            }
          }
        }
      }
    }

    if (trans < 0.02) {
      break;
    }
  }

  return vec4f(volRad, trans);
}

// ============================================================================
// 5. MAIN RELATIVISTIC ABERRATION, FOREGROUND & VOLUMETRIC PIPELINE
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_prog.x, -u.jitter_fov_prog.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = tan(clamp(u.jitter_fov_prog.z, 0.1, 2.8) * 0.5);
  let localRay = vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0);
  let rdShip = normalize(
    u.camRight_beta.xyz * localRay.x +
    u.camUp_gamma.xyz * localRay.y +
    u.camFwd_oneMinusBeta.xyz * localRay.z
  );

  let pixelFwShip = clamp(length(fwidth(rdShip)), 0.0002, 0.05);

  let simTime = u.resolution_time_frame.z;
  let frameIndex = i32(round(u.resolution_time_frame.w));
  let beta = clamp(u.camRight_beta.w, 0.0, 0.9999996);
  let gamma = max(u.camUp_gamma.w, 1.0);
  let oneMinusBeta = max(u.camFwd_oneMinusBeta.w, 0.0);

  let flightDir = u.flightKinematics.x;
  let flightPosZ = u.flightKinematics.y;
  let dopplerStrength = clamp(u.flightKinematics.w, 0.0, 2.0);

  let cmbVisibility = max(u.spectralParams.x, 0.0);
  let starDensity = max(u.spectralParams.y, 0.0);
  let uvIrGain = max(u.spectralParams.z, 0.0);
  let aberrationStrength = u.spectralParams.w;

  let geometryVisibility = max(u.foregroundParams.x, 0.0);
  let dustDensity = max(u.foregroundParams.y, 0.0);
  let dustStreakScale = max(u.foregroundParams.z, 0.25);

  let skyIntensity = max(u.skyParams.x, 0.0);
  let skyMode = i32(round(u.skyParams.y));
  let skyRot = u.skyParams.zw;

  let quality = i32(round(u.qualityParams.x));
  let beamingGain = max(u.extraParams.x, 0.0);
  let cmbTempScale = max(u.extraParams.y, 0.0);

  // Cancellation-free SR aberration & Doppler factor
  var rdRest = rdShip;
  var doppler : f32 = 1.0;

  if (aberrationStrength > 0.5) {
    let s = select(-1.0, 1.0, flightDir >= 0.0);
    let muP = s * rdShip.z;
    let oneMinusMuP = select(
      1.0 - muP,
      (rdShip.x * rdShip.x + rdShip.y * rdShip.y) / max(1.0 + muP, 1e-6),
      muP >= 0.0
    );
    let denom = select(
      1.0 - beta * muP,
      oneMinusBeta + beta * oneMinusMuP,
      muP >= 0.0
    );
    let muRest = select(muP - beta, oneMinusBeta - oneMinusMuP, muP >= 0.0) / max(denom, 1e-7);
    let perpScale = 1.0 / max(gamma * denom, 1e-7);
    let rawRest = vec3f(rdShip.x * perpScale, rdShip.y * perpScale, s * muRest);
    let rawLen = length(rawRest);
    rdRest = select(vec3f(0.0, 0.0, s), rawRest / max(rawLen, 1e-7), rawLen > 1e-7);
    doppler = clamp(1.0 / max(gamma * denom, 1e-6), 1e-4, 2500.0);
  }

  let pixelFwRest = clamp(pixelFwShip * doppler, 0.0002, 0.28);

  // Sample sky & CMB unconditionally in uniform control flow (wrap- & seam-safe!)
  let skyColor = sampleSkyBackground(
    rdRest,
    pixelFwRest,
    doppler,
    dopplerStrength,
    beamingGain,
    skyIntensity,
    skyMode,
    skyRot,
    starDensity,
    uvIrGain,
    cmbVisibility,
    cmbTempScale
  );

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(frameIndex & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  let origin = vec3f(0.0, 0.0, flightPosZ);
  var hitInfo: HitInfo;
  hitInfo.hit = false;
  hitInfo.t = MAX_TRACE_DIST;
  hitInfo.objId = -1;
  hitInfo.localPos = vec3f(0.0);

  if (geometryVisibility > 0.001) {
    hitInfo = traceCorridorGeometry(origin, rdRest);
  }

  let geomAlpha = select(0.0, smoothstep(0.0, 0.95, geometryVisibility), hitInfo.hit);
  let volMaxDist = select(72.0, hitInfo.t, hitInfo.hit && geomAlpha >= 0.99);

  let volSample = integrateCorridorVolume(
    origin,
    rdRest,
    min(volMaxDist, 72.0),
    bn,
    quality,
    simTime,
    doppler,
    dopplerStrength,
    beamingGain,
    dustDensity,
    dustStreakScale,
    starDensity
  );

  var radiance = skyColor;
  if (hitInfo.hit && geomAlpha > 0.001) {
    let hitColor = shadeForegroundHit(hitInfo, rdRest, doppler, dopplerStrength, beamingGain, geometryVisibility);
    radiance = mix(radiance, hitColor, geomAlpha);
  }
  radiance = radiance * volSample.w + volSample.xyz;

  return vec4f(sanitizeHdr(radiance), 1.0);
}
`;
