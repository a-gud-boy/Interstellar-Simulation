/**
 * Shared post-processing GLSL 300 es fragment shaders for Interstellar HDR pipelines:
 *  - TAA_FRAG: HDR Karis-compressed YCoCg 3x3 variance-clipped TAA + 128-sample progressive accumulation
 *  - BLOOM_PREFILTER_FRAG: Karis-averaged 4-tap firefly-safe luminance filter + soft-knee threshold
 *  - BLOOM_DOWNSAMPLE_FRAG: 13-tap Jimenez (SIGGRAPH 2014) energy-preserving mip downsample
 *  - BLOOM_UPSAMPLE_FRAG: 9-tap 3x3 tent filter upsample combined with upper mip level
 *  - ANAMORPHIC_FRAG: 2-pass separable wide 70mm Panavision horizontal optical streak
 *  - COMPOSITE_FRAG: Subtle edge CA, HDR optical combine, cinema vignette, Troy Sobotka AgX tone mapping,
 *                    subtle triangular-PDF dither / film grain, and exact linear-to-sRGB encoding
 */

import { formatShaderFloat, resolvePostOpticsProfile } from './postConfig.js';

export const TAA_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uCurrentTex;
uniform sampler2D uHistoryTex;
uniform vec2 uTexelSize;
uniform float uBlendFactor;
uniform int uProgressive;

const float MAX_HDR_RADIANCE = 50000.0;

vec3 sanitizeHdr(vec3 c) {
  bvec3 bad = bvec3(
    isnan(c.r) || isinf(c.r),
    isnan(c.g) || isinf(c.g),
    isnan(c.b) || isinf(c.b)
  );
  c = mix(c, vec3(0.0), bad);
  return clamp(c, vec3(0.0), vec3(MAX_HDR_RADIANCE));
}

// Bijective HDR compression into [0, 1) using max-component Karis weighting.
vec3 compressHdr(vec3 c) {
  float peak = max(c.r, max(c.g, c.b));
  return c / (1.0 + peak);
}

vec3 expandHdr(vec3 c) {
  vec3 clamped = clamp(c, vec3(0.0), vec3(0.99995));
  float peak = max(clamped.r, max(clamped.g, clamped.b));
  return clamped / max(1e-4, 1.0 - peak);
}

vec3 rgbToYCoCg(vec3 c) {
  float y  =  0.25 * c.r + 0.50 * c.g + 0.25 * c.b;
  float co =  0.50 * c.r              - 0.50 * c.b;
  float cg = -0.25 * c.r + 0.50 * c.g - 0.25 * c.b;
  return vec3(y, co, cg);
}

vec3 yCoCgToRgb(vec3 ycc) {
  float t = ycc.x - ycc.z;
  return max(vec3(0.0), vec3(t + ycc.y, ycc.x + ycc.z, t - ycc.y));
}

// Ray-box clip from history toward neighborhood mean in YCoCg space to avoid chroma shifting on edges.
vec3 clipToAabb(vec3 history, vec3 meanVal, vec3 boxMin, vec3 boxMax) {
  vec3 center = 0.5 * (boxMax + boxMin);
  vec3 extents = max(0.5 * (boxMax - boxMin), vec3(1e-5));
  vec3 offset = history - center;
  vec3 unitOffset = abs(offset / extents);
  float maxUnit = max(unitOffset.x, max(unitOffset.y, unitOffset.z));
  if (maxUnit > 1.0) {
    return center + offset / maxUnit;
  }
  return history;
}

