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

@group(0) @binding(0) var<uniform> u: vec4u;

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

fn hash3(p: vec3i) -> f32 {
  var h = u32(p.x) * 374761393u + u32(p.y) * 668265263u + u32(p.z) * 2147483647u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) * 2.3283064365386963e-10;
}

fn valueNoise3D(p: vec3f) -> f32 {
  let ip = vec3i(floor(p));
  let t = p - vec3f(ip);
  let f = t * t * (3.0 - 2.0 * t);

  let c000 = hash3(ip + vec3i(0, 0, 0));
  let c100 = hash3(ip + vec3i(1, 0, 0));
  let c010 = hash3(ip + vec3i(0, 1, 0));
  let c110 = hash3(ip + vec3i(1, 1, 0));
  let c001 = hash3(ip + vec3i(0, 0, 1));
  let c101 = hash3(ip + vec3i(1, 0, 1));
  let c011 = hash3(ip + vec3i(0, 1, 1));
  let c111 = hash3(ip + vec3i(1, 1, 1));

  let x00 = mix(c000, c100, f.x);
  let x10 = mix(c010, c110, f.x);
  let x01 = mix(c001, c101, f.x);
  let x11 = mix(c011, c111, f.x);

  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

fn fbm3D_3(p0: vec3f) -> f32 {
  var p = p0;
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  for (var i: i32 = 0; i < 3; i++) {
    sum += amp * valueNoise3D(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.07;
  }
  return sum / norm;
}

fn fbm3D_4(p0: vec3f) -> f32 {
  var p = p0;
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  for (var i: i32 = 0; i < 4; i++) {
    sum += amp * valueNoise3D(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.07;
  }
  return sum / norm;
}

fn starHash4(cell: vec3i, salt: i32) -> vec4f {
  let c = vec3u(cell + vec3i(salt * 131, salt * 277, salt * 521));
  var v = c * vec3u(1664525u, 22695477u, 2891336453u) + vec3u(1013904223u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v = v ^ (v >> vec3u(16u));
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  let w = (v.x ^ v.y ^ v.z);
  return vec4f(
    f32(v.x) * 2.3283064365e-10,
    f32(v.y) * 2.3283064365e-10,
    f32(v.z) * 2.3283064365e-10,
    f32(w) * 2.3283064365e-10
  );
}

fn spectralRgb(uTemp: f32, warmBias: bool) -> vec3f {
  var tempK: f32;
  if (warmBias) {
    if (uTemp < 0.08) { tempK = 22000.0; }
    else if (uTemp < 0.25) { tempK = 9500.0; }
    else if (uTemp < 0.62) { tempK = 5600.0; }
    else { tempK = 3500.0; }
  } else {
    if (uTemp < 0.06) { tempK = 24000.0; }
    else if (uTemp < 0.22) { tempK = 10000.0; }
    else if (uTemp < 0.48) { tempK = 6500.0; }
    else if (uTemp < 0.78) { tempK = 4500.0; }
    else { tempK = 3100.0; }
  }
  let t = tempK * 0.01;
  var r: f32;
  var g: f32;
  var b: f32;
  if (t <= 66.0) {
    r = 1.0;
    g = 0.39008158 * log(max(1.0, t)) - 0.63184144;
    b = select(0.54320679 * log(max(1.0, t - 10.0)) - 1.19625409, 0.0, t <= 19.0);
  } else {
    r = 1.29293619 * pow(t - 60.0, -0.13320476);
    g = 1.12989086 * pow(t - 60.0, -0.07551485);
    b = 1.0;
  }
  let s = clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
  let lin = pow(s, vec3f(2.2));
  return lin / max(max(lin.r, lin.g), max(lin.b, 1e-6));
}

fn evalStarGrid(dir: vec3f, freq: f32, density: f32, gain: f32, salt: i32, warmBias: bool) -> vec3f {
  let p = dir * freq;
  let cell = vec3i(floor(p));
  let h = starHash4(cell, salt);
  if (h.w > density) {
    return vec3f(0.0);
  }
  let starWorld = normalize((vec3f(cell) + vec3f(0.24) + h.xyz * 0.52) / freq);
  let chord = length(dir - starWorld);
  let radiusRad = select(0.0022, 0.0038, h.w < density * 0.14);
  let d = chord / radiusRad;
  let w = exp(-d * d * 2.1);
  if (w < 0.008) {
    return vec3f(0.0);
  }
  let uBright = max(h.w / max(density, 1e-5), 0.002);
  let bright = min(7.5, gain * pow(uBright, -0.76));
  let tint = spectralRgb(fract(h.x * 13.7 + h.y * 7.3), warmBias);
  return tint * (bright * w);
}

fn bakeUniverseA(dir: vec3f) -> vec3f {
  let tilt = 60.0 * PI / 180.0;
  let cosTilt = cos(tilt);
  let sinTilt = sin(tilt);
  let yaw = 0.55;
  let cosYaw = cos(yaw);
  let sinYaw = sin(yaw);

  let rx = dir.x * cosYaw - dir.z * sinYaw;
  let rz = dir.x * sinYaw + dir.z * cosYaw;
  let gx = rx;
  let gy = dir.y * cosTilt - rz * sinTilt;
  let gz = dir.y * sinTilt + rz * cosTilt;

  let bandDist2 = gy * gy;
  let bandProfile = exp(-bandDist2 * 26.0);
  let wideGlow = exp(-bandDist2 * 5.2);

  let bulgeDot = max(0.0, gx);
  let bulge = bulgeDot * bulgeDot * bulgeDot * exp(-bandDist2 * 14.0);

  let cloudNoise = fbm3D_4(vec3f(gx * 3.4 + 4.1, gy * 5.5 - 1.7, gz * 3.4 + 2.3));
  let fineCloud = fbm3D_3(vec3f(gx * 9.5 - 2.2, gy * 12.0 + 3.8, gz * 9.5 + 1.1));
  let dustFbm = fbm3D_4(vec3f(gx * 7.2 + 11.4, gy * 16.0 - 5.2, gz * 7.2 - 3.6));

  let riftCoord = (gy - (cloudNoise - 0.5) * 0.08) * 18.0;
  let riftBand = exp(-riftCoord * riftCoord);
  let dustExtinction = max(
    0.18,
    1.0 - riftBand * (0.45 + 0.5 * smoothstep(0.0, 1.0, (dustFbm - 0.35) * 2.2))
  );

  let baseIntensity = (
    bandProfile * (0.045 + 0.095 * cloudNoise * fineCloud) +
    wideGlow * 0.012 * cloudNoise +
    bulge * (0.09 + 0.08 * fineCloud)
  ) * dustExtinction;

  let coreWarmth = min(1.0, bulge * 1.4 + 0.15);
  let nebCool = max(0.0, fineCloud - 0.55) * bandProfile * 0.045;
  let nebWarm = max(0.0, cloudNoise - 0.58) * bulge * 0.05;

  var col = vec3f(0.0008, 0.0010, 0.0016)
    + baseIntensity * mix(vec3f(0.72, 0.84, 1.12), vec3f(1.18, 0.96, 0.72), coreWarmth)
    + nebWarm * vec3f(1.1, 0.55, 0.25)
    + nebCool * vec3f(0.35, 0.65, 1.25);

  let gDir = vec3f(gx, gy, gz);
  let bandWeight = exp(-gy * gy * 18.0);
  col += evalStarGrid(gDir, 56.0, 0.22 * bandWeight + 0.07, 0.055, 11, false);
  col += evalStarGrid(gDir, 102.0, 0.18 * bandWeight + 0.06, 0.036, 37, false);
  col += evalStarGrid(gDir, 168.0, 0.14 * bandWeight + 0.05, 0.025, 73, false);

  let shoulder = 0.35;
  return col / (vec3f(1.0) + col * shoulder);
}

fn bakeUniverseB(dir: vec3f) -> vec3f {
  let f = normalize(vec3f(-0.886, -0.171, -0.430));
  let upRef = vec3f(0.36, 0.88, -0.31);
  let rAxis = normalize(cross(upRef, f));
  let uAxis = cross(f, rAxis);

  let nx = dot(dir, rAxis);
  let ny = dot(dir, uAxis);
  let nz = dot(dir, f);

  let warpA = fbm3D_3(vec3f(nx * 2.8 + 1.3, ny * 2.8 - 0.8, nz * 2.8 + 3.1)) - 0.5;
  let wx = nx + warpA * 0.48;
  let wy = ny - warpA * 0.34;
  let wz = nz + warpA * 0.28;

  let cloudBase = fbm3D_4(vec3f(wx * 3.4 + 7.2, wy * 4.2 - 2.4, wz * 3.4 + 5.6));
  let fineFbm = fbm3D_3(vec3f(wx * 9.8 - 3.3, wy * 11.4 + 4.9, wz * 9.8 + 2.1));

  let rawRidge = 1.0 - abs(fineFbm * 2.0 - 1.0);
  let ridge = rawRidge * rawRidge * rawRidge;

  let bandDist = ny + warpA * 0.24;
  let bandEnv = exp(-bandDist * bandDist * 16.0);
  let wideTealHalo = exp(-bandDist * bandDist * 4.2);

  let heartDot = max(0.0, nz * 0.84 + 0.16);
  let heartFocus = heartDot * heartDot * heartDot * (0.28 + 0.72 * bandEnv);

  let pillarField = cloudBase * 0.52 + fineFbm * 0.48;
  let pillarCore = smoothstep(0.0, 1.0, (pillarField - 0.54) * 5.0) * (0.25 + 0.75 * bandEnv);
  let dustTransmit = 1.0 - pillarCore * 0.90;
  let pillarRim = smoothstep(0.0, 1.0, (pillarField - 0.48) * 11.0)
    * (1.0 - smoothstep(0.0, 1.0, (pillarField - 0.57) * 9.0))
    * bandEnv;

  let ionBalance = smoothstep(0.0, 1.0, (cloudBase - 0.44) * 4.2);

  let goldCore = heartFocus * (0.14 + 0.78 * ionBalance)
    + bandEnv * ridge * (0.18 + 0.44 * ionBalance);
  let goldWeight = goldCore * dustTransmit + pillarRim * 0.56;

  let tealPockets = (1.0 - ionBalance * 0.75) * smoothstep(0.0, 1.0, (fineFbm - 0.30) * 2.8);
  let tealWeight = (
    wideTealHalo * 0.055 * (0.4 + 0.6 * tealPockets) +
    bandEnv * (0.16 * tealPockets + 0.34 * ridge * (1.0 - ionBalance * 0.6))
  ) * (0.22 + 0.78 * dustTransmit);

  var col = vec3f(0.0007, 0.0016, 0.0032)
    + goldWeight * vec3f(1.15, 0.46, 0.05)
    + tealWeight * vec3f(0.025, 0.52, 0.68);

  let coreSpark = max(0.0, cloudBase - 0.58) * heartFocus * dustTransmit;
  col += coreSpark * vec3f(0.95, 0.58, 0.18);

  let bDir = vec3f(nx, ny, nz);
  let bandWeight = exp(-ny * ny * 12.5);
  let clusterWeight = smoothstep(0.76, 0.96, nz);
  col += evalStarGrid(bDir, 54.0, 0.25 * bandWeight + 0.36 * clusterWeight + 0.07, 0.075, 19, true);
  col += evalStarGrid(bDir, 98.0, 0.22 * bandWeight + 0.30 * clusterWeight + 0.06, 0.048, 53, true);
  col += evalStarGrid(bDir, 162.0, 0.16 * bandWeight + 0.20 * clusterWeight + 0.05, 0.030, 89, true);

  let shoulder = 0.42;
  return col / (vec3f(1.0) + col * shoulder);
}

fn linearToSrgb(lin: vec3f) -> vec3f {
  let c = clamp(lin, vec3f(0.0), vec3f(1.0));
  var s: vec3f;
  s.x = select(1.055 * pow(c.x, 1.0 / 2.4) - 0.055, 12.92 * c.x, c.x <= 0.0031308);
  s.y = select(1.055 * pow(c.y, 1.0 / 2.4) - 0.055, 12.92 * c.y, c.y <= 0.0031308);
  s.z = select(1.055 * pow(c.z, 1.0 / 2.4) - 0.055, 12.92 * c.z, c.z <= 0.0031308);
  return clamp(s, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let phi = in.uv.x * TAU;
  let theta = in.uv.y * PI;
  let sinTheta = sin(theta);
  let cosTheta = cos(theta);
  let dir = vec3f(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));

  let hdrLin = select(bakeUniverseA(dir), bakeUniverseB(dir), u.x == 1u);
  return vec4f(linearToSrgb(hdrLin), 1.0);
}
