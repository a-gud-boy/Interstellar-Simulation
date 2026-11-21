/**
 * Cinema-grade WebGL2 GLSL 300 es Relativistic Starflight Ray-Tracer
 * for "Relativistic Starflight Simulator".
 *
 * Physics & Optical Architecture (1:1 parity with starflight.wgsl.js):
 *  - Exact cancellation-free Special Relativity (SR) Lorentz aberration &
 *    relativistic Doppler factor D = 1 / (gamma * (1 - beta * mu')) in both
 *    forward and aft hemispheres, valid up to eta = 7.65 (gamma > 1000).
 *  - Multi-spectral 4K Milky Way / Procedural sky with physical CIE-1931 Planck
 *    blackbody temperature shift T_obs = T_base * D^dopplerStrength and soft-shoulder
 *    relativistic beaming + 3 rest-frame procedural star layers:
 *      * Main sequence (3000K..18000K)
 *      * Cool IR brown dwarfs (750K..1750K, igniting in forward cone D > 1.25)
 *      * Hot UV O-stars / white dwarfs (26000K..80000K, shifting into aft window)
 *  - Cosmic Microwave Background (CMB) shell at T_0 = 2.7255K * cmbTempScale * D
 *    with exact Solar dipole (0.00123) and 128^3 Planck-style acoustic mottling,
 *    bridging NIR thermal corona [110K, 900K] and optical Planck core (> 650K).
 *  - Penrose-Terrell rotated 3D periodic foreground corridor (CELL_Z = 34.0)
 *    traced along the aberrated rest-frame ray P(lambda) = (0,0,flightPosZ) + lambda*rdRest:
 *      * Navigation / Dyson Beacon Ring (major R = 5.4, center clear r_xy >= 4.9)
 *      * Flanking Beacon Station & Faceted Asteroid + Relay Pair with directional
 *        cyan bow (-Z) & warm amber stern (+Z) illumination.
 *  - 14/20/28 blue-noise-jittered volumetric 128^3 interstellar H-alpha / O-III
 *    dust streaks and sparse 3D parallax star knots outside r_xy > 1.6.
 */

export const STARFLIGHT_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 176-byte std140 UBO (11 x vec4) matching StarflightUniforms in starflight.wgsl.js
layout(std140) uniform StarflightUniforms {
  vec4 resolution_time_frame;  // (width, height, simTime, float(frameIndex))
  vec4 jitter_fov_prog;        // (jitterX, jitterY, fovY, isProgressive)
  vec4 camRight_beta;          // (right.x, right.y, right.z, beta)
  vec4 camUp_gamma;            // (up.x, up.y, up.z, gamma)
  vec4 camFwd_oneMinusBeta;    // (forward.x, forward.y, forward.z, oneMinusBeta)
  vec4 flightKinematics;       // (flightDir, flightPosZ, rapidity, dopplerStrength)
  vec4 spectralParams;         // (cmbVisibility, starDensity, uvIrGain, aberrationStrength)
  vec4 foregroundParams;       // (geometryVisibility, dustDensity, dustStreakScale, properAccelG)
  vec4 skyParams;              // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  vec4 qualityParams;          // (float(quality), properTimeYr, coordTimeYr, visualPace)
  vec4 extraParams;            // (beamingGain, cmbTempScale, 0.0, 0.0)
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
const float T_MIN          = 800.0;
const float T_MAX          = 40000.0;
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543; // 1 / ln(40000 / 800)
const float CELL_Z         = 34.0;
const float MAX_TRACE_DIST = 88.0;

// ============================================================================
// 1. IEEE-754 SANITIZER, BLACKBODY LUT & RELATIVISTIC DOPPLER HELPERS
// ============================================================================

bool isBadFloat(float x) {
  return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u;
}

vec3 sanitizeHdr(vec3 v) {
  vec3 clean = vec3(
    isBadFloat(v.x) ? 0.0 : v.x,
    isBadFloat(v.y) ? 0.0 : v.y,
    isBadFloat(v.z) ? 0.0 : v.z
  );
  return clamp(clean, vec3(0.0), vec3(28.0));
}

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureLod(uBlackbodyLut, vec2(uCoord, 0.5), 0.0).rgb;
}

float evalSoftBeam(float dBeam, float beamingGain) {
  float d = max(dBeam, 1e-4);
  float baseBeam;
  if (d >= 1.0) {
    float dp = pow(d, 1.32);
    float dm = (d > 1.0001) ? pow(d - 1.0, 1.32) : 0.0;
    baseBeam = dp / (1.0 + 0.22 * dm);
  } else {
    baseBeam = pow(clamp(d, 0.02, 1.0), 0.72) * smoothstep(0.015, 0.22, d);
  }
  return pow(max(baseBeam, 1e-4), clamp(beamingGain, 0.0, 2.0));
}

