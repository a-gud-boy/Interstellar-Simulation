/**
 * Unified sky texture loader & procedural deep-space synthesizer for WebGL2 and
 * WebGPU across all Interstellar simulators, with module-level CPU pixel & blob
 * caching so live backend switching reuses assets from RAM with zero redundant
 * synthesis or fetches.
 *
 * - Universe A: Canonical 4K Milky Way (shared/assets/milkyway_4k.jpg) + procedural indigo-silver fallback
 * - Universe B: Exotic Golden-Amber & Teal Emission Nebula + cosmic dust pillars (Wormhole Sim)
 */

export const DEFAULT_SKY_URL = new URL('./milkyway_4k.jpg', import.meta.url).href;

const ANISOTROPY_EXT_NAMES = [
  'EXT_texture_filter_anisotropic',
  'MOZ_texture_filter_anisotropic',
  'WEBKIT_texture_filter_anisotropic',
];

const cachedProceduralSkyPixelsA = new Map();
const cachedExoticNebulaPixelsB = new Map();
const cachedSkyBlobs = new Map();

// Precomputed 12-bit linear-to-sRGB byte LUT for fast pixel encoding
const SRGB_LUT_SIZE = 4096;
const SRGB_LUT = (() => {
  const lut = new Uint8Array(SRGB_LUT_SIZE + 1);
  for (let i = 0; i <= SRGB_LUT_SIZE; i++) {
    const c = i / SRGB_LUT_SIZE;
    const srgb =
      c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
    lut[i] = Math.max(0, Math.min(255, Math.round(srgb * 255)));
  }
  return lut;
})();

function linearToSrgbByte(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  return SRGB_LUT[(c * SRGB_LUT_SIZE + 0.5) | 0];
}

function configureSkyTextureParams(gl, texture) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  for (const name of ANISOTROPY_EXT_NAMES) {
    const ext = gl.getExtension(name);
    if (ext) {
      const maxAniso = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      if (maxAniso && maxAniso > 1) {
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, maxAniso));
      }
      break;
    }
  }
}

