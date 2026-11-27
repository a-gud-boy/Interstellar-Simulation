#!/usr/bin/env node
/**
 * Wormhole Simulator (Unified WebGL2 + WebGPU) — Exact Morris-Thorne / James-Thorne
 * & Ellis Drainhole Relativistic Physics, GLSL + WGSL Contract & Asset Verification Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TRIAL_ROOT = path.resolve(ROOT, '../..');

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(label, reason) {
  skipped++;
  console.log(`  [SKIP] ${label} — ${reason}`);
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ============================================================================
// 1. EXACT WORMHOLE METRIC PROFILES & GEODESIC RK4 INTEGRATOR
// ============================================================================

/**
 * James-Thorne Dneg metric profile (Interstellar) in proper radial distance l in (-inf, +inf).
 */
function jamesThorneProfile(l, rho, a, M) {
  const absL = Math.abs(l);
  if (absL <= a) {
    return { r: rho, drdl: 0.0 };
  }
  const x = (2.0 * (absL - a)) / (Math.PI * Math.max(M, 1e-9));
  const r = rho + M * (x * Math.atan(x) - 0.5 * Math.log(1.0 + x * x));
  const signL = l >= 0.0 ? 1.0 : -1.0;
  const drdl = signL * (2.0 / Math.PI) * Math.atan(x);
  return { r, drdl };
}

/**
 * Pure Ellis drainhole profile: r(l) = sqrt(rho^2 + l^2), dr/dl = l / r.
 */
function ellisProfile(l, rho) {
  const r = Math.hypot(rho, l);
  const drdl = r > 0 ? l / r : 0.0;
  return { r, drdl };
}

function geodesicRHS(l, pl, b, profileFn) {
  const { r, drdl } = profileFn(l);
  const r2 = r * r;
  const r3 = r2 * r;
  return {
    dl: pl,
    dpl: ((b * b) / r3) * drdl,
    dpsi: b / r2,
  };
}

function stepRK4(l, pl, psi, b, h, profileFn) {
  const k1 = geodesicRHS(l, pl, b, profileFn);
  const k2 = geodesicRHS(l + 0.5 * h * k1.dl, pl + 0.5 * h * k1.dpl, b, profileFn);
  const k3 = geodesicRHS(l + 0.5 * h * k2.dl, pl + 0.5 * h * k2.dpl, b, profileFn);
  const k4 = geodesicRHS(l + h * k3.dl, pl + h * k3.dpl, b, profileFn);

  return {
    l: l + (h / 6.0) * (k1.dl + 2.0 * k2.dl + 2.0 * k3.dl + k4.dl),
    pl: pl + (h / 6.0) * (k1.dpl + 2.0 * k2.dpl + 2.0 * k3.dpl + k4.dpl),
    psi: psi + (h / 6.0) * (k1.dpsi + 2.0 * k2.dpsi + 2.0 * k3.dpsi + k4.dpsi),
  };
}

function traceWormholeRay({
  l0 = 20.0,
  b,
  rho,
  profileFn,
  inward = true,
  escapeL = 20.5,
  maxSteps = 4000,
}) {
  const { r: r0 } = profileFn(l0);
  const sinAlpha = b / r0;
  if (sinAlpha >= 1.0) {
    throw new Error(`Invalid impact parameter b=${b} >= r(l0)=${r0}`);
  }

  let l = l0;
  let pl = (inward ? -1.0 : 1.0) * Math.sqrt(Math.max(0.0, 1.0 - sinAlpha * sinAlpha));
  let psi = 0.0;
  let maxHamErr = 0.0;
  let minAbsL = Math.abs(l);
  let crossedThroat = false;

  for (let step = 0; step < maxSteps; step++) {
    const { r } = profileFn(l);
    const H = 0.5 * (pl * pl + (b * b) / (r * r) - 1.0);
    maxHamErr = Math.max(maxHamErr, Math.abs(H));
    minAbsL = Math.min(minAbsL, Math.abs(l));

    if (l < 0.0) crossedThroat = true;
    if (Math.abs(l) >= escapeL && l * pl > 0.0) {
      return {
        escaped: true,
        traversed: l < 0.0,
        crossedThroat,
        l,
        pl,
        psi,
        minAbsL,
        steps: step,
        maxHamErr,
      };
    }

    const h = Math.max(0.012, Math.min(0.22, 0.035 * (Math.abs(l) + 0.35) + 0.012 * Math.max(r - rho, 0.0)));
    const next = stepRK4(l, pl, psi, b, h, profileFn);
    if ((l > 0 && next.l <= 0) || (l < 0 && next.l >= 0)) crossedThroat = true;
    l = next.l;
    pl = next.pl;
    psi = next.psi;
  }

  return {
    escaped: false,
    traversed: l < 0.0,
    crossedThroat,
    l,
    pl,
    psi,
    minAbsL,
    steps: maxSteps,
    maxHamErr,
  };
}

