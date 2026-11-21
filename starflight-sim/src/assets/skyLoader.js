/**
 * skyLoader.js — Unified sky texture acquisition and procedural deep-space fallback
 * generator for the Relativistic Starflight Simulator (WebGL2 + WebGPU), with
 * module-level CPU pixel & blob caching so live backend switching reuses data
 * from RAM with zero redundant synthesis or fetches.
 */

const ANISOTROPY_EXT_NAMES = [
  'EXT_texture_filter_anisotropic',
  'MOZ_texture_filter_anisotropic',
  'WEBKIT_texture_filter_anisotropic',
];

const cachedProceduralSkyPixels = new Map();
const cachedSkyBlobs = new Map();

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
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function valueNoise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const fz = smoothstep(z - iz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);

  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
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

function linearToSrgbByte(c) {
  const clamped = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const srgb =
    clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

/**
 * Approximate linear Rec.709 star chromaticity from effective temperature (Kelvin).
 * Covers M (~2600K) through O (~35000K) spectral classes.
 */
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

function sampleSpectralTemperature(rand) {
  const u = rand();
  if (u < 0.06) return 18000 + rand() * 17000; // O/B blue-white
  if (u < 0.22) return 7800 + rand() * 5200;   // A/B white-blue
  if (u < 0.48) return 5400 + rand() * 2400;   // F/G solar white-yellow
  if (u < 0.78) return 3800 + rand() * 1600;   // K warm orange
  return 2600 + rand() * 1200;                 // M red-orange
}

/**
 * Generates and caches the procedural deep-space Milky Way RGBA byte buffer on CPU.
 * @param {number} [width=2048]
 * @param {number} [height=1024]
 * @returns {Uint8Array}
 */
export function getProceduralSkyPixels(width = 2048, height = 1024) {
  const key = `${width}x${height}`;
  const cached = cachedProceduralSkyPixels.get(key);
  if (cached) return cached;

  const totalPixels = width * height;
  const accum = new Float32Array(totalPixels * 3);

  const tilt = (60.0 * Math.PI) / 180.0;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const yaw = 0.55;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);

  // 1. Continuous Milky Way band, dust lanes, and subtle warm/cool nebulae
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = u * 2.0 * Math.PI;

      const dx = sinTheta * Math.cos(phi);
      const dy = cosTheta;
      const dz = sinTheta * Math.sin(phi);

      const rx = dx * cosYaw - dz * sinYaw;
      const rz = dx * sinYaw + dz * cosYaw;
      const gx = rx;
      const gy = dy * cosTilt - rz * sinTilt;
      const gz = dy * sinTilt + rz * cosTilt;

      const bandDist = Math.abs(gy);
      const bandProfile = Math.exp(-bandDist * bandDist * 26.0);
      const wideGlow = Math.exp(-bandDist * bandDist * 5.2);

      const bulgeDot = Math.max(0, gx);
      const bulge = Math.pow(bulgeDot, 3.0) * Math.exp(-bandDist * bandDist * 14.0);

      const cloudNoise = fbm3D(gx * 3.4 + 4.1, gy * 5.5 - 1.7, gz * 3.4 + 2.3, 4);
      const fineCloud = fbm3D(gx * 9.5 - 2.2, gy * 12.0 + 3.8, gz * 9.5 + 1.1, 3);
      const dustFbm = fbm3D(gx * 7.2 + 11.4, gy * 16.0 - 5.2, gz * 7.2 - 3.6, 4);

      const riftBand = Math.exp(-Math.pow((gy - (cloudNoise - 0.5) * 0.08) * 18.0, 2.0));
      const dustExtinction = Math.max(
        0.18,
        1.0 - riftBand * (0.45 + 0.5 * smoothstep(Math.max(0, Math.min(1, (dustFbm - 0.35) * 2.2))))
      );

      const baseIntensity =
        (bandProfile * (0.045 + 0.095 * cloudNoise * fineCloud) +
          wideGlow * 0.012 * cloudNoise +
          bulge * (0.09 + 0.08 * fineCloud)) *
        dustExtinction;

      const coreWarmth = Math.min(1.0, bulge * 1.4 + 0.15);
      const nebCool = Math.max(0, fineCloud - 0.55) * bandProfile * 0.045;
      const nebWarm = Math.max(0, cloudNoise - 0.58) * bulge * 0.05;

      const idx = (y * width + x) * 3;
      accum[idx + 0] =
        0.0008 + baseIntensity * lerp(0.72, 1.18, coreWarmth) + nebWarm * 1.1 + nebCool * 0.35;
      accum[idx + 1] =
        0.0010 + baseIntensity * lerp(0.84, 0.96, coreWarmth) + nebWarm * 0.55 + nebCool * 0.65;
      accum[idx + 2] =
        0.0016 + baseIntensity * lerp(1.12, 0.72, coreWarmth) + nebWarm * 0.25 + nebCool * 1.25;
    }
  }

  // 2. Thousands of spectral-colored pinpoint stars with power-law magnitude distribution
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
      const lat = (Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)) * 0.16;
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

    const theta = Math.acos(Math.max(-1, Math.min(1, dy)));
    let phi = Math.atan2(dz, dx);
    if (phi < 0) phi += 2.0 * Math.PI;

    const fx = (phi / (2.0 * Math.PI)) * width;
    const fy = (theta / Math.PI) * height;

    const p = Math.max(1e-5, rand());
    const brightness = 0.04 * Math.pow(p, -0.78);
    const clampedBrightness = Math.min(8.5, brightness);

    const tempK = sampleSpectralTemperature(rand);
    const [sr, sg, sb] = spectralTempToLinearRgb(tempK);

    const radius = clampedBrightness > 1.8 ? 1.35 : 0.72;
    const ix0 = Math.floor(fx);
    const iy0 = Math.floor(fy);
    const span = radius > 1.0 ? 2 : 1;

    for (let oy = -span; oy <= span; oy++) {
      const py = iy0 + oy;
      if (py < 0 || py >= height) continue;
      const ddy = py + 0.5 - fy;

      for (let ox = -span; ox <= span; ox++) {
        const px = ((ix0 + ox) % width + width) % width;
        const ddx = ix0 + ox + 0.5 - fx;
        const dist2 = ddx * ddx + ddy * ddy;
        const w = Math.exp(-dist2 / (radius * radius * 0.5));
        if (w < 0.01) continue;

        const contrib = clampedBrightness * w;
        const idx = (py * width + px) * 3;
        accum[idx + 0] += sr * contrib;
        accum[idx + 1] += sg * contrib;
        accum[idx + 2] += sb * contrib;
      }
    }
  }

  // 3. Soft shoulder tone compression + sRGB encoding to RGBA8
  const pixels = new Uint8Array(totalPixels * 4);
  for (let i = 0; i < totalPixels; i++) {
    const r = accum[i * 3 + 0];
    const g = accum[i * 3 + 1];
    const b = accum[i * 3 + 2];
    pixels[i * 4 + 0] = linearToSrgbByte(r / (1.0 + r * 0.35));
    pixels[i * 4 + 1] = linearToSrgbByte(g / (1.0 + g * 0.35));
    pixels[i * 4 + 2] = linearToSrgbByte(b / (1.0 + b * 0.35));
    pixels[i * 4 + 3] = 255;
  }

  cachedProceduralSkyPixels.set(key, pixels);
  return pixels;
}

