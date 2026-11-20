/**
 * Cinema-grade WebGL2 GLSL 300 es relativistic binary black hole shader for
 * "Binary Black Hole Inspiral & Gravitational Wave Lensing Simulator".
 *
 * Physics & Optical Architecture:
 *  - Exact 3D Brill-Lindquist two-black-hole optical metric n(x) = (1+Phi)^3 / (1-Phi)
 *    with analytical gradient grad(ln n) = ((4 - 2*Phi_c)/(1 - Phi_c^2)) * gradPhi,
 *    producing twin horizons, common merger neck, and fractal self-similar eyebrow shadows.
 *  - 1PN gravitomagnetic orbital frame-dragging a_GM = (lensing/n) * (v x B_g).
 *  - Pole-free Cartesian Transverse-Traceless (TT) retarded quadrupole gravitational wave
 *    shear field + Integrated Sachs-Wolfe (ISW) sky modulation in the wave zone.
 *  - Adaptive mass-ratio-safe RK4/RK2 geodesic integration with blue-noise stratified
 *    sub-stepped 3D volumetric transfer sampling the 256x256 co-rotating tidal field
 *    (circumbinary disk, spiral shocks, S-shaped tidal gas bridges, twin mini-disks)
 *    combined with 128^3 periodic 3D MHD noise and CIE-1931 Planck blackbody LUT.
 */

export const BINARY_BH_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Textures (locked unit bindings 0..5)
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8 (fbm, ridged, worley, micro)
uniform sampler2D uSkyMap;        // unit 1: 4K equirectangular Milky Way (sRGB RGBA8)
uniform sampler2D uProcSkyMap;    // unit 2: Procedural equirectangular sky (sRGB RGBA8)
uniform sampler2D uBlackbodyLut;  // unit 3: 512x1 linear CIE-1931 Planck LUT (800K..40000K log)
uniform sampler2D uBlueNoise;     // unit 4: 128x128 RGBA8 void-and-cluster blue noise
uniform sampler2D uTidalField;    // unit 5: 256x256 RGBA16F co-rotating tidal field

// Viewport & temporal state
uniform vec2  uResolution;
uniform float uTime;
uniform int   uFrameIndex;
uniform vec2  uJitter;

// Camera (COM Cartesian coords, M=1, orbital angular momentum=+Y, disk=X-Z plane)
uniform vec3  uCamPos;
uniform mat3  uCamBasis;          // col0=right, col1=up, col2=forward
uniform float uFovY;

// Binary black hole parameters
uniform float uMass1;
uniform float uMass2;
uniform float uSeparation;
uniform float uEta;
uniform float uPhase;
uniform float uOmega;
uniform float uGwWaveOmega;
uniform vec3  uBh1Pos;
uniform vec3  uBh2Pos;
uniform vec3  uBh1Vel;
uniform vec3  uBh2Vel;

// Relativistic physics & GW parameters
uniform float uGwAmplitude;
uniform float uLensingStrength;
uniform float uRelativisticMode;

// Accretion & tidal field parameters
uniform float uDiskTemp;
uniform float uDiskDensity;
uniform float uBridgeIntensity;
uniform float uDiskThickness;
uniform float uDiskOuterRadius;
uniform float uTurbulence;
uniform float uFieldHalfSize;
uniform float uRCavity;
uniform float uRingdown;

// Background sky & quality
uniform float uSkyIntensity;
uniform int   uSkyMode;
uniform vec2  uSkyRotation;
uniform int   uQuality;

const float PI       = 3.14159265359;
const float TAU      = 6.28318530718;
const float INV_PI   = 0.31830988618;
const float INV_TAU  = 0.15915494309;
const float T_MIN    = 800.0;
const float T_MAX    = 40000.0;
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543;

// ============================================================================
// 1. BRILL-LINDQUIST BINARY METRIC, 1PN FRAME-DRAGGING & CARTESIAN TT GW
// ============================================================================

struct GwConsts {
  float r0;
  float invSpan;
  float A0;
  float twoPhase;
  float twoGwOmega;
  bool  hasGw;
};

struct FlowConsts {
  float blend;
  float dt0;
  float dt1;
  float globalRot;
};

struct GeodesicFull {
  vec3  dv;
  float phi;
  float r1;
  float r2;
};

vec2 rotOrbXZ(vec2 xz, float cosOrb, float sinOrb) {
  return vec2(
    xz.x * cosOrb - xz.y * sinOrb,
    xz.x * sinOrb + xz.y * cosOrb
  );
}

