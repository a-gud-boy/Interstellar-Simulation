#!/usr/bin/env node
/**
 * Wormhole Simulator (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Switcher Suite
 *
 * Serves the Trial workspace root so BOTH /wormhole-sim/ and /blackhole-sim/ resolve cleanly.
 * Launches headed X11 GPU-accelerated Google Chrome in dark mode with BOTH WebGL2 and WebGPU
 * enabled on NVIDIA RTX 5060 (matching launch.sh):
 *  1. Verifies default /wormhole-sim/ boot uses WebGL2, NVIDIA GL renderer, 4K Milky Way, drawer collapsed
 *  2. Opens Controls drawer and clicks #ctrl-backend-webgpu -> verifies live switch to NVIDIA Blackwell WebGPU,
 *     zero extra network fetch of milkyway_4k.jpg, preserved camera pose, valid capturePNG() (>50KB)
 *  3. Verifies bi-universal portal rendering (portal center Universe B golden-amber/teal nebula vs outer
 *     field Universe A Milky Way) and captures all 6 presets (interstellar, ellis, tunnel, crossing, universe_b, einstein)
 *  4. Verifies Traverse (T) smoothly flies camera across l=0 from Universe A (l>0) into Universe B (l<0)
 *  5. Switches BACK to WebGL2 -> verifies valid PNG (>50KB), non-blank frame, slider & H hotkey
 *  6. E2E Cross-Sim Switcher test: /blackhole-sim/?backend=webgpu -> #sim-switch-link -> /wormhole-sim/?backend=webgpu
 *     -> #sim-switch-link -> /blackhole-sim/?backend=webgpu cleanly on WebGPU with zero errors
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

function startTrialRootServer(preferredPort = 8789) {
  let skyRequestCount = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath.endsWith('milkyway_4k.jpg')) {
        skyRequestCount++;
      }
      let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      let fullPath = path.resolve(TRIAL_ROOT, rel);
      if (!fullPath.startsWith(TRIAL_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.stat(fullPath, (err, stat) => {
        if (!err && stat.isDirectory()) {
          fullPath = path.join(fullPath, 'index.html');
          fs.stat(fullPath, (err2, stat2) => serveFile(err2, stat2, fullPath, res));
          return;
        }
        serveFile(err, stat, fullPath, res);
      });
    });

    function serveFile(err, stat, fullPath, res) {
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
    }

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wormhole-unified-qa-'));
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
      // keep polling
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

  const { server, port, getSkyRequestCount } = await startTrialRootServer(8789);
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
      if (p.canceled) return;
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

    const waitForReadyBackend = async (expectedBackend, apiGlobal = '__WORMHOLE__', urlPart = '', maxMs = 18000) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        try {
          const res = await evalJS(`(() => {
            const urlOk = ${urlPart ? `window.location.href.includes(${JSON.stringify(urlPart)})` : 'true'};
            const d = window[${JSON.stringify(apiGlobal)}]?.getDiagnostics?.();
            return { urlOk, href: window.location.href, diag: d || null };
          })()`);
          if (
            res?.urlOk &&
            res?.diag &&
            res.diag.backend === expectedBackend &&
            !res.diag.switchingBackend &&
            res.diag.skyMapLoaded === true
          ) {
            return res;
          }
        } catch {
          // Execution context resets briefly during cross-page navigation
        }
        await sleep(140);
      }
      return await evalJS(`(() => ({
        urlOk: ${urlPart ? `window.location.href.includes(${JSON.stringify(urlPart)})` : 'true'},
        href: window.location.href,
        diag: window[${JSON.stringify(apiGlobal)}]?.getDiagnostics?.() || null,
      }))()`).catch(() => null);
    };

    const waitForSamples = async (targetSamples = 20, apiGlobal = '__WORMHOLE__', maxMs = 4500) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window[${JSON.stringify(apiGlobal)}]?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(120);
      }
      return await evalJS(`window[${JSON.stringify(apiGlobal)}]?.getDiagnostics?.()`);
    };

    const captureShot = async (filename) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(SHOT_DIR, filename);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      return { outPath, base64: data };
    };

    const analyzePortalPng = async (base64) => {
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
          let cenR = 0, cenG = 0, cenB = 0, cenCount = 0, cenGoldTeal = 0;
          let outR = 0, outG = 0, outB = 0, outCount = 0;

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              if (luma > maxLuma) maxLuma = luma;

              const distNorm = Math.hypot(x - cx, y - cy) / height;
              if (distNorm < 0.11) {
                cenR += r; cenG += g; cenB += b; cenCount++;
                // Golden-amber (R>G>=B) or Teal (G>R && B>R) emission signature
                if ((r > b + 12 && r > 35) || (g > r + 8 && b > r + 5 && g > 30)) {
                  cenGoldTeal++;
                }
              } else if (distNorm > 0.33 && distNorm < 0.47) {
                outR += r; outG += g; outB += b; outCount++;
              }
            }
          }

          const total = width * height;
          const cR = cenR / Math.max(1, cenCount);
          const cG = cenG / Math.max(1, cenCount);
          const cB = cenB / Math.max(1, cenCount);
          const oR = outR / Math.max(1, outCount);
          const oG = outG / Math.max(1, outCount);
          const oB = outB / Math.max(1, outCount);
          const cLuma = 0.2126 * cR + 0.7152 * cG + 0.0722 * cB;
          const oLuma = 0.2126 * oR + 0.7152 * oG + 0.0722 * oB;
          const rgbDist = Math.hypot(cR - oR, cG - oG, cB - oB);

          return {
            width,
            height,
            meanLuma: +(sumLuma / total).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            portalCenter: {
              meanLuma: +cLuma.toFixed(2),
              rgb: [+cR.toFixed(1), +cG.toFixed(1), +cB.toFixed(1)],
              goldTealRatio: +(cenGoldTeal / Math.max(1, cenCount)).toFixed(3),
            },
            outerField: {
              meanLuma: +oLuma.toFixed(2),
              rgb: [+oR.toFixed(1), +oG.toFixed(1), +oB.toFixed(1)],
            },
            rgbDistanceCenterVsOuter: +rgbDist.toFixed(2),
          };
        })()`,
        true
      );
    };

    const pressKey = async (key, code, keyCode) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text: key,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await sleep(220);
    };

    // =========================================================================
    // 1. Default /wormhole-sim/ boot (WebGL2, NVIDIA RTX 5060, drawer collapsed)
    // =========================================================================
    const baseUrl = `http://127.0.0.1:${port}/wormhole-sim/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const initRes = await waitForReadyBackend('webgl2', '__WORMHOLE__', '/wormhole-sim/');
    const diagWebGLInit = initRes?.diag;
    await waitFrames(25);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__WORMHOLE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    const s1 = await captureShot('01_wormhole_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePortalPng(s1.base64);
    console.log('Captured 01_wormhole_webgl2_default_hud.png');

    // =========================================================================
    // 2. Open Controls drawer & switch live WebGL2 -> WebGPU
    // =========================================================================
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
    await captureShot('02_wormhole_controls_drawer_webgl2.png');

    // Non-default camera pose before switch to verify pose preservation
    await evalJS(`window.__WORMHOLE__.setState({
      paused: true,
      autoOrbit: false,
      camera: { l: 11.5, elevationDeg: 11.0, azimuthDeg: 28.0, lookYawDeg: 2.0, lookPitchDeg: -1.5, rollDeg: -3.5 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__WORMHOLE__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking #ctrl-backend-webgpu inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const gpuRes = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/wormhole-sim/');
    const diagWebGPU = gpuRes?.diag;
    await waitForSamples(16, '__WORMHOLE__', 4500);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(100);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__WORMHOLE__.getState().camera`);
    const toggleCheckWebGPU = await evalJS(`(() => {
      const btnGL = document.getElementById('ctrl-backend-webgl2');
      const btnGPU = document.getElementById('ctrl-backend-webgpu');
      return {
        glChecked: btnGL?.getAttribute('aria-checked'),
        gpuChecked: btnGPU?.getAttribute('aria-checked'),
      };
    })()`);

    await captureShot('03_wormhole_controls_drawer_webgpu.png');
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__WORMHOLE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    // =========================================================================
    // 3. Bi-universal portal rendering & capture all 6 presets on WebGPU
    // =========================================================================
    const capturePreset = async (presetId, filename, targetSamples = 20) => {
      await evalJS(`
        window.__WORMHOLE__.selectPreset('${presetId}', true);
        window.__WORMHOLE__.setState({ paused: true, autoOrbit: false });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, '__WORMHOLE__', 4500);
      await waitFrames(4);
      const shot = await captureShot(filename);
      const stats = await analyzePortalPng(shot.base64);
      console.log(
        `Captured ${filename} (samples=${d?.samples}, centerRGB=[${stats.portalCenter.rgb}], outerRGB=[${stats.outerField.rgb}], rgbDist=${stats.rgbDistanceCenterVsOuter})`
      );
      return { file: shot.outPath, samples: d?.samples, stats };
    };

    const shots = {};
    shots.interstellar = await capturePreset('interstellar', '04_interstellar_webgpu.png', 20);
    shots.ellis = await capturePreset('ellis', '05_ellis_webgpu.png', 20);
    shots.tunnel = await capturePreset('tunnel', '06_tunnel_webgpu.png', 20);
    shots.crossing = await capturePreset('crossing', '07_crossing_webgpu.png', 20);
    shots.universe_b = await capturePreset('universe_b', '08_universe_b_webgpu.png', 20);
    shots.einstein = await capturePreset('einstein', '09_einstein_webgpu.png', 20);

    // =========================================================================
    // 4. Test Traverse (T) flies across l=0 from Universe A (l>0) -> Universe B (l<0)
    // =========================================================================
    console.log('4. Testing Traverse (T) flight across throat l=0...');
    await evalJS(`
      window.__WORMHOLE__.selectPreset('interstellar', true);
      window.__WORMHOLE__.setState({ paused: false, autoOrbit: false });
    `);
    await waitFrames(4);
    const traverseStart = await evalJS(`({
      cam: window.__WORMHOLE__.getState().camera,
      tel: window.__WORMHOLE__.getTelemetry(),
    })`);

    await pressKey('t', 'KeyT', 84);
    const lTrace = [];
    for (let i = 0; i < 28; i++) {
      await sleep(160);
      const cur = await evalJS(`window.__WORMHOLE__.getState().camera.l`);
      lTrace.push(+cur.toFixed(3));
      if (i > 22 && cur < -8.0 && Math.abs(cur - lTrace[lTrace.length - 2]) < 0.02) {
        break;
      }
    }
    const traverseEnd = await evalJS(`({
      cam: window.__WORMHOLE__.getState().camera,
      tel: window.__WORMHOLE__.getTelemetry(),
    })`);
    await waitFrames(6);
    await captureShot('10_wormhole_after_traverse_univB.png');
    console.log(`Traverse (T): l ${traverseStart.cam.l.toFixed(2)} -> ${traverseEnd.cam.l.toFixed(2)} (${traverseEnd.tel.region})`);

    // =========================================================================
    // 5. Switch BACK to WebGL2 & verify valid PNG, non-blank frame, slider & H
    // =========================================================================
    console.log('5. Switching BACK from WebGPU to WebGL2...');
    await evalJS(`
      window.__WORMHOLE__.selectPreset('interstellar', true);
      window.__WORMHOLE__.setState({ paused: true, autoOrbit: false });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const glBackRes = await waitForReadyBackend('webgl2', '__WORMHOLE__', '/wormhole-sim/');
    const diagWebGLAfterSwitch = glBackRes?.diag;
    await waitForSamples(16, '__WORMHOLE__', 4500);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const sliderTest = await evalJS(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="range"]'));
      const target = document.getElementById('ctrl-throatGlow') || inputs[0];
      if (!target) return { ok: false, count: inputs.length };
      const key = target.id.replace(/^ctrl-/, '');
      const before = JSON.parse(JSON.stringify(window.__WORMHOLE__.getState()));
      const origVal = target.value;
      const nextVal = String(Math.min(Number(target.max || 1), Math.max(Number(target.min || 0), Number(origVal) + 0.15)));
      target.value = nextVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = JSON.parse(JSON.stringify(window.__WORMHOLE__.getState()));
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: before[key] !== after[key], key, sliderCount: inputs.length };
    })()`);

    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    await waitFrames(4);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__WORMHOLE__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const s11 = await captureShot('11_wormhole_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePortalPng(s11.base64);

    // =========================================================================
    // 6. E2E Cross-Sim Switcher: /blackhole-sim/?backend=webgpu <-> /wormhole-sim/?backend=webgpu
    // =========================================================================
    console.log('6. Running E2E Cross-Sim Switcher test on ?backend=webgpu...');
    const bhWebgpuUrl = `http://127.0.0.1:${port}/blackhole-sim/?backend=webgpu`;
    await cdp.send('Page.navigate', { url: bhWebgpuUrl });
    const bhInitRes = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/blackhole-sim/');
    await waitFrames(12);

    const bhSwitcherCheck = await evalJS(`(() => {
      const link = document.getElementById('sim-switch-link');
      const nav = link?.closest('nav');
      return {
        exists: Boolean(link),
        inNav: Boolean(nav && nav.getAttribute('aria-label') === 'Simulation switcher'),
        noTabRole: link?.getAttribute('role') !== 'tab' && nav?.getAttribute('role') !== 'tab',
        hrefAttr: link?.getAttribute('href') || '',
      };
    })()`);

    await evalJS(`document.getElementById('sim-switch-link')?.click()`);
    const whFromSwitchRes = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/wormhole-sim/');
    await waitFrames(15);
    const whSwitcherCheck = await evalJS(`(() => {
      const link = document.getElementById('sim-switch-link');
      const nav = link?.closest('nav');
      return {
        exists: Boolean(link),
        inNav: Boolean(nav && nav.getAttribute('aria-label') === 'Simulation switcher'),
        noTabRole: link?.getAttribute('role') !== 'tab' && nav?.getAttribute('role') !== 'tab',
        hrefAttr: link?.getAttribute('href') || '',
        search: window.location.search,
      };
    })()`);
    await captureShot('12_e2e_wormhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-link')?.click()`);
    const bhBackRes = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/blackhole-sim/');
    await waitFrames(15);
    await captureShot('13_e2e_blackhole_back_via_switcher.png');

    const report = {
      diagWebGLInit,
      diagWebGPU,
      diagWebGLAfterSwitch,
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
      traverse: { traverseStart, traverseEnd, lTrace },
      sliderTest,
      hudHiddenAfterH,
      e2eSwitcher: {
        bhInitDiag: bhInitRes?.diag,
        bhSwitcherCheck,
        whFromSwitchHref: whFromSwitchRes?.href,
        whFromSwitchDiag: whFromSwitchRes?.diag,
        whSwitcherCheck,
        bhBackHref: bhBackRes?.href,
        bhBackDiag: bhBackRes?.diag,
      },
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED WORMHOLE CHROME QA ASSERTIONS ===');
    let qaFail = 0;
    const check = (cond, msg, detail = '') => {
      if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
      else { qaFail++; console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`); }
    };

    check(consoleErrors.length === 0, 'Zero JS console errors', consoleErrors.join(' | '));
    check(exceptions.length === 0, 'Zero uncaught runtime exceptions', exceptions.join(' | '));
    check(failedRequests.length === 0, 'Zero failed HTTP/network requests', failedRequests.join(' | '));

    check(diagWebGLInit?.backend === 'webgl2', 'Default /wormhole-sim/ boot uses WebGL2', diagWebGLInit?.backend);
    check(diagWebGLInit?.allShadersCompiled === true, 'WebGL2 shaders compiled cleanly');
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 4K Milky Way sky loaded');
    check(
      /nvidia|rtx 5060/i.test(String(diagWebGLInit?.webglRenderer || '')),
      'WebGL2 running on hardware NVIDIA RTX 5060 GL',
      diagWebGLInit?.webglRenderer
    );
    check(drawerClosedInitially === true, 'Controls drawer starts collapsed (backend toggle hidden from main viewport)');
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
      Math.abs((camAfterSwitch?.l ?? 999) - (camBeforeSwitch?.l ?? -999)) < 0.15 &&
      Math.abs((camAfterSwitch?.elevationDeg ?? 999) - (camBeforeSwitch?.elevationDeg ?? -999)) < 0.5 &&
      Math.abs((camAfterSwitch?.azimuthDeg ?? 999) - (camBeforeSwitch?.azimuthDeg ?? -999)) < 0.5 &&
      Math.abs((camAfterSwitch?.rollDeg ?? 999) - (camBeforeSwitch?.rollDeg ?? -999)) < 0.5;
    check(camPreserved, 'Camera pose preserved across WebGL2 -> WebGPU switch');

    // Bi-universal portal rendering verification
    const interStats = shots.interstellar.stats;
    const ellisStats = shots.ellis.stats;
    const univBStats = shots.universe_b.stats;
    check(
      interStats.portalCenter.meanLuma > 6 &&
        interStats.outerField.meanLuma > 2 &&
        interStats.rgbDistanceCenterVsOuter > 15 &&
        interStats.portalCenter.goldTealRatio > 0.2,
      'Bi-universal portal (Interstellar): portal center shows golden-teal Universe B vs outer Universe A Milky Way',
      `centerRGB=[${interStats.portalCenter.rgb}], outerRGB=[${interStats.outerField.rgb}], dist=${interStats.rgbDistanceCenterVsOuter}, goldTeal=${interStats.portalCenter.goldTealRatio}`
    );
    check(
      ellisStats.portalCenter.meanLuma > 6 &&
        ellisStats.rgbDistanceCenterVsOuter > 15 &&
        univBStats.outerField.meanLuma > 5 &&
        Math.hypot(
          interStats.outerField.rgb[0] - univBStats.outerField.rgb[0],
          interStats.outerField.rgb[1] - univBStats.outerField.rgb[1],
          interStats.outerField.rgb[2] - univBStats.outerField.rgb[2]
        ) > 15,
      'Universe B preset swaps outer/portal hemispheres cleanly (Ellis & Universe B verified)',
      `ellisDist=${ellisStats.rgbDistanceCenterVsOuter}, univBOuterRGB=[${univBStats.outerField.rgb}]`
    );

    const allPresetsNonBlank = Object.entries(shots).every(
      ([, s]) => s.stats.meanLuma > 4 && s.stats.maxLuma > 60
    );
    check(allPresetsNonBlank, 'All 6 wormhole presets render crisp non-blank WebGPU frames');

    // Traverse (T) verification
    const crossedZero =
      traverseStart.cam.l > 5.0 &&
      traverseEnd.cam.l < -5.0 &&
      traverseEnd.tel?.region === 'Universe B' &&
      lTrace.some((v) => v > 0) &&
      lTrace.some((v) => v < 0) &&
      lTrace.every((v) => Number.isFinite(v));
    check(
      crossedZero,
      'Traverse (T) smoothly flies across l=0 from Universe A (l>0) into Universe B (l<0)',
      `l: ${traverseStart.cam.l.toFixed(2)} -> ${traverseEnd.cam.l.toFixed(2)} (${traverseEnd.tel?.region})`
    );

    // WebGPU -> WebGL2 switch back
    check(
      diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true,
      'Live switch BACK WebGPU -> WebGL2 succeeded cleanly'
    );
    check(
      statsWebGLAfterSwitch.meanLuma > 5 && statsWebGLAfterSwitch.maxLuma > 60,
      'WebGL2 after round-trip switch renders non-blank wormhole image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}, maxLuma=${statsWebGLAfterSwitch.maxLuma}`
    );
    check(sliderTest?.ok === true, 'Live slider input updates wormhole simulator state cleanly');
    check(hudHiddenAfterH === true, 'Hotkey H cleanly toggles HUD visibility');
    check(
      pngBytesWebGL > 50000 && pngBytesWebGPU > 50000 && pngBytesWebGLAfterSwitch > 50000,
      'capturePNG() produces valid PNG Blobs (>50KB) across WebGL2 & WebGPU',
      `bytes=[${pngBytesWebGL}, ${pngBytesWebGPU}, ${pngBytesWebGLAfterSwitch}]`
    );

    // E2E Cross-Sim Switcher assertions
    check(
      bhSwitcherCheck?.exists &&
        bhSwitcherCheck?.inNav &&
        bhSwitcherCheck?.noTabRole &&
        bhSwitcherCheck?.hrefAttr.endsWith('../wormhole-sim/?backend=webgpu'),
      'blackhole-sim #sim-switch-link points cleanly to ../wormhole-sim/?backend=webgpu',
      bhSwitcherCheck?.hrefAttr
    );
    check(
      whFromSwitchRes?.href?.includes('/wormhole-sim/') &&
        whFromSwitchRes?.diag?.backend === 'webgpu' &&
        whFromSwitchRes?.diag?.allShadersCompiled === true &&
        whFromSwitchRes?.diag?.skyMapLoaded === true &&
        (whFromSwitchRes?.diag?.errors || []).length === 0,
      'Clicking switcher from blackhole-sim navigates cleanly to /wormhole-sim/?backend=webgpu running WebGPU',
      whFromSwitchRes?.href
    );
    check(
      whSwitcherCheck?.exists &&
        whSwitcherCheck?.inNav &&
        whSwitcherCheck?.noTabRole &&
        whSwitcherCheck?.hrefAttr.endsWith('../blackhole-sim/?backend=webgpu'),
      'wormhole-sim #sim-switch-link points cleanly to ../blackhole-sim/?backend=webgpu',
      whSwitcherCheck?.hrefAttr
    );
    check(
      bhBackRes?.href?.includes('/blackhole-sim/') &&
        bhBackRes?.diag?.backend === 'webgpu' &&
        bhBackRes?.diag?.allShadersCompiled === true &&
        bhBackRes?.diag?.skyMapLoaded === true &&
        (bhBackRes?.diag?.errors || []).length === 0,
      'Clicking switcher back from wormhole-sim returns cleanly to /blackhole-sim/?backend=webgpu running WebGPU',
      bhBackRes?.href
    );

    console.log(`\nQA REPORT WRITTEN: ${path.join(SHOT_DIR, 'qa_report.json')}`);
    process.exitCode = qaFail > 0 ? 1 : 0;
  } finally {
    await cdp.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('FATAL QA ERROR:', err);
  process.exit(1);
});
