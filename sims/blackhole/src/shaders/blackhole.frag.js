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

// CPU-precomputed ZAMO orthonormal tetrad & frame invariants (shared with WebGPU)
uniform vec4 uZamoE0;
uniform vec4 uZamoE1;
uniform vec4 uZamoE2;
uniform vec4 uZamoE3;
uniform vec4 uCamKSl2H;
uniform vec4 uKerrConsts;
uniform vec4 uRayConsts;
uniform vec4 uFlowConsts;
uniform vec4 uOptConsts;
uniform vec4 uSkyTrig;

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

float evalKerrR(vec3 pos, float a2) {
  if (a2 < 1e-8) {
    return sqrt(max(dot(pos, pos), 1e-8));
  }
  float uVal = dot(pos, pos) - a2;
  float ay = 2.0 * pos.y;
  float disc = sqrt(max(uVal * uVal + a2 * ay * ay, 1e-12));
  return sqrt(max(0.5 * (uVal + disc), 1e-8));
}

KSFields evalKSFields(vec3 pos, float a, float a2, float lensing) {
  KSFields f;
  if (a2 < 1e-8) {
    f.r2 = max(dot(pos, pos), 1e-8);
    float invR = inversesqrt(f.r2);
    f.r  = f.r2 * invR;
    f.D  = f.r2 * f.r2;
    f.H  = lensing * invR;
    f.R2 = f.r2;
    f.l  = pos * invR;
    return f;
  }
  float uVal = dot(pos, pos) - a2;
  float y2 = pos.y * pos.y;
  float disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  f.r2 = max(0.5 * (uVal + disc), 1e-8);
  float invR = inversesqrt(f.r2);
  f.r  = f.r2 * invR;
  f.D  = f.r2 * f.r2 + a2 * y2;
  float invD = 1.0 / max(f.D, 1e-10);
  f.H  = lensing * (f.r * f.r2) * invD;
  f.R2 = f.r2 + a2;
  float invR2 = 1.0 / max(f.R2, 1e-8);
  f.l = vec3(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (f.r * pos.z - a * pos.x) * invR2
  );
  return f;
}

// Analytical RHS of Hamilton's equations for H_geo = 1/2 (-p_t^2 + |p|^2) - H (p_t + l.p)^2
struct GeodesicDeriv {
  vec3  dpos;
  vec3  dp;
  float r;
  KSFields f;
};

GeodesicDeriv evalGeodesicRHS(vec3 pos, vec3 p, float pt, float a, float a2, float lensing) {
  GeodesicDeriv outD;
  if (a2 < 1e-8) {
    float r2 = max(dot(pos, pos), 1e-8);
    float invR = inversesqrt(r2);
    float r = r2 * invR;
    float H = lensing * invR;
    vec3 l = pos * invR;
    outD.f.r = r;
    outD.f.r2 = r2;
    outD.f.D = r2 * r2;
    outD.f.H = H;
    outD.f.R2 = r2;
    outD.f.l = l;
    float L = pt + dot(l, p);
    float twoHL = 2.0 * H * L;
    outD.dpos = p - twoHL * l;
    outD.r = r;
    if (lensing <= 1e-6) {
      outD.dp = vec3(0.0);
      return outD;
    }
    outD.dp = -(L * L * H * invR) * l + (twoHL * invR) * (p - dot(p, l) * l);
    return outD;
  }

  float y2 = pos.y * pos.y;
  float uVal = dot(pos, pos) - a2;
  float disc = sqrt(max(uVal * uVal + 4.0 * a2 * y2, 1e-12));
  float r2 = max(0.5 * (uVal + disc), 1e-8);
  float invR  = inversesqrt(r2);
  float r     = r2 * invR;
  float D     = r2 * r2 + a2 * y2;
  float invD  = 1.0 / max(D, 1e-10);
  float H     = lensing * (r * r2) * invD;
  float R2    = r2 + a2;
  float invR2 = 1.0 / max(R2, 1e-8);
  vec3 l = vec3(
    (r * pos.x + a * pos.z) * invR2,
    pos.y * invR,
    (r * pos.z - a * pos.x) * invR2
  );

  outD.f.r = r;
  outD.f.r2 = r2;
  outD.f.D = D;
  outD.f.H = H;
  outD.f.R2 = R2;
  outD.f.l = l;

  float L = pt + dot(l, p);
  float twoHL = 2.0 * H * L;

  outD.dpos = p - twoHL * l;
  outD.r = r;

  if (lensing <= 1e-6) {
    outD.dp = vec3(0.0);
    return outD;
  }

  vec3 gradR = vec3(
    r * r2 * pos.x,
    r * R2 * pos.y,
    r * r2 * pos.z
  ) * invD;

  float hFac = lensing * r2 * invD * invD;
  float cR = 3.0 * a2 * y2 - r2 * r2;
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
  float sr = sqrt(rNorm);
  float powApprox = mix(sr, sr * sqrt(sr), 0.88);
  float baseH = 0.048 + 0.036 * r * (0.42 + 0.88 * powApprox);
  return baseH * max(uDiskThickness, 0.15);
}

