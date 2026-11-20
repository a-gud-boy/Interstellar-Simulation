/**
 * Cinema-grade WebGPU WGSL relativistic traversable wormhole shader.
 *
 * 1:1 exact physics & optical port of wormhole.frag.js:
 *  - Exact Morris-Thorne spacetime (Interstellar James-Thorne Dneg & Ellis drainhole)
 *  - Exact great-circle geodesic ODE via adaptive RK4
 *  - Graceful photon-sphere fallback near b ~ rho (zero black ring artifact)
 *  - Dual-universe equirectangular sky sampling + Saturn & binary accretion landmarks
 *  - Optional translucent 3D volumetric throat caustic halo & swirling dust filaments
 */

import { FULLSCREEN_VERT_WGSL } from './common.wgsl.js';

export const WORMHOLE_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

struct WormholeUniforms {
  resolution_time_frame  : vec4f, // x=width, y=height, z=time, w=f32(frame)
  jitter_fov_camL        : vec4f, // x=jitterX, y=jitterY, z=fovY, w=camL
  camN0_tanHalfFov       : vec4f, // xyz=camN0, w=tanHalfFov
  camRight_rho           : vec4f, // xyz=basisCol0, w=throatRadius
  camUp_throatLen        : vec4f, // xyz=basisCol1, w=throatLength
  camForward_lensingW    : vec4f, // xyz=basisCol2, w=lensingWidth
  matter_skyParams       : vec4f, // x=throatGlow, y=dustDensity, z=swirlSpeed, w=skyIntensityA
  skyB_rotA_rotBx        : vec4f, // x=skyIntensityB, y=skyRotA.x, z=skyRotA.y, w=skyRotB.x
  rotBy_camR_escapeL_pad : vec4f, // x=skyRotB.y, y=camR, z=escapeL, w=0.0
  modes                  : vec4i, // x=frameIndex, y=metricType, z=quality, w=planetVisible
  skyTrigA               : vec4f, // x=cos(rotA.x), y=sin(rotA.x), z=cos(rotA.y), w=sin(rotA.y)
  skyTrigB               : vec4f, // x=cos(rotB.x), y=sin(rotB.x), z=cos(rotB.y), w=sin(rotB.y)
};

@group(0) @binding(0) var<uniform> u: WormholeUniforms;
@group(0) @binding(1) var uVolumeNoise: texture_3d<f32>;
@group(0) @binding(2) var sVolume: sampler;
@group(0) @binding(3) var uSkyMapA: texture_2d<f32>;
@group(0) @binding(4) var uProcSkyMapA: texture_2d<f32>;
@group(0) @binding(5) var uSkyMapB: texture_2d<f32>;
@group(0) @binding(6) var sSky: sampler;
@group(0) @binding(7) var uBlueNoise: texture_2d<f32>;

const PI      : f32 = 3.14159265359;
const TAU     : f32 = 6.28318530718;
const INV_PI  : f32 = 0.31830988618;
const INV_TAU : f32 = 0.15915494309;

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
// 1. EXACT MORRIS-THORNE (JAMES-THORNE DNEG & ELLIS) METRIC & GEODESIC ODE
// ============================================================================

struct MetricVal {
  r    : f32,
  drdl : f32,
};

fn evalMetric(l: f32, metricType: i32, rho: f32, a: f32, M: f32) -> MetricVal {
  var outM: MetricVal;
  if (metricType == 1) {
    let r = sqrt(rho * rho + l * l);
    outM.r = r;
    outM.drdl = l / max(r, 1e-6);
    return outM;
  }

  let absL = abs(l);
  if (absL <= a) {
    outM.r = rho;
    outM.drdl = 0.0;
    return outM;
  }

  let safeM = max(M, 1e-4);
  let x = (2.0 * (absL - a)) / (PI * safeM);
  let atanX = atan(x);
  outM.r = rho + safeM * (x * atanX - 0.5 * log(1.0 + x * x));
  outM.drdl = select(-1.0, 1.0, l >= 0.0) * (2.0 * INV_PI) * atanX;
  return outM;
}