GeodesicFull evalGeodesicFull(vec3 pos, vec3 dir) {
  vec3 d1 = pos - uBh1Pos;
  vec3 d2 = pos - uBh2Pos;
  float r1Sq = max(dot(d1, d1), 1e-10);
  float r2Sq = max(dot(d2, d2), 1e-10);
  float invR1 = inversesqrt(r1Sq);
  float invR2 = inversesqrt(r2Sq);
  float r1 = r1Sq * invR1;
  float r2 = r2Sq * invR2;

  float phi1 = 0.5 * uMass1 * invR1;
  float phi2 = 0.5 * uMass2 * invR2;
  float phi = phi1 + phi2;

  float invR1_3 = invR1 * invR1 * invR1;
  float invR2_3 = invR2 * invR2 * invR2;
  float k1 = -0.5 * uMass1 * invR1_3;
  float k2 = -0.5 * uMass2 * invR2_3;
  vec3 gradPhi = k1 * d1 + k2 * d2;

  float phiC = min(phi, 0.95);
  float opPhi = 1.0 + phiC;
  float invN = min(max(1.0 - phiC, 0.05) / (opPhi * opPhi * opPhi), 1.0);
  float blFactor = uLensingStrength * ((4.0 - 2.0 * phiC) / max(1.0 - phiC * phiC, 0.05));
  vec3 gradTot = blFactor * gradPhi;

  vec3 dv = gradTot - dot(gradTot, dir) * dir;

  if (uLensingStrength > 1e-6) {
    vec3 Bg = 8.0 * (k1 * cross(d1, uBh1Vel) + k2 * cross(d2, uBh2Vel));
    dv += (uLensingStrength * invN) * cross(dir, Bg);
  }

  GeodesicFull outD;
  outD.dv = dv;
  outD.phi = phi;
  outD.r1 = r1;
  outD.r2 = r2;
  return outD;
}

vec3 evalGeodesicAccel(vec3 pos, vec3 dir) {
  return evalGeodesicFull(pos, dir).dv;
}

vec4 evalGwKick(vec3 pos, vec3 dir, GwConsts gwc) {
  float R2 = dot(pos, pos);
  float invR = inversesqrt(max(R2, 1e-10));
  float R = R2 * invR;
  if (R <= gwc.r0) {
    return vec4(0.0);
  }

  vec3 nHat = pos * invR;
  float t = clamp((R - gwc.r0) * gwc.invSpan, 0.0, 1.0);
  float ramp = t * t * (3.0 - 2.0 * t);
  float dRamp = (t > 0.0 && t < 1.0) ? (6.0 * t * (1.0 - t) * gwc.invSpan) : 0.0;

  float decayDen = 1.0 + 0.055 * R;
  float decay = exp(-R * 0.0105263158) / decayDen;
  float dDecay = -decay * (0.055 / decayDen + 0.0105263158);

  float A = gwc.A0 * ramp * decay;
  float dAdR = gwc.A0 * (dRamp * decay + ramp * dDecay);

  float twoPhiRet = gwc.twoPhase - gwc.twoGwOmega * R;
  float c = cos(twoPhiRet);
  float s = sin(twoPhiRet);

  vec3 vPerp = dir - dot(dir, nHat) * nHat;
  float vp2 = dot(vPerp, vPerp);
  float qv = vPerp.x * vPerp.x - vPerp.z * vPerp.z;
  float uv = 2.0 * vPerp.x * vPerp.z;
  float qn = nHat.x * nHat.x - nHat.z * nHat.z;
  float un = 2.0 * nHat.x * nHat.z;

  float C1 = qv + 0.5 * vp2 * qn;
  float C2 = uv + 0.5 * vp2 * un;
  float S = c * C1 + s * C2;
  float dSdPhi = s * C1 - c * C2;

  float radialCoeff = 0.5 * (gwc.twoGwOmega * A * dSdPhi + dAdR * S);
  vec3 aGw = radialCoeff * (nHat - dot(nHat, dir) * dir);
  float iswTerm = 0.9 * gwc.twoGwOmega * A * (-dSdPhi);
  return vec4(aGw, iswTerm);
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT
// ============================================================================

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float u = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureLod(uBlackbodyLut, vec2(u, 0.5), 0.0).rgb;
}

// ============================================================================
// 3. 3D VOLUMETRIC CIRCUMBINARY DISK, TIDAL BRIDGES & TWIN MINI-DISKS
// ============================================================================

float diskScaleHeight(float rCom, float d1, float d2, float rCav, float rOuter) {
  float dClosest = min(d1, d2);
  float hMini = 0.034 + 0.044 * dClosest;
  float rNorm = clamp((rCom - rCav) / max(rOuter - rCav, 1.0), 0.0, 1.0);
  float sr = sqrt(rNorm);
  float powApprox = mix(sr, sr * sqrt(sr), 0.88);
  float hCbd = 0.054 + 0.033 * rCom * (0.42 + 0.85 * powApprox);
  float inCbd = smoothstep(rCav * 0.70, rCav * 1.15, rCom);
  return mix(hMini, hCbd, inCbd) * max(uDiskThickness, 0.15);
}

