/**
 * WebGL2 GLSL 300 es Gravitational Lensing Observatory Shader
 * (1:1 mathematical & uniform parity with lens-cluster.wgsl.js).
 *
 *  - Locked 176-byte std140 LensClusterUniforms (11 x vec4) at binding slot 0
 *  - Exact Point Mass, SIE Elliptical, & Pseudo-Elliptical NFW + 6 Subhalos
 *  - Analytical Jacobian magnification, critical curves, caustics, Fermat isolines
 *  - 3D foreground cluster member galaxies & volumetric X-ray ICM haze (128^3)
 */

export const LENS_CLUSTER_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 176-byte std140 UBO matching LensClusterUniforms in lens-cluster.wgsl.js
layout(std140) uniform LensClusterUniforms {
  vec4 resolution_time_frame;  // (width, height, simTime, float(frameIndex))
  vec4 jitter_fov_prog;        // (jitterX, jitterY, fovY, isProgressive)
  vec4 camPos_unused;          // (pos.x, pos.y, pos.z, 0.0)
  vec4 camRight_model;         // (right.x, right.y, right.z, float(lensModel))
  vec4 camUp_thetaE;           // (up.x, up.y, up.z, einsteinRadius)
  vec4 camFwd_ellip;           // (forward.x, forward.y, forward.z, ellipticity)
  vec4 lensShapeParams;        // (extShear, lensAngleRad, shearAngleRad, subhaloStrength)
  vec4 sourceParams;           // (sourceX, sourceY, sourceScale, quasarCore)
  vec4 overlayParams;          // (showCaustics, showFermat, dragMode, extraFieldGalaxies)
  vec4 clusterOpticsParams;    // (clusterLight, icmGlow, skyIntensity, float(skyMode))
  vec4 skyQualityParams;       // (skyRotX, skyRotY, float(quality), 0.0)
} u;

// Locked texture units 0..4
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8
uniform sampler2D uSkyMap;        // unit 1: 4K equirectangular Milky Way
uniform sampler2D uProcSkyMap;    // unit 2: Procedural equirectangular sky
uniform sampler2D uBlackbodyLut;  // unit 3: 512x1 CIE-1931 Planck LUT
uniform sampler2D uBlueNoise;     // unit 4: 128x128 void-and-cluster blue noise

const float PI             = 3.14159265359;
const float TAU            = 6.28318530718;
const float INV_PI         = 0.31830988618;
const float INV_TAU        = 0.15915494309;
const float T_MIN          = 800.0;
const float T_MAX          = 40000.0;
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543;
const float POINT_SOFT     = 0.015;
const float SIE_CORE       = 0.035;
const float NFW_CORE       = 0.04;
const float NFW_RS_RATIO   = 2.6;

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

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(123.34, 456.21));
  q += vec2(dot(q, q + vec2(45.32)));
  return fract(q.x * q.y);
}

vec2 hash22(vec2 p) {
  vec2 a = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(a) * 43758.5453);
}