vec3 applyRelativisticShift(vec3 baseCol, float tBase, float dColor, float dBeam, float beamingGain, float beamMix) {
  float tObs = tBase * dColor;
  vec3 bbRef = max(sampleBlackbody(tBase), vec3(0.06));
  vec3 bbObs = sampleBlackbody(tObs);
  vec3 shiftRatio = bbObs / bbRef;

  if (dColor > 1.0) {
    shiftRatio = mix(shiftRatio, vec3(0.62, 0.86, 1.26), smoothstep(1.3, 6.0, dColor) * 0.36);
  } else {
    float wienCut = mix(0.22, 1.0, smoothstep(220.0, 800.0, tObs));
    shiftRatio *= wienCut;
  }

  float softBeam = evalSoftBeam(dBeam, beamingGain);
  float gain = mix(1.0, softBeam, beamMix);
  return baseCol * shiftRatio * gain;
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

// ============================================================================
// 2. MULTI-SPECTRAL STAR LAYERS, SKY & COSMIC MICROWAVE BACKGROUND (CMB)
// ============================================================================

// Spectral classes:
//   0 = Main sequence (3000K..18000K)
//   1 = Cool IR brown dwarfs (750K..1750K, ignite in forward cone D > 1.25)
//   2 = Hot UV O-stars / white dwarfs (26000K..80000K, glow in aft window D in [0.05, 0.55])
vec3 evalSpectralStarLayer(
  vec3 dir,
  float scale,
  float densityThresh,
  float boost,
  float pixelFwRest,
  float doppler,
  float dColor,
  float beamingGain,
  float uvIrGain,
  int spectralClass,
  float lodLimit
) {
  float cellFw = pixelFwRest * scale;
  float lodFade = 1.0 - smoothstep(lodLimit * 0.45, lodLimit, cellFw);
  if (lodFade <= 0.002) return vec3(0.0);

  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);
  if (rnd.x < densityThresh) return vec3(0.0);

  vec3 starPos = cell + vec3(0.24) + 0.52 * hash33f(cell + vec3(19.17, 73.41, 41.83));
  float dist = length(p - starPos);

  float magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  float mag2 = magU * magU;
  float mag = mag2 * mag2 * sqrt(magU);

  float fw = clamp(cellFw, 0.014, 0.28);
  float starRad = mix(0.025, 0.080, mag) + fw * 0.40;
  float core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
  if (core < 0.004) return vec3(0.0);

  float ry = max(rnd.y, 0.0);
  float tEmit;
  float bandpassGain;
  float beamFactor;
  vec3 tint = vec3(1.0);

  if (spectralClass == 1) {
    // Cool IR brown dwarfs (750K..1750K): invisible at rest, ignite in forward cone D > 1.25
    tEmit = mix(750.0, 1750.0, ry);
    float fwdIgnite = smoothstep(1.20, 2.25, doppler);
    bandpassGain = fwdIgnite * uvIrGain * 1.85;
    float irBeam = pow(clamp(doppler, 1.0, 12.0), 0.70);
    beamFactor = pow(irBeam / (1.0 + 0.20 * (irBeam - 1.0)), clamp(beamingGain, 0.0, 2.0));
  } else if (spectralClass == 2) {
    // Hot UV O-stars / white dwarfs (26000K..80000K): faint violet at rest, gold/orange/ruby in aft window
    tEmit = mix(26000.0, 80000.0, ry * ry);
    float aftWindow = smoothstep(0.018, 0.048, doppler) * (1.0 - smoothstep(0.42, 0.88, doppler));
    float restViolet = 0.065 * smoothstep(0.65, 1.05, doppler) * (1.0 - smoothstep(1.4, 3.0, doppler));
    bandpassGain = restViolet + aftWindow * uvIrGain * 3.45;
    if (doppler > 0.72) {
      tint = vec3(0.76, 0.62, 1.18);
    }
    float uvBeam = mix(0.80, 1.35, smoothstep(0.03, 0.45, doppler));
    beamFactor = pow(uvBeam, clamp(beamingGain, 0.0, 2.0));
  } else {
    // Main sequence (3000K..18000K)
    tEmit = mix(3000.0, 18000.0, ry * ry);
    bandpassGain = smoothstep(0.05, 0.35, doppler);
    float msBeam = evalSoftBeam(doppler, beamingGain);
    beamFactor = mix(1.0, msBeam, 0.85);
  }

  if (bandpassGain <= 0.002) return vec3(0.0);

  float tObs = tEmit * dColor;
  vec3 col = sampleBlackbody(tObs) * tint;
  float wienCut = (spectralClass == 1)
    ? smoothstep(520.0, 900.0, tObs)
    : smoothstep(220.0, 780.0, tObs);
  if (dColor > 1.5 && spectralClass != 2) {
    col = mix(col, vec3(0.70, 0.90, 1.22), smoothstep(2.0, 14.0, dColor) * 0.25);
  }

  float energyComp = 1.0 / (1.0 + fw * 5.2);
  float lum = (0.14 + 3.8 * mag) * boost * energyComp * bandpassGain * beamFactor * wienCut * lodFade;
  return col * (core * lum);
}

