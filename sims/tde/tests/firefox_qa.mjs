#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/tde',
  debugHandle: '__TDE__',
  profilePrefix: 'tde-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'orbit',
  switchCamera: { radius: 26.5, elevationDeg: 28.0, azimuthDeg: 24.0, rollDeg: -4.0, fovDeg: 46.0 },
  roundTripPreset: 'deep_plunge',
  roundTripPngName: 'firefox_deep_plunge_webgpu.png',
  roundTripLabel: 'Firefox live round-trip switch WebGL2 -> WebGPU (Deep Plunge preset) succeeded cleanly',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 10, extra: 12 },
  extraPresetStep: {
    stepKey: 'eddingtonFlareWebGPU',
    presetId: 'eddington_flare',
    preState: {},
    pngName: 'firefox_eddington_flare_webgpu.png',
    label: 'Firefox Super-Eddington Flare preset capture on WebGPU produced valid PNG',
  },
});