function uploadPixelsWebGL(gl, pixels, width, height) {
  const texture = gl.createTexture();
  configureSkyTextureParams(gl, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

function uploadPixelsWebGPU(device, mipGen, pixels, width, height, label) {
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = device.createTexture({
    label,
    size: [width, height, 1],
    format: 'rgba8unorm',
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.writeTexture(
    { texture, mipLevel: 0 },
    pixels,
    { bytesPerRow: width * 4, rowsPerImage: height },
    [width, height, 1]
  );

  if (typeof mipGen === 'function') {
    mipGen(texture, width, height, mipLevelCount);
  }

  return texture;
}

function createMulberry32(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix, iy, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) * 2.3283064365386963e-10;
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function valueNoise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const tx = x - ix;
  const ty = y - iy;
  const tz = z - iz;
  const fx = tx * tx * (3 - 2 * tx);
  const fy = ty * ty * (3 - 2 * ty);
  const fz = tz * tz * (3 - 2 * tz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;

  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function fbm3D(x, y, z, octaves) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

function spectralTempToLinearRgb(tempK) {
  const t = tempK / 100.0;
  let r;
  let g;
  let b;

  if (t <= 66) {
    r = 1.0;
    g = 0.390081578769 * Math.log(Math.max(1.0, t)) - 0.631841443788;
    b = t <= 19 ? 0.0 : 0.54320678911 * Math.log(t - 10) - 1.19625408914;
  } else {
    r = 1.29293618606 * Math.pow(t - 60, -0.1332047592);
    g = 1.1298908609 * Math.pow(t - 60, -0.0755148492);
    b = 1.0;
  }

  const toLin = (v) => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lr = toLin(r);
  const lg = toLin(g);
  const lb = toLin(b);
  const peak = Math.max(lr, lg, lb, 1e-6);
  return [lr / peak, lg / peak, lb / peak];
}

function sampleSpectralTemperature(rand, warmBias = false) {
  const u = rand();
  if (warmBias) {
    if (u < 0.08) return 16000 + rand() * 14000;
    if (u < 0.25) return 7500 + rand() * 4500;
    if (u < 0.62) return 4600 + rand() * 2400;
    return 2800 + rand() * 1600;
  }
  if (u < 0.06) return 18000 + rand() * 17000;
  if (u < 0.22) return 7800 + rand() * 5200;
  if (u < 0.48) return 5400 + rand() * 2400;
  if (u < 0.78) return 3800 + rand() * 1600;
  return 2600 + rand() * 1200;
}

/**
 * Splats pinpoint spectral stars with polar cosine correction so stars remain round everywhere.
 */
function splatStarOnEquirect(accum, width, height, dx, dy, dz, brightness, sr, sg, sb) {
  const theta = Math.acos(Math.max(-1, Math.min(1, dy)));
  const rawSin = Math.sin(theta);
  const poleFade = smoothstep01((rawSin - 0.06) * 8.0);
  if (poleFade <= 0.01) return;
  const sinTheta = Math.max(0.06, rawSin);

  let phi = Math.atan2(dz, dx);
  if (phi < 0) phi += 2.0 * Math.PI;

  const fx = (phi / (2.0 * Math.PI)) * width;
  const fy = (theta / Math.PI) * height;

  const radius = brightness > 1.8 ? 1.32 : 0.72;
  const ix0 = Math.floor(fx);
  const iy0 = Math.floor(fy);
  const spanY = radius > 1.0 ? 2 : 1;
  const spanX = Math.min(10, Math.ceil(spanY / sinTheta));
  const invSigma2 = 1.0 / (radius * radius * 0.5);

  for (let oy = -spanY; oy <= spanY; oy++) {
    const py = iy0 + oy;
    if (py < 0 || py >= height) continue;
    const ddy = py + 0.5 - fy;

    for (let ox = -spanX; ox <= spanX; ox++) {
      const px = ((ix0 + ox) % width + width) % width;
      const ddx = (ix0 + ox + 0.5 - fx) * sinTheta;
      const dist2 = ddx * ddx + ddy * ddy;
      const w = Math.exp(-dist2 * invSigma2);
      if (w < 0.01) continue;

      const contrib = brightness * poleFade * w;
      const idx = (py * width + px) * 3;
      accum[idx + 0] += sr * contrib;
      accum[idx + 1] += sg * contrib;
      accum[idx + 2] += sb * contrib;
    }
  }
}

function encodeAccumToRgba8(accum, totalPixels, shoulder = 0.35) {
  const pixels = new Uint8Array(totalPixels * 4);
  for (let i = 0; i < totalPixels; i++) {
    const r = accum[i * 3 + 0];
    const g = accum[i * 3 + 1];
    const b = accum[i * 3 + 2];
    pixels[i * 4 + 0] = linearToSrgbByte(r / (1.0 + r * shoulder));
    pixels[i * 4 + 1] = linearToSrgbByte(g / (1.0 + g * shoulder));
    pixels[i * 4 + 2] = linearToSrgbByte(b / (1.0 + b * shoulder));
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

/**
 * Generates and caches Universe A's procedural deep-space Milky Way RGBA8 buffer.
 * @param {number} [width=2048]
 * @param {number} [height=1024]
 * @returns {Uint8Array}
 */
export function getProceduralSkyPixelsA(width = 2048, height = 1024) {
  const key = `${width}x${height}`;
  const cached = cachedProceduralSkyPixelsA.get(key);
  if (cached) return cached;

  const totalPixels = width * height;
  const accum = new Float32Array(totalPixels * 3);

  const tilt = (60.0 * Math.PI) / 180.0;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const yaw = 0.55;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);

  const cosPhiArr = new Float32Array(width);
  const sinPhiArr = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const phi = ((x + 0.5) / width) * 2.0 * Math.PI;
    cosPhiArr[x] = Math.cos(phi);
    sinPhiArr[x] = Math.sin(phi);
  }

  for (let y = 0; y < height; y++) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const dx = sinTheta * cosPhiArr[x];
      const dy = cosTheta;
      const dz = sinTheta * sinPhiArr[x];

      const rx = dx * cosYaw - dz * sinYaw;
      const rz = dx * sinYaw + dz * cosYaw;
      const gx = rx;
      const gy = dy * cosTilt - rz * sinTilt;
      const gz = dy * sinTilt + rz * cosTilt;

      const bandDist2 = gy * gy;
      const bandProfile = Math.exp(-bandDist2 * 26.0);
      const wideGlow = Math.exp(-bandDist2 * 5.2);

      const bulgeDot = Math.max(0, gx);
      const bulge = bulgeDot * bulgeDot * bulgeDot * Math.exp(-bandDist2 * 14.0);

      const cloudNoise = fbm3D(gx * 3.4 + 4.1, gy * 5.5 - 1.7, gz * 3.4 + 2.3, 4);
      const fineCloud = fbm3D(gx * 9.5 - 2.2, gy * 12.0 + 3.8, gz * 9.5 + 1.1, 3);
      const dustFbm = fbm3D(gx * 7.2 + 11.4, gy * 16.0 - 5.2, gz * 7.2 - 3.6, 4);

      const riftCoord = (gy - (cloudNoise - 0.5) * 0.08) * 18.0;
      const riftBand = Math.exp(-riftCoord * riftCoord);
      const dustExtinction = Math.max(
        0.18,
        1.0 - riftBand * (0.45 + 0.5 * smoothstep01((dustFbm - 0.35) * 2.2))
      );

      const baseIntensity =
        (bandProfile * (0.045 + 0.095 * cloudNoise * fineCloud) +
          wideGlow * 0.012 * cloudNoise +
          bulge * (0.09 + 0.08 * fineCloud)) *
        dustExtinction;

      const coreWarmth = Math.min(1.0, bulge * 1.4 + 0.15);
      const nebCool = Math.max(0, fineCloud - 0.55) * bandProfile * 0.045;
      const nebWarm = Math.max(0, cloudNoise - 0.58) * bulge * 0.05;

      const idx = (rowOff + x) * 3;
      accum[idx + 0] =
        0.0008 + baseIntensity * lerp(0.72, 1.18, coreWarmth) + nebWarm * 1.1 + nebCool * 0.35;
      accum[idx + 1] =
        0.0010 + baseIntensity * lerp(0.84, 0.96, coreWarmth) + nebWarm * 0.55 + nebCool * 0.65;
      accum[idx + 2] =
        0.0016 + baseIntensity * lerp(1.12, 0.72, coreWarmth) + nebWarm * 0.25 + nebCool * 1.25;
    }
  }

  const rand = createMulberry32(0x5a7a9c31);
  const starCount = Math.round(totalPixels * 0.012);

  for (let s = 0; s < starCount; s++) {
    let gx;
    let gy;
    let gz;
    if (rand() < 0.55) {
      const lon = rand() * 2.0 * Math.PI;
      const u1 = Math.max(1e-6, rand());
      const u2 = rand();
      const lat = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * 0.16;
      const clampedLat = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, lat));
      const cosLat = Math.cos(clampedLat);
      gx = cosLat * Math.cos(lon);
      gy = Math.sin(clampedLat);
      gz = cosLat * Math.sin(lon);
    } else {
      const z = rand() * 2.0 - 1.0;
      const lon = rand() * 2.0 * Math.PI;
      const rxy = Math.sqrt(Math.max(0, 1.0 - z * z));
      gx = rxy * Math.cos(lon);
      gy = z;
      gz = rxy * Math.sin(lon);
    }

    const ry = gy * cosTilt + gz * sinTilt;
    const rz = -gy * sinTilt + gz * cosTilt;
    const dx = gx * cosYaw + rz * sinYaw;
    const dy = ry;
    const dz = -gx * sinYaw + rz * cosYaw;

    const p = Math.max(1e-5, rand());
    const clampedBrightness = Math.min(8.5, 0.04 * Math.pow(p, -0.78));
    const [sr, sg, sb] = spectralTempToLinearRgb(sampleSpectralTemperature(rand, false));
    splatStarOnEquirect(accum, width, height, dx, dy, dz, clampedBrightness, sr, sg, sb);
  }

  const pixels = encodeAccumToRgba8(accum, totalPixels, 0.35);
  cachedProceduralSkyPixelsA.set(key, pixels);
  return pixels;
}

/**
 * Generates and caches Universe B's vivid Golden-Amber & Teal Emission Nebula
 * with sculpted cosmic dust pillars and bright alien star clusters.
 * @param {number} [width=2048]
 * @param {number} [height=1024]
 * @returns {Uint8Array}
 */
export function getExoticNebulaPixelsB(width = 2048, height = 1024) {
  const key = `${width}x${height}`;
  const cached = cachedExoticNebulaPixelsB.get(key);
  if (cached) return cached;

  const totalPixels = width * height;
  const accum = new Float32Array(totalPixels * 3);

  const fLen = Math.hypot(-0.886, -0.171, -0.430);
  const fX = -0.886 / fLen;
  const fY = -0.171 / fLen;
  const fZ = -0.430 / fLen;

  const upRefX = 0.36;
  const upRefY = 0.88;
  const upRefZ = -0.31;
  let rX = upRefY * fZ - upRefZ * fY;
  let rY = upRefZ * fX - upRefX * fZ;
  let rZ = upRefX * fY - upRefY * fX;
  const rLen = Math.hypot(rX, rY, rZ);
  rX /= rLen;
  rY /= rLen;
  rZ /= rLen;

  const uX = fY * rZ - fZ * rY;
  const uY = fZ * rX - fX * rZ;
  const uZ = fX * rY - fY * rX;

  const cosPhiArr = new Float32Array(width);
  const sinPhiArr = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const phi = ((x + 0.5) / width) * 2.0 * Math.PI;
    cosPhiArr[x] = Math.cos(phi);
    sinPhiArr[x] = Math.sin(phi);
  }

  for (let y = 0; y < height; y++) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const dx = sinTheta * cosPhiArr[x];
      const dy = cosTheta;
      const dz = sinTheta * sinPhiArr[x];

      const nx = dx * rX + dy * rY + dz * rZ;
      const ny = dx * uX + dy * uY + dz * uZ;
      const nz = dx * fX + dy * fY + dz * fZ;

      const warpA = fbm3D(nx * 2.8 + 1.3, ny * 2.8 - 0.8, nz * 2.8 + 3.1, 3) - 0.5;
      const wx = nx + warpA * 0.48;
      const wy = ny - warpA * 0.34;
      const wz = nz + warpA * 0.28;

      const cloudBase = fbm3D(wx * 3.4 + 7.2, wy * 4.2 - 2.4, wz * 3.4 + 5.6, 4);
      const fineFbm = fbm3D(wx * 9.8 - 3.3, wy * 11.4 + 4.9, wz * 9.8 + 2.1, 3);

      const rawRidge = 1.0 - Math.abs(fineFbm * 2.0 - 1.0);
      const ridge = rawRidge * rawRidge * rawRidge;

      const bandDist = ny + warpA * 0.24;
      const bandEnv = Math.exp(-bandDist * bandDist * 16.0);
      const wideTealHalo = Math.exp(-bandDist * bandDist * 4.2);

      const heartDot = Math.max(0.0, nz * 0.84 + 0.16);
      const heartFocus = heartDot * heartDot * heartDot * (0.28 + 0.72 * bandEnv);

      const pillarField = cloudBase * 0.52 + fineFbm * 0.48;
      const pillarCore = smoothstep01((pillarField - 0.54) * 5.0) * (0.25 + 0.75 * bandEnv);
      const dustTransmit = 1.0 - pillarCore * 0.90;
      const pillarRim =
        smoothstep01((pillarField - 0.48) * 11.0) *
        (1.0 - smoothstep01((pillarField - 0.57) * 9.0)) *
        bandEnv;

      const ionBalance = smoothstep01((cloudBase - 0.44) * 4.2);

      const goldCore =
        heartFocus * (0.14 + 0.78 * ionBalance) +
        bandEnv * ridge * (0.18 + 0.44 * ionBalance);
      const goldWeight = goldCore * dustTransmit + pillarRim * 0.56;

      const tealPockets = (1.0 - ionBalance * 0.75) * smoothstep01((fineFbm - 0.30) * 2.8);
      const tealWeight =
        (wideTealHalo * 0.055 * (0.4 + 0.6 * tealPockets) +
          bandEnv * (0.16 * tealPockets + 0.34 * ridge * (1.0 - ionBalance * 0.6))) *
        (0.22 + 0.78 * dustTransmit);

      let r = 0.0007 + goldWeight * 1.15 + tealWeight * 0.025;
      let g = 0.0016 + goldWeight * 0.46 + tealWeight * 0.52;
      let b = 0.0032 + goldWeight * 0.05 + tealWeight * 0.68;

      const coreSpark = Math.max(0.0, cloudBase - 0.58) * heartFocus * dustTransmit;
      r += coreSpark * 0.95;
      g += coreSpark * 0.58;
      b += coreSpark * 0.18;

      const idx = (rowOff + x) * 3;
      accum[idx + 0] = r;
      accum[idx + 1] = g;
      accum[idx + 2] = b;
    }
  }

  const rand = createMulberry32(0x9b3e7c41);
  const starCount = Math.round(totalPixels * 0.015);

  for (let s = 0; s < starCount; s++) {
    let lx;
    let ly;
    let lz;
    const mode = rand();
    if (mode < 0.22) {
      const spread = 0.36;
      lx = (rand() * 2 - 1) * spread;
      ly = (rand() * 2 - 1) * spread * 0.65;
      lz = 1.0;
      const inv = 1.0 / Math.hypot(lx, ly, lz);
      lx *= inv;
      ly *= inv;
      lz *= inv;
    } else if (mode < 0.66) {
      const lon = rand() * 2.0 * Math.PI;
      const u1 = Math.max(1e-6, rand());
      const u2 = rand();
      const lat = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * 0.20;
      const clampedLat = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, lat));
      const cosLat = Math.cos(clampedLat);
      lx = cosLat * Math.cos(lon);
      ly = Math.sin(clampedLat);
      lz = cosLat * Math.sin(lon);
    } else {
      const z = rand() * 2.0 - 1.0;
      const lon = rand() * 2.0 * Math.PI;
      const rxy = Math.sqrt(Math.max(0, 1.0 - z * z));
      lx = rxy * Math.cos(lon);
      ly = z;
      lz = rxy * Math.sin(lon);
    }

    const dx = lx * rX + ly * uX + lz * fX;
    const dy = lx * rY + ly * uY + lz * fY;
    const dz = lx * rZ + ly * uZ + lz * fZ;

    const p = Math.max(1e-5, rand());
    const clampedBrightness = Math.min(10.0, 0.055 * Math.pow(p, -0.78));
    const [sr, sg, sb] = spectralTempToLinearRgb(sampleSpectralTemperature(rand, true));
    splatStarOnEquirect(accum, width, height, dx, dy, dz, clampedBrightness, sr, sg, sb);
  }

  const pixels = encodeAccumToRgba8(accum, totalPixels, 0.42);
  cachedExoticNebulaPixelsB.set(key, pixels);
  return pixels;
}

