#!/usr/bin/env node
/**
 * Binary BH (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Capture Suite
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

function startStaticServer(preferredPort = 8783) {
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-bh-qa-'));
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
      // poll
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

  const { server, port, getSkyRequestCount } = await startStaticServer(8783);
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

    const waitForReadyBackend = async (expectedBackend, globalVar = '__BINARY_BH__', expectedPath = '/binary-bh-sim/', maxMs = 15000) => {
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

    const waitForSamples = async (targetSamples = 20, maxMs = 5000) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window.__BINARY_BH__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(120);
      }
      return await evalJS(`window.__BINARY_BH__?.getDiagnostics?.()`);
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
          let sumLuma = 0, maxLuma = 0, darkCorePixels = 0;
          let leftDark = 0, rightDark = 0, diskBrightPixels = 0;

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              if (luma > maxLuma) maxLuma = luma;

              const dx = (x - cx) / height;
              const dy = (y - cy) / height;
              if (Math.abs(dx) < 0.30 && Math.abs(dy) < 0.24) {
                if (luma < 14) {
                  darkCorePixels++;
                  if (dx < -0.015) leftDark++;
                  else if (dx > 0.015) rightDark++;
                }
                if (luma > 90) diskBrightPixels++;
              }
            }
          }

          return {
            width,
            height,
            meanLuma: +(sumLuma / (width * height)).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            darkCorePixels,
            leftDark,
            rightDark,
            diskBrightPixels,
          };
        })()`,
        true
      );
    };

    const baseUrl = `http://127.0.0.1:${port}/binary-bh-sim/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(30);
    const liveFpsWebGL = await evalJS(`window.__BINARY_BH__.getTelemetry().fps`);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__BINARY_BH__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png', { liveFpsWebGL, ...statsWebGLInit });

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

    // Non-default camera pose before switch
    await evalJS(`window.__BINARY_BH__.setState({
      paused: true,
      autoOrbit: false,
      camera: { radius: 28.0, elevationDeg: 18.0, azimuthDeg: 28.0, rollDeg: -2.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__BINARY_BH__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 5000);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(100);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__BINARY_BH__.getState().camera`);
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
    await evalJS(`window.__BINARY_BH__.setState({ paused: false, autoOrbit: true })`);
    await sleep(1200);
    const liveFpsWebGPU = await evalJS(`window.__BINARY_BH__.getTelemetry().fps`);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__BINARY_BH__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const capturePreset = async (presetId, filename, targetSamples = 20) => {
      await evalJS(`
        window.__BINARY_BH__.selectPreset('${presetId}', true);
        window.__BINARY_BH__.setState({ paused: true, autoOrbit: false });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 5000);
      await waitFrames(4);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(`Captured ${filename} (samples=${d?.samples}, meanLuma=${stats.meanLuma}, darkCore=${stats.darkCorePixels}, diskBright=${stats.diskBrightPixels})`);
      return { file: shot.outPath, samples: d?.samples, stats };
    };

    const shots = {};
    shots.equal_mass = await capturePreset('equal_mass', '04_equal_mass_webgpu.png', 20);
    shots.emri = await capturePreset('emri', '05_emri_webgpu.png', 20);
    shots.eyebrows = await capturePreset('eyebrows', '06_eyebrows_webgpu.png', 20);
    shots.tidal_bridges = await capturePreset('tidal_bridges', '07_tidal_bridges_webgpu.png', 20);
    shots.pre_merger = await capturePreset('pre_merger', '08_pre_merger_webgpu.png', 20);
    shots.vacuum = await capturePreset('vacuum', '09_vacuum_webgpu.png', 20);

    // 3. Switch BACK from WebGPU to WebGL2
    await evalJS(`window.__BINARY_BH__.selectPreset('equal_mass', true); window.__BINARY_BH__.setState({ paused: true, autoOrbit: false });`);
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(300);
    console.log('3. Clicking WebGL2 toggle inside Controls drawer to switch back...');
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 5000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const sliderTest = await evalJS(`(() => {
      const target = document.getElementById('ctrl-massRatio');
      if (!target) return { ok: false };
      const before = JSON.parse(JSON.stringify(window.__BINARY_BH__.getState()));
      const origVal = target.value;
      target.value = '0.45';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = JSON.parse(JSON.stringify(window.__BINARY_BH__.getState()));
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: Math.abs(before.massRatio - after.massRatio) > 0.1 };
    })()`);

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
    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    await waitFrames(4);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__BINARY_BH__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const s10 = await captureShot('10_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(s10.base64);

    // 4. Direct ?backend=webgpu + E2E Cross-Sim Switcher
    const directUrl = `http://127.0.0.1:${port}/binary-bh-sim/?backend=webgpu`;
    console.log(`4. Navigating directly to ${directUrl} + testing 3-sim switcher E2E...`);
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(12);

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const cur = nav?.querySelector('[aria-current="page"]');
      const bh = document.getElementById('sim-switch-link');
      const wh = document.getElementById('sim-switch-wormhole');
      return {
        hasNav: Boolean(nav),
        noTabRole: nav?.getAttribute('role') !== 'tab' && bh?.getAttribute('role') !== 'tab',
        currentId: cur?.id,
        bhHref: bh?.getAttribute('href'),
        whHref: wh?.getAttribute('href'),
      };
    })()`);

    await evalJS(`document.getElementById('sim-switch-link')?.click()`);
    const diagBlackholeSwitch = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/blackhole-sim/');
    await waitFrames(12);
    await captureShot('11_e2e_blackhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-binary')?.click()`);
    const diagBinaryBack = await waitForReadyBackend('webgpu', '__BINARY_BH__', '/binary-bh-sim/');
    await waitFrames(10);

    await evalJS(`document.getElementById('sim-switch-wormhole')?.click()`);
    const diagWormholeSwitch = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/wormhole-sim/');
    await waitFrames(12);
    await captureShot('12_e2e_wormhole_via_switcher.png');

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
      sliderTest,
      hudHiddenAfterH,
      switcherCheck,
      diagBlackholeSwitch,
      diagBinaryBack,
      diagWormholeSwitch,
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED BINARY BH CHROME QA ASSERTIONS ===');
    let qaFail = 0;
    const check = (cond, msg, detail = '') => {
      if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
      else { qaFail++; console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`); }
    };

    check(consoleErrors.length === 0, 'Zero JS console errors', consoleErrors.join(' | '));
    check(exceptions.length === 0, 'Zero uncaught runtime exceptions', exceptions.join(' | '));
    check(failedRequests.length === 0, 'Zero failed HTTP/network requests', failedRequests.join(' | '));

    check(diagWebGLInit?.backend === 'webgl2', 'Default page boot uses WebGL2', diagWebGLInit?.backend);
    check(diagWebGLInit?.allShadersCompiled === true, 'WebGL2 shaders compiled cleanly');
    check(diagWebGLInit?.tidalComputed === true, 'WebGL2 solved 256x256 RGBA16F tidal field');
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 4K Milky Way sky loaded');
    check(
      /nvidia|rtx 5060/i.test(String(diagWebGLInit?.webglRenderer || '')),
      'WebGL2 running on hardware NVIDIA RTX 5060 GL',
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
    check(diagWebGPU?.tidalComputed === true, 'WebGPU computed 256x256 rgba16float tidal field');
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
      Math.abs(camAfterSwitch.radius - camBeforeSwitch.radius) < 0.1 &&
      Math.abs(camAfterSwitch.elevationDeg - camBeforeSwitch.elevationDeg) < 0.5 &&
      Math.abs(camAfterSwitch.azimuthDeg - camBeforeSwitch.azimuthDeg) < 0.5 &&
      Math.abs(camAfterSwitch.rollDeg - camBeforeSwitch.rollDeg) < 0.5;
    check(camPreserved, 'Camera pose preserved across WebGL2 -> WebGPU switch');
    check(liveFpsWebGPU >= 20, 'WebGPU High quality runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGPU}`);

    check(
      shots.equal_mass.stats.darkCorePixels > 200 && shots.equal_mass.stats.leftDark > 40 && shots.equal_mass.stats.rightDark > 40,
      'Equal-Mass preset renders twin dark BH horizon shadows',
      `leftDark=${shots.equal_mass.stats.leftDark}, rightDark=${shots.equal_mass.stats.rightDark}`
    );
    check(
      shots.tidal_bridges.stats.diskBrightPixels > 8000 && shots.tidal_bridges.stats.meanLuma > shots.vacuum.stats.meanLuma,
      'Tidal Gas Bridges preset renders luminous circumbinary disk, bridges & mini-disks',
      `diskBright=${shots.tidal_bridges.stats.diskBrightPixels}, tidalMean=${shots.tidal_bridges.stats.meanLuma} vs vacMean=${shots.vacuum.stats.meanLuma}`
    );
    check(
      shots.vacuum.stats.darkCorePixels > 250 && shots.vacuum.stats.meanLuma > 4.0,
      'Pure Vacuum Binary preset renders twin vacuum horizon shadows against Milky Way',
      `darkCore=${shots.vacuum.stats.darkCorePixels}, meanLuma=${shots.vacuum.stats.meanLuma}`
    );

    check(diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true, 'Live switch BACK WebGPU -> WebGL2 succeeded cleanly');
    check(statsWebGLAfterSwitch.meanLuma > 5 && statsWebGLAfterSwitch.darkCorePixels > 100, 'WebGL2 after switch renders non-blank binary black hole image');
    check(sliderTest?.ok === true, 'Live slider input updates simulator state cleanly');
    check(hudHiddenAfterH === true, 'Hotkey H cleanly toggles HUD visibility');
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
      switcherCheck?.hasNav && switcherCheck?.noTabRole && switcherCheck?.currentId === 'sim-switch-binary' &&
        switcherCheck?.bhHref?.includes('?backend=webgpu') && switcherCheck?.whHref?.includes('?backend=webgpu'),
      '3-simulator navbar switcher uses aria-current="page" and propagates ?backend=webgpu'
    );
    check(
      diagBlackholeSwitch?.backend === 'webgpu' && diagBinaryBack?.backend === 'webgpu' && diagWormholeSwitch?.backend === 'webgpu',
      'E2E 3-simulator switcher preserves ?backend=webgpu across Binary BH <-> Black Hole <-> Wormhole'
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
