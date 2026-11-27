/**
 * Shared WebGL2 GLSL 300 es shaders for the Interstellar Spacetime Simulators:
 *  - FULLSCREEN_VERT: Zero-VBO fullscreen triangle vertex shader (gl_VertexID 0..2)
 *  - NOISE_BAKE_FRAG: Exact integer-lattice periodic 3D volumetric plasma/dust noise baker
 *                     Channels: R = 3D fBM, G = 3D Ridged Filaments,
 *                               B = 3D Inverted Worley Eddies, A = High-Freq Micro-Filaments
 *  - SKY_BAKE_FRAG:   GPU Universe A (Milky Way) & Universe B (Golden-Amber/Teal Nebula) baker
 */

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  // Single oversized triangle covering NDC [-1, 1]^2 with vUv in [0, 1]^2
  vec2 pos = vec2(
    float((gl_VertexID & 1) << 2) - 1.0,
    float((gl_VertexID & 2) << 1) - 1.0
  );
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const NOISE_BAKE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform float uSliceZ;
uniform float uSize;

// High-quality 3D integer PCG hash (zero directional bias, exact across periodic boundaries)
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

vec3 hash33u(uvec3 cell, uint seed) {
  uvec3 h = pcg3d(cell ^ uvec3(seed, seed * 374761393u + 17u, seed * 668265263u + 53u));
  return vec3(h) * (1.0 / 4294967295.0);
}

// 12-edge Perlin gradient lookup from integer hash (branchless bit-packed vectors)
vec3 gradFromHash(uvec3 cell, uint seed) {
  uint h = pcg3d(cell ^ uvec3(seed * 747796405u + 2891336453u, seed * 277803737u, seed * 1597334677u)).x;
  uint shift = (h & 15u) << 1u;
  uvec3 bits = (uvec3(0x52552222u, 0x0a22550au, 0x250a0a55u) >> shift) & 3u;
  return (vec3(bits) - vec3(1.0)) * 0.70710678;
}

// Wrap signed integer lattice coordinate into [0, period - 1]
uvec3 wrapCell(ivec3 c, int period) {
  ivec3 w = c % period;
  w += ivec3(lessThan(w, ivec3(0))) * period;
  return uvec3(w);
}