vec3 rotateSkyDir(vec3 d, vec2 skyRot) {
  float cy = cos(skyRot.x);
  float sy = sin(skyRot.x);
  vec3 r1 = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  float cp = cos(skyRot.y);
  float sp = sin(skyRot.y);
  return vec3(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

vec4 getSubhaloData(int idx) {
  if (idx == 0) return vec4(-1.25,  0.72, 0.24,  0.45);
  if (idx == 1) return vec4( 1.48, -0.58, 0.22, -0.55);
  if (idx == 2) return vec4( 0.55,  1.42, 0.18,  0.65);
  if (idx == 3) return vec4(-1.62, -1.05, 0.20, -0.40);
  if (idx == 4) return vec4( 2.15,  1.10, 0.16, -0.75);
  return vec4(-0.42, -1.85, 0.17,  0.60);
}

vec4 getSubhaloShape(int idx) {
  if (idx == 0) return vec4(0.14, 0.22,  0.42, 4100.0);
  if (idx == 1) return vec4(0.14, 0.28, -0.65, 3850.0);
  if (idx == 2) return vec4(0.12, 0.18,  1.10, 4350.0);
  if (idx == 3) return vec4(0.13, 0.30, -0.25, 3700.0);
  if (idx == 4) return vec4(0.12, 0.24,  0.80, 4500.0);
  return vec4(0.13, 0.20, -1.05, 3950.0);
}

struct NfwVals {
  float g;
  float F;
  float hPsi;
};

NfwVals evalNfwFunctions(float rawX) {
  float x = max(rawX, 1e-4);
  float lnHalfX = log(0.5 * x);
  float d = x - 1.0;

  float C;
  float F;
  if (abs(d) < 0.02) {
    C = 1.0 + d * (-2.0 / 3.0 + d * (7.0 / 15.0 + d * (-12.0 / 35.0 + d * (83.0 / 315.0))));
    F = (2.0 / 3.0 + d * (-7.0 / 15.0 + d * (12.0 / 35.0 - d * (83.0 / 315.0)))) / (2.0 + d);
  } else if (x < 1.0) {
    float oneMinusX2 = 1.0 - x * x;
    float sq = sqrt(oneMinusX2);
    float invX = 1.0 / x;
    C = log(invX + sqrt(max(invX * invX - 1.0, 0.0))) / sq;
    F = (C - 1.0) / oneMinusX2;
  } else {
    float x2Minus1 = x * x - 1.0;
    float sq = sqrt(x2Minus1);
    C = acos(1.0 / x) / sq;
    F = (1.0 - C) / x2Minus1;
  }

  float g = lnHalfX + C;
  float hPsi = lnHalfX * lnHalfX + (x * x - 1.0) * C * C;
  return NfwVals(g, F, hPsi);
}

struct LensAcc {
  float psi;
  vec2 alpha;
  float psiXX;
  float psiYY;
  float psiXY;
};

void addSoftenedSie(inout LensAcc acc, float tx, float ty, float b, float q, float s, float angleRad) {
  float c = cos(angleRad);
  float si = sin(angleRad);
  float xp = c * tx + si * ty;
  float yp = -si * tx + c * ty;

  float qClamped = clamp(q, 0.25, 1.0);
  float q2 = qClamped * qClamped;
  float qp2 = 1.0 - q2;
  float psiK = sqrt(q2 * (s * s + xp * xp) + yp * yp + 1e-8);

  float axp;
  float ayp;
  float dPsi;
  float pxxp;
  float pyyp;
  float pxyp;

  if (qp2 < 1e-5) {
    float denom = max(psiK + s, 1e-6);
    float invD = 1.0 / denom;
    float invPsi = 1.0 / max(psiK, 1e-6);
    axp = b * xp * invD;
    ayp = b * yp * invD;
    dPsi = b * (psiK - s - s * log(0.5 * denom / max(s, 1e-5)));
    pxxp = b * invD * (1.0 - xp * xp * invPsi * invD);
    pyyp = b * invD * (1.0 - yp * yp * invPsi * invD);
    pxyp = -b * xp * yp * invPsi * invD * invD;
  } else {
    float qp = sqrt(qp2);
    float ps = max(psiK + s, 1e-6);
    float pqs = max(psiK + q2 * s, 1e-6);
    float bSqrtQ = b * sqrt(qClamped);
    axp = (bSqrtQ / qp) * atan((qp * xp) / ps);
    float arg = clamp((qp * yp) / pqs, -0.99995, 0.99995);
    ayp = (bSqrtQ / qp) * 0.5 * log((1.0 + arg) / (1.0 - arg));

    float dK = max(xp * xp + yp * yp + (1.0 + q2) * s * s + 2.0 * s * psiK, 1e-7);
    float invPsiDk = 1.0 / max(psiK * dK, 1e-8);
    float refDk = max((1.0 + q2) * s * s + 2.0 * s * qClamped * s, 1e-8);
    dPsi = xp * axp + yp * ayp - 0.5 * bSqrtQ * s * log(max(dK / refDk, 1e-8));

    pxxp = bSqrtQ * (q2 * s * s + yp * yp + s * psiK) * invPsiDk;
    pyyp = bSqrtQ * (xp * xp + s * s + s * psiK) * invPsiDk;
    pxyp = -bSqrtQ * xp * yp * invPsiDk;
  }

  acc.psi += dPsi;
  acc.alpha.x += c * axp - si * ayp;
  acc.alpha.y += si * axp + c * ayp;

  float c2 = c * c;
  float s2 = si * si;
  float cs = c * si;
  acc.psiXX += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
  acc.psiYY += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
  acc.psiXY += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;
}

struct LensField {
  float psi;
  vec2 alpha;
  float kappa;
  float gamma;
  float detA;
  float lambdaT;
  float lambdaR;
};

LensField evalLensField(
  float tx,
  float ty,
  vec3 cRight,
  vec3 cUp,
  int lensModel,
  float thetaE,
  float ellip,
  float extShear,
  float lensAngleRad,
  float shearAngleRad,
  float subhaloStrength
) {
  LensAcc acc;
  acc.psi = 0.0;
  acc.alpha = vec2(0.0);
  acc.psiXX = 0.0;
  acc.psiYY = 0.0;
  acc.psiXY = 0.0;

  if (lensModel == 0) {
    float eps = POINT_SOFT * thetaE;
    float r2 = tx * tx + ty * ty + eps * eps;
    float te2 = thetaE * thetaE;
    float invR2 = 1.0 / r2;
    float invR4 = invR2 * invR2;

    acc.psi += 0.5 * te2 * log(r2 / max(eps * eps, 1e-8));
    acc.alpha += te2 * vec2(tx, ty) * invR2;
    acc.psiXX += te2 * (r2 - 2.0 * tx * tx) * invR4;
    acc.psiYY += te2 * (r2 - 2.0 * ty * ty) * invR4;
    acc.psiXY += -2.0 * te2 * tx * ty * invR4;
  } else if (lensModel == 1) {
    float q = clamp(1.0 - ellip, 0.25, 1.0);
    float s = SIE_CORE * thetaE;
    addSoftenedSie(acc, tx, ty, thetaE, q, s, lensAngleRad);
  } else {
    float c = cos(lensAngleRad);
    float si = sin(lensAngleRad);
    float xp = c * tx + si * ty;
    float yp = -si * tx + c * ty;

    float q = clamp(1.0 - ellip, 0.30, 1.0);
    float q2 = q * q;
    float q4 = q2 * q2;
    float rs = NFW_RS_RATIO * thetaE;
    float core = NFW_CORE * thetaE;
    float xE = thetaE / rs;
    float gXE = evalNfwFunctions(xE).g;
    float fourKs = (thetaE * xE) / max(rs * gXE, 1e-6);

    float R2 = q2 * xp * xp + yp * yp + core * core;
    float R = sqrt(R2);
    float uCoord = R / rs;
    NfwVals nfw = evalNfwFunctions(uCoord);

    float psiNorm = 0.5 * fourKs * rs * rs;
    float a1 = fourKs * (nfw.g / (uCoord * uCoord));
    float kappaRad = 0.5 * fourKs * nfw.F;
    float a2 = (2.0 * (kappaRad - a1)) / max(R2, 1e-7);

    acc.psi += psiNorm * nfw.hPsi;
    float axp = a1 * q2 * xp;
    float ayp = a1 * yp;
    acc.alpha.x += c * axp - si * ayp;
    acc.alpha.y += si * axp + c * ayp;

    float pxxp = q2 * a1 + q4 * xp * xp * a2;
    float pyyp = a1 + yp * yp * a2;
    float pxyp = q2 * xp * yp * a2;

    float c2 = c * c;
    float s2 = si * si;
    float cs = c * si;
    acc.psiXX += c2 * pxxp - 2.0 * cs * pxyp + s2 * pyyp;
    acc.psiYY += s2 * pxxp + 2.0 * cs * pxyp + c2 * pyyp;
    acc.psiXY += cs * (pxxp - pyyp) + (c2 - s2) * pxyp;

    if (subhaloStrength > 1e-4) {
      float clusterScale = thetaE / 2.85;
      for (int i = 0; i < 6; i++) {
        vec4 d0 = getSubhaloData(i);
        vec4 d1 = getSubhaloShape(i);
        vec3 gPos = vec3(d0.x, d0.y, d0.w) * clusterScale;
        float sx0 = dot(gPos, cRight);
        float sy0 = dot(gPos, cUp);
        float bSh = d0.z * thetaE * subhaloStrength;
        float sSh = d1.x * thetaE;
        float qSh = clamp(1.0 - d1.y, 0.45, 1.0);
        addSoftenedSie(acc, tx - sx0, ty - sy0, bSh, qSh, sSh, d1.z);
      }
    }
  }

  if (extShear > 1e-5) {
    float g1 = extShear * cos(2.0 * shearAngleRad);
    float g2 = extShear * sin(2.0 * shearAngleRad);
    acc.psi += 0.5 * (g1 * (tx * tx - ty * ty) + 2.0 * g2 * tx * ty);
    acc.alpha.x += g1 * tx + g2 * ty;
    acc.alpha.y += g2 * tx - g1 * ty;
    acc.psiXX += g1;
    acc.psiYY -= g1;
    acc.psiXY += g2;
  }

  float kappa = 0.5 * (acc.psiXX + acc.psiYY);
  float g1Total = 0.5 * (acc.psiXX - acc.psiYY);
  float g2Total = acc.psiXY;
  float gamma = sqrt(g1Total * g1Total + g2Total * g2Total);
  float a11 = 1.0 - acc.psiXX;
  float a22 = 1.0 - acc.psiYY;
  float a12 = -acc.psiXY;
  float detA = a11 * a22 - a12 * a12;
  float lambdaT = 1.0 - kappa - gamma;
  float lambdaR = 1.0 - kappa + gamma;

  return LensField(acc.psi, acc.alpha, kappa, gamma, detA, lambdaT, lambdaR);
}

// ============================================================================
// 2. PROCEDURAL GRAND-DESIGN SPIRAL & JWST DEEP-FIELD SOURCE PLANE
// ============================================================================

vec3 evalSpiralGalaxy(
  vec2 rel,
  float scale,
  float paRad,
  float inclination,
  float quasarCore,
  vec3 armTint,
  float coreTempK
) {
  float c = cos(paRad);
  float s = sin(paRad);
  vec2 pRot = vec2(c * rel.x + s * rel.y, (-s * rel.x + c * rel.y) / max(inclination, 0.25));
  vec2 p = pRot / max(scale, 0.08);
  float r = length(p);
  if (r > 3.6) {
    return vec3(0.0);
  }

  float theta = atan(p.y, p.x);

  float outerFade = smoothstep(3.55, 1.85, r);
  float barR = length(vec2(p.x * 0.65, p.y * 1.45));
  float bulge = exp(-2.7 * pow(r + 0.02, 0.72)) * outerFade;
  float barGlow = 0.42 * exp(-barR * barR * 4.5) * outerFade;
  vec3 bulgeCol = sampleBlackbody(coreTempK) * (bulge * 2.2 + barGlow * 1.3);

  float lnR = log(max(r, 0.06));
  float armPhase1 = 2.0 * theta - 3.65 * lnR;
  float armPhase2 = 4.0 * theta - 7.1 * lnR + 1.1;
  float armMain = pow(max(0.5 + 0.5 * cos(armPhase1), 0.0), 3.0);
  float armSub = pow(max(0.5 + 0.5 * cos(armPhase2), 0.0), 4.5);

  float dustRidge = pow(max(0.5 + 0.5 * cos(armPhase1 + 0.62), 0.0), 5.0);
  float diskEnv = smoothstep(0.08, 0.34, r) * exp(-1.15 * r) * outerFade;
  float dustAtten = 1.0 - 0.52 * dustRidge * diskEnv;

  float youngStars = (armMain * 1.25 + armSub * 0.48 + 0.16) * diskEnv * dustAtten;
  vec3 armCol = armTint * youngStars * 1.75;

  vec2 knotCell = vec2(theta * 3.82, r * 6.5);
  vec2 knotId = floor(knotCell);
  vec2 knotUv = fract(knotCell) - vec2(0.5);
  vec2 knotRnd = hash22(knotId);
  float knotDist = length(knotUv - (knotRnd - 0.5) * 0.42);
  float onArm = smoothstep(0.45, 0.92, armMain);
  float knotMask = exp(-knotDist * knotDist * 26.0) * onArm * diskEnv * step(0.46, knotRnd.x);
  vec3 hiiCol = vec3(1.35, 0.24, 0.68) * knotMask * 1.9;

  float coreTight = exp(-(r * r) / 0.0055) * 5.2;
  float coreHalo = exp(-r * 6.5) * 0.95;
  vec3 qCol = sampleBlackbody(9200.0) * (coreTight + coreHalo) * quasarCore;

  return (bulgeCol + armCol + hiiCol + qCol);
}

vec3 evalEllipticalSource(vec2 rel, float scale, float paRad, float q, float tempK, float peakGain) {
  float c = cos(paRad);
  float s = sin(paRad);
  vec2 p = vec2(c * rel.x + s * rel.y, (-s * rel.x + c * rel.y) / max(q, 0.3)) / max(scale, 0.06);
  float r = length(p);
  if (r > 3.8) {
    return vec3(0.0);
  }
  float outerFade = smoothstep(3.7, 2.0, r);
  float sersic = exp(-2.9 * pow(r + 0.03, 0.65)) * outerFade;
  float core = exp(-r * r * 32.0) * 1.4 * outerFade;
  return sampleBlackbody(tempK) * (sersic + core) * peakGain;
}

vec3 evalSourcePlane(
  vec2 beta,
  vec2 sourcePos,
  float sourceScale,
  float quasarCore,
  float extraGalaxies
) {
  vec3 col = vec3(0.0);

  col += evalSpiralGalaxy(
    beta - sourcePos,
    sourceScale,
    0.52,
    0.66,
    quasarCore,
    vec3(0.36, 0.68, 1.45),
    4200.0
  );

  if (extraGalaxies > 0.01) {
    col += extraGalaxies * evalSpiralGalaxy(
      beta - vec2(-0.78, 0.86),
      sourceScale * 0.72,
      -0.85,
      0.56,
      0.40,
      vec3(0.30, 0.62, 1.48),
      4800.0
    );
    col += extraGalaxies * evalEllipticalSource(
      beta - vec2(0.92, 0.52),
      sourceScale * 0.44,
      0.70,
      0.58,
      2650.0,
      1.75
    );
    col += extraGalaxies * evalSpiralGalaxy(
      beta - vec2(0.16, -0.14),
      sourceScale * 0.42,
      1.30,
      0.72,
      0.32,
      vec3(0.95, 0.46, 0.78),
      3900.0
    );
    col += extraGalaxies * evalSpiralGalaxy(
      beta - vec2(-3.85, -2.55),
      0.78,
      -0.42,
      0.55,
      0.30,
      vec3(0.38, 0.72, 1.35),
      4400.0
    );
    col += extraGalaxies * evalEllipticalSource(
      beta - vec2(4.10, 2.35),
      0.62,
      0.95,
      0.74,
      3600.0,
      1.25
    );
  }

  return col;
}

// ============================================================================
// 3. DEEP-FIELD BACKGROUND STARS & 4K SKY
// ============================================================================

vec3 evalDeepStars(vec2 uvSky, float starBoost) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float scale = (layer == 1) ? 108.0 : 48.0;
    vec2 grid = vec2(uvSky.x * scale * 2.0, uvSky.y * scale);
    vec2 id = floor(grid);
    vec2 f = fract(grid) - vec2(0.5);
    vec2 rnd = hash22(id + vec2(float(layer) * 37.0, 11.3));
    float prob = step((layer == 1) ? 0.88 : 0.84, rnd.x);
    if (prob > 0.5) {
      vec2 jitter = (rnd - 0.5) * 0.42;
      float d = length(f - jitter);
      float cellFade = smoothstep(0.49, 0.24, max(abs(f.x), abs(f.y)));
      float size = (layer == 1) ? 0.024 : 0.032;
      float core = exp(-(d * d) / (size * size));
      float halo = exp(-d / (size * 2.1)) * 0.22;
      float tempK = mix(2800.0, 16500.0, pow(fract(rnd.y * 13.7), 1.6));
      float lum = pow(fract(rnd.x * 29.3), 2.2) * ((layer == 1) ? 1.05 : 1.6);
      col += sampleBlackbody(tempK) * (core + halo) * lum * starBoost * cellFade;
    }
  }
  return col;
}