vec4 sampleDiskNoise(vec2 posRotXZ, float rCom, float phiRot, float logR, float yNorm, float rCav, FlowConsts fc, bool lowDetail) {
  float phiU = phiRot * INV_TAU;
  float inCbd = smoothstep(rCav * 0.65, rCav * 1.15, rCom);

  float rm = max(rCom, 0.85);
  float omegaVis = 1.35 / (rm * sqrt(sqrt(rm)) + 0.35);

  float spiralU0 = phiU + 2.25 * logR - (omegaVis * fc.dt0 + fc.globalRot) * INV_TAU;
  float spiralU1 = phiU + 2.25 * logR - (omegaVis * fc.dt1 + fc.globalRot) * INV_TAU;
  float radV0    = logR * 1.12 + fc.dt0 * 0.010;
  float radV1    = logR * 1.12 + fc.dt1 * 0.010;
  float zCoord   = yNorm * 0.28 + 0.5;

  vec4 n0 = textureLod(uVolumeNoise, vec3(spiralU0, radV0, zCoord), 0.0);
  vec4 n1 = textureLod(uVolumeNoise, vec3(spiralU1, radV1, zCoord), 0.0);
  vec4 cbdNoise = mix(n1, n0, fc.blend);

  if (lowDetail) {
    return cbdNoise;
  }

  float mhdWarpU = (cbdNoise.r - 0.5) * 0.09 + (cbdNoise.b - 0.5) * 0.05;
  float mhdWarpV = (cbdNoise.r - 0.5) * 0.34 + (cbdNoise.g - 0.5) * 0.16;
  float fineU = 2.0 * phiU + 4.65 * logR - (fc.globalRot * 2.2) * INV_TAU + mhdWarpU;
  float fineV = logR * 3.05 + mhdWarpV;

  vec4 detail = textureLod(uVolumeNoise, vec3(fineU, fineV, yNorm * 0.52 + 0.25), 0.0);

  vec4 cbdCombined = vec4(
    mix(cbdNoise.r, detail.r, 0.42),
    mix(cbdNoise.g, detail.g, 0.56),
    mix(cbdNoise.b, detail.b, 0.44),
    mix(cbdNoise.a, detail.a, 0.70)
  );

  if (inCbd >= 0.999) {
    return cbdCombined;
  }

  vec3 innerUvw = vec3(posRotXZ * (0.28 + 0.12 * (1.0 - inCbd)) - vec2(uTime * 0.04, 0.0), yNorm * 0.32 + 0.5);
  vec4 innerNoise = textureLod(uVolumeNoise, innerUvw, 0.0);
  return mix(innerNoise, cbdCombined, mix(0.35, 1.0, inCbd));
}

