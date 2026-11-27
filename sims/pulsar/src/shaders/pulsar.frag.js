/**
 * Cinema-grade WebGL2 GLSL 300 es Relativistic Magnetar & Millisecond Pulsar
 * Ray-Tracer for "Magnetar & Millisecond Pulsar Simulator".
 *
 * Physics & Optical Architecture:
 *  - Exact 3D Cartesian Outgoing Kerr-Schild metric with explicit geometric mass
 *    M = compactness (u_c = M / R_*, R_* = 1.0, spin axis = +Y):
 *      H = lensingStrength * M * r^3 / (r^4 + a^2 * y^2)
 *    with exact analytical Hamiltonian gradients (evalGeodesicRHS) and exact
 *    4D Lorentzian Gram-Schmidt ZAMO orthonormal observer tetrad (initCameraRay).
 *    When lensingStrength <= 1e-6, rays march straight Euclidean trajectories.
 *  - Adaptive RK4 null geodesic integration with blue-noise stratified step
 *    jitter and cubic-Hermite + 6-iteration bisection + secant root refinement
 *    at r <= 1.0 so the neutron star silhouette and gravitationally bent
 *    back-hemisphere polar caps are razor-sharp.
 *  - Solid Neutron Star Crust (r = 1.0):
 *      * Co-rotating body frame transformed by spinPhase around +Y.
 *      * Antipodal Polar Caps (+muHat, -muHat) glowing at 10^6..10^7 K via
 *        CIE-1931 Planck blackbody LUT + sapphire-blue/white pair-cascade rim.
 *      * Anisotropic crustal thermal map + molten magnetic tectonic cracks
 *        driven by magnetarCrackGlow & twistShear.
 *      * Exact crustal 4-velocity u_em = u^t (1, Omega_rot*z, 0, -Omega_rot*x),
 *        yielding exact gravitational redshift + relativistic Doppler shift g,
 *        spectral temperature shift T_obs = g*T, g^4 beaming, and limb darkening.
 *  - Volumetric Magnetosphere & Pulsar Wind Nebula (PWN):
 *      * Closed dipole shell L = r / sin^2(theta_m) in (1.04, rLightCylVis] with
 *        twisted flux tubes and Deutsch retardation delta_phi = -(r - 1)/R_LC.
 *      * Sweeping dual hollow-cone + core lighthouse beams with Deutsch spiral lag
 *        and strong relativistic forward beaming triggering 70mm anamorphic flares.
 *      * Equatorial Chandra/Crab synchrotron torus & outward shock wisps +
 *        helical spin-axis polar jets (+-Y).
 *  - Escaping rays sample the lensed 4K Milky Way / procedural sky + crisp 3D
 *    spectral micro-stars via wrap-safe, silhouette-safe textureGrad.
 */

