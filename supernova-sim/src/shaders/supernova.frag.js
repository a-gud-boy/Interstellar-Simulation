/**
 * Cinema-grade WebGL2 GLSL 300 es Volumetric Multi-Scattering Supernova Remnant
 * & Emission-Line Nebula Ray-Tracer for "Supernova Remnant Simulator".
 *
 * Radiative Transfer & Astrophysical Architecture:
 *  - Analytic ray–bounding-sphere intersection (rBound = 1.68 * R_shock) so empty
 *    sky pixels skip volumetric marching completely.
 *  - Blue-noise stratified step start + quality-tiered adaptive step counts
 *    (boosted during Space-paused 128-sample progressive accumulation) + early
 *    ray termination (transmittance < 0.005).
 *  - Exact analytical Beer–Lambert step integration preventing thin-shock aliasing.
 *  - 6 exponentially spaced shadow taps toward the central white dwarf / pulsar
 *    + 4-octave Wrenninge multiple scattering + normalized dual-lobe Henyey–Greenstein.
 *  - Pole-free 3D spherical Rayleigh–Taylor filament sculpting across distinct radial
 *    ionization zones: central pulsar + synchrotron wind cavity (Planck blackbody LUT),
 *    inner [O III] shell, shock-compressed H-alpha filaments, outer [S II] shock ridges,
 *    and cold dark foreground dust lanes & Bok globules.
 *  - Seamless switching between Hubble SHO narrowband (0) and True Color Broadband (1).
 */

export const SUPERNOVA_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 160-byte std140 UBO matching SupernovaUniforms in supernova.wgsl.js
layout(std140) uniform SupernovaUniforms {
  vec4 resolution_time_frame;  // (width, height, time, float(frameIndex))
  vec4 jitter_fov_palette;     // (jitterX, jitterY, fovY, float(paletteMode))
  vec4 camPos_rShock;          // (camX, camY, camZ, worldShockRadius)
  vec4 camRight_age;           // (rightX, rightY, rightZ, shockAgeNorm)
  vec4 camUp_turb;             // (upX, upY, upZ, rtTurbulence)
  vec4 camFwd_dust;            // (fwdX, fwdY, fwdZ, dustOpacity)
  vec4 scatterParams;          // (hgAnisotropy, starLuminosity, filamentContrast, cavityGlow)
  vec4 skyParams;              // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  vec4 qualityParams;          // (float(quality), expansionSpeed, centralTempK, float(isProgressive))
  vec4 zoneParams;             // (bokDensity, shellThickness, emissionGain, 0.0)
} u;

// Locked texture units 0..4
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8 (fbm, ridged, worley, micro)
uniform sampler2D uSkyMap;        // unit 1: 4K equirectangular Milky Way (sRGB RGBA8)
uniform sampler2D uProcSkyMap;    // unit 2: Procedural equirectangular sky (sRGB RGBA8)
uniform sampler2D uBlackbodyLut;  // unit 3: 512x1 linear CIE-1931 Planck LUT (800K..40000K log)
uniform sampler2D uBlueNoise;     // unit 4: 128x128 RGBA8 void-and-cluster blue noise

const float PI             = 3.14159265359;
const float TAU            = 6.28318530718;
const float INV_PI         = 0.31830988618;
const float INV_TAU        = 0.15915494309;
const float INV_4_PI       = 0.07957747155;
const float T_MIN          = 800.0;
const float T_MAX          = 40000.0;
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543;

