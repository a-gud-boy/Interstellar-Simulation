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

struct WarpUniforms {
  resolution_time_frame : vec4<f32>,  // (width, height, time, float(frameIndex))
  jitter_fov_mode       : vec4<f32>,  // (jitterX, jitterY, fovY, float(cameraMode))
  camPos_metric         : vec4<f32>,  // (camX, camY, camZ, float(metricType))
  camRight_vs           : vec4<f32>,  // (rightX, rightY, rightZ, warpVelocity)
  camUp_R               : vec4<f32>,  // (upX, upY, upZ, bubbleRadius)
  camFwd_sigma          : vec4<f32>,  // (fwdX, fwdY, fwdZ, wallThickness)
  physicsParams         : vec4<f32>,  // (dopplerStrength, wallShimmer, causticGlow, starStreaks)
  skyParams             : vec4<f32>,  // (skyIntensity, float(skyMode), skyRotX, skyRotY)
  qualityParams         : vec4<f32>,  // (float(quality), flowSpeed, frameBlend, 0.0)
};

@group(0) @binding(0) var<uniform> u: WarpUniforms;
@group(0) @binding(1) var uVolumeNoise: texture_3d<f32>;
@group(0) @binding(2) var sVolume: sampler;
@group(0) @binding(3) var uSkyMap: texture_2d<f32>;
@group(0) @binding(4) var uProcSkyMap: texture_2d<f32>;
@group(0) @binding(5) var sSky: sampler;
@group(0) @binding(6) var uBlackbodyLut: texture_2d<f32>;
@group(0) @binding(7) var sLut: sampler;
@group(0) @binding(8) var uBlueNoise: texture_2d<f32>;

const PI               : f32 = 3.14159265359;
const TAU              : f32 = 6.28318530718;
const INV_PI           : f32 = 0.31830988618;
const INV_TAU          : f32 = 0.15915494309;
const T_MIN            : f32 = 800.0;
const T_MAX            : f32 = 40000.0;
const INV_LOG_T_SPAN   : f32 = 1.0 / 3.91202300543;

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

// ============================================================================
// 1. NVIDIA-SAFE HYPERBOLIC HELPERS & ADM WARP METRIC JACOBIANS
// ============================================================================

struct WarpConsts {
  R           : f32,
  invR        : f32,
  sigma       : f32,
  sigma2      : f32,
  v_s         : f32,
  frameBlend  : f32,
  extShiftZ   : f32,
  invDenom2   : f32,
  sigmaInvD2  : f32,
  sigma2InvD1 : f32,
  dfOverR0    : f32,
  dhOverR0    : f32,
  wallStep    : f32,
  invSigma16  : f32,
  weakTailR   : f32,
  rFlatIn     : f32,
  lentzEps2   : f32,
  advZWall    : f32,
  advZDust    : f32,
  bridgeAtten : f32,
  scaleGain   : f32,
  speedGain   : f32,
  rDustInner  : f32,
  rDustKnee   : f32,
  rDustOuter  : f32,
  invDustFall : f32,
  metricType  : i32,
};

fn safeTanh(x: f32) -> f32 {
  return tanh(clamp(x, -15.0, 15.0));
}

struct ShapeResult {
  f       : f32,
  df      : f32,
  d2f     : f32,
  dfOverR : f32,
};

fn evalShape(r: f32, wc: WarpConsts, needD2f: bool) -> ShapeResult {
  let a = wc.sigma * (r + wc.R);
  let b = wc.sigma * (r - wc.R);
  let ta = safeTanh(a);
  let tb = safeTanh(b);
  let sa = max(1.0 - ta * ta, 0.0);
  let sb = max(1.0 - tb * tb, 0.0);

  var s: ShapeResult;
  s.f = (ta - tb) * wc.invDenom2;
  s.df = wc.sigmaInvD2 * (sa - sb);
  s.d2f = 0.0;
  if (needD2f) {
    s.d2f = wc.sigma2InvD1 * (-sa * ta + sb * tb);
  }
  if (r < 1e-3) {
    s.dfOverR = wc.dfOverR0;
  } else {
    s.dfOverR = s.df / r;
  }
  return s;
}

struct MetricSample {
  beta  : vec3f,
  dBdx  : vec3f,
  dBdy  : vec3f,
  dBdz  : vec3f,
  theta : f32,
  t00   : f32,
  rEff  : f32,
};

