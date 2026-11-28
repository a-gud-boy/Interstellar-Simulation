/**
 * GLSL 300 es relativistic Tidal Disruption Event (TDE) ray-tracer shader for WebGL2,
 * matching sims/tde/src/shaders/tde.wgsl and desktop/src/sims/tde.rs physics & uniforms.
 */

export const TDE_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler3D uVolumeNoise;   // unit 0
uniform sampler2D uSkyMap;        // unit 1
uniform sampler2D uProcSkyMap;    // unit 2
uniform sampler2D uBlackbodyLut;  // unit 3
uniform sampler2D uBlueNoise;     // unit 4

layout(std140) uniform TdeUniforms {
  vec4 resolution_time_frame;
  vec4 jitter_fov_spin;
  vec4 camPos_relMode;
  vec4 camRight_lensing;
  vec4 camUp_tdePhase;
  vec4 camFwd_beta;
  vec4 streamParams;
  vec4 visualParams;
  vec4 skyParams;
  ivec4 modes_pad;
  vec4 zamoE0;
  vec4 zamoE1;
  vec4 zamoE2;
  vec4 zamoE3;
  vec4 camKS_l_2H;
  vec4 kerrConsts;
  vec4 rayConsts;
  vec4 shockPosConsts;
  vec4 starCoreConsts;
  vec4 skyTrig;
} u;

const float PI             = 3.14159265359;
const float TAU            = 6.28318530718;
const float INV_PI         = 0.31830988618;
const float INV_TAU        = 0.15915494309;
const float T_MIN          = 800.0;
const float T_MAX          = 40000.0;
const float INV_LOG_T_SPAN = 1.0 / 3.91202300543;

bool isBadFloat(float x) {
  return isnan(x) || isinf(x);
}

vec3 sanitizeVec3Zero(vec3 v) {
  return vec3(
    isBadFloat(v.x) ? 0.0 : v.x,
    isBadFloat(v.y) ? 0.0 : v.y,
    isBadFloat(v.z) ? 0.0 : v.z
  );
}

struct KSFields {
  float r;
  float r2;
  float D;
  float H;
  float R2;
  vec3 l;
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
    f.r  = sqrt(f.r2);
    f.D  = f.r2 * f.r2;
    f.R2 = f.r2;
    f.H  = lensing / max(f.r, 1e-5);
    f.l  = pos / max(f.r, 1e-5);
    return f;
  }
  float uVal = dot(pos, pos) - a2;
  float ay = 2.0 * pos.y;
  float disc = sqrt(max(uVal * uVal + a2 * ay * ay, 1e-12));
  f.r2 = max(0.5 * (uVal + disc), 1e-8);
  f.r  = sqrt(f.r2);
  f.D  = f.r2 * f.r2 + a2 * pos.y * pos.y;
  f.R2 = f.r2 + a2;
  f.H  = (lensing * f.r * f.r2) / max(f.D, 1e-10);
  float invR2 = 1.0 / max(f.R2, 1e-8);
  f.l  = vec3(
    (f.r * pos.x + a * pos.z) * invR2,
    pos.y / max(f.r, 1e-5),
    (f.r * pos.z - a * pos.x) * invR2
  );
  return f;
}

struct GeodesicRHS {
  vec3 dpos;
  vec3 dp;
  KSFields f;
};

GeodesicRHS evalGeodesicRHS(vec3 pos, vec3 p, float pt, float a, float a2, float lensing) {
  GeodesicRHS res;
  KSFields f = evalKSFields(pos, a, a2, lensing);
  res.f = f;

  float L = -pt + dot(f.l, p);
  float twoHL = 2.0 * f.H * L;
  res.dpos = p - twoHL * f.l;

  float invD = 1.0 / max(f.D, 1e-10);
  float invR2 = 1.0 / max(f.R2, 1e-8);
  vec3 gradR = vec3(f.r * f.r2 * pos.x, f.r * f.R2 * pos.y, f.r * f.r2 * pos.z) * invD;
  float cR = -f.r2 * f.r2 + 3.0 * a2 * pos.y * pos.y;
  float hFac = lensing * f.r2 * invD * invD;
  vec3 dH = hFac * cR * gradR + vec3(0.0, -2.0 * a2 * lensing * f.r * f.r2 * pos.y * invD * invD, 0.0);

  float lpHoriz = f.l.x * p.x + f.l.z * p.z;
  float S = (p.x * pos.x + p.z * pos.z - 2.0 * f.r * lpHoriz) * invR2 - (pos.y * p.y) / max(f.r2, 1e-8);
  vec3 dLP = vec3(
    (f.r * p.x - a * p.z) * invR2,
    p.y / max(f.r, 1e-5),
    (a * p.x + f.r * p.z) * invR2
  ) + S * gradR;

  res.dp = (L * L) * dH + twoHL * dLP;
  return res;
}

