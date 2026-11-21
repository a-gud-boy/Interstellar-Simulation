/**
 * Cinema-grade WebGL2 GLSL 300 es ADM Warp Drive Geodesic & Volumetric Shader
 * for "Alcubierre Warp Drive Simulator".
 *
 * Physics & Optical Architecture:
 *  - Three exact 3+1 ADM warp metrics (alpha = 1, gamma_ij = delta_ij):
 *      0: Alcubierre (bell-shaped hyperbolic tangent bubble)
 *      1: Natario Zero-Expansion (identically divergence-free theta === 0)
 *      2: Lentz Rhomboidal Soliton (Lp diamond shell with positive bow/stern T_00 > 0 lobes)
 *  - Dual-frame shift blending (frameBlend=0 External Chase vs frameBlend=1 Inside Bridge).
 *  - Exact Hamiltonian backward ADM null geodesic RK4 integrator (ds = -dt > 0)
 *    with analytical metric Jacobians & NVIDIA safeTanh/safeSech2 [-15, 15] NaN guards.
 *  - Causal horizon trapping (|k| > 28) producing pitch-black causal shadow core
 *    framed by a crisp crimson-amber Hawking rim glow as |k| ramps 16 -> 28.
 *  - CIE-1931 Planck blackbody Doppler shift with UV O-star & IR dwarf layers,
 *    blue-noise stratified 128^3 periodic 3D volumetric exotic wall shimmer,
 *    bow-shock star caustic ring, and external interstellar dust streaks.
 */

export const WARP_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 144-byte std140 UBO matching WarpUniforms in warp.wgsl.js
layout(std140) uniform WarpUniforms {
  vec4 resolution_time_frame;  // (width, height, time, float(frameIndex))
  vec4 jitter_fov_mode;        // (jitterX, jitterY, fovY, float(cameraMode))
  vec4 camPos_metric;          // (camX, camY, camZ, float(metricType))
  vec4 camRight_vs;            // (rightX, rightY, rightZ, warpVelocity)
  vec4 camUp_R;                // (upX, upY, upZ, bubbleRadius)
  vec4 camFwd_sigma;           // (fwdX, fwdY, fwdZ, wallThickness)
  vec4 physicsParams;          // (dopplerStrength, wallShimmer, causticGlow, starStreaks)
  vec4 skyParams;              // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  vec4 qualityParams;          // (float(quality), flowSpeed, frameBlend, 0.0)
} u;

// Locked texture units 0..4
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8 (fbm, ridged, worley, micro)
uniform sampler2D uSkyMap;        // unit 1: 4K equirectangular Milky Way (sRGB RGBA8)
uniform sampler2D uProcSkyMap;    // unit 2: Procedural equirectangular sky (sRGB RGBA8)
uniform sampler2D uBlackbodyLut;  // unit 3: 512x1 linear CIE-1931 Planck LUT (800K..40000K log)
uniform sampler2D uBlueNoise;     // unit 4: 128x128 RGBA8 void-and-cluster blue noise

const float PI               = 3.14159265359;
const float TAU              = 6.28318530718;
const float INV_PI           = 0.31830988618;
const float INV_TAU          = 0.15915494309;
const float T_MIN            = 800.0;
const float T_MAX            = 40000.0;
const float INV_LOG_T_SPAN   = 1.0 / 3.91202300543;

// ============================================================================
// 1. NVIDIA-SAFE HYPERBOLIC HELPERS & ADM WARP METRIC JACOBIANS
// ============================================================================

float safeTanh(float x) {
  return tanh(clamp(x, -15.0, 15.0));
}

float safeSech2(float x) {
  if (abs(x) > 15.0) return 0.0;
  float c = cosh(x);
  return 1.0 / (c * c);
}

struct ShapeResult {
  float f;
  float df;
  float d2f;
  float dfOverR;
};

ShapeResult evalShape(float r, float R, float sigma) {
  float sr = sigma * R;
  float tanhSR = safeTanh(sr);
  float denom2 = max(2.0 * tanhSR, 1e-5);
  float denom1 = max(tanhSR, 1e-5);

  float a = sigma * (r + R);
  float b = sigma * (r - R);
  float ta = safeTanh(a);
  float tb = safeTanh(b);
  float sa = safeSech2(a);
  float sb = safeSech2(b);

  ShapeResult s;
  s.f = (ta - tb) / denom2;
  s.df = (sigma / denom2) * (sa - sb);
  s.d2f = (sigma * sigma / denom1) * (-sa * ta + sb * tb);
  s.dfOverR = (r < 1e-3) ? (-2.0 * sigma * sigma * safeSech2(sr)) : (s.df / r);
  return s;
}