function bisectEllisCriticalB(rho, l0 = 20.0, iters = 30) {
  const prof = (l) => ellisProfile(l, rho);
  let lo = 0.4 * rho;
  let hi = 1.6 * rho;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const res = traceWormholeRay({ l0, b: mid, rho, profileFn: prof, escapeL: 20.5 });
    if (res.traversed) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

console.log('\n=== 1. James-Thorne Dneg & Ellis Metric Profile Identities ===');
{
  const rho = 2.0;
  const a = 0.6;
  const M = 1.35;
  const eps = 1e-6;

  const dnegSamples = [-20.0, -4.5, -1.2, -0.601, -0.3, 0.0, 0.3, 0.601, 1.2, 4.5, 20.0];
  let maxDnegFdErr = 0.0;
  let minDnegR = Infinity;
  for (const l of dnegSamples) {
    const st = jamesThorneProfile(l, rho, a, M);
    minDnegR = Math.min(minDnegR, st.r);
    const sp = jamesThorneProfile(l + eps, rho, a, M);
    const sm = jamesThorneProfile(l - eps, rho, a, M);
    const fd = (sp.r - sm.r) / (2.0 * eps);
    maxDnegFdErr = Math.max(maxDnegFdErr, Math.abs(st.drdl - fd));
  }
  const throatEdgePlus = jamesThorneProfile(a, rho, a, M);
  const throatEdgeMinus = jamesThorneProfile(-a, rho, a, M);
  assert(
    maxDnegFdErr < 1e-7 && approx(throatEdgePlus.r, rho, 1e-12) && approx(throatEdgeMinus.r, rho, 1e-12) && minDnegR >= rho - 1e-12,
    'James-Thorne Dneg r(l) and dr/dl match central FD (<1e-7) & throat C1 continuity',
    `maxErr=${maxDnegFdErr.toExponential(2)}, r(±a)=${throatEdgePlus.r.toFixed(6)}`
  );

  const ellisSamples = [-20.0, -5.0, -1.2, 0.0, 1.2, 5.0, 20.0];
  let maxEllisFdErr = 0.0;
  for (const l of ellisSamples) {
    const st = ellisProfile(l, rho);
    const sp = ellisProfile(l + eps, rho);
    const sm = ellisProfile(l - eps, rho);
    const fd = (sp.r - sm.r) / (2.0 * eps);
    maxEllisFdErr = Math.max(maxEllisFdErr, Math.abs(st.drdl - fd));
  }
  const ellisThroat = ellisProfile(0.0, rho);
  assert(
    maxEllisFdErr < 1e-7 && approx(ellisThroat.r, rho, 1e-12) && approx(ellisThroat.drdl, 0.0, 1e-12),
    'Ellis drainhole r(l) and dr/dl match central FD (<1e-7) & r(0)=rho',
    `maxErr=${maxEllisFdErr.toExponential(2)}, r(0)=${ellisThroat.r.toFixed(6)}`
  );
}

console.log('\n=== 2. Null Hamiltonian Conservation, Critical b_c & Orientation Preservation ===');
{
  const rho = 2.0;
  const a = 0.6;
  const M = 1.35;
  const dnegProf = (l) => jamesThorneProfile(l, rho, a, M);
  const ellisProf = (l) => ellisProfile(l, rho);

  const dnegThru = traceWormholeRay({ l0: 20.0, b: 0.75 * rho, rho, profileFn: dnegProf, escapeL: 20.0 });
  const dnegBounce = traceWormholeRay({ l0: 20.0, b: 1.25 * rho, rho, profileFn: dnegProf, escapeL: 20.0 });
  const ellisThru = traceWormholeRay({ l0: 20.0, b: 0.75 * rho, rho, profileFn: ellisProf, escapeL: 20.0 });
  const ellisBounce = traceWormholeRay({ l0: 20.0, b: 1.25 * rho, rho, profileFn: ellisProf, escapeL: 20.0 });

  assert(
    dnegThru.escaped && dnegThru.traversed && dnegThru.l <= -20.0 && dnegThru.maxHamErr < 1e-5 &&
    ellisThru.escaped && ellisThru.traversed && ellisThru.l <= -20.0 && ellisThru.maxHamErr < 1e-5,
    'Through-throat traversal (l=+20 -> -20, b < rho) conserves |H| < 1e-5',
    `Dneg max|H|=${dnegThru.maxHamErr.toExponential(2)}, Ellis max|H|=${ellisThru.maxHamErr.toExponential(2)}`
  );

  assert(
    dnegBounce.escaped && !dnegBounce.traversed && !dnegBounce.crossedThroat && dnegBounce.l >= 20.0 && dnegBounce.pl > 0 && dnegBounce.maxHamErr < 1e-5 &&
    ellisBounce.escaped && !ellisBounce.traversed && !ellisBounce.crossedThroat && ellisBounce.l >= 20.0 && ellisBounce.pl > 0 && ellisBounce.maxHamErr < 1e-5,
    'Reflective bounce (b > rho) reflects back to l >= +20 and conserves |H| < 1e-5',
    `Dneg max|H|=${dnegBounce.maxHamErr.toExponential(2)}, Ellis max|H|=${ellisBounce.maxHamErr.toExponential(2)}`
  );

  const bc2 = bisectEllisCriticalB(2.0);
  const bc15 = bisectEllisCriticalB(1.5);
  assert(
    Math.abs(bc2 - 2.0) < 0.02 && Math.abs(bc15 - 1.5) < 0.02,
    'Ellis drainhole critical impact parameter b_c = rho via RK4 bisection (<0.02)',
    `rho=2.0 -> b_c=${bc2.toFixed(5)}, rho=1.5 -> b_c=${bc15.toFixed(5)}`
  );

  // Orientation-preserving sign(l)*n(psi) verification
  const n0 = normalize3([0.32, -0.44, 0.838]);
  const dInward = [-n0[0], -n0[1], -n0[2]];
  const pl0 = dot3(dInward, n0);
  const tVec = [dInward[0] - pl0 * n0[0], dInward[1] - pl0 * n0[1], dInward[2] - pl0 * n0[2]];
  const sinAlpha = Math.hypot(tVec[0], tVec[1], tVec[2]);
  const tHat = sinAlpha > 1e-7 ? [tVec[0] / sinAlpha, tVec[1] / sinAlpha, tVec[2] / sinAlpha] : [0, 0, 0];
  const radialRes = traceWormholeRay({
    l0: 20.0,
    b: ellisProf(20.0).r * sinAlpha,
    rho,
    profileFn: ellisProf,
    escapeL: 20.0,
  });
  const nPsi = [
    Math.cos(radialRes.psi) * n0[0] + Math.sin(radialRes.psi) * tHat[0],
    Math.cos(radialRes.psi) * n0[1] + Math.sin(radialRes.psi) * tHat[1],
    Math.cos(radialRes.psi) * n0[2] + Math.sin(radialRes.psi) * tHat[2],
  ];
  const signL = radialRes.l >= 0 ? 1.0 : -1.0;
  const dSky = [signL * nPsi[0], signL * nPsi[1], signL * nPsi[2]];
  const nPsiDotN0 = dot3(nPsi, n0);
  const dSkyDotInward = dot3(dSky, dInward);

  // Off-axis near-radial check: verify orientation preservation (both sign(l)*nPsi and normal-reflected dSky continue forward without flip)
  const perp = normalize3([-n0[2], 0, n0[0]]);
  const dOffAxis = normalize3([dInward[0] + 0.005 * perp[0], dInward[1] + 0.005 * perp[1], dInward[2] + 0.005 * perp[2]]);
  const plOff = dot3(dOffAxis, n0);
  const tOff = [dOffAxis[0] - plOff * n0[0], dOffAxis[1] - plOff * n0[1], dOffAxis[2] - plOff * n0[2]];
  const sinOff = Math.hypot(tOff[0], tOff[1], tOff[2]);
  const tHatOff = [tOff[0] / sinOff, tOff[1] / sinOff, tOff[2] / sinOff];
  const offRes = traceWormholeRay({
    l0: 20.0,
    b: ellisProf(20.0).r * sinOff,
    rho,
    profileFn: ellisProf,
    escapeL: 20.0,
  });
  const nPsiOff = [
    Math.cos(offRes.psi) * n0[0] + Math.sin(offRes.psi) * tHatOff[0],
    Math.cos(offRes.psi) * n0[1] + Math.sin(offRes.psi) * tHatOff[1],
    Math.cos(offRes.psi) * n0[2] + Math.sin(offRes.psi) * tHatOff[2],
  ];
  const dSkyOff = [
    (offRes.l >= 0 ? 1 : -1) * nPsiOff[0],
    (offRes.l >= 0 ? 1 : -1) * nPsiOff[1],
    (offRes.l >= 0 ? 1 : -1) * nPsiOff[2],
  ];
  const nPsiDotN0Off = dot3(nPsiOff, n0);
  const dSkyShaderOff = [
    nPsiOff[0] - 2.0 * nPsiDotN0Off * n0[0],
    nPsiOff[1] - 2.0 * nPsiDotN0Off * n0[1],
    nPsiOff[2] - 2.0 * nPsiDotN0Off * n0[2],
  ];

  assert(
    radialRes.traversed &&
      approx(radialRes.psi, 0.0, 1e-12) &&
      approx(nPsiDotN0, 1.0, 1e-12) &&
      approx(dSkyDotInward, 1.0, 1e-12) &&
      offRes.traversed &&
      dot3(dSkyOff, dInward) > 0.95 &&
      dot3(dSkyShaderOff, dInward) > 0.95 &&
      dot3(dSkyShaderOff, tHatOff) > 0.0,
    'Orientation-preserving sign(l)*n(psi): radial photon lands at +n0 on opposite side with continuous dSky',
    `dot(nPsi,n0)=${nPsiDotN0.toFixed(6)}, dot(dSky,dIn)=${dSkyDotInward.toFixed(6)}, offAxisPsi=${offRes.psi.toFixed(4)}rad`
  );

  // Shader-matching adaptive RK4 with exact escapeL boundary crossing & asymptotic flat-space tail
  function traceShaderAdaptive(camL, alphaDeg, metricType, rho, a, M, quality = 1) {
    const profileFn = metricType === 1
      ? (lv) => ellisProfile(lv, rho)
      : (lv) => jamesThorneProfile(lv, rho, a, M);
    const { r: r0 } = profileFn(camL);
    const alpha = (alphaDeg * Math.PI) / 180.0;
    let pl = Math.cos(alpha);
    const sinA = Math.sin(alpha);
    const b = r0 * sinA;
    const maxSteps = quality <= 0 ? 140 : quality >= 2 ? 320 : 220;
    const qualScale = quality <= 0 ? 1.25 : quality >= 2 ? 0.68 : 0.92;
    const escapeL = Math.max(Math.abs(camL) * 3.0 + 40.0, a + 4.0 * Math.max(M, 0.35) + 80.0);
    let l = camL;
    let psi = 0.0;
    for (let step = 0; step < maxSteps; step++) {
      const k1 = geodesicRHS(l, pl, b, profileFn);
      const { r } = profileFn(l);
      const absL = Math.abs(l);
      if (absL >= escapeL - 1e-3 && l * pl > 0.0) break;
      const distEdge = absL - a;
      const curvScale = metricType === 0 ? Math.max(M, 0.35) : rho;
      let h;
      if (metricType === 0 && absL <= a) {
        const wallDist = pl > 0.0 ? a - l : l + a;
        h = Math.max(0.08, Math.min(0.50 * rho * qualScale, wallDist + 0.05));
        if (Math.abs(pl) < 0.08) h = Math.min(h, 0.42 * rho);
      } else {
        h = (0.14 * r + 0.08 * curvScale) * qualScale;
        if (distEdge < 2.5 * curvScale) {
          h = Math.min(h, (0.06 * rho + 0.09 * Math.max(distEdge, 0.0) + 0.04 * curvScale) * qualScale);
        }
        if (l * pl > 0.0 && r > 2.5 * rho && distEdge > 2.5 * curvScale) {
          h = Math.max(h, 0.30 * r * qualScale);
        }
        h = Math.min(Math.max(h, 0.03 * qualScale), 18.0);
        if (l * pl > 0.0 && Math.abs(pl) > 1e-4) {
          const remL = escapeL - absL;
          if (remL > 0.0 && Math.abs(pl) * h > remL) {
            h = remL / Math.abs(pl);
          }
        }
      }
      const next = stepRK4(l, pl, psi, b, h, profileFn);
      l = next.l;
      pl = next.pl;
      psi = next.psi;
    }
    const rEnd = profileFn(l).r;
    const psiFinal = l * pl > 0.0 ? psi + Math.atan2(b / Math.max(rEnd, 1e-5), Math.abs(pl)) : psi;
    return { l, pl, psiFinal, psiFinalDeg: (psiFinal * 180.0) / Math.PI };
  }

  let minFlatDot = 1.0;
  for (const camLVal of [30.0, -30.0]) {
    for (const ang of [20, 60, 120, 150, 170]) {
      const tr = traceShaderAdaptive(camLVal, ang, 1, 1e-5, 0.0, 1.0, 1);
      const rad = (ang * Math.PI) / 180.0;
      const nPsiF = [Math.sin(tr.psiFinal), 0, Math.cos(tr.psiFinal)];
      const dSkyF = tr.l >= 0 ? nPsiF : [nPsiF[0], 0, -nPsiF[2]];
      const dOrigF = [Math.sin(rad), 0, Math.cos(rad)];
      minFlatDot = Math.min(minFlatDot, dot3(dSkyF, dOrigF));
    }
  }
  assert(
    minFlatDot > 0.999999,
    'Asymptotic escape tail recovers exact flat-space rays at camL=±30 across 20°..170° (dot > 0.999999)',
    `minDot=${minFlatDot.toFixed(8)}`
  );

  let maxStepRingD2 = 0.0;
  for (const [mt, rhoV, aV, mV] of [
    [0, 2.0, 0.25, 0.32],
    [0, 2.0, 0.60, 1.35],
    [1, 2.0, 0.00, 1.00],
  ]) {
    const vals = [];
    for (let th = 12.0; th <= 42.0; th += 0.05) {
      // Camera looks at -n0: local ray angle theta from -n0 => alpha from +n0 is 180 - theta
      vals.push(traceShaderAdaptive(30.04, 180.0 - th, mt, rhoV, aV, mV, 1).psiFinalDeg);
    }
    for (let i = 1; i < vals.length - 1; i++) {
      const d2 = Math.abs((vals[i + 1] - vals[i]) - (vals[i] - vals[i - 1]));
      if (d2 > maxStepRingD2) maxStepRingD2 = d2;
    }
  }
  assert(
    maxStepRingD2 < 0.02,
    'Perimeter sky smoothness at camL=30.04 (0.05° grid): zero step-count discontinuity rings (max|Δ²ψ| < 0.02°)',
    `max|Δ²ψ|=${maxStepRingD2.toFixed(5)}°`
  );
}

// ============================================================================
// 3. UNIFIED CODEBASE, GLSL + WGSL & DUAL-BACKEND CONTRACT VERIFICATION
// ============================================================================
console.log('\n=== 3. Wormhole Codebase, Shaders, Controls & Dual-Backend Contract Verification ===');

const expectedFiles = [
  'index.html',
  'styles.css',
  '../../index.html',
  '../../launch.sh',
  '../../shared/simRegistry.js',
  '../../shared/ui/base.css',
  '../../shared/ui/simSwitcher.js',
  '../../shared/assets/milkyway_4k.jpg',
  '../../shared/assets/skyLoader.js',
  '../../shared/assets/physicalLuts.js',
  '../../shared/shaders/common.glsl.js',
  'src/shaders/wormhole.frag.js',
  '../../shared/shaders/post.glsl.js',
  '../../shared/shaders/common.wgsl.js',
  'src/shaders/wormhole.wgsl.js',
  '../../shared/shaders/post.wgsl.js',
  'src/engine/Presets.js',
  'src/engine/Physics.js',
  'src/engine/CameraController.js',
  'src/engine/WebGLRenderer.js',
  'src/engine/WebGPURenderer.js',
  'src/ui/ControlsHUD.js',
  'src/main.js',
];

const missingFiles = expectedFiles.filter((f) => !fs.existsSync(path.join(ROOT, f)));
assert(
  missingFiles.length === 0,
  `All ${expectedFiles.length} expected wormhole-sim + root files exist`,
  missingFiles.length ? `missing: ${missingFiles.join(', ')}` : 'OK'
);

const jsFiles = [
  ...expectedFiles.filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, f)),
  path.join(TRIAL_ROOT, 'sims/blackhole/src/main.js'),
];
for (const full of jsFiles) {
  const label = path.relative(TRIAL_ROOT, full);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    assert(true, `JS syntax OK: ${label}`);
  } catch (err) {
    assert(false, `JS syntax ERROR: ${label}`, err.stderr?.toString().trim() || err.message);
  }
}

