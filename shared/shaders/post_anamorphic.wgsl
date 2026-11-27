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

struct AnamorphicUniforms {
  texelSize_thresh_spread : vec4f, // xy=texelSize, z=threshold, w=spread
  pass_pad                : vec4f, // x=pass (0.0 or 1.0)
  tint_inner_edge         : vec4f, // xyz=innerTint, w=edgeStart
  tint_outer_mix          : vec4f, // xyz=outerTint, w=mixWeight
};

@group(0) @binding(0) var<uniform> u: AnamorphicUniforms;
@group(0) @binding(1) var uSrcTex: texture_2d<f32>;
@group(0) @binding(2) var sLinear: sampler;

fn isolateHighlights(cIn: vec3f, threshold: f32) -> vec3f {
  let c = clamp(sanitizeVec3Zero(cIn), vec3f(0.0), vec3f(12.0));
  let br = max(c.r, max(c.g, c.b));
  let knee = max(threshold * 0.40, 1e-4);
  let soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  let softTerm = (soft * soft) / (4.0 * knee + 1e-5);
  let contrib = max(softTerm, br - threshold) / max(br, 1e-5);
  return c * max(contrib, 0.0);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texelSize = u.texelSize_thresh_spread.xy;
  let threshold = u.texelSize_thresh_spread.z;
  let spread    = u.texelSize_thresh_spread.w;
  let passIdx   = i32(round(u.pass_pad.x));

  var sum = vec3f(0.0);
  var weightSum : f32 = 0.0;

  if (passIdx == 0) {
    const HALF_TAPS : i32 = 12;
    let stride = texelSize.x * spread * 1.85;

    for (var i: i32 = -HALF_TAPS; i <= HALF_TAPS; i++) {
      let fi = f32(i);
      let af = abs(fi) / f32(HALF_TAPS);
      let uv = vec2f(in.uv.x + fi * stride, in.uv.y);

      let s0 = textureSampleLevel(uSrcTex, sLinear, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
      let s1 = textureSampleLevel(uSrcTex, sLinear, vec2f(clamp(uv.x, 0.0, 1.0), clamp(uv.y - texelSize.y, 0.0, 1.0)), 0.0).rgb;
      let s2 = textureSampleLevel(uSrcTex, sLinear, vec2f(clamp(uv.x, 0.0, 1.0), clamp(uv.y + texelSize.y, 0.0, 1.0)), 0.0).rgb;

      if (uv.x < 0.0 || uv.x > 1.0) { continue; }

      let s = 0.50 * isolateHighlights(s0, threshold)
            + 0.25 * isolateHighlights(s1, threshold)
            + 0.25 * isolateHighlights(s2, threshold);

      let w = exp(-af * 3.1) + 0.22 / (1.0 + af * af * 9.0);
      let tint = mix(
        u.tint_inner_edge.xyz,
        u.tint_outer_mix.xyz,
        smoothstep(u.tint_inner_edge.w, 1.0, af) * u.tint_outer_mix.w
      );
      sum += s * tint * w;
      weightSum += w;
    }
  } else {
    const HALF_TAPS : i32 = 10;
    let stride = texelSize.x * spread * 5.2;

    for (var i: i32 = -HALF_TAPS; i <= HALF_TAPS; i++) {
      let fi = f32(i);
      let af = abs(fi) / f32(HALF_TAPS);
      let uv = vec2f(in.uv.x + fi * stride, in.uv.y);
      let raw = textureSampleLevel(uSrcTex, sLinear, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;

      if (uv.x < 0.0 || uv.x > 1.0) { continue; }

      let s = max(raw, vec3f(0.0));
      let w = exp(-af * 2.45) + 0.16 * exp(-af * 0.9);
      sum += s * w;
      weightSum += w;
    }
  }

  return vec4f(sum / max(weightSum, 1e-5), 1.0);
}