// ============================================================================
// 4. 3D FOREGROUND CLUSTER GALAXIES & VOLUMETRIC X-RAY ICM HAZE
// ============================================================================

vec4 evalClusterGalaxies3D(
  vec3 ro,
  vec3 rd,
  int lensModel,
  float thetaE,
  float ellip,
  float lensAngleRad,
  float clusterLight,
  float subhaloStrength
) {
  vec3 accumRgb = vec3(0.0);
  float transm = 1.0;

  if (clusterLight <= 1e-4) {
    return vec4(accumRgb, transm);
  }

  float tCent = dot(-ro, rd);
  if (tCent > 0.05) {
    vec3 pC = ro + rd * tCent;
    float rC = length(pC);
    if (lensModel == 0) {
      float rCore = 0.08 * thetaE;
      float starGlow = exp(-(rC * rC) / max(rCore * rCore, 1e-4)) * 2.6
                     + exp(-rC / max(0.18 * thetaE, 0.05)) * 0.35;
      vec3 cCol = sampleBlackbody(8600.0) * starGlow * clusterLight;
      float op = clamp(exp(-(rC * rC) / max(0.03 * thetaE * thetaE, 1e-4)) * 0.72, 0.0, 0.85);
      accumRgb += cCol * transm;
      transm *= (1.0 - op);
    } else {
      float cA = cos(lensAngleRad);
      float sA = sin(lensAngleRad);
      float qBcg = clamp(1.0 - ellip * 0.82, 0.38, 1.0);
      vec2 rotXY = vec2(cA * pC.x + sA * pC.y, (-sA * pC.x + cA * pC.y) / qBcg);
      float rEll = length(vec3(rotXY.x, rotXY.y, pC.z / 0.75)) / max(0.42 * thetaE, 0.25);
      if (rEll < 3.4) {
        float fade = smoothstep(3.4, 2.0, rEll);
        float sersic = exp(-3.1 * pow(rEll + 0.04, 0.58)) * fade;
        float core = exp(-rEll * rEll * 22.0) * 1.55 * fade;
        vec3 bcgCol = sampleBlackbody(3650.0) * (sersic * 1.28 + core) * clusterLight;
        float op = clamp(sersic * 0.45 * min(clusterLight, 1.4), 0.0, 0.82);
        accumRgb += bcgCol * transm;
        transm *= (1.0 - op);
      }
    }
  }

  if (lensModel == 2 && subhaloStrength > 0.05) {
    float clusterScale = thetaE / 2.85;
    float memGain = clusterLight * smoothstep(0.0, 0.35, subhaloStrength);
    for (int i = 0; i < 6; i++) {
      vec4 d0 = getSubhaloData(i);
      vec4 d1 = getSubhaloShape(i);
      vec3 gPos = vec3(d0.x, d0.y, d0.w) * clusterScale;
      float tG = dot(gPos - ro, rd);
      if (tG > 0.05) {
        vec3 dVec = (ro + rd * tG) - gPos;
        float cG = cos(d1.z);
        float sG = sin(d1.z);
        float qG = clamp(1.0 - d1.y, 0.45, 1.0);
        vec2 rLoc = vec2(cG * dVec.x + sG * dVec.y, (-sG * dVec.x + cG * dVec.y) / qG);
        float rad = length(vec3(rLoc.x, rLoc.y, dVec.z * 1.15)) / max(0.22 * thetaE, 0.14);
        if (rad < 3.2) {
          float mFade = smoothstep(3.2, 1.9, rad);
          float sersic = exp(-3.0 * pow(rad + 0.05, 0.62)) * mFade;
          float core = exp(-rad * rad * 26.0) * 1.4 * mFade;
          vec3 memCol = sampleBlackbody(d1.w - 250.0) * (sersic * 1.08 + core) * memGain;
          float op = clamp(sersic * 0.40 * min(memGain, 1.4), 0.0, 0.74);
          accumRgb += memCol * transm;
          transm *= (1.0 - op);
        }
      }
    }
  }

  return vec4(accumRgb, transm);
}