vec3 sampleBlackbody(float tempK) {
  float t = clamp(tempK, T_MIN, T_MAX);
  float uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.001, 0.999);
  return textureLod(uBlackbodyLut, vec2(uCoord, 0.5), 0.0).rgb;
}

vec3 rotateTiltX(vec3 v, float angleRad) {
  float c = cos(angleRad);
  float s = sin(angleRad);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

struct VolSample {
  vec3 emission;
  float extinction;
};

float computeFrequencyShift(
  vec3 pos,
  vec3 vel3,
  vec3 rayP,
  float pt,
  float a,
  float a2,
  float lensing
) {
  KSFields f = evalKSFields(pos, a, a2, lensing);
  float lv = dot(f.l, vel3);
  float v2 = dot(vel3, vel3);
  float denom = max(1.0 - 2.0 * f.H * (1.0 - lv) * (1.0 - lv) - v2, 0.025);
  float ut = inversesqrt(denom);
  float kDotU = pt + dot(rayP, vel3);
  float kDotUObs = ut * kDotU;
  return clamp(-1.0 / min(kDotUObs, -0.05), 0.14, 3.2);
}

VolSample evalTidalDebris(
  vec3 pos,
  float rKerr,
  vec3 rayP,
  float pt,
  float rPlus,
  float a,
  float a2,
  float lensing,
  float camDistFade,
  bool lowDetail
) {
  VolSample outS;
  outS.emission = vec3(0.0);
  outS.extinction = 0.0;

  float streamDens = max(u.streamParams.x, 0.0);
  float shockInt   = max(u.streamParams.y, 0.0);
  if (streamDens <= 0.001 && shockInt <= 0.001) {
    return outS;
  }

  float t = u.resolution_time_frame.z * max(u.visualParams.x, 0.05);
  float phase = clamp(u.camUp_tdePhase.w, 0.02, 1.0);
  float beta  = max(u.camFwd_beta.w, 0.4);
  float precess = u.visualParams.y;
  float rpVis = u.visualParams.z;
  float ecc = u.rayConsts.w;
  float tilt = u.visualParams.w;
  bool swallowed = (u.modes_pad.w != 0);
  float swallowedF = swallowed ? 1.0 : 0.0;
  float rel = clamp(u.camPos_relMode.w, 0.0, 1.0);

  vec3 q = rotateTiltX(pos, -tilt);
  float rHoriz = length(q.xz);

  // Self-Intersection Nozzle Shock & Reprocessing Halo
  vec3 shockPos = u.shockPosConsts.xyz;
  vec3 dShock = pos - shockPos;
  float rShockDist = length(dShock);
  if (shockInt > 0.001 && rShockDist < 11.5) {
    vec3 nUV = u.shockPosConsts.xyz * 0.075 + dShock * 0.075 - vec3(0.0, t * 0.28, 0.0);
    vec4 turb = textureLod(uVolumeNoise, nUV, 0.0);
    vec3 lobeScale = vec3(1.25, 0.72 + 0.35 * phase, 1.45);
    float rPlume = length(dShock / lobeScale);
    float nozzleCore = exp(-rPlume * rPlume * 0.65) * (0.45 + 0.95 * turb.g);
    float reprocHalo = exp(-rShockDist * rShockDist * 0.055) * (0.35 + 0.65 * turb.r) * (0.35 + 0.65 * phase);

    float phaseShock = smoothstep(0.14, 0.45, phase) * (1.0 - 0.35 * smoothstep(0.72, 1.0, phase));
    float holeDim = swallowed ? 0.22 : 1.0;
    float sGain = shockInt * phaseShock * holeDim * camDistFade;

    vec3 nozzleCol = sampleBlackbody(u.shockPosConsts.w) * vec3(0.88, 0.96, 1.15);
    vec3 haloCol   = sampleBlackbody(mix(12500.0, 21000.0, 0.5 * turb.r)) * vec3(1.04, 0.86, 1.08);
    outS.emission += (nozzleCol * (nozzleCore * 4.4) + haloCol * (reprocHalo * 0.95)) * sGain;
    outS.extinction += (nozzleCore * 0.32 + reprocHalo * 0.14) * shockInt * holeDim;
  }

  // Disrupted Stellar Core
  vec3 corePos = u.starCoreConsts.xyz;
  float coreRad = max(u.starCoreConsts.w, 0.18);
  vec3 dCore = pos - corePos;
  float dCoreSq = dot(dCore, dCore);
  float coreFade = (1.0 - smoothstep(0.45, 0.92, phase));
  if (coreFade > 0.01 && dCoreSq < (coreRad * 6.5) * (coreRad * 6.5)) {
    vec3 dirToBh = normalize(-corePos + vec3(1e-5, 0.0, 0.0));
    float axial = dot(dCore, dirToBh);
    vec3 perpVec = dCore - axial * dirToBh;
    float stretch = 1.0 + 1.15 * min(beta, 3.0) * smoothstep(0.05, 0.45, phase);
    float ellipDist = length(perpVec) + abs(axial) / stretch;
    float rNorm = ellipDist / coreRad;
    if (rNorm < 2.6) {
      vec4 puff = textureLod(uVolumeNoise, dCore * 0.18 + vec3(t * 0.15, 0.0, 0.0), 0.0);
      float photosphere = exp(-rNorm * rNorm * 2.1) * (0.78 + 0.44 * puff.r);
      vec3 stellarCol = sampleBlackbody(mix(6400.0, 12800.0, smoothstep(0.0, 1.8, rNorm)));
      outS.emission += stellarCol * (photosphere * 5.2 * coreFade * streamDens * camDistFade);
      outS.extinction += photosphere * 1.45 * coreFade * streamDens;
    }
  }

  // Precessing Elliptical Tidal Arms & Unbound Escaping Tail
  if (streamDens > 0.001 && rHoriz > rPlus * 1.04 && rHoriz < 36.0 && abs(q.y) < 3.6) {
    float semiL = rpVis * (1.0 + ecc);
    float phi = atan(q.z, q.x);
    float pHalf = 0.5 * precess;

    float rOrbit1 = semiL / max(1.0 + ecc * cos(phi), 0.18);
    float rOrbit2 = semiL / max(1.0 + ecc * cos(phi - precess), 0.18);
    float rTail   = (rpVis * 1.15 * (1.0 + ecc)) / max(1.0 + 1.12 * ecc * cos((phi + 1.92) * 0.55), 0.22);

    float d1 = abs(rHoriz - rOrbit1);
    float d2 = abs(rHoriz - rOrbit2);
    float d3 = abs(rHoriz - rTail);

    float w1 = 0.34 + 0.042 * rHoriz + 0.32 * phase;
    float w2 = 0.38 + 0.048 * rHoriz + 0.42 * phase;
    float w3 = 0.46 + 0.055 * rHoriz;

    float hStream = 0.22 + 0.028 * rHoriz + 0.24 * phase;
    float vProf = exp(-(q.y * q.y) / max(hStream * hStream, 0.02));

    float arc1Mask = smoothstep(-2.9, -1.6, phi) * smoothstep(0.15, -0.55, phi - (PI - pHalf * 0.3));
    float arc2Mask = smoothstep(-0.35, 0.55, phi) * (1.0 - 0.25 * swallowedF) * smoothstep(0.18, 0.45, phase);
    float tailMask = smoothstep(0.12, 0.42, phase) * smoothstep(0.85, 2.5, rHoriz / max(rpVis, 1.0));

    float env1 = exp(-(d1 * d1) / (w1 * w1)) * vProf * arc1Mask;
    float env2 = exp(-(d2 * d2) / (w2 * w2)) * vProf * arc2Mask;
    float env3 = exp(-(d3 * d3) / (w3 * w3)) * vProf * tailMask * 0.55;

    float streamEnv = max(max(env1, env2), env3);
    if (streamEnv > 0.015) {
      float sTime = t * 0.55;
      vec3 fUv = vec3(phi * 0.55 - sTime * 0.45, log2(max(rHoriz, 0.8)) * 0.42, q.y * 0.55);
      vec4 n0 = textureLod(uVolumeNoise, fUv, 0.0);
      float filament = mix(0.55, 1.45, n0.g * 0.65 + n0.r * 0.35);
      if (!lowDetail) {
        vec4 n1 = textureLod(uVolumeNoise, fUv * 2.15 + vec3(0.31, -sTime * 0.22, 0.17), 0.0);
        filament *= mix(0.75, 1.32, n1.b);
      }

      float speed = clamp(inversesqrt(max(rKerr, 1.35)), 0.05, 0.66);
      vec3 tanDirLocal = normalize(vec3(-q.z, 0.0, q.x) + vec3(0.12 * q.x, 0.0, 0.12 * q.z));
      vec3 velWorld = rotateTiltX(tanDirLocal, tilt) * speed;
      float g = computeFrequencyShift(pos, velWorld, rayP, pt, a, a2, lensing);
      float gEff = mix(mix(1.0, g, 0.28), g, rel);
      float beaming = clamp(pow(gEff, mix(1.6, 2.8, rel)), 0.22, 3.6);

      float proxHeat = clamp(rpVis / max(rHoriz, rpVis * 0.7), 0.25, 1.85);
      bool isTail = (env3 > max(env1, env2));
      float baseT = mix(u.skyParams.w * (0.65 + 0.55 * proxHeat), 5400.0, isTail ? 0.72 : 0.0);
      vec3 col = sampleBlackbody(baseT * mix(1.0, gEff, 0.65));

      float dens = streamEnv * filament * streamDens * (swallowed ? 0.42 : 1.0);
      float emissiveGain = (0.95 + 1.85 * proxHeat * (0.5 + 0.5 * phase)) * beaming * camDistFade;
      outS.emission += col * (dens * emissiveGain);
      outS.extinction += dens * (0.24 + 0.35 * filament);
    }
  }

  return outS;
}

VolSample evalCircularDisk(
  vec3 pos,
  float rKerr,
  vec3 rayP,
  float pt,
  float rIsco,
  float rOuter,
  float rPlus,
  float a,
  float a2,
  float lensing,
  float camDistFade,
  bool lowDetail
) {
  VolSample outD;
  outD.emission = vec3(0.0);
  outD.extinction = 0.0;

  float diskDens = max(u.streamParams.z, 0.0);
  float phase = clamp(u.camUp_tdePhase.w, 0.02, 1.0);
  float phaseDisk = smoothstep(0.18, 0.68, phase);
  if (diskDens <= 0.001 || phaseDisk <= 0.01) {
    return outD;
  }
  if (rKerr <= rPlus * 1.02 || rKerr >= rOuter * 1.06) {
    return outD;
  }

  float hScale = (0.14 + 0.042 * (rKerr - rIsco) * 0.35 + 0.16 * phase) * (1.0 + 0.15 * clamp(u.streamParams.y, 0.0, 2.0));
  float vDens = exp(-(pos.y * pos.y) / max(hScale * hScale, 0.015));
  if (vDens < 0.006) {
    return outD;
  }

  float radialIn = smoothstep(rPlus * 1.03, rIsco * 1.04, rKerr);
  float radialOut = 1.0 - smoothstep(rOuter * 0.52, rOuter * 1.04, rKerr);
  float rProf = radialIn * radialOut;
  if (rProf <= 0.004) {
    return outD;
  }

  float t = u.resolution_time_frame.z * max(u.visualParams.x, 0.05);
  float omega = inversesqrt(max(rKerr * rKerr * rKerr, 0.8)) * 0.85;
  float phi = atan(pos.z, pos.x);
  float advPhase = phi - omega * t * 3.8;
  vec3 uvN = vec3(cos(advPhase) * 0.32 + rKerr * 0.11, pos.y * 0.55, sin(advPhase) * 0.32 - t * 0.14);
  vec4 nMain = textureLod(uVolumeNoise, uvN, 0.0);
  float structFac = mix(0.45, 1.45, nMain.g * 0.6 + nMain.r * 0.4);
  if (!lowDetail) {
    vec4 nFine = textureLod(uVolumeNoise, uvN * 2.4 + vec3(0.19, 0.0, -t * 0.25), 0.0);
    structFac *= mix(0.75, 1.28, nFine.a);
  }

  float rho = max(sqrt(pos.x * pos.x + pos.z * pos.z), 0.1);
  float kepSpeed = clamp(inversesqrt(max(rKerr - 0.65 * a, 1.15)), 0.06, 0.72);
  vec3 velWorld = vec3(-pos.z / rho, 0.0, pos.x / rho) * kepSpeed;
  float g = computeFrequencyShift(pos, velWorld, rayP, pt, a, a2, lensing);
  float rel = clamp(u.camPos_relMode.w, 0.0, 1.0);
  float gEff = mix(mix(1.0, g, 0.28), g, rel);
  float beaming = clamp(pow(gEff, mix(1.75, 3.25, rel)), 0.15, 4.2);

  float rNorm = clamp((rOuter - rKerr) / max(rOuter - rIsco, 1.0), 0.0, 1.0);
  float tempK = u.skyParams.w * (0.62 + 1.25 * rNorm * rNorm) * mix(1.0, gEff, 0.82);
  vec3 col = sampleBlackbody(tempK);

  float swallowedDim = (u.modes_pad.w != 0) ? 0.18 : 1.0;
  float dens = vDens * rProf * structFac * diskDens * phaseDisk * swallowedDim;
  outD.emission = col * (dens * 1.55 * beaming * camDistFade);
  outD.extinction = dens * 0.34;
  return outD;
}

vec3 evalTdeJet(vec3 pos, vec3 rayDpos, float rPlus, float camDistFade) {
  float jetInt = max(u.streamParams.w, 0.0);
  if (jetInt <= 0.002) {
    return vec3(0.0);
  }
  float ay = abs(pos.y);
  if (ay < rPlus * 0.7 || ay > 38.0) {
    return vec3(0.0);
  }
  float rho = sqrt(pos.x * pos.x + pos.z * pos.z);
  float coneR = 0.28 + 0.115 * pow(ay, 0.74);
  float sheath = exp(-((rho - 0.45 * coneR) * (rho - 0.45 * coneR)) / max(0.32 * coneR * coneR, 0.04));
  float core = exp(-(rho * rho) / max(0.36 * coneR * coneR, 0.04));
  float t = u.resolution_time_frame.z * max(u.visualParams.x, 0.05);
  float phi = atan(pos.z, pos.x);
  vec3 jUv = vec3(cos(phi) * 0.24, ay * 0.12 - t * 1.9, sin(phi) * 0.24);
  vec4 n = textureLod(uVolumeNoise, jUv, 0.0);

  float jetSign = (pos.y >= 0.0) ? 1.0 : -1.0;
  float cosBeam = clamp(dot(normalize(rayDpos), vec3(0.0, jetSign, 0.0)), -1.0, 1.0);
  float boost = clamp(pow(1.0 / max(1.0 + 0.52 * cosBeam, 0.35), 1.65), 0.35, 3.2);
  float verticalEnv = smoothstep(rPlus * 0.7, rPlus * 2.2, ay) * (1.0 - smoothstep(14.0, 36.0, ay));
  vec3 col = mix(vec3(0.55, 0.72, 1.25), vec3(0.92, 0.78, 1.35), sheath);
  return col * ((core * 0.85 + sheath * 0.65) * (0.45 + 0.9 * n.g) * verticalEnv * boost * jetInt * 0.42 * camDistFade);
}

vec3 rotateSkyDir(vec3 d) {
  float cX = u.skyTrig.x;
  float sX = u.skyTrig.y;
  float cY = u.skyTrig.z;
  float sY = u.skyTrig.w;
  vec3 rx = vec3(d.x * cX - d.z * sX, d.y, d.x * sX + d.z * cX);
  return vec3(rx.x, rx.y * cY - rx.z * sY, rx.y * sY + rx.z * cY);
}

vec3 hash33f(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + vec3(33.33));
  return fract((q.xxy + q.yxx) * q.zyx);
}

