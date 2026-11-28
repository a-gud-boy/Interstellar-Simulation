#!/usr/bin/env node
/**
 * Gravitational Lensing Observatory (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA Suite
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../../shared/testing/staticServer.mjs';
import { sleep, angleDiffDeg, launchChromeDualCDP } from '../../../shared/testing/chromeCdp.mjs';
import { SIMULATORS } from '../../../shared/simRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const VIEWPORT_W = 1440;
const VIEWPORT_H = 810;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8793 });
  const debugPort = 9550 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    profilePrefix: 'lens-cluster-qa-',
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
      globalVar = '__LENS_CLUSTER__',
      expectedPath = '/sims/lens-cluster/',
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
        const d = await evalJS(`window.__LENS_CLUSTER__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(100);
      }
      return await evalJS(`window.__LENS_CLUSTER__?.getDiagnostics?.()`);
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
          let warmGoldPixels = 0, cyanBluePixels = 0, magentaArcPixels = 0;
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
              if (r > b + 20 && luma > 25) warmGoldPixels++;
              if (b > r + 15 && luma > 22) cyanBluePixels++;
              if (r > g + 12 && b > g + 8 && luma > 20) magentaArcPixels++;
              const dx = (x - cx) / height;
              const dy = (y - cy) / height;
              if (dx * dx + dy * dy < 0.16 * 0.16) {
                centerCount++;
                centerSumLuma += luma;
              }
            }
          }

          const N = width * height;
          const meanLuma = sumLuma / N;
          const variance = Math.max(0, sumLuma2 / N - meanLuma * meanLuma);
          const stdLuma = Math.sqrt(variance);

          const tw = 96, th = 54;
          const tc = document.createElement("canvas");
          tc.width = tw;
          tc.height = th;
          const tctx = tc.getContext("2d");
          tctx.drawImage(c, 0, 0, tw, th);
          const td = tctx.getImageData(0, 0, tw, th).data;
          for (let i = 0; i < td.length; i += 4) {
            thumb.push(td[i], td[i + 1], td[i + 2]);
          }

          return {
            width,
            height,
            meanLuma: Number(meanLuma.toFixed(2)),
            stdLuma: Number(stdLuma.toFixed(2)),
            maxLuma: Number(maxLuma.toFixed(1)),
            nonBlackRatio: Number((nonBlackPixels / N).toFixed(4)),
            centerMeanLuma: Number((centerSumLuma / Math.max(centerCount, 1)).toFixed(2)),
            warmGoldPixels,
            cyanBluePixels,
            magentaArcPixels,
            thumb,
          };
        })()`,
        true
      );
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

    const url = `http://127.0.0.1:${port}/sims/lens-cluster/`;
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
      const groups = Array.from(popover?.querySelectorAll('.sim-switch-group') || []);
      const pills = Array.from(popover?.querySelectorAll('a[data-sim-href]') || []);
      const rects = pills.map((p) => p.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (overlaps(rects[i], rects[j])) overlap = true;
        }
      }
      const search = document.getElementById('sim-switch-search');
      if (search) {
        search.value = 'starflight';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleepMs(60);
      const filteredCount = Array.from(popover?.querySelectorAll('a[data-sim-href]') || []).filter((p) => !p.classList.contains('is-filtered-out')).length;
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
        navHeight: Math.round(navRect?.height || 0),
        navWidth: Math.round(navRect?.width || 0),
        hdrNavOverlap: Boolean(hdrRect && navRect && overlaps(hdrRect, navRect)),
        ctrlOverlap: Boolean(ctrlRect && navRect && overlaps(ctrlRect, navRect)),
        opened,
        groupCount: groups.length,
        pillCount: pills.length,
        overlap,
        filteredCount,
        closedAfterEsc,
      };
    })()`, true);

    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(320);
    const toggleCheckWebGL = await evalJS(`(() => {
      const gl = document.getElementById('ctrl-backend-webgl2');
      const gpu = document.getElementById('ctrl-backend-webgpu');
      return { hasBoth: Boolean(gl && gpu), glChecked: gl?.getAttribute('aria-checked'), gpuChecked: gpu?.getAttribute('aria-checked') };
    })()`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);

    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__LENS_CLUSTER__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const sGLInit = await captureShot('01_webgl2_jwst_cluster.png');
    const statsWebGLInit = await analyzePng(sGLInit.base64);

    // 2. Capture all 6 presets in WebGL2
    const presetIds = ['einstein_ring', 'einstein_cross', 'jwst_cluster', 'fold_caustic', 'microlensing', 'caustic_fermat'];
    const webglShots = {};
    for (const id of presetIds) {
      await evalJS(`
        window.__LENS_CLUSTER__.applyPreset('${id}', true);
        window.__LENS_CLUSTER__.setState({ paused: true, autoOrbit: false });
      `);
      await waitForSamples(24, 6000);
      const s = await captureShot(`02_webgl2_preset_${id}.png`);
      const tel = await evalJS(`window.__LENS_CLUSTER__.getTelemetry()`);
      webglShots[id] = { stats: await analyzePng(s.base64), tel };
    }

    // 3. Switch to WebGPU and verify RAM sky cache reuse + camera preservation
    console.log('3. Switching live WebGL2 -> WebGPU via Controls drawer...');
    await evalJS(`window.__LENS_CLUSTER__.applyPreset('jwst_cluster', true); window.__LENS_CLUSTER__.setState({ paused: true, autoOrbit: false });`);
    await sleep(150);
    const camBeforeSwitch = await evalJS(`window.__LENS_CLUSTER__.getCameraState()`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(260);
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(18);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__LENS_CLUSTER__.getCameraState()`);

    const toggleCheckWebGPU = await evalJS(`(() => {
      const gl = document.getElementById('ctrl-backend-webgl2');
      const gpu = document.getElementById('ctrl-backend-webgpu');
      return { glChecked: gl?.getAttribute('aria-checked'), gpuChecked: gpu?.getAttribute('aria-checked') };
    })()`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(260);

    const liveFpsWebGPU = await evalJS(`(() => new Promise(r => {
      let n = 0; const t0 = performance.now();
      function f() { if (++n >= 24) r(Number((n * 1000 / Math.max(performance.now() - t0, 1)).toFixed(1))); else requestAnimationFrame(f); }
      requestAnimationFrame(f);
    }))()`, true);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__LENS_CLUSTER__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    // 4. WebGPU preset parity captures + clean HUD-hidden 128-sample hero capture
    const webgpuShots = {};
    for (const id of presetIds) {
      await evalJS(`
        window.__LENS_CLUSTER__.applyPreset('${id}', true);
        window.__LENS_CLUSTER__.setState({ paused: true, autoOrbit: false });
      `);
      await waitForSamples(24, 6000);
      const s = await captureShot(`03_webgpu_preset_${id}.png`);
      const tel = await evalJS(`window.__LENS_CLUSTER__.getTelemetry()`);
      webgpuShots[id] = { stats: await analyzePng(s.base64), tel };
    }

    // Clean 128-sample WebGPU canvas-only hero shot (zero HUD or Show UI pill) for homepage preview
    await evalJS(`
      window.__LENS_CLUSTER__.applyPreset('jwst_cluster', true);
      window.__LENS_CLUSTER__.setState({ paused: true, autoOrbit: false });
    `);
    await waitForSamples(128, 12000);
    const heroCanvasB64 = await evalJS(`(async () => {
      const b = await window.__LENS_CLUSTER__.capturePNG();
      const reader = new FileReader();
      return await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(b);
      });
    })()`, true);
    fs.writeFileSync(path.join(SHOT_DIR, '00_hero_jwst_cluster_canvas.png'), Buffer.from(heroCanvasB64, 'base64'));

    const parityDiffs = {};
    for (const id of presetIds) {
      parityDiffs[id] = compareThumbs(webglShots[id].stats.thumb, webgpuShots[id].stats.thumb);
    }

    // 5. Interactive T (Drag Source <-> Orbit View), mouse drag source offset, Caustic/Fermat diff, & Space 128x accumulation
    console.log('5. Verifying T Drag Source hotkey, pointer source drag, overlays, and 128x pause...');
    await evalJS(`window.__LENS_CLUSTER__.applyPreset('einstein_cross', true); window.__LENS_CLUSTER__.setState({ paused: true, autoOrbit: false, dragMode: 0 });`);
    await waitForSamples(8, 4000);
    const dragBeforeT = await evalJS(`window.__LENS_CLUSTER__.getState()`);
    await pressKey('t', 'KeyT', 84);
    const dragAfterT = await evalJS(`window.__LENS_CLUSTER__.getState()`);

    // Simulate mouse pointer drag on canvas while in Drag Source mode
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 720, y: 405, button: 'left', clickCount: 1 });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 840, y: 345, button: 'left', buttons: 1 });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 315, button: 'left', buttons: 1 });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 315, button: 'left', clickCount: 1 });
    await sleep(120);
    const dragAfterMove = await evalJS(`window.__LENS_CLUSTER__.getState()`);

    // Toggle back to Orbit View
    await pressKey('t', 'KeyT', 84);
    const dragAfterT2 = await evalJS(`window.__LENS_CLUSTER__.getState()`);

    // Caustics / Fermat overlay visual check on caustic_fermat preset
    await evalJS(`window.__LENS_CLUSTER__.applyPreset('caustic_fermat', true); window.__LENS_CLUSTER__.setState({ paused: true, showCaustics: 0, showFermat: 0 });`);
    await waitForSamples(16, 5000);
    const sNoOverlay = await captureShot('04_fermat_off.png');
    await evalJS(`window.__LENS_CLUSTER__.setState({ showCaustics: 1, showFermat: 1 });`);
    await waitForSamples(16, 5000);
    const sWithOverlay = await captureShot('05_fermat_caustic_on.png');
    const overlayVisualDiff = compareThumbs((await analyzePng(sNoOverlay.base64)).thumb, (await analyzePng(sWithOverlay.base64)).thumb);

    // Spacebar 128-sample pause & resume check
    await evalJS(`window.__LENS_CLUSTER__.applyPreset('jwst_cluster', true); window.__LENS_CLUSTER__.setState({ paused: false });`);
    await waitFrames(6);
    await pressKey(' ', 'Space', 32);
    const pausedAfterSpace = await evalJS(`window.__LENS_CLUSTER__.getState().paused === true`);
    const diag128 = await waitForSamples(128, 12000);
    await pressKey(' ', 'Space', 32);
    const resumedAfterSpace = await evalJS(`window.__LENS_CLUSTER__.getState().paused === false`);

    // 6. Switch back WebGPU -> WebGL2 + ?sim= redirect + Switcher link verification
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(250);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(12, 6000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__LENS_CLUSTER__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const directUrl = `http://127.0.0.1:${port}/sims/lens-cluster/?backend=webgpu`;
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(10);

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const cur = nav?.querySelector('[aria-current="page"]');
      const links = Array.from(nav?.querySelectorAll('a[data-sim-href]') || []);
      return {
        hasNav: Boolean(nav),
        count: links.length,
        currentId: cur?.id,
        allPropagateWebgpu: links.every(a => a.id === 'sim-switch-lens-cluster' || a.getAttribute('href')?.includes('?backend=webgpu')),
      };
    })()`);

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?sim=lens-cluster&backend=webgpu` });
    const diagRootRedirect = await waitForReadyBackend('webgpu');

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
      webglShots,
      webgpuShots,
      parityDiffs,
      hotkeyT: {
        dragBefore: dragBeforeT.dragMode,
        dragAfterT: dragAfterT.dragMode,
        sourceDelta: [dragAfterMove.sourceX - dragBeforeT.sourceX, dragAfterMove.sourceY - dragBeforeT.sourceY],
        dragAfterT2: dragAfterT2.dragMode,
      },
      overlayVisualDiff,
      accumulation128: {
        pausedAfterSpace,
        samplesReached: diag128?.samples ?? 0,
        resumedAfterSpace,
      },
      switcherCheck,
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED LENS CLUSTER CHROME QA ASSERTIONS ===');
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
    check(diagWebGLInit?.backend === 'webgl2', 'Default boot uses WebGL2');
    check(diagWebGLInit?.allShadersCompiled === true, 'WebGL2 shaders compiled cleanly');
    check(diagWebGLInit?.volumeBaked === true, 'WebGL2 baked 128^3 3D ICM noise volume');
    check(diagWebGLInit?.skyMapLoaded === true, 'WebGL2 loaded 4K Milky Way sky');
    check(/nvidia|rtx/i.test(String(diagWebGLInit?.webglRenderer || '')), 'WebGL2 running on hardware NVIDIA GL', diagWebGLInit?.webglRenderer);
    check(liveFpsWebGL >= 20, 'WebGL2 runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGL}`);
    check(drawerClosedInitially === true, 'Controls drawer starts collapsed');
    check(
      hudLayoutCheck?.hasTrigger &&
        hudLayoutCheck?.hasPopover &&
        hudLayoutCheck?.initiallyClosed &&
        !hudLayoutCheck?.hdrNavOverlap &&
        !hudLayoutCheck?.ctrlOverlap &&
        hudLayoutCheck?.opened &&
        hudLayoutCheck?.groupCount === 4 &&
        hudLayoutCheck?.pillCount === SIMULATORS.length &&
        !hudLayoutCheck?.overlap &&
        hudLayoutCheck?.filteredCount === 1 &&
        hudLayoutCheck?.closedAfterEsc,
      'Compact switcher trigger + categorized dropdown popover fit cleanly, filter live, and close on Escape',
      JSON.stringify(hudLayoutCheck)
    );
    check(diagWebGPU?.backend === 'webgpu' && diagWebGPU?.allShadersCompiled === true, 'Live switch to WebGPU succeeded cleanly');
    check(
      skyFetchesAfterSwitch === skyFetchesBeforeSwitch && skyFetchesBeforeSwitch === 1,
      'Switching to WebGPU reused cached 4K sky blob (zero extra network requests)',
      `${skyFetchesBeforeSwitch} -> ${skyFetchesAfterSwitch}`
    );
    check(
      diagWebGPU?.adapterInfo?.isFallbackAdapter === false &&
        /nvidia|blackwell|rtx|geforce/i.test(String(diagWebGPU?.gpuRenderer || '')),
      'WebGPU running on hardware NVIDIA GPU',
      diagWebGPU?.gpuRenderer
    );
    check(liveFpsWebGPU >= 20, 'WebGPU runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGPU}`);

    for (const id of presetIds) {
      const glShot = webglShots[id];
      const gpuShot = webgpuShots[id];
      check(
        glShot.stats.meanLuma > 3.0 && glShot.stats.maxLuma > 90 && glShot.stats.stdLuma > 3.0,
        `WebGL2 preset '${id}' renders bright non-blank lensed scene`,
        `mean=${glShot.stats.meanLuma}, max=${glShot.stats.maxLuma}, std=${glShot.stats.stdLuma}`
      );
      check(
        gpuShot.stats.meanLuma > 3.0 && gpuShot.stats.maxLuma > 90 && gpuShot.stats.stdLuma > 3.0,
        `WebGPU preset '${id}' renders bright non-blank lensed scene`,
        `mean=${gpuShot.stats.meanLuma}, max=${gpuShot.stats.maxLuma}, std=${gpuShot.stats.stdLuma}`
      );
      check(parityDiffs[id] < 16.0, `WebGL2 <-> WebGPU parity holds for '${id}'`, `meanAbsDiff=${parityDiffs[id]}`);
    }

    const srcMovedDist = Math.hypot(...report.hotkeyT.sourceDelta);
    check(
      dragBeforeT.dragMode === 0 && dragAfterT.dragMode === 1 && dragAfterT2.dragMode === 0 && srcMovedDist > 0.25,
      'Hotkey T toggles Drag Source mode & pointer drag translates background source position cleanly',
      `srcMoved=${srcMovedDist.toFixed(3)}"`
    );
    check(overlayVisualDiff > 1.2, 'Caustics & Fermat contour overlays render clearly with visible image diff', `diff=${overlayVisualDiff}`);
    check(
      pausedAfterSpace && (diag128?.samples ?? 0) >= 128 && resumedAfterSpace,
      'Space pauses source drift & accumulates 128 progressive samples cleanly, then resumes',
      `samples=${diag128?.samples ?? 0}`
    );
    check(diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true, 'Live switch BACK WebGPU -> WebGL2 succeeded cleanly');
    check(pngBytesWebGL > 40000 && pngBytesWebGPU > 40000 && pngBytesWebGLAfterSwitch > 40000, 'capturePNG() produces valid PNG blobs');
    check(diagDirectWebGPU?.backend === 'webgpu' && diagRootRedirect?.backend === 'webgpu', '?backend=webgpu & root ?sim=lens-cluster redirect work cleanly');
    check(
      switcherCheck?.hasNav &&
        switcherCheck?.count === SIMULATORS.length &&
        switcherCheck?.currentId === 'sim-switch-lens-cluster' &&
        switcherCheck?.allPropagateWebgpu,
      `${SIMULATORS.length}-simulator navbar switcher marks lens-cluster current & propagates ?backend=webgpu`
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