vec4 integrateIcmVolume(
  vec3 ro,
  vec3 rd,
  float thetaE,
  float icmGlow,
  int quality,
  vec4 bn,
  float simTime
) {
  if (icmGlow <= 1e-4) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }
  float rVol = max(3.4 * thetaE, 2.5);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rVol * rVol;
  float disc = b * b - c;
  if (disc <= 0.0) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }
  float sq = sqrt(disc);
  float tNear = max(-b - sq, 0.05);
  float tFar = max(-b + sq, tNear);
  if (tFar <= tNear) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  int steps = 14;
  if (quality <= 0) {
    steps = 10;
  } else if (quality >= 2) {
    steps = 20;
  }

  float stepLen = (tFar - tNear) / float(steps);
  vec3 accum = vec3(0.0);
  float transm = 1.0;

  float invRVol = 1.0 / rVol;
  vec3 drift = vec3(simTime * 0.008, -simTime * 0.005, simTime * 0.006);

  for (int i = 0; i < 20; i++) {
    if (i >= steps) {
      break;
    }
    float t = tNear + (float(i) + bn.x) * stepLen;
    vec3 p = ro + rd * t;
    float uRad = length(p) * invRVol;
    float radialFalloff = exp(-4.4 * uRad * uRad) * (1.0 - smoothstep(0.62, 1.0, uRad));

    if (radialFalloff > 0.004) {
      vec3 nCoord = p * (0.14 / max(thetaE * 0.4, 0.5)) + drift;
      vec4 nSample = textureLod(uVolumeNoise, nCoord, 0.0);
      float filament = mix(nSample.r, nSample.g, 0.45);
      float density = radialFalloff * (0.22 + 0.78 * filament) * icmGlow * 0.015;
      vec3 xRayCol = mix(vec3(0.08, 0.22, 0.78), vec3(0.24, 0.58, 1.05), nSample.b);
      float dTau = density * stepLen;
      accum += xRayCol * dTau * transm;
      transm *= exp(-dTau * 0.20);
    }
  }

  return vec4(accum, transm);
}