export const PULSAR_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Locked 176-byte std140 UBO (11 x vec4) matching PulsarUniforms in pulsar.wgsl.js
layout(std140) uniform PulsarUniforms {
  vec4 resolution_time_frame;  // (width, height, time, float(frameIndex))
  vec4 jitter_fov_lensing;     // (jitterX, jitterY, fovY, lensingStrength)
  vec4 camPos_compactness;     // (camX, camY, camZ, compactness)
  vec4 camRight_spinA;         // (rightX, rightY, rightZ, spinA)
  vec4 camUp_betaEq;           // (upX, upY, upZ, betaEq)
  vec4 camFwd_phase;           // (fwdX, fwdY, fwdZ, spinPhase)
  vec4 magnetParams;           // (obliquityRad, twistShear, rLightCylVis, plasmaDensity)
  vec4 beamPwnParams;          // (beamIntensity, pwnVisibility, polarCapTempK, crustTempK)
  vec4 skyParams;              // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  vec4 qualityParams;          // (float(quality), spinVisualSpeed, float(isProgressive), surfaceRedshiftZ)
  vec4 extraParams;            // (beamConeHalfAngle, magnetarCrackGlow, pwnJetPower, 0.0)
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

// ============================================================================
// 1. EXACT 3D CARTESIAN OUTGOING KERR-SCHILD METRIC (EXPLICIT MASS M = u_c)
// ============================================================================

struct KSFields {
  float r;
  float r2;
  float D;
  float H;
  float R2;
  vec3  l;
  vec3  gradR;
};

float evalKerrR(vec3 pos, float a2) {
  if (a2 < 1e-6) {
    return sqrt(max(dot(pos, pos), 1e-8));
  }
  float uVal = dot(pos, pos) - a2;
  float y2 = pos.y * pos.y;
  float disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  return sqrt(max(0.5 * (uVal + disc), 1e-8));
}

KSFields evalKSFields(vec3 pos, float M, float a, float a2, float lensing) {
  KSFields f;
  float y2 = pos.y * pos.y;
  if (a2 < 1e-6) {
    f.r2 = max(dot(pos, pos), 1e-8);
    float invR = inversesqrt(f.r2);
    f.r = f.r2 * invR;
    f.D = f.r2 * f.r2;
    f.H = lensing * M * invR;
    f.R2 = f.r2;
    f.l = pos * invR;
    f.gradR = f.l;
    return f;
  }

  float uVal = dot(pos, pos) - a2;
  float disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  f.r2 = max(0.5 * (uVal + disc), 1e-8);
  float invR = inversesqrt(f.r2);
  f.r = f.r2 * invR;
  f.D = f.r2 * f.r2 + a2 * y2;
  float invD = 1.0 / max(f.D, 1e-10);
  f.H = lensing * M * (f.r * f.r2) * invD;
  f.R2 = f.r2 + a2;
  float invR2 = 1.0 / max(f.R2, 1e-8);
  f.l = vec3(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (f.r * pos.z - a * pos.x) * invR2
  );
  f.gradR = vec3(
    f.r * f.r2 * pos.x,
    f.r * f.R2 * pos.y,
    f.r * f.r2 * pos.z
  ) * invD;
  return f;
}

// Lorentzian inner product g_{mu nu} A^mu B^nu in Outgoing Kerr-Schild (l_t = -1)
float ksMetricDot(vec4 A, vec4 B, KSFields f) {
  float lA = -A.x + dot(f.l, A.yzw);
  float lB = -B.x + dot(f.l, B.yzw);
  return -A.x * B.x + dot(A.yzw, B.yzw) + 2.0 * f.H * lA * lB;
}

struct GeodesicDeriv {
  vec3  dpos;
  vec3  dp;
  float r;
};

GeodesicDeriv evalGeodesicRHS(vec3 pos, vec3 p, float pt, float M, float a, float a2, float lensing) {
  GeodesicDeriv outD;
  float y2 = pos.y * pos.y;

  if (a2 < 1e-6) {
    float r2 = max(dot(pos, pos), 1e-8);
    float invR = inversesqrt(r2);
    float r = r2 * invR;
    vec3 l = pos * invR;
    float H = lensing * M * invR;
    float lp = dot(l, p);
    float L = pt + lp;
    float twoHL = 2.0 * H * L;

    outD.dpos = p - twoHL * l;
    outD.r = r;
    outD.dp = (lensing <= 1e-6)
      ? vec3(0.0)
      : invR * (twoHL * p - (H * L * L + twoHL * lp) * l);
    return outD;
  }

  if (a2 < 1e-4) {
    float r2 = max(dot(pos, pos), 1e-8);
    float invR = inversesqrt(r2);
    float r = r2 * invR;
    float invR2 = invR * invR;
    vec3 rHat = pos * invR;
    float aInvR2 = a * invR2;
    vec3 l = rHat + aInvR2 * vec3(pos.z, 0.0, -pos.x);
    float H = lensing * M * invR;
    float L = pt + dot(l, p);
    float twoHL = 2.0 * H * L;

    outD.dpos = p - twoHL * l;
    outD.r = r;

    if (lensing <= 1e-6) {
      outD.dp = vec3(0.0);
      return outD;
    }

    float S = -(dot(p, pos) + 2.0 * a * invR * (p.x * pos.z - p.z * pos.x)) * invR2;
    vec3 w = p * invR + aInvR2 * vec3(-p.z, 0.0, p.x) + S * rHat;
    outD.dp = (-H * invR * L * L) * rHat + twoHL * w;
    return outD;
  }

  float uVal = dot(pos, pos) - a2;
  float disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  float r2 = max(0.5 * (uVal + disc), 1e-8);
  float invR = inversesqrt(r2);
  float r = r2 * invR;
  float r4 = r2 * r2;
  float a2y2 = a2 * y2;
  float invD = 1.0 / max(r4 + a2y2, 1e-10);
  float H = lensing * M * (r * r2) * invD;
  float R2 = r2 + a2;
  float invR2 = 1.0 / max(R2, 1e-8);
  vec3 l = vec3(
    (r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (r * pos.z - a * pos.x) * invR2
  );
  float L = pt + dot(l, p);
  float twoHL = 2.0 * H * L;

  outD.dpos = p - twoHL * l;
  outD.r = r;

  if (lensing <= 1e-6) {
    outD.dp = vec3(0.0);
    return outD;
  }

  vec3 gradR = vec3(r * r2 * pos.x, r * R2 * pos.y, r * r2 * pos.z) * invD;
  float hFac = H * invR * invD;
  float cR = 3.0 * a2y2 - r4;
  vec3 gradH = (hFac * cR) * gradR;
  gradH.y -= hFac * (2.0 * r * a2 * pos.y);

  float S = (p.x * (pos.x - 2.0 * r * l.x) + p.z * (pos.z - 2.0 * r * l.z)) * invR2
          - p.y * l.y * invR;

  vec3 w = vec3(
    (r * p.x - a * p.z) * invR2,
    p.y * invR,
    (a * p.x + r * p.z) * invR2
  ) + S * gradR;

  outD.dp = (L * L) * gradH + twoHL * w;
  return outD;
}

struct CameraRayInit {
  vec3  p;
  float pt;
};

// Exact 4D Lorentzian Gram-Schmidt ZAMO orthonormal observer tetrad at camPos
CameraRayInit initCameraRay(
  vec3 camPos,
  vec3 camRight,
  vec3 camUp,
  vec3 camFwd,
  vec3 localRay,
  float M,
  float a,
  float a2,
  float lensing
) {
  KSFields f = evalKSFields(camPos, M, a, a2, lensing);
  float rho2 = camPos.x * camPos.x + camPos.z * camPos.z;

  float omega = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  vec3 vZamo = vec3(omega * camPos.z, 0.0, -omega * camPos.x);
  float lPhi = a * rho2 / max(f.R2, 1e-8);
  float oneMinusWl = 1.0 - omega * lPhi;
  float normSq = max(1.0 - dot(vZamo, vZamo) - 2.0 * f.H * oneMinusWl * oneMinusWl, 1e-5);
  float ut = inversesqrt(normSq);
  vec4 e0 = vec4(ut, ut * vZamo);

  vec4 f4 = vec4(0.0, camFwd);
  f4 += ksMetricDot(f4, e0, f) * e0;
  vec4 e3 = f4 * inversesqrt(max(ksMetricDot(f4, f4, f), 1e-8));

  vec4 r4 = vec4(0.0, camRight);
  r4 += ksMetricDot(r4, e0, f) * e0;
  r4 -= ksMetricDot(r4, e3, f) * e3;
  vec4 e1 = r4 * inversesqrt(max(ksMetricDot(r4, r4, f), 1e-8));

  vec4 u4 = vec4(0.0, camUp);
  u4 += ksMetricDot(u4, e0, f) * e0;
  u4 -= ksMetricDot(u4, e3, f) * e3;
  u4 -= ksMetricDot(u4, e1, f) * e1;
  vec4 e2 = u4 * inversesqrt(max(ksMetricDot(u4, u4, f), 1e-8));

  vec4 pUp = -e0 + localRay.x * e1 + localRay.y * e2 + localRay.z * e3;
  float lp = -pUp.x + dot(f.l, pUp.yzw);

  CameraRayInit outRay;
  outRay.pt = -pUp.x - 2.0 * f.H * lp;
  outRay.p  =  pUp.yzw + (2.0 * f.H * lp) * f.l;
  return outRay;
}

vec3 evalHermite(vec3 x0, vec3 v0, vec3 x1, vec3 v1, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * x0
       + (t3 - 2.0 * t2 + t) * v0
       + (-2.0 * t3 + 3.0 * t2) * x1
       + (t3 - t2) * v1;
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT & SEAMLESS 4K SKY + MICRO-STARS
// ============================================================================

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureLod(uBlackbodyLut, vec2(uCoord, 0.5), 0.0).rgb;
}

// Map neutron-star physical Kelvin (10^5..1.5x10^7 K) onto Rayleigh-Jeans CIE-1931 Planck curve
float mapPulsarTempToLut(float physTempK) {
  float normT = clamp(max(physTempK, 1.0e5) / 6.0e6, 0.02, 2.2);
  return clamp(11500.0 + 28500.0 * pow(normT, 0.55), 11500.0, T_MAX);
}

vec3 rotateY(vec3 v, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
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

  float fw = clamp(pixelFw * scale, 0.024, 0.20);
  float starRad = mix(0.032, 0.096, mag) + fw * 0.48;
  float core = exp(-min((dist * dist) / max(starRad * starRad * 0.36, 1e-5), 40.0));
  if (core < 0.004) return vec3(0.0);

  float ry = max(rnd.y, 0.0);
  float tEmit = mix(3100.0, 22000.0, ry * ry);
  vec3 col = sampleBlackbody(tEmit);

  float energyComp = 1.0 / (1.0 + fw * 6.0);
  float lum = (0.09 + 3.1 * mag) * boost * energyComp;
  return col * (core * lum);
}

vec3 sampleSkyBackground(vec3 rawDir, float skyIntensity, int skyMode, vec2 skyRot, bool escaped, float edgeMask) {
  vec3 dir = normalize(rotateSkyDir(rawDir, skyRot));

  // Wrap-safe & pole-safe equirectangular coordinates in uniform control flow
  float u1 = ((abs(dir.x) + abs(dir.z) > 1e-6) ? atan(dir.z, dir.x) : 0.0) * INV_TAU + 0.5;
  float v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
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

  float dirFw = min(length(fwidth(dir)), 0.12);
  if (edgeMask > 0.01) dirFw = 0.0012;

  if (!escaped) return vec3(0.0);

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));
  vec3 mapSrgb = (skyMode >= 1)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(1e-5)), vec3(2.2));

  float skyLuma = dot(skyLin, vec3(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.32, 1.0, smoothstep(0.002, 0.042, skyLuma));

  vec3 brightCores = max(skyLin - vec3(0.28), vec3(0.0));
  skyLin += brightCores * brightCores * 2.2;

  float starGain = (skyMode >= 1) ? 1.05 : 0.72;
  skyLin += evalMicroStarLayer(dir, 100.0, 0.912, 0.92 * starGain, dirFw)
          + evalMicroStarLayer(dir, 210.0, 0.884, 0.42 * starGain, dirFw);

  return skyLin * max(skyIntensity, 0.0);
}

// ============================================================================
// 3. NEUTRON STAR SOLID CRUST (r = 1.0): POLAR CAPS, CRACKS & RELATIVISTIC SHIFT
// ============================================================================

float computeCrustFrequencyShift(
  vec3 pos,
  KSFields f,
  vec3 p,
  float pt,
  float a,
  float a2,
  float betaEq
) {
  float rho2 = pos.x * pos.x + pos.z * pos.z;
  float omegaZ = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  vec3 vZamo = vec3(omegaZ * pos.z, 0.0, -omegaZ * pos.x);

  // Rigid crustal angular speed Omega_rot = betaEq / R_* (R_* = 1.0)
  vec3 vEmit = vec3(betaEq * pos.z, 0.0, -betaEq * pos.x);
  float lv = -1.0 + dot(f.l, vEmit);
  float ds2 = -1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv;

  if (ds2 > -0.04) {
    vec3 dv = vEmit - vZamo;
    float lvZ = -1.0 + dot(f.l, vZamo);
    float ds2Z = min(-1.0 + dot(vZamo, vZamo) + 2.0 * f.H * lvZ * lvZ, -0.02);
    float shrink = sqrt(clamp((-0.04 - ds2Z) / max(ds2 - ds2Z, 1e-4), 0.0, 1.0)) * 0.92;
    vEmit = vZamo + dv * shrink;
    lv = -1.0 + dot(f.l, vEmit);
    ds2 = min(-1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv, -0.02);
  }

  float ut = inversesqrt(max(-ds2, 0.02));
  float emitEnergy = ut * (pt + dot(p, vEmit));
  return clamp(1.0 / max(emitEnergy, 0.08), 0.12, 2.65);
}