// Exact tileable 3D Perlin gradient noise with integer lattice period in [-1, 1]
float perlinPeriodic3D(vec3 uvw, int period, uint seed) {
  vec3 p = uvw * float(period);
  ivec3 i0 = ivec3(floor(p));
  vec3 f = fract(p);

  // C2-continuous quintic Hermite fade
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  uvec3 c000 = wrapCell(i0 + ivec3(0, 0, 0), period);
  uvec3 c100 = wrapCell(i0 + ivec3(1, 0, 0), period);
  uvec3 c010 = wrapCell(i0 + ivec3(0, 1, 0), period);
  uvec3 c110 = wrapCell(i0 + ivec3(1, 1, 0), period);
  uvec3 c001 = wrapCell(i0 + ivec3(0, 0, 1), period);
  uvec3 c101 = wrapCell(i0 + ivec3(1, 0, 1), period);
  uvec3 c011 = wrapCell(i0 + ivec3(0, 1, 1), period);
  uvec3 c111 = wrapCell(i0 + ivec3(1, 1, 1), period);

  float n000 = dot(gradFromHash(c000, seed), f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(gradFromHash(c100, seed), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(gradFromHash(c010, seed), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(gradFromHash(c110, seed), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(gradFromHash(c001, seed), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(gradFromHash(c101, seed), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(gradFromHash(c011, seed), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(gradFromHash(c111, seed), f - vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);

  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);

  // Scale slightly so 3D Perlin fills [-1, 1] generously
  return clamp(mix(nxy0, nxy1, u.z) * 1.38, -1.0, 1.0);
}

// Exact tileable 3D Worley cellular noise returning vec2(F1, F2 - F1)
vec2 worleyPeriodic3D(vec3 uvw, int period, uint seed) {
  vec3 p = uvw * float(period);
  ivec3 baseCell = ivec3(floor(p));
  vec3 fracPos = fract(p);

  float minD1 = 8.0;
  float minD2 = 8.0;

  for (int dz = -1; dz <= 1; ++dz) {
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        ivec3 offset = ivec3(dx, dy, dz);
        uvec3 wrapped = wrapCell(baseCell + offset, period);
        vec3 jitter = hash33u(wrapped, seed);
        vec3 diff = vec3(offset) + jitter - fracPos;
        float d2 = dot(diff, diff);
        if (d2 < minD1) {
          minD2 = minD1;
          minD1 = d2;
        } else if (d2 < minD2) {
          minD2 = d2;
        }
      }
    }
  }

  float f1 = sqrt(minD1);
  float f2 = sqrt(minD2);
  return vec2(f1, f2 - f1);
}

// R: 5-octave tileable 3D fBM for volumetric plasma density & dust billows
float bakeFbm(vec3 uvw, float nyquistLimit) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  int period = 4;

  for (int i = 0; i < 5; ++i) {
    if (float(period) > nyquistLimit) break;
    float n = perlinPeriodic3D(uvw, period, 101u + uint(i) * 37u);
    sum += amp * (n * 0.5 + 0.5);
    norm += amp;
    amp *= 0.52;
    period *= 2;
  }

  float v = sum / max(norm, 1e-5);
  // Gentle S-curve contrast without clipping tails
  return clamp(smoothstep(0.14, 0.86, v), 0.0, 1.0);
}

// G: 5-octave tileable 3D Musgrave ridged multifractal for razor-crisp plasma filaments
float bakeRidged(vec3 uvw, float nyquistLimit) {
  float sum = 0.0;
  float amp = 0.52;
  float weight = 1.0;
  float norm = 0.0;
  int period = 4;

  for (int i = 0; i < 5; ++i) {
    if (float(period) > nyquistLimit) break;
    float n = perlinPeriodic3D(uvw, period, 409u + uint(i) * 53u);
    float ridge = 1.0 - abs(n);
    ridge = ridge * ridge;
    ridge *= weight;
    weight = clamp(ridge * 1.65, 0.15, 1.0);
    sum += ridge * amp;
    norm += amp;
    amp *= 0.54;
    period *= 2;
  }

  return clamp(sum / max(norm, 1e-5), 0.0, 1.0);
}

// B: 3-octave tileable 3D inverted Worley cellular turbulent eddies
float bakeWorley(vec3 uvw, float nyquistLimit) {
  float sum = 0.0;
  float amp = 0.58;
  float norm = 0.0;
  int period = 4;

  for (int i = 0; i < 3; ++i) {
    if (float(period) > nyquistLimit) break;
    vec2 w = worleyPeriodic3D(uvw, period, 733u + uint(i) * 89u);
    float cell = clamp(1.0 - w.x * 1.05, 0.0, 1.0);
    // Combine rounded convective cell core with crisp boundary emphasis
    float eddy = pow(cell, 1.35) * 0.82 + smoothstep(0.0, 0.28, w.y) * 0.18;
    sum += amp * eddy;
    norm += amp;
    amp *= 0.48;
    period *= 2;
  }

  return clamp(sum / max(norm, 1e-5), 0.0, 1.0);
}

// A: High-frequency tileable micro-filament striations (periods 16 -> 64)
float bakeMicro(vec3 uvw, float nyquistLimit) {
  float sum = 0.0;
  float amp = 0.55;
  float norm = 0.0;
  int period = 16;

  for (int i = 0; i < 3; ++i) {
    if (float(period) > nyquistLimit) break;
    float p = perlinPeriodic3D(uvw, period, 977u + uint(i) * 113u);
    float ridge = 1.0 - abs(p);
    float signal = mix(p * 0.5 + 0.5, ridge * ridge, 0.65);
    sum += amp * signal;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }

  return clamp(sum / max(norm, 1e-5), 0.0, 1.0);
}

void main() {
  float safeSize = max(uSize, 32.0);
  // Keep frequencies safely below Nyquist of the 3D volume texture
  float nyquistLimit = safeSize * 0.55;
  vec3 uvw = vec3(vUv, fract(uSliceZ));

  float chFbm    = bakeFbm(uvw, nyquistLimit);
  float chRidged = bakeRidged(uvw, nyquistLimit);
  float chWorley = bakeWorley(uvw, nyquistLimit);
  float chMicro  = bakeMicro(uvw, nyquistLimit);

  fragColor = vec4(chFbm, chRidged, chWorley, chMicro);
}
`;

export const SKY_BAKE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform int uUniverse;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float skyHash3(ivec3 p) {
  uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u + uint(p.z) * 2147483647u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) * 2.3283064365386963e-10;
}

float valueNoise3D(vec3 p) {
  ivec3 ip = ivec3(floor(p));
  vec3 t = p - vec3(ip);
  vec3 f = t * t * (3.0 - 2.0 * t);

  float c000 = skyHash3(ip + ivec3(0, 0, 0));
  float c100 = skyHash3(ip + ivec3(1, 0, 0));
  float c010 = skyHash3(ip + ivec3(0, 1, 0));
  float c110 = skyHash3(ip + ivec3(1, 1, 0));
  float c001 = skyHash3(ip + ivec3(0, 0, 1));
  float c101 = skyHash3(ip + ivec3(1, 0, 1));
  float c011 = skyHash3(ip + ivec3(0, 1, 1));
  float c111 = skyHash3(ip + ivec3(1, 1, 1));

  float x00 = mix(c000, c100, f.x);
  float x10 = mix(c010, c110, f.x);
  float x01 = mix(c001, c101, f.x);
  float x11 = mix(c011, c111, f.x);

  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

float fbm3D_3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * valueNoise3D(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.07;
  }
  return sum / norm;
}

float fbm3D_4(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amp * valueNoise3D(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.07;
  }
  return sum / norm;
}

vec4 starHash4(ivec3 cell, int salt) {
  uvec3 c = uvec3(cell + ivec3(salt * 131, salt * 277, salt * 521));
  uvec3 v = c * uvec3(1664525u, 22695477u, 2891336453u) + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  uint w = v.x ^ v.y ^ v.z;
  return vec4(float(v.x), float(v.y), float(v.z), float(w)) * 2.3283064365e-10;
}

vec3 spectralRgb(float uTemp, bool warmBias) {
  float tempK;
  if (warmBias) {
    if (uTemp < 0.08) tempK = 22000.0;
    else if (uTemp < 0.25) tempK = 9500.0;
    else if (uTemp < 0.62) tempK = 5600.0;
    else tempK = 3500.0;
  } else {
    if (uTemp < 0.06) tempK = 24000.0;
    else if (uTemp < 0.22) tempK = 10000.0;
    else if (uTemp < 0.48) tempK = 6500.0;
    else if (uTemp < 0.78) tempK = 4500.0;
    else tempK = 3100.0;
  }
  float t = tempK * 0.01;
  float r;
  float g;
  float b;
  if (t <= 66.0) {
    r = 1.0;
    g = 0.39008158 * log(max(1.0, t)) - 0.63184144;
    b = (t <= 19.0) ? 0.0 : (0.54320679 * log(max(1.0, t - 10.0)) - 1.19625409);
  } else {
    r = 1.29293619 * pow(t - 60.0, -0.13320476);
    g = 1.12989086 * pow(t - 60.0, -0.07551485);
    b = 1.0;
  }
  vec3 s = clamp(vec3(r, g, b), 0.0, 1.0);
  vec3 lin = pow(s, vec3(2.2));
  return lin / max(max(lin.r, lin.g), max(lin.b, 1e-6));
}

vec3 evalStarGrid(vec3 dir, float freq, float density, float gain, int salt, bool warmBias) {
  vec3 p = dir * freq;
  ivec3 cell = ivec3(floor(p));
  vec4 h = starHash4(cell, salt);
  if (h.w > density) {
    return vec3(0.0);
  }
  vec3 starWorld = normalize((vec3(cell) + vec3(0.24) + h.xyz * 0.52) / freq);
  float chord = length(dir - starWorld);
  float radiusRad = (h.w < density * 0.14) ? 0.0038 : 0.0022;
  float d = chord / radiusRad;
  float w = exp(-d * d * 2.1);
  if (w < 0.008) {
    return vec3(0.0);
  }
  float uBright = max(h.w / max(density, 1e-5), 0.002);
  float bright = min(7.5, gain * pow(uBright, -0.76));
  vec3 tint = spectralRgb(fract(h.x * 13.7 + h.y * 7.3), warmBias);
  return tint * (bright * w);
}

vec3 bakeUniverseA(vec3 dir) {
  float tilt = 60.0 * PI / 180.0;
  float cosTilt = cos(tilt);
  float sinTilt = sin(tilt);
  float yaw = 0.55;
  float cosYaw = cos(yaw);
  float sinYaw = sin(yaw);

  float rx = dir.x * cosYaw - dir.z * sinYaw;
  float rz = dir.x * sinYaw + dir.z * cosYaw;
  float gx = rx;
  float gy = dir.y * cosTilt - rz * sinTilt;
  float gz = dir.y * sinTilt + rz * cosTilt;

  float bandDist2 = gy * gy;
  float bandProfile = exp(-bandDist2 * 26.0);
  float wideGlow = exp(-bandDist2 * 5.2);

  float bulgeDot = max(0.0, gx);
  float bulge = bulgeDot * bulgeDot * bulgeDot * exp(-bandDist2 * 14.0);

  float cloudNoise = fbm3D_4(vec3(gx * 3.4 + 4.1, gy * 5.5 - 1.7, gz * 3.4 + 2.3));
  float fineCloud = fbm3D_3(vec3(gx * 9.5 - 2.2, gy * 12.0 + 3.8, gz * 9.5 + 1.1));
  float dustFbm = fbm3D_4(vec3(gx * 7.2 + 11.4, gy * 16.0 - 5.2, gz * 7.2 - 3.6));

  float riftCoord = (gy - (cloudNoise - 0.5) * 0.08) * 18.0;
  float riftBand = exp(-riftCoord * riftCoord);
  float dustExtinction = max(
    0.18,
    1.0 - riftBand * (0.45 + 0.5 * smoothstep(0.0, 1.0, (dustFbm - 0.35) * 2.2))
  );

  float baseIntensity = (
    bandProfile * (0.045 + 0.095 * cloudNoise * fineCloud) +
    wideGlow * 0.012 * cloudNoise +
    bulge * (0.09 + 0.08 * fineCloud)
  ) * dustExtinction;

  float coreWarmth = min(1.0, bulge * 1.4 + 0.15);
  float nebCool = max(0.0, fineCloud - 0.55) * bandProfile * 0.045;
  float nebWarm = max(0.0, cloudNoise - 0.58) * bulge * 0.05;

  vec3 col = vec3(0.0008, 0.0010, 0.0016)
    + baseIntensity * mix(vec3(0.72, 0.84, 1.12), vec3(1.18, 0.96, 0.72), coreWarmth)
    + nebWarm * vec3(1.1, 0.55, 0.25)
    + nebCool * vec3(0.35, 0.65, 1.25);

  vec3 gDir = vec3(gx, gy, gz);
  float bandWeight = exp(-gy * gy * 18.0);
  col += evalStarGrid(gDir, 56.0, 0.22 * bandWeight + 0.07, 0.055, 11, false);
  col += evalStarGrid(gDir, 102.0, 0.18 * bandWeight + 0.06, 0.036, 37, false);
  col += evalStarGrid(gDir, 168.0, 0.14 * bandWeight + 0.05, 0.025, 73, false);

  float shoulder = 0.35;
  return col / (vec3(1.0) + col * shoulder);
}

vec3 bakeUniverseB(vec3 dir) {
  vec3 f = normalize(vec3(-0.886, -0.171, -0.430));
  vec3 upRef = vec3(0.36, 0.88, -0.31);
  vec3 rAxis = normalize(cross(upRef, f));
  vec3 uAxis = cross(f, rAxis);

  float nx = dot(dir, rAxis);
  float ny = dot(dir, uAxis);
  float nz = dot(dir, f);

  float warpA = fbm3D_3(vec3(nx * 2.8 + 1.3, ny * 2.8 - 0.8, nz * 2.8 + 3.1)) - 0.5;
  float wx = nx + warpA * 0.48;
  float wy = ny - warpA * 0.34;
  float wz = nz + warpA * 0.28;

  float cloudBase = fbm3D_4(vec3(wx * 3.4 + 7.2, wy * 4.2 - 2.4, wz * 3.4 + 5.6));
  float fineFbm = fbm3D_3(vec3(wx * 9.8 - 3.3, wy * 11.4 + 4.9, wz * 9.8 + 2.1));

  float rawRidge = 1.0 - abs(fineFbm * 2.0 - 1.0);
  float ridge = rawRidge * rawRidge * rawRidge;

  float bandDist = ny + warpA * 0.24;
  float bandEnv = exp(-bandDist * bandDist * 16.0);
  float wideTealHalo = exp(-bandDist * bandDist * 4.2);

  float heartDot = max(0.0, nz * 0.84 + 0.16);
  float heartFocus = heartDot * heartDot * heartDot * (0.28 + 0.72 * bandEnv);

  float pillarField = cloudBase * 0.52 + fineFbm * 0.48;
  float pillarCore = smoothstep(0.0, 1.0, (pillarField - 0.54) * 5.0) * (0.25 + 0.75 * bandEnv);
  float dustTransmit = 1.0 - pillarCore * 0.90;
  float pillarRim = smoothstep(0.0, 1.0, (pillarField - 0.48) * 11.0)
    * (1.0 - smoothstep(0.0, 1.0, (pillarField - 0.57) * 9.0))
    * bandEnv;

  float ionBalance = smoothstep(0.0, 1.0, (cloudBase - 0.44) * 4.2);

  float goldCore = heartFocus * (0.14 + 0.78 * ionBalance)
    + bandEnv * ridge * (0.18 + 0.44 * ionBalance);
  float goldWeight = goldCore * dustTransmit + pillarRim * 0.56;

  float tealPockets = (1.0 - ionBalance * 0.75) * smoothstep(0.0, 1.0, (fineFbm - 0.30) * 2.8);
  float tealWeight = (
    wideTealHalo * 0.055 * (0.4 + 0.6 * tealPockets) +
    bandEnv * (0.16 * tealPockets + 0.34 * ridge * (1.0 - ionBalance * 0.6))
  ) * (0.22 + 0.78 * dustTransmit);

  vec3 col = vec3(0.0007, 0.0016, 0.0032)
    + goldWeight * vec3(1.15, 0.46, 0.05)
    + tealWeight * vec3(0.025, 0.52, 0.68);

  float coreSpark = max(0.0, cloudBase - 0.58) * heartFocus * dustTransmit;
  col += coreSpark * vec3(0.95, 0.58, 0.18);

  vec3 bDir = vec3(nx, ny, nz);
  float bandWeight = exp(-ny * ny * 12.5);
  float clusterWeight = smoothstep(0.76, 0.96, nz);
  col += evalStarGrid(bDir, 54.0, 0.25 * bandWeight + 0.36 * clusterWeight + 0.07, 0.075, 19, true);
  col += evalStarGrid(bDir, 98.0, 0.22 * bandWeight + 0.30 * clusterWeight + 0.06, 0.048, 53, true);
  col += evalStarGrid(bDir, 162.0, 0.16 * bandWeight + 0.20 * clusterWeight + 0.05, 0.030, 89, true);

  float shoulder = 0.42;
  return col / (vec3(1.0) + col * shoulder);
}

vec3 linearToSrgb(vec3 lin) {
  vec3 c = clamp(lin, 0.0, 1.0);
  vec3 lo = 12.92 * c;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055;
  bvec3 mask = lessThanEqual(c, vec3(0.0031308));
  return clamp(mix(hi, lo, vec3(mask)), 0.0, 1.0);
}

void main() {
  float phi = vUv.x * TAU;
  float theta = vUv.y * PI;
  float sinTheta = sin(theta);
  float cosTheta = cos(theta);
  vec3 dir = vec3(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));

  vec3 hdrLin = (uUniverse == 1) ? bakeUniverseB(dir) : bakeUniverseA(dir);
  fragColor = vec4(linearToSrgb(hdrLin), 1.0);
}
`;