void evalDiskVolume(
  float posY,
  vec2 posRotXZ,
  vec3 dir,
  float phiPot,
  float cosOrb,
  float sinOrb,
  float camDistFade,
  float invFieldSpan,
  FlowConsts fc,
  bool lowDetail,
  out vec3 emission,
  out float extinction
) {
  emission = vec3(0.0);
  extinction = 0.0;

  if (phiPot >= 0.88) return;

  vec2 uvTidal = posRotXZ * invFieldSpan + 0.5;
  if (uvTidal.x <= 0.002 || uvTidal.x >= 0.998 || uvTidal.y <= 0.002 || uvTidal.y >= 0.998) {
    return;
  }

  vec4 tidal = textureLod(uTidalField, uvTidal, 0.0);
  float sigma = tidal.r;
  if (sigma < 1e-4) return;

  float rCom = length(posRotXZ);
  float d1XZ = length(posRotXZ - vec2(-uMass2 * uSeparation, 0.0));
  float d2XZ = length(posRotXZ - vec2(uMass1 * uSeparation, 0.0));
  float rOuter = max(uDiskOuterRadius, uRCavity + 4.0);

  float H = diskScaleHeight(rCom, d1XZ, d2XZ, uRCavity, rOuter);
  float absY = abs(posY);
  if (absY > H * 2.65) return;

  float yNorm = posY / max(H, 1e-4);
  float absYNorm = abs(yNorm);
  float logR = log(max(rCom, 0.55));
  float phiRot = atan(posRotXZ.y, posRotXZ.x);
  vec4 n = sampleDiskNoise(posRotXZ, rCom, phiRot, logR, yNorm, uRCavity, fc, lowDetail || absYNorm > 1.18);
  float turb = clamp(uTurbulence, 0.0, 2.2);

  float warpY = (n.r - 0.5) * 0.28 * turb;
  float yShifted = abs(yNorm + warpY);
  float ySq = yShifted * yShifted;
  float vertCore = exp(-ySq * 2.75);
  float vertMid  = exp(-ySq * 5.40);
  float slabWindow = smoothstep(2.65, 1.90, absYNorm);
  float vertSheath = 0.22 * exp(-absYNorm * 1.65) * slabWindow;

  float ngc = clamp(n.g, 0.0, 1.0);
  float ridgeSharp = ngc * sqrt(ngc);
  float nac = clamp(n.a, 0.0, 1.0);
  float microSharp = nac * mix(1.0, sqrt(nac), 0.70);
  float ht = clamp(ridgeSharp * 0.62 + microSharp * 0.52, 0.0, 1.0);
  float hotThread = ht * ht * sqrt(ht);

  float inCbd = smoothstep(uRCavity * 0.75, uRCavity * 1.15, rCom);
  float laneBlend = 0.68 + 0.42 * ridgeSharp;
  float lbPow = 0.0;
  if (inCbd > 0.001) {
    float rWarp = logR + (n.r - 0.5) * 0.22 * turb + (n.b - 0.5) * 0.11 * turb;
    float laneBroad = max(0.5 + 0.5 * sin(rWarp * 17.5 + 0.68 * sin(phiRot + logR * 3.2 + n.r * 2.4)), 0.0);
    float laneFine  = max(0.5 + 0.5 * sin(rWarp * 42.0 - 0.58 * cos(2.0 * phiRot - logR * 4.8 + n.b * 2.8)), 0.0);
    lbPow = laneBroad * sqrt(laneBroad);
    float concentricLanes = mix(0.62 + 0.38 * laneBroad, 0.34 + 0.36 * lbPow + 0.38 * (laneFine * laneFine), 0.72);
    float mriFilaments = mix(0.72, 0.22 + 1.12 * ridgeSharp + 0.58 * microSharp + 0.80 * hotThread, clamp(turb, 0.0, 1.65));
    float eddyBoost = mix(1.0, 0.68 + 0.76 * n.b, clamp(turb * 0.80, 0.0, 1.2));
    laneBlend = mix(laneBlend, concentricLanes * mriFilaments * eddyBoost, inCbd);
  }

  float riftMask = smoothstep(0.22, 0.74, n.r * 0.50 + n.g * 0.35 + n.b * 0.15);
  float structureContrast = mix(1.0, mix(0.28, 1.46, riftMask), clamp(turb * 0.80, 0.0, 1.0));

  float localDensity = sigma * (vertCore * laneBlend * structureContrast * slabWindow + vertSheath * (0.40 + 0.60 * ridgeSharp)) * camDistFade;
  if (localDensity < 1e-5) return;

  vec2 vRot = tidal.ba;
  vec3 vEmit = vec3(
    vRot.x * cosOrb + vRot.y * sinOrb,
    0.0,
    -vRot.x * sinOrb + vRot.y * cosOrb
  );
  float v2 = dot(vEmit, vEmit);
  if (v2 > 0.52) {
    vEmit *= sqrt(0.52 / v2);
    v2 = 0.52;
  }
  float gammaEmit = inversesqrt(max(1.0 - v2, 0.25));
  float alphaEmit = clamp((1.0 - phiPot) / max(1.0 + phiPot, 1.0), 0.06, 1.0);
  float gShift = clamp(alphaEmit / max(gammaEmit * (1.0 + dot(vEmit, dir)), 0.12), 0.08, 3.4);

  float rel = clamp(uRelativisticMode, 0.0, 1.0);
  float gColor  = mix(mix(1.0, gShift, 0.28), gShift, rel);
  float gBeam   = mix(mix(1.0, gShift, 0.36), gShift, rel);
  float beamExp = mix(1.75, 3.20, rel);
  float beaming = pow(clamp(gBeam, 0.12, 2.75), beamExp);
  beaming = beaming / (1.0 + beaming * mix(0.055, 0.16, rel));

  float tempBoost = max(tidal.g, 0.8);
  float tempRadial = 1.0;
  if (inCbd > 0.001) {
    float rPeak = max(uRCavity * 1.15, 2.8);
    float rRatio = max(rCom / rPeak, 0.58);
    tempRadial = mix(1.0, pow(rRatio, -mix(0.38, 0.50, rel)), inCbd);
  }
  float filamentHeat = clamp(ridgeSharp * 0.45 + microSharp * 0.25 + hotThread * 0.42, 0.0, 1.0);
  float T_local = uDiskTemp * tempBoost * tempRadial * mix(0.76, 1.32, filamentHeat) * (1.0 + 0.18 * uRingdown);

  float T_obs = clamp(T_local * gColor, T_MIN, T_MAX);
  vec3 bbColor = sampleBlackbody(T_obs);

  float thermalPower = pow(clamp(T_local / 4900.0, 0.15, 4.0), 1.85);
  float heightComp = 1.0 / pow(max(H * 2.8, 0.28), 0.36);

  float emitStrength = localDensity * thermalPower * beaming * heightComp * 1.18;
  emission = bbColor * emitStrength;

  float dustZone = smoothstep(uRCavity * 0.92, uRCavity * 1.45, rCom);
  float coolDustExt = 0.0;
  if (dustZone > 0.001 && vertMid > 1e-4) {
    float dvRaw = smoothstep(0.30, 0.86, 1.0 - ridgeSharp * 0.72 + (n.r - 0.5) * 0.72);
    float dustVeins = dvRaw * mix(1.0, sqrt(dvRaw), 0.65);
    float dustLane = 0.32 + 0.68 * (1.0 - lbPow);
    coolDustExt = sigma * vertMid * dustZone * (0.38 + 1.75 * dustVeins * dustLane);
  }
  float plasmaSelfExt = sigma * vertCore * (0.14 + 0.22 * n.r);

  extinction = (coolDustExt * 1.35 + plasmaSelfExt * 0.36) * heightComp * camDistFade * slabWindow;
}

