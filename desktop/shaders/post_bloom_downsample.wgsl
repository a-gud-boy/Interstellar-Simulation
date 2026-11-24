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
fn isBadFloat(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}

fn sanitizeVec3Zero(v: vec3f) -> vec3f {
  return vec3f(
    select(v.x, 0.0, isBadFloat(v.x)),
    select(v.y, 0.0, isBadFloat(v.y)),
    select(v.z, 0.0, isBadFloat(v.z))
  );
}

// xy=texelSize, z=useKaris (0.0 or 1.0), w=0.0
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var uSrcTex: texture_2d<f32>;
@group(0) @binding(2) var sLinear: sampler;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn karisWeight(c: vec3f) -> f32 {
  return 1.0 / (1.0 + luminance(max(c, vec3f(0.0))));
}

fn sampleSafe(baseUv: vec2f, offset: vec2f, texelSize: vec2f) -> vec3f {
  let uv = clamp(baseUv + offset * texelSize, vec2f(0.0), vec2f(1.0));
  let c = textureSampleLevel(uSrcTex, sLinear, uv, 0.0).rgb;
  return max(sanitizeVec3Zero(c), vec3f(0.0));
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let ts = u.xy;

  let a = sampleSafe(in.uv, vec2f(-2.0,  2.0), ts);
  let b = sampleSafe(in.uv, vec2f( 0.0,  2.0), ts);
  let c = sampleSafe(in.uv, vec2f( 2.0,  2.0), ts);

  let d = sampleSafe(in.uv, vec2f(-2.0,  0.0), ts);
  let e = sampleSafe(in.uv, vec2f( 0.0,  0.0), ts);
  let f = sampleSafe(in.uv, vec2f( 2.0,  0.0), ts);

  let g = sampleSafe(in.uv, vec2f(-2.0, -2.0), ts);
  let h = sampleSafe(in.uv, vec2f( 0.0, -2.0), ts);
  let i = sampleSafe(in.uv, vec2f( 2.0, -2.0), ts);

  let j = sampleSafe(in.uv, vec2f(-1.0,  1.0), ts);
  let k = sampleSafe(in.uv, vec2f( 1.0,  1.0), ts);
  let l = sampleSafe(in.uv, vec2f(-1.0, -1.0), ts);
  let m = sampleSafe(in.uv, vec2f( 1.0, -1.0), ts);

  let g0 = 0.25 * (j + k + l + m);
  let g1 = 0.25 * (a + b + d + e);
  let g2 = 0.25 * (b + c + e + f);
  let g3 = 0.25 * (d + e + g + h);
  let g4 = 0.25 * (e + f + h + i);

  var color: vec3f;
  if (u.z > 0.5) {
    let w0 = 0.500 * karisWeight(g0);
    let w1 = 0.125 * karisWeight(g1);
    let w2 = 0.125 * karisWeight(g2);
    let w3 = 0.125 * karisWeight(g3);
    let w4 = 0.125 * karisWeight(g4);
    color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-5);
  } else {
    color = g0 * 0.500 + (g1 + g2 + g3 + g4) * 0.125;
  }

  return vec4f(max(color, vec3f(0.0)), 1.0);
}