vec3 evalMicroStarLayer(vec3 dir, float gridScale, float threshold, float boost, float fw) {
  vec3 p = dir * gridScale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);
  if (rnd.x < threshold) { return vec3(0.0); }
  vec3 local = fract(p) - (vec3(0.25) + 0.5 * rnd);
  float d2 = dot(local, local);
  float mag = (rnd.x - threshold) / (1.0 - threshold);
  float rRad = max(0.015, fw * gridScale * 0.65);
  float core = exp(-d2 / max(rRad * rRad, 0.0005));
  float specT = mix(3400.0, 21000.0, rnd.y * rnd.y);
  vec3 col = sampleBlackbody(specT);
  return col * (core * (0.1 + 2.6 * mag) * boost / (1.0 + fw * 6.0));
}

vec3 sampleSkyBackground(vec3 rawDir, bool escaped, float edgeMask) {
  vec3 dir = normalize(rotateSkyDir(rawDir));
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
  if (edgeMask > 0.01) {
    dirFw = 0.0012;
  }

  if (!escaped) {
    return vec3(0.0);
  }

  vec2 sampleUv = vec2(uv1.x, clamp(uv1.y, 0.005, 0.995));
  int skyMode = u.modes_pad.y;
  vec3 mapSrgb = (skyMode == 2)
    ? textureGrad(uProcSkyMap, sampleUv, dUVdx, dUVdy).rgb
    : textureGrad(uSkyMap, sampleUv, dUVdx, dUVdy).rgb;
  vec3 skyLin = pow(max(mapSrgb, vec3(0.0)), vec3(2.2));
  vec3 brightCores = max(skyLin - vec3(0.32), vec3(0.0));
  skyLin += brightCores * brightCores * 2.4;

  if (skyMode == 0 || skyMode == 2) {
    float starGain = (skyMode == 0) ? 0.55 : 0.95;
    skyLin += evalMicroStarLayer(dir, 105.0, 0.915, 0.95 * starGain, dirFw)
            + evalMicroStarLayer(dir, 225.0, 0.885, 0.42 * starGain, dirFw);
  }
  return skyLin * max(u.skyParams.x, 0.0);
}