// ============================================================================
// 1. CIE-1931 PLANCK BLACKBODY LUT & BACKGROUND SKY + MICRO-STARS
// ============================================================================

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureLod(uBlackbodyLut, vec2(uCoord, 0.5), 0.0).rgb;
}

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

  float fw = clamp(pixelFw * scale, 0.018, 0.20);
  float starRad = mix(0.026, 0.082, mag) + fw * 0.40;
  float core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
  if (core < 0.004) return vec3(0.0);

  float ry = max(rnd.y, 0.0);
  float tEmit = mix(3200.0, 22000.0, ry * ry);
  vec3 col = sampleBlackbody(tEmit);

  float energyComp = 1.0 / (1.0 + fw * 6.0);
  float lum = (0.10 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

vec3 sampleSkyBackground(vec3 rawDir, float skyIntensity, int skyMode, vec2 skyRot) {
  vec3 dir = normalize(rotateSkyDir(rawDir, skyRot));

  // Wrap-safe & pole-safe equirectangular derivatives in uniform control flow
  float u1 = atan(dir.z, dir.x) * INV_TAU + 0.5;
  float v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  vec2 uv1 = vec2(u1, v);
  vec2 uv2 = vec2(fract(u1 + 0.5), v);

  vec2 dx1 = dFdx(uv1);
  vec2 dy1 = dFdy(uv1);
  vec2 dx2 = dFdx(uv2);
  vec2 dy2 = dFdy(uv2);

  vec2 dUVdx = clamp(vec2(abs(dx1.x) < abs(dx2.x) ? dx1.x : dx2.x, dx1.y), vec2(-0.38), vec2(0.38));
  vec2 dUVdy = clamp(vec2(abs(dy1.x) < abs(dy2.x) ? dy1.x : dy2.x, dy1.y), vec2(-0.38), vec2(0.38));
  float dirFw = min(length(fwidth(dir)), 0.12);

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));
  vec3 mapSrgb = (skyMode == 2)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(0.0)), vec3(2.2));

  float skyLuma = dot(skyLin, vec3(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.32, 1.0, smoothstep(0.002, 0.042, skyLuma));

  vec3 brightCores = max(skyLin - vec3(0.28), vec3(0.0));
  skyLin += brightCores * brightCores * 2.2;

  if (skyMode == 0 || skyMode == 2) {
    float starGain = (skyMode == 0) ? 0.75 : 1.05;
    skyLin += evalMicroStarLayer(dir, 95.0,  0.908, 0.95 * starGain, dirFw)
            + evalMicroStarLayer(dir, 195.0, 0.882, 0.42 * starGain, dirFw);
  }

  return skyLin * max(skyIntensity, 0.0);
}

// ============================================================================
// 2. DUAL-LOBE HENYEY–GREENSTEIN & WRENNINGE MULTI-OCTAVE SCATTERING
// ============================================================================

float evalHG(float cosTheta, float g) {
  float gc = clamp(g, -0.95, 0.95);
  float mu = clamp(cosTheta, -1.0, 1.0);
  float denom = max(1.0 + gc * gc - 2.0 * gc * mu, 1e-4);
  return ((1.0 - gc * gc) * INV_4_PI) / (denom * sqrt(denom));
}

float evalDualHG(float cosTheta, float g) {
  float g1 = clamp(g, -0.95, 0.95);
  float g2 = clamp(-0.35 * g1, -0.55, 0.55);
  return 0.82 * evalHG(cosTheta, g1) + 0.18 * evalHG(cosTheta, g2);
}