float evalLentzR(vec3 pos, float R) {
  const float p = 1.38;
  const float halfP = 0.69;
  float eps = 0.12 * R;
  float eps2 = eps * eps;
  float rho2 = pos.x * pos.x + pos.y * pos.y;
  float uVal = rho2 + eps2;
  float vVal = pos.z * pos.z + eps2;
  return pow(pow(uVal, halfP) + pow(vVal, halfP), 1.0 / p);
}

struct MetricSample {
  vec3  beta;
  vec3  dBdx;
  vec3  dBdy;
  vec3  dBdz;
  float theta;
  float t00;
  float rEff;
};

MetricSample evalMetric(vec3 pos, float R, float sigma, float v_s, int metricType, float frameBlend) {
  MetricSample m;
  float r2 = dot(pos, pos);
  float r = sqrt(r2);

  if (metricType == 0) {
    ShapeResult sh = evalShape(r, R, sigma);
    m.beta = vec3(0.0, 0.0, v_s * (1.0 - sh.f));
    m.dBdx = vec3(0.0, 0.0, -v_s * sh.dfOverR * pos.x);
    m.dBdy = vec3(0.0, 0.0, -v_s * sh.dfOverR * pos.y);
    m.dBdz = vec3(0.0, 0.0, -v_s * sh.dfOverR * pos.z);
    m.theta = -m.dBdz.z;
    m.t00 = -(m.dBdx.z * m.dBdx.z + m.dBdy.z * m.dBdy.z) / (32.0 * PI);
    m.rEff = r;
  } else if (metricType == 1) {
    ShapeResult sh = evalShape(r, R, sigma);
    float h = sh.dfOverR;
    float dhOverR;
    if (r < 2e-3) {
      float s2 = sigma * sigma;
      float sech2SR = safeSech2(sigma * R);
      dhOverR = (8.0 / 3.0) * (s2 * s2) * sech2SR * (3.0 * sech2SR - 1.0);
    } else {
      dhOverR = (sh.d2f - h) / (r * r);
    }
    float halfVs = 0.5 * v_s;
    float rho2 = pos.x * pos.x + pos.y * pos.y;

    m.beta = vec3(
      halfVs * h * pos.x * pos.z,
      halfVs * h * pos.y * pos.z,
      v_s * (1.0 - sh.f) - halfVs * h * rho2
    );

    m.dBdx = vec3(
      halfVs * (dhOverR * pos.x * pos.x * pos.z + h * pos.z),
      halfVs * (dhOverR * pos.x * pos.y * pos.z),
      -2.0 * v_s * h * pos.x - halfVs * dhOverR * pos.x * rho2
    );
    m.dBdy = vec3(
      halfVs * (dhOverR * pos.y * pos.x * pos.z),
      halfVs * (dhOverR * pos.y * pos.y * pos.z + h * pos.z),
      -2.0 * v_s * h * pos.y - halfVs * dhOverR * pos.y * rho2
    );
    m.dBdz = vec3(
      halfVs * (dhOverR * pos.z * pos.x * pos.z + h * pos.x),
      halfVs * (dhOverR * pos.z * pos.y * pos.z + h * pos.y),
      -v_s * h * pos.z - halfVs * dhOverR * pos.z * rho2
    );

    m.theta = 0.0;
    float k01 = 0.5 * (m.dBdx.y + m.dBdy.x);
    float k02 = 0.5 * (m.dBdx.z + m.dBdz.x);
    float k12 = 0.5 * (m.dBdy.z + m.dBdz.y);
    float sumK2 =
      m.dBdx.x * m.dBdx.x +
      m.dBdy.y * m.dBdy.y +
      m.dBdz.z * m.dBdz.z +
      2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
    m.t00 = -sumK2 / (16.0 * PI);
    m.rEff = r;
  } else {
    const float p = 1.38;
    const float halfP = 0.69;
    float eps = 0.12 * R;
    float eps2 = eps * eps;
    float rho2 = pos.x * pos.x + pos.y * pos.y;
    float uVal = rho2 + eps2;
    float vVal = pos.z * pos.z + eps2;
    float aTerm = pow(uVal, halfP);
    float bTerm = pow(vVal, halfP);
    float sTerm = aTerm + bTerm;
    float rL = pow(sTerm, 1.0 / p);

    float kRho = (rL / sTerm) * (aTerm / uVal);
    float kZ = (rL / sTerm) * (bTerm / vVal);
    float drdx = kRho * pos.x;
    float drdy = kRho * pos.y;
    float drdz = kZ * pos.z;

    ShapeResult sh = evalShape(rL, R, sigma);
    float invRL = 1.0 / max(rL, 1e-3);
    float c = -0.28 * v_s;
    float invR = 1.0 / max(R, 1e-3);
    float zArg = 2.0 * pos.z * invR;
    float tz = safeTanh(zArg);
    float dtz = 2.0 * invR * safeSech2(zArg);
    float gL = sh.df * invRL;
    float dgL = (sh.d2f - gL) * invRL;

    float sc = c * gL * tz;
    float dscdx = c * tz * dgL * drdx;
    float dscdy = c * tz * dgL * drdy;
    float dscdz = c * (tz * dgL * drdz + gL * dtz);

    m.beta = vec3(sc * pos.x, sc * pos.y, v_s * (1.0 - sh.f));
    m.dBdx = vec3(sc + pos.x * dscdx, pos.y * dscdx, -v_s * sh.df * drdx);
    m.dBdy = vec3(pos.x * dscdy, sc + pos.y * dscdy, -v_s * sh.df * drdy);
    m.dBdz = vec3(pos.x * dscdz, pos.y * dscdz, -v_s * sh.df * drdz);

    m.theta = -(m.dBdx.x + m.dBdy.y + m.dBdz.z);
    float k01 = 0.5 * (m.dBdx.y + m.dBdy.x);
    float k02 = 0.5 * (m.dBdx.z + m.dBdz.x);
    float k12 = 0.5 * (m.dBdy.z + m.dBdz.y);
    float sumK2 =
      m.dBdx.x * m.dBdx.x +
      m.dBdy.y * m.dBdy.y +
      m.dBdz.z * m.dBdz.z +
      2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
    m.t00 = (m.theta * m.theta - sumK2) / (16.0 * PI);
    m.rEff = rL;
  }

  m.beta.z -= (1.0 - frameBlend) * v_s;
  return m;
}