vec3 shadeNeutronStarSurface(
  vec3 posHit,
  vec3 pHit,
  float pt,
  vec3 velHit,
  float M,
  float a,
  float a2,
  float lensing,
  float betaEq,
  float simTime,
  float spinPhase,
  float sinObl,
  float cosObl,
  float twistShear,
  float rLightCylVis,
  float polarCapTempK,
  float crustTempK,
  float magnetarCrackGlow
) {
  KSFields f = evalKSFields(posHit, M, a, a2, lensing);
  vec3 surfNormal = normalize(f.gradR);

  // Transform surface intersection into co-rotating body frame around +Y
  vec3 pBody = rotateY(posHit, -spinPhase);
  vec3 rHatBody = normalize(pBody);

  float cosM = rHatBody.x * sinObl + rHatBody.y * cosObl;
  float sinM = sqrt(max(1.0 - cosM * cosM, 0.0));
  float xM = rHatBody.x * cosObl - rHatBody.y * sinObl;
  float yM = -rHatBody.z;
  float phiM = (abs(xM) + abs(yM) > 1e-6) ? atan(yM, xM) : 0.0;
  float signCosM = cosM >= 0.0 ? 1.0 : -1.0;

  // Exact Greenstein & Hartke (1983) dipolar anisotropic electron thermal conduction
  float cos2M = cosM * cosM;
  float cos2B = (4.0 * cos2M) / (1.0 + 3.0 * cos2M);
  float anisoTemp = pow(max(cos2B + 0.26 * (1.0 - cos2B), 1e-4), 0.25);

  // Silky magnetized atmospheric plasma shimmer, meridian thermal striations & loop footpoint glow
  vec3 shearCoord = pBody * 0.36 + vec3(0.17, 0.31, 0.53);
  vec4 nCrust = textureLod(uVolumeNoise, shearCoord, 0.0);
  vec3 fineCoord = pBody * 0.85 + (nCrust.rgb - vec3(0.5)) * 0.26
                 + vec3(0.18 * twistShear * signCosM * pBody.z, 0.0, -0.18 * twistShear * signCosM * pBody.x);
  vec4 nFine = textureLod(uVolumeNoise, fineCoord, 0.0);
  vec3 microCoord = pBody * 2.4 + vec3(0.0, simTime * 0.08, 0.0);
  vec4 nMicro = textureLod(uVolumeNoise, microCoord, 0.0);
  float meridianWave = 0.5 + 0.5 * sin(phiM * 7.0 + twistShear * 2.2 * cosM + nCrust.g * 3.4);
  float meridianFine = 0.5 + 0.5 * cos(phiM * 15.0 - twistShear * 3.1 * cosM + nFine.r * 4.2);
  float meridianStreak = mix(1.0, 0.84 + 0.24 * meridianWave * (0.55 + 0.45 * meridianFine), sinM);
  float plasmaShimmer = (0.82 + 0.16 * nCrust.r + 0.14 * nFine.g + 0.12 * nMicro.a) * meridianStreak;
  float footGlow = smoothstep(0.56, 0.90, nFine.g * (0.50 + 0.50 * nMicro.r)) * sinM * (0.35 + 0.65 * meridianWave);

  // Polar cap angular footprint from last closed dipole field line sin(theta_pc) = 1 / sqrt(R_LC)
  float sinThetaPc = clamp(inversesqrt(max(rLightCylVis, 1.5)), 0.16, 0.62);
  float sinPerturb = sinM + (nFine.r - 0.5) * 0.028 * sinM;

  float crownNorm = sinPerturb / max(sinThetaPc * 1.75, 0.12);
  float capCrown = exp(-min(crownNorm * crownNorm, 40.0));
  float capCore = 1.0 - smoothstep(sinThetaPc * 0.12, sinThetaPc * 0.96, sinPerturb);
  float capIn = sinPerturb / max(sinThetaPc * 0.50, 0.06);
  float capInner = exp(-min(capIn * capIn, 40.0));
  float capRimDist = (sinPerturb - sinThetaPc * 0.96) / max(sinThetaPc * 0.13, 0.028);
  float capRim = exp(-min(capRimDist * capRimDist, 40.0));

  float driftPhi = phiM - simTime * 0.65 * signCosM;
  float sparkWave = 0.5 + 0.5 * sin(5.0 * driftPhi + twistShear * 1.8 * signCosM + nCrust.g * 3.8);
  float sparkFine = 0.5 + 0.5 * cos(11.0 * driftPhi - 2.4 * twistShear * signCosM + nFine.a * 4.5);
  float auroralSparks = 0.35 + 0.65 * (sparkWave * sparkWave) * (0.45 + 0.55 * sparkFine);

  // Azimuthally-sheared branching magnetar plasma fault ribbons
  float faultHalo = 0.0;
  float faultCore = 0.0;
  float crackDrive = 0.0;
  if (magnetarCrackGlow > 0.001) {
    vec3 arcCoordA = vec3(
      cos(phiM * 2.0 + twistShear * 1.4 * cosM) * 0.42 + pBody.x * 0.35,
      sin(phiM * 2.0 + twistShear * 1.4 * cosM) * 0.42 + pBody.z * 0.35,
      cosM * 1.65 + 0.25 * nCrust.r
    );
    vec4 nArcA = textureLod(uVolumeNoise, arcCoordA, 0.0);
    vec3 arcCoordB = pBody * 1.65 + (nArcA.rgb - vec3(0.5)) * 0.55
                   + vec3(0.35 * twistShear * signCosM * pBody.z, 0.0, -0.35 * twistShear * signCosM * pBody.x);
    vec4 nArcB = textureLod(uVolumeNoise, arcCoordB, 0.0);

    float shearBelt = 0.22 + 0.78 * (4.0 * cos2M * (1.0 - cos2M));
    float rA = clamp(nArcA.g, 1e-5, 1.0);
    float rB = clamp(nArcB.g * 0.72 + nArcB.a * 0.42, 1e-5, 1.0);
    float arcRibbon = pow(rA, 2.8) * pow(rB, 2.2) * (0.45 + 0.55 * nArcA.a);
    float faultNet = arcRibbon * shearBelt * 2.2;

    faultHalo = smoothstep(0.06, 0.36, faultNet);
    faultCore = smoothstep(0.24, 0.62, faultNet);
    crackDrive = pow(magnetarCrackGlow, 1.25) * (0.65 + 0.35 * clamp(twistShear, 0.0, 2.5));
  }

  // Relativistic frequency shift g = (p.u)_obs / (p.u)_emit (gravitational redshift + Doppler)
  float g = computeCrustFrequencyShift(posHit, f, pHit, pt, a, a2, betaEq);

  // Magnetized photosphere limb darkening + incandescent ionized horizon glow
  vec3 vRayDir = (dot(velHit, velHit) > 1e-10) ? normalize(velHit) : surfNormal;
  float muLimb = clamp(dot(surfNormal, -vRayDir), 0.0, 1.0);
  float limbDark = mix(0.32, 1.0, pow(max(muLimb, 1e-5), 0.45));
  float atmoRim = pow(max(1.0 - muLimb, 1e-5), 2.8) * 1.35;

  // Incandescent Rayleigh-Jeans photosphere: vivid sapphire equator -> blazing ice-cyan latitudes + footpoint shimmer
  float T_crust = crustTempK * anisoTemp * plasmaShimmer;
  vec3 crustCol = sampleBlackbody(mapPulsarTempToLut(T_crust * g));
  float crustLum = 1.42 * pow(clamp(T_crust / 1.4e6, 0.35, 3.0), 1.22);
  vec3 eqSapphire = vec3(0.24, 0.56, 1.00);
  vec3 hiIceCyan = crustCol * vec3(0.72, 0.92, 1.20);
  float latBlend = smoothstep(0.70, 0.99, anisoTemp);
  vec3 crustTint = mix(eqSapphire, hiIceCyan, latBlend);
  float latGain = mix(0.92, 1.95, latBlend);
  vec3 crustEmit = crustTint * (crustLum * latGain) + hiIceCyan * (footGlow * crustLum * 0.72);

  // Magnetar returning j-bundle shear ribbons (electric violet-indigo halo + plasma-white core)
  vec3 haloCol = vec3(0.46, 0.22, 1.00);
  vec3 coreCrackCol = mix(sampleBlackbody(mapPulsarTempToLut(max(crustTempK * 2.8, 6.0e6) * g)), vec3(0.90, 0.97, 1.00), 0.65);
  vec3 crackEmit = (haloCol * (faultHalo * 5.2) + coreCrackCol * (faultCore * 18.0)) * crackDrive;

  // Structured blazing polar caps + drifting pair-cascade spark cluster & auroral oval
  float sparkCore = 0.65 + 0.55 * nMicro.g * (0.55 + 0.45 * auroralSparks);
  float T_cap = polarCapTempK * (0.85 + 0.45 * capInner + 0.16 * nFine.g);
  vec3 capCol = sampleBlackbody(mapPulsarTempToLut(T_cap * g));
  vec3 crownTint = mix(vec3(0.22, 0.72, 1.00), capCol, 0.55);
  float capStr = (capCore * 1.05 + capInner * 2.10) * sparkCore;
  vec3 pairRimCol = mix(vec3(0.28, 0.82, 1.00), vec3(0.92, 0.98, 1.00), auroralSparks);
  vec3 capEmit = crownTint * (capCrown * 3.2)
               + capCol * (capStr * 15.5)
               + pairRimCol * (capRim * auroralSparks * 10.5);

  // Relativistic bolometric intensity shift g^4 (with soft knee) & atmospheric limb
  float g2 = g * g;
  float g4 = g2 * g2;
  float relFlux = g4 / (1.0 + 0.05 * g4);

  vec3 totalSurf = (crustEmit + crackEmit + capEmit) * limbDark * relFlux
                 + vec3(0.42, 0.84, 1.00) * (atmoRim * g * (0.95 + 0.45 * crackDrive));
  return max(totalSurf, vec3(0.0));
}

