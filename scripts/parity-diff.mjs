#!/usr/bin/env node
/**
 * parity-diff.mjs — Zero-dependency Cross-Backend Visual Parity Diffing Suite
 * (WebGL2 vs WebGPU, and optionally Native Rust Desktop wgpu `--export-parity`).
 *
 * Exports:
 *  - decodePngRgba(buffer)         Pure-Node PNG parser (zlib inflateSync + filters 0..4)
 *  - computeParityMetrics(a, b, w, h)  { psnr, ssim, mae, rmse, maxDiff }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStaticServer } from '../shared/testing/staticServer.mjs';
import { sleep, launchChromeDualCDP } from '../shared/testing/chromeCdp.mjs';
import { SIMULATORS, resolveSimByAlias } from '../shared/simRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-Node PNG decoder supporting 8-bit RGB (colorType 2) and RGBA (colorType 6),
 * plus grayscale (0) / GA (4), across all PNG scanline filter types (0..4).
 * @param {Buffer|Uint8Array} inputBuf
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function decodePngRgba(inputBuf) {
  const buf = Buffer.isBuffer(inputBuf) ? inputBuf : Buffer.from(inputBuf);
  if (
    buf.length < 33 ||
    buf[0] !== 137 ||
    buf[1] !== 80 ||
    buf[2] !== 78 ||
    buf[3] !== 71 ||
    buf[4] !== 13 ||
    buf[5] !== 10 ||
    buf[6] !== 26 ||
    buf[7] !== 10
  ) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `Unsupported PNG layout (w=${width}, h=${height}, bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`
    );
  }

  let bpp = 4;
  if (colorType === 0) bpp = 1;
  else if (colorType === 2) bpp = 3;
  else if (colorType === 4) bpp = 2;
  else if (colorType === 6) bpp = 4;
  else throw new Error(`Unsupported PNG colorType=${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const unfilt = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const inRow = y * (stride + 1);
    const filter = raw[inRow];
    const outRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const xVal = raw[inRow + 1 + x];
      const a = x >= bpp ? unfilt[outRow + x - bpp] : 0;
      const b = y > 0 ? unfilt[prevRow + x] : 0;
      const c = y > 0 && x >= bpp ? unfilt[prevRow + x - bpp] : 0;
      let val = xVal;
      if (filter === 1) val = (xVal + a) & 0xff;
      else if (filter === 2) val = (xVal + b) & 0xff;
      else if (filter === 3) val = (xVal + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (xVal + paethPredictor(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`Unknown PNG filter type ${filter}`);
      unfilt[outRow + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (bpp === 4) {
    rgba.set(unfilt);
  } else if (bpp === 3) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      const k = i * 4;
      rgba[k] = unfilt[j];
      rgba[k + 1] = unfilt[j + 1];
      rgba[k + 2] = unfilt[j + 2];
      rgba[k + 3] = 255;
    }
  } else if (bpp === 2) {
    for (let i = 0, j = 0; i < width * height; i++, j += 2) {
      const k = i * 4;
      rgba[k] = unfilt[j];
      rgba[k + 1] = unfilt[j];
      rgba[k + 2] = unfilt[j];
      rgba[k + 3] = unfilt[j + 1];
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      const k = i * 4;
      const g = unfilt[i];
      rgba[k] = g;
      rgba[k + 1] = g;
      rgba[k + 2] = g;
      rgba[k + 3] = 255;
    }
  }

  return { width, height, data: rgba };
}

/**
 * Resizes RGBA buffer using bilinear sampling when two backends differ slightly in pixel size.
 */
function resampleBilinear(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return src;
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const fy = ((y + 0.5) * srcH) / dstH - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < dstW; x++) {
      const fx = ((x + 0.5) * srcW) / dstW - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const di = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v0 = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
        const v1 = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
        out[di + c] = Math.round(v0 * (1 - ty) + v1 * ty);
      }
    }
  }
  return out;
}

/**
 * Computes RGB PSNR (dB), 8x8 windowed luminance SSIM, MAE (0..255), RMSE, and MaxDiff.
 */
