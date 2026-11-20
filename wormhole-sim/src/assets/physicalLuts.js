/**
 * High-frequency 4-channel toroidal void-and-cluster blue-noise dithering LUT
 * for both WebGL2 and WebGPU, with module-level CPU data caching for instant
 * live backend switching.
 */

const blueNoiseDataCache = new Map();

function isWebGPUDevice(target) {
  return Boolean(target && typeof target.createTexture === 'function' && target.queue);
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
 * Uploads cached RGBA8 blue-noise texture to WebGL2 (REPEAT, NEAREST).
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
 * Uploads cached rgba8unorm blue-noise texture to WebGPU.
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
