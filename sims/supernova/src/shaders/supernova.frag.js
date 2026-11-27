/**
 * Cinema-grade WebGL2 GLSL 300 es Full-Lifecycle Supernova & Volumetric
 * Multi-Scattering Remnant Ray-Tracer:
 *  - Analytic ray-bounding-sphere intersection scaled dynamically with jetPower.
 *  - Blue-noise stratified step start + quality-tiered step counts + early
 *    ray termination (transmittance < 0.005) + empty-space skipping.
 *  - 3-octave multi-scale volumetric sculpting using zero-isosurface ribbons,
 *    Musgrave ridged tendrils, and Worley cell walls with zero fog floor so
 *    inter-filament voids stay crystal clear.
 *  - Full-lifecycle morphology:
 *     * Core-Collapse Shock Breakout fireball with turbulent Planck blackbody convection
 *     * Twin relativistic helical bipolar jets + unclipped Mach bow-shock caps
 *     * SN 1987A clumpy beaded equatorial circumstellar ring & sculpted polar arcs
 *     * Hollow Pulsar Wind Nebula synchrotron torus & delicate wisps
 *     * Crisp filamentary remnant cage, folded Veil shock curtains, & X-ray rim
 *     * Sculpted dark Bok dust pillars with backlit photo-evaporation rims &
 *       6-tap Wrenninge 4-octave multiple scattering god-rays
 *  - 3 Spectral Palettes: 0 = Hubble SHO, 1 = True Color, 2 = Chandra / JWST.
 */

export const SUPERNOVA_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 176-byte std140 UBO matching SupernovaUniforms in supernova.wgsl
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
  vec4 morphParams;            // (bipolarPower, jetPower, ringStrength, curtainWeight)
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

// Tilted bipolar spin axis & orthonormal equatorial frame
const vec3 JET_AXIS = vec3(0.24495, 0.90837, -0.33875);
const vec3 EQ_U     = vec3(0.96954, -0.22949, 0.08558);
const vec3 EQ_V     = vec3(0.00000, -0.34946, -0.93695);

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
// 2. DUAL-LOBE HENYEY-GREENSTEIN & WRENNINGE MULTI-OCTAVE SCATTERING
// ============================================================================

