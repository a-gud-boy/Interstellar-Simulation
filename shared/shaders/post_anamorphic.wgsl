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

fn samplePass0(uv: vec2f, texelY: f32, threshold: f32) -> vec3f {
  let s0 = textureSampleLevel(uSrcTex, sLinear, uv, 0.0).rgb;
  let s1 = textureSampleLevel(uSrcTex, sLinear, vec2f(uv.x, max(uv.y - texelY, 0.0)), 0.0).rgb;
  let s2 = textureSampleLevel(uSrcTex, sLinear, vec2f(uv.x, min(uv.y + texelY, 1.0)), 0.0).rgb;
  return 0.50 * isolateHighlights(s0, threshold)
       + 0.25 * isolateHighlights(s1, threshold)
       + 0.25 * isolateHighlights(s2, threshold);
}

fn pass0SymPair(
  baseUv: vec2f,
  dx: f32,
  texelY: f32,
  threshold: f32,
  w: f32,
  af: f32,
  tintInner: vec3f,
  edgeStart: f32,
  tintOuter: vec3f,
  mixWeight: f32,
  sum: ptr<function, vec3f>,
  weightSum: ptr<function, f32>
) {
  let uvR = vec2f(baseUv.x + dx, baseUv.y);
  let uvL = vec2f(baseUv.x - dx, baseUv.y);
  var tapSum = vec3f(0.0);
  var tapW : f32 = 0.0;
  if (uvR.x <= 1.0) {
    tapSum += samplePass0(uvR, texelY, threshold);
    tapW += w;
  }
  if (uvL.x >= 0.0) {
    tapSum += samplePass0(uvL, texelY, threshold);
    tapW += w;
  }
  if (tapW > 0.0) {
    let tint = mix(tintInner, tintOuter, smoothstep(edgeStart, 1.0, af) * mixWeight);
    *sum += tapSum * (tint * w);
    *weightSum += tapW;
  }
}

fn pass1SymPair(
  baseUv: vec2f,
  dx: f32,
  w: f32,
  sum: ptr<function, vec3f>,
  weightSum: ptr<function, f32>
) {
  let uvR = baseUv.x + dx;
  let uvL = baseUv.x - dx;
  if (uvR <= 1.0) {
    let sR = max(textureSampleLevel(uSrcTex, sLinear, vec2f(uvR, baseUv.y), 0.0).rgb, vec3f(0.0));
    *sum += sR * w;
    *weightSum += w;
  }
  if (uvL >= 0.0) {
    let sL = max(textureSampleLevel(uSrcTex, sLinear, vec2f(uvL, baseUv.y), 0.0).rgb, vec3f(0.0));
    *sum += sL * w;
    *weightSum += w;
  }
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
    let stride = texelSize.x * spread * 1.85;
    let tintInner = u.tint_inner_edge.xyz;
    let edgeStart = u.tint_inner_edge.w;
    let tintOuter = u.tint_outer_mix.xyz;
    let mixWeight = u.tint_outer_mix.w;

    // Center tap (i = 0: w = 1.22, af = 0.0 -> pure tintInner)
    sum = samplePass0(in.uv, texelSize.y, threshold) * (tintInner * 1.22);
    weightSum = 1.22;

    // Symmetric +/-i taps with precomputed Lorentzian + Gaussian optical weights
    pass0SymPair(in.uv, stride *  1.0, texelSize.y, threshold, 0.979397, 1.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  2.0, texelSize.y, threshold, 0.772506, 2.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  3.0, texelSize.y, threshold, 0.601504, 3.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  4.0, texelSize.y, threshold, 0.465819, 4.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  5.0, texelSize.y, threshold, 0.360666, 5.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  6.0, texelSize.y, threshold, 0.279940, 6.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  7.0, texelSize.y, threshold, 0.218081, 7.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  8.0, texelSize.y, threshold, 0.170607, 8.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride *  9.0, texelSize.y, threshold, 0.134072, 9.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride * 10.0, texelSize.y, threshold, 0.105867, 10.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride * 11.0, texelSize.y, threshold, 0.084022, 11.0 / 12.0, tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
    pass0SymPair(in.uv, stride * 12.0, texelSize.y, threshold, 0.067049, 1.0,        tintInner, edgeStart, tintOuter, mixWeight, &sum, &weightSum);
  } else {
    let stride = texelSize.x * spread * 5.2;

    // Center tap (i = 0: w = 1.16)
    sum = max(textureSampleLevel(uSrcTex, sLinear, in.uv, 0.0).rgb, vec3f(0.0)) * 1.16;
    weightSum = 1.16;

    // Symmetric +/-i taps with precomputed double-exponential weights
    pass1SymPair(in.uv, stride *  1.0, 0.928934, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  2.0, 0.746270, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  3.0, 0.601646, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  4.0, 0.486939, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  5.0, 0.395778, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  6.0, 0.323165, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  7.0, 0.265178, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  8.0, 0.218739, &sum, &weightSum);
    pass1SymPair(in.uv, stride *  9.0, 0.181428, &sum, &weightSum);
    pass1SymPair(in.uv, stride * 10.0, 0.151345, &sum, &weightSum);
  }

  return vec4f(sum / max(weightSum, 1e-5), 1.0);
}