void main() {
  vec3 current = sanitizeHdr(texture(uCurrentTex, vUv).rgb);

  // Hard reset on frame 1 or full override
  if (uBlendFactor >= 0.999) {
    fragColor = vec4(current, 1.0);
    return;
  }

  vec3 history = sanitizeHdr(texture(uHistoryTex, vUv).rgb);

  // Mode 1: Unbiased progressive cinema path-trace accumulation (paused & stationary)
  if (uProgressive == 1) {
    vec3 accum = mix(history, current, clamp(uBlendFactor, 0.0, 1.0));
    fragColor = vec4(sanitizeHdr(accum), 1.0);
    return;
  }

  // Mode 0: Karis HDR YCoCg 3x3 variance-clipped Temporal Anti-Aliasing
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 curComp = compressHdr(current);

  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      vec2 sampleUv = clamp(vUv + vec2(float(dx), float(dy)) * uTexelSize, vec2(0.0), vec2(1.0));
      vec3 s = (dx == 0 && dy == 0)
        ? curComp
        : compressHdr(sanitizeHdr(texture(uCurrentTex, sampleUv).rgb));
      vec3 ycc = rgbToYCoCg(s);
      m1 += ycc;
      m2 += ycc * ycc;
    }
  }

  vec3 mean = m1 / 9.0;
  vec3 variance = max(vec3(0.0), m2 / 9.0 - mean * mean);
  vec3 stddev = sqrt(variance);

  const float GAMMA = 1.25;
  vec3 boxMin = mean - GAMMA * stddev;
  vec3 boxMax = mean + GAMMA * stddev;

  vec3 histYcc = rgbToYCoCg(compressHdr(history));
  vec3 clippedHistYcc = clipToAabb(histYcc, mean, boxMin, boxMax);
  vec3 clippedHistComp = yCoCgToRgb(clippedHistYcc);

  vec3 blendedComp = mix(clippedHistComp, curComp, clamp(uBlendFactor, 0.02, 1.0));
  vec3 result = sanitizeHdr(expandHdr(blendedComp));
  fragColor = vec4(result, 1.0);
}
`;

export const BLOOM_PREFILTER_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSrcTex;
uniform vec2 uTexelSize;
uniform float uThreshold;
uniform float uKnee;
uniform float uClampMax;

vec3 sanitizeSample(vec3 c) {
  bvec3 bad = bvec3(
    isnan(c.r) || isinf(c.r),
    isnan(c.g) || isinf(c.g),
    isnan(c.b) || isinf(c.b)
  );
  c = mix(c, vec3(0.0), bad);
  return clamp(c, vec3(0.0), vec3(uClampMax));
}

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 softKneeThreshold(vec3 color) {
  float br = max(color.r, max(color.g, color.b));
  float knee = max(uThreshold * uKnee, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  return color * max(contrib, 0.0);
}

void main() {
  // Exact 4-tap full-res pixel centers covered by this half-res texel, with Karis anti-firefly weighting
  vec2 o = 0.5 * uTexelSize;
  vec3 c0 = softKneeThreshold(sanitizeSample(texture(uSrcTex, vUv + vec2(-o.x, -o.y)).rgb));
  vec3 c1 = softKneeThreshold(sanitizeSample(texture(uSrcTex, vUv + vec2( o.x, -o.y)).rgb));
  vec3 c2 = softKneeThreshold(sanitizeSample(texture(uSrcTex, vUv + vec2(-o.x,  o.y)).rgb));
  vec3 c3 = softKneeThreshold(sanitizeSample(texture(uSrcTex, vUv + vec2( o.x,  o.y)).rgb));

  float w0 = 1.0 / (1.0 + luminance(c0));
  float w1 = 1.0 / (1.0 + luminance(c1));
  float w2 = 1.0 / (1.0 + luminance(c2));
  float w3 = 1.0 / (1.0 + luminance(c3));

  vec3 result = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / max(w0 + w1 + w2 + w3, 1e-5);
  fragColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;

export const BLOOM_DOWNSAMPLE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSrcTex;
uniform vec2 uTexelSize;
uniform int uUseKaris;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luminance(max(c, vec3(0.0))));
}

vec3 sampleSafe(vec2 offset) {
  vec3 c = texture(uSrcTex, clamp(vUv + offset * uTexelSize, vec2(0.0), vec2(1.0))).rgb;
  bvec3 bad = bvec3(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b));
  return max(mix(c, vec3(0.0), bad), vec3(0.0));
}

void main() {
  // Jorge Jimenez / Call of Duty: Advanced Warfare 13-tap energy-preserving downsample
  vec3 a = sampleSafe(vec2(-2.0,  2.0));
  vec3 b = sampleSafe(vec2( 0.0,  2.0));
  vec3 c = sampleSafe(vec2( 2.0,  2.0));

  vec3 d = sampleSafe(vec2(-2.0,  0.0));
  vec3 e = sampleSafe(vec2( 0.0,  0.0));
  vec3 f = sampleSafe(vec2( 2.0,  0.0));

  vec3 g = sampleSafe(vec2(-2.0, -2.0));
  vec3 h = sampleSafe(vec2( 0.0, -2.0));
  vec3 i = sampleSafe(vec2( 2.0, -2.0));

  vec3 j = sampleSafe(vec2(-1.0,  1.0));
  vec3 k = sampleSafe(vec2( 1.0,  1.0));
  vec3 l = sampleSafe(vec2(-1.0, -1.0));
  vec3 m = sampleSafe(vec2( 1.0, -1.0));

  // Five overlapping 2x2 groups
  vec3 g0 = 0.25 * (j + k + l + m); // Center box (weight 0.50)
  vec3 g1 = 0.25 * (a + b + d + e); // Top-left   (weight 0.125)
  vec3 g2 = 0.25 * (b + c + e + f); // Top-right  (weight 0.125)
  vec3 g3 = 0.25 * (d + e + g + h); // Bot-left   (weight 0.125)
  vec3 g4 = 0.25 * (e + f + h + i); // Bot-right  (weight 0.125)

  vec3 color;
  if (uUseKaris == 1) {
    float w0 = 0.500 * karisWeight(g0);
    float w1 = 0.125 * karisWeight(g1);
    float w2 = 0.125 * karisWeight(g2);
    float w3 = 0.125 * karisWeight(g3);
    float w4 = 0.125 * karisWeight(g4);
    color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-5);
  } else {
    color = g0 * 0.500 + (g1 + g2 + g3 + g4) * 0.125;
  }

  fragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

export const BLOOM_UPSAMPLE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uLowTex;
uniform sampler2D uHighTex;
uniform vec2 uTexelSize;
uniform float uFilterRadius;
uniform float uMipWeight;

void main() {
  // 9-tap 3x3 tent filter (weights 1,2,1 / 2,4,2 / 1,2,1 divided by 16)
  vec2 d = uTexelSize * uFilterRadius;

  vec3 a = texture(uLowTex, vUv + vec2(-d.x,  d.y)).rgb;
  vec3 b = texture(uLowTex, vUv + vec2( 0.0,  d.y)).rgb;
  vec3 c = texture(uLowTex, vUv + vec2( d.x,  d.y)).rgb;

  vec3 d1 = texture(uLowTex, vUv + vec2(-d.x,  0.0)).rgb;
  vec3 e  = texture(uLowTex, vUv).rgb;
  vec3 f  = texture(uLowTex, vUv + vec2( d.x,  0.0)).rgb;

  vec3 g = texture(uLowTex, vUv + vec2(-d.x, -d.y)).rgb;
  vec3 h = texture(uLowTex, vUv + vec2( 0.0, -d.y)).rgb;
  vec3 i = texture(uLowTex, vUv + vec2( d.x, -d.y)).rgb;

  vec3 upsampled = (
    (a + c + g + i) +
    (b + d1 + f + h) * 2.0 +
    e * 4.0
  ) * (1.0 / 16.0);

  vec3 higher = texture(uHighTex, vUv).rgb;
  fragColor = vec4(max(higher + upsampled * uMipWeight, vec3(0.0)), 1.0);
}
`;

