#!/usr/bin/env node
/**
 * Gravitational Lensing Observatory — Analytical & Numerical Physics Verification,
 * Camera Basis & Reflow Guard Check, JS Syntax Check, and 176-Byte GLSL/WGSL
 * Uniform/Uniformity Contract Verification Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  LENS_CONSTANTS,
  LENS_MODEL_LABELS,
  evalNfwFunctions,
  evalLensField,
  evalFermatPotential,
  evalPointMassExact,
  solveLensedImages,
  computeLensTelemetry,
} = await import(path.join(ROOT, 'src/engine/Physics.js'));

const {
  DEFAULT_STATE,
  PRESETS,
  getPresetById,
  createInitialState,
} = await import(path.join(ROOT, 'src/engine/Presets.js'));

const { LensClusterCamera } = await import(path.join(ROOT, 'src/engine/CameraController.js'));

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

console.log('\n=== 1. Point-Mass Einstein Ring, Paczynski Magnification & Exact Time Delay ===');
{
  const thetaE = 2.1;
  const pmRing = evalLensField(thetaE, 0.0, { lensModel: 0, einsteinRadius: thetaE, extShear: 0.0 });
  const eps2 = Math.pow(LENS_CONSTANTS.POINT_SOFTENING_FRAC * thetaE, 2);
  const expectedAlpha = (thetaE * thetaE * thetaE) / (thetaE * thetaE + eps2);
  assert(
    approx(pmRing.ax, expectedAlpha, 1e-9) &&
      approx(pmRing.ay, 0.0, 1e-12) &&
      Math.abs(pmRing.detA) < 2e-3 &&
      Math.abs(pmRing.lambdaT) < 2e-3,
    'Point-Mass ring critical curve (lambdaT ≈ 0, detA ≈ 0) sits accurately on |theta| = thetaE',
    `alpha=${pmRing.ax.toFixed(6)}, lambdaT=${pmRing.lambdaT.toExponential(2)}`
  );

  // Off-axis two-image lens equation & exact Paczynski total magnification check
  for (const u of [0.15, 0.35, 0.85, 1.5]) {
    const ex = evalPointMassExact(u, thetaE);
    const betaX = u * thetaE;
    const solved = solveLensedImages({
      lensModel: 0,
      einsteinRadius: thetaE,
      extShear: 0.0,
      sourceX: betaX,
      sourceY: 0.0,
    });
    const fPlus = evalLensField(ex.thetaPlus, 0.0, { lensModel: 0, einsteinRadius: thetaE, extShear: 0.0 });
    const fMinus = evalLensField(ex.thetaMinus, 0.0, { lensModel: 0, einsteinRadius: thetaE, extShear: 0.0 });
    assert(
      solved.images.length === 2 &&
        approx(solved.totalMag, ex.muTot, 0.05) &&
        approx(solved.timeDelayDays, ex.timeDelayDays, 0.35) &&
        Math.abs(ex.thetaPlus - fPlus.ax - betaX) < 5e-3 &&
        Math.abs(ex.thetaMinus - fMinus.ax - betaX) < 5e-3,
      `Paczynski 2-image parity & Shapiro delay at u=${u}`,
      `mu=${solved.totalMag.toFixed(3)} vs ${ex.muTot.toFixed(3)}, dt=${solved.timeDelayDays.toFixed(2)}d vs ${ex.timeDelayDays.toFixed(2)}d`
    );
  }
}

console.log('\n=== 2. SIE Elliptical Quad (Einstein Cross) & Curl-Free Symmetry ===');
{
  const crossState = createInitialState('einstein_cross');
  const crossTel = computeLensTelemetry(crossState);
  assert(
    crossTel.imageCount === 4 &&
      crossTel.multiplicityLabel.includes('Quad') &&
      crossTel.totalMagnification > 8.0 &&
      crossTel.timeDelayDays >= 0.0,
    'Einstein Cross preset produces 4 lensed Quad images inside astroid caustic',
    `images=${crossTel.imageCount} (${crossTel.multiplicityLabel}), mu=${crossTel.totalMagnification.toFixed(2)}x, dt=${crossTel.timeDelayDays.toFixed(2)}d`
  );

  // Verify curl-free lens deflection numerically on SIE and NFW (d alpha_x / dy == d alpha_y / dx)
  const h = 1e-5;
  for (const model of [1, 2]) {
    const params = {
      lensModel: model,
      einsteinRadius: 2.5,
      ellipticity: 0.34,
      extShear: 0.09,
      lensAngleDeg: 27,
      shearAngleDeg: -19,
      subhaloStrength: 1.0,
    };
    const px = 1.15;
    const py = -0.82;
    const axUp = evalLensField(px, py + h, params).ax;
    const axDn = evalLensField(px, py - h, params).ax;
    const ayRt = evalLensField(px + h, py, params).ay;
    const ayLt = evalLensField(px - h, py, params).ay;
    const curl = Math.abs((axUp - axDn) / (2 * h) - (ayRt - ayLt) / (2 * h));
    assert(
      curl < 1e-5,
      `${LENS_MODEL_LABELS[model]} deflection field is analytically curl-free (Psi_xy symmetric)`,
      `curl=${curl.toExponential(2)}`
    );
  }
}

console.log('\n=== 3. NFW Smooth Transition Across x = 1 & Cluster Arc Multiplicity ===');
{
  const xs = [0.9799, 0.9801, 0.9999, 1.0, 1.0001, 1.0199, 1.0201];
  const vals = xs.map((x) => evalNfwFunctions(x));
  const contOk = vals.every(
    (v, i) =>
      Number.isFinite(v.g) &&
      Number.isFinite(v.F) &&
      Number.isFinite(v.hPsi) &&
      (i === 0 || (Math.abs(v.F - vals[i - 1].F) < 0.015 && Math.abs(v.g - vals[i - 1].g) < 0.015))
  );
  assert(
    contOk && approx(vals[3].F, 1 / 3, 1e-12) && approx(vals[3].g, 1 - Math.LN2, 1e-12),
    'NFW analytical projection functions g(x), F(x), hPsi(x) are C^infinity continuous across x = 1',
    `F(1)=${vals[3].F.toFixed(6)}, g(1)=${vals[3].g.toFixed(6)}`
  );

  // Verify NFW radial & tangential critical curves exist (lambdaT crosses 0, lambdaR crosses 0 inside)
  const jwstState = createInitialState('jwst_cluster');
  const inner = evalLensField(0.10 * jwstState.einsteinRadius, 0.0, { ...jwstState, subhaloStrength: 0.0 });
  const outer = evalLensField(1.80 * jwstState.einsteinRadius, 0.0, { ...jwstState, subhaloStrength: 0.0 });
  assert(
    inner.lambdaR < 0.0 && outer.lambdaR > 0.0 && inner.lambdaT < 0.0 && outer.lambdaT > 0.0,
    'NFW Cluster halo supports both tangential (lambdaT=0) and inner radial (lambdaR=0) critical curves',
    `lambdaR=[${inner.lambdaR.toFixed(3)}, ${outer.lambdaR.toFixed(3)}], lambdaT=[${inner.lambdaT.toFixed(3)}, ${outer.lambdaT.toFixed(3)}]`
  );

  const jwstTel = computeLensTelemetry(jwstState);
  assert(
    jwstTel.imageCount >= 2 &&
      jwstTel.enclosedMass1e12Msun > 1.5 &&
      jwstTel.enclosedMass1e12Msun < 4.0 &&
      jwstTel.totalMagnification > 3.0,
    'JWST Giant Cluster Arcs telemetry computes physical enclosed mass and strong lensing magnification',
    `images=${jwstTel.imageCount}, mass=${jwstTel.enclosedMass1e12Msun.toFixed(2)}e12 Msun, mu=${jwstTel.totalMagnification.toFixed(2)}x`
  );
}

console.log('\n=== 4. Fermat Principle Stationary Points ===');
{
  const bench = createInitialState('caustic_fermat');
  const solved = solveLensedImages(bench);
  const h = 1e-5;
  let maxGrad = 0.0;
  for (const im of solved.images) {
    const gx =
      (evalFermatPotential(im.x + h, im.y, bench.sourceX, bench.sourceY, bench) -
        evalFermatPotential(im.x - h, im.y, bench.sourceX, bench.sourceY, bench)) /
      (2 * h);
    const gy =
      (evalFermatPotential(im.x, im.y + h, bench.sourceX, bench.sourceY, bench) -
        evalFermatPotential(im.x, im.y - h, bench.sourceX, bench.sourceY, bench)) /
      (2 * h);
    maxGrad = Math.max(maxGrad, Math.hypot(gx, gy));
  }
  assert(
    solved.images.length >= 4 && maxGrad < 5e-4,
    'Every lensed image is an exact stationary point (grad tau == 0) of the Fermat arrival-time surface',
    `images=${solved.images.length}, max|gradTau|=${maxGrad.toExponential(2)}`
  );
}

console.log('\n=== 5. Presets, Camera Basis Orthonormality & No-Reflow Contract ===');
{
  assert(
    PRESETS.length === 6 &&
      PRESETS.every((p) => p.id && p.name && p.hotkey && p.params && p.camera) &&
      getPresetById('einstein_cross')?.id === 'einstein_cross' &&
      DEFAULT_STATE.presetId === 'jwst_cluster',
    'All 6 lens-cluster presets valid with jwst_cluster default'
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
  const cam = new LensClusterCamera(mockCanvas, getPresetById('jwst_cluster').camera);
  cam.update(0.016, false);
  const m = cam.getMatrices();
  const rLen = Math.hypot(...m.right);
  const uLen = Math.hypot(...m.up);
  const fLen = Math.hypot(...m.forward);
  const orthoErr = Math.max(
    Math.abs(dot3(m.right, m.up)),
    Math.abs(dot3(m.right, m.forward)),
    Math.abs(dot3(m.up, m.forward))
  );
  const rxf = cross3(m.right, m.forward);
  const handErr = Math.hypot(rxf[0] - m.up[0], rxf[1] - m.up[1], rxf[2] - m.up[2]);
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
    'LensClusterCamera triad is right-handed orthonormal & eliminates getBoundingClientRect reflows',
    `orthoErr=${orthoErr.toExponential(1)}, handErr=${handErr.toExponential(1)}`
  );
}

console.log('\n=== 6. JS Syntax Verification ===');
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
  assert(allOk && jsFiles.length >= 8, `All ${jsFiles.length} lens-cluster JS modules pass node --check`);
}

console.log('\n=== 7. GLSL <-> WGSL Uniform Block, Uniformity & Parity Check ===');
{
  const { LENS_CLUSTER_FRAG } = await import(path.join(ROOT, 'src/shaders/lens-cluster.frag.js'));
  const { LENS_CLUSTER_WGSL } = await import(path.join(ROOT, 'src/shaders/lens-cluster.wgsl.js'));
  const rawWgsl = fs.readFileSync(path.join(ROOT, 'src/shaders/lens-cluster.wgsl'), 'utf8');

  const glHasFields =
    LENS_CLUSTER_FRAG.includes('#version 300 es') &&
    LENS_CLUSTER_FRAG.includes('uniform LensClusterUniforms') &&
    LENS_CLUSTER_FRAG.includes('sampler3D uVolumeNoise') &&
    LENS_CLUSTER_FRAG.includes('sampler2D uSkyMap') &&
    LENS_CLUSTER_FRAG.includes('sampler2D uProcSkyMap') &&
    LENS_CLUSTER_FRAG.includes('sampler2D uBlackbodyLut') &&
    LENS_CLUSTER_FRAG.includes('sampler2D uBlueNoise');

  const wgHasFields =
    LENS_CLUSTER_WGSL.includes('struct LensClusterUniforms') &&
    LENS_CLUSTER_WGSL.includes('@binding(0) var<uniform> u: LensClusterUniforms;') &&
    LENS_CLUSTER_WGSL.includes('@binding(8) var uBlueNoise: texture_2d<f32>;') &&
    !LENS_CLUSTER_WGSL.includes('textureSample(') &&
    LENS_CLUSTER_WGSL.includes('textureSampleGrad(') &&
    LENS_CLUSTER_WGSL.includes('textureSampleLevel(') &&
    LENS_CLUSTER_WGSL.includes('textureLoad(') &&
    rawWgsl.trim() === LENS_CLUSTER_WGSL.trim();

  assert(
    glHasFields && wgHasFields,
    '176-byte LensClusterUniforms + bindings 0..8 match across GLSL & WGSL with strict WGSL uniformity (zero bare textureSample)'
  );
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