void main() {
  vec2 res = max(u.resolution_time_frame.xy, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + u.jitter_fov_spin.xy;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = u.kerrConsts.w;
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  float a = clamp(u.jitter_fov_spin.w, 0.0, 0.998);
  float a2 = a * a;
  float lensing = clamp(u.camRight_lensing.w, 0.0, 1.0);
  float rPlus  = u.kerrConsts.x;
  float rIsco  = u.kerrConsts.y;
  float rOuter = u.kerrConsts.z;

  vec4 pUp = -u.zamoE0 + localRay.x * u.zamoE1 + localRay.y * u.zamoE2 + localRay.z * u.zamoE3;
  float lp = -pUp.x + dot(u.camKS_l_2H.xyz, pUp.yzw);
  float twoHL = u.camKS_l_2H.w * lp;
  float pt = -pUp.x - twoHL;
  vec3 p = pUp.yzw + twoHL * u.camKS_l_2H.xyz;
  vec3 pos = u.camPos_relMode.xyz;

  ivec2 bnCoord = ivec2(int(gl_FragCoord.x) & 127, (int(res.y) - 1 - int(gl_FragCoord.y)) & 127);
  vec4 bnRaw = texelFetch(uBlueNoise, bnCoord, 0);
  float fIdx = float(u.modes_pad.x & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  int quality = u.modes_pad.z;
  int maxSteps = 220;
  float qualScale = 1.0;
  if (quality <= 0) {
    maxSteps = 145;
    qualScale = 1.28;
  } else if (quality >= 2) {
    maxSteps = 320;
    qualScale = 0.68;
  }
  bool lowDetailBase = (quality <= 0);

  float escapeR  = u.rayConsts.x;
  float captureR = u.rayConsts.y;
  float maxSlabY = u.rayConsts.z;
  bool hasJet    = (u.streamParams.w > 0.002);

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  float rayDist = 0.0;
  bool captured = false;
  bool escaped = false;
  vec3 finalVel = localRay;

  for (int step = 0; step < 340; step++) {
    if (step >= maxSteps) break;
    GeodesicRHS k1 = evalGeodesicRHS(pos, p, pt, a, a2, lensing);
    float r = k1.f.r;
    finalVel = k1.dpos;

    if (r <= captureR) {
      captured = true;
      break;
    }

    bool outbound = (dot(pos, k1.dpos) > 0.0);
    if (outbound && r > escapeR) {
      escaped = true;
      break;
    }

    float hScale = clamp((r - 0.85 * rPlus) * 0.072, 0.045, 2.55) * qualScale;
    float maxStep = (r < 34.0) ? 1.35 : 2.6;
    float h = clamp(hScale, 0.032, maxStep);
    if (step == 0) {
      h *= mix(0.65, 1.0, bn.x);
    }

    bool useRk2 = (r > rPlus * 5.2 + 2.5);
    vec3 posNext;
    vec3 pNext;
    float rMidEst = r;

    if (!useRk2) {
      GeodesicRHS k2 = evalGeodesicRHS(pos + 0.5 * h * k1.dpos, p + 0.5 * h * k1.dp, pt, a, a2, lensing);
      GeodesicRHS k3 = evalGeodesicRHS(pos + 0.5 * h * k2.dpos, p + 0.5 * h * k2.dp, pt, a, a2, lensing);
      GeodesicRHS k4 = evalGeodesicRHS(pos + h * k3.dpos, p + h * k3.dp, pt, a, a2, lensing);
      posNext = pos + (h / 6.0) * (k1.dpos + 2.0 * k2.dpos + 2.0 * k3.dpos + k4.dpos);
      pNext   = p   + (h / 6.0) * (k1.dp   + 2.0 * k2.dp   + 2.0 * k3.dp   + k4.dp);
      rMidEst = k2.f.r;
    } else {
      GeodesicRHS k2 = evalGeodesicRHS(pos + 0.5 * h * k1.dpos, p + 0.5 * h * k1.dp, pt, a, a2, lensing);
      posNext = pos + h * k2.dpos;
      pNext   = p   + h * k2.dp;
      rMidEst = k2.f.r;
    }

    float segLen = length(posNext - pos);
    float midDist = rayDist + 0.5 * segLen;
    float camDistFade = smoothstep(0.0, 0.85, midDist);
    bool lowDet = lowDetailBase || (transmittance < 0.09);

    if (rMidEst < 38.0) {
      vec3 midPos = mix(pos, posNext, fract(bn.y + float(step) * 0.61803399));
      vec3 midP = 0.5 * (p + pNext);
      float rMid = evalKerrR(midPos, a2);

      VolSample tdeSamp = evalTidalDebris(midPos, rMid, midP, pt, rPlus, a, a2, lensing, camDistFade, lowDet);
      if (tdeSamp.extinction > 1e-6 || dot(tdeSamp.emission, tdeSamp.emission) > 1e-9) {
        float tau = tdeSamp.extinction * segLen;
        float stepT = exp(-tau);
        vec3 stepRad = (tau > 1e-4)
          ? tdeSamp.emission * ((1.0 - stepT) / max(tdeSamp.extinction, 1e-5))
          : tdeSamp.emission * segLen;
        radiance += transmittance * stepRad;
        transmittance *= stepT;
      }

      bool inSlab = (min(pos.y, posNext.y) <= maxSlabY && max(pos.y, posNext.y) >= -maxSlabY);
      if (inSlab && transmittance > 0.008 && rMid < rOuter * 1.1) {
        VolSample diskSamp = evalCircularDisk(midPos, rMid, midP, pt, rIsco, rOuter, rPlus, a, a2, lensing, camDistFade, lowDet);
        if (diskSamp.extinction > 1e-6 || dot(diskSamp.emission, diskSamp.emission) > 1e-9) {
          float tauD = diskSamp.extinction * segLen;
          float stepTD = exp(-tauD);
          vec3 stepRadD = (tauD > 1e-4)
            ? diskSamp.emission * ((1.0 - stepTD) / max(diskSamp.extinction, 1e-5))
            : diskSamp.emission * segLen;
          radiance += transmittance * stepRadD;
          transmittance *= stepTD;
        }
      }

      if (hasJet && transmittance > 0.008) {
        vec3 jPos = mix(pos, posNext, fract(bn.z + float(step) * 0.38196601));
        vec3 jEmit = evalTdeJet(jPos, k1.dpos, rPlus, camDistFade);
        radiance += transmittance * jEmit * segLen;
      }
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

  radiance = clamp(sanitizeVec3Zero(radiance), vec3(0.0), vec3(28.0));
  fragColor = vec4(radiance, 1.0);
}
`;