vec3 evalCmbShell(vec3 rdRest, float doppler, float cmbVisibility, float cmbTempScale) {
  if (cmbVisibility <= 0.001) return vec3(0.0);

  vec4 nCmb = textureLod(uVolumeNoise, rdRest * 3.5, 0.0);
  vec4 nFine = textureLod(uVolumeNoise, rdRest * 9.5 + vec3(0.23, 0.41, 0.17), 0.0);
  float acousticMottle = ((nCmb.r * 0.62 + nCmb.b * 0.26 + nFine.g * 0.12) - 0.5) * 2.0;

  vec3 dipoleDir = normalize(vec3(0.45, 0.35, 0.82));
  float dipoleTerm = 0.00123 * dot(rdRest, dipoleDir);
  float tCmbObs = 2.7255 * max(cmbTempScale, 0.0) * doppler * (1.0 + dipoleTerm + 0.04 * acousticMottle);

  if (tCmbObs < 95.0) return vec3(0.0);

  // Smooth NIR/thermal CMB corona band [110K, 900K] (active at Preset 4 gamma=70.7 -> ~385K)
  float nirEnv = smoothstep(105.0, 220.0, tCmbObs) * (1.0 - 0.82 * smoothstep(660.0, 1350.0, tCmbObs));
  float nirWarm = smoothstep(115.0, 420.0, tCmbObs);
  vec3 nirCol = mix(vec3(0.64, 0.06, 0.015), vec3(1.00, 0.48, 0.09), nirWarm);
  nirCol = mix(nirCol, vec3(1.00, 0.80, 0.36), smoothstep(390.0, 760.0, tCmbObs));
  float nirLum = (tCmbObs > 102.0)
    ? pow(min((tCmbObs - 102.0) / 290.0, 2.6), 1.35) * 1.95 * nirEnv
    : 0.0;

  // Optical Planck band (> 650K, blazing white-blue bullseye + golden ring as gamma -> 1000)
  float optMask = smoothstep(620.0, 920.0, tCmbObs);
  vec3 optCol = sampleBlackbody(tCmbObs);
  float optRaw = (tCmbObs > 560.0)
    ? pow(min((tCmbObs - 560.0) / 2100.0, 6.0), 1.25) * 5.2 * optMask
    : 0.0;
  float optLum = optRaw / (1.0 + 0.14 * optRaw);

  float mottleContrast = 1.0 + 0.16 * acousticMottle;
  vec3 cmbColor = (nirCol * nirLum + optCol * optLum) * mottleContrast * cmbVisibility;
  return max(cmbColor, vec3(0.0));
}

vec3 sampleSkyBackground(
  vec3 rdRest,
  float pixelFwRest,
  float doppler,
  float dopplerStrength,
  float beamingGain,
  float skyIntensity,
  int skyMode,
  vec2 skyRot,
  float starDensity,
  float uvIrGain,
  float cmbVisibility,
  float cmbTempScale
) {
  vec3 dir = normalize(rotateSkyDir(rdRest, skyRot));

  // Seam-safe & pole-safe equirectangular derivatives in uniform control flow
  float azim = (abs(dir.x) + abs(dir.z) > 1e-6) ? atan(dir.z, dir.x) : 0.0;
  float u1 = azim * INV_TAU + 0.5;
  float v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  vec2 uv1 = vec2(u1, v);
  vec2 uv2 = vec2(fract(u1 + 0.5), v);

  vec2 dx1 = dFdx(uv1);
  vec2 dy1 = dFdy(uv1);
  vec2 dx2 = dFdx(uv2);
  vec2 dy2 = dFdy(uv2);

  vec2 dUVdx = vec2(abs(dx1.x) < abs(dx2.x) ? dx1.x : dx2.x, dx1.y);
  vec2 dUVdy = vec2(abs(dy1.x) < abs(dy2.x) ? dy1.x : dy2.x, dy1.y);
  dUVdx = clamp(dUVdx, vec2(-0.25), vec2(0.25));
  dUVdy = clamp(dUVdy, vec2(-0.25), vec2(0.25));

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.002, 0.998));
  vec3 mapSrgb = (skyMode >= 1)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(1e-5)), vec3(2.2));

  // Crisp deep-space floor + galactic core punch
  float skyLuma = dot(skyLin, vec3(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.22, 1.0, smoothstep(0.002, 0.045, skyLuma));
  vec3 brightCores = max(skyLin - vec3(0.28), vec3(0.0));
  skyLin += brightCores * brightCores * 2.4;

  // Relativistic Planck blackbody temperature shift + soft-shoulder beaming
  float dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  float blueRed = clamp((skyLin.b - skyLin.r) / max(skyLin.r + skyLin.g + skyLin.b, 1e-4), -0.6, 0.6);
  float tBaseMw = mix(5200.0, 9200.0, clamp(blueRed * 0.8 + 0.35, 0.0, 1.0));
  vec3 shiftedSky = applyRelativisticShift(skyLin, tBaseMw, dColor, dColor, beamingGain, 0.85);

  // Subtle deep-crimson IR floor on bright Milky Way core so extreme aft windows (e.g. 0.995c D=0.05) stay visibly warm crimson
  float coreMask = smoothstep(0.03, 0.38, skyLuma);
  float irAftBand = smoothstep(0.022, 0.060, dColor) * (1.0 - smoothstep(0.16, 0.45, dColor));
  shiftedSky += vec3(0.52, 0.045, 0.012) * (coreMask * irAftBand * 0.42);
  skyLin = shiftedSky;

  // 3 multi-spectral procedural star layers in rest frame
  if (starDensity > 0.001) {
    float starGain = ((skyMode >= 1) ? 1.10 : 0.85) * starDensity;
    vec3 stars = vec3(0.0);
    // Main sequence octaves
    stars += evalSpectralStarLayer(dir,  12.0, 0.785, 0.65 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.55);
    stars += evalSpectralStarLayer(dir,  34.0, 0.880, 0.90 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.20);
    stars += evalSpectralStarLayer(dir,  88.0, 0.896, 0.95 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.15);
    stars += evalSpectralStarLayer(dir, 195.0, 0.878, 0.45 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.15);
    // Cool IR brown dwarfs (750K..1750K, ignite in forward cone D > 1.25)
    stars += evalSpectralStarLayer(dir,  15.0, 0.820, 0.90 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.55);
    stars += evalSpectralStarLayer(dir,  48.0, 0.875, 1.25 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.20);
    stars += evalSpectralStarLayer(dir, 115.0, 0.888, 1.05 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.15);
    // Hot UV O-stars / white dwarfs (26000K..80000K, ignite in aft window D in [0.05, 0.55])
    stars += evalSpectralStarLayer(dir,  52.0, 0.855, 1.35 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.20);
    stars += evalSpectralStarLayer(dir,  92.0, 0.842, 1.65 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.15);
    stars += evalSpectralStarLayer(dir, 215.0, 0.848, 1.25 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.15);
    skyLin += stars;
  }

  vec3 cmbCol = evalCmbShell(rdRest, doppler, cmbVisibility, cmbTempScale);
  return skyLin * max(skyIntensity, 0.0) + cmbCol;
}

