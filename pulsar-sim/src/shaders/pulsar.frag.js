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
  KSFields f = evalKSFields(pos, M, a, a2, lensing);
  float L = pt + dot(f.l, p);
  float twoHL = 2.0 * f.H * L;

  GeodesicDeriv outD;
  outD.dpos = p - twoHL * f.l;
  outD.r = f.r;

  if (lensing <= 1e-6) {
    outD.dp = vec3(0.0);
    return outD;
  }

  float invD = 1.0 / max(f.D, 1e-10);
  float hFac = lensing * M * f.r2 * invD * invD;
  float cR = 3.0 * a2 * pos.y * pos.y - f.r2 * f.r2;
  vec3 gradH = (hFac * cR) * f.gradR;
  gradH.y -= hFac * (2.0 * f.r * a2 * pos.y);

  float invR2 = 1.0 / max(f.R2, 1e-8);
  float invR = 1.0 / max(f.r, 1e-5);
  float S = (p.x * (pos.x - 2.0 * f.r * f.l.x) + p.z * (pos.z - 2.0 * f.r * f.l.z)) * invR2
          - p.y * f.l.y * invR;

  vec3 w = vec3(
    (f.r * p.x - a * p.z) * invR2,
    p.y * invR,
    (a * p.x + f.r * p.z) * invR2
  ) + S * f.gradR;

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

