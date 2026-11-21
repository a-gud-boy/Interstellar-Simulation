#!/usr/bin/env node
/**
 * Antigravity PostToolUse + PostInvocation hook for Interstellar Simulation.
 *
 * - PostToolUse: Inspects the edited file path. If it lies under
 *   `<sim>/src/engine/` or `<sim>/src/shaders/` for one of the four simulators,
 *   runs `node <sim>/tests/physics_check.mjs` (zero-dependency contract check).
 *   Always emits `{}` on stdout per Antigravity's PostToolUse contract.
 *   On failure, writes concise `[FAIL]` diagnostics to stderr, caches the
 *   failure per `conversationId` in os.tmpdir(), and exits 1. On pass, clears
 *   any cached failure for that simulator (supporting multi-file WebGL2/WebGPU
 *   edit batches) and exits 0. Non-matching edits exit 0 immediately as a no-op.
 *
 * - PostInvocation: Consumes any remaining unfixed failure for the current
 *   `conversationId` and injects it into model context via `injectSteps`
 *   (`systemMessage`) with `terminationBehavior: ""` (non-aborting), per
 *   Antigravity's documented hooks.md contract.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIM_EDIT_RE =
  /^(blackhole-sim|wormhole-sim|binary-bh-sim|warp-drive-sim)\/src\/(engine|shaders)\//;

function readStdinUtf8() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function getStateFile(conversationId) {
  const safeId = String(conversationId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(os.tmpdir(), `agy-interstellar-physics-hook-${safeId}.json`);
}

function loadPendingFailures(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePendingFailures(stateFile, data) {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    try {
      fs.unlinkSync(stateFile);
    } catch {
      // ignore missing file
    }
    return;
  }
  try {
    fs.writeFileSync(stateFile, JSON.stringify(data), 'utf8');
  } catch {
    // non-fatal if tmpdir is unavailable
  }
}

function resolveRepoRoot(payload) {
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) {
    return path.resolve(payload.workspacePaths[0]);
  }
  if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
    return path.resolve(payload.cwd);
  }
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '../..');
}

function extractEditedPath(payload) {
  const args = payload?.toolCall?.args;
  if (!args || typeof args !== 'object') return null;
  for (const key of ['Path', 'path', 'TargetFile', 'targetFile', 'filePath', 'file_path']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return args[key].trim();
    }
  }
  return null;
}

function summarizeFailure(sim, relEdited, result) {
  const lines = [];
  const combinedOut = `${result.stdout || ''}\n${result.stderr || ''}`.split(/\r?\n/);

  const failLines = combinedOut
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[FAIL]') || l.includes('[FAIL]'));
  const summaryLine = combinedOut
    .map((l) => l.trim())
    .find((l) => l.startsWith('SUMMARY:'));

  lines.push(
    `[physics_check FAILED] ${sim}/tests/physics_check.mjs (triggered by edit to ${relEdited})`
  );

  if (result.error) {
    lines.push(`  Runner error: ${result.error.message}`);
  }
  if (result.signal) {
    lines.push(`  Terminated by signal: ${result.signal}`);
  }

  if (failLines.length > 0) {
    const shown = failLines.slice(0, 12);
    for (const f of shown) lines.push(`  ${f}`);
    if (failLines.length > shown.length) {
      lines.push(`  ... and ${failLines.length - shown.length} more [FAIL] line(s)`);
    }
  } else {
    const tail = combinedOut
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-8);
    for (const t of tail) lines.push(`  ${t}`);
  }

  if (summaryLine) {
    lines.push(`  ${summaryLine}`);
  }
  lines.push(`  Re-run: node ${sim}/tests/physics_check.mjs`);
  return lines.join('\n');
}

function handlePostInvocation(payload) {
  const stateFile = getStateFile(payload.conversationId);
  const pending = loadPendingFailures(stateFile);
  const entries = Object.values(pending).filter((v) => typeof v === 'string' && v.trim());

  if (entries.length === 0) {
    process.stdout.write(`${JSON.stringify({ injectSteps: [], terminationBehavior: '' })}\n`);
    process.exit(0);
  }

  // Consume once so fixed or acknowledged diagnostics do not loop across turns.
  savePendingFailures(stateFile, {});

  const message = [
    'Post-edit physics_check.mjs reported failures that remain unresolved after your latest edits:',
    '',
    ...entries,
  ].join('\n');

  const response = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: message,
        },
      },
    ],
    terminationBehavior: '',
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(0);
}

function handlePostToolUse(payload) {
  // Always emit valid empty JSON object on stdout per Antigravity's PostToolUse contract.
  const finish = (code = 0) => {
    process.stdout.write('{}\n');
    process.exit(code);
  };

  // If the edit tool itself failed, do not run contract checks against partial/missing edits.
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    finish(0);
  }

  const rawPath = extractEditedPath(payload);
  if (!rawPath) {
    finish(0);
  }

  const repoRoot = resolveRepoRoot(payload);
  const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(repoRoot, rawPath);
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');

  const match = SIM_EDIT_RE.exec(relPath);
  if (!match) {
    finish(0);
  }

  const sim = match[1];
  const testScript = path.join(repoRoot, sim, 'tests', 'physics_check.mjs');
  if (!fs.existsSync(testScript)) {
    finish(0);
  }

  const result = spawnSync(process.execPath, [testScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 40_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const stateFile = getStateFile(payload.conversationId);
  const pending = loadPendingFailures(stateFile);

  if (result.status === 0 && !result.error) {
    if (pending[sim]) {
      delete pending[sim];
      savePendingFailures(stateFile, pending);
    }
    finish(0);
  }

  const report = summarizeFailure(sim, relPath, result);
  pending[sim] = report;
  savePendingFailures(stateFile, pending);
  process.stderr.write(`${report}\n`);
  finish(1);
}

function main() {
  const raw = readStdinUtf8().trim();
  if (!raw) {
    process.stdout.write('{}\n');
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write('{}\n');
    process.exit(0);
  }

  const eventName = payload?.hookEventName;
  if (eventName === 'PostInvocation' || (!payload?.toolCall && payload?.invocationNum !== undefined)) {
    handlePostInvocation(payload);
  } else {
    handlePostToolUse(payload);
  }
}

main();
