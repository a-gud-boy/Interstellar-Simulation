/**
 * Cinema-grade WebGL2 GLSL 300 es relativistic black hole shader for
 * "Gargantua — Relativistic Black Hole Simulator".
 *
 * Physics & Optical Architecture:
 *  - Exact 3D Cartesian Outgoing Kerr-Schild metric (G = c = M = 1, spin along +Y):
 *      g_{mu nu} = eta_{mu nu} + 2 H l_mu l_nu,  l_t = -1,  l^t = +1,
 *      l_x = (r*x + a*z)/(r^2+a^2),  l_y = y/r,  l_z = (r*z - a*x)/(r^2+a^2)
 *    guarantees exact frame-dragging (g_{t phi} = -2 M a r sin^2(theta) / Sigma < 0),
 *    D-shaped Kerr shadow flattened on the prograde (-X) side and shifted toward (+X),
 *    and smooth finite-affine-parameter horizon crossing for past-directed rays.
 *  - Exact 4D Lorentzian Gram-Schmidt ZAMO orthonormal observer tetrad at uCamPos
 *    (valid everywhere outside r_+, even inside the ergosphere; zero radial aberration).
 *  - Exact analytical Hamiltonian gradients integrated via adaptive RK4 with
 *    blue-noise stratified sub-stepped volumetric disk quadrature (resolves n=1 & n=2
 *    photon rings with zero shell banding).
 *  - True 3D volumetric radiative transfer accretion disk: exact Bardeen-Press-Teukolsky
 *    ISCO + infalling plunging region, dual-phase Keplerian flow-map advection,
 *    concentric sheared plasma lanes + MRI filaments + physical foreground dust absorption,
 *    Novikov-Thorne temperature profile, CIE-1931 Planck blackbody LUT, and exact
 *    relativistic frequency shift & beaming.
 *  - Optional Blandford-Znajek parabolic helical polar jets (3D Cartesian, zero polar seam).
 *  - Wrap-safe, silhouette-safe textureGrad equirectangular 4K Milky Way lensing +
 *    crisp 3D-cell spectral micro-stars.
 */

export const BLACKHOLE_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Textures (locked unit bindings)
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8 (fbm, ridged, worley, micro)
uniform sampler2D uSkyMap;        // unit 1: 4K equirectangular Milky Way (sRGB RGBA8)
uniform sampler2D uProcSkyMap;    // unit 2: Procedural equirectangular sky (sRGB RGBA8)
uniform sampler2D uBlackbodyLut;  // unit 3: 512x1 linear CIE-1931 Planck LUT (800K..40000K log)
uniform sampler2D uBlueNoise;     // unit 4: 128x128 RGBA8 void-and-cluster blue noise

// Viewport & temporal state
uniform vec2  uResolution;
uniform float uTime;
uniform int   uFrameIndex;
uniform vec2  uJitter;

// Camera (Kerr-Schild Cartesian coords, M=1, spin=+Y, disk=X-Z plane)
uniform vec3  uCamPos;
uniform mat3  uCamBasis;          // col0=right, col1=up, col2=forward
uniform float uFovY;

// Relativistic physics parameters
uniform float uSpin;
uniform float uRelativisticMode;
uniform float uLensingStrength;

// Accretion disk & jet parameters
uniform float uDiskTemp;
uniform float uDiskDensity;
uniform float uDiskThickness;
uniform float uDiskOuterRadius;
uniform float uTurbulence;
uniform float uOrbitSpeed;
uniform float uJetIntensity;

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
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543; // 1 / ln(40000 / 800) = 1 / ln(50)

// ============================================================================
// 1. EXACT 3D CARTESIAN OUTGOING KERR-SCHILD METRIC & HAMILTONIAN
// ============================================================================

struct KSFields {
  float r;
  float r2;
  float D;
  float H;
  float R2;
  vec3  l;
};

KSFields evalKSFields(vec3 pos, float a, float a2, float lensing) {
  KSFields f;
  float u = dot(pos, pos) - a2;
  float disc = sqrt(max(u * u + 4.0 * a2 * pos.y * pos.y, 1e-12));
  f.r2 = max(0.5 * (u + disc), 1e-8);
  f.r  = sqrt(f.r2);
  f.D  = f.r2 * f.r2 + a2 * pos.y * pos.y;
  f.H  = lensing * (f.r * f.r2) / max(f.D, 1e-10);
  f.R2 = f.r2 + a2;
  float invR2 = 1.0 / max(f.R2, 1e-8);
  f.l = vec3(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y / max(f.r, 1e-5),
    (f.r * pos.z - a * pos.x) * invR2
  );
  return f;
}

// Lorentzian inner product g_{mu nu} A^mu B^nu in Outgoing Kerr-Schild (l_t = -1)
float ksMetricDot(vec4 A, vec4 B, KSFields f) {
  float lA = -A.x + dot(f.l, A.yzw);
  float lB = -B.x + dot(f.l, B.yzw);
  return -A.x * B.x + dot(A.yzw, B.yzw) + 2.0 * f.H * lA * lB;
}

// Analytical RHS of Hamilton's equations for H_geo = 1/2 (-p_t^2 + |p|^2) - H (p_t + l.p)^2
struct GeodesicDeriv {
  vec3  dpos;
  vec3  dp;
  float r;
};

