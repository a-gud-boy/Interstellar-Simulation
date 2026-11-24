#!/usr/bin/env node
/**
 * Magnetar & Millisecond Pulsar (Unified WebGL2 + WebGPU) — Automated Headed Firefox NVIDIA Wayland QA Suite
 *
 * Strictly follows the firefox-webgpu-nvidia runbook:
 *  - NEVER uses --headless (always launches real headed Firefox Wayland with NVIDIA offload env)
 *  - Configures isolated temporary profile user.js with:
 *      dom.webgpu.enabled = true
 *      gfx.webgpu.ignore-blocklist = true
 *      dom.webgpu.allow-present-without-readback = false
 *  - Verifies nvidia-smi shows active `firefox` GPU process
 *  - Verifies SharedTexture swapchain readback workaround active on stderr and zero Device-lost errors
 *  - Verifies continuous rendering on WebGPU -> live toggle to WebGL2 -> live toggle back to WebGPU + Magnetar & Torus presets
 *  - Saves capturePNG() screenshots + firefox_qa_report.json under pulsar-sim/tests/screenshots/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../shared/testing/staticServer.mjs';
import { runHeadedFirefoxQA } from '../../shared/testing/firefoxHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const INJECTED_QA_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const postPng = async (name) => {
    const blob = await window.__PULSAR__.capturePNG();
    const buf = await blob.arrayBuffer();
    await fetch('/__qa_png?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: buf,
    });
    return buf.byteLength;
  };
  const countRafAndFps = async (ms = 2600) => {
    let rafCount = 0;
    let active = true;
    const step = () => { if (active) { rafCount++; requestAnimationFrame(step); } };
    requestAnimationFrame(step);
    await sleep(ms);
    active = false;
    const diag = window.__PULSAR__.getDiagnostics();
    const tel = window.__PULSAR__.getTelemetry();
    return { rafCount, fps: tel.fps, diag };
  };
  const waitReadyBackend = async (backend, timeoutMs = 20000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = window.__PULSAR__?.getDiagnostics?.();
      if (d && d.backend === backend && !d.switchingBackend && d.skyMapLoaded === true) {
        return d;
      }
      await sleep(120);
    }
    return window.__PULSAR__?.getDiagnostics?.();
  };
  const waitSamples = async (target = 10, timeoutMs = 5000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = window.__PULSAR__?.getDiagnostics?.();
      if (d && (d.samples ?? 0) >= target) return d;
      await sleep(100);
    }
    return window.__PULSAR__?.getDiagnostics?.();
  };
  const selectPreset = (id) => {
    if (typeof window.__PULSAR__.selectPreset === 'function') {
      return window.__PULSAR__.selectPreset(id, true);
    }
    return window.__PULSAR__.applyPreset(id, true);
  };

  try {
    const t0 = performance.now();
    while (!window.__PULSAR__ && performance.now() - t0 < 20000) {
      await sleep(100);
    }
    if (!window.__PULSAR__) {
      throw new Error('window.__PULSAR__ failed to mount in Firefox within 20s');
    }

    const report = { steps: {}, runtimeErrors: [] };
    window.addEventListener('error', (e) => report.runtimeErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', (e) => report.runtimeErrors.push(String(e.reason)));

    // 1. Initial WebGPU boot (?backend=webgpu) + continuous 2.6s render check
    await waitReadyBackend('webgpu');
    window.__PULSAR__.setState({ paused: false, autoOrbit: true });
    const webgpuRun1 = await countRafAndFps(2600);
    window.__PULSAR__.setState({ paused: true, autoOrbit: false });
    await waitSamples(6, 2500);
    await sleep(250);
    const png1 = await postPng('firefox_webgpu.png');
    report.steps.initialWebGPU = { ...webgpuRun1, pngBytes: png1 };

    // 2. Open Controls drawer & switch live to WebGL2 while testing camera preservation
    document.getElementById('controls-toggle')?.click();
    await sleep(250);
    window.__PULSAR__.setState({
      paused: true,
      autoOrbit: false,
      camera: { distance: 7.5, pivot: [0.2, -0.1, 0.2], azimuthDeg: 52.0, elevationDeg: 24.0, rollDeg: -5.0, fovDeg: 46.0 },
    });
    const camBefore = window.__PULSAR__.getState().camera;

    document.getElementById('ctrl-backend-webgl2')?.click();
    const afterGL = await waitReadyBackend('webgl2');
    const camAfterGL = window.__PULSAR__.getState().camera;
    window.__PULSAR__.setState({ paused: false, autoOrbit: true });
    const webglRun = await countRafAndFps(1800);
    window.__PULSAR__.setState({ paused: true, autoOrbit: false });
    await waitSamples(6, 2500);
    await sleep(250);
    const png2 = await postPng('firefox_webgl2.png');
    report.steps.switchedWebGL2 = {
      ...webglRun,
      diagImmediate: afterGL,
      camBefore,
      camAfter: camAfterGL,
      pngBytes: png2,
    };

    // 3. Switch live BACK to WebGPU via Controls drawer + verify 2.6s continuous rendering
    document.getElementById('ctrl-backend-webgpu')?.click();
    const afterGPU = await waitReadyBackend('webgpu');
    document.getElementById('controls-close')?.click();
    selectPreset('magnetar');
    window.__PULSAR__.setState({ paused: false, autoOrbit: true });
    const webgpuRun2 = await countRafAndFps(2600);
    window.__PULSAR__.setState({ paused: true, autoOrbit: false });
    await waitSamples(10, 3000);
    await sleep(250);
    const png3 = await postPng('firefox_magnetar_webgpu.png');
    report.steps.switchedBackWebGPU = { ...webgpuRun2, diagImmediate: afterGPU, pngBytes: png3 };

    // 4. Torus & Jet PWN preset capture on WebGPU
    selectPreset('pwn_torus');
    window.__PULSAR__.setState({ paused: true, autoOrbit: false });
    await waitSamples(12, 3500);
    await sleep(250);
    const torusDiag = window.__PULSAR__.getDiagnostics();
    const png4 = await postPng('firefox_pwn_torus_webgpu.png');
    report.steps.torusWebGPU = { diag: torusDiag, pngBytes: png4 };

    await fetch('/__qa_done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (err) {
    await fetch('/__qa_done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fatalError: String(err?.stack || err) }),
    });
  }
})();
`;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, donePromise } = await startStaticServer({
    shotDir: SHOT_DIR,
    enableQaEndpoints: true,
    injectTargetRel: 'pulsar-sim/index.html',
    injectScript: INJECTED_QA_SCRIPT,
  });

  const targetUrl = `http://127.0.0.1:${port}/pulsar-sim/?backend=webgpu`;
  let sawFirefoxOnNvidia = false;
  let report;
  let stderr = '';
  try {
    ({ sawFirefoxOnNvidia, report, stderr } = await runHeadedFirefoxQA({
      targetUrl,
      donePromise,
      profilePrefix: 'pulsar-firefox-qa-',
      timeoutMs: 60000,
    }));
  } finally {
    server.close();
  }

  fs.writeFileSync(
    path.join(SHOT_DIR, 'firefox_qa_report.json'),
    JSON.stringify({ sawFirefoxOnNvidia, report, stderrSnippet: stderr.slice(-2000) }, null, 2)
  );

  console.log('\n=== AUTOMATED HEADED FIREFOX NVIDIA QA ASSERTIONS ===');
  let qaFail = 0;
  const check = (cond, msg, detail = '') => {
    if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
    else {
      qaFail++;
      console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
    }
  };

  check(!report?.fatalError, 'Firefox QA script completed without fatal error', report?.fatalError || 'OK');
  check(sawFirefoxOnNvidia, 'nvidia-smi listed firefox under active NVIDIA GPU processes');
  check(
    stderr.includes('dom.webgpu.allow-present-without-readback'),
    'Firefox stderr confirms SharedTexture readback workaround is active'
  );
  check(!/Device is lost/i.test(stderr), 'Firefox stderr contains zero WebGPU "Device is lost" errors');
  check((report?.runtimeErrors || []).length === 0, 'Zero Firefox page JS runtime errors', (report?.runtimeErrors || []).join(' | '));

  const s1 = report?.steps?.initialWebGPU;
  check(
    s1?.diag?.backend === 'webgpu' &&
      s1?.diag?.allShadersCompiled === true &&
      s1?.diag?.volumeBaked === true &&
      s1?.diag?.skyMapLoaded === true,
    'Initial Firefox WebGPU boot compiled, baked volume & loaded 4K sky',
    s1?.diag?.canvasFormat
  );
  check((s1?.fps || 0) > 2 && (s1?.rafCount || 0) > 15, 'Firefox WebGPU renders continuously over 2.6s', `fps=${s1?.fps}, rafs=${s1?.rafCount}`);
  check((s1?.pngBytes || 0) > 50000, 'Firefox WebGPU capturePNG() offscreen readback valid', `${s1?.pngBytes} bytes`);

  const s2 = report?.steps?.switchedWebGL2;
  check(
    s2?.diag?.backend === 'webgl2' && s2?.diag?.allShadersCompiled === true && s2?.diag?.skyMapLoaded === true,
    'Firefox live switch WebGPU -> WebGL2 succeeded cleanly',
    s2?.diag?.webglRenderer
  );
  const camOk =
    s2?.camBefore &&
    s2?.camAfter &&
    Math.abs(s2.camAfter.distance - s2.camBefore.distance) < 0.2 &&
    Math.abs((s2.camAfter.pivot?.[0] ?? 0) - (s2.camBefore.pivot?.[0] ?? 0)) < 0.1 &&
    Math.abs((s2.camAfter.pivot?.[1] ?? 0) - (s2.camBefore.pivot?.[1] ?? 0)) < 0.1 &&
    Math.abs((s2.camAfter.pivot?.[2] ?? 0) - (s2.camBefore.pivot?.[2] ?? 0)) < 0.1 &&
    Math.abs(s2.camAfter.elevationDeg - s2.camBefore.elevationDeg) < 0.5 &&
    Math.abs(s2.camAfter.azimuthDeg - s2.camBefore.azimuthDeg) < 0.5 &&
    Math.abs(s2.camAfter.rollDeg - s2.camBefore.rollDeg) < 0.5;
  check(camOk, 'Firefox preserved camera pose & pivot across WebGPU -> WebGL2 switch');
  check((s2?.fps || 0) > 2 && (s2?.pngBytes || 0) > 50000, 'Firefox WebGL2 renders & exports PNG after switch', `fps=${s2?.fps}, ${s2?.pngBytes} bytes`);

  const s3 = report?.steps?.switchedBackWebGPU;
  check(
    s3?.diag?.backend === 'webgpu' &&
      s3?.diag?.allShadersCompiled === true &&
      s3?.diag?.volumeBaked === true &&
      (!s3?.diag?.errors || s3.diag.errors.length === 0),
    'Firefox live round-trip switch WebGL2 -> WebGPU (Magnetar preset) succeeded cleanly'
  );
  check((s3?.fps || 0) > 2 && (s3?.pngBytes || 0) > 50000, 'Firefox WebGPU after round-trip switch renders continuously & exports PNG', `fps=${s3?.fps}, ${s3?.pngBytes} bytes`);

  const s4 = report?.steps?.torusWebGPU;
  check(
    s4?.diag?.backend === 'webgpu' && s4?.diag?.activePreset === 'pwn_torus' && (s4?.pngBytes || 0) > 50000,
    'Firefox Torus & Jet PWN preset capture on WebGPU produced valid PNG',
    `${s4?.pngBytes} bytes`
  );

  process.exitCode = qaFail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL FIREFOX QA ERROR:', err);
  process.exit(1);
});
