/**
 * Cinema-grade WebGL2 GLSL 300 es relativistic traversable wormhole shader:
 *  - Exact Morris-Thorne spacetime ds^2 = -c^2 dt^2 + dl^2 + r(l)^2 dOmega^2
 *    * uMetricType == 0: Interstellar (James-Thorne Dneg) metric with flat throat |l| <= a
 *      and smooth arctan-log flared exterior |l| > a
 *    * uMetricType == 1: Pure Ellis drainhole r(l) = sqrt(rho^2 + l^2)
 *  - Exact great-circle null geodesic ODE integrated via adaptive RK4
 *  - Graceful photon-sphere fallback near b ~ rho (zero black ring artifact)
 *  - Dual-universe equirectangular sky sampling (Universe A 4K Milky Way + Saturn-like
 *    ringed gas giant & solar glare; Universe B Exotic Golden-Amber & Teal Nebula +
 *    binary accretion beacon)
 *  - Optional translucent 3D volumetric throat caustic halo & swirling dust filaments
 */

export const WORMHOLE_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Textures (locked unit bindings 0..4)
uniform sampler3D uVolumeNoise;   // unit 0: 128^3 periodic RGBA8 (fbm, ridged, worley, micro)
uniform sampler2D uSkyMapA;       // unit 1: 4K equirectangular Milky Way (sRGB RGBA8)
uniform sampler2D uProcSkyMapA;   // unit 2: Procedural equirectangular sky A fallback (sRGB RGBA8)
uniform sampler2D uSkyMapB;       // unit 3: Exotic Golden-Amber & Teal Nebula B (sRGB RGBA8)
uniform sampler2D uBlueNoise;     // unit 4: 128x128 RGBA8 void-and-cluster blue noise

// Viewport & temporal state
uniform vec2  uResolution;
uniform float uTime;
uniform int   uFrameIndex;
uniform vec2  uJitter;

// Camera & wormhole coordinates
uniform vec3  uCamN0;
uniform float uCamL;
uniform mat3  uCamBasis;          // col0=right, col1=up, col2=forward
uniform float uFovY;

// Wormhole metric parameters
uniform int   uMetricType;        // 0 = Interstellar (James-Thorne Dneg), 1 = Ellis drainhole
uniform float uThroatRadius;      // rho
uniform float uThroatLength;      // a (half-length of cylindrical throat)
uniform float uLensingWidth;      // M

// Throat volumetric matter & swirl
uniform float uThroatGlow;
uniform float uDustDensity;
uniform float uSwirlSpeed;

// Dual-universe sky parameters
uniform float uSkyIntensityA;
uniform float uSkyIntensityB;
uniform int   uPlanetVisible;
uniform vec2  uSkyRotationA;
uniform vec2  uSkyRotationB;
uniform int   uQuality;
uniform float uTanHalfFov;
uniform float uCamR;
uniform float uEscapeL;
uniform vec4  uSkyTrigA;
uniform vec4  uSkyTrigB;

const float PI      = 3.14159265359;
const float TAU     = 6.28318530718;
const float INV_PI  = 0.31830988618;
const float INV_TAU = 0.15915494309;

// ============================================================================
// 1. EXACT MORRIS-THORNE (JAMES-THORNE DNEG & ELLIS) METRIC & GEODESIC ODE
// ============================================================================

void evalMetric(float l, int metricType, float rho, float a, float M, out float r, out float drdl) {
  if (metricType == 1) {
    r = sqrt(rho * rho + l * l);
    drdl = l / max(r, 1e-6);
    return;
  }

  float absL = abs(l);
  if (absL <= a) {
    r = rho;
    drdl = 0.0;
    return;
  }

  float safeM = max(M, 1e-4);
  float x = (2.0 * (absL - a)) / (PI * safeM);
  float atanX = atan(x);
  r = rho + safeM * (x * atanX - 0.5 * log(1.0 + x * x));
  drdl = (l >= 0.0 ? 1.0 : -1.0) * (2.0 * INV_PI) * atanX;
}

float evalMetricR(float l, int metricType, float rho, float a, float M) {
  if (metricType == 1) {
    return sqrt(rho * rho + l * l);
  }
  float absL = abs(l);
  if (absL <= a) return rho;
  float safeM = max(M, 1e-4);
  float x = (2.0 * (absL - a)) / (PI * safeM);
  return rho + safeM * (x * atan(x) - 0.5 * log(1.0 + x * x));
}