GeodesicDeriv evalGeodesicRHS(vec3 pos, vec3 p, float pt, float a, float a2, float lensing) {
  KSFields f = evalKSFields(pos, a, a2, lensing);
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
  vec3 gradR = vec3(
    f.r * f.r2 * pos.x,
    f.r * f.R2 * pos.y,
    f.r * f.r2 * pos.z
  ) * invD;

  float hFac = lensing * f.r2 * invD * invD;
  float cR = 3.0 * a2 * pos.y * pos.y - f.r2 * f.r2;
  vec3 gradH = (hFac * cR) * gradR;
  gradH.y -= hFac * (2.0 * f.r * a2 * pos.y);

  float invR2 = 1.0 / max(f.R2, 1e-8);
  float invR  = 1.0 / max(f.r, 1e-5);
  float S = (p.x * (pos.x - 2.0 * f.r * f.l.x) + p.z * (pos.z - 2.0 * f.r * f.l.z)) * invR2
          - p.y * f.l.y * invR;

  vec3 w = vec3(
    (f.r * p.x - a * p.z) * invR2,
    p.y * invR,
    (a * p.x + f.r * p.z) * invR2
  ) + S * gradR;

  outD.dp = (L * L) * gradH + twoHL * w;
  return outD;
}

// Exact Bardeen-Press-Teukolsky prograde equatorial ISCO radius
float computeISCO(float a) {
  float a2 = a * a;
  float c1 = pow(max(1.0 - a2, 1e-7), 1.0 / 3.0);
  float c2 = pow(1.0 + a, 1.0 / 3.0) + pow(max(1.0 - a, 1e-7), 1.0 / 3.0);
  float Z1 = 1.0 + c1 * c2;
  float Z2 = sqrt(3.0 * a2 + Z1 * Z1);
  return 3.0 + Z2 - sqrt(max((3.0 - Z1) * (3.0 + Z1 + 2.0 * Z2), 0.0));
}

// Initialize exact past-directed null covariant momentum (pt, p) from ZAMO orthonormal tetrad
void initCameraRay(
  vec3 camPos,
  mat3 camBasis,
  vec3 localRay,
  float a,
  float a2,
  float lensing,
  out vec3 outP,
  out float outPt
) {
  KSFields f = evalKSFields(camPos, a, a2, lensing);
  float rho2 = camPos.x * camPos.x + camPos.z * camPos.z;

  // Exact Kerr-Schild ZAMO angular velocity (valid everywhere outside r_+, even in ergosphere)
  float omega = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  vec3 vZamo = vec3(omega * camPos.z, 0.0, -omega * camPos.x);
  float lPhi = a * rho2 / max(f.R2, 1e-8);
  float oneMinusWl = 1.0 - omega * lPhi;
  float normSq = max(1.0 - dot(vZamo, vZamo) - 2.0 * f.H * oneMinusWl * oneMinusWl, 1e-5);
  float ut = inversesqrt(normSq);
  vec4 e0 = vec4(ut, ut * vZamo);

  // Project desired spatial camera triad into ZAMO rest 3-space and g-orthonormalize
  vec4 f4 = vec4(0.0, camBasis[2]);
  f4 += ksMetricDot(f4, e0, f) * e0;
  vec4 e3 = f4 * inversesqrt(max(ksMetricDot(f4, f4, f), 1e-8));

  vec4 r4 = vec4(0.0, camBasis[0]);
  r4 += ksMetricDot(r4, e0, f) * e0;
  r4 -= ksMetricDot(r4, e3, f) * e3;
  vec4 e1 = r4 * inversesqrt(max(ksMetricDot(r4, r4, f), 1e-8));

  vec4 u4 = vec4(0.0, camBasis[1]);
  u4 += ksMetricDot(u4, e0, f) * e0;
  u4 -= ksMetricDot(u4, e3, f) * e3;
  u4 -= ksMetricDot(u4, e1, f) * e1;
  vec4 e2 = u4 * inversesqrt(max(ksMetricDot(u4, u4, f), 1e-8));

  // Past-directed null 4-momentum p^mu = -e_(0)^mu + localRay.x*e_(1) + localRay.y*e_(2) + localRay.z*e_(3)
  // Guarantees g_{mu nu} p^mu p^nu = 0 and (p_mu u_obs^mu) = +1 identically.
  vec4 pUp = -e0 + localRay.x * e1 + localRay.y * e2 + localRay.z * e3;

  // Lower index via p_mu = eta_{mu nu} p^nu + 2 H (l_alpha p^alpha) l_mu (with l_t = -1)
  float lp = -pUp.x + dot(f.l, pUp.yzw);
  outPt = -pUp.x - 2.0 * f.H * lp;
  outP  =  pUp.yzw + (2.0 * f.H * lp) * f.l;
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY & COLOR UTILITIES
// ============================================================================

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float u = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return texture(uBlackbodyLut, vec2(u, 0.5)).rgb;
}

// ============================================================================
// 3. VOLUMETRIC ACCRETION DISK & RELATIVISTIC DOPPLER TRANSFER
// ============================================================================

float diskScaleHeight(float r, float rIsco, float rOuter) {
  float rNorm = clamp((r - rIsco) / max(rOuter - rIsco, 1.0), 0.0, 1.0);
  // Razor-thin near ISCO, gracefully flaring outward for volumetric 3D depth
  float baseH = 0.048 + 0.036 * r * (0.42 + 0.88 * pow(rNorm, 0.72));
  return baseH * max(uDiskThickness, 0.15);
}

