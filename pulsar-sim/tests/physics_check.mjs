#!/usr/bin/env node
/**
 * Magnetar & Millisecond Pulsar Simulator — GR Light Bending, Spin & Light-Cylinder
 * Scaling, Camera Basis & Clamp, Syntax, and GLSL/WGSL Contract Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const physicsMod = await import(path.join(ROOT, 'src/engine/PulsarPhysics.js'));
const {
  PULSAR_CONSTANTS,
  computeSurfaceRedshift,
  computeApparentRadius,
  computeMaxVisibleAngle,
  computeVisibleSurfaceFraction,
  computeLightCylinder,
  computeSpinParameters,
  integrateSchwarzschildDeflection,
  computePulsarTelemetry,
} = physicsMod;

const {
  DEFAULT_STATE,
  PRESETS,
  getPresetById,
  createInitialState,
} = await import(path.join(ROOT, 'src/engine/Presets.js'));

const { PulsarCamera } = await import(path.join(ROOT, 'src/engine/PulsarCamera.js'));

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

function getCamMatrices(cam) {
  if (typeof cam.getMatrices === 'function') return cam.getMatrices();
  if (typeof cam.getCameraMatrices === 'function') return cam.getCameraMatrices();
  throw new Error('PulsarCamera exposes neither getMatrices() nor getCameraMatrices()');
}

function applyCamPreset(cam, presetCam) {
  if (typeof cam.applyPreset === 'function') return cam.applyPreset(presetCam, 0);
  if (typeof cam.flyTo === 'function') return cam.flyTo(presetCam, 0);
  if (typeof cam.setImmediate === 'function') return cam.setImmediate(presetCam);
  throw new Error('PulsarCamera exposes neither applyPreset(), flyTo(), nor setImmediate()');
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

function refQuadraturePsiMax(uc, n = 256) {
  let sum = 0.0;
  const dt = 1.0 / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * dt;
    const t2 = t * t;
    const rad = Math.max((2.0 - t2) - 2.0 * uc * (3.0 - 3.0 * t2 + t2 * t2), 1e-12);
    sum += (2.0 / Math.sqrt(rad)) * dt;
  }
  return sum;
}

console.log('\n=== 1. Gravitational Redshift, Apparent Radius & Schwarzschild Light Bending ===');
{
  const ucValues = [0.12, 0.16, 0.20, 0.21, 0.24, 0.28, 0.29, 0.30];
  let zErrMax = 0;
  let rErrMax = 0;
  let psiErrMax = 0;
  let fVisGrOk = true;
  let fVisFlatOk = true;

  for (const uc of ucValues) {
    const expectedZ = 1.0 / Math.sqrt(1.0 - 2.0 * uc) - 1.0;
    const gotZ = computeSurfaceRedshift(uc);
    zErrMax = Math.max(zErrMax, Math.abs(gotZ - expectedZ));

    const expectedAppR = 1.0 / Math.sqrt(1.0 - 2.0 * uc);
    const gotAppR = computeApparentRadius(uc, 1);
    const gotFlatR = computeApparentRadius(uc, 0);
    rErrMax = Math.max(rErrMax, Math.abs(gotAppR - expectedAppR), Math.abs(gotFlatR - 1.0));

    const refPsi = refQuadraturePsiMax(uc, 256);
    const gotPsi = computeMaxVisibleAngle(uc, 1);
    psiErrMax = Math.max(psiErrMax, Math.abs(gotPsi - refPsi));

    const fGr = computeVisibleSurfaceFraction(uc, 1);
    const fFlat = computeVisibleSurfaceFraction(uc, 0);
    if (!Number.isFinite(fGr) || fGr <= 0.5 || fGr > 1.0 + 1e-12) fVisGrOk = false;
    if (fFlat !== 0.5) fVisFlatOk = false;
  }

  assert(
    zErrMax < 1e-12,
    'Gravitational redshift matches exact z = (1 - 2*u_c)^(-1/2) - 1',
    `maxErr=${zErrMax.toExponential(2)}, z(0.21)=${computeSurfaceRedshift(0.21).toFixed(4)}`
  );
  assert(
    rErrMax < 1e-12,
    'Apparent lensed radius matches R_*/sqrt(1 - 2*u_c) in GR mode and 1.0 in flat mode',
    `maxErr=${rErrMax.toExponential(2)}, R_app(0.29)=${computeApparentRadius(0.29, 1).toFixed(4)}`
  );
  assert(
    psiErrMax < 2e-4 && fVisGrOk && fVisFlatOk,
    'Visible surface fraction f_vis > 0.5 for all u_c in [0.12, 0.30] and f_vis === 0.5 in flat mode',
    `psiMaxErr=${psiErrMax.toExponential(2)}, f_vis(0.21)=${(computeVisibleSurfaceFraction(0.21, 1) * 100).toFixed(2)}%, f_vis(0.29)=${(computeVisibleSurfaceFraction(0.29, 1) * 100).toFixed(2)}%`
  );

  // Entire-surface visibility threshold around u_c >= 0.284 (psi_max >= PI -> f_vis === 1.0)
  const fLow = computeVisibleSurfaceFraction(0.12, 1);
  const fCrab = computeVisibleSurfaceFraction(0.21, 1);
  const fFull = computeVisibleSurfaceFraction(0.29, 1);
  assert(
    fLow > 0.5 && fCrab > 0.7 && fFull >= 0.999999,
    'GR light bending exposes >70% at Crab u_c=0.21 and 100% full crust by u_c=0.29',
    `f_vis(0.12)=${fLow.toFixed(4)}, f_vis(0.21)=${fCrab.toFixed(4)}, f_vis(0.29)=${fFull.toFixed(4)}`
  );

  // Monotonicity of z, R_app, psi_max, and f_vis vs u_c
  const monoUcs = [0.12, 0.15, 0.18, 0.21, 0.24, 0.27, 0.30];
  let monoOk = true;
  for (let i = 1; i < monoUcs.length; i++) {
    const u0 = monoUcs[i - 1];
    const u1 = monoUcs[i];
    if (
      !(computeSurfaceRedshift(u1) > computeSurfaceRedshift(u0)) ||
      !(computeApparentRadius(u1, 1) > computeApparentRadius(u0, 1)) ||
      !(computeMaxVisibleAngle(u1, 1) > computeMaxVisibleAngle(u0, 1)) ||
      !(computeVisibleSurfaceFraction(u1, 1) >= computeVisibleSurfaceFraction(u0, 1))
    ) {
      monoOk = false;
    }
  }
  assert(monoOk, 'Redshift z, apparent radius, psi_max, and f_vis increase monotonically with compactness u_c');
}