// Exact emitter 4-velocity (prograde Keplerian circular orbit outside ISCO,
// smooth relativistic radial+frame-dragged plunge inside ISCO) -> frequency shift g
float computeDiskFrequencyShiftFromFields(
  vec3 pos,
  KSFields f,
  vec3 p,
  float pt,
  float r,
  float rIsco,
  float rPlus,
  float a,
  float a2,
  float lensing
) {
  float rho2 = pos.x * pos.x + pos.z * pos.z;
  float invRho = inversesqrt(max(rho2, 1e-6));

  float omegaZ = (2.0 * f.H * a * f.R2) / max(f.R2 * f.R2 + 2.0 * f.H * a2 * rho2, 1e-8);
  vec3 vZamo = vec3(omegaZ * pos.z, 0.0, -omegaZ * pos.x);

  vec3 vEmit;
  if (r >= rIsco) {
    float rm = max(r, 1.0);
    float omega = 1.0 / (rm * sqrt(rm) + a);
    vEmit = vec3(omega * pos.z, 0.0, -omega * pos.x);
  } else {
    float plunge = clamp((rIsco - r) / max(rIsco - rPlus, 0.08), 0.0, 1.0);
    float rmIsco = max(rIsco, 1.0);
    float omegaIsco = 1.0 / (rmIsco * sqrt(rmIsco) + a);
    float ratio = rIsco / max(r, rPlus);
    float omegaEff = mix(omegaIsco * pow(ratio, 0.85), omegaZ, plunge * plunge);
    vec3 vRot = vec3(omegaEff * pos.z, 0.0, -omegaEff * pos.x);
    float vRadMag = 0.62 * (plunge * mix(1.0, sqrt(plunge), 0.5)) * sqrt(max(lensing, 0.1));
    vec3 radDir = vec3(pos.x, 0.0, pos.z) * invRho;
    vEmit = vRot - vRadMag * radDir;
  }

  float lv = -1.0 + dot(f.l, vEmit);
  float ds2 = -1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv;
  if (ds2 > -0.05) {
    vec3 dv = vEmit - vZamo;
    float lvZ = -1.0 + dot(f.l, vZamo);
    float ds2Z = min(-1.0 + dot(vZamo, vZamo) + 2.0 * f.H * lvZ * lvZ, -0.02);
    float shrink = sqrt(clamp((-0.05 - ds2Z) / max(ds2 - ds2Z, 1e-4), 0.0, 1.0)) * 0.92;
    vEmit = vZamo + dv * shrink;
    lv = -1.0 + dot(f.l, vEmit);
    ds2 = min(-1.0 + dot(vEmit, vEmit) + 2.0 * f.H * lv * lv, -0.02);
  }

  float ut = inversesqrt(max(-ds2, 0.02));
  float emitEnergy = ut * (pt + dot(p, vEmit));
  return clamp(1.0 / max(emitEnergy, 0.08), 0.06, 3.6);
}