/**
 * Creates a procedural equirectangular deep-space Milky Way WebGL2 texture with full mip chain.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [width=2048]
 * @param {number} [height=1024]
 * @returns {WebGLTexture}
 */
export function createProceduralSkyTextureWebGL(gl, width = 2048, height = 1024) {
  const pixels = getProceduralSkyPixels(width, height);
  const texture = gl.createTexture();
  configureSkyTextureParams(gl, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

/**
 * Creates a procedural equirectangular deep-space Milky Way WebGPU texture with full mip chain.
 * @param {GPUDevice} device
 * @param {(texture: GPUTexture, width: number, height: number, mipLevelCount: number) => void} mipGen
 * @param {number} [width=2048]
 * @param {number} [height=1024]
 * @returns {GPUTexture}
 */
export function createProceduralSkyTextureWebGPU(device, mipGen, width = 2048, height = 1024) {
  const pixels = getProceduralSkyPixels(width, height);
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = device.createTexture({
    label: 'proc-sky-map',
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

async function decodeImageSource(url) {
  let blob = cachedSkyBlobs.get(url);
  if (!blob) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching sky texture: ${url}`);
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
 * Loads an equirectangular sky texture into WebGL2 or falls back to the procedural Milky Way starfield.
 * @param {WebGL2RenderingContext} gl
 * @param {string} [url='./assets/milkyway_4k.jpg']
 * @returns {Promise<{ texture: WebGLTexture, width: number, height: number, isRealMap: boolean }>}
 */
export async function loadSkyTextureWebGL(gl, url = './assets/milkyway_4k.jpg') {
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
    console.warn(`[skyLoader] Falling back to procedural sky map (${err?.message ?? err})`);
    const width = 2048;
    const height = 1024;
    const texture = createProceduralSkyTextureWebGL(gl, width, height);
    return { texture, width, height, isRealMap: false };
  }
}

/**
 * Loads an equirectangular sky texture into WebGPU or falls back to the procedural Milky Way starfield.
 * @param {GPUDevice} device
 * @param {(texture: GPUTexture, width: number, height: number, mipLevelCount: number) => void} mipGen
 * @param {string} [url='./assets/milkyway_4k.jpg']
 * @returns {Promise<{ texture: GPUTexture, width: number, height: number, isRealMap: boolean }>}
 */
export async function loadSkyTextureWebGPU(device, mipGen, url = './assets/milkyway_4k.jpg') {
  try {
    const source = await decodeImageSource(url);
    const width = source.width;
    const height = source.height;
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;

    const texture = device.createTexture({
      label: 'real-sky-map',
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
    console.warn(`[skyLoader] Falling back to procedural sky map (${err?.message ?? err})`);
    const width = 2048;
    const height = 1024;
    const texture = createProceduralSkyTextureWebGPU(device, mipGen, width, height);
    return { texture, width, height, isRealMap: false };
  }
}
