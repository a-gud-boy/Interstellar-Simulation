#!/usr/bin/env node
/**
 * Unified Interstellar Simulation Test Runner
 *
 * Orchestrates shared contract checks, 9-simulator physics checks,
 * native Rust desktop parity/shader tests, and headed NVIDIA GPU QA suites.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SIMULATORS, resolveSimByAlias } from '../shared/simRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`Usage: node scripts/run-tests.mjs [options]

Options:
  --physics          Run shared/tests/shared_check.mjs and <sim>/tests/physics_check.mjs (default)
  --desktop          Run cargo test --test physics_parity --test shader_validation in desktop/
  --homepage         Run shared/tests/homepage_qa.mjs (Chrome X11 NVIDIA; skips if prereqs absent)
  --browser          Run homepage_qa.mjs (when unscoped) and <sim>/tests/browser_qa.mjs (Chrome X11 NVIDIA)
  --firefox          Run <sim>/tests/firefox_qa.mjs (Firefox Wayland NVIDIA; skips if prereqs absent)
  --parity           Run scripts/parity-diff.mjs (WebGL2 vs WebGPU PSNR/SSIM diffing; skips if prereqs absent)
  --all              Run --physics, --desktop, --browser (incl. --homepage), and --firefox
  --sim <name>       Scope web suites to specific simulator(s) (repeatable or comma-separated)
  -h, --help         Show this help message and exit`);
}

function parseArgs(argv) {
  const opts = {
    physics: false,
    desktop: false,
    homepage: false,
    browser: false,
    firefox: false,
    parity: false,
    simTokens: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--physics') {
      opts.physics = true;
    } else if (arg === '--desktop') {
      opts.desktop = true;
    } else if (arg === '--homepage') {
      opts.homepage = true;
    } else if (arg === '--browser') {
      opts.browser = true;
    } else if (arg === '--firefox') {
      opts.firefox = true;
    } else if (arg === '--parity') {
      opts.parity = true;
    } else if (arg === '--all') {
      opts.physics = true;
      opts.desktop = true;
      opts.browser = true;
      opts.firefox = true;
    } else if (arg === '--sim') {
      const next = argv[++i];
      if (!next) {
        console.error('Error: --sim requires an argument.');
        process.exit(2);
      }
      opts.simTokens.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--sim=')) {
      const val = arg.slice('--sim='.length);
      opts.simTokens.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!opts.physics && !opts.desktop && !opts.homepage && !opts.browser && !opts.firefox && !opts.parity) {
    opts.physics = true;
  }
  return opts;
}

function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasNvidiaGpu() {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runStep(results, label, cmd, args) {
  console.log(`\n============================================================`);
  console.log(`RUN: ${label}`);
  console.log(`CMD: ${cmd} ${args.join(' ')}`);
  console.log(`============================================================`);
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (res.error) {
    console.error(`[FAIL] ${label}: ${res.error.message}`);
    results.push({ label, status: 'FAIL' });
    return false;
  }
  const ok = res.status === 0;
  results.push({ label, status: ok ? 'PASS' : 'FAIL' });
  return ok;
}

function skipStep(results, label, reason) {
  console.log(`\n[SKIP] ${label} — ${reason}`);
  results.push({ label, status: 'SKIP', reason });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let selectedSims = SIMULATORS;
  const scopedBySim = opts.simTokens.length > 0;
  if (scopedBySim) {
    const resolved = [];
    const seenIds = new Set();
    for (const token of opts.simTokens) {
      const sim = resolveSimByAlias(token, { strict: true });
      if (!sim) {
        console.error(`Error: Unknown simulator "${token}". Valid IDs: ${SIMULATORS.map((s) => s.id).join(', ')}`);
        process.exit(2);
      }
      if (!seenIds.has(sim.id)) {
        seenIds.add(sim.id);
        resolved.push(sim);
      }
    }
    selectedSims = resolved;
  }

  const results = [];

  if (opts.physics) {
    if (!scopedBySim) {
      runStep(results, 'shared_check', process.execPath, ['shared/tests/shared_check.mjs']);
    }
    for (const sim of selectedSims) {
      const script = path.join(sim.dir, 'tests/physics_check.mjs');
      runStep(results, `${sim.dir} physics_check`, process.execPath, [script]);
    }
  }

  if (opts.desktop) {
    if (!commandExists('cargo')) {
      results.push({ label: 'desktop cargo tests', status: 'FAIL', reason: 'cargo not found in PATH' });
      console.error('[FAIL] desktop cargo tests — cargo not found in PATH');
    } else {
      runStep(results, 'desktop physics_parity & shader_validation', 'cargo', [
        'test',
        '--manifest-path',
        'desktop/Cargo.toml',
        '--test',
        'physics_parity',
        '--test',
        'shader_validation',
      ]);
    }
  }

  const runHomepage = opts.homepage || (opts.browser && !scopedBySim);
  if (runHomepage || opts.browser) {
    const missing = [];
    if (!fs.existsSync('/usr/bin/google-chrome')) missing.push('/usr/bin/google-chrome');
    if (!process.env.DISPLAY) missing.push('DISPLAY (headed X11)');
    if (!hasNvidiaGpu()) missing.push('nvidia-smi');

    if (missing.length > 0) {
      if (runHomepage) {
        skipStep(results, 'homepage_qa', `missing prerequisites: ${missing.join(', ')}`);
      }
      if (opts.browser) {
        for (const sim of selectedSims) {
          skipStep(results, `${sim.dir} browser_qa`, `missing prerequisites: ${missing.join(', ')}`);
        }
      }
    } else {
      if (runHomepage) {
        runStep(results, 'homepage_qa', process.execPath, ['shared/tests/homepage_qa.mjs']);
      }
      if (opts.browser) {
        for (const sim of selectedSims) {
          const script = path.join(sim.dir, 'tests/browser_qa.mjs');
          runStep(results, `${sim.dir} browser_qa`, process.execPath, [script]);
        }
      }
    }
  }

  if (opts.firefox) {
    const missing = [];
    if (!commandExists('firefox')) missing.push('firefox');
    if (!process.env.WAYLAND_DISPLAY) missing.push('WAYLAND_DISPLAY (headed Wayland)');
    if (!hasNvidiaGpu()) missing.push('nvidia-smi');

    if (missing.length > 0) {
      for (const sim of selectedSims) {
        skipStep(results, `${sim.dir} firefox_qa`, `missing prerequisites: ${missing.join(', ')}`);
      }
    } else {
      for (const sim of selectedSims) {
        const script = path.join(sim.dir, 'tests/firefox_qa.mjs');
        runStep(results, `${sim.dir} firefox_qa`, process.execPath, [script]);
      }
    }
  }

  if (opts.parity) {
    const missing = [];
    if (!fs.existsSync('/usr/bin/google-chrome')) missing.push('/usr/bin/google-chrome');
    if (!process.env.DISPLAY) missing.push('DISPLAY (headed X11)');
    if (!hasNvidiaGpu()) missing.push('nvidia-smi');

    if (missing.length > 0) {
      skipStep(results, 'parity_diff', `missing prerequisites: ${missing.join(', ')}`);
    } else {
      const args = ['scripts/parity-diff.mjs'];
      if (scopedBySim) {
        args.push('--sim', selectedSims.map((s) => s.id).join(','));
      }
      runStep(results, 'parity_diff', process.execPath, args);
    }
  }

  const passCount = results.filter((r) => r.status === 'PASS').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;

  console.log('\n==================== TEST RUNNER SUMMARY ====================');
  for (const r of results) {
    const suffix = r.reason ? ` (${r.reason})` : '';
    console.log(`  [${r.status}] ${r.label}${suffix}`);
  }
  console.log(`Total: ${passCount} passed, ${skipCount} skipped, ${failCount} failed`);

  process.exitCode = failCount > 0 ? 1 : 0;
}

main();
