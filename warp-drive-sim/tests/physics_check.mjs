#!/usr/bin/env node
/**
 * Warp Drive Transit Simulator — Relativistic ADM Physics, Geodesic Conservation,
 * Alcubierre / Natário / Lentz Metrics, Presets, and Dual-Mode Camera Verification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  evalShape,
  evalMetric,
  computeWarpTelemetry,
  traceRayCPU,
} = await import(path.join(ROOT, 'src/engine/WarpPhysics.js'));

const {
  DEFAULT_STATE,
  PRESETS,
  getPresetById,
  createInitialState,
} = await import(path.join(ROOT, 'src/engine/Presets.js'));

const { WarpCamera } = await import(path.join(ROOT, 'src/engine/WarpCamera.js'));

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

function checkOrthonormal(mat, label) {
  const { pos, right, up, forward, basis, fovY, frameBlend } = mat;
  const allVals = [...pos, ...right, ...up, ...forward, ...basis, fovY, frameBlend];
  const allFinite = allVals.every(Number.isFinite);

  const rLen = Math.hypot(...right);
  const uLen = Math.hypot(...up);
  const fLen = Math.hypot(...forward);
  const ru = Math.abs(dot3(right, up));
  const rf = Math.abs(dot3(right, forward));
  const uf = Math.abs(dot3(up, forward));

  const rxF = cross3(right, forward);
  const handErr = Math.hypot(rxF[0] - up[0], rxF[1] - up[1], rxF[2] - up[2]);

  const basisErr = Math.max(
    Math.abs(basis[0] - right[0]), Math.abs(basis[1] - right[1]), Math.abs(basis[2] - right[2]),
    Math.abs(basis[3] - up[0]), Math.abs(basis[4] - up[1]), Math.abs(basis[5] - up[2]),
    Math.abs(basis[6] - forward[0]), Math.abs(basis[7] - forward[1]), Math.abs(basis[8] - forward[2])
  );

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

function checkMetricJacobianFD(metricType, points, statePatch = {}) {
  const state = { bubbleRadius: 3.0, wallThickness: 2.3, warpVelocity: 2.5, metricType, ...statePatch };
  let maxErr = 0.0;
  let maxDiv = 0.0;
  const eps = 1e-6;

  for (const frameBlend of [0.0, 1.0]) {
    for (const p of points) {
      const m = evalMetric(p, state, frameBlend);
      const div = m.J[0][0] + m.J[1][1] + m.J[2][2];
      maxDiv = Math.max(maxDiv, Math.abs(div));

      for (let i = 0; i < 3; i++) {
        const pp = [...p];
        const pm = [...p];
        pp[i] += eps;
        pm[i] -= eps;
        const bp = evalMetric(pp, state, frameBlend).beta;
        const bm = evalMetric(pm, state, frameBlend).beta;
        for (let j = 0; j < 3; j++) {
          const fd = (bp[j] - bm[j]) / (2.0 * eps);
          maxErr = Math.max(maxErr, Math.abs(m.J[i][j] - fd));
        }
      }
    }
  }
  return { maxErr, maxDiv };
}

console.log('\n=== 1. Alcubierre Shaping Function & Metric (metricType = 0) ===');
{
  const R = 3.0;
  const sigma = 2.3;
  const s0 = evalShape(0.0, R, sigma);
  const expectedDfOverR0 = -2.0 * sigma * sigma / (Math.cosh(sigma * R) ** 2);

  assert(
    approx(s0.f, 1.0, 1e-12) && approx(s0.df, 0.0, 1e-12),
    'Alcubierre shaping function satisfies f(0) = 1 and f\'(0) = 0',
    `f(0)=${s0.f.toFixed(12)}, df(0)=${s0.df.toExponential(2)}`
  );
  assert(
    approx(s0.dfOverR, expectedDfOverR0, 1e-12),
    'Analytical r -> 0 limit dfOverR(0) = -2*sigma^2*sech^2(sigma*R)',
    `dfOverR=${s0.dfOverR.toExponential(6)}`
  );

  // Check d2f against FD of df and continuity across r = 1e-3
  let maxD2fErr = 0.0;
  const h = 1e-6;
  for (const r of [0.002, 0.5, 1.8, 3.0, 4.2]) {
    const s = evalShape(r, R, sigma);
    const sp = evalShape(r + h, R, sigma);
    const sm = evalShape(Math.max(0, r - h), R, sigma);
    const fd = (sp.df - sm.df) / (r + h - Math.max(0, r - h));
    maxD2fErr = Math.max(maxD2fErr, Math.abs(s.d2f - fd));
  }
  const sBelow = evalShape(0.999e-3, R, sigma);
  const sAbove = evalShape(1.001e-3, R, sigma);
  const jump = Math.abs(sAbove.dfOverR - sBelow.dfOverR);
  const sExtreme = evalShape(1e6, 6.0, 6.5);
  assert(
    maxD2fErr < 1e-6 && jump < 1e-8 && Number.isFinite(sExtreme.f) && Number.isFinite(sExtreme.df),
    'Alcubierre d2f matches FD (< 1e-6), dfOverR smooth across r=1e-3, large-u clamp finite',
    `maxD2fErr=${maxD2fErr.toExponential(2)}, jump=${jump.toExponential(2)}`
  );

  const testPoints = [
    [0.0, 0.0, 0.0],
    [4e-4, -3e-4, 5e-4],
    [1.8, -0.7, 2.2],
    [3.0, 0.0, 0.0],
    [0.0, 2.4, -1.9],
  ];
  const { maxErr } = checkMetricJacobianFD(0, testPoints);
  assert(
    maxErr < 1e-6,
    'Alcubierre exact analytical Jacobian matches central FD (< 1e-6)',
    `maxErr=${maxErr.toExponential(2)}`
  );

  const state0 = { bubbleRadius: R, wallThickness: sigma, warpVelocity: 2.5, metricType: 0 };
  const eqSamples = [];
  for (let phi = 0; phi < 8; phi++) {
    const ang = (phi * Math.PI) / 4;
    eqSamples.push(evalMetric([R * Math.cos(ang), R * Math.sin(ang), 0.0], state0, 0.0).t00);
  }
  const frontMetric = evalMetric([0.0, 0.0, R], state0, 0.0);
  const backMetric = evalMetric([0.0, 0.0, -R], state0, 0.0);

  assert(
    eqSamples.every((t) => t < -1e-3),
    'Alcubierre T_00 <= 0 (strictly negative) around equatorial torus (z=0, r=R)',
    `minT00=${Math.min(...eqSamples).toExponential(3)}`
  );
  assert(
    frontMetric.theta < -1.0 && backMetric.theta > 1.0 && approx(frontMetric.theta, -backMetric.theta, 1e-12),
    'Alcubierre York expansion theta < 0 in front (z>0) and theta > 0 behind (z<0)',
    `theta(+R)=${frontMetric.theta.toFixed(4)}, theta(-R)=${backMetric.theta.toFixed(4)}`
  );
}

console.log('\n=== 2. Natário Zero-Expansion Metric (metricType = 1) ===');
{
  const natPoints = [
    [0.0, 0.0, 0.0],
    [3e-4, 4e-4, -5e-4],
    [1.5e-3, -1e-3, 1.2e-3],
    [2.1, -1.1, 1.8],
    [3.0, 0.0, 0.0],
    [0.0, 0.0, 3.0],
    [-1.7, 2.2, -1.4],
  ];
  const { maxErr, maxDiv } = checkMetricJacobianFD(1, natPoints, { warpVelocity: 2.0 });
  const maxTheta = Math.max(
    ...natPoints.map((p) => Math.abs(evalMetric(p, { bubbleRadius: 3.0, wallThickness: 2.3, warpVelocity: 2.0, metricType: 1 }).theta))
  );

  assert(
    maxDiv < 1e-10 && maxTheta === 0.0,
    'Natário divergence div(beta) == 0 everywhere (< 1e-10)',
    `maxDiv=${maxDiv.toExponential(2)}, maxTheta=${maxTheta}`
  );
  assert(
    maxErr < 1e-6,
    'Natário exact analytical Jacobian matches central FD (< 1e-6, including r -> 0 Taylor)',
    `maxErr=${maxErr.toExponential(2)}`
  );

  // Also test smooth Taylor behavior at small R, sigma where f^(4)(0) is appreciable
  const { maxErr: smallRErr, maxDiv: smallRDiv } = checkMetricJacobianFD(
    1,
    [[4e-4, -3e-4, 6e-4], [1.6e-3, 1.2e-3, -8e-4]],
    { bubbleRadius: 1.8, wallThickness: 1.2, warpVelocity: 2.5 }
  );
  assert(
    smallRErr < 1e-6 && smallRDiv < 1e-10,
    'Natário r -> 0 Taylor limit holds for small sigma*R',
    `maxErr=${smallRErr.toExponential(2)}, maxDiv=${smallRDiv.toExponential(2)}`
  );
}

console.log('\n=== 3. Lentz Rhomboidal Soliton Metric (metricType = 2) ===');
{
  const lentzPoints = [
    [0.0, 0.0, 0.0],
    [0.0, 0.0, 3.0],
    [0.0, 0.0, -3.0],
    [3.0, 0.0, 0.0],
    [0.0, 3.0, 0.0],
    [1.2, -0.7, 1.7],
    [-1.5, 0.8, -1.6],
  ];
  const { maxErr } = checkMetricJacobianFD(2, lentzPoints, { warpVelocity: 2.5 });
  assert(
    maxErr < 1e-6,
    'Lentz analytical Jacobian matches central FD (< 1e-6)',
    `maxErr=${maxErr.toExponential(2)}`
  );

  const lentzState = { bubbleRadius: 3.0, wallThickness: 2.3, warpVelocity: 2.5, metricType: 2 };
  const bowLobe = evalMetric([0.0, 0.0, 3.0], lentzState, 0.0);
  const sternLobe = evalMetric([0.0, 0.0, -3.0], lentzState, 0.0);
  const diagFace = evalMetric([1.3, 0.0, 1.7], lentzState, 0.0);
  const eqPinchX = evalMetric([3.0, 0.0, 0.0], lentzState, 0.0);
  const eqPinchY = evalMetric([0.0, 3.0, 0.0], lentzState, 0.0);

  assert(
    bowLobe.t00 > 0.01 && sternLobe.t00 > 0.01 && diagFace.t00 > 0.0,
    'Lentz soliton develops positive energy density lobes (T_00 > 0) at bow/stern diamond faces',
    `bow=${bowLobe.t00.toFixed(4)}, stern=${sternLobe.t00.toFixed(4)}, face=${diagFace.t00.toFixed(4)}`
  );
  assert(
    eqPinchX.t00 < -0.05 && eqPinchY.t00 < -0.05,
    'Lentz soliton retains negative equatorial pinch belt (T_00 < 0)',
    `eqX=${eqPinchX.t00.toFixed(4)}, eqY=${eqPinchY.t00.toFixed(4)}`
  );
}

console.log('\n=== 4. Backward ADM RK4 Null Geodesic Conservation & Horizon Physics ===');
{
  const superState = { bubbleRadius: 3.0, wallThickness: 2.3, warpVelocity: 2.5, metricType: 0 };
  const bridgePos = [0.0, 0.0, -0.15];

  const fwdBridge = traceRayCPU(bridgePos, [0.0, 0.0, 1.0], superState, 1.0);
  assert(
    fwdBridge.escaped && !fwdBridge.horizonCaptured && approx(fwdBridge.dopplerFactor, 3.5, 1e-4) && fwdBridge.p0Drift < 1e-4,
    'Inside Bridge forward ray at v_s=2.5c escapes with g = 1 + v_s = 3.5 and p_0 conserved',
    `g=${fwdBridge.dopplerFactor.toFixed(6)}, p0Drift=${fwdBridge.p0Drift.toExponential(2)}`
  );

  const aftBridgeSuper = traceRayCPU(bridgePos, [0.0, 0.0, -1.0], superState, 1.0);
  const aftKLen = Math.hypot(...aftBridgeSuper.k);
  assert(
    (aftBridgeSuper.horizonCaptured || aftKLen > 28.0) && !aftBridgeSuper.escaped && aftBridgeSuper.p0Drift < 1e-4,
    'Inside Bridge aft ray at v_s=2.5c hits causal horizon (captured / |k|>28) with p_0 conserved',
    `captured=${aftBridgeSuper.horizonCaptured}, |k|=${aftKLen.toFixed(2)}, p0Drift=${aftBridgeSuper.p0Drift.toExponential(2)}`
  );

  const subState = { bubbleRadius: 3.0, wallThickness: 2.3, warpVelocity: 0.8, metricType: 0 };
  const aftBridgeSub = traceRayCPU(bridgePos, [0.0, 0.0, -1.0], subState, 1.0);
  assert(
    aftBridgeSub.escaped && !aftBridgeSub.horizonCaptured && approx(aftBridgeSub.dopplerFactor, 0.2, 1e-4) && aftBridgeSub.p0Drift < 1e-4,
    'Inside Bridge subluminal aft ray at v_s=0.8c escapes with g = 1 - 0.8 = 0.2',
    `g=${aftBridgeSub.dopplerFactor.toFixed(6)}, p0Drift=${aftBridgeSub.p0Drift.toExponential(2)}`
  );

  // Off-axis Bridge ray (checks 3D Hamiltonian conservation through curved wall)
  const obliqueBridge = traceRayCPU(bridgePos, [0.35, 0.25, 0.90], superState, 1.0);
  assert(
    obliqueBridge.escaped && obliqueBridge.p0Drift < 1e-4,
    'Oblique Inside Bridge ray escapes cleanly with p_0 drift < 1e-4',
    `p0Drift=${obliqueBridge.p0Drift.toExponential(2)}, g=${obliqueBridge.dopplerFactor.toFixed(3)}`
  );

  // External Chase rays from 3/4 view across Alcubierre, Lentz, and Natário
  const chaseCam = new WarpCamera(null, PRESETS[2].camera, { cameraMode: 0 });
  const chaseMat = chaseCam.getCameraMatrices();
  let chaseAllEscaped = true;
  let chaseMaxDrift = 0.0;
  for (const mt of [0, 2]) {
    const st = { ...superState, metricType: mt };
    for (const target of [[0, 0, 0], [2.5, 0, 0], [0, 2.5, 0], [0, 0, 2.5], [-2.0, 1.5, -1.5]]) {
      const dir = [target[0] - chaseMat.pos[0], target[1] - chaseMat.pos[1], target[2] - chaseMat.pos[2]];
      const res = traceRayCPU(chaseMat.pos, dir, st, 0.0);
      if (!res.escaped || res.horizonCaptured) chaseAllEscaped = false;
      chaseMaxDrift = Math.max(chaseMaxDrift, res.p0Drift);
    }
  }
  const natCenter = traceRayCPU(
    chaseMat.pos,
    [-chaseMat.pos[0], -chaseMat.pos[1], -chaseMat.pos[2]],
    { bubbleRadius: 3.2, wallThickness: 2.4, warpVelocity: 2.0, metricType: 1 },
    0.0
  );
  chaseMaxDrift = Math.max(chaseMaxDrift, natCenter.p0Drift);
  if (!natCenter.escaped || natCenter.horizonCaptured) chaseAllEscaped = false;

  assert(
    chaseAllEscaped && chaseMaxDrift < 1e-4,
    'External Chase rays escape cleanly without getting swept past bubble & conserve p_0 < 1e-4',
    `maxP0Drift=${chaseMaxDrift.toExponential(2)}`
  );
  chaseCam.dispose();
}

console.log('\n=== 5. Telemetry, Presets, Dual-Mode WarpCamera & Assets ===');
{
  const telSuper = computeWarpTelemetry(createInitialState());
  const telSub = computeWarpTelemetry({ ...createInitialState(), warpVelocity: 0.8 });
  const telBarrier = computeWarpTelemetry({ ...createInitialState(), warpVelocity: 1.0 });
  const telBridge = computeWarpTelemetry({ ...createInitialState(), warpVelocity: 2.2 });
  const telFast = computeWarpTelemetry({ ...createInitialState(), warpVelocity: 3.5 });
  const telNat = computeWarpTelemetry({ ...createInitialState(), metricType: 1, warpVelocity: 2.0 });
  const telLentz = computeWarpTelemetry({ ...createInitialState(), metricType: 2, warpVelocity: 2.5 });

  assert(
    approx(telSuper.gForward, 3.5, 1e-9) &&
      telSuper.gAft === 0.0 &&
      telSuper.hasHorizon === true &&
      approx(telSuper.horizonAngleDeg, 2.0 * Math.acos(1 / 2.5) * (180 / Math.PI), 1e-6) &&
      telSuper.peakYork > 0 &&
      telSuper.peakEnergyDensity < 0 &&
      telSuper.metricLabel === 'Alcubierre',
    'computeWarpTelemetry matches 2.5c Alcubierre physics',
    `g=${telSuper.gForward}/${telSuper.gAft}, thetaH=${telSuper.horizonAngleDeg.toFixed(2)}deg, T00=${telSuper.peakEnergyDensity.toExponential(2)}`
  );
  assert(
    telBarrier.hasHorizon === true &&
      approx(telBarrier.horizonAngleDeg, 0.0, 1e-6) &&
      telBridge.horizonAngleDeg > 120.0 &&
      approx(telBridge.horizonAngleDeg, 2.0 * Math.acos(1 / 2.2) * (180 / Math.PI), 1e-6) &&
      telBarrier.horizonAngleDeg < telNat.horizonAngleDeg &&
      telNat.horizonAngleDeg < telBridge.horizonAngleDeg &&
      telBridge.horizonAngleDeg < telSuper.horizonAngleDeg &&
      telSuper.horizonAngleDeg < telFast.horizonAngleDeg,
    'horizonAngleDeg increases monotonically with vs >= 1.0 (0deg at 1.0c, >120deg at 2.2c)',
    `1.0c=${telBarrier.horizonAngleDeg.toFixed(1)}deg, 2.0c=${telNat.horizonAngleDeg.toFixed(1)}deg, 2.2c=${telBridge.horizonAngleDeg.toFixed(1)}deg, 2.5c=${telSuper.horizonAngleDeg.toFixed(1)}deg`
  );
  assert(
    approx(telSub.gForward, 1.8, 1e-9) &&
      approx(telSub.gAft, 0.2, 1e-9) &&
      telSub.hasHorizon === false &&
      telSub.horizonAngleDeg === 0.0 &&
      telNat.peakYork === 0.0 &&
      telNat.metricLabel === 'Natário' &&
      telLentz.metricLabel === 'Lentz',
    'computeWarpTelemetry handles subluminal, Natário (theta=0), and Lentz cleanly'
  );

  const requiredStateKeys = [
    'presetId', 'metricType', 'cameraMode', 'warpVelocity', 'bubbleRadius', 'wallThickness',
    'dopplerStrength', 'wallShimmer', 'causticGlow', 'starStreaks', 'flowSpeed',
    'exposure', 'bloomIntensity', 'anamorphicIntensity', 'skyIntensity', 'skyMode',
    'skyRotation', 'quality', 'resolutionScale', 'paused', 'autoOrbit',
  ];
  const expectedOrder = ['subluminal', 'light_barrier', 'superluminal', 'bridge', 'thin_wall', 'natario'];
  const actualOrder = PRESETS.map((p) => p.id);
  const init = createInitialState();

  assert(
    DEFAULT_STATE.presetId === 'superluminal' &&
      requiredStateKeys.every((k) => k in DEFAULT_STATE && k in init) &&
      expectedOrder.every((id, idx) => actualOrder[idx] === id && PRESETS[idx].hotkey === String(idx + 1)) &&
      getPresetById('bridge')?.params.cameraMode === 1,
    'Presets.js exports DEFAULT_STATE (superluminal) and all 6 presets in exact order 1..6',
    `order=[${actualOrder.join(', ')}]`
  );

  // Verify WarpCamera across all 6 presets + dual-mode blending + Bridge 180 deg aft look
  const cam = new WarpCamera(null, PRESETS[2].camera, { cameraMode: 0 });
  for (const preset of PRESETS) {
    cam.flyTo(preset.camera, 0, preset.params.cameraMode);
    const mat = cam.getCameraMatrices();
    checkOrthonormal(mat, `WarpCamera orthonormal on preset '${preset.id}' (mode=${preset.params.cameraMode})`);
  }

  // Verify 3/4 view geometry for preset 'superluminal' (az=34, el=15)
  cam.setImmediate({ ...PRESETS[2].camera, cameraMode: 0 });
  const chase34 = cam.getCameraMatrices();
  const zDotRight = chase34.right[2];
  const zDotMinusFwd = -chase34.forward[2];
  assert(
    chase34.pos[2] > 0 && zDotRight > 0.3 && zDotMinusFwd > 0.5,
    'External Chase az=34, el=15 frames 3/4 bow toward camera-right/front with aft tail visible',
    `posZ=${chase34.pos[2].toFixed(2)}, +Z·right=${zDotRight.toFixed(3)}, +Z·(-fwd)=${zDotMinusFwd.toFixed(3)}`
  );

  // Verify Bridge View forward (+Z) and 180 deg aft (-Z) orientations
  cam.setImmediate({ ...PRESETS[3].camera, cameraMode: 1, lookYawDeg: 0, lookPitchDeg: 0, rollDeg: 0 });
  const bridgeFwd = cam.getCameraMatrices();
  assert(
    approx(bridgeFwd.pos[2], -0.15, 1e-6) &&
      approx(bridgeFwd.forward[2], 1.0, 1e-6) &&
      approx(bridgeFwd.up[1], 1.0, 1e-6) &&
      bridgeFwd.frameBlend === 1.0,
    'Inside Bridge lookYaw=0 looks along +Z (+Y up) from flat core (0,0,-0.15)'
  );

  cam.setImmediate({ cameraMode: 1, lookYawDeg: 180, lookPitchDeg: 0, rollDeg: 0 });
  const bridgeAft = cam.getCameraMatrices();
  assert(
    approx(bridgeAft.forward[2], -1.0, 1e-6) && approx(bridgeAft.up[1], 1.0, 1e-6),
    'Inside Bridge lookYaw=180 looks cleanly aft along -Z without gimbal flip'
  );

  // Verify smooth toggleCameraMode + spring frameBlend interpolation across mid-transition
  cam.setImmediate({ ...PRESETS[2].camera, cameraMode: 0 });
  const toggledMode = cam.toggleCameraMode(false);
  assert(toggledMode === 1 && cam.getState().cameraMode === 1, 'toggleCameraMode(false) flips 0 -> 1');
  let sawIntermediate = false;
  for (let i = 0; i < 45; i++) {
    cam.update(0.03, false);
    const m = cam.getCameraMatrices();
    if (m.frameBlend > 0.05 && m.frameBlend < 0.95) {
      sawIntermediate = true;
      checkOrthonormal(m, `WarpCamera intermediate frameBlend=${m.frameBlend.toFixed(2)} orthonormal`);
      break;
    }
  }
  for (let i = 0; i < 60; i++) cam.update(0.03, { paused: false, autoOrbit: false });
  assert(
    sawIntermediate && approx(cam.getState().frameBlend, 1.0, 1e-4),
    'WarpCamera smoothly animates frameBlend from 0.0 -> 1.0 without singularities'
  );
  cam.dispose();

  // Verify syntax and shared/owned assets
  const ownedJs = [
    '../shared/assets/physicalLuts.js',
    '../shared/assets/skyLoader.js',
    '../shared/ui/simSwitcher.js',
    '../shared/simRegistry.js',
    'src/engine/WarpPhysics.js',
    'src/engine/Presets.js',
    'src/engine/WarpCamera.js',
  ];
  for (const rel of ownedJs) {
    try {
      execFileSync(process.execPath, ['--check', path.resolve(ROOT, rel)], { stdio: 'pipe' });
      assert(true, `JS syntax OK: ${rel}`);
    } catch (err) {
      assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
    }
  }

  const skyPath = path.resolve(ROOT, '../shared/assets/milkyway_4k.jpg');
  const skyExists = fs.existsSync(skyPath) && fs.statSync(skyPath).size > 1_000_000;
  assert(skyExists, 'shared/assets/milkyway_4k.jpg present and complete');

  const lutsMod = await import(path.resolve(ROOT, '../shared/assets/physicalLuts.js'));
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
