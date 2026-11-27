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

// x=texelX, y=texelY, z=blendFactor, w=progressiveFlag (0.0 or 1.0)
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var uCurrentTex: texture_2d<f32>;
@group(0) @binding(2) var uHistoryTex: texture_2d<f32>;
@group(0) @binding(3) var sLinear: sampler;

const MAX_HDR_RADIANCE : f32 = 50000.0;

fn sanitizeHdr(c: vec3f) -> vec3f {
  return clamp(sanitizeVec3Zero(c), vec3f(0.0), vec3f(MAX_HDR_RADIANCE));
}

fn compressHdr(c: vec3f) -> vec3f {
  let peak = max(c.r, max(c.g, c.b));
  return c / (1.0 + peak);
}

fn expandHdr(c: vec3f) -> vec3f {
  let clamped = clamp(c, vec3f(0.0), vec3f(0.99995));
  let peak = max(clamped.r, max(clamped.g, clamped.b));
  return clamped / max(1e-4, 1.0 - peak);
}

fn rgbToYCoCg(c: vec3f) -> vec3f {
  let y  =  0.25 * c.r + 0.50 * c.g + 0.25 * c.b;
  let co =  0.50 * c.r              - 0.50 * c.b;
  let cg = -0.25 * c.r + 0.50 * c.g - 0.25 * c.b;
  return vec3f(y, co, cg);
}

fn yCoCgToRgb(ycc: vec3f) -> vec3f {
  let t = ycc.x - ycc.z;
  return max(vec3f(0.0), vec3f(t + ycc.y, ycc.x + ycc.z, t - ycc.y));
}

fn clipToAabb(history: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec3f {
  let center = 0.5 * (boxMax + boxMin);
  let extents = max(0.5 * (boxMax - boxMin), vec3f(1e-5));
  let offset = history - center;
  let unitOffset = abs(offset / extents);
  let maxUnit = max(unitOffset.x, max(unitOffset.y, unitOffset.z));
  if (maxUnit > 1.0) {
    return center + offset / maxUnit;
  }
  return history;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texelSize = u.xy;
  let blendFactor = u.z;
  let progressive = u.w > 0.5;

  let current = sanitizeHdr(textureSampleLevel(uCurrentTex, sLinear, in.uv, 0.0).rgb);

  if (blendFactor >= 0.999) {
    return vec4f(current, 1.0);
  }

  let history = sanitizeHdr(textureSampleLevel(uHistoryTex, sLinear, in.uv, 0.0).rgb);

  if (progressive) {
    let accum = mix(history, current, clamp(blendFactor, 0.0, 1.0));
    return vec4f(sanitizeHdr(accum), 1.0);
  }

  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  let curComp = compressHdr(current);

  for (var dy: i32 = -1; dy <= 1; dy++) {
    for (var dx: i32 = -1; dx <= 1; dx++) {
      var s: vec3f;
      if (dx == 0 && dy == 0) {
        s = curComp;
      } else {
        let sampleUv = clamp(in.uv + vec2f(f32(dx), f32(dy)) * texelSize, vec2f(0.0), vec2f(1.0));
        let sRaw = sanitizeHdr(textureSampleLevel(uCurrentTex, sLinear, sampleUv, 0.0).rgb);
        s = compressHdr(sRaw);
      }
      let ycc = rgbToYCoCg(s);
      m1 += ycc;
      m2 += ycc * ycc;
    }
  }

  let mean = m1 / 9.0;
  let variance = max(vec3f(0.0), m2 / 9.0 - mean * mean);
  let stddev = sqrt(variance);

  const GAMMA : f32 = 1.25;
  let boxMin = mean - GAMMA * stddev;
  let boxMax = mean + GAMMA * stddev;

  let histYcc = rgbToYCoCg(compressHdr(history));
  let clippedHistYcc = clipToAabb(histYcc, boxMin, boxMax);
  let clippedHistComp = yCoCgToRgb(clippedHistYcc);

  let blendedComp = mix(clippedHistComp, curComp, clamp(blendFactor, 0.02, 1.0));
  let result = sanitizeHdr(expandHdr(blendedComp));
  return vec4f(result, 1.0);
}
