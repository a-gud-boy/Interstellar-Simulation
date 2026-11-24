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

struct BloomPrefilterUniforms {
  texelSize_thresh_knee : vec4f, // xy=texelSize, z=threshold, w=knee
  clampMax_pad          : vec4f, // x=clampMax
};

@group(0) @binding(0) var<uniform> u: BloomPrefilterUniforms;
@group(0) @binding(1) var uSrcTex: texture_2d<f32>;
@group(0) @binding(2) var sLinear: sampler;

fn sanitizeSample(c: vec3f) -> vec3f {
  return clamp(sanitizeVec3Zero(c), vec3f(0.0), vec3f(u.clampMax_pad.x));
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn softKneeThreshold(color: vec3f) -> vec3f {
  let thresh = u.texelSize_thresh_knee.z;
  let kneeFrac = u.texelSize_thresh_knee.w;
  let br = max(color.r, max(color.g, color.b));
  let knee = max(thresh * kneeFrac, 1e-4);
  let soft = clamp(br - thresh + knee, 0.0, 2.0 * knee);
  let softTerm = (soft * soft) / (4.0 * knee + 1e-5);
  let contrib = max(softTerm, br - thresh) / max(br, 1e-5);
  return color * max(contrib, 0.0);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let o = 0.5 * u.texelSize_thresh_knee.xy;
  let c0 = softKneeThreshold(sanitizeSample(textureSampleLevel(uSrcTex, sLinear, in.uv + vec2f(-o.x, -o.y), 0.0).rgb));
  let c1 = softKneeThreshold(sanitizeSample(textureSampleLevel(uSrcTex, sLinear, in.uv + vec2f( o.x, -o.y), 0.0).rgb));
  let c2 = softKneeThreshold(sanitizeSample(textureSampleLevel(uSrcTex, sLinear, in.uv + vec2f(-o.x,  o.y), 0.0).rgb));
  let c3 = softKneeThreshold(sanitizeSample(textureSampleLevel(uSrcTex, sLinear, in.uv + vec2f( o.x,  o.y), 0.0).rgb));

  let w0 = 1.0 / (1.0 + luminance(c0));
  let w1 = 1.0 / (1.0 + luminance(c1));
  let w2 = 1.0 / (1.0 + luminance(c2));
  let w3 = 1.0 / (1.0 + luminance(c3));

  let result = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / max(w0 + w1 + w2 + w3, 1e-5);
  return vec4f(max(result, vec3f(0.0)), 1.0);
}
