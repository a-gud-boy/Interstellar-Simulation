#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/binary',
  debugHandle: '__BINARY_BH__',
  profilePrefix: 'binary-bh-firefox-qa-',
  timeoutMs: 45000,
  requireTidalComputed: true,
  cameraKind: 'radius',
  switchCamera: { radius: 28.0, elevationDeg: 18.0, azimuthDeg: 28.0, rollDeg: -2.0 },
  roundTripPreset: 'tidal_bridges',
  roundTripPngName: 'firefox_webgpu_after_switch.png',
});
