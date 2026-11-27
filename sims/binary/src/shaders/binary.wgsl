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

struct BinaryUniforms {
  resolution_time_frame : vec4f, // x=res.x, y=res.y, z=time, w=f32(frameIndex)
  jitter_fov_phase      : vec4f, // x=jitterX, y=jitterY, z=fovY, w=phaseRad
  camPos_relMode        : vec4f, // xyz=camPos, w=relativisticMode
  camRight_lensing      : vec4f, // xyz=camBasis[0], w=lensingStrength
  camUp_diskTemp        : vec4f, // xyz=camBasis[1], w=diskTemp
  camForward_diskDens   : vec4f, // xyz=camBasis[2], w=diskDensity
  diskParams            : vec4f, // x=diskThickness, y=diskOuterRadius, z=turbulence, w=bridgeIntensity
  gw_skyParams          : vec4f, // x=gwAmplitude, y=skyIntensity, z=skyRotation.x, w=skyRotation.y
  modes_pad             : vec4i, // x=frameIndex, y=skyMode, z=quality, w=0
  binaryMass_sep        : vec4f, // x=m1, y=m2, z=d, w=eta
  binaryC1_omega        : vec4f, // xyz=c1, w=omega
  binaryC2_gwOmega      : vec4f, // xyz=c2, w=gwWaveOmega
  binaryV1_rH1          : vec4f, // xyz=v1, w=rH1
  binaryV2_rH2          : vec4f, // xyz=v2, w=rH2
  field_rayConsts       : vec4f, // x=fieldHalfSize, y=escapeR, z=tanHalfFov, w=rCavity
  flowConsts            : vec4f, // x=flowBlend, y=dt0, z=dt1, w=globalRot
  rotTrig_skyTrig       : vec4f, // x=cos(phase), y=sin(phase), z=cos(skyRot.x), w=sin(skyRot.x)
  skyY_ringdown         : vec4f, // x=cos(skyRot.y), y=sin(skyRot.y), z=ringdownFactor, w=maxDiskSlabY
};

@group(0) @binding(0) var<uniform> u: BinaryUniforms;
@group(0) @binding(1) var uVolumeNoise: texture_3d<f32>;
@group(0) @binding(2) var sVolume: sampler;
@group(0) @binding(3) var uSkyMap: texture_2d<f32>;
@group(0) @binding(4) var uProcSkyMap: texture_2d<f32>;
@group(0) @binding(5) var sSky: sampler;
@group(0) @binding(6) var uBlackbodyLut: texture_2d<f32>;
@group(0) @binding(7) var sLut: sampler;
@group(0) @binding(8) var uBlueNoise: texture_2d<f32>;
@group(0) @binding(9) var uTidalField: texture_2d<f32>;

const PI       : f32 = 3.14159265359;
const TAU      : f32 = 6.28318530718;
const INV_PI   : f32 = 0.31830988618;
const INV_TAU  : f32 = 0.15915494309;
const T_MIN    : f32 = 800.0;
const T_MAX    : f32 = 40000.0;
const INV_LOG_T_SPAN : f32 = 1.0 / 3.91202300543;

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
// 1. BRILL-LINDQUIST BINARY METRIC, 1PN FRAME-DRAGGING & CARTESIAN TT GW
// ============================================================================

struct GwConsts {
  r0         : f32,
  r0Sq       : f32,
  invSpan    : f32,
  A0         : f32,
  twoPhase   : f32,
  twoGwOmega : f32,
  hasGw      : bool,
};

struct GeodesicFull {
  dv  : vec3f,
  phi : f32,
  r1  : f32,
  r2  : f32,
};

fn rotOrbXZ(xz: vec2f, cosOrb: f32, sinOrb: f32) -> vec2f {
  return vec2f(
    xz.x * cosOrb - xz.y * sinOrb,
    xz.x * sinOrb + xz.y * cosOrb
  );
}

fn evalGeodesicFull(pos: vec3f, dir: vec3f) -> GeodesicFull {
  let m1 = u.binaryMass_sep.x;
  let m2 = u.binaryMass_sep.y;
  let lensing = u.camRight_lensing.w;

  let d1 = pos - u.binaryC1_omega.xyz;
  let d2 = pos - u.binaryC2_gwOmega.xyz;
  let r1Sq = max(dot(d1, d1), 1e-10);
  let r2Sq = max(dot(d2, d2), 1e-10);
  let invR1 = inverseSqrt(r1Sq);
  let invR2 = inverseSqrt(r2Sq);
  let r1 = r1Sq * invR1;
  let r2 = r2Sq * invR2;

  let phi1 = 0.5 * m1 * invR1;
  let phi2 = 0.5 * m2 * invR2;
  let phi = phi1 + phi2;

  let invR1_3 = invR1 * invR1 * invR1;
  let invR2_3 = invR2 * invR2 * invR2;
  let k1 = -0.5 * m1 * invR1_3;
  let k2 = -0.5 * m2 * invR2_3;
  let gradPhi = k1 * d1 + k2 * d2;

  let phiC = min(phi, 0.95);
  let blFactor = lensing * ((4.0 - 2.0 * phiC) / max(1.0 - phiC * phiC, 0.05));
  let gradTot = blFactor * gradPhi;

  var dv = gradTot - dot(gradTot, dir) * dir;

  if (lensing > 1e-6 && phi > 0.012) {
    let opPhi = 1.0 + phiC;
    let invN = min(max(1.0 - phiC, 0.05) / (opPhi * opPhi * opPhi), 1.0);
    let Bg = 8.0 * (k1 * cross(d1, u.binaryV1_rH1.xyz) + k2 * cross(d2, u.binaryV2_rH2.xyz));
    dv += (lensing * invN) * cross(dir, Bg);
  }

  var outD: GeodesicFull;
  outD.dv = dv;
  outD.phi = phi;
  outD.r1 = r1;
  outD.r2 = r2;
  return outD;
}

