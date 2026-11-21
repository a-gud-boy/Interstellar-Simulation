/**
 * physicalLuts.js — Physically-based lookup tables for relativistic blackbody radiation
 * (CIE 1931 2-deg Planck chromaticity, 800 K..40,000 K) and high-frequency toroidal
 * blue-noise dithering for the Relativistic Starflight Simulator (WebGL2 + WebGPU),
 * with module-level CPU data caching for near-instantaneous backend toggling.
 */

export const BLACKBODY_T_MIN = 800.0;
export const BLACKBODY_T_MAX = 40000.0;

// Standard CIE 1931 2-degree color matching functions from 380 nm to 780 nm (5 nm step, 81 samples)
// Format: [xBar, yBar, zBar] per 5 nm step
const CIE_1931_2DEG_5NM = [
  [0.001368, 0.000039, 0.006450], // 380
  [0.002236, 0.000064, 0.010550], // 385
  [0.004243, 0.000120, 0.020050], // 390
  [0.007650, 0.000217, 0.036210], // 395
  [0.014310, 0.000396, 0.067850], // 400
  [0.023190, 0.000640, 0.110200], // 405
  [0.043510, 0.001210, 0.207400], // 410
  [0.077630, 0.002180, 0.371300], // 415
  [0.134380, 0.004000, 0.645600], // 420
  [0.214770, 0.007300, 1.039050], // 425
  [0.283900, 0.011600, 1.385600], // 430
  [0.328500, 0.016840, 1.622960], // 435
  [0.348280, 0.023000, 1.747060], // 440
  [0.348060, 0.029800, 1.782600], // 445
  [0.336200, 0.038000, 1.772110], // 450
  [0.318700, 0.048000, 1.744100], // 455
  [0.290800, 0.060000, 1.669200], // 460
  [0.251100, 0.073900, 1.528100], // 465
  [0.195360, 0.090980, 1.287640], // 470
  [0.142100, 0.112600, 1.041900], // 475
  [0.095640, 0.139020, 0.812950], // 480
  [0.057950, 0.169300, 0.616200], // 485
  [0.032010, 0.208020, 0.465180], // 490
  [0.014700, 0.258600, 0.353300], // 495
  [0.004900, 0.323000, 0.272000], // 500
  [0.002400, 0.407300, 0.212300], // 505
  [0.009300, 0.503000, 0.158200], // 510
  [0.029100, 0.608200, 0.111700], // 515
  [0.063270, 0.710000, 0.078250], // 520
  [0.109600, 0.793200, 0.057250], // 525
  [0.165500, 0.862000, 0.042160], // 530
  [0.225750, 0.914850, 0.029840], // 535
  [0.290400, 0.954000, 0.020300], // 540
  [0.359700, 0.980300, 0.013400], // 545
  [0.433450, 0.994950, 0.008750], // 550
  [0.512050, 1.000000, 0.005750], // 555
  [0.594500, 0.995000, 0.003900], // 560
  [0.678400, 0.978600, 0.002750], // 565
  [0.762100, 0.952000, 0.002100], // 570
  [0.842500, 0.915400, 0.001800], // 575
  [0.916300, 0.870000, 0.001650], // 580
  [0.978600, 0.816300, 0.001400], // 585
  [1.026300, 0.757000, 0.001100], // 590
  [1.056700, 0.694900, 0.001000], // 595
  [1.062200, 0.631000, 0.000800], // 600
  [1.045600, 0.566800, 0.000600], // 605
  [1.002600, 0.503000, 0.000340], // 610
  [0.938400, 0.441200, 0.000240], // 615
  [0.854450, 0.381000, 0.000190], // 620
  [0.751400, 0.321000, 0.000100], // 625
  [0.642400, 0.265000, 0.000050], // 630
  [0.541900, 0.217000, 0.000030], // 635
  [0.447900, 0.175000, 0.000020], // 640
  [0.360800, 0.138200, 0.000010], // 645
  [0.283500, 0.107000, 0.000000], // 650
  [0.218700, 0.081600, 0.000000], // 655
  [0.164900, 0.061000, 0.000000], // 660
  [0.121200, 0.044580, 0.000000], // 665
  [0.087400, 0.032000, 0.000000], // 670
  [0.063600, 0.023200, 0.000000], // 675
  [0.046770, 0.017000, 0.000000], // 680
  [0.032900, 0.011920, 0.000000], // 685
  [0.022700, 0.008210, 0.000000], // 690
  [0.015840, 0.005723, 0.000000], // 695
  [0.011359, 0.004102, 0.000000], // 700
  [0.008111, 0.002929, 0.000000], // 705
  [0.005790, 0.002091, 0.000000], // 710
  [0.004109, 0.001484, 0.000000], // 715
  [0.002899, 0.001047, 0.000000], // 720
  [0.002049, 0.000740, 0.000000], // 725
  [0.001440, 0.000520, 0.000000], // 730
  [0.001000, 0.000361, 0.000000], // 735
  [0.000690, 0.000249, 0.000000], // 740
  [0.000476, 0.000172, 0.000000], // 745
  [0.000332, 0.000120, 0.000000], // 750
  [0.000235, 0.000085, 0.000000], // 755
  [0.000166, 0.000060, 0.000000], // 760
  [0.000117, 0.000042, 0.000000], // 765
  [0.000083, 0.000030, 0.000000], // 770
  [0.000059, 0.000021, 0.000000], // 775
  [0.000042, 0.000015, 0.000000], // 780
];

