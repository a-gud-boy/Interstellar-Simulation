/**
 * Cinema-grade WebGPU WGSL Volumetric Multi-Scattering Supernova Remnant
 * & Emission-Line Nebula Ray-Tracer for "Supernova Remnant Simulator".
 *
 * 1:1 exact physics & radiative-transfer port of supernova.frag.js:
 *  - Locked 160-byte SupernovaUniforms (10 x vec4<f32>) and @group(0) @binding(0..8)
 *  - All uVolumeNoise and uBlackbodyLut lookups strictly use textureSampleLevel(..., 0.0)
 *    for Dawn & Naga WGSL uniformity compliance, and sky derivatives run in uniform flow.
 *  - Origin-safe r -> 0 softened central illuminator and radial normalization.
 */

import { FULLSCREEN_VERT_WGSL } from '../../../shared/shaders/common.wgsl.js';

export const SUPERNOVA_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

struct SupernovaUniforms {
  resolution_time_frame : vec4<f32>,  // (width, height, time, float(frameIndex))
  jitter_fov_palette    : vec4<f32>,  // (jitterX, jitterY, fovY, float(paletteMode))
  camPos_rShock         : vec4<f32>,  // (camX, camY, camZ, worldShockRadius)
  camRight_age          : vec4<f32>,  // (rightX, rightY, rightZ, shockAgeNorm)
  camUp_turb            : vec4<f32>,  // (upX, upY, upZ, rtTurbulence)
  camFwd_dust           : vec4<f32>,  // (fwdX, fwdY, fwdZ, dustOpacity)
  scatterParams         : vec4<f32>,  // (hgAnisotropy, starLuminosity, filamentContrast, cavityGlow)
  skyParams             : vec4<f32>,  // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  qualityParams         : vec4<f32>,  // (float(quality), expansionSpeed, centralTempK, float(isProgressive))
  zoneParams            : vec4<f32>,  // (bokDensity, shellThickness, emissionGain, 0.0)
};