// ============================================================================
// 3. PENROSE-TERRELL ROTATED 3D FOREGROUND REFERENCE GEOMETRY (REST FRAME S)
// ============================================================================

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Object 0: Navigation / Dyson Beacon Ring (major R = 5.4, center clear r_xy >= 4.9)
float sdRingGate(vec3 p) {
  vec2 qr = vec2(abs(length(p.xy) - 5.4) - 0.16, abs(p.z) - 0.24);
  float dTorus = length(max(qr, vec2(0.0))) + min(max(qr.x, qr.y), 0.0) - 0.06;

  vec2 ap = abs(p.xy);
  vec2 mxy = (ap.x > ap.y) ? ap.xy : ap.yx;
  float dPylon = sdBox(vec3(mxy.x - 5.78, mxy.y, p.z), vec3(0.56, 0.24, 0.56)) - 0.05;
  return min(dTorus, dPylon);
}

// Object 1: Flanking Beacon Station at (-6.8, -1.2, 5.5)
float sdBeaconStation(vec3 p) {
  float dCore = sdBox(p, vec3(0.54, 0.54, 1.02)) - 0.10;
  float dWing = sdBox(vec3(p.x, abs(p.y) - 1.32, p.z), vec3(0.56, 0.52, 0.66)) - 0.03;
  float dStrut = sdBox(p, vec3(0.22, 0.85, 0.34));

  vec2 qDock = vec2(abs(length(p.xy) - 0.38) - 0.05, abs(p.z + 1.12) - 0.08);
  float dDock = length(max(qDock, vec2(0.0))) + min(max(qDock.x, qDock.y), 0.0) - 0.02;

  float engineRad = mix(0.28, 0.44, clamp((p.z - 0.95) / 0.45, 0.0, 1.0));
  vec2 qEng = vec2(length(p.xy) - engineRad, abs(p.z - 1.18) - 0.22);
  float dEng = length(max(qEng, vec2(0.0))) + min(max(qEng.x, qEng.y), 0.0) - 0.02;

  return min(min(dCore, dWing), min(dStrut, min(dDock, dEng)));
}

// Object 2: Faceted Asteroid & Transponder Pair at (6.8, 1.5, -6.5)
float sdFacetedAsteroid(vec3 p) {
  const float cy = 0.87758256; // cos(0.5)
  const float sy = 0.47942554; // sin(0.5)
  const float cx = 0.96891242; // cos(0.25)
  const float sx = 0.24740396; // sin(0.25)
  vec3 r1 = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  vec3 pa = vec3(r1.x, cx * r1.y - sx * r1.z, sx * r1.y + cx * r1.z);

  float dBoxA = sdBox(pa, vec3(1.14, 0.88, 1.20)) - 0.14;
  float dOctA = (abs(pa.x) * 0.86 + abs(pa.y) * 1.05 + abs(pa.z) * 0.82 - 1.62) * 0.56;
  float ridge = 0.08 * sin(pa.x * 3.1 + 0.7) * cos(pa.y * 3.7 - 0.4) * sin(pa.z * 2.9 + 1.1);
  float dRock = max(dBoxA, dOctA) + ridge;

  vec3 pPod = p - vec3(0.0, 1.12, 0.0);
  float dPod = sdBox(pPod, vec3(0.32, 0.28, 0.68)) - 0.04;
  float dFin = sdBox(vec3(abs(pPod.x) - 0.56, pPod.y, pPod.z), vec3(0.24, 0.05, 0.36)) - 0.01;
  return min(dRock, min(dPod, dFin));
}