struct GeodesicDeriv {
  vec3  dp;
  vec3  dk;
  float theta;
  float t00;
  float rEff;
};

GeodesicDeriv evalGeodesicRHS(vec3 pos, vec3 k, float R, float sigma, float v_s, int metricType, float frameBlend) {
  MetricSample m = evalMetric(pos, R, sigma, v_s, metricType, frameBlend);
  float kLen = max(length(k), 1e-6);
  vec3 khat = k / kLen;

  GeodesicDeriv d;
  d.dp = -khat + m.beta;
  d.dk.x = -(k.x * m.dBdx.x + k.y * m.dBdx.y + k.z * m.dBdx.z);
  d.dk.y = -(k.x * m.dBdy.x + k.y * m.dBdy.y + k.z * m.dBdy.z);
  d.dk.z = -(k.x * m.dBdz.x + k.y * m.dBdz.y + k.z * m.dBdz.z);
  d.theta = m.theta;
  d.t00 = m.t00;
  d.rEff = m.rEff;
  return d;
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT & MULTI-SPECTRAL STAR LAYERS
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

// Spectral class: 0 = Main sequence (3000K..22000K), 1 = IR 1200K dwarfs, 2 = UV 22000K O-stars
vec3 evalSpectralStarLayer(vec3 dir, float scale, float densityThresh, float boost, float pixelFw, float gEff, int spectralClass) {
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
  float starRad = mix(0.028, 0.088, mag) + fw * 0.42;
  float core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) return vec3(0.0);

  float ry = max(rnd.y, 0.0);
  float tEmit;
  float bandpassGain = 1.0;

  if (spectralClass == 1) {
    // Cool 1200K..1850K IR dwarfs: invisible at rest, ignite into golden-white/cyan when blue-shifted
    tEmit = mix(1150.0, 1850.0, ry);
    bandpassGain = smoothstep(1.12, 2.25, gEff) * 1.55;
  } else if (spectralClass == 2) {
    // Hot 20000K..32000K UV O-stars: dim UV at rest, shift down into visible amber/ruby even near aft rim
    tEmit = mix(20000.0, 32000.0, ry);
    bandpassGain = mix(0.32, 1.65, smoothstep(0.95, 0.22, gEff)) * smoothstep(0.03, 0.16, gEff);
  } else {
    tEmit = mix(3000.0, 22000.0, ry * ry);
    bandpassGain = smoothstep(0.06, 0.40, gEff);
  }

  if (bandpassGain < 0.002) return vec3(0.0);

  float tObs = tEmit * gEff;
  vec3 col = sampleBlackbody(tObs);
  float beam = pow(clamp(gEff, 0.18, 3.6), 1.35);
  beam = beam / (1.0 + 0.14 * beam);

  float energyComp = 1.0 / (1.0 + fw * 6.0);
  float lum = (0.12 + 3.6 * mag) * boost * energyComp * bandpassGain * beam;
  return col * (core * lum);
}