struct GeodesicDeriv {
  float dl;
  float dpl;
  float dpsi;
  float r;
};

GeodesicDeriv evalGeodesicRHS(float l, float pl, float b, float b2, int metricType, float rho, float a, float M) {
  float r;
  float drdl;
  evalMetric(l, metricType, rho, a, M, r, drdl);
  float invR = 1.0 / max(r, 1e-5);
  float invR2 = invR * invR;
  GeodesicDeriv d;
  d.dl = pl;
  d.dpl = (b2 * invR2 * invR) * drdl;
  d.dpsi = b * invR2;
  d.r = r;
  return d;
}

// ============================================================================
// 2. VOLUMETRIC THROAT CAUSTIC HALO & SWIRLING DUST FILAMENTS
// ============================================================================

vec3 rotateAroundAxis(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
}

void evalThroatMatter(
  float l,
  float pl,
  vec3 nVec,
  float a,
  float M,
  float matterBound,
  out vec3 emission,
  out float extinction
) {
  emission = vec3(0.0);
  extinction = 0.0;

  float absL = abs(l);
  if (absL >= matterBound) return;

  float lipWidth = max(M, 0.35);
  float lipDist = max(absL - a, 0.0);

  // Smooth fade from throat interior out to matterBound
  float outerEnv = 1.0 - smoothstep(a + lipWidth * 0.4, matterBound, absL);
  float lipCenterDist = (absL - (a + 0.35 * lipWidth)) / max(lipWidth * 0.72, 0.32);
  float lipPeak = exp(-(lipCenterDist * lipCenterDist));
  float interiorEnv = smoothstep(a + 0.65 * lipWidth, max(a - 0.2, 0.0), absL);
  float env = max(outerEnv * 0.45, max(lipPeak * 0.92, interiorEnv * 0.68));
  if (env < 1e-4) return;

  // Seamless 3D periodic noise coordinates rotated coherently around throat axis (zero atan seam!)
  vec3 swirlAxis = normalize(vec3(0.18, 0.96, 0.21));
  float swirlAngle = uTime * uSwirlSpeed * 0.36 + l * 0.24;
  vec3 rotN = rotateAroundAxis(nVec, swirlAxis, swirlAngle);

  float flowT = uTime * uSwirlSpeed * 0.028;
  vec3 uvw1 = rotN * 0.78 + vec3(l * 0.11 - flowT * 0.45, flowT, -l * 0.08);
  vec4 n1 = textureLod(uVolumeNoise, uvw1, 0.0);

  vec3 uvw2 = rotN * 1.85 + vec3(n1.r * 0.18, l * 0.22 + flowT * 1.4, n1.g * 0.18);
  vec4 n2 = textureLod(uVolumeNoise, uvw2, 0.0);

  float ridgedFil = pow(clamp(n1.g * 0.58 + n2.a * 0.52, 0.0, 1.0), 1.65);
  float billow = smoothstep(0.20, 0.85, n1.r * 0.65 + n1.b * 0.35);
  float grazing = pow(clamp(1.0 - abs(pl), 0.0, 1.0), 1.45);

  // Color shift smoothly across throat: cool silver-cyan on Univ A -> warm gold-amber on Univ B
  float sideBlend = smoothstep(-0.8, 0.8, l);
  vec3 tintA = vec3(0.42, 0.76, 1.00);
  vec3 tintB = vec3(1.00, 0.68, 0.26);
  vec3 throatTint = mix(tintB, tintA, sideBlend);

  // Delicate refractive caustic halo
  if (uThroatGlow > 0.001) {
    float caustic = (0.28 + 0.72 * ridgedFil) * (0.25 + 0.85 * grazing);
    emission += throatTint * (uThroatGlow * env * caustic * 0.175);
  }

  // Swirling translucent dust filaments
  if (uDustDensity > 0.001) {
    float dustMask = pow(clamp(billow * 0.55 + ridgedFil * 0.55, 0.0, 1.0), 1.45);
    vec3 dustCol = mix(vec3(0.88, 0.52, 0.22), vec3(0.45, 0.62, 0.86), sideBlend);
    emission += dustCol * (uDustDensity * env * dustMask * (0.045 + 0.055 * grazing));
    extinction = uDustDensity * env * (0.045 + 0.24 * dustMask) * (1.0 - 0.35 * exp(-lipDist));
  }
}

