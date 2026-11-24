/**
 * Shared post-processing WebGPU WGSL shaders for Interstellar HDR pipelines:
 *  - TAA_WGSL: HDR Karis-compressed YCoCg 3x3 variance-clipped TAA + 128-sample progressive accumulation
 *  - BLOOM_PREFILTER_WGSL: Karis-averaged 4-tap firefly-safe luminance filter + soft-knee threshold
 *  - BLOOM_DOWNSAMPLE_WGSL: 13-tap Jimenez (SIGGRAPH 2014) energy-preserving mip downsample
 *  - BLOOM_UPSAMPLE_WGSL: 9-tap 3x3 tent filter upsample combined with upper mip level
 *  - ANAMORPHIC_WGSL: 2-pass separable wide 70mm Panavision horizontal optical streak
 *  - COMPOSITE_WGSL: Subtle edge CA, HDR optical combine, cinema vignette, Troy Sobotka AgX tone mapping,
 *                    subtle triangular-PDF dither / film grain, and exact linear-to-sRGB encoding
 */

import { FULLSCREEN_VERT_WGSL } from './common.wgsl.js';
import { formatShaderFloat, resolvePostOpticsProfile } from './postConfig.js';

const IEEE_NAN_GUARD_WGSL = /* wgsl */ `
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
`;

export const TAA_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}
${IEEE_NAN_GUARD_WGSL}

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
      let sampleUv = clamp(in.uv + vec2f(f32(dx), f32(dy)) * texelSize, vec2f(0.0), vec2f(1.0));
      let sRaw = sanitizeHdr(textureSampleLevel(uCurrentTex, sLinear, sampleUv, 0.0).rgb);
      let s = select(compressHdr(sRaw), curComp, dx == 0 && dy == 0);
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
`;

export const BLOOM_PREFILTER_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}
${IEEE_NAN_GUARD_WGSL}

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
`;

export const BLOOM_DOWNSAMPLE_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}
${IEEE_NAN_GUARD_WGSL}

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
`;

export const BLOOM_UPSAMPLE_WGSL = /* wgsl */ `
${FULLSCREEN_VERT_WGSL}

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
`;

function buildAnamorphicWgsl(p) {
  const core = p.coreTint.map(formatShaderFloat).join(', ');
  const outer = p.outerTint.map(formatShaderFloat).join(', ');
  const fStart = formatShaderFloat(p.fringeStart);
  const fMix = formatShaderFloat(p.fringeMix);

  return /* wgsl */ `
${FULLSCREEN_VERT_WGSL}
${IEEE_NAN_GUARD_WGSL}

struct AnamorphicUniforms {
  texelSize_thresh_spread : vec4f, // xy=texelSize, z=threshold, w=spread
  pass_pad                : vec4f, // x=pass (0.0 or 1.0)
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
      let tint = mix(vec3f(${core}), vec3f(${outer}), smoothstep(${fStart}, 1.0, af) * ${fMix});
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
`;
}

function buildCompositeWgsl(p) {
  const bloomGain = formatShaderFloat(p.bloomGain);
  const anamorphicGain = formatShaderFloat(p.anamorphicGain);

  return /* wgsl */ `
${FULLSCREEN_VERT_WGSL}
${IEEE_NAN_GUARD_WGSL}

struct CompositeUniforms {
  res_exposure_bloom : vec4f, // xy=resolution, z=exposure, w=bloomIntensity
  ana_time_frame_pad : vec4f, // x=anamorphicIntensity, y=time, z=f32(frameIndex & 255)
};

@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var uSceneTex: texture_2d<f32>;
@group(0) @binding(2) var uBloomTex: texture_2d<f32>;
@group(0) @binding(3) var uAnamorphicTex: texture_2d<f32>;
@group(0) @binding(4) var sLinear: sampler;

// Troy Sobotka AgX Rec.709 Inset & Outset matrices (WGSL column-major)
const AGX_INSET_MATRIX = mat3x3f(
  vec3f(0.842479062253094,   0.0423282422610123, 0.0423756549057051),
  vec3f(0.0784335999999992,  0.878468636469772,  0.0784336),
  vec3f(0.0792237451477643,  0.0791661274605434, 0.879142973793104)
);

const AGX_OUTSET_MATRIX = mat3x3f(
  vec3f( 1.19687900512017,   -0.0528968517574562, -0.0529716355144438),
  vec3f(-0.0980208811401368,  1.15190312990417,   -0.0980434501171241),
  vec3f(-0.0990297440797205, -0.0989611768448433,  1.15107367264116)
);

const AGX_MIN_EV : f32 = -12.47393;
const AGX_MAX_EV : f32 = 4.026069;

fn agxDefaultContrastApprox(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return (
      15.5    * x4 * x2
    - 40.14   * x4 * x
    + 31.96   * x4
    - 6.868   * x2 * x
    + 0.4298  * x2
    + 0.1191  * x
    - 0.00232
  );
}

fn agxLookPunchy(val: vec3f) -> vec3f {
  const lw = vec3f(0.2126, 0.7152, 0.0722);
  let luma = dot(val, lw);
  let graded = pow(max(val, vec3f(0.0)), vec3f(1.18));
  return max(vec3f(0.0), vec3f(luma) + 1.18 * (graded - vec3f(luma)));
}

fn agxToneMap(linearColor: vec3f) -> vec3f {
  var val = max(linearColor, vec3f(0.0));
  let maxChannel = max(val.r, max(val.g, val.b));
  if (maxChannel <= 1e-7) {
    return vec3f(0.0);
  }

  val = AGX_INSET_MATRIX * val;
  val = max(val, vec3f(1e-10));
  val = log2(val);
  val = (val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  val = clamp(val, vec3f(0.0), vec3f(1.0));

  val = max(agxDefaultContrastApprox(val), vec3f(0.0));
  val = agxLookPunchy(val);
  val = clamp(AGX_OUTSET_MATRIX * val, vec3f(0.0), vec3f(1.0));

  return pow(val, vec3f(2.2));
}

fn linearToSrgb(linearColor: vec3f) -> vec3f {
  let c = clamp(linearColor, vec3f(0.0), vec3f(1.0));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3f(0.0031308), c));
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += vec3f(dot(p3, p3.yzx + vec3f(33.33)));
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let centered = in.uv - 0.5;
  let r2 = dot(centered, centered);