// Physical constants (CODATA 2018)
const PLANCK_H = 6.62607015e-34;
const SPEED_OF_LIGHT = 2.99792458e8;
const BOLTZMANN_K = 1.380649e-23;
const C1 = 2.0 * PLANCK_H * SPEED_OF_LIGHT * SPEED_OF_LIGHT;
const C2 = (PLANCK_H * SPEED_OF_LIGHT) / BOLTZMANN_K;

const _f32Scratch = new Float32Array(1);
const _u32Scratch = new Uint32Array(_f32Scratch.buffer);

const blackbodyDataCache = new Map();
const blueNoiseDataCache = new Map();

function isWebGPUDevice(target) {
  return Boolean(target && typeof target.createTexture === 'function' && target.queue);
}

/**
 * Converts a JS number to IEEE-754 binary16 (half-float) bits.
 * @param {number} value
 * @returns {number}
 */
function floatToHalf(value) {
  _f32Scratch[0] = value;
  const x = _u32Scratch[0];

  const sign = (x >>> 16) & 0x8000;
  let mantissa = x & 0x007fffff;
  const exp = (x >>> 23) & 0xff;

  if (exp === 0xff) {
    return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  }

  const halfExp = exp - 127 + 15;
  if (halfExp >= 31) {
    return sign | 0x7c00;
  }
  if (halfExp <= 0) {
    if (halfExp < -10) return sign;
    mantissa = (mantissa | 0x00800000) >> (1 - halfExp);
    return sign | ((mantissa + 0x1000) >> 13);
  }

  return sign | (halfExp << 10) | ((mantissa + 0x1000) >> 13);
}

/**
 * Computes linear Rec.709 RGB chromaticity (max(r,g,b) = 1.0) for a blackbody at temperature T (K).
 * @param {number} temperatureK
 * @returns {[number, number, number]}
 */
export function computeBlackbodyLinearRgb(temperatureK) {
  let X = 0.0;
  let Y = 0.0;
  let Z = 0.0;

  for (let i = 0; i < CIE_1931_2DEG_5NM.length; i++) {
    const lambdaM = (380.0 + i * 5.0) * 1e-9;
    const exponent = C2 / (lambdaM * temperatureK);
    const radiance =
      exponent > 700.0
        ? 0.0
        : C1 / (Math.pow(lambdaM, 5.0) * Math.expm1(exponent));

    const [xb, yb, zb] = CIE_1931_2DEG_5NM[i];
    X += radiance * xb;
    Y += radiance * yb;
    Z += radiance * zb;
  }

  // CIE XYZ -> Linear Rec.709 / sRGB (D65)
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  r = r > 0.0 ? r : 0.0;
  g = g > 0.0 ? g : 0.0;
  b = b > 0.0 ? b : 0.0;

  const peak = Math.max(r, g, b, 1e-12);
  return [r / peak, g / peak, b / peak];
}

/**
 * Returns cached CPU-side Planck blackbody LUT arrays (`halfData` & `byteData`).
 * @param {number} [size=512]
 * @returns {{ halfData: Uint16Array, byteData: Uint8Array, tMin: number, tMax: number }}
 */
export function getBlackbodyData(size = 512) {
  const cached = blackbodyDataCache.get(size);
  if (cached) return cached;

  const tMin = BLACKBODY_T_MIN;
  const tMax = BLACKBODY_T_MAX;
  const logRatio = Math.log(tMax / tMin);

  const halfData = new Uint16Array(size * 4);
  const byteData = new Uint8Array(size * 4);
  const oneHalf = floatToHalf(1.0);

  for (let i = 0; i < size; i++) {
    const u = size > 1 ? i / (size - 1) : 0.0;
    const tempK = tMin * Math.exp(u * logRatio);
    const [r, g, b] = computeBlackbodyLinearRgb(tempK);

    const base = i * 4;
    halfData[base + 0] = floatToHalf(r);
    halfData[base + 1] = floatToHalf(g);
    halfData[base + 2] = floatToHalf(b);
    halfData[base + 3] = oneHalf;

    byteData[base + 0] = Math.round(r * 255);
    byteData[base + 1] = Math.round(g * 255);
    byteData[base + 2] = Math.round(b * 255);
    byteData[base + 3] = 255;
  }

  const entry = { halfData, byteData, tMin, tMax };
  blackbodyDataCache.set(size, entry);
  return entry;
}