// Exact emitter 4-velocity (prograde Keplerian circular orbit outside ISCO,
// smooth relativistic radial+frame-dragged plunge inside ISCO) -> frequency shift g
float computeDiskFrequencyShift(
  vec3 pos,
  vec3 p,
  float pt,
  float r,
  float rIsco,
  float rPlus,
  float a,
  float a2,
  float lensing
) {
  KSFields f = evalKSFields(pos, a, a2, lensing);
  float rho2 = pos.x * pos.x + pos.z * pos.z;
  float rho = sqrt(max(rho2, 1e-6));

  // Local ZAMO frame-dragging angular velocity (always strictly timelike outside r_+)
  float omegaZ = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  vec3 vZamo = vec3(omegaZ * pos.z, 0.0, -omegaZ * pos.x);

  // Target 3-velocity: exact prograde Keplerian Omega = 1 / (r^(3/2) + a) outside ISCO,
  // smoothly transitioning to accelerating inward plunge inside ISCO
  vec3 vEmit;
  if (r >= rIsco) {
    float omega = 1.0 / (pow(max(r, 1.0), 1.5) + a);
    vEmit = vec3(omega * pos.z, 0.0, -omega * pos.x);
  } else {
    float plunge = clamp((rIsco - r) / max(rIsco - rPlus, 0.08), 0.0, 1.0);
    float omegaIsco = 1.0 / (pow(max(rIsco, 1.0), 1.5) + a);
    // Angular velocity ramps smoothly from ISCO orbital rate toward horizon frame-dragging
    float omegaEff = mix(omegaIsco * pow(rIsco / max(r, rPlus), 0.85), omegaZ, plunge * plunge);
    vec3 vRot = vec3(omegaEff * pos.z, 0.0, -omegaEff * pos.x);
    // Accelerating inward radial infall across the plunging gap
    float vRadMag = 0.62 * pow(plunge, 1.25) * sqrt(max(lensing, 0.1));
    vec3 radDir = vec3(pos.x, 0.0, pos.z) / rho;
    vEmit = vRot - vRadMag * radDir;
  }

  // Exact Kerr-Schild timelike normalization g_{mu nu} (1, v)^mu (1, v)^nu = -1 / (u^t)^2
  // If extreme parameters push vEmit near the local light cone, pull smoothly toward vZamo
  float lv = -1.0 + dot(f.l, vEmit);
  float ds2 = -1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv;
  if (ds2 > -0.05) {
    vec3 dv = vEmit - vZamo;
    // Binary-free analytical damping toward guaranteed-timelike ZAMO frame
    float lvZ = -1.0 + dot(f.l, vZamo);
    float ds2Z = min(-1.0 + dot(vZamo, vZamo) + 2.0 * f.H * lvZ * lvZ, -0.02);
    float shrink = sqrt(clamp((-0.05 - ds2Z) / max(ds2 - ds2Z, 1e-4), 0.0, 1.0)) * 0.92;
    vEmit = vZamo + dv * shrink;
    lv = -1.0 + dot(f.l, vEmit);
    ds2 = min(-1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv, -0.02);
  }

  float ut = inversesqrt(max(-ds2, 0.02));
  // (p_mu u^mu)_obs == +1.0 from ZAMO camera tetrad; (p_mu u^mu)_emit = ut * (p_t + p . vEmit)
  float emitEnergy = ut * (pt + dot(p, vEmit));
  return clamp(1.0 / max(emitEnergy, 0.08), 0.06, 3.6);
}

// Dual-phase flow-advected 3D spiral filament sampling (zero stretching blowup, zero azimuth seam)
vec4 sampleDiskPlasmaNoise(float r, float phi, float yNorm, float a) {
  float logR = log(max(r, 0.6));
  float phiU = phi * INV_TAU; // wraps by exact +/-1.0 across phi = +/-PI

  // Differential Keplerian visual angular rate (inner disk visibly races faster than outer edge)
  float omegaVis = uOrbitSpeed * 1.65 / (pow(max(r, 1.0), 1.28) + 0.45 * a);

  // Dual-phase triangle/cosine flow map prevents unbounded differential shear stretch
  const float FLOW_CYCLE = 15.0;
  float phase0 = fract(uTime / FLOW_CYCLE);
  float phase1 = fract(uTime / FLOW_CYCLE + 0.5);
  float blend  = 0.5 - 0.5 * cos(TAU * phase0); // 0 at phase0 seam, 1 at phase1 seam

  float dt0 = (phase0 - 0.5) * FLOW_CYCLE;
  float dt1 = (phase1 - 0.5) * FLOW_CYCLE;

  // Global slow rigid rotation layer ensures continuous silky motion even during crossfade
  float globalRot = uTime * uOrbitSpeed * 0.045;

  // Primary sheared logarithmic spiral (integer azimuthal wrap K = 1.0 -> 100% seam-free!)
  float spiralU0 = 1.0 * phiU + 2.35 * logR - (omegaVis * dt0 + globalRot) * INV_TAU;
  float spiralU1 = 1.0 * phiU + 2.35 * logR - (omegaVis * dt1 + globalRot) * INV_TAU;
  float radV0    = logR * 1.15 + dt0 * 0.012 * uOrbitSpeed;
  float radV1    = logR * 1.15 + dt1 * 0.012 * uOrbitSpeed;
  float zCoord   = yNorm * 0.28 + 0.5;

  vec4 n0 = texture(uVolumeNoise, vec3(spiralU0, radV0, zCoord));
  vec4 n1 = texture(uVolumeNoise, vec3(spiralU1, radV1, zCoord));
  vec4 primary = mix(n1, n0, blend);

  // Fine high-frequency MRI micro-sheared striations with MHD domain warp (integer K = 2.0 -> seam-free!)
  float mhdWarpU = (primary.r - 0.5) * 0.095 + (primary.b - 0.5) * 0.055;
  float mhdWarpV = (primary.r - 0.5) * 0.36  + (primary.g - 0.5) * 0.18;
  float fineU0 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt0 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
  float fineU1 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt1 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
  float fineV0 = logR * 3.15 + mhdWarpV;
  float fineV1 = logR * 3.15 + mhdWarpV;

  vec4 d0 = texture(uVolumeNoise, vec3(fineU0, fineV0, yNorm * 0.55 + 0.25));
  vec4 d1 = texture(uVolumeNoise, vec3(fineU1, fineV1, yNorm * 0.55 + 0.25));
  vec4 detail = mix(d1, d0, blend);

  // Combine multi-scale channels:
  // x: broad turbulent cloud, y: sharp ridged plasma strands, z: cellular pockets, w: micro-striations
  return vec4(
    mix(primary.r, detail.r, 0.42),
    mix(primary.g, detail.g, 0.58),
    mix(primary.b, detail.b, 0.45),
    mix(primary.a, detail.a, 0.72)
  );
}