// ============================================================================
// 5. SCIENTIFIC CAUSTICS & FERMAT ARRIVAL-TIME OVERLAYS
// ============================================================================

float distPointToSegment2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

vec2 evalCausticDistance(
  vec2 theta,
  vec3 cRight,
  vec3 cUp,
  int lensModel,
  float thetaE,
  float ellip,
  float extShear,
  float lensAngleRad,
  float shearAngleRad,
  float subhaloStrength
) {
  float tanDist = 100.0;
  float radDist = 100.0;

  if (lensModel == 0) {
    if (extShear < 0.005) {
      tanDist = length(theta);
    } else {
      float cs = cos(shearAngleRad);
      float ss = sin(shearAngleRad);
      float amp = 2.0 * extShear * thetaE / max(sqrt(max(1.0 - extShear * extShear, 0.2)), 0.4);
      vec2 prevPt = vec2(0.0);
      for (int k = 0; k <= 24; k++) {
        float ang = float(k) * (TAU / 24.0);
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 locPt = vec2(amp * ca * ca * ca, -amp * sa * sa * sa);
        vec2 pt = vec2(cs * locPt.x - ss * locPt.y, ss * locPt.x + cs * locPt.y);
        if (k > 0) {
          tanDist = min(tanDist, distPointToSegment2(theta, prevPt, pt));
        }
        prevPt = pt;
      }
    }
    return vec2(tanDist, radDist);
  }

  float q = clamp(1.0 - ellip, 0.25, 1.0);
  float cL = cos(lensAngleRad);
  float sL = sin(lensAngleRad);
  vec2 prevCaustic = vec2(0.0);
  int segs = 28;

  for (int k = 0; k <= 28; k++) {
    float phi = float(k) * (TAU / float(segs));
    float cp = cos(phi);
    float sp = sin(phi);
    float rCrit;
    if (lensModel == 1) {
      rCrit = (thetaE * sqrt(q)) / max(sqrt(q * q * cp * cp + sp * sp), 0.1);
    } else {
      rCrit = thetaE / max(sqrt(q * q * cp * cp + sp * sp), 0.2);
      float r1 = rCrit * 0.92;
      float r2 = rCrit * 1.08;
      vec2 uDir = vec2(cL * cp - sL * sp, sL * cp + cL * sp);
      float l1 = evalLensField(uDir.x * r1, uDir.y * r1, cRight, cUp, lensModel, thetaE, ellip, extShear, lensAngleRad, shearAngleRad, 0.0).lambdaT;
      float l2 = evalLensField(uDir.x * r2, uDir.y * r2, cRight, cUp, lensModel, thetaE, ellip, extShear, lensAngleRad, shearAngleRad, 0.0).lambdaT;
      float dL = l2 - l1;
      float tLerp = clamp(-l1 / (abs(dL) < 1e-4 ? 1e-4 : dL), -0.5, 1.5);
      rCrit = mix(r1, r2, tLerp);
    }
    vec2 dirWorld = vec2(cL * cp - sL * sp, sL * cp + cL * sp);
    vec2 thetaC = dirWorld * rCrit;
    LensField lf = evalLensField(
      thetaC.x, thetaC.y,
      cRight, cUp, lensModel, thetaE, ellip, extShear, lensAngleRad, shearAngleRad, 0.0
    );
    vec2 betaC = thetaC - lf.alpha;
    if (k > 0) {
      tanDist = min(tanDist, distPointToSegment2(theta, prevCaustic, betaC));
    }
    prevCaustic = betaC;
  }

  float radialCauR = (lensModel == 1) ? thetaE * 0.62 * q : thetaE * 0.36 * (0.65 + 0.35 * q);
  radDist = abs(length(theta) - radialCauR);

  return vec2(tanDist, radDist);
}

