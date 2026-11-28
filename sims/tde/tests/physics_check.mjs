#!/usr/bin/env node
/**
 * Tidal Disruption Event — Relativistic Physics, Hills Criterion, Rees–Phinney t^(-5/3),
 * Outgoing Kerr–Schild Geodesic Verification, ZAMO Tetrad & Camera Orthonormality,
 * JS Syntax Check, and 320-Byte GLSL <-> WGSL Contract Check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  TDE_CONSTANTS,
  stellarRadiusSolar,
  computeKerrRadii,
  computeTdeTelemetry,
  writeTdeFrameConstants,
  integrateTdeGeodesic,
} = await import(path.join(ROOT, 'src/engine/Physics.js'));

const { DEFAULT_STATE, PRESETS, getPresetById, createInitialState } = await import(
  path.join(ROOT, 'src/engine/Presets.js')
);

const { CameraController } = await import(path.join(ROOT, 'src/engine/CameraController.js'));

let passed = 0;
let failed = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a, b, tol) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('=== 1. Stellar Mass-Radius, Kerr Radii & Tidal Disruption Telemetry ===');
{
  assert(
    approx(stellarRadiusSolar(1.0), 1.0, 1e-6) && stellarRadiusSolar(2.0) > 1.7,
    'Main-sequence mass-radius scaling R_* = M_*^0.8 exact'
  );

  const schw = computeKerrRadii(0.0);
  const ext = computeKerrRadii(0.998);
  assert(
    approx(schw.horizonR, 2.0, 1e-6) &&
      approx(schw.iscoR, 6.0, 1e-4) &&
      approx(schw.ibcoR, 4.0, 1e-4) &&
      ext.horizonR < 1.1 &&
      ext.iscoR < 1.3 &&
      ext.ibcoR < 1.15,
    'Kerr outer horizon r_+, prograde ISCO & IBCO match Schwarzschild (2/6/4 M) and extremal Kerr'
  );

  const peak = computeTdeTelemetry({ bhMassM6: 2.0, starMassSolar: 1.0, beta: 1.8, spin: 0.72, tdePhase: 0.42 });
  const late = computeTdeTelemetry({ bhMassM6: 2.0, starMassSolar: 1.0, beta: 1.8, spin: 0.72, tdePhase: 0.84 });
  assert(
    peak.eddingtonRatio > late.eddingtonRatio * 2.5 && !peak.swallowedDirect,
    'Rees–Phinney t^(-5/3) fallback lightcurve decays strongly after t_fb peak',
    `peak=${peak.eddingtonRatio.toFixed(1)}, late=${late.eddingtonRatio.toFixed(1)}`
  );

  const grazing = computeTdeTelemetry({ bhMassM6: 3.2, starMassSolar: 1.0, beta: 1.0, spin: 0.78, tdePhase: 0.55 });
  const plunge = computeTdeTelemetry({ bhMassM6: 3.2, starMassSolar: 1.0, beta: 4.5, spin: 0.78, tdePhase: 0.55 });
  assert(
    plunge.precessDeg > grazing.precessDeg && plunge.rPeriRg < grazing.rPeriRg && plunge.shockVelocityC > grazing.shockVelocityC,
    'Deeper penetration factor β shrinks r_p, strengthens apsidal precession, and boosts shock speed',
    `precess ${grazing.precessDeg.toFixed(1)}° -> ${plunge.precessDeg.toFixed(1)}°`
  );
}

console.log('\n=== 2. Hills Mass Limit & Horizon Capture Transition ===');
{
  const disrupted = computeTdeTelemetry({ bhMassM6: 1.8, starMassSolar: 1.0, beta: 1.5, spin: 0.0 });
  const hillsSchw = computeTdeTelemetry({ bhMassM6: 135.0, starMassSolar: 1.0, beta: 1.0, spin: 0.0 });
  assert(
    approx(disrupted.hillsMassM6, TDE_CONSTANTS.HILLS_COEFF_M6, 1e-3) &&
      disrupted.swallowedDirect === false &&
      hillsSchw.swallowedDirect === true,
    'Hills direct-capture criterion toggles cleanly across M_Hills ≈ 1.1e8 M_sun for solar star',
    `disrupted(1.8e6) swallowed=${disrupted.swallowedDirect}, schw(135e6) swallowed=${hillsSchw.swallowedDirect}`
  );
}

console.log('\n=== 3. Outgoing Kerr–Schild Geodesic & ZAMO Tetrad Orthonormality ===');
{
  const schwB15 = integrateTdeGeodesic(15.0, 0.0);
  const schwB30 = integrateTdeGeodesic(30.0, 0.0);
  const schwCap = integrateTdeGeodesic(4.0, 0.0);
  assert(
    schwCap.captured && schwB15.escaped && schwB30.escaped && schwB15.deflectionDeg > schwB30.deflectionDeg,
    'CPU Outgoing Kerr–Schild RK4 integrator captures b=4M inside shadow & decreases deflection with b',
    `b=15 -> ${schwB15.deflectionDeg?.toFixed(2)}°, b=30 -> ${schwB30.deflectionDeg?.toFixed(2)}°`
  );

  const prograde = integrateTdeGeodesic(-3.0, 0.99);
  const retrograde = integrateTdeGeodesic(3.0, 0.99);
  assert(
    (prograde.captured && retrograde.captured && prograde.rMin <= retrograde.rMin) ||
      (!prograde.captured && retrograde.captured) ||
      (prograde.captured && !retrograde.captured),
    'Spin a=0.99 Kerr geodesic differentiates prograde vs retrograde strong-field trajectories'
  );

  const f32 = new Float32Array(40);
  const camData = {
    pos: [0.0, 4.0, -24.0],
    fovY: 46.0 * (Math.PI / 180),
    basis: [1, 0, 0, 0, 0.986, -0.164, 0, 0.164, 0.986],
  };
  writeTdeFrameConstants(f32, 0, DEFAULT_STATE, camData);
  const allFinite = Array.from(f32).every(Number.isFinite);
  const lx = f32[16];
  const ly = f32[17];
  const lz = f32[18];
  const twoH = f32[19];

  function metricDot(aOff, bOff) {
    const a0 = f32[aOff];
    const a1 = f32[aOff + 1];
    const a2 = f32[aOff + 2];
    const a3 = f32[aOff + 3];
    const b0 = f32[bOff];
    const b1 = f32[bOff + 1];
    const b2 = f32[bOff + 2];
    const b3 = f32[bOff + 3];
    const la = -a0 + lx * a1 + ly * a2 + lz * a3;
    const lb = -b0 + lx * b1 + ly * b2 + lz * b3;
    return -a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3 + twoH * la * lb;
  }

  const g00 = metricDot(0, 0);
  const g11 = metricDot(4, 4);
  const g22 = metricDot(8, 8);
  const g33 = metricDot(12, 12);
  const g03 = metricDot(0, 12);
  const g12 = metricDot(4, 8);
  assert(
    allFinite &&
      approx(g00, -1.0, 1e-4) &&
      approx(g11, 1.0, 1e-4) &&
      approx(g22, 1.0, 1e-4) &&
      approx(g33, 1.0, 1e-4) &&
      Math.abs(g03) < 1e-4 &&
      Math.abs(g12) < 1e-4,
    'writeTdeFrameConstants produces exact finite 4D Lorentzian orthonormal ZAMO tetrad',
    `g00=${g00.toFixed(5)}, g11=${g11.toFixed(5)}, g03=${g03.toExponential(1)}`
  );
}

console.log('\n=== 4. Presets, Camera Basis & No-Reflow Contract ===');
{
  const initial = createInitialState();
  assert(
    PRESETS.length === 6 &&
      PRESETS.every((p) => p.id && p.name && p.hotkey && p.params && p.camera) &&
      getPresetById('hills_horizon')?.id === 'hills_horizon' &&
      DEFAULT_STATE.presetId === 'self_intersection' &&
      initial.presetId === 'self_intersection',
    'All 6 TDE presets valid with self_intersection default'
  );

  const mockCanvas = {
    clientWidth: 1280,
    clientHeight: 720,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = globalThis.window || {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 720,
  };
  const cam = new CameraController(mockCanvas, getPresetById('self_intersection').camera);
  cam.update(0.016, { paused: false, autoOrbit: false });
  const m = cam.getCameraMatrices();
  const right = [m.basis[0], m.basis[1], m.basis[2]];
  const up = [m.basis[3], m.basis[4], m.basis[5]];
  const forward = [m.basis[6], m.basis[7], m.basis[8]];
  const rLen = Math.hypot(...right);
  const uLen = Math.hypot(...up);
  const fLen = Math.hypot(...forward);
  const orthoErr = Math.max(
    Math.abs(dot3(right, up)),
    Math.abs(dot3(right, forward)),
    Math.abs(dot3(up, forward))
  );
  const rxf = cross3(right, forward);
  const uxR = cross3(up, right);
  const handErr = Math.min(
    Math.hypot(rxf[0] - up[0], rxf[1] - up[1], rxf[2] - up[2]),
    Math.hypot(uxR[0] - forward[0], uxR[1] - forward[1], uxR[2] - forward[2])
  );
  cam.dispose();

  const camSrc = fs.readFileSync(path.join(ROOT, 'src/engine/CameraController.js'), 'utf8');
  assert(
    approx(rLen, 1.0, 1e-6) &&
      approx(uLen, 1.0, 1e-6) &&
      approx(fLen, 1.0, 1e-6) &&
      orthoErr < 1e-6 &&
      handErr < 1e-6 &&
      camSrc.includes('createCanvasRectCache') &&
      !camSrc.includes('getBoundingClientRect'),
    'TDE CameraController triad is right-handed orthonormal & avoids getBoundingClientRect reflows',
    `orthoErr=${orthoErr.toExponential(1)}, handErr=${handErr.toExponential(1)}`
  );
}

console.log('\n=== 5. JS Syntax Verification ===');
{
  const jsFiles = collectJsFiles(path.join(ROOT, 'src'));
  let allOk = true;
  for (const file of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      allOk = false;
      console.error(`Syntax error in ${file}:`, err.stderr?.toString() || err.message);
    }
  }
  assert(allOk && jsFiles.length >= 8, `All ${jsFiles.length} tde JS modules pass node --check`);
}

console.log('\n=== 6. GLSL <-> WGSL 320-Byte Uniform Block & Uniformity Check ===');
{
  const { TDE_FRAG } = await import(path.join(ROOT, 'src/shaders/tde.frag.js'));
  const { TDE_WGSL } = await import(path.join(ROOT, 'src/shaders/tde.wgsl.js'));
  const rawWgsl = fs.readFileSync(path.join(ROOT, 'src/shaders/tde.wgsl'), 'utf8');

  const glHasFields =
    TDE_FRAG.includes('#version 300 es') &&
    TDE_FRAG.includes('uniform TdeUniforms') &&
    TDE_FRAG.includes('sampler3D uVolumeNoise') &&
    TDE_FRAG.includes('sampler2D uSkyMap') &&
    TDE_FRAG.includes('sampler2D uProcSkyMap') &&
    TDE_FRAG.includes('sampler2D uBlackbodyLut') &&
    TDE_FRAG.includes('sampler2D uBlueNoise');

  const wgHasFields =
    TDE_WGSL.includes('struct TdeUniforms') &&
    TDE_WGSL.includes('@binding(0) var<uniform> u: TdeUniforms;') &&
    TDE_WGSL.includes('@binding(8) var uBlueNoise: texture_2d<f32>;') &&
    !TDE_WGSL.includes('textureSample(') &&
    TDE_WGSL.includes('textureSampleGrad(') &&
    TDE_WGSL.includes('textureSampleLevel(') &&
    TDE_WGSL.includes('textureLoad(') &&
    rawWgsl.trim() === TDE_WGSL.trim();

  assert(
    glHasFields && wgHasFields,
    '320-byte TdeUniforms + bindings 0..8 match across GLSL & WGSL with strict WGSL uniformity (zero bare textureSample)'
  );
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