@group(0) @binding(0) var<uniform> u: SupernovaUniforms;
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
const INV_4_PI       : f32 = 0.07957747155;
const T_MIN          : f32 = 800.0;
const T_MAX          : f32 = 40000.0;
const INV_LOG_T_SPAN : f32 = 1.0 / 3.91202300543;

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
// 1. CIE-1931 PLANCK BLACKBODY LUT & BACKGROUND SKY + MICRO-STARS
// ============================================================================

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
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

  let fw = clamp(pixelFw * scale, 0.018, 0.20);
  let starRad = mix(0.026, 0.082, mag) + fw * 0.40;
  let core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let ry = max(rnd.y, 0.0);
  let tEmit = mix(3200.0, 22000.0, ry * ry);
  let col = sampleBlackbody(tEmit);

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let lum = (0.10 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

fn sampleSkyBackground(rawDir: vec3f, skyIntensity: f32, skyMode: i32, skyRot: vec2f) -> vec3f {
  let dir = normalize(rotateSkyDir(rawDir, skyRot));

  // Wrap-safe & pole-safe equirectangular derivatives in uniform control flow
  let u1 = atan2(dir.z, dir.x) * INV_TAU + 0.5;
  let v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  let uv1 = vec2f(u1, v);
  let uv2 = vec2f(fract(u1 + 0.5), v);

  let dx1 = dpdx(uv1);
  let dy1 = dpdy(uv1);
  let dx2 = dpdx(uv2);
  let dy2 = dpdy(uv2);

  let dUVdx = clamp(vec2f(select(dx2.x, dx1.x, abs(dx1.x) < abs(dx2.x)), dx1.y), vec2f(-0.38), vec2f(0.38));
  let dUVdy = clamp(vec2f(select(dy2.x, dy1.x, abs(dy1.x) < abs(dy2.x)), dy1.y), vec2f(-0.38), vec2f(0.38));
  let dirFw = min(length(fwidth(dir)), 0.12);

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.005, 0.995));
  var mapSrgb : vec3f;
  if (skyMode == 2) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(0.0)), vec3f(2.2));

  let skyLuma = dot(skyLin, vec3f(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.32, 1.0, smoothstep(0.002, 0.042, skyLuma));

  let brightCores = max(skyLin - vec3f(0.28), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.2;

  if (skyMode == 0 || skyMode == 2) {
    let starGain = select(1.05, 0.75, skyMode == 0);
    skyLin += evalMicroStarLayer(dir, 95.0,  0.908, 0.95 * starGain, dirFw)
            + evalMicroStarLayer(dir, 195.0, 0.882, 0.42 * starGain, dirFw);
  }

  return skyLin * max(skyIntensity, 0.0);
}

// ============================================================================
// 2. DUAL-LOBE HENYEY–GREENSTEIN & WRENNINGE MULTI-OCTAVE SCATTERING
// ============================================================================

fn evalHG(cosTheta: f32, g: f32) -> f32 {
  let gc = clamp(g, -0.95, 0.95);
  let mu = clamp(cosTheta, -1.0, 1.0);
  let denom = max(1.0 + gc * gc - 2.0 * gc * mu, 1e-4);
  return ((1.0 - gc * gc) * INV_4_PI) / (denom * sqrt(denom));
}

fn evalDualHG(cosTheta: f32, g: f32) -> f32 {
  let g1 = clamp(g, -0.95, 0.95);
  let g2 = clamp(-0.35 * g1, -0.55, 0.55);
  return 0.82 * evalHG(cosTheta, g1) + 0.18 * evalHG(cosTheta, g2);
}

fn evalWrenningeMultiScatter(tauShadow: f32, cosTheta: f32, g: f32) -> f32 {
  let tau = max(tauShadow, 0.0);
  let gc = clamp(g, -0.95, 0.95);
  var sum : f32 = 0.0;
  var aPow : f32 = 1.0;
  var bPow : f32 = 1.0;
  var cPow : f32 = 1.0;
  for (var oct: i32 = 0; oct < 4; oct++) {
    let extAtten = exp(-min(bPow * tau, 40.0));
    sum += aPow * extAtten * evalDualHG(cosTheta, gc * cPow);
    aPow *= 0.55;
    bPow *= 0.48;
    cPow *= 0.65;
  }
  return sum;
}

// ============================================================================
// 3. 3D RAYLEIGH–TAYLOR FILAMENT SCULPTING, IONIZATION ZONES & SHADOW TAPS
// ============================================================================

fn gaussianBand(x: f32, center: f32, width: f32) -> f32 {
  let u = (x - center) / max(width, 1e-4);
  return exp(-min(u * u, 40.0));
}

fn evalShadowExtinction(
  p: vec3f,
  rShock: f32,
  shockAgeNorm: f32,
  rtTurbulence: f32,
  dustOpacity: f32,
  bokDensity: f32,
  shellThickness: f32,
  emissionGain: f32,
  simTime: f32,
  expansionSpeed: f32
) -> f32 {
  let r2 = dot(p, p);
  let r = sqrt(r2);
  let u = r / max(rShock, 0.5);
  if (u > 1.66) {
    return 0.0;
  }

  let rHat = select(vec3f(0.0, 1.0, 0.0), p / max(r, 1e-5), r > 1e-5);
  let adv = simTime * expansionSpeed * 0.028;

  let qBase = p * (0.14 / max(rShock / 3.2, 0.5)) - rHat * (adv * 0.65);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, qBase, 0.0);

  let asym = 1.0 + 0.08 * (rHat.x * rHat.y - 0.55 * rHat.z) + 0.14 * (n1.r - 0.5);
  let uWarp = (u / max(asym, 0.55)) + (n1.r - 0.5) * 0.28 * rtTurbulence;

  let shellEnv = gaussianBand(uWarp, 0.94, 0.24 * shellThickness);
  let dustBand = smoothstep(0.74, 1.02, uWarp) * (1.0 - smoothstep(1.34, 1.64, uWarp));
  let clump = smoothstep(0.32, 0.88, n1.r * 0.58 + (1.0 - n1.b) * 0.42);
  let bokKnot = smoothstep(0.56, 0.90, (1.0 - n1.b) * 0.72 + n1.g * 0.28) * dustBand * bokDensity;

  let gasExt = 0.09 * shellEnv * emissionGain * (0.55 + 0.45 * n1.g);
  let dustExt = (0.82 * clump * dustBand + 2.35 * bokKnot) * dustOpacity * (0.75 + 0.45 * shockAgeNorm);
  return gasExt + dustExt;
}

struct VolSample {
  emission      : vec3f,
  scatterAlbedo : vec3f,
  sigmaScat     : f32,
  sigmaExt      : f32,
};