// ============================================================================
// 4. SEAMLESS 4K MILKY WAY LENSING + CRISP 3D MICRO-STARS + GW ISW MODULATION
// ============================================================================

vec3 rotateSkyDir(vec3 d, vec2 rot) {
  float cy = cos(rot.x), sy = sin(rot.x);
  vec3 r1 = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  float cp = cos(rot.y), sp = sin(rot.y);
  return vec3(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

vec3 hash33f(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 evalMicroStarLayer(vec3 dir, float scale, float densityThresh, float boost, float pixelFw) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);

  if (rnd.x < densityThresh) return vec3(0.0);

  vec3 starPos = cell + vec3(0.22) + 0.56 * hash33f(cell + vec3(19.17, 73.41, 41.83));
  float dist = length(p - starPos);

  float magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  float mag2 = magU * magU;
  float mag = mag2 * mag2 * sqrt(magU);

  float fw = clamp(pixelFw * scale, 0.018, 0.14);
  float starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  float core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) return vec3(0.0);

  float energyComp = 1.0 / (1.0 + fw * 6.0);
  float ry = max(rnd.y, 0.0);
  float specT = mix(3000.0, 22000.0, ry * ry);
  vec3 col = sampleBlackbody(specT);

  float lum = (0.08 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

vec3 sampleSkyBackground(vec3 rawDir, bool escaped, float edgeMask, float deltaISW) {
  vec3 dir = normalize(rotateSkyDir(rawDir, uSkyRotation));

  // Wrap-safe & pole-safe equirectangular coordinates (computed in uniform control flow!)
  float u1 = atan(dir.z, dir.x) * INV_TAU + 0.5;
  float v  = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  vec2 uv1 = vec2(u1, v);
  vec2 uv2 = vec2(fract(u1 + 0.5), v);

  vec2 dx1 = dFdx(uv1);
  vec2 dy1 = dFdy(uv1);
  vec2 dx2 = dFdx(uv2);
  vec2 dy2 = dFdy(uv2);

  vec2 dUVdx = vec2(abs(dx1.x) < abs(dx2.x) ? dx1.x : dx2.x, dx1.y);
  vec2 dUVdy = vec2(abs(dy1.x) < abs(dy2.x) ? dy1.x : dy2.x, dy1.y);

  if (edgeMask > 0.01) {
    dUVdx = vec2(1.0 / 4096.0, 0.0);
    dUVdy = vec2(0.0, 1.0 / 2048.0);
  } else {
    dUVdx = clamp(dUVdx, vec2(-0.045), vec2(0.045));
    dUVdy = clamp(dUVdy, vec2(-0.045), vec2(0.045));
  }

  float dirFw = length(fwidth(dir));
  if (edgeMask > 0.01) dirFw = 0.0012;

  if (!escaped) return vec3(0.0);

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));
  vec3 mapSrgb = (uSkyMode == 2)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(0.0)), vec3(2.2));

  vec3 brightCores = max(skyLin - vec3(0.32), vec3(0.0));
  skyLin += brightCores * brightCores * 2.4;

  if (uSkyMode == 0 || uSkyMode == 2) {
    float starGain = (uSkyMode == 0) ? 0.55 : 0.95;
    vec3 microStars = evalMicroStarLayer(dir, 105.0, 0.915, 0.95 * starGain, dirFw)
                    + evalMicroStarLayer(dir, 225.0, 0.885, 0.42 * starGain, dirFw);
    skyLin += microStars;
  }

  float iswFactor = 1.0 + clamp(deltaISW, -0.25, 0.25);
  return skyLin * max(uSkyIntensity, 0.0) * (iswFactor * iswFactor);
}