// ============================================================================
// 3. DUAL-UNIVERSE SKY BACKGROUND, MICRO-STARS & ICONIC LANDMARKS
// ============================================================================

vec3 rotateSkyDirTrig(vec3 d, vec4 trig) {
  float cy = trig.x, sy = trig.y;
  vec3 r1 = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  float cp = trig.z, sp = trig.w;
  return vec3(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

vec3 hash33f(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 stellarTint(float tNorm, bool alienPalette) {
  if (alienPalette) {
    vec3 gold  = vec3(1.00, 0.68, 0.28);
    vec3 ivory = vec3(1.00, 0.94, 0.82);
    vec3 teal  = vec3(0.42, 0.92, 1.00);
    return tNorm < 0.55 ? mix(gold, ivory, tNorm / 0.55) : mix(ivory, teal, (tNorm - 0.55) / 0.45);
  }
  vec3 redK  = vec3(1.00, 0.56, 0.26);
  vec3 solG  = vec3(1.00, 0.95, 0.88);
  vec3 blueO = vec3(0.64, 0.82, 1.00);
  return tNorm < 0.5 ? mix(redK, solG, tNorm * 2.0) : mix(solG, blueO, (tNorm - 0.5) * 2.0);
}

vec3 evalMicroStarLayer(vec3 dir, float scale, float densityThresh, float boost, float pixelFw, bool alienPalette) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 rnd = hash33f(cell);

  if (rnd.x < densityThresh) return vec3(0.0);

  vec3 starPos = cell + vec3(0.22) + 0.56 * hash33f(cell + vec3(19.17, 73.41, 41.83));
  float dist = length(p - starPos);

  float magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  float mag = pow(magU, 4.4);

  float fw = clamp(pixelFw * scale, 0.018, 0.14);
  float starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  float core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) return vec3(0.0);

  float energyComp = 1.0 / (1.0 + fw * 6.0);
  vec3 col = stellarTint(pow(rnd.y, 1.35), alienPalette);
  float lum = (0.09 + 3.4 * mag) * boost * energyComp;
  return col * (core * lum);
}

// Universe A Landmark: Crisp Saturn-like ringed gas giant + distant Sun & glare
vec3 evalUniverseALandmarks(vec3 dir, float dirFw, inout float skyOcc) {
  vec3 saturnDir  = normalize(vec3(-0.18, 0.22, -0.958));
  vec3 sunDir     = normalize(vec3(-0.62, 0.30, -0.725));
  vec3 ringNormal = normalize(vec3(0.28, 0.90, 0.33));

  float saturnCos = dot(dir, saturnDir);
  vec3 saturnTotal = vec3(0.0);
  float saturnOcc = 0.0;

  if (saturnCos > 0.985) {
    float distUnits = 31.0; // Angular radius ~1/31 = 0.032 rad (~3.7 deg diameter)
    vec3 C = saturnDir * distUnits;
    float aaUnit = clamp(min(dirFw, 0.012) * distUnits, 0.014, 0.25);

    // 1. Ray-sphere test for Saturn globe
    float tCa = saturnCos * distUnits;
    float tGlobe = 1e6;
    float globeAlpha = 0.0;
    vec3 globeCol = vec3(0.0);

    vec3 perp = dir * tCa - C;
    float d2 = dot(perp, perp);
    float d = sqrt(d2);
    globeAlpha = 1.0 - smoothstep(1.0 - aaUnit, 1.0 + aaUnit, d);
    if (globeAlpha > 0.001) {
      float zHit = sqrt(max(1.0 - min(d2, 0.9999), 0.0));
      tGlobe = tCa - zHit;
      vec3 hitP = dir * tGlobe - C;
      vec3 N = normalize(hitP);

      // Subtle Saturnian latitude cloud bands
      float lat = dot(N, ringNormal);
      float band = 0.5 + 0.5 * sin(lat * 26.0 + 0.6 * sin(lat * 9.0));
      float fineBand = 0.5 + 0.5 * cos(lat * 64.0);
      vec3 baseAlbedo = mix(vec3(0.76, 0.66, 0.49), vec3(0.92, 0.85, 0.68), band * 0.72 + fineBand * 0.28);
      baseAlbedo = mix(baseAlbedo, vec3(0.55, 0.60, 0.68), smoothstep(0.76, 0.98, abs(lat)) * 0.55);

      // Ring shadow cast onto Saturn's cloud deck
      float denomShad = dot(sunDir, ringNormal);
      float ringShadow = 1.0;
      if (abs(denomShad) > 1e-4) {
        float tS = -dot(hitP, ringNormal) / denomShad;
        if (tS > 0.0) {
          float rShad = length(hitP + sunDir * tS);
          float inRingShad = smoothstep(1.30, 1.38, rShad) * (1.0 - smoothstep(2.34, 2.40, rShad));
          float cassiniDist = (rShad - 1.97) / 0.045;
          float cassiniGap = exp(-(cassiniDist * cassiniDist));
          ringShadow = 1.0 - inRingShad * (1.0 - cassiniGap * 0.85) * 0.78;
        }
      }

      float ndotl = max(dot(N, sunDir), 0.0);
      float lit = pow(ndotl, 0.86) * ringShadow;
      float fresnel = pow(clamp(1.0 - max(dot(N, -dir), 0.0), 0.0, 1.0), 3.0);
      vec3 limbGlow = vec3(0.72, 0.78, 0.88) * (fresnel * ndotl * 0.25);
      globeCol = baseAlbedo * (0.025 + 1.55 * lit) + limbGlow;
    }

    // 2. Ray-plane test for Saturn rings
    float denom = dot(dir, ringNormal);
    float tRing = 1e6;
    float ringAlpha = 0.0;
    vec3 ringCol = vec3(0.0);
    if (abs(denom) > 1e-4) {
      float tr = dot(C, ringNormal) / denom;
      if (tr > 0.0) {
        vec3 rPos = dir * tr - C;
        float rDist = length(rPos);
        float innerFade = smoothstep(1.30 - aaUnit, 1.34 + aaUnit, rDist);
        float outerFade = 1.0 - smoothstep(2.36 - aaUnit, 2.40 + aaUnit, rDist);
        float ringMask = innerFade * outerFade;
        if (ringMask > 0.001) {
          tRing = tr;
          float casW = (rDist - 1.97) / max(0.042, aaUnit * 0.5);
          float encW = (rDist - 2.27) / max(0.018, aaUnit * 0.4);
          float cassini = 1.0 - 0.94 * exp(-(casW * casW));
          float encke   = 1.0 - 0.65 * exp(-(encW * encW));
          float cRing   = mix(0.28, 1.0, smoothstep(1.32, 1.54, rDist));
          float ringlets = 0.82 + 0.18 * sin(rDist * 48.0) * cos(rDist * 19.0);
          float density = ringMask * cassini * encke * cRing * ringlets;

          // Planet shadow across rear half of rings
          float sunProj = dot(rPos, sunDir);
          float planetShadow = 1.0;
          if (sunProj < 0.0) {
            float perpSun = length(rPos - sunDir * sunProj);
            planetShadow = smoothstep(0.96, 1.05, perpSun);
          }

          vec3 rAlbedo = mix(vec3(0.74, 0.66, 0.56), vec3(0.95, 0.89, 0.77), smoothstep(1.52, 1.88, rDist));
          float sunLit = 0.03 + 1.45 * planetShadow * (0.55 + 0.45 * abs(dot(ringNormal, sunDir)));
          ringCol = rAlbedo * sunLit;
          ringAlpha = clamp(density * 0.86, 0.0, 0.94);
        }
      }
    }

    // Depth-sort globe and rings cleanly
    if (tRing < tGlobe) {
      // Ring in front of planet
      saturnTotal = ringCol * ringAlpha + globeCol * globeAlpha * (1.0 - ringAlpha);
      saturnOcc = clamp(ringAlpha + globeAlpha * (1.0 - ringAlpha), 0.0, 1.0);
    } else {
      // Planet occludes ring behind it
      saturnTotal = globeCol * globeAlpha + ringCol * ringAlpha * (1.0 - globeAlpha);
      saturnOcc = clamp(globeAlpha + ringAlpha * (1.0 - globeAlpha), 0.0, 1.0);
    }
  }

  // 3. Distant Sun photosphere disc + tight physical solar corona
  float sunCos = dot(dir, sunDir);
  vec3 sunCol = vec3(0.0);
  if (sunCos > 0.75) {
    float sunAng = atan(length(cross(dir, sunDir)), sunCos);
    float sunFw = min(dirFw, 0.009);
    float sunEnergy = min(1.0, 0.012 / max(dirFw * 1.5, 1e-4));
    float sunDisc = (1.0 - smoothstep(0.0085, 0.0115 + sunFw, sunAng)) * sunEnergy;
    float corona  = (exp(-sunAng * 56.0) * 0.72 + exp(-sunAng * 18.0) * 0.032) * (0.20 + 0.80 * sunEnergy);
    sunCol = vec3(1.00, 0.95, 0.84) * (sunDisc * 10.5 + corona);
  }

  skyOcc = 1.0 - saturnOcc;
  return saturnTotal + sunCol;
}

// Universe B Landmark: Distant glowing golden-teal accretion beacon / binary star
vec3 evalUniverseBLandmark(vec3 dir, float dirFw) {
  vec3 beaconDir = normalize(vec3(-0.72, 0.08, -0.689));
  vec3 bUp = normalize(vec3(0.24, 0.92, -0.31));
  vec3 bRight = normalize(cross(bUp, beaconDir));
  vec3 bOrthoUp = cross(beaconDir, bRight);

  vec2 rel = vec2(dot(dir, bRight), dot(dir, bOrthoUp));
  float front = smoothstep(-0.1, 0.3, dot(dir, beaconDir));
  if (front <= 0.001) return vec3(0.0);

  float angDist = length(rel);
  if (angDist > 0.30) return vec3(0.0);

  float bFw = min(dirFw, 0.008);
  float bEnergy = min(1.0, 0.012 / max(dirFw * 1.5, 1e-4));

  // Tilted luminous golden-teal accretion disk around primary beacon
  vec2 diskCoord = vec2(rel.x * 0.92 + rel.y * 0.39, (-rel.x * 0.39 + rel.y * 0.92) * 3.1);
  float rDisk = length(diskCoord);
  float d1 = (rDisk - 0.022) / max(0.0085, bFw * 1.4);
  float d2 = (rDisk - 0.036) / max(0.011, bFw * 1.6);
  float diskRing = exp(-(d1 * d1)) + 0.45 * exp(-(d2 * d2));
  vec3 diskTint = mix(vec3(1.00, 0.72, 0.24), vec3(0.18, 0.88, 0.96), smoothstep(0.014, 0.042, rDisk));

  // Primary radiant champagne-gold star core
  float primCore = exp(-(angDist * angDist) / max(0.000045 + bFw * bFw, 1e-6)) * 5.2;
  float primHalo = exp(-angDist * 26.0) * 0.55;

  // Companion hot cyan-teal star orbiting nearby
  vec2 compOffset = vec2(0.032, 0.014);
  float compDist = length(rel - compOffset);
  float compCore = exp(-(compDist * compDist) / max(0.000028 + bFw * bFw, 1e-6)) * 3.6;
  float compHalo = exp(-compDist * 34.0) * 0.38;

  // Delicate ionized plasma bridge & anamorphic glint
  vec3 col = diskTint * (diskRing * 1.45)
           + vec3(1.00, 0.86, 0.54) * (primCore + primHalo)
           + vec3(0.32, 0.94, 1.00) * (compCore + compHalo);
  return col * (front * bEnergy);
}

vec2 evalEquirectUv(vec3 dir, out vec2 uvShift) {
  float u1 = atan(dir.z, dir.x) * INV_TAU + 0.5;
  float v  = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  uvShift = vec2(fract(u1 + 0.5), v);
  return vec2(u1, v);
}

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 pixelCoord = gl_FragCoord.xy + uJitter;
  vec2 ndc = (pixelCoord / res) * 2.0 - 1.0;

  float aspect = res.x / res.y;
  float tanHalfFov = uTanHalfFov;
  if (tanHalfFov <= 1e-4) {
    tanHalfFov = tan(clamp(uFovY, 0.1, 2.8) * 0.5);
  }
  vec3 localRay = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));
  vec3 d = normalize(uCamBasis * localRay);

  vec3 n0 = normalize(uCamN0);
  float rho = max(uThroatRadius, 0.05);
  float a   = max(uThroatLength, 0.0);
  float M   = max(uLensingWidth, 1e-4);

  // Great-circle geodesic initialization
  float r0 = uCamR;
  if (r0 <= 1e-4) {
    r0 = evalMetricR(uCamL, uMetricType, rho, a, M);
  }
  float pl = dot(d, n0);
  vec3 t = d - pl * n0;
  float sinAlpha = length(t);
  vec3 tHat = t / max(sinAlpha, 1e-7);
  float b = r0 * sinAlpha;
  float b2 = b * b;

  // Blue-noise stratified dithering for smooth volumetric throat matter
  vec4 bnRaw = texelFetch(uBlueNoise, ivec2(gl_FragCoord.xy) & 127, 0);
  float fIdx = float(uFrameIndex & 1023);
  vec4 bn = fract(bnRaw + fIdx * vec4(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  // Quality tiers (step caps: Medium 140, High 220, Ultra 320)
  int maxSteps = 220;
  float qualScale = 0.92;
  if (uQuality <= 0) {
    maxSteps = 140;
    qualScale = 1.25;
  } else if (uQuality >= 2) {
    maxSteps = 320;
    qualScale = 0.68;
  }

  float escapeL = max(uEscapeL, max(abs(uCamL) * 3.0 + 40.0, a + 4.0 * max(M, 0.35) + 80.0));
  float matterBound = a + 2.8 * max(M, 0.35);
  bool hasMatter = (uThroatGlow > 0.001 || uDustDensity > 0.001);

  float l = uCamL;
  float psi = 0.0;
  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  bool escaped = false;
  GeodesicDeriv k1 = evalGeodesicRHS(l, pl, b, b2, uMetricType, rho, a, M);

  for (int step = 0; step < 320; ++step) {
    if (step >= maxSteps) break;

    float r = k1.r;
    float absL = abs(l);

    if (absL >= escapeL - 1e-3 && (l * pl) > 0.0) {
      escaped = true;
      break;
    }

    float distEdge = absL - a;
    float curvScale = (uMetricType == 0) ? max(M, 0.35) : rho;
    float h;

    bool inCylThroat = (uMetricType == 0 && absL <= a);
    if (inCylThroat) {
      float wallDist = (pl > 0.0) ? (a - l) : (l + a);
      h = max(0.08, min(0.50 * rho * qualScale, wallDist + 0.05));
      if (abs(pl) < 0.08) {
        h = min(h, 0.42 * rho);
      }
    } else {
      h = (0.14 * r + 0.08 * curvScale) * qualScale;
      if (distEdge < 2.5 * curvScale) {
        h = min(h, (0.06 * rho + 0.09 * max(distEdge, 0.0) + 0.04 * curvScale) * qualScale);
      }
      if ((l * pl) > 0.0 && r > 2.5 * rho && distEdge > 2.5 * curvScale) {
        h = max(h, 0.30 * r * qualScale);
      }
      h = clamp(h, 0.03 * qualScale, 18.0);
      if ((l * pl) > 0.0 && abs(pl) > 1e-4) {
        float remL = escapeL - absL;
        if (remL > 0.0 && abs(pl) * h > remL) {
          h = remL / abs(pl);
        }
      }
    }

    if (step == 0 && hasMatter && absL < matterBound) {
      h *= (0.55 + 0.45 * bn.x);
    }

    // Hybrid integrator: safe cylindrical throat / weak-exterior RK2 / strong-field RK4 + FSAL
    float lNext;
    float plNext;
    float psiNext;
    GeodesicDeriv kNext;
    if (inCylThroat && abs(l + h * pl) <= a) {
      lNext   = l + h * pl;
      plNext  = pl;
      psiNext = psi + h * k1.dpsi;
      kNext   = k1;
    } else if (!inCylThroat && r > 3.0 * rho && distEdge > 2.5 * curvScale) {
      GeodesicDeriv k2 = evalGeodesicRHS(l + 0.5 * h * k1.dl, pl + 0.5 * h * k1.dpl, b, b2, uMetricType, rho, a, M);
      lNext   = l   + h * k2.dl;
      plNext  = pl  + h * k2.dpl;
      psiNext = psi + h * k2.dpsi;
      kNext   = evalGeodesicRHS(lNext, plNext, b, b2, uMetricType, rho, a, M);
    } else {
      GeodesicDeriv k2 = evalGeodesicRHS(l + 0.5 * h * k1.dl, pl + 0.5 * h * k1.dpl, b, b2, uMetricType, rho, a, M);
      GeodesicDeriv k3 = evalGeodesicRHS(l + 0.5 * h * k2.dl, pl + 0.5 * h * k2.dpl, b, b2, uMetricType, rho, a, M);
      GeodesicDeriv k4 = evalGeodesicRHS(l + h * k3.dl,       pl + h * k3.dpl,       b, b2, uMetricType, rho, a, M);

      lNext   = l   + (h / 6.0) * (k1.dl   + 2.0 * k2.dl   + 2.0 * k3.dl   + k4.dl);
      plNext  = pl  + (h / 6.0) * (k1.dpl  + 2.0 * k2.dpl  + 2.0 * k3.dpl  + k4.dpl);
      psiNext = psi + (h / 6.0) * (k1.dpsi + 2.0 * k2.dpsi + 2.0 * k3.dpsi + k4.dpsi);
      kNext   = evalGeodesicRHS(lNext, plNext, b, b2, uMetricType, rho, a, M);
    }

    // Volumetric Throat Matter (pure vacuum when throatGlow <= 0.001 && dustDensity <= 0.001)
    if (hasMatter && transmittance > 0.004) {
      float segMinL = min(l, lNext);
      float segMaxL = max(l, lNext);
      if (segMinL < matterBound && segMaxL > -matterBound) {
        int nSub = (h > 0.45) ? 2 : 1;
        float rMidSeg = max(0.5 * (r + kNext.r), rho);
        float totalDs = length(vec2(lNext - l, rMidSeg * (psiNext - psi)));
        float dsSub = totalDs / float(nSub);
        float jitBase = fract(bn.y + float(step) * 0.61803399);

        for (int s = 0; s < 2; ++s) {
          if (s >= nSub) break;
          float frac = (float(s) + jitBase) / float(nSub);
          float lSub = mix(l, lNext, frac);
          float plSub = mix(pl, plNext, frac);
          float psiSub = mix(psi, psiNext, frac);
          vec3 nSubVec = normalize(cos(psiSub) * n0 + sin(psiSub) * tHat);

          vec3 emit;
          float ext;
          evalThroatMatter(lSub, plSub, nSubVec, a, M, matterBound, emit, ext);
          if (ext > 1e-6 || dot(emit, emit) > 1e-10) {
            float tau = ext * dsSub;
            float stepT = exp(-tau);
            vec3 stepRad = emit * dsSub;
            if (tau > 1e-4) {
              stepRad = emit * ((1.0 - stepT) / max(ext, 1e-5));
            }
            radiance += transmittance * stepRad;
            transmittance *= stepT;
          }
        }
      }
    }

    l = lNext;
    pl = plNext;
    psi = psiNext;
    k1 = kNext;

    if (transmittance < 0.004) break;
  }

  if (!escaped && abs(l) >= escapeL - 1e-2 && (l * pl) > 0.0) {
    escaped = true;
  }

  // Determine final universe side (if step cap hit inside flat throat, use propagation sign)
  float finalSideSign = (abs(l) <= a && abs(pl) > 1e-4)
    ? (pl >= 0.0 ? 1.0 : -1.0)
    : (l >= 0.0 ? 1.0 : -1.0);
  bool onSideA = (finalSideSign > 0.0);

  // Orientation-preserving sky direction with asymptotic flat-space escape angle:
  // nPsi = cos(psiFinal)*n0 + sin(psiFinal)*tHat; radial component flips via sign(l) across throat while
  // tangential orientation preserves 3D handedness so Universe B views & camera controls stay natural.
  float psiFinal = psi;
  if ((l * pl) > 0.0) {
    float rEnd = k1.r;
    psiFinal += atan(b / max(rEnd, 1e-5), abs(pl));
  }
  vec3 nPsi = cos(psiFinal) * n0 + sin(psiFinal) * tHat;
  vec3 dSky = onSideA ? nPsi : (nPsi - 2.0 * dot(nPsi, n0) * n0);
  dSky = normalize(dSky);

  vec4 trigA = uSkyTrigA;
  if (dot(trigA, trigA) <= 0.5) {
    trigA = vec4(cos(uSkyRotationA.x), sin(uSkyRotationA.x), cos(uSkyRotationA.y), sin(uSkyRotationA.y));
  }
  vec4 trigB = uSkyTrigB;
  if (dot(trigB, trigB) <= 0.5) {
    trigB = vec4(cos(uSkyRotationB.x), sin(uSkyRotationB.x), cos(uSkyRotationB.y), sin(uSkyRotationB.y));
  }

  vec3 dirA = normalize(rotateSkyDirTrig(dSky, trigA));
  vec3 dirB = normalize(rotateSkyDirTrig(dSky, trigB));

  // Compute screen-space equirectangular UV gradients & silhouette mask in uniform control flow
  vec2 uvA2, uvB2;
  vec2 uvA = evalEquirectUv(dirA, uvA2);
  vec2 uvB = evalEquirectUv(dirB, uvB2);

  vec2 dxA1 = dFdx(uvA),  dyA1 = dFdy(uvA);
  vec2 dxA2 = dFdx(uvA2), dyA2 = dFdy(uvA2);
  vec2 dUVdxA = vec2(abs(dxA1.x) < abs(dxA2.x) ? dxA1.x : dxA2.x, dxA1.y);
  vec2 dUVdyA = vec2(abs(dyA1.x) < abs(dyA2.x) ? dyA1.x : dyA2.x, dyA1.y);

  vec2 dxB1 = dFdx(uvB),  dyB1 = dFdy(uvB);
  vec2 dxB2 = dFdx(uvB2), dyB2 = dFdy(uvB2);
  vec2 dUVdxB = vec2(abs(dxB1.x) < abs(dxB2.x) ? dxB1.x : dxB2.x, dxB1.y);
  vec2 dUVdyB = vec2(abs(dyB1.x) < abs(dyB2.x) ? dyB1.x : dyB2.x, dyB1.y);

  float sideFlag = onSideA ? 1.0 : 0.0;
  float edgeMask = fwidth(sideFlag) + (!escaped ? 1.0 : 0.0);
  float dirFwA = length(fwidth(dirA));
  float dirFwB = length(fwidth(dirB));

  if (edgeMask > 0.01) {
    dUVdxA = vec2(0.004, 0.0);
    dUVdyA = vec2(0.0, 0.004);
    dUVdxB = vec2(0.004, 0.0);
    dUVdyB = vec2(0.0, 0.004);
    dirFwA = 0.025;
    dirFwB = 0.025;
  } else {
    dUVdxA = clamp(dUVdxA, vec2(-0.045), vec2(0.045));
    dUVdyA = clamp(dUVdyA, vec2(-0.045), vec2(0.045));
    dUVdxB = clamp(dUVdxB, vec2(-0.045), vec2(0.045));
    dUVdyB = clamp(dUVdyB, vec2(-0.045), vec2(0.045));
  }

  vec2 sampleUvA = vec2(uvA.x, clamp(uvA.y, 0.005, 0.995));
  vec2 sampleUvB = vec2(uvB.x, clamp(uvB.y, 0.005, 0.995));

  vec3 skyColor = vec3(0.0);
  if (onSideA) {
    vec3 texA     = textureGrad(uSkyMapA, sampleUvA, dUVdxA, dUVdyA).rgb;
    vec3 procTexA = textureGrad(uProcSkyMapA, sampleUvA, dUVdxA, dUVdyA).rgb;
    vec3 srgbA = mix(texA, procTexA, 0.015);
    vec3 skyLinA = pow(max(srgbA, vec3(0.0)), vec3(2.2));
    vec3 coresA = max(skyLinA - vec3(0.32), vec3(0.0));
    skyLinA += coresA * coresA * 2.4;
    skyLinA += evalMicroStarLayer(dirA, 110.0, 0.915, 0.55, dirFwA, false)
             + evalMicroStarLayer(dirA, 230.0, 0.885, 0.26, dirFwA, false);
    skyLinA *= max(uSkyIntensityA, 0.0);

    if (uPlanetVisible == 1) {
      float skyOcc = 1.0;
      vec3 landmarkA = evalUniverseALandmarks(dirA, dirFwA, skyOcc);
      skyLinA = skyLinA * skyOcc + landmarkA;
    }
    skyColor = skyLinA;
  } else {
    vec3 texB = textureGrad(uSkyMapB, sampleUvB, dUVdxB, dUVdyB).rgb;
    vec3 skyLinB = pow(max(texB, vec3(0.0)), vec3(2.2));
    vec3 coresB = max(skyLinB - vec3(0.28), vec3(0.0));
    skyLinB += coresB * coresB * 2.2;
    skyLinB += evalMicroStarLayer(dirB, 102.0, 0.900, 0.82, dirFwB, true)
             + evalMicroStarLayer(dirB, 215.0, 0.870, 0.44, dirFwB, true);
    skyLinB *= max(uSkyIntensityB, 0.0);

    if (uPlanetVisible == 1) {
      skyLinB += evalUniverseBLandmark(dirB, dirFwB);
    }
    skyColor = skyLinB;
  }

  radiance += transmittance * skyColor;

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