fn evalVolumeSample(
  p: vec3f,
  rShock: f32,
  shockAgeNorm: f32,
  rtTurbulence: f32,
  dustOpacity: f32,
  filamentContrast: f32,
  cavityGlow: f32,
  bokDensity: f32,
  shellThickness: f32,
  emissionGain: f32,
  paletteMode: i32,
  centralTempK: f32,
  simTime: f32,
  expansionSpeed: f32
) -> VolSample {
  var vs: VolSample;
  vs.emission = vec3f(0.0);
  vs.scatterAlbedo = vec3f(0.0);
  vs.sigmaScat = 0.0;
  vs.sigmaExt = 0.0;

  let r2 = dot(p, p);
  let r = sqrt(r2);
  let u = r / max(rShock, 0.5);
  if (u > 1.68) {
    return vs;
  }

  let rHat = select(vec3f(0.0, 1.0, 0.0), p / max(r, 1e-5), r > 1e-5);
  let adv = simTime * expansionSpeed * 0.028;

  let qBase = p * (0.14 / max(rShock / 3.2, 0.5)) - rHat * (adv * 0.65);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, qBase, 0.0);

  let asym = 1.0 + 0.08 * (rHat.x * rHat.y - 0.55 * rHat.z) + 0.14 * (n1.r - 0.5);
  let uWarp = (u / max(asym, 0.55)) + (n1.r - 0.5) * 0.28 * rtTurbulence + (n1.g - 0.5) * 0.12 * rtTurbulence;

  let qRadial = rHat * (1.35 + 0.52 * log(1.0 + 2.1 * u))
              + (n1.rgb - vec3f(0.5)) * (0.38 * rtTurbulence)
              - rHat * (adv * 1.15);
  let qRT = mix(p * 0.45, qRadial * 0.48, smoothstep(0.03, 0.18, u));
  let n2 = textureSampleLevel(uVolumeNoise, sVolume, qRT, 0.0);

  let rtBase = clamp(n2.g * 0.64 + (1.0 - n2.b) * 0.36, 0.0, 1.0);
  let rtSharp = smoothstep(0.32, 0.92, rtBase);
  let rtFine = mix(rtSharp, rtSharp * rtSharp * (0.55 + 0.45 * n2.a), clamp(filamentContrast - 0.5, 0.0, 1.0));
  let rtFingers = (0.28 + 1.45 * rtFine) * (0.55 + 0.45 * n1.g);

  let pwnBand = smoothstep(0.04, 0.16, u) * (1.0 - smoothstep(0.34, 0.64, u));
  let pwnWisp = smoothstep(0.28, 0.88, n1.g * 0.52 + n2.a * 0.48);
  let pwnVal = pwnBand * (0.25 + 0.95 * pwnWisp) * cavityGlow * (1.20 - 0.45 * shockAgeNorm);

  let oiiiBand = gaussianBand(uWarp, 0.72, 0.21 * shellThickness);
  let oiiiVal = oiiiBand * (0.35 + 0.85 * n2.r) * (0.75 + 0.45 * rtSharp);

  let haBand = gaussianBand(uWarp, 0.96, 0.15 * shellThickness);
  let haVal = haBand * rtFingers;

  let siiBand = gaussianBand(uWarp, 1.09, 0.11 * shellThickness);
  let siiVal = siiBand * (0.30 + 1.25 * rtFine) * smoothstep(0.35, 0.85, n2.g + 0.22 * n1.g);

  let dustBand = smoothstep(0.74, 1.02, uWarp) * (1.0 - smoothstep(1.34, 1.64, uWarp));
  let dustClump = smoothstep(0.30, 0.86, n1.r * 0.54 + (1.0 - n2.b) * 0.46);
  let bokRaw = clamp((1.0 - n2.b) * 0.65 + (1.0 - n1.b) * 0.35, 0.0, 1.0);
  let bokKnot = smoothstep(0.58, 0.91, bokRaw) * dustBand * bokDensity;

  let sigmaDust = (0.78 * dustClump * dustBand + 2.45 * bokKnot) * dustOpacity * (0.75 + 0.45 * shockAgeNorm);

  var cOIII : vec3f;
  var cHa   : vec3f;
  var cSII  : vec3f;
  if (paletteMode == 0) {
    cSII  = vec3f(1.00, 0.56, 0.10);
    cHa   = vec3f(0.28, 0.88, 0.40);
    cOIII = vec3f(0.08, 0.72, 1.00);
  } else {
    cHa   = vec3f(1.00, 0.14, 0.24);
    cOIII = vec3f(0.06, 0.88, 0.78);
    cSII  = vec3f(0.98, 0.42, 0.10);
  }

  let pwnColor = mix(vec3f(0.28, 0.66, 1.00), sampleBlackbody(clamp(centralTempK * 0.28, 7000.0, 40000.0)), 0.45);
  var gasEmit = pwnColor * (pwnVal * 0.58)
              + cOIII * (oiiiVal * 0.66)
              + cHa   * (haVal   * 0.92)
              + cSII  * (siiVal  * 0.78);
  gasEmit *= emissionGain;

  let gasDensity = (0.24 * pwnVal + 0.52 * oiiiVal + 0.88 * haVal + 0.60 * siiVal) * emissionGain;
  let sigmaGasExt = 0.085 * gasDensity;

  vs.emission = gasEmit;
  vs.sigmaScat = 0.06 * gasDensity + 0.72 * sigmaDust;
  vs.sigmaExt = sigmaGasExt + sigmaDust;
  vs.scatterAlbedo = mix(vec3f(0.75, 0.82, 0.95), vec3f(0.95, 0.78, 0.62), clamp(sigmaDust / max(vs.sigmaExt, 1e-4), 0.0, 1.0));
  return vs;
}