  let caOffset = centered * (r2 * 0.0024);
  let sr = textureSampleLevel(uSceneTex, sLinear, clamp(in.uv + caOffset, vec2f(0.0), vec2f(1.0)), 0.0).r;
  let sg = textureSampleLevel(uSceneTex, sLinear, in.uv, 0.0).g;
  let sb = textureSampleLevel(uSceneTex, sLinear, clamp(in.uv - caOffset, vec2f(0.0), vec2f(1.0)), 0.0).b;
  let scene = max(sanitizeVec3Zero(vec3f(sr, sg, sb)), vec3f(0.0));

  let bloom = max(textureSampleLevel(uBloomTex, sLinear, in.uv, 0.0).rgb, vec3f(0.0));
  let anamorphic = max(textureSampleLevel(uAnamorphicTex, sLinear, in.uv, 0.0).rgb, vec3f(0.0));

  let bloomIntensity = u.res_exposure_bloom.w;
  let anamorphicIntensity = u.ana_time_frame_pad.x;
  let exposure = u.res_exposure_bloom.z;

  var hdr = scene
          + bloom * (bloomIntensity * ${bloomGain})
          + anamorphic * (anamorphicIntensity * ${anamorphicGain});

  hdr *= max(exposure, 0.01);

  let res = max(u.res_exposure_bloom.xy, vec2f(1.0));
  let aspect = res.x / res.y;
  let vigCoord = centered * vec2f(min(aspect, 1.65) * 0.85, 1.0);
  let vignette = 1.0 - smoothstep(0.36, 1.18, length(vigCoord)) * 0.24;
  hdr *= vignette;

  let displayLinear = agxToneMap(hdr);
  var srgb = linearToSrgb(displayLinear);

  // Match pixel noise orientation & scale
  let pix = vec2f(in.pos.x, res.y - in.pos.y);
  let simTime = u.ana_time_frame_pad.y;
  let frameMod = u.ana_time_frame_pad.z;
  let seed = fract(frameMod * 0.61803398875 + simTime * 0.13);
  let n1 = hash12(pix + vec2f(seed * 97.1, seed * 43.7));
  let n2 = hash12(pix + vec2f(seed * 29.3 + 17.0, seed * 83.9 + 5.0));
  let triNoise = n1 + n2 - 1.0;

  let lumaSrgb = dot(srgb, vec3f(0.2126, 0.7152, 0.0722));
  let ditherAmp = (1.15 / 255.0) * smoothstep(0.0005, 0.012, lumaSrgb);
  let grainAmp = 0.0042 * smoothstep(0.01, 0.18, lumaSrgb) * (1.0 - 0.55 * lumaSrgb);
  srgb = clamp(srgb + triNoise * (ditherAmp + grainAmp), vec3f(0.0), vec3f(1.0));

  return vec4f(srgb, 1.0);
}
`;
}

/**
 * Generates the complete set of WGSL post-processing shaders for a named optics profile.
 * @param {string | object} [profile='default']
 */
export function createPostShadersWGSL(profile = 'default') {
  const resolved = resolvePostOpticsProfile(profile);
  return {
    TAA_WGSL,
    BLOOM_PREFILTER_WGSL,
    BLOOM_DOWNSAMPLE_WGSL,
    BLOOM_UPSAMPLE_WGSL,
    ANAMORPHIC_WGSL: buildAnamorphicWgsl(resolved),
    COMPOSITE_WGSL: buildCompositeWgsl(resolved),
  };
}

export const ANAMORPHIC_WGSL = buildAnamorphicWgsl(resolvePostOpticsProfile('default'));
export const COMPOSITE_WGSL = buildCompositeWgsl(resolvePostOpticsProfile('default'));