// ============================================================================
// 5. MAIN ADAPTIVE RK4/RK3 BINARY GEODESIC RAY-MARCHER
// ============================================================================

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + uJitter;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(uFovY, 0.1, 2.8) * 0.5);
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  vec3 pos = uCamPos;
  vec3 dir = normalize(uCamBasis * localRay);

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(uFrameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int maxSteps = 260;
  float qualScale = 0.94;
  if (uQuality <= 0) {
    maxSteps = 175;
    qualScale = 1.24;
  } else if (uQuality >= 2) {
    maxSteps = 400;
    qualScale = 0.64;
  }

  float rOuter = max(uDiskOuterRadius, uRCavity + 4.0);
  float invFieldSpan = 1.0 / (2.0 * max(uFieldHalfSize, 1.0));
  float camR = length(uCamPos);
  float escapeR = max(max(rOuter * 1.85, camR * 1.65), 62.0);
  float rH1 = 0.5 * uMass1;
  float rH2 = 0.5 * uMass2;
  float maxDiskSlabY = (0.054 + 0.033 * rOuter * 1.30) * max(uDiskThickness, 0.15) * 2.75;

  bool hasDisk = (uDiskDensity > 0.001 || uBridgeIntensity > 0.001);
  bool hasGw   = (abs(uGwAmplitude) > 0.01 && uEta > 1e-6);
  float gwBaseStep = hasGw ? (PI / (5.2 * max(uGwWaveOmega, 0.05))) : 100.0;
  bool lowDetailBase = (uQuality <= 0);

  float r0Gw = 0.8 * uSeparation;
  float r1Gw = 2.2 * uSeparation;
  GwConsts gwc;
  gwc.r0 = r0Gw;
  gwc.invSpan = 1.0 / max(r1Gw - r0Gw, 1e-5);
  gwc.A0 = uGwAmplitude * (4.0 * uEta) * 0.035;
  gwc.twoPhase = 2.0 * uPhase;
  gwc.twoGwOmega = 2.0 * uGwWaveOmega;
  gwc.hasGw = hasGw;

  const float FLOW_CYCLE = 15.0;
  float tNorm0 = uTime / FLOW_CYCLE;
  float phase0 = fract(tNorm0);
  float phase1 = fract(tNorm0 + 0.5);
  FlowConsts fc;
  fc.blend = 0.5 - 0.5 * cos(TAU * phase0);
  fc.dt0 = (phase0 - 0.5) * FLOW_CYCLE;
  fc.dt1 = (phase1 - 0.5) * FLOW_CYCLE;
  fc.globalRot = uTime * 0.038;

  float cosOrb = cos(uPhase);
  float sinOrb = sin(uPhase);

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float rayDist = 0.0;
  float deltaISW = 0.0;
  bool captured = false;
  bool escaped = false;

  for (int step = 0; step < 400; ++step) {
    if (step >= maxSteps) break;

    GeodesicFull k1 = evalGeodesicFull(pos, dir);
    if (k1.phi >= 0.92) {
      captured = true;
      break;
    }

    float rCom = length(pos);
    bool outbound = (dot(pos, dir) > 0.0);
    if (rCom > escapeR && outbound) {
      escaped = true;
      break;
    }

    float clear1 = (uMass1 > 0.0) ? (k1.r1 - 0.82 * rH1) : 1e6;
    float clear2 = (uMass2 > 0.0) ? (k1.r2 - 0.82 * rH2) : 1e6;
    float minClear = min(clear1, clear2);
    float minMassR = min((uMass1 > 0.0) ? k1.r1 : 1e6, (uMass2 > 0.0) ? k1.r2 : 1e6);
    float minH = max(0.0012, 0.055 * minMassR) * qualScale;
    bool farOut = outbound && rCom > max(rOuter * 1.15, uSeparation * 2.5) && k1.phi < 0.02;
    float h = clamp((farOut ? 0.36 : 0.15) * max(minClear, 0.005) * qualScale, minH, farOut ? 13.0 : 5.2);

    if (hasGw) {
      float gwLim = gwBaseStep * (1.0 + 0.022 * max(rCom - 2.4 * uSeparation, 0.0));
      h = min(h, gwLim);
    }

    if (hasDisk && rCom < rOuter * 1.15 && abs(pos.y) < maxDiskSlabY * 1.15) {
      float localH = diskScaleHeight(rCom, length(pos.xz - uBh1Pos.xz), length(pos.xz - uBh2Pos.xz), uRCavity, rOuter);
      float absY = abs(pos.y);
      if (absY < localH * 2.90) {
        bool skipCavRefine = false;
        if (rCom < uRCavity * 0.80) {
          vec2 uv0 = rotOrbXZ(pos.xz, cosOrb, sinOrb) * invFieldSpan + 0.5;
          vec2 uv1 = rotOrbXZ(pos.xz + dir.xz * min(h, 1.2), cosOrb, sinOrb) * invFieldSpan + 0.5;
          float sig0 = textureLod(uTidalField, clamp(uv0, vec2(0.002), vec2(0.998)), 0.0).r;
          float sig1 = textureLod(uTidalField, clamp(uv1, vec2(0.002), vec2(0.998)), 0.0).r;
          if (max(sig0, sig1) < 1e-4) {
            h = min(h, 0.85 * qualScale);
            skipCavRefine = true;
          }
        }
        if (!skipCavRefine) {
          float anisoScale = (rCom > uRCavity * 0.85) ? min(1.0 / max(abs(dir.y), 0.36), 2.15) : 1.0;
          float diskHStep = max(localH * 1.05 * anisoScale, 0.048) * qualScale;
          float prox = smoothstep(localH * 2.90, localH * 1.05, absY);
          h = min(h, mix(h, diskHStep, prox));
        }
      }
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    vec3 posNext;
    vec3 dirNext;

    bool strongField = (k1.phi > 0.036) || (k1.r1 < 6.0 * max(uMass1, 0.01)) || (k1.r2 < 6.0 * max(uMass2, 0.01));
    bool veryWeak = (k1.phi < 0.016) && !strongField;
    if (strongField) {
      vec3 p2 = pos + (0.5 * h) * dir;
      vec3 v2 = normalize(dir + (0.5 * h) * k1.dv);
      vec3 a2 = evalGeodesicAccel(p2, v2);

      vec3 p3 = pos + (0.5 * h) * v2;
      vec3 v3 = normalize(dir + (0.5 * h) * a2);
      vec3 a3 = evalGeodesicAccel(p3, v3);

      vec3 p4 = pos + h * v3;
      vec3 v4 = normalize(dir + h * a3);
      vec3 a4 = evalGeodesicAccel(p4, v4);

      posNext = pos + (h / 6.0) * (dir + 2.0 * v2 + 2.0 * v3 + v4);
      dirNext = normalize(dir + (h / 6.0) * (k1.dv + 2.0 * a2 + 2.0 * a3 + a4));
    } else if (veryWeak) {
      vec3 p2 = pos + (0.5 * h) * dir;
      vec3 v2 = normalize(dir + (0.5 * h) * k1.dv);
      vec3 a2 = evalGeodesicAccel(p2, v2);

      posNext = pos + h * v2;
      dirNext = normalize(dir + h * a2);
    } else {
      vec3 p2 = pos + (0.5 * h) * dir;
      vec3 v2 = normalize(dir + (0.5 * h) * k1.dv);
      vec3 a2 = evalGeodesicAccel(p2, v2);

      vec3 p3 = pos + (0.75 * h) * v2;
      vec3 v3 = normalize(dir + (0.75 * h) * a2);
      vec3 a3 = evalGeodesicAccel(p3, v3);

      posNext = pos + (h / 9.0) * (2.0 * dir + 3.0 * v2 + 4.0 * v3);
      dirNext = normalize(dir + (h / 9.0) * (2.0 * k1.dv + 3.0 * a2 + 4.0 * a3));
    }

    float iswMid = 0.0;
    if (hasGw) {
      vec3 midPosGw = 0.5 * (pos + posNext);
      vec3 midDirGw = normalize(dir + dirNext);
      vec4 gwKick = evalGwKick(midPosGw, midDirGw, gwc);
      posNext += (0.5 * h * h) * gwKick.xyz;
      dirNext = normalize(dirNext + h * gwKick.xyz);
      iswMid = gwKick.w;
    }

    float segLen = length(posNext - pos);
    float midDist = rayDist + 0.5 * segLen;
    float camDistFade = smoothstep(0.0, 0.85, midDist);
    deltaISW += iswMid * segLen;

    if (hasDisk) {
      float yMin = min(pos.y, posNext.y);
      float yMax = max(pos.y, posNext.y);
      bool crossesPlane = (yMin <= 0.0 && yMax >= 0.0);
      bool inSlab = (yMin <= maxDiskSlabY && yMax >= -maxDiskSlabY);

      if (inSlab || crossesPlane) {
        vec3 midPos = 0.5 * (pos + posNext);
        float rMidCom = length(midPos.xz);
        if (rMidCom < rOuter * 1.12) {
          float hMid = diskScaleHeight(rMidCom, length(midPos.xz - uBh1Pos.xz), length(midPos.xz - uBh2Pos.xz), uRCavity, rOuter);

          if (crossesPlane || abs(midPos.y) < hMid * 2.65 || abs(pos.y) < hMid * 2.65 || abs(posNext.y) < hMid * 2.65) {
            float midDirY = abs(dir.y + dirNext.y) * 0.5;
            float anisoSub = (rMidCom > uRCavity * 0.85) ? min(1.0 / max(midDirY, 0.36), 2.15) : 1.0;
            float targetDs = max(hMid * 1.15 * anisoSub, 0.055) * qualScale;
            bool needCrossSub = crossesPlane && (segLen > targetDs * 0.72);
            int nSub = 1;
            if (needCrossSub || segLen > targetDs) {
              nSub = clamp(int(ceil(segLen / targetDs)), needCrossSub ? 2 : 1, uQuality >= 2 ? 3 : 2);
            }
            vec2 p0Rot = rotOrbXZ(pos.xz, cosOrb, sinOrb);
            vec2 p1Rot = rotOrbXZ(posNext.xz, cosOrb, sinOrb);

            bool skipSub = false;
            if (nSub > 1 && rMidCom < uRCavity * 0.82) {
              vec2 p0Uv = clamp(p0Rot * invFieldSpan + 0.5, vec2(0.002), vec2(0.998));
              vec2 pmUv = clamp((0.5 * (p0Rot + p1Rot)) * invFieldSpan + 0.5, vec2(0.002), vec2(0.998));
              vec2 p1Uv = clamp(p1Rot * invFieldSpan + 0.5, vec2(0.002), vec2(0.998));
              float s0 = textureLod(uTidalField, p0Uv, 0.0).r;
              float s1 = textureLod(uTidalField, pmUv, 0.0).r;
              float s2 = textureLod(uTidalField, p1Uv, 0.0).r;
              skipSub = (max(s0, max(s1, s2)) < 1e-4);
            }

            if (!skipSub) {
              float d1Mid = length(midPos - uBh1Pos);
              float d2Mid = length(midPos - uBh2Pos);
              float dsSub = segLen / float(nSub);
              float jitterBase = fract(bn.y + float(step) * 0.61803399);
              bool lowDet = lowDetailBase || (transmittance < 0.14);

              for (int s = 0; s < 3; ++s) {
                if (s >= nSub) break;
                float frac = (float(s) + jitterBase) / float(nSub);
                vec3 sPos = mix(pos, posNext, frac);
                vec2 sRotXZ = mix(p0Rot, p1Rot, frac);
                vec3 sDir = normalize(mix(dir, dirNext, frac));
                float sr1 = (nSub == 1) ? d1Mid : length(sPos - uBh1Pos);
                float sr2 = (nSub == 1) ? d2Mid : length(sPos - uBh2Pos);
                float sPhi = ((uMass1 > 0.0) ? (0.5 * uMass1 / max(sr1, 1e-4)) : 0.0)
                           + ((uMass2 > 0.0) ? (0.5 * uMass2 / max(sr2, 1e-4)) : 0.0);

                vec3 emit;
                float ext;
                evalDiskVolume(sPos.y, sRotXZ, sDir, sPhi, cosOrb, sinOrb, camDistFade, invFieldSpan, fc, lowDet, emit, ext);

                if (ext > 1e-6 || dot(emit, emit) > 1e-10) {
                  float tau = ext * dsSub;
                  float stepT = exp(-tau);
                  vec3 stepRad = (tau > 1e-4)
                    ? emit * ((1.0 - stepT) / max(ext, 1e-5))
                    : emit * dsSub;
                  radiance += transmittance * stepRad;
                  transmittance *= stepT;
                  if (transmittance < 0.008) break;
                }
              }
            }
          }
        }
      }
    }

    pos = posNext;
    dir = dirNext;
    rayDist += segLen;

    if (transmittance < 0.008) {
      break;
    }
  }

  if (!captured && !escaped) {
    float r1E = length(pos - uBh1Pos);
    float r2E = length(pos - uBh2Pos);
    float phiEnd = ((uMass1 > 0.0) ? (0.5 * uMass1 / max(r1E, 1e-4)) : 0.0)
                 + ((uMass2 > 0.0) ? (0.5 * uMass2 / max(r2E, 1e-4)) : 0.0);
    vec3 nearestD = (r1E / max(uMass1, 1e-4) <= r2E / max(uMass2, 1e-4)) ? (pos - uBh1Pos) : (pos - uBh2Pos);
    if (phiEnd > 0.45 || (phiEnd > 0.28 && dot(nearestD, dir) < 0.0)) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  float escFlag = (escaped && !captured && transmittance > 0.008) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);
  vec3 safeSkyDir = (dot(dir, dir) > 1e-10) ? normalize(dir) : localRay;
  vec3 skyColor = sampleSkyBackground(safeSkyDir, escFlag > 0.5, edgeMask, deltaISW);

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  }

  bvec3 bad = bvec3(
    isnan(radiance.r) || isinf(radiance.r),
    isnan(radiance.g) || isinf(radiance.g),
    isnan(radiance.b) || isinf(radiance.b)
  );
  radiance = mix(radiance, vec3(0.0), bad);
  radiance = clamp(radiance, vec3(0.0), vec3(28.0));

  fragColor = vec4(radiance, 1.0);
}
`;