// Map neutron-star physical Kelvin (10^5..1.5x10^7 K) onto CIE-1931 Planck curve
float mapPulsarTempToLut(float physTempK) {
  float scaled = 2800.0 * pow(max(physTempK, 1.0e5) * 1.0e-6, 1.15);
  return clamp(scaled, T_MIN, T_MAX);
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

  float fw = clamp(pixelFw * scale, 0.018, 0.18);
  float starRad = mix(0.028, 0.088, mag) + fw * 0.40;
  float core = exp(-min((dist * dist) / max(starRad * starRad * 0.34, 1e-5), 40.0));
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
  float spinPhase,
  vec3 mu0,
  vec3 em1_0,
  vec3 em2_0,
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

  float cosM = dot(rHatBody, mu0);
  float absCosM = abs(cosM);
  float sinM = sqrt(max(1.0 - cosM * cosM, 0.0));
  float xM = dot(rHatBody, em1_0);
  float yM = dot(rHatBody, em2_0);
  float phiM = (abs(xM) + abs(yM) > 1e-6) ? atan(yM, xM) : 0.0;
  float signCosM = cosM >= 0.0 ? 1.0 : -1.0;

  // Co-rotating 3D crust noise & tectonic shear warp
  vec3 shearCoord = pBody * 0.48 + vec3(0.17, 0.31, 0.53);
  vec4 nCrust = textureLod(uVolumeNoise, shearCoord, 0.0);
  vec3 fineCoord = pBody * 1.12 + (nCrust.rgb - vec3(0.5)) * 0.42
                 + vec3(0.16 * twistShear * signCosM * pBody.z, 0.0, -0.16 * twistShear * signCosM * pBody.x);
  vec4 nFine = textureLod(uVolumeNoise, fineCoord, 0.0);

  // Polar cap angular footprint from last closed dipole field line sin(theta_pc) = 1 / sqrt(R_LC)
  float sinThetaPc = clamp(inversesqrt(max(rLightCylVis, 1.5)), 0.16, 0.62);
  float sinPerturb = sinM + (nFine.r - 0.5) * 0.042 * sinM;

  float capCore = 1.0 - smoothstep(sinThetaPc * 0.28, sinThetaPc * 0.96, sinPerturb);
  float capIn = sinPerturb / max(sinThetaPc * 0.48, 0.06);
  float capInner = exp(-min(capIn * capIn, 40.0));
  float capRimDist = (sinPerturb - sinThetaPc * 0.96) / max(sinThetaPc * 0.20, 0.045);
  float capRim = exp(-min(capRimDist * capRimDist, 40.0));
  float auroralMod = 0.58 + 0.42 * sin(2.0 * phiM + twistShear * 1.45 * signCosM + nCrust.g * 3.4);

  // Anisotropic magnetic thermal map across the heavy-iron neutron-star crust
  float latThermal = 0.22 + 0.78 * pow(max(absCosM, 1e-5), 1.45);
  float crustGran = 0.54 + 0.68 * nCrust.r * (0.55 + 0.45 * nFine.b);

  // Continuous branching molten magnetic tectonic fissures from 3D fBM level sets
  float lineA = 1.0 - abs(nCrust.r * 2.0 - 1.0);
  float lineB = 1.0 - abs(nFine.r * 2.0 - 1.0);
  float pA = clamp(lineA, 1e-5, 1.0);
  float pB = clamp(lineB, 1e-5, 1.0);
  float faultNet = max(pow(pA, 8.0), 0.78 * pow(pB, 10.0) * smoothstep(0.28, 0.78, nCrust.g));
  float faultMod = 0.55 + 0.45 * nFine.g;
  float faultHalo = smoothstep(0.14, 0.68, faultNet) * faultMod;
  float faultCore = smoothstep(0.48, 0.92, faultNet) * faultMod;
  float crackDrive = pow(max(magnetarCrackGlow, 1e-5), 1.35) * (0.65 + 0.35 * clamp(twistShear, 0.0, 2.5));

  // Relativistic frequency shift g = (p.u)_obs / (p.u)_emit (gravitational redshift + Doppler)
  float g = computeCrustFrequencyShift(posHit, f, pHit, pt, a, a2, betaEq);

  // Limb darkening + thin magnetized photosphere horizon sheen
  vec3 vRayDir = (dot(velHit, velHit) > 1e-10) ? normalize(velHit) : surfNormal;
  float muLimb = clamp(dot(surfNormal, -vRayDir), 0.0, 1.0);
  float limbDark = mix(0.30, 1.0, pow(max(muLimb, 1e-5), 0.58));
  float atmoRim = pow(max(1.0 - muLimb, 1e-5), 4.2) * 0.12;

  // Dark metallic iron-copper thermal crust so cracks & polar caps command dynamic range
  float T_crust = crustTempK * (0.52 + 0.56 * latThermal) * crustGran;
  vec3 crustCol = sampleBlackbody(mapPulsarTempToLut(T_crust * g));
  float crustLum = 0.38 * pow(clamp(T_crust / 1.4e6, 0.30, 3.2), 1.35);
  vec3 ironTint = vec3(0.055, 0.070, 0.115);
  vec3 crustEmit = mix(ironTint, crustCol * crustLum, clamp(0.35 + 0.65 * latThermal, 0.0, 1.0));

  // Glowing crimson-orange magma halos + golden-white fault fissure cores
  vec3 haloCol = vec3(1.00, 0.24, 0.03);
  vec3 coreCrackCol = mix(sampleBlackbody(mapPulsarTempToLut(max(crustTempK * 2.1, 3.2e6) * g)), vec3(1.00, 0.72, 0.20), 0.55);
  vec3 crackEmit = (haloCol * (faultHalo * 2.6) + coreCrackCol * (faultCore * 8.5)) * crackDrive;

  // Antipodal polar caps + sapphire-blue/white X-ray pair-cascade rim
  float T_cap = polarCapTempK * (0.78 + 0.42 * capInner + 0.18 * nFine.g);
  vec3 capCol = sampleBlackbody(mapPulsarTempToLut(T_cap * g));
  float capStr = (capCore * 0.85 + capInner * 1.25) * (0.80 + 0.35 * nFine.g);
  vec3 pairRimCol = mix(vec3(0.16, 0.60, 1.00), vec3(0.58, 0.90, 1.00), auroralMod);
  vec3 capEmit = capCol * (capStr * 16.5) + pairRimCol * (capRim * auroralMod * 9.5);

  // Relativistic bolometric intensity shift g^4 (with soft knee) & atmospheric limb
  float g2 = g * g;
  float g4 = g2 * g2;
  float relFlux = g4 / (1.0 + 0.08 * g4);

  vec3 totalSurf = (crustEmit + crackEmit + capEmit) * limbDark * relFlux
                 + vec3(0.30, 0.70, 1.00) * (atmoRim * g * (0.7 + 0.5 * crackDrive));
  return max(totalSurf, vec3(0.0));
}

// ============================================================================
// 4. VOLUMETRIC MAGNETOSPHERE, LIGHTHOUSE BEAMS, PWN TORUS & POLAR JETS
// ============================================================================

struct VolAccum {
  vec3  emission;
  float extinction;
};