// ============================================================================
// 4. CENTRAL WHITE DWARF / PULSAR ILLUMINATOR (ORIGIN-SAFE)
// ============================================================================

fn evalCentralCore(camPos: vec3f, rayDir: vec3f, starLuminosity: f32, centralTempK: f32) -> vec3f {
  if (starLuminosity <= 1e-4) {
    return vec3f(0.0);
  }

  let tStar = -dot(camPos, rayDir);
  if (tStar <= -0.15) {
    return vec3f(0.0);
  }

  let tFwd = max(tStar, 0.0);
  let fwdFade = smoothstep(-0.14, 0.18, tStar);
  let d2 = max(dot(camPos, camPos) - tStar * tStar, 0.0);

  let coreScale = 0.0022 + 0.00042 * tFwd * tFwd;
  let haloScale = 0.042 + 0.0042 * tFwd * tFwd;
  let coreDisk = exp(-min(d2 / coreScale, 40.0));
  let corona = exp(-min(d2 / haloScale, 40.0));
  let distAtten = 1.0 / (1.0 + 0.045 * tFwd * tFwd);

  let starCol = sampleBlackbody(centralTempK);
  let coronaCol = mix(starCol, vec3f(0.42, 0.78, 1.00), 0.38);

  return (starCol * (3.2 * coreDisk) + coronaCol * (0.48 * corona)) * starLuminosity * fwdFade * distAtten;
}

