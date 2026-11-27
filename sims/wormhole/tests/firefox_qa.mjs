#!/usr/bin/env node
/**
 * Wormhole Simulator (Unified WebGL2 + WebGPU) — Automated Headed Firefox NVIDIA Wayland QA Suite
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/wormhole',
  debugHandle: '__WORMHOLE__',
  profilePrefix: 'wormhole-firefox-qa-',
  banner: '=== AUTOMATED WORMHOLE HEADED FIREFOX NVIDIA QA ASSERTIONS ===',
  requireSharedTextureWord: true,
  cameraKind: 'wormhole',
  switchCamera: { l: 12.0, elevationDeg: 10.5, azimuthDeg: 25.0, lookYawDeg: 0.0, lookPitchDeg: 0.0, rollDeg: -2.5 },
  secondSwitchCamera: { l: 11.0, elevationDeg: 8.5, azimuthDeg: 18.0, lookYawDeg: 0.0, lookPitchDeg: 0.0, rollDeg: -3.0 },
  roundTripPreset: 'interstellar',
}).catch((err) => {
  console.error('FATAL FIREFOX QA ERROR:', err);
  process.exit(1);
});