// ============================================================================
// 4. VOLUMETRIC MAGNETOSPHERE, LIGHTHOUSE BEAMS, PWN TORUS & POLAR JETS
// ============================================================================

vec4 evalPulsarVolume(
  vec3 pos,
  vec3 toCamDir,
  float r,
  float invR,
  float simTime,
  float spinPhase,
  float sinObl,
  float cosObl,
  float twistShear,
  float twistFactor,
  float rLightCylVis,
  float invSepW,
  float retardFactor,
  float rMagLoopMax,
  float rSheetMin,
  float rSheetMax,
  float rMagOuter,
  float plasmaDensity,
  float beamIntensity,
  float beamConeHalfAngle,
  float cosMaxCone,
  float pwnVisibility,
  float jetAmp,
  float spinVisualSpeed,
  float camDistFade,
  float segCorotBeam,
  bool segNeedsMag,
  bool segNeedsBeam,
  bool segNeedsPwn,
  bool segNeedsJet
) {
  vec3 emission = vec3(0.0);
  float nearMagFlag = 0.0;

  bool needMag  = segNeedsMag && (r < rMagOuter);
  bool needBeam = segNeedsBeam && (r < 18.0);
  bool checkMagOrBeam = needMag;
  if (!checkMagOrBeam && needBeam) {
    float absCosSpin = abs(pos.y) * invR;
    float sinSpin = sqrt(max(1.0 - absCosSpin * absCosSpin, 0.0));
    float maxPossibleCosM = absCosSpin * abs(cosObl) + sinSpin * abs(sinObl);
    checkMagOrBeam = (maxPossibleCosM > cosMaxCone);
  }

  if (checkMagOrBeam) {
    // Deutsch electromagnetic retardation lag delta_phi = -(r - 1) / R_LC
    float deltaPhi = -max(r - 1.0, 0.0) * retardFactor;
    float phaseRet = spinPhase + deltaPhi;
    float cRet = cos(phaseRet);
    float sRet = sin(phaseRet);
    vec3 pRot = vec3(cRet * pos.x - sRet * pos.z, pos.y, sRet * pos.x + cRet * pos.z);

    float zM = pRot.x * sinObl + pRot.y * cosObl;
    float xM = pRot.x * cosObl - pRot.y * sinObl;
    float yM = -pRot.z;
    float rhoM2 = xM * xM + yM * yM;
    float sin2Theta = max(rhoM2 * invR * invR, 1e-5);
    float cosThetaM = zM * invR;
    float L = r / sin2Theta;
    nearMagFlag = (L < rMagLoopMax * 1.18) ? 1.0 : 0.0;

    bool inCorona = segNeedsMag && (r < 2.05);
    bool inLoops  = needMag && (L > 1.04 && L < rMagLoopMax);
    bool inSheet  = segNeedsMag && (r > rSheetMin && r < rSheetMax && abs(cosThetaM) < 0.097);

    if (inCorona || inLoops || inSheet) {
      // 4A-0. Optically-Thin Relativistic Magnetized Inner Corona (1.01 < r < 2.05)
      if (inCorona) {
        float coronaRad = smoothstep(1.01, 1.035, r) * exp(-min((r - 1.0) * 5.4, 40.0));
        float poleBoost = 0.75 + 0.55 * abs(cosThetaM);
        float coronaDens = coronaRad * poleBoost * (0.18 + 0.12 * plasmaDensity) * segCorotBeam * camDistFade;
        vec3 coronaCol = mix(vec3(0.18, 0.64, 1.00), vec3(0.84, 0.96, 1.00), exp(-min((r - 1.0) * 9.0, 40.0)));
        emission += coronaCol * (coronaDens * 0.48);
      }

      // 4A. Crisp Field-Aligned Dipole / Twisted-Dipole Flux Loops (1.04 < L <= rLightCylVis)
      if (inLoops) {
        float logL = log(L);
        float sepDist = (L - rLightCylVis * 0.90) * invSepW;
        float sepSq = sepDist * sepDist * 2.5;
        float sBApprox = sin(logL * 9.5 + 0.225);
        float lEnv = smoothstep(1.04, 1.24, L) * (1.0 - smoothstep(rLightCylVis * 0.88, rMagLoopMax, L));
        float rFade = smoothstep(1.02, 1.15, r) / (1.0 + 0.36 * pow(max(r - 1.0, 1e-5), 1.55));

        vec3 cIce    = vec3(0.68, 0.94, 1.00);
        vec3 cCyan   = vec3(0.06, 0.44, 1.00);
        vec3 cViolet = vec3(0.32, 0.10, 0.98);
        vec3 magCol = mix(cViolet, cCyan, smoothstep(rLightCylVis, 1.35, L));

        if (sBApprox < -0.525 && sepSq >= 12.0) {
          float magDens = lEnv * rFade * 0.00555 * plasmaDensity * segCorotBeam * camDistFade;
          if (twistFactor > 0.001) {
            magCol = mix(magCol, vec3(0.48, 0.14, 1.00), twistFactor * 0.45);
          }
          emission += magCol * (magDens * 0.125);
        } else {
          float invL = sin2Theta * invR;
          float dTwist = twistShear * cosThetaM * (1.0 - invL) * 2.2;
          bool hasAz = rhoM2 > 1e-10;
          float invRhoM = hasAz ? inversesqrt(rhoM2) : 1.0;
          float cPhi = hasAz ? (xM * invRhoM) : 1.0;
          float sPhi = hasAz ? (yM * invRhoM) : 0.0;
          float cTw = cos(dTwist);
          float sTw = sin(dTwist);
          float cTwist = cPhi * cTw + sPhi * sTw;
          float sTwist = sPhi * cTw - cPhi * sTw;

          float qRad = 0.55 + 0.22 * logL;
          float flowMag = simTime * (0.35 + 0.45 * spinVisualSpeed);
          vec3 qMag = vec3(
            cTwist * qRad,
            sTwist * qRad,
            cosThetaM * 1.85 - flowMag
          );
          vec4 nMag = textureLod(uVolumeNoise, qMag, 0.0);

          float sB0 = clamp(0.5 + 0.5 * sin(logL * 9.5 + 0.45 * nMag.r), 0.0, 1.0);
          float sepEnv = (sepSq < 12.0) ? exp(-sepSq) : 0.0;

          float filamentCore = 0.0;
          if (sB0 > 0.35 || sepEnv > 1e-4) {
            float c2 = cTwist * cTwist - sTwist * sTwist;
            float s2 = 2.0 * cTwist * sTwist;
            float c4 = c2 * c2 - s2 * s2;
            float s4 = 2.0 * c2 * s2;
            float c8 = c4 * c4 - s4 * s4;
            float s8 = 2.0 * c4 * s4;
            float c10 = c8 * c2 - s8 * s2;
            float s10 = s8 * c2 + c8 * s2;
            float c18 = c10 * c8 - s10 * s8;
            float s18 = s10 * c8 + c10 * s8;

            float angB = 0.65 * nMag.b - 1.4 * logL;
            float fB = clamp(0.5 + 0.5 * (c18 * cos(angB) - s18 * sin(angB)), 0.0, 1.0);
            float fB2 = fB * fB;
            float fB4 = fB2 * fB2;
            float tubeB = fB4 * fB4 * fB4;

            float shellBands = 0.0;
            float tubeA = 0.0;
            if (sB0 > 0.35) {
              float sB2 = sB0 * sB0;
              shellBands = sB2 * sB2 * sB2 * sB2 * sB2;
              float A = 0.55 * nMag.r;
              float A2 = A * A;
              float cosA = 1.0 - A2 * (0.5 - A2 * 0.0416667);
              float sinA = A * (1.0 - A2 * (0.1666667 - A2 * 0.0083333));
              float fA = clamp(0.5 + 0.5 * (c10 * cosA - s10 * sinA), 0.0, 1.0);
              float fA2 = fA * fA;
              float fA4 = fA2 * fA2;
              tubeA = fA4 * fA4 * fA4 * fA2;
            }

            filamentCore = min(
              1.85 * tubeA * shellBands + 0.85 * tubeB * shellBands + 1.10 * sepEnv * (0.25 + 0.95 * tubeB),
              2.5
            );
          }

          float tubeStruct = (0.006 + filamentCore * (0.45 + 0.75 * nMag.a)) * (0.65 + 0.55 * nMag.g);
          float magDens = lEnv * rFade * tubeStruct * plasmaDensity * segCorotBeam * camDistFade;

          magCol = mix(magCol, cIce, min(filamentCore * 0.55, 1.0));

          if (twistFactor > 0.001) {
            float twistCore = (filamentCore > 1e-4) ? pow(min(filamentCore * 0.60, 1.0), 1.25) : 0.0;
            vec3 jViolet = vec3(0.48, 0.14, 1.00);
            vec3 jWhiteViolet = vec3(0.86, 0.82, 1.00);
            vec3 twistCol = mix(jViolet, jWhiteViolet, twistCore);
            magCol = mix(magCol, twistCol, twistFactor * (0.45 + 0.55 * twistCore));
          }

          emission += magCol * (magDens * 0.125);
        }
      }

      // 4A-2. Delicate Retarded Equatorial Current Sheet & Y-Point Reconnection
      if (inSheet) {
        float sheetRatio = cosThetaM * (1.0 / 0.042);
        float sheetProf = exp(-sheetRatio * sheetRatio);
        if (sheetProf > 0.005) {
          float yPtDist = (r - 0.96 * rLightCylVis) / max(0.14 * rLightCylVis, 0.35);
          float yPoint = exp(-min(yPtDist * yPtDist, 40.0)) * 1.45;
          float sheetEnv = smoothstep(rSheetMin, 0.94 * rLightCylVis, r)
                         * (1.0 - smoothstep(rSheetMax * 0.72, rSheetMax, r))
                         / (1.0 + 0.18 * max(r - rSheetMin, 0.0));

          bool hasAzS = rhoM2 > 1e-10;
          float invRhoS = hasAzS ? inversesqrt(rhoM2) : 1.0;
          float cPhiS = hasAzS ? (xM * invRhoS) : 1.0;
          float sPhiS = hasAzS ? (yM * invRhoS) : 0.0;
          float flowSheet = r * 0.32 - simTime * (0.75 + 0.95 * spinVisualSpeed);
          vec4 nSheet = textureLod(uVolumeNoise, vec3(cPhiS * 0.65, sPhiS * 0.65, flowSheet), 0.0);
          float plasmoids = 0.35 + 1.15 * pow(max(nSheet.g, 1e-5), 2.2) * (0.5 + 0.5 * nSheet.a);

          float sheetDens = sheetEnv * sheetProf * (plasmoids + yPoint * (0.65 + 0.55 * nSheet.g))
                          * plasmaDensity * segCorotBeam * camDistFade;
          vec3 sheetCol = mix(
            vec3(0.20, 0.30, 0.98),
            vec3(0.68, 0.92, 1.00),
            clamp(sheetProf * 0.75 + yPoint * 0.45, 0.0, 1.0)
          );
          emission += sheetCol * (sheetDens * 0.045);
        }
      }
    }

    // 4B. Sweeping Lighthouse Synchrotron / Curvature Beams around +-muHat
    if (needBeam) {
      float absCosB = abs(cosThetaM);
      if (absCosB > cosMaxCone) {
        float sinB = sqrt(max(1.0 - absCosB * absCosB, 0.0));
        float thetaB = atan(sinB, absCosB);
        float thetaCone = beamConeHalfAngle * mix(0.56, 1.04, smoothstep(1.0, 4.2, r));
        float coneW = max(thetaCone * 0.18, 0.030);
        float coreW = max(thetaCone * 0.22, 0.036);

        if (thetaB < thetaCone + 3.4 * coneW) {
          float cd = (thetaB - thetaCone) / coneW;
          float hollowCone = exp(-min(cd * cd, 40.0));
          float kd = thetaB / coreW;
          float coreBeam = exp(-min(kd * kd, 40.0)) * 0.92;

          float radialOnset = smoothstep(1.01, 1.18, r)
                            * (1.0 - smoothstep(10.5, 18.0, r))
                            / (1.0 + 0.22 * r * r);

          bool hasAzB = rhoM2 > 1e-10;
          float invRhoB = hasAzB ? inversesqrt(rhoM2) : 1.0;
          float cPhiB = hasAzB ? (xM * invRhoB) : 1.0;
          float sPhiB = hasAzB ? (yM * invRhoB) : 0.0;
          float phiB = hasAzB ? atan(yM, xM) : 0.0;
          float flowOut = r * 0.28 - simTime * (0.95 + 1.25 * spinVisualSpeed);
          vec3 qBeam = vec3(cPhiB * 0.68, sPhiB * 0.68, flowOut);
          vec4 nBeam = textureLod(uVolumeNoise, qBeam, 0.0);
          float streakCos = clamp(0.5 + 0.5 * cos(8.0 * phiB + 0.6 * nBeam.r + r * 0.35 - simTime * 2.2), 0.0, 1.0);
          float sc2 = streakCos * streakCos;
          float subPulses = (0.30 + 0.90 * nBeam.g * nBeam.g) * (0.40 + 0.60 * sc2 * sc2) * (0.65 + 0.35 * nBeam.a);

          // Relativistic forward beaming along outward retarded beam axis toward -vel
          float signMu = cosThetaM >= 0.0 ? 1.0 : -1.0;
          vec3 muRetLab = signMu * vec3(cRet * sinObl, cosObl, -sRet * sinObl);
          vec3 rHatLab = pos * invR;
          vec3 beamDir = normalize(mix(muRetLab, rHatLab, 0.42));
          float cosForward = dot(beamDir, toCamDir);
          float dopplerBeam = 1.0 / max(1.0 - 0.62 * cosForward, 0.26);
          float beaming = pow(clamp(dopplerBeam, 0.35, 3.8), 1.75);

          vec3 beamCol = mix(vec3(0.32, 0.16, 1.00), vec3(0.12, 0.68, 1.00), clamp(hollowCone + coreBeam, 0.0, 1.0));
          beamCol = mix(beamCol, vec3(0.92, 0.98, 1.00), smoothstep(1.15, 3.0, beaming) * 0.88);

          float beamVal = beamIntensity * radialOnset * (hollowCone * 1.10 + coreBeam * 0.95)
                        * subPulses * beaming * camDistFade;
          emission += beamCol * (beamVal * 0.34);
        }
      }
    }
  }

  // 4C. Chandra/Hubble-Faithful PWN Equatorial Termination Shock Ring & Outward Synchrotron Wisps
  if (segNeedsPwn && r > 2.55 && r < 8.8 && abs(pos.y) < 1.32) {
    float hRing = 0.12 + 0.03 * r;
    float absY = abs(pos.y);
    if (absY < hRing * 3.4) {
      float yT = absY / max(hRing, 1e-4);
      float vertTorus = exp(-min(yT * yT * 1.85, 40.0));
      float dr = (yT - 0.62) / 0.30;
      float doubleRing = 0.62 + 0.58 * exp(-min(dr * dr, 40.0));

      float radEnv = smoothstep(2.55, 3.15, r)
                   * (1.0 - smoothstep(6.0, 8.8, r))
                   / (1.0 + 0.055 * r * r);
      float tsDist = (r - 3.25) / 0.20;
      float termShock = exp(-min(tsDist * tsDist, 40.0)) * 2.4;

      float rhoXZ2 = pos.x * pos.x + pos.z * pos.z;
      float invRhoXZ = inversesqrt(max(rhoXZ2, 1e-12));
      float cAz = pos.x * invRhoXZ;
      float sAz = pos.z * invRhoXZ;
      float rotAngle = 0.18 * simTime * (0.4 + spinVisualSpeed) - 0.28 * r;
      float cr = cos(rotAngle);
      float sr = sin(rotAngle);
      float cp = cAz * cr - sAz * sr;
      float sp = sAz * cr + cAz * sr;

      vec3 pwnCoordA = vec3(cp * 0.32 + r * 0.09, sp * 0.32 + r * 0.09, pos.y * 0.65);
      vec3 pwnCoordB = vec3(cp * 0.72 - r * 0.16, sp * 0.72 + r * 0.16, pos.y * 1.15);
      vec4 nPwnA = textureLod(uVolumeNoise, pwnCoordA, 0.0);
      vec4 nPwnB = textureLod(uVolumeNoise, pwnCoordB, 0.0);

      float wispPhase = r * 2.55 - simTime * (0.55 + 0.75 * spinVisualSpeed) + (nPwnA.r - 0.5) * 1.45;
      float w0 = max(0.5 + 0.5 * sin(wispPhase), 0.0);
      float w2 = w0 * w0;
      float w4 = w2 * w2;
      float wisps = w4 * w2 * w0 * sqrt(max(w0, 1e-5));
      float filaments = (0.28 + 1.25 * nPwnA.g * nPwnA.g) * (0.45 + 0.75 * nPwnB.a);
      float tsKnots = 0.55 + 0.95 * pow(max(nPwnB.g, 1e-5), 1.6);

      // Authentic post-shock relativistic outflow Doppler asymmetry (beta_PWN = 0.42, capped cleanly)
      vec3 radEqDir = vec3(cAz, 0.0, sAz);
      float cosOut = dot(radEqDir, toCamDir);
      float dopPwn = 1.0 / max(1.0 - 0.42 * cosOut, 0.45);
      float pwnBeam = pow(clamp(dopPwn, 0.45, 1.85), 1.75);

      float torusDens = pwnVisibility * radEnv * vertTorus * doubleRing
                      * (0.01 * filaments + 1.55 * wisps * filaments + termShock * tsKnots)
                      * pwnBeam * camDistFade;

      vec3 torusCol = mix(vec3(0.24, 0.12, 0.95), vec3(0.06, 0.56, 1.00), smoothstep(8.2, 3.1, r));
      torusCol = mix(
        torusCol,
        vec3(0.82, 0.96, 1.00),
        clamp(wisps * 0.65 + termShock * 0.45 + smoothstep(1.25, 1.85, pwnBeam) * 0.35, 0.0, 1.0)
      );

      emission += torusCol * (torusDens * 0.062);
    }
  }

  // 4D. Sleek Kink-Braided Relativistic Polar Jets (+-Y)
  if (segNeedsJet) {
    float absY = abs(pos.y);
    float rhoXZ2 = dot(pos.xz, pos.xz);
    if (rhoXZ2 < 3.6 && absY >= 1.25 && absY <= 18.0) {
      float signY = pos.y >= 0.0 ? 1.0 : -1.0;
      float kinkAmp = smoothstep(2.2, 11.5, absY) * 0.28;
      float kinkAng = signY * (absY * 0.42 - simTime * (0.45 + 0.75 * spinVisualSpeed));
      vec2 jetCenter = vec2(cos(kinkAng), sin(kinkAng)) * kinkAmp;
      vec2 relXZ = pos.xz - jetCenter;
      float rho = length(relXZ);
      float jetRadius = 0.11 + 0.052 * pow(max(absY - 1.15, 0.0), 0.76);
      if (rho < jetRadius * 2.8) {
        float uRad = rho / max(jetRadius, 1e-4);
        float spine = exp(-min(uRad * uRad * 7.0, 40.0));
        float braidEnv = exp(-min(uRad * uRad * 2.4, 40.0));
        float halo = exp(-min(uRad * uRad * 0.85, 40.0)) * 0.16;

        float yEnv = smoothstep(1.25, 2.6, absY)
                   * (1.0 - smoothstep(10.5, 18.0, absY))
                   / (1.0 + 0.12 * absY);

        float helixAngle = signY * (absY * 0.92 - simTime * (0.75 + 1.45 * spinVisualSpeed));
        float ch = cos(helixAngle), sh = sin(helixAngle);
        vec2 rotXZ = vec2(ch * relXZ.x - sh * relXZ.y, sh * relXZ.x + ch * relXZ.y);

        float flowY = absY * 0.22 - simTime * (0.42 + 0.75 * spinVisualSpeed);
        vec4 jn = textureLod(uVolumeNoise, vec3(rotXZ * 0.62, flowY), 0.0);

        float rawFil = clamp(jn.y * 0.64 + jn.w * 0.54, 0.0, 1.0);
        float filaments = rawFil * rawFil * rawFil;
        float knotWave = max(0.5 + 0.5 * sin(absY * 1.45 - simTime * (0.85 + 1.25 * spinVisualSpeed) + jn.r * 2.2), 0.0);
        float kw2 = knotWave * knotWave;
        float knots = 0.35 + 1.25 * (kw2 * kw2);

        float radProf = spine * 0.85 + braidEnv * (0.35 + 0.95 * filaments) + halo;

        float cosTheta = signY * toCamDir.y;
        float dopplerJet = 1.0 / max(1.0 - 0.55 * cosTheta, 0.28);
        float jetBeam = pow(clamp(dopplerJet, 0.38, 2.6), 1.55);
        float viewColAtten = mix(1.0, 0.28, pow(max(abs(cosTheta), 1e-5), 1.55));

        vec3 coreCol   = vec3(0.86, 0.97, 1.00);
        vec3 sheathCol = vec3(0.08, 0.54, 1.00);
        vec3 outerCol  = vec3(0.36, 0.12, 0.96);
        vec3 jetCol = mix(sheathCol, coreCol, clamp(spine * 0.90 + filaments * 0.45, 0.0, 1.0));
        jetCol = mix(jetCol, outerCol, smoothstep(0.55, 1.80, uRad) * 0.72);

        float rawInt = jetAmp * radProf * yEnv * knots * jetBeam * viewColAtten * camDistFade;
        float intensity = rawInt / (1.0 + rawInt * 0.38);
        emission += jetCol * (intensity * 0.28);
      }
    }
  }

  return vec4(emission, nearMagFlag);
}