console.log('\n=== 2. Light Cylinder, Spin Frequency & Kerr-Schild Deflection RK4 Verification ===');
{
  const cKms = PULSAR_CONSTANTS?.C_KMS ?? 299792.458;
  const periods = [1.5, 12.0, 33.0, 320.0];
  let lcOk = true;
  let spinOk = true;
  let prevRlc = 0;

  for (const pMs of periods) {
    const lc = computeLightCylinder(0.21, pMs);
    const expectedKm = (cKms * (pMs / 1000.0)) / (2.0 * Math.PI);
    const relErr = Math.abs(lc.rLightCylKm - expectedKm) / expectedKm;
    if (
      !Number.isFinite(lc.rLightCylKm) ||
      relErr > 1e-6 ||
      !(lc.rLightCylKm > prevRlc) ||
      !(lc.rLightCylVis >= 3.4 && lc.rLightCylVis <= 10.8)
    ) {
      lcOk = false;
    }
    prevRlc = lc.rLightCylKm;

    const sp = computeSpinParameters(0.21, pMs, 1.0);
    const expectedHz = 1000.0 / pMs;
    if (
      !approx(sp.spinFreqHz, expectedHz, 1e-9) ||
      !(sp.betaEq >= 0 && sp.betaEq <= 0.38) ||
      !(sp.chi >= 0 && sp.chi <= 0.45) ||
      !approx(sp.spinA, sp.chi * 0.21, 1e-12) ||
      !(sp.omegaVis > 0)
    ) {
      spinOk = false;
    }
  }

  assert(lcOk, 'Light-cylinder R_LC = c*P/(2*pi) and clamped rLightCylVis in [3.4, 10.8] scale properly');
  assert(spinOk, 'Spin frequency f = 1000/P_ms, betaEq <= 0.38, Hartle-Thorne chi <= 0.45, and spinA = chi*M');

  // Weak-field Schwarzschild deflection check against classic 4M/b (M = u_c in R_*=1 units)
  const ucDefl = 0.21;
  const bWeak = 60.0;
  const weakRes = integrateSchwarzschildDeflection(bWeak, ucDefl, 0.0);
  const weakAngle = Number(typeof weakRes === 'number' ? weakRes : weakRes?.deflectionRad ?? weakRes?.angleRad ?? weakRes?.deflection);
  const einsteinAngle = (4.0 * ucDefl) / bWeak;
  const weakRelErr = Math.abs(weakAngle - einsteinAngle) / einsteinAngle;

  const bMid = 10.0;
  const midRes = integrateSchwarzschildDeflection(bMid, ucDefl, 0.0);
  const midAngle = Number(typeof midRes === 'number' ? midRes : midRes?.deflectionRad ?? midRes?.angleRad ?? midRes?.deflection);

  // Critical capture radius b_crit = 3*sqrt(3)*M
  const ucCap = 0.25;
  const bCritExpected = 3.0 * Math.sqrt(3.0) * ucCap; // ~1.2990 > R_*=1.0
  const capInside = integrateSchwarzschildDeflection(bCritExpected * 0.90, ucCap, 0.0);
  const capOutside = integrateSchwarzschildDeflection(bCritExpected * 1.15, ucCap, 0.0);
  const isInsideCaptured = typeof capInside === 'object' ? Boolean(capInside.captured || capInside.hitSurface) : false;
  const isOutsideEscaped = typeof capOutside === 'object' ? !capOutside.captured : Number.isFinite(capOutside);

  assert(
    Number.isFinite(weakAngle) && weakRelErr < 0.05 && Number.isFinite(midAngle) && midAngle > weakAngle,
    'integrateSchwarzschildDeflection matches weak-field 4M/b limit and increases inward',
    `b=${bWeak}: RK4=${weakAngle.toExponential(4)} vs 4M/b=${einsteinAngle.toExponential(4)} (relErr=${(weakRelErr * 100).toFixed(2)}%)`
  );
  assert(
    isInsideCaptured && isOutsideEscaped,
    `Critical capture threshold consistent with b_crit = 3*sqrt(3)*M (${bCritExpected.toFixed(4)} R_*)`,
    `0.90*b_crit captured=${isInsideCaptured}, 1.15*b_crit escaped=${isOutsideEscaped}`
  );
}

