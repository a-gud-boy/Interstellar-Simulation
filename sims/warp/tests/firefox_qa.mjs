#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/warp',
  debugHandle: '__WARP_DRIVE__',
  profilePrefix: 'warp-drive-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'radius',
  switchCamera: { radius: 13.5, azimuthDeg: 52.0, elevationDeg: 22.0, rollDeg: -4.0, fovDeg: 50.0 },
  roundTripPreset: 'thin_wall',
  roundTripPngName: 'firefox_webgpu_after_switch.png',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 6, extra: 12 },
  extraPresetStep: {
    stepKey: 'bridgeWebGPU',
    presetId: 'bridge',
    pngName: 'firefox_bridge_webgpu.png',
    label: 'Firefox Bridge View preset capture on WebGPU produced valid PNG',
  },
});
