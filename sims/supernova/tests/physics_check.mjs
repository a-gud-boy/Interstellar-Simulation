#!/usr/bin/env node
/**
 * Supernova Remnant Simulator — Astrophysical Blast-Wave Scaling, Radiative-Transfer
 * Normalization, Origin-Safe Camera Fly-Through, Syntax, and GLSL/WGSL Contract Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  SEDOV_CONSTANTS,
  evalSedovTaylor,
  evalHG,
  evalDualHG,
  evalWrenningeMultiScatter,
  evalSpeciesProfile,
  estimateOpticalDepth,
  computeSupernovaTelemetry,
} = await import(path.join(ROOT, 'src/engine/Physics.js'));

const {
  DEFAULT_STATE,
  PRESETS,
  getPresetById,
  createInitialState,
} = await import(path.join(ROOT, 'src/engine/Presets.js'));

const { SupernovaCamera } = await import(path.join(ROOT, 'src/engine/CameraController.js'));

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
  const { pos, right, up, forward, basis, fovY } = mat;
  const allVals = [...pos, ...right, ...up, ...forward, ...basis, fovY];
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

console.log('\n=== 1. Sedov–Taylor Blast-Wave & Free-Expansion Kinematics ===');
{
  // Late-age Sedov-Taylor self-similar t^(2/5) scaling & v = 0.4 * R / t
  const stLate1 = evalSedovTaylor(20000);
  const stLate2 = evalSedovTaylor(200000);
  const ratioR = stLate2.shockRadiusLy / stLate1.shockRadiusLy;
  const expectedRatio = Math.pow(10.0, 0.4);
  const ratioV = (stLate2.expansionVelocityCms * (200000 * SEDOV_CONSTANTS.YR_S)) / stLate2.shockRadiusCm;

  assert(
    Math.abs(ratioR - expectedRatio) / expectedRatio < 0.01 &&
      Math.abs(ratioV - 0.4) < 0.005,
    'Sedov–Taylor late-age scaling satisfies R ~ t^(2/5) and v_sh = (2/5)*R_sh/t (< 1%)',
    `R_ratio=${ratioR.toFixed(5)} (exp ${expectedRatio.toFixed(5)}), v*t/R=${ratioV.toFixed(5)}`
  );

  // Young age free-expansion limit: R_sh -> v_ej * t, v_sh -> v_ej
  const stYoung = evalSedovTaylor(10);
  const vEjKms = SEDOV_CONSTANTS.V_EJ_CMS / 1e5;
  assert(
    Math.abs(stYoung.expansionVelocityKms - vEjKms) / vEjKms < 0.02 &&
      stYoung.regimeLabel === 'Free Expansion',
    'Smooth free-expansion limit at t = 10 yr matches v_ej (~5790 km/s)',
    `v=${stYoung.expansionVelocityKms.toFixed(1)} km/s, v_ej=${vEjKms.toFixed(1)} km/s, regime=${stYoung.regimeLabel}`
  );

  // Exact analytical derivative parity: v_sh = dR_sh/dt across all regimes
  let maxDerivRelErr = 0.0;
  for (const ageYr of [25, 350, 970, 5000, 15000]) {
    const h = ageYr * 1e-4;
    const sp = evalSedovTaylor(ageYr + h);
    const sm = evalSedovTaylor(ageYr - h);
    const s0 = evalSedovTaylor(ageYr);
    const fdVel = (sp.shockRadiusCm - sm.shockRadiusCm) / (2.0 * h * SEDOV_CONSTANTS.YR_S);
    const relErr = Math.abs(s0.expansionVelocityCms - fdVel) / Math.max(s0.expansionVelocityCms, 1.0);
    maxDerivRelErr = Math.max(maxDerivRelErr, relErr);
  }
  assert(
    maxDerivRelErr < 1e-6,
    'Analytical blast-wave velocity v_sh equals central FD dR_sh/dt (< 1e-6 rel)',
    `maxRelErr=${maxDerivRelErr.toExponential(2)}`
  );

  // Strict monotonicity of R_sh (increasing), v_sh (decreasing), and T_shock (decreasing)
  const ages = [20, 150, 500, 970, 4000, 15000];
  const samples = ages.map((a) => evalSedovTaylor(a));
  let monoOk = true;
  for (let i = 1; i < samples.length; i++) {
    if (
      !(samples[i].shockRadiusLy > samples[i - 1].shockRadiusLy) ||
      !(samples[i].expansionVelocityKms < samples[i - 1].expansionVelocityKms) ||
      !(samples[i].shockTempK < samples[i - 1].shockTempK)
    ) {
      monoOk = false;
    }
  }
  assert(
    monoOk,
    'Shock radius increases strictly while expansion velocity & post-shock temp decrease strictly with age'
  );
}

console.log('\n=== 2. Dual-Lobe Henyey–Greenstein Normalization & Singularity Guards ===');
{
  const N = 60000;
  const dMu = 2.0 / N;
  let maxNormErr = 0.0;
  for (const g of [-0.95, -0.6, 0.0, 0.45, 0.78, 0.95]) {
    let integralSingle = 0.0;
    let integralDual = 0.0;
    for (let i = 0; i < N; i++) {
      const mu = -1.0 + (i + 0.5) * dMu;
      integralSingle += 2.0 * Math.PI * evalHG(mu, g) * dMu;
      integralDual += 2.0 * Math.PI * evalDualHG(mu, g) * dMu;
    }
    maxNormErr = Math.max(maxNormErr, Math.abs(integralSingle - 1.0), Math.abs(integralDual - 1.0));
  }
  assert(
    maxNormErr < 1e-4,
    'Dual-lobe & single-lobe Henyey–Greenstein 4*pi spherical integrals equal 1.0 across g in [-0.95, 0.95]',
    `maxErr=${maxNormErr.toExponential(2)}`
  );

  // Extreme input singularity clamping (g = +-2, mu = +-2)
  const extremes = [];
  for (const g of [-2.0, -1.0, 0.0, 1.0, 2.0]) {
    for (const mu of [-2.0, -1.0, 0.0, 1.0, 2.0]) {
      const val = evalDualHG(mu, g);
      extremes.push(val);
    }
  }
  assert(
    extremes.every((v) => Number.isFinite(v) && v > 0.0) &&
      evalDualHG(1.0, 0.8) > evalDualHG(-1.0, 0.8) &&
      evalDualHG(-1.0, -0.8) > evalDualHG(1.0, -0.8),
    'Dual-lobe HG clamps singularities cleanly and preserves forward/backscatter anisotropy'
  );
}

console.log('\n=== 3. Wrenninge Multi-Octave Scattering & Optical Depth Monotonicity ===');
{
  const taus = [0.0, 0.5, 2.0, 6.0, 20.0, 50.0];
  let wrenOk = true;
  for (const g of [-0.95, 0.0, 0.78]) {
    for (const mu of [-1.0, 0.0, 1.0]) {
      let prev = Infinity;
      for (const tau of taus) {
        const val = evalWrenningeMultiScatter(tau, mu, g);
        if (!Number.isFinite(val) || val <= 0.0 || val >= prev) {
          wrenOk = false;
        }
        prev = val;
      }
    }
  }
  const singleHighTau = Math.exp(-6.0) * evalDualHG(0.5, 0.78);
  const wrenHighTau = evalWrenningeMultiScatter(6.0, 0.5, 0.78);
  assert(
    wrenOk && wrenHighTau > singleHighTau * 5.0,
    'Wrenninge 4-octave scattering is positive, finite, strictly monotonic in tau, and penetrates dense Bok cores',
    `tau=6 ratio=${(wrenHighTau / singleHighTau).toFixed(1)}x`
  );

  // Optical depth & transmittance monotonicity vs dustOpacity and bokDensity
  const opacities = [0.0, 0.4, 0.8, 1.6, 2.5];
  const tausOut = opacities.map((d) => estimateOpticalDepth({ ...DEFAULT_STATE, dustOpacity: d }));
  let tauMono = true;
  for (let i = 1; i < tausOut.length; i++) {
    if (
      !(tausOut[i].opticalDepth > tausOut[i - 1].opticalDepth) ||
      !(tausOut[i].transmittance < tausOut[i - 1].transmittance)
    ) {
      tauMono = false;
    }
  }
  const bokLow = estimateOpticalDepth({ ...DEFAULT_STATE, bokDensity: 0.1 });
  const bokHigh = estimateOpticalDepth({ ...DEFAULT_STATE, bokDensity: 1.8 });
  const profSample = evalSpeciesProfile(0.95, DEFAULT_STATE);
  assert(
    tauMono &&
      bokHigh.opticalDepth > bokLow.opticalDepth &&
      tausOut[0].transmittance <= 1.0 &&
      profSample.hAlphaShell > 0.5,
    'Optical depth increases monotonically and transmittance decreases monotonically with dust/Bok density',
    `tau(0)=${tausOut[0].opticalDepth.toFixed(3)}, tau(2.5)=${tausOut[4].opticalDepth.toFixed(3)}`
  );
}

console.log('\n=== 4. Presets, Telemetry & Origin-Safe Camera Fly-Through (r -> 0) ===');
{
  const requiredStateKeys = [
    'presetId', 'shockAge', 'bipolarPower', 'jetPower', 'ringStrength', 'curtainWeight',
    'rtTurbulence', 'dustOpacity', 'hgAnisotropy',
    'starLuminosity', 'paletteMode', 'filamentContrast', 'cavityGlow',
    'bokDensity', 'shellThickness', 'emissionGain', 'expansionSpeed',
    'exposure', 'bloomIntensity', 'anamorphicIntensity', 'skyIntensity',
    'skyMode', 'skyRotation', 'quality', 'resolutionScale', 'paused', 'autoOrbit', 'evolving',
  ];
  const expectedOrder = ['breakout', 'sn1987a', 'crab', 'veil', 'hubble_sho', 'pulsar_cathedral'];
  const actualOrder = PRESETS.map((p) => p.id);
  const init = createInitialState();

  assert(
    DEFAULT_STATE.presetId === 'breakout' &&
      requiredStateKeys.every((k) => k in DEFAULT_STATE && k in init) &&
      expectedOrder.every((id, idx) => actualOrder[idx] === id && PRESETS[idx].hotkey === String(idx + 1)) &&
      getPresetById('hubble_sho')?.params.paletteMode === 0 &&
      getPresetById('breakout')?.params.paletteMode === 1 &&
      getPresetById('pulsar_cathedral')?.params.paletteMode === 2,
    'Presets.js exports DEFAULT_STATE (breakout) and all 6 presets in exact order 1..6 across 3 palettes',
    `order=[${actualOrder.join(', ')}]`
  );

  const stBreakout = evalSedovTaylor(0.002);
  const telChandra = computeSupernovaTelemetry({ ...init, paletteMode: 2 });
  assert(
    stBreakout.regimeLabel === 'Shock Breakout' &&
      stBreakout.shockRadiusLy > 0 &&
      stBreakout.shockRadiusLy < 0.01 &&
      telChandra.paletteLabel === 'Chandra / JWST',
    'Shock Breakout epoch & Chandra / JWST palette telemetry evaluate cleanly',
    `regime=${stBreakout.regimeLabel}, R=${stBreakout.shockRadiusLy.toExponential(2)} ly`
  );

  // Verify finite telemetry across all 6 presets
  let telAllOk = true;
  for (const preset of PRESETS) {
    const tel = computeSupernovaTelemetry({ ...init, ...preset.params });
    if (
      !Number.isFinite(tel.shockRadiusLy) || tel.shockRadiusLy <= 0 ||
      !Number.isFinite(tel.expansionVelocityKms) || tel.expansionVelocityKms <= 0 ||
      !Number.isFinite(tel.opticalDepth) || tel.opticalDepth <= 0 ||
      !Number.isFinite(tel.centralTempK) || tel.centralTempK <= 0 ||
      !Number.isFinite(tel.shockTempK) || tel.shockTempK <= 0
    ) {
      telAllOk = false;
    }
  }
  assert(telAllOk, 'computeSupernovaTelemetry produces finite positive astrophysics across all 6 presets');

  const cam = new SupernovaCamera(null, PRESETS[0].camera);
  for (const preset of PRESETS) {
    cam.flyTo(preset.camera, 0);
    checkOrthonormal(cam.getCameraMatrices(), `SupernovaCamera orthonormal on preset '${preset.id}'`);
  }

  // Exact origin r = 0 and near-origin r = 1e-9 safety
  cam.setImmediate({ pos: [0.0, 0.0, 0.0], azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, lookYawDeg: 0, lookPitchDeg: 0 });
  const originMat = cam.getCameraMatrices();
  checkOrthonormal(originMat, 'SupernovaCamera orthonormal & NaN-free at exact origin r = 0');

  cam.setImmediate({ pos: [1e-9, -1e-9, 1e-9], azimuthDeg: 45, elevationDeg: 85, rollDeg: 15, lookYawDeg: 35, lookPitchDeg: -20 });
  checkOrthonormal(cam.getCameraMatrices(), 'SupernovaCamera orthonormal near pole & r = 1e-9');

  // Continuous W fly-through straight through (0, 0, 0) from +4.0 to -4.0
  cam.setImmediate({ distance: 4.0, pivot: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, lookYawDeg: 0, lookPitchDeg: 0 });
  let crossedOrigin = false;
  let allFlyOrtho = true;
  let minRSeen = Infinity;
  for (let i = 0; i < 80; i++) {
    cam.flyStep(0.1);
    cam.update(0.05, false);
    const m = cam.getCameraMatrices();
    minRSeen = Math.min(minRSeen, Math.hypot(...m.pos));
    if (m.pos[2] < -1.0) crossedOrigin = true;
    const allFin = [...m.pos, ...m.right, ...m.up, ...m.forward].every(Number.isFinite);
    if (!allFin || Math.abs(Math.hypot(...m.right) - 1) > 1e-5) {
      allFlyOrtho = false;
    }
  }
  assert(
    crossedOrigin && allFlyOrtho && minRSeen < 0.6,
    'W fly-through passes smoothly from +Z through (0, 0, 0) to -Z with zero clipping or NaNs',
    `minR=${minRSeen.toFixed(3)}, finalZ=${cam.getCameraMatrices().pos[2].toFixed(2)}`
  );
  cam.dispose();
}

console.log('\n=== 5. Syntax, GLSL/WGSL Uniform Parity, Uniformity & Asset Contracts ===');
{
  // node --check on ALL .js files under supernova-sim/src
  const jsFiles = collectJsFiles(path.join(ROOT, 'src')).sort();
  assert(jsFiles.length >= 9, `Discovered ${jsFiles.length} JS modules under sims/supernova/src/`);
  for (const fullPath of jsFiles) {
    const rel = path.relative(ROOT, fullPath);
    try {
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
      assert(true, `JS syntax OK: ${rel}`);
    } catch (err) {
      assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
    }
  }

  // Parse SupernovaUniforms struct in supernova.frag.js vs supernova.wgsl.js
  const glslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/supernova.frag.js'), 'utf8');
  const wgslSrc = fs.readFileSync(path.join(ROOT, 'src/shaders/supernova.wgsl.js'), 'utf8');
  const glRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGLRenderer.js'), 'utf8');
  const gpuRendererSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');

  const glslStructMatch = glslSrc.match(/layout\(std140\)\s+uniform\s+SupernovaUniforms\s*\{([\s\S]*?)\}\s*u\s*;/);
  const wgslStructMatch = wgslSrc.match(/struct\s+SupernovaUniforms\s*\{([\s\S]*?)\}\s*;/);

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
    glslFields.every((name, idx) => name === wgslFields[idx]);
  const expectedBytes = glslFields.length * 16;

  assert(
    fieldsEqual &&
      expectedBytes === 176 &&
      glRendererSrc.includes('Float32Array(44)') &&
      glRendererSrc.includes('gl.bufferData(gl.UNIFORM_BUFFER, 176') &&
      gpuRendererSrc.includes('new ArrayBuffer(176)') &&
      gpuRendererSrc.includes("makeUbo('supernova-ubo', 176)"),
    'GLSL & WGSL SupernovaUniforms match byte-for-byte (176 bytes / 11 vec4<f32> fields) and renderer UBO allocations',
    `fields=${glslFields.length}, bytes=${expectedBytes}`
  );

  // Check WGSL @group(0) @binding(0..8) contiguous bindings & GLSL texture units
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

  // Static WGSL uniformity safeguard: zero bare textureSample( on uVolumeNoise or uBlackbodyLut
  const bareVolSample = /textureSample\s*\(\s*uVolumeNoise\b/.test(wgslSrc);
  const bareLutSample = /textureSample\s*\(\s*uBlackbodyLut\b/.test(wgslSrc);
  const hasAnyBareTextureSample = /\btextureSample\s*\(/.test(wgslSrc);
  const hasVolSampleLevel = /textureSampleLevel\s*\(\s*uVolumeNoise\b/.test(wgslSrc);
  const hasLutSampleLevel = /textureSampleLevel\s*\(\s*uBlackbodyLut\b/.test(wgslSrc);
  const hasGlslLod =
    /textureLod\s*\(\s*uVolumeNoise\b/.test(glslSrc) &&
    /textureLod\s*\(\s*uBlackbodyLut\b/.test(glslSrc);

  assert(
    !bareVolSample && !bareLutSample && !hasAnyBareTextureSample && hasVolSampleLevel && hasLutSampleLevel && hasGlslLod,
    'WGSL uniformity safeguard: zero bare textureSample() calls; uVolumeNoise & uBlackbodyLut strictly use textureSampleLevel/textureLod'
  );

  // Assets & physicalLuts WebGPU test
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