float evalHG(float cosTheta, float g) {
  float gc = clamp(g, -0.95, 0.95);
  float mu = clamp(cosTheta, -1.0, 1.0);
  float denom = max(1.0 + gc * gc - 2.0 * gc * mu, 1e-4);
  float invS = inversesqrt(denom);
  return ((1.0 - gc * gc) * INV_4_PI) * (invS * invS * invS);
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
// 3. 3-OCTAVE MULTI-SCALE SCULPTING, LIFECYCLE ZONES & SHADOW TAPS
// ============================================================================

struct SupernovaConsts {
  float rShock;
  float invRShock;
  float qBaseScale;
  float simTime;
  float adv;
  float rtTurb;
  float dustAgeScale;
  float pwnAgeScale;
  float filPow;
  float bokDensity;
  float emissionGain;
  float gasExtScale;
  float invShellThick;
  float bipolarPower;
  float jetPower;
  float ringStrength;
  float curtainWeight;
  float wBreakout;
  float wYoung;
  float wRemnant;
  float wCurtain;
  float expansionSpeed;
  int   paletteMode;
  vec3  pwnColor;
  vec3  cOIII;
  vec3  cHa;
  vec3  cSII;
  vec3  cRim;
  vec3  cJet;
  vec3  cIrDust;
  vec3  ambientBounce;
};

float gaussianBandInv(float x, float center, float invWidth) {
  float u = (x - center) * invWidth;
  return exp(-min(u * u, 40.0));
}

float evalShadowExtinction(
  vec3 qBaseTap,
  float uTap,
  float dipoleAsym,
  SupernovaConsts sc
) {
  if (uTap > 1.44) return 0.0;

  vec4 n1 = textureLod(uVolumeNoise, qBaseTap, 0.0);
  float asym = 1.0 + dipoleAsym + 0.14 * (n1.r - 0.5);
  float uWarp = (uTap / max(asym, 0.55)) + (n1.r - 0.5) * (0.24 * sc.rtTurb);

  float shellEnv = gaussianBandInv(uWarp, 0.94, 5.2 * sc.invShellThick);
  float gasExt = sc.gasExtScale * shellEnv * smoothstep(0.38, 0.88, n1.g);

  if (sc.wBreakout > 0.01 && uWarp < 0.78) {
    float fbEnv = (1.0 - smoothstep(0.45, 0.78, uWarp)) * sc.wBreakout;
    gasExt += fbEnv * (0.85 + 1.2 * (1.0 - n1.r));
  }

  float dustExt = 0.0;
  if (sc.dustAgeScale > 1e-5) {
    float dustBand = smoothstep(0.74, 0.96, uWarp) * (1.0 - smoothstep(1.16, 1.38, uWarp));
    if (dustBand > 1e-4) {
      float pillar = smoothstep(0.50, 0.84, (1.0 - n1.b) * 0.58 + n1.r * 0.42);
      float bokKnot = smoothstep(0.58, 0.90, (1.0 - n1.b) * 0.74 + n1.g * 0.26) * sc.bokDensity;
      dustExt = (0.85 * pillar + 2.65 * bokKnot) * dustBand * sc.dustAgeScale;
    }
  }
  return gasExt + dustExt;
}

struct VolSample {
  vec3  emission;
  vec3  scatterAlbedo;
  float sigmaScat;
  float sigmaExt;
  float sigmaDust;
};

VolSample evalVolumeSample(
  vec3 p,
  float u,
  vec3 rHat,
  vec3 pBase,
  vec3 advShift,
  float dipoleAsym,
  SupernovaConsts sc
) {
  VolSample vs;
  vs.emission = vec3(0.0);
  vs.scatterAlbedo = vec3(0.0);
  vs.sigmaScat = 0.0;
  vs.sigmaExt = 0.0;
  vs.sigmaDust = 0.0;

  // Axial / equatorial cylindrical coordinates along tilted spin axis
  float zAx = dot(p, JET_AXIS);
  vec3 pEq = p - JET_AXIS * zAx;
  float rhoEq = length(pEq);
  float zNorm = zAx * sc.invRShock;
  float absZNorm = abs(zNorm);
  float rhoNorm = rhoEq * sc.invRShock;
  float cosLat = clamp(absZNorm / max(u, 1e-5), 0.0, 1.0);
  float sinLat = sqrt(max(1.0 - cosLat * cosLat, 0.0));

  // Prolate bipolar lobe stretch & equatorial hourglass pinch
  float polarStretch = 1.0 + sc.bipolarPower * (
    0.32 * cosLat * cosLat - 0.16 * sinLat * sinLat * (0.35 + 0.65 * sc.wYoung)
  );
  float uMorph = u / max(polarStretch, 0.55);

  // Tap 1: Macro domain warp & large-scale dipole asymmetry
  vec3 qBase = pBase - advShift * 0.45;
  vec4 n1 = textureLod(uVolumeNoise, qBase, 0.0);

  float asym = 1.0 + dipoleAsym + 0.14 * (n1.r - 0.5);
  float uWarp = (uMorph / max(asym, 0.55))
              + (n1.r - 0.5) * (0.24 * sc.rtTurb)
              + (n1.g - 0.5) * (0.09 * sc.rtTurb);

  // Coarse empty-space check before evaluating Taps 2 & 3
  bool nearJet = (sc.jetPower > 0.02)
              && (absZNorm >= 0.08 && absZNorm <= 2.35)
              && (rhoNorm <= 0.36 + 0.14 * absZNorm);
  bool nearRing = (sc.ringStrength > 0.02)
               && (absZNorm <= 1.15)
               && (rhoNorm >= 0.65 && rhoNorm <= 1.48);
  bool nearShell = (uWarp <= 1.44);

  if (!nearJet && !nearRing && !nearShell) {
    return vs;
  }

  // Tap 2: Bold, sweeping 3D tangled tendrils (macro-to-meso coherent loops, not fine confetti!)
  vec3 qRadial = rHat * (1.75 + 0.90 * log(1.0 + 2.4 * u) - sc.adv * 0.95)
               + (n1.rgb - vec3(0.5)) * (0.42 * sc.rtTurb);
  vec3 qWeb = p * 0.54 + (n1.rgb - vec3(0.5)) * (0.32 * sc.rtTurb) - rHat * (sc.adv * 0.75);
  vec3 qRT = mix(qWeb, qRadial * 0.58, 0.35 * smoothstep(0.08, 0.38, u));
  vec4 n2 = textureLod(uVolumeNoise, qRT, 0.0);

  // Tap 3: Fine secondary braided strands & cellular knots
  vec3 qMicro = p * 1.28 - rHat * (sc.adv * 1.15) + (n2.rgb - vec3(0.5)) * 0.28;
  vec4 n3 = textureLod(uVolumeNoise, qMicro, 0.0);

  // Coherent sweeping zero-isosurface ribbons + Musgrave ridges + Worley web seams
  float isoRibbon = exp(-min(pow((n2.r - 0.50) * 14.0, 2.0), 25.0));
  float isoMicro  = exp(-min(pow((n3.r - 0.50) * 10.5, 2.0), 25.0));
  float ridgeTend = pow(smoothstep(0.50, 0.92, n2.g), 2.4) * smoothstep(0.32, 0.90, n3.g);
  float cellSeam  = pow(smoothstep(0.56, 0.92, 1.0 - n2.b), 2.4) * (0.35 + 0.65 * n3.a);

  float filRaw = clamp(
    0.78 * isoRibbon * (0.45 + 0.55 * n3.a)
    + 0.95 * ridgeTend
    + 0.65 * cellSeam
    + 0.22 * isoMicro * n2.g,
    0.0,
    1.25
  );
  float filSharp = pow(smoothstep(0.44, 0.92, filRaw), sc.filPow) * (0.50 + 0.90 * n3.a);

  vec3 totalEmit = vec3(0.0);
  float gasDensity = 0.0;
  float fireballAbs = 0.0;

  // --------------------------------------------------------------------------
  // (A) Core-Collapse Fireball & Boiling Photosphere (Breakout + Early Young)
  // --------------------------------------------------------------------------
  float fireballPhase = clamp(sc.wBreakout + 0.16 * sc.wYoung, 0.0, 1.0);
  if (fireballPhase > 1e-3 && uMorph < 1.05) {
    float coreR = mix(0.56, 0.30, sc.wYoung);
    vec4 nBoil = textureLod(uVolumeNoise, p * 0.92 - rHat * (sc.adv * 1.6) + (n1.rgb - vec3(0.5)) * 0.42, 0.0);
    float boilEdge = coreR
                   + 0.38 * (n1.r - 0.5)
                   + 0.28 * (nBoil.g - 0.5)
                   + 0.14 * (n3.g - 0.5);
    float fbMask = 1.0 - smoothstep(boilEdge - 0.18, boilEdge + 0.04, uMorph);

    float clumpGate = mix(1.0, smoothstep(0.42, 0.88, nBoil.r * 0.55 + n3.g * 0.45), sc.wYoung * 0.95);
    fbMask *= clumpGate;

    if (fbMask > 1e-4) {
      float convect = clamp((1.0 - nBoil.b) * 0.52 + nBoil.g * 0.32 + n3.a * 0.16, 0.0, 1.0);
      float hotFissure = smoothstep(0.36, 0.90, convect);
      // Blazing incandescent stellar plasma (2,600 K deep magma -> 22,000 K blue-white breakout fissures)
      float tempK = mix(2600.0, 22000.0, pow(hotFissure, 1.85)) * (1.0 - 0.22 * uMorph);
      vec3 bbCol = sampleBlackbody(max(tempK, 2200.0));

      float fbRad = (0.06 + 3.4 * pow(hotFissure, 1.65)) * fbMask * fireballPhase;
      totalEmit += bbCol * fbRad;

      // Dark tearing convection rifts for cellular magma depth
      float coolCrust = smoothstep(0.58, 0.90, 1.0 - convect) * fbMask * fireballPhase;
      fireballAbs += (0.14 * fbMask * sc.wBreakout + 1.65 * coolCrust);
      gasDensity += 0.06 * fbMask * fireballPhase;
    }

    // Fiery shock-heated ejecta streamers & UV blast-wave shell erupting from breakout front
    if (sc.wBreakout > 1e-3) {
      float ejectaZone = gaussianBandInv(uWarp, 0.86, 3.0) * sc.wBreakout;
      float tongue = filSharp * smoothstep(0.22, 0.84, nBoil.g * 0.6 + n3.g * 0.4);
      vec3 ejectaCol = mix(
        mix(vec3(1.0, 0.28, 0.04), vec3(1.0, 0.78, 0.24), smoothstep(0.30, 0.75, n3.a)),
        vec3(0.42, 0.84, 1.0),
        smoothstep(0.76, 0.96, n3.a)
      );
      totalEmit += ejectaCol * (ejectaZone * tongue * 3.8);

      float uvShock = gaussianBandInv(uWarp, 1.06, 34.0) * smoothstep(0.30, 0.88, n2.g * 0.6 + n3.a * 0.4) * sc.wBreakout;
      totalEmit += vec3(0.26, 0.72, 1.0) * (uvShock * 1.15);
      gasDensity += 0.14 * ejectaZone * tongue + 0.04 * uvShock;
    }
  }

  // --------------------------------------------------------------------------
  // (B) Twin Relativistic Helical Bipolar Jets & Unclipped Mach Bow-Shock Caps
  // --------------------------------------------------------------------------
  if (sc.jetPower > 0.02 && absZNorm >= 0.08 && absZNorm <= 2.30) {
    float helPhase = absZNorm * 5.4 - sc.simTime * 2.5 * sc.expansionSpeed + (zNorm >= 0.0 ? 0.0 : PI);
    vec3 jetCenterEq = (EQ_U * cos(helPhase) + EQ_V * sin(helPhase)) * (0.032 * sc.rShock * absZNorm);
    float rFromJet = length(pEq - jetCenterEq) * sc.invRShock;

    float jetWidth = 0.024 + 0.048 * pow(absZNorm, 1.15);
    float jetCore = exp(-min((rFromJet * rFromJet) / max(jetWidth * jetWidth * 0.20, 1e-5), 32.0));
    float jetSheath = exp(-min((rFromJet * rFromJet) / max(jetWidth * jetWidth * 1.05, 1e-5), 32.0));

    float axialGate = smoothstep(0.08, 0.22, absZNorm) * (1.0 - smoothstep(1.30, 1.88, absZNorm));
    float mhdPulse = 0.38 + 0.62 * pow(0.5 + 0.5 * sin(absZNorm * 14.0 - sc.simTime * 4.2 * sc.expansionSpeed + n2.r * 2.8), 2.2);
    float jetStruct = smoothstep(0.24, 0.88, n2.g * 0.55 + n3.a * 0.45);

    float jetFade = mix(1.0, 0.72, sc.wRemnant * (1.0 - 0.55 * clamp(sc.pwnAgeScale, 0.0, 1.0)));
    float jPow = sc.jetPower * axialGate * jetFade;

    vec3 spineCol = mix(sc.cJet, vec3(0.90, 0.96, 1.0), 0.55);
    totalEmit += spineCol * (jetCore * mhdPulse * jPow * 2.85)
               + sc.cJet  * (jetSheath * jetStruct * jPow * 0.72);
    gasDensity += (jetCore + 0.30 * jetSheath) * jPow * 0.25;

    float bowPhase = clamp(sc.wBreakout + 0.65 * sc.wYoung, 0.0, 1.0);
    if (bowPhase > 0.02 && absZNorm > 1.05 && absZNorm < 1.95) {
      float bowZ = absZNorm - (1.42 - 0.42 * rhoNorm * rhoNorm * 10.0);
      float bowFade = 1.0 - smoothstep(0.12, 0.40, rhoNorm);
      float bowArc = exp(-min((bowZ * bowZ) / 0.010, 30.0)) * bowFade;
      vec3 bowCol = mix(sc.cJet, vec3(1.0, 0.72, 0.34), 0.40 * sc.wBreakout);
      totalEmit += bowCol * (bowArc * bowPhase * sc.jetPower * (0.20 + 1.45 * n2.g * n3.a));
    }
  }

  // --------------------------------------------------------------------------
  // (C) SN 1987A Clumpy Beaded Equatorial Circumstellar Ring & Polar Arcs
  // --------------------------------------------------------------------------
  if (sc.ringStrength > 0.02 && absZNorm <= 1.15 && rhoNorm >= 0.62 && rhoNorm <= 1.48) {
    float az = atan(dot(pEq, EQ_V), dot(pEq, EQ_U));
    float ringWarp = (n1.r - 0.5) * 0.07 + (n2.g - 0.5) * 0.04;
    float dRho = rhoNorm - (1.12 + ringWarp);
    float dZ = zNorm - 0.04 * (n1.g - 0.5);
    float ringTube2 = dRho * dRho + dZ * dZ * 1.8;
    float eqRing = exp(-min(ringTube2 / 0.00095, 32.0));

    if (eqRing > 1e-4) {
      float clump = 0.20 + 0.85 * smoothstep(0.28, 0.86, n2.g * 0.6 + n3.a * 0.4);
      float pearlWave = 0.5 + 0.5 * sin(az * 21.0 + n1.r * 2.4 - sc.simTime * 0.35 * sc.expansionSpeed);
      float pearls = pow(pearlWave, 4.5);
      float hotPearl = exp(-min(ringTube2 / 0.00038, 32.0)) * pearls;

      vec3 ringCol = mix(sc.cHa, sc.cOIII, 0.35 * n2.r);
      vec3 pearlCol = mix(vec3(1.0, 0.82, 0.48), vec3(0.90, 0.96, 1.0), 0.38 * pearls);
      float ringGain = mix(0.58, 1.10, sc.wYoung);
      totalEmit += (ringCol * (eqRing * clump * 0.85) + pearlCol * (hotPearl * 3.3))
                 * sc.ringStrength * ringGain;
      gasDensity += eqRing * clump * sc.ringStrength * 0.25;
    }

    if (sc.bipolarPower > 1.05 && sc.wYoung > 0.15 && absZNorm > 0.60) {
      float dZPol = absZNorm - 0.86;
      float dRPol = rhoNorm - 0.94;
      float polRing = exp(-min((dZPol * dZPol * 2.0 + dRPol * dRPol) / 0.0014, 32.0));
      float polClump = smoothstep(0.32, 0.88, n2.g * 0.65 + n3.a * 0.35);
      totalEmit += sc.cOIII * (polRing * polClump * sc.ringStrength * sc.wYoung * 0.52);
    }
  }

  // --------------------------------------------------------------------------
  // (D) Hollow Pulsar Wind Nebula (PWN) — Synchrotron Torus & Delicate Wisps
  // --------------------------------------------------------------------------
  if (sc.wRemnant > 1e-3 && sc.pwnAgeScale > 1e-3 && u < 0.68) {
    float pwnScale = sc.wRemnant * sc.pwnAgeScale;

    // Crisp inclined Chandra-style concentric synchrotron torus around the pulsar
    float torusRad = smoothstep(0.11, 0.18, rhoNorm) * (1.0 - smoothstep(0.38, 0.54, rhoNorm));
    float torusThin = exp(-min((zNorm * zNorm) / 0.00045, 30.0));
    float ripplePhase = rhoNorm * 28.0 - sc.simTime * 2.4 * sc.expansionSpeed + n2.r * 1.8;
    float torusWisp = pow(0.5 + 0.5 * sin(ripplePhase), 5.0) * (0.20 + 0.80 * smoothstep(0.28, 0.86, n2.g * 0.55 + n3.g * 0.45));
    float torusVal = torusRad * torusThin * (1.25 * torusWisp) * pwnScale;

    // Ultra-sparse delicate interior wisps (never clouds the pulsar cavity!)
    float cavityShell = smoothstep(0.20, 0.30, u) * (1.0 - smoothstep(0.42, 0.58, u));
    float fineWisp = pow(smoothstep(0.58, 0.95, n2.g * 0.60 + n3.a * 0.40), 2.8);
    float arcVal = cavityShell * fineWisp * pwnScale * 0.16;

    totalEmit += sc.pwnColor * (torusVal * 0.62 + arcVal * 0.22);
    gasDensity += (torusVal * 0.025 + arcVal * 0.01);
  }

  // --------------------------------------------------------------------------
  // (E) Remnant Filament Cage, Veil Shock Curtains & Forward X-Ray/Balmer Rim
  // --------------------------------------------------------------------------
  float remPhase = clamp(sc.wRemnant + 0.42 * sc.wYoung, 0.0, 1.0);
  if (remPhase > 1e-3) {
    float cageWeight = 1.0 - sc.wCurtain;
    float speciesMix = smoothstep(0.38, 0.66, n2.r);

    // 1) Razor-thin braided Rayleigh-Taylor filament cage (Crab / SHO Pillars)
    if (cageWeight > 1e-3) {
      float oiiiBand = gaussianBandInv(uWarp, 0.68, 7.8 * sc.invShellThick);
      float oiiiVal = oiiiBand * filSharp * (0.22 + 0.78 * speciesMix);

      float haBand = gaussianBandInv(uWarp, 0.92, 8.8 * sc.invShellThick);
      float haVal = haBand * filSharp * (1.0 - 0.62 * speciesMix) * (0.50 + 0.55 * n1.g);

      float siiBand = gaussianBandInv(uWarp, 1.03, 12.2 * sc.invShellThick);
      float siiVal = siiBand * filSharp * smoothstep(0.48, 0.90, n3.g * 0.68 + n2.g * 0.32);

      vec3 cageEmit = (
        sc.cOIII * (oiiiVal * 0.78)
        + sc.cHa * (haVal   * 1.08)
        + sc.cSII * (siiVal * 0.98)
      ) * (cageWeight * remPhase);

      totalEmit += cageEmit;
      gasDensity += (0.18 * oiiiVal + 0.42 * haVal + 0.32 * siiVal) * cageWeight * remPhase;
    }

    // 2) Gossamer Folded Shock Curtains (Veil Nebula silk sheets)
    if (sc.wCurtain > 1e-3) {
      float fold = (n1.r - 0.5) * 0.26 + (n2.r - 0.5) * 0.12;
      float c1 = gaussianBandInv(uMorph, 0.93 + fold, 52.0 * sc.invShellThick);
      float c2 = gaussianBandInv(uMorph, 1.00 + fold * 1.12, 58.0 * sc.invShellThick);
      float ribbon = pow(smoothstep(0.34, 0.88, n2.g * 0.55 + n3.g * 0.45), 1.65)
                   * (0.30 + 0.90 * isoMicro);

      vec3 curtEmit = (
        sc.cOIII * (c1 * 1.45)
        + sc.cHa * (c2 * 1.60)
      ) * (ribbon * sc.wCurtain * remPhase);

      totalEmit += curtEmit;
      gasDensity += (c1 + c2) * ribbon * sc.wCurtain * remPhase * 0.20;
    }

    // 3) Delicate gossamer outer Forward Blast-Wave Rim (Balmer / Chandra X-Ray shock front)
    float rimThin = gaussianBandInv(uWarp, 1.13, 48.0 * sc.invShellThick);
    float rimDetail = smoothstep(0.34, 0.88, n2.g * 0.58 + n3.a * 0.42);
    float rimVal = rimThin * rimDetail * (0.35 + 0.65 * sc.wRemnant);
    totalEmit += sc.cRim * (rimVal * 0.44);
    gasDensity += rimVal * 0.06;
  }

  // --------------------------------------------------------------------------
  // (F) Sculpted Dark Bok Pillars & Photo-Evaporative Dust Rims (Zero Halo!)
  //     Dust sublimates cleanly during Shock Breakout (wBreakout ~ 1).
  // --------------------------------------------------------------------------
  float sigmaDust = 0.0;
  float dustSurvive = 1.0 - 0.96 * sc.wBreakout;
  if (sc.dustAgeScale > 1e-5 && dustSurvive > 1e-4) {
    float dustBand = smoothstep(0.74, 0.96, uWarp) * (1.0 - smoothstep(1.16, 1.38, uWarp));
    if (dustBand > 1e-4) {
      float pillarField = (1.0 - n2.b) * 0.56 + n1.r * 0.44;
      float pillarMask = smoothstep(0.52, 0.84, pillarField) * smoothstep(0.34, 0.82, 1.0 - n3.b);
      float bokCore = smoothstep(0.58, 0.89, (1.0 - n2.b) * 0.66 + (1.0 - n1.b) * 0.34) * sc.bokDensity;
      sigmaDust = (0.95 * pillarMask + 3.10 * bokCore) * dustBand * sc.dustAgeScale * dustSurvive;
    }
  }

  totalEmit *= sc.emissionGain;
  gasDensity *= sc.emissionGain;

  float sigmaGasExt = 0.045 * gasDensity + fireballAbs;
  vs.emission = totalEmit;
  vs.sigmaScat = 0.03 * gasDensity * (1.0 - 0.85 * sc.wBreakout) + 0.26 * sigmaDust;
  vs.sigmaExt = sigmaGasExt + sigmaDust;
  vs.sigmaDust = sigmaDust;
  vs.scatterAlbedo = mix(
    vec3(0.72, 0.84, 0.98),
    vec3(0.96, 0.74, 0.54),
    clamp(sigmaDust / max(vs.sigmaExt, 1e-4), 0.0, 1.0)
  );
  return vs;
}

// ============================================================================
// 4. CENTRAL WHITE DWARF / PULSAR / BREAKOUT ENGINE (ORIGIN-SAFE)
// ============================================================================

vec3 evalCentralCore(
  vec3 camPos,
  float tStar,
  float starLuminosity,
  vec3 starCol,
  float wBreakout,
  float wRemnant
) {
  if (starLuminosity <= 1e-4 || tStar <= -0.15) return vec3(0.0);

  float tFwd = max(tStar, 0.0);
  float fwdFade = smoothstep(-0.14, 0.18, tStar);
  float d2 = max(dot(camPos, camPos) - tStar * tStar, 0.0);

  float coreScale = mix(0.0014, 0.00040, wRemnant) + mix(0.00032, 0.00009, wRemnant) * tFwd * tFwd;
  float haloScale = mix(0.045, 0.0085, wRemnant) + mix(0.0038, 0.0008, wRemnant) * tFwd * tFwd;
  float coreDisk = exp(-min(d2 / coreScale, 40.0));
  float corona = exp(-min(d2 / haloScale, 40.0));
  float distAtten = 1.0 / (1.0 + mix(0.035, 0.075, wRemnant) * tFwd * tFwd);

  vec3 coronaCol = mix(starCol, vec3(0.45, 0.80, 1.00), 0.45);
  float coreGain = mix(3.6, 5.2, wBreakout);
  float haloGain = mix(0.22, 0.65, wBreakout);
  return (starCol * (coreGain * coreDisk) + coronaCol * (haloGain * corona))
       * starLuminosity * fwdFade * distAtten;
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
  int paletteMode = clamp(int(round(u.jitter_fov_palette.w)), 0, 2);

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

  float bipolarPower = clamp(u.morphParams.x, 0.0, 2.5);
  float jetPower = clamp(u.morphParams.y, 0.0, 2.5);
  float ringStrength = clamp(u.morphParams.z, 0.0, 2.5);
  float curtainWeight = clamp(u.morphParams.w, 0.0, 1.0);

  vec3 skyColor = sampleSkyBackground(rayDir, skyIntensity, skyMode, skyRot);

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  vec3 centralStarCol = sampleBlackbody(centralTempK);
  vec3 starLightTint = mix(centralStarCol, vec3(0.68, 0.90, 1.00), 0.25);

  SupernovaConsts sc;
  sc.rShock = rShock;
  sc.invRShock = 1.0 / rShock;
  sc.qBaseScale = 0.24 / max(rShock / 3.0, 0.5);
  sc.simTime = simTime;
  sc.expansionSpeed = expansionSpeed;
  sc.adv = simTime * expansionSpeed * 0.028;
  sc.rtTurb = rtTurbulence;
  sc.dustAgeScale = dustOpacity * (0.70 + 0.45 * shockAgeNorm);
  sc.pwnAgeScale = cavityGlow * (1.15 - 0.30 * shockAgeNorm);
  sc.filPow = mix(1.55, 3.05, clamp((filamentContrast - 0.6) / 1.2, 0.0, 1.0));
  sc.bokDensity = bokDensity;
  sc.emissionGain = emissionGain;
  sc.gasExtScale = 0.055 * emissionGain;
  sc.invShellThick = 1.0 / max(shellThickness, 0.3);
  sc.bipolarPower = bipolarPower;
  sc.jetPower = jetPower;
  sc.ringStrength = ringStrength;
  sc.curtainWeight = curtainWeight;
  sc.paletteMode = paletteMode;

  sc.wBreakout = 1.0 - smoothstep(0.06, 0.32, shockAgeNorm);
  sc.wYoung    = smoothstep(0.08, 0.34, shockAgeNorm) * (1.0 - smoothstep(0.62, 0.80, shockAgeNorm));
  sc.wRemnant  = smoothstep(0.58, 0.78, shockAgeNorm);
  sc.wCurtain  = clamp(curtainWeight + 0.55 * smoothstep(0.91, 0.99, shockAgeNorm), 0.0, 1.0);

  if (paletteMode == 0) {
    // Hubble SHO Narrowband: [S II] Molten Gold, H-alpha Emerald, [O III] Electric Sapphire
    sc.cSII     = vec3(1.00, 0.54, 0.05);
    sc.cHa      = vec3(0.14, 0.88, 0.36);
    sc.cOIII    = vec3(0.04, 0.62, 1.00);
    sc.cRim     = vec3(0.12, 0.48, 1.00);
    sc.pwnColor = vec3(0.20, 0.70, 1.00);
    sc.cJet     = vec3(0.30, 0.76, 1.00);
    sc.cIrDust  = vec3(1.00, 0.50, 0.10);
    sc.ambientBounce = vec3(0.012, 0.018, 0.024) * emissionGain;
  } else if (paletteMode == 2) {
    // Chandra X-ray / Optical / JWST Infrared Composite
    sc.cHa      = vec3(1.00, 0.12, 0.38);
    sc.cOIII    = vec3(0.05, 0.88, 0.96);
    sc.cSII     = vec3(1.00, 0.48, 0.06);
    sc.cRim     = vec3(0.42, 0.30, 1.00);
    sc.pwnColor = vec3(0.24, 0.34, 1.00);
    sc.cJet     = vec3(0.32, 0.46, 1.00);
    sc.cIrDust  = vec3(1.00, 0.44, 0.08);
    sc.ambientBounce = vec3(0.018, 0.010, 0.024) * emissionGain;
  } else {
    // True Color Broadband: H-alpha Ruby-Crimson, [O III] Electric Teal, [S II] Warm Amber
    sc.cHa      = vec3(1.00, 0.08, 0.16);
    sc.cOIII    = vec3(0.03, 0.86, 0.82);
    sc.cSII     = vec3(1.00, 0.42, 0.04);
    sc.cRim     = vec3(0.22, 0.56, 1.00);
    sc.pwnColor = vec3(0.22, 0.68, 1.00);
    sc.cJet     = vec3(0.36, 0.72, 1.00);
    sc.cIrDust  = vec3(1.00, 0.48, 0.14);
    sc.ambientBounce = vec3(0.014, 0.012, 0.018) * emissionGain;
  }

  // Analytic ray-bounding-sphere intersection expanded generously so jets never clip
  float rBound = rShock * (1.72 + 0.85 * clamp(jetPower, 0.0, 1.0));
  float bSphere = dot(camPos, rayDir);
  float tStar = -bSphere;
  float cSphere = dot(camPos, camPos) - rBound * rBound;
  float disc = bSphere * bSphere - cSphere;

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;

  if (disc > 0.0) {
    float sqrtDisc = sqrt(disc);
    float tNear = max(0.0, tStar - sqrtDisc);
    float tFar = tStar + sqrtDisc;

    if (tFar > tNear) {
      int nSteps = isProgressive ? 128 : 96;
      if (quality <= 0) {
        nSteps = isProgressive ? 88 : 64;
      } else if (quality >= 2) {
        nSteps = isProgressive ? 160 : 128;
      }

      float marchSpan = tFar - tNear;
      float ds = marchSpan / float(nSteps);
      float starTransmittance = 1.0;

      const float tapScale[6] = float[6](0.95, 0.89, 0.80, 0.66, 0.46, 0.22);
      const float tapW[6]     = float[6](0.07, 0.09, 0.13, 0.18, 0.23, 0.30);

      for (int step = 0; step < 160; ++step) {
        if (step >= nSteps) break;

        float tPrev = tNear + float(step) * ds;
        float t = tPrev + bn.x * ds;
        vec3 p = camPos + rayDir * t;

        float r2 = dot(p, p);
        float r = sqrt(r2);
        float u = r * sc.invRShock;

        float prevTrans = transmittance;
        if (r <= rBound) {
          vec3 rHat = (r > 1e-5) ? (p / max(r, 1e-5)) : vec3(0.0, 1.0, 0.0);
          vec3 pBase = p * sc.qBaseScale;
          vec3 advShift = rHat * sc.adv;
          float dipoleAsym = 0.08 * (rHat.x * rHat.y - 0.55 * rHat.z);

          VolSample vs = evalVolumeSample(p, u, rHat, pBase, advShift, dipoleAsym, sc);
          vec3 stepSource = vs.emission;

          if (vs.sigmaScat > 1e-4) {
            vec3 directScatter = vec3(0.0);
            float rimLight = 0.0;
            if (starLuminosity > 1e-3) {
              float tauShadow = 0.0;
              if (r > 0.08 && u >= 0.32) {
                float shadowSpan = min(r, rBound);
                for (int st = 0; st < 6; ++st) {
                  float s = tapScale[st];
                  vec3 qBaseTap = pBase * s - advShift * 0.45;
                  float uTap = u * s;
                  float extTap = evalShadowExtinction(qBaseTap, uTap, dipoleAsym, sc);
                  tauShadow += extTap * (tapW[st] * shadowSpan);
                  if (tauShadow > 40.0) break;
                }
              }

              float cosTheta = dot(rHat, -rayDir);
              float wrenninge = evalWrenningeMultiScatter(tauShadow, cosTheta, hgAnisotropy);
              float invDist2 = 1.0 / (r2 + 0.25);
              directScatter = starLightTint * (starLuminosity * 6.5 * invDist2 * wrenninge);

              if (vs.sigmaDust > 0.05) {
                rimLight = exp(-min(tauShadow * 1.35, 30.0))
                         * smoothstep(0.12, 0.90, vs.sigmaDust)
                         * starLuminosity * invDist2 * 3.6;
              }
            }

            stepSource += vs.sigmaScat * vs.scatterAlbedo * (directScatter + sc.ambientBounce);
            if (rimLight > 1e-4) {
              float irBoost = (paletteMode == 2) ? 1.50 : 0.72;
              stepSource += sc.cIrDust * (rimLight * irBoost);
            }
          }

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

      radiance += starTransmittance * evalCentralCore(
        camPos, tStar, starLuminosity, centralStarCol, sc.wBreakout, sc.wRemnant
      );
    } else {
      radiance += evalCentralCore(
        camPos, tStar, starLuminosity, centralStarCol, sc.wBreakout, sc.wRemnant
      );
    }
  } else {
    radiance += evalCentralCore(
      camPos, tStar, starLuminosity, centralStarCol, sc.wBreakout, sc.wRemnant
    );
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