void main() {
  vec2 res = u.resolution_time_frame.xy;
  float simTime = u.resolution_time_frame.z;
  int frameIndex = int(u.resolution_time_frame.w);

  vec2 jitter = u.jitter_fov_prog.xy;
  float fovY = u.jitter_fov_prog.z;

  vec3 ro = u.camPos_unused.xyz;
  vec3 camRight = u.camRight_model.xyz;
  vec3 camUp = u.camUp_thetaE.xyz;
  vec3 camFwd = u.camFwd_ellip.xyz;

  int lensModel = int(floor(u.camRight_model.w + 0.5));
  float thetaE = max(u.camUp_thetaE.w, 0.25);
  float ellip = clamp(u.camFwd_ellip.w, 0.0, 0.72);

  float extShear = clamp(u.lensShapeParams.x, 0.0, 0.40);
  float lensAngleRad = u.lensShapeParams.y;
  float shearAngleRad = u.lensShapeParams.z;
  float subhaloStrength = clamp(u.lensShapeParams.w, 0.0, 3.0);

  vec2 sourcePos = u.sourceParams.xy;
  float sourceScale = clamp(u.sourceParams.z, 0.12, 2.0);
  float quasarCore = max(u.sourceParams.w, 0.0);

  float showCaustics = u.overlayParams.x;
  float showFermat = u.overlayParams.y;
  float extraGalaxies = max(u.overlayParams.w, 0.0);

  float clusterLight = max(u.clusterOpticsParams.x, 0.0);
  float icmGlow = max(u.clusterOpticsParams.y, 0.0);
  float skyIntensity = max(u.clusterOpticsParams.z, 0.0);
  int skyMode = int(floor(u.clusterOpticsParams.w + 0.5));

  vec2 skyRot = u.skyQualityParams.xy;
  int quality = int(floor(u.skyQualityParams.z + 0.5));

  vec2 pxCoord = gl_FragCoord.xy + jitter;
  vec2 ndc = vec2(
    (pxCoord.x / max(res.x, 1.0)) * 2.0 - 1.0,
    (pxCoord.y / max(res.y, 1.0)) * 2.0 - 1.0
  );
  float aspect = res.x / max(res.y, 1.0);
  float tanHalfFov = tan(0.5 * fovY);
  vec3 rd = normalize(
    camFwd +
    camRight * (ndc.x * aspect * tanHalfFov) +
    camUp * (ndc.y * tanHalfFov)
  );

  float rLen = max(length(ro), 1e-4);
  vec3 cFwd = ro / rLen;
  vec3 rawRight = cross(vec3(0.0, 1.0, 0.0), cFwd);
  vec3 cRight = (length(rawRight) > 1e-4) ? normalize(rawRight) : vec3(1.0, 0.0, 0.0);
  vec3 cUp = cross(cFwd, cRight);

  float tImpact = -dot(ro, rd);
  vec3 pImpact = ro + rd * tImpact;
  vec2 theta = vec2(dot(pImpact, cRight), dot(pImpact, cUp));

  LensField lf = evalLensField(
    theta.x, theta.y,
    cRight, cUp,
    lensModel,
    thetaE,
    ellip,
    extShear,
    lensAngleRad,
    shearAngleRad,
    subhaloStrength
  );

  vec2 beta = theta - lf.alpha;
  float fermatTau = 0.5 * dot(theta - sourcePos, theta - sourcePos) - lf.psi;

  float fwTheta = max(length(fwidth(theta)), 1e-4);
  float fwLambdaT = max(fwidth(lf.lambdaT), 1e-4);
  float fwLambdaR = max(fwidth(lf.lambdaR), 1e-4);
  float tauStep = max(0.14 * thetaE * thetaE, 0.12);
  float tauNorm = fermatTau / tauStep;
  float fwTauNorm = max(fwidth(tauNorm), 1e-4);

  vec3 deflWorld = (cRight * lf.alpha.x + cUp * lf.alpha.y) * 0.022;
  vec3 rdLensed = normalize(rd - deflWorld);
  vec3 dir = normalize(rotateSkyDir(rdLensed, skyRot));
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
  dUVdx = clamp(dUVdx, vec2(-0.2), vec2(0.2));
  dUVdy = clamp(dUVdy, vec2(-0.2), vec2(0.2));
  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.002, 0.998));

  vec3 realSky = textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 procSky = textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skySample = (skyMode == 1) ? procSky : realSky;

  ivec2 bnCoord = ivec2(gl_FragCoord.xy) & ivec2(127);
  vec4 bnRaw = texelFetch(uBlueNoise, bnCoord, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  vec3 stars = evalDeepStars(sampleUv, 0.48 + 0.35 * skyIntensity);
  vec3 galaxies = evalSourcePlane(beta, sourcePos, sourceScale, quasarCore, extraGalaxies);
  vec3 radiance = skySample * skyIntensity * 0.20 + stars + galaxies;

  vec4 icm = integrateIcmVolume(ro, rd, thetaE, icmGlow, quality, bn, simTime);
  radiance = radiance * icm.w + icm.xyz;

  vec4 fg = evalClusterGalaxies3D(
    ro, rd, lensModel, thetaE, ellip, lensAngleRad, clusterLight, subhaloStrength
  );
  radiance = radiance * fg.w + fg.xyz;

  if (showCaustics > 0.5) {
    float tanCritDist = abs(lf.lambdaT) / fwLambdaT;
    float tanCritMask = 1.0 - smoothstep(0.55, 1.55, tanCritDist);
    radiance = mix(radiance, vec3(0.24, 0.88, 1.45), tanCritMask * 0.88);

    if (lensModel != 0) {
      float radCritDist = abs(lf.lambdaR) / fwLambdaR;
      float radCritMask = (1.0 - smoothstep(0.55, 1.55, radCritDist)) * smoothstep(0.05 * thetaE, 0.14 * thetaE, length(theta));
      radiance = mix(radiance, vec3(1.25, 0.72, 0.22), radCritMask * 0.78);
    }

    if (length(theta) < 2.2 * thetaE) {
      vec2 cauDists = evalCausticDistance(
        theta, cRight, cUp,
        lensModel, thetaE, ellip, extShear, lensAngleRad, shearAngleRad, subhaloStrength
      );
      float tanCauPx = cauDists.x / fwTheta;
      float tanCauMask = 1.0 - smoothstep(0.6, 1.7, tanCauPx);
      radiance = mix(radiance, vec3(1.45, 0.34, 0.86), tanCauMask * 0.92);

      if (lensModel != 0) {
        float radCauPx = cauDists.y / fwTheta;
        float radCauMask = 1.0 - smoothstep(0.6, 1.6, radCauPx);
        radiance = mix(radiance, vec3(1.15, 0.55, 0.24), radCauMask * 0.65);
      }
    }

    float dSrcPx = length(theta - sourcePos) / fwTheta;
    float ringPx = abs(dSrcPx - 9.0);
    float srcMarker = (1.0 - smoothstep(0.5, 1.5, ringPx)) + (1.0 - smoothstep(1.2, 2.5, dSrcPx)) * 0.65;
    radiance = mix(radiance, vec3(1.55, 0.88, 1.25), clamp(srcMarker, 0.0, 1.0) * 0.85);
  }

  if (showFermat > 0.5) {
    float contourDist = abs(fract(tauNorm - 0.5) - 0.5) / fwTauNorm;
    float fermatLine = 1.0 - smoothstep(0.50, 1.45, contourDist);
    radiance = mix(radiance, vec3(1.28, 0.98, 0.48), fermatLine * 0.68);

    float gradErr = length(beta - sourcePos) / max(thetaE, 0.25);
    float statGlow = exp(-(gradErr * gradErr) / 0.00055);
    radiance += vec3(0.42, 0.92, 0.85) * statGlow * 0.55;
  }

  fragColor = vec4(sanitizeHdr(radiance), 1.0);
}
`;