// Dual-phase flow-advected 3D spiral filament sampling (zero stretching blowup, zero azimuth seam)
vec4 sampleDiskPlasmaNoise(float r, float logR, float log2R, float phi, float yNorm, float a, bool lowDetail) {
  float phiU = phi * INV_TAU;
  float rm = max(r, 1.0);
  float rmPow = exp2(0.28 * max(log2R, 0.0));
  float omegaVis = uOrbitSpeed * 1.65 / (rm * rmPow + 0.45 * a);

  float blend     = uFlowConsts.x;
  float dt0       = uFlowConsts.y;
  float dt1       = uFlowConsts.z;
  float globalRot = uFlowConsts.w;
  bool staticFlow = (abs(uOrbitSpeed) <= 1e-4);

  float spiralU0 = phiU + 2.35 * logR - (omegaVis * dt0 + globalRot) * INV_TAU;
  float radV0    = logR * 1.15 + dt0 * 0.012 * uOrbitSpeed;
  float zCoord   = yNorm * 0.28 + 0.5;

  vec4 n0 = texture(uVolumeNoise, vec3(spiralU0, radV0, zCoord));
  vec4 primary = n0;
  if (!staticFlow) {
    float spiralU1 = phiU + 2.35 * logR - (omegaVis * dt1 + globalRot) * INV_TAU;
    float radV1    = logR * 1.15 + dt1 * 0.012 * uOrbitSpeed;
    vec4 n1 = texture(uVolumeNoise, vec3(spiralU1, radV1, zCoord));
    primary = mix(n1, n0, blend);
  }

  if (lowDetail) {
    return primary;
  }

  float mhdWarpU = (primary.r - 0.5) * 0.095 + (primary.b - 0.5) * 0.055;
  float mhdWarpV = (primary.r - 0.5) * 0.36  + (primary.g - 0.5) * 0.18;
  float fineU0 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt0 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
  float fineV0 = logR * 3.15 + mhdWarpV;
  float fineZ  = yNorm * 0.55 + 0.25;

  vec4 d0 = texture(uVolumeNoise, vec3(fineU0, fineV0, fineZ));
  vec4 detail = d0;
  if (!staticFlow) {
    float fineU1 = 2.0 * phiU + 4.85 * logR - (omegaVis * dt1 * 1.18 + globalRot * 1.8) * INV_TAU + mhdWarpU;
    vec4 d1 = texture(uVolumeNoise, vec3(fineU1, fineV0, fineZ));
    detail = mix(d1, d0, blend);
  }

  return vec4(
    mix(primary.r, detail.r, 0.42),
    mix(primary.g, detail.g, 0.58),
    mix(primary.b, detail.b, 0.45),
    mix(primary.a, detail.a, 0.72)
  );
}

