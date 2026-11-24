struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  let x = f32((vid & 1u) << 2u) - 1.0;
  let y = f32((vid & 2u) << 1u) - 1.0;
  var out: VSOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

// dir_sat: xy = blur step direction in UV (e.g. (texelX, 0) or (0, texelY)), z = saturation boost (1.0 pass 0, 1.25 pass 1), w = unused
@group(0) @binding(0) var<uniform> dir_sat: vec4f;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let stepUv = dir_sat.xy;
  let satBoost = dir_sat.z;

  // 9-tap Gaussian approximating ~10px CSS backdrop blur when run at 1/4 resolution
  let c0 = textureSampleLevel(srcTex, srcSampler, in.uv, 0.0).rgb * 0.227027;
  let c1 = (
    textureSampleLevel(srcTex, srcSampler, clamp(in.uv + stepUv * 1.384615, vec2f(0.0), vec2f(1.0)), 0.0).rgb +
    textureSampleLevel(srcTex, srcSampler, clamp(in.uv - stepUv * 1.384615, vec2f(0.0), vec2f(1.0)), 0.0).rgb
  ) * 0.316216;
  let c2 = (
    textureSampleLevel(srcTex, srcSampler, clamp(in.uv + stepUv * 3.230769, vec2f(0.0), vec2f(1.0)), 0.0).rgb +
    textureSampleLevel(srcTex, srcSampler, clamp(in.uv - stepUv * 3.230769, vec2f(0.0), vec2f(1.0)), 0.0).rgb
  ) * 0.070270;

  var col = c0 + c1 + c2;
  if (abs(satBoost - 1.0) > 1e-3) {
    let luma = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3f(luma), col, satBoost), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(col, 1.0);
}