if (missingFiles.length === 0) {
  // WGSL shader exports, entry points, zero GLSL-isms, UBO layout & bindings
  const commonWgsl = await import(path.resolve(ROOT, '../../shared/shaders/common.wgsl.js'));
  const whWgsl = await import(path.join(ROOT, 'src/shaders/wormhole.wgsl.js'));
  const postWgsl = await import(path.resolve(ROOT, '../../shared/shaders/post.wgsl.js'));

  const wgslStages = [
    { name: 'NOISE_BAKE_COMPUTE_WGSL', code: commonWgsl.NOISE_BAKE_COMPUTE_WGSL, entry: '@compute' },
    { name: 'MIPMAP_WGSL', code: commonWgsl.MIPMAP_WGSL, entry: '@fragment' },
    { name: 'WORMHOLE_WGSL', code: whWgsl.WORMHOLE_WGSL, entry: '@fragment' },
    { name: 'TAA_WGSL', code: postWgsl.TAA_WGSL, entry: '@fragment' },
    { name: 'BLOOM_PREFILTER_WGSL', code: postWgsl.BLOOM_PREFILTER_WGSL, entry: '@fragment' },
    { name: 'BLOOM_DOWNSAMPLE_WGSL', code: postWgsl.BLOOM_DOWNSAMPLE_WGSL, entry: '@fragment' },
    { name: 'BLOOM_UPSAMPLE_WGSL', code: postWgsl.BLOOM_UPSAMPLE_WGSL, entry: '@fragment' },
    { name: 'ANAMORPHIC_WGSL', code: postWgsl.ANAMORPHIC_WGSL, entry: '@fragment' },
    { name: 'COMPOSITE_WGSL', code: postWgsl.COMPOSITE_WGSL, entry: '@fragment' },
  ];

  const forbiddenGlsl = /\b(isnan|isinf|inversesqrt|dFdx|dFdy|gl_FragCoord|gl_VertexID|texelFetch|textureGrad)\b/;
  for (const st of wgslStages) {
    const hasCode = typeof st.code === 'string' && st.code.includes(st.entry);
    const badMatch = st.code ? st.code.match(forbiddenGlsl) : null;
    assert(
      hasCode && !badMatch,
      `WGSL module ${st.name} valid (${st.entry}, zero GLSL-isms)`,
      badMatch ? `forbidden GLSL token: ${badMatch[0]}` : 'OK'
    );
  }

  const whUniformFields = [
    'resolution_time_frame',
    'jitter_fov_camL',
    'camN0_tanHalfFov',
    'camRight_rho',
    'camUp_throatLen',
    'camForward_lensingW',
    'matter_skyParams',
    'skyB_rotA_rotBx',
    'rotBy_camR_escapeL_pad',
    'modes',
    'skyTrigA',
    'skyTrigB',
  ];
  const missingWhFields = whUniformFields.filter((f) => !whWgsl.WORMHOLE_WGSL.includes(f));
  assert(
    whWgsl.WORMHOLE_WGSL.includes('WormholeUniforms') && missingWhFields.length === 0,
    'WORMHOLE_WGSL declares WormholeUniforms with all 12 packed vec4 fields (192 bytes)',
    missingWhFields.length ? `missing: ${missingWhFields.join(', ')}` : '12/12 OK'
  );

  const whBindings = [...whWgsl.WORMHOLE_WGSL.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((m) => Number(m[1]));
  assert(
    whBindings.length === 8 && whBindings.every((b, idx) => b === idx),
    'WORMHOLE_WGSL declares contiguous bindings 0..7 matching WebGPURenderer',
    `bindings=[${whBindings.join(',')}]`
  );

  const gpuRenSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');
  assert(
    gpuRenSrc.includes('192') && gpuRenSrc.includes('NOISE_BAKE_COMPUTE_WGSL'),
    'WebGPURenderer.js allocates 192-byte WormholeUniforms UBO and compute noise pipeline'
  );

  // GLSL ES 3.00 shader & WebGLRenderer uniform parity check
  const commonGlsl = await import(path.resolve(ROOT, '../../shared/shaders/common.glsl.js'));
  const whGlsl = await import(path.join(ROOT, 'src/shaders/wormhole.frag.js'));
  const postGlsl = await import(path.resolve(ROOT, '../../shared/shaders/post.glsl.js'));

  const glslStages = [
    { name: 'FULLSCREEN_VERT', code: commonGlsl.FULLSCREEN_VERT },
    { name: 'NOISE_BAKE_FRAG', code: commonGlsl.NOISE_BAKE_FRAG },
    { name: 'WORMHOLE_FRAG', code: whGlsl.WORMHOLE_FRAG },
    { name: 'TAA_FRAG', code: postGlsl.TAA_FRAG },
    { name: 'BLOOM_PREFILTER_FRAG', code: postGlsl.BLOOM_PREFILTER_FRAG },
    { name: 'BLOOM_DOWNSAMPLE_FRAG', code: postGlsl.BLOOM_DOWNSAMPLE_FRAG },
    { name: 'BLOOM_UPSAMPLE_FRAG', code: postGlsl.BLOOM_UPSAMPLE_FRAG },
    { name: 'ANAMORPHIC_FRAG', code: postGlsl.ANAMORPHIC_FRAG },
    { name: 'COMPOSITE_FRAG', code: postGlsl.COMPOSITE_FRAG },
  ];
  assert(
    glslStages.every((s) => typeof s.code === 'string' && s.code.includes('#version 300 es')),
    'All 9 GLSL ES 3.00 shader stages declare #version 300 es'
  );

  function extractUniforms(src) {
    const set = new Set();
    const re = /\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
    return set;
  }

  const glRenSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGLRenderer.js'), 'utf8');
  const postPipeSrc = fs.readFileSync(path.join(TRIAL_ROOT, 'shared/engine/SharedWebGLPostPipeline.js'), 'utf8');
  const whGlUniforms = extractUniforms(whGlsl.WORMHOLE_FRAG);
  const expectedSamplerUniforms = ['uVolumeNoise', 'uSkyMapA', 'uProcSkyMapA', 'uSkyMapB', 'uBlueNoise'];
  const expectedValueUniforms = [
    'uResolution', 'uTime', 'uFrameIndex', 'uJitter', 'uCamN0', 'uCamL', 'uCamBasis', 'uFovY',
    'uMetricType', 'uThroatRadius', 'uThroatLength', 'uLensingWidth', 'uThroatGlow', 'uDustDensity',
    'uSwirlSpeed', 'uSkyIntensityA', 'uSkyIntensityB', 'uPlanetVisible', 'uSkyRotationA',
    'uSkyRotationB', 'uQuality',
  ];
  const expectedAllUniforms = [...expectedSamplerUniforms, ...expectedValueUniforms];
  const missingGlInShader = expectedAllUniforms.filter((u) => !whGlUniforms.has(u));
  const unboundGl = [...whGlUniforms].filter((u) => !glRenSrc.includes(u));
  assert(
    missingGlInShader.length === 0 && unboundGl.length === 0 && expectedValueUniforms.length === 21,
    'wormhole.frag.js <-> WebGLRenderer.js 21 value uniforms + 5 texture units parity',
    `declared=${whGlUniforms.size}, missing=[${missingGlInShader.join(',')}], unbound=[${unboundGl.join(',')}]`
  );

  const postGlUniforms = extractUniforms(
    [
      postGlsl.TAA_FRAG,
      postGlsl.BLOOM_PREFILTER_FRAG,
      postGlsl.BLOOM_DOWNSAMPLE_FRAG,
      postGlsl.BLOOM_UPSAMPLE_FRAG,
      postGlsl.ANAMORPHIC_FRAG,
      postGlsl.COMPOSITE_FRAG,
    ].join('\n')
  );
  const unboundPostGl = [...postGlUniforms].filter((u) => !(glRenSrc + '\n' + postPipeSrc).includes(u));
  assert(
    unboundPostGl.length === 0,
    'post.glsl.js <-> WebGLRenderer.js + SharedWebGLPostPipeline.js uniform parity',
    `${postGlUniforms.size} post uniforms bound`
  );

  assert(
    whWgsl.WORMHOLE_WGSL.includes('psiFinal') &&
      whWgsl.WORMHOLE_WGSL.includes('atan2(b / max(rEnd') &&
      !whWgsl.WORMHOLE_WGSL.includes('spike6') &&
      whGlsl.WORMHOLE_FRAG.includes('psiFinal') &&
      whGlsl.WORMHOLE_FRAG.includes('atan(b / max(rEnd') &&
      !whGlsl.WORMHOLE_FRAG.includes('spike6'),
    'WGSL & GLSL both include asymptotic escape tail correction (psiFinal) and omit sky-space spike6 arcs'
  );

  // Presets, WormholeCamera telemetry, ControlsHUD & backend toggle placement checks
  const { DEFAULT_STATE, PRESETS, getPresetById, createInitialState } = await import(
    path.join(ROOT, 'src/engine/Presets.js')
  );
  const { computeWormholeTelemetry } = await import(path.join(ROOT, 'src/engine/CameraController.js'));
  const hudSrc = fs.readFileSync(path.join(ROOT, 'src/ui/ControlsHUD.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const bhHtmlSrc = fs.readFileSync(path.join(TRIAL_ROOT, 'sims/blackhole/index.html'), 'utf8');

  const expectedPresetIds = ['interstellar', 'ellis', 'tunnel', 'crossing', 'universe_b', 'einstein'];
  const actualIds = PRESETS.map((p) => p.id);
  assert(
    expectedPresetIds.every((id) => actualIds.includes(id)) &&
      typeof getPresetById === 'function' &&
      typeof createInitialState === 'function',
    'Presets.js exports all 6 required wormhole presets & helpers',
    `ids: ${actualIds.join(', ')}`
  );

  const controlKeys = [
    'metricType', 'throatRadius', 'throatLength', 'lensingWidth',
    'throatGlow', 'dustDensity', 'swirlSpeed', 'skyIntensityA', 'skyIntensityB',
    'planetVisible', 'exposure', 'bloomIntensity', 'anamorphicIntensity',
    'quality', 'resolutionScale',
  ];
  assert(
    controlKeys.every((k) => k in DEFAULT_STATE) && controlKeys.every((k) => hudSrc.includes(k)),
    'DEFAULT_STATE and ControlsHUD.js share all 15 physics/optics parameters'
  );
  assert(
    hudSrc.includes("key: 'backend'") &&
      hudSrc.includes("value: 'webgl2'") &&
      hudSrc.includes("value: 'webgpu'") &&
      hudSrc.includes("statusNoteId: 'backend-status-note'") &&
      !htmlSrc.includes('ctrl-backend'),
    'Rendering Backend toggle (WebGL2/WebGPU) lives inside collapsible ControlsHUD drawer, not main HUD chrome'
  );
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const simShellSrc = fs.readFileSync(path.join(TRIAL_ROOT, 'shared/engine/SimAppShell.js'), 'utf8');
  assert(
    htmlSrc.includes('data-current-sim="wormhole"') &&
      htmlSrc.includes('id="btn-traverse"') &&
      htmlSrc.includes('../../shared/ui/base.css') &&
      bhHtmlSrc.includes('data-current-sim="blackhole"') &&
      ((mainSrc.includes('createSimApp') && simShellSrc.includes('mountSimSwitcher')) ||
        mainSrc.includes('mountSimSwitcher')) &&
      !htmlSrc.includes('role="tab"') &&
      !bhHtmlSrc.includes('role="tab"'),
    'Shared sim switcher (data-current-sim + mountSimSwitcher) and Traverse button (#btn-traverse) present cleanly without role="tab"'
  );

  const telA = computeWormholeTelemetry(DEFAULT_STATE, 10.5);
  const telT = computeWormholeTelemetry(DEFAULT_STATE, 0.0);
  const telB = computeWormholeTelemetry(DEFAULT_STATE, -10.5);
  assert(
    telA.region === 'Universe A' &&
      telT.region === 'Throat' &&
      telB.region === 'Universe B' &&
      approx(telT.rOfL, DEFAULT_STATE.throatRadius, 1e-9) &&
      telA.rOfL > DEFAULT_STATE.throatRadius &&
      telB.rOfL > DEFAULT_STATE.throatRadius,
    'computeWormholeTelemetry accurately distinguishes Universe A, Throat, and Universe B',
    `A=${telA.rOfL.toFixed(2)}M, Throat=${telT.rOfL.toFixed(2)}M, B=${telB.rOfL.toFixed(2)}M`
  );

  // Dual-backend physicalLuts.js & skyLoader.js verification (mock GPUDevice AND mock WebGL2RenderingContext)
  const lutsMod = await import(path.resolve(ROOT, '../../shared/assets/physicalLuts.js'));
  const skyMod = await import(path.resolve(ROOT, '../../shared/assets/skyLoader.js'));

  const blueData = lutsMod.getBlueNoiseData?.(128);
  assert(
    blueData instanceof Uint8Array && blueData.length === 128 * 128 * 4,
    'physicalLuts.js getBlueNoiseData(128) returns 128x128 RGBA Uint8Array',
    `bytes=${blueData?.length}`
  );

  let gpuBlueUploaded = null;
  let gpuSkyUploads = [];
  globalThis.GPUTextureUsage = globalThis.GPUTextureUsage || {
    TEXTURE_BINDING: 4,
    COPY_DST: 2,
    RENDER_ATTACHMENT: 16,
  };
  const mockDevice = {
    createTexture: (desc) => ({ desc, createView: () => ({ id: 'mockView' }) }),
    queue: {
      writeTexture: (dst, data, layout, size) => {
        if (dst?.texture?.desc?.size?.[0] === 128 && dst?.texture?.desc?.size?.[1] === 128) {
          gpuBlueUploaded = { desc: dst.texture.desc, data, layout, size };
        } else {
          gpuSkyUploads.push({ desc: dst.texture.desc, data, layout, size });
        }
      },
    },
  };

  const gpuBlueTex = lutsMod.createBlueNoiseLUT(mockDevice, 128);
  assert(
    Boolean(
      gpuBlueTex &&
        gpuBlueUploaded?.size?.[0] === 128 &&
        gpuBlueUploaded?.size?.[1] === 128 &&
        gpuBlueUploaded?.desc?.format === 'rgba8unorm'
    ),
    'createBlueNoiseLUT handles WebGPU GPUDevice (128x128 rgba8unorm)'
  );

  const glCalls = [];
  const mockGl = {
    TEXTURE_2D: 0x0de1, RGBA8: 0x8058, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703,
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812f, UNPACK_FLIP_Y_WEBGL: 0x9240,
    createTexture: () => ({ id: 'mockGlTex' }),
    bindTexture: () => {},
    texParameteri: () => {},
    texParameterf: () => {},
    pixelStorei: () => {},
    getExtension: () => null,
    generateMipmap: () => {},
    texImage2D: (_t, _l, internalFormat, width, height, _b, _f, type, data) => {
      glCalls.push({ internalFormat, width, height, type, len: data?.length });
    },
  };

  const glBlueTex = lutsMod.createBlueNoiseLUT(mockGl, 128);
  const glBlueUpload = glCalls.find((c) => c.width === 128 && c.height === 128);
  assert(
    Boolean(glBlueTex && glBlueUpload && glBlueUpload.internalFormat === mockGl.RGBA8 && glBlueUpload.len === 128 * 128 * 4),
    'createBlueNoiseLUT handles WebGL2RenderingContext (128x128 RGBA8)'
  );

  // Verify skyLoader Universe A + Universe B exports & dual-backend pixel/texture generation
  const requiredSkyExports = [
    'getProceduralSkyPixelsA',
    'createProceduralSkyTextureAWebGL',
    'createProceduralSkyTextureAWebGPU',
    'loadSkyTextureAWebGL',
    'loadSkyTextureAWebGPU',
    'getExoticNebulaPixelsB',
    'createExoticNebulaTextureBWebGL',
    'createExoticNebulaTextureBWebGPU',
  ];
  const missingSkyExports = requiredSkyExports.filter((fn) => typeof skyMod[fn] !== 'function');
  assert(
    missingSkyExports.length === 0,
    'skyLoader.js exports all 8 Universe A & Universe B functions',
    missingSkyExports.length ? `missing: ${missingSkyExports.join(', ')}` : '8/8 OK'
  );

  if (missingSkyExports.length === 0) {
    const pxA = skyMod.getProceduralSkyPixelsA(128, 64);
    const pxB = skyMod.getExoticNebulaPixelsB(128, 64);
    let meanLumA = 0;
    let meanLumB = 0;
    let diffSum = 0;
    const count = 128 * 64;
    for (let i = 0; i < count; i++) {
      const k = i * 4;
      meanLumA += 0.2126 * pxA[k] + 0.7152 * pxA[k + 1] + 0.0722 * pxA[k + 2];
      meanLumB += 0.2126 * pxB[k] + 0.7152 * pxB[k + 1] + 0.0722 * pxB[k + 2];
      diffSum += Math.abs(pxA[k] - pxB[k]) + Math.abs(pxA[k + 1] - pxB[k + 1]) + Math.abs(pxA[k + 2] - pxB[k + 2]);
    }
    meanLumA /= count;
    meanLumB /= count;
    const meanColorDiff = diffSum / (count * 3);

    const texAGpu = skyMod.createProceduralSkyTextureAWebGPU(mockDevice, null, 128, 64);
    const texBGpu = skyMod.createExoticNebulaTextureBWebGPU(mockDevice, null, 128, 64);
    const texAGl = skyMod.createProceduralSkyTextureAWebGL(mockGl, 128, 64);
    const texBGl = skyMod.createExoticNebulaTextureBWebGL(mockGl, 128, 64);

    assert(
      pxA instanceof Uint8Array &&
        pxB instanceof Uint8Array &&
        pxA.length === count * 4 &&
        pxB.length === count * 4 &&
        meanLumB > 5 &&
        meanColorDiff > 8 &&
        Boolean(texAGpu && texBGpu && texAGl && texBGl),
      'Universe A (Milky Way) & Universe B (Golden-Teal Nebula) pixel/texture generators work on WebGL2 & WebGPU',
      `lumA=${meanLumA.toFixed(1)}, lumB=${meanLumB.toFixed(1)}, rgbDiff=${meanColorDiff.toFixed(1)}`
    );
  }
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