fn evalMetric(pos: vec3f, wc: WarpConsts) -> MetricSample {
  var m: MetricSample;
  let r2 = dot(pos, pos);
  let r = sqrt(r2);

  if (wc.metricType == 0) {
    let sh = evalShape(r, wc, false);
    m.beta = vec3f(0.0, 0.0, wc.v_s * (1.0 - sh.f));
    m.dBdx = vec3f(0.0, 0.0, -wc.v_s * sh.dfOverR * pos.x);
    m.dBdy = vec3f(0.0, 0.0, -wc.v_s * sh.dfOverR * pos.y);
    m.dBdz = vec3f(0.0, 0.0, -wc.v_s * sh.dfOverR * pos.z);
    m.theta = -m.dBdz.z;
    m.t00 = -(m.dBdx.z * m.dBdx.z + m.dBdy.z * m.dBdy.z) / (32.0 * PI);
    m.rEff = r;
  } else if (wc.metricType == 1) {
    let sh = evalShape(r, wc, true);
    let h = sh.dfOverR;
    var dhOverR : f32;
    if (r < 2e-3) {
      dhOverR = wc.dhOverR0;
    } else {
      dhOverR = (sh.d2f - h) / (r * r);
    }
    let halfVs = 0.5 * wc.v_s;
    let rho2 = pos.x * pos.x + pos.y * pos.y;

    m.beta = vec3f(
      halfVs * h * pos.x * pos.z,
      halfVs * h * pos.y * pos.z,
      wc.v_s * (1.0 - sh.f) - halfVs * h * rho2
    );

    m.dBdx = vec3f(
      halfVs * (dhOverR * pos.x * pos.x * pos.z + h * pos.z),
      halfVs * (dhOverR * pos.x * pos.y * pos.z),
      -2.0 * wc.v_s * h * pos.x - halfVs * dhOverR * pos.x * rho2
    );
    m.dBdy = vec3f(
      halfVs * (dhOverR * pos.y * pos.x * pos.z),
      halfVs * (dhOverR * pos.y * pos.y * pos.z + h * pos.z),
      -2.0 * wc.v_s * h * pos.y - halfVs * dhOverR * pos.y * rho2
    );
    m.dBdz = vec3f(
      halfVs * (dhOverR * pos.z * pos.x * pos.z + h * pos.x),
      halfVs * (dhOverR * pos.z * pos.y * pos.z + h * pos.y),
      -wc.v_s * h * pos.z - halfVs * dhOverR * pos.z * rho2
    );

    m.theta = 0.0;
    let k01 = 0.5 * (m.dBdx.y + m.dBdy.x);
    let k02 = 0.5 * (m.dBdx.z + m.dBdz.x);
    let k12 = 0.5 * (m.dBdy.z + m.dBdz.y);
    let sumK2 =
      m.dBdx.x * m.dBdx.x +
      m.dBdy.y * m.dBdy.y +
      m.dBdz.z * m.dBdz.z +
      2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
    m.t00 = -sumK2 / (16.0 * PI);
    m.rEff = r;
  } else {
    const p : f32 = 1.38;
    const halfP : f32 = 0.69;
    let rho2 = pos.x * pos.x + pos.y * pos.y;
    let uVal = rho2 + wc.lentzEps2;
    let vVal = pos.z * pos.z + wc.lentzEps2;
    let aTerm = pow(uVal, halfP);
    let bTerm = pow(vVal, halfP);
    let sTerm = aTerm + bTerm;
    let rL = pow(sTerm, 1.0 / p);

    let kRho = (rL / sTerm) * (aTerm / uVal);
    let kZ = (rL / sTerm) * (bTerm / vVal);
    let drdx = kRho * pos.x;
    let drdy = kRho * pos.y;
    let drdz = kZ * pos.z;

    let sh = evalShape(rL, wc, true);
    let invRL = 1.0 / max(rL, 1e-3);
    let c = -0.28 * wc.v_s;
    let zArg = 2.0 * pos.z * wc.invR;
    let tz = safeTanh(zArg);
    let dtz = 2.0 * wc.invR * max(1.0 - tz * tz, 0.0);
    let gL = sh.df * invRL;
    let dgL = (sh.d2f - gL) * invRL;

    let sc = c * gL * tz;
    let dscdx = c * tz * dgL * drdx;
    let dscdy = c * tz * dgL * drdy;
    let dscdz = c * (tz * dgL * drdz + gL * dtz);

    m.beta = vec3f(sc * pos.x, sc * pos.y, wc.v_s * (1.0 - sh.f));
    m.dBdx = vec3f(sc + pos.x * dscdx, pos.y * dscdx, -wc.v_s * sh.df * drdx);
    m.dBdy = vec3f(pos.x * dscdy, sc + pos.y * dscdy, -wc.v_s * sh.df * drdy);
    m.dBdz = vec3f(pos.x * dscdz, pos.y * dscdz, -wc.v_s * sh.df * drdz);

    m.theta = -(m.dBdx.x + m.dBdy.y + m.dBdz.z);
    let k01 = 0.5 * (m.dBdx.y + m.dBdy.x);
    let k02 = 0.5 * (m.dBdx.z + m.dBdz.x);
    let k12 = 0.5 * (m.dBdy.z + m.dBdz.y);
    let sumK2 =
      m.dBdx.x * m.dBdx.x +
      m.dBdy.y * m.dBdy.y +
      m.dBdz.z * m.dBdz.z +
      2.0 * (k01 * k01 + k02 * k02 + k12 * k12);
    m.t00 = (m.theta * m.theta - sumK2) / (16.0 * PI);
    m.rEff = rL;
  }

  m.beta.z -= wc.extShiftZ;
  return m;
}