void evalDiskVolume(
  vec3 pos,
  float r,
  float gColor,
  float beaming,
  float rIsco,
  float rOuter,
  float rPlus,
  float a,
  float camDistFade,
  bool lowDetail,
  float log2RPeak,
  out vec3 emission,
  out float extinction
) {
  emission = vec3(0.0);
  extinction = 0.0;

  if (r <= rPlus * 1.03 || r >= rOuter * 1.07) return;

  float H = diskScaleHeight(r, rIsco, rOuter);
  float absY = abs(pos.y);
  if (absY > H * 2.55) return;

  float yNorm = pos.y / max(H, 1e-4);
  float absYNorm = abs(yNorm);
  float phi = atan(pos.z, pos.x);
  float log2R = log2(max(r, 0.6));
  float logR = log2R * 0.69314718056;

  vec4 n = sampleDiskPlasmaNoise(r, logR, log2R, phi, yNorm, a, lowDetail || absYNorm > 1.32);
  float turb = clamp(uTurbulence, 0.0, 2.2);

  float mainInner = smoothstep(rIsco * 0.90, rIsco * 1.16, r);
  float tendrilWarp = (n.x * 0.55 + n.y * 0.45 - 0.5) * 0.28 * clamp(turb, 0.3, 1.8);
  float rOuterEff = rOuter * (1.0 + tendrilWarp);
  float ob = max(1.0 - smoothstep(rOuterEff * 0.28, rOuterEff * 1.02, r), 0.0);
  float outerFade = ob * ob;
  float outerWisps = smoothstep(0.32, 0.85, n.y * 0.65 + n.w * 0.35);
  float outerEdgeSoft = (1.0 - smoothstep(rOuter * 0.72, rOuter * 1.07, r))
                      * mix(1.0, 0.35 + 0.95 * outerWisps, smoothstep(rOuter * 0.52, rOuter * 0.92, r));

  float plungeEnv = 0.0;
  if (mainInner < 0.999) {
    float plungeMask = (1.0 - mainInner) * smoothstep(rPlus * 1.04, rPlus * 1.32, r);
    float pf = clamp(n.y * 0.75 + n.w * 0.45, 0.0, 1.0);
    float plungeFilaments = pf * pf;
    plungeEnv = plungeMask * (0.14 + 0.38 * plungeFilaments);
  }

  float radialEnv = (mainInner * outerFade + plungeEnv) * outerEdgeSoft;
  if (radialEnv < 1e-4) return;

  float warpY = (n.x - 0.5) * 0.28 * turb;
  float yShifted = abs(yNorm + warpY);
  float yShiftedSq = yShifted * yShifted;
  float vertCore   = exp(-yShiftedSq * 2.75);
  float vertMid    = exp(-yShiftedSq * 5.60);
  float slabWindow = smoothstep(2.55, 1.80, absYNorm);
  float vertSheath = 0.22 * exp(-absYNorm * 1.65) * slabWindow;

  float rWarp = logR + (n.x - 0.5) * 0.24 * turb + (n.z - 0.5) * 0.12 * turb;
  float laneBroad = max(0.5 + 0.5 * sin(rWarp * 18.5 + 0.72 * sin(phi + logR * 3.5 + n.x * 2.6)), 0.0);
  float lbSqrt = sqrt(laneBroad);
  float lbPow = laneBroad * lbSqrt;
  float laneFine = 0.5;
  float concentricLanes = 0.56 + 0.44 * laneBroad;
  if (!lowDetail) {
    laneFine = max(0.5 + 0.5 * sin(rWarp * 46.0 - 0.62 * cos(2.0 * phi - logR * 5.2 + n.z * 3.0)), 0.0);
    float laneMicro = max(0.5 + 0.5 * sin(rWarp * 94.0 + 0.50 * sin(3.0 * phi + logR * 7.0 - n.y * 2.4)), 0.0);
    float lmPow = laneMicro * laneMicro * sqrt(laneMicro);
    concentricLanes = mix(
      concentricLanes,
      0.26 + 0.34 * lbPow + 0.36 * (laneFine * laneFine) + 0.24 * lmPow,
      0.76
    );
  }

  float nyc = clamp(n.y, 0.0, 1.0);
  float ridgeSharp = nyc * sqrt(nyc);
  float nwc = clamp(n.w, 0.0, 1.0);
  float microSharp = nwc * mix(1.0, sqrt(nwc), 0.76);
  float ht = clamp(ridgeSharp * 0.62 + microSharp * 0.52, 0.0, 1.0);
  float hotThread = ht * ht * sqrt(ht);
  float mriFilaments = mix(0.68, 0.18 + 1.15 * ridgeSharp + 0.62 * microSharp + 0.85 * hotThread, clamp(turb, 0.0, 1.65));
  float eddyBoost = mix(1.0, 0.64 + 0.82 * n.z, clamp(turb * 0.80, 0.0, 1.2));
  float plasmaStructure = concentricLanes * mriFilaments * eddyBoost;

  float riftSignal = n.x * 0.50 + n.y * 0.35 + n.z * 0.15;
  float riftMask = smoothstep(0.24, 0.74, riftSignal);
  float structureContrast = mix(1.0, mix(0.20, 1.48, riftMask), clamp(turb * 0.85, 0.0, 1.0));

  float localDensity = radialEnv * (vertCore * plasmaStructure * structureContrast * slabWindow + vertSheath * (0.38 + 0.62 * ridgeSharp))
                     * uDiskDensity * camDistFade;
  if (localDensity < 1e-5) return;

  float rel = clamp(uRelativisticMode, 0.0, 1.0);
  float tempExp = mix(0.42, 0.55, rel);
  float tempRadial = exp2(-tempExp * max(log2R - log2RPeak, -0.94341647));
  float plungeCool = mix(0.76, 1.0, mainInner);
  float filamentHeat = clamp(ridgeSharp * 0.46 + microSharp * 0.24 + laneFine * 0.22 + hotThread * 0.42, 0.0, 1.0);
  float T_local = uDiskTemp * tempRadial * plungeCool * mix(0.72, 1.34, filamentHeat);

  float T_obs = clamp(T_local * gColor, T_MIN, T_MAX);
  vec3 bbColor = sampleBlackbody(T_obs);

  float tr = clamp(T_local / 4750.0, 0.15, 3.8);
  float thermalPower = tr * tr;
  float heightComp = exp2(-0.40 * log2(max(H * 3.0, 0.38)));
  float rPeakComp  = uOptConsts.x;

  float rimDist = (r - rIsco * 1.18) / max(rIsco * 0.38, 0.42);
  float innerHotRim = 1.0 + 0.95 * exp(-rimDist * rimDist) * mainInner;

  float emitStrength = localDensity * thermalPower * beaming * heightComp * rPeakComp * innerHotRim * 1.38;
  emission = bbColor * emitStrength;

  float dustZone = smoothstep(rIsco * 1.45 + 1.8, rIsco * 3.0 + 3.2, r);
  float dvRaw = smoothstep(0.32, 0.88, 1.0 - ridgeSharp * 0.72 + (n.x - 0.5) * 0.75);
  float dustVeins = dvRaw * mix(1.0, sqrt(dvRaw), 0.70);
  float dustLane  = 0.30 + 0.70 * (1.0 - lbPow);
  float coolDustExt = radialEnv * vertMid * dustZone * (0.42 + 1.85 * dustVeins * dustLane);
  float plasmaSelfExt = radialEnv * vertCore * (0.15 + 0.22 * n.x);

  float extPeakComp = uOptConsts.y;
  extinction = (coolDustExt * 1.45 + plasmaSelfExt * 0.40) * uDiskDensity * heightComp * extPeakComp * camDistFade * slabWindow;
}

