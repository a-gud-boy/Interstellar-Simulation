#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimFirefoxQA } from '../../../shared/testing/firefoxQaRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runSimFirefoxQA({
  shotDir: path.join(__dirname, 'screenshots'),
  simDir: 'sims/starflight',
  debugHandle: '__STARFLIGHT__',
  profilePrefix: 'starflight-firefox-qa-',
  timeoutMs: 60000,
  requireVolumeBaked: true,
  cameraKind: 'look',
  switchCamera: { lookYawDeg: 42.0, lookPitchDeg: -14.0, rollDeg: 5.0, fovDeg: 52.0 },
  roundTripPreset: 'cmb_glow',
  roundTripPngName: 'firefox_cmb_glow_webgpu.png',
  roundTripLabel: 'Firefox live round-trip switch WebGL2 -> WebGPU (CMB Glow preset) succeeded cleanly',
  waitSamples: { initial: 6, afterGL: 6, roundTrip: 10, extra: 12 },
  extraPresetStep: {
    stepKey: 'aftRedshiftWebGPU',
    presetId: 'aft_redshift',
    preState: { flightPosZ: 0.0 },
    pngName: 'firefox_aft_redshift_webgpu.png',
    label: 'Firefox Aft Redshift preset capture on WebGPU produced valid PNG',
  },
});