// ============================================================================
// 3. VOLUMETRIC EXOTIC WALL SHIMMER & INTERSTELLAR DUST STREAKS
// ============================================================================

vec3 evalWallShimmer(
  vec3 pos,
  float R,
  float sigma,
  float v_s,
  float t00,
  float theta,
  float kLen,
  float frameBlend,
  int metricType,
  float time,
  float flowSpeed,
  float wallShimmer,
  out float ridgeOut
) {
  ridgeOut = 0.0;
  if (wallShimmer <= 0.001) return vec3(0.0);
  float absT00 = abs(t00);
  float absTheta = abs(theta);
  if (absT00 <= 1e-5 && absTheta <= 1e-3) return vec3(0.0);

  // Advect periodic 3D noise along -Z (texture offset +Z)
  float advZ = time * flowSpeed;
  vec3 uv1 = pos * 0.26 + vec3(0.0, 0.0, advZ * 0.34);
  vec3 uv2 = pos * 0.64 + vec3(0.17, 0.41, advZ * 0.72);
  vec4 n1 = textureLod(uVolumeNoise, uv1, 0.0);
  vec4 n2 = textureLod(uVolumeNoise, uv2, 0.0);

  float filaments = clamp(n1.g * 0.60 + n2.a * 0.52, 0.0, 1.0);
  float sharpFil = smoothstep(0.42, 0.94, filaments);
  float ridge = sharpFil * sharpFil * sharpFil * (0.40 + 0.60 * n1.b);
  ridgeOut = ridge;
  float turbMod = 0.008 + 1.55 * ridge;

  float normT00 = absT00 / (absT00 + 0.095);
  float normTheta = absTheta / (absTheta + 1.65);

  vec3 negCol = mix(
    vec3(0.02, 0.48, 1.00), // Deep cobalt-cerulean
    vec3(0.26, 0.12, 0.88), // Rich indigo-violet eddy
    clamp(1.0 - n1.g, 0.0, 1.0) * 0.72
  );
  negCol = mix(negCol, vec3(0.55, 0.94, 1.00), sharpFil * sharpFil * 0.65);

  vec3 posCol = mix(
    vec3(1.00, 0.74, 0.18), // Lentz solar gold
    vec3(0.35, 0.90, 1.00), // Cyan accent edge
    clamp(n2.a * 0.45, 0.0, 0.5)
  );

  vec3 energyCol = (t00 > 0.0) ? posCol : negCol;
  float energyWeight = (metricType == 1) ? (normT00 * 0.72) : (normT00 * 1.08);

  // Alcubierre / Lentz bow contraction vs aft expansion tint (disabled in Bridge view so cockpit stays clear)
  vec3 yorkCol = (theta < 0.0)
    ? vec3(0.22, 0.82, 1.00)
    : vec3(0.62, 0.24, 0.82);
  float yorkWeight = normTheta * 0.24 * (1.0 - frameBlend);

  float bridgeAtten = mix(1.0, 0.18, frameBlend);
  float causalAtten = (frameBlend > 0.5)
    ? pow(clamp(1.0 / max(kLen, 1.0), 1e-5, 1.0), 2.2)
    : 1.0;

  float scaleGain = mix(1.0, 0.80, clamp((sigma - 2.2) / 3.5, 0.0, 1.0));
  return (energyCol * energyWeight + yorkCol * yorkWeight) * turbMod * wallShimmer * bridgeAtten * causalAtten * scaleGain * 0.19;
}