float evalObjSdf(vec3 pLocal, int objId) {
  if (objId == 0) return sdRingGate(pLocal);
  if (objId == 1) return sdBeaconStation(pLocal);
  return sdFacetedAsteroid(pLocal);
}

vec3 calcObjNormal(vec3 pLocal, int objId) {
  const float eps = 0.004;
  vec3 n = vec3(1.0, -1.0, -1.0) * evalObjSdf(pLocal + vec3( 1.0, -1.0, -1.0) * eps, objId)
         + vec3(-1.0, -1.0, 1.0) * evalObjSdf(pLocal + vec3(-1.0, -1.0,  1.0) * eps, objId)
         + vec3(-1.0,  1.0,-1.0) * evalObjSdf(pLocal + vec3(-1.0,  1.0, -1.0) * eps, objId)
         + vec3( 1.0,  1.0, 1.0) * evalObjSdf(pLocal + vec3( 1.0,  1.0,  1.0) * eps, objId);
  float len = length(n);
  return (len > 1e-6) ? (n / len) : vec3(0.0, 0.0, 1.0);
}

vec2 intersectSphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

struct HitInfo {
  bool hit;
  float t;
  int objId;
  vec3 localPos;
};

HitInfo marchObject(vec3 ro, vec3 rd, vec3 center, float radius, float tMin, float tMax, int objId, bool zSlab) {
  HitInfo res;
  res.hit = false;
  res.t = tMax;
  res.objId = objId;
  res.localPos = vec3(0.0);

  vec2 sp = intersectSphere(ro, rd, center, radius);
  float t0 = max(tMin, sp.x);
  float t1 = min(tMax, sp.y);

  if (zSlab) {
    if (abs(rd.z) > 1e-5) {
      float tzA = (center.z - 0.85 - ro.z) / rd.z;
      float tzB = (center.z + 0.85 - ro.z) / rd.z;
      t0 = max(t0, min(tzA, tzB));
      t1 = min(t1, max(tzA, tzB));
    } else if (abs(ro.z - center.z) > 0.85) {
      return res;
    }
  }

  if (t0 >= t1) return res;

  float t = t0;
  float stepFactor = (objId == 0) ? 0.92 : 0.78;
  for (int i = 0; i < 42; ++i) {
    vec3 pLocal = (ro + t * rd) - center;
    float d = evalObjSdf(pLocal, objId);
    if (d < 0.0025 * max(1.0, t * 0.04)) {
      res.hit = true;
      res.t = t;
      res.localPos = pLocal;
      return res;
    }
    t += max(d * stepFactor, 0.008);
    if (t > t1) break;
  }
  return res;
}

HitInfo traceCorridorGeometry(vec3 ro, vec3 rd) {
  HitInfo best;
  best.hit = false;
  best.t = MAX_TRACE_DIST;
  best.objId = -1;
  best.localPos = vec3(0.0);

  int kBase = int(floor(ro.z / CELL_Z + 0.5));
  int stepK = (rd.z >= 0.0) ? 1 : -1;

  for (int c = 0; c < 4; ++c) {
    float cellZ = float(kBase + stepK * c) * CELL_Z;
    float minPossibleT = (c >= 2) ? max(0.0, (abs(cellZ - ro.z) - 9.5) / max(abs(rd.z), 1e-3)) : 0.0;
    if (minPossibleT > best.t) break;

    HitInfo h0 = marchObject(ro, rd, vec3(0.0, 0.0, cellZ), 6.65, 0.4, best.t, 0, true);
    if (h0.hit && h0.t < best.t) best = h0;

    HitInfo h1 = marchObject(ro, rd, vec3(-6.8, -1.2, cellZ + 5.5), 2.65, 0.4, best.t, 1, false);
    if (h1.hit && h1.t < best.t) best = h1;

    HitInfo h2 = marchObject(ro, rd, vec3(6.8, 1.5, cellZ - 6.5), 2.45, 0.4, best.t, 2, false);
    if (h2.hit && h2.t < best.t) best = h2;
  }

  return best;
}

