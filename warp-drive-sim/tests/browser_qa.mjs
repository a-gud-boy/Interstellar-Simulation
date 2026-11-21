#!/usr/bin/env node
/**
 * Alcubierre Warp Drive (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Capture Suite
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

function startStaticServer(preferredPort = 8784) {
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-drive-qa-'));
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

  const { server, port, getSkyRequestCount } = await startStaticServer(8784);
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
      globalVar = '__WARP_DRIVE__',
      expectedPath = '/warp-drive-sim/',
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

    const waitForSamples = async (targetSamples = 20, maxMs = 6000) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window.__WARP_DRIVE__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(120);
      }
      return await evalJS(`window.__WARP_DRIVE__?.getDiagnostics?.()`);
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
          let sumLuma = 0, maxLuma = 0;
          let darkCorePixels = 0, centerBrightPixels = 0, centerSumLuma = 0, centerCount = 0;
          let cyanPixels = 0, warmPixels = 0;
          const thumb = [];

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              if (luma > maxLuma) maxLuma = luma;

              if (b > r + 14 && g > r + 8 && luma > 25) cyanPixels++;
              if (r > b + 20 && luma > 25) warmPixels++;

              const dx = (x - cx) / height;
              const dy = (y - cy) / height;
              const dist2 = dx * dx + dy * dy;
              if (dist2 < 0.16 * 0.16) {
                centerCount++;
                centerSumLuma += luma;
                if (luma < 14) darkCorePixels++;
                if (luma > 65) centerBrightPixels++;
              }
            }
          }

          // Downsampled 16x9 fingerprint for fast image diffing
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
            meanLuma: +(sumLuma / (width * height)).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            centerMeanLuma: +(centerSumLuma / Math.max(centerCount, 1)).toFixed(2),
            darkCorePixels,
            centerBrightPixels,
            cyanPixels,
            warmPixels,
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

    const baseUrl = `http://127.0.0.1:${port}/warp-drive-sim/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(30);
    const liveFpsWebGL = await evalJS(`window.__WARP_DRIVE__.getTelemetry().fps`);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__WARP_DRIVE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png', { liveFpsWebGL, meanLuma: statsWebGLInit.meanLuma, cyanPixels: statsWebGLInit.cyanPixels });

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
    console.log('Captured 02_controls_drawer_webgl2.png');

    // Non-default camera pose before WebGL2 -> WebGPU switch
    await evalJS(`window.__WARP_DRIVE__.setState({
      paused: true,
      autoOrbit: false,
      camera: { radius: 13.5, azimuthDeg: 52.0, elevationDeg: 22.0, rollDeg: -4.0, fovDeg: 50.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__WARP_DRIVE__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 6000);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(120);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__WARP_DRIVE__.getState().camera`);
    const toggleCheckWebGPU = await evalJS(`(() => {
      const btnGL = document.getElementById('ctrl-backend-webgl2');
      const btnGPU = document.getElementById('ctrl-backend-webgpu');
      return {
        glChecked: btnGL?.getAttribute('aria-checked'),
        gpuChecked: btnGPU?.getAttribute('aria-checked'),
      };
    })()`);

    await captureShot('03_controls_drawer_webgpu.png');
    console.log('Captured 03_controls_drawer_webgpu.png');

    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    // Measure live WebGPU FPS
    await evalJS(`window.__WARP_DRIVE__.setState({ paused: false, autoOrbit: true })`);
    await sleep(1200);
    const liveFpsWebGPU = await evalJS(`window.__WARP_DRIVE__.getTelemetry().fps`);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__WARP_DRIVE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const capturePreset = async (presetId, filename, targetSamples = 20) => {
      await evalJS(`
        window.__WARP_DRIVE__.selectPreset('${presetId}', true);
        window.__WARP_DRIVE__.setState({ paused: true, autoOrbit: false });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 6000);
      await waitFrames(4);
      const tel = await evalJS(`window.__WARP_DRIVE__.getTelemetry()`);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(
        `Captured ${filename} (samples=${d?.samples}, meanLuma=${stats.meanLuma}, centerLuma=${stats.centerMeanLuma}, darkCore=${stats.darkCorePixels}, cyan=${stats.cyanPixels}, horizon=${tel?.horizonAngleDeg?.toFixed?.(1) ?? tel?.horizonAngleDeg})`
      );
      return { file: shot.outPath, samples: d?.samples, tel, stats };
    };

    const shots = {};
    shots.subluminal = await capturePreset('subluminal', '04_subluminal_webgpu.png', 20);
    shots.light_barrier = await capturePreset('light_barrier', '05_light_barrier_webgpu.png', 20);
    shots.superluminal = await capturePreset('superluminal', '06_superluminal_webgpu.png', 20);
    shots.bridge = await capturePreset('bridge', '07_bridge_webgpu.png', 20);
    shots.thin_wall = await capturePreset('thin_wall', '08_thin_wall_webgpu.png', 20);
    shots.natario = await capturePreset('natario', '09_natario_webgpu.png', 20);

    // 2b. Lentz Soliton metric capture via Controls drawer (#ctrl-metricType-2 -> 15_lentz_webgpu.png)
    console.log('2b. Selecting Lentz Soliton metric (#ctrl-metricType-2) on WebGPU...');
    await evalJS(`
      window.__WARP_DRIVE__.selectPreset('superluminal', true);
      window.__WARP_DRIVE__.setState({ paused: true, autoOrbit: false });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-metricType-2')?.click()`);
    await waitFrames(4);
    const lentzUiCheck = await evalJS(`({
      metricType: window.__WARP_DRIVE__.getState().metricType,
      checked: document.getElementById('ctrl-metricType-2')?.getAttribute('aria-checked'),
      drawerMeta: document.getElementById('drawer-metric-meta')?.textContent?.trim(),
    })`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);
    const lentzDiag = await waitForSamples(20, 6000);
    await waitFrames(4);
    const s15 = await captureShot('15_lentz_webgpu.png');
    const statsLentz = await analyzePng(s15.base64);
    console.log(
      `Captured 15_lentz_webgpu.png (samples=${lentzDiag?.samples}, meanLuma=${statsLentz.meanLuma}, centerLuma=${statsLentz.centerMeanLuma}, cyan=${statsLentz.cyanPixels}, warm=${statsLentz.warmPixels})`
    );

    // 3. Bridge View aft causal horizon test (v_s=2.2c, cameraMode=1, lookYawDeg=180)
    console.log('3. Testing Bridge View aft causal horizon (lookYawDeg=180, lookPitchDeg=0)...');
    await evalJS(`
      window.__WARP_DRIVE__.selectPreset('bridge', true);
      window.__WARP_DRIVE__.setState({
        paused: true,
        autoOrbit: false,
        camera: { lookYawDeg: 180, lookPitchDeg: 0 }
      });
    `);
    await waitFrames(6);
    const aftDiag = await waitForSamples(20, 6000);
    await waitFrames(4);
    const s10 = await captureShot('10_bridge_aft_horizon_webgpu.png');
    const statsBridgeAft = await analyzePng(s10.base64);
    console.log(
      `Captured 10_bridge_aft_horizon_webgpu.png (samples=${aftDiag?.samples}, darkCore=${statsBridgeAft.darkCorePixels}, centerLuma=${statsBridgeAft.centerMeanLuma})`
    );

    // 4. Test 'T' hotkey toggling External Chase (0) <-> Inside Bridge (1)
    console.log('4. Testing T hotkey (KeyT) cameraMode toggle...');
    await evalJS(`
      document.activeElement?.blur?.();
      window.__WARP_DRIVE__.selectPreset('superluminal', true);
      window.__WARP_DRIVE__.setState({ paused: true, autoOrbit: false });
    `);
    await waitFrames(6);
    const beforeT = await evalJS(`({
      cameraMode: window.__WARP_DRIVE__.getState().cameraMode,
      telText: document.getElementById('tel-cam-mode')?.textContent?.trim(),
    })`);
    const shotBeforeT = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const statsBeforeT = await analyzePng(shotBeforeT.data);

    await pressKey('t', 'KeyT', 84);
    const waitBlendTarget = async (targetBlend, timeoutMs = 2500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const b = await evalJS(`window.__WARP_DRIVE__.getState().camera?.frameBlend`);
        if (typeof b === 'number' && Math.abs(b - targetBlend) < 0.02) break;
        await sleep(80);
      }
      await waitFrames(8);
    };
    await waitBlendTarget(1.0);
    const afterT1 = await evalJS(`({
      cameraMode: window.__WARP_DRIVE__.getState().cameraMode,
      frameBlend: window.__WARP_DRIVE__.getState().camera?.frameBlend,
      telText: document.getElementById('tel-cam-mode')?.textContent?.trim(),
    })`);
    const shotAfterT1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const statsAfterT1 = await analyzePng(shotAfterT1.data);
    const visualDiffChaseVsBridge = imageMeanAbsDiff(statsBeforeT, statsAfterT1);

    await pressKey('t', 'KeyT', 84);
    await waitBlendTarget(0.0);
    const afterT2 = await evalJS(`({
      cameraMode: window.__WARP_DRIVE__.getState().cameraMode,
      frameBlend: window.__WARP_DRIVE__.getState().camera?.frameBlend,
      telText: document.getElementById('tel-cam-mode')?.textContent?.trim(),
    })`);

    // 5. Test live slider (#ctrl-warpVelocity), H HUD toggle, and live switch BACK WebGPU -> WebGL2
    console.log('5. Testing live slider, H HUD toggle, and live switch BACK WebGPU -> WebGL2...');
    const sliderTest = await evalJS(`(() => {
      const target = document.getElementById('ctrl-warpVelocity');
      if (!target) return { ok: false };
      const before = window.__WARP_DRIVE__.getState().warpVelocity;
      const origVal = target.value;
      target.value = '4.25';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = window.__WARP_DRIVE__.getState().warpVelocity;
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: Math.abs(after - 4.25) < 0.05 && Math.abs(before - after) > 0.5, before, after };
    })()`);

    await evalJS(`document.activeElement?.blur?.()`);
    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    const hudRestoredAfterH = await evalJS(`!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await waitFrames(4);

    await evalJS(`
      window.__WARP_DRIVE__.selectPreset('superluminal', true);
      window.__WARP_DRIVE__.setState({ paused: true, autoOrbit: false });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 6000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__WARP_DRIVE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const s11 = await captureShot('11_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(s11.base64);

    // 6. Direct ?backend=webgpu + 4-Simulator Switcher E2E
    const directUrl = `http://127.0.0.1:${port}/warp-drive-sim/?backend=webgpu`;
    console.log(`6. Navigating directly to ${directUrl} + testing 4-sim switcher E2E...`);
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(12);

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const cur = nav?.querySelector('[aria-current="page"]');
      const bh = document.getElementById('sim-switch-link');
      const wh = document.getElementById('sim-switch-wormhole');
      const bin = document.getElementById('sim-switch-binary');
      return {
        hasNav: Boolean(nav),
        noTabRole: nav?.getAttribute('role') !== 'tab' && bh?.getAttribute('role') !== 'tab',
        currentId: cur?.id,
        bhHref: bh?.getAttribute('href'),
        whHref: wh?.getAttribute('href'),
        binHref: bin?.getAttribute('href'),
      };
    })()`);

    await evalJS(`document.getElementById('sim-switch-link')?.click()`);
    const diagBlackholeSwitch = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/blackhole-sim/');
    await waitFrames(12);
    await captureShot('12_e2e_blackhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-warp')?.click()`);
    const diagWarpFromBH = await waitForReadyBackend('webgpu', '__WARP_DRIVE__', '/warp-drive-sim/');
    await waitFrames(10);

    await evalJS(`document.getElementById('sim-switch-wormhole')?.click()`);
    const diagWormholeSwitch = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/wormhole-sim/');
    await waitFrames(12);
    await captureShot('13_e2e_wormhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-binary')?.click()`);
    const diagBinarySwitch = await waitForReadyBackend('webgpu', '__BINARY_BH__', '/binary-bh-sim/');
    await waitFrames(12);
    await captureShot('14_e2e_binary_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-warp')?.click()`);
    const diagWarpFromBinary = await waitForReadyBackend('webgpu', '__WARP_DRIVE__', '/warp-drive-sim/');
    await waitFrames(10);

    const natarioVsAlcubierreDiff = imageMeanAbsDiff(shots.superluminal.stats, shots.natario.stats);
    const lentzVsAlcubierreDiff = imageMeanAbsDiff(shots.superluminal.stats, statsLentz);

    const report = {
      diagWebGLInit,
      diagWebGPU,
      diagWebGLAfterSwitch,
      diagDirectWebGPU,
      liveFpsWebGL,
      liveFpsWebGPU,
      drawerClosedInitially,
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
      shots,
      lentz: { ui: lentzUiCheck, samples: lentzDiag?.samples, stats: statsLentz },
      statsBridgeAft,
      natarioVsAlcubierreDiff,
      lentzVsAlcubierreDiff,
      hotkeyT: { beforeT, afterT1, afterT2, visualDiffChaseVsBridge },
      sliderTest,
      hudHiddenAfterH,
      hudRestoredAfterH,
      switcherCheck,
      e2eSwitchChain: {
        diagBlackholeSwitch,
        diagWarpFromBH,
        diagWormholeSwitch,
        diagBinarySwitch,
        diagWarpFromBinary,
      },
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED WARP DRIVE CHROME QA ASSERTIONS ===');
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
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 4K Milky Way sky loaded');
    check(
      /nvidia|rtx/i.test(String(diagWebGLInit?.webglRenderer || '')),
      'WebGL2 running on hardware NVIDIA GL',
      diagWebGLInit?.webglRenderer
    );
    check(drawerClosedInitially === true, 'Controls drawer starts collapsed');
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
      diagWebGPU?.adapterInfo?.isFallbackAdapter === false && /nvidia|blackwell/i.test(String(diagWebGPU?.gpuRenderer || '')),
      'WebGPU running on hardware NVIDIA Blackwell (not SwiftShader)',
      diagWebGPU?.gpuRenderer
    );
    check(
      toggleCheckWebGPU?.glChecked === 'false' && toggleCheckWebGPU?.gpuChecked === 'true',
      'Controls drawer radio state synced to WebGPU after switch'
    );

    const camPreserved =
      camBeforeSwitch &&
      camAfterSwitch &&
      Math.abs(camAfterSwitch.radius - camBeforeSwitch.radius) < 0.1 &&
      Math.abs(camAfterSwitch.elevationDeg - camBeforeSwitch.elevationDeg) < 0.5 &&
      Math.abs(camAfterSwitch.azimuthDeg - camBeforeSwitch.azimuthDeg) < 0.5 &&
      Math.abs(camAfterSwitch.rollDeg - camBeforeSwitch.rollDeg) < 0.5 &&
      Math.abs((camAfterSwitch.fovDeg ?? 48) - (camBeforeSwitch.fovDeg ?? 48)) < 0.5;
    check(camPreserved, 'Camera pose preserved across WebGL2 -> WebGPU switch');
    check(liveFpsWebGPU >= 20, 'WebGPU runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGPU}`);

    for (const [key, shot] of Object.entries(shots)) {
      check(
        shot.stats.meanLuma > 3.0 && shot.stats.maxLuma > 80,
        `Preset '${key}' renders bright non-blank WebGPU image`,
        `meanLuma=${shot.stats.meanLuma}, maxLuma=${shot.stats.maxLuma}`
      );
    }
    check(
      natarioVsAlcubierreDiff > 2.5,
      'Natario zero-expansion bubble renders distinctly from Alcubierre',
      `meanAbsDiff=${natarioVsAlcubierreDiff}`
    );
    check(
      lentzUiCheck?.metricType === 2 &&
        lentzUiCheck?.checked === 'true' &&
        /lentz/i.test(lentzUiCheck?.drawerMeta || '') &&
        statsLentz.meanLuma > 3.0 &&
        statsLentz.maxLuma > 80 &&
        lentzVsAlcubierreDiff > 1.5,
      'Lentz Soliton metric (#ctrl-metricType-2) renders cleanly & distinctly from Alcubierre',
      `meanLuma=${statsLentz.meanLuma}, diff=${lentzVsAlcubierreDiff}, meta='${lentzUiCheck?.drawerMeta}'`
    );

    const hSub = shots.subluminal.tel?.horizonAngleDeg ?? -1;
    const hBar = shots.light_barrier.tel?.horizonAngleDeg ?? -1;
    const hBri = shots.bridge.tel?.horizonAngleDeg ?? -1;
    const hSup = shots.superluminal.tel?.horizonAngleDeg ?? -1;
    const hThn = shots.thin_wall.tel?.horizonAngleDeg ?? -1;
    check(
      shots.subluminal.tel?.hasHorizon === false &&
        hSub === 0 &&
        shots.light_barrier.tel?.hasHorizon === true &&
        Math.abs(hBar) < 0.05 &&
        hBri > 120 &&
        hSup > hBri &&
        hThn > hSup,
      'Aft causal horizonAngleDeg is 0 deg at 1.0c and grows monotonically for v_s > 1',
      `[0.8c=${hSub}, 1.0c=${hBar.toFixed?.(1)}, 2.2c=${hBri.toFixed?.(1)}, 2.5c=${hSup.toFixed?.(1)}, 3.5c=${hThn.toFixed?.(1)}]`
    );

    check(
      statsBridgeAft.darkCorePixels > 5000 &&
        statsBridgeAft.darkCorePixels > shots.bridge.stats.darkCorePixels * 2 &&
        shots.bridge.stats.centerMeanLuma > statsBridgeAft.centerMeanLuma,
      'Bridge aft look (180 deg) shows dark causal horizon while forward Bridge shows bright caustic/starfield',
      `aftDark=${statsBridgeAft.darkCorePixels}, fwdDark=${shots.bridge.stats.darkCorePixels}, fwdCenterLuma=${shots.bridge.stats.centerMeanLuma}, aftCenterLuma=${statsBridgeAft.centerMeanLuma}`
    );

    check(
      beforeT.cameraMode === 0 &&
        afterT1.cameraMode === 1 &&
        afterT2.cameraMode === 0 &&
        /bridge/i.test(afterT1.telText || '') &&
        /chase/i.test(afterT2.telText || '') &&
        visualDiffChaseVsBridge > 3.0,
      'Hotkey T toggles cameraMode External Chase <-> Inside Bridge with visual & telemetry update',
      `tel: '${beforeT.telText}' -> '${afterT1.telText}' -> '${afterT2.telText}', diff=${visualDiffChaseVsBridge}`
    );

    check(
      diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true,
      'Live switch BACK WebGPU -> WebGL2 succeeded cleanly'
    );
    check(
      statsWebGLAfterSwitch.meanLuma > 3.0 && statsWebGLAfterSwitch.maxLuma > 80,
      'WebGL2 after switch renders non-blank warp drive image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}`
    );
    check(sliderTest?.ok === true, 'Live #ctrl-warpVelocity slider updates simulator state cleanly');
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
      switcherCheck?.hasNav &&
        switcherCheck?.noTabRole &&
        switcherCheck?.currentId === 'sim-switch-warp' &&
        switcherCheck?.bhHref?.includes('?backend=webgpu') &&
        switcherCheck?.whHref?.includes('?backend=webgpu') &&
        switcherCheck?.binHref?.includes('?backend=webgpu'),
      '4-simulator navbar switcher uses aria-current="page" and propagates ?backend=webgpu'
    );
    check(
      diagBlackholeSwitch?.backend === 'webgpu' &&
        diagWarpFromBH?.backend === 'webgpu' &&
        diagWormholeSwitch?.backend === 'webgpu' &&
        diagBinarySwitch?.backend === 'webgpu' &&
        diagWarpFromBinary?.backend === 'webgpu',
      'E2E 4-simulator switcher preserves ?backend=webgpu across Warp <-> Black Hole <-> Wormhole <-> Binary BH'
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