export function computeParityMetrics(rgbaA, rgbaB, width, height) {
  const n = width * height;
  if (!n || rgbaA.length < n * 4 || rgbaB.length < n * 4) {
    throw new Error('Invalid image buffers for computeParityMetrics');
  }

  let sse = 0;
  let absSum = 0;
  let maxDiff = 0;
  const lumaA = new Float64Array(n);
  const lumaB = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const dr = rgbaA[k] - rgbaB[k];
    const dg = rgbaA[k + 1] - rgbaB[k + 1];
    const db = rgbaA[k + 2] - rgbaB[k + 2];
    sse += dr * dr + dg * dg + db * db;
    const ar = Math.abs(dr);
    const ag = Math.abs(dg);
    const ab = Math.abs(db);
    absSum += ar + ag + ab;
    if (ar > maxDiff) maxDiff = ar;
    if (ag > maxDiff) maxDiff = ag;
    if (ab > maxDiff) maxDiff = ab;
    lumaA[i] = 0.2126 * rgbaA[k] + 0.7152 * rgbaA[k + 1] + 0.0722 * rgbaA[k + 2];
    lumaB[i] = 0.2126 * rgbaB[k] + 0.7152 * rgbaB[k + 1] + 0.0722 * rgbaB[k + 2];
  }

  const mse = sse / (n * 3);
  const rmse = Math.sqrt(mse);
  const mae = absSum / (n * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);

  // 8x8 block SSIM (Wang et al. 2004 constants for L=255)
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const blockW = 8;
  const step = 4;
  let ssimSum = 0;
  let blocks = 0;

  for (let y = 0; y + blockW <= height; y += step) {
    for (let x = 0; x + blockW <= width; x += step) {
      let sA = 0;
      let sB = 0;
      const bn = blockW * blockW;
      for (let by = 0; by < blockW; by++) {
        const row = (y + by) * width + x;
        for (let bx = 0; bx < blockW; bx++) {
          sA += lumaA[row + bx];
          sB += lumaB[row + bx];
        }
      }
      const muA = sA / bn;
      const muB = sB / bn;
      let vA = 0;
      let vB = 0;
      let cov = 0;
      for (let by = 0; by < blockW; by++) {
        const row = (y + by) * width + x;
        for (let bx = 0; bx < blockW; bx++) {
          const da = lumaA[row + bx] - muA;
          const db = lumaB[row + bx] - muB;
          vA += da * da;
          vB += db * db;
          cov += da * db;
        }
      }
      vA /= bn - 1;
      vB /= bn - 1;
      cov /= bn - 1;
      const num = (2 * muA * muB + C1) * (2 * cov + C2);
      const den = (muA * muA + muB * muB + C1) * (vA + vB + C2);
      ssimSum += den > 0 ? num / den : 1.0;
      blocks++;
    }
  }
  const ssim = blocks > 0 ? ssimSum / blocks : 1.0;

  return {
    psnr: Number.isFinite(psnr) ? Number(psnr.toFixed(2)) : Infinity,
    ssim: Number(ssim.toFixed(4)),
    mae: Number(mae.toFixed(2)),
    rmse: Number(rmse.toFixed(2)),
    maxDiff,
  };
}

function parseCliArgs(argv) {
  const out = {
    sims: ['blackhole', 'lens-cluster', 'tde'],
    width: 960,
    height: 540,
    includeDesktop: false,
    outDir: null,
    psnrMin: 22.0,
    ssimMin: 0.85,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sim' && argv[i + 1]) {
      const raw = argv[++i].trim();
      if (raw === 'all') out.sims = SIMULATORS.map((s) => s.id);
      else out.sims = raw.split(',').map((s) => resolveSimByAlias(s.trim())?.id || s.trim());
    } else if (a === '--width' && argv[i + 1]) out.width = Number(argv[++i]) || 960;
    else if (a === '--height' && argv[i + 1]) out.height = Number(argv[++i]) || 540;
    else if (a === '--include-desktop') out.includeDesktop = true;
    else if (a === '--out' && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
    else if (a === '--psnr-min' && argv[i + 1]) out.psnrMin = Number(argv[++i]) || 22.0;
    else if (a === '--ssim-min' && argv[i + 1]) out.ssimMin = Number(argv[++i]) || 0.85;
  }
  return out;
}