struct GeodesicDeriv {
  dp    : vec3f,
  dk    : vec3f,
  theta : f32,
  t00   : f32,
  rEff  : f32,
};

fn evalGeodesicRHS(pos: vec3f, k: vec3f, wc: WarpConsts) -> GeodesicDeriv {
  let m = evalMetric(pos, wc);
  let kLen = max(length(k), 1e-6);
  let khat = k / kLen;

  var d: GeodesicDeriv;
  d.dp = -khat + m.beta;
  d.dk = vec3f(
    -(k.x * m.dBdx.x + k.y * m.dBdx.y + k.z * m.dBdx.z),
    -(k.x * m.dBdy.x + k.y * m.dBdy.y + k.z * m.dBdy.z),
    -(k.x * m.dBdz.x + k.y * m.dBdz.y + k.z * m.dBdz.z)
  );
  d.theta = m.theta;
  d.t00 = m.t00;
  d.rEff = m.rEff;
  return d;
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT & MULTI-SPECTRAL STAR LAYERS
// ============================================================================

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
}

fn rotateSkyDir(d: vec3f, rot: vec2f) -> vec3f {
  let cy = cos(rot.x);
  let sy = sin(rot.x);
  let r1 = vec3f(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  let cp = cos(rot.y);
  let sp = sin(rot.y);
  return vec3f(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

fn hash33f(pIn: vec3f) -> vec3f {
  var p = fract(pIn * vec3f(0.1031, 0.1030, 0.0973));
  p += vec3f(dot(p, p.yxz + vec3f(33.33)));
  return fract((p.xxy + p.yxx) * p.zyx);
}

fn evalSpectralStarLayer(dir: vec3f, scale: f32, densityThresh: f32, boost: f32, pixelFw: f32, gEff: f32, spectralClass: i32) -> vec3f {
  let p = dir * scale;
  let cell = floor(p);
  let rnd = hash33f(cell);

  if (rnd.x < densityThresh) {
    return vec3f(0.0);
  }

  let starPos = cell + vec3f(0.22) + 0.56 * hash33f(cell + vec3f(19.17, 73.41, 41.83));
  let dist = length(p - starPos);

  let magU = clamp((rnd.x - densityThresh) / max(1.0 - densityThresh, 1e-4), 0.0, 1.0);
  let mag2 = magU * magU;
  let mag = mag2 * mag2 * sqrt(magU);

  let fw = clamp(pixelFw * scale, 0.018, 0.20);
  let starRad = mix(0.028, 0.088, mag) + fw * 0.42;
  let core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let ry = max(rnd.y, 0.0);
  var tEmit : f32;
  var bandpassGain : f32 = 1.0;

  if (spectralClass == 1) {
    tEmit = mix(1150.0, 1850.0, ry);
    bandpassGain = smoothstep(1.12, 2.25, gEff) * 1.55;
  } else if (spectralClass == 2) {
    tEmit = mix(20000.0, 32000.0, ry);
    bandpassGain = mix(0.32, 1.65, smoothstep(0.95, 0.22, gEff)) * smoothstep(0.03, 0.16, gEff);
  } else {
    tEmit = mix(3000.0, 22000.0, ry * ry);
    bandpassGain = smoothstep(0.06, 0.40, gEff);
  }

  if (bandpassGain < 0.002) {
    return vec3f(0.0);
  }

  let tObs = tEmit * gEff;
  let col = sampleBlackbody(tObs);
  let beamRaw = pow(clamp(gEff, 0.18, 3.6), 1.35);
  let beam = beamRaw / (1.0 + 0.14 * beamRaw);

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let lum = (0.12 + 3.6 * mag) * boost * energyComp * bandpassGain * beam;
  return col * (core * lum);
}

// ============================================================================
// 3. VOLUMETRIC EXOTIC WALL SHIMMER & INTERSTELLAR DUST STREAKS
// ============================================================================

struct WallSample {
  emit  : vec3f,
  ridge : f32,
};

fn evalWallShimmer(
  pos: vec3f,
  t00: f32,
  theta: f32,
  kLen: f32,
  wc: WarpConsts,
  wallShimmer: f32
) -> WallSample {
  var ws: WallSample;
  ws.emit = vec3f(0.0);
  ws.ridge = 0.0;
  if (wallShimmer <= 0.001) {
    return ws;
  }
  let absT00 = abs(t00);
  let absTheta = abs(theta);
  if (absT00 <= 1e-5 && absTheta <= 1e-3) {
    return ws;
  }

  let uv1 = pos * 0.26 + vec3f(0.0, 0.0, wc.advZWall * 0.34);
  let uv2 = pos * 0.64 + vec3f(0.17, 0.41, wc.advZWall * 0.72);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, uv1, 0.0);
  let n2 = textureSampleLevel(uVolumeNoise, sVolume, uv2, 0.0);

  let filaments = clamp(n1.g * 0.60 + n2.a * 0.52, 0.0, 1.0);
  let sharpFil = smoothstep(0.42, 0.94, filaments);
  let ridge = sharpFil * sharpFil * sharpFil * (0.40 + 0.60 * n1.b);
  ws.ridge = ridge;
  let turbMod = 0.008 + 1.55 * ridge;

  let normT00 = absT00 / (absT00 + 0.095);
  let normTheta = absTheta / (absTheta + 1.65);

  var negCol = mix(
    vec3f(0.02, 0.48, 1.00),
    vec3f(0.26, 0.12, 0.88),
    clamp(1.0 - n1.g, 0.0, 1.0) * 0.72
  );
  negCol = mix(negCol, vec3f(0.55, 0.94, 1.00), sharpFil * sharpFil * 0.65);

  let posCol = mix(
    vec3f(1.00, 0.74, 0.18),
    vec3f(0.35, 0.90, 1.00),
    clamp(n2.a * 0.45, 0.0, 0.5)
  );

  let energyCol = select(negCol, posCol, t00 > 0.0);
  let energyWeight = select(normT00 * 1.08, normT00 * 0.72, wc.metricType == 1);

  let yorkCol = select(
    vec3f(0.62, 0.24, 0.82),
    vec3f(0.22, 0.82, 1.00),
    theta < 0.0
  );
  let yorkWeight = normTheta * 0.24 * (1.0 - wc.frameBlend);

  var causalAtten : f32 = 1.0;
  if (wc.frameBlend > 0.5) {
    causalAtten = pow(clamp(1.0 / max(kLen, 1.0), 1e-5, 1.0), 2.2);
  }

  ws.emit = (energyCol * energyWeight + yorkCol * yorkWeight) * turbMod * wallShimmer * wc.bridgeAtten * causalAtten * wc.scaleGain * 0.19;
  return ws;
}

fn evalDustStreak(
  pos: vec3f,
  r: f32,
  kLen: f32,
  wc: WarpConsts,
  starStreaks: f32
) -> vec3f {
  if (starStreaks <= 0.001 || r <= wc.rDustInner || r >= wc.rDustOuter) {
    return vec3f(0.0);
  }

  let radialEnv = smoothstep(wc.rDustInner, wc.rDustKnee, r) * exp(-max(r - wc.rDustKnee, 0.0) * wc.invDustFall);
  if (radialEnv < 0.002) {
    return vec3f(0.0);
  }

  let uvw = vec3f(pos.x * 0.28, pos.y * 0.28, pos.z * 0.055 + wc.advZDust);
  let sn = textureSampleLevel(uVolumeNoise, sVolume, uvw, 0.0);
  var streak = smoothstep(0.60, 0.95, sn.g * 0.62 + sn.a * 0.48);
  streak = streak * streak;

  let causalAtten = select(1.0, smoothstep(3.8, 1.3, kLen), wc.frameBlend > 0.5);

  var col = mix(vec3f(0.32, 0.72, 1.00), vec3f(0.84, 0.95, 1.00), sn.a);
  if (pos.z < 0.0) {
    col = mix(col, vec3f(0.70, 0.44, 0.92), smoothstep(0.0, -1.5 * wc.R, pos.z) * 0.45);
  }
  return col * (streak * radialEnv * starStreaks * wc.speedGain * causalAtten * 0.18);
}

// ============================================================================
// 4. SKY BACKGROUND & CAUSTIC / HAWKING RIM COMPOSITOR
// ============================================================================

const INV_BB_5800 : vec3f = vec3f(1.0, 1.137223, 1.209106);

fn sampleSkyBackground(
  rawDir: vec3f,
  rayDir: vec3f,
  escaped: bool,
  edgeMask: f32,
  gEff: f32,
  frameBlend: f32,
  causticGlow: f32,
  kFinal: f32,
  bendAngle: f32,
  skyIntensity: f32,
  skyMode: i32,
  skyRot: vec2f
) -> vec3f {
  let dir = normalize(rotateSkyDir(rawDir, skyRot));

  let u1 = atan2(dir.z, dir.x) * INV_TAU + 0.5;
  let v = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  let uv1 = vec2f(u1, v);
  let uv2 = vec2f(fract(u1 + 0.5), v);

  let dx1 = dpdx(uv1);
  let dy1 = dpdy(uv1);
  let dx2 = dpdx(uv2);
  let dy2 = dpdy(uv2);

  var dUVdx = vec2f(select(dx2.x, dx1.x, abs(dx1.x) < abs(dx2.x)), dx1.y);
  var dUVdy = vec2f(select(dy2.x, dy1.x, abs(dy1.x) < abs(dy2.x)), dy1.y);

  var dirFw = length(fwidth(dir));

  dUVdx = clamp(dUVdx, vec2f(-0.38), vec2f(0.38));
  dUVdy = clamp(dUVdy, vec2f(-0.38), vec2f(0.38));
  if (edgeMask > 0.01) {
    dirFw = min(dirFw, 0.08);
  }

  if (!escaped) {
    return vec3f(0.0);
  }

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.005, 0.995));
  var mapSrgb: vec3f;
  if (skyMode == 2) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(0.0)), vec3f(2.2));

  let skyLuma = dot(skyLin, vec3f(0.2126, 0.7152, 0.0722));
  skyLin *= mix(0.35, 1.0, smoothstep(0.002, 0.042, skyLuma));

  let brightCores = max(skyLin - vec3f(0.28), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.6;

  let tObsMw = 5800.0 * gEff;
  var bbMw = sampleBlackbody(tObsMw) * INV_BB_5800;
  if (gEff > 1.0) {
    bbMw = mix(bbMw, vec3f(0.58, 0.86, 1.24), smoothstep(1.2, 3.2, gEff) * 0.35);
  }
  let beamDiff = mix(1.0, pow(clamp(gEff, 0.16, 3.5), 0.55), 0.65) * smoothstep(0.02, 0.38, gEff);
  skyLin *= bbMw * beamDiff;

  if (skyMode == 0 || skyMode == 2) {
    let starGain = select(1.05, 0.75, skyMode == 0);
    let microStars = evalSpectralStarLayer(dir, 95.0,  0.908, 1.05 * starGain, dirFw, gEff, 0)
                   + evalSpectralStarLayer(dir, 195.0, 0.882, 0.48 * starGain, dirFw, gEff, 0)
                   + evalSpectralStarLayer(dir, 125.0, 0.892, 1.25 * starGain, dirFw, gEff, 1)
                   + evalSpectralStarLayer(dir, 140.0, 0.905, 1.00 * starGain, dirFw, gEff, 2);
    skyLin += microStars;
  }

  var causticColor = vec3f(0.0);
  if (causticGlow > 0.001) {
    if (frameBlend > 0.5) {
      let fwdCos = clamp(rayDir.z, 0.0, 1.0);
      let dRing = (fwdCos - 0.934) / 0.024;
      let bowRing = exp(-dRing * dRing) * smoothstep(1.12, 2.1, gEff);
      causticColor = vec3f(0.42, 0.88, 1.00) * (bowRing * 0.65 * causticGlow);
    } else {
      let dBend = (bendAngle - 0.62) / 0.28;
      let chaseBow = exp(-dBend * dBend) * smoothstep(1.25, 2.3, gEff);
      causticColor = vec3f(0.42, 0.88, 1.00) * (chaseBow * 0.24 * causticGlow);
    }
  }

  let hawkingRamp = smoothstep(16.0, 27.8, kFinal);
  let hawkingRim = vec3f(1.00, 0.24, 0.05) * (hawkingRamp * hawkingRamp * 0.46);

  return skyLin * max(skyIntensity, 0.0) + causticColor + hawkingRim;
}