// ============================================================================
// 5. MAIN ANALYTIC-SPHERE MULTI-SCATTERING VOLUMETRIC RAY-MARCHER
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_palette.x, -u.jitter_fov_palette.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = tan(clamp(u.jitter_fov_palette.z, 0.1, 2.8) * 0.5);
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let camBasis = mat3x3f(
    u.camRight_age.xyz,
    u.camUp_turb.xyz,
    u.camFwd_dust.xyz
  );
  let rayDir = normalize(camBasis * localRay);

  let simTime = u.resolution_time_frame.z;
  let frameIndex = i32(round(u.resolution_time_frame.w));
  let paletteMode = clamp(i32(round(u.jitter_fov_palette.w)), 0, 1);

  let camPos = u.camPos_rShock.xyz;
  let rShock = max(u.camPos_rShock.w, 0.5);
  let shockAgeNorm = clamp(u.camRight_age.w, 0.0, 1.0);
  let rtTurbulence = max(u.camUp_turb.w, 0.0);
  let dustOpacity = max(u.camFwd_dust.w, 0.0);

  let hgAnisotropy = clamp(u.scatterParams.x, -0.95, 0.95);
  let starLuminosity = max(u.scatterParams.y, 0.0);
  let filamentContrast = max(u.scatterParams.z, 0.1);
  let cavityGlow = max(u.scatterParams.w, 0.0);

  let skyIntensity = max(u.skyParams.x, 0.0);
  let skyMode = i32(round(u.skyParams.y));
  let skyRot = u.skyParams.zw;

  let quality = i32(round(u.qualityParams.x));
  let expansionSpeed = max(u.qualityParams.y, 0.0);
  let centralTempK = clamp(u.qualityParams.z, T_MIN, 400000.0);
  let isProgressive = u.qualityParams.w > 0.5;

  let bokDensity = max(u.zoneParams.x, 0.0);
  let shellThickness = clamp(u.zoneParams.y, 0.3, 2.5);
  let emissionGain = max(u.zoneParams.z, 0.0);

  let skyColor = sampleSkyBackground(rayDir, skyIntensity, skyMode, skyRot);

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(frameIndex & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  let rBound = rShock * 1.68;
  let bSphere = dot(camPos, rayDir);
  let cSphere = dot(camPos, camPos) - rBound * rBound;
  let disc = bSphere * bSphere - cSphere;

  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;

  if (disc > 0.0) {
    let sqrtDisc = sqrt(disc);
    let tNear = max(0.0, -bSphere - sqrtDisc);
    let tFar = -bSphere + sqrtDisc;

    if (tFar > tNear) {
      var nSteps : i32 = select(84, 112, isProgressive);
      if (quality <= 0) {
        nSteps = select(56, 80, isProgressive);
      } else if (quality >= 2) {
        nSteps = select(120, 144, isProgressive);
      }

      let marchSpan = tFar - tNear;
      let ds = marchSpan / f32(nSteps);
      let tStar = -dot(camPos, rayDir);
      var starTransmittance : f32 = 1.0;

      var tapFrac = array<f32, 6>(0.05, 0.11, 0.20, 0.34, 0.54, 0.78);
      var tapW    = array<f32, 6>(0.07, 0.09, 0.13, 0.18, 0.23, 0.30);

      let starLightTint = mix(sampleBlackbody(centralTempK), vec3f(0.65, 0.88, 1.00), 0.25);

      for (var step: i32 = 0; step < 144; step++) {
        if (step >= nSteps) { break; }

        let tPrev = tNear + f32(step) * ds;
        let t = tPrev + bn.x * ds;
        let p = camPos + rayDir * t;

        let vs = evalVolumeSample(
          p,
          rShock,
          shockAgeNorm,
          rtTurbulence,
          dustOpacity,
          filamentContrast,
          cavityGlow,
          bokDensity,
          shellThickness,
          emissionGain,
          paletteMode,
          centralTempK,
          simTime,
          expansionSpeed
        );

        var stepSource = vs.emission;

        if (vs.sigmaScat > 1e-4) {
          let r2 = dot(p, p);
          let r = sqrt(r2);
          let rHat = select(vec3f(0.0, 1.0, 0.0), p / max(r, 1e-5), r > 1e-5);

          var tauShadow : f32 = 0.0;
          if (starLuminosity > 1e-3 && r > 0.08) {
            let shadowSpan = min(r, rBound);
            for (var st: i32 = 0; st < 6; st++) {
              let pTap = p * max(1.0 - tapFrac[st], 0.0);
              let extTap = evalShadowExtinction(
                pTap,
                rShock,
                shockAgeNorm,
                rtTurbulence,
                dustOpacity,
                bokDensity,
                shellThickness,
                emissionGain,
                simTime,
                expansionSpeed
              );
              tauShadow += extTap * (tapW[st] * shadowSpan);
            }
          }

          let cosTheta = dot(rHat, -rayDir);
          let wrenninge = evalWrenningeMultiScatter(tauShadow, cosTheta, hgAnisotropy);
          let invDist2 = 1.0 / (r2 + 0.25);
          let directScatter = starLightTint * (starLuminosity * 6.5 * invDist2 * wrenninge);

          let ambientBounce = mix(vec3f(0.04, 0.09, 0.14), vec3f(0.11, 0.08, 0.05), f32(1 - paletteMode)) * emissionGain;

          stepSource += vs.sigmaScat * vs.scatterAlbedo * (directScatter + ambientBounce);
        }

        let prevTrans = transmittance;
        let sigmaT = max(vs.sigmaExt, 0.0);
        if (sigmaT > 1e-4 || dot(stepSource, stepSource) > 1e-10) {
          let tau = min(sigmaT * ds, 40.0);
          let stepT = exp(-tau);
          var stepRad : vec3f;
          if (sigmaT > 1e-4) {
            stepRad = stepSource * ((1.0 - stepT) / max(sigmaT, 1e-5));
          } else {
            stepRad = stepSource * ds;
          }
          radiance += transmittance * stepRad;
          transmittance *= stepT;
        }

        if (tStar > tNear) {
          let tNext = tPrev + ds;
          if (tNext <= tStar) {
            starTransmittance = transmittance;
          } else if (tPrev < tStar) {
            let frac = clamp((tStar - tPrev) / max(ds, 1e-5), 0.0, 1.0);
            starTransmittance = mix(prevTrans, transmittance, frac);
          }
        }

        if (transmittance < 0.005) {
          break;
        }
      }

      radiance += starTransmittance * evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
    } else {
      radiance += evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
    }
  } else {
    radiance += evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
  }

  radiance += transmittance * skyColor;

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));
  return vec4f(radiance, 1.0);
}
`;