/**
 * Alias for single-universe procedural Milky Way RGBA8 buffer.
 */
export function getProceduralSkyPixels(width = 2048, height = 1024) {
  return getProceduralSkyPixelsA(width, height);
}

/**
 * Creates Universe A's procedural Milky Way WebGL2 texture with full mip chain.
 */
export function createProceduralSkyTextureAWebGL(gl, width = 2048, height = 1024) {
  return uploadPixelsWebGL(gl, getProceduralSkyPixelsA(width, height), width, height);
}

/**
 * Single-universe alias for procedural Milky Way WebGL2 texture.
 */
export function createProceduralSkyTextureWebGL(gl, width = 2048, height = 1024) {
  return createProceduralSkyTextureAWebGL(gl, width, height);
}

/**
 * Creates Universe A's procedural Milky Way WebGPU texture with full mip chain.
 */
export function createProceduralSkyTextureAWebGPU(device, mipGen, width = 2048, height = 1024) {
  return uploadPixelsWebGPU(
    device,
    mipGen,
    getProceduralSkyPixelsA(width, height),
    width,
    height,
    'proc-sky-a-map'
  );
}

/**
 * Single-universe alias for procedural Milky Way WebGPU texture.
 */
export function createProceduralSkyTextureWebGPU(device, mipGen, width = 2048, height = 1024) {
  return uploadPixelsWebGPU(
    device,
    mipGen,
    getProceduralSkyPixelsA(width, height),
    width,
    height,
    'proc-sky-map'
  );
}