console.log('\n=== 3. Presets, Telemetry & PulsarCamera Orthonormal / Inner Clamp Checks ===');
{
  const expectedOrder = ['crab', 'millisecond', 'magnetar', 'polar_cap', 'edge_on', 'pwn_torus'];
  const actualOrder = PRESETS.map((p) => p.id);
  const init = createInitialState();

  const boundsOk = PRESETS.every((p) => {
    const pr = p.params;
    const cam = p.camera;
    return (
      pr.compactness >= 0.12 && pr.compactness <= 0.30 &&
      pr.spinPeriodMs >= 1.4 && pr.spinPeriodMs <= 500 &&
      pr.obliquityDeg >= 0 && pr.obliquityDeg <= 90 &&
      pr.twistShear >= 0 && pr.beamIntensity >= 0 && pr.plasmaDensity >= 0 &&
      cam.distance >= 2.2 && cam.distance <= 36.0
    );
  });

  assert(
    DEFAULT_STATE.presetId === 'crab' &&
      expectedOrder.every((id, idx) => actualOrder[idx] === id && PRESETS[idx].hotkey === String(idx + 1)) &&
      getPresetById('magnetar')?.params.compactness === 0.29 &&
      boundsOk,
    'Presets.js exports DEFAULT_STATE (crab) and all 6 presets in exact order 1..6 with valid bounds',
    `order=[${actualOrder.join(', ')}]`
  );

  let telAllOk = true;
  for (const preset of PRESETS) {
    const tel = computePulsarTelemetry({ ...init, ...preset.params });
    const vals = [
      tel.compactness, tel.massSolar, tel.stellarRadiusKm, tel.schwarzschildRadius,
      tel.spinA, tel.chi, tel.betaEq, tel.surfaceRedshiftZ, tel.apparentRadius,
      tel.maxVisibleAngleRad, tel.maxVisibleAngleDeg, tel.visibleSurfaceFraction,
      tel.rLightCylKm, tel.rLightCylNorm, tel.rLightCylVis, tel.spinFreqHz,
      tel.omegaVis, tel.lensingStrength, tel.obliquityRad,
    ];
    if (!vals.every(Number.isFinite) || tel.visibleSurfaceFraction <= 0.5 || tel.surfaceRedshiftZ <= 0) {
      telAllOk = false;
    }
  }
  assert(telAllOk, 'computePulsarTelemetry produces finite positive astrophysics across all 6 presets');

  const cam = new PulsarCamera(null, PRESETS[0].camera);
  for (const preset of PRESETS) {
    applyCamPreset(cam, preset.camera);
    checkOrthonormal(getCamMatrices(cam), `PulsarCamera orthonormal on preset '${preset.id}'`);
  }

  // Inner distance clamp >= 2.2 and outer clamp <= 36.0
  cam.setState({ distance: 0.4, azimuthDeg: 45, elevationDeg: 85, rollDeg: 15, lookYawDeg: 20, lookPitchDeg: -15 });
  cam.update(0.05, false);
  const clampedInner = cam.getState();
  checkOrthonormal(getCamMatrices(cam), 'PulsarCamera orthonormal near pole (elevation=85 deg) & inner clamp');
  assert(
    clampedInner.distance >= 2.2 - 1e-6,
    'PulsarCamera enforces safe inner distance clamp >= 2.2 R_*',
    `requested 0.4 -> got ${clampedInner.distance.toFixed(3)}`
  );

  cam.setState({ distance: 99.0, elevationDeg: -85 });
  cam.update(0.05, false);
  const clampedOuter = cam.getState();
  assert(
    clampedOuter.distance <= 36.0 + 1e-6,
    'PulsarCamera enforces outer distance clamp <= 36.0 R_*',
    `requested 99.0 -> got ${clampedOuter.distance.toFixed(3)}`
  );

  if (typeof cam.reset === 'function') {
    cam.reset();
    cam.update(0.05, false);
    const resetSt = cam.getState();
    assert(
      approx(resetSt.distance, PRESETS[0].camera.distance, 0.5),
      'PulsarCamera reset() restores initial preset camera distance'
    );
  }

  // Left-to-right control convention check (matching SupernovaCamera.js):
  //   - Pointer drag right (dx > 0) increases azimuth -> moves camera in -right (pulsar rotates right on screen)
  //   - KeyD / ArrowRight decreases azimuth -> moves camera in +right (camera orbits right)
  {
    const cDir = new PulsarCamera(null, { distance: 10.0, pivot: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, fovDeg: 48, lookYawDeg: 0, lookPitchDeg: 0 });
    const m0 = getCamMatrices(cDir);
    cDir._ensureHandlers();
    cDir._pointers.set(1, { x: 100, y: 100, button: 0 });
    cDir._dragMode = 'orbit';
    cDir._onPointerMove({ pointerId: 1, clientX: 160, clientY: 100, shiftKey: false });
    cDir._pointers.clear();
    cDir._dragMode = null;
    for (let i = 0; i < 40; i++) cDir.update(0.03, false);
    const mDrag = getCamMatrices(cDir);
    const dragDot = dot3([mDrag.pos[0] - m0.pos[0], mDrag.pos[1] - m0.pos[1], mDrag.pos[2] - m0.pos[2]], m0.right);

    cDir.setState({ azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 });
    const mKeyBase = getCamMatrices(cDir);
    cDir._keys.add('KeyD');
    cDir.update(0.05, false);
    cDir._keys.delete('KeyD');
    for (let i = 0; i < 20; i++) cDir.update(0.03, false);
    const mKeyRight = getCamMatrices(cDir);
    const keyDot = dot3([mKeyRight.pos[0] - mKeyBase.pos[0], mKeyRight.pos[1] - mKeyBase.pos[1], mKeyRight.pos[2] - mKeyBase.pos[2]], mKeyBase.right);

    assert(
      dragDot < -0.1 && keyDot > 0.01,
      'PulsarCamera left-to-right controls match non-inverted convention (drag right moves camera -right, KeyD moves +right)',
      `dragDot=${dragDot.toFixed(3)}, keyDot=${keyDot.toFixed(3)}`
    );
    cDir.dispose?.();
  }

  cam.dispose?.();
}

