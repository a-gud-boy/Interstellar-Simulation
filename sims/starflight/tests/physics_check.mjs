#!/usr/bin/env node
/**
 * Relativistic Starflight Simulator — Exact SR Aberration, Doppler/CMB Scaling,
 * 1g Rocket & Brachistochrone Equations, Camera Basis & Clamps, JS Syntax,
 * and 176-Byte GLSL/WGSL Contract Verification Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const physicsMod = await import(path.join(ROOT, 'src/engine/Physics.js'));
const {
  STARFLIGHT_CONSTANTS,
  rapidityFromBeta,
  kinematicsFromRapidity,
  aberrateShipToRest,
  aberrateRestToShip,
  computeConstantAccelAtProperTime,
  computeBrachistochroneState,
  computeStarflightTelemetry,
} = physicsMod;

const {
  DEFAULT_STATE,
  PRESETS,
  getPresetById,
  createInitialState,
} = await import(path.join(ROOT, 'src/engine/Presets.js'));

const { StarflightCamera } = await import(path.join(ROOT, 'src/engine/CameraController.js'));

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

function norm3(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function getCamMatrices(cam) {
  if (typeof cam.getMatrices === 'function') return cam.getMatrices();
  if (typeof cam.getCameraMatrices === 'function') return cam.getCameraMatrices();
  throw new Error('StarflightCamera exposes neither getMatrices() nor getCameraMatrices()');
}

function applyCamPreset(cam, presetCam) {
  if (typeof cam.applyPreset === 'function') return cam.applyPreset(presetCam, 0);
  if (typeof cam.flyTo === 'function') return cam.flyTo(presetCam, 0);
  if (typeof cam.setImmediate === 'function') return cam.setImmediate(presetCam);
  throw new Error('StarflightCamera exposes neither applyPreset(), flyTo(), nor setImmediate()');
}

function checkOrthonormal(mat, label) {
  const { pos, right, up, forward, basis, fovY } = mat;
  const allVals = [...pos, ...right, ...up, ...forward, ...(basis || []), fovY];
  const allFinite = allVals.every(Number.isFinite);

  const rLen = Math.hypot(...right);
  const uLen = Math.hypot(...up);
  const fLen = Math.hypot(...forward);
  const ru = Math.abs(dot3(right, up));
  const rf = Math.abs(dot3(right, forward));
  const uf = Math.abs(dot3(up, forward));

  const rxF = cross3(right, forward);
  const handErr = Math.hypot(rxF[0] - up[0], rxF[1] - up[1], rxF[2] - up[2]);

  let basisErr = 0;
  if (basis && basis.length >= 9) {
    basisErr = Math.max(
      Math.abs(basis[0] - right[0]), Math.abs(basis[1] - right[1]), Math.abs(basis[2] - right[2]),
      Math.abs(basis[3] - up[0]), Math.abs(basis[4] - up[1]), Math.abs(basis[5] - up[2]),
      Math.abs(basis[6] - forward[0]), Math.abs(basis[7] - forward[1]), Math.abs(basis[8] - forward[2])
    );
  }

  const ok =
    allFinite &&
    approx(rLen, 1.0, 1e-6) &&
    approx(uLen, 1.0, 1e-6) &&
    approx(fLen, 1.0, 1e-6) &&
    ru < 1e-6 &&
    rf < 1e-6 &&
    uf < 1e-6 &&
    handErr < 1e-6 &&
    basisErr < 1e-6;

  assert(
    ok,
    label,
    `normErr=${Math.max(Math.abs(rLen - 1), Math.abs(uLen - 1), Math.abs(fLen - 1)).toExponential(1)}, orthoErr=${Math.max(ru, rf, uf).toExponential(1)}, handErr=${handErr.toExponential(1)}`
  );
}

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

console.log('\n=== 1. Special Relativity Aberration, Cancellation-Free Algebra & Round-Trip ===');
{
  const etas = [0.0, 0.549306, 1.472219, 2.993223, 4.951744, 7.0, 7.6];
  const dirs = [
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
    [1e-4, -2e-4, 1.0],
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [-0.35, 0.48, 0.8],
    [0.25, -0.4, -0.88],
  ];

  let maxNormErr = 0;
  let maxRoundTripErr = 0;
  let maxDopplerInvErr = 0;

  for (const eta of etas) {
    for (const flightDir of [1, -1]) {
      for (const rawDir of dirs) {
        const uDir = norm3(rawDir);
        const toRest = aberrateShipToRest(uDir, eta, flightDir);
        const backToShip = aberrateRestToShip(toRest.dirRest, eta, flightDir);

        const normRestErr = Math.abs(Math.hypot(...toRest.dirRest) - 1.0);
        const normShipErr = Math.abs(Math.hypot(...backToShip.dirShip) - 1.0);
        const rtErr = Math.hypot(
          backToShip.dirShip[0] - uDir[0],
          backToShip.dirShip[1] - uDir[1],
          backToShip.dirShip[2] - uDir[2]
        );
        const rev = aberrateRestToShip(uDir, eta, flightDir);
        const revBack = aberrateShipToRest(rev.dirShip, eta, flightDir);
        const revRtErr = Math.hypot(
          revBack.dirRest[0] - uDir[0],
          revBack.dirRest[1] - uDir[1],
          revBack.dirRest[2] - uDir[2]
        );
        const dErr = Math.abs(toRest.doppler - backToShip.doppler) / Math.max(toRest.doppler, 1e-12);
        const revDErr = Math.abs(rev.doppler - revBack.doppler) / Math.max(rev.doppler, 1e-12);

        maxNormErr = Math.max(maxNormErr, normRestErr, normShipErr);
        maxRoundTripErr = Math.max(maxRoundTripErr, rtErr, revRtErr);
        maxDopplerInvErr = Math.max(maxDopplerInvErr, dErr, revDErr);
      }
    }
  }

  assert(
    maxNormErr < 1e-12 && maxRoundTripErr < 1e-12 && maxDopplerInvErr < 1e-11,
    'aberrateShipToRest <-> aberrateRestToShip round-trips & unit norms hold across eta in [0, 7.6]',
    `maxNormErr=${maxNormErr.toExponential(2)}, maxRoundTripErr=${maxRoundTripErr.toExponential(2)}, maxDopplerInvErr=${maxDopplerInvErr.toExponential(2)}`
  );

  // Cancellation-free 1 - beta at gamma ~ 1000 (eta = 7.6)
  const kin76 = kinematicsFromRapidity(7.6);
  const exactOneMinusBeta = 1.0 / (kin76.gamma * (kin76.gamma + kin76.gammaBeta));
  const relOneMinusErr = Math.abs(kin76.oneMinusBeta - exactOneMinusBeta) / exactOneMinusBeta;
  assert(
    kin76.gamma > 990 &&
      kin76.oneMinusBeta > 0 &&
      relOneMinusErr < 1e-14,
    'Cancellation-free oneMinusBeta remains exact at gamma ~ 1000 (eta = 7.6)',
    `gamma=${kin76.gamma.toFixed(2)}, 1-beta=${kin76.oneMinusBeta.toExponential(8)}, relErr=${relOneMinusErr.toExponential(2)}`
  );

  const betas = [0.0, 0.5, 0.9, 0.995, 0.9999];
  const betaRoundErr = Math.max(...betas.map((b) => Math.abs(Math.tanh(rapidityFromBeta(b)) - b)));
  assert(
    betaRoundErr < 1e-12,
    'rapidityFromBeta(beta) inverts tanh(eta) accurately across [0, 0.9999]',
    `maxErr=${betaRoundErr.toExponential(2)}`
  );
}

console.log('\n=== 2. Doppler Shifts, Zero-Shift Cone, Terrell Rotation & CMB Temperature ===');
{
  const testEtas = [0.549306, 1.472219, 2.993223, 4.951744, 7.0, 7.6];
  let dopplerOk = true;
  let zeroShiftMaxErr = 0;
  let terrellMaxErr = 0;
  let cmbMaxErr = 0;

  for (const eta of testEtas) {
    const k = kinematicsFromRapidity(eta);
    const expectedFwd = Math.exp(eta);
    const expectedAft = Math.exp(-eta);
    const fwdRay = aberrateShipToRest([0, 0, 1], eta, 1);
    const aftRay = aberrateShipToRest([0, 0, -1], eta, 1);

    if (
      Math.abs(k.dopplerFwd - expectedFwd) / expectedFwd > 1e-12 ||
      Math.abs(k.dopplerAft - expectedAft) / expectedAft > 1e-12 ||
      Math.abs(k.dopplerFwd * k.dopplerAft - 1.0) > 1e-12 ||
      Math.abs(fwdRay.doppler - expectedFwd) / expectedFwd > 1e-11 ||
      Math.abs(aftRay.doppler - expectedAft) / expectedAft > 1e-11
    ) {
      dopplerOk = false;
    }

    const expectedCos0 = Math.tanh(0.5 * eta);
    const sin0 = Math.sqrt(Math.max(0.0, 1.0 - expectedCos0 * expectedCos0));
    const zeroRay = aberrateShipToRest([sin0, 0.0, expectedCos0], eta, 1);
    zeroShiftMaxErr = Math.max(
      zeroShiftMaxErr,
      Math.abs(k.zeroShiftCosThetaPrime - expectedCos0),
      Math.abs(zeroRay.doppler - 1.0)
    );

    const expectedTerrell = Math.asin(k.beta) * (180.0 / Math.PI);
    terrellMaxErr = Math.max(terrellMaxErr, Math.abs(k.terrellRotationDeg - expectedTerrell));

    const expectedCmb = STARFLIGHT_CONSTANTS.T_CMB_K * expectedFwd;
    cmbMaxErr = Math.max(cmbMaxErr, Math.abs(k.cmbPeakTempK - expectedCmb) / expectedCmb);
  }

  assert(dopplerOk, 'Doppler D_fwd = exp(eta), D_aft = exp(-eta), and D_fwd * D_aft = 1 hold exactly');
  assert(
    zeroShiftMaxErr < 1e-11,
    'Zero-Doppler-shift cone satisfies cos(theta\'_0) = tanh(eta/2) and D = 1',
    `maxErr=${zeroShiftMaxErr.toExponential(2)}`
  );
  assert(
    terrellMaxErr < 1e-12,
    'Penrose-Terrell rotation angle matches asin(beta)',
    `maxErr=${terrellMaxErr.toExponential(2)} deg`
  );

  const kinCmbGlow = kinematicsFromRapidity(4.951744);
  const kin70 = kinematicsFromRapidity(7.0);
  const kin76 = kinematicsFromRapidity(7.6);
  assert(
    cmbMaxErr < 1e-12 &&
      kinCmbGlow.cmbPeakTempK > 380 && kinCmbGlow.cmbPeakTempK < 395 &&
      kin70.cmbPeakTempK > 2800 && kin70.cmbPeakTempK < 3100 &&
      kin76.cmbPeakTempK > 5000,
    'CMB forward temperature 2.7255 * exp(eta) scales from 385 K (0.9999c) to > 5000 K (D_fwd ~ 2000)',
    `relErr=${cmbMaxErr.toExponential(2)}, T(0.9999c)=${kinCmbGlow.cmbPeakTempK.toFixed(1)}K, T(eta=7.0)=${kin70.cmbPeakTempK.toFixed(1)}K, T(eta=7.6)=${kin76.cmbPeakTempK.toFixed(1)}K`
  );
}

console.log('\n=== 3. Constant 1g Rocket Equations & Cyclic Brachistochrone Symmetry ===');
{
  const alpha = STARFLIGHT_CONSTANTS.ACCEL_1G_PER_YR;
  let rocketRelErrMax = 0;
  for (const tau of [0.5, 1.35, 3.2, 5.0]) {
    const r = computeConstantAccelAtProperTime(tau, 1.0);
    const expectedT = Math.sinh(alpha * tau) / alpha;
    const expectedX = (Math.cosh(alpha * tau) - 1.0) / alpha;
    const expectedTau = Math.asinh(alpha * expectedT) / alpha;
    rocketRelErrMax = Math.max(
      rocketRelErrMax,
      Math.abs(r.coordTimeYr - expectedT) / expectedT,
      Math.abs(r.distanceLy - expectedX) / expectedX,
      Math.abs(r.properTimeCheckYr - expectedTau) / tau
    );
  }
  assert(
    rocketRelErrMax < 1e-12,
    '1g rocket equations tau = (c/a)*asinh(a*t/c) and x = (c^2/a)*(gamma - 1) hold exactly',
    `maxRelErr=${rocketRelErrMax.toExponential(2)}`
  );

  const halfTau = 3.2;
  const bZero = computeBrachistochroneState(0.0, 1.0, halfTau);
  const bPeak = computeBrachistochroneState(halfTau, 1.0, halfTau);
  const bEnd = computeBrachistochroneState(2.0 * halfTau, 1.0, halfTau);
  const bThird = computeBrachistochroneState(3.0 * halfTau, 1.0, halfTau);

  let symErrMax = 0;
  let symPhaseOk = true;
  for (const delta of [0.25, 1.1, 2.4]) {
    const ba = computeBrachistochroneState(halfTau - delta, 1.0, halfTau);
    const bd = computeBrachistochroneState(halfTau + delta, 1.0, halfTau);
    symErrMax = Math.max(symErrMax, Math.abs(ba.rapidity - bd.rapidity));
    if (ba.phase !== 'accel' || bd.phase !== 'decel') symPhaseOk = false;
  }

  assert(
    bZero.rapidity === 0 &&
      bZero.coordTimeYr === 0 &&
      bZero.distanceLy === 0 &&
      symErrMax < 1e-12 &&
      symPhaseOk &&
      approx(bEnd.rapidity, 0.0, 1e-12) &&
      approx(bEnd.coordTimeYr, 2.0 * bPeak.coordTimeYr, 1e-10) &&
      approx(bEnd.distanceLy, 2.0 * bPeak.distanceLy, 1e-10) &&
      bThird.coordTimeYr > bEnd.coordTimeYr &&
      bThird.distanceLy > bEnd.distanceLy,
    'Cyclic brachistochrone trajectory is symmetric across turnaround and monotonic in t, x',
    `symErr=${symErrMax.toExponential(2)}, d(2*halfTau)=${bEnd.distanceLy.toFixed(2)} ly, t(2*halfTau)=${bEnd.coordTimeYr.toFixed(2)} yr`
  );

  const telManual = computeStarflightTelemetry({ ...DEFAULT_STATE, flightMode: 0, rapidity: 1.472219, properTimeYr: 2.0 });
  const telRest = computeStarflightTelemetry({ ...DEFAULT_STATE, flightMode: 0, rapidity: 1.472219, aberrationMode: 0 });
  assert(
    approx(telManual.coordTimeYr, 2.0 * Math.cosh(1.472219), 1e-10) &&
      telRest.aberrationStrength === 0 &&
      telRest.effectiveRapidity === 0 &&
      telRest.beta === 0 &&
      telRest.gamma === 1 &&
      telRest.trueBeta > 0.89 &&
      telRest.visualPace > 1.6,
    'computeStarflightTelemetry handles manual cruise and Rest Frame (aberrationMode=0) toggle cleanly'
  );
}

console.log('\n=== 4. Presets, Telemetry & StarflightCamera Orthonormal / Clamp Checks ===');
{
  const expectedOrder = ['sub_rel', 'headlight_90', 'uv_milkyway', 'cmb_glow', 'aft_redshift', 'brachistochrone'];
  const actualOrder = PRESETS.map((p) => p.id);
  const init = createInitialState();

  const boundsOk = PRESETS.every((p) => {
    const pr = p.params;
    const cam = p.camera;
    return (
      pr.rapidity >= 0.0 && pr.rapidity <= 7.65 &&
      pr.properAccelG >= 0.05 && pr.properAccelG <= 20.0 &&
      cam.lookPitchDeg >= -85 && cam.lookPitchDeg <= 85 &&
      cam.rollDeg >= -90 && cam.rollDeg <= 90 &&
      cam.fovDeg >= 8 && cam.fovDeg <= 95
    );
  });

  assert(
    DEFAULT_STATE.presetId === 'headlight_90' &&
      PRESETS.length === 6 &&
      expectedOrder.every((id, idx) => actualOrder[idx] === id && PRESETS[idx].hotkey === String(idx + 1)) &&
      getPresetById('cmb_glow')?.params.rapidity > 4.9 &&
      boundsOk,
    'Presets.js exports DEFAULT_STATE (headlight_90) and all 6 presets in exact order 1..6 with valid bounds',
    `order=[${actualOrder.join(', ')}]`
  );

  let telAllOk = true;
  for (const preset of PRESETS) {
    const tel = computeStarflightTelemetry({ ...init, ...preset.params });
    const vals = [
      tel.rapidity, tel.beta, tel.gamma, tel.gammaBeta, tel.oneMinusBeta,
      tel.dopplerFwd, tel.dopplerAft, tel.zeroShiftAngleDeg, tel.headlightHalfAngleDeg,
      tel.terrellRotationDeg, tel.cmbPeakTempK, tel.coordTimeYr, tel.distanceLy, tel.visualPace,
    ];
    if (!vals.every(Number.isFinite) || tel.beta <= 0 || tel.gamma <= 1.0 || tel.visualPace <= 1.0) {
      telAllOk = false;
    }
  }
  assert(telAllOk, 'computeStarflightTelemetry produces finite relativistic telemetry across all 6 presets');

  const cam = new StarflightCamera(null, PRESETS[1].camera);
  for (const preset of PRESETS) {
    applyCamPreset(cam, preset.camera);
    checkOrthonormal(getCamMatrices(cam), `StarflightCamera orthonormal on preset '${preset.id}'`);
  }

  // +/- 85 deg pitch, roll, FOV clamps, and 180 deg flip
  cam.setState({ lookYawDeg: 45, lookPitchDeg: 110, rollDeg: 130, fovDeg: 140 });
  cam.update(0.05, false);
  const stHi = cam.getState();
  checkOrthonormal(getCamMatrices(cam), 'StarflightCamera orthonormal at +85 deg pitch clamp');

  cam.setState({ lookYawDeg: 180, lookPitchDeg: -110, rollDeg: -130, fovDeg: 2 });
  cam.update(0.05, false);
  const stLo = cam.getState();
  checkOrthonormal(getCamMatrices(cam), 'StarflightCamera orthonormal at -85 deg pitch clamp & 180 deg aft look');

  assert(
    approx(stHi.lookPitchDeg, 85.0, 1e-4) &&
      approx(stLo.lookPitchDeg, -85.0, 1e-4) &&
      approx(stHi.rollDeg, 90.0, 1e-4) &&
      approx(stLo.rollDeg, -90.0, 1e-4) &&
      approx(stHi.fovDeg, 95.0, 1e-4) &&
      approx(stLo.fovDeg, 8.0, 1e-4),
    'StarflightCamera enforces lookPitch in [-85, 85], roll in [-90, 90], fov in [8, 95]'
  );

  cam.setState({ lookYawDeg: 0, lookPitchDeg: 0, rollDeg: 0, fovDeg: 56 });
  cam.flipAftForward(0);
  const stFlipped = cam.getState();
  checkOrthonormal(getCamMatrices(cam), 'StarflightCamera orthonormal after 180 deg flipAftForward()');
  const flipDelta = Math.abs((((stFlipped.lookYawDeg % 360) + 540) % 360) - 180);
  assert(
    approx(flipDelta, 180.0, 1e-4),
    'StarflightCamera flipAftForward(0) rotates lookYawDeg by 180 deg',
    `lookYawDeg=${stFlipped.lookYawDeg.toFixed(2)}`
  );

  cam.dispose?.();
}

console.log('\n=== 5. Syntax, GLSL/WGSL 176-Byte UBO Parity, Uniformity & Asset Contracts ===');
{
  const jsFiles = collectJsFiles(path.join(ROOT, 'src')).sort();
  assert(jsFiles.length >= 9, `Discovered ${jsFiles.length} JS modules under sims/starflight/src/`);
  for (const fullPath of jsFiles) {
    const rel = path.relative(ROOT, fullPath);
    try {
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
      assert(true, `JS syntax OK: ${rel}`);
    } catch (err) {
      assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
    }
  }

  const glslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/starflight.frag.js'), 'utf8');
  const wgslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/starflight.wgsl.js'), 'utf8');
  const glRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGLRenderer.js'), 'utf8');
  const gpuRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const expectedFields = [
    'resolution_time_frame',
    'jitter_fov_prog',
    'camRight_beta',
    'camUp_gamma',
    'camFwd_oneMinusBeta',
    'flightKinematics',
    'spectralParams',
    'foregroundParams',
    'skyParams',
    'qualityParams',
    'extraParams',
  ];

  const glslStructMatch = glslSrc.match(/layout\(std140\)\s+uniform\s+StarflightUniforms\s*\{([\s\S]*?)\}\s*u\s*;/);
  const wgslStructMatch = wgslSrc.match(/struct\s+StarflightUniforms\s*\{([\s\S]*?)\}\s*;/);

  const glslFields = [];
  if (glslStructMatch) {
    for (const line of glslStructMatch[1].split('\n')) {
      const m = line.match(/^\s*vec4\s+([A-Za-z0-9_]+)\s*;/);
      if (m) glslFields.push(m[1]);
    }
  }

  const wgslFields = [];
  if (wgslStructMatch) {
    for (const line of wgslStructMatch[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*vec4<f32>\s*,/);
      if (m) wgslFields.push(m[1]);
    }
  }

  const fieldsEqual =
    glslFields.length === 11 &&
    wgslFields.length === 11 &&
    expectedFields.every((name, idx) => glslFields[idx] === name && wgslFields[idx] === name);
  const expectedBytes = glslFields.length * 16;

  assert(
    fieldsEqual &&
      expectedBytes === 176 &&
      glRendererSrc.includes('Float32Array(44)') &&
      glRendererSrc.includes('176') &&
      glRendererSrc.includes("'StarflightUniforms'") &&
      gpuRendererSrc.includes('new ArrayBuffer(176)') &&
      gpuRendererSrc.includes('176'),
    'GLSL & WGSL StarflightUniforms match byte-for-byte (176 bytes / 11 vec4<f32> fields) and renderer UBO allocations',
    `fields=${glslFields.length}, bytes=${expectedBytes}`
  );

  // Check WGSL @group(0) @binding(0..8) & GLSL texture units 0..4
  const wgslBindings = Array.from(
    wgslSrc.matchAll(/@group\(0\)\s+@binding\((\d+)\)\s+var(?:<uniform>)?\s+([A-Za-z0-9_]+)/g)
  ).map((m) => [Number(m[1]), m[2]]);
  const expectedBindings = [
    [0, 'u'],
    [1, 'uVolumeNoise'],
    [2, 'sVolume'],
    [3, 'uSkyMap'],
    [4, 'uProcSkyMap'],
    [5, 'sSky'],
    [6, 'uBlackbodyLut'],
    [7, 'sLut'],
    [8, 'uBlueNoise'],
  ];
  const bindingsOk =
    wgslBindings.length === expectedBindings.length &&
    expectedBindings.every(([bIdx, bName], i) => wgslBindings[i][0] === bIdx && wgslBindings[i][1] === bName);

  const glslUnitsOk =
    glslSrc.includes('uniform sampler3D uVolumeNoise;') &&
    glslSrc.includes('uniform sampler2D uSkyMap;') &&
    glslSrc.includes('uniform sampler2D uProcSkyMap;') &&
    glslSrc.includes('uniform sampler2D uBlackbodyLut;') &&
    glslSrc.includes('uniform sampler2D uBlueNoise;');

  assert(bindingsOk && glslUnitsOk, 'WGSL @group(0) @binding(0..8) & GLSL texture unit declarations match contract');

  // Static WGSL uniformity safeguard & zero GLSL-isms
  const hasAnyBareTextureSample = /\btextureSample\s*\(/.test(wgslSrc);
  const hasVolSampleLevel = /textureSampleLevel\s*\(\s*uVolumeNoise\b/.test(wgslSrc);
  const hasLutSampleLevel = /textureSampleLevel\s*\(\s*uBlackbodyLut\b/.test(wgslSrc);
  const hasSkySampleGrad =
    /textureSampleGrad\s*\(\s*uSkyMap\b/.test(wgslSrc) &&
    /textureSampleGrad\s*\(\s*uProcSkyMap\b/.test(wgslSrc);
  const hasBlueNoiseLoad = /textureLoad\s*\(\s*uBlueNoise\b/.test(wgslSrc);
  const hasGlslLod =
    /textureLod\s*\(\s*uVolumeNoise\b/.test(glslSrc) &&
    /textureLod\s*\(\s*uBlackbodyLut\b/.test(glslSrc);
  const hasGlslGrad =
    /textureGrad\s*\(\s*uSkyMap\b/.test(glslSrc) &&
    /textureGrad\s*\(\s*uProcSkyMap\b/.test(glslSrc);

  const commonWgsl = await import(path.resolve(ROOT, '../../shared/shaders/common.wgsl.js'));
  const postWgslMod = await import(path.resolve(ROOT, '../../shared/shaders/post.wgsl.js'));
  const postWgsl = postWgslMod.createPostShadersWGSL('starflight');
  const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\s*\(/;
  const wgslSources = [
    commonWgsl.FULLSCREEN_VERT_WGSL,
    commonWgsl.NOISE_BAKE_COMPUTE_WGSL,
    commonWgsl.MIPMAP_WGSL,
    wgslSrc,
    postWgsl.TAA_WGSL,
    postWgsl.BLOOM_PREFILTER_WGSL,
    postWgsl.BLOOM_DOWNSAMPLE_WGSL,
    postWgsl.BLOOM_UPSAMPLE_WGSL,
    postWgsl.ANAMORPHIC_WGSL,
    postWgsl.COMPOSITE_WGSL,
  ];
  const noGlslIsms = wgslSources.every((s) => typeof s === 'string' && !forbiddenGlsl.test(s));

  assert(
    !hasAnyBareTextureSample &&
      hasVolSampleLevel &&
      hasLutSampleLevel &&
      hasSkySampleGrad &&
      hasBlueNoiseLoad &&
      hasGlslLod &&
      hasGlslGrad &&
      noGlslIsms,
    'WGSL uniformity safeguard: zero bare textureSample() calls, zero GLSL-isms, explicit Level/Grad/Load sampling'
  );

  // Zero stale handles from other sims in starflight-sim
  const allSrcTexts = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n') + '\n' + htmlSrc;
  const hasStaleHandles =
    /__GARGANTUA__|__WORMHOLE__|__BINARY_BH__|__WARP_DRIVE__|__SUPERNOVA__|__PULSAR__|blackhole-sim\.backend|supernova-sim\.backend|pulsar-sim\.backend|SupernovaUniforms|BlackholeUniforms|PulsarUniforms|supernova-canvas|blackhole-canvas|pulsar-canvas/.test(
      allSrcTexts
    );
  const hasStarflightHandle = mainSrc.includes('__STARFLIGHT__') && htmlSrc.includes('starflight-canvas');
  assert(
    !hasStaleHandles && hasStarflightHandle,
    'Zero stale simulator debug handles; window.__STARFLIGHT__ and #starflight-canvas present'
  );

  // Assets & physicalLuts WebGPU check
  const skyPath = path.resolve(ROOT, '../../shared/assets/milkyway_4k.jpg');
  const skyExists = fs.existsSync(skyPath) && fs.statSync(skyPath).size > 1_000_000;
  assert(skyExists, 'shared/assets/milkyway_4k.jpg present and complete');

  const lutsMod = await import(path.resolve(ROOT, '../../shared/assets/physicalLuts.js'));
  globalThis.GPUTextureUsage = globalThis.GPUTextureUsage || { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let gpuUploaded = null;
  const mockDevice = {
    createTexture: (desc) => ({ desc, createView: () => ({ id: 'mockView' }) }),
    queue: { writeTexture: (dst, data, layout, size) => { gpuUploaded = { desc: dst.texture.desc, size }; } },
  };
  const gpuLut = lutsMod.createBlackbodyLUT(mockDevice, 512);
  assert(
    Boolean(gpuLut?.texture && gpuUploaded?.size[0] === 512 && gpuUploaded?.desc.format === 'rgba16float'),
    'physicalLuts.js dual-backend Planck LUT works for WebGPU'
  );
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