/**
 * Creates Universe B's exotic golden-amber & teal nebula WebGL2 texture with full mip chain.
 */
export function createExoticNebulaTextureBWebGL(gl, width = 2048, height = 1024) {
  return uploadPixelsWebGL(gl, getExoticNebulaPixelsB(width, height), width, height);
}

/**
 * Creates Universe B's exotic golden-amber & teal nebula WebGPU texture with full mip chain.
 */
export function createExoticNebulaTextureBWebGPU(device, mipGen, width = 2048, height = 1024) {
  return uploadPixelsWebGPU(
    device,
    mipGen,
    getExoticNebulaPixelsB(width, height),
    width,
    height,
    'exotic-nebula-b-map'
  );
}

async function decodeImageSource(url) {
  let blob = cachedSkyBlobs.get(url);
  if (!blob) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching sky texture: ${url}`);
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error(`Non-image content-type (${contentType}) for ${url}`);
    }
    blob = await response.blob();
    cachedSkyBlobs.set(url, blob);
  }

  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob, {
      imageOrientation: 'none',
      premultiplyAlpha: 'none',
    });
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`Failed to decode sky image: ${url}`));
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Loads Universe A's 4K equirectangular Milky Way into WebGL2 or falls back cleanly.
 * @returns {Promise<{ texture: WebGLTexture, width: number, height: number, isRealMap: boolean }>}
 */
export async function loadSkyTextureAWebGL(gl, url = DEFAULT_SKY_URL) {
  try {
    const source = await decodeImageSource(url);
    const width = source.width;
    const height = source.height;

    const texture = gl.createTexture();
    configureSkyTextureParams(gl, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);

    if (typeof source.close === 'function') {
      source.close();
    }

    return { texture, width, height, isRealMap: true };
  } catch (err) {
    console.warn(`[skyLoader] Falling back to procedural sky A (${err?.message ?? err})`);
    const width = 2048;
    const height = 1024;
    const texture = createProceduralSkyTextureAWebGL(gl, width, height);
    return { texture, width, height, isRealMap: false };
  }
}

/**
 * Single-universe alias for loading equirectangular sky texture into WebGL2.
 */
export async function loadSkyTextureWebGL(gl, url = DEFAULT_SKY_URL) {
  return loadSkyTextureAWebGL(gl, url);
}

/**
 * Loads Universe A's 4K equirectangular Milky Way into WebGPU or falls back cleanly.
 * @returns {Promise<{ texture: GPUTexture, width: number, height: number, isRealMap: boolean }>}
 */
export async function loadSkyTextureAWebGPU(device, mipGen, url = DEFAULT_SKY_URL) {
  try {
    const source = await decodeImageSource(url);
    const width = source.width;
    const height = source.height;
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;

    const texture = device.createTexture({
      label: 'real-sky-a-map',
      size: [width, height, 1],
      format: 'rgba8unorm',
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture, mipLevel: 0 },
      [width, height]
    );

    if (typeof source.close === 'function') {
      source.close();
    }

    if (typeof mipGen === 'function') {
      mipGen(texture, width, height, mipLevelCount);
    }

    return { texture, width, height, isRealMap: true };
  } catch (err) {
    console.warn(`[skyLoader] Falling back to procedural sky A (${err?.message ?? err})`);
    const width = 2048;
    const height = 1024;
    const texture = createProceduralSkyTextureAWebGPU(device, mipGen, width, height);
    return { texture, width, height, isRealMap: false };
  }
}

/**
 * Single-universe alias for loading equirectangular sky texture into WebGPU.
 */
export async function loadSkyTextureWebGPU(device, mipGen, url = DEFAULT_SKY_URL) {
  return loadSkyTextureAWebGPU(device, mipGen, url);
}
