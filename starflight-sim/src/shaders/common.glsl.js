/**
 * Shared WebGL2 GLSL 300 es shaders for Relativistic Starflight Simulator:
 *  - FULLSCREEN_VERT: Zero-VBO fullscreen triangle vertex shader (gl_VertexID 0..2)
 *  - NOISE_BAKE_FRAG: Exact integer-lattice periodic 3D volumetric interstellar medium noise baker
 *                     Channels: R = 3D fBM, G = 3D Ridged Filaments,
 *                               B = 3D Inverted Worley Eddies, A = High-Freq Micro-Filaments
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

// 12-edge Perlin gradient lookup from integer hash (isotropic, unit-sphere balanced)
vec3 gradFromHash(uvec3 cell, uint seed) {
  uint h = pcg3d(cell ^ uvec3(seed * 747796405u + 2891336453u, seed * 277803737u, seed * 1597334677u)).x;
  uint idx = h & 15u;
  // Standard 16 Perlin edge vectors (4 repeated cleanly for uniform bitmask)
  vec3 g;
  if (idx == 0u)       g = vec3( 1.0,  1.0,  0.0);
  else if (idx == 1u)  g = vec3(-1.0,  1.0,  0.0);
  else if (idx == 2u)  g = vec3( 1.0, -1.0,  0.0);
  else if (idx == 3u)  g = vec3(-1.0, -1.0,  0.0);
  else if (idx == 4u)  g = vec3( 1.0,  0.0,  1.0);
  else if (idx == 5u)  g = vec3(-1.0,  0.0,  1.0);
  else if (idx == 6u)  g = vec3( 1.0,  0.0, -1.0);
  else if (idx == 7u)  g = vec3(-1.0,  0.0, -1.0);
  else if (idx == 8u)  g = vec3( 0.0,  1.0,  1.0);
  else if (idx == 9u)  g = vec3( 0.0, -1.0,  1.0);
  else if (idx == 10u) g = vec3( 0.0,  1.0, -1.0);
  else if (idx == 11u) g = vec3( 0.0, -1.0, -1.0);
  else if (idx == 12u) g = vec3( 1.0,  1.0,  0.0);
  else if (idx == 13u) g = vec3(-1.0,  1.0,  0.0);
  else if (idx == 14u) g = vec3( 0.0, -1.0,  1.0);
  else                 g = vec3( 0.0, -1.0, -1.0);
  return g * 0.70710678;
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

// G: 5-octave tileable 3D Musgrave ridged multifractal for razor-crisp MRI plasma filaments
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