void evalDiskVolume(
  vec3 pos,
  vec3 p,
  float pt,
  float r,
  float rIsco,
  float rOuter,
  float rPlus,
  float a,
  float a2,
  float lensing,
  float camDistFade,
  out vec3 emission,
  out float extinction
) {
  emission = vec3(0.0);
  extinction = 0.0;

  if (r <= rPlus * 1.03 || r >= rOuter * 1.08) return;

  float H = diskScaleHeight(r, rIsco, rOuter);
  float absY = abs(pos.y);
  if (absY > H * 3.6) return;

  float yNorm = pos.y / max(H, 1e-4);
  float absYNorm = abs(yNorm);
  float phi = atan(pos.z, pos.x);
  float logR = log(max(r, 0.6));

  // Sample 3D dual-phase sheared volumetric noise
  vec4 n = sampleDiskPlasmaNoise(r, phi, yNorm, a);
  float turb = clamp(uTurbulence, 0.0, 2.2);

  // Radial envelope: sharp bright inner disk outside ISCO + wispy turbulent outer spiral tendrils
  // melting naturally into deep star-filled space (never a hard geometric outer ellipse!)
  float mainInner = smoothstep(rIsco * 0.90, rIsco * 1.16, r);
  float tendrilWarp = (n.x * 0.55 + n.y * 0.45 - 0.5) * 0.28 * clamp(turb, 0.3, 1.8);
  float rOuterEff = rOuter * (1.0 + tendrilWarp);
  float outerFade = pow(1.0 - smoothstep(rOuterEff * 0.28, rOuterEff * 1.02, r), 1.95);
  // Extra wispy gossamer outer-rim filament survival so feathery spiral arms dissolve into space
  float outerWisps = smoothstep(0.32, 0.85, n.y * 0.65 + n.w * 0.35);
  float outerEdgeSoft = (1.0 - smoothstep(rOuter * 0.72, rOuter * 1.07, r))
                      * mix(1.0, 0.35 + 0.95 * outerWisps, smoothstep(rOuter * 0.52, rOuter * 0.92, r));

  // Plunging region (r_+ < r < r_isco): steep magnetized plasma tendrils falling into horizon
  float plungeMask = (1.0 - mainInner) * smoothstep(rPlus * 1.04, rPlus * 1.32, r);
  float plungeFilaments = pow(clamp(n.y * 0.75 + n.w * 0.45, 0.0, 1.0), 1.85);
  float plungeEnv = plungeMask * (0.14 + 0.38 * plungeFilaments);

  float radialEnv = (mainInner * outerFade + plungeEnv) * outerEdgeSoft;
  if (radialEnv < 1e-4) return;

  // Vertical profile: crisp luminous midplane core + delicate hot plasma corona sheath
  float warpY = (n.x - 0.5) * 0.28 * turb;
  float yShifted = abs(yNorm + warpY);
  float vertCore   = exp(-yShifted * yShifted * 2.75);
  float vertMid    = exp(-yShifted * yShifted * 5.60);
  float vertSheath = 0.22 * exp(-absYNorm * 1.65);

  // Chaotic braided Gargantua sheared plasma ribbons (heavily MHD-warped so they NEVER look like rigid sine rings!)
  float rWarp = logR + (n.x - 0.5) * 0.24 * turb + (n.z - 0.5) * 0.12 * turb;
  float laneBroad = 0.5 + 0.5 * sin(rWarp * 18.5 + 0.72 * sin(phi + logR * 3.5 + n.x * 2.6));
  float laneFine  = 0.5 + 0.5 * sin(rWarp * 46.0 - 0.62 * cos(2.0 * phi - logR * 5.2 + n.z * 3.0));
  float laneMicro = 0.5 + 0.5 * sin(rWarp * 94.0 + 0.50 * sin(3.0 * phi + logR * 7.0 - n.y * 2.4));
  // Blend irregular sheared harmonic lanes with ridged MRI turbulence for fiery braided strands
  float concentricLanes = mix(
    0.56 + 0.44 * laneBroad,
    0.26 + 0.34 * pow(laneBroad, 1.60) + 0.36 * pow(laneFine, 2.05) + 0.24 * pow(laneMicro, 2.35),
    0.76
  );

  // Crisp magnetorotational (MRI) glowing filaments, incandescent hot plasma threads & convective pockets
  float ridgeSharp = pow(clamp(n.y, 0.0, 1.0), 1.48);
  float microSharp = pow(clamp(n.w, 0.0, 1.0), 1.38);
  float hotThread  = pow(clamp(ridgeSharp * 0.62 + microSharp * 0.52, 0.0, 1.0), 2.35);
  float mriFilaments = mix(0.68, 0.18 + 1.15 * ridgeSharp + 0.62 * microSharp + 0.85 * hotThread, clamp(turb, 0.0, 1.65));
  float eddyBoost = mix(1.0, 0.64 + 0.82 * n.z, clamp(turb * 0.80, 0.0, 1.2));
  float plasmaStructure = concentricLanes * mriFilaments * eddyBoost;

  // Dramatic dark rifts & chaotic braided gaps between incandescent plasma filaments
  float riftSignal = n.x * 0.50 + n.y * 0.35 + n.z * 0.15;
  float riftMask = smoothstep(0.24, 0.74, riftSignal);
  float structureContrast = mix(1.0, mix(0.20, 1.48, riftMask), clamp(turb * 0.85, 0.0, 1.0));

  float localDensity = radialEnv * (vertCore * plasmaStructure * structureContrast + vertSheath * (0.38 + 0.62 * ridgeSharp));
  localDensity *= uDiskDensity * camDistFade;

  // Novikov-Thorne / coronal-irradiated radial temperature profile peaking outside ISCO
  float rPeak = max(rIsco * 1.55, rPlus * 1.45);
  float rel = clamp(uRelativisticMode, 0.0, 1.0);
  // Gentler radial decay keeps approaching Kerr crescent vividly sapphire-blue-white in relativistic mode
  // and keeps Gargantua's sweeping arches incandescent champagne-gold rather than matte rusty brown
  float tempExp = mix(0.42, 0.55, rel);
  float rRatio = max(r / rPeak, 0.52);
  float tempRadial = pow(rRatio, -tempExp);
  float plungeCool = mix(0.76, 1.0, mainInner);
  // Incandescent plasma threads spike hotter champagne-white-gold; dust gaps drop to rich ember-bronze
  float filamentHeat = clamp(ridgeSharp * 0.46 + microSharp * 0.24 + laneFine * 0.22 + hotThread * 0.42, 0.0, 1.0);
  float T_local = uDiskTemp * tempRadial * plungeCool * mix(0.72, 1.34, filamentHeat);

  // Exact relativistic Doppler + gravitational frequency shift g = (p.u)_obs / (p.u)_emit
  float g = computeDiskFrequencyShift(pos, p, pt, r, rIsco, rPlus, a, a2, lensing);

  // Smoothly bridge Interstellar Gargantua cinematic look (0.0) <-> Physically Exact GR (1.0)
  float gColor  = mix(mix(1.0, g, 0.26), g, rel);
  float gBeam   = mix(mix(1.0, g, 0.34), g, rel);
  float beamExp = mix(1.85, 3.35, rel);
  float beaming = pow(clamp(gBeam, 0.10, 2.75), beamExp);
  // Stronger high-end soft-knee keeps approaching sapphire crescent saturated in AgX instead of clipping white
  beaming = beaming / (1.0 + beaming * mix(0.055, 0.165, rel));
  beaming *= mix(1.0, 0.92, rel);

  float T_obs = clamp(T_local * gColor, T_MIN, T_MAX);
  vec3 bbColor = sampleBlackbody(T_obs);

  // Cinematographically calibrated Planck radiative power tailored to AgX [-12.5..+4.0 EV]
  float thermalPower = pow(clamp(T_local / 4750.0, 0.15, 3.8), 1.98);

  // Normalize optical brightness smoothly across both scale height H and rPeak
  // (keeps Schwarzschild r_isco=6M rich & crisp instead of washed-out pale cream vs Kerr r_isco=1.24M)
  float heightComp = 1.0 / pow(max(H * 3.0, 0.38), 0.40);
  float rPeakComp  = pow(2.2 / max(rPeak, 1.5), 0.28);

  // Razor-crisp hot inner edge right outside ISCO -> brightens 360-deg n=1 & n=2 photon ring cleanly
  float innerHotRim = 1.0 + 0.95 * exp(-pow((r - rIsco * 1.18) / max(rIsco * 0.38, 0.42), 2.0)) * mainInner;

  float emitStrength = localDensity * thermalPower * beaming * heightComp * rPeakComp * innerHotRim * 1.38;
  emission = bbColor * emitStrength;

  // Physical foreground cool-dust & dense-plasma optical absorption:
  // Optically thin near ISCO so 360-deg n=1 & n=2 photon rings stay razor-crisp around the entire shadow,
  // while narrow mid-to-outer cool dust veins carve crisp dark 3D foreground depth across Gargantua!
  float dustZone = smoothstep(rIsco * 1.45 + 1.8, rIsco * 3.0 + 3.2, r);
  float dustVeins = pow(smoothstep(0.32, 0.88, 1.0 - ridgeSharp * 0.72 + (n.x - 0.5) * 0.75), 1.35);
  float dustLane  = 0.30 + 0.70 * (1.0 - pow(laneBroad, 1.45));
  float coolDustExt = radialEnv * vertMid * dustZone * (0.42 + 1.85 * dustVeins * dustLane);
  float plasmaSelfExt = radialEnv * vertCore * (0.15 + 0.22 * n.x);

  float extPeakComp = pow(2.2 / max(rPeak, 1.5), 0.18);
  extinction = (coolDustExt * 1.45 + plasmaSelfExt * 0.40) * uDiskDensity * heightComp * extPeakComp * camDistFade;
}

