#!/usr/bin/env node
/**
 * Reproducible App Icon Asset Generator (`scripts/generate-icons.mjs`).
 *
 * Rasterizes the canonical vector icon `shared/assets/app-icon.svg` into:
 *  - `shared/assets/app-icon-256.png`   (256x256 RGBA PNG for runtime window icon)
 *  - `favicon.ico`                      (16, 32, 48 multi-size browser default ICO)
 *  - `desktop/assets/app-icon.ico`      (16, 24, 32, 48, 64, 128, 256 Windows PE ICO)
 *  - `desktop/assets/AppIcon.icns`      (macOS Retina ICNS bundle icon)
 *
 * Requires `inkscape` (or `magick`) in PATH.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_SVG = path.join(REPO_ROOT, 'shared/assets/app-icon.svg');

function hasCmd(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function renderSvgToPng(svgPath, size, outPng) {
  if (hasCmd('inkscape')) {
    execFileSync(
      'inkscape',
      [
        svgPath,
        '--export-type=png',
        `--export-width=${size}`,
        `--export-height=${size}`,
        `--export-filename=${outPng}`,
      ],
      { stdio: 'pipe' }
    );
    return;
  }
  if (hasCmd('magick')) {
    execFileSync(
      'magick',
      ['-background', 'none', '-density', '384', svgPath, '-resize', `${size}x${size}`, outPng],
      { stdio: 'pipe' }
    );
    return;
  }
  throw new Error('Neither inkscape nor magick was found in PATH to rasterize app-icon.svg');
}

function writeIcoFromPngs(pngMap, sizes, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Prefer ImageMagick for maximal compatibility with Windows resource compilers (BMP + PNG entries).
  if (hasCmd('magick')) {
    const inputs = sizes.map((s) => pngMap.get(s));
    execFileSync('magick', [...inputs, outPath], { stdio: 'pipe' });
    return;
  }

  // Fallback: pure Node PNG-in-ICO writer (supported by all modern browsers and Windows Vista+).
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (ICO)
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const payloads = [];
  let offset = 6 + count * 16;

  for (const size of sizes) {
    const png = fs.readFileSync(pngMap.get(size));
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    payloads.push(png);
    offset += png.length;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([header, ...dirEntries, ...payloads]));
}

function writeIcnsFromPngs(pngMap, outPath) {
  // Apple ICNS container with PNG-compressed icon types (macOS 10.7+).
  const specs = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['icp6', 64],
    ['ic12', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256],
    ['ic09', 512],
    ['ic14', 512],
    ['ic10', 1024],
  ];

  const chunks = [];
  let totalBytes = 8;

  for (const [osType, size] of specs) {
    const png = fs.readFileSync(pngMap.get(size));
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(osType, 0, 4, 'ascii');
    chunkHeader.writeUInt32BE(8 + png.length, 4);
    chunks.push(chunkHeader, png);
    totalBytes += 8 + png.length;
  }

  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalBytes, 4);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([fileHeader, ...chunks]));
}

function main() {
  if (!fs.existsSync(SRC_SVG)) {
    throw new Error(`Missing canonical SVG icon: ${SRC_SVG}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interstellar-icons-'));
  try {
    const neededSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
    const pngMap = new Map();

    for (const size of neededSizes) {
      const outPng = path.join(tmpDir, `icon_${size}.png`);
      renderSvgToPng(SRC_SVG, size, outPng);
      pngMap.set(size, outPng);
    }

    const sharedPng256 = path.join(REPO_ROOT, 'shared/assets/app-icon-256.png');
    fs.copyFileSync(pngMap.get(256), sharedPng256);

    const rootFaviconIco = path.join(REPO_ROOT, 'favicon.ico');
    writeIcoFromPngs(pngMap, [16, 32, 48], rootFaviconIco);

    const desktopIco = path.join(REPO_ROOT, 'desktop/assets/app-icon.ico');
    writeIcoFromPngs(pngMap, [16, 24, 32, 48, 64, 128, 256], desktopIco);

    const desktopIcns = path.join(REPO_ROOT, 'desktop/assets/AppIcon.icns');
    writeIcnsFromPngs(pngMap, desktopIcns);

    const outputs = [sharedPng256, rootFaviconIco, desktopIco, desktopIcns];
    for (const f of outputs) {
      const rel = path.relative(REPO_ROOT, f);
      const kb = (fs.statSync(f).size / 1024).toFixed(1);
      console.log(`  [ICON] ${rel} (${kb} KB)`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