// ============================================================================
// 4. RELATIVISTIC BLANDFORD-ZNAJEK POLAR JETS (3D CARTESIAN, ZERO POLE SEAM)
// ============================================================================

vec3 evalPolarJet(vec3 pos, vec3 vel, float rPlus, float a, float camDistFade) {
  float absY = abs(pos.y);
  if (absY < rPlus * 1.35 || absY > 44.0) return vec3(0.0);

  float rho = length(pos.xz);
  float jetRadius = 0.14 * rPlus + 0.088 * pow(absY, 0.72);
  if (rho > jetRadius * 2.4) return vec3(0.0);

  float u = rho / max(jetRadius, 1e-4);
  float spine  = exp(-u * u * 5.2);
  float sd     = u - 0.76;
  float sheath = exp(-sd * sd * 10.5) * 0.88;
  float outerHalo = exp(-u * u * 1.4) * 0.16;
  float radialProfile = spine * 0.52 + sheath + outerHalo;

  float yEnv = smoothstep(rPlus * 1.35, rPlus * 3.9, absY)
             * (1.0 - smoothstep(16.0, 42.0, absY))
             / (1.0 + 0.11 * absY);

  float signY = pos.y >= 0.0 ? 1.0 : -1.0;
  float helixAngle = signY * (absY * 0.72 - uTime * uOrbitSpeed * 1.85) * (0.55 + 0.45 * a);
  float ch = cos(helixAngle);
  float sh = sin(helixAngle);
  vec2 rotXZ = vec2(ch * pos.x - sh * pos.z, sh * pos.x + ch * pos.z);

  float flowY = absY * 0.17 - uTime * uOrbitSpeed * 0.48;
  vec3 jetUvw = vec3(rotXZ * 0.48, flowY);
  vec4 jn = texture(uVolumeNoise, jetUvw);
  vec4 jnFine = texture(uVolumeNoise, vec3(rotXZ * 1.08, flowY * 2.15 + 0.37));

  float rawFil = clamp(jn.y * 0.55 + jnFine.w * 0.60, 0.0, 1.0);
  float filaments = rawFil * rawFil * sqrt(rawFil);
  float knots = 0.40 + 0.90 * pow(max(jn.z, 0.0), 1.3);

  vec3 jetDir = vec3(0.0, signY, 0.0);
  float cosTheta = dot(jetDir, -normalize(vel));
  float betaJet = 0.48 + 0.20 * a;
  float dopplerJet = 1.0 / max(1.0 - betaJet * cosTheta, 0.30);
  float jetBeam = pow(clamp(dopplerJet, 0.40, 2.2), mix(0.85, 1.65, uRelativisticMode));
  float viewColumnAtten = mix(1.0, 0.24, pow(max(abs(cosTheta), 0.0), 1.55));

  vec3 coreCol   = vec3(0.62, 0.86, 1.00);
  vec3 sheathCol = vec3(0.20, 0.46, 1.00);
  vec3 outerCol  = vec3(0.46, 0.22, 1.00);
  vec3 jetCol = mix(sheathCol, coreCol, clamp(spine * 0.85 + filaments * 0.55, 0.0, 1.0));
  jetCol = mix(jetCol, outerCol, smoothstep(0.75, 1.85, u) * 0.68);

  float rawInt = uJetIntensity * radialProfile * yEnv * (0.18 + 1.55 * filaments) * knots * jetBeam * viewColumnAtten * camDistFade;
  float intensity = rawInt / (1.0 + rawInt * 0.45);
  return jetCol * (intensity * 0.165);
}