/**
 * Uploads the cached 1D logarithmic blackbody LUT texture to WebGL2.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size=512]
 * @returns {{ texture: WebGLTexture, tMin: number, tMax: number }}
 */
export function createBlackbodyLUTWebGL(gl, size = 512) {
  const { halfData, byteData, tMin, tMax } = getBlackbodyData(size);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // RGBA16F with HALF_FLOAT is guaranteed texture-filterable (LINEAR) in core WebGL2
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, 1, 0, gl.RGBA, gl.HALF_FLOAT, halfData);
    if (gl.getError() !== gl.NO_ERROR) {
      throw new Error('RGBA16F upload failed');
    }
  } catch {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, byteData);
  }

  return { texture, tMin, tMax };
}

/**
 * Uploads the cached 1D logarithmic blackbody LUT texture to WebGPU (rgba16float).
 * @param {GPUDevice} device
 * @param {number} [size=512]
 * @returns {{ texture: GPUTexture, view: GPUTextureView, tMin: number, tMax: number }}
 */
export function createBlackbodyLUTWebGPU(device, size = 512) {
  const { halfData, tMin, tMax } = getBlackbodyData(size);

  const texture = device.createTexture({
    label: 'blackbody-lut',
    size: [size, 1, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    halfData,
    { bytesPerRow: size * 8, rowsPerImage: 1 },
    [size, 1, 1]
  );

  return { texture, view: texture.createView(), tMin, tMax };
}

/**
 * Smart wrapper accepting either a WebGL2RenderingContext or WebGPU GPUDevice.
 */
export function createBlackbodyLUT(ctxOrDevice, size = 512) {
  return isWebGPUDevice(ctxOrDevice)
    ? createBlackbodyLUTWebGPU(ctxOrDevice, size)
    : createBlackbodyLUTWebGL(ctxOrDevice, size);
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

/**
 * Generates one toroidal blue-noise rank array [0..size*size-1] via Ulichney's void-and-cluster
 * algorithm with row-accelerated extrema lookup.
 */
function generateBlueNoiseChannel(size, seed) {
  const n = size;
  const total = n * n;
  const sigma = 1.5;
  const radius = 5;
  const kDim = radius * 2 + 1;
  const kernel = new Float32Array(kDim * kDim);
  const invTwoSigma2 = 1.0 / (2.0 * sigma * sigma);

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel[(dy + radius) * kDim + (dx + radius)] = Math.exp(
        -(dx * dx + dy * dy) * invTwoSigma2
      );
    }
  }

  const rand = createMulberry32(seed);
  const initialCount = Math.max(1, Math.floor(total * 0.1));
  const binary = new Uint8Array(total);
  const energy = new Float32Array(total);

  let placed = 0;
  while (placed < initialCount) {
    const idx = Math.floor(rand() * total);
    if (binary[idx] === 0) {
      binary[idx] = 1;
      placed++;
    }
  }

  const splat = (idx, sign) => {
    const cx = idx % n;
    const cy = (idx / n) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = (cy + dy + n) % n;
      const rowOff = y * n;
      const kRow = (dy + radius) * kDim;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (cx + dx + n) % n;
        energy[rowOff + x] += sign * kernel[kRow + (dx + radius)];
      }
    }
  };

  for (let i = 0; i < total; i++) {
    if (binary[i]) splat(i, 1.0);
  }

  const rowMaxVal = new Float32Array(n);
  const rowMaxIdx = new Int32Array(n);
  const rowMinVal = new Float32Array(n);
  const rowMinIdx = new Int32Array(n);

  const updateRow = (y) => {
    const rowOff = y * n;
    let maxV = -1e30;
    let maxI = -1;
    let minV = 1e30;
    let minI = -1;
    for (let x = 0; x < n; x++) {
      const idx = rowOff + x;
      const e = energy[idx];
      if (binary[idx]) {
        if (e > maxV) {
          maxV = e;
          maxI = idx;
        }
      } else if (e < minV) {
        minV = e;
        minI = idx;
      }
    }
    rowMaxVal[y] = maxV;
    rowMaxIdx[y] = maxI;
    rowMinVal[y] = minV;
    rowMinIdx[y] = minI;
  };

  const updateAllRows = () => {
    for (let y = 0; y < n; y++) updateRow(y);
  };

  const updateRowsAround = (idx) => {
    const cy = (idx / n) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      updateRow((cy + dy + n) % n);
    }
  };

  const findTightestCluster = () => {
    let bestV = -1e30;
    let bestI = -1;
    for (let y = 0; y < n; y++) {
      if (rowMaxVal[y] > bestV) {
        bestV = rowMaxVal[y];
        bestI = rowMaxIdx[y];
      }
    }
    return bestI;
  };

  const findLargestVoid = () => {
    let bestV = 1e30;
    let bestI = -1;
    for (let y = 0; y < n; y++) {
      if (rowMinVal[y] < bestV) {
        bestV = rowMinVal[y];
        bestI = rowMinIdx[y];
      }
    }
    return bestI;
  };

  updateAllRows();
  for (let iter = 0; iter < initialCount * 2; iter++) {
    const clusterIdx = findTightestCluster();
    binary[clusterIdx] = 0;
    splat(clusterIdx, -1.0);
    updateRowsAround(clusterIdx);

    const voidIdx = findLargestVoid();
    if (voidIdx === clusterIdx) {
      binary[clusterIdx] = 1;
      splat(clusterIdx, 1.0);
      updateRowsAround(clusterIdx);
      break;
    }
    binary[voidIdx] = 1;
    splat(voidIdx, 1.0);
    updateRowsAround(voidIdx);
  }

  const initialBinary = new Uint8Array(binary);
  const initialEnergy = new Float32Array(energy);
  const ranks = new Int32Array(total);

  for (let rank = initialCount - 1; rank >= 0; rank--) {
    const clusterIdx = findTightestCluster();
    ranks[clusterIdx] = rank;
    binary[clusterIdx] = 0;
    splat(clusterIdx, -1.0);
    updateRowsAround(clusterIdx);
  }

  binary.set(initialBinary);
  energy.set(initialEnergy);
  updateAllRows();
  const half = total >> 1;
  for (let rank = initialCount; rank < half; rank++) {
    const voidIdx = findLargestVoid();
    ranks[voidIdx] = rank;
    binary[voidIdx] = 1;
    splat(voidIdx, 1.0);
    updateRowsAround(voidIdx);
  }

  for (let i = 0; i < total; i++) {
    binary[i] = binary[i] ? 0 : 1;
  }
  energy.fill(0);
  for (let i = 0; i < total; i++) {
    if (binary[i]) splat(i, 1.0);
  }
  updateAllRows();
  for (let rank = half; rank < total; rank++) {
    const clusterIdx = findTightestCluster();
    ranks[clusterIdx] = rank;
    binary[clusterIdx] = 0;
    splat(clusterIdx, -1.0);
    updateRowsAround(clusterIdx);
  }

  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    bytes[i] = Math.min(255, Math.floor((ranks[i] * 256) / total));
  }
  return bytes;
}

