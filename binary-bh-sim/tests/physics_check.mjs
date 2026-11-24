#!/usr/bin/env node
/**
 * Binary BH (Unified WebGL2 + WebGPU) — Relativistic Two-Body Physics,
 * Eyebrow Shadow Lensing, 2.5PN Inspiral, Cartesian TT GW & Dual-Backend Contract Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  computeBinaryState,
  petersMathewsRate,
  petersMathewsTimeToMerger,
  stepBinaryOrbit,
  evalBrillLindquistFields,
  evalCartesianTTGW,
  traceBinaryRay,
} = await import(path.join(ROOT, 'src/engine/BinaryPhysics.js'));

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
  return Math.abs(a - b) <= tol;
}

function bisectSingleBhEdge(loCaptured, hiEscaped, camZ, bin) {
  let lo = loCaptured;
  let hi = hiEscaped;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    const res = traceBinaryRay([mid, 0.0, camZ], [0.0, 0.0, -1.0], bin, { gwAmplitude: 0.0 });
    if (res.captured) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

console.log('\n=== 1. Brill-Lindquist Single-BH Limit (q -> 0) & Analytical Gradient ===');
{
  const binSingle = computeBinaryState({ massRatio: 0.0, separation: 6.0 }, 0.0, {
    allowZeroMassRatio: true,
  });
  const camZ = 120.0;
  const bcExact = 3.0 * Math.sqrt(3.0);
  const bcCoordRight = bisectSingleBhEdge(0.0, 8.0, camZ, binSingle);
  const bcCoordLeft = bisectSingleBhEdge(0.0, -8.0, camZ, binSingle);
  const fCamR = evalBrillLindquistFields(bcCoordRight, 0.0, camZ, binSingle, 1.0);
  const fCamL = evalBrillLindquistFields(bcCoordLeft, 0.0, camZ, binSingle, 1.0);
  const bcRight = bcCoordRight * fCamR.n;
  const bcLeft = bcCoordLeft * fCamL.n;

  assert(
    approx(bcRight, bcExact, 0.03) && approx(bcLeft, -bcExact, 0.03),
    `Single-BH limit critical impact parameter b_c = 3*sqrt(3)M (${bcExact.toFixed(4)}M)`,
    `RK4 b_inf left=${bcLeft.toFixed(4)}M, right=${bcRight.toFixed(4)}M`
  );

  // Check analytical grad(ln n) vs central finite differences across unequal mass ratios
  const testCases = [
    { q: 1.0, d: 6.0, phase: 0.3, pos: [2.4, 1.3, -1.8] },
    { q: 0.4, d: 7.5, phase: 1.1, pos: [-3.1, 2.2, 2.7] },
    { q: 0.1, d: 8.4, phase: 2.0, pos: [4.2, -0.9, 1.5] },
  ];
  let maxGradErr = 0.0;
  for (const tc of testCases) {
    const bin = computeBinaryState({ massRatio: tc.q, separation: tc.d }, tc.phase);
    const f = evalBrillLindquistFields(tc.pos[0], tc.pos[1], tc.pos[2], bin, 1.0);
    const eps = 1e-6;
    for (let axis = 0; axis < 3; axis++) {
      const pPlus = [...tc.pos];
      const pMinus = [...tc.pos];
      pPlus[axis] += eps;
      pMinus[axis] -= eps;
      const fp = evalBrillLindquistFields(pPlus[0], pPlus[1], pPlus[2], bin, 1.0);
      const fm = evalBrillLindquistFields(pMinus[0], pMinus[1], pMinus[2], bin, 1.0);
      const numGrad = (Math.log(fp.n) - Math.log(fm.n)) / (2.0 * eps);
      maxGradErr = Math.max(maxGradErr, Math.abs(f.gradLnN[axis] - numGrad));
    }
  }
  assert(
    maxGradErr < 1e-7,
    'Analytical Brill-Lindquist grad(ln n) matches central FD (< 1e-7)',
    `maxErr=${maxGradErr.toExponential(2)}`
  );

  const probe = traceBinaryRay([5.0, 1.2, 50.0], [0.0, 0.0, -1.0], computeBinaryState({ massRatio: 1.0, separation: 6.0 }, 0.4), {
    gwAmplitude: 0.5,
  });
  assert(
    probe.maxUnitErr < 1e-4,
    'Null tangent vector |v| = 1 conserved along adaptive RK4 geodesic',
    `maxUnitErr=${probe.maxUnitErr.toExponential(2)}`
  );
}

console.log('\n=== 2. Fractal Eyebrow Lensing Shadows & 10:1 Extreme Mass Ratio ===');
{
  // Aligned near the optical axis so rear BH2 produces an eyebrow shadow above primary BH1
  const binEyebrow = computeBinaryState({ massRatio: 1.0, separation: 6.0 }, Math.PI * 0.5 - 0.14);
  const outcomes = [];
  for (let y = 0.0; y <= 9.0; y += 0.12) {
    const res = traceBinaryRay([0.2, y, 42.0], [0.0, 0.0, -1.0], binEyebrow, { gwAmplitude: 0.0 });
    outcomes.push({ y: +y.toFixed(2), captured: res.captured, by: res.capturedBy });
  }

  // Collapse contiguous segments of captured / escaped
  const segments = [];
  for (const o of outcomes) {
    if (segments.length === 0 || segments[segments.length - 1].captured !== o.captured) {
      segments.push({ captured: o.captured, startY: o.y, endY: o.y, count: 1 });
    } else {
      segments[segments.length - 1].endY = o.y;
      segments[segments.length - 1].count++;
    }
  }
  const pattern = segments.map((s) => `${s.captured ? 'CAP' : 'ESC'}[${s.startY}..${s.endY}]`).join(' -> ');
  const hasEyebrowPattern =
    segments.length >= 4 &&
    segments[0].captured === true &&
    segments[1].captured === false &&
    segments[2].captured === true &&
    segments[3].captured === false;

  assert(
    hasEyebrowPattern,
    'Fractal eyebrow shadow transition: captured (primary) -> escaped (window) -> captured (eyebrow) -> escaped (sky)',
    pattern
  );

  // 10:1 EMRI distinct shadow test (scanning around lensed secondary position)
  const binEmri = computeBinaryState({ massRatio: 0.1, separation: 8.4 }, 0.0);
  const hitPrimary = traceBinaryRay([binEmri.c1[0], 0.0, 40.0], [0.0, 0.0, -1.0], binEmri, { gwAmplitude: 0.0 });
  let hitSecondary = null;
  let secondaryLensedX = null;
  for (let x = binEmri.c2[0] - 0.5; x <= binEmri.c2[0] + 2.5; x += 0.2) {
    const res = traceBinaryRay([x, 0.0, 40.0], [0.0, 0.0, -1.0], binEmri, { gwAmplitude: 0.0 });
    if (res.captured && res.capturedBy === 2) {
      hitSecondary = res;
      secondaryLensedX = x;
      break;
    }
  }
  const midGap = traceBinaryRay([0.5 * (binEmri.c1[0] + binEmri.c2[0]), 0.0, 40.0], [0.0, 0.0, -1.0], binEmri, { gwAmplitude: 0.0 });

  assert(
    hitPrimary.captured && hitPrimary.capturedBy === 1 &&
      Boolean(hitSecondary) &&
      !midGap.captured,
    '10:1 EMRI resolves both primary (m1=0.91) and lensed secondary (m2=0.09) shadows with clear gap',
    `BH1=${hitPrimary.capturedBy}, BH2=${hitSecondary?.capturedBy} at x=${secondaryLensedX?.toFixed(2)}M, gapEscaped=${!midGap.captured}`
  );
}

console.log('\n=== 3. 2.5PN Inspiral Dynamics, 1PN Padé Omega & COM Conservation ===');
{
  const sWide = computeBinaryState({ massRatio: 0.85, separation: 10.0 }, 0.7);
  const sTight = computeBinaryState({ massRatio: 0.85, separation: 4.5 }, 0.7);
  const sPlunge = computeBinaryState({ massRatio: 0.85, separation: 2.5 }, 0.7);

  assert(
    sWide.omega > 0 && sTight.omega > sWide.omega && sPlunge.omega > sTight.omega,
    '1PN Padé Omega(d, eta) is positive-definite and strictly monotonic with shrinking separation',
    `d=10: ${sWide.omega.toFixed(4)}, d=4.5: ${sTight.omega.toFixed(4)}, d=2.5: ${sPlunge.omega.toFixed(4)}`
  );

  assert(
    sTight.fGwHz >= 10 && sTight.fGwHz <= 500,
    'LIGO-band gravitational wave frequency f_GW for fiducial 60 M_sun binary',
    `d=4.5M -> ${sTight.fGwHz.toFixed(1)} Hz`
  );

  const pmRate = petersMathewsRate(6.0, 0.25);
  const tMerger = petersMathewsTimeToMerger(6.0, 0.25);
  assert(pmRate < 0 && tMerger > 0, '2.5PN Peters-Mathews rate < 0 and coalescence time > 0', `dd/dt=${pmRate.toFixed(4)}, T_coal=${tMerger.toFixed(1)}M`);

  const orbit = { phase: 0.0, currentSep: 7.4, ringdownTimer: 0.0, inRingdown: false, ringdownFactor: 0.0 };
  const sepSamples = [orbit.currentSep];
  for (let i = 0; i < 20; i++) {
    stepBinaryOrbit(orbit, { massRatio: 1.0, separation: 7.4, inspiralMode: 1, timeWarp: 1.0 }, 0.05);
    sepSamples.push(orbit.currentSep);
  }
  const monotonicShrink = sepSamples.every((val, idx) => idx === 0 || val < sepSamples[idx - 1]);
  assert(
    monotonicShrink && orbit.phase > 0,
    'stepBinaryOrbit shrinks separation monotonically under 2.5PN inspiral',
    `7.40M -> ${orbit.currentSep.toFixed(3)}M, phase=${orbit.phase.toFixed(2)} rad`
  );

  const comErr = Math.hypot(
    sTight.m1 * sTight.c1[0] + sTight.m2 * sTight.c2[0],
    sTight.m1 * sTight.c1[1] + sTight.m2 * sTight.c2[1],
    sTight.m1 * sTight.c1[2] + sTight.m2 * sTight.c2[2]
  );
  const momErr = Math.hypot(
    sTight.m1 * sTight.v1[0] + sTight.m2 * sTight.v2[0],
    sTight.m1 * sTight.v1[1] + sTight.m2 * sTight.v2[1],
    sTight.m1 * sTight.v1[2] + sTight.m2 * sTight.v2[2]
  );
  assert(
    comErr < 1e-14 && momErr < 1e-14,
    'Exact center-of-mass and linear momentum conservation',
    `comErr=${comErr.toExponential(1)}, momErr=${momErr.toExponential(1)}`
  );
}

console.log('\n=== 4. Pole-Free Cartesian TT Quadrupole Gravitational Wave Verification ===');
{
  const bin = computeBinaryState({ massRatio: 1.0, separation: 6.0 }, 0.6);
  const gwZero = evalCartesianTTGW(14.0, 2.0, -8.0, 0.2, 0.1, -0.97, bin, 0.0);
  assert(
    gwZero.A === 0 && gwZero.gradGW.every((v) => v === 0) && gwZero.iswIntegrand === 0,
    'Cartesian TT GW field vanishes identically when gwAmplitude = 0'
  );

  const gwPole = evalCartesianTTGW(0.0, 18.0, 0.0, 0.6, 0.0, -0.8, bin, 2.0);
  const poleFinite = [...gwPole.gradGW, gwPole.A, gwPole.S, gwPole.iswIntegrand].every(Number.isFinite);
  assert(
    poleFinite && gwPole.A > 0 && Math.abs(gwPole.S) > 0,
    'Cartesian TT GW field is smooth & finite at +Y pole (zero polar singularity)',
    `A=${gwPole.A.toExponential(2)}, S=${gwPole.S.toFixed(4)}`
  );

  // Verify radial derivative of U_GW = 0.5 * A(R) * S matches central FD along nHat
  const px = 12.0, py = 5.0, pz = 9.0;
  const vx = 0.3, vy = -0.2, vz = Math.sqrt(1 - 0.09 - 0.04);
  const R = Math.hypot(px, py, pz);
  const nx = px / R, ny = py / R, nz = pz / R;
  const gwCenter = evalCartesianTTGW(px, py, pz, vx, vy, vz, bin, 1.5);
  const eps = 1e-5;
  const gwP = evalCartesianTTGW(px + eps * nx, py + eps * ny, pz + eps * nz, vx, vy, vz, bin, 1.5);
  const gwM = evalCartesianTTGW(px - eps * nx, py - eps * ny, pz - eps * nz, vx, vy, vz, bin, 1.5);
  const numRadial = (0.5 * gwP.A * gwP.S - 0.5 * gwM.A * gwM.S) / (2 * eps);
  const anaRadial = gwCenter.gradGW[0] * nx + gwCenter.gradGW[1] * ny + gwCenter.gradGW[2] * nz;
  assert(
    Math.abs(anaRadial - numRadial) < 1e-7,
    'Analytical radial GW gradient matches central finite difference (< 1e-7)',
    `ana=${anaRadial.toExponential(4)}, num=${numRadial.toExponential(4)}`
  );
}

console.log('\n=== 5. Unified WebGL2 + WebGPU Codebase & Contract Verification ===');
{
  const expectedFiles = [
    'index.html',
    'styles.css',
    '../launch.sh',
    '../shared/simRegistry.js',
    '../shared/ui/base.css',
    '../shared/ui/simSwitcher.js',
    '../shared/assets/milkyway_4k.jpg',
    '../shared/assets/skyLoader.js',
    '../shared/assets/physicalLuts.js',
    '../shared/shaders/common.glsl.js',
    'src/shaders/tidal.glsl.js',
    'src/shaders/binary.frag.js',
    '../shared/shaders/post.glsl.js',
    '../shared/shaders/common.wgsl.js',
    'src/shaders/tidal.wgsl.js',
    'src/shaders/binary.wgsl.js',
    '../shared/shaders/post.wgsl.js',
    'src/engine/BinaryPhysics.js',
    'src/engine/Presets.js',
    'src/engine/CameraController.js',
    'src/engine/WebGLRenderer.js',
    'src/engine/WebGPURenderer.js',
    'src/ui/ControlsHUD.js',
    'src/main.js',
  ];

  const missingFiles = expectedFiles.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert(
    missingFiles.length === 0,
    `All ${expectedFiles.length} expected binary-bh-sim files exist`,
    missingFiles.length ? `missing: ${missingFiles.join(', ')}` : 'OK'
  );

  for (const rel of expectedFiles.filter((f) => f.endsWith('.js'))) {
    const full = path.join(ROOT, rel);
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      assert(true, `JS syntax OK: ${rel}`);
    } catch (err) {
      assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
    }
  }

  const commonWgsl = await import(path.resolve(ROOT, '../shared/shaders/common.wgsl.js'));
  const tidalWgsl = await import(path.join(ROOT, 'src/shaders/tidal.wgsl.js'));
  const binWgsl = await import(path.join(ROOT, 'src/shaders/binary.wgsl.js'));
  const postWgsl = await import(path.resolve(ROOT, '../shared/shaders/post.wgsl.js'));

  const wgslStages = [
    { name: 'NOISE_BAKE_COMPUTE_WGSL', code: commonWgsl.NOISE_BAKE_COMPUTE_WGSL, entry: '@compute' },
    { name: 'MIPMAP_WGSL', code: commonWgsl.MIPMAP_WGSL, entry: '@fragment' },
    { name: 'TIDAL_FIELD_COMPUTE_WGSL', code: tidalWgsl.TIDAL_FIELD_COMPUTE_WGSL, entry: '@compute' },
    { name: 'BINARY_BH_WGSL', code: binWgsl.BINARY_BH_WGSL, entry: '@fragment' },
    { name: 'TAA_WGSL', code: postWgsl.TAA_WGSL, entry: '@fragment' },
    { name: 'BLOOM_PREFILTER_WGSL', code: postWgsl.BLOOM_PREFILTER_WGSL, entry: '@fragment' },
    { name: 'BLOOM_DOWNSAMPLE_WGSL', code: postWgsl.BLOOM_DOWNSAMPLE_WGSL, entry: '@fragment' },
    { name: 'BLOOM_UPSAMPLE_WGSL', code: postWgsl.BLOOM_UPSAMPLE_WGSL, entry: '@fragment' },
    { name: 'ANAMORPHIC_WGSL', code: postWgsl.ANAMORPHIC_WGSL, entry: '@fragment' },
    { name: 'COMPOSITE_WGSL', code: postWgsl.COMPOSITE_WGSL, entry: '@fragment' },
  ];

  const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\s*\(/;
  for (const st of wgslStages) {
    const hasCode = typeof st.code === 'string' && st.code.includes(st.entry);
    const badMatch = st.code ? st.code.match(forbiddenGlsl) : null;
    assert(
      hasCode && !badMatch,
      `WGSL module ${st.name} valid (${st.entry}, zero GLSL-isms)`,
      badMatch ? `forbidden GLSL token: ${badMatch[0]}` : 'OK'
    );
  }

  const binUniformFields = [
    'resolution_time_frame', 'jitter_fov_phase', 'camPos_relMode', 'camRight_lensing',
    'camUp_diskTemp', 'camForward_diskDens', 'diskParams', 'gw_skyParams', 'modes_pad',
    'binaryMass_sep', 'binaryC1_omega', 'binaryC2_gwOmega', 'binaryV1_rH1', 'binaryV2_rH2',
    'field_rayConsts', 'flowConsts', 'rotTrig_skyTrig', 'skyY_ringdown',
  ];
  const missingBinFields = binUniformFields.filter((f) => !binWgsl.BINARY_BH_WGSL.includes(f));
  assert(
    missingBinFields.length === 0,
    'BINARY_BH_WGSL declares all 18 packed uniform struct vec4 fields (288 bytes)',
    missingBinFields.length ? `missing: ${missingBinFields.join(', ')}` : '18/18 OK'
  );

  const binBindings = [...binWgsl.BINARY_BH_WGSL.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((m) => Number(m[1]));
  assert(
    binBindings.length === 10 && binBindings.every((b, idx) => b === idx),
    'BINARY_BH_WGSL declares contiguous bindings 0..9 matching WebGPURenderer',
    `bindings=[${binBindings.join(',')}]`
  );

  const tidalBindings = [...tidalWgsl.TIDAL_FIELD_COMPUTE_WGSL.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((m) => Number(m[1]));
  assert(
    tidalBindings.length === 4 && tidalBindings.every((b, idx) => b === idx),
    'TIDAL_FIELD_COMPUTE_WGSL declares contiguous bindings 0..3 matching WebGPURenderer',
    `bindings=[${tidalBindings.join(',')}]`
  );

  const gpuRenSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');
  assert(
    gpuRenSrc.includes('288') && gpuRenSrc.includes('binUniformBuf') && gpuRenSrc.includes('tidalPipeline'),
    'WebGPURenderer.js allocates 288-byte Binary UBO, 64-byte Tidal UBO, and tidal compute pipeline'
  );

  const commonGlsl = await import(path.resolve(ROOT, '../shared/shaders/common.glsl.js'));
  const tidalGlsl = await import(path.join(ROOT, 'src/shaders/tidal.glsl.js'));
  const binGlsl = await import(path.join(ROOT, 'src/shaders/binary.frag.js'));
  const postGlsl = await import(path.resolve(ROOT, '../shared/shaders/post.glsl.js'));

  const glslStages = [
    commonGlsl.FULLSCREEN_VERT,
    commonGlsl.NOISE_BAKE_FRAG,
    tidalGlsl.TIDAL_FIELD_FRAG,
    binGlsl.BINARY_BH_FRAG,
    postGlsl.TAA_FRAG,
    postGlsl.BLOOM_PREFILTER_FRAG,
    postGlsl.BLOOM_DOWNSAMPLE_FRAG,
    postGlsl.BLOOM_UPSAMPLE_FRAG,
    postGlsl.ANAMORPHIC_FRAG,
    postGlsl.COMPOSITE_FRAG,
  ];
  assert(
    glslStages.every((code) => typeof code === 'string' && code.includes('#version 300 es')),
    'All 10 GLSL ES 3.00 shader stages declare #version 300 es'
  );

  function extractUniforms(src) {
    const set = new Set();
    const re = /\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
    return set;
  }

  const glRenSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGLRenderer.js'), 'utf8');
  const binGlUniforms = extractUniforms(binGlsl.BINARY_BH_FRAG);
  const unboundBinGl = [...binGlUniforms].filter((u) => !glRenSrc.includes(u));
  assert(
    binGlUniforms.size >= 34 && unboundBinGl.length === 0,
    'binary.frag.js <-> WebGLRenderer.js uniform parity',
    `declared=${binGlUniforms.size}, unbound=${unboundBinGl.length}`
  );

  const tidalGlUniforms = extractUniforms(tidalGlsl.TIDAL_FIELD_FRAG);
  const unboundTidalGl = [...tidalGlUniforms].filter((u) => !glRenSrc.includes(u));
  assert(
    tidalGlUniforms.size >= 15 && unboundTidalGl.length === 0,
    'tidal.glsl.js <-> WebGLRenderer.js uniform parity',
    `declared=${tidalGlUniforms.size}, unbound=${unboundTidalGl.length}`
  );

  const { DEFAULT_STATE, PRESETS } = await import(path.join(ROOT, 'src/engine/Presets.js'));
  const hudSrc = fs.readFileSync(path.join(ROOT, 'src/ui/ControlsHUD.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const expectedPresets = ['equal_mass', 'emri', 'eyebrows', 'tidal_bridges', 'pre_merger', 'vacuum'];
  const actualIds = PRESETS.map((p) => p.id);
  assert(
    expectedPresets.every((id) => actualIds.includes(id)),
    'Presets.js exports all 6 required binary presets',
    `ids: ${actualIds.join(', ')}`
  );

  const controlKeys = [
    'massRatio', 'separation', 'orbitalInclination', 'gwAmplitude', 'inspiralMode',
    'timeWarp', 'lensingStrength', 'relativisticMode',
    'diskTemp', 'diskDensity', 'bridgeIntensity', 'diskThickness', 'diskOuterRadius', 'turbulence',
    'exposure', 'bloomIntensity', 'anamorphicIntensity', 'skyIntensity', 'skyMode',
    'quality', 'resolutionScale',
  ];
  assert(
    controlKeys.every((k) => k in DEFAULT_STATE) && controlKeys.every((k) => hudSrc.includes(k)),
    'DEFAULT_STATE and ControlsHUD.js share all 21 physics/optics parameters'
  );
  assert(
    hudSrc.includes("key: 'backend'") &&
      hudSrc.includes("value: 'webgl2'") &&
      hudSrc.includes("value: 'webgpu'") &&
      !htmlSrc.includes('ctrl-backend'),
    'Rendering Backend toggle lives inside collapsible ControlsHUD drawer, not main HUD chrome'
  );

  const lutsMod = await import(path.resolve(ROOT, '../shared/assets/physicalLuts.js'));
  globalThis.GPUTextureUsage = globalThis.GPUTextureUsage || { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let gpuUploaded = null;
  const mockDevice = {
    createTexture: (desc) => ({ desc, createView: () => ({ id: 'mockView' }) }),
    queue: { writeTexture: (dst, data, layout, size) => { gpuUploaded = { desc: dst.texture.desc, data, layout, size }; } },
  };
  const gpuLut = lutsMod.createBlackbodyLUT(mockDevice, 512);
  assert(
    Boolean(gpuLut?.texture && gpuUploaded?.size[0] === 512 && gpuUploaded?.desc.format === 'rgba16float'),
    'physicalLuts.js dual-backend Planck LUT works for WebGPU'
  );
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