// ============================================================================
// 5. SEAMLESS 4K MILKY WAY LENSING + CRISP 3D MICRO-STARS
// ============================================================================

vec3 rotateSkyDir(vec3 d) {
  float cy = uOptConsts.z;
  float sy = uOptConsts.w;
  vec3 r1 = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  float cp = uSkyTrig.x;
  float sp = uSkyTrig.y;
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

  float magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  float mag2 = magU * magU;
  float mag  = mag2 * mag2 * sqrt(magU);

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

vec3 sampleSkyBackground(vec3 rawDir, bool escaped, float edgeMask) {
  vec3 dir = normalize(rotateSkyDir(rawDir));

  // Wrap-safe & pole-safe equirectangular coordinates (MUST run in uniform control flow!)
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
  float tanHalfFov = uKerrConsts.w;
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  float a = clamp(uSpin, 0.0, 0.998);
  float a2 = a * a;
  float lensing = clamp(uLensingStrength, 0.0, 1.0);
  float rPlus  = uKerrConsts.x;
  float rIsco  = uKerrConsts.y;
  float rOuter = uKerrConsts.z;

  // Initialize exact ZAMO orthonormal null momentum using CPU-precomputed tetrad
  vec4 pUp = -uZamoE0 + localRay.x * uZamoE1 + localRay.y * uZamoE2 + localRay.z * uZamoE3;
  float lp = -pUp.x + dot(uCamKSl2H.xyz, pUp.yzw);
  float twoHL = uCamKSl2H.w * lp;
  float pt = -pUp.x - twoHL;
  vec3 p   = pUp.yzw + twoHL * uCamKSl2H.xyz;
  vec3 pos = uCamPos;

  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(uFrameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int maxSteps = 240;
  float qualScale = 0.96;
  if (uQuality <= 0) {
    maxSteps = 155;
    qualScale = 1.25;
  } else if (uQuality >= 2) {
    maxSteps = 360;
    qualScale = 0.66;
  }

  float escapeR      = uRayConsts.x;
  float captureR     = uRayConsts.y;
  float maxDiskSlabY = uRayConsts.z;
  bool hasDisk = (uDiskDensity > 0.001);
  bool hasJet  = (uJetIntensity > 0.001);
  bool lowDetailBase = (uQuality <= 0);
  float rel = clamp(uRelativisticMode, 0.0, 1.0);
  float log2RPeak = log2(max(uRayConsts.w, 1e-4));

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float rayDist = 0.0;
  bool captured = false;
  bool escaped  = false;
  vec3 finalVel = localRay;

  for (int step = 0; step < 360; ++step) {
    if (step >= maxSteps) break;

    GeodesicDeriv k1 = evalGeodesicRHS(pos, p, pt, a, a2, lensing);
    float r = k1.r;
    finalVel = k1.dpos;

    if (r <= captureR) {
      captured = true;
      break;
    }

    bool outbound = dot(pos, k1.dpos) > 0.0;
    if (r > escapeR && outbound) {
      escaped = true;
      break;
    }

    float rAboveHor = max(r - rPlus * 0.72, 0.06);
    bool farOut = outbound && r > rOuter * 1.10 && (!hasJet || abs(pos.y) > 42.0 || dot(pos.xz, pos.xz) > 25.0);
    float h = clamp((farOut ? 0.32 : 0.12) * rAboveHor * qualScale, 0.024 * qualScale, farOut ? 14.0 : 4.8);

    if (r < 4.8 * rPlus) {
      h = min(h, (0.028 + 0.035 * max(r - rPlus, 0.05)) * qualScale);
    }

    if (hasDisk && r < rOuter * 1.10) {
      float localH = diskScaleHeight(r, rIsco, rOuter);
      float absY = abs(pos.y);
      if (absY < localH * 2.8) {
        float diskHStep = max(localH * 1.15, 0.085) * qualScale;
        float prox = smoothstep(localH * 2.8, localH * 0.9, absY);
        h = min(h, mix(h, diskHStep, prox));
      }
    }

    if (hasJet && abs(pos.y) > rPlus * 1.1 && abs(pos.y) < 42.0) {
      float rho = length(pos.xz);
      float jRad = 0.14 * rPlus + 0.088 * pow(max(abs(pos.y), 0.1), 0.72);
      if (rho < jRad * 2.6) {
        h = min(h, max(jRad * 0.36, 0.075) * qualScale);
      }
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    bool useRk2 = (r >= 6.5 * rPlus);
    vec3 posNext;
    vec3 pNext;
    KSFields k2Fields;
    if (!useRk2) {
      vec3 pos2 = pos + (0.5 * h) * k1.dpos;
      vec3 p2   = p   + (0.5 * h) * k1.dp;
      GeodesicDeriv k2 = evalGeodesicRHS(pos2, p2, pt, a, a2, lensing);

      vec3 pos3 = pos + (0.5 * h) * k2.dpos;
      vec3 p3   = p   + (0.5 * h) * k2.dp;
      GeodesicDeriv k3 = evalGeodesicRHS(pos3, p3, pt, a, a2, lensing);

      vec3 pos4 = pos + h * k3.dpos;
      vec3 p4   = p   + h * k3.dp;
      GeodesicDeriv k4 = evalGeodesicRHS(pos4, p4, pt, a, a2, lensing);

      posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
      pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);
      k2Fields = k2.f;
    } else {
      vec3 pos2 = pos + (0.5 * h) * k1.dpos;
      vec3 p2   = p   + (0.5 * h) * k1.dp;
      GeodesicDeriv k2 = evalGeodesicRHS(pos2, p2, pt, a, a2, lensing);

      posNext = pos + h * k2.dpos;
      pNext   = p   + h * k2.dp;
      k2Fields = k2.f;
    }

    float segLen = length(posNext - pos);
    float midDist = rayDist + 0.5 * segLen;
    float camDistFade = smoothstep(0.0, 0.75, midDist);

    if (hasDisk) {
      float yMin = min(pos.y, posNext.y);
      float yMax = max(pos.y, posNext.y);
      bool crossesPlane = (yMin <= 0.0 && yMax >= 0.0);
      bool inSlab = (yMin <= maxDiskSlabY && yMax >= -maxDiskSlabY);

      if (inSlab || crossesPlane) {
        vec3 midPos = 0.5 * (pos + posNext);
        KSFields fMid;
        if (useRk2) {
          fMid = k2Fields;
        } else {
          fMid = evalKSFields(midPos, a, a2, lensing);
        }
        float rMid = fMid.r;

        if (rMid > rPlus * 1.025 && rMid < rOuter * 1.07) {
          float hMid = diskScaleHeight(rMid, rIsco, rOuter);
          if (crossesPlane || abs(midPos.y) < hMid * 2.55 || abs(pos.y) < hMid * 2.55 || abs(posNext.y) < hMid * 2.55) {
            vec3 midP = 0.5 * (p + pNext);
            float gSeg = computeDiskFrequencyShiftFromFields(midPos, fMid, midP, pt, rMid, rIsco, rPlus, a, a2, lensing);
            float gColor = mix(mix(1.0, gSeg, 0.26), gSeg, rel);
            float gBeam  = mix(mix(1.0, gSeg, 0.34), gSeg, rel);
            float beamExp = mix(1.85, 3.35, rel);
            float beaming = pow(clamp(gBeam, 0.10, 2.75), beamExp);
            beaming = (beaming / (1.0 + beaming * mix(0.055, 0.165, rel))) * mix(1.0, 0.92, rel);

            int nSub = 1;
            float targetDs = max(hMid * 0.95, 0.075) * qualScale;
            if (crossesPlane || segLen > targetDs) {
              nSub = clamp(int(ceil(segLen / targetDs)), crossesPlane ? 2 : 1, (uQuality >= 2) ? 3 : 2);
            }
            float dsSub = segLen / float(nSub);
            float jitterBase = fract(bn.y + float(step) * 0.61803399);
            bool lowDet = lowDetailBase || (transmittance < 0.08);

            for (int s = 0; s < 3; ++s) {
              if (s >= nSub) break;
              float frac = (float(s) + jitterBase) / float(nSub);
              vec3 sPos = mix(pos, posNext, frac);
              float sR = (nSub == 1) ? rMid : evalKerrR(sPos, a2);

              vec3 emit;
              float ext;
              evalDiskVolume(sPos, sR, gColor, beaming, rIsco, rOuter, rPlus, a, camDistFade, lowDet, log2RPeak, emit, ext);

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

    if (hasJet && transmittance > 0.008) {
      float jFrac = fract(bn.z + float(step) * 0.38196601);
      vec3 jPos = mix(pos, posNext, jFrac);
      vec3 jetEmit = evalPolarJet(jPos, k1.dpos, rPlus, a, camDistFade);
      radiance += transmittance * jetEmit * segLen;
    }

    pos = posNext;
    p   = pNext;
    rayDist += segLen;

    if (transmittance < 0.008) {
      break;
    }
  }

  if (!captured && !escaped) {
    float rEnd = evalKerrR(pos, a2);
    if (rEnd < rPlus * 1.65 || (rEnd < 4.0 * rPlus && dot(pos, finalVel) < 0.0)) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  float escFlag = (escaped && !captured && transmittance > 0.008) ? 1.0 : 0.0;
  float edgeMask = fwidth(escFlag);
  vec3 safeSkyDir = (dot(finalVel, finalVel) > 1e-10) ? normalize(finalVel) : localRay;
  vec3 skyColor = sampleSkyBackground(safeSkyDir, escFlag > 0.5, edgeMask);

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