/**
 * Returns cached 4-channel tileable void-and-cluster blue-noise RGBA bytes.
 * @param {number} [size=128]
 * @returns {Uint8Array}
 */
export function getBlueNoiseData(size = 128) {
  const cached = blueNoiseDataCache.get(size);
  if (cached) return cached;

  const total = size * size;
  const ch0 = generateBlueNoiseChannel(size, 0x13579bdf);
  const ch1 = generateBlueNoiseChannel(size, 0x2468ace0);
  const ch2 = generateBlueNoiseChannel(size, 0x9e3779b9);
  const ch3 = generateBlueNoiseChannel(size, 0xdeadbeef);

  const rgba = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const base = i * 4;
    rgba[base + 0] = ch0[i];
    rgba[base + 1] = ch1[i];
    rgba[base + 2] = ch2[i];
    rgba[base + 3] = ch3[i];
  }

  blueNoiseDataCache.set(size, rgba);
  return rgba;
}

/**
 * Uploads cached 128x128 RGBA8 blue-noise texture to WebGL2 (REPEAT, NEAREST).
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size=128]
 * @returns {WebGLTexture}
 */
export function createBlueNoiseLUTWebGL(gl, size = 128) {
  const rgba = getBlueNoiseData(size);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

  return texture;
}

/**
 * Uploads cached 128x128 rgba8unorm blue-noise texture to WebGPU.
 * @param {GPUDevice} device
 * @param {number} [size=128]
 * @returns {GPUTexture}
 */
export function createBlueNoiseLUTWebGPU(device, size = 128) {
  const rgba = getBlueNoiseData(size);

  const texture = device.createTexture({
    label: 'blue-noise-lut',
    size: [size, size, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: size * 4, rowsPerImage: size },
    [size, size, 1]
  );

  return texture;
}

/**
 * Smart wrapper accepting either a WebGL2RenderingContext or WebGPU GPUDevice.
 */
export function createBlueNoiseLUT(ctxOrDevice, size = 128) {
  return isWebGPUDevice(ctxOrDevice)
    ? createBlueNoiseLUTWebGPU(ctxOrDevice, size)
    : createBlueNoiseLUTWebGL(ctxOrDevice, size);
}