// ============================================================================
// 5. MAIN ADAPTIVE HYBRID RK4/RK2 GEODESIC RAY-MARCHER & TRANSFER
// ============================================================================

void main() {
  vec2 res = max(u.resolution_time_frame.xy, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + u.jitter_fov_lensing.xy;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(u.jitter_fov_lensing.z, 0.1, 2.8) * 0.5);
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  float simTime = u.resolution_time_frame.z;
  int frameIndex = int(round(u.resolution_time_frame.w));
  float lensing = clamp(u.jitter_fov_lensing.w, 0.0, 1.0);

  vec3 camPos   = u.camPos_compactness.xyz;
  float M       = clamp(u.camPos_compactness.w, 0.05, 0.35);
  vec3 camRight = u.camRight_spinA.xyz;
  float a       = clamp(u.camRight_spinA.w, 0.0, 0.25);
  float a2      = a * a;
  vec3 camUp    = u.camUp_betaEq.xyz;
  float betaEq  = clamp(u.camUp_betaEq.w, 0.0, 0.45);
  vec3 camFwd   = u.camFwd_phase.xyz;
  float spinPhase = u.camFwd_phase.w;

  float obliquityRad  = u.magnetParams.x;
  float twistShear    = max(u.magnetParams.y, 0.0);
  float rLightCylVis  = max(u.magnetParams.z, 1.5);
  float plasmaDensity = max(u.magnetParams.w, 0.0);

  float beamIntensity = max(u.beamPwnParams.x, 0.0);
  float pwnVisibility = max(u.beamPwnParams.y, 0.0);
  float polarCapTempK = max(u.beamPwnParams.z, 1.0e5);
  float crustTempK    = max(u.beamPwnParams.w, 1.0e5);

  float skyIntensity = max(u.skyParams.x, 0.0);
  int skyMode        = int(round(u.skyParams.y));
  vec2 skyRot        = u.skyParams.zw;

  int quality           = int(round(u.qualityParams.x));
  float spinVisualSpeed = max(u.qualityParams.y, 0.0);
  bool isProgressive    = u.qualityParams.z > 0.5;

  float beamConeHalfAngle = clamp(u.extraParams.x, 0.08, 0.90);
  float magnetarCrackGlow = max(u.extraParams.y, 0.0);
  float pwnJetPower       = max(u.extraParams.z, 0.0);

  // Frame-constant magnetic basis, cone early-out bound, and volume outer bound
  float cosObl = cos(obliquityRad);
  float sinObl = sin(obliquityRad);

  float maxThetaCone = beamConeHalfAngle * 1.04;
  float maxConeW = max(maxThetaCone * 0.24, 0.038);
  float maxBeamAngle = maxThetaCone + 3.2 * maxConeW;
  float cosMaxCone = (maxBeamAngle < 1.56) ? cos(maxBeamAngle) : -0.01;

  float twistFactor = smoothstep(0.60, 1.85, twistShear);
  float invSepW = 1.0 / max(rLightCylVis * 0.11, 0.34);
  float invRLc = 1.0 / rLightCylVis;
  float retardFactor = (0.85 + 0.55 * betaEq) * invRLc;
  float rMagLoopMax = rLightCylVis * 1.14;
  float rSheetMin = 0.80 * rLightCylVis;
  float rSheetMax = min(rLightCylVis * 1.45, 10.5);
  float rMagOuter = max(rMagLoopMax, rSheetMax);
  float jetAmp = pwnVisibility * pwnJetPower;

  bool hasMag  = (plasmaDensity > 0.001);
  bool hasBeam = (beamIntensity > 0.001);
  bool hasPwn  = (pwnVisibility > 0.001);
  bool hasJet  = (jetAmp > 0.001);

  float volBoundR = 1.01;
  if (hasMag)  volBoundR = max(volBoundR, rMagOuter);
  if (hasPwn)  volBoundR = max(volBoundR, 8.8);
  if (hasBeam) volBoundR = max(volBoundR, 18.0);
  if (hasJet)  volBoundR = max(volBoundR, 18.1);

  CameraRayInit ray0 = initCameraRay(camPos, camRight, camUp, camFwd, localRay, M, a, a2, lensing);
  vec3 pos = camPos;
  vec3 p   = ray0.p;
  float pt = ray0.pt;

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int maxSteps = isProgressive ? 160 : 120;
  float qualScale = isProgressive ? 0.78 : 0.92;
  if (quality <= 0) {
    maxSteps = isProgressive ? 115 : 88;
    qualScale = isProgressive ? 1.05 : 1.18;
  } else if (quality >= 2) {
    maxSteps = isProgressive ? 225 : 176;
    qualScale = isProgressive ? 0.60 : 0.70;
  }

  float camR = length(camPos);
  float escapeR = max(20.0, camR * 1.35);

  vec3 radiance = vec3(0.0);
  float rayDist = 0.0;
  bool hitStar = false;
  bool shadeStar = false;
  bool escaped = false;
  bool nearMagShell = true;
  vec3 hitPos = camPos;
  vec3 hitP = p;
  vec3 hitVel = localRay;
  vec3 finalVel = localRay;

  for (int step = 0; step < 225; ++step) {
    if (step >= maxSteps) break;

    GeodesicDeriv k1;
    if (lensing <= 1e-6) {
      k1.dpos = p;
      k1.dp = vec3(0.0);
      k1.r = evalKerrR(pos, a2);
    } else {
      k1 = evalGeodesicRHS(pos, p, pt, M, a, a2, lensing);
    }
    float r = k1.r;
    finalVel = k1.dpos;

    if (r <= 1.0) {
      hitPos = pos;
      hitP = p;
      hitVel = k1.dpos;
      hitStar = true;
      shadeStar = true;
      break;
    }

    bool outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    // Pure geodesic step size (decoupled from volumetric sampling)
    float h;
    if (outbound && r > volBoundR) {
      h = clamp(0.50 * r * qualScale, 1.2, 6.0);
    } else if (r > volBoundR) {
      h = clamp(0.35 * r * qualScale, 0.50 * qualScale, max(r - volBoundR + 0.25, 0.50 * qualScale));
    } else if (r < 2.4) {
      h = (0.042 + 0.078 * max(r - 1.0, 0.0)) * qualScale;
    } else {
      h = clamp(0.13 * (r - 0.55) * qualScale, 0.08 * qualScale, 2.2 * qualScale);
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    // Hybrid geodesic integrator: flat straight step / weak-field RK2 / strong-field RK4
    vec3 posNext;
    vec3 pNext;
    vec3 velEnd;
    if (lensing <= 1e-6) {
      posNext = pos + h * k1.dpos;
      pNext   = p;
      velEnd  = k1.dpos;
    } else if (r >= 2.8) {
      vec3 posMid = pos + (0.5 * h) * k1.dpos;
      vec3 pMid   = p   + (0.5 * h) * k1.dp;
      GeodesicDeriv k2 = evalGeodesicRHS(posMid, pMid, pt, M, a, a2, lensing);
      posNext = pos + h * k2.dpos;
      pNext   = p   + h * k2.dp;
      velEnd  = k2.dpos;
    } else {
      vec3 pos2 = pos + (0.5 * h) * k1.dpos;
      vec3 p2   = p   + (0.5 * h) * k1.dp;
      GeodesicDeriv k2 = evalGeodesicRHS(pos2, p2, pt, M, a, a2, lensing);

      vec3 pos3 = pos + (0.5 * h) * k2.dpos;
      vec3 p3   = p   + (0.5 * h) * k2.dp;
      GeodesicDeriv k3 = evalGeodesicRHS(pos3, p3, pt, M, a, a2, lensing);

      vec3 pos4 = pos + h * k3.dpos;
      vec3 p4   = p   + h * k3.dp;
      GeodesicDeriv k4 = evalGeodesicRHS(pos4, p4, pt, M, a, a2, lensing);

      posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
      pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);
      velEnd  = k4.dpos;
    }

    float r2NextEuclid = dot(posNext, posNext);
    bool maybeHit = (r2NextEuclid <= 1.0 + a2 + 1e-5);
    float rNext = maybeHit ? evalKerrR(posNext, a2) : 2.0;

    bool hitThisStep = false;
    float alphaHi = 1.0;
    vec3 v0 = vec3(0.0);
    vec3 v1 = vec3(0.0);
    if (rNext <= 1.0) {
      hitThisStep = true;
      alphaHi = 1.0;
      v0 = h * k1.dpos;
      v1 = h * velEnd;
    } else if (r < 1.18 && dot(pos, k1.dpos) < 0.0) {
      v0 = h * k1.dpos;
      v1 = h * velEnd;
      vec3 midH = evalHermite(pos, v0, posNext, v1, 0.5);
      if (evalKerrR(midH, a2) <= 1.0) {
        hitThisStep = true;
        alphaHi = 0.5;
      }
    }

    vec3 segEnd = posNext;
    vec3 segVelEnd = velEnd;
    if (hitThisStep) {
      float aLo = 0.0;
      float aHi = alphaHi;
      float rLo = r;
      float rHi = (alphaHi > 0.75) ? rNext : evalKerrR(evalHermite(pos, v0, posNext, v1, alphaHi), a2);

      for (int bi = 0; bi < 6; ++bi) {
        float aMid = 0.5 * (aLo + aHi);
        vec3 xMid = evalHermite(pos, v0, posNext, v1, aMid);
        float rMid = evalKerrR(xMid, a2);
        if (rMid <= 1.0) {
          aHi = aMid;
          rHi = rMid;
        } else {
          aLo = aMid;
          rLo = rMid;
        }
      }

      float denomR = rLo - rHi;
      float secFrac = (abs(denomR) > 1e-6) ? clamp((rLo - 1.0) / denomR, 0.0, 1.0) : 0.5;
      float alphaHit = mix(aLo, aHi, secFrac);
      hitPos = evalHermite(pos, v0, posNext, v1, alphaHit);
      hitP   = mix(p, pNext, alphaHit);
      hitVel = mix(k1.dpos, velEnd, alphaHit);
      segEnd = hitPos;
      segVelEnd = hitVel;
    }

    // Segment-level volume intersection culling + volumetric sub-stepping
    vec3 segVec = segEnd - pos;
    float segLen2 = dot(segVec, segVec);
    float segLen = sqrt(segLen2);
    if (segLen > 1e-5) {
      float tMin = clamp(-dot(pos, segVec) / segLen2, 0.0, 1.0);
      vec3 closestP = pos + tMin * segVec;
      float minR2 = dot(closestP, closestP);

      if (minR2 < volBoundR * volBoundR) {
        float maxR2 = max(dot(pos, pos), dot(segEnd, segEnd));
        bool segNeedsMag = hasMag && (minR2 < rMagOuter * rMagOuter);
        bool segNeedsBeam = hasBeam && (minR2 < 324.0);
        bool segNeedsPwn = hasPwn && (minR2 < 77.44) && (maxR2 > 6.5025)
                        && (min(abs(pos.y), abs(segEnd.y)) < 1.32 || pos.y * segEnd.y < 0.0);

        float segXZ2 = dot(segVec.xz, segVec.xz);
        float tXZ = (segXZ2 > 1e-10) ? clamp(-dot(pos.xz, segVec.xz) / segXZ2, 0.0, 1.0) : 0.0;
        vec2 clXZ = pos.xz + tXZ * segVec.xz;
        bool segNeedsJet = hasJet && (dot(clXZ, clXZ) < 3.6)
                        && (min(abs(pos.y), abs(segEnd.y)) < 18.0)
                        && (max(abs(pos.y), abs(segEnd.y)) > 1.25);

        if (segNeedsMag || segNeedsBeam || segNeedsPwn || segNeedsJet) {
          vec3 midPos = pos + 0.5 * segVec;
          float r2Mid = max(dot(midPos, midPos), 1e-8);
          float invRMid = inversesqrt(r2Mid);
          float rMid = r2Mid * invRMid;

          float hVol = clamp(0.11 * (rMid - 0.55) * qualScale, 0.06 * qualScale, 1.65 * qualScale);
          if (rMid < 2.2) {
            hVol = min(hVol, (0.032 + 0.055 * max(rMid - 1.0, 0.0)) * qualScale);
          }
          if (segNeedsMag && minR2 < rMagLoopMax * rMagLoopMax && nearMagShell) {
            hVol = min(hVol, (0.072 + 0.050 * max(rMid - 1.0, 0.0)) * qualScale);
          }
          if (segNeedsJet) {
            hVol = min(hVol, 0.20 * qualScale);
          }
          if (segNeedsPwn) {
            hVol = min(hVol, 0.26 * qualScale);
          }

          int nSub = clamp(int(floor(segLen / max(hVol, 0.03) + 0.5)), 1, 6);
          float invNSub = 1.0 / float(nSub);
          float dsSub = segLen * invNSub;

          vec3 segVelMid = 0.5 * (k1.dpos + segVelEnd);
          vec3 segToCamDir = (dot(segVelMid, segVelMid) > 1e-10) ? -normalize(segVelMid) : (-midPos * invRMid);

          float segCorotBeam = 1.0;
          if (segNeedsMag) {
            float rhoCyl2 = dot(midPos.xz, midPos.xz);
            float invRhoCyl = (rhoCyl2 > 1e-10) ? inversesqrt(rhoCyl2) : 0.0;
            float rhoCyl = rhoCyl2 * invRhoCyl;
            float betaCorotMag = clamp(rhoCyl * invRLc, 0.0, 0.72) * (0.35 + 0.65 * min(betaEq * 3.5, 1.0));
            float corotDot = (midPos.z * segToCamDir.x - midPos.x * segToCamDir.z) * invRhoCyl;
            float gammaCorot = inversesqrt(max(1.0 - betaCorotMag * betaCorotMag, 0.15));
            float dopCorot = 1.0 / max(gammaCorot * (1.0 - betaCorotMag * corotDot), 0.30);
            segCorotBeam = pow(clamp(dopCorot, 0.35, 3.2), 1.8);
          }

          bool segNearMag = false;
          float jBase = fract(bn.y + float(step) * 0.61803399);
          for (int sub = 0; sub < 6; ++sub) {
            if (sub >= nSub) break;
            float uSub = (float(sub) + jBase) * invNSub;
            vec3 samplePos = pos + uSub * segVec;
            float r2Samp = max(dot(samplePos, samplePos), 1e-8);
            float invRSamp = inversesqrt(r2Samp);
            float rSamp = r2Samp * invRSamp;
            bool outsideCrust = (a2 >= 1e-6 && r2Samp < 1.06 + a2)
              ? (evalKerrR(samplePos, a2) > 1.01)
              : (rSamp > 1.01);

            if (outsideCrust && rSamp < volBoundR) {
              float camDistFade = smoothstep(0.25, 1.75, rayDist + uSub * segLen);
              vec4 volRes = evalPulsarVolume(
                samplePos, segToCamDir, rSamp, invRSamp, simTime, spinPhase, sinObl, cosObl,
                twistShear, twistFactor, rLightCylVis, invSepW, retardFactor, rMagLoopMax, rSheetMin,
                rSheetMax, rMagOuter, plasmaDensity, beamIntensity, beamConeHalfAngle, cosMaxCone,
                pwnVisibility, jetAmp, spinVisualSpeed, camDistFade, segCorotBeam,
                segNeedsMag, segNeedsBeam, segNeedsPwn, segNeedsJet
              );
              radiance += volRes.rgb * dsSub;
              if (rSamp >= rMagLoopMax || volRes.a > 0.5) {
                segNearMag = true;
              }
            } else if (rSamp >= rMagLoopMax) {
              segNearMag = true;
            }
          }
          nearMagShell = segNearMag;
        } else if (minR2 >= rMagLoopMax * rMagLoopMax) {
          nearMagShell = true;
        }
      } else {
        nearMagShell = true;
      }
    }

    if (hitThisStep) {
      hitStar = true;
      shadeStar = true;
      break;
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;
  }

  if (shadeStar) {
    radiance += shadeNeutronStarSurface(
      hitPos, hitP, pt, hitVel, M, a, a2, lensing, betaEq, simTime, spinPhase,
      sinObl, cosObl, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
    );
  }

  if (!hitStar && !escaped) {
    float rEnd = evalKerrR(pos, a2);
    if (rEnd <= 1.02) {
      hitStar = true;
    } else {
      escaped = true;
    }
  }

  // Sample lensed sky unconditionally in uniform control flow (wrap- & silhouette-safe!)
  float escFlag = (escaped && !hitStar) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);
  vec3 safeSkyDir = (dot(finalVel, finalVel) > 1e-10) ? normalize(finalVel) : localRay;
  vec3 skyColor = sampleSkyBackground(safeSkyDir, skyIntensity, skyMode, skyRot, escFlag > 0.5, edgeMask);

  if (escFlag > 0.5) {
    radiance += skyColor;
  }

  // Strict NaN/Inf guard and float16-safe HDR upper clamp
  bvec3 bad = bvec3(
    isnan(radiance.r) || isinf(radiance.r),
    isnan(radiance.g) || isinf(radiance.g),
    isnan(radiance.b) || isinf(radiance.b)
  );
  radiance = mix(radiance, vec3(0.0), bad);
  radiance = clamp(radiance, vec3(0.0), vec3(36.0));

  fragColor = vec4(radiance, 1.0);
}
`;