fn evalMetricR(l: f32, metricType: i32, rho: f32, a: f32, M: f32) -> f32 {
  if (metricType == 1) {
    return sqrt(rho * rho + l * l);
  }
  let absL = abs(l);
  if (absL <= a) {
    return rho;
  }
  let safeM = max(M, 1e-4);
  let x = (2.0 * (absL - a)) / (PI * safeM);
  return rho + safeM * (x * atan(x) - 0.5 * log(1.0 + x * x));
}

struct GeodesicDeriv {
  dl   : f32,
  dpl  : f32,
  dpsi : f32,
  r    : f32,
};

fn evalGeodesicRHS(l: f32, pl: f32, b: f32, b2: f32, metricType: i32, rho: f32, a: f32, M: f32) -> GeodesicDeriv {
  let mv = evalMetric(l, metricType, rho, a, M);
  let invR = 1.0 / max(mv.r, 1e-5);
  let invR2 = invR * invR;
  var d: GeodesicDeriv;
  d.dl = pl;
  d.dpl = (b2 * invR2 * invR) * mv.drdl;
  d.dpsi = b * invR2;
  d.r = mv.r;
  return d;
}

// ============================================================================
// 2. VOLUMETRIC THROAT CAUSTIC HALO & SWIRLING DUST FILAMENTS
// ============================================================================

fn rotateAroundAxis(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
}

struct MatterSample {
  emission   : vec3f,
  extinction : f32,
};

fn evalThroatMatter(
  l: f32,
  pl: f32,
  nVec: vec3f,
  a: f32,
  M: f32,
  matterBound: f32
) -> MatterSample {
  var outM: MatterSample;
  outM.emission = vec3f(0.0);
  outM.extinction = 0.0;

  let absL = abs(l);
  if (absL >= matterBound) {
    return outM;
  }

  let lipWidth = max(M, 0.35);
  let lipDist = max(absL - a, 0.0);

  let outerEnv = 1.0 - smoothstep(a + lipWidth * 0.4, matterBound, absL);
  let lipCenterDist = (absL - (a + 0.35 * lipWidth)) / max(lipWidth * 0.72, 0.32);
  let lipPeak = exp(-(lipCenterDist * lipCenterDist));
  let interiorEnv = smoothstep(a + 0.65 * lipWidth, max(a - 0.2, 0.0), absL);
  let env = max(outerEnv * 0.45, max(lipPeak * 0.92, interiorEnv * 0.68));
  if (env < 1e-4) {
    return outM;
  }

  let simTime = u.resolution_time_frame.z;
  let swirlSpeed = u.matter_skyParams.z;
  let throatGlow = u.matter_skyParams.x;
  let dustDensity = u.matter_skyParams.y;

  let swirlAxis = normalize(vec3f(0.18, 0.96, 0.21));
  let swirlAngle = simTime * swirlSpeed * 0.36 + l * 0.24;
  let rotN = rotateAroundAxis(nVec, swirlAxis, swirlAngle);

  let flowT = simTime * swirlSpeed * 0.028;
  let uvw1 = rotN * 0.78 + vec3f(l * 0.11 - flowT * 0.45, flowT, -l * 0.08);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, uvw1, 0.0);

  let uvw2 = rotN * 1.85 + vec3f(n1.r * 0.18, l * 0.22 + flowT * 1.4, n1.g * 0.18);
  let n2 = textureSampleLevel(uVolumeNoise, sVolume, uvw2, 0.0);

  let ridgedFil = pow(clamp(n1.g * 0.58 + n2.a * 0.52, 0.0, 1.0), 1.65);
  let billow = smoothstep(0.20, 0.85, n1.r * 0.65 + n1.b * 0.35);
  let grazing = pow(clamp(1.0 - abs(pl), 0.0, 1.0), 1.45);

  let sideBlend = smoothstep(-0.8, 0.8, l);
  let tintA = vec3f(0.42, 0.76, 1.00);
  let tintB = vec3f(1.00, 0.68, 0.26);
  let throatTint = mix(tintB, tintA, sideBlend);

  if (throatGlow > 0.001) {
    let caustic = (0.28 + 0.72 * ridgedFil) * (0.25 + 0.85 * grazing);
    outM.emission += throatTint * (throatGlow * env * caustic * 0.175);
  }

  if (dustDensity > 0.001) {
    let dustMask = pow(clamp(billow * 0.55 + ridgedFil * 0.55, 0.0, 1.0), 1.45);
    let dustCol = mix(vec3f(0.88, 0.52, 0.22), vec3f(0.45, 0.62, 0.86), sideBlend);
    outM.emission += dustCol * (dustDensity * env * dustMask * (0.045 + 0.055 * grazing));
    outM.extinction = dustDensity * env * (0.045 + 0.24 * dustMask) * (1.0 - 0.35 * exp(-lipDist));
  }

  return outM;
}