// ============================================================================
// 5. MAIN ADAPTIVE ADM NULL GEODESIC RK4 / RK2 RAY-MARCHER
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_mode.x, -u.jitter_fov_mode.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = tan(clamp(u.jitter_fov_mode.z, 0.1, 2.8) * 0.5);
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let camBasis = mat3x3f(
    u.camRight_vs.xyz,
    u.camUp_R.xyz,
    u.camFwd_sigma.xyz
  );
  let rayDir = normalize(camBasis * localRay);

  let simTime = u.resolution_time_frame.z;
  let frameIndex = i32(round(u.resolution_time_frame.w));
  let metricType = clamp(i32(round(u.camPos_metric.w)), 0, 2);
  let v_s = max(u.camRight_vs.w, 0.0);
  let R = max(u.camUp_R.w, 0.5);
  let sigma = max(u.camFwd_sigma.w, 0.3);

  let dopplerStrength = clamp(u.physicsParams.x, 0.0, 1.5);
  let wallShimmer = max(u.physicsParams.y, 0.0);
  let causticGlow = max(u.physicsParams.z, 0.0);
  let starStreaks = max(u.physicsParams.w, 0.0);

  let skyIntensity = max(u.skyParams.x, 0.0);
  let skyMode = i32(round(u.skyParams.y));
  let skyRot = u.skyParams.zw;

  let quality = i32(round(u.qualityParams.x));
  let flowSpeed = max(u.qualityParams.y, 0.0);
  let frameBlend = clamp(u.qualityParams.z, 0.0, 1.0);

  let invR = 1.0 / max(R, 1e-3);
  let sigma2 = sigma * sigma;
  let tanhSR = safeTanh(sigma * R);
  let sech2SR = max(1.0 - tanhSR * tanhSR, 0.0);
  let invDenom2 = 1.0 / max(2.0 * tanhSR, 1e-5);
  let lentzEps = 0.12 * R;

  var wc: WarpConsts;
  wc.R = R;
  wc.invR = invR;
  wc.sigma = sigma;
  wc.sigma2 = sigma2;
  wc.v_s = v_s;
  wc.frameBlend = frameBlend;
  wc.extShiftZ = (1.0 - frameBlend) * v_s;
  wc.invDenom2 = invDenom2;
  wc.sigmaInvD2 = sigma * invDenom2;
  wc.sigma2InvD1 = sigma2 / max(tanhSR, 1e-5);
  wc.dfOverR0 = -2.0 * sigma2 * sech2SR;
  wc.dhOverR0 = (8.0 / 3.0) * (sigma2 * sigma2) * sech2SR * (3.0 * sech2SR - 1.0);
  wc.wallStep = 0.14 / sigma;
  wc.invSigma16 = 1.6 / sigma;
  wc.weakTailR = 2.0 / sigma;
  wc.rFlatIn = R - 4.0 / sigma;
  wc.lentzEps2 = lentzEps * lentzEps;
  wc.advZWall = simTime * flowSpeed;
  wc.advZDust = simTime * flowSpeed * (0.45 + 0.18 * min(v_s, 3.5));
  wc.bridgeAtten = mix(1.0, 0.18, frameBlend);
  wc.scaleGain = mix(1.0, 0.80, clamp((sigma - 2.2) / 3.5, 0.0, 1.0));
  wc.speedGain = 0.35 + 0.25 * min(v_s, 3.5);
  wc.rDustInner = R * 1.04;
  wc.rDustKnee = R * 1.28;
  wc.rDustOuter = R * 2.85;
  wc.invDustFall = 1.0 / max(R * 0.68, 0.5);
  wc.metricType = metricType;

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(frameIndex & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  var maxSteps : i32 = 560;
  var qualScale : f32 = 1.00;
  if (quality <= 0) {
    maxSteps = 400;
    qualScale = 1.25;
  } else if (quality >= 2) {
    maxSteps = 720;
    qualScale = 0.78;
  }

  let escapeR = max(R + 7.5 / sigma, max(R + 4.5, 2.2 * R));
  let dustR = max(escapeR, wc.rDustOuter);

  var pos = u.camPos_metric.xyz;
  var k = -rayDir;

  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;
  var integratedNegTheta : f32 = 0.0;
  var captured = false;
  var escaped = false;
  var runLoop = true;

  if (frameBlend < 0.01 && length(pos) > escapeR) {
    let tClose = -dot(pos, rayDir);
    if (tClose <= 0.0) {
      escaped = true;
      runLoop = false;
    } else {
      let b2 = dot(pos, pos) - tClose * tClose;
      if (b2 >= escapeR * escapeR) {
        escaped = true;
        runLoop = false;
        if (starStreaks > 0.001 && b2 < dustR * dustR) {
          let halfChord = sqrt(dustR * dustR - b2);
          let tStart = max(0.0, tClose - halfChord);
          let tEnd = tClose + halfChord;
          let dtDust = (tEnd - tStart) / 16.0;
          for (var s: i32 = 0; s < 16; s++) {
            let tS = tStart + (f32(s) + bn.x) * dtDust;
            let dPos = pos + rayDir * tS;
            radiance += transmittance * evalDustStreak(dPos, length(dPos), 1.0, wc, starStreaks) * dtDust;
          }
        }
      } else {
        let tEntEsc = tClose - sqrt(escapeR * escapeR - b2);
        if (starStreaks > 0.001 && b2 < dustR * dustR) {
          let tEntDust = max(0.0, tClose - sqrt(dustR * dustR - b2));
          if (tEntEsc > tEntDust) {
            let dtDust = (tEntEsc - tEntDust) / 12.0;
            for (var s: i32 = 0; s < 12; s++) {
              let tS = tEntDust + (f32(s) + bn.x) * dtDust;
              let dPos = pos + rayDir * tS;
              radiance += transmittance * evalDustStreak(dPos, length(dPos), 1.0, wc, starStreaks) * dtDust;
            }
          }
        }
        pos = pos + rayDir * tEntEsc;
      }
    }
  }

  for (var step: i32 = 0; step < 720; step++) {
    if (!runLoop || step >= maxSteps) { break; }

    let kLen = length(k);
    if (kLen > 28.0) {
      captured = true;
      break;
    }

    let r = length(pos);
    // Flat-space inner core analytic jump (skipped for Lentz, stays strictly inside rFlatIn < rDustInner)
    if (metricType != 2 && wc.rFlatIn > 0.25 && r < wc.rFlatIn - 0.05) {
      let kHat = k / max(kLen, 1e-6);
      let vFlat = -kHat + vec3f(0.0, 0.0, -wc.extShiftZ);
      let vFlatLen = length(vFlat);
      if (vFlatLen > 1e-4) {
        let vFlatDir = vFlat / vFlatLen;
        let bDot = dot(pos, vFlatDir);
        let disc = bDot * bDot - (dot(pos, pos) - wc.rFlatIn * wc.rFlatIn);
        if (disc > 0.0) {
          let tExit = -bDot + sqrt(disc);
          if (tExit > 0.05) {
            pos += vFlatDir * tExit;
            continue;
          }
        }
      }
    }

    let k1 = evalGeodesicRHS(pos, k, wc);
    if (r > escapeR && dot(pos, k1.dp) > 0.0) {
      escaped = true;
      break;
    }

    let speedCap = max(length(k1.dp), 1.0);
    let wallDist = abs(k1.rEff - R);
    let safeDistStep = wc.wallStep + 0.40 * max(wallDist - wc.invSigma16, 0.0);
    let maxSp = min(0.32 * R, safeDistStep) * qualScale;
    let ds = maxSp / speedCap;

    var posNext: vec3f;
    var kNext: vec3f;
    var endT00: f32;
    var endTheta: f32;
    if (wallDist > wc.weakTailR && kLen < 8.0) {
      let k2 = evalGeodesicRHS(pos + (0.5 * ds) * k1.dp, k + (0.5 * ds) * k1.dk, wc);
      posNext = pos + ds * k2.dp;
      kNext = k + ds * k2.dk;
      integratedNegTheta += -k2.theta * ds;
      endT00 = k2.t00;
      endTheta = k2.theta;
    } else {
      let k2 = evalGeodesicRHS(pos + (0.5 * ds) * k1.dp, k + (0.5 * ds) * k1.dk, wc);
      let k3 = evalGeodesicRHS(pos + (0.5 * ds) * k2.dp, k + (0.5 * ds) * k2.dk, wc);
      let k4 = evalGeodesicRHS(pos + ds * k3.dp, k + ds * k3.dk, wc);

      posNext = pos + (ds / 6.0) * (k1.dp + 2.0 * k2.dp + 2.0 * k3.dp + k4.dp);
      kNext = k + (ds / 6.0) * (k1.dk + 2.0 * k2.dk + 2.0 * k3.dk + k4.dk);
      integratedNegTheta += (-0.5 * (k1.theta + k4.theta)) * ds;
      endT00 = k4.t00;
      endTheta = k4.theta;
    }

    let segLen = length(posNext - pos);
    let bnStep = fract(bn.y + f32(step) * 0.61803399);
    let kNextLen = length(kNext);

    let hasWall = (wallShimmer > 0.001) && (max(abs(k1.t00), abs(endT00)) > 1e-5 || max(abs(k1.theta), abs(endTheta)) > 1e-3);
    if (hasWall) {
      let nVol = clamp(i32(ceil(segLen / 0.18)), 1, 5);
      let subLen = segLen / f32(nVol);
      for (var vsIdx: i32 = 0; vsIdx < 5; vsIdx++) {
        if (vsIdx >= nVol) { break; }
        let subBn = fract(bnStep + f32(vsIdx) * 0.61803399);
        let uSub = (f32(vsIdx) + subBn) / f32(nVol);
        let sPos = mix(pos, posNext, uSub);
        let kSubLen = mix(kLen, kNextLen, uSub);
        let t00Sub = mix(k1.t00, endT00, uSub);
        let thetaSub = mix(k1.theta, endTheta, uSub);

        let ws = evalWallShimmer(sPos, t00Sub, thetaSub, kSubLen, wc, wallShimmer);
        let volEmit = ws.emit;
        let ext = select(0.0, min(abs(t00Sub), 0.4) * (0.04 + 0.22 * ws.ridge) * wallShimmer, frameBlend < 0.5);
        if (dot(volEmit, volEmit) > 1e-10 || ext > 1e-6) {
          let tau = ext * subLen;
          let stepT = exp(-tau);
          var stepRad: vec3f;
          if (tau > 1e-4) {
            stepRad = volEmit * ((1.0 - stepT) / max(ext, 1e-5));
          } else {
            stepRad = volEmit * subLen;
          }
          radiance += transmittance * stepRad;
          transmittance *= stepT;
          if (transmittance < 0.01) { break; }
        }
      }
    }

    if (starStreaks > 0.001 && transmittance > 0.01) {
      let dFrac = fract(bnStep + 0.38196601);
      let dPos = mix(pos, posNext, dFrac);
      let dR = length(dPos);
      if (dR > wc.rDustInner && dR < wc.rDustOuter) {
        let dKLen = mix(kLen, kNextLen, dFrac);
        radiance += transmittance * evalDustStreak(dPos, dR, dKLen, wc, starStreaks) * segLen;
      }
    }

    pos = posNext;
    k = kNext;

    if (transmittance < 0.01) {
      break;
    }
  }

  let kFinal = max(length(k), 1e-4);
  if (!captured && !escaped) {
    if (v_s >= 0.99 && kFinal > 22.0) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  let finalDir = -k / kFinal;

  if (runLoop && escaped && !captured && starStreaks > 0.001 && length(pos) < dustR) {
    let dEnd = evalGeodesicRHS(pos, k, wc);
    let dEndLen = length(dEnd.dp);
    if (dEndLen > 1e-4) {
      let exitVel = dEnd.dp / dEndLen;
      let bExit = dot(pos, exitVel);
      let disc = bExit * bExit - (dot(pos, pos) - dustR * dustR);
      if (disc > 0.0) {
        let remDist = max(0.0, -bExit + sqrt(disc));
        let dtDust = remDist / 12.0;
        for (var s: i32 = 0; s < 12; s++) {
          let tS = (f32(s) + bn.z) * dtDust;
          let dPos = pos + exitVel * tS;
          radiance += transmittance * evalDustStreak(dPos, length(dPos), kFinal, wc, starStreaks) * dtDust;
        }
      }
    }
  }

  let gRaw = select(
    exp(clamp(integratedNegTheta + v_s * (finalDir.z - rayDir.z), -2.4, 2.4)),
    1.0 / kFinal,
    frameBlend > 0.5
  );
  let gEff = mix(1.0, gRaw, dopplerStrength);

  let bendAngle = acos(clamp(dot(rayDir, finalDir), -1.0, 1.0));
  let escFlag = select(0.0, 1.0, escaped && !captured && transmittance > 0.008);
  let edgeMask = fwidth(escFlag);

  let fdLen = length(finalDir);
  let safeSkyDir = select(rayDir, finalDir / max(fdLen, 1e-5), fdLen > 1e-5);
  let skyColor = sampleSkyBackground(
    safeSkyDir,
    rayDir,
    escFlag > 0.5,
    edgeMask,
    gEff,
    frameBlend,
    causticGlow,
    kFinal,
    bendAngle,
    skyIntensity,
    skyMode,
    skyRot
  );

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  } else if (captured) {
    radiance = radiance * 0.12;
  }

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));
  return vec4f(radiance, 1.0);
}