vec3 shadeForegroundHit(
  HitInfo h,
  vec3 rdRest,
  float doppler,
  float dopplerStrength,
  float beamingGain,
  float geometryVisibility
) {
  vec3 p = h.localPos;
  vec3 n = calcObjNormal(p, h.objId);
  vec3 v = -rdRest;

  vec3 keyDir = normalize(vec3(0.55, 0.68, -0.48));
  vec3 rimDir = normalize(vec3(-0.62, -0.35, 0.70));
  float ndlKey = max(dot(n, keyDir), 0.0);
  float ndlRim = max(dot(n, rimDir), 0.0);
  vec3 halfV = normalize(keyDir + v);
  float spec = pow(max(dot(n, halfV), 1e-5), 28.0);
  float fresnel = pow(clamp(1.0 - max(dot(n, v), 0.0), 1e-5, 1.0), 3.2);

  // Subtle SDF ambient occlusion
  float ao = clamp(0.45 + 0.55 * (evalObjSdf(p + n * 0.22, h.objId) / 0.22), 0.25, 1.0);

  vec3 albedo = vec3(0.18, 0.21, 0.27);
  vec3 emissive = vec3(0.0);
  float emTemp = 6500.0;
  float metalSpec = 0.75;

  if (h.objId == 0) {
    // Navigation / Dyson Beacon Ring
    float angle = (abs(p.x) + abs(p.y) > 1e-6) ? atan(p.y, p.x) : 0.0;
    float rXY = length(p.xy);
    float seg = smoothstep(0.35, 0.85, cos(angle * 24.0));
    float ribs = 0.82 + 0.18 * cos(angle * 48.0);
    albedo = mix(vec3(0.14, 0.17, 0.22), vec3(0.28, 0.33, 0.40), seg) * ribs;

    // Directional cyan (-Z) vs amber (+Z) nav strip lights for clear Penrose-Terrell rotation
    float stripMask = smoothstep(0.18, 0.04, abs(rXY - 5.4)) * step(0.1, seg);
    float pylonStrip = smoothstep(0.16, 0.04, min(abs(p.x), abs(p.y))) * step(5.2, rXY);
    if (p.z < -0.14) {
      emissive = vec3(0.14, 0.88, 1.00) * (stripMask * 2.8 + pylonStrip * 1.2);
      emTemp = 11500.0;
    } else if (p.z > 0.14) {
      emissive = vec3(1.00, 0.48, 0.09) * (stripMask * 2.8 + pylonStrip * 1.2);
      emTemp = 2600.0;
    }
  } else if (h.objId == 1) {
    // Flanking Beacon Station
    if (abs(p.y) > 0.75) {
      // Metallic solar-fin wings with golden ribs
      float finRib = smoothstep(0.75, 0.96, cos(p.z * 22.0));
      albedo = mix(vec3(0.06, 0.15, 0.34), vec3(0.45, 0.34, 0.14), finRib);
      metalSpec = 1.15;
    } else {
      float hullPanel = 0.85 + 0.15 * sin(p.z * 12.0);
      albedo = vec3(0.22, 0.25, 0.30) * hullPanel;
    }
    // Bow cyan docking face (-Z) vs Stern warm amber engine glow (+Z)
    if (p.z < -0.96) {
      float ringGlow = smoothstep(0.55, 0.32, abs(length(p.xy) - 0.38));
      emissive = vec3(0.10, 0.86, 1.00) * (1.2 + 3.4 * ringGlow);
      emTemp = 12000.0;
    } else if (p.z > 0.96) {
      float nozzle = smoothstep(0.52, 0.12, length(p.xy));
      emissive = vec3(1.00, 0.42, 0.08) * (1.4 + 4.2 * nozzle);
      emTemp = 2400.0;
    }
  } else {
    // Faceted Asteroid + Transponder Pair
    if (p.y < 0.82) {
      vec4 nRock = textureLod(uVolumeNoise, p * 0.52 + vec3(0.11, 0.37, 0.29), 0.0);
      albedo = mix(vec3(0.11, 0.10, 0.12), vec3(0.28, 0.25, 0.23), nRock.r * 0.7 + nRock.b * 0.3);
      metalSpec = 0.22;
    } else {
      float finGrid = 0.8 + 0.2 * cos(p.z * 26.0);
      albedo = vec3(0.24, 0.28, 0.34) * finGrid;
      if (p.z < -0.50) {
        emissive = vec3(0.12, 0.84, 1.00) * 3.2;
        emTemp = 11000.0;
      } else if (p.z > 0.50) {
        emissive = vec3(1.00, 0.46, 0.10) * 3.4;
        emTemp = 2500.0;
      }
    }
  }

  vec3 litSurface = albedo * (0.20 * ao + 1.15 * ndlKey * ao + 0.45 * ndlRim)
                  + vec3(0.75, 0.86, 1.00) * (spec * metalSpec + fresnel * 0.24);

  float dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  vec3 shiftedLit = applyRelativisticShift(litSurface, 5800.0, dColor, dColor, beamingGain, 0.72);
  float emGain = 0.70 + 0.35 * max(geometryVisibility, 0.0);
  vec3 shiftedEm = applyRelativisticShift(emissive * emGain, emTemp, dColor, dColor, beamingGain, 0.75);

  float distFade = 1.0 - smoothstep(64.0, MAX_TRACE_DIST, h.t);
  return max((shiftedLit + shiftedEm) * distFade, vec3(0.0));
}