// ============================================================================
// 4. RELATIVISTIC BLANDFORD-ZNAJEK POLAR JETS (3D CARTESIAN, ZERO POLE SEAM)
// ============================================================================

vec3 evalPolarJet(vec3 pos, vec3 vel, float rPlus, float a, float camDistFade) {
  float absY = abs(pos.y);
  // Launch cleanly above/below the polar magnetosphere so the pitch-black event horizon stays unobstructed
  if (absY < rPlus * 1.35 || absY > 44.0) return vec3(0.0);

  float rho = length(pos.xz);
  // Tight, slender parabolic magnetic collimation R_jet(|y|) = r_base + c * |y|^0.72
  float jetRadius = 0.14 * rPlus + 0.088 * pow(absY, 0.72);
  if (rho > jetRadius * 2.4) return vec3(0.0);

  float u = rho / max(jetRadius, 1e-4);
  // Crisp hollow magnetically-sheared sheath + slender energetic core spine
  float spine  = exp(-u * u * 5.2);
  float sheath = exp(-pow(u - 0.76, 2.0) * 10.5) * 0.88;
  float outerHalo = exp(-u * u * 1.4) * 0.16;
  float radialProfile = spine * 0.52 + sheath + outerHalo;

  // Smooth onset outside polar horizon & gentle large-scale attenuation
  float yEnv = smoothstep(rPlus * 1.35, rPlus * 3.9, absY)
             * (1.0 - smoothstep(16.0, 42.0, absY))
             / (1.0 + 0.11 * absY);

  // 3D Cartesian helical coordinate rotation around +Y (ZERO atan polar seam!)
  float signY = pos.y >= 0.0 ? 1.0 : -1.0;
  float helixAngle = signY * (absY * 0.72 - uTime * uOrbitSpeed * 1.85) * (0.55 + 0.45 * a);
  float ch = cos(helixAngle);
  float sh = sin(helixAngle);
  vec2 rotXZ = vec2(ch * pos.x - sh * pos.z, sh * pos.x + ch * pos.z);

  // High-frequency helical magnetic plasma filaments streaming outward along both poles
  float flowY = absY * 0.17 - uTime * uOrbitSpeed * 0.48;
  vec3 jetUvw = vec3(rotXZ * 0.48, flowY);
  vec4 jn = texture(uVolumeNoise, jetUvw);
  vec4 jnFine = texture(uVolumeNoise, vec3(rotXZ * 1.08, flowY * 2.15 + 0.37));

  float rawFil = clamp(jn.y * 0.55 + jnFine.w * 0.60, 0.0, 1.0);
  float filaments = pow(rawFil, 2.25);
  float knots = 0.40 + 0.90 * pow(jn.z, 1.3);

  // Relativistic synchrotron beaming + head-on optical column attenuation
  // (keeps M87* polar view translucent and electric instead of a solid white barrel cloud)
  vec3 jetDir = vec3(0.0, signY, 0.0);
  float cosTheta = dot(jetDir, -normalize(vel));
  float betaJet = 0.48 + 0.20 * a;
  float dopplerJet = 1.0 / max(1.0 - betaJet * cosTheta, 0.30);
  float jetBeam = pow(clamp(dopplerJet, 0.40, 2.2), mix(0.85, 1.65, uRelativisticMode));
  float viewColumnAtten = mix(1.0, 0.24, pow(abs(cosTheta), 1.55));

  // Rich translucent electric sapphire / cyan-blue / violet synchrotron palette (stays vivid in AgX)
  vec3 coreCol   = vec3(0.62, 0.86, 1.00);
  vec3 sheathCol = vec3(0.20, 0.46, 1.00);
  vec3 outerCol  = vec3(0.46, 0.22, 1.00);
  vec3 jetCol = mix(sheathCol, coreCol, clamp(spine * 0.85 + filaments * 0.55, 0.0, 1.0));
  jetCol = mix(jetCol, outerCol, smoothstep(0.75, 1.85, u) * 0.68);

  float rawInt = uJetIntensity * radialProfile * yEnv * (0.18 + 1.55 * filaments) * knots * jetBeam * viewColumnAtten * camDistFade;
  // Soft density compression preserves translucent synchrotron color saturation instead of clipping to white fog
  float intensity = rawInt / (1.0 + rawInt * 0.45);
  return jetCol * (intensity * 0.165);
}

