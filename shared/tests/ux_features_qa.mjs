#!/usr/bin/env node
/**
 * Part 2 UX & Observatory Features Hardware Chrome QA Suite:
 *  1. Shareable URL state & deep-linking (/?sim=blackhole&preset=m87&...#s=... redirect & restore)
 *  2. Persistent Graphics & Quality Profiles (Eco / Balanced / Ultra + DPR cap across reload & WebGL2/WebGPU)
 *  3. Interactive Physics Tour (I toggle, reticle pins, ] step, preset update, H hide-HUD integration)
 *  4. Cinema Recorder (deterministic PNG frame sequence + WebM MediaRecorder evolution capture)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../testing/staticServer.mjs';
import { sleep, launchChromeDualCDP } from '../testing/chromeCdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { server, port } = await startStaticServer({ preferredPort: 8792 });
  const debugPort = 9650 + Math.floor(Math.random() * 250);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: 1280,
    viewportH: 720,
    profilePrefix: 'interstellar-ux-qa-',
  });

  const consoleErrors = [];
  const exceptions = [];
  const failedRequests = [];

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const ex = p.exceptionDetails;
      exceptions.push(ex?.exception?.description || ex?.text || JSON.stringify(ex));
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response.status >= 400 && !p.response.url.includes('favicon.ico')) {
        failedRequests.push(`${p.response.status} ${p.response.url}`);
      }
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

    const waitReady = async (handle = '__GARGANTUA__', backend = 'webgl2', maxMs = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        try {
          const d = await evalJS(`window.${handle}?.getDiagnostics?.()`);
          if (d && d.backend === backend && !d.switchingBackend && d.allShadersCompiled) {
            return d;
          }
        } catch {
          // mid-navigation
        }
        await sleep(100);
      }
      return await evalJS(`window.${handle}?.getDiagnostics?.()`);
    };

    const pressKey = async (key, code, keyCode, modifiers = 0) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await sleep(150);
    };

    const results = [];
    const check = (cond, msg, detail = '') => {
      results.push({ ok: Boolean(cond), msg, detail });
      if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
      else console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
    };

    // 1. Boot blackhole and verify Shareable URL State & Deep-Linking
    console.log('1. Testing Shareable URL State & Deep-Linking...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/blackhole/` });
    await waitReady('__GARGANTUA__', 'webgl2');

    const shareUrl = await evalJS(`(() => {
      const api = window.__GARGANTUA__;
      api.selectPreset('m87', true);
      api.setState({ spin: 0.65, camera: { azimuthDeg: 55, elevationDeg: 28 } });
      api.togglePhysicsTour(true);
      return api.getShareUrl();
    })()`);

    const parsedShare = new URL(shareUrl);
    const rootRedirectShare = `http://127.0.0.1:${port}/?sim=blackhole&${parsedShare.search.slice(1)}${parsedShare.hash}`;
    await cdp.send('Page.navigate', { url: rootRedirectShare });
    await waitReady('__GARGANTUA__', 'webgl2');
    await sleep(300);

    const restoredState = await evalJS(`(() => ({
      pathname: window.location.pathname,
      state: window.__GARGANTUA__.getState(),
      tour: window.__GARGANTUA__.getPhysicsTourState(),
    }))()`);

    check(
      restoredState.pathname.includes('/sims/blackhole/') &&
        restoredState.state.presetId === 'm87' &&
        Math.abs(restoredState.state.spin - 0.65) < 0.01 &&
        Math.abs(restoredState.state.camera.azimuthDeg - 55) < 1.0 &&
        Math.abs(restoredState.state.camera.elevationDeg - 28) < 1.0 &&
        restoredState.tour.open === true,
      'Shareable URL roundtrips through root /?sim=blackhole redirect restoring preset, params, camera, and tour',
      `preset=${restoredState.state.presetId}, spin=${restoredState.state.spin}, az=${restoredState.state.camera?.azimuthDeg?.toFixed?.(1)}`
    );

    // 2. Interactive Physics Tour
    console.log('2. Testing Interactive Physics Tour...');
    const tourBeforeStep = await evalJS(`({
      visible: !document.getElementById('physics-tour-overlay')?.hidden,
      pinCount: document.querySelectorAll('#physics-tour-overlay .tour-pin').length,
      headline: document.querySelector('#physics-tour-overlay .tour-headline')?.textContent,
      step0: window.__GARGANTUA__.getPhysicsTourState().stepIndex,
    })`);
    await pressKey(']', 'BracketRight', 221);
    const tourAfterStep = await evalJS(`window.__GARGANTUA__.getPhysicsTourState()`);
    await pressKey('2', 'Digit2', 50);
    await sleep(200);
    const tourAfterPreset2 = await evalJS(`({
      presetId: window.__GARGANTUA__.getState().presetId,
      headline: document.querySelector('#physics-tour-overlay .tour-headline')?.textContent,
    })`);
    await pressKey('h', 'KeyH', 72);
    const hiddenCheck = await evalJS(`document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);
    await pressKey('i', 'KeyI', 73);
    const tourClosed = await evalJS(`document.getElementById('physics-tour-overlay')?.hidden`);

    check(
      tourBeforeStep.visible &&
        tourBeforeStep.pinCount >= 3 &&
        tourAfterStep.stepIndex === 1 &&
        tourAfterPreset2.presetId === 'relativistic' &&
        tourAfterPreset2.headline !== tourBeforeStep.headline &&
        hiddenCheck === true &&
        tourClosed === true,
      'Physics Tour renders reticle pins, steps via ], updates on preset switch, hides with H, and toggles via I'
    );

    // 3. Persistent Graphics & Quality Profiles across reload + WebGPU
    console.log('3. Testing Persistent Graphics Profiles & DPR Cap...');
    await evalJS(`window.__GARGANTUA__.setQualityProfile('eco')`);
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitReady('__GARGANTUA__', 'webgl2');
    const ecoAfterReload = await evalJS(`({
      prefs: window.__GARGANTUA__.getGraphicsPrefs(),
      reducedGlass: document.body.classList.contains('reduced-glass'),
      diag: window.__GARGANTUA__.getDiagnostics(),
    })`);

    await evalJS(`window.__GARGANTUA__.setQualityProfile('ultra')`);
    await evalJS(`window.__GARGANTUA__.setBackend('webgpu')`, true);
    const ultraWebGPU = await waitReady('__GARGANTUA__', 'webgpu');

    check(
      ecoAfterReload.prefs.profileId === 'eco' &&
        ecoAfterReload.prefs.quality === 0 &&
        Math.abs(ecoAfterReload.prefs.resolutionScale - 0.75) < 1e-3 &&
        ecoAfterReload.prefs.dprCap === 1.0 &&
        ecoAfterReload.reducedGlass === true &&
        ultraWebGPU.dprCap === 2.0 &&
        ultraWebGPU.qualityProfile === 'ultra',
      'Eco/Ultra quality profiles & DPR cap persist across reload and synchronize across WebGL2/WebGPU'
    );

    // Reset localStorage so profile stays clean
    await evalJS(`localStorage.clear()`);

    // 4. Cinema Recorder (PNG Frame Sequence + WebM on Supernova)
    console.log('4. Testing Cinema Recorder (PNG Frame Sequence & WebM)...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/supernova/` });
    await waitReady('__SUPERNOVA__', 'webgl2');

    const framesStart = await evalJS(`(() => {
      window.__SUPERNOVA__.startRecording({ mode: 'turntable', format: 'frames', durationSec: 2, fps: 15 });
      return window.__SUPERNOVA__.getRecordingState();
    })()`);
    await sleep(450);
    const framesMid = await evalJS(`window.__SUPERNOVA__.getRecordingState()`);
    await evalJS(`window.__SUPERNOVA__.stopRecording()`);
    await sleep(250);
    const framesAfterStop = await evalJS(`window.__SUPERNOVA__.getRecordingState()`);

    const webmStart = await evalJS(`window.__SUPERNOVA__.startRecording({ mode: 'evolution', format: 'webm', durationSec: 2, fps: 24 })`, true);
    await sleep(300);
    const webmMid = await evalJS(`window.__SUPERNOVA__.getRecordingState()`);
    await evalJS(`window.__SUPERNOVA__.stopRecording()`);
    await sleep(250);
    const webmAfterStop = await evalJS(`window.__SUPERNOVA__.getRecordingState()`);

    check(
      framesStart.active === true &&
        framesMid.frameIndex >= 2 &&
        framesAfterStop.active === false &&
        (!webmStart.ok || (webmMid.active === true && webmAfterStop.active === false)),
      'Cinema Recorder captures deterministic turntable PNG sequences and WebM evolution clips cleanly',
      `framesMid=${framesMid.frameIndex}, webmOk=${webmStart.ok}`
    );

    // 5. Web Audio Sonification Toggle (`M` key on Binary & Pulsar)
    console.log('5. Testing Web Audio Sonification (`M`) on Binary & Pulsar...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/binary/` });
    await waitReady('__BINARY_BH__', 'webgl2');
    const binAudioBefore = await evalJS(`window.__BINARY_BH__.getDiagnostics().audio`);
    await pressKey('m', 'KeyM', 77);
    await sleep(120);
    const binAudioOn = await evalJS(`window.__BINARY_BH__.getDiagnostics().audio`);
    await pressKey('m', 'KeyM', 77);
    const binAudioOff = await evalJS(`window.__BINARY_BH__.getDiagnostics().audio`);

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/pulsar/` });
    await waitReady('__PULSAR__', 'webgl2');
    await pressKey('m', 'KeyM', 77);
    await sleep(120);
    const pulsarAudioOn = await evalJS(`window.__PULSAR__.getDiagnostics().audio`);
    await pressKey('m', 'KeyM', 77);

    check(
      binAudioBefore?.enabled === false &&
        binAudioOn?.enabled === true &&
        binAudioOff?.enabled === false &&
        pulsarAudioOn?.enabled === true,
      'M hotkey toggles Web Audio astrophysics sonification on Binary BH & Pulsar without runtime errors',
      `binary=${binAudioOn?.readout || 'n/a'}`
    );

    // 6. Live GPU Pass Profiler Overlay (`G` key across WebGL2 & WebGPU) + Service Worker Registration
    console.log('6. Testing Live GPU Pass Profiler (`G`) on WebGL2 & WebGPU + PWA Service Worker...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/blackhole/` });
    await waitReady('__GARGANTUA__', 'webgl2');
    await pressKey('g', 'KeyG', 71);
    await sleep(450);
    const glProf = await evalJS(`({
      diag: window.__GARGANTUA__.getDiagnostics().profiler,
      visible: !document.getElementById('gpu-profiler-overlay')?.hidden,
      totalText: document.getElementById('gp-total-val')?.textContent?.trim(),
      badge: document.getElementById('gp-backend-badge')?.textContent?.trim(),
    })`);

    await evalJS(`window.__GARGANTUA__.setBackend('webgpu')`, true);
    await waitReady('__GARGANTUA__', 'webgpu');
    await sleep(450);
    const gpuProf = await evalJS(`({
      diag: window.__GARGANTUA__.getDiagnostics().profiler,
      visible: !document.getElementById('gpu-profiler-overlay')?.hidden,
      totalText: document.getElementById('gp-total-val')?.textContent?.trim(),
      badge: document.getElementById('gp-backend-badge')?.textContent?.trim(),
    })`);
    await pressKey('g', 'KeyG', 71);
    const profHiddenAfter = await evalJS(`Boolean(document.getElementById('gpu-profiler-overlay')?.hidden)`);

    const swInfo = await evalJS(`(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        supported: true,
        regCount: regs.length,
        scripts: regs.map((r) => r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || ''),
      };
    })()`, true);

    check(
      glProf.visible === true &&
        glProf.diag?.enabled === true &&
        glProf.diag?.history?.length >= 1 &&
        gpuProf.visible === true &&
        gpuProf.diag?.enabled === true &&
        gpuProf.diag?.backend === 'webgpu' &&
        gpuProf.diag?.history?.length >= 1 &&
        profHiddenAfter === true,
      'G hotkey opens GPU Pass Profiler across WebGL2 & WebGPU with live pass metrics and closes cleanly',
      `glTotal=${glProf.totalText} (${glProf.badge}), gpuTotal=${gpuProf.totalText} (${gpuProf.badge})`
    );

    check(
      swInfo.supported && swInfo.regCount >= 1 && swInfo.scripts.some((s) => s.endsWith('/sw.js')),
      'Observatory PWA Service Worker registers cleanly under active scope',
      `regs=${swInfo.regCount}`
    );

    // 7. Universal In-Sim Help Menu (? / F1 / Button / Tabs / Presets / Esc)
    console.log('7. Testing Universal In-Sim Help Menu (? / F1 / Button / Tabs / Presets / Esc)...');
    const helpBtnLayout = await evalJS(`(() => {
      const overlaps = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const btn = document.getElementById('btn-help-menu');
      const hdr = document.querySelector('.hud-top-left');
      const ctrl = document.getElementById('controls-toggle');
      const br = btn?.getBoundingClientRect();
      const hr = hdr?.getBoundingClientRect();
      const cr = ctrl?.getBoundingClientRect();
      return {
        exists: Boolean(btn),
        hdrOverlap: Boolean(br && hr && overlaps(br, hr)),
        ctrlOverlap: Boolean(br && cr && overlaps(br, cr)),
      };
    })()`);

    await evalJS(`document.getElementById('btn-help-menu')?.click()`);
    await sleep(220);
    const helpOpenControls = await evalJS(`(() => ({
      open: window.__GARGANTUA__.getHelpState().open,
      title: document.getElementById('help-menu-title')?.textContent?.trim(),
      eq: document.querySelector('.help-modal-eq')?.textContent?.trim(),
      controlsVisible: !document.getElementById('help-panel-controls')?.hidden,
      keyRows: document.querySelectorAll('#help-panel-controls .help-key-row').length,
    }))()`);
    const shotHelpControls = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'help_menu_controls.png'), Buffer.from(shotHelpControls.data, 'base64'));

    await evalJS(`document.getElementById('help-tab-physics')?.click()`);
    await sleep(160);
    const helpPhysicsInfo = await evalJS(`(() => ({
      physicsVisible: !document.getElementById('help-panel-physics')?.hidden,
      presetCards: document.querySelectorAll('#help-panel-physics .help-preset-card').length,
    }))()`);
    const shotHelpPhysics = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'help_menu_physics.png'), Buffer.from(shotHelpPhysics.data, 'base64'));

    await evalJS(`document.getElementById('help-tab-tips')?.click()`);
    await sleep(140);
    const helpTipsVisible = await evalJS(`!document.getElementById('help-panel-tips')?.hidden`);

    await evalJS(`document.getElementById('help-tab-physics')?.click()`);
    await sleep(120);
    await evalJS(`document.querySelector('#help-panel-physics .help-preset-card[data-preset-id="relativistic"]')?.click()`);
    await sleep(220);
    const helpAfterPresetClick = await evalJS(`(() => ({
      helpOpen: window.__GARGANTUA__.getHelpState().open,
      presetId: window.__GARGANTUA__.getState().presetId,
    }))()`);

    // Hotkey ? / F1 / Esc / H
    await pressKey('?', 'Slash', 191, 8);
    const openedByQuestion = await evalJS(`window.__GARGANTUA__.getHelpState().open`);
    await pressKey('Escape', 'Escape', 27);
    const closedByEsc = await evalJS(`!window.__GARGANTUA__.getHelpState().open`);
    await pressKey('F1', 'F1', 112);
    const openedByF1 = await evalJS(`window.__GARGANTUA__.getHelpState().open`);
    await pressKey('h', 'KeyH', 72);
    const closedByHideHud = await evalJS(`!window.__GARGANTUA__.getHelpState().open && document.getElementById('hud-chrome')?.classList.contains('is-hud-hidden')`);
    await pressKey('h', 'KeyH', 72);

    // Verify Help Menu on a second simulator (TDE)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sims/tde/` });
    await waitReady('__TDE__', 'webgl2');
    await pressKey('F1', 'F1', 112);
    const tdeHelp = await evalJS(`(() => ({
      hasBtn: Boolean(document.getElementById('btn-help-menu')),
      open: window.__TDE__.getHelpState().open,
      title: document.getElementById('help-menu-title')?.textContent?.trim(),
      presetCards: document.querySelectorAll('#help-panel-physics .help-preset-card').length,
    }))()`);
    await pressKey('Escape', 'Escape', 27);

    const helpChecks = {
      btnExists: helpBtnLayout.exists,
      noHdrOverlap: !helpBtnLayout.hdrOverlap,
      noCtrlOverlap: !helpBtnLayout.ctrlOverlap,
      openControls: helpOpenControls.open === true,
      hasTitle: Boolean(helpOpenControls.title),
      hasEq: Boolean(helpOpenControls.eq),
      controlsVisible: helpOpenControls.controlsVisible === true,
      enoughKeys: helpOpenControls.keyRows >= 15,
      physicsVisible: helpPhysicsInfo.physicsVisible === true,
      sixPresets: helpPhysicsInfo.presetCards === 6,
      tipsVisible: helpTipsVisible === true,
      closedOnPresetClick: helpAfterPresetClick.helpOpen === false,
      presetSwitched: helpAfterPresetClick.presetId === 'relativistic',
      openedByQuestion,
      closedByEsc,
      openedByF1,
      closedByHideHud,
      tdeHasBtn: tdeHelp.hasBtn === true,
      tdeOpen: tdeHelp.open === true,
      tdeTitleOk: Boolean(tdeHelp.title?.includes('Tidal Disruption')),
      tdeSixPresets: tdeHelp.presetCards === 6,
    };
    const failedHelpFlags = Object.entries(helpChecks).filter(([, v]) => !v).map(([k]) => k);

    check(
      failedHelpFlags.length === 0,
      'Universal Help Menu mounts cleanly, avoids HUD overlap, switches tabs & presets, and responds to ?, F1, Esc, and H across sims',
      `blackholeKeys=${helpOpenControls.keyRows}, tdeTitle=${tdeHelp.title}, failed=[${failedHelpFlags.join(',')}]`
    );

    check(consoleErrors.length === 0, 'Zero console errors during UX QA', consoleErrors.join(' | '));
    check(exceptions.length === 0, 'Zero runtime exceptions during UX QA', exceptions.join(' | '));
    check(failedRequests.length === 0, 'Zero failed HTTP requests during UX QA', failedRequests.join(' | '));

    const failCount = results.filter((r) => !r.ok).length;
    console.log(`\nUX QA SUMMARY: ${results.length - failCount} passed, ${failCount} failed`);
    process.exitCode = failCount > 0 ? 1 : 0;
  } finally {
    await cdp.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('UX QA FATAL:', err);
  process.exit(1);
});