async function captureWebBackendPng(cdp, port, simMeta, backend, outPath) {
  const url = `http://127.0.0.1:${port}/sims/${simMeta.id}/?backend=${backend}`;
  await cdp.send('Page.navigate', { url });

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: `window.${simMeta.debugHandle}?.getDiagnostics?.()`,
      returnByValue: true,
    });
    const d = res.result?.value;
    if (
      d &&
      d.backend === backend &&
      !d.switchingBackend &&
      d.allShadersCompiled === true &&
      d.skyMapLoaded === true &&
      d.volumeBaked === true &&
      (d.samples || 0) >= 1
    ) {
      break;
    }
    await sleep(150);
  }

  const snapRes = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.${simMeta.debugHandle};
      const firstId = api.presets?.[0]?.id;
      if (firstId) api.selectPreset(firstId, true);
      api.setState({ paused: true, autoOrbit: false });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return await api.captureRawPngDataUrl(0);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const dataUrl = snapRes.result?.value;
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error(`Failed capturing raw PNG for ${simMeta.id} on ${backend}`);
  }
  const pngBuf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(outPath, pngBuf);
  return decodePngRgba(pngBuf);
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const ownTmp = !opts.outDir;
  const outDir = opts.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'interstellar-parity-'));
  fs.mkdirSync(outDir, { recursive: true });

  const simMetas = opts.sims
    .map((id) => SIMULATORS.find((s) => s.id === id))
    .filter(Boolean);
  if (simMetas.length === 0) {
    throw new Error('No matching simulators for --sim');
  }

  let desktopAvailable = false;
  if (opts.includeDesktop) {
    const deskDir = path.join(outDir, 'desktop');
    const simList = simMetas.map((s) => s.id).join(',');
    const binRelease = path.join(REPO_ROOT, 'desktop/target/release/interstellar-desktop');
    const binDebug = path.join(REPO_ROOT, 'desktop/target/debug/interstellar-desktop');
    const args = ['--export-parity', deskDir, '--sim', simList, '--width', String(opts.width), '--height', String(opts.height)];
    if (fs.existsSync(binRelease)) {
      execFileSync(binRelease, args, { stdio: 'inherit' });
      desktopAvailable = true;
    } else if (fs.existsSync(binDebug)) {
      execFileSync(binDebug, args, { stdio: 'inherit' });
      desktopAvailable = true;
    } else {
      execFileSync(
        'cargo',
        ['run', '--manifest-path', 'desktop/Cargo.toml', '--', ...args],
        { cwd: REPO_ROOT, stdio: 'inherit' }
      );
      desktopAvailable = true;
    }
  }

  const { server, port } = await startStaticServer({ preferredPort: 8796 });
  const cdp = await launchChromeDualCDP({
    debugPort: 9560 + Math.floor(Math.random() * 200),
    viewportW: opts.width,
    viewportH: opts.height,
    profilePrefix: 'parity-diff-',
  });

  const rows = [];
  let failed = 0;

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const meta of simMetas) {
      const glFile = path.join(outDir, `${meta.id}_webgl2.png`);
      const gpuFile = path.join(outDir, `${meta.id}_webgpu.png`);
      const glImg = await captureWebBackendPng(cdp, port, meta, 'webgl2', glFile);
      const gpuImg = await captureWebBackendPng(cdp, port, meta, 'webgpu', gpuFile);

      const glResamp = resampleBilinear(glImg.data, glImg.width, glImg.height, gpuImg.width, gpuImg.height);
      const glVsGpu = computeParityMetrics(glResamp, gpuImg.data, gpuImg.width, gpuImg.height);
      const glPass =
        (glVsGpu.psnr === Infinity || glVsGpu.psnr >= opts.psnrMin) && glVsGpu.ssim >= opts.ssimMin;
      if (!glPass) failed++;

      let deskVsGpu = null;
      if (desktopAvailable) {
        const deskFile = path.join(outDir, 'desktop', `${meta.id}.png`);
        if (fs.existsSync(deskFile)) {
          const deskImg = decodePngRgba(fs.readFileSync(deskFile));
          const deskResamp = resampleBilinear(
            deskImg.data,
            deskImg.width,
            deskImg.height,
            gpuImg.width,
            gpuImg.height
          );
          deskVsGpu = computeParityMetrics(deskResamp, gpuImg.data, gpuImg.width, gpuImg.height);
          const deskPass =
            (deskVsGpu.psnr === Infinity || deskVsGpu.psnr >= opts.psnrMin) &&
            deskVsGpu.ssim >= opts.ssimMin;
          if (!deskPass) failed++;
        }
      }

      rows.push({
        simId: meta.id,
        resolution: `${gpuImg.width}x${gpuImg.height}`,
        webgl2VsWebgpu: glVsGpu,
        ...(deskVsGpu ? { desktopVsWebgpu: deskVsGpu } : {}),
        pass: glPass && (!deskVsGpu || (deskVsGpu.psnr >= opts.psnrMin && deskVsGpu.ssim >= opts.ssimMin)),
      });
    }

    console.log('\n=== CROSS-BACKEND VISUAL PARITY REPORT ===');
    for (const r of rows) {
      const w = r.webgl2VsWebgpu;
      const d = r.desktopVsWebgpu
        ? ` | Desktop vs WebGPU: PSNR=${r.desktopVsWebgpu.psnr}dB SSIM=${r.desktopVsWebgpu.ssim} MAE=${r.desktopVsWebgpu.mae}`
        : '';
      console.log(
        `  [${r.pass ? 'PASS' : 'FAIL'}] ${r.simId.padEnd(13)} (${r.resolution}) WebGL2 vs WebGPU: PSNR=${w.psnr}dB SSIM=${w.ssim} MAE=${w.mae}${d}`
      );
    }

    if (!ownTmp) {
      fs.writeFileSync(path.join(outDir, 'parity_report.json'), JSON.stringify({ rows }, null, 2));
    }
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await cdp.close();
    server.close();
    if (ownTmp) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('PARITY DIFF ERROR:', err);
    process.exit(1);
  });
}
