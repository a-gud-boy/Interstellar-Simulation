#!/usr/bin/env node
/**
 * Wormhole Simulator (Unified WebGL2 + WebGPU) — Automated Headed Firefox NVIDIA Wayland QA Suite
 *
 * Strictly follows the firefox-webgpu-nvidia runbook:
 *  - NEVER uses --headless (always launches real headed Firefox Wayland with NVIDIA offload env)
 *  - Configures isolated temporary profile user.js with:
 *      dom.webgpu.enabled = true
 *      gfx.webgpu.ignore-blocklist = true
 *      dom.webgpu.allow-present-without-readback = false
 *  - Uses MOZ_LOG=WebGPU:4 and all 6 NVIDIA offload environment variables
 *  - Verifies nvidia-smi shows active `firefox` GPU process
 *  - Verifies SharedTexture swapchain readback log active on stderr and zero Device-lost errors
 *  - Verifies continuous rendering on WebGPU -> live toggle to WebGL2 -> live toggle back to WebGPU
 *    with camera pose preserved across switches
 *  - Saves capturePNG() screenshots (firefox_webgpu.png, firefox_webgl2.png, firefox_webgpu_after_switch.png)
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
    const blob = await window.__WORMHOLE__.capturePNG();
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
    const diag = window.__WORMHOLE__.getDiagnostics();
    const tel = window.__WORMHOLE__.getTelemetry();
    return { rafCount, fps: tel.fps, diag };
  };
  const waitReadyBackend = async (backend, timeoutMs = 20000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = window.__WORMHOLE__?.getDiagnostics?.();
      if (d && d.backend === backend && !d.switchingBackend && d.skyMapLoaded === true) {
        return d;
      }
      await sleep(120);
    }
    return window.__WORMHOLE__?.getDiagnostics?.();
  };

  try {
    const t0 = performance.now();
    while (!window.__WORMHOLE__ && performance.now() - t0 < 20000) {
      await sleep(100);
    }
    if (!window.__WORMHOLE__) {
      throw new Error('window.__WORMHOLE__ failed to mount in Firefox within 20s');
    }

    const report = { steps: {}, runtimeErrors: [] };
    window.addEventListener('error', (e) => report.runtimeErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', (e) => report.runtimeErrors.push(String(e.reason)));

    // 1. Initial WebGPU boot (?backend=webgpu) + continuous 2.6s render check
    await waitReadyBackend('webgpu');
    window.__WORMHOLE__.setState({ paused: false, autoOrbit: true });
    const webgpuRun1 = await countRafAndFps(2600);
    window.__WORMHOLE__.setState({ paused: true, autoOrbit: false });
    await sleep(300);
    const png1 = await postPng('firefox_webgpu.png');
    report.steps.initialWebGPU = { ...webgpuRun1, pngBytes: png1 };

    // 2. Open Controls drawer & switch live WebGPU -> WebGL2 while testing camera preservation
    document.getElementById('controls-toggle')?.click();
    await sleep(250);
    window.__WORMHOLE__.setState({
      paused: true,
      autoOrbit: false,
      camera: { l: 12.0, elevationDeg: 10.5, azimuthDeg: 25.0, lookYawDeg: 0.0, lookPitchDeg: 0.0, rollDeg: -2.5 },
    });
    const camBeforeGL = window.__WORMHOLE__.getState().camera;

    document.getElementById('ctrl-backend-webgl2')?.click();
    const afterGL = await waitReadyBackend('webgl2');
    const camAfterGL = window.__WORMHOLE__.getState().camera;
    window.__WORMHOLE__.setState({ paused: false, autoOrbit: true });
    const webglRun = await countRafAndFps(1800);
    window.__WORMHOLE__.setState({ paused: true, autoOrbit: false });
    await sleep(300);
    const png2 = await postPng('firefox_webgl2.png');
    report.steps.switchedWebGL2 = {
      ...webglRun,
      diagImmediate: afterGL,
      camBefore: camBeforeGL,
      camAfter: camAfterGL,
      pngBytes: png2,
    };

    // 3. Switch live BACK WebGL2 -> WebGPU via Controls drawer + verify camera preservation & continuous rendering
    window.__WORMHOLE__.setState({
      paused: true,
      autoOrbit: false,
      camera: { l: 11.0, elevationDeg: 8.5, azimuthDeg: 18.0, lookYawDeg: 0.0, lookPitchDeg: 0.0, rollDeg: -3.0 },
    });
    const camBeforeGPU = window.__WORMHOLE__.getState().camera;
    document.getElementById('ctrl-backend-webgpu')?.click();
    const afterGPU = await waitReadyBackend('webgpu');
    const camAfterGPU = window.__WORMHOLE__.getState().camera;
    document.getElementById('controls-close')?.click();
    window.__WORMHOLE__.selectPreset('interstellar', true);
    window.__WORMHOLE__.setState({ paused: false, autoOrbit: true });
    const webgpuRun2 = await countRafAndFps(2600);
    window.__WORMHOLE__.setState({ paused: true, autoOrbit: false });
    await sleep(300);
    const png3 = await postPng('firefox_webgpu_after_switch.png');
    report.steps.switchedBackWebGPU = {
      ...webgpuRun2,
      diagImmediate: afterGPU,
      camBefore: camBeforeGPU,
      camAfter: camAfterGPU,
      pngBytes: png3,
    };

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

function cameraMatches(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs((a.l ?? 999) - (b.l ?? -999)) < 0.2 &&
    Math.abs((a.elevationDeg ?? 999) - (b.elevationDeg ?? -999)) < 0.5 &&
    Math.abs((a.azimuthDeg ?? 999) - (b.azimuthDeg ?? -999)) < 0.5 &&
    Math.abs((a.rollDeg ?? 999) - (b.rollDeg ?? -999)) < 0.5
  );
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, donePromise } = await startStaticServer({
    shotDir: SHOT_DIR,
    enableQaEndpoints: true,
    injectTargetRel: 'wormhole-sim/index.html',
    injectScript: INJECTED_QA_SCRIPT,
  });

  const targetUrl = `http://127.0.0.1:${port}/wormhole-sim/?backend=webgpu`;
  let sawFirefoxOnNvidia = false;
  let report;
  let stderr = '';
  try {
    ({ sawFirefoxOnNvidia, report, stderr } = await runHeadedFirefoxQA({
      targetUrl,
      donePromise,
      profilePrefix: 'wormhole-firefox-qa-',
      timeoutMs: 45000,
    }));
  } finally {
    server.close();
  }

  fs.writeFileSync(
    path.join(SHOT_DIR, 'firefox_qa_report.json'),
    JSON.stringify({ sawFirefoxOnNvidia, report, stderrSnippet: stderr.slice(-2000) }, null, 2)
  );

  console.log('\n=== AUTOMATED WORMHOLE HEADED FIREFOX NVIDIA QA ASSERTIONS ===');
  let qaFail = 0;
  const check = (cond, msg, detail = '') => {
    if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
    else { qaFail++; console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`); }
  };

  check(!report?.fatalError, 'Firefox QA script completed without fatal error', report?.fatalError || 'OK');
  check(sawFirefoxOnNvidia, 'nvidia-smi listed firefox under active NVIDIA GPU processes');
  check(
    stderr.includes('SharedTexture') && stderr.includes('dom.webgpu.allow-present-without-readback'),
    'Firefox stderr confirms SharedTexture readback workaround is active'
  );
  check(!/Device is lost/i.test(stderr), 'Firefox stderr contains zero WebGPU "Device is lost" errors');
  check((report?.runtimeErrors || []).length === 0, 'Zero Firefox page JS runtime errors', (report?.runtimeErrors || []).join(' | '));

  const s1 = report?.steps?.initialWebGPU;
  check(
    s1?.diag?.backend === 'webgpu' && s1?.diag?.allShadersCompiled === true && s1?.diag?.skyMapLoaded === true,
    'Initial Firefox WebGPU boot compiled & loaded 4K sky',
    s1?.diag?.canvasFormat
  );
  check((s1?.fps || 0) > 2 && (s1?.rafCount || 0) > 15, 'Firefox WebGPU renders continuously over 2.6s', `fps=${s1?.fps}, rafs=${s1?.rafCount}`);
  check((s1?.pngBytes || 0) > 50000, 'Firefox WebGPU capturePNG() offscreen readback valid (>50KB)', `${s1?.pngBytes} bytes`);

  const s2 = report?.steps?.switchedWebGL2;
  check(
    s2?.diag?.backend === 'webgl2' && s2?.diag?.allShadersCompiled === true && s2?.diag?.skyMapLoaded === true,
    'Firefox live switch WebGPU -> WebGL2 succeeded cleanly',
    s2?.diag?.webglRenderer
  );
  check(cameraMatches(s2?.camBefore, s2?.camAfter), 'Firefox preserved camera pose across WebGPU -> WebGL2 switch');
  check((s2?.fps || 0) > 2 && (s2?.pngBytes || 0) > 50000, 'Firefox WebGL2 renders & exports PNG after switch (>50KB)', `fps=${s2?.fps}, ${s2?.pngBytes} bytes`);

  const s3 = report?.steps?.switchedBackWebGPU;
  check(
    s3?.diag?.backend === 'webgpu' && s3?.diag?.allShadersCompiled === true && (!s3?.diag?.errors || s3.diag.errors.length === 0),
    'Firefox live round-trip switch WebGL2 -> WebGPU succeeded cleanly'
  );
  check(cameraMatches(s3?.camBefore, s3?.camAfter), 'Firefox preserved camera pose across WebGL2 -> WebGPU switch');
  check((s3?.fps || 0) > 2 && (s3?.pngBytes || 0) > 50000, 'Firefox WebGPU after round-trip switch renders continuously & exports PNG (>50KB)', `fps=${s3?.fps}, ${s3?.pngBytes} bytes`);

  process.exitCode = qaFail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL FIREFOX QA ERROR:', err);
  process.exit(1);
});
