/**
 * Shared WebGPU WGSL shaders for the Interstellar Spacetime Simulators:
 *  - FULLSCREEN_VERT_WGSL: Zero-VBO fullscreen triangle vertex shader (@builtin(vertex_index) 0..2)
 *  - MIPMAP_WGSL: GPU bilinear 2D mipmap generator shader for equirectangular sky maps
 *  - NOISE_BAKE_COMPUTE_WGSL: Compute shader baking the entire 128^3 periodic 3D noise volume
 *      Channels: R = 3D fBM, G = 3D Ridged Filaments,
 *                B = 3D Inverted Worley Eddies, A = High-Freq Micro-Filaments
 */

export const FULLSCREEN_VERT_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  // Single oversized triangle covering NDC [-1, 1]^2 with uv in [0, 1]^2 (top-left origin)
  let x = f32((vid & 1u) << 2u) - 1.0;
  let y = f32((vid & 2u) << 1u) - 1.0;
  var out: VSOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}
`;

export const MIPMAP_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, srcSampler, in.uv, 0.0);
}
`;

export const NOISE_BAKE_COMPUTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var outVol: texture_storage_3d<rgba8unorm, write>;

// High-quality 3D integer PCG hash (zero directional bias, exact across periodic boundaries)
fn pcg3d(vIn: vec3u) -> vec3u {
  var v = vIn * 1664525u + vec3u(1013904223u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v = v ^ (v >> vec3u(16u));
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

fn hash33u(cell: vec3u, seed: u32) -> vec3f {
  let h = pcg3d(cell ^ vec3u(seed, seed * 374761393u + 17u, seed * 668265263u + 53u));
  return vec3f(h) * (1.0 / 4294967295.0);
}

// 12-edge Perlin gradient lookup from integer hash (isotropic, unit-sphere balanced)
fn gradFromHash(cell: vec3u, seed: u32) -> vec3f {
  let h = pcg3d(cell ^ vec3u(seed * 747796405u + 2891336453u, seed * 277803737u, seed * 1597334677u)).x;
  let idx = h & 15u;
  var g: vec3f;
  switch (idx) {
    case 0u:  { g = vec3f( 1.0,  1.0,  0.0); }
    case 1u:  { g = vec3f(-1.0,  1.0,  0.0); }
    case 2u:  { g = vec3f( 1.0, -1.0,  0.0); }
    case 3u:  { g = vec3f(-1.0, -1.0,  0.0); }
    case 4u:  { g = vec3f( 1.0,  0.0,  1.0); }
    case 5u:  { g = vec3f(-1.0,  0.0,  1.0); }
    case 6u:  { g = vec3f( 1.0,  0.0, -1.0); }
    case 7u:  { g = vec3f(-1.0,  0.0, -1.0); }
    case 8u:  { g = vec3f( 0.0,  1.0,  1.0); }
    case 9u:  { g = vec3f( 0.0, -1.0,  1.0); }
    case 10u: { g = vec3f( 0.0,  1.0, -1.0); }
    case 11u: { g = vec3f( 0.0, -1.0, -1.0); }
    case 12u: { g = vec3f( 1.0,  1.0,  0.0); }
    case 13u: { g = vec3f(-1.0,  1.0,  0.0); }
    case 14u: { g = vec3f( 0.0, -1.0,  1.0); }
    default:  { g = vec3f( 0.0, -1.0, -1.0); }
  }
  return g * 0.70710678;
}

// Wrap signed integer lattice coordinate into [0, period - 1]
fn wrapCell(c: vec3i, period: i32) -> vec3u {
  let p = vec3i(period);
  let w = ((c % p) + p) % p;
  return vec3u(w);
}

// Exact tileable 3D Perlin gradient noise with integer lattice period in [-1, 1]
fn perlinPeriodic3D(uvw: vec3f, period: i32, seed: u32) -> f32 {
  let p = uvw * f32(period);
  let i0 = vec3i(floor(p));
  let f = fract(p);

  // C2-continuous quintic Hermite fade
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let c000 = wrapCell(i0 + vec3i(0, 0, 0), period);
  let c100 = wrapCell(i0 + vec3i(1, 0, 0), period);
  let c010 = wrapCell(i0 + vec3i(0, 1, 0), period);
  let c110 = wrapCell(i0 + vec3i(1, 1, 0), period);
  let c001 = wrapCell(i0 + vec3i(0, 0, 1), period);
  let c101 = wrapCell(i0 + vec3i(1, 0, 1), period);
  let c011 = wrapCell(i0 + vec3i(0, 1, 1), period);
  let c111 = wrapCell(i0 + vec3i(1, 1, 1), period);

  let n000 = dot(gradFromHash(c000, seed), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(gradFromHash(c100, seed), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(gradFromHash(c010, seed), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(gradFromHash(c110, seed), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(gradFromHash(c001, seed), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(gradFromHash(c101, seed), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(gradFromHash(c011, seed), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(gradFromHash(c111, seed), f - vec3f(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, u.x);
  let nx10 = mix(n010, n110, u.x);
  let nx01 = mix(n001, n101, u.x);
  let nx11 = mix(n011, n111, u.x);

  let nxy0 = mix(nx00, nx10, u.y);
  let nxy1 = mix(nx01, nx11, u.y);

  return clamp(mix(nxy0, nxy1, u.z) * 1.38, -1.0, 1.0);
}

// Exact tileable 3D Worley cellular noise returning vec2f(F1, F2 - F1)
fn worleyPeriodic3D(uvw: vec3f, period: i32, seed: u32) -> vec2f {
  let p = uvw * f32(period);
  let baseCell = vec3i(floor(p));
  let fracPos = fract(p);

  var minD1 = 8.0;
  var minD2 = 8.0;

  for (var dz: i32 = -1; dz <= 1; dz++) {
    for (var dy: i32 = -1; dy <= 1; dy++) {
      for (var dx: i32 = -1; dx <= 1; dx++) {
        let offset = vec3i(dx, dy, dz);
        let wrapped = wrapCell(baseCell + offset, period);
        let jitter = hash33u(wrapped, seed);
        let diff = vec3f(offset) + jitter - fracPos;
        let d2 = dot(diff, diff);
        if (d2 < minD1) {
          minD2 = minD1;
          minD1 = d2;
        } else if (d2 < minD2) {
          minD2 = d2;
        }
      }
    }
  }

  let f1 = sqrt(minD1);
  let f2 = sqrt(minD2);
  return vec2f(f1, f2 - f1);
}

// R: 5-octave tileable 3D fBM for volumetric plasma density & dust billows
fn bakeFbm(uvw: vec3f, nyquistLimit: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var period: i32 = 4;

  for (var i: i32 = 0; i < 5; i++) {
    if (f32(period) > nyquistLimit) { break; }
    let n = perlinPeriodic3D(uvw, period, 101u + u32(i) * 37u);
    sum += amp * (n * 0.5 + 0.5);
    norm += amp;
    amp *= 0.52;
    period *= 2;
  }

  let v = sum / max(norm, 1e-5);
  return clamp(smoothstep(0.14, 0.86, v), 0.0, 1.0);
}

// G: 5-octave tileable 3D Musgrave ridged multifractal for razor-crisp plasma filaments
fn bakeRidged(uvw: vec3f, nyquistLimit: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.52;
  var weight = 1.0;
  var norm = 0.0;
  var period: i32 = 4;

  for (var i: i32 = 0; i < 5; i++) {
    if (f32(period) > nyquistLimit) { break; }
    let n = perlinPeriodic3D(uvw, period, 409u + u32(i) * 53u);
    var ridge = 1.0 - abs(n);
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
fn bakeWorley(uvw: vec3f, nyquistLimit: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.58;
  var norm = 0.0;
  var period: i32 = 4;

  for (var i: i32 = 0; i < 3; i++) {
    if (f32(period) > nyquistLimit) { break; }
    let w = worleyPeriodic3D(uvw, period, 733u + u32(i) * 89u);
    let cell = clamp(1.0 - w.x * 1.05, 0.0, 1.0);
    let eddy = pow(cell, 1.35) * 0.82 + smoothstep(0.0, 0.28, w.y) * 0.18;
    sum += amp * eddy;
    norm += amp;
    amp *= 0.48;
    period *= 2;
  }

  return clamp(sum / max(norm, 1e-5), 0.0, 1.0);
}

// A: High-frequency tileable micro-filament striations (periods 16 -> 64)
fn bakeMicro(uvw: vec3f, nyquistLimit: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.55;
  var norm = 0.0;
  var period: i32 = 16;

  for (var i: i32 = 0; i < 3; i++) {
    if (f32(period) > nyquistLimit) { break; }
    let p = perlinPeriodic3D(uvw, period, 977u + u32(i) * 113u);
    let ridge = 1.0 - abs(p);
    let signal = mix(p * 0.5 + 0.5, ridge * ridge, 0.65);
    sum += amp * signal;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }

  return clamp(sum / max(norm, 1e-5), 0.0, 1.0);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(outVol);
  if (id.x >= dims.x || id.y >= dims.y || id.z >= dims.z) {
    return;
  }

  let safeSize = max(f32(dims.x), 32.0);
  let nyquistLimit = safeSize * 0.55;
  let uvw = (vec3f(id) + vec3f(0.5)) / vec3f(dims);

  let chFbm    = bakeFbm(uvw, nyquistLimit);
  let chRidged = bakeRidged(uvw, nyquistLimit);
  let chWorley = bakeWorley(uvw, nyquistLimit);
  let chMicro  = bakeMicro(uvw, nyquistLimit);

  textureStore(outVol, vec3i(id), vec4f(chFbm, chRidged, chWorley, chMicro));
}
`;
