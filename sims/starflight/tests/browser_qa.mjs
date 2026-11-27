#!/usr/bin/env node
/**
 * Relativistic Starflight (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Capture Suite
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../../shared/testing/staticServer.mjs';
import { sleep, angleDiffDeg, launchChromeDualCDP } from '../../../shared/testing/chromeCdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const VIEWPORT_W = 1440;
const VIEWPORT_H = 810;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8787 });
  const debugPort = 9550 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    profilePrefix: 'starflight-qa-',
  });

  const consoleErrors = [];
  const externalPulsarErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const failedRequests = [];
  let inExternalPulsarHop = false;

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
      const frameUrl = p.stackTrace?.callFrames?.[0]?.url || '';
      const isPulsarExternal =
        frameUrl.includes('/sims/pulsar/') ||
        (inExternalPulsarHop && /\[Pulsar\]|pulsar\.wgsl|pulsar \(FRAG\)|shadeNeutronStarSurface/i.test(text)) ||
        /\[Pulsar\]|ShaderModuleDescriptor ""pulsar-wgsl""|shadeNeutronStarSurface/i.test(text);
      if (p.type === 'error') {
        if (isPulsarExternal) externalPulsarErrors.push(text);
        else consoleErrors.push(text);
      } else if (p.type === 'warning') {
        consoleWarnings.push(text);
      }
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
      globalVar = '__STARFLIGHT__',
      expectedPath = '/sims/starflight/',
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
        const d = await evalJS(`window.__STARFLIGHT__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(100);
      }
      return await evalJS(`window.__STARFLIGHT__?.getDiagnostics?.()`);
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
          let sumR = 0, sumG = 0, sumB = 0;
          let sceneSumR = 0, sceneSumG = 0, sceneSumB = 0, sceneCount = 0;
          let nonBlackPixels = 0, centerSumLuma = 0, centerCount = 0;
          let cyanBluePixels = 0, warmRedPixels = 0;
          let sceneCyanBluePixels = 0, sceneWarmRedPixels = 0;
          const thumb = [];

          for (let y = 0; y < height; y++) {
            const inSceneBand = y >= 150 && y <= height - 130;
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              sumLuma2 += luma * luma;
              sumR += r;
              sumG += g;
              sumB += b;
              if (luma > maxLuma) maxLuma = luma;
              if (luma > 10) nonBlackPixels++;

              if (b > r + 15 && luma > 25) cyanBluePixels++;
              if (r > b + 20 && luma > 25) warmRedPixels++;

              if (inSceneBand) {
                sceneCount++;
                sceneSumR += r;
                sceneSumG += g;
                sceneSumB += b;
                if (b > r + 12 && luma > 16) sceneCyanBluePixels++;
                if (r > b + 12 && luma > 12) sceneWarmRedPixels++;
              }

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
          const meanR = sumR / total;
          const meanG = sumG / total;
          const meanB = sumB / total;

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
            meanR: +meanR.toFixed(2),
            meanG: +meanG.toFixed(2),
            meanB: +meanB.toFixed(2),
            redOverBlue: +(sumR / Math.max(sumB, 1)).toFixed(3),
            sceneRedOverBlue: +(sceneSumR / Math.max(sceneSumB, 1)).toFixed(3),
            sceneMeanR: +(sceneSumR / Math.max(sceneCount, 1)).toFixed(2),
            sceneMeanB: +(sceneSumB / Math.max(sceneCount, 1)).toFixed(2),
            nonBlackPixels,
            cyanBluePixels,
            warmRedPixels,
            sceneCyanBluePixels,
            sceneWarmRedPixels,
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

    const baseUrl = `http://127.0.0.1:${port}/sims/starflight/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(30);
    const liveFpsWebGL = await evalJS(`window.__STARFLIGHT__.getTelemetry().fps`);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__STARFLIGHT__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    // Check HUD top-right 7-sim switcher layout at 1440px (zero overlap, single row)
    const hudLayoutCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const items = Array.from(nav?.querySelectorAll('a') || []);
      const ctrlBtn = document.getElementById('controls-toggle');
      const hideBtn = document.getElementById('btn-hide-ui');
      const header = document.querySelector('.hud-top-left');
      const navRect = nav?.getBoundingClientRect();
      const hdrRect = header?.getBoundingClientRect();
      const ctrlRect = ctrlBtn?.getBoundingClientRect();
      const hideRect = hideBtn?.getBoundingClientRect();
      const itemRects = items.map(a => {
        const r = a.getBoundingClientRect();
        return { id: a.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      let overlap = false;
      for (let i = 0; i < itemRects.length; i++) {
        for (let j = i + 1; j < itemRects.length; j++) {
          const a = itemRects[i], b = itemRects[j];
          const horiz = a.left < b.right - 1 && b.left < a.right - 1;
          const vert = a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (horiz && vert) overlap = true;
        }
      }
      const singleRow = itemRects.length > 0 && itemRects.every(r => Math.abs(r.top - itemRects[0].top) < 8);
      const rectsOverlap = (a, b, pad = 2) => Boolean(a && b && a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad);
      const hdrNavOverlap = rectsOverlap(hdrRect, navRect, 4);
      const ctrlOverlap = rectsOverlap(navRect, ctrlRect, 1) || rectsOverlap(navRect, hideRect, 1) || rectsOverlap(hdrRect, ctrlRect, 2);
      return {
        pillCount: items.length,
        overlap,
        singleRow,
        hdrNavOverlap,
        navHeight: Math.round(navRect?.height ?? 0),
        ctrlOverlap,
      };
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png', {
      liveFpsWebGL,
      meanLuma: statsWebGLInit.meanLuma,
      cyanBluePixels: statsWebGLInit.cyanBluePixels,
      warmRedPixels: statsWebGLInit.warmRedPixels,
      hudLayoutCheck,
    });

    // Capture all 6 presets in WebGL2
    const presetIds = ['sub_rel', 'headlight_90', 'uv_milkyway', 'cmb_glow', 'aft_redshift', 'brachistochrone'];
    const capturePreset = async (presetId, filename, targetSamples = 16) => {
      await evalJS(`
        (window.__STARFLIGHT__.selectPreset ? window.__STARFLIGHT__.selectPreset('${presetId}', true) : window.__STARFLIGHT__.applyPreset('${presetId}', true));
        window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 7000);
      await waitFrames(4);
      const tel = await evalJS(`window.__STARFLIGHT__.getTelemetry()`);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(
        `Captured ${filename} (backend=${d?.backend}, samples=${d?.samples}, meanLuma=${stats.meanLuma}, std=${stats.stdLuma}, beta=${tel?.beta?.toFixed?.(5)}, gamma=${tel?.gamma?.toFixed?.(2)}, T_cmb=${tel?.cmbPeakTempK?.toFixed?.(1)}K)`
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
    await evalJS(`window.__STARFLIGHT__.setState({
      paused: true,
      autoOrbit: false,
      camera: { lookYawDeg: 42.0, lookPitchDeg: -14.0, rollDeg: 8.0, fovDeg: 44.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__STARFLIGHT__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 6000);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(120);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__STARFLIGHT__.getState().camera`);
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
    await evalJS(`window.__STARFLIGHT__.setState({ paused: false, autoOrbit: false })`);
    await sleep(1200);
    const liveFpsWebGPU = await evalJS(`window.__STARFLIGHT__.getTelemetry().fps`);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__STARFLIGHT__.capturePNG();
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

    // 3. Test Aberration Toggle: Exact SR (1) vs Rest Frame (0) on 0.90c Headlight Cone
    console.log('3. Testing Exact SR (#ctrl-aberrationMode-1) vs Rest Frame (#ctrl-aberrationMode-0)...');
    await evalJS(`
      (window.__STARFLIGHT__.selectPreset ? window.__STARFLIGHT__.selectPreset('headlight_90', true) : window.__STARFLIGHT__.applyPreset('headlight_90', true));
      window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    const exactSrCheck = await evalJS(`({
      aberrationMode: window.__STARFLIGHT__.getState().aberrationMode,
      effectiveRapidity: window.__STARFLIGHT__.getTelemetry().effectiveRapidity,
      srChecked: document.getElementById('ctrl-aberrationMode-1')?.getAttribute('aria-checked'),
    })`);

    await evalJS(`document.getElementById('ctrl-aberrationMode-0')?.click()`);
    await waitFrames(4);
    const restFrameCheck = await evalJS(`({
      aberrationMode: window.__STARFLIGHT__.getState().aberrationMode,
      effectiveRapidity: window.__STARFLIGHT__.getTelemetry().effectiveRapidity,
      restChecked: document.getElementById('ctrl-aberrationMode-0')?.getAttribute('aria-checked'),
      srChecked: document.getElementById('ctrl-aberrationMode-1')?.getAttribute('aria-checked'),
    })`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);
    const restDiag = await waitForSamples(20, 6000);
    await waitFrames(4);
    const sAberrationOff = await captureShot('04_aberration_off_webgpu.png');
    const statsAberrationOff = await analyzePng(sAberrationOff.base64);
    const aberrationDiff = imageMeanAbsDiff(webgpuShots.headlight_90.stats, statsAberrationOff);
    console.log(
      `Captured 04_aberration_off_webgpu.png (samples=${restDiag?.samples}, effEta: ${exactSrCheck.effectiveRapidity?.toFixed?.(3)} -> ${restFrameCheck.effectiveRapidity?.toFixed?.(3)}, diff=${aberrationDiff})`
    );

    // Restore Exact SR
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(200);
    await evalJS(`document.getElementById('ctrl-aberrationMode-1')?.click()`);
    await waitFrames(4);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(200);

    // 4. Test 'T' hotkey toggling Forward <-> Aft (lookYawDeg changes by ~180 deg + color shift)
    console.log('4. Testing T hotkey (KeyT) Forward <-> Aft flip...');
    await evalJS(`
      document.activeElement?.blur?.();
      (window.__STARFLIGHT__.selectPreset ? window.__STARFLIGHT__.selectPreset('uv_milkyway', true) : window.__STARFLIGHT__.applyPreset('uv_milkyway', true));
      window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
    `);
    await waitForSamples(16, 6000);
    await waitFrames(4);
    const beforeT = await evalJS(`({
      lookYawDeg: window.__STARFLIGHT__.getState().camera?.lookYawDeg ?? 0,
      tel: window.__STARFLIGHT__.getTelemetry(),
    })`);
    const shotBeforeT = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const statsBeforeT = await analyzePng(shotBeforeT.data);

    const waitYawSettled = async (targetYaw, timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const y = await evalJS(`window.__STARFLIGHT__.getState().camera?.lookYawDeg ?? 0`);
        if (angleDiffDeg(y, targetYaw) < 2.0) break;
        await sleep(80);
      }
      await waitFrames(6);
    };

    await pressKey('t', 'KeyT', 84);
    await waitYawSettled((beforeT.lookYawDeg + 180) % 360);
    await waitForSamples(16, 6000);
    await waitFrames(4);
    const afterT1 = await evalJS(`({
      lookYawDeg: window.__STARFLIGHT__.getState().camera?.lookYawDeg ?? 0,
    })`);
    const shotAfterT1 = await captureShot('06_aft_flip_webgpu.png');
    const statsAfterT1 = await analyzePng(shotAfterT1.base64);
    const visualDiffFwdVsAft = imageMeanAbsDiff(statsBeforeT, statsAfterT1);

    await pressKey('t', 'KeyT', 84);
    await waitYawSettled(beforeT.lookYawDeg);
    const afterT2 = await evalJS(`({
      lookYawDeg: window.__STARFLIGHT__.getState().camera?.lookYawDeg ?? 0,
    })`);
    console.log(
      `Hotkey T flip: yaw ${beforeT.lookYawDeg.toFixed(1)} -> ${afterT1.lookYawDeg.toFixed(1)} -> ${afterT2.lookYawDeg.toFixed(1)}, diff=${visualDiffFwdVsAft}, cyan=[${statsBeforeT.cyanBluePixels}->${statsAfterT1.cyanBluePixels}], warm=[${statsBeforeT.warmRedPixels}->${statsAfterT1.warmRedPixels}], red/blue=[${statsBeforeT.redOverBlue}->${statsAfterT1.redOverBlue}]`
    );

    // 5. Test Space 128-sample progressive accumulation & resume
    console.log('5. Testing Space 128-sample progressive accumulation...');
    await evalJS(`
      document.activeElement?.blur?.();
      (window.__STARFLIGHT__.selectPreset ? window.__STARFLIGHT__.selectPreset('headlight_90', true) : window.__STARFLIGHT__.applyPreset('headlight_90', true));
      window.__STARFLIGHT__.setState({ paused: false, autoOrbit: false });
    `);
    await waitFrames(10);
    await pressKey(' ', 'Space', 32);
    const pausedAfterSpace = await evalJS(`window.__STARFLIGHT__.getState().paused`);
    const diag128 = await waitForSamples(128, 15000);
    const samplesReached = diag128?.samples ?? 0;
    const s128 = await captureShot('05_headlight_128x_webgpu.png');
    const stats128 = await analyzePng(s128.base64);
    await pressKey(' ', 'Space', 32);
    const resumedAfterSpace = await evalJS(`!window.__STARFLIGHT__.getState().paused`);
    console.log(`Space 128x check: paused=${pausedAfterSpace}, samplesReached=${samplesReached}, resumed=${resumedAfterSpace}`);

    // 6. Live slider (#ctrl-rapidity), H HUD toggle, and live switch BACK WebGPU -> WebGL2
    console.log('6. Testing live slider (#ctrl-rapidity), H HUD toggle, and live switch BACK WebGPU -> WebGL2...');
    const sliderTest = await evalJS(`(() => {
      const target = document.getElementById('ctrl-rapidity');
      if (!target) return { ok: false };
      const before = window.__STARFLIGHT__.getState().rapidity;
      const origVal = target.value;
      target.value = '3.20';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = window.__STARFLIGHT__.getState().rapidity;
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: Math.abs(after - 3.20) < 0.02 && Math.abs(before - after) > 0.5, before, after };
    })()`);

    await evalJS(`document.activeElement?.blur?.()`);
    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    const hudRestoredAfterH = await evalJS(`!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await waitFrames(4);

    await evalJS(`
      (window.__STARFLIGHT__.selectPreset ? window.__STARFLIGHT__.selectPreset('headlight_90', true) : window.__STARFLIGHT__.applyPreset('headlight_90', true));
      window.__STARFLIGHT__.setState({ paused: true, autoOrbit: false, flightPosZ: 0.0 });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 6000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__STARFLIGHT__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const sWebGLBack = await captureShot('07_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(sWebGLBack.base64);

    // 7. Direct ?backend=webgpu + 7-Simulator Switcher E2E Loop
    const directUrl = `http://127.0.0.1:${port}/sims/starflight/?backend=webgpu`;
    console.log(`7. Navigating directly to ${directUrl} + testing 7-sim switcher E2E...`);
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
        bhHref: findHref('sims/blackhole'),
        whHref: findHref('sims/wormhole'),
        binHref: findHref('sims/binary'),
        warpHref: findHref('sims/warp'),
        snHref: findHref('sims/supernova'),
        pulHref: findHref('sims/pulsar'),
      };
    })()`);

    const clickSimLink = async (substr) => {
      await evalJS(`document.querySelector('nav[aria-label="Simulation switcher"] a[data-sim-href*="${substr}"]')?.click()`);
    };

    await clickSimLink('sims/blackhole');
    const diagBlackholeSwitch = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/sims/blackhole/');
    await waitFrames(10);

    await clickSimLink('sims/wormhole');
    const diagWormholeSwitch = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/sims/wormhole/');
    await waitFrames(10);

    await clickSimLink('sims/binary');
    const diagBinarySwitch = await waitForReadyBackend('webgpu', '__BINARY_BH__', '/sims/binary/');
    await waitFrames(10);

    await clickSimLink('sims/warp');
    const diagWarpSwitch = await waitForReadyBackend('webgpu', '__WARP_DRIVE__', '/sims/warp/');
    await waitFrames(10);

    await clickSimLink('sims/supernova');
    const diagSupernovaSwitch = await waitForReadyBackend('webgpu', '__SUPERNOVA__', '/sims/supernova/');
    await waitFrames(10);

    inExternalPulsarHop = true;
    await clickSimLink('sims/pulsar');
    let pulsarHopCheck = { pathname: '', search: '', starflightHref: null };
    {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        pulsarHopCheck = await evalJS(`(() => ({
          pathname: window.location.pathname,
          search: window.location.search,
          starflightHref: document.querySelector('nav[aria-label="Simulation switcher"] a[data-sim-href*="starflight-sim"]')?.getAttribute('href') || null,
        }))()`);
        if (
          pulsarHopCheck.pathname.includes('/sims/pulsar/') &&
          pulsarHopCheck.starflightHref?.includes('?backend=webgpu')
        ) {
          break;
        }
        await sleep(120);
      }
      await sleep(600);
      pulsarHopCheck = await evalJS(`(() => ({
        pathname: window.location.pathname,
        search: window.location.search,
        starflightHref: document.querySelector('nav[aria-label="Simulation switcher"] a[data-sim-href*="starflight-sim"]')?.getAttribute('href') || null,
      }))()`);
    }

    inExternalPulsarHop = false;
    await clickSimLink('sims/starflight');
    const diagStarflightFromPulsar = await waitForReadyBackend('webgpu', '__STARFLIGHT__', '/sims/starflight/');
    await waitFrames(10);
    await captureShot('08_e2e_starflight_after_7sim_loop.png');

    // Root index.html ?sim=starflight&backend=webgpu redirect
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?sim=starflight&backend=webgpu` });
    const diagRootRedirect = await waitForReadyBackend('webgpu', '__STARFLIGHT__', '/sims/starflight/');

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
      aberrationToggle: {
        exactSrCheck,
        restFrameCheck,
        statsAberrationOff,
        aberrationDiff,
      },
      hotkeyT: {
        beforeT: { lookYawDeg: beforeT.lookYawDeg },
        afterT1,
        afterT2,
        statsBeforeT,
        statsAfterT1,
        visualDiffFwdVsAft,
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
        pulsarHopCheck,
        diagStarflightFromPulsar,
      },
      errors: { consoleErrors, externalPulsarErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED STARFLIGHT CHROME QA ASSERTIONS ===');
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
      hudLayoutCheck?.pillCount === 7 &&
        !hudLayoutCheck?.overlap &&
        hudLayoutCheck?.singleRow &&
        !hudLayoutCheck?.hdrNavOverlap &&
        !hudLayoutCheck?.ctrlOverlap,
      '7-sim switcher HUD layout fits cleanly on a single row without overlapping pills or controls',
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
      skyFetchesAfterSwitch === skyFetchesBeforeSwitch && skyFetchesBeforeSwitch === 1,
      'Switching to WebGPU reused cached 4K sky blob (zero extra network requests)',
      `skyFetches: ${skyFetchesBeforeSwitch} -> ${skyFetchesAfterSwitch}`
    );
    check(
      diagWebGPU?.adapterInfo?.isFallbackAdapter === false &&
        /nvidia|blackwell|rtx|geforce/i.test(String(diagWebGPU?.gpuRenderer || '')),
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
      angleDiffDeg(camAfterSwitch.lookYawDeg, camBeforeSwitch.lookYawDeg) < 0.5 &&
      Math.abs(camAfterSwitch.lookPitchDeg - camBeforeSwitch.lookPitchDeg) < 0.5 &&
      Math.abs(camAfterSwitch.rollDeg - camBeforeSwitch.rollDeg) < 0.5 &&
      Math.abs((camAfterSwitch.fovDeg ?? 56) - (camBeforeSwitch.fovDeg ?? 56)) < 0.5;
    check(
      camPreserved,
      'Camera pose (lookYawDeg, lookPitchDeg, rollDeg, fovDeg) preserved across WebGL2 -> WebGPU switch',
      `before=${JSON.stringify(camBeforeSwitch)}, after=${JSON.stringify(camAfterSwitch)}`
    );
    check(liveFpsWebGPU >= 20, 'WebGPU runs smoothly (>= 20 FPS)', `fps=${liveFpsWebGPU}`);

    for (const id of presetIds) {
      const glShot = webglShots[id];
      const gpuShot = webgpuShots[id];
      check(
        glShot.stats.meanLuma > 2.5 && glShot.stats.maxLuma > 75 && glShot.stats.stdLuma > 2.0,
        `WebGL2 preset '${id}' renders bright non-blank image`,
        `meanLuma=${glShot.stats.meanLuma}, maxLuma=${glShot.stats.maxLuma}, std=${glShot.stats.stdLuma}`
      );
      check(
        gpuShot.stats.meanLuma > 2.5 && gpuShot.stats.maxLuma > 75 && gpuShot.stats.stdLuma > 2.0,
        `WebGPU preset '${id}' renders bright non-blank image`,
        `meanLuma=${gpuShot.stats.meanLuma}, maxLuma=${gpuShot.stats.maxLuma}, std=${gpuShot.stats.stdLuma}`
      );
      check(
        parityDiffs[id] < 18.0,
        `WebGL2 <-> WebGPU parity holds for preset '${id}'`,
        `meanAbsDiff=${parityDiffs[id]}`
      );
    }

    // Relativistic physics ordering checks across presets
    const gSub = webgpuShots.sub_rel.tel?.gamma ?? 0;
    const gHead = webgpuShots.headlight_90.tel?.gamma ?? 0;
    const gUv = webgpuShots.uv_milkyway.tel?.gamma ?? 0;
    const gCmb = webgpuShots.cmb_glow.tel?.gamma ?? 0;
    const tCmbGlow = webgpuShots.cmb_glow.tel?.cmbPeakTempK ?? 0;
    const dAft = webgpuShots.aft_redshift.tel?.dopplerAft ?? 1;
    check(
      gSub > 1.1 && gHead > gSub && gUv > gHead && gCmb > gUv && tCmbGlow > 350 && dAft < 0.25,
      'Relativistic gamma, CMB forward temperature, and aft Doppler redshift scale monotonically across presets',
      `gamma=[${gSub.toFixed(2)}, ${gHead.toFixed(2)}, ${gUv.toFixed(2)}, ${gCmb.toFixed(2)}], T_cmb=${tCmbGlow.toFixed(1)}K, D_aft=${dAft.toFixed(3)}`
    );

    check(
      exactSrCheck?.aberrationMode === 1 &&
        exactSrCheck?.effectiveRapidity > 1.4 &&
        restFrameCheck?.aberrationMode === 0 &&
        restFrameCheck?.effectiveRapidity === 0 &&
        statsAberrationOff.meanLuma > 2.5 &&
        aberrationDiff > 4.0,
      'Aberration toggle (Exact SR <-> Rest Frame) updates effectiveRapidity to 0 and produces large visual diff',
      `effEta: ${exactSrCheck?.effectiveRapidity?.toFixed?.(3)} -> ${restFrameCheck?.effectiveRapidity}, diff=${aberrationDiff}`
    );

    const yawDelta1 = angleDiffDeg(afterT1.lookYawDeg, beforeT.lookYawDeg);
    const yawDelta2 = angleDiffDeg(afterT2.lookYawDeg, beforeT.lookYawDeg);
    const colorShiftedToWarm =
      statsAfterT1.sceneRedOverBlue > statsBeforeT.sceneRedOverBlue * 1.15 ||
      statsAfterT1.sceneWarmRedPixels > statsBeforeT.sceneWarmRedPixels;
    check(
      Math.abs(yawDelta1 - 180) < 3.0 &&
        yawDelta2 < 3.0 &&
        visualDiffFwdVsAft > 4.0 &&
        colorShiftedToWarm,
      'Hotkey T flips Forward <-> Aft (~180 deg) with blue/cyan forward -> warm/red aft color shift',
      `delta1=${yawDelta1.toFixed(1)}deg, delta2=${yawDelta2.toFixed(1)}deg, diff=${visualDiffFwdVsAft}, sceneRed/Blue: ${statsBeforeT.sceneRedOverBlue}->${statsAfterT1.sceneRedOverBlue}`
    );

    check(
      pausedAfterSpace && samplesReached >= 128 && resumedAfterSpace && stats128.meanLuma > 2.5,
      'Space pauses flight & accumulates 128 progressive samples cleanly, then resumes',
      `samples=${samplesReached}`
    );

    check(
      diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true,
      'Live switch BACK WebGPU -> WebGL2 succeeded cleanly'
    );
    check(
      statsWebGLAfterSwitch.meanLuma > 2.5 && statsWebGLAfterSwitch.maxLuma > 75,
      'WebGL2 after switch renders non-blank starflight image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}`
    );
    check(sliderTest?.ok === true, 'Live #ctrl-rapidity slider updates simulator state cleanly', JSON.stringify(sliderTest));
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
      'Root /?sim=starflight&backend=webgpu routes cleanly into starflight-sim'
    );
    check(
      switcherCheck?.hasNav &&
        switcherCheck?.count === 7 &&
        switcherCheck?.noTabRole &&
        switcherCheck?.currentId === 'sim-switch-starflight' &&
        switcherCheck?.bhHref?.includes('?backend=webgpu') &&
        switcherCheck?.whHref?.includes('?backend=webgpu') &&
        switcherCheck?.binHref?.includes('?backend=webgpu') &&
        switcherCheck?.warpHref?.includes('?backend=webgpu') &&
        switcherCheck?.snHref?.includes('?backend=webgpu') &&
        switcherCheck?.pulHref?.includes('?backend=webgpu'),
      '7-simulator navbar switcher uses aria-current="page" and propagates ?backend=webgpu'
    );
    check(
      diagBlackholeSwitch?.backend === 'webgpu' &&
        diagWormholeSwitch?.backend === 'webgpu' &&
        diagBinarySwitch?.backend === 'webgpu' &&
        diagWarpSwitch?.backend === 'webgpu' &&
        diagSupernovaSwitch?.backend === 'webgpu' &&
        pulsarHopCheck?.pathname?.includes('/sims/pulsar/') &&
        pulsarHopCheck?.search?.includes('backend=webgpu') &&
        pulsarHopCheck?.starflightHref?.includes('?backend=webgpu') &&
        diagStarflightFromPulsar?.backend === 'webgpu' &&
        diagStarflightFromPulsar?.allShadersCompiled === true,
      'E2E 7-simulator switcher preserves ?backend=webgpu across Starflight -> Black Hole -> Wormhole -> Binary BH -> Warp Drive -> Supernova -> Pulsar -> Starflight'
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
