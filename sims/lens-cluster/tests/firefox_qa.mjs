#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/lens-cluster',
  debugHandle: '__LENS_CLUSTER__',
  profilePrefix: 'lens-cluster-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'orbit',
  switchCamera: { radius: 14.5, elevationDeg: 10.0, azimuthDeg: -14.0, rollDeg: 2.0, fovDeg: 40.0 },
  roundTripPreset: 'einstein_cross',
  roundTripPngName: 'firefox_einstein_cross_webgpu.png',
  roundTripLabel: 'Firefox live round-trip switch WebGL2 -> WebGPU (Einstein Cross preset) succeeded cleanly',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 10, extra: 12 },
  extraPresetStep: {
    stepKey: 'causticFermatWebGPU',
    presetId: 'caustic_fermat',
    preState: {},
    pngName: 'firefox_caustic_fermat_webgpu.png',
    label: 'Firefox Caustic & Fermat Bench preset capture on WebGPU produced valid PNG',
  },
});
