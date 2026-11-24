/**
 * Shared headed Wayland Firefox + NVIDIA WebGPU launcher and diagnostics helper.
 * Enforces `dom.webgpu.allow-present-without-readback = false`, `MOZ_LOG=WebGPU:4`,
 * and active `nvidia-smi` GPU process verification (never `--headless`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export function checkNvidiaSmiFirefox() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=process_name', '--format=csv,noheader'],
      { encoding: 'utf8' }
    );
    const fullOut = execFileSync('nvidia-smi', [], { encoding: 'utf8' });
    return /firefox/i.test(out) || /firefox/i.test(fullOut);
  } catch {
    return false;
  }
}

/**
 * Launches headed Firefox Wayland with NVIDIA offload + WebGPU readback preferences
 * and waits for `donePromise` or timeout.
 * @param {object} options
 * @param {string} options.targetUrl
 * @param {Promise<object>} options.donePromise
 * @param {string} [options.profilePrefix='interstellar-firefox-qa-']
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.width=1280]
 * @param {number} [options.height=720]
 */
export async function runHeadedFirefoxQA({
  targetUrl,
  donePromise,
  profilePrefix = 'interstellar-firefox-qa-',
  timeoutMs = 60000,
  width = 1280,
  height = 720,
}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));

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

  console.log(`Launching headed Firefox Wayland on NVIDIA GPU: ${targetUrl}`);

  const ff = spawn(
    'firefox',
    [
      '--no-remote',
      '--profile',
      profileDir,
      '--width',
      String(width),
      '--height',
      String(height),
      targetUrl,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  ff.stdout.on('data', (d) => {
    stderr += d.toString();
  });
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let sawFirefoxOnNvidia = false;
  const smiTimer = setInterval(() => {
    if (checkNvidiaSmiFirefox()) sawFirefoxOnNvidia = true;
  }, 700);

  let report;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Firefox QA timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs
      )
    );
    report = await Promise.race([donePromise, timeoutPromise]);
    if (checkNvidiaSmiFirefox()) sawFirefoxOnNvidia = true;
  } finally {
    clearInterval(smiTimer);
    ff.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 900));
    if (!ff.killed) ff.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  return { sawFirefoxOnNvidia, report, stderr };
}