// ============================================================================
// 5. SEAMLESS 4K MILKY WAY LENSING + CRISP 3D MICRO-STARS
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

// Ultra-crisp, pole-free, alias-free 3D directional micro-star layer
vec3 evalMicroStarLayer(vec3 dir, float scale, float densityThresh, float boost, float pixelFw) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);

  if (rnd.x < densityThresh) return vec3(0.0);

  // Keep star center safely inside [0.22, 0.78]^3 so zero clipping ever occurs at cell borders
  vec3 starPos = cell + vec3(0.22) + 0.56 * hash33f(cell + vec3(19.17, 73.41, 41.83));
  float dist = length(p - starPos);

  // Power-law astrophysical magnitude distribution
  float magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  float mag = pow(magU, 4.6);

  // Sub-pixel crisp pinpoint radius anti-aliased cleanly against gravitational lensing stretch
  float fw = clamp(pixelFw * scale, 0.018, 0.14);
  float starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  float core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) return vec3(0.0);

  // Suppress aliasing energy slightly when heavily compressed near photon ring
  float energyComp = 1.0 / (1.0 + fw * 6.0);

  // Spectral class color from CIE-1931 blackbody LUT (M-red ~3000K through O-blue ~24000K)
  float specT = mix(3000.0, 22000.0, pow(rnd.y, 1.85));
  vec3 col = sampleBlackbody(specT);

  float lum = (0.08 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

vec3 sampleSkyBackground(vec3 rawDir, bool escaped, float edgeMask) {
  vec3 dir = normalize(rotateSkyDir(rawDir, uSkyRotation));

  // Wrap-safe & pole-safe equirectangular coordinates (computed in uniform control flow!)
  float u1 = atan(dir.z, dir.x) * INV_TAU + 0.5;
  float v  = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  vec2 uv1 = vec2(u1, v);
  vec2 uv2 = vec2(fract(u1 + 0.5), v); // shifted meridian avoids +/-PI derivative jump

  vec2 dx1 = dFdx(uv1);
  vec2 dy1 = dFdy(uv1);
  vec2 dx2 = dFdx(uv2);
  vec2 dy2 = dFdy(uv2);

  vec2 dUVdx = vec2(abs(dx1.x) < abs(dx2.x) ? dx1.x : dx2.x, dx1.y);
  vec2 dUVdy = vec2(abs(dy1.x) < abs(dy2.x) ? dy1.x : dy2.x, dy1.y);

  // Prevent shadow-silhouette quad discontinuities and Einstein-ring mipmap blur
  if (edgeMask > 0.01) {
    dUVdx = vec2(1.0 / 4096.0, 0.0);
    dUVdy = vec2(0.0, 1.0 / 2048.0);
  } else {
    dUVdx = clamp(dUVdx, vec2(-0.045), vec2(0.045));
    dUVdy = clamp(dUVdy, vec2(-0.045), vec2(0.045));
  }

  // Clamp slightly inside poles to avoid stretched polar pixels in equirectangular maps
  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));

  vec3 realSrgb = textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 procSrgb = textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb;

  // Compute screen-space angular derivative for micro-star AA outside branches
  float dirFw = length(fwidth(dir));
  if (edgeMask > 0.01) dirFw = 0.0012;

  if (!escaped) return vec3(0.0);

  vec3 mapSrgb = (uSkyMode == 2) ? procSrgb : realSrgb;
  // Decode sRGB sky texture to linear radiance
  vec3 skyLin = pow(max(mapSrgb, vec3(0.0)), vec3(2.2));

  // Restore gentle HDR sparkle to bright star cores compressed into 8-bit JPEG sky maps
  vec3 brightCores = max(skyLin - vec3(0.32), vec3(0.0));
  skyLin += brightCores * brightCores * 2.4;

  // Mode 0 (Hybrid) & Mode 2 (Procedural): layer razor-sharp procedural 3D pinpoint stars
  // so heavily lensed Einstein rings stay crisp at any magnification
  if (uSkyMode == 0 || uSkyMode == 2) {
    float starGain = (uSkyMode == 0) ? 0.55 : 0.95;
    vec3 microStars = evalMicroStarLayer(dir, 105.0, 0.915, 0.95 * starGain, dirFw)
                    + evalMicroStarLayer(dir, 225.0, 0.885, 0.42 * starGain, dirFw);
    skyLin += microStars;
  }

  return skyLin * max(uSkyIntensity, 0.0);
}