VolAccum evalPulsarVolume(
  vec3 pos,
  vec3 vel,
  float r,
  float simTime,
  float betaEq,
  float spinPhase,
  vec3 mu0,
  vec3 em1_0,
  vec3 em2_0,
  float twistShear,
  float rLightCylVis,
  float plasmaDensity,
  float beamIntensity,
  float beamConeHalfAngle,
  float cosMaxCone,
  float pwnVisibility,
  float pwnJetPower,
  float spinVisualSpeed,
  float camDistFade
) {
  VolAccum va;
  va.emission = vec3(0.0);
  va.extinction = 0.0;

  if (r <= 1.025) return va;

  bool needMag  = (plasmaDensity > 0.001 && r < rLightCylVis * 1.18);
  bool needBeam = (beamIntensity > 0.001 && r < 18.0);

  if (needMag || needBeam) {
    // Deutsch electromagnetic retardation lag delta_phi = -(r - 1) / R_LC
    float deltaPhi = -(max(r - 1.0, 0.0) / max(rLightCylVis, 1.5)) * (0.85 + 0.55 * betaEq);
    float phaseRet = spinPhase + deltaPhi;
    vec3 pRot = rotateY(pos, -phaseRet);

    float zM = dot(pRot, mu0);
    float xM = dot(pRot, em1_0);
    float yM = dot(pRot, em2_0);
    float rhoM2 = xM * xM + yM * yM;
    float r2M = max(dot(pRot, pRot), 1e-6);
    float rM = sqrt(r2M);
    float sin2Theta = max(rhoM2 / r2M, 1e-5);
    float cosThetaM = zM / max(rM, 1e-5);
    float L = rM / sin2Theta;

    // 4A. Closed Twisted Dipole Magnetosphere (1.04 < L <= rLightCylVis)
    if (needMag && L > 1.04 && L < rLightCylVis * 1.14) {
      float phiM = (rhoM2 > 1e-10) ? atan(yM, xM) : 0.0;
      float phiTwist = phiM - twistShear * cosThetaM * (1.0 - 1.0 / max(L, 1.0)) * 2.2;
      float logL = log(max(L, 1.01));

      float flowMag = simTime * (0.35 + 0.45 * spinVisualSpeed);
      vec3 qMag = vec3(
        cos(phiTwist) * (0.42 + 0.14 * logL),
        sin(phiTwist) * (0.42 + 0.14 * logL),
        cosThetaM * 1.35 - flowMag
      );
      vec4 nMag = textureLod(uVolumeNoise, qMag, 0.0);

      float tA0 = clamp(0.5 + 0.5 * cos(7.0 * phiTwist + 1.6 * nMag.r), 0.0, 1.0);
      float tA2 = tA0 * tA0;
      float tubeA = tA2 * tA2 * tA2;
      float tB0 = clamp(0.5 + 0.5 * cos(13.0 * phiTwist - 2.2 * logL + 2.0 * nMag.b), 0.0, 1.0);
      float tB2 = tB0 * tB0;
      float tubeB = tB2 * tB2 * tB0;
      float sB0 = max(0.5 + 0.5 * sin(logL * 10.5 + 1.8 * nMag.r), 1e-5);
      float shellBands = sB0 * sB0 * sB0 * sqrt(sB0);
      float sepDist = (L - rLightCylVis * 0.88) / max(rLightCylVis * 0.14, 0.40);
      float sepEnv = exp(-min(sepDist * sepDist * 2.2, 40.0));

      float lEnv = smoothstep(1.04, 1.25, L) * (1.0 - smoothstep(rLightCylVis * 0.86, rLightCylVis * 1.12, L));
      float rFade = smoothstep(1.03, 1.16, rM) / (1.0 + 0.42 * pow(max(rM - 1.0, 1e-5), 1.65));
      float tubeStruct = (1.55 * tubeA * shellBands + 0.65 * tubeB * shellBands + 0.85 * sepEnv * (0.35 + 0.65 * tubeA))
                       * (0.28 + 1.10 * nMag.g * nMag.g + 0.40 * nMag.a);
      float magDens = lEnv * rFade * tubeStruct * plasmaDensity * camDistFade;

      vec3 cCyan   = vec3(0.10, 0.58, 1.00);
      vec3 cViolet = vec3(0.42, 0.16, 1.00);
      vec3 cIce    = vec3(0.66, 0.92, 1.00);
      vec3 magCol = mix(cViolet, cCyan, smoothstep(rLightCylVis, 1.4, L));
      magCol = mix(magCol, cIce, clamp(tubeA * shellBands * 0.72 + sepEnv * 0.35, 0.0, 1.0));

      float twistFactor = smoothstep(0.55, 1.85, twistShear);
      if (twistFactor > 0.001) {
        float twistCore = pow(clamp(tubeA * (0.5 + 0.5 * nMag.g) + sepEnv * 0.35, 1e-5, 1.0), 1.35);
        vec3 twistGold = mix(vec3(1.00, 0.52, 0.08), vec3(1.00, 0.86, 0.42), twistCore);
        magCol = mix(magCol, twistGold, twistFactor * clamp(0.40 + 0.60 * twistCore, 0.0, 1.0));
      }

      va.emission += magCol * (magDens * 0.12);
      va.extinction += magDens * 0.025;
    }

    // 4B. Sweeping Lighthouse Synchrotron / Curvature Beams around +-muHat
    if (needBeam) {
      float absCosB = abs(cosThetaM);
      if (absCosB > cosMaxCone) {
        float sinB = sqrt(max(1.0 - absCosB * absCosB, 0.0));
        float thetaB = atan(sinB, absCosB);
        float thetaCone = beamConeHalfAngle * mix(0.58, 1.04, smoothstep(1.0, 4.2, rM));
        float coneW = max(thetaCone * 0.24, 0.038);
        float coreW = max(thetaCone * 0.26, 0.042);

        if (thetaB < thetaCone + 3.2 * coneW) {
          float cd = (thetaB - thetaCone) / coneW;
          float hollowCone = exp(-min(cd * cd, 40.0));
          float kd = thetaB / coreW;
          float coreBeam = exp(-min(kd * kd, 40.0)) * 0.90;

          float radialOnset = smoothstep(1.04, 1.38, rM)
                            * (1.0 - smoothstep(10.0, 18.0, rM))
                            / (1.0 + 0.25 * rM * rM);

          float phiB = (rhoM2 > 1e-10) ? atan(yM, xM) : 0.0;
          float flowOut = rM * 0.24 - simTime * (0.85 + 1.15 * spinVisualSpeed);
          vec3 qBeam = vec3(cos(phiB) * 0.55, sin(phiB) * 0.55, flowOut);
          vec4 nBeam = textureLod(uVolumeNoise, qBeam, 0.0);
          float streakCos = clamp(0.5 + 0.5 * cos(6.0 * phiB + rM * 0.45 - simTime * 2.4), 0.0, 1.0);
          float subPulses = (0.28 + 0.92 * nBeam.g * nBeam.g) * (0.45 + 0.55 * streakCos * streakCos);

          // Relativistic forward beaming along outward retarded beam axis toward -vel
          float signMu = cosThetaM >= 0.0 ? 1.0 : -1.0;
          vec3 muRetLab = rotateY(signMu * mu0, phaseRet);
          vec3 rHatLab = pos / max(r, 1e-5);
          vec3 beamDir = normalize(mix(muRetLab, rHatLab, 0.42));
          vec3 toCamDir = (dot(vel, vel) > 1e-10) ? -normalize(vel) : -rHatLab;
          float cosForward = dot(beamDir, toCamDir);
          float dopplerBeam = 1.0 / max(1.0 - 0.54 * cosForward, 0.34);
          float beaming = pow(clamp(dopplerBeam, 0.45, 3.0), 1.55);

          vec3 beamCol = mix(vec3(0.42, 0.22, 1.00), vec3(0.16, 0.68, 1.00), clamp(hollowCone + coreBeam, 0.0, 1.0));
          beamCol = mix(beamCol, vec3(0.86, 0.95, 1.00), smoothstep(1.5, 3.6, beaming) * 0.80);

          float beamVal = beamIntensity * radialOnset * (hollowCone * 1.05 + coreBeam * 0.95)
                        * subPulses * beaming * camDistFade;
          va.emission += beamCol * (beamVal * 0.20);
          va.extinction += beamVal * 0.005;
        }
      }
    }
  }

  // 4C. Pulsar Wind Nebula (PWN) Equatorial Synchrotron Torus & Outward Shock Wisps (r in [2.6, 11.5])
  if (pwnVisibility > 0.001 && r > 2.15 && r < 11.8) {
    float hTorus = 0.15 + 0.068 * r;
    float absY = abs(pos.y);
    if (absY < hTorus * 2.8) {
      float yT = absY / max(hTorus, 1e-4);
      float vertTorus = exp(-min(yT * yT * 1.75, 40.0));
      float dr = (yT - 0.56) / 0.32;
      float doubleRing = 0.68 + 0.55 * exp(-min(dr * dr, 40.0));
      float radEnv = smoothstep(2.40, 3.30, r)
                   * (1.0 - smoothstep(7.8, 11.5, r))
                   / (1.0 + 0.065 * r * r);
      float ts = (r - 3.15) / 0.48;
      float termShock = exp(-min(ts * ts * 1.4, 40.0)) * 1.15;

      float rotAngle = 0.14 * simTime * (0.4 + spinVisualSpeed) - 0.22 * r;
      float cr = cos(rotAngle), sr = sin(rotAngle);
      vec2 rotXZ = vec2(cr * pos.x - sr * pos.z, sr * pos.x + cr * pos.z);
      vec4 nPwn  = textureLod(uVolumeNoise, vec3(rotXZ * 0.19, pos.y * 0.32), 0.0);

      float wispPhase = r * 2.35 - simTime * (0.55 + 0.75 * spinVisualSpeed) + (nPwn.r - 0.5) * 2.6;
      float wisps = pow(max(0.5 + 0.5 * sin(wispPhase), 1e-5), 4.5);
      float filaments = (0.18 + 1.35 * pow(max(nPwn.g, 1e-5), 1.8)) * (0.45 + 0.75 * nPwn.a);
      float torusDens = pwnVisibility * radEnv * vertTorus * doubleRing
                      * (0.14 * filaments + 1.25 * wisps * filaments + termShock * (0.45 + 0.85 * nPwn.g))
                      * camDistFade;

      vec3 torusCol = mix(vec3(0.36, 0.20, 0.92), vec3(0.12, 0.56, 1.00), smoothstep(10.2, 3.2, r));
      torusCol = mix(torusCol, vec3(0.60, 0.88, 1.00), clamp(wisps * 0.68 + termShock * 0.42, 0.0, 1.0));

      va.emission += torusCol * (torusDens * 0.09);
      va.extinction += torusDens * 0.018;
    }
  }

  // 4D. Helical Spin-Axis Polar Jets (+-Y)
  float jetAmp = pwnVisibility * pwnJetPower;
  if (jetAmp > 0.001) {
    float absY = abs(pos.y);
    if (absY >= 1.55 && absY <= 18.5) {
      float rho = length(pos.xz);
      float jetRadius = 0.18 + 0.082 * pow(absY, 0.72);
      if (rho < jetRadius * 2.3) {
        float uRad = rho / max(jetRadius, 1e-4);
        float spine = exp(-min(uRad * uRad * 5.2, 40.0));
        float sd = uRad - 0.75;
        float sheath = exp(-min(sd * sd * 10.5, 40.0)) * 0.85;
        float outerHalo = exp(-min(uRad * uRad * 1.4, 40.0)) * 0.14;
        float radProf = spine * 0.55 + sheath + outerHalo;

        float yEnv = smoothstep(1.55, 3.2, absY)
                   * (1.0 - smoothstep(10.0, 18.0, absY))
                   / (1.0 + 0.14 * absY);

        float signY = pos.y >= 0.0 ? 1.0 : -1.0;
        float helixAngle = signY * (absY * 0.82 - simTime * (0.65 + 1.35 * spinVisualSpeed));
        float ch = cos(helixAngle), sh = sin(helixAngle);
        vec2 rotXZ = vec2(ch * pos.x - sh * pos.z, sh * pos.x + ch * pos.z);

        float flowY = absY * 0.19 - simTime * (0.35 + 0.65 * spinVisualSpeed);
        vec4 jn = textureLod(uVolumeNoise, vec3(rotXZ * 0.48, flowY), 0.0);

        float rawFil = clamp(jn.y * 0.62 + jn.w * 0.52, 0.0, 1.0);
        float filaments = rawFil * rawFil * rawFil;
        float knots = 0.40 + 0.90 * pow(max(jn.z, 1e-5), 1.3);

        vec3 jetDir = vec3(0.0, signY, 0.0);
        vec3 toCamDir = (dot(vel, vel) > 1e-10) ? -normalize(vel) : -jetDir;
        float cosTheta = dot(jetDir, toCamDir);
        float dopplerJet = 1.0 / max(1.0 - 0.52 * cosTheta, 0.28);
        float jetBeam = pow(clamp(dopplerJet, 0.40, 2.4), 1.45);
        float viewColAtten = mix(1.0, 0.28, pow(max(abs(cosTheta), 1e-5), 1.55));

        vec3 coreCol   = vec3(0.60, 0.86, 1.00);
        vec3 sheathCol = vec3(0.18, 0.46, 1.00);
        vec3 outerCol  = vec3(0.44, 0.20, 1.00);
        vec3 jetCol = mix(sheathCol, coreCol, clamp(spine * 0.85 + filaments * 0.55, 0.0, 1.0));
        jetCol = mix(jetCol, outerCol, smoothstep(0.75, 1.85, uRad) * 0.68);

        float rawInt = jetAmp * radProf * yEnv * (0.16 + 1.55 * filaments) * knots
                     * jetBeam * viewColAtten * camDistFade;
        float intensity = rawInt / (1.0 + rawInt * 0.45);
        va.emission += jetCol * (intensity * 0.095);
      }
    }
  }

  return va;
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
  vec3 mu0   = vec3(sinObl, cosObl, 0.0);
  vec3 em1_0 = vec3(cosObl, -sinObl, 0.0);
  vec3 em2_0 = vec3(0.0, 0.0, -1.0);

  float maxThetaCone = beamConeHalfAngle * 1.04;
  float maxConeW = max(maxThetaCone * 0.24, 0.038);
  float maxBeamAngle = maxThetaCone + 3.2 * maxConeW;
  float cosMaxCone = (maxBeamAngle < 1.56) ? cos(maxBeamAngle) : -0.01;

  float volBoundR = 1.025;
  if (plasmaDensity > 0.001) volBoundR = max(volBoundR, rLightCylVis * 1.18);
  if (pwnVisibility > 0.001) volBoundR = max(volBoundR, 11.8);
  if (beamIntensity > 0.001) volBoundR = max(volBoundR, 18.0);
  if (pwnVisibility * pwnJetPower > 0.001) volBoundR = max(volBoundR, 19.2);

  CameraRayInit ray0 = initCameraRay(camPos, camRight, camUp, camFwd, localRay, M, a, a2, lensing);
  vec3 pos = camPos;
  vec3 p   = ray0.p;
  float pt = ray0.pt;

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(frameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int maxSteps = isProgressive ? 170 : 128;
  float qualScale = isProgressive ? 0.88 : 1.02;
  if (quality <= 0) {
    maxSteps = isProgressive ? 120 : 88;
    qualScale = isProgressive ? 1.18 : 1.32;
  } else if (quality >= 2) {
    maxSteps = isProgressive ? 250 : 190;
    qualScale = isProgressive ? 0.68 : 0.78;
  }

  float camR = length(camPos);
  float escapeR = max(20.0, camR * 1.35);

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float rayDist = 0.0;
  bool hitStar = false;
  bool escaped = false;
  vec3 finalVel = localRay;

  for (int step = 0; step < 250; ++step) {
    if (step >= maxSteps) break;

    GeodesicDeriv k1 = evalGeodesicRHS(pos, p, pt, M, a, a2, lensing);
    float r = k1.r;
    finalVel = k1.dpos;

    if (r <= 1.0) {
      vec3 surfRad = shadeNeutronStarSurface(
        pos, p, pt, k1.dpos, M, a, a2, lensing, betaEq, spinPhase,
        mu0, em1_0, em2_0, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
      );
      radiance += transmittance * surfRad;
      hitStar = true;
      break;
    }

    bool outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    // Adaptive step size: razor-tight near crust r=1.0, balanced in volume, fast once past volBoundR
    bool outsideVol = outbound && r > max(volBoundR, 12.5);
    float h = outsideVol
      ? clamp(0.32 * r * qualScale, 0.9, 4.8)
      : clamp(0.135 * (r - 0.55) * qualScale, 0.042 * qualScale, 0.78 * qualScale);

    if (r < 2.25) {
      h = min(h, (0.030 + 0.064 * max(r - 1.0, 0.0)) * qualScale);
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
    } else if (r >= 4.2) {
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

    float rNext = evalKerrR(posNext, a2);
    vec3 v0 = h * k1.dpos;
    vec3 v1 = h * velEnd;

    bool hitThisStep = false;
    float alphaHi = 1.0;
    if (rNext <= 1.0) {
      hitThisStep = true;
      alphaHi = 1.0;
    } else if (r < 1.18 && dot(pos, k1.dpos) < 0.0) {
      vec3 midH = evalHermite(pos, v0, posNext, v1, 0.5);
      if (evalKerrR(midH, a2) <= 1.0) {
        hitThisStep = true;
        alphaHi = 0.5;
      }
    }

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
      vec3 posHit = evalHermite(pos, v0, posNext, v1, alphaHit);
      vec3 pHit   = mix(p, pNext, alphaHit);
      vec3 velHit = mix(k1.dpos, velEnd, alphaHit);

      // Integrate foreground volume along [pos, posHit] prior to solid crust hit
      float segHit = length(posHit - pos);
      if (segHit > 1e-5) {
        float jF = fract(bn.y + float(step) * 0.61803399);
        vec3 samplePos = mix(pos, posHit, jF);
        float rSamp = evalKerrR(samplePos, a2);
        if (rSamp > 1.025 && rSamp < volBoundR) {
          float camDistFade = smoothstep(0.25, 1.75, rayDist + jF * segHit);

          VolAccum va = evalPulsarVolume(
            samplePos, velHit, rSamp, simTime, betaEq, spinPhase, mu0, em1_0, em2_0,
            twistShear, rLightCylVis, plasmaDensity, beamIntensity, beamConeHalfAngle,
            cosMaxCone, pwnVisibility, pwnJetPower, spinVisualSpeed, camDistFade
          );

          float tau = max(va.extinction, 0.0) * segHit;
          if (tau > 1e-5 || dot(va.emission, va.emission) > 1e-10) {
            float stepT = exp(-min(tau, 40.0));
            vec3 stepRad = (tau > 1e-4)
              ? va.emission * ((1.0 - stepT) / max(va.extinction, 1e-5))
              : va.emission * segHit;
            radiance += transmittance * stepRad;
            transmittance *= stepT;
          }
        }
      }

      vec3 surfRad = shadeNeutronStarSurface(
        posHit, pHit, pt, velHit, M, a, a2, lensing, betaEq, spinPhase,
        mu0, em1_0, em2_0, twistShear, rLightCylVis, polarCapTempK, crustTempK, magnetarCrackGlow
      );
      radiance += transmittance * surfRad;
      hitStar = true;
      break;
    }

    // Volumetric integration along curved geodesic segment [pos, posNext]
    float segLen = length(posNext - pos);
    float jFrac = fract(bn.y + float(step) * 0.61803399);
    vec3 samplePos = mix(pos, posNext, jFrac);
    float rSamp = evalKerrR(samplePos, a2);
    if (rSamp > 1.025 && rSamp < volBoundR) {
      vec3 sampleVel = mix(k1.dpos, velEnd, jFrac);
      float camDistFade = smoothstep(0.25, 1.75, rayDist + jFrac * segLen);

      VolAccum va = evalPulsarVolume(
        samplePos, sampleVel, rSamp, simTime, betaEq, spinPhase, mu0, em1_0, em2_0,
        twistShear, rLightCylVis, plasmaDensity, beamIntensity, beamConeHalfAngle,
        cosMaxCone, pwnVisibility, pwnJetPower, spinVisualSpeed, camDistFade
      );

      float tau = max(va.extinction, 0.0) * segLen;
      if (tau > 1e-5 || dot(va.emission, va.emission) > 1e-10) {
        float stepT = exp(-min(tau, 40.0));
        vec3 stepRad = (tau > 1e-4)
          ? va.emission * ((1.0 - stepT) / max(va.extinction, 1e-5))
          : va.emission * segLen;
        radiance += transmittance * stepRad;
        transmittance *= stepT;
      }
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;

    if (transmittance < 0.004) {
      break;
    }
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
  float escFlag = (escaped && !hitStar && transmittance > 0.004) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);
  vec3 safeSkyDir = (dot(finalVel, finalVel) > 1e-10) ? normalize(finalVel) : localRay;
  vec3 skyColor = sampleSkyBackground(safeSkyDir, skyIntensity, skyMode, skyRot, escFlag > 0.5, edgeMask);

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  }

  // Strict NaN/Inf guard and float16-safe HDR upper clamp
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
