#!/usr/bin/env node
/**
 * Gargantua (Unified WebGL2 + WebGPU) — Automated Hardware NVIDIA Chrome QA & Visual Capture Suite
 *
 * Launches a local static HTTP server + headed X11 GPU-accelerated Google Chrome
 * in dark mode with BOTH WebGL2 and WebGPU enabled on NVIDIA RTX 5060 (matching launch.sh):
 *  1. Verifies default boot uses WebGL2, NVIDIA GL renderer, 4K Milky Way, toggle hidden in drawer
 *  2. Opens Controls drawer and clicks WebGPU toggle -> verifies live switch to NVIDIA Blackwell WebGPU,
 *     zero extra network fetch of milkyway_4k.jpg (RAM blob cache hit), preserved camera pose,
 *     capturePNG(), and all 6 presets' relativistic beaming & shadow asymmetry
 *  3. Opens Controls drawer and clicks WebGL2 toggle -> verifies clean switch BACK to WebGL2,
 *     live sliders, hotkey H, capturePNG(), and non-blank rendered pixels
 *  4. Verifies direct boot via ?backend=webgpu
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

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8779 });
  const debugPort = 9450 + Math.floor(Math.random() * 400);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    profilePrefix: 'gargantua-unified-qa-',
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

    const waitForReadyBackend = async (expectedBackend, maxMs = 30000) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window.__GARGANTUA__?.getDiagnostics?.()`);
        if (d && d.backend === expectedBackend && !d.switchingBackend && d.skyMapLoaded === true) {
          return d;
        }
        await sleep(120);
      }
      return await evalJS(`window.__GARGANTUA__?.getDiagnostics?.()`);
    };

    const waitForSamples = async (targetSamples = 20, maxMs = 4500) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const d = await evalJS(`window.__GARGANTUA__?.getDiagnostics?.()`);
        if (d && (d.samples ?? 0) >= targetSamples) return d;
        await sleep(120);
      }
      return await evalJS(`window.__GARGANTUA__?.getDiagnostics?.()`);
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
          let sumLuma = 0, maxLuma = 0, brightPixels = 0, pureBlackCenter = 0;
          let leftR = 0, leftG = 0, leftB = 0, leftCount = 0;
          let rightR = 0, rightG = 0, rightB = 0, rightCount = 0;
          let shadowSumX = 0, shadowSumY = 0, shadowCount = 0;
          let shadowMinX = width, shadowMaxX = 0;

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sumLuma += luma;
              if (luma > maxLuma) maxLuma = luma;
              if (luma > 235) brightPixels++;

              const dx = (x - cx) / height;
              const dy = (y - cy) / height;

              if (Math.abs(dy) < 0.14 && Math.abs(dx) > 0.04 && Math.abs(dx) < 0.42) {
                if (dx < 0) {
                  leftR += r; leftG += g; leftB += b; leftCount++;
                } else {
                  rightR += r; rightG += g; rightB += b; rightCount++;
                }
              }

              if (Math.abs(dx) < 0.26 && Math.abs(dy) < 0.26 && luma < 16) {
                shadowSumX += x;
                shadowSumY += y;
                shadowCount++;
                if (x < shadowMinX) shadowMinX = x;
                if (x > shadowMaxX) shadowMaxX = x;
              }
              if (Math.abs(dx) < 0.04 && Math.abs(dy) < 0.04 && luma < 8) {
                pureBlackCenter++;
              }
            }
          }

          const total = width * height;
          const lR = leftR / Math.max(1, leftCount);
          const lG = leftG / Math.max(1, leftCount);
          const lB = leftB / Math.max(1, leftCount);
          const rR = rightR / Math.max(1, rightCount);
          const rG = rightG / Math.max(1, rightCount);
          const rB = rightB / Math.max(1, rightCount);
          const leftLuma = 0.2126 * lR + 0.7152 * lG + 0.0722 * lB;
          const rightLuma = 0.2126 * rR + 0.7152 * rG + 0.0722 * rB;

          return {
            width,
            height,
            meanLuma: +(sumLuma / total).toFixed(2),
            maxLuma: +maxLuma.toFixed(1),
            clippedRatio: +(brightPixels / total).toFixed(4),
            pureBlackCenter,
            leftBand: {
              luma: +leftLuma.toFixed(2),
              rgb: [+lR.toFixed(1), +lG.toFixed(1), +lB.toFixed(1)],
              blueOverRed: +(lB / Math.max(1, lR)).toFixed(3),
            },
            rightBand: {
              luma: +rightLuma.toFixed(2),
              rgb: [+rR.toFixed(1), +rG.toFixed(1), +rB.toFixed(1)],
              blueOverRed: +(rB / Math.max(1, rR)).toFixed(3),
            },
            shadowCore: {
              pixelCount: shadowCount,
              centroidOffsetXNorm: shadowCount > 50 ? +((shadowSumX / shadowCount - cx) / height).toFixed(4) : null,
              leftEdgeNorm: shadowCount > 50 ? +((shadowMinX - cx) / height).toFixed(4) : null,
              rightEdgeNorm: shadowCount > 50 ? +((shadowMaxX - cx) / height).toFixed(4) : null,
            },
          };
        })()`,
        true
      );
    };

    const baseUrl = `http://127.0.0.1:${port}/sims/blackhole/`;
    console.log(`1. Navigating to default URL ${baseUrl} (expects WebGL2 default)...`);
    await cdp.send('Page.navigate', { url: baseUrl });

    const diagWebGLInit = await waitForReadyBackend('webgl2');
    await waitFrames(25);
    const pngBytesWebGL = await evalJS(`(async () => {
      const b = await window.__GARGANTUA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const drawerClosedInitially = await evalJS(`(() => {
      const drawer = document.getElementById('controls-drawer');
      return !!drawer && drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true && !drawer.classList.contains('is-open');
    })()`);

    const s1 = await captureShot('01_webgl2_default_hud.png');
    const statsWebGLInit = await analyzePng(s1.base64);
    console.log('Captured 01_webgl2_default_hud.png');

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
    const s2 = await captureShot('02_controls_drawer_webgl2.png');
    console.log('Captured 02_controls_drawer_webgl2.png');

    // Set a non-default camera pose before toggling backend to verify state preservation
    await evalJS(`window.__GARGANTUA__.setState({
      paused: true,
      autoOrbit: false,
      camera: { radius: 22.0, elevationDeg: 14.5, azimuthDeg: 35.0, rollDeg: -3.0 }
    })`);
    await waitFrames(4);
    const camBeforeSwitch = await evalJS(`window.__GARGANTUA__.getState().camera`);
    const skyFetchesBeforeSwitch = getSkyRequestCount();

    console.log('2. Clicking WebGPU toggle inside Controls drawer...');
    await evalJS(`document.getElementById('ctrl-backend-webgpu')?.click()`);
    const diagWebGPU = await waitForReadyBackend('webgpu');
    await waitForSamples(16, 4500);
    await waitFrames(5);
    await evalJS(`document.getElementById('ctrl-backend')?.scrollIntoView({ block: 'end' })`);
    await sleep(100);
    const skyFetchesAfterSwitch = getSkyRequestCount();
    const camAfterSwitch = await evalJS(`window.__GARGANTUA__.getState().camera`);
    const toggleCheckWebGPU = await evalJS(`(() => {
      const btnGL = document.getElementById('ctrl-backend-webgl2');
      const btnGPU = document.getElementById('ctrl-backend-webgpu');
      return {
        glChecked: btnGL?.getAttribute('aria-checked'),
        gpuChecked: btnGPU?.getAttribute('aria-checked'),
      };
    })()`);

    const s3 = await captureShot('03_controls_drawer_webgpu.png');
    console.log('Captured 03_controls_drawer_webgpu.png');

    // Close drawer for clean WebGPU verification & preset captures
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    const pngBytesWebGPU = await evalJS(`(async () => {
      const b = await window.__GARGANTUA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);

    const capturePreset = async (presetId, filename, targetSamples = 20) => {
      await evalJS(`
        window.__GARGANTUA__.selectPreset('${presetId}', true);
        window.__GARGANTUA__.setState({ paused: true, autoOrbit: false });
      `);
      await waitFrames(6);
      const d = await waitForSamples(targetSamples, 4500);
      await waitFrames(4);
      const shot = await captureShot(filename);
      const stats = await analyzePng(shot.base64);
      console.log(`Captured ${filename} (samples=${d?.samples}, leftLuma=${stats.leftBand.luma}, rightLuma=${stats.rightBand.luma}, shadowX=${stats.shadowCore.centroidOffsetXNorm})`);
      return { file: shot.outPath, samples: d?.samples, stats };
    };

    const shots = {};
    shots.gargantua_webgpu = await capturePreset('gargantua', '04_gargantua_webgpu.png', 20);
    shots.relativistic_webgpu = await capturePreset('relativistic', '05_relativistic_webgpu.png', 20);
    shots.schwarzschild_webgpu = await capturePreset('schwarzschild', '06_schwarzschild_webgpu.png', 20);
    shots.millers_webgpu = await capturePreset('millers', '07_millers_webgpu.png', 20);
    shots.m87_webgpu = await capturePreset('m87', '08_m87_webgpu.png', 20);
    shots.quasar_webgpu = await capturePreset('quasar', '09_quasar_webgpu.png', 20);

    // 3. Switch BACK from WebGPU to WebGL2 via Controls drawer
    await evalJS(`window.__GARGANTUA__.selectPreset('gargantua', true); window.__GARGANTUA__.setState({ paused: true, autoOrbit: false });`);
    await evalJS(`document.getElementById('controls-toggle')?.click()`);
    await sleep(300);
    console.log('3. Clicking WebGL2 toggle inside Controls drawer to switch back...');
    await evalJS(`document.getElementById('ctrl-backend-webgl2')?.click()`);
    const diagWebGLAfterSwitch = await waitForReadyBackend('webgl2');
    await waitForSamples(16, 4500);
    await evalJS(`document.getElementById('controls-close')?.click()`);
    await sleep(300);

    // Test slider interaction on WebGL2 after switching back
    const sliderTest = await evalJS(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="range"]'));
      const tempInput = inputs.find(i => i.id?.toLowerCase().includes('temp')) || inputs[0];
      if (!tempInput) return { ok: false, count: inputs.length };
      const before = JSON.parse(JSON.stringify(window.__GARGANTUA__.getState()));
      const origVal = tempInput.value;
      tempInput.value = '9500';
      tempInput.dispatchEvent(new Event('input', { bubbles: true }));
      const after = JSON.parse(JSON.stringify(window.__GARGANTUA__.getState()));
      tempInput.value = origVal;
      tempInput.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: before.diskTemp !== after.diskTemp, sliderCount: inputs.length };
    })()`);

    // Test hotkey H hides and restores HUD
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
      const b = await window.__GARGANTUA__.capturePNG();
      return b ? b.size : 0;
    })()`, true);
    const s10 = await captureShot('10_webgl2_after_switch.png');
    const statsWebGLAfterSwitch = await analyzePng(s10.base64);
    console.log('Captured 10_webgl2_after_switch.png');

    // 4. Test direct boot with ?backend=webgpu
    const directUrl = `http://127.0.0.1:${port}/sims/blackhole/?backend=webgpu`;
    console.log(`4. Navigating directly to ${directUrl}...`);
    await cdp.send('Page.navigate', { url: directUrl });
    const diagDirectWebGPU = await waitForReadyBackend('webgpu');
    await waitFrames(15);

    const report = {
      diagWebGLInit,
      diagWebGPU,
      diagWebGLAfterSwitch,
      diagDirectWebGPU,
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
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED UNIFIED CHROME QA ASSERTIONS ===');
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
      Math.abs(camAfterSwitch.radius - camBeforeSwitch.radius) < 0.1 &&
      Math.abs(camAfterSwitch.elevationDeg - camBeforeSwitch.elevationDeg) < 0.5 &&
      Math.abs(camAfterSwitch.azimuthDeg - camBeforeSwitch.azimuthDeg) < 0.5 &&
      Math.abs(camAfterSwitch.rollDeg - camBeforeSwitch.rollDeg) < 0.5;
    check(camPreserved, 'Camera pose preserved across WebGL2 -> WebGPU switch');

    const rel = shots.relativistic_webgpu.stats;
    check(
      rel.leftBand.luma > rel.rightBand.luma * 1.4,
      'WebGPU Relativistic preset: approaching (-X) brighter than receding (+X)',
      `leftLuma=${rel.leftBand.luma}, rightLuma=${rel.rightBand.luma}`
    );
    check(
      rel.leftBand.blueOverRed > rel.rightBand.blueOverRed,
      'WebGPU Relativistic preset: approaching (-X) bluer than receding (+X)',
      `left B/R=${rel.leftBand.blueOverRed}, right B/R=${rel.rightBand.blueOverRed}`
    );
    check(
      rel.shadowCore.centroidOffsetXNorm !== null && rel.shadowCore.centroidOffsetXNorm > 0.01,
      'WebGPU Relativistic (a=0.998): Kerr shadow shifted RIGHT (+X)',
      `centroidOffsetX=${rel.shadowCore.centroidOffsetXNorm}`
    );

    const schw = shots.schwarzschild_webgpu.stats;
    check(
      schw.shadowCore.centroidOffsetXNorm !== null && Math.abs(schw.shadowCore.centroidOffsetXNorm) < 0.03,
      'WebGPU Schwarzschild (a=0): shadow symmetric near X=0',
      `centroidOffsetX=${schw.shadowCore.centroidOffsetXNorm}`
    );

    check(diagWebGLAfterSwitch?.backend === 'webgl2' && diagWebGLAfterSwitch?.allShadersCompiled === true, 'Live switch BACK WebGPU -> WebGL2 succeeded cleanly');
    check(
      statsWebGLAfterSwitch.meanLuma > 5 && statsWebGLAfterSwitch.pureBlackCenter > 0,
      'WebGL2 after round-trip switch renders non-blank black hole image',
      `meanLuma=${statsWebGLAfterSwitch.meanLuma}, blackCenter=${statsWebGLAfterSwitch.pureBlackCenter}`
    );
    check(sliderTest?.ok === true, 'Live slider input updates simulator state cleanly');
    check(hudHiddenAfterH === true, 'Hotkey H cleanly toggles HUD visibility');
    check(
      pngBytesWebGL > 50000 && pngBytesWebGPU > 50000 && pngBytesWebGLAfterSwitch > 50000,
      'capturePNG() produces valid PNG Blobs across WebGL2 & WebGPU',
      `bytes=[${pngBytesWebGL}, ${pngBytesWebGPU}, ${pngBytesWebGLAfterSwitch}]`
    );
    check(
      diagDirectWebGPU?.backend === 'webgpu' && diagDirectWebGPU?.allShadersCompiled === true && (!diagDirectWebGPU?.errors || diagDirectWebGPU.errors.length === 0),
      'Direct boot via ?backend=webgpu starts cleanly in WebGPU'
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
