/**
 * Shared Chrome X11 NVIDIA + WebGL2 + WebGPU CDP launcher and utility helpers
 * for automated browser QA suites.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function angleDiffDeg(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * Launches headed X11 Google Chrome with NVIDIA ANGLE WebGL2 + Vulkan WebGPU
 * and attaches a zero-dependency WebSocket CDP session.
 * @param {object} options
 * @param {number} options.debugPort
 * @param {number} [options.viewportW=1440]
 * @param {number} [options.viewportH=810]
 * @param {string} [options.profilePrefix='interstellar-qa-']
 */
export async function launchChromeDualCDP({
  debugPort,
  viewportW = 1440,
  viewportH = 810,
  profilePrefix = 'interstellar-qa-',
}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
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
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${viewportW},${viewportH}`,
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
    try {
      ws.close();
    } catch {
      // ignore websocket close error
    }
    chrome.kill('SIGTERM');
    await sleep(300);
    if (!chrome.killed) chrome.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  return { send, on, close };
}