fn evalGeodesicAccel(pos: vec3f, dir: vec3f) -> vec3f {
  return evalGeodesicFull(pos, dir).dv;
}

fn evalGwKick(pos: vec3f, dir: vec3f, gwc: GwConsts) -> vec4f {
  let R2 = dot(pos, pos);
  let invR = inverseSqrt(max(R2, 1e-10));
  let R = R2 * invR;
  if (R <= gwc.r0) {
    return vec4f(0.0);
  }

  let nHat = pos * invR;
  let t = clamp((R - gwc.r0) * gwc.invSpan, 0.0, 1.0);
  let ramp = t * t * (3.0 - 2.0 * t);
  let dRamp = select(0.0, 6.0 * t * (1.0 - t) * gwc.invSpan, t > 0.0 && t < 1.0);

  let decayDen = 1.0 + 0.055 * R;
  let decay = exp(-R * 0.0105263158) / decayDen;
  let dDecay = -decay * (0.055 / decayDen + 0.0105263158);

  let A = gwc.A0 * ramp * decay;
  let dAdR = gwc.A0 * (dRamp * decay + ramp * dDecay);

  let twoPhiRet = gwc.twoPhase - gwc.twoGwOmega * R;
  let c = cos(twoPhiRet);
  let s = sin(twoPhiRet);

  let vPerp = dir - dot(dir, nHat) * nHat;
  let vp2 = dot(vPerp, vPerp);
  let qv = vPerp.x * vPerp.x - vPerp.z * vPerp.z;
  let uv = 2.0 * vPerp.x * vPerp.z;
  let qn = nHat.x * nHat.x - nHat.z * nHat.z;
  let un = 2.0 * nHat.x * nHat.z;

  let C1 = qv + 0.5 * vp2 * qn;
  let C2 = uv + 0.5 * vp2 * un;
  let S = c * C1 + s * C2;
  let dSdPhi = s * C1 - c * C2;

  let radialCoeff = 0.5 * (gwc.twoGwOmega * A * dSdPhi + dAdR * S);
  let aGw = radialCoeff * (nHat - dot(nHat, dir) * dir);
  let iswTerm = 0.9 * gwc.twoGwOmega * A * (-dSdPhi);
  return vec4f(aGw, iswTerm);
}

// ============================================================================
// 2. CIE-1931 PLANCK BLACKBODY LUT
// ============================================================================

fn sampleBlackbody(tempK: f32) -> vec3f {
  let t = clamp(tempK, T_MIN, T_MAX);
  let uCoord = clamp(log(t / T_MIN) * INV_LOG_T_SPAN, 0.0, 1.0);
  return textureSampleLevel(uBlackbodyLut, sLut, vec2f(uCoord, 0.5), 0.0).rgb;
}

// ============================================================================
// 3. 3D VOLUMETRIC CIRCUMBINARY DISK, TIDAL BRIDGES & TWIN MINI-DISKS
// ============================================================================

fn diskScaleHeight(rCom: f32, d1: f32, d2: f32, rCav: f32, rOuter: f32) -> f32 {
  let dClosest = min(d1, d2);
  let hMini = 0.034 + 0.044 * dClosest;
  let rNorm = clamp((rCom - rCav) / max(rOuter - rCav, 1.0), 0.0, 1.0);
  let sr = sqrt(rNorm);
  let powApprox = mix(sr, sr * sqrt(sr), 0.88);
  let hCbd = 0.054 + 0.033 * rCom * (0.42 + 0.85 * powApprox);
  let inCbd = smoothstep(rCav * 0.70, rCav * 1.15, rCom);
  return mix(hMini, hCbd, inCbd) * max(u.diskParams.x, 0.15);
}