vec3 evalDustStreak(
  vec3 pos,
  float R,
  float v_s,
  float kLen,
  float frameBlend,
  float time,
  float flowSpeed,
  float starStreaks
) {
  if (starStreaks <= 0.001) return vec3(0.0);
  float r = length(pos);
  if (r <= R * 1.04 || r >= R * 2.85) return vec3(0.0);

  float rInner = R * 1.04;
  float rKnee = R * 1.28;
  float radialEnv = smoothstep(rInner, rKnee, r) * exp(-max(r - rKnee, 0.0) / max(R * 0.68, 0.5));
  if (radialEnv < 0.002) return vec3(0.0);

  float advZ = time * flowSpeed * (0.45 + 0.18 * min(v_s, 3.5));
  vec3 uvw = vec3(pos.x * 0.28, pos.y * 0.28, pos.z * 0.055 + advZ);
  vec4 sn = textureLod(uVolumeNoise, uvw, 0.0);
  float streak = smoothstep(0.60, 0.95, sn.g * 0.62 + sn.a * 0.48);
  streak = streak * streak;

  float causalAtten = (frameBlend > 0.5)
    ? smoothstep(3.8, 1.3, kLen)
    : 1.0;

  vec3 col = mix(vec3(0.32, 0.72, 1.00), vec3(0.84, 0.95, 1.00), sn.a);
  if (pos.z < 0.0) {
    col = mix(col, vec3(0.70, 0.44, 0.92), smoothstep(0.0, -R * 1.5, pos.z) * 0.45);
  }
  float speedGain = 0.35 + 0.25 * min(v_s, 3.5);
  return col * (streak * radialEnv * starStreaks * speedGain * causalAtten * 0.18);
}

// ============================================================================
// 4. SKY BACKGROUND & CAUSTIC / HAWKING RIM COMPOSITOR
// ============================================================================