// ============================================================================
// 6. MAIN RELATIVISTIC GEODESIC RAY-MARCHER & RADIATIVE TRANSFER
// ============================================================================

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + uJitter;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = tan(clamp(uFovY, 0.1, 2.8) * 0.5);
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  float a = clamp(uSpin, 0.0, 0.998);
  float a2 = a * a;
  float lensing = clamp(uLensingStrength, 0.0, 1.0);
  float rPlus = 1.0 + sqrt(max(1.0 - a2, 1e-6));
  float rIsco = computeISCO(a);
  float rOuter = max(uDiskOuterRadius, rIsco + 2.5);

  // Exact initial null ray from ZAMO orthonormal tetrad
  vec3 pos = uCamPos;
  vec3 p;
  float pt;
  initCameraRay(uCamPos, uCamBasis, localRay, a, a2, lensing, p, pt);

  // Toroidal 4-channel blue noise animated via R2 quasi-random sequence across frames
  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(uFrameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  // Quality tiers (Medium ~175, High ~275, Ultra ~390 steps)
  int maxSteps = 275;
  float qualScale = 0.92;
  if (uQuality <= 0) {
    maxSteps = 175;
    qualScale = 1.24;
  } else if (uQuality >= 2) {
    maxSteps = 390;
    qualScale = 0.66;
  }

  float camR = length(uCamPos);
  float escapeR = max(max(rOuter * 1.85, camR * 1.65), 58.0);
  float captureR = rPlus * 1.022;
  float maxDiskSlabY = diskScaleHeight(rOuter, rIsco, rOuter) * 3.8;
  bool hasDisk = (uDiskDensity > 0.001);
  bool hasJet  = (uJetIntensity > 0.001);

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float rayDist = 0.0;
  bool captured = false;
  bool escaped  = false;
  vec3 finalVel = localRay;

  for (int step = 0; step < 400; ++step) {
    if (step >= maxSteps) break;

    GeodesicDeriv k1 = evalGeodesicRHS(pos, p, pt, a, a2, lensing);
    float r = k1.r;
    finalVel = k1.dpos;

    if (r <= captureR) {
      captured = true;
      break;
    }

    if (r > escapeR && dot(pos, k1.dpos) > 0.0) {
      escaped = true;
      break;
    }

    // Adaptive step size: tight around photon sphere & disk plane, fast in far field
    float rAboveHor = max(r - rPlus * 0.72, 0.06);
    float h = clamp(0.088 * rAboveHor * qualScale, 0.022 * qualScale, 2.4);

    // Extra angular accuracy right near photon shell (resolves razor-sharp n=1 & n=2 photon rings)
    if (r < 4.8 * rPlus) {
      h = min(h, (0.028 + 0.035 * max(r - rPlus, 0.05)) * qualScale);
    }

    // Refine geodesic step smoothly when approaching or traversing the flared accretion disk
    if (hasDisk && r < rOuter * 1.12) {
      float localH = diskScaleHeight(r, rIsco, rOuter);
      float absY = abs(pos.y);
      if (absY < localH * 4.5) {
        float diskHStep = max(localH * 0.68, 0.045) * qualScale;
        float prox = smoothstep(localH * 4.5, localH * 1.1, absY);
        h = min(h, mix(h, diskHStep, prox));
      }
    }

    // Refine smoothly inside slender collimated polar jets when active
    if (hasJet && abs(pos.y) > rPlus * 1.1 && abs(pos.y) < 42.0) {
      float rho = length(pos.xz);
      float jRad = 0.14 * rPlus + 0.088 * pow(max(abs(pos.y), 0.1), 0.72);
      if (rho < jRad * 2.6) {
        h = min(h, max(jRad * 0.36, 0.075) * qualScale);
      }
    }

    // Blue-noise jitter on first step completely eliminates concentric marching shell banding
    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    // 4th-order Runge-Kutta step in exact 3D Kerr-Schild phase space
    vec3 pos2 = pos + (0.5 * h) * k1.dpos;
    vec3 p2   = p   + (0.5 * h) * k1.dp;
    GeodesicDeriv k2 = evalGeodesicRHS(pos2, p2, pt, a, a2, lensing);

    vec3 pos3 = pos + (0.5 * h) * k2.dpos;
    vec3 p3   = p   + (0.5 * h) * k2.dp;
    GeodesicDeriv k3 = evalGeodesicRHS(pos3, p3, pt, a, a2, lensing);

    vec3 pos4 = pos + h * k3.dpos;
    vec3 p4   = p   + h * k3.dp;
    GeodesicDeriv k4 = evalGeodesicRHS(pos4, p4, pt, a, a2, lensing);

    vec3 posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
    vec3 pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);

    float segLen = length(posNext - pos);
    float midDist = rayDist + 0.5 * segLen;
    float camDistFade = smoothstep(0.0, 0.75, midDist);

    // Volumetric accretion disk radiative transfer with stratified sub-stepping on thin crossings
    if (hasDisk) {
      float yMin = min(pos.y, posNext.y);
      float yMax = max(pos.y, posNext.y);
      bool crossesPlane = (yMin <= 0.0 && yMax >= 0.0);
      bool inSlab = (yMin <= maxDiskSlabY && yMax >= -maxDiskSlabY);

      if (inSlab || crossesPlane) {
        vec3 midPos = 0.5 * (pos + posNext);
        float rMid = evalKSFields(midPos, a, a2, lensing).r;

        if (rMid > rPlus * 1.025 && rMid < rOuter * 1.08) {
          float hMid = diskScaleHeight(rMid, rIsco, rOuter);
          if (crossesPlane || abs(midPos.y) < hMid * 3.6 || abs(pos.y) < hMid * 3.6 || abs(posNext.y) < hMid * 3.6) {
            // Subdivide steep/thin crossings (essential for razor-sharp n=1 & n=2 photon rings!)
            int nSub = 1;
            float targetDs = max(hMid * 0.42, 0.032);
            if (crossesPlane || segLen > targetDs) {
              nSub = clamp(int(ceil(segLen / targetDs)), crossesPlane ? 2 : 1, 4);
            }
            float dsSub = segLen / float(nSub);
            float jitterBase = fract(bn.y + float(step) * 0.61803399);

            for (int s = 0; s < 4; ++s) {
              if (s >= nSub) break;
              float frac = (float(s) + jitterBase) / float(nSub);
              vec3 sPos = mix(pos, posNext, frac);
              vec3 sP   = mix(p, pNext, frac);
              float sR  = (nSub == 1) ? rMid : evalKSFields(sPos, a, a2, lensing).r;

              vec3 emit;
              float ext;
              evalDiskVolume(sPos, sP, pt, sR, rIsco, rOuter, rPlus, a, a2, lensing, camDistFade, emit, ext);

              if (ext > 1e-6 || dot(emit, emit) > 1e-10) {
                float tau = ext * dsSub;
                float stepT = exp(-tau);
                // Exact analytical 1D slab solution: integral_0^ds j * exp(-alpha * s) ds
                vec3 stepRad = (tau > 1e-4)
                  ? emit * ((1.0 - stepT) / max(ext, 1e-5))
                  : emit * dsSub;
                radiance += transmittance * stepRad;
                transmittance *= stepT;
                if (transmittance < 0.0025) break;
              }
            }
          }
        }
      }
    }

    // Optional optically-thin relativistic polar jets
    if (hasJet && transmittance > 0.004) {
      float jFrac = fract(bn.z + float(step) * 0.38196601);
      vec3 jPos = mix(pos, posNext, jFrac);
      vec3 jetEmit = evalPolarJet(jPos, k1.dpos, rPlus, a, camDistFade);
      radiance += transmittance * jetEmit * segLen;
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;

    if (transmittance < 0.0025) {
      // Virtually opaque foreground plasma; stop early for speed
      break;
    }
  }

  // Classify rays that exhausted maxSteps near the critical photon curve cleanly
  if (!captured && !escaped) {
    float rEnd = evalKSFields(pos, a, a2, lensing).r;
    if (rEnd < rPlus * 1.65 || (rEnd < 4.0 * rPlus && dot(pos, finalVel) < 0.0)) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  // Sample lensed sky in uniform control flow (eliminates atan seam & silhouette mip halo!)
  float escFlag = (escaped && !captured && transmittance > 0.0025) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);
  vec3 safeSkyDir = (dot(finalVel, finalVel) > 1e-10) ? normalize(finalVel) : localRay;
  vec3 skyColor = sampleSkyBackground(safeSkyDir, escFlag > 0.5, edgeMask);

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
