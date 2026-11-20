#!/usr/bin/env node
/**
 * Gargantua (Unified WebGL2 + WebGPU) — Exact Kerr-Schild Relativistic Physics,
 * GLSL + WGSL Contract & Dual-Backend Asset Verification Suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
// 1. EXACT KERR-SCHILD MATH (Y-up spin axis = +Y, disk in X-Z plane, G=c=M=1)
// ============================================================================

function kerrHorizon(a) {
  return 1.0 + Math.sqrt(Math.max(0.0, 1.0 - a * a));
}

function kerrISCO(a) {
  const s = Math.max(0.0, 1.0 - a * a);
  const z1 = 1.0 + Math.cbrt(s) * (Math.cbrt(1.0 + a) + Math.cbrt(1.0 - a));
  const z2 = Math.sqrt(3.0 * a * a + z1 * z1);
  return 3.0 + z2 - Math.sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
}

function kerrSchildR(x, y, z, a) {
  const a2 = a * a;
  const u = x * x + y * y + z * z - a2;
  const r2 = 0.5 * (u + Math.sqrt(u * u + 4.0 * a2 * y * y));
  return Math.sqrt(Math.max(r2, 1e-18));
}

function kerrSchildState(x, y, z, a) {
  const a2 = a * a;
  const r = kerrSchildR(x, y, z, a);
  const r2 = r * r;
  const denom = r2 + a2;
  const r4ay2 = r2 * r2 + a2 * y * y;
  const H = (r2 * r) / r4ay2;

  const lt = -1.0;
  const lx = (r * x + a * z) / denom;
  const ly = y / r;
  const lz = (r * z - a * x) / denom;

  const drdx = (r2 * r * x) / r4ay2;
  const drdy = (r * (r2 + a2) * y) / r4ay2;
  const drdz = (r2 * r * z) / r4ay2;

  const dHdr = (3.0 * r2 * r4ay2 - r2 * r * 4.0 * r2 * r) / (r4ay2 * r4ay2);
  const dHdy_explicit = (-2.0 * a2 * y * r2 * r) / (r4ay2 * r4ay2);
  const dHdx = dHdr * drdx;
  const dHdy = dHdr * drdy + dHdy_explicit;
  const dHdz = dHdr * drdz;

  const invD = 1.0 / denom;
  const invD2 = invD * invD;
  const dlx_dr = (x * denom - 2.0 * r * (r * x + a * z)) * invD2;
  const dly_dr = -y / r2;
  const dlz_dr = (z * denom - 2.0 * r * (r * z - a * x)) * invD2;

  const dl = [
    [r * invD + dlx_dr * drdx, dlx_dr * drdy, a * invD + dlx_dr * drdz],
    [dly_dr * drdx, 1.0 / r + dly_dr * drdy, dly_dr * drdz],
    [-a * invD + dlz_dr * drdx, dlz_dr * drdy, r * invD + dlz_dr * drdz],
  ];

  return { r, H, l: [lt, lx, ly, lz], dH: [dHdx, dHdy, dHdz], dl };
}

function metricCovariant(x, y, z, a) {
  const { H, l } = kerrSchildState(x, y, z, a);
  const eta = [-1, 1, 1, 1];
  const g = Array.from({ length: 4 }, () => new Float64Array(4));
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      g[mu][nu] = (mu === nu ? eta[mu] : 0.0) + 2.0 * H * l[mu] * l[nu];
    }
  }
  return g;
}

function metricContravariant(x, y, z, a) {
  const { H, l } = kerrSchildState(x, y, z, a);
  const eta = [-1, 1, 1, 1];
  const lUp = [-l[0], l[1], l[2], l[3]];
  const gInv = Array.from({ length: 4 }, () => new Float64Array(4));
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      gInv[mu][nu] = (mu === nu ? eta[mu] : 0.0) - 2.0 * H * lUp[mu] * lUp[nu];
    }
  }
  return gInv;
}

function initialPastNullMomentum(pos, dir, a) {
  const g = metricCovariant(pos[0], pos[1], pos[2], a);
  const A = g[0][0];
  let B = 0.0;
  let C = 0.0;
  for (let i = 0; i < 3; i++) {
    B += 2.0 * g[0][i + 1] * dir[i];
    for (let j = 0; j < 3; j++) {
      C += g[i + 1][j + 1] * dir[i] * dir[j];
    }
  }
  const disc = B * B - 4.0 * A * C;
  if (disc < 0) throw new Error(`No null root at pos=${pos}`);
  const kt1 = (-B + Math.sqrt(disc)) / (2.0 * A);
  const kt2 = (-B - Math.sqrt(disc)) / (2.0 * A);
  const kt = Math.min(kt1, kt2);
  const kUp = [kt, dir[0], dir[1], dir[2]];
  const p = [0, 0, 0, 0];
  for (let mu = 0; mu < 4; mu++) {
    for (let nu = 0; nu < 4; nu++) {
      p[mu] += g[mu][nu] * kUp[nu];
    }
  }
  const scale = 1.0 / p[0];
  return [p[1] * scale, p[2] * scale, p[3] * scale];
}

function geodesicRHS(pos, p, a) {
  const { H, l, dH, dl } = kerrSchildState(pos[0], pos[1], pos[2], a);
  const lp = -l[0] * 1.0 + l[1] * p[0] + l[2] * p[1] + l[3] * p[2];
  const dx = [
    p[0] - 2.0 * H * lp * l[1],
    p[1] - 2.0 * H * lp * l[2],
    p[2] - 2.0 * H * lp * l[3],
  ];
  const dp = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const pdl = p[0] * dl[0][i] + p[1] * dl[1][i] + p[2] * dl[2][i];
    dp[i] = lp * lp * dH[i] + 2.0 * H * lp * pdl;
  }
  return { dx, dp };
}

function traceRayCaptured(impactX, impactY, camZ, a, maxSteps = 2000, hybrid = false) {
  const rPlus = kerrHorizon(a);
  const pos = [impactX, impactY, camZ];
  const dir = [0.0, 0.0, -1.0];
  let p = initialPastNullMomentum(pos, dir, a);
  const x = [...pos];
  let maxHamErr = 0.0;

  for (let step = 0; step < maxSteps; step++) {
    const r = kerrSchildR(x[0], x[1], x[2], a);
    if (r <= rPlus * 1.022) return { captured: true, steps: step, maxHamErr };
    const k1 = geodesicRHS(x, p, a);
    const outbound = x[0] * k1.dx[0] + x[1] * k1.dx[1] + x[2] * k1.dx[2] > 0;
    if (r > camZ * 1.45 && outbound) {
      return { captured: false, steps: step, maxHamErr };
    }

    let h;
    if (hybrid) {
      const qualScale = 0.96;
      const rAboveHor = Math.max(r - rPlus * 0.72, 0.06);
      const farOut = outbound && r > 25.0;
      const mul = farOut ? 0.32 : 0.12;
      const maxH = farOut ? 14.0 : 4.8;
      h = Math.max(0.024 * qualScale, Math.min(maxH, mul * rAboveHor * qualScale));
      if (r < 4.8 * rPlus) {
        h = Math.min(h, (0.028 + 0.035 * Math.max(r - rPlus, 0.05)) * qualScale);
      }
    } else {
      h = Math.max(0.015, Math.min(0.6, 0.07 * (r - 0.85 * rPlus)));
    }

    if (hybrid && r >= 6.5 * rPlus) {
      const x2 = [x[0] + 0.5 * h * k1.dx[0], x[1] + 0.5 * h * k1.dx[1], x[2] + 0.5 * h * k1.dx[2]];
      const p2 = [p[0] + 0.5 * h * k1.dp[0], p[1] + 0.5 * h * k1.dp[1], p[2] + 0.5 * h * k1.dp[2]];
      const k2 = geodesicRHS(x2, p2, a);
      for (let i = 0; i < 3; i++) {
        x[i] += h * k2.dx[i];
        p[i] += h * k2.dp[i];
      }
    } else {
      const x2 = [x[0] + 0.5 * h * k1.dx[0], x[1] + 0.5 * h * k1.dx[1], x[2] + 0.5 * h * k1.dx[2]];
      const p2 = [p[0] + 0.5 * h * k1.dp[0], p[1] + 0.5 * h * k1.dp[1], p[2] + 0.5 * h * k1.dp[2]];
      const k2 = geodesicRHS(x2, p2, a);

      const x3 = [x[0] + 0.5 * h * k2.dx[0], x[1] + 0.5 * h * k2.dx[1], x[2] + 0.5 * h * k2.dx[2]];
      const p3 = [p[0] + 0.5 * h * k2.dp[0], p[1] + 0.5 * h * k2.dp[1], p[2] + 0.5 * h * k2.dp[2]];
      const k3 = geodesicRHS(x3, p3, a);

      const x4 = [x[0] + h * k3.dx[0], x[1] + h * k3.dx[1], x[2] + h * k3.dx[2]];
      const p4 = [p[0] + h * k3.dp[0], p[1] + h * k3.dp[1], p[2] + h * k3.dp[2]];
      const k4 = geodesicRHS(x4, p4, a);

      for (let i = 0; i < 3; i++) {
        x[i] += (h / 6.0) * (k1.dx[i] + 2.0 * k2.dx[i] + 2.0 * k3.dx[i] + k4.dx[i]);
        p[i] += (h / 6.0) * (k1.dp[i] + 2.0 * k2.dp[i] + 2.0 * k3.dp[i] + k4.dp[i]);
      }
    }

    if (step % 25 === 0) {
      const gInv = metricContravariant(x[0], x[1], x[2], a);
      const p4v = [1.0, p[0], p[1], p[2]];
      let ham = 0.0;
      for (let mu = 0; mu < 4; mu++) {
        for (let nu = 0; nu < 4; nu++) {
          ham += 0.5 * gInv[mu][nu] * p4v[mu] * p4v[nu];
        }
      }
      maxHamErr = Math.max(maxHamErr, Math.abs(ham));
    }
  }
  return { captured: true, steps: maxSteps, maxHamErr };
}

function bisectShadowEdge(loCaptured, hiEscaped, camZ, a, iters = 24, hybrid = false) {
  let lo = loCaptured;
  let hi = hiEscaped;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const res = traceRayCaptured(mid, 0.0, camZ, a, 2000, hybrid);
    if (res.captured) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function bardeenEquatorialShadowEdges(a) {
  if (a < 1e-9) {
    const bc = 3.0 * Math.sqrt(3.0);
    return { xLeft: -bc, xRight: +bc };
  }
  const rPro = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(-a)));
  const rRet = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(+a)));
  const xi = (r) => -(r * r * r - 3.0 * r * r + a * a * r + a * a) / (a * (r - 1.0));
  return { xLeft: -xi(rPro), xRight: -xi(rRet), rPro, rRet };
}

console.log('\n=== 1. Kerr-Schild Metric, Null Covector & Derivative Identities ===');
{
  const testCases = [
    { a: 0.0, x: 4.5, y: 1.2, z: -2.3 },
    { a: 0.5, x: -3.2, y: 2.1, z: 4.0 },
    { a: 0.998, x: 1.8, y: 0.65, z: -1.4 },
    { a: 0.998, x: -2.5, y: 0.0, z: 3.1 },
    { a: 0.998, x: 0.0, y: 2.2, z: 0.0 },
  ];

  let maxSpheroidErr = 0;
  let maxNullEtaErr = 0;
  let maxNullMetricErr = 0;
  let maxInvErr = 0;
  let maxDerivErr = 0;

  for (const tc of testCases) {
    const { a, x, y, z } = tc;
    const st = kerrSchildState(x, y, z, a);
    const sph = (x * x + z * z) / (st.r * st.r + a * a) + (y * y) / (st.r * st.r);
    maxSpheroidErr = Math.max(maxSpheroidErr, Math.abs(sph - 1.0));

    const lEta = -(st.l[0] ** 2) + st.l[1] ** 2 + st.l[2] ** 2 + st.l[3] ** 2;
    maxNullEtaErr = Math.max(maxNullEtaErr, Math.abs(lEta));

    const g = metricCovariant(x, y, z, a);
    const gInv = metricContravariant(x, y, z, a);

    let lG = 0;
    for (let mu = 0; mu < 4; mu++) {
      for (let nu = 0; nu < 4; nu++) lG += gInv[mu][nu] * st.l[mu] * st.l[nu];
    }
    maxNullMetricErr = Math.max(maxNullMetricErr, Math.abs(lG));

    for (let mu = 0; mu < 4; mu++) {
      for (let al = 0; al < 4; al++) {
        let sum = 0;
        for (let nu = 0; nu < 4; nu++) sum += g[mu][nu] * gInv[nu][al];
        maxInvErr = Math.max(maxInvErr, Math.abs(sum - (mu === al ? 1.0 : 0.0)));
      }
    }

    const eps = 1e-6;
    const coords = [x, y, z];
    for (let i = 0; i < 3; i++) {
      const cp = [...coords]; cp[i] += eps;
      const cm = [...coords]; cm[i] -= eps;
      const sp = kerrSchildState(cp[0], cp[1], cp[2], a);
      const sm = kerrSchildState(cm[0], cm[1], cm[2], a);
      const numDH = (sp.H - sm.H) / (2 * eps);
      maxDerivErr = Math.max(maxDerivErr, Math.abs(st.dH[i] - numDH));
      for (let j = 0; j < 3; j++) {
        const numDl = (sp.l[j + 1] - sm.l[j + 1]) / (2 * eps);
        maxDerivErr = Math.max(maxDerivErr, Math.abs(st.dl[j][i] - numDl));
      }
    }
  }

  assert(maxSpheroidErr < 1e-13, 'Oblate spheroid radius identity', `maxErr=${maxSpheroidErr.toExponential(2)}`);
  assert(maxNullEtaErr < 1e-13, 'Flat null vector eta^{mu nu} l_mu l_nu = 0', `maxErr=${maxNullEtaErr.toExponential(2)}`);
  assert(maxNullMetricErr < 1e-13, 'Curved null vector g^{mu nu} l_mu l_nu = 0', `maxErr=${maxNullMetricErr.toExponential(2)}`);
  assert(maxInvErr < 1e-13, 'Metric inverse identity g_{mu nu} g^{nu alpha} = delta', `maxErr=${maxInvErr.toExponential(2)}`);
  assert(maxDerivErr < 1e-7, 'Analytic dH/dx_i and dl_j/dx_i match central FD', `maxErr=${maxDerivErr.toExponential(2)}`);
}

console.log('\n=== 2. Bardeen-Press-Teukolsky ISCO & Horizon Radii ===');
{
  const isco0 = kerrISCO(0.0);
  const isco05 = kerrISCO(0.5);
  const isco09 = kerrISCO(0.9);
  const isco998 = kerrISCO(0.998);
  const h0 = kerrHorizon(0.0);
  const h998 = kerrHorizon(0.998);

  assert(approx(isco0, 6.0, 1e-12), 'ISCO(a=0) = 6.0M', `got ${isco0.toFixed(6)}M`);
  assert(approx(isco05, 4.23300253, 1e-6), 'ISCO(a=0.5) = 4.233003M', `got ${isco05.toFixed(6)}M`);
  assert(approx(isco09, 2.32088304, 1e-6), 'ISCO(a=0.9) = 2.320883M', `got ${isco09.toFixed(6)}M`);
  assert(approx(isco998, 1.236972, 1e-4), 'ISCO(a=0.998) = 1.23697M (Thorne limit)', `got ${isco998.toFixed(6)}M`);
  assert(approx(h0, 2.0, 1e-12), 'Horizon r+(a=0) = 2.0M', `got ${h0.toFixed(6)}M`);
  assert(approx(h998, 1.0632139, 1e-5), 'Horizon r+(a=0.998) = 1.06321M', `got ${h998.toFixed(6)}M`);
}

console.log('\n=== 3. Exact Schwarzschild & Kerr D-Shaped Shadow Geodesic Verification ===');
{
  const camZ = 120.0;
  const bcExact = 3.0 * Math.sqrt(3.0);
  const schwRight = bisectShadowEdge(0.0, 8.0, camZ, 0.0);
  const schwLeft = bisectShadowEdge(0.0, -8.0, camZ, 0.0);
  const schwProbe = traceRayCaptured(5.0, 0.0, camZ, 0.0);
  assert(
    approx(schwRight, bcExact, 0.03) && approx(schwLeft, -bcExact, 0.03),
    `Schwarzschild critical impact parameter b_c = 3*sqrt(3)M (${bcExact.toFixed(4)}M)`,
    `RK4 left=${schwLeft.toFixed(4)}M, right=${schwRight.toFixed(4)}M`
  );
  assert(
    schwProbe.maxHamErr < 1e-5,
    'Null Hamiltonian conservation H = 1/2 g^{mu nu} p_mu p_nu = 0 along RK4 geodesic',
    `max|H|=${schwProbe.maxHamErr.toExponential(2)}`
  );

  const a = 0.998;
  const bardeen = bardeenEquatorialShadowEdges(a);
  const kerrLeft = bisectShadowEdge(0.0, -6.0, camZ, a);
  const kerrRight = bisectShadowEdge(0.0, +9.0, camZ, a);
  const kerrCenter = 0.5 * (kerrLeft + kerrRight);

  assert(
    approx(kerrLeft, bardeen.xLeft, 0.08),
    'Kerr a=0.998 prograde (-X, left) flattened shadow edge',
    `RK4=${kerrLeft.toFixed(4)}M vs Bardeen=${bardeen.xLeft.toFixed(4)}M`
  );
  assert(
    approx(kerrRight, bardeen.xRight, 0.08),
    'Kerr a=0.998 retrograde (+X, right) extended shadow edge',
    `RK4=${kerrRight.toFixed(4)}M vs Bardeen=${bardeen.xRight.toFixed(4)}M`
  );
  assert(
    kerrCenter > 2.0 && Math.abs(kerrLeft) < kerrRight * 0.45,
    'Kerr shadow shifts strongly RIGHT (+X) and flattens on LEFT (-X)',
    `centerX=+${kerrCenter.toFixed(3)}M, |left|=${Math.abs(kerrLeft).toFixed(3)}M < right=${kerrRight.toFixed(3)}M`
  );

  const rOrb = 4.0;
  const omega = 1.0 / (Math.pow(rOrb, 1.5) + a);
  function computeG(x, z, p3) {
    const gCov = metricCovariant(x, 0, z, a);
    const v = [1.0, omega * z, 0.0, -omega * x];
    let norm = 0;
    for (let mu = 0; mu < 4; mu++) {
      for (let nu = 0; nu < 4; nu++) norm += gCov[mu][nu] * v[mu] * v[nu];
    }
    const ut = 1.0 / Math.sqrt(-norm);
    const uEmit = v.map((c) => c * ut);
    const p4 = [1.0, p3[0], p3[1], p3[2]];
    const emitDot = p4[0] * uEmit[0] + p4[1] * uEmit[1] + p4[2] * uEmit[2] + p4[3] * uEmit[3];
    return 1.0 / emitDot;
  }
  const pLeft = initialPastNullMomentum([-rOrb, 0, 0], [0, 0, -1], a);
  const pRight = initialPastNullMomentum([+rOrb, 0, 0], [0, 0, -1], a);
  const gLeft = computeG(-rOrb, 0, pLeft);
  const gRight = computeG(+rOrb, 0, pRight);
  assert(
    gLeft > 1.2 && gRight < 0.75,
    'Relativistic Doppler shift g: approaching left (-X) blueshifted, receding right (+X) redshifted',
    `g(-4M)=${gLeft.toFixed(3)} (>1 blueshift), g(+4M)=${gRight.toFixed(3)} (<1 redshift)`
  );

  const hSchwRight = bisectShadowEdge(0.0, 8.0, camZ, 0.0, 24, true);
  const hKerrLeft = bisectShadowEdge(0.0, -6.0, camZ, a, 24, true);
  const hKerrRight = bisectShadowEdge(0.0, +9.0, camZ, a, 24, true);
  const hProbe = traceRayCaptured(5.0, 0.0, camZ, 0.0, 2000, true);
  assert(
    approx(hSchwRight, bcExact, 0.04) &&
    approx(hKerrLeft, bardeen.xLeft, 0.04) &&
    approx(hKerrRight, bardeen.xRight, 0.04) &&
    approx(hKerrLeft, kerrLeft, 0.03),
    'Hybrid RK4/RK2 geodesic integrator matches Bardeen/RK4 shadow edges (<0.04M)',
    `Schw=${hSchwRight.toFixed(4)}M, KerrL=${hKerrLeft.toFixed(4)}M, KerrR=${hKerrRight.toFixed(4)}M`
  );
  assert(
    hProbe.maxHamErr < 5e-5,
    'Hybrid RK4/RK2 conserves null Hamiltonian |H| < 5e-5',
    `max|H|=${hProbe.maxHamErr.toExponential(2)}`
  );
}

// ============================================================================
// 4. UNIFIED CODEBASE, GLSL + WGSL & DUAL-BACKEND CONTRACT VERIFICATION
// ============================================================================
console.log('\n=== 4. Unified WebGL2 + WebGPU Codebase & Contract Verification ===');

const expectedFiles = [
  'index.html',
  'styles.css',
  '../launch.sh',
  'assets/milkyway_4k.jpg',
  'src/assets/skyLoader.js',
  'src/assets/physicalLuts.js',
  'src/shaders/common.glsl.js',
  'src/shaders/blackhole.frag.js',
  'src/shaders/post.glsl.js',
  'src/shaders/common.wgsl.js',
  'src/shaders/blackhole.wgsl.js',
  'src/shaders/post.wgsl.js',
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
  `All ${expectedFiles.length} expected unified project files exist`,
  missingFiles.length ? `missing: ${missingFiles.join(', ')}` : 'OK'
);

const jsFiles = expectedFiles.filter((f) => f.endsWith('.js'));
for (const rel of jsFiles) {
  const full = path.join(ROOT, rel);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    assert(true, `JS syntax OK: ${rel}`);
  } catch (err) {
    assert(false, `JS syntax ERROR: ${rel}`, err.stderr?.toString().trim() || err.message);
  }
}

// WGSL shader exports, entry points, zero GLSL-isms, UBO layout & bindings
const commonWgsl = await import(path.join(ROOT, 'src/shaders/common.wgsl.js'));
const bhWgsl = await import(path.join(ROOT, 'src/shaders/blackhole.wgsl.js'));
const postWgsl = await import(path.join(ROOT, 'src/shaders/post.wgsl.js'));

const wgslStages = [
  { name: 'NOISE_BAKE_COMPUTE_WGSL', code: commonWgsl.NOISE_BAKE_COMPUTE_WGSL, entry: '@compute' },
  { name: 'MIPMAP_WGSL', code: commonWgsl.MIPMAP_WGSL, entry: '@fragment' },
  { name: 'BLACKHOLE_WGSL', code: bhWgsl.BLACKHOLE_WGSL, entry: '@fragment' },
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

const bhUniformFields = [
  'resolution_time_frame', 'jitter_fov_spin', 'camPos_relMode', 'camRight_lensing',
  'camUp_diskTemp', 'camForward_diskDens', 'diskParams', 'jet_skyParams', 'modes_pad',
  'zamoE0', 'zamoE1', 'zamoE2', 'zamoE3', 'camKS_l_2H', 'kerrConsts', 'rayConsts',
  'flowConsts', 'optConsts', 'skyTrig',
];
const missingBhFields = bhUniformFields.filter((f) => !bhWgsl.BLACKHOLE_WGSL.includes(f));
assert(
  missingBhFields.length === 0,
  'BLACKHOLE_WGSL declares all 19 packed uniform struct vec4 fields (304 bytes)',
  missingBhFields.length ? `missing: ${missingBhFields.join(', ')}` : '19/19 OK'
);

const bhBindings = [...bhWgsl.BLACKHOLE_WGSL.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)].map((m) => Number(m[1]));
assert(
  bhBindings.length === 9 && bhBindings.every((b, idx) => b === idx),
  'BLACKHOLE_WGSL declares contiguous bindings 0..8 matching WebGPURenderer',
  `bindings=[${bhBindings.join(',')}]`
);

const gpuRenSrc = fs.readFileSync(path.join(ROOT, 'src/engine/WebGPURenderer.js'), 'utf8');
assert(
  gpuRenSrc.includes('304') && gpuRenSrc.includes('bhUniformBuf') && gpuRenSrc.includes('noisePipeline'),
  'WebGPURenderer.js allocates 304-byte Blackhole UBO and compute noise pipeline'
);

// GLSL ES 3.00 shader & WebGLRenderer uniform parity check
const commonGlsl = await import(path.join(ROOT, 'src/shaders/common.glsl.js'));
const bhGlsl = await import(path.join(ROOT, 'src/shaders/blackhole.frag.js'));
const postGlsl = await import(path.join(ROOT, 'src/shaders/post.glsl.js'));

const glslStages = [
  { name: 'FULLSCREEN_VERT', code: commonGlsl.FULLSCREEN_VERT },
  { name: 'NOISE_BAKE_FRAG', code: commonGlsl.NOISE_BAKE_FRAG },
  { name: 'BLACKHOLE_FRAG', code: bhGlsl.BLACKHOLE_FRAG },
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
const bhGlUniforms = extractUniforms(bhGlsl.BLACKHOLE_FRAG);
const expectedGlContract = [
  'uVolumeNoise', 'uSkyMap', 'uProcSkyMap', 'uBlackbodyLut', 'uBlueNoise',
  'uResolution', 'uTime', 'uFrameIndex', 'uJitter', 'uCamPos', 'uCamBasis', 'uFovY',
  'uSpin', 'uRelativisticMode', 'uLensingStrength', 'uDiskTemp', 'uDiskDensity',
  'uDiskThickness', 'uDiskOuterRadius', 'uTurbulence', 'uOrbitSpeed', 'uJetIntensity',
  'uSkyIntensity', 'uSkyMode', 'uSkyRotation', 'uQuality',
];
const missingGlInShader = expectedGlContract.filter((u) => !bhGlUniforms.has(u));
const unboundGl = [...bhGlUniforms].filter((u) => !glRenSrc.includes(u));
assert(
  missingGlInShader.length === 0 && unboundGl.length === 0,
  'blackhole.frag.js <-> WebGLRenderer.js 26-uniform parity',
  `declared=${bhGlUniforms.size}`
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
const unboundPostGl = [...postGlUniforms].filter((u) => !glRenSrc.includes(u));
assert(
  unboundPostGl.length === 0,
  'post.glsl.js <-> WebGLRenderer.js uniform parity',
  `${postGlUniforms.size} post uniforms bound`
);

// Presets, ControlsHUD & backend toggle placement checks
const { DEFAULT_STATE, PRESETS } = await import(path.join(ROOT, 'src/engine/Presets.js'));
const hudSrc = fs.readFileSync(path.join(ROOT, 'src/ui/ControlsHUD.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const expectedPresetIds = ['gargantua', 'relativistic', 'schwarzschild', 'millers', 'm87', 'quasar'];
const actualIds = PRESETS.map((p) => p.id);
assert(
  expectedPresetIds.every((id) => actualIds.includes(id)),
  'Presets.js exports all 6 required presets',
  `ids: ${actualIds.join(', ')}`
);

const controlKeys = [
  'spin', 'relativisticMode', 'lensingStrength', 'diskTemp', 'diskDensity',
  'diskThickness', 'diskOuterRadius', 'turbulence', 'orbitSpeed', 'jetIntensity',
  'exposure', 'bloomIntensity', 'anamorphicIntensity', 'skyIntensity', 'skyMode',
  'quality', 'resolutionScale',
];
assert(
  controlKeys.every((k) => k in DEFAULT_STATE) && controlKeys.every((k) => hudSrc.includes(k)),
  'DEFAULT_STATE and ControlsHUD.js share all 17 physics/optics parameters'
);
assert(
  hudSrc.includes("key: 'backend'") &&
    hudSrc.includes("value: 'webgl2'") &&
    hudSrc.includes("value: 'webgpu'") &&
    !htmlSrc.includes('ctrl-backend'),
  'Rendering Backend toggle (WebGL2/WebGPU) lives inside collapsible ControlsHUD drawer, not main HUD chrome'
);

// Dual-backend physicalLuts.js verification (mock GPUDevice AND mock WebGL2RenderingContext)
const lutsMod = await import(path.join(ROOT, 'src/assets/physicalLuts.js'));
assert(
  lutsMod.BLACKBODY_T_MIN === 800.0 && lutsMod.BLACKBODY_T_MAX === 40000.0,
  'physicalLuts.js exports exact temperature range [800K, 40000K]',
  `[${lutsMod.BLACKBODY_T_MIN}, ${lutsMod.BLACKBODY_T_MAX}]`
);

let gpuUploaded = null;
globalThis.GPUTextureUsage = globalThis.GPUTextureUsage || { TEXTURE_BINDING: 4, COPY_DST: 2 };
const mockDevice = {
  createTexture: (desc) => ({ desc, createView: () => ({ id: 'mockView' }) }),
  queue: {
    writeTexture: (dst, data, layout, size) => {
      gpuUploaded = { desc: dst.texture.desc, data, layout, size };
    },
  },
};
const gpuLutRes = lutsMod.createBlackbodyLUT(mockDevice, 512);
assert(
  Boolean(gpuLutRes?.texture && gpuLutRes?.view && gpuUploaded?.size[0] === 512 && gpuUploaded?.desc.format === 'rgba16float'),
  'createBlackbodyLUT handles WebGPU GPUDevice (512x1 rgba16float)'
);

let glUploaded = null;
const mockGl = {
  TEXTURE_2D: 0x0de1, RGBA16F: 0x881a, RGBA8: 0x8058, RGBA: 0x1908,
  HALF_FLOAT: 0x140b, UNSIGNED_BYTE: 0x1401, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f, NO_ERROR: 0,
  createTexture: () => ({ id: 'mockGlTex' }),
  bindTexture: () => {},
  texParameteri: () => {},
  getError: () => 0,
  texImage2D: (_t, _l, internalFormat, width, height, _b, _f, type, data) => {
    glUploaded = { internalFormat, width, height, type, data };
  },
};
const glLutRes = lutsMod.createBlackbodyLUT(mockGl, 512);
assert(
  Boolean(glLutRes?.texture && glUploaded?.width === 512 && glUploaded?.internalFormat === mockGl.RGBA16F),
  'createBlackbodyLUT handles WebGL2RenderingContext (512x1 RGBA16F)'
);

if (gpuUploaded?.data) {
  function halfToFloat(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  function sampleT(T) {
    const u = Math.log(T / 800.0) / Math.log(40000.0 / 800.0);
    const idx = Math.max(0, Math.min(511, Math.round(u * 511)));
    const d = gpuUploaded.data;
    return [halfToFloat(d[idx * 4]), halfToFloat(d[idx * 4 + 1]), halfToFloat(d[idx * 4 + 2])];
  }
  const c1500 = sampleT(1500);
  const c6500 = sampleT(6500);
  const c25000 = sampleT(25000);
  const allValid = [...c1500, ...c6500, ...c25000].every((v) => Number.isFinite(v) && v >= 0 && v <= 1.01);
  const normMax = (c) => Math.max(c[0], c[1], c[2]);
  assert(
    allValid && approx(normMax(c1500), 1.0, 0.02) && approx(normMax(c6500), 1.0, 0.02) && approx(normMax(c25000), 1.0, 0.02),
    'Planck LUT max-normalized linear RGB without NaN/Inf',
    `1500K=[${c1500.map((v) => v.toFixed(2))}], 6500K=[${c6500.map((v) => v.toFixed(2))}], 25000K=[${c25000.map((v) => v.toFixed(2))}]`
  );
  assert(
    c1500[0] > c1500[1] && c1500[1] > c1500[2] &&
    Math.abs(c6500[0] - c6500[2]) < 0.25 &&
    c25000[2] > c25000[1] && c25000[1] > c25000[0],
    'Planck LUT chromaticity progression (1500K red-amber -> 6500K white -> 25000K blue-white)'
  );
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