// ============================================================================
// 4. VOLUMETRIC 128^3 INTERSTELLAR DUST STREAKS & 3D PARALLAX STAR KNOTS
// ============================================================================

vec4 integrateCorridorVolume(
  vec3 ro,
  vec3 rdRest,
  float tEnd,
  vec4 bn,
  int quality,
  float simTime,
  float doppler,
  float dopplerStrength,
  float beamingGain,
  float dustDensity,
  float dustStreakScale,
  float starDensity
) {
  float tStart = 0.6;
  if (tEnd <= tStart) return vec4(0.0, 0.0, 0.0, 1.0);
  if (dustDensity <= 0.001 && starDensity <= 0.001) return vec4(0.0, 0.0, 0.0, 1.0);

  int nSteps = 20;
  if (quality <= 0) {
    nSteps = 14;
  } else if (quality >= 2) {
    nSteps = 28;
  }

  float dColor = pow(max(doppler, 1e-4), clamp(dopplerStrength, 0.0, 2.0));
  float invStreakZ = 0.045 / max(dustStreakScale, 0.25);
  float invStreakFineZ = 0.095 / max(dustStreakScale, 0.25);
  float fSteps = float(nSteps);

  vec3 volRad = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < 28; ++i) {
    if (i >= nSteps) break;
    float j0 = fract(bn.y + float(i) * 0.61803399);
    float u0 = float(i) / fSteps;
    float u1 = float(i + 1) / fSteps;
    float t0 = mix(tStart, tEnd, u0 * (0.45 + 0.55 * u0));
    float t1 = mix(tStart, tEnd, u1 * (0.45 + 0.55 * u1));
    float tMid = mix(t0, t1, j0);
    float dt = t1 - t0;

    vec3 p = ro + rdRest * tMid;
    float rangeMask = smoothstep(2.5, 11.0, tMid) * (1.0 - smoothstep(46.0, 72.0, tMid));

    if (rangeMask > 0.001) {
      if (dustDensity > 0.001) {
        vec3 uvw1 = vec3(p.xy * 0.11, p.z * invStreakZ) + vec3(0.37, 0.61, 0.19);
        vec3 uvw2 = vec3(p.xy * 0.22, p.z * invStreakFineZ) + vec3(0.73, 0.29, 0.53);
        vec4 n1 = textureLod(uVolumeNoise, uvw1, 0.0);
        vec4 n2 = textureLod(uVolumeNoise, uvw2, 0.0);

        float wisp = smoothstep(0.58, 0.94, n1.r * 0.55 + n1.g * 0.45);
        float fil = smoothstep(0.60, 0.95, n1.g * 0.52 + n2.a * 0.58);
        float clump = smoothstep(0.45, 0.82, n1.b);
        float dustRedFade = smoothstep(0.30, 0.95, doppler);
        float dens = (wisp * wisp * 0.25 + fil * fil * fil * 0.90) * clump * rangeMask * dustDensity;

        if (dens > 0.002 && dustRedFade > 0.001) {
          vec3 hAlpha = vec3(0.95, 0.20, 0.34);
          vec3 oThree = vec3(0.14, 0.72, 0.94);
          vec3 nebCol = mix(hAlpha, oThree, smoothstep(0.28, 0.78, n1.b));
          nebCol = mix(nebCol, vec3(0.86, 0.94, 1.00), fil * 0.35);

          vec3 shiftedNeb = applyRelativisticShift(nebCol, 5600.0, dColor, dColor, beamingGain, 0.55);
          float ext = dens * 0.0025;
          float stepT = exp(-ext * dt);
          volRad += trans * shiftedNeb * (dens * 0.0060 * dustRedFade * dt);
          trans *= stepT;
        }
      }

      // Sparse 3D parallax star knots along the corridor (crisp beyond 5.5u)
      float knotRange = smoothstep(5.5, 13.0, tMid) * (1.0 - smoothstep(48.0, 72.0, tMid));
      if (starDensity > 0.001 && knotRange > 0.001 && length(p.xy) > 1.2) {
        const float knotScale = 0.18;
        vec3 pScaled = p * knotScale;
        vec3 cell = floor(pScaled);
        vec3 rnd = hash33f(cell + vec3(7.13, 19.41, 31.77));
        if (rnd.x > 0.948) {
          vec3 starWorld = (cell + vec3(0.26) + 0.48 * hash33f(cell + vec3(53.1, 11.7, 97.3))) / knotScale;
          float tProj = dot(starWorld - ro, rdRest);
          if (tProj >= t0 && tProj < t1) {
            float dPerp = length((ro + rdRest * tProj) - starWorld);
            float knotR = mix(0.045, 0.105, fract(rnd.y * 13.7));
            float glow = exp(-min((dPerp * dPerp) / (knotR * knotR), 32.0));
            if (glow > 0.005) {
              float tKnot = mix(3400.0, 14000.0, rnd.z);
              vec3 knotCol = sampleBlackbody(tKnot * dColor);
              float knotBeam = evalSoftBeam(doppler, beamingGain);
              float wienCut = smoothstep(220.0, 780.0, tKnot * dColor);
              volRad += trans * knotCol * (glow * 1.95 * knotBeam * wienCut * starDensity * knotRange);
            }
          }
        }
      }
    }

    if (trans < 0.02) break;
  }

  return vec4(volRad, trans);
}