// ============================================================================
// 3. DUAL-UNIVERSE SKY BACKGROUND, MICRO-STARS & ICONIC LANDMARKS
// ============================================================================

fn rotateSkyDirTrig(d: vec3f, trig: vec4f) -> vec3f {
  let cy = trig.x;
  let sy = trig.y;
  let r1 = vec3f(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  let cp = trig.z;
  let sp = trig.w;
  return vec3f(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

fn hash33f(pIn: vec3f) -> vec3f {
  var p = fract(pIn * vec3f(0.1031, 0.1030, 0.0973));
  p += vec3f(dot(p, p.yxz + vec3f(33.33)));
  return fract((p.xxy + p.yxx) * p.zyx);
}

fn stellarTint(tNorm: f32, alienPalette: bool) -> vec3f {
  if (alienPalette) {
    let gold  = vec3f(1.00, 0.68, 0.28);
    let ivory = vec3f(1.00, 0.94, 0.82);
    let teal  = vec3f(0.42, 0.92, 1.00);
    return select(mix(ivory, teal, (tNorm - 0.55) / 0.45), mix(gold, ivory, tNorm / 0.55), tNorm < 0.55);
  }
  let redK  = vec3f(1.00, 0.56, 0.26);
  let solG  = vec3f(1.00, 0.95, 0.88);
  let blueO = vec3f(0.64, 0.82, 1.00);
  return select(mix(solG, blueO, (tNorm - 0.5) * 2.0), mix(redK, solG, tNorm * 2.0), tNorm < 0.5);
}

fn evalMicroStarLayer(dir: vec3f, scale: f32, densityThresh: f32, boost: f32, pixelFw: f32, alienPalette: bool) -> vec3f {
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
  let mag = mag2 * mag2 * pow(magU, 0.4);

  let fw = clamp(pixelFw * scale, 0.018, 0.14);
  let starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  let core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let col = stellarTint(pow(max(rnd.y, 0.0), 1.35), alienPalette);
  let lum = (0.09 + 3.4 * mag) * boost * energyComp;
  return col * (core * lum);
}

struct LandmarkResult {
  color : vec3f,
  occ   : f32,
};

fn evalUniverseALandmarks(dir: vec3f, dirFw: f32) -> LandmarkResult {
  let saturnDir  = normalize(vec3f(-0.18, 0.22, -0.958));
  let sunDir     = normalize(vec3f(-0.62, 0.30, -0.725));
  let ringNormal = normalize(vec3f(0.28, 0.90, 0.33));

  let distUnits : f32 = 31.0;
  let C = saturnDir * distUnits;
  let aaUnit = clamp(min(dirFw, 0.012) * distUnits, 0.014, 0.25);

  let tCa = dot(C, dir);
  var tGlobe : f32 = 1e6;
  var globeAlpha : f32 = 0.0;
  var globeCol = vec3f(0.0);

  if (tCa > 0.0) {
    let perp = dir * tCa - C;
    let d2 = dot(perp, perp);
    let d = sqrt(d2);
    globeAlpha = 1.0 - smoothstep(1.0 - aaUnit, 1.0 + aaUnit, d);
    if (globeAlpha > 0.001) {
      let zHit = sqrt(max(1.0 - min(d2, 0.9999), 0.0));
      tGlobe = tCa - zHit;
      let hitP = dir * tGlobe - C;
      let N = normalize(hitP);

      let lat = dot(N, ringNormal);
      let band = 0.5 + 0.5 * sin(lat * 26.0 + 0.6 * sin(lat * 9.0));
      let fineBand = 0.5 + 0.5 * cos(lat * 64.0);
      var baseAlbedo = mix(vec3f(0.76, 0.66, 0.49), vec3f(0.92, 0.85, 0.68), band * 0.72 + fineBand * 0.28);
      baseAlbedo = mix(baseAlbedo, vec3f(0.55, 0.60, 0.68), smoothstep(0.76, 0.98, abs(lat)) * 0.55);

      let denomShad = dot(sunDir, ringNormal);
      var ringShadow : f32 = 1.0;
      if (abs(denomShad) > 1e-4) {
        let tS = -dot(hitP, ringNormal) / denomShad;
        if (tS > 0.0) {
          let rShad = length(hitP + sunDir * tS);
          let inRingShad = smoothstep(1.30, 1.38, rShad) * (1.0 - smoothstep(2.34, 2.40, rShad));
          let cassiniDist = (rShad - 1.97) / 0.045;
          let cassiniGap = exp(-(cassiniDist * cassiniDist));
          ringShadow = 1.0 - inRingShad * (1.0 - cassiniGap * 0.85) * 0.78;
        }
      }

      let ndotl = max(dot(N, sunDir), 0.0);
      let lit = pow(ndotl, 0.86) * ringShadow;
      let fresnel = pow(clamp(1.0 - max(dot(N, -dir), 0.0), 0.0, 1.0), 3.0);
      let limbGlow = vec3f(0.72, 0.78, 0.88) * (fresnel * ndotl * 0.25);
      globeCol = baseAlbedo * (0.025 + 1.55 * lit) + limbGlow;
    }
  }

  let denom = dot(dir, ringNormal);
  var tRing : f32 = 1e6;
  var ringAlpha : f32 = 0.0;
  var ringCol = vec3f(0.0);
  if (abs(denom) > 1e-4) {
    let tr = dot(C, ringNormal) / denom;
    if (tr > 0.0) {
      let rPos = dir * tr - C;
      let rDist = length(rPos);
      let innerFade = smoothstep(1.30 - aaUnit, 1.34 + aaUnit, rDist);
      let outerFade = 1.0 - smoothstep(2.36 - aaUnit, 2.40 + aaUnit, rDist);
      let ringMask = innerFade * outerFade;
      if (ringMask > 0.001) {
        tRing = tr;
        let casW = (rDist - 1.97) / max(0.042, aaUnit * 0.5);
        let encW = (rDist - 2.27) / max(0.018, aaUnit * 0.4);
        let cassini = 1.0 - 0.94 * exp(-(casW * casW));
        let encke   = 1.0 - 0.65 * exp(-(encW * encW));
        let cRing   = mix(0.28, 1.0, smoothstep(1.32, 1.54, rDist));
        let ringlets = 0.82 + 0.18 * sin(rDist * 48.0) * cos(rDist * 19.0);
        let density = ringMask * cassini * encke * cRing * ringlets;

        let sunProj = dot(rPos, sunDir);
        var planetShadow : f32 = 1.0;
        if (sunProj < 0.0) {
          let perpSun = length(rPos - sunDir * sunProj);
          planetShadow = smoothstep(0.96, 1.05, perpSun);
        }

        let rAlbedo = mix(vec3f(0.74, 0.66, 0.56), vec3f(0.95, 0.89, 0.77), smoothstep(1.52, 1.88, rDist));
        let sunLit = 0.03 + 1.45 * planetShadow * (0.55 + 0.45 * abs(dot(ringNormal, sunDir)));
        ringCol = rAlbedo * sunLit;
        ringAlpha = clamp(density * 0.86, 0.0, 0.94);
      }
    }
  }

  var saturnTotal = vec3f(0.0);
  var saturnOcc : f32 = 0.0;
  if (tRing < tGlobe) {
    saturnTotal = ringCol * ringAlpha + globeCol * globeAlpha * (1.0 - ringAlpha);
    saturnOcc = clamp(ringAlpha + globeAlpha * (1.0 - ringAlpha), 0.0, 1.0);
  } else {
    saturnTotal = globeCol * globeAlpha + ringCol * ringAlpha * (1.0 - globeAlpha);
    saturnOcc = clamp(globeAlpha + ringAlpha * (1.0 - globeAlpha), 0.0, 1.0);
  }

  let sunCos = dot(dir, sunDir);
  let sunAng = atan2(length(cross(dir, sunDir)), sunCos);
  let sunFw = min(dirFw, 0.009);
  let sunEnergy = min(1.0, 0.012 / max(dirFw * 1.5, 1e-4));
  let sunDisc = (1.0 - smoothstep(0.0085, 0.0115 + sunFw, sunAng)) * sunEnergy;
  let corona  = (exp(-sunAng * 56.0) * 0.72 + exp(-sunAng * 18.0) * 0.032) * (0.20 + 0.80 * sunEnergy);
  let sunCol = vec3f(1.00, 0.95, 0.84) * (sunDisc * 10.5 + corona);

  var resOut: LandmarkResult;
  resOut.color = saturnTotal + sunCol;
  resOut.occ = 1.0 - saturnOcc;
  return resOut;
}

fn evalUniverseBLandmark(dir: vec3f, dirFw: f32) -> vec3f {
  let beaconDir = normalize(vec3f(-0.72, 0.08, -0.689));
  let bUp = normalize(vec3f(0.24, 0.92, -0.31));
  let bRight = normalize(cross(bUp, beaconDir));
  let bOrthoUp = cross(beaconDir, bRight);

  let rel = vec2f(dot(dir, bRight), dot(dir, bOrthoUp));
  let front = smoothstep(-0.1, 0.3, dot(dir, beaconDir));
  if (front <= 0.001) {
    return vec3f(0.0);
  }

  let angDist = length(rel);
  if (angDist > 0.30) {
    return vec3f(0.0);
  }

  let bFw = min(dirFw, 0.008);
  let bEnergy = min(1.0, 0.012 / max(dirFw * 1.5, 1e-4));

  let diskCoord = vec2f(rel.x * 0.92 + rel.y * 0.39, (-rel.x * 0.39 + rel.y * 0.92) * 3.1);
  let rDisk = length(diskCoord);
  let d1 = (rDisk - 0.022) / max(0.0085, bFw * 1.4);
  let d2 = (rDisk - 0.036) / max(0.011, bFw * 1.6);
  let diskRing = exp(-(d1 * d1)) + 0.45 * exp(-(d2 * d2));
  let diskTint = mix(vec3f(1.00, 0.72, 0.24), vec3f(0.18, 0.88, 0.96), smoothstep(0.014, 0.042, rDisk));

  let primCore = exp(-(angDist * angDist) / max(0.000045 + bFw * bFw, 1e-6)) * 5.2;
  let primHalo = exp(-angDist * 26.0) * 0.55;

  let compOffset = vec2f(0.032, 0.014);
  let compDist = length(rel - compOffset);
  let compCore = exp(-(compDist * compDist) / max(0.000028 + bFw * bFw, 1e-6)) * 3.6;
  let compHalo = exp(-compDist * 34.0) * 0.38;

  let col = diskTint * (diskRing * 1.45)
          + vec3f(1.00, 0.86, 0.54) * (primCore + primHalo)
          + vec3f(0.32, 0.94, 1.00) * (compCore + compHalo);
  return col * (front * bEnergy);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_camL.x, -u.jitter_fov_camL.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = select(
    tan(clamp(u.jitter_fov_camL.z, 0.1, 2.8) * 0.5),
    u.camN0_tanHalfFov.w,
    u.camN0_tanHalfFov.w > 1e-4
  );
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let camBasis = mat3x3f(
    u.camRight_rho.xyz,
    u.camUp_throatLen.xyz,
    u.camForward_lensingW.xyz
  );
  let d = normalize(camBasis * localRay);

  let n0 = normalize(u.camN0_tanHalfFov.xyz);
  let camL = u.jitter_fov_camL.w;
  let metricType = u.modes.y;
  let rho = max(u.camRight_rho.w, 0.05);
  let a   = max(u.camUp_throatLen.w, 0.0);
  let M   = max(u.camForward_lensingW.w, 1e-4);

  let r0 = select(
    evalMetricR(camL, metricType, rho, a, M),
    u.rotBy_camR_escapeL_pad.y,
    u.rotBy_camR_escapeL_pad.y > 1e-4
  );
  var pl = dot(d, n0);
  let t = d - pl * n0;
  let sinAlpha = length(t);
  let tHat = t / max(sinAlpha, 1e-7);
  let b = r0 * sinAlpha;
  let b2 = b * b;

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(u.modes.x & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  let quality = u.modes.z;
  var maxSteps : i32 = 220;
  var qualScale : f32 = 0.92;
  if (quality <= 0) {
    maxSteps = 140;
    qualScale = 1.25;
  } else if (quality >= 2) {
    maxSteps = 320;
    qualScale = 0.68;
  }

  let escapeL = max(
    u.rotBy_camR_escapeL_pad.z,
    max(abs(camL) * 3.0 + 40.0, a + 4.0 * max(M, 0.35) + 80.0)
  );
  let matterBound = a + 2.8 * max(M, 0.35);
  let hasMatter = (u.matter_skyParams.x > 0.001 || u.matter_skyParams.y > 0.001);

  var l = camL;
  var psi : f32 = 0.0;
  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;
  var escaped = false;

  for (var step: i32 = 0; step < 320; step++) {
    if (step >= maxSteps) { break; }

    let k1 = evalGeodesicRHS(l, pl, b, b2, metricType, rho, a, M);
    let r = k1.r;
    let absL = abs(l);

    if (absL >= escapeL - 1e-3 && (l * pl) > 0.0) {
      escaped = true;
      break;
    }

    let distEdge = absL - a;
    let curvScale = select(rho, max(M, 0.35), metricType == 0);
    var h: f32;

    if (metricType == 0 && absL <= a) {
      let wallDist = select(l + a, a - l, pl > 0.0);
      h = max(0.08, min(0.50 * rho * qualScale, wallDist + 0.05));
      if (abs(pl) < 0.08) {
        h = min(h, 0.42 * rho);
      }
    } else {
      h = (0.14 * r + 0.08 * curvScale) * qualScale;
      if (distEdge < 2.5 * curvScale) {
        h = min(h, (0.06 * rho + 0.09 * max(distEdge, 0.0) + 0.04 * curvScale) * qualScale);
      }
      if ((l * pl) > 0.0 && r > 2.5 * rho && distEdge > 2.5 * curvScale) {
        h = max(h, 0.30 * r * qualScale);
      }
      h = clamp(h, 0.03 * qualScale, 18.0);
      if ((l * pl) > 0.0 && abs(pl) > 1e-4) {
        let remL = escapeL - absL;
        if (remL > 0.0 && abs(pl) * h > remL) {
          h = remL / abs(pl);
        }
      }
    }

    if (step == 0 && hasMatter && absL < matterBound) {
      h *= (0.55 + 0.45 * bn.x);
    }

    let k2 = evalGeodesicRHS(l + 0.5 * h * k1.dl, pl + 0.5 * h * k1.dpl, b, b2, metricType, rho, a, M);
    let k3 = evalGeodesicRHS(l + 0.5 * h * k2.dl, pl + 0.5 * h * k2.dpl, b, b2, metricType, rho, a, M);
    let k4 = evalGeodesicRHS(l + h * k3.dl,       pl + h * k3.dpl,       b, b2, metricType, rho, a, M);

    let lNext   = l   + (h / 6.0) * (k1.dl   + 2.0 * k2.dl   + 2.0 * k3.dl   + k4.dl);
    let plNext  = pl  + (h / 6.0) * (k1.dpl  + 2.0 * k2.dpl  + 2.0 * k3.dpl  + k4.dpl);
    let psiNext = psi + (h / 6.0) * (k1.dpsi + 2.0 * k2.dpsi + 2.0 * k3.dpsi + k4.dpsi);

    if (hasMatter && transmittance > 0.004) {
      let segMinL = min(l, lNext);
      let segMaxL = max(l, lNext);
      if (segMinL < matterBound && segMaxL > -matterBound) {
        let nSub : i32 = select(1, 2, h > 0.45);
        let rMidSeg = max(0.5 * (r + evalMetricR(lNext, metricType, rho, a, M)), rho);
        let totalDs = length(vec2f(lNext - l, rMidSeg * (psiNext - psi)));
        let dsSub = totalDs / f32(nSub);
        let jitBase = fract(bn.y + f32(step) * 0.61803399);

        for (var s: i32 = 0; s < 2; s++) {
          if (s >= nSub) { break; }
          let frac = (f32(s) + jitBase) / f32(nSub);
          let lSub = mix(l, lNext, frac);
          let plSub = mix(pl, plNext, frac);
          let psiSub = mix(psi, psiNext, frac);
          let nSubVec = normalize(cos(psiSub) * n0 + sin(psiSub) * tHat);

          let ms = evalThroatMatter(lSub, plSub, nSubVec, a, M, matterBound);
          if (ms.extinction > 1e-6 || dot(ms.emission, ms.emission) > 1e-10) {
            let tau = ms.extinction * dsSub;
            let stepT = exp(-tau);
            let stepRad = select(
              ms.emission * dsSub,
              ms.emission * ((1.0 - stepT) / max(ms.extinction, 1e-5)),
              tau > 1e-4
            );
            radiance += transmittance * stepRad;
            transmittance *= stepT;
          }
        }
      }
    }

    l = lNext;
    pl = plNext;
    psi = psiNext;

    if (transmittance < 0.004) {
      break;
    }
  }

  if (!escaped && abs(l) >= escapeL - 1e-2 && (l * pl) > 0.0) {
    escaped = true;
  }

  let usePropSign = abs(l) <= a && abs(pl) > 1e-4;
  let finalSideSign = select(
    select(-1.0, 1.0, l >= 0.0),
    select(-1.0, 1.0, pl >= 0.0),
    usePropSign
  );
  let onSideA = (finalSideSign > 0.0);

  var psiFinal = psi;
  if ((l * pl) > 0.0) {
    let rEnd = evalMetricR(l, metricType, rho, a, M);
    psiFinal += atan2(b / max(rEnd, 1e-5), abs(pl));
  }
  let nPsi = cos(psiFinal) * n0 + sin(psiFinal) * tHat;
  let dSkyRaw = select(nPsi - 2.0 * dot(nPsi, n0) * n0, nPsi, onSideA);
  let dSky = normalize(dSkyRaw);

  let trigA = select(
    vec4f(cos(u.skyB_rotA_rotBx.y), sin(u.skyB_rotA_rotBx.y), cos(u.skyB_rotA_rotBx.z), sin(u.skyB_rotA_rotBx.z)),
    u.skyTrigA,
    dot(u.skyTrigA, u.skyTrigA) > 0.5
  );
  let trigB = select(
    vec4f(cos(u.skyB_rotA_rotBx.w), sin(u.skyB_rotA_rotBx.w), cos(u.rotBy_camR_escapeL_pad.x), sin(u.rotBy_camR_escapeL_pad.x)),
    u.skyTrigB,
    dot(u.skyTrigB, u.skyTrigB) > 0.5
  );

  let dirA = normalize(rotateSkyDirTrig(dSky, trigA));
  let dirB = normalize(rotateSkyDirTrig(dSky, trigB));

  // Uniform control flow equirectangular gradients & silhouette edge detection
  let uA1 = atan2(dirA.z, dirA.x) * INV_TAU + 0.5;
  let vA  = acos(clamp(dirA.y, -1.0, 1.0)) * INV_PI;
  let uvA1 = vec2f(uA1, vA);
  let uvA2 = vec2f(fract(uA1 + 0.5), vA);

  let dxA1 = dpdx(uvA1);
  let dyA1 = dpdy(uvA1);
  let dxA2 = dpdx(uvA2);
  let dyA2 = dpdy(uvA2);
  var dUVdxA = vec2f(select(dxA2.x, dxA1.x, abs(dxA1.x) < abs(dxA2.x)), dxA1.y);
  var dUVdyA = vec2f(select(dyA2.x, dyA1.x, abs(dyA1.x) < abs(dyA2.x)), dyA1.y);

  let uB1 = atan2(dirB.z, dirB.x) * INV_TAU + 0.5;
  let vB  = acos(clamp(dirB.y, -1.0, 1.0)) * INV_PI;
  let uvB1 = vec2f(uB1, vB);
  let uvB2 = vec2f(fract(uB1 + 0.5), vB);

  let dxB1 = dpdx(uvB1);
  let dyB1 = dpdy(uvB1);
  let dxB2 = dpdx(uvB2);
  let dyB2 = dpdy(uvB2);
  var dUVdxB = vec2f(select(dxB2.x, dxB1.x, abs(dxB1.x) < abs(dxB2.x)), dxB1.y);
  var dUVdyB = vec2f(select(dyB2.x, dyB1.x, abs(dyB1.x) < abs(dyB2.x)), dyB1.y);

  let sideFlag = select(0.0, 1.0, onSideA);
  let edgeMask = fwidth(sideFlag) + select(1.0, 0.0, escaped);
  var dirFwA = length(fwidth(dirA));
  var dirFwB = length(fwidth(dirB));

  if (edgeMask > 0.01) {
    dUVdxA = vec2f(0.004, 0.0);
    dUVdyA = vec2f(0.0, 0.004);
    dUVdxB = vec2f(0.004, 0.0);
    dUVdyB = vec2f(0.0, 0.004);
    dirFwA = 0.025;
    dirFwB = 0.025;
  } else {
    dUVdxA = clamp(dUVdxA, vec2f(-0.045), vec2f(0.045));
    dUVdyA = clamp(dUVdyA, vec2f(-0.045), vec2f(0.045));
    dUVdxB = clamp(dUVdxB, vec2f(-0.045), vec2f(0.045));
    dUVdyB = clamp(dUVdyB, vec2f(-0.045), vec2f(0.045));
  }

  let sampleUvA = vec2f(uvA1.x, clamp(uvA1.y, 0.005, 0.995));
  let sampleUvB = vec2f(uvB1.x, clamp(uvB1.y, 0.005, 0.995));

  let texA     = textureSampleGrad(uSkyMapA, sSky, sampleUvA, dUVdxA, dUVdyA).rgb;
  let procTexA = textureSampleGrad(uProcSkyMapA, sSky, sampleUvA, dUVdxA, dUVdyA).rgb;
  let texB     = textureSampleGrad(uSkyMapB, sSky, sampleUvB, dUVdxB, dUVdyB).rgb;

  let planetVisible = (u.modes.w == 1);
  var skyColor = vec3f(0.0);

  if (onSideA) {
    let srgbA = mix(texA, procTexA, 0.015);
    var skyLinA = pow(max(srgbA, vec3f(0.0)), vec3f(2.2));
    let coresA = max(skyLinA - vec3f(0.32), vec3f(0.0));
    skyLinA += coresA * coresA * 2.4;
    skyLinA += evalMicroStarLayer(dirA, 110.0, 0.915, 0.55, dirFwA, false)
             + evalMicroStarLayer(dirA, 230.0, 0.885, 0.26, dirFwA, false);
    skyLinA *= max(u.matter_skyParams.w, 0.0);

    if (planetVisible) {
      let lmA = evalUniverseALandmarks(dirA, dirFwA);
      skyLinA = skyLinA * lmA.occ + lmA.color;
    }
    skyColor = skyLinA;
  } else {
    var skyLinB = pow(max(texB, vec3f(0.0)), vec3f(2.2));
    let coresB = max(skyLinB - vec3f(0.28), vec3f(0.0));
    skyLinB += coresB * coresB * 2.2;
    skyLinB += evalMicroStarLayer(dirB, 102.0, 0.900, 0.82, dirFwB, true)
             + evalMicroStarLayer(dirB, 215.0, 0.870, 0.44, dirFwB, true);
    skyLinB *= max(u.skyB_rotA_rotBx.x, 0.0);

    if (planetVisible) {
      skyLinB += evalUniverseBLandmark(dirB, dirFwB);
    }
    skyColor = skyLinB;
  }

  radiance += transmittance * skyColor;
  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));

  return vec4f(radiance, 1.0);
}
`;