fn sampleDiskNoise(posRotXZ: vec2f, rCom: f32, phiRot: f32, logR: f32, yNorm: f32, rCav: f32, lowDetail: bool) -> vec4f {
  let simTime = u.resolution_time_frame.z;
  let phiU = phiRot * INV_TAU;
  let inCbd = smoothstep(rCav * 0.65, rCav * 1.15, rCom);

  let rm = max(rCom, 0.85);
  let omegaVis = 1.35 / (rm * sqrt(sqrt(rm)) + 0.35);
  let blend     = u.flowConsts.x;
  let dt0       = u.flowConsts.y;
  let dt1       = u.flowConsts.z;
  let globalRot = u.flowConsts.w;

  let spiralU0 = phiU + 2.25 * logR - (omegaVis * dt0 + globalRot) * INV_TAU;
  let spiralU1 = phiU + 2.25 * logR - (omegaVis * dt1 + globalRot) * INV_TAU;
  let radV0    = logR * 1.12 + dt0 * 0.010;
  let radV1    = logR * 1.12 + dt1 * 0.010;
  let zCoord   = yNorm * 0.28 + 0.5;

  let n0 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(spiralU0, radV0, zCoord), 0.0);
  let n1 = textureSampleLevel(uVolumeNoise, sVolume, vec3f(spiralU1, radV1, zCoord), 0.0);
  let cbdNoise = mix(n1, n0, blend);

  if (lowDetail) {
    return cbdNoise;
  }

  let mhdWarpU = (cbdNoise.r - 0.5) * 0.09 + (cbdNoise.b - 0.5) * 0.05;
  let mhdWarpV = (cbdNoise.r - 0.5) * 0.34 + (cbdNoise.g - 0.5) * 0.16;
  let fineU = 2.0 * phiU + 4.65 * logR - (globalRot * 2.2) * INV_TAU + mhdWarpU;
  let fineV = logR * 3.05 + mhdWarpV;

  let detail = textureSampleLevel(uVolumeNoise, sVolume, vec3f(fineU, fineV, yNorm * 0.52 + 0.25), 0.0);

  let cbdCombined = vec4f(
    mix(cbdNoise.r, detail.r, 0.42),
    mix(cbdNoise.g, detail.g, 0.56),
    mix(cbdNoise.b, detail.b, 0.44),
    mix(cbdNoise.a, detail.a, 0.70)
  );

  if (inCbd >= 0.999) {
    return cbdCombined;
  }

  let innerUvw = vec3f(posRotXZ * (0.28 + 0.12 * (1.0 - inCbd)) - vec2f(simTime * 0.04, 0.0), yNorm * 0.32 + 0.5);
  let innerNoise = textureSampleLevel(uVolumeNoise, sVolume, innerUvw, 0.0);
  return mix(innerNoise, cbdCombined, mix(0.35, 1.0, inCbd));
}

struct DiskSample {
  emission   : vec3f,
  extinction : f32,
};

