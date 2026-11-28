#!/usr/bin/env node
/**
 * Tidal Disruption Event Observatory (WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA Suite
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../../shared/testing/staticServer.mjs';
import { sleep, launchChromeDualCDP } from '../../../shared/testing/chromeCdp.mjs';
import { SIMULATORS } from '../../../shared/simRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const VIEWPORT_W = 1440;
const VIEWPORT_H = 810;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8794 });
  const debugPort = 9550 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    profilePrefix: 'tde-qa-',
  });

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
    cdp.on('Network.loadingFailed', (p) => {
      if (p.canceled) return;
      failedRequests.push(`${p.type || 'req'}: ${p.errorText}`);
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response?.status >= 400) {
        failedRequests.push(`HTTP ${p.response.status}: ${p.response.url}`);
      }
    });

    const evalJS = async (expression, awaitPromise = false) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text || 'JS eval error');
      }
      return res.result?.value;
    };

    const waitFrames = async (n = 8) => {
      await evalJS(
        `new Promise(r => { let c = ${n}; const s = () => (--c <= 0 ? r(true) : requestAnimationFrame(s)); requestAnimationFrame(s); })`,
        true
      );
    };

    const waitForReadyBackend = async (expectedBackend, timeoutMs = 45000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const diag = await evalJS(
          `window.__TDE__?.getDiagnostics ? window.__TDE__.getDiagnostics() : null`
        );
        if (
          diag &&
          diag.backend === expectedBackend &&
          !diag.switchingBackend &&
          diag.allShadersCompiled === true &&
          diag.skyMapLoaded === true &&
          diag.volumeBaked === true &&
          (diag.samples || 0) >= 1
        ) {
          return diag;
        }
        await sleep(200);
      }
      throw new Error(`Timed out waiting for TDE backend=${expectedBackend}`);
    };

    const checkCapturePngSize = async () => {
      return await evalJS(`(async () => {
        const dataUrl = await window.__TDE__.captureRawPngDataUrl();
        return dataUrl ? Math.floor((dataUrl.split(',')[1] || '').length * 0.75) : 0;
      })()`, true);
    };

    const inspectCanvasVisual = async (shotName) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOT_DIR, shotName);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      const stats = await evalJS(
        `(async () => {
          const img = new Image();
          img.src = "data:image/png;base64,${data}";
          await img.decode();
          const sc = document.createElement('canvas');
          sc.width = img.width;
          sc.height = img.height;
          const ctx = sc.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, sc.width, sc.height).data;
          let sum = 0, sum2 = 0, maxL = 0, n = sc.width * sc.height;
          for (let i = 0; i < d.length; i += 4) {
            const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            sum += l;
            sum2 += l * l;
            if (l > maxL) maxL = l;
          }
          const mean = sum / Math.max(n, 1);
          const std = Math.sqrt(Math.max(0, sum2 / Math.max(n, 1) - mean * mean));
          const tc = document.createElement('canvas');
          tc.width = 96;
          tc.height = 54;
          const tctx = tc.getContext('2d');
          tctx.drawImage(sc, 0, 0, 96, 54);
          const td = tctx.getImageData(0, 0, 96, 54).data;
          const thumb = [];
          for (let i = 0; i < td.length; i += 4) thumb.push(td[i], td[i + 1], td[i + 2]);
          return {
            width: sc.width,
            height: sc.height,
            meanLuma: Number(mean.toFixed(2)),
            stdLuma: Number(std.toFixed(2)),
            maxLuma: Number(maxL.toFixed(1)),
            thumb,
          };
        })()`,
        true
      );
      return { stats, shot: file };
    };

    const compareThumbs = (a, b) => {
      if (!a?.length || !b?.length || a.length !== b.length) return 255;
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      return Number((sum / a.length).toFixed(2));
    };

    const pressKey = async (key, code, keyCode) => {
      const payload = { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode };
      if (key.length === 1) payload.text = key;
      await cdp.send('Input.dispatchKeyEvent', payload);
      await sleep(30);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await sleep(90);
    };

    const url = `http://127.0.0.1:${port}/sims/tde/`;
    console.log(`1. Navigating to ${url} (default WebGL2 boot)...`);
    await cdp.send('Page.navigate', { url });
    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(18);

    const liveFpsWebGL = await evalJS(`(() => new Promise(r => {
      let n = 0; const t0 = performance.now();
      function f() { if (++n >= 24) r(Number((n * 1000 / Math.max(performance.now() - t0, 1)).toFixed(1))); else requestAnimationFrame(f); }
      requestAnimationFrame(f);
    }))()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const d = document.getElementById('controls-drawer');
      return !d?.classList.contains('is-open') && d?.getAttribute('aria-hidden') === 'true';
    })()`);

    const hudLayoutCheck = await evalJS(`(async () => {
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      const overlaps = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const trigger = document.getElementById('sim-switch-trigger');
      const popover = document.getElementById('sim-switch-popover');
      const hdr = document.querySelector('.hud-top-left');
      const ctrl = document.getElementById('controls-toggle');
      const navRect = nav?.getBoundingClientRect();
      const hdrRect = hdr?.getBoundingClientRect();
      const ctrlRect = ctrl?.getBoundingClientRect();
      const initiallyClosed = popover?.getAttribute('aria-hidden') === 'true';
      trigger?.click();
      await sleepMs(160);
      const opened = popover?.classList.contains('is-open') && popover?.getAttribute('aria-hidden') === 'false';
      const pills = Array.from(popover?.querySelectorAll('a[data-sim-href]') || []);
      const search = document.getElementById('sim-switch-search');
      if (search) {
        search.value = 'tidal disruption';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleepMs(60);
      const filteredCount = pills.filter((p) => !p.classList.contains('is-filtered-out')).length;
      if (search) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleepMs(160);
      const closedAfterEsc = popover?.getAttribute('aria-hidden') === 'true';
      return {
        hasTrigger: Boolean(trigger),
        hasPopover: Boolean(popover),
        initiallyClosed,
        hdrNavOverlap: Boolean(hdrRect && navRect && overlaps(hdrRect, navRect)),
        ctrlOverlap: Boolean(ctrlRect && navRect && overlaps(ctrlRect, navRect)),
        opened,
        pillCount: pills.length,
        filteredCount,
        closedAfterEsc,
      };
    })()`, true);

    const presetIds = ['self_intersection', 'tidal_rip', 'deep_plunge', 'eddington_flare', 'jetted_tde', 'hills_horizon'];
    const webglShots = {};
    for (const id of presetIds) {
      await evalJS(`window.__TDE__.applyPreset('${id}', true)`);
      await waitFrames(14);
      webglShots[id] = await inspectCanvasVisual(`tde_${id}_webgl2.png`);
    }

    const webglCaptureBytes = await checkCapturePngSize();
    const skyFetchesBeforeSwitch = getSkyRequestCount();
    const diagWebGPU = await evalJS(`(async () => {
      await window.__TDE__.setBackend('webgpu');
      return window.__TDE__.getDiagnostics();
    })()`, true);
    await waitForReadyBackend('webgpu');
    await waitFrames(16);
    const skyFetchesAfterSwitch = getSkyRequestCount();

    const liveFpsWebGPU = await evalJS(`(() => new Promise(r => {
      let n = 0; const t0 = performance.now();
      function f() { if (++n >= 24) r(Number((n * 1000 / Math.max(performance.now() - t0, 1)).toFixed(1))); else requestAnimationFrame(f); }
      requestAnimationFrame(f);
    }))()`, true);

    const webgpuShots = {};
    const parityDiffs = {};
    for (const id of presetIds) {
      await evalJS(`window.__TDE__.applyPreset('${id}', true)`);
      await waitFrames(14);
      const shotObj = await inspectCanvasVisual(`tde_${id}_webgpu.png`);
      webgpuShots[id] = shotObj;
      parityDiffs[id] = compareThumbs(webglShots[id].stats.thumb, shotObj.stats.thumb);
    }

    const webgpuCaptureBytes = await checkCapturePngSize();
    // Hotkey T triggers Disruption Evolution Sweep
    await evalJS(`window.__TDE__.applyPreset('self_intersection', true)`);
    await waitFrames(8);
    await pressKey('t', 'KeyT', 84);
    await sleep(450);
    const afterSweepPhase = await evalJS(`window.__TDE__.getState().tdePhase`);
    await evalJS(`window.__TDE__.applyPreset('self_intersection', true)`);
    await waitFrames(6);

    // Space pause -> progressive accumulation check
    await pressKey(' ', 'Space', 32);
    const pausedAfterSpace = await evalJS(`window.__TDE__.getState().paused`);
    let diagProg = null;
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        diagProg = await evalJS(`window.__TDE__.getDiagnostics()`);
        if ((diagProg?.samples ?? 0) >= 8) break;
        await sleep(80);
      }
    }
    await pressKey(' ', 'Space', 32);
    const resumedAfterSpace = await evalJS(`!window.__TDE__.getState().paused`);

    // Switch back to WebGL2
    await evalJS(`window.__TDE__.setBackend('webgl2')`, true);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');

    // Direct ?backend=webgpu & root ?sim=tde redirect check
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/tde/?backend=webgpu` });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?sim=tde&backend=webgpu` });
    const diagRootRedirect = await waitForReadyBackend('webgpu');

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const links = Array.from(nav?.querySelectorAll('a[data-sim-href]') || []);
      const cur = nav?.querySelector('[aria-current="page"]');
      return {
        hasNav: Boolean(nav),
        count: links.length,
        currentId: cur?.id || null,
        allPropagateWebgpu: links.every((a) => a.href.includes('backend=webgpu')),
      };
    })()`);

    const report = {
      diagWebGLInit,
      liveFpsWebGL,
      drawerClosedInitially,
      hudLayoutCheck,
      skyFetchesBeforeSwitch,
      skyFetchesAfterSwitch,
      diagWebGPU,
      liveFpsWebGPU,
      webglShots,
      webgpuShots,
      webglCaptureBytes,
      webgpuCaptureBytes,
      parityDiffs,
      afterSweepPhase,
      accumulation: { pausedAfterSpace, samples: diagProg?.samples ?? 0, resumedAfterSpace },
      diagWebGLAfterSwitch,
      diagDirectWebGPU,
      diagRootRedirect,
      switcherCheck,
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED TDE CHROME QA ASSERTIONS ===');
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
    check(failedRequests.length === 0, 'Zero failed HTTP requests', failedRequests.join(' | '));
    check(diagWebGLInit?.backend === 'webgl2', 'Default boot uses WebGL2');
    check(diagWebGLInit?.allShadersCompiled === true, 'WebGL2 TDE shaders compiled');
    check(diagWebGLInit?.volumeBaked === true, 'WebGL2 baked 128^3 3D plasma noise');
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 loaded 4K Milky Way sky');
    check(/nvidia|rtx/i.test(String(diagWebGLInit?.webglRenderer || '')), 'WebGL2 hardware NVIDIA GL', diagWebGLInit?.webglRenderer);
    check(liveFpsWebGL >= 20, 'WebGL2 runs >= 20 FPS', `fps=${liveFpsWebGL}`);
    check(drawerClosedInitially === true, 'Controls drawer starts collapsed');
    check(
      hudLayoutCheck?.hasTrigger &&
        hudLayoutCheck?.hasPopover &&
        hudLayoutCheck?.initiallyClosed &&
        !hudLayoutCheck?.hdrNavOverlap &&
        !hudLayoutCheck?.ctrlOverlap &&
        hudLayoutCheck?.opened &&
        hudLayoutCheck?.pillCount === SIMULATORS.length &&
        hudLayoutCheck?.filteredCount >= 1 &&
        hudLayoutCheck?.closedAfterEsc,
      `Switcher trigger + ${SIMULATORS.length}-sim popover fit cleanly`,
      JSON.stringify(hudLayoutCheck)
    );
    check(diagWebGPU?.backend === 'webgpu' && diagWebGPU?.allShadersCompiled === true, 'Live switch WebGL2 -> WebGPU succeeded');
    check(
      skyFetchesAfterSwitch === skyFetchesBeforeSwitch && skyFetchesBeforeSwitch === 1,
      'Backend switch reused cached 4K sky blob (zero extra fetches)',
      `${skyFetchesBeforeSwitch} -> ${skyFetchesAfterSwitch}`
    );
    check(
      diagWebGPU?.adapterInfo?.isFallbackAdapter === false &&
        /nvidia|blackwell|rtx|geforce/i.test(String(diagWebGPU?.gpuRenderer || '')),
      'WebGPU running on hardware NVIDIA GPU',
      diagWebGPU?.gpuRenderer
    );
    check(liveFpsWebGPU >= 20, 'WebGPU runs >= 20 FPS', `fps=${liveFpsWebGPU}`);

    for (const id of presetIds) {
      const glS = webglShots[id].stats;
      const gpuS = webgpuShots[id].stats;
      check(
        glS.meanLuma > 3.0 && glS.maxLuma > 85 && glS.stdLuma > 3.0,
        `WebGL2 preset '${id}' renders bright non-blank TDE scene`,
        `mean=${glS.meanLuma}, max=${glS.maxLuma}`
      );
      check(
        gpuS.meanLuma > 3.0 && gpuS.maxLuma > 85 && gpuS.stdLuma > 3.0,
        `WebGPU preset '${id}' renders bright non-blank TDE scene`,
        `mean=${gpuS.meanLuma}, max=${gpuS.maxLuma}`
      );
      check(parityDiffs[id] < 16.0, `WebGL2 <-> WebGPU parity holds for '${id}'`, `diff=${parityDiffs[id]}`);
    }

    check(afterSweepPhase > 0.06 && afterSweepPhase < 0.45, 'KeyT triggers Disruption Evolution Sweep cleanly', `phase=${afterSweepPhase}`);
    check(pausedAfterSpace && (diagProg?.samples ?? 0) >= 2 && resumedAfterSpace, 'Space pauses & accumulates cleanly', `samples=${diagProg?.samples ?? 0}`);
    check(webglCaptureBytes > 30000 && webgpuCaptureBytes > 30000, 'capturePNG() produces valid PNG blobs', `${webglCaptureBytes} / ${webgpuCaptureBytes}`);
    check(diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true, 'Live switch BACK WebGPU -> WebGL2 succeeded');
    check(diagDirectWebGPU?.backend === 'webgpu' && diagRootRedirect?.backend === 'webgpu', '?backend=webgpu & root ?sim=tde redirect work cleanly');
    check(
      switcherCheck?.hasNav &&
        switcherCheck?.count === SIMULATORS.length &&
        switcherCheck?.currentId === 'sim-switch-tde' &&
        switcherCheck?.allPropagateWebgpu,
      `${SIMULATORS.length}-simulator navbar marks tde current & propagates ?backend=webgpu`
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
