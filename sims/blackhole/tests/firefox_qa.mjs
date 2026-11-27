#!/usr/bin/env node
/**
 * Gargantua (Unified WebGL2 + WebGPU) — Automated Headed Firefox NVIDIA Wayland QA Suite
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/blackhole',
  debugHandle: '__GARGANTUA__',
  profilePrefix: 'gargantua-firefox-qa-',
  cameraKind: 'radius',
  switchCamera: { radius: 22.0, elevationDeg: 14.5, azimuthDeg: 35.0, rollDeg: -3.0 },
  roundTripPreset: 'gargantua',
}).catch((err) => {
  console.error('FATAL FIREFOX QA ERROR:', err);
  process.exit(1);
});