fn evalDiskVolume(
  posY: f32,
  posRotXZ: vec2f,
  dir: vec3f,
  phiPot: f32,
  cosOrb: f32,
  sinOrb: f32,
  camDistFade: f32,
  lowDetail: bool
) -> DiskSample {
  var outDisk: DiskSample;
  outDisk.emission = vec3f(0.0);
  outDisk.extinction = 0.0;

  if (phiPot >= 0.88) {
    return outDisk;
  }

  let fieldHalfSize = max(u.field_rayConsts.x, 1.0);
  let uvTidal = posRotXZ / (2.0 * fieldHalfSize) + 0.5;
  if (uvTidal.x <= 0.002 || uvTidal.x >= 0.998 || uvTidal.y <= 0.002 || uvTidal.y >= 0.998) {
    return outDisk;
  }

  let tidal = textureSampleLevel(uTidalField, sLut, uvTidal, 0.0);
  let sigma = tidal.r;
  if (sigma < 1e-4) {
    return outDisk;
  }

  let rCom = length(posRotXZ);
  let m1 = u.binaryMass_sep.x;
  let m2 = u.binaryMass_sep.y;
  let d = u.binaryMass_sep.z;
  let rCav = u.field_rayConsts.w;
  let rOuter = max(u.diskParams.y, rCav + 4.0);

  let d1XZ = length(posRotXZ - vec2f(-m2 * d, 0.0));
  let d2XZ = length(posRotXZ - vec2f(m1 * d, 0.0));
  let H = diskScaleHeight(rCom, d1XZ, d2XZ, rCav, rOuter);
  let absY = abs(posY);
  if (absY > H * 2.65) {
    return outDisk;
  }

  let yNorm = posY / max(H, 1e-4);
  let absYNorm = abs(yNorm);
  let logR = log(max(rCom, 0.55));
  let phiRot = atan2(posRotXZ.y, posRotXZ.x);
  let n = sampleDiskNoise(posRotXZ, rCom, phiRot, logR, yNorm, rCav, lowDetail || absYNorm > 1.18);
  let turb = clamp(u.diskParams.z, 0.0, 2.2);

  let warpY = (n.r - 0.5) * 0.28 * turb;
  let yShifted = abs(yNorm + warpY);
  let ySq = yShifted * yShifted;
  let vertCore = exp(-ySq * 2.75);
  let vertMid  = exp(-ySq * 5.40);
  let slabWindow = smoothstep(2.65, 1.90, absYNorm);
  let vertSheath = 0.22 * exp(-absYNorm * 1.65) * slabWindow;

  let ngc = clamp(n.g, 0.0, 1.0);
  let ridgeSharp = ngc * sqrt(ngc);
  let nac = clamp(n.a, 0.0, 1.0);
  let microSharp = nac * mix(1.0, sqrt(nac), 0.70);
  let ht = clamp(ridgeSharp * 0.62 + microSharp * 0.52, 0.0, 1.0);
  let hotThread = ht * ht * sqrt(ht);

  let inCbd = smoothstep(rCav * 0.75, rCav * 1.15, rCom);
  var laneBlend = 0.68 + 0.42 * ridgeSharp;
  var lbPow = 0.0;
  if (inCbd > 0.001) {
    let rWarp = logR + (n.r - 0.5) * 0.22 * turb + (n.b - 0.5) * 0.11 * turb;
    let laneBroad = max(0.5 + 0.5 * sin(rWarp * 17.5 + 0.68 * sin(phiRot + logR * 3.2 + n.r * 2.4)), 0.0);
    let laneFine  = max(0.5 + 0.5 * sin(rWarp * 42.0 - 0.58 * cos(2.0 * phiRot - logR * 4.8 + n.b * 2.8)), 0.0);
    lbPow = laneBroad * sqrt(laneBroad);
    let concentricLanes = mix(0.62 + 0.38 * laneBroad, 0.34 + 0.36 * lbPow + 0.38 * (laneFine * laneFine), 0.72);
    let mriFilaments = mix(0.72, 0.22 + 1.12 * ridgeSharp + 0.58 * microSharp + 0.80 * hotThread, clamp(turb, 0.0, 1.65));
    let eddyBoost = mix(1.0, 0.68 + 0.76 * n.b, clamp(turb * 0.80, 0.0, 1.2));
    laneBlend = mix(laneBlend, concentricLanes * mriFilaments * eddyBoost, inCbd);
  }

  let riftMask = smoothstep(0.22, 0.74, n.r * 0.50 + n.g * 0.35 + n.b * 0.15);
  let structureContrast = mix(1.0, mix(0.28, 1.46, riftMask), clamp(turb * 0.80, 0.0, 1.0));

  let localDensity = sigma * (vertCore * laneBlend * structureContrast * slabWindow + vertSheath * (0.40 + 0.60 * ridgeSharp)) * camDistFade;
  if (localDensity < 1e-5) {
    return outDisk;
  }

  let vRot = tidal.ba;
  var vEmit = vec3f(
    vRot.x * cosOrb + vRot.y * sinOrb,
    0.0,
    -vRot.x * sinOrb + vRot.y * cosOrb
  );
  var v2 = dot(vEmit, vEmit);
  if (v2 > 0.52) {
    vEmit *= sqrt(0.52 / v2);
    v2 = 0.52;
  }
  let gammaEmit = inverseSqrt(max(1.0 - v2, 0.25));
  let alphaEmit = clamp((1.0 - phiPot) / max(1.0 + phiPot, 1.0), 0.06, 1.0);
  let gShift = clamp(alphaEmit / max(gammaEmit * (1.0 + dot(vEmit, dir)), 0.12), 0.08, 3.4);

  let rel = clamp(u.camPos_relMode.w, 0.0, 1.0);
  let gColor  = mix(mix(1.0, gShift, 0.28), gShift, rel);
  let gBeam   = mix(mix(1.0, gShift, 0.36), gShift, rel);
  let beamExp = mix(1.75, 3.20, rel);
  var beaming = pow(clamp(gBeam, 0.12, 2.75), beamExp);
  beaming = beaming / (1.0 + beaming * mix(0.055, 0.16, rel));

  let tempBoost = max(tidal.g, 0.8);
  var tempRadial = 1.0;
  if (inCbd > 0.001) {
    let rPeak = max(rCav * 1.15, 2.8);
    let rRatio = max(rCom / rPeak, 0.58);
    tempRadial = mix(1.0, pow(rRatio, -mix(0.38, 0.50, rel)), inCbd);
  }
  let filamentHeat = clamp(ridgeSharp * 0.45 + microSharp * 0.25 + hotThread * 0.42, 0.0, 1.0);
  let ringdown = u.skyY_ringdown.z;
  let T_local = u.camUp_diskTemp.w * tempBoost * tempRadial * mix(0.76, 1.32, filamentHeat) * (1.0 + 0.18 * ringdown);

  let T_obs = clamp(T_local * gColor, T_MIN, T_MAX);
  let bbColor = sampleBlackbody(T_obs);

  let tr = clamp(T_local / 4900.0, 0.15, 4.0);
  let thermalPower = (tr * tr) * inverseSqrt(sqrt(sqrt(tr)));
  let heightComp = 1.0 / pow(max(H * 2.8, 0.28), 0.36);

  let emitStrength = localDensity * thermalPower * beaming * heightComp * 1.18;
  outDisk.emission = bbColor * emitStrength;

  let dustZone = smoothstep(rCav * 0.92, rCav * 1.45, rCom);
  var coolDustExt = 0.0;
  if (dustZone > 0.001 && vertMid > 1e-4) {
    let dvRaw = smoothstep(0.30, 0.86, 1.0 - ridgeSharp * 0.72 + (n.r - 0.5) * 0.72);
    let dustVeins = dvRaw * mix(1.0, sqrt(dvRaw), 0.65);
    let dustLane = 0.32 + 0.68 * (1.0 - lbPow);
    coolDustExt = sigma * vertMid * dustZone * (0.38 + 1.75 * dustVeins * dustLane);
  }
  let plasmaSelfExt = sigma * vertCore * (0.14 + 0.22 * n.r);

  outDisk.extinction = (coolDustExt * 1.35 + plasmaSelfExt * 0.36) * heightComp * camDistFade * slabWindow;
  return outDisk;
}

// ============================================================================
// 4. SEAMLESS 4K MILKY WAY LENSING + CRISP 3D MICRO-STARS + GW ISW MODULATION
// ============================================================================