float evalWrenningeMultiScatter(float tauShadow, float cosTheta, float g) {
  float tau = max(tauShadow, 0.0);
  float gc = clamp(g, -0.95, 0.95);
  float sum = 0.0;
  float aPow = 1.0;
  float bPow = 1.0;
  float cPow = 1.0;
  for (int oct = 0; oct < 4; ++oct) {
    float extAtten = exp(-min(bPow * tau, 40.0));
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

float gaussianBand(float x, float center, float width) {
  float u = (x - center) / max(width, 1e-4);
  return exp(-min(u * u, 40.0));
}

float evalShadowExtinction(
  vec3 p,
  float rShock,
  float shockAgeNorm,
  float rtTurbulence,
  float dustOpacity,
  float bokDensity,
  float shellThickness,
  float emissionGain,
  float simTime,
  float expansionSpeed
) {
  float r2 = dot(p, p);
  float r = sqrt(r2);
  float u = r / max(rShock, 0.5);
  if (u > 1.66) return 0.0;

  vec3 rHat = (r > 1e-5) ? (p / max(r, 1e-5)) : vec3(0.0, 1.0, 0.0);
  float adv = simTime * expansionSpeed * 0.028;

  vec3 qBase = p * (0.14 / max(rShock / 3.2, 0.5)) - rHat * (adv * 0.65);
  vec4 n1 = textureLod(uVolumeNoise, qBase, 0.0);

  float asym = 1.0 + 0.08 * (rHat.x * rHat.y - 0.55 * rHat.z) + 0.14 * (n1.r - 0.5);
  float uWarp = (u / max(asym, 0.55)) + (n1.r - 0.5) * 0.28 * rtTurbulence;

  float shellEnv = gaussianBand(uWarp, 0.94, 0.24 * shellThickness);
  float dustBand = smoothstep(0.74, 1.02, uWarp) * (1.0 - smoothstep(1.34, 1.64, uWarp));
  float clump = smoothstep(0.32, 0.88, n1.r * 0.58 + (1.0 - n1.b) * 0.42);
  float bokKnot = smoothstep(0.56, 0.90, (1.0 - n1.b) * 0.72 + n1.g * 0.28) * dustBand * bokDensity;

  float gasExt = 0.09 * shellEnv * emissionGain * (0.55 + 0.45 * n1.g);
  float dustExt = (0.82 * clump * dustBand + 2.35 * bokKnot) * dustOpacity * (0.75 + 0.45 * shockAgeNorm);
  return gasExt + dustExt;
}

struct VolSample {
  vec3  emission;
  vec3  scatterAlbedo;
  float sigmaScat;
  float sigmaExt;
};

VolSample evalVolumeSample(
  vec3 p,
  float rShock,
  float shockAgeNorm,
  float rtTurbulence,
  float dustOpacity,
  float filamentContrast,
  float cavityGlow,
  float bokDensity,
  float shellThickness,
  float emissionGain,
  int paletteMode,
  float centralTempK,
  float simTime,
  float expansionSpeed
) {
  VolSample vs;
  vs.emission = vec3(0.0);
  vs.scatterAlbedo = vec3(0.0);
  vs.sigmaScat = 0.0;
  vs.sigmaExt = 0.0;

  float r2 = dot(p, p);
  float r = sqrt(r2);
  float u = r / max(rShock, 0.5);
  if (u > 1.68) return vs;

  // Origin-safe unit radial direction
  vec3 rHat = (r > 1e-5) ? (p / max(r, 1e-5)) : vec3(0.0, 1.0, 0.0);
  float adv = simTime * expansionSpeed * 0.028;

  // Tap 1: Low-frequency domain warp + natural dipolar asymmetry
  vec3 qBase = p * (0.14 / max(rShock / 3.2, 0.5)) - rHat * (adv * 0.65);
  vec4 n1 = textureLod(uVolumeNoise, qBase, 0.0);

  float asym = 1.0 + 0.08 * (rHat.x * rHat.y - 0.55 * rHat.z) + 0.14 * (n1.r - 0.5);
  float uWarp = (u / max(asym, 0.55)) + (n1.r - 0.5) * 0.28 * rtTurbulence + (n1.g - 0.5) * 0.12 * rtTurbulence;

  // Tap 2: Pole-free 3D spherical Rayleigh–Taylor stretched coordinates
  vec3 qRadial = rHat * (1.35 + 0.52 * log(1.0 + 2.1 * u))
               + (n1.rgb - vec3(0.5)) * (0.38 * rtTurbulence)
               - rHat * (adv * 1.15);
  vec3 qRT = mix(p * 0.45, qRadial * 0.48, smoothstep(0.03, 0.18, u));
  vec4 n2 = textureLod(uVolumeNoise, qRT, 0.0);

  // Sculpted Rayleigh-Taylor filaments and cellular shock fronts
  float rtBase = clamp(n2.g * 0.64 + (1.0 - n2.b) * 0.36, 0.0, 1.0);
  float rtSharp = smoothstep(0.32, 0.92, rtBase);
  float rtFine = mix(rtSharp, rtSharp * rtSharp * (0.55 + 0.45 * n2.a), clamp(filamentContrast - 0.5, 0.0, 1.0));
  float rtFingers = (0.28 + 1.45 * rtFine) * (0.55 + 0.45 * n1.g);

  // Layered astrophysical ionization zones
  // 1) Central Pulsar Wind Nebula (PWN) synchrotron cavity
  float pwnBand = smoothstep(0.04, 0.16, u) * (1.0 - smoothstep(0.34, 0.64, u));
  float pwnWisp = smoothstep(0.28, 0.88, n1.g * 0.52 + n2.a * 0.48);
  float pwnVal = pwnBand * (0.25 + 0.95 * pwnWisp) * cavityGlow * (1.20 - 0.45 * shockAgeNorm);

  // 2) Inner [O III] 500.7 nm photoionized shell
  float oiiiBand = gaussianBand(uWarp, 0.72, 0.21 * shellThickness);
  float oiiiVal = oiiiBand * (0.35 + 0.85 * n2.r) * (0.75 + 0.45 * rtSharp);

  // 3) Shock-compressed H-alpha 656.3 nm Rayleigh–Taylor filament shell
  float haBand = gaussianBand(uWarp, 0.96, 0.15 * shellThickness);
  float haVal = haBand * rtFingers;

  // 4) Outer [S II] 671.6/673.1 nm leading blast-wave shock ridge
  float siiBand = gaussianBand(uWarp, 1.09, 0.11 * shellThickness);
  float siiVal = siiBand * (0.30 + 1.25 * rtFine) * smoothstep(0.35, 0.85, n2.g + 0.22 * n1.g);

  // 5) Cold outer/foreground dust lanes & dense dark Bok globules (non-emissive)
  float dustBand = smoothstep(0.74, 1.02, uWarp) * (1.0 - smoothstep(1.34, 1.64, uWarp));
  float dustClump = smoothstep(0.30, 0.86, n1.r * 0.54 + (1.0 - n2.b) * 0.46);
  float bokRaw = clamp((1.0 - n2.b) * 0.65 + (1.0 - n1.b) * 0.35, 0.0, 1.0);
  float bokKnot = smoothstep(0.58, 0.91, bokRaw) * dustBand * bokDensity;

  float sigmaDust = (0.78 * dustClump * dustBand + 2.45 * bokKnot) * dustOpacity * (0.75 + 0.45 * shockAgeNorm);

  // Emission palette mapping: 0 = Hubble SHO Narrowband, 1 = True Color Broadband
  vec3 cOIII;
  vec3 cHa;
  vec3 cSII;
  if (paletteMode == 0) {
    // Hubble SHO: [S II] -> Gold-Amber, H-alpha -> Emerald-Jade, [O III] -> Sapphire-Cyan
    cSII  = vec3(1.00, 0.56, 0.10);
    cHa   = vec3(0.28, 0.88, 0.40);
    cOIII = vec3(0.08, 0.72, 1.00);
  } else {
    // True Color Broadband: H-alpha -> Crimson, [O III] -> Teal, [S II] -> Ruby-Gold
    cHa   = vec3(1.00, 0.14, 0.24);
    cOIII = vec3(0.06, 0.88, 0.78);
    cSII  = vec3(0.98, 0.42, 0.10);
  }

  vec3 pwnColor = mix(vec3(0.28, 0.66, 1.00), sampleBlackbody(clamp(centralTempK * 0.28, 7000.0, 40000.0)), 0.45);
  vec3 gasEmit = pwnColor * (pwnVal * 0.58)
               + cOIII * (oiiiVal * 0.66)
               + cHa   * (haVal   * 0.92)
               + cSII  * (siiVal  * 0.78);
  gasEmit *= emissionGain;

  float gasDensity = (0.24 * pwnVal + 0.52 * oiiiVal + 0.88 * haVal + 0.60 * siiVal) * emissionGain;
  float sigmaGasExt = 0.085 * gasDensity;

  vs.emission = gasEmit;
  vs.sigmaScat = 0.06 * gasDensity + 0.72 * sigmaDust;
  vs.sigmaExt = sigmaGasExt + sigmaDust;
  vs.scatterAlbedo = mix(vec3(0.75, 0.82, 0.95), vec3(0.95, 0.78, 0.62), clamp(sigmaDust / max(vs.sigmaExt, 1e-4), 0.0, 1.0));
  return vs;
}

// ============================================================================
// 4. CENTRAL WHITE DWARF / PULSAR ILLUMINATOR (ORIGIN-SAFE)
// ============================================================================

vec3 evalCentralCore(vec3 camPos, vec3 rayDir, float starLuminosity, float centralTempK) {
  if (starLuminosity <= 1e-4) return vec3(0.0);

  float tStar = -dot(camPos, rayDir);
  if (tStar <= -0.15) return vec3(0.0);

  float tFwd = max(tStar, 0.0);
  float fwdFade = smoothstep(-0.14, 0.18, tStar);
  float d2 = max(dot(camPos, camPos) - tStar * tStar, 0.0);

  float coreScale = 0.0022 + 0.00042 * tFwd * tFwd;
  float haloScale = 0.042 + 0.0042 * tFwd * tFwd;
  float coreDisk = exp(-min(d2 / coreScale, 40.0));
  float corona = exp(-min(d2 / haloScale, 40.0));
  float distAtten = 1.0 / (1.0 + 0.045 * tFwd * tFwd);

  vec3 starCol = sampleBlackbody(centralTempK);
  vec3 coronaCol = mix(starCol, vec3(0.42, 0.78, 1.00), 0.38);

  return (starCol * (3.2 * coreDisk) + coronaCol * (0.48 * corona)) * starLuminosity * fwdFade * distAtten;
}

// ============================================================================
// 5. MAIN ANALYTIC-SPHERE MULTI-SCATTERING VOLUMETRIC RAY-MARCHER
// ============================================================================

void main() {
  vec2 res = max(u.resolution_time_frame.xy, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + u.jitter_fov_palette.xy;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(u.jitter_fov_palette.z, 0.1, 2.8) * 0.5);
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  mat3 camBasis = mat3(u.camRight_age.xyz, u.camUp_turb.xyz, u.camFwd_dust.xyz);
  vec3 rayDir = normalize(camBasis * localRay);

  float simTime = u.resolution_time_frame.z;
  int frameIndex = int(round(u.resolution_time_frame.w));
  int paletteMode = clamp(int(round(u.jitter_fov_palette.w)), 0, 1);

  vec3 camPos = u.camPos_rShock.xyz;
  float rShock = max(u.camPos_rShock.w, 0.5);
  float shockAgeNorm = clamp(u.camRight_age.w, 0.0, 1.0);
  float rtTurbulence = max(u.camUp_turb.w, 0.0);
  float dustOpacity = max(u.camFwd_dust.w, 0.0);

  float hgAnisotropy = clamp(u.scatterParams.x, -0.95, 0.95);
  float starLuminosity = max(u.scatterParams.y, 0.0);
  float filamentContrast = max(u.scatterParams.z, 0.1);
  float cavityGlow = max(u.scatterParams.w, 0.0);

  float skyIntensity = max(u.skyParams.x, 0.0);
  int skyMode = int(round(u.skyParams.y));
  vec2 skyRot = u.skyParams.zw;

  int quality = int(round(u.qualityParams.x));
  float expansionSpeed = max(u.qualityParams.y, 0.0);
  float centralTempK = clamp(u.qualityParams.z, T_MIN, 400000.0);
  bool isProgressive = u.qualityParams.w > 0.5;

  float bokDensity = max(u.zoneParams.x, 0.0);
  float shellThickness = clamp(u.zoneParams.y, 0.3, 2.5);
  float emissionGain = max(u.zoneParams.z, 0.0);

  // Sample sky unconditionally in uniform control flow for valid dFdx/dFdy derivatives
  vec3 skyColor = sampleSkyBackground(rayDir, skyIntensity, skyMode, skyRot);

  // Blue-noise stratification jitter
  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  // Analytic ray–bounding-sphere intersection
  float rBound = rShock * 1.68;
  float bSphere = dot(camPos, rayDir);
  float cSphere = dot(camPos, camPos) - rBound * rBound;
  float disc = bSphere * bSphere - cSphere;

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;

  if (disc > 0.0) {
    float sqrtDisc = sqrt(disc);
    float tNear = max(0.0, -bSphere - sqrtDisc);
    float tFar = -bSphere + sqrtDisc;

    if (tFar > tNear) {
      int nSteps = isProgressive ? 112 : 84;
      if (quality <= 0) {
        nSteps = isProgressive ? 80 : 56;
      } else if (quality >= 2) {
        nSteps = isProgressive ? 144 : 120;
      }

      float marchSpan = tFar - tNear;
      float ds = marchSpan / float(nSteps);
      float tStar = -dot(camPos, rayDir);
      float starTransmittance = 1.0;

      // Exponentially spaced shadow tap fractions + weights toward central remnant (0, 0, 0)
      const float tapFrac[6] = float[6](0.05, 0.11, 0.20, 0.34, 0.54, 0.78);
      const float tapW[6]    = float[6](0.07, 0.09, 0.13, 0.18, 0.23, 0.30);

      vec3 starLightTint = mix(sampleBlackbody(centralTempK), vec3(0.65, 0.88, 1.00), 0.25);

      for (int step = 0; step < 144; ++step) {
        if (step >= nSteps) break;

        float tPrev = tNear + float(step) * ds;
        float t = tPrev + bn.x * ds;
        vec3 p = camPos + rayDir * t;

        VolSample vs = evalVolumeSample(
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

        vec3 stepSource = vs.emission;

        if (vs.sigmaScat > 1e-4) {
          float r2 = dot(p, p);
          float r = sqrt(r2);
          vec3 rHat = (r > 1e-5) ? (p / max(r, 1e-5)) : vec3(0.0, 1.0, 0.0);

          // 6 exponentially spaced shadow taps toward (0, 0, 0)
          float tauShadow = 0.0;
          if (starLuminosity > 1e-3 && r > 0.08) {
            float shadowSpan = min(r, rBound);
            for (int st = 0; st < 6; ++st) {
              vec3 pTap = p * max(1.0 - tapFrac[st], 0.0);
              float extTap = evalShadowExtinction(
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

          // Wrenninge 4-octave multiple scattering + dual-lobe Henyey–Greenstein
          float cosTheta = dot(rHat, -rayDir);
          float wrenninge = evalWrenningeMultiScatter(tauShadow, cosTheta, hgAnisotropy);
          float invDist2 = 1.0 / (r2 + 0.25);
          vec3 directScatter = starLightTint * (starLuminosity * 6.5 * invDist2 * wrenninge);

          // Ambient nebula bounce illumination so shadowed Bok globule edges stay rich
          vec3 ambientBounce = mix(vec3(0.04, 0.09, 0.14), vec3(0.11, 0.08, 0.05), float(1 - paletteMode)) * emissionGain;

          stepSource += vs.sigmaScat * vs.scatterAlbedo * (directScatter + ambientBounce);
        }

        float prevTrans = transmittance;
        float sigmaT = max(vs.sigmaExt, 0.0);
        if (sigmaT > 1e-4 || dot(stepSource, stepSource) > 1e-10) {
          float tau = min(sigmaT * ds, 40.0);
          float stepT = exp(-tau);
          vec3 stepRad = (sigmaT > 1e-4)
            ? stepSource * ((1.0 - stepT) / max(sigmaT, 1e-5))
            : stepSource * ds;
          radiance += transmittance * stepRad;
          transmittance *= stepT;
        }

        if (tStar > tNear) {
          float tNext = tPrev + ds;
          if (tNext <= tStar) {
            starTransmittance = transmittance;
          } else if (tPrev < tStar) {
            float frac = clamp((tStar - tPrev) / max(ds, 1e-5), 0.0, 1.0);
            starTransmittance = mix(prevTrans, transmittance, frac);
          }
        }

        if (transmittance < 0.005) {
          break;
        }
      }

      radiance += starTransmittance * evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
    } else {
      // Ray exits sphere behind camera, yet core could still be barely forward if inside edge
      radiance += evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
    }
  } else {
    radiance += evalCentralCore(camPos, rayDir, starLuminosity, centralTempK);
  }

  radiance += transmittance * skyColor;

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
