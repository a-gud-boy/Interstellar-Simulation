#!/usr/bin/env node
/**
 * Relativistic Starflight (Unified WebGL2 + WebGPU) — Automated Headed Firefox NVIDIA Wayland QA Suite
 *
 * Strictly follows the firefox-webgpu-nvidia runbook:
 *  - NEVER uses --headless (always launches real headed Firefox Wayland with NVIDIA offload env)
 *  - Configures isolated temporary profile user.js with:
 *      dom.webgpu.enabled = true
 *      gfx.webgpu.ignore-blocklist = true
 *      dom.webgpu.allow-present-without-readback = false
 *  - Verifies nvidia-smi shows active `firefox` GPU process
 *  - Verifies SharedTexture swapchain readback workaround active on stderr and zero Device-lost errors
 *  - Verifies continuous rendering on WebGPU -> live toggle to WebGL2 -> live toggle back to WebGPU + cmb_glow & aft_redshift presets
 *  - Saves capturePNG() screenshots + firefox_qa_report.json under starflight-sim/tests/screenshots/
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(__dirname, '..');
const TRIAL_ROOT = path.resolve(SIM_ROOT, '..');
const SHOT_DIR = path.join(__dirname, 'screenshots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const INJECTED_QA_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const postPng = async (name) => {
    const blob = await window.__STARFLIGHT__.capturePNG();
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
    const diag = window.__STARFLIGHT__.getDiagnostics();
    const tel = window.__STARFLIGHT__.getTelemetry();
    return { rafCount, fps: tel.fps, diag };
  };
  const waitReadyBackend = async (backend, timeoutMs = 20000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = window.__STARFLIGHT__?.getDiagnostics?.();
      if (d && d.backend === backend && !d.switchingBackend && d.skyMapLoaded === true) {
        return d;
      }
      await sleep(120);
    }
    return window.__STARFLIGHT__?.getDiagnostics?.();
  };
  const waitSamples = async (target = 10, timeoutMs = 5000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = window.__STARFLIGHT__?.getDiagnostics?.();
      if (d && (d.samples ?? 0) >= target) return d;
      await sleep(100);
    }
    return window.__STARFLIGHT__?.getDiagnostics?.();
  };
  const selectPreset = (id) => {
    if (typeof window.__STARFLIGHT__.selectPreset === 'function') {
      return window.__STARFLIGHT__.selectPreset(id, true);
    }
    return window.__STARFLIGHT__.applyPreset(id, true);
  };

  try {
    const t0 = performance.now();
    while (!window.__STARFLIGHT__ && performance.now() - t0 < 20000) {
      await sleep(100);
    }
    if (!window.__STARFLIGHT__) {
      throw new Error('window.__STARFLIGHT__ failed to mount in Firefox within 20s');
    }

    const report = { steps: {}, runtimeErrors: [] };
    window.addEventListener('error', (e) => report.runtimeErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', (e) => report.runtimeErrors.push(String(e.reason)));

    // 1. Initial WebGPU boot (?backend=webgpu) + continuous 2.6s render check
    await waitReadyBackend('webgpu');
    window.__STARFLIGHT__.setState({ paused: false, autoOrbit: false });
    const webgpuRun1 = await countRafAndFps(2600);
    window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
    await waitSamples(6, 2500);
    await sleep(250);
    const png1 = await postPng('firefox_webgpu.png');
    report.steps.initialWebGPU = { ...webgpuRun1, pngBytes: png1 };

    // 2. Open Controls drawer & switch live to WebGL2 while testing camera preservation
    document.getElementById('controls-toggle')?.click();
    await sleep(250);
    window.__STARFLIGHT__.setState({
      paused: true,
      autoOrbit: false,
      flightPosZ: 0.0,
      camera: { lookYawDeg: 42.0, lookPitchDeg: -14.0, rollDeg: 8.0, fovDeg: 44.0 },
    });
    const camBefore = window.__STARFLIGHT__.getState().camera;

    document.getElementById('ctrl-backend-webgl2')?.click();
    const afterGL = await waitReadyBackend('webgl2');
    const camAfterGL = window.__STARFLIGHT__.getState().camera;
    window.__STARFLIGHT__.setState({ paused: false, autoOrbit: false });
    const webglRun = await countRafAndFps(1800);
    window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
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

    // 3. Switch live BACK to WebGPU via Controls drawer + verify 2.6s continuous rendering on cmb_glow
    document.getElementById('ctrl-backend-webgpu')?.click();
    const afterGPU = await waitReadyBackend('webgpu');
    document.getElementById('controls-close')?.click();
    selectPreset('cmb_glow');
    window.__STARFLIGHT__.setState({ paused: false, autoOrbit: false });
    const webgpuRun2 = await countRafAndFps(2600);
    window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
    await waitSamples(10, 3000);
    await sleep(250);
    const png3 = await postPng('firefox_cmb_glow_webgpu.png');
    report.steps.switchedBackWebGPU = { ...webgpuRun2, diagImmediate: afterGPU, pngBytes: png3 };

    // 4. Aft Redshift preset capture on WebGPU
    selectPreset('aft_redshift');
    window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
    await waitSamples(12, 3500);
    await sleep(250);
    const aftDiag = window.__STARFLIGHT__.getDiagnostics();
    const png4 = await postPng('firefox_aft_redshift_webgpu.png');
    report.steps.aftRedshiftWebGPU = { diag: aftDiag, pngBytes: png4 };

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

function angleDiffDeg(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function startQaServer() {
  let doneResolve;
  const donePromise = new Promise((res) => {
    doneResolve = res;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && reqUrl.pathname === '/__qa_runner.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      res.end(INJECTED_QA_SCRIPT);
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/__qa_png') {
      const name = path.basename(reqUrl.searchParams.get('name') || 'firefox_out.png');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(path.join(SHOT_DIR, name), buf);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/__qa_done') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        try {
          doneResolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          doneResolve({ fatalError: `Malformed report JSON: ${err.message}` });
        }
      });
      return;
    }

    let rel = reqUrl.pathname.replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) {
      rel += 'index.html';
    }
    const fullPath = path.resolve(TRIAL_ROOT, rel);
    if (!fullPath.startsWith(TRIAL_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (rel === 'starflight-sim/index.html') {
      fs.readFile(fullPath, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500);
          res.end(err.message);
          return;
        }
        const instrumented = html.replace(
          '</body>',
          '  <script type="module" src="/__qa_runner.js"></script>\n</body>'
        );
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(instrumented);
      });
      return;
    }

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(fullPath).pipe(res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, donePromise });
    });
  });
}

function checkNvidiaSmiFirefox() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-compute-apps=process_name', '--format=csv,noheader'], {
      encoding: 'utf8',
    });
    const fullOut = execFileSync('nvidia-smi', [], { encoding: 'utf8' });
    return /firefox/i.test(out) || /firefox/i.test(fullOut);
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, donePromise } = await startQaServer();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starflight-firefox-qa-'));

  fs.writeFileSync(
    path.join(profileDir, 'user.js'),
    `user_pref("dom.webgpu.enabled", true);
user_pref("gfx.webgpu.ignore-blocklist", true);
// Avoid Wayland DMABUF zero-copy swapchain hangs on Linux NVIDIA (Mozilla Bug 1927839)
user_pref("dom.webgpu.allow-present-without-readback", false);
`
  );

  const env = {
    ...process.env,
    MOZ_LOG: 'WebGPU:4',
    __NV_PRIME_RENDER_OFFLOAD: '1',
    __NV_PRIME_RENDER_OFFLOAD_PROVIDER: 'NVIDIA-G0',
    __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
    __VK_LAYER_NV_optimus: 'NVIDIA_only',
    __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json',
    VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json',
  };
  delete env.MOZ_ENABLE_WAYLAND;

  const targetUrl = `http://127.0.0.1:${port}/starflight-sim/?backend=webgpu`;
  console.log(`Launching headed Firefox Wayland on NVIDIA GPU: ${targetUrl}`);

  const ff = spawn(
    'firefox',
    ['--no-remote', '--profile', profileDir, '--width', '1280', '--height', '720', targetUrl],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  ff.stdout.on('data', (d) => { stderr += d.toString(); });
  ff.stderr.on('data', (d) => { stderr += d.toString(); });

  let sawFirefoxOnNvidia = false;
  const smiTimer = setInterval(() => {
    if (checkNvidiaSmiFirefox()) sawFirefoxOnNvidia = true;
  }, 700);

  let report;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firefox QA timed out after 60s')), 60000)
    );
    report = await Promise.race([donePromise, timeoutPromise]);
    if (checkNvidiaSmiFirefox()) sawFirefoxOnNvidia = true;
  } finally {
    clearInterval(smiTimer);
    ff.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 900));
    if (!ff.killed) ff.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
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
    angleDiffDeg(s2.camAfter.lookYawDeg, s2.camBefore.lookYawDeg) < 0.5 &&
    Math.abs(s2.camAfter.lookPitchDeg - s2.camBefore.lookPitchDeg) < 0.5 &&
    Math.abs(s2.camAfter.rollDeg - s2.camBefore.rollDeg) < 0.5 &&
    Math.abs((s2.camAfter.fovDeg ?? 56) - (s2.camBefore.fovDeg ?? 56)) < 0.5;
  check(camOk, 'Firefox preserved camera pose across WebGPU -> WebGL2 switch');
  check((s2?.fps || 0) > 2 && (s2?.pngBytes || 0) > 50000, 'Firefox WebGL2 renders & exports PNG after switch', `fps=${s2?.fps}, ${s2?.pngBytes} bytes`);

  const s3 = report?.steps?.switchedBackWebGPU;
  check(
    s3?.diag?.backend === 'webgpu' &&
      s3?.diag?.allShadersCompiled === true &&
      s3?.diag?.volumeBaked === true &&
      (!s3?.diag?.errors || s3.diag.errors.length === 0),
    'Firefox live round-trip switch WebGL2 -> WebGPU (CMB Glow preset) succeeded cleanly'
  );
  check((s3?.fps || 0) > 2 && (s3?.pngBytes || 0) > 50000, 'Firefox WebGPU after round-trip switch renders continuously & exports PNG', `fps=${s3?.fps}, ${s3?.pngBytes} bytes`);

  const s4 = report?.steps?.aftRedshiftWebGPU;
  check(
    s4?.diag?.backend === 'webgpu' && s4?.diag?.activePreset === 'aft_redshift' && (s4?.pngBytes || 0) > 50000,
    'Firefox Aft Redshift preset capture on WebGPU produced valid PNG',
    `${s4?.pngBytes} bytes`
  );

  process.exitCode = qaFail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL FIREFOX QA ERROR:', err);
  process.exit(1);
});