fn rotateSkyDir(d: vec3f) -> vec3f {
  let cy = u.rotTrig_skyTrig.z;
  let sy = u.rotTrig_skyTrig.w;
  let r1 = vec3f(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  let cp = u.skyY_ringdown.x;
  let sp = u.skyY_ringdown.y;
  return vec3f(r1.x, cp * r1.y - sp * r1.z, sp * r1.y + cp * r1.z);
}

fn hash33f(pIn: vec3f) -> vec3f {
  var p = fract(pIn * vec3f(0.1031, 0.1030, 0.0973));
  p += vec3f(dot(p, p.yxz + vec3f(33.33)));
  return fract((p.xxy + p.yxx) * p.zyx);
}

fn evalMicroStarLayer(dir: vec3f, scale: f32, densityThresh: f32, boost: f32, pixelFw: f32) -> vec3f {
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
  let mag  = mag2 * mag2 * sqrt(magU);

  let fw = clamp(pixelFw * scale, 0.018, 0.14);
  let starRad = mix(0.032, 0.095, mag) + fw * 0.42;
  let core = exp(-(dist * dist) / max(starRad * starRad * 0.34, 1e-5));
  if (core < 0.004) {
    return vec3f(0.0);
  }

  let energyComp = 1.0 / (1.0 + fw * 6.0);
  let ry = max(rnd.y, 0.0);
  let specT = mix(3000.0, 22000.0, ry * ry);
  let col = sampleBlackbody(specT);

  let lum = (0.08 + 3.2 * mag) * boost * energyComp;
  return col * (core * lum);
}

fn sampleSkyBackground(rawDir: vec3f, escaped: bool, edgeMask: f32, deltaISW: f32) -> vec3f {
  let dir = normalize(rotateSkyDir(rawDir));

  let u1 = atan2(dir.z, dir.x) * INV_TAU + 0.5;
  let v  = acos(clamp(dir.y, -1.0, 1.0)) * INV_PI;
  let uv1 = vec2f(u1, v);
  let uv2 = vec2f(fract(u1 + 0.5), v);

  let dx1 = dpdx(uv1);
  let dy1 = dpdy(uv1);
  let dx2 = dpdx(uv2);
  let dy2 = dpdy(uv2);

  var dUVdx = vec2f(select(dx2.x, dx1.x, abs(dx1.x) < abs(dx2.x)), dx1.y);
  var dUVdy = vec2f(select(dy2.x, dy1.x, abs(dy1.x) < abs(dy2.x)), dy1.y);

  if (edgeMask > 0.01) {
    dUVdx = vec2f(1.0 / 4096.0, 0.0);
    dUVdy = vec2f(0.0, 1.0 / 2048.0);
  } else {
    dUVdx = clamp(dUVdx, vec2f(-0.045), vec2f(0.045));
    dUVdy = clamp(dUVdy, vec2f(-0.045), vec2f(0.045));
  }

  var dirFw = length(fwidth(dir));
  if (edgeMask > 0.01) {
    dirFw = 0.0012;
  }

  if (!escaped) {
    return vec3f(0.0);
  }

  let sampleUv = vec2f(uv1.x, clamp(uv1.y, 0.005, 0.995));
  let skyMode = u.modes_pad.y;
  var mapSrgb: vec3f;
  if (skyMode == 2) {
    mapSrgb = textureSampleGrad(uProcSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  } else {
    mapSrgb = textureSampleGrad(uSkyMap, sSky, sampleUv, dUVdx, dUVdy).rgb;
  }
  var skyLin = pow(max(mapSrgb, vec3f(0.0)), vec3f(2.2));

  let brightCores = max(skyLin - vec3f(0.32), vec3f(0.0));
  skyLin += brightCores * brightCores * 2.4;

  if (skyMode == 0 || skyMode == 2) {
    let starGain = select(0.95, 0.55, skyMode == 0);
    let microStars = evalMicroStarLayer(dir, 105.0, 0.915, 0.95 * starGain, dirFw)
                   + evalMicroStarLayer(dir, 225.0, 0.885, 0.42 * starGain, dirFw);
    skyLin += microStars;
  }

  let iswFactor = 1.0 + clamp(deltaISW, -0.25, 0.25);
  return skyLin * max(u.gw_skyParams.y, 0.0) * (iswFactor * iswFactor);
}

// ============================================================================
// 5. MAIN ADAPTIVE RK4/RK3 BINARY GEODESIC RAY-MARCHER
// ============================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution_time_frame.xy, vec2f(1.0));
  let pixelCoord = in.pos.xy + vec2f(u.jitter_fov_phase.x, -u.jitter_fov_phase.y);
  let ndc = vec2f(
    (pixelCoord.x / res.x) * 2.0 - 1.0,
    1.0 - (pixelCoord.y / res.y) * 2.0
  );

  let aspect = res.x / res.y;
  let tanHalfFov = u.field_rayConsts.z;
  let localRay = normalize(vec3f(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));

  let camBasis = mat3x3f(
    u.camRight_lensing.xyz,
    u.camUp_diskTemp.xyz,
    u.camForward_diskDens.xyz
  );
  var pos = u.camPos_relMode.xyz;
  var dir = normalize(camBasis * localRay);

  let bnCoord = vec2i(in.pos.xy) & vec2i(127);
  let bnRaw = textureLoad(uBlueNoise, bnCoord, 0);
  let fIdx = f32(u.modes_pad.x & 1023);
  let bn = fract(bnRaw + fIdx * vec4f(0.75487766, 0.56984029, 0.43015971, 0.61803399));

  let quality = u.modes_pad.z;
  var maxSteps : i32 = 260;
  var qualScale : f32 = 0.94;
  if (quality <= 0) {
    maxSteps = 175;
    qualScale = 1.24;
  } else if (quality >= 2) {
    maxSteps = 400;
    qualScale = 0.64;
  }

  let m1 = u.binaryMass_sep.x;
  let m2 = u.binaryMass_sep.y;
  let d = u.binaryMass_sep.z;
  let eta = u.binaryMass_sep.w;
  let rH1 = u.binaryV1_rH1.w;
  let rH2 = u.binaryV2_rH2.w;
  let rCav = u.field_rayConsts.w;
  let rOuter = max(u.diskParams.y, rCav + 4.0);
  let invFieldSpan = 1.0 / (2.0 * max(u.field_rayConsts.x, 1.0));
  let escapeR = u.field_rayConsts.y;
  let maxDiskSlabY = u.skyY_ringdown.w;

  let hasDisk = (u.camForward_diskDens.w > 0.001 || u.diskParams.w > 0.001);
  let hasGw   = (abs(u.gw_skyParams.x) > 0.01 && eta > 1e-6);
  var gwBaseStep : f32 = 100.0;
  if (hasGw) {
    gwBaseStep = PI / (5.2 * max(u.binaryC2_gwOmega.w, 0.05));
  }
  let lowDetailBase = (quality <= 0);

  let r0Gw = 0.8 * d;
  let r1Gw = 2.2 * d;
  var gwc: GwConsts;
  gwc.r0 = r0Gw;
  gwc.r0Sq = r0Gw * r0Gw;
  gwc.invSpan = 1.0 / max(r1Gw - r0Gw, 1e-5);
  gwc.A0 = u.gw_skyParams.x * (4.0 * eta) * 0.035;
  gwc.twoPhase = 2.0 * u.jitter_fov_phase.w;
  gwc.twoGwOmega = 2.0 * u.binaryC2_gwOmega.w;
  gwc.hasGw = hasGw;

  let cosOrb = u.rotTrig_skyTrig.x;
  let sinOrb = u.rotTrig_skyTrig.y;

  var radiance = vec3f(0.0);
  var transmittance : f32 = 1.0;
  var rayDist : f32 = 0.0;
  var deltaISW : f32 = 0.0;
  var captured = false;
  var escaped = false;
  var hasPrevRot = false;
  var prevRotXZ = vec2f(0.0);
  var hasPrevSig = false;
  var prevSig : f32 = 0.0;

  for (var step: i32 = 0; step < 400; step++) {
    if (step >= maxSteps) { break; }

    let k1 = evalGeodesicFull(pos, dir);
    if (k1.phi >= 0.92) {
      captured = true;
      break;
    }

    let rCom = length(pos);
    let outbound = dot(pos, dir) > 0.0;
    if (rCom > escapeR && outbound) {
      escaped = true;
      break;
    }

    var hasCurRot = hasPrevRot;
    var curRotXZ = prevRotXZ;
    var hasCurSig = hasPrevSig;
    var curSig = prevSig;
    hasPrevRot = false;
    hasPrevSig = false;

    let clear1 = select(1e6, k1.r1 - 0.82 * rH1, m1 > 0.0);
    let clear2 = select(1e6, k1.r2 - 0.82 * rH2, m2 > 0.0);
    let minClear = min(clear1, clear2);
    let minMassR = min(select(1e6, k1.r1, m1 > 0.0), select(1e6, k1.r2, m2 > 0.0));
    let minH = max(0.0012, 0.055 * minMassR) * qualScale;
    let farOut = outbound && rCom > max(rOuter * 1.15, d * 2.5) && k1.phi < 0.02;
    var h = clamp(select(0.15, 0.36, farOut) * max(minClear, 0.005) * qualScale, minH, select(5.2, 13.0, farOut));

    if (hasGw && rCom > gwc.r0) {
      let gwLim = gwBaseStep * (1.0 + 0.022 * max(rCom - 2.4 * d, 0.0));
      h = min(h, gwLim);
    }

    if (hasDisk && rCom < rOuter * 1.15 && abs(pos.y) < maxDiskSlabY * 1.15) {
      let localH = diskScaleHeight(
        rCom,
        length(pos.xz - u.binaryC1_omega.xz),
        length(pos.xz - u.binaryC2_gwOmega.xz),
        rCav,
        rOuter
      );
      let absY = abs(pos.y);
      if (absY < localH * 2.90) {
        var skipCavRefine = false;
        if (rCom < rCav * 0.80) {
          if (!hasCurRot) {
            curRotXZ = rotOrbXZ(pos.xz, cosOrb, sinOrb);
            hasCurRot = true;
          }
          if (!hasCurSig) {
            let uv0 = curRotXZ * invFieldSpan + 0.5;
            curSig = textureSampleLevel(uTidalField, sLut, clamp(uv0, vec2f(0.002), vec2f(0.998)), 0.0).r;
            hasCurSig = true;
          }
          if (curSig < 1e-4) {
            let uv1 = rotOrbXZ(pos.xz + dir.xz * min(h, 1.2), cosOrb, sinOrb) * invFieldSpan + 0.5;
            let sig1 = textureSampleLevel(uTidalField, sLut, clamp(uv1, vec2f(0.002), vec2f(0.998)), 0.0).r;
            if (sig1 < 1e-4) {
              h = min(h, 0.85 * qualScale);
              skipCavRefine = true;
            }
          }
        }
        if (!skipCavRefine) {
          var anisoScale : f32 = 1.0;
          if (rCom > rCav * 0.85) {
            anisoScale = min(1.0 / max(abs(dir.y), 0.36), 2.15);
          }
          let diskHStep = max(localH * 1.05 * anisoScale, 0.048) * qualScale;
          let prox = smoothstep(localH * 2.90, localH * 1.05, absY);
          h = min(h, mix(h, diskHStep, prox));
        }
      }
    }

    if (step == 0) {
      h *= (0.25 + 0.75 * bn.x);
    }

    var posNext: vec3f;
    var dirNext: vec3f;

    let strongField = (k1.phi > 0.036) || (k1.r1 < 6.0 * max(m1, 0.01)) || (k1.r2 < 6.0 * max(m2, 0.01));
    let veryWeak = (k1.phi < 0.016) && !strongField;
    if (strongField) {
      let p2 = pos + (0.5 * h) * dir;
      let v2 = normalize(dir + (0.5 * h) * k1.dv);
      let a2 = evalGeodesicAccel(p2, v2);

      let p3 = pos + (0.5 * h) * v2;
      let v3 = normalize(dir + (0.5 * h) * a2);
      let a3 = evalGeodesicAccel(p3, v3);

      let p4 = pos + h * v3;
      let v4 = normalize(dir + h * a3);
      let a4 = evalGeodesicAccel(p4, v4);

      posNext = pos + (h / 6.0) * (dir + 2.0 * v2 + 2.0 * v3 + v4);
      dirNext = normalize(dir + (h / 6.0) * (k1.dv + 2.0 * a2 + 2.0 * a3 + a4));
    } else if (veryWeak) {
      let p2 = pos + (0.5 * h) * dir;
      let v2 = normalize(dir + (0.5 * h) * k1.dv);
      let a2 = evalGeodesicAccel(p2, v2);

      posNext = pos + h * v2;
      dirNext = normalize(dir + h * a2);
    } else {
      let p2 = pos + (0.5 * h) * dir;
      let v2 = normalize(dir + (0.5 * h) * k1.dv);
      let a2 = evalGeodesicAccel(p2, v2);

      let p3 = pos + (0.75 * h) * v2;
      let v3 = normalize(dir + (0.75 * h) * a2);
      let a3 = evalGeodesicAccel(p3, v3);

      posNext = pos + (h / 9.0) * (2.0 * dir + 3.0 * v2 + 4.0 * v3);
      dirNext = normalize(dir + (h / 9.0) * (2.0 * k1.dv + 3.0 * a2 + 4.0 * a3));
    }

    var iswMid : f32 = 0.0;
    if (hasGw) {
      let midPosGw = 0.5 * (pos + posNext);
      if (dot(midPosGw, midPosGw) > gwc.r0Sq) {
        let midDirGw = normalize(dir + dirNext);
        let gwKick = evalGwKick(midPosGw, midDirGw, gwc);
        posNext += (0.5 * h * h) * gwKick.xyz;
        dirNext = normalize(dirNext + h * gwKick.xyz);
        iswMid = gwKick.w;
      }
    }

    let segLen = length(posNext - pos);
    let midDist = rayDist + 0.5 * segLen;
    let camDistFade = smoothstep(0.0, 0.85, midDist);
    deltaISW += iswMid * segLen;

    if (hasDisk) {
      let yMin = min(pos.y, posNext.y);
      let yMax = max(pos.y, posNext.y);
      let crossesPlane = (yMin <= 0.0 && yMax >= 0.0);
      let inSlab = (yMin <= maxDiskSlabY && yMax >= -maxDiskSlabY);

      if (inSlab || crossesPlane) {
        let midPos = 0.5 * (pos + posNext);
        let rMidCom = length(midPos.xz);
        if (rMidCom < rOuter * 1.12) {
          let hMid = diskScaleHeight(
            rMidCom,
            length(midPos.xz - u.binaryC1_omega.xz),
            length(midPos.xz - u.binaryC2_gwOmega.xz),
            rCav,
            rOuter
          );

          if (crossesPlane || abs(midPos.y) < hMid * 2.65 || abs(pos.y) < hMid * 2.65 || abs(posNext.y) < hMid * 2.65) {
            var anisoSub : f32 = 1.0;
            if (rMidCom > rCav * 0.85) {
              let midDirY = abs(dir.y + dirNext.y) * 0.5;
              anisoSub = min(1.0 / max(midDirY, 0.36), 2.15);
            }
            let targetDs = max(hMid * 1.15 * anisoSub, 0.055) * qualScale;
            let needCrossSub = crossesPlane && (segLen > targetDs * 0.72);
            var nSub : i32 = 1;
            if (needCrossSub || segLen > targetDs) {
              nSub = clamp(i32(ceil(segLen / targetDs)), select(1, 2, needCrossSub), select(2, 3, quality >= 2));
            }
            var p0Rot : vec2f;
            if (hasCurRot) {
              p0Rot = curRotXZ;
            } else {
              p0Rot = rotOrbXZ(pos.xz, cosOrb, sinOrb);
            }
            let p1Rot = rotOrbXZ(posNext.xz, cosOrb, sinOrb);
            prevRotXZ = p1Rot;
            hasPrevRot = true;

            var skipSub = false;
            if (nSub > 1 && rMidCom < rCav * 0.82) {
              var s0 : f32;
              if (hasCurSig) {
                s0 = curSig;
              } else {
                let p0Uv = clamp(p0Rot * invFieldSpan + 0.5, vec2f(0.002), vec2f(0.998));
                s0 = textureSampleLevel(uTidalField, sLut, p0Uv, 0.0).r;
              }
              if (s0 < 1e-4) {
                let p1Uv = clamp(p1Rot * invFieldSpan + 0.5, vec2f(0.002), vec2f(0.998));
                let s2 = textureSampleLevel(uTidalField, sLut, p1Uv, 0.0).r;
                prevSig = s2;
                hasPrevSig = true;
                if (s2 < 1e-4) {
                  let pmUv = clamp((0.5 * (p0Rot + p1Rot)) * invFieldSpan + 0.5, vec2f(0.002), vec2f(0.998));
                  let s1 = textureSampleLevel(uTidalField, sLut, pmUv, 0.0).r;
                  skipSub = (s1 < 1e-4);
                }
              }
            }

            if (!skipSub) {
              let dsSub = segLen / f32(nSub);
              let jitterBase = fract(bn.y + f32(step) * 0.61803399);
              let lowDet = lowDetailBase || (transmittance < 0.14);

              for (var s: i32 = 0; s < 3; s++) {
                if (s >= nSub) { break; }
                let frac = (f32(s) + jitterBase) / f32(nSub);
                let sPos = mix(pos, posNext, frac);
                let sRotXZ = mix(p0Rot, p1Rot, frac);
                let sDir = normalize(mix(dir, dirNext, frac));
                var sr1 : f32;
                var sr2 : f32;
                if (nSub == 1) {
                  sr1 = length(midPos - u.binaryC1_omega.xyz);
                  sr2 = length(midPos - u.binaryC2_gwOmega.xyz);
                } else {
                  sr1 = length(sPos - u.binaryC1_omega.xyz);
                  sr2 = length(sPos - u.binaryC2_gwOmega.xyz);
                }
                var sPhi : f32 = 0.0;
                if (m1 > 0.0) { sPhi += 0.5 * m1 / max(sr1, 1e-4); }
                if (m2 > 0.0) { sPhi += 0.5 * m2 / max(sr2, 1e-4); }

                let ds = evalDiskVolume(sPos.y, sRotXZ, sDir, sPhi, cosOrb, sinOrb, camDistFade, lowDet);
                if (ds.extinction > 1e-6 || dot(ds.emission, ds.emission) > 1e-10) {
                  let tau = ds.extinction * dsSub;
                  let stepT = exp(-tau);
                  var stepRad: vec3f;
                  if (tau > 1e-4) {
                    stepRad = ds.emission * ((1.0 - stepT) / max(ds.extinction, 1e-5));
                  } else {
                    stepRad = ds.emission * dsSub;
                  }
                  radiance += transmittance * stepRad;
                  transmittance *= stepT;
                  if (transmittance < 0.008) { break; }
                }
              }
            }
          }
        }
      }
    }

    pos = posNext;
    dir = dirNext;
    rayDist += segLen;

    if (transmittance < 0.008) {
      break;
    }
  }

  if (!captured && !escaped) {
    let r1E = length(pos - u.binaryC1_omega.xyz);
    let r2E = length(pos - u.binaryC2_gwOmega.xyz);
    let phiEnd = select(0.0, 0.5 * m1 / max(r1E, 1e-4), m1 > 0.0)
               + select(0.0, 0.5 * m2 / max(r2E, 1e-4), m2 > 0.0);
    let nearestD = select(pos - u.binaryC2_gwOmega.xyz, pos - u.binaryC1_omega.xyz, r1E / max(m1, 1e-4) <= r2E / max(m2, 1e-4));
    if (phiEnd > 0.45 || (phiEnd > 0.28 && dot(nearestD, dir) < 0.0)) {
      captured = true;
    } else {
      escaped = true;
    }
  }

  let escFlag = select(0.0, 1.0, escaped && !captured && transmittance > 0.008);
  let edgeMask = fwidth(escFlag);
  var safeSkyDir = localRay;
  if (dot(dir, dir) > 1e-10) {
    safeSkyDir = normalize(dir);
  }
  let skyColor = sampleSkyBackground(safeSkyDir, escFlag > 0.5, edgeMask, deltaISW);

  if (escFlag > 0.5) {
    radiance += transmittance * skyColor;
  }

  radiance = clamp(sanitizeVec3Zero(radiance), vec3f(0.0), vec3f(28.0));
  return vec4f(radiance, 1.0);
}