function buildAnamorphicFrag(p) {
  const core = p.coreTint.map(formatShaderFloat).join(', ');
  const outer = p.outerTint.map(formatShaderFloat).join(', ');
  const fStart = formatShaderFloat(p.fringeStart);
  const fMix = formatShaderFloat(p.fringeMix);

  return `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSrcTex;
uniform vec2 uTexelSize;
uniform float uThreshold;
uniform float uSpread;
uniform int uPass;

vec3 isolateHighlights(vec3 c) {
  bvec3 bad = bvec3(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b));
  c = clamp(mix(c, vec3(0.0), bad), vec3(0.0), vec3(12.0));
  float br = max(c.r, max(c.g, c.b));
  float knee = max(uThreshold * 0.40, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  return c * max(contrib, 0.0);
}

void main() {
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;

  if (uPass == 0) {
    // Pass 0: Extract ultra-bright incandescent highlights + primary horizontal Panavision smear
    const int HALF_TAPS = 12;
    float stride = uTexelSize.x * uSpread * 1.85;

    for (int i = -HALF_TAPS; i <= HALF_TAPS; ++i) {
      float fi = float(i);
      float af = abs(fi) / float(HALF_TAPS);
      vec2 uv = vec2(vUv.x + fi * stride, vUv.y);
      if (uv.x < 0.0 || uv.x > 1.0) continue;

      // Subtle vertical stabilization (3-tap weighted) prevents thin 1-pixel shimmer
      vec3 s =
        0.50 * isolateHighlights(texture(uSrcTex, uv).rgb) +
        0.25 * isolateHighlights(texture(uSrcTex, vec2(uv.x, clamp(uv.y - uTexelSize.y, 0.0, 1.0))).rgb) +
        0.25 * isolateHighlights(texture(uSrcTex, vec2(uv.x, clamp(uv.y + uTexelSize.y, 0.0, 1.0))).rgb);

      // Lorentzian + Gaussian hybrid optical falloff for authentic 70mm glass streak
      float w = exp(-af * 3.1) + 0.22 / (1.0 + af * af * 9.0);

      // Subtle chromatic glass coating
      vec3 tint = mix(vec3(${core}), vec3(${outer}), smoothstep(${fStart}, 1.0, af) * ${fMix});
      sum += s * tint * w;
      weightSum += w;
    }
  } else {
    // Pass 1: Long-reach secondary horizontal extension for silky cinema streak across viewport
    const int HALF_TAPS = 10;
    float stride = uTexelSize.x * uSpread * 5.2;

    for (int i = -HALF_TAPS; i <= HALF_TAPS; ++i) {
      float fi = float(i);
      float af = abs(fi) / float(HALF_TAPS);
      vec2 uv = vec2(vUv.x + fi * stride, vUv.y);
      if (uv.x < 0.0 || uv.x > 1.0) continue;

      vec3 s = max(texture(uSrcTex, uv).rgb, vec3(0.0));
      float w = exp(-af * 2.45) + 0.16 * exp(-af * 0.9);
      sum += s * w;
      weightSum += w;
    }
  }

  fragColor = vec4(sum / max(weightSum, 1e-5), 1.0);
}
`;
}