vec3 sampleSkyBackground(
  vec3 rawDir,
  vec3 rayDir,
  bool escaped,
  float edgeMask,
  float gEff,
  float frameBlend,
  float causticGlow,
  float kFinal,
  float bendAngle,
  float skyIntensity,
  int skyMode,
  vec2 skyRot
) {
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

  vec2 dUVdx = vec2(abs(dx1.x) < abs(dx2.x) ? dx1.x : dx2.x, dx1.y);
  vec2 dUVdy = vec2(abs(dy1.x) < abs(dy2.x) ? dy1.x : dy2.x, dy1.y);

  float dirFw = length(fwidth(dir));

  dUVdx = clamp(dUVdx, vec2(-0.38), vec2(0.38));
  dUVdy = clamp(dUVdy, vec2(-0.38), vec2(0.38));
  if (edgeMask > 0.01) {
    dirFw = min(dirFw, 0.08);
  }

  if (!escaped) return vec3(0.0);

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));
  vec3 mapSrgb = (skyMode == 2)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(0.0)), vec3(2.2));

  // Preserve deep-space black floor so strong forward Doppler boost keeps cosmos crisp & contrasty
  float skyLuma = dot(skyLin, vec3(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.35, 1.0, smoothstep(0.002, 0.042, skyLuma));

  vec3 brightCores = max(skyLin - vec3(0.28), vec3(0.0));
  skyLin += brightCores * brightCores * 2.6;

  // Doppler spectral tint & gentle diffuse beaming (stars get full relativistic beaming separately)
  float tObsMw = 5800.0 * gEff;
  vec3 bbRef = max(sampleBlackbody(5800.0), vec3(0.08));
  vec3 bbMw = sampleBlackbody(tObsMw) / bbRef;
  if (gEff > 1.0) {
    bbMw = mix(bbMw, vec3(0.58, 0.86, 1.24), smoothstep(1.2, 3.2, gEff) * 0.35);
  }
  float beamDiff = mix(1.0, pow(clamp(gEff, 0.16, 3.5), 0.55), 0.65) * smoothstep(0.02, 0.38, gEff);
  skyLin *= bbMw * beamDiff;

  if (skyMode == 0 || skyMode == 2) {
    float starGain = (skyMode == 0) ? 0.75 : 1.05;
    vec3 microStars = evalSpectralStarLayer(dir, 95.0,  0.908, 1.05 * starGain, dirFw, gEff, 0)
                    + evalSpectralStarLayer(dir, 195.0, 0.882, 0.48 * starGain, dirFw, gEff, 0)
                    + evalSpectralStarLayer(dir, 125.0, 0.892, 1.25 * starGain, dirFw, gEff, 1)
                    + evalSpectralStarLayer(dir, 140.0, 0.905, 1.00 * starGain, dirFw, gEff, 2);
    skyLin += microStars;
  }

  // Forward bow-shock caustic ring (narrow circular ring in Bridge; localized critical rim in Chase)
  vec3 causticColor = vec3(0.0);
  if (causticGlow > 0.001) {
    if (frameBlend > 0.5) {
      float fwdCos = clamp(rayDir.z, 0.0, 1.0);
      float dRing = (fwdCos - 0.934) / 0.024;
      float bowRing = exp(-dRing * dRing) * smoothstep(1.12, 2.1, gEff);
      causticColor = vec3(0.42, 0.88, 1.00) * (bowRing * 0.65 * causticGlow);
    } else {
      float dBend = (bendAngle - 0.62) / 0.28;
      float chaseBow = exp(-dBend * dBend) * smoothstep(1.25, 2.3, gEff);
      causticColor = vec3(0.42, 0.88, 1.00) * (chaseBow * 0.24 * causticGlow);
    }
  }

  // Crisp narrow crimson-amber Hawking rim hugging the causal horizon edge (|k| = 16 -> 28)
  float hawkingRamp = smoothstep(16.0, 27.8, kFinal);
  vec3 hawkingRim = vec3(1.00, 0.24, 0.05) * (hawkingRamp * hawkingRamp * 0.46);

  return skyLin * max(skyIntensity, 0.0) + causticColor + hawkingRim;
}

// ============================================================================
// 5. MAIN ADAPTIVE ADM NULL GEODESIC RK4 RAY-MARCHER
// ============================================================================

