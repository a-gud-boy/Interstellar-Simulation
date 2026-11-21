#!/usr/bin/env node
/**
 * Magnetar & Millisecond Pulsar (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Capture Suite
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(__dirname, '..');
const TRIAL_ROOT = path.resolve(SIM_ROOT, '..');
const SHOT_DIR = path.join(__dirname, 'screenshots');

const VIEWPORT_W = 1440;
const VIEWPORT_H = 810;

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

function startStaticServer(preferredPort = 8786) {
  let skyRequestCount = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath.endsWith('milkyway_4k.jpg')) {
        skyRequestCount++;
      }
      let rel = urlPath.replace(/^\/+/, '');
      if (rel === '' || rel.endsWith('/')) {
        rel += 'index.html';
      }
      const fullPath = path.resolve(TRIAL_ROOT, rel);
      if (!fullPath.startsWith(TRIAL_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.stat(fullPath, (err, stat) => {
        if (!err && stat.isDirectory()) {
          const idxPath = path.join(fullPath, 'index.html');
          fs.stat(idxPath, (err2, stat2) => {
            if (err2 || !stat2.isFile()) {
              res.writeHead(404);
              res.end('Not found');
              return;
            }
            res.writeHead(200, {
              'Content-Type': MIME['.html'],
              'Content-Length': stat2.size,
              'Cache-Control': 'no-cache',
            });
            fs.createReadStream(idxPath).pipe(res);
          });
          return;
        }
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

    server.on('error', (err) => {
      if (err.code === 'EADDRUSE' && preferredPort !== 0) {
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    server.listen(preferredPort, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getSkyRequestCount: () => skyRequestCount,
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchChromeDualCDP(debugPort) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-qa-'));
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      browser: { theme: { color_scheme: 2, color_scheme2: 2 } },
      extensions: { theme: { id: '', system_theme: 0 } },
    })
  );

  const nvEnv = {
    ...process.env,
    GTK_THEME: 'Adwaita:dark',
    __NV_PRIME_RENDER_OFFLOAD: '1',
    __NV_PRIME_RENDER_OFFLOAD_PROVIDER: 'NVIDIA-G0',
    __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
    __VK_LAYER_NV_optimus: 'NVIDIA_only',
    VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json',
  };

  const chrome = spawn(
    '/usr/bin/google-chrome',
    [
      '--ozone-platform=x11',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebUIDarkMode',
      '--force-dark-mode',
      '--ignore-gpu-blocklist',
      '--gtk-version=3',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { env: nvEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  chrome.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let targets = null;
  for (let i = 0; i < 45; i++) {
    await sleep(160);
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
      if (res.ok) {
        targets = await res.json();
        if (targets.some((t) => t.type === 'page')) break;
      }
    } catch {
      // poll until CDP is listening
    }
  }
  if (!targets) {
    chrome.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(`Chrome CDP failed to start. stderr:\n${stderr.slice(-800)}`);
  }

  const pageTarget = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const close = async () => {
    try { ws.close(); } catch {}
    chrome.kill('SIGTERM');
    await sleep(300);
    if (!chrome.killed) chrome.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  return { send, on, close };
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer(8786);
  const debugPort = 9550 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP(debugPort);

  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const failedRequests = [];

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') consoleErrors.push(text);
      else if (p.type === 'warning') consoleWarnings.push(text);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const ex = p.exceptionDetails;
      exceptions.push(ex?.exception?.description || ex?.text || JSON.stringify(ex));
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') consoleErrors.push(`[Log] ${p.entry.text}`);
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response.status >= 400) {
        failedRequests.push(`${p.response.status} ${p.response.url}`);
      }
    });
    cdp.on('Network.loadingFailed', (p) => {
      failedRequests.push(`FAILED: ${p.errorText}`);
    });

    const evalJS = async (expression, awaitPromise = false) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result?.value;
    };

    const waitFrames = async (count = 15) => {
      await evalJS(
        `new Promise(resolve => {
          let n = 0;
          function tick() { if (++n >= ${count}) resolve(); else requestAnimationFrame(tick); }
          requestAnimationFrame(tick);
        })`,
        true
      );
    };

    const waitForReadyBackend = async (
      expectedBackend,
      globalVar = '__PULSAR__',
      expectedPath = '/pulsar-sim/',
      maxMs = 15000
    ) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const res = await evalJS(`(() => {
          const api = window['${globalVar}'];
          const d = api?.getDiagnostics?.();
          return { path: window.location.pathname, d };
        })()`);
        if (
          res?.path?.includes(expectedPath) &&
          res?.d &&
          res.d.backend === expectedBackend &&
          !res.d.switchingBackend &&
          res.d.skyMapLoaded === true
        ) {
          return res.d;
        }
        await sleep(120);
      }
      return await evalJS(`window['${globalVar}']?.getDiagnostics?.()`);
    };

    const waitForSamples = async (targetSamples = 20, maxMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window.__PULSAR__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(100);
      }
      return await evalJS(`window.__PULSAR__?.getDiagnostics?.()`);
    };

    const captureShot = async (filename) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(SHOT_DIR, filename);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      return { outPath, base64: data };
    };

    const analyzePng = async (base64) => {
      return await evalJS(
        `(async () => {
          const img = new Image();
          img.src = "data:image/png;base64,${base64}";
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

          const cx = width * 0.5;
          const cy = height * 0.5;
          let sumLuma = 0, sumLuma2 = 0, maxLuma = 0;
          let nonBlackPixels = 0, centerSumLuma = 0, centerCount = 0;
          let cyanBluePixels = 0, goldWarmPixels = 0;
          const thumb = [];

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              sumLuma2 += luma * luma;
              if (luma > maxLuma) maxLuma = luma;
              if (luma > 10) nonBlackPixels++;

              if (b > r + 15 && luma > 25) cyanBluePixels++;
              if (r > b + 20 && luma > 25) goldWarmPixels++;

              const dx = (x - cx) / height;
              const dy = (y - cy) / height;
              if (dx * dx + dy * dy < 0.16 * 0.16) {
                centerCount++;
                centerSumLuma += luma;
              }
            }
          }

          const total = Math.max(width * height, 1);
          const mean = sumLuma / total;
          const variance = Math.max(sumLuma2 / total - mean * mean, 0);

          for (let gy = 0; gy < 9; gy++) {
            for (let gx = 0; gx < 16; gx++) {
              const sx = Math.floor(((gx + 0.5) / 16) * width);
              const sy = Math.floor(((gy + 0.5) / 9) * height);
              const idx = (sy * width + sx) * 4;
              thumb.push(data[idx], data[idx + 1], data[idx + 2]);
            }
          }

          return {
            width,
            height,
            meanLuma: +mean.toFixed(2),
            stdLuma: +Math.sqrt(variance).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            centerMeanLuma: +(centerSumLuma / Math.max(centerCount, 1)).toFixed(2),
            nonBlackPixels,
            cyanBluePixels,
            goldWarmPixels,
            thumb,
          };
        })()`,
        true
      );
    };

    const imageMeanAbsDiff = (statsA, statsB) => {
      const a = statsA?.thumb || [];
      const b = statsB?.thumb || [];
      const n = Math.min(a.length, b.length);
      if (!n) return 0;
      let diff = 0;
      for (let i = 0; i < n; i++) diff += Math.abs(a[i] - b[i]);
      return +(diff / n).toFixed(2);
    };

    const pressKey = async (key, code, keyCode) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        text: key,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await sleep(220);
    };

    const baseUrl = `http://127.0.0.1:${port}/pulsar-sim/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(30);
    const liveFpsWebGL = await evalJS(`window.__PULSAR__.getTelemetry().fps`);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__PULSAR__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    // Check HUD top-right switcher layout at 1440px (zero overlap, 6 pills on single line or clean layout)
    const hudLayoutCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const items = Array.from(nav?.querySelectorAll('a') || []);
      const ctrlBtn = document.getElementById('controls-toggle');
      const header = document.querySelector('.hud-top-left');
      const navRect = nav?.getBoundingClientRect();
      const hdrRect = header?.getBoundingClientRect();
      const ctrlRect = ctrlBtn?.getBoundingClientRect();
      const itemRects = items.map(a => {
        const r = a.getBoundingClientRect();
        return { id: a.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      let overlap = false;
      for (let i = 1; i < itemRects.length; i++) {
        if (itemRects[i].left < itemRects[i - 1].right - 1 && Math.abs(itemRects[i].top - itemRects[i - 1].top) < 10) {
          overlap = true;
        }
      }
      const hdrNavOverlap = hdrRect && navRect ? (hdrRect.right > navRect.left - 4 && hdrRect.bottom > navRect.top) : false;
      return {
        pillCount: items.length,
        overlap,
        hdrNavOverlap,
        navHeight: navRect?.height ?? 0,
        ctrlOverlap: ctrlRect && navRect ? (navRect.right > ctrlRect.left + 1 && Math.abs(navRect.top - ctrlRect.top) < 10) : false,
      };
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png', {
      liveFpsWebGL,
      meanLuma: statsWebGLInit.meanLuma,
      cyanBluePixels: statsWebGLInit.cyanBluePixels,
      goldWarmPixels: statsWebGLInit.goldWarmPixels,
    });

    // Capture all 6 presets in WebGL2
    const presetIds = ['crab', 'millisecond', 'magnetar', 'polar_cap', 'edge_on', 'pwn_torus'];
    const capturePreset = async (presetId, filename, targetSamples = 16) => {
      await evalJS(`
        (window.__PULSAR__.selectPreset ? window.__PULSAR__.selectPreset('${presetId}', true) : window.__PULSAR__.applyPreset('${presetId}', true));
        window.__PULSAR__.setState({ paused: true, autoOrbit: false, spinPhase: 0.4 });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 7000);
      await waitFrames(4);
      const tel = await evalJS(`window.__PULSAR__.getTelemetry()`);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(
        `Captured ${filename} (backend=${d?.backend}, samples=${d?.samples}, meanLuma=${stats.meanLuma}, std=${stats.stdLuma}, z=${tel?.surfaceRedshiftZ?.toFixed?.(3)}, f_vis=${((tel?.visibleSurfaceFraction ?? 0) * 100).toFixed(1)}%)`
      );
      return { file: shot.outPath, samples: d?.samples, tel, stats };
    };

    const webglShots = {};
    for (let i = 0; i < presetIds.length; i++) {
      const id = presetIds[i];
      webglShots[id] = await capturePreset(id, `gl_${String(i + 1).padStart(2, '0')}_${id}.png`, 16);
    }

    // Open Controls drawer and inspect backend toggle
    await evalJS(`(() => {
      document.getElementById('controls-toggle')?.click();
      document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' });
    })()`);
    await sleep(350);
    const toggleCheckWebGL = await evalJS(`(() => {
      const btnGL = document.getElementById('ctrl-backend-webgl2');
      const btnGPU = document.getElementById('ctrl-backend-webgpu');
      return {
        hasBoth: Boolean(btnGL && btnGPU),
        glChecked: btnGL?.getAttribute('aria-checked'),
        gpuChecked: btnGPU?.getAttribute('aria-checked'),
      };
    })()`);
    await captureShot('02_controls_drawer_webgl2.png');

    // Non-default camera pose before WebGL2 -> WebGPU switch
    await evalJS(`window.__PULSAR__.setState({
      paused: true,
      autoOrbit: false,
      camera: { distance: 7.5, pivot: [0.2, -0.1, 0.2], azimuthDeg: 52.0, elevationDeg: 24.0, rollDeg: -5.0, fovDeg: 46.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__PULSAR__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 6000);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(120);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__PULSAR__.getState().camera`);
    const toggleCheckWebGPU = await evalJS(`(() => {
      const btnGL = document.getElementById('ctrl-backend-webgl2');
      const btnGPU = document.getElementById('ctrl-backend-webgpu');
      return {
        glChecked: btnGL?.getAttribute('aria-checked'),
        gpuChecked: btnGPU?.getAttribute('aria-checked'),
      };
    })()`);

    await captureShot('03_controls_drawer_webgpu.png');
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    // Measure live WebGPU FPS
    await evalJS(`window.__PULSAR__.setState({ paused: false, autoOrbit: true })`);
    await sleep(1200);
    const liveFpsWebGPU = await evalJS(`window.__PULSAR__.getTelemetry().fps`);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__PULSAR__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    // Capture all 6 presets in WebGPU
    const webgpuShots = {};
    for (let i = 0; i < presetIds.length; i++) {
      const id = presetIds[i];
      webgpuShots[id] = await capturePreset(id, `gpu_${String(i + 1).padStart(2, '0')}_${id}.png`, 20);
    }

    // Dual-backend visual parity check per preset
    const parityDiffs = {};
    for (const id of presetIds) {
      parityDiffs[id] = imageMeanAbsDiff(webglShots[id].stats, webgpuShots[id].stats);
    }

    // 3. Test Lensing Toggle: GR Curved (1) vs Flat Space (0) on Magnetar preset
    console.log('3. Testing GR Curved (#ctrl-lensingMode-1) vs Flat Space (#ctrl-lensingMode-0) lensing toggle...');
    await evalJS(`
      (window.__PULSAR__.selectPreset ? window.__PULSAR__.selectPreset('magnetar', true) : window.__PULSAR__.applyPreset('magnetar', true));
      window.__PULSAR__.setState({ paused: true, autoOrbit: false, spinPhase: 0.4 });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    const grCheck = await evalJS(`({
      lensingMode: window.__PULSAR__.getState().lensingMode,
      fVis: window.__PULSAR__.getTelemetry().visibleSurfaceFraction,
      fVisText: document.getElementById('tel-visible-frac')?.textContent?.trim(),
      grChecked: document.getElementById('ctrl-lensingMode-1')?.getAttribute('aria-checked'),
    })`);

    await evalJS(`document.getElementById('ctrl-lensingMode-0')?.click()`);
    await waitFrames(4);
    const flatCheck = await evalJS(`({
      lensingMode: window.__PULSAR__.getState().lensingMode,
      fVis: window.__PULSAR__.getTelemetry().visibleSurfaceFraction,
      fVisText: document.getElementById('tel-visible-frac')?.textContent?.trim(),
      flatChecked: document.getElementById('ctrl-lensingMode-0')?.getAttribute('aria-checked'),
      grChecked: document.getElementById('ctrl-lensingMode-1')?.getAttribute('aria-checked'),
    })`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);
    const flatDiag = await waitForSamples(20, 6000);
    await waitFrames(4);
    const sFlat = await captureShot('04_magnetar_flat_space_webgpu.png');
    const statsFlat = await analyzePng(sFlat.base64);
    const lensingDiff = imageMeanAbsDiff(webgpuShots.magnetar.stats, statsFlat);
    console.log(
      `Captured 04_magnetar_flat_space_webgpu.png (samples=${flatDiag?.samples}, f_vis: ${grCheck.fVisText} -> ${flatCheck.fVisText}, diff=${lensingDiff})`
    );

    // Restore GR Curved
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(200);
    await evalJS(`document.getElementById('ctrl-lensingMode-1')?.click()`);
    await waitFrames(4);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(200);

    // 4. Test Space 128-sample progressive accumulation & resume
    console.log('4. Testing Space 128-sample progressive accumulation...');
    await evalJS(`
      document.activeElement?.blur?.();
      (window.__PULSAR__.selectPreset ? window.__PULSAR__.selectPreset('crab', true) : window.__PULSAR__.applyPreset('crab', true));
      window.__PULSAR__.setState({ paused: false, autoOrbit: true });
    `);
    await waitFrames(10);
    await pressKey(' ', 'Space', 32);
    const pausedAfterSpace = await evalJS(`window.__PULSAR__.getState().paused`);
    const diag128 = await waitForSamples(128, 12000);
    const samplesReached = diag128?.samples ?? 0;
    const s128 = await captureShot('05_crab_128x_webgpu.png');
    const stats128 = await analyzePng(s128.base64);
    await pressKey(' ', 'Space', 32);
    const resumedAfterSpace = await evalJS(`!window.__PULSAR__.getState().paused`);
    console.log(`Space 128x check: paused=${pausedAfterSpace}, samplesReached=${samplesReached}, resumed=${resumedAfterSpace}`);

    // 5. Live slider (#ctrl-compactness), H HUD toggle, and live switch BACK WebGPU -> WebGL2
    console.log('5. Testing live slider, H HUD toggle, and live switch BACK WebGPU -> WebGL2...');
    const sliderTest = await evalJS(`(() => {
      const target = document.getElementById('ctrl-compactness');
      if (!target) return { ok: false };
      const before = window.__PULSAR__.getState().compactness;
      const origVal = target.value;
      target.value = '0.285';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = window.__PULSAR__.getState().compactness;
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: Math.abs(after - 0.285) < 0.01 && Math.abs(before - after) > 0.02, before, after };
    })()`);

    await evalJS(`document.activeElement?.blur?.()`);
    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    const hudRestoredAfterH = await evalJS(`!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await waitFrames(4);

    await evalJS(`
      (window.__PULSAR__.selectPreset ? window.__PULSAR__.selectPreset('crab', true) : window.__PULSAR__.applyPreset('crab', true));
      window.__PULSAR__.setState({ paused: true, autoOrbit: false, spinPhase: 0.4 });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 6000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__PULSAR__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const sWebGLBack = await captureShot('06_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(sWebGLBack.base64);

    // 6. Direct ?backend=webgpu + 6-Simulator Switcher E2E
    const directUrl = `http://127.0.0.1:${port}/pulsar-sim/?backend=webgpu`;
    console.log(`6. Navigating directly to ${directUrl} + testing 6-sim switcher E2E...`);
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(12);

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const cur = nav?.querySelector('[aria-current="page"]');
      const links = Array.from(nav?.querySelectorAll('a[data-sim-href]') || []);
      const findHref = (sub) => links.find(a => a.getAttribute('data-sim-href')?.includes(sub))?.getAttribute('href');
      return {
        hasNav: Boolean(nav),
        count: links.length,
        noTabRole: nav?.getAttribute('role') !== 'tab' && links.every(a => a.getAttribute('role') !== 'tab'),
        currentId: cur?.id,
        bhHref: findHref('blackhole-sim'),
        whHref: findHref('wormhole-sim'),
        binHref: findHref('binary-bh-sim'),
        warpHref: findHref('warp-drive-sim'),
        snHref: findHref('supernova-sim'),
      };
    })()`);

    const clickSimLink = async (substr) => {
      await evalJS(`document.querySelector('nav[aria-label="Simulation switcher"] a[data-sim-href*="${substr}"]')?.click()`);
    };

    await clickSimLink('blackhole-sim');
    const diagBlackholeSwitch = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/blackhole-sim/');
    await waitFrames(10);

    await clickSimLink('wormhole-sim');
    const diagWormholeSwitch = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/wormhole-sim/');
    await waitFrames(10);

    await clickSimLink('binary-bh-sim');
    const diagBinarySwitch = await waitForReadyBackend('webgpu', '__BINARY_BH__', '/binary-bh-sim/');
    await waitFrames(10);

    await clickSimLink('warp-drive-sim');
    const diagWarpSwitch = await waitForReadyBackend('webgpu', '__WARP_DRIVE__', '/warp-drive-sim/');
    await waitFrames(10);

    await clickSimLink('supernova-sim');
    const diagSupernovaSwitch = await waitForReadyBackend('webgpu', '__SUPERNOVA__', '/supernova-sim/');
    await waitFrames(10);

    await clickSimLink('pulsar-sim');
    const diagPulsarFromSupernova = await waitForReadyBackend('webgpu', '__PULSAR__', '/pulsar-sim/');
    await waitFrames(10);
    await captureShot('07_e2e_pulsar_after_6sim_loop.png');

    // Also test root index.html ?sim=pulsar forwarding
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?sim=pulsar&backend=webgpu` });
    const diagRootRedirect = await waitForReadyBackend('webgpu', '__PULSAR__', '/pulsar-sim/');

    const report = {
      diagWebGLInit,
      diagWebGPU,
      diagWebGLAfterSwitch,
      diagDirectWebGPU,
      diagRootRedirect,
      liveFpsWebGL,
      liveFpsWebGPU,
      drawerClosedInitially,
      hudLayoutCheck,
      toggleCheckWebGL,
      toggleCheckWebGPU,
      camBeforeSwitch,
      camAfterSwitch,
      skyFetchesBeforeSwitch,
      skyFetchesAfterSwitch,
      pngBytes: {
        webglInit: pngBytesWebGL,
        webgpu: pngBytesWebGPU,
        webglAfterSwitch: pngBytesWebGLAfterSwitch,
      },
      statsWebGLInit,
      statsWebGLAfterSwitch,
      webglShots,
      webgpuShots,
      parityDiffs,
      lensingToggle: {
        grCheck,
        flatCheck,
        statsFlat,
        lensingDiff,
      },
      accumulation128: {
        pausedAfterSpace,
        samplesReached,
        resumedAfterSpace,
        stats128,
      },
      sliderTest,
      hudHiddenAfterH,
      hudRestoredAfterH,
      switcherCheck,
      e2eSwitchChain: {
        diagBlackholeSwitch,
        diagWormholeSwitch,
        diagBinarySwitch,
        diagWarpSwitch,
        diagSupernovaSwitch,
        diagPulsarFromSupernova,
      },
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED PULSAR CHROME QA ASSERTIONS ===');
    let qaFail = 0;
    const check = (cond, msg, detail = '') => {
      if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
      else {
        qaFail++;
        console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
      }
    };

    check(consoleErrors.length === 0, 'Zero JS console errors', consoleErrors.join(' | '));
    check(exceptions.length === 0, 'Zero uncaught runtime exceptions', exceptions.join(' | '));
    check(failedRequests.length === 0, 'Zero failed HTTP/network requests', failedRequests.join(' | '));

    check(diagWebGLInit?.backend === 'webgl2', 'Default page boot uses WebGL2', diagWebGLInit?.backend);
    check(diagWebGLInit?.allShadersCompiled === true, 'WebGL2 shaders compiled cleanly');
    check(diagWebGLInit?.volumeBaked === true, 'WebGL2 baked 128^3 3D noise volume');
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 4K Milky Way sky loaded');
    check(
      /nvidia|rtx/i.test(String(diagWebGLInit?.webglRenderer || '')),
      'WebGL2 running on hardware NVIDIA GL',
      diagWebGLInit?.webglRenderer
    );
    check(liveFpsWebGL >= 20, 'WebGL2 runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGL}`);
    check(drawerClosedInitially === true, 'Controls drawer starts collapsed');
    check(
      hudLayoutCheck?.pillCount >= 6 && !hudLayoutCheck?.overlap && !hudLayoutCheck?.hdrNavOverlap && !hudLayoutCheck?.ctrlOverlap,
      'Switcher HUD layout fits cleanly without overlapping pills or controls',
      JSON.stringify(hudLayoutCheck)
    );
    check(
      toggleCheckWebGL?.hasBoth && toggleCheckWebGL?.glChecked === 'true' && toggleCheckWebGL?.gpuChecked === 'false',
      'Controls drawer shows WebGL2 active before toggle'
    );

    check(diagWebGPU?.backend === 'webgpu', 'Live switch updated active backend to WebGPU', diagWebGPU?.backend);
    check(diagWebGPU?.allShadersCompiled === true, 'WebGPU WGSL shaders compiled cleanly');
    check(diagWebGPU?.volumeBaked === true, 'WebGPU baked 128^3 3D volume via compute shader');
    check(diagWebGPU?.skyMapLoaded === true, 'WebGPU uploaded 4K Milky Way sky');
    check(
      skyFetchesAfterSwitch === skyFetchesBeforeSwitch,
      'Switching to WebGPU reused cached 4K sky blob (zero extra network requests)',
      `skyFetches: ${skyFetchesBeforeSwitch} -> ${skyFetchesAfterSwitch}`
    );
    check(
      diagWebGPU?.adapterInfo?.isFallbackAdapter === false && /nvidia|blackwell|rtx|geforce/i.test(String(diagWebGPU?.gpuRenderer || '')),
      'WebGPU running on hardware NVIDIA GPU (not SwiftShader)',
      diagWebGPU?.gpuRenderer
    );
    check(
      toggleCheckWebGPU?.glChecked === 'false' && toggleCheckWebGPU?.gpuChecked === 'true',
      'Controls drawer radio state synced to WebGPU after switch'
    );

    const camPreserved =
      camBeforeSwitch &&
      camAfterSwitch &&
      Math.abs(camAfterSwitch.distance - camBeforeSwitch.distance) < 0.1 &&
      Math.abs((camAfterSwitch.pivot?.[0] ?? 0) - (camBeforeSwitch.pivot?.[0] ?? 0)) < 0.1 &&
      Math.abs((camAfterSwitch.pivot?.[1] ?? 0) - (camBeforeSwitch.pivot?.[1] ?? 0)) < 0.1 &&
      Math.abs((camAfterSwitch.pivot?.[2] ?? 0) - (camBeforeSwitch.pivot?.[2] ?? 0)) < 0.1 &&
      Math.abs(camAfterSwitch.elevationDeg - camBeforeSwitch.elevationDeg) < 0.5 &&
      Math.abs(camAfterSwitch.azimuthDeg - camBeforeSwitch.azimuthDeg) < 0.5 &&
      Math.abs(camAfterSwitch.rollDeg - camBeforeSwitch.rollDeg) < 0.5 &&
      Math.abs((camAfterSwitch.fovDeg ?? 48) - (camBeforeSwitch.fovDeg ?? 48)) < 0.5;
    check(camPreserved, 'Camera pose & pivot preserved across WebGL2 -> WebGPU switch');
    check(liveFpsWebGPU >= 20, 'WebGPU runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGPU}`);

    for (const id of presetIds) {
      const glShot = webglShots[id];
      const gpuShot = webgpuShots[id];
      check(
        glShot.stats.meanLuma > 3.0 && glShot.stats.maxLuma > 80 && glShot.stats.stdLuma > 2.0,
        `WebGL2 preset '${id}' renders bright non-blank image`,
        `meanLuma=${glShot.stats.meanLuma}, maxLuma=${glShot.stats.maxLuma}, std=${glShot.stats.stdLuma}`
      );
      check(
        gpuShot.stats.meanLuma > 3.0 && gpuShot.stats.maxLuma > 80 && gpuShot.stats.stdLuma > 2.0,
        `WebGPU preset '${id}' renders bright non-blank image`,
        `meanLuma=${gpuShot.stats.meanLuma}, maxLuma=${gpuShot.stats.maxLuma}, std=${gpuShot.stats.stdLuma}`
      );
      check(
        parityDiffs[id] < 18.0,
        `WebGL2 <-> WebGPU parity holds for preset '${id}'`,
        `meanAbsDiff=${parityDiffs[id]}`
      );
    }

    // Physical ordering checks across presets
    const zCrab = webgpuShots.crab.tel?.surfaceRedshiftZ ?? 0;
    const zMag = webgpuShots.magnetar.tel?.surfaceRedshiftZ ?? 0;
    const fVisCrab = webgpuShots.crab.tel?.visibleSurfaceFraction ?? 0;
    const fVisMag = webgpuShots.magnetar.tel?.visibleSurfaceFraction ?? 0;
    const fSpinCrab = webgpuShots.crab.tel?.spinFreqHz ?? 0;
    const fSpinMs = webgpuShots.millisecond.tel?.spinFreqHz ?? 0;
    check(
      zMag > zCrab && fVisMag > fVisCrab && fSpinMs > fSpinCrab * 10,
      'Relativistic redshift, visible surface fraction & millisecond spin frequency ordering hold across presets',
      `z=[crab:${zCrab.toFixed(3)}, mag:${zMag.toFixed(3)}], f_vis=[crab:${(fVisCrab * 100).toFixed(1)}%, mag:${(fVisMag * 100).toFixed(1)}%], f_spin=[crab:${fSpinCrab.toFixed(1)}Hz, ms:${fSpinMs.toFixed(1)}Hz]`
    );

    check(
      grCheck?.lensingMode === 1 &&
        grCheck?.fVis > 0.85 &&
        flatCheck?.lensingMode === 0 &&
        Math.abs((flatCheck?.fVis ?? 0) - 0.5) < 1e-4 &&
        /50\.0%/.test(flatCheck?.fVisText || '') &&
        statsFlat.meanLuma > 3.0 &&
        lensingDiff > 1.5,
      'Lensing toggle (GR Curved <-> Flat Space) updates f_vis to 50.0% and alters rendered image distinctly',
      `GR=${grCheck?.fVisText}, Flat=${flatCheck?.fVisText}, diff=${lensingDiff}`
    );

    check(
      pausedAfterSpace && samplesReached >= 128 && resumedAfterSpace && stats128.meanLuma > 3.0,
      'Space pauses spin & accumulates 128 progressive samples cleanly, then resumes',
      `samples=${samplesReached}`
    );

    check(
      diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true,
      'Live switch BACK WebGPU -> WebGL2 succeeded cleanly'
    );
    check(
      statsWebGLAfterSwitch.meanLuma > 3.0 && statsWebGLAfterSwitch.maxLuma > 80,
      'WebGL2 after switch renders non-blank pulsar image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}`
    );
    check(sliderTest?.ok === true, 'Live #ctrl-compactness slider updates simulator state cleanly');
    check(hudHiddenAfterH === true && hudRestoredAfterH === true, 'Hotkey H cleanly toggles HUD visibility');
    check(
      pngBytesWebGL > 50000 && pngBytesWebGPU > 50000 && pngBytesWebGLAfterSwitch > 50000,
      'capturePNG() produces valid PNG Blobs across WebGL2 & WebGPU',
      `bytes=[${pngBytesWebGL}, ${pngBytesWebGPU}, ${pngBytesWebGLAfterSwitch}]`
    );
    check(
      diagDirectWebGPU?.backend === 'webgpu' && diagDirectWebGPU?.allShadersCompiled === true,
      'Direct boot via ?backend=webgpu starts cleanly in WebGPU'
    );
    check(
      diagRootRedirect?.backend === 'webgpu' && diagRootRedirect?.allShadersCompiled === true,
      'Root /?sim=pulsar&backend=webgpu routes cleanly into pulsar-sim'
    );
    check(
      switcherCheck?.hasNav &&
        switcherCheck?.count >= 6 &&
        switcherCheck?.noTabRole &&
        switcherCheck?.currentId === 'sim-switch-pulsar' &&
        switcherCheck?.bhHref?.includes('?backend=webgpu') &&
        switcherCheck?.whHref?.includes('?backend=webgpu') &&
        switcherCheck?.binHref?.includes('?backend=webgpu') &&
        switcherCheck?.warpHref?.includes('?backend=webgpu') &&
        switcherCheck?.snHref?.includes('?backend=webgpu'),
      'Simulation navbar switcher uses aria-current="page" and propagates ?backend=webgpu'
    );
    check(
      diagBlackholeSwitch?.backend === 'webgpu' &&
        diagWormholeSwitch?.backend === 'webgpu' &&
        diagBinarySwitch?.backend === 'webgpu' &&
        diagWarpSwitch?.backend === 'webgpu' &&
        diagSupernovaSwitch?.backend === 'webgpu' &&
        diagPulsarFromSupernova?.backend === 'webgpu',
      'E2E 6-simulator switcher preserves ?backend=webgpu across Pulsar -> Black Hole -> Wormhole -> Binary BH -> Warp Drive -> Supernova -> Pulsar'
    );

    console.log(`\nQA REPORT WRITTEN: ${path.join(SHOT_DIR, 'qa_report.json')}`);
    process.exitCode = qaFail > 0 ? 1 : 0;
  } catch (err) {
    console.error('QA RUN FAILED:', err);
    console.error('Console Errors:', consoleErrors);
    console.error('Exceptions:', exceptions);
    console.error('Failed Requests:', failedRequests);
    throw err;
  } finally {
    await cdp.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('FATAL QA ERROR:', err);
  process.exit(1);
});