console.log('\n=== 4. Syntax, GLSL/WGSL 176-Byte UBO Parity, Uniformity & Asset Contracts ===');
{
  const jsFiles = collectJsFiles(path.join(ROOT, 'src')).sort();
  assert(jsFiles.length >= 12, `Discovered ${jsFiles.length} JS modules under pulsar-sim/src/`);
  for (const fullPath of jsFiles) {
    const rel = path.relative(ROOT, fullPath);
    try {
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
      assert(true, `JS syntax OK: ${rel}`);
    } catch (err) {
      assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
    }
  }

  const glslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/pulsar.frag.js'), 'utf8');
  const wgslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/pulsar.wgsl.js'), 'utf8');
  const glRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGLRenderer.js'), 'utf8');
  const gpuRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const expectedFields = [
    'resolution_time_frame',
    'jitter_fov_lensing',
    'camPos_compactness',
    'camRight_spinA',
    'camUp_betaEq',
    'camFwd_phase',
    'magnetParams',
    'beamPwnParams',
    'skyParams',
    'qualityParams',
    'extraParams',
  ];

  const glslStructMatch = glslSrc.match(/layout\(std140\)\s+uniform\s+PulsarUniforms\s*\{([\s\S]*?)\}\s*u\s*;/);
  const wgslStructMatch = wgslSrc.match(/struct\s+PulsarUniforms\s*\{([\s\S]*?)\}\s*;/);

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
      glRendererSrc.includes("'PulsarUniforms'") &&
      gpuRendererSrc.includes('new ArrayBuffer(176)') &&
      gpuRendererSrc.includes('176'),
    'GLSL & WGSL PulsarUniforms match byte-for-byte (176 bytes / 11 vec4<f32> fields) and renderer UBO allocations',
    `fields=${glslFields.length}, bytes=${expectedBytes}`
  );

  // Check WGSL @group(0) @binding(0..8) & GLSL texture units
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
  const hasGlslLod =
    /textureLod\s*\(\s*uVolumeNoise\b/.test(glslSrc) &&
    /textureLod\s*\(\s*uBlackbodyLut\b/.test(glslSrc);

  const commonWgsl = await import(path.join(ROOT, 'src/shaders/common.wgsl.js'));
  const postWgsl = await import(path.join(ROOT, 'src/shaders/post.wgsl.js'));
  const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\s*\(/;
  const wgslSources = [
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
    !hasAnyBareTextureSample && hasVolSampleLevel && hasLutSampleLevel && hasSkySampleGrad && hasGlslLod && noGlslIsms,
    'WGSL uniformity safeguard: zero bare textureSample() calls, zero GLSL-isms, explicit Level/Grad sampling'
  );

  // Zero stale blackhole / supernova debug handles in pulsar-sim
  const allSrcTexts = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n') + '\n' + htmlSrc;
  const hasStaleHandles =
    /__GARGANTUA__|__SUPERNOVA__|blackhole-sim\.backend|supernova-sim\.backend|SupernovaUniforms|BlackholeUniforms|supernova-canvas|blackhole-canvas/.test(
      allSrcTexts
    );
  const hasPulsarHandle = mainSrc.includes('__PULSAR__') && htmlSrc.includes('pulsar-canvas');
  assert(
    !hasStaleHandles && hasPulsarHandle,
    'Zero stale blackhole/supernova debug handles; window.__PULSAR__ and #pulsar-canvas present'
  );

  // Assets & physicalLuts WebGPU + WebGL2 check
  const skyExists =
    fs.existsSync(path.join(ROOT, 'assets/milkyway_4k.jpg')) &&
    fs.statSync(path.join(ROOT, 'assets/milkyway_4k.jpg')).size > 1_000_000;
  assert(skyExists, 'assets/milkyway_4k.jpg present and complete');

  const lutsMod = await import(path.join(ROOT, 'src/assets/physicalLuts.js'));
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