// ============================================================================
// 5. MAIN RELATIVISTIC ABERRATION, FOREGROUND & VOLUMETRIC PIPELINE
// ============================================================================

void main() {
  vec2 res = max(u.resolution_time_frame.xy, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + u.jitter_fov_prog.xy;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(u.jitter_fov_prog.z, 0.1, 2.8) * 0.5);
  vec3 localRay = vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0);
  vec3 rdShip = normalize(
    u.camRight_beta.xyz * localRay.x +
    u.camUp_gamma.xyz * localRay.y +
    u.camFwd_oneMinusBeta.xyz * localRay.z
  );

  float pixelFwShip = clamp(length(fwidth(rdShip)), 0.0002, 0.05);

  float simTime = u.resolution_time_frame.z;
  int frameIndex = int(round(u.resolution_time_frame.w));
  float beta = clamp(u.camRight_beta.w, 0.0, 0.9999996);
  float gamma = max(u.camUp_gamma.w, 1.0);
  float oneMinusBeta = max(u.camFwd_oneMinusBeta.w, 0.0);

  float flightDir = u.flightKinematics.x;
  float flightPosZ = u.flightKinematics.y;
  float dopplerStrength = clamp(u.flightKinematics.w, 0.0, 2.0);

  float cmbVisibility = max(u.spectralParams.x, 0.0);
  float starDensity = max(u.spectralParams.y, 0.0);
  float uvIrGain = max(u.spectralParams.z, 0.0);
  float aberrationStrength = u.spectralParams.w;

  float geometryVisibility = max(u.foregroundParams.x, 0.0);
  float dustDensity = max(u.foregroundParams.y, 0.0);
  float dustStreakScale = max(u.foregroundParams.z, 0.25);

  float skyIntensity = max(u.skyParams.x, 0.0);
  int skyMode = int(round(u.skyParams.y));
  vec2 skyRot = u.skyParams.zw;

  int quality = int(round(u.qualityParams.x));
  float beamingGain = max(u.extraParams.x, 0.0);
  float cmbTempScale = max(u.extraParams.y, 0.0);

  // Cancellation-free SR aberration & Doppler factor
  vec3 rdRest = rdShip;
  float doppler = 1.0;

  if (aberrationStrength > 0.5) {
    float s = (flightDir >= 0.0) ? 1.0 : -1.0;
    float muP = s * rdShip.z;
    float oneMinusMuP = (muP >= 0.0)
      ? (rdShip.x * rdShip.x + rdShip.y * rdShip.y) / max(1.0 + muP, 1e-6)
      : (1.0 - muP);
    float denom = (muP >= 0.0)
      ? (oneMinusBeta + beta * oneMinusMuP)
      : (1.0 - beta * muP);
    float muRest = ((muP >= 0.0) ? (oneMinusBeta - oneMinusMuP) : (muP - beta)) / max(denom, 1e-7);
    float perpScale = 1.0 / max(gamma * denom, 1e-7);
    vec3 rawRest = vec3(rdShip.x * perpScale, rdShip.y * perpScale, s * muRest);
    float rawLen = length(rawRest);
    rdRest = (rawLen > 1e-7) ? (rawRest / rawLen) : vec3(0.0, 0.0, s);
    doppler = clamp(1.0 / max(gamma * denom, 1e-6), 1e-4, 2500.0);
  }

  float pixelFwRest = clamp(pixelFwShip * doppler, 0.0002, 0.28);

  // Sample sky & CMB unconditionally in uniform control flow (wrap- & seam-safe!)
  vec3 skyColor = sampleSkyBackground(
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

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  vec3 origin = vec3(0.0, 0.0, flightPosZ);
  HitInfo hitInfo;
  hitInfo.hit = false;
  hitInfo.t = MAX_TRACE_DIST;
  hitInfo.objId = -1;
  hitInfo.localPos = vec3(0.0);

  if (geometryVisibility > 0.001) {
    hitInfo = traceCorridorGeometry(origin, rdRest);
  }

  float geomAlpha = hitInfo.hit ? smoothstep(0.0, 0.95, geometryVisibility) : 0.0;
  float volMaxDist = hitInfo.hit && geomAlpha >= 0.99 ? hitInfo.t : 72.0;

  vec4 volSample = integrateCorridorVolume(
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

  vec3 radiance = skyColor;
  if (hitInfo.hit && geomAlpha > 0.001) {
    vec3 hitColor = shadeForegroundHit(hitInfo, rdRest, doppler, dopplerStrength, beamingGain, geometryVisibility);
    radiance = mix(radiance, hitColor, geomAlpha);
  }
  radiance = radiance * volSample.w + volSample.xyz;

  fragColor = vec4(sanitizeHdr(radiance), 1.0);
}
`;
