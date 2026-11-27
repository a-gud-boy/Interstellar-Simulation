#!/usr/bin/env node
/**
 * Supernova Remnant (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & E2E Capture Suite
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../../shared/testing/staticServer.mjs';
import { sleep, launchChromeDualCDP } from '../../../shared/testing/chromeCdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const VIEWPORT_W = 1440;
const VIEWPORT_H = 810;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8785 });
  const debugPort = 9550 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    profilePrefix: 'supernova-qa-',
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
      globalVar = '__SUPERNOVA__',
      expectedPath = '/sims/supernova/',
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
        const d = await evalJS(`window.__SUPERNOVA__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(120);
      }
      return await evalJS(`window.__SUPERNOVA__?.getDiagnostics?.()`);
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
          let tealPixels = 0, goldWarmPixels = 0;
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

              if (g > r + 10 && b > r + 10 && luma > 25) tealPixels++;
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
            meanLuma: +mean.toFixed(2),
            stdLuma: +Math.sqrt(variance).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            centerMeanLuma: +(centerSumLuma / Math.max(centerCount, 1)).toFixed(2),
            nonBlackPixels,
            tealPixels,
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

    const holdKey = async (key, code, keyCode, holdMs) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        text: key,
      });
      await sleep(holdMs);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    };

    const baseUrl = `http://127.0.0.1:${port}/sims/supernova/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(30);
    const liveFpsWebGL = await evalJS(`window.__SUPERNOVA__.getTelemetry().fps`);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__SUPERNOVA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png', {
      liveFpsWebGL,
      meanLuma: statsWebGLInit.meanLuma,
      tealPixels: statsWebGLInit.tealPixels,
      goldWarmPixels: statsWebGLInit.goldWarmPixels,
    });

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
    await evalJS(`window.__SUPERNOVA__.setState({
      paused: true,
      autoOrbit: false,
      camera: { distance: 8.8, pivot: [0.4, -0.2, 0.3], azimuthDeg: 52.0, elevationDeg: 22.0, rollDeg: -4.0, fovDeg: 50.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__SUPERNOVA__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 6000);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(120);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__SUPERNOVA__.getState().camera`);
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
    await evalJS(`window.__SUPERNOVA__.setState({ paused: false, autoOrbit: true })`);
    await sleep(1200);
    const liveFpsWebGPU = await evalJS(`window.__SUPERNOVA__.getTelemetry().fps`);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__SUPERNOVA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const capturePreset = async (presetId, filename, targetSamples = 20) => {
      await evalJS(`
        window.__SUPERNOVA__.selectPreset('${presetId}', true);
        window.__SUPERNOVA__.setState({ paused: true, autoOrbit: false });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 6000);
      await waitFrames(4);
      const tel = await evalJS(`window.__SUPERNOVA__.getTelemetry()`);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(
        `Captured ${filename} (samples=${d?.samples}, meanLuma=${stats.meanLuma}, std=${stats.stdLuma}, Rsh=${tel?.shockRadiusLy?.toFixed?.(2)}, tau=${tel?.opticalDepth?.toFixed?.(2)})`
      );
      return { file: shot.outPath, samples: d?.samples, tel, stats };
    };

    const shots = {};
    shots.crab = await capturePreset('crab', '04_crab_webgpu.png', 20);
    shots.veil = await capturePreset('veil', '05_veil_webgpu.png', 20);
    shots.hubble_sho = await capturePreset('hubble_sho', '06_hubble_sho_webgpu.png', 20);
    shots.bok_globules = await capturePreset('bok_globules', '07_bok_globules_webgpu.png', 20);
    shots.pulsar_cavity = await capturePreset('pulsar_cavity', '08_pulsar_cavity_webgpu.png', 20);
    shots.flythrough = await capturePreset('flythrough', '09_flythrough_webgpu.png', 20);

    // 3. Test Hubble SHO (0) vs True Color Broadband (1) palette toggle via Controls drawer
    console.log('3. Testing Hubble SHO (#ctrl-paletteMode-0) vs True Color (#ctrl-paletteMode-1) palette toggle...');
    await evalJS(`
      window.__SUPERNOVA__.selectPreset('crab', true);
      window.__SUPERNOVA__.setState({ paused: true, autoOrbit: false });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-paletteMode-0')?.click()`);
    await waitFrames(4);
    const shoUiCheck = await evalJS(`({
      paletteMode: window.__SUPERNOVA__.getState().paletteMode,
      shoChecked: document.getElementById('ctrl-paletteMode-0')?.getAttribute('aria-checked'),
      trueChecked: document.getElementById('ctrl-paletteMode-1')?.getAttribute('aria-checked'),
      drawerMeta: document.getElementById('drawer-physics-meta')?.textContent?.trim(),
    })`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);
    const shoDiag = await waitForSamples(20, 6000);
    await waitFrames(4);
    const s10 = await captureShot('10_palette_hubble_sho_webgpu.png');
    const statsPaletteSHO = await analyzePng(s10.base64);
    const paletteDiff = imageMeanAbsDiff(shots.crab.stats, statsPaletteSHO);
    console.log(
      `Captured 10_palette_hubble_sho_webgpu.png (samples=${shoDiag?.samples}, meanLuma=${statsPaletteSHO.meanLuma}, diffVsTrueColor=${paletteDiff})`
    );

    // Toggle back to True Color Broadband
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(250);
    await evalJS(`document.getElementById('ctrl-paletteMode-1')?.click()`);
    await waitFrames(4);
    const trueColorUiCheck = await evalJS(`({
      paletteMode: window.__SUPERNOVA__.getState().paletteMode,
      shoChecked: document.getElementById('ctrl-paletteMode-0')?.getAttribute('aria-checked'),
      trueChecked: document.getElementById('ctrl-paletteMode-1')?.getAttribute('aria-checked'),
      drawerMeta: document.getElementById('drawer-physics-meta')?.textContent?.trim(),
    })`);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(250);

    // 4. Test interior W/S fly-through (origin-safe r -> 0 crossing, non-black & NaN-free)
    console.log('4. Testing interior W/S fly-through through the remnant shell...');
    await evalJS(`
      document.activeElement?.blur?.();
      window.__SUPERNOVA__.selectPreset('flythrough', true);
      window.__SUPERNOVA__.setState({
        paused: false,
        autoOrbit: false,
        camera: { distance: 3.0, pivot: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, lookYawDeg: 0, lookPitchDeg: 0 }
      });
    `);
    await waitFrames(6);
    const camBeforeFly = await evalJS(`window.__SUPERNOVA__.getState().camera`);
    const shotFlyBefore = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const statsFlyBefore = await analyzePng(shotFlyBefore.data);

    await holdKey('w', 'KeyW', 87, 1600);
    await waitFrames(8);
    const camAfterW = await evalJS(`window.__SUPERNOVA__.getState().camera`);
    const telAfterW = await evalJS(`window.__SUPERNOVA__.getTelemetry()`);
    await evalJS(`window.__SUPERNOVA__.setState({ paused: true, autoOrbit: false })`);
    await waitForSamples(12, 4000);
    await waitFrames(4);
    const s11 = await captureShot('11_interior_flythrough_w_webgpu.png');
    const statsFlyW = await analyzePng(s11.base64);
    const flyDiffW = imageMeanAbsDiff(statsFlyBefore, statsFlyW);
    console.log(
      `Captured 11_interior_flythrough_w_webgpu.png (posZ: ${camBeforeFly.pos[2].toFixed(2)} -> ${camAfterW.pos[2].toFixed(2)}, meanLuma=${statsFlyW.meanLuma}, std=${statsFlyW.stdLuma}, diff=${flyDiffW})`
    );

    await evalJS(`window.__SUPERNOVA__.setState({ paused: false, autoOrbit: false })`);
    await waitFrames(4);
    await holdKey('s', 'KeyS', 83, 1000);
    await waitFrames(8);
    const camAfterS = await evalJS(`window.__SUPERNOVA__.getState().camera`);
    const telAfterS = await evalJS(`window.__SUPERNOVA__.getTelemetry()`);
    const shotFlyS = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const statsFlyS = await analyzePng(shotFlyS.data);

    // 5. Test live slider (#ctrl-shockAge), H HUD toggle, and live switch BACK WebGPU -> WebGL2
    console.log('5. Testing live slider, H HUD toggle, and live switch BACK WebGPU -> WebGL2...');
    const sliderTest = await evalJS(`(() => {
      const target = document.getElementById('ctrl-shockAge');
      if (!target) return { ok: false };
      const before = window.__SUPERNOVA__.getState().shockAge;
      const origVal = target.value;
      target.value = '12000';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const after = window.__SUPERNOVA__.getState().shockAge;
      target.value = origVal;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: Math.abs(after - 12000) < 50 && Math.abs(before - after) > 500, before, after };
    })()`);

    await evalJS(`document.activeElement?.blur?.()`);
    await pressKey('h', 'KeyH', 72);
    const hudHiddenAfterH = await evalJS(`!!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    const hudRestoredAfterH = await evalJS(`!document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await waitFrames(4);

    await evalJS(`
      window.__SUPERNOVA__.selectPreset('crab', true);
      window.__SUPERNOVA__.setState({ paused: true, autoOrbit: false });
      document.getElementById('controls-toggle')?.click();
    `);
    await sleep(300);
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 6000);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGLAfterSwitch = await evalJS(`(async () => {
      const b = await window.__SUPERNOVA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const s12 = await captureShot('12_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(s12.base64);

    // 6. Direct ?backend=webgpu + 5-Simulator Switcher E2E
    const directUrl = `http://127.0.0.1:${port}/sims/supernova/?backend=webgpu`;
    console.log(`6. Navigating directly to ${directUrl} + testing 5-sim switcher E2E...`);
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(12);

    const switcherCheck = await evalJS(`(() => {
      const nav = document.querySelector('nav[aria-label="Simulation switcher"]');
      const cur = nav?.querySelector('[aria-current="page"]');
      const bh = document.getElementById('sim-switch-blackhole');
      const wh = document.getElementById('sim-switch-wormhole');
      const bin = document.getElementById('sim-switch-binary');
      const warp = document.getElementById('sim-switch-warp');
      return {
        hasNav: Boolean(nav),
        noTabRole: nav?.getAttribute('role') !== 'tab' && bh?.getAttribute('role') !== 'tab',
        currentId: cur?.id,
        bhHref: bh?.getAttribute('href'),
        whHref: wh?.getAttribute('href'),
        binHref: bin?.getAttribute('href'),
        warpHref: warp?.getAttribute('href'),
      };
    })()`);

    await evalJS(`document.getElementById('sim-switch-blackhole')?.click()`);
    const diagBlackholeSwitch = await waitForReadyBackend('webgpu', '__GARGANTUA__', '/sims/blackhole/');
    await waitFrames(12);
    await captureShot('13_e2e_blackhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-supernova')?.click()`);
    const diagSupernovaFromBH = await waitForReadyBackend('webgpu', '__SUPERNOVA__', '/sims/supernova/');
    await waitFrames(10);

    await evalJS(`document.getElementById('sim-switch-wormhole')?.click()`);
    const diagWormholeSwitch = await waitForReadyBackend('webgpu', '__WORMHOLE__', '/sims/wormhole/');
    await waitFrames(12);
    await captureShot('14_e2e_wormhole_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-binary')?.click()`);
    const diagBinarySwitch = await waitForReadyBackend('webgpu', '__BINARY_BH__', '/sims/binary/');
    await waitFrames(12);
    await captureShot('15_e2e_binary_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-warp')?.click()`);
    const diagWarpSwitch = await waitForReadyBackend('webgpu', '__WARP_DRIVE__', '/sims/warp/');
    await waitFrames(12);
    await captureShot('16_e2e_warp_via_switcher.png');

    await evalJS(`document.getElementById('sim-switch-supernova')?.click()`);
    const diagSupernovaFromWarp = await waitForReadyBackend('webgpu', '__SUPERNOVA__', '/sims/supernova/');
    await waitFrames(10);

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
      paletteToggle: {
        shoUiCheck,
        trueColorUiCheck,
        statsPaletteSHO,
        paletteDiff,
      },
      flythroughTest: {
        camBeforeFly,
        camAfterW,
        camAfterS,
        telAfterW,
        telAfterS,
        statsFlyBefore,
        statsFlyW,
        statsFlyS,
        flyDiffW,
      },
      sliderTest,
      hudHiddenAfterH,
      hudRestoredAfterH,
      switcherCheck,
      e2eSwitchChain: {
        diagBlackholeSwitch,
        diagSupernovaFromBH,
        diagWormholeSwitch,
        diagBinarySwitch,
        diagWarpSwitch,
        diagSupernovaFromWarp,
      },
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED SUPERNOVA CHROME QA ASSERTIONS ===');
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
    check(diagWebGLInit?.volumeBaked === true, 'WebGL2 baked 128^3 3D volume turbulence');
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

    for (const [key, shot] of Object.entries(shots)) {
      check(
        shot.stats.meanLuma > 3.0 && shot.stats.maxLuma > 80 && shot.stats.stdLuma > 2.0,
        `Preset '${key}' renders bright non-blank WebGPU image`,
        `meanLuma=${shot.stats.meanLuma}, maxLuma=${shot.stats.maxLuma}, std=${shot.stats.stdLuma}`
      );
    }

    const rPulsar = shots.pulsar_cavity.tel?.shockRadiusLy ?? 0;
    const rCrab = shots.crab.tel?.shockRadiusLy ?? 0;
    const rVeil = shots.veil.tel?.shockRadiusLy ?? 0;
    const vPulsar = shots.pulsar_cavity.tel?.expansionVelocityKms ?? 0;
    const vCrab = shots.crab.tel?.expansionVelocityKms ?? 0;
    const vVeil = shots.veil.tel?.expansionVelocityKms ?? 0;
    const tauBok = shots.bok_globules.tel?.opticalDepth ?? 0;
    const tauVeil = shots.veil.tel?.opticalDepth ?? 0;
    check(
      rVeil > rCrab && rCrab > rPulsar && vPulsar > vCrab && vCrab > vVeil && tauBok > tauVeil,
      'Sedov-Taylor shock radius, expansion velocity & optical depth ordering hold across presets',
      `Rsh=[${rPulsar.toFixed(2)}, ${rCrab.toFixed(2)}, ${rVeil.toFixed(2)}] ly, tau=[Veil=${tauVeil.toFixed(2)}, Bok=${tauBok.toFixed(2)}]`
    );

    check(
      shoUiCheck?.paletteMode === 0 &&
        shoUiCheck?.shoChecked === 'true' &&
        /hubble\s*sho/i.test(shoUiCheck?.drawerMeta || '') &&
        trueColorUiCheck?.paletteMode === 1 &&
        trueColorUiCheck?.trueChecked === 'true' &&
        /true\s*color/i.test(trueColorUiCheck?.drawerMeta || '') &&
        statsPaletteSHO.meanLuma > 3.0 &&
        statsPaletteSHO.maxLuma > 80 &&
        paletteDiff > 2.5,
      'Palette toggle (Hubble SHO <-> True Color Broadband) updates UI, state & rendered image distinctly',
      `diff=${paletteDiff}, meanLuma=${statsPaletteSHO.meanLuma}, meta='${shoUiCheck?.drawerMeta}'`
    );

    const flyFinite =
      camAfterW?.pos?.every(Number.isFinite) &&
      camAfterS?.pos?.every(Number.isFinite) &&
      Number.isFinite(telAfterW?.shockRadiusLy) &&
      Number.isFinite(telAfterS?.opticalDepth);
    check(
      flyFinite &&
        camAfterW.pos[2] < camBeforeFly.pos[2] - 1.0 &&
        camAfterS.pos[2] > camAfterW.pos[2] + 0.5 &&
        statsFlyW.meanLuma > 3.0 &&
        statsFlyW.maxLuma > 60 &&
        statsFlyW.stdLuma > 2.0 &&
        statsFlyS.meanLuma > 3.0 &&
        statsFlyS.maxLuma > 60 &&
        flyDiffW > 1.5,
      'Interior W/S fly-through moves smoothly along ray through remnant with non-black, NaN-free frames',
      `posZ=[${camBeforeFly?.pos?.[2]?.toFixed?.(2)} -> W:${camAfterW?.pos?.[2]?.toFixed?.(2)} -> S:${camAfterS?.pos?.[2]?.toFixed?.(2)}], lumaW=${statsFlyW.meanLuma}, diffW=${flyDiffW}`
    );

    check(
      diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true,
      'Live switch BACK WebGPU -> WebGL2 succeeded cleanly'
    );
    check(
      statsWebGLAfterSwitch.meanLuma > 3.0 && statsWebGLAfterSwitch.maxLuma > 80,
      'WebGL2 after switch renders non-blank supernova image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}`
    );
    check(sliderTest?.ok === true, 'Live #ctrl-shockAge slider updates simulator state cleanly');
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
        switcherCheck?.currentId === 'sim-switch-supernova' &&
        switcherCheck?.bhHref?.includes('?backend=webgpu') &&
        switcherCheck?.whHref?.includes('?backend=webgpu') &&
        switcherCheck?.binHref?.includes('?backend=webgpu') &&
        switcherCheck?.warpHref?.includes('?backend=webgpu'),
      '5-simulator navbar switcher uses aria-current="page" and propagates ?backend=webgpu'
    );
    check(
      diagBlackholeSwitch?.backend === 'webgpu' &&
        diagSupernovaFromBH?.backend === 'webgpu' &&
        diagWormholeSwitch?.backend === 'webgpu' &&
        diagBinarySwitch?.backend === 'webgpu' &&
        diagWarpSwitch?.backend === 'webgpu' &&
        diagSupernovaFromWarp?.backend === 'webgpu',
      'E2E 5-simulator switcher preserves ?backend=webgpu across Supernova <-> Black Hole <-> Wormhole <-> Binary BH <-> Warp Drive'
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
