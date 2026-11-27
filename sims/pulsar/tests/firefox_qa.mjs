#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/pulsar',
  debugHandle: '__PULSAR__',
  profilePrefix: 'pulsar-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'pivotDistance',
  switchCamera: { distance: 7.5, pivot: [0.2, -0.1, 0.2], azimuthDeg: 52.0, elevationDeg: 24.0, rollDeg: -5.0, fovDeg: 46.0 },
  roundTripPreset: 'magnetar',
  roundTripPngName: 'firefox_magnetar_webgpu.png',
  roundTripLabel: 'Firefox live round-trip switch WebGL2 -> WebGPU (Magnetar preset) succeeded cleanly',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 10, extra: 12 },
  extraPresetStep: {
    stepKey: 'torusWebGPU',
    presetId: 'pwn_torus',
    pngName: 'firefox_pwn_torus_webgpu.png',
    label: 'Firefox Torus & Jet PWN preset capture on WebGPU produced valid PNG',
  },
});
