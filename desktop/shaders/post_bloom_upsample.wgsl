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

// xy=texelSize, z=filterRadius, w=mipWeight
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var uLowTex: texture_2d<f32>;
@group(0) @binding(2) var uHighTex: texture_2d<f32>;
@group(0) @binding(3) var sLinear: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = u.xy * u.z;

  let a  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f(-d.x,  d.y), 0.0).rgb;
  let b  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f( 0.0,  d.y), 0.0).rgb;
  let c  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f( d.x,  d.y), 0.0).rgb;

  let d1 = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f(-d.x,  0.0), 0.0).rgb;
  let e  = textureSampleLevel(uLowTex, sLinear, in.uv, 0.0).rgb;
  let f  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f( d.x,  0.0), 0.0).rgb;

  let g  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f(-d.x, -d.y), 0.0).rgb;
  let h  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f( 0.0, -d.y), 0.0).rgb;
  let i  = textureSampleLevel(uLowTex, sLinear, in.uv + vec2f( d.x, -d.y), 0.0).rgb;

  let upsampled = (
    (a + c + g + i) +
    (b + d1 + f + h) * 2.0 +
    e * 4.0
  ) * (1.0 / 16.0);

  let higher = textureSampleLevel(uHighTex, sLinear, in.uv, 0.0).rgb;
  return vec4f(max(higher + upsampled * u.w, vec3f(0.0)), 1.0);
}
