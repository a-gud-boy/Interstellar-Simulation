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

struct CompositeUniforms {
  res_exposure_bloom : vec4f, // xy=resolution, z=exposure, w=bloomIntensity
  ana_time_frame_pad : vec4f, // x=anamorphicIntensity, y=time, z=f32(frameIndex & 255)
  weights_pad        : vec4f, // x=bloomWeight, y=anamorphicWeight, zw=0
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

// Fold AgX display EOTF pow(v, 2.2) with linear-to-sRGB pow(c, 1/2.4) inside an explicit branch
fn agxDisplayToSrgbChannel(v: f32) -> f32 {
  if (v >= 0.07272128) {
    return clamp(1.055 * pow(v, 0.91666667) - 0.055, 0.0, 1.0);
  }
  return clamp(12.92 * pow(max(v, 0.0), 2.2), 0.0, 1.0);
}

fn agxToneMapToSrgb(linearColor: vec3f) -> vec3f {
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

  return vec3f(
    agxDisplayToSrgbChannel(val.r),
    agxDisplayToSrgbChannel(val.g),
    agxDisplayToSrgbChannel(val.b)
  );
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

  var sceneRaw = textureSampleLevel(uSceneTex, sLinear, in.uv, 0.0).rgb;
  if (r2 > 0.04) {
    let caOffset = centered * (r2 * 0.0024);
    sceneRaw.r = textureSampleLevel(uSceneTex, sLinear, clamp(in.uv + caOffset, vec2f(0.0), vec2f(1.0)), 0.0).r;
    sceneRaw.b = textureSampleLevel(uSceneTex, sLinear, clamp(in.uv - caOffset, vec2f(0.0), vec2f(1.0)), 0.0).b;
  }
  let scene = max(sanitizeVec3Zero(sceneRaw), vec3f(0.0));

  let bloom = max(textureSampleLevel(uBloomTex, sLinear, in.uv, 0.0).rgb, vec3f(0.0));
  let anamorphic = max(textureSampleLevel(uAnamorphicTex, sLinear, in.uv, 0.0).rgb, vec3f(0.0));

  let bloomIntensity = u.res_exposure_bloom.w;
  let anamorphicIntensity = u.ana_time_frame_pad.x;
  let exposure = u.res_exposure_bloom.z;

  var hdr = scene
          + bloom * (bloomIntensity * u.weights_pad.x)
          + anamorphic * (anamorphicIntensity * u.weights_pad.y);

  hdr *= max(exposure, 0.01);

  let res = max(u.res_exposure_bloom.xy, vec2f(1.0));
  let aspect = res.x / res.y;
  let vigCoord = centered * vec2f(min(aspect, 1.65) * 0.85, 1.0);
  let vignette = 1.0 - smoothstep(0.36, 1.18, length(vigCoord)) * 0.24;
  hdr *= vignette;

  var srgb = agxToneMapToSrgb(hdr);

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