void main() {
  vec2 res = max(u.resolution_time_frame.xy, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + u.jitter_fov_mode.xy;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(u.jitter_fov_mode.z, 0.1, 2.8) * 0.5);
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  mat3 camBasis = mat3(u.camRight_vs.xyz, u.camUp_R.xyz, u.camFwd_sigma.xyz);
  vec3 rayDir = normalize(camBasis * localRay);

  float simTime = u.resolution_time_frame.z;
  int frameIndex = int(round(u.resolution_time_frame.w));
  int metricType = clamp(int(round(u.camPos_metric.w)), 0, 2);
  float v_s = max(u.camRight_vs.w, 0.0);
  float R = max(u.camUp_R.w, 0.5);
  float sigma = max(u.camFwd_sigma.w, 0.3);

  float dopplerStrength = clamp(u.physicsParams.x, 0.0, 1.5);
  float wallShimmer = max(u.physicsParams.y, 0.0);
  float causticGlow = max(u.physicsParams.z, 0.0);
  float starStreaks = max(u.physicsParams.w, 0.0);

  float skyIntensity = max(u.skyParams.x, 0.0);
  int skyMode = int(round(u.skyParams.y));
  vec2 skyRot = u.skyParams.zw;

  int quality = int(round(u.qualityParams.x));
  float flowSpeed = max(u.qualityParams.y, 0.0);
  float frameBlend = clamp(u.qualityParams.z, 0.0, 1.0);

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int maxSteps = 560;
  float qualScale = 1.00;
  if (quality <= 0) {
    maxSteps = 400;
    qualScale = 1.25;
  } else if (quality >= 2) {
    maxSteps = 720;
    qualScale = 0.78;
  }

  float escapeR = max(R + 7.5 / sigma, max(R + 4.5, 2.2 * R));
  float dustR = max(escapeR, R * 2.85);

  vec3 pos = u.camPos_metric.xyz;
  vec3 k = -rayDir;

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float integratedNegTheta = 0.0;
  bool captured = false;
  bool escaped = false;
  bool runLoop = true;

  // Flat-space analytic skip & pre-entry dust streak integration in External Chase
  if (frameBlend < 0.01 && length(pos) > escapeR) {
    float tClose = -dot(pos, rayDir);
    if (tClose <= 0.0) {
      escaped = true;
      runLoop = false;
    } else {
      float b2 = dot(pos, pos) - tClose * tClose;
      if (b2 >= escapeR * escapeR) {
        escaped = true;
        runLoop = false;
        if (starStreaks > 0.001 && b2 < dustR * dustR) {
          float halfChord = sqrt(dustR * dustR - b2);
          float tStart = max(0.0, tClose - halfChord);
          float tEnd = tClose + halfChord;
          float dtDust = (tEnd - tStart) / 16.0;
          for (int s = 0; s < 16; ++s) {
            float tS = tStart + (float(s) + bn.x) * dtDust;
            vec3 dPos = pos + rayDir * tS;
            radiance += transmittance * evalDustStreak(dPos, R, v_s, 1.0, frameBlend, simTime, flowSpeed, starStreaks) * dtDust;
          }
        }
      } else {
        float tEntEsc = tClose - sqrt(escapeR * escapeR - b2);
        if (starStreaks > 0.001 && b2 < dustR * dustR) {
          float tEntDust = max(0.0, tClose - sqrt(dustR * dustR - b2));
          if (tEntEsc > tEntDust) {
            float dtDust = (tEntEsc - tEntDust) / 12.0;
            for (int s = 0; s < 12; ++s) {
              float tS = tEntDust + (float(s) + bn.x) * dtDust;
              vec3 dPos = pos + rayDir * tS;
              radiance += transmittance * evalDustStreak(dPos, R, v_s, 1.0, frameBlend, simTime, flowSpeed, starStreaks) * dtDust;
            }
          }
        }
        pos = pos + rayDir * tEntEsc;
      }
    }
  }

  for (int step = 0; step < 720; ++step) {
    if (!runLoop || step >= maxSteps) break;

    float kLen = length(k);
    if (kLen > 28.0) {
      captured = true;
      break;
    }

    GeodesicDeriv k1 = evalGeodesicRHS(pos, k, R, sigma, v_s, metricType, frameBlend);
    float r = length(pos);
    if (r > escapeR && dot(pos, k1.dp) > 0.0) {
      escaped = true;
      break;
    }

    // Lipschitz sphere-traced step prevents wall-entry overshoot in steep thin-wall & Natario shear
    float speedCap = max(length(k1.dp), 1.0);
    float wallDist = abs(k1.rEff - R);
    float wallStep = 0.14 / sigma;
    float safeDistStep = wallStep + 0.40 * max(wallDist - 1.6 / sigma, 0.0);
    float maxSp = min(0.32 * R, safeDistStep) * qualScale;
    float ds = maxSp / speedCap;

    GeodesicDeriv k2 = evalGeodesicRHS(pos + (0.5 * ds) * k1.dp, k + (0.5 * ds) * k1.dk, R, sigma, v_s, metricType, frameBlend);
    GeodesicDeriv k3 = evalGeodesicRHS(pos + (0.5 * ds) * k2.dp, k + (0.5 * ds) * k2.dk, R, sigma, v_s, metricType, frameBlend);
    GeodesicDeriv k4 = evalGeodesicRHS(pos + ds * k3.dp, k + ds * k3.dk, R, sigma, v_s, metricType, frameBlend);

    vec3 posNext = pos + (ds / 6.0) * (k1.dp + 2.0 * k2.dp + 2.0 * k3.dp + k4.dp);
    vec3 kNext = k + (ds / 6.0) * (k1.dk + 2.0 * k2.dk + 2.0 * k3.dk + k4.dk);

    integratedNegTheta += (-0.5 * (k1.theta + k4.theta)) * ds;

    // Full-interval [0, 1] blue-noise stratified volumetric sub-stepping (zero radial dead-zones)
    float segLen = length(posNext - pos);
    int nVol = clamp(int(ceil(segLen / 0.18)), 1, 5);
    float subLen = segLen / float(nVol);
    float bnStep = fract(bn.y + float(step) * 0.61803399);
    float kNextLen = length(kNext);

    for (int vsIdx = 0; vsIdx < 5; ++vsIdx) {
      if (vsIdx >= nVol) break;
      float subBn = fract(bnStep + float(vsIdx) * 0.61803399);
      float uSub = (float(vsIdx) + subBn) / float(nVol);
      vec3 sPos = mix(pos, posNext, uSub);
      float kSubLen = mix(kLen, kNextLen, uSub);
      float t00Sub = mix(k1.t00, k4.t00, uSub);
      float thetaSub = mix(k1.theta, k4.theta, uSub);

      float ridgeVal = 0.0;
      vec3 volEmit = evalWallShimmer(
        sPos, R, sigma, v_s, t00Sub, thetaSub, kSubLen, frameBlend, metricType, simTime, flowSpeed, wallShimmer, ridgeVal
      );
      if (starStreaks > 0.001 && length(sPos) > R * 1.04) {
        volEmit += evalDustStreak(sPos, R, v_s, kSubLen, frameBlend, simTime, flowSpeed, starStreaks);
      }

      float ext = (frameBlend < 0.5) ? (min(abs(t00Sub), 0.4) * (0.04 + 0.22 * ridgeVal) * wallShimmer) : 0.0;
      if (dot(volEmit, volEmit) > 1e-10 || ext > 1e-6) {
        float tau = ext * subLen;
        float stepT = exp(-tau);
        vec3 stepRad = (tau > 1e-4)
          ? volEmit * ((1.0 - stepT) / max(ext, 1e-5))
          : volEmit * subLen;
        radiance += transmittance * stepRad;
        transmittance *= stepT;
        if (transmittance < 0.01) break;
      }
    }

    pos = posNext;
    k = kNext;

    if (transmittance < 0.01) {
      break;
    }
  }

  // Handle step-budget exhaustion: capture only true horizon-divergent rays (kFinal > 22)
  float kFinal = max(length(k), 1e-4);
  if (!captured && !escaped) {
    if (v_s >= 0.99 && kFinal > 22.0) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  vec3 finalDir = -k / kFinal;

  // Post-escape outer dust streaks from escapeR out to dustR
  if (runLoop && escaped && !captured && starStreaks > 0.001 && length(pos) < dustR) {
    vec3 exitVel = -finalDir;
    GeodesicDeriv dEnd = evalGeodesicRHS(pos, k, R, sigma, v_s, metricType, frameBlend);
    float dEndLen = length(dEnd.dp);
    if (dEndLen > 1e-4) {
      exitVel = dEnd.dp / dEndLen;
      float bExit = dot(pos, exitVel);
      float disc = bExit * bExit - (dot(pos, pos) - dustR * dustR);
      if (disc > 0.0) {
        float remDist = max(0.0, -bExit + sqrt(disc));
        float dtDust = remDist / 12.0;
        for (int s = 0; s < 12; ++s) {
          float tS = (float(s) + bn.z) * dtDust;
          vec3 dPos = pos + exitVel * tS;
          radiance += transmittance * evalDustStreak(dPos, R, v_s, kFinal, frameBlend, simTime, flowSpeed, starStreaks) * dtDust;
        }
      }
    }
  }

  // Exact Inside Bridge vs External Chase Doppler factor
  float gRaw = (frameBlend > 0.5)
    ? (1.0 / kFinal)
    : exp(clamp(integratedNegTheta + v_s * (finalDir.z - rayDir.z), -2.4, 2.4));
  float gEff = mix(1.0, gRaw, dopplerStrength);

  float bendAngle = acos(clamp(dot(rayDir, finalDir), -1.0, 1.0));
  float escFlag = (escaped && !captured && transmittance > 0.008) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);

  float fdLen = length(finalDir);
  vec3 safeSkyDir = (fdLen > 1e-5) ? (finalDir / fdLen) : rayDir;
  vec3 skyColor = sampleSkyBackground(
    safeSkyDir,
    rayDir,
    escFlag > 0.5,
    edgeMask,
    gEff,
    frameBlend,
    causticGlow,
    kFinal,
    bendAngle,
    skyIntensity,
    skyMode,
    skyRot
  );

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  } else if (captured) {
    // Pitch-black causal shadow core (smooth Hawking rim rendered on grazing escaping rays via kFinal)
    radiance = radiance * 0.12;
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