function buildCompositeFrag(p) {
  const bloomGain = formatShaderFloat(p.bloomGain);
  const anamorphicGain = formatShaderFloat(p.anamorphicGain);

  return `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
uniform sampler2D uAnamorphicTex;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomIntensity;
uniform float uAnamorphicIntensity;
uniform float uTime;
uniform int uFrameIndex;

// Troy Sobotka AgX Rec.709 Inset & Outset matrices (GLSL column-major)
const mat3 AGX_INSET_MATRIX = mat3(
  vec3(0.842479062253094,   0.0423282422610123, 0.0423756549057051),
  vec3(0.0784335999999992,  0.878468636469772,  0.0784336),
  vec3(0.0792237451477643,  0.0791661274605434, 0.879142973793104)
);

const mat3 AGX_OUTSET_MATRIX = mat3(
  vec3( 1.19687900512017,   -0.0528968517574562, -0.0529716355144438),
  vec3(-0.0980208811401368,  1.15190312990417,   -0.0980434501171241),
  vec3(-0.0990297440797205, -0.0989611768448433,  1.15107367264116)
);

const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

// 6th-order polynomial approximation to the AgX default contrast sigmoid
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return (
    + 15.5    * x4 * x2
    - 40.14   * x4 * x
    + 31.96   * x4
    - 6.868   * x2 * x
    + 0.4298  * x2
    + 0.1191  * x
    - 0.00232
  );
}

// Subtle punchy cinema look in AgX log/display space (rich abyssal blacks, vibrant incandescent highlights)
vec3 agxLookPunchy(vec3 val) {
  const vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  float luma = dot(val, lw);
  vec3 graded = pow(max(val, vec3(0.0)), vec3(1.18));
  return max(vec3(0.0), luma + 1.18 * (graded - luma));
}

vec3 agxToneMap(vec3 linearColor) {
  vec3 val = max(linearColor, vec3(0.0));
  // Preserve absolute black (deep space shadow stays true #000)
  float maxChannel = max(val.r, max(val.g, val.b));
  if (maxChannel <= 1e-7) {
    return vec3(0.0);
  }

  val = AGX_INSET_MATRIX * val;
  val = max(val, vec3(1e-10));
  val = log2(val);
  val = (val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  val = clamp(val, 0.0, 1.0);

  val = max(agxDefaultContrastApprox(val), vec3(0.0));
  val = agxLookPunchy(val);
  val = clamp(AGX_OUTSET_MATRIX * val, 0.0, 1.0);

  // AgX EOTF back to linear display light prior to exact piecewise sRGB encoding
  return pow(val, vec3(2.2));
}

vec3 linearToSrgb(vec3 linearColor) {
  vec3 c = clamp(linearColor, 0.0, 1.0);
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 centered = vUv - 0.5;
  float r2 = dot(centered, centered); // 0 at center, 0.5 at corners

  // Very subtle natural IMAX lens edge chromatic aberration (0 at center, ~0.0012 at far corners)
  vec2 caOffset = centered * (r2 * 0.0024);
  vec3 scene;
  scene.r = texture(uSceneTex, clamp(vUv + caOffset, vec2(0.0), vec2(1.0))).r;
  scene.g = texture(uSceneTex, vUv).g;
  scene.b = texture(uSceneTex, clamp(vUv - caOffset, vec2(0.0), vec2(1.0))).b;

  // Guard against any non-finite pixels before final grading
  bvec3 bad = bvec3(isnan(scene.r) || isinf(scene.r), isnan(scene.g) || isinf(scene.g), isnan(scene.b) || isinf(scene.b));
  scene = max(mix(scene, vec3(0.0), bad), vec3(0.0));

  vec3 bloom = max(texture(uBloomTex, vUv).rgb, vec3(0.0));
  vec3 anamorphic = max(texture(uAnamorphicTex, vUv).rgb, vec3(0.0));

  // Energy-balanced optical bloom & horizontal 70mm anamorphic streak
  vec3 hdr = scene
    + bloom * (uBloomIntensity * ${bloomGain})
    + anamorphic * (uAnamorphicIntensity * ${anamorphicGain});

  // Camera exposure
  hdr *= max(uExposure, 0.01);

  // Subtle cinema vignette framing deep space
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 vigCoord = centered * vec2(min(aspect, 1.65) * 0.85, 1.0);
  float vignette = 1.0 - smoothstep(0.36, 1.18, length(vigCoord)) * 0.24;
  hdr *= vignette;

  // Troy Sobotka AgX Filmic Tone Mapping -> exact linear-to-sRGB
  vec3 displayLinear = agxToneMap(hdr);
  vec3 srgb = linearToSrgb(displayLinear);

  // Ultra-fine triangular-PDF dither + subtle cinema film grain to eliminate 8-bit dark sky banding
  vec2 pix = gl_FragCoord.xy;
  float seed = fract(float(uFrameIndex & 255) * 0.61803398875 + uTime * 0.13);
  float n1 = hash12(pix + vec2(seed * 97.1, seed * 43.7));
  float n2 = hash12(pix + vec2(seed * 29.3 + 17.0, seed * 83.9 + 5.0));
  float triNoise = n1 + n2 - 1.0; // Triangular PDF in [-1, 1], zero mean

  // Keep pure #000 shadow regions spotless while dithering dark sky & adding delicate organic grain
  float lumaSrgb = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
  float ditherAmp = (1.15 / 255.0) * smoothstep(0.0005, 0.012, lumaSrgb);
  float grainAmp = 0.0042 * smoothstep(0.01, 0.18, lumaSrgb) * (1.0 - 0.55 * lumaSrgb);
  srgb = clamp(srgb + triNoise * (ditherAmp + grainAmp), 0.0, 1.0);

  fragColor = vec4(srgb, 1.0);
}
`;
}

/**
 * Generates the complete set of GLSL post-processing shaders for a named optics profile.
 * @param {string | object} [profile='default']
 */
export function createPostShadersGLSL(profile = 'default') {
  const resolved = resolvePostOpticsProfile(profile);
  return {
    TAA_FRAG,
    BLOOM_PREFILTER_FRAG,
    BLOOM_DOWNSAMPLE_FRAG,
    BLOOM_UPSAMPLE_FRAG,
    ANAMORPHIC_FRAG: buildAnamorphicFrag(resolved),
    COMPOSITE_FRAG: buildCompositeFrag(resolved),
  };
}

export const ANAMORPHIC_FRAG = buildAnamorphicFrag(resolvePostOpticsProfile('default'));
export const COMPOSITE_FRAG = buildCompositeFrag(resolvePostOpticsProfile('default'));
