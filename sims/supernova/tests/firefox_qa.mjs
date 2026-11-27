#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/supernova',
  debugHandle: '__SUPERNOVA__',
  profilePrefix: 'supernova-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'pivotDistance',
  switchCamera: { distance: 12.0, pivot: [0.5, -0.3, 0.2], azimuthDeg: 52.0, elevationDeg: 24.0, rollDeg: -5.0 },
  roundTripPreset: 'crab_shell',
  roundTripPngName: 'firefox_webgpu_after_switch.png',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 10, extra: 12 },
  extraPresetStep: {
    stepKey: 'flythroughWebGPU',
    presetId: 'flythrough',
    pngName: 'firefox_flythrough_webgpu.png',
    label: 'Firefox Deep Interior Flythrough preset capture on WebGPU produced valid PNG',
  },
});
