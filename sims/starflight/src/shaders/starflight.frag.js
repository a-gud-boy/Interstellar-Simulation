/**
 * Cinema-grade WebGL2 GLSL 300 es Relativistic Starflight Ray-Tracer
 * for "Relativistic Starflight Simulator".
 *
 * Physically exact radiative-transfer & Penrose-Terrell foreground pipeline
 * (1:1 mathematical parity with starflight.wgsl.js):
 *  - Locked 176-byte std140 StarflightUniforms (11 x vec4) and texture units 0..4
 *  - Exact cancellation-free Special Relativity (SR) Lorentz aberration &
 *    relativistic Doppler factor D = 1 / (gamma * (1 - beta * mu')) in both
 *    forward and aft hemispheres, valid up to eta = 7.65 (gamma > 1000).
 *  - Spectral-continuous CIE-1931 Planck Doppler chromaticity transfer with
 *    monotonic 555 nm visible-band Planck radiance ratio, soft HDR knee,
 *    Far-IR galactic dust thermal shift (D > 28), and aft UV OB disk glow.
 *  - Ship-frame pixel-locked Airy/Moffat pinpoint starfield across 3 stellar
 *    populations (Main Sequence, L/T Brown Dwarfs, UV O-stars/White Dwarfs)
 *    with Milky Way galactic-plane density weighting.
 *  - C-infinity smooth cosmological CMB fireball with exact Solar dipole
 *    (0.001233) and 3-octave Planck acoustic mottling.
 *  - NASA / Interstellar-grade Penrose-Terrell 3D periodic corridor (CELL_Z = 34.0,
 *    mod-16 seamless periodicity across 544.0): dual-flange I-beam Metrology Gate,
 *    Voyager/JWST Interferometer Probe, and pure cratered carbonaceous/silicate
 *    Asteroid shaded with Cook-Torrance GGX PBR, 4-step vacuum shadows & 3-tap AO.
 *  - Physical volumetric ISM H-alpha / O-III & reflection dust cirrus with
 *    Henyey-Greenstein forward scattering (g = 0.58) and crisp 3D parallax glints.
 *  - Explicit LOD/Grad/Fetch sampling: uVolumeNoise & uBlackbodyLut use
 *    textureLod at LOD 0; uBlueNoise uses texelFetch; sky derivatives run in
 *    uniform control flow with textureGrad.
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
const float PLANCK_VIS_K   = 25920.0;             // h*c / (555 nm * k_B)
const float CELL_Z         = 34.0;
const float MAX_TRACE_DIST = 115.0;
const float VOL_MAX_DIST   = 84.0;
const vec3  LUMA_W         = vec3(0.2126, 0.7152, 0.0722);

// ============================================================================
// 1. IEEE-754 SANITIZER, PLANCK BLACKBODY & SPECTRAL DOPPLER TRANSFER
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
  return clamp(clean, vec3(0.0), vec3(32.0));
}

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureLod(uBlackbodyLut, vec2(uCoord, 0.5), 0.0).rgb;
}

// Overflow-free ln(exp(x) - 1) valid across all x > 0 (from 50 K to 10^7 K)
float logExpm1(float x) {
  if (x > 20.0) {
    return x;
  }
  if (x < 0.01) {
    float xs = max(x, 1e-6);
    return log(xs) + 0.5 * xs;
  }
  return x + log(max(1.0 - exp(-x), 1e-7));
}

// Physically monotonic Planck 555 nm visible-band radiance ratio with C1-smooth
// photographic HDR knee for relativistic headlight beaming & Wien redshift cutoff
float evalPlanckBeam(float tBase, float dBeam, float beamingGain) {
  float t0 = max(tBase, 250.0);
  float d = max(dBeam, 1e-4);
  float t1 = max(t0 * d, 40.0);

  float logR = logExpm1(PLANCK_VIS_K / t0) - logExpm1(PLANCK_VIS_K / t1);
  float baseRatio;
  if (logR >= 0.0) {
    float rawGain = exp(min(logR * 0.572, 12.0));
    float excess = rawGain - 1.0;
    baseRatio = 1.0 + excess / (1.0 + excess / 11.2);
  } else {
    float absL = -logR;
    baseRatio = exp(-0.55 * absL / (1.0 + 0.16 * absL) - 0.022 * absL);
  }
  return pow(max(baseRatio, 1e-5), clamp(beamingGain, 0.0, 2.0));
}

vec3 evalPlanckChroma(float tObs) {
  vec3 bbRaw = sampleBlackbody(tObs);
  // Deepen sub-800 K Wien tail toward velvety ruby-crimson
  vec3 deepRed = mix(vec3(1.0, 0.024, 0.002), bbRaw, smoothstep(260.0, 820.0, tObs));
  // Subtle electric sapphire-white tint at extreme relativistic blueshift (> 35,000 K)
  vec3 hotBlue = mix(deepRed, vec3(0.32, 0.56, 1.00), smoothstep(32000.0, 120000.0, tObs) * 0.26);
  float luma = max(dot(hotBlue, LUMA_W), 0.05);
  return hotBlue / luma;
}

vec3 applyRelativisticShift(
  vec3 baseCol,
  float tBase,
  float dColor,
  float dBeam,
  float beamingGain,
  float beamMix
) {
  float dSafe = max(dColor, 1e-4);
  float tObs = tBase * dSafe;
  vec3 bbObs = evalPlanckChroma(tObs);
  float baseLuma = dot(baseCol, LUMA_W);

  float shiftMix = 1.0 - exp(-abs(log(dSafe)) * 1.45);
  vec3 shiftedChroma = mix(baseCol, bbObs * baseLuma, shiftMix);

  float planckBeam = evalPlanckBeam(tBase, dBeam, beamingGain);
  float gain = mix(1.0, planckBeam, beamMix);
  return max(shiftedChroma * gain, vec3(0.0));
}

// Smooth perceptual spectral locus (380..740 nm) for true emission-line Doppler shift
vec3 wavelengthToRgb(float nm) {
  if (nm < 375.0 || nm > 740.0) {
    return vec3(0.0);
  }
  float dr = (nm - 605.0) / 46.0;
  float dv = (nm - 435.0) / 24.0;
  float dg = (nm - 538.0) / 42.0;
  float db = (nm - 452.0) / 30.0;
  float r = exp(-0.5 * dr * dr) + 0.24 * exp(-0.5 * dv * dv);
  float g = exp(-0.5 * dg * dg);
  float b = exp(-0.5 * db * db);
  float edge = smoothstep(375.0, 415.0, nm) * (1.0 - smoothstep(670.0, 740.0, nm));
  return vec3(r, g, b) * edge;
}

vec3 rotateSkyDir(vec3 d, vec2 rot) {
  float cy = cos(rot.x);
  float sy = sin(rot.x);
  vec3 r1 = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  float cp = cos(rot.y);
  float sp = sin(rot.y);
  return vec3(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

vec3 hash33f(vec3 pIn) {
  vec3 p = fract(pIn * vec3(0.1031, 0.1030, 0.0973));
  p += vec3(dot(p, p.yxz + vec3(33.33)));
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ============================================================================
// 2. PIXEL-LOCKED PINPOINT STARFIELD, SPECTRAL SKY & SMOOTH CMB FIREBALL
// ============================================================================

vec3 evalSpectralStarLayer(
  vec3 dir,
  float galWeight,
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
  if (lodFade <= 0.002) {
    return vec3(0.0);
  }

  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);

  // Weight star density toward the Milky Way galactic plane plus isotropic halo stars
  float effThresh = clamp(densityThresh - galWeight * 0.088, 0.58, 0.985);
  if (rnd.x < effThresh) {
    return vec3(0.0);
  }

  vec3 starPos = cell + vec3(0.25) + 0.50 * hash33f(cell + vec3(19.17, 73.41, 41.83));
  float dist = length(p - starPos);

  // Cleanly mask to zero before cell boundary (dist = 0.22) so zero square clipping occurs
  float cellMask = 1.0 - smoothstep(0.11, 0.22, dist);
  if (cellMask <= 0.001) {
    return vec3(0.0);
  }

  float magU = clamp((rnd.x - effThresh) / max(1.0 - effThresh, 1e-4), 0.0, 1.0);
  float mag2 = magU * magU;
  float mag = mag2 * mag2 * sqrt(magU);

  // Measure star PSF strictly in ship-frame pixels: crisp 1-2 px Airy/Moffat pinpoints
  float pxDist = dist / max(cellFw, 1e-5);
  float corePx = mix(0.46, 0.96, mag);
  float core = exp(-min((pxDist * pxDist) / (corePx * corePx), 36.0));
  float psf = core;
  if (mag > 0.35) {
    float brightFrac = (mag - 0.35) / 0.65;
    float moffatR = mix(1.20, 2.25, brightFrac);
    float uM = pxDist / moffatR;
    float moffat = 1.0 / pow(1.0 + uM * uM, 2.35);
    psf += moffat * (0.10 * brightFrac);
  }
  psf *= cellMask;
  if (psf < 0.002) {
    return vec3(0.0);
  }

  float ry = max(rnd.y, 0.0);
  float tEmit;
  float bandpassGain;
  float beamFactor;

  if (spectralClass == 1) {
    // Cool L/T Brown Dwarfs (750K..1900K): ignite inside the forward headlight cone D > 1.3
    tEmit = mix(750.0, 1900.0, ry);
    float fwdIgnite = smoothstep(1.30, 2.45, doppler);
    bandpassGain = fwdIgnite * uvIrGain * 1.95;
    float irBeam = evalPlanckBeam(2600.0, max(doppler * 0.55, 1.0), beamingGain);
    beamFactor = mix(1.0, irBeam, 0.65);
  } else if (spectralClass == 2) {
    // Hot UV O/B stars & White Dwarfs (14000K..95000K): crisp warm-amber to sapphire-white aft pinpoints
    tEmit = mix(14000.0, 95000.0, ry * ry);
    float aftWindow = smoothstep(0.018, 0.044, doppler) * (1.0 - smoothstep(0.45, 0.68, doppler));
    float restTrace = 0.055 * smoothstep(0.68, 1.02, doppler) * (1.0 - smoothstep(1.45, 2.8, doppler));
    bandpassGain = restTrace + aftWindow * uvIrGain * 2.25;
    float uvBeam = mix(0.85, 1.40, smoothstep(0.025, 0.35, doppler));
    beamFactor = pow(max(uvBeam, 1e-4), clamp(beamingGain, 0.0, 2.0));
  } else {
    // Main sequence OBAFGKM (2800K..22000K)
    tEmit = 2800.0 * exp((ry * ry * 0.84 + ry * 0.16) * 2.061423);
    bandpassGain = 1.0;
    float msBeam = evalPlanckBeam(tEmit, doppler, beamingGain);
    beamFactor = mix(1.0, msBeam, 0.88);
  }

  if (bandpassGain <= 0.002) {
    return vec3(0.0);
  }

  float tObs = tEmit * max(dColor, 1e-4);
  vec3 col = sampleBlackbody(tObs);
  if (tObs < 820.0) {
    col = mix(vec3(1.0, 0.03, 0.003), col, smoothstep(260.0, 820.0, tObs));
  } else if (tObs > 32000.0) {
    col = mix(col, vec3(0.48, 0.72, 1.00), smoothstep(32000.0, 120000.0, tObs) * 0.25);
  }

  float wienCut = (spectralClass == 1)
    ? smoothstep(520.0, 960.0, tObs)
    : smoothstep(240.0, 760.0, tObs);

  float antiAlias = 1.0 / (1.0 + cellFw * 1.45);
  float lum = (0.18 + 5.20 * mag) * boost * antiAlias * bandpassGain * beamFactor * wienCut * lodFade;
  return col * (psf * lum);
}

vec3 evalCmbShell(vec3 rdRest, float doppler, float cmbVisibility, float cmbTempScale) {
  if (cmbVisibility <= 0.001 || 2.7255 * max(cmbTempScale, 0.0) * doppler * 1.07 < 45.0) {
    return vec3(0.0);
  }

  // Multi-scale 3-octave Planck acoustic mottling (strictly LOD 0)
  vec4 n1 = textureLod(uVolumeNoise, rdRest * 4.5, 0.0);
  vec4 n2 = textureLod(uVolumeNoise, rdRest * 11.0 + vec3(0.23, 0.41, 0.17), 0.0);
  vec4 n3 = textureLod(uVolumeNoise, rdRest * 26.0 + vec3(0.67, 0.19, 0.53), 0.0);
  float acousticMottle = ((n1.r * 0.54 + n2.b * 0.30 + n3.g * 0.16) - 0.5) * 2.0;

  vec3 dipoleDir = normalize(vec3(0.45, 0.35, 0.82));
  float dipoleTerm = 0.001233 * dot(rdRest, dipoleDir);
  float mottle = 0.065 * acousticMottle;
  float tCmbObs = 2.7255 * max(cmbTempScale, 0.0) * doppler * (1.0 + dipoleTerm + mottle);

  if (tCmbObs < 45.0) {
    return vec3(0.0);
  }

  // C-infinity smooth Wien-like NIR thermal onset -> exact CIE-1931 optical blackbody
  float nirWien = exp(-560.0 / max(tCmbObs, 1.0));
  float nirLum = 11.5 * nirWien / (1.0 + 1.45 * nirWien);

  // Smooth C-infinity thermal color ramp: deep IR crimson (~115K) -> ember-gold (385K)
  float cWarm1 = 1.0 - exp(-max(tCmbObs - 60.0, 0.0) / 175.0);
  float cWarm2 = 1.0 - exp(-max(tCmbObs - 180.0, 0.0) / 340.0);
  vec3 thermalCol = mix(vec3(0.50, 0.022, 0.004), vec3(0.98, 0.24, 0.028), cWarm1);
  thermalCol = mix(thermalCol, vec3(1.00, 0.52, 0.11), cWarm2);

  // Seamless blend into exact CIE-1931 Planck blackbody above ~800 K (solar-white at eta=7.0..7.65)
  float optBlend = 1.0 - exp(-max(tCmbObs - 720.0, 0.0) / 1150.0);
  vec3 optCol = sampleBlackbody(tCmbObs);
  vec3 cmbTint = mix(thermalCol, optCol, optBlend);

  float optWien = exp(-2800.0 / max(tCmbObs, 1.0));
  float optLum = 18.0 * optWien / (1.0 + 0.55 * optWien);

  float totalLum = (nirLum + optLum) * (1.0 + 0.18 * acousticMottle) * cmbVisibility;
  return max(cmbTint * totalLum, vec3(0.0));
}

vec3 sampleSkyBackground(
  vec3 rdRest,
  vec3 dir,
  vec2 sampleUv,
  vec2 dUVdx,
  vec2 dUVdy,
  float pixelFwRest,
  float doppler,
  float dColor,
  float beamingGain,
  float skyIntensity,
  int skyMode,
  float starDensity,
  float uvIrGain,
  float cmbVisibility,
  float cmbTempScale
) {
  vec3 mapSrgb = (skyMode >= 1)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;

  vec3 skyLin = pow(max(mapSrgb, vec3(1e-5)), vec3(2.2));
  float rawSkyLuma = dot(skyLin, LUMA_W);

  // Preserve crisp dust-lane contrast & pure #000 deep-space black floor
  float blackFloorGate = smoothstep(0.0016, 0.032, rawSkyLuma);
  skyLin *= blackFloorGate;
  float coreBoost = max(rawSkyLuma - 0.14, 0.0);
  skyLin *= (1.0 + coreBoost * 1.65);

  // Reconstruct rest-frame effective temperature (~3200K warm bulge -> ~5800K disk -> ~10500K OB clouds)
  float rgbSum = max(skyLin.r + skyLin.g + skyLin.b, 1e-5);
  float chromaRB = clamp((skyLin.b - skyLin.r) / rgbSum, -0.55, 0.55);
  float tNorm = clamp(chromaRB * 1.43 + 0.50, 0.0, 1.0);
  float tBaseMw = 3200.0 * exp(tNorm * 1.188224); // 3200K * (10500/3200)^tNorm

  vec3 shiftedSky = applyRelativisticShift(skyLin, tBaseMw, dColor, dColor, beamingGain, 0.88);

  // Physically real Far-IR Galactic Dust Thermal Shift in dark extinction lanes (activates only for D > 28)
  if (dColor > 28.0) {
    float planeWeight = exp(-dir.y * dir.y * 42.0);
    float darkRift = 1.0 - smoothstep(0.015, 0.14, rawSkyLuma);
    vec4 dustN = textureLod(uVolumeNoise, dir * 4.2 + vec3(0.17, 0.53, 0.31), 0.0);
    float dustFil = smoothstep(0.26, 0.86, dustN.r * 0.56 + dustN.g * 0.44);
    float tDustRest = mix(30.0, 50.0, dustN.b);
    float tDustObs = tDustRest * dColor;
    float irOnset = smoothstep(28.0, 92.0, dColor) * smoothstep(950.0, 3100.0, tDustObs);
    vec3 dustCol = sampleBlackbody(tDustObs);
    float dustLum = 0.82 * planeWeight * darkRift * dustFil * irOnset * (0.50 + 0.50 * clamp(uvIrGain, 0.0, 2.5));
    shiftedSky += dustCol * dustLum;
  }

  // Subtle aft UV galactic-plane OB continuum glow (D in [0.025, 0.55])
  float aftUvWindow = smoothstep(0.025, 0.052, dColor) * (1.0 - smoothstep(0.32, 0.55, dColor));
  if (aftUvWindow > 0.001) {
    float galBand = exp(-dir.y * dir.y * 24.0);
    vec4 obN = textureLod(uVolumeNoise, dir * 3.8 + vec3(0.41, 0.13, 0.67), 0.0);
    float obStruct = 0.38 + 0.62 * smoothstep(0.20, 0.84, obN.r * 0.62 + obN.b * 0.38);
    float dustCarve = 0.24 + 1.65 * smoothstep(0.009, 0.17, rawSkyLuma);
    float tUvObs = mix(19000.0, 34000.0, obN.b) * dColor;
    vec3 uvBb = sampleBlackbody(tUvObs);
    vec3 garnetCol = mix(vec3(0.84, 0.095, 0.024), uvBb, smoothstep(950.0, 2900.0, tUvObs) * 0.48);
    float uvLum = aftUvWindow * galBand * obStruct * dustCarve * (0.14 + 0.11 * clamp(uvIrGain, 0.0, 2.5));
    shiftedSky += garnetCol * uvLum;
  }

  skyLin = shiftedSky;

  if (starDensity > 0.001) {
    float starGain = ((skyMode >= 1) ? 1.15 : 0.92) * starDensity;
    float galWeight = exp(-dir.y * dir.y * 16.0);
    vec3 stars = vec3(0.0);
    // Main sequence octaves (2800K..22000K)
    stars += evalSpectralStarLayer(dir, galWeight,  18.0, 0.800, 0.82 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.85);
    stars += evalSpectralStarLayer(dir, galWeight,  46.0, 0.882, 1.00 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.35);
    stars += evalSpectralStarLayer(dir, galWeight, 115.0, 0.902, 0.96 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.20);
    stars += evalSpectralStarLayer(dir, galWeight, 240.0, 0.892, 0.52 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 0, 1.15);
    // Cool L/T Brown Dwarfs (750K..1900K, forward headlight ignition D > 1.3)
    if (uvIrGain > 0.001 && doppler > 1.30) {
      stars += evalSpectralStarLayer(dir, galWeight,  22.0, 0.825, 0.95 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.75);
      stars += evalSpectralStarLayer(dir, galWeight,  64.0, 0.880, 1.22 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.30);
      stars += evalSpectralStarLayer(dir, galWeight, 150.0, 0.895, 1.00 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 1, 1.20);
    }
    // Hot UV O/B stars & White Dwarfs (14000K..95000K, crisp warm-to-sapphire aft pinpoints)
    if (doppler > 0.018 && doppler < 2.80) {
      stars += evalSpectralStarLayer(dir, galWeight,  38.0, 0.805, 1.35 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.50);
      stars += evalSpectralStarLayer(dir, galWeight,  96.0, 0.828, 1.65 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.25);
      stars += evalSpectralStarLayer(dir, galWeight, 210.0, 0.838, 1.30 * starGain, pixelFwRest, doppler, dColor, beamingGain, uvIrGain, 2, 1.15);
    }
    skyLin += stars;
  }

  vec3 cmbCol = evalCmbShell(rdRest, doppler, cmbVisibility, cmbTempScale);
  return skyLin * max(skyIntensity, 0.0) + cmbCol;
}

// ============================================================================
// 3. NASA / INTERSTELLAR-GRADE PENROSE-TERRELL 3D FOREGROUND CORRIDOR (REST S)
// ============================================================================

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCylinderZ(vec3 p, float r, float h) {
  vec2 d = vec2(length(p.xy) - r, abs(p.z) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2(0.0)));
}

float sdOctPrismZ(vec3 p, float r, float h) {
  vec2 ap = abs(p.xy);
  float octD = max(max(ap.x, ap.y), (ap.x + ap.y) * 0.70710678) - r;
  vec2 d = vec2(octD, abs(p.z) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2(0.0)));
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Object 0: Precision Relativistic Metrology Gate (R = 6.35 dual-flange I-beam, 24 ribs, 4 optical nodes)
float sdRingGate(vec3 p) {
  float rXY = length(p.xy);
  float dr = rXY - 6.35;
  float az = abs(p.z);

  // Dual-flange I-beam ring: dark recessed web + proud brushed-titanium inner/outer flanges
  vec2 qWeb = vec2(abs(dr) - 0.115, az - 0.165);
  float dWeb = length(max(qWeb, vec2(0.0))) + min(max(qWeb.x, qWeb.y), 0.0) - 0.012;

  vec2 qFlange = vec2(abs(abs(dr) - 0.118) - 0.026, az - 0.245);
  float dFlange = length(max(qFlange, vec2(0.0))) + min(max(qFlange.x, qFlange.y), 0.0) - 0.012;
  float dMin = min(dWeb, dFlange);

  // 24 sculpted radial bulkhead stiffening ribs (gated strictly inside ring radial annulus)
  if (abs(dr) <= 0.85) {
    float angle = (rXY > 1e-6) ? atan(p.y, p.x) : 0.0;
    const float SEC_24 = TAU / 24.0;
    float aRib = ((angle + 0.5 * SEC_24) - floor((angle + 0.5 * SEC_24) / SEC_24) * SEC_24) - 0.5 * SEC_24;
    vec3 pRib = vec3(rXY * cos(aRib) - 6.35, rXY * sin(aRib), p.z);
    float dRib = sdBox(pRib, vec3(0.140, 0.032, 0.220)) - 0.008;
    dMin = min(dMin, dRib);
  }

  // 4 sleek chamfered octagonal optical-interferometer nodes at cardinal points
  vec2 ap = abs(p.xy);
  vec2 mxy = (ap.x > ap.y) ? ap.xy : ap.yx;
  vec3 pNode = vec3(mxy.x - 6.44, mxy.y, p.z);
  float dNodeOct = sdOctPrismZ(pNode, 0.31, 0.39) - 0.022;
  // Recessed circular optical lens apertures on both bow (-Z) and stern (+Z) faces
  float dApertureCut = sdCylinderZ(vec3(pNode.x, pNode.y, abs(pNode.z) - 0.40), 0.135, 0.055);
  float dNodeBody = max(dNodeOct, -dApertureCut);
  // Recessed optical objective lens dome inside the baffle
  float dLens = length(vec3(pNode.x, pNode.y, abs(pNode.z) - 0.355)) - 0.118;
  // Slender radial stabilizer fin projecting outward from each cardinal node
  float dFin = sdBox(pNode - vec3(0.42, 0.0, 0.0), vec3(0.30, 0.026, 0.155)) - 0.008;

  float dNode = min(min(dNodeBody, dLens), dFin);
  return min(dMin, dNode);
}

// Object 1: Deep-Space Relativistic Interferometer Probe (NASA / Voyager / JWST silhouette)
float sdBeaconStation(vec3 p) {
  // Central chamfered octagonal spacecraft bus wrapped in gold-Kapton MLI + louver bays
  float dBus = sdOctPrismZ(p, 0.43, 0.46) - 0.024;
  // Seamless gimbal pedestal deck bridging bus to parabolic dish vertex (z in [-0.62, -0.44])
  float dDeck = sdCylinderZ(p - vec3(0.0, 0.0, -0.53), 0.28, 0.09) - 0.010;

  // Thin concave white-ceramic parabolic high-gain dish antenna opening forward (-Z)
  vec3 pd = p - vec3(0.0, 0.0, -0.60);
  float rD = length(pd.xy);
  float rClamp = min(rD, 0.72);
  float zSurf = -0.44 * rClamp * rClamp;
  float dz = pd.z - zSurf;
  float drEdge = max(rD - 0.72, 0.0);
  float invSlope = 1.0 / sqrt(1.0 + 0.7744 * rClamp * rClamp);
  float dDishShell = sqrt(dz * dz * invSlope * invSlope + drEdge * drEdge) - 0.018;
  float dDishRim = length(vec2(rD - 0.72, pd.z + 0.228)) - 0.024;
  float dDish = min(dDishShell, dDishRim);

  // Central feed horn + 3-leg tripod struts (exact 3-fold symmetry)
  float dHorn = sdCylinderZ(p - vec3(0.0, 0.0, -1.10), 0.072, 0.062) - 0.010;
  float aTri = (rD > 1e-6) ? atan(p.y, p.x) : 0.0;
  const float SEC_3 = TAU / 3.0;
  float aFold = ((aTri + 0.5 * SEC_3) - floor((aTri + 0.5 * SEC_3) / SEC_3) * SEC_3) - 0.5 * SEC_3;
  vec3 pTri = vec3(rD * cos(aFold), rD * sin(aFold), p.z);
  float dTripod = sdCapsule(pTri, vec3(0.60, 0.0, -0.77), vec3(0.05, 0.0, -1.10), 0.014);

  // Paper-thin photovoltaic solar arrays (~0.032 total thickness) on slender tubular booms
  float dBoom = sdCapsule(vec3(p.x, abs(p.y), p.z), vec3(0.0, 0.40, 0.04), vec3(0.0, 2.04, 0.04), 0.024);
  const float C15 = 0.96592583;
  const float S15 = 0.25881905;
  float pz = p.z - 0.04;
  vec3 pWing = vec3(C15 * p.x + S15 * pz, abs(p.y) - 1.40, -S15 * p.x + C15 * pz);
  float dSolar = sdBox(pWing, vec3(0.012, 0.62, 0.34)) - 0.004;

  // Recessed aft xenon ion-thruster nozzle bell seamlessly mounted to aft bulkhead (+Z)
  float zNoz = clamp((p.z - 0.46) / 0.46, 0.0, 1.0);
  float rBell = mix(0.155, 0.285, sqrt(zNoz));
  float dBellOut = max((rD - rBell) * 0.85, abs(p.z - 0.69) - 0.23);
  float dBellIn = max((rD - (rBell - 0.030)) * 0.85, -(p.z - 0.58));
  float dNozzle = max(dBellOut, -dBellIn) - 0.008;

  // Small forward star-tracker optical baffle & tiny navigation strobe mast
  float dTracker = sdCylinderZ(p - vec3(0.35, 0.33, -0.42), 0.062, 0.11) - 0.008;
  float dMast = sdCapsule(p, vec3(-0.30, 0.28, -0.30), vec3(-0.45, 0.47, -0.45), 0.011);
  float dStrobe = length(p - vec3(-0.46, 0.48, -0.46)) - 0.030;

  float dCore = min(min(dBus, dDeck), min(dNozzle, dTracker));
  float dAnt = min(dDish, min(dHorn, dTripod));
  float dWings = min(dBoom, dSolar);
  float dNav = min(dMast, dStrobe);
  return min(min(dCore, dAnt), min(dWings, dNav));
}

struct AsteroidParams {
  mat3  rot;
  vec3  invAxes;
  vec3  invAxes2;
  float minAxis;
  vec3  seedOff;
};

AsteroidParams defaultAsteroidParams() {
  return AsteroidParams(mat3(1.0), vec3(1.0), vec3(1.0), 1.0, vec3(0.0));
}

// Per-cell deterministic 3D orientation, triaxial axes & regolith seed precomputed once per march/shade
AsteroidParams makeAsteroidParams(int cellMod) {
  float fm = float(cellMod);
  vec3 h = hash33f(vec3(fm * 1.73 + 5.1, fm * 2.91 + 13.7, fm * 4.19 + 29.3));
  float yaw = h.x * TAU;
  float pitch = (h.y - 0.5) * 2.4;
  float roll = h.z * TAU;

  float cy = cos(yaw); float sy = sin(yaw);
  float cp = cos(pitch); float sp = sin(pitch);
  float cr = cos(roll); float sr = sin(roll);

  vec3 ha = hash33f(vec3(fm * 5.31 + 2.7, fm * 1.17 + 17.9, fm * 3.83 + 41.1));
  vec3 axes = vec3(
    mix(0.96, 1.44, ha.x),
    mix(0.78, 1.16, ha.y),
    mix(1.02, 1.50, ha.z)
  );

  AsteroidParams ap;
  ap.rot = mat3(
    vec3(cr * cy - sr * sp * sy, sr * cy + cr * sp * sy, -cp * sy),
    vec3(-sr * cp, cr * cp, sp),
    vec3(cr * sy + sr * sp * cy, sr * sy - cr * sp * cy, cp * cy)
  );
  ap.invAxes = vec3(1.0) / axes;
  ap.invAxes2 = ap.invAxes * ap.invAxes;
  ap.minAxis = min(axes.x, min(axes.y, axes.z));
  ap.seedOff = hash33f(vec3(fm * 2.13 + 9.4, fm * 3.67 + 1.9, fm * 1.41 + 27.5)) * 0.77;
  return ap;
}

float evalHeroCrater(vec3 uDir, vec3 axis, float angRad, float depth) {
  float d = length(uDir - axis) / angRad;
  if (d >= 1.55) {
    return 0.0;
  }
  float bowl = -depth * max(1.0 - d * d, 0.0);
  float dr = d - 1.06;
  float rim = depth * 0.34 * exp(-(dr * dr) / 0.030);
  return bowl + rim;
}

const vec3 CRATER_AXIS_0 = vec3( 0.619845,  0.439890, -0.649838);
const vec3 CRATER_AXIS_1 = vec3(-0.699127,  0.299626,  0.649189);
const vec3 CRATER_AXIS_2 = vec3(-0.219813, -0.819304, -0.529550);
const vec3 CRATER_AXIS_3 = vec3( 0.349215, -0.419058,  0.838116);
const vec3 CRATER_AXIS_4 = vec3(-0.540324,  0.760456, -0.360216);

// Object 2: Pure Cratered Carbonaceous/Silicate Rubble-Pile Asteroid (ZERO glued pods!)
float sdFacetedAsteroid(vec3 p, AsteroidParams ap) {
  vec3 pa = ap.rot * p;

  float k0 = length(pa * ap.invAxes);
  float k1 = length(pa * ap.invAxes2);
  float dEllip = (k0 > 1e-4) ? (k0 * (k0 - 1.0) / max(k1, 1e-5)) : -ap.minAxis;
  if (dEllip > 0.42) {
    return dEllip - 0.38;
  }

  // Broad geological facets & ridges from 128^3 3D Perlin + ridged multifractal
  vec4 nMacro = textureLod(uVolumeNoise, pa * 0.25 + ap.seedOff, 0.0);
  vec4 nCell = textureLod(uVolumeNoise, pa * 0.62 + ap.seedOff * 1.63, 0.0);

  float broadDisp = (nMacro.r - 0.5) * 0.30 + (nMacro.g - 0.45) * 0.22;

  // Secondary Worley cellular pockmarks with raised ejecta rims
  float cRad = clamp(1.0 - nCell.b, 0.0, 1.0);
  float smallBowl = -0.070 * max(1.0 - (cRad / 0.36) * (cRad / 0.36), 0.0);
  float sRimD = cRad - 0.40;
  float smallRim = 0.022 * exp(-(sRimD * sRimD) / 0.0055);

  // 5 deterministic concave hero impact craters with raised rims
  float paLen = length(pa);
  vec3 uDir = (paLen > 1e-5) ? (pa / max(paLen, 1e-5)) : vec3(0.0, 0.0, 1.0);
  float heroCraters = 0.0;
  heroCraters += evalHeroCrater(uDir, CRATER_AXIS_0, 0.48, 0.135);
  heroCraters += evalHeroCrater(uDir, CRATER_AXIS_1, 0.42, 0.115);
  heroCraters += evalHeroCrater(uDir, CRATER_AXIS_2, 0.38, 0.105);
  heroCraters += evalHeroCrater(uDir, CRATER_AXIS_3, 0.34, 0.092);
  heroCraters += evalHeroCrater(uDir, CRATER_AXIS_4, 0.30, 0.082);

  return (dEllip - broadDisp - smallBowl - smallRim - heroCraters) * 0.68;
}

float evalObjSdf(vec3 pLocal, int objId, AsteroidParams astP) {
  if (objId == 0) {
    return sdRingGate(pLocal);
  }
  if (objId == 1) {
    return sdBeaconStation(pLocal);
  }
  return sdFacetedAsteroid(pLocal, astP);
}

vec3 calcObjNormal(vec3 pLocal, int objId, AsteroidParams astP) {
  const float eps = 0.0032;
  vec3 n = vec3( 1.0, -1.0, -1.0) * evalObjSdf(pLocal + vec3( 1.0, -1.0, -1.0) * eps, objId, astP)
         + vec3(-1.0, -1.0,  1.0) * evalObjSdf(pLocal + vec3(-1.0, -1.0,  1.0) * eps, objId, astP)
         + vec3(-1.0,  1.0, -1.0) * evalObjSdf(pLocal + vec3(-1.0,  1.0, -1.0) * eps, objId, astP)
         + vec3( 1.0,  1.0,  1.0) * evalObjSdf(pLocal + vec3( 1.0,  1.0,  1.0) * eps, objId, astP);
  float len = length(n);
  return (len > 1e-6) ? (n / max(len, 1e-6)) : vec3(0.0, 0.0, 1.0);
}

vec2 intersectSphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) {
    return vec2(1e9, -1e9);
  }
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

struct HitInfo {
  bool hit;
  float t;
  int objId;
  int cellMod;
  vec3 localPos;
};

HitInfo marchObject(
  vec3 ro,
  vec3 rd,
  vec3 center,
  float radius,
  float tMin,
  float tMax,
  int objId,
  int cellMod,
  float zSlabHalf
) {
  HitInfo res;
  res.hit = false;
  res.t = tMax;
  res.objId = objId;
  res.cellMod = cellMod;
  res.localPos = vec3(0.0);

  vec2 sp = intersectSphere(ro, rd, center, radius);
  float t0 = max(tMin, sp.x);
  float t1 = min(tMax, sp.y);

  if (zSlabHalf > 0.0) {
    if (abs(rd.z) > 1e-5) {
      float tzA = (center.z - zSlabHalf - ro.z) / rd.z;
      float tzB = (center.z + zSlabHalf - ro.z) / rd.z;
      t0 = max(t0, min(tzA, tzB));
      t1 = min(t1, max(tzA, tzB));
    } else if (abs(ro.z - center.z) > zSlabHalf) {
      return res;
    }
  }

  if (t0 >= t1) {
    return res;
  }

  AsteroidParams astP = defaultAsteroidParams();
  if (objId == 2) {
    astP = makeAsteroidParams(cellMod);
  }

  float t = t0;
  float stepFactor = (objId == 0) ? 0.90 : 0.76;
  for (int i = 0; i < 46; ++i) {
    vec3 pLocal = (ro + t * rd) - center;
    float d = evalObjSdf(pLocal, objId, astP);
    if (d < 0.0020 * max(1.0, t * 0.035)) {
      res.hit = true;
      res.t = t;
      res.localPos = pLocal;
      return res;
    }
    t += max(d * stepFactor, 0.005);
    if (t > t1) {
      break;
    }
  }
  return res;
}

HitInfo traceCorridorGeometry(vec3 ro, vec3 rd) {
  HitInfo best;
  best.hit = false;
  best.t = MAX_TRACE_DIST;
  best.objId = -1;
  best.cellMod = 0;
  best.localPos = vec3(0.0);

  int kBase = int(floor(ro.z / CELL_Z));
  int stepK = (rd.z >= 0.0) ? 1 : -1;

  for (int c = 0; c < 5; ++c) {
    int cellK = kBase + stepK * c;
    int cellMod = cellK & 15;
    float cellZ = float(cellK) * CELL_Z;

    // Conservative Z-slab early termination for distant cells
    if (c >= 2) {
      float distZ = (stepK > 0) ? max(0.0, cellZ - ro.z) : max(0.0, ro.z - (cellZ + CELL_Z));
      if (distZ > best.t * abs(rd.z) + 1.0) {
        break;
      }
    }

    // Object 0: Precision Relativistic Metrology Gate phase-offset to cellZ + 17.0
    HitInfo h0 = marchObject(ro, rd, vec3(0.0, 0.0, cellZ + 17.0), 7.35, 0.4, best.t, 0, cellMod, 0.58);
    if (h0.hit && h0.t < best.t) {
      best = h0;
    }

    // Deterministic mod-16 per-cell flanking offsets (central tunnel r_xy < 5.6 strictly clear)
    float fm = float(cellMod);
    vec3 hProbe = hash33f(vec3(fm * 1.37 + 3.1, fm * 2.71 + 7.3, fm * 0.89 + 11.7));
    float probeX = -(8.15 + 1.15 * hProbe.x);
    float probeY = mix(-1.45, 1.15, hProbe.y);
    float probeZ = cellZ + 8.5 + (hProbe.z - 0.5) * 3.2;

    HitInfo h1 = marchObject(ro, rd, vec3(probeX, probeY, probeZ), 2.30, 0.4, best.t, 1, cellMod, 0.0);
    if (h1.hit && h1.t < best.t) {
      best = h1;
    }

    vec3 hAst = hash33f(vec3(fm * 3.17 + 19.3, fm * 1.93 + 5.7, fm * 4.11 + 23.1));
    float astX = 7.95 + 1.35 * hAst.x;
    float astY = mix(-1.30, 2.05, hAst.y);
    float astZ = cellZ + 23.8 + (hAst.z - 0.5) * 4.6;

    HitInfo h2 = marchObject(ro, rd, vec3(astX, astY, astZ), 1.95, 0.4, best.t, 2, cellMod, 0.0);
    if (h2.hit && h2.t < best.t) {
      best = h2;
    }
  }

  return best;
}

// ============================================================================
// 4. COOK-TORRANCE GGX PBR, VACUUM SELF-SHADOWS & MICRO-NORMAL PERTURBATION
// ============================================================================

float distributionGGX(float ndh, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 1e-5);
}

float geometrySchlickGGX(float ndv, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) * 0.125;
  return ndv / max(ndv * (1.0 - k) + k, 1e-5);
}

float geometrySmith(float ndv, float ndl, float roughness) {
  return geometrySchlickGGX(ndv, roughness) * geometrySchlickGGX(ndl, roughness);
}

vec3 fresnelSchlick(float cosTheta, vec3 f0) {
  float m = clamp(1.0 - cosTheta, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (vec3(1.0) - f0) * (m2 * m2 * m);
}

float calcSoftShadow(vec3 p, vec3 lDir, int objId, AsteroidParams astP) {
  float sh = 1.0;
  float t = 0.045;
  for (int i = 0; i < 4; ++i) {
    float h = evalObjSdf(p + lDir * t, objId, astP);
    sh = min(sh, clamp(10.0 * h / max(t, 0.02), 0.0, 1.0));
    t += clamp(h, 0.07, 0.38);
  }
  return clamp(sh, 0.0, 1.0);
}

float calcObjAO(vec3 p, vec3 n, int objId, AsteroidParams astP) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 1; i <= 3; ++i) {
    float h = 0.05 + 0.11 * float(i);
    float d = evalObjSdf(p + n * h, objId, astP);
    occ += max(h - d, 0.0) * sca;
    sca *= 0.65;
  }
  return clamp(1.0 - 2.35 * occ, 0.10, 1.0);
}

// 3-tap finite-difference bump perturbation using 128^3 volume noise (strictly LOD 0)
vec3 evalVolumeBump(vec3 p, float freq, float amp) {
  float e = 0.014;
  vec3 uv = p * freq;
  vec4 c0 = textureLod(uVolumeNoise, uv, 0.0);
  vec4 cx = textureLod(uVolumeNoise, uv + vec3(e, 0.0, 0.0), 0.0);
  vec4 cy = textureLod(uVolumeNoise, uv + vec3(0.0, e, 0.0), 0.0);
  vec4 cz = textureLod(uVolumeNoise, uv + vec3(0.0, 0.0, e), 0.0);
  float h0 = c0.g * 0.60 + c0.a * 0.40;
  float hx = cx.g * 0.60 + cx.a * 0.40;
  float hy = cy.g * 0.60 + cy.a * 0.40;
  float hz = cz.g * 0.60 + cz.a * 0.40;
  return vec3(hx - h0, hy - h0, hz - h0) * (amp / e);
}

vec3 shadeForegroundHit(
  HitInfo h,
  vec3 rdRest,
  float dColor,
  float beamingGain,
  float geometryVisibility
) {
  vec3 p = h.localPos;
  AsteroidParams astP = defaultAsteroidParams();
  if (h.objId == 2) {
    astP = makeAsteroidParams(h.cellMod);
  }
  vec3 nGeo = calcObjNormal(p, h.objId, astP);
  vec3 v = -rdRest;

  vec3 albedo = vec3(0.20, 0.22, 0.26);
  float metallic = 0.50;
  float roughness = 0.45;
  vec3 emissive = vec3(0.0);
  float emTemp = 6500.0;
  vec3 nBump = vec3(0.0);

  if (h.objId == 0) {
    // Precision Relativistic Metrology Gate materials
    float rXY = length(p.xy);
    float dr = rXY - 6.35;
    float angle = (rXY > 1e-6) ? atan(p.y, p.x) : 0.0;
    vec2 ap = abs(p.xy);
    vec2 mxy = (ap.x > ap.y) ? ap.xy : ap.yx;
    vec3 pNode = vec3(mxy.x - 6.44, mxy.y, p.z);
    bool onNode = (mxy.x > 6.08) && (mxy.y < 0.38);

    if (onNode) {
      float rLens = length(pNode.xy);
      bool inAperture = (rLens < 0.140) && (abs(pNode.z) > 0.26);
      bool onFin = (pNode.x > 0.31) && (abs(pNode.y) < 0.045);
      if (inAperture) {
        // Coated interferometer objective lens glass + tiny recessed optical beacon
        albedo = vec3(0.03, 0.05, 0.08);
        metallic = 0.08;
        roughness = 0.06;
        float spot = 1.0 - smoothstep(0.025, 0.095, rLens);
        if (p.z < -0.26) {
          emissive = vec3(0.52, 0.90, 1.00) * (spot * 2.1);
          emTemp = 10500.0;
        } else if (p.z > 0.26) {
          emissive = vec3(1.00, 0.56, 0.16) * (spot * 2.1);
          emTemp = 2800.0;
        }
      } else if (onFin) {
        // Dark carbon-titanium stabilizer fin
        albedo = vec3(0.09, 0.10, 0.12);
        metallic = 0.45;
        roughness = 0.46;
      } else if (abs(pNode.z) < 0.34) {
        // Crinkled gold-Kapton MLI thermal blanket wrapping the 4 octagonal nodes
        albedo = vec3(0.88, 0.61, 0.13);
        metallic = 0.94;
        roughness = 0.26;
        nBump = evalVolumeBump(pNode, 4.8, 0.042);
      } else {
        // Anodized dark-titanium optical bezel ring
        albedo = vec3(0.14, 0.15, 0.18);
        metallic = 0.82;
        roughness = 0.34;
      }
    } else {
      // I-beam ring: dark recessed carbon-titanium web + brushed titanium flanges & 24 ribs
      const float SEC_24 = TAU / 24.0;
      float aRib = ((angle + 0.5 * SEC_24) - floor((angle + 0.5 * SEC_24) / SEC_24) * SEC_24) - 0.5 * SEC_24;
      bool onRib = abs(rXY * sin(aRib)) < 0.042;
      bool onFlange = abs(dr) > 0.082 || abs(p.z) > 0.195;

      if (onFlange || onRib) {
        // Brushed aerospace titanium alloy with subtle circumferential milling grain
        float grain = 0.92 + 0.08 * sin(angle * 180.0 + dr * 95.0);
        albedo = vec3(0.42, 0.45, 0.50) * grain;
        metallic = 0.88;
        roughness = 0.30;
        nBump = evalVolumeBump(vec3(angle * 2.4, dr * 12.0, p.z * 8.0), 1.6, 0.012);
      } else {
        // Dark carbon-titanium structural web
        albedo = vec3(0.065, 0.072, 0.084);
        metallic = 0.36;
        roughness = 0.56;
        // Razor-thin hairline optical calibration slits on bow (-Z) & stern (+Z) faces
        float hairline = (1.0 - smoothstep(0.004, 0.018, abs(dr))) * (onRib ? 0.0 : 1.0);
        if (p.z < -0.155 && hairline > 0.01) {
          emissive = vec3(0.55, 0.92, 1.00) * (hairline * 2.4);
          emTemp = 10500.0;
        } else if (p.z > 0.155 && hairline > 0.01) {
          emissive = vec3(1.00, 0.58, 0.18) * (hairline * 2.4);
          emTemp = 2800.0;
        }
      }
    }
  } else if (h.objId == 1) {
    // Deep-Space Relativistic Interferometer Probe materials
    float rXY = length(p.xy);
    float distStrobe = length(p - vec3(-0.46, 0.48, -0.46));

    if (distStrobe < 0.045) {
      // Tiny crisp navigation strobe pinpoint
      albedo = vec3(0.85, 0.92, 1.0);
      metallic = 0.1;
      roughness = 0.15;
      emissive = vec3(0.68, 0.94, 1.00) * 3.0;
      emTemp = 10500.0;
    } else if (p.z < -0.54) {
      // Concave NASA white-ceramic parabolic high-gain dish + dark titanium tripod & feed horn
      bool onHornOrTripod = (p.z < -0.88) || (rXY < 0.10 && p.z < -0.68);
      vec3 pd = p - vec3(0.0, 0.0, -0.60);
      float zParab = -0.44 * min(rXY, 0.72) * min(rXY, 0.72);
      bool onDishSurf = abs(pd.z - zParab) < 0.048;
      if (onDishSurf && !onHornOrTripod) {
        float angD = (rXY > 1e-6) ? atan(p.y, p.x) : 0.0;
        float seam = smoothstep(0.96, 0.995, abs(cos(angD * 6.0)));
        albedo = mix(vec3(0.84, 0.85, 0.86), vec3(0.62, 0.64, 0.67), seam * 0.45);
        metallic = 0.04;
        roughness = 0.42;
        nBump = evalVolumeBump(p, 5.5, 0.008);
      } else {
        // Dark titanium tripod struts, gimbal neck & feed horn
        albedo = vec3(0.16, 0.18, 0.21);
        metallic = 0.84;
        roughness = 0.34;
      }
    } else if (abs(p.y) > 0.72) {
      // Paper-thin photovoltaic solar arrays with fine procedural silicon-cell grid & glass specular
      const float C15 = 0.96592583;
      const float S15 = 0.25881905;
      float pz = p.z - 0.04;
      float uWing = -S15 * p.x + C15 * pz;
      float vWing = abs(p.y) - 1.40;
      bool onFrame = abs(uWing) > 0.315 || abs(vWing) > 0.595 || abs(vWing - 0.20) < 0.014 || abs(vWing + 0.20) < 0.014;
      bool onBoom = rXY < 0.045 && abs(p.z - 0.04) < 0.045;

      if (onBoom || onFrame) {
        albedo = vec3(0.28, 0.31, 0.36);
        metallic = 0.86;
        roughness = 0.34;
      } else {
        float cellU = abs(fract(uWing * 18.0) - 0.5);
        float cellV = abs(fract(vWing * 14.0) - 0.5);
        float fineBus = smoothstep(0.46, 0.495, max(cellU, cellV));
        float microGrid = smoothstep(0.47, 0.50, abs(fract(uWing * 72.0) - 0.5));
        albedo = mix(vec3(0.022, 0.045, 0.115), vec3(0.55, 0.60, 0.68), fineBus * 0.72 + microGrid * 0.18);
        metallic = mix(0.18, 0.85, fineBus);
        roughness = mix(0.11, 0.30, fineBus);
        nBump = vec3(0.0, (cellV - 0.25) * 0.06 * fineBus, (cellU - 0.25) * 0.06 * fineBus);
      }
    } else if (p.z > 0.47) {
      // Recessed aft xenon ion-thruster nozzle bell
      bool inIonCore = (rXY < 0.175) && (p.z < 0.65) && (p.z > 0.50);
      albedo = vec3(0.13, 0.13, 0.16);
      metallic = 0.88;
      roughness = 0.36;
      if (inIonCore) {
        float ionGlow = 1.0 - smoothstep(0.02, 0.175, rXY);
        emissive = vec3(0.56, 0.48, 1.00) * (ionGlow * 1.9);
        emTemp = 16000.0;
      }
    } else {
      // Octagonal spacecraft bus: crinkled gold-Kapton MLI + dark slotted radiator louvers + booms/masts
      bool onRadiator = (abs(p.x) > 0.34) && (abs(p.y) < 0.24) && (abs(p.z) < 0.32);
      bool onBoomRoot = (abs(p.y) > 0.45) && (abs(p.x) < 0.05) && (abs(p.z - 0.04) < 0.05);
      bool onTrackerOrMast = (p.x > 0.25 && p.y > 0.22 && p.z < -0.26) || (p.x < -0.28 && p.y > 0.26 && p.z < -0.28);
      if (onRadiator) {
        float louver = 0.5 + 0.5 * sin(p.z * 78.0);
        albedo = mix(vec3(0.04, 0.045, 0.055), vec3(0.14, 0.15, 0.17), louver);
        metallic = 0.35;
        roughness = 0.68;
        nBump = vec3(0.0, 0.0, cos(p.z * 78.0) * 0.24);
      } else if (onBoomRoot || onTrackerOrMast) {
        albedo = vec3(0.15, 0.17, 0.20);
        metallic = 0.82;
        roughness = 0.35;
      } else {
        // Authentic crinkled gold-Kapton MLI thermal foil
        albedo = vec3(0.90, 0.62, 0.12);
        metallic = 0.94;
        roughness = 0.25;
        nBump = evalVolumeBump(p, 5.2, 0.048);
      }
    }
  } else {
    // Object 2: Pure Cratered Carbonaceous/Silicate Asteroid (albedo ~ 0.07..0.18, roughness ~ 0.92)
    vec3 pa = astP.rot * p;

    vec4 nMacro = textureLod(uVolumeNoise, pa * 0.35 + astP.seedOff, 0.0);
    vec4 nFine = textureLod(uVolumeNoise, pa * 2.60 + astP.seedOff * 2.1, 0.0);
    float mineral = clamp(nMacro.r * 0.52 + nMacro.g * 0.28 + nFine.a * 0.20, 0.0, 1.0);
    float ejectaTint = smoothstep(0.55, 0.88, nMacro.b);

    albedo = mix(vec3(0.068, 0.065, 0.062), vec3(0.172, 0.158, 0.144), mineral);
    albedo = mix(albedo, vec3(0.185, 0.178, 0.168), ejectaTint * 0.28);
    metallic = 0.02;
    roughness = 0.92;
    // High-frequency dusty regolith micro-bump normal perturbation
    nBump = evalVolumeBump(pa + astP.seedOff, 2.5, 0.036) + evalVolumeBump(pa + astP.seedOff * 1.7, 6.2, 0.016);
  }

  vec3 n = normalize(nGeo + nBump - nGeo * dot(nBump, nGeo));

  // Crisp raking side-key solar light + 4-step SDF vacuum soft shadows + 3-tap AO
  vec3 keyDir = normalize(vec3(0.82, 0.52, -0.24));
  float ndl = max(dot(n, keyDir), 0.0);
  float ndv = max(dot(n, v), 1e-4);
  vec3 halfRaw = keyDir + v;
  vec3 halfV = (dot(halfRaw, halfRaw) > 1e-8) ? normalize(halfRaw) : n;
  float ndh = max(dot(n, halfV), 0.0);
  float vdh = max(dot(v, halfV), 0.0);

  float shadow = 0.0;
  if (ndl > 0.002) {
    shadow = calcSoftShadow(p + nGeo * 0.015, keyDir, h.objId, astP);
  }
  float ao = calcObjAO(p, nGeo, h.objId, astP);

  // Cook-Torrance GGX direct solar BRDF
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  float D = distributionGGX(ndh, roughness);
  float G = geometrySmith(ndv, max(ndl, 1e-4), roughness);
  vec3 F = fresnelSchlick(vdh, f0);
  vec3 spec = (D * G * F) / max(4.0 * ndv * max(ndl, 1e-4), 1e-4);
  vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
  vec3 sunRadiance = vec3(3.05, 2.94, 2.80);
  vec3 directLight = (kD * albedo * INV_PI + spec) * sunRadiance * (ndl * shadow);

  // Deep vacuum-space dark ambient (0.025..0.04 -> stark ink-black NASA shadows)
  vec3 ambFill = vec3(0.030, 0.034, 0.042) * albedo * (1.0 - 0.65 * metallic) * ao;
  // Subtle starlight / galactic-plane mirror reflection on smooth metals & solar glass only
  vec3 reflDir = reflect(-v, n);
  float galEnv = exp(-reflDir.y * reflDir.y * 7.5) * 0.14 + 0.022;
  float smoothFactor = (1.0 - roughness) * (1.0 - roughness);
  vec3 envSpec = fresnelSchlick(ndv, f0) * smoothFactor * galEnv * ao;

  vec3 litSurface = directLight + ambFill + envSpec;

  vec3 shiftedLit = applyRelativisticShift(litSurface, 5800.0, dColor, dColor, beamingGain, 0.72);
  float emGain = 0.72 + 0.28 * clamp(geometryVisibility, 0.0, 1.8);
  vec3 shiftedEm = applyRelativisticShift(emissive * emGain, emTemp, dColor, dColor, beamingGain, 0.76);

  float distFade = 1.0 - smoothstep(88.0, MAX_TRACE_DIST, h.t);
  return max((shiftedLit + shiftedEm) * distFade, vec3(0.0));
}

// ============================================================================
// 5. PHYSICAL VOLUMETRIC INTERSTELLAR MEDIUM (ISM) CIRRUS & 3D PARALLAX GLINTS
// ============================================================================

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-3);
  float invS = inversesqrt(denom);
  return ((1.0 - g2) / (4.0 * PI)) * (invS * invS * invS);
}

vec4 integrateCorridorVolume(
  vec3 ro,
  vec3 rdRest,
  float flightDir,
  float pixelFwRest,
  float tEnd,
  vec4 bn,
  int quality,
  float simTime,
  float doppler,
  float dColor,
  float beamingGain,
  float dustDensity,
  float dustStreakScale,
  float starDensity
) {
  const float tStart = 4.2;
  if (tEnd <= tStart) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }
  if (dustDensity <= 0.001 && starDensity <= 0.001) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  int nSteps = 20;
  if (quality <= 0) {
    nSteps = 14;
  } else if (quality >= 2) {
    nSteps = 28;
  }

  float invStreakZ = 0.038 / max(dustStreakScale, 0.25);
  float invStreakFineZ = 0.082 / max(dustStreakScale, 0.25);
  float fSteps = float(nSteps);

  // Henyey-Greenstein forward scattering (g = 0.58) aligned with the forward headlight cone
  vec3 flightAxis = vec3(0.0, 0.0, (flightDir >= 0.0) ? 1.0 : -1.0);
  float cosFwd = dot(rdRest, flightAxis);
  float hgPhase = clamp(henyeyGreenstein(cosFwd, 0.58) * 3.1, 0.08, 2.25);

  // True wavelength Doppler shift of H-alpha (656.3 nm), O-III (500.7 nm) & Paschen-alpha (1875 nm)
  vec3 haCol = wavelengthToRgb(656.3 / dColor);
  vec3 o3Col = wavelengthToRgb(500.7 / dColor);
  vec3 paCol = wavelengthToRgb(1875.0 / dColor) * 0.45;
  vec3 contCol = applyRelativisticShift(vec3(0.56, 0.68, 0.88), 6600.0, dColor, dColor, beamingGain, 0.55);
  float lineBeam = evalPlanckBeam(5800.0, dColor, beamingGain);
  float glintAftFade = smoothstep(0.08, 0.38, doppler);

  vec3 volRad = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < 28; ++i) {
    if (i >= nSteps) {
      break;
    }
    float j0 = fract(bn.y + float(i) * 0.61803399);
    float u0 = float(i) / fSteps;
    float u1 = float(i + 1) / fSteps;
    float t0 = mix(tStart, tEnd, u0 * (0.45 + 0.55 * u0));
    float t1 = mix(tStart, tEnd, u1 * (0.45 + 0.55 * u1));
    float tMid = mix(t0, t1, j0);
    float dt = t1 - t0;

    vec3 p = ro + rdRest * tMid;
    float rXY = length(p.xy);
    float rangeMask = smoothstep(4.2, 15.0, tMid) * (1.0 - smoothstep(54.0, VOL_MAX_DIST, tMid));

    if (rangeMask > 0.001) {
      if (dustDensity > 0.001) {
        vec3 uvw1 = vec3(p.xy * 0.095, p.z * invStreakZ) + vec3(0.37, 0.61, 0.19);
        vec3 uvw2 = vec3(p.xy * 0.210, p.z * invStreakFineZ) + vec3(0.73, 0.29, 0.53);
        vec4 n1 = textureLod(uVolumeNoise, uvw1, 0.0);
        vec4 n2 = textureLod(uVolumeNoise, uvw2, 0.0);

        float wisp = smoothstep(0.60, 0.94, n1.r * 0.52 + n1.g * 0.48);
        float fil = smoothstep(0.64, 0.96, n1.g * 0.48 + n2.a * 0.58);
        float clump = smoothstep(0.46, 0.84, n1.b);
        float tunnelClear = smoothstep(1.4, 4.2, rXY);
        float dens = (wisp * wisp * 0.22 + fil * fil * fil * 0.78) * clump * tunnelClear * rangeMask * dustDensity;

        if (dens > 0.002) {
          float lineMix = smoothstep(0.32, 0.78, n1.b);
          vec3 emLineCol = (mix(haCol, o3Col, lineMix) + paCol) * (0.48 * mix(1.0, lineBeam, 0.45));
          vec3 cirrusCol = emLineCol + contCol * (0.42 + 0.35 * fil);

          float ext = dens * 0.0018;
          float stepT = exp(-ext * dt);
          volRad += trans * cirrusCol * (dens * 0.0042 * hgPhase * dt);
          trans *= stepT;
        }
      }

      // Crisp sparse sub-pixel 3D parallax dust/starlight glints strictly outside r_xy > 2.2
      float glintRange = smoothstep(6.0, 14.0, tMid) * (1.0 - smoothstep(54.0, VOL_MAX_DIST, tMid)) * glintAftFade;
      if (starDensity > 0.001 && glintRange > 0.001 && rXY > 2.2) {
        const float knotScale = 0.20;
        vec3 pScaled = p * knotScale;
        vec3 cell = floor(pScaled);
        vec3 rnd = hash33f(cell + vec3(7.13, 19.41, 31.77));
        if (rnd.x > 0.958) {
          vec3 starWorld = (cell + vec3(0.26) + 0.48 * hash33f(cell + vec3(53.1, 11.7, 97.3))) / knotScale;
          float tProj = dot(starWorld - ro, rdRest);
          if (tProj >= t0 && tProj < t1) {
            float dPerp = length((ro + rdRest * tProj) - starWorld);
            float glintR = min(mix(0.018, 0.044, fract(rnd.y * 13.7)), max(pixelFwRest * tProj * 1.15, 0.0025));
            float glow = exp(-min((dPerp * dPerp) / (glintR * glintR), 32.0));
            if (glow > 0.005) {
              float tKnot = mix(3400.0, 14500.0, rnd.z);
              float tKnotObs = tKnot * dColor;
              vec3 knotCol = sampleBlackbody(tKnotObs);
              float knotBeam = evalPlanckBeam(tKnot, doppler, beamingGain);
              float wienCut = smoothstep(260.0, 780.0, tKnotObs);
              volRad += trans * knotCol * (glow * 2.15 * knotBeam * wienCut * starDensity * glintRange);
            }
          }
        }
      }
    }

    if (trans < 0.02) {
      break;
    }
  }

  return vec4(volRad, trans);
}

// ============================================================================
// 6. MAIN RELATIVISTIC ABERRATION, FOREGROUND & VOLUMETRIC PIPELINE
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
    rdRest = (rawLen > 1e-7) ? (rawRest / max(rawLen, 1e-7)) : vec3(0.0, 0.0, s);
    doppler = clamp(1.0 / max(gamma * denom, 1e-6), 1e-4, 2500.0);
  }

  float pixelFwRest = clamp(pixelFwShip * doppler, 1e-6, 0.45);
  float dColor = pow(max(doppler, 1e-4), dopplerStrength);

  // Seam-safe & pole-safe equirectangular derivatives computed unconditionally in uniform control flow
  vec3 dir = normalize(rotateSkyDir(rdRest, skyRot));
  float azim = (abs(dir.x) + abs(dir.z) > 1e-6) ? atan(dir.z, dir.x) : 0.0;
  float u1 = azim * INV_TAU + 0.5;
  float vCoord = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  vec2 uv1 = vec2(u1, vCoord);
  vec2 uv2 = vec2(fract(u1 + 0.5), vCoord);

  vec2 dx1 = dFdx(uv1);
  vec2 dy1 = dFdy(uv1);
  vec2 dx2 = dFdx(uv2);
  vec2 dy2 = dFdy(uv2);

  vec2 dUVdx = vec2((abs(dx1.x) < abs(dx2.x)) ? dx1.x : dx2.x, dx1.y);
  vec2 dUVdy = vec2((abs(dy1.x) < abs(dy2.x)) ? dy1.x : dy2.x, dy1.y);

  float magSmooth = 1.0 - smoothstep(0.14, 0.72, doppler);
  float minGrad = magSmooth * 0.0065;
  if (minGrad > 1e-6) {
    float lenX = length(vec2(dUVdx.x, dUVdx.y * 0.5));
    float lenY = length(vec2(dUVdy.x, dUVdy.y * 0.5));
    dUVdx = (lenX > 1e-5) ? (dUVdx * max(1.0, minGrad / max(lenX, 1e-6))) : vec2(minGrad, 0.0);
    dUVdy = (lenY > 1e-5) ? (dUVdy * max(1.0, minGrad / max(lenY, 1e-6))) : vec2(0.0, minGrad * 2.0);
  }
  dUVdx = clamp(dUVdx, vec2(-0.25), vec2(0.25));
  dUVdy = clamp(dUVdy, vec2(-0.25), vec2(0.25));
  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.002, 0.998));

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  vec3 origin = vec3(0.0, 0.0, flightPosZ);
  HitInfo hitInfo;
  hitInfo.hit = false;
  hitInfo.t = MAX_TRACE_DIST;
  hitInfo.objId = -1;
  hitInfo.cellMod = 0;
  hitInfo.localPos = vec3(0.0);

  if (geometryVisibility > 0.001) {
    hitInfo = traceCorridorGeometry(origin, rdRest);
  }

  float geomAlpha = hitInfo.hit ? smoothstep(0.0, 0.18, geometryVisibility) : 0.0;
  bool opaqueHit = hitInfo.hit && (geomAlpha >= 0.999);
  float volMaxDist = (hitInfo.hit && geomAlpha >= 0.99) ? hitInfo.t : VOL_MAX_DIST;

  vec3 skyColor = vec3(0.0);
  if (!opaqueHit) {
    skyColor = sampleSkyBackground(
      rdRest,
      dir,
      sampleUv,
      dUVdx,
      dUVdy,
      pixelFwRest,
      doppler,
      dColor,
      beamingGain,
      skyIntensity,
      skyMode,
      starDensity,
      uvIrGain,
      cmbVisibility,
      cmbTempScale
    );
  }

  vec4 volSample = integrateCorridorVolume(
    origin,
    rdRest,
    flightDir,
    pixelFwRest,
    min(volMaxDist, VOL_MAX_DIST),
    bn,
    quality,
    simTime,
    doppler,
    dColor,
    beamingGain,
    dustDensity,
    dustStreakScale,
    starDensity
  );

  vec3 radiance = skyColor;
  if (hitInfo.hit && geomAlpha > 0.001) {
    vec3 hitColor = shadeForegroundHit(hitInfo, rdRest, dColor, beamingGain, geometryVisibility);
    radiance = mix(radiance, hitColor, geomAlpha);
  }
  radiance = radiance * volSample.w + volSample.xyz;

  fragColor = vec4(sanitizeHdr(radiance), 1.0);
}
`;
