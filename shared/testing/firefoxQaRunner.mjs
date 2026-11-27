/**
 * firefoxQaRunner.mjs — Parameterized Headed Wayland Firefox NVIDIA WebGPU QA runner
 * shared by all 7 `sims/<id>/tests/firefox_qa.mjs` test suites.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startStaticServer } from './staticServer.mjs';
import { runHeadedFirefoxQA } from './firefoxHarness.mjs';

function buildInjectedScript(config) {
  const {
    debugHandle,
    switchCamera,
    secondSwitchCamera = null,
    roundTripPreset,
    roundTripPngName = 'firefox_webgpu_after_switch.png',
    waitSamples = null,
    extraPresetStep = null,
  } = config;

  const sampleCfg = waitSamples
    ? JSON.stringify(waitSamples)
    : 'null';
  const extraCfg = extraPresetStep ? JSON.stringify(extraPresetStep) : 'null';
  const cam1Json = JSON.stringify(switchCamera);
  const cam2Json = JSON.stringify(secondSwitchCamera);

  return `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SAMPLE_CFG = ${sampleCfg};
  const EXTRA_STEP = ${extraCfg};
  const SECOND_CAM = ${cam2Json};
  const getApi = () => window['${debugHandle}'];

  const postPng = async (name) => {
    const blob = await getApi().capturePNG();
    const buf = await blob.arrayBuffer();
    await fetch('/__qa_png?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: buf,
    });
    return buf.byteLength;
  };
  const countRafAndFps = async (ms = 2600) => {
    let rafCount = 0;
    let active = true;
    const step = () => { if (active) { rafCount++; requestAnimationFrame(step); } };
    requestAnimationFrame(step);
    await sleep(ms);
    active = false;
    const diag = getApi().getDiagnostics();
    const tel = getApi().getTelemetry();
    return { rafCount, fps: tel.fps, diag };
  };
  const waitReadyBackend = async (backend, timeoutMs = 20000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = getApi()?.getDiagnostics?.();
      if (d && d.backend === backend && !d.switchingBackend && d.skyMapLoaded === true) {
        return d;
      }
      await sleep(120);
    }
    return getApi()?.getDiagnostics?.();
  };
  const waitSamples = async (target = 10, timeoutMs = 5000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = getApi()?.getDiagnostics?.();
      if (d && (d.samples ?? 0) >= target) return d;
      await sleep(100);
    }
    return getApi()?.getDiagnostics?.();
  };
  const selectPreset = (id) => {
    const api = getApi();
    if (typeof api.selectPreset === 'function') {
      return api.selectPreset(id, true);
    }
    return api.applyPreset(id, true);
  };

  try {
    const t0 = performance.now();
    while (!getApi() && performance.now() - t0 < 20000) {
      await sleep(100);
    }
    if (!getApi()) {
      throw new Error('window.${debugHandle} failed to mount in Firefox within 20s');
    }

    const report = { steps: {}, runtimeErrors: [] };
    window.addEventListener('error', (e) => report.runtimeErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', (e) => report.runtimeErrors.push(String(e.reason)));

    // 1. Initial WebGPU boot (?backend=webgpu) + continuous 2.6s render check
    await waitReadyBackend('webgpu');
    getApi().setState({ paused: false, autoOrbit: true });
    const webgpuRun1 = await countRafAndFps(2600);
    getApi().setState({ paused: true, autoOrbit: false });
    if (SAMPLE_CFG?.initial) await waitSamples(SAMPLE_CFG.initial, 2500);
    await sleep(SAMPLE_CFG ? 250 : 300);
    const png1 = await postPng('firefox_webgpu.png');
    report.steps.initialWebGPU = { ...webgpuRun1, pngBytes: png1 };

    // 2. Open Controls drawer & switch live WebGPU -> WebGL2 while testing camera preservation
    document.getElementById('controls-toggle')?.click();
    await sleep(250);
    getApi().setState({
      paused: true,
      autoOrbit: false,
      camera: ${cam1Json},
    });
    const camBefore = getApi().getState().camera;

    document.getElementById('ctrl-backend-webgl2')?.click();
    const afterGL = await waitReadyBackend('webgl2');
    const camAfterGL = getApi().getState().camera;
    getApi().setState({ paused: false, autoOrbit: true });
    const webglRun = await countRafAndFps(1800);
    getApi().setState({ paused: true, autoOrbit: false });
    if (SAMPLE_CFG?.afterGL) await waitSamples(SAMPLE_CFG.afterGL, 2500);
    await sleep(SAMPLE_CFG ? 250 : 300);
    const png2 = await postPng('firefox_webgl2.png');
    report.steps.switchedWebGL2 = {
      ...webglRun,
      diagImmediate: afterGL,
      camBefore,
      camAfter: camAfterGL,
      pngBytes: png2,
    };

    // 3. Switch live BACK WebGL2 -> WebGPU via Controls drawer + verify 2.6s continuous rendering
    let camBeforeGPU = null;
    if (SECOND_CAM) {
      getApi().setState({ paused: true, autoOrbit: false, camera: SECOND_CAM });
      camBeforeGPU = getApi().getState().camera;
    }
    document.getElementById('ctrl-backend-webgpu')?.click();
    const afterGPU = await waitReadyBackend('webgpu');
    const camAfterGPU = SECOND_CAM ? getApi().getState().camera : null;
    document.getElementById('controls-close')?.click();
    selectPreset('${roundTripPreset}');
    getApi().setState({ paused: false, autoOrbit: true });
    const webgpuRun2 = await countRafAndFps(2600);
    getApi().setState({ paused: true, autoOrbit: false });
    if (SAMPLE_CFG?.roundTrip) await waitSamples(SAMPLE_CFG.roundTrip, 3000);
    await sleep(SAMPLE_CFG ? 250 : 300);
    const png3 = await postPng('${roundTripPngName}');
    report.steps.switchedBackWebGPU = {
      ...webgpuRun2,
      diagImmediate: afterGPU,
      ...(SECOND_CAM ? { camBefore: camBeforeGPU, camAfter: camAfterGPU } : {}),
      pngBytes: png3,
    };

    // 4. Optional extra preset capture on WebGPU
    if (EXTRA_STEP) {
      selectPreset(EXTRA_STEP.presetId);
      getApi().setState({ paused: true, autoOrbit: false, ...(EXTRA_STEP.preState || {}) });
      if (SAMPLE_CFG?.extra) await waitSamples(SAMPLE_CFG.extra, 3500);
      await sleep(250);
      const extraDiag = getApi().getDiagnostics();
      const png4 = await postPng(EXTRA_STEP.pngName);
      report.steps[EXTRA_STEP.stepKey] = { diag: extraDiag, pngBytes: png4 };
    }

    await fetch('/__qa_done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (err) {
    await fetch('/__qa_done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fatalError: String(err?.stack || err) }),
    });
  }
})();
`;
}

function angleDiffDeg(a, b) {
  const na = Number.isFinite(Number(a)) ? Number(a) : 0;
  const nb = Number.isFinite(Number(b)) ? Number(b) : 0;
  let d = (na - nb + 180) % 360;
  if (d < 0) d += 360;
  return Math.abs(d - 180);
}

function checkCameraPreserved(kind, camBefore, camAfter) {
  if (!camBefore || !camAfter) return false;
  switch (kind) {
    case 'wormhole':
      return (
        Math.abs((camAfter.l ?? 999) - (camBefore.l ?? -999)) < 0.2 &&
        Math.abs((camAfter.elevationDeg ?? 999) - (camBefore.elevationDeg ?? -999)) < 0.5 &&
        Math.abs((camAfter.azimuthDeg ?? 999) - (camBefore.azimuthDeg ?? -999)) < 0.5 &&
        Math.abs((camAfter.rollDeg ?? 999) - (camBefore.rollDeg ?? -999)) < 0.5
      );
    case 'pivotDistance':
      return (
        Math.abs(camAfter.distance - camBefore.distance) < 0.2 &&
        Math.abs((camAfter.pivot?.[0] ?? 0) - (camBefore.pivot?.[0] ?? 0)) < 0.1 &&
        Math.abs((camAfter.pivot?.[1] ?? 0) - (camBefore.pivot?.[1] ?? 0)) < 0.1 &&
        Math.abs((camAfter.pivot?.[2] ?? 0) - (camBefore.pivot?.[2] ?? 0)) < 0.1 &&
        Math.abs(camAfter.elevationDeg - camBefore.elevationDeg) < 0.5 &&
        Math.abs(camAfter.azimuthDeg - camBefore.azimuthDeg) < 0.5 &&
        Math.abs(camAfter.rollDeg - camBefore.rollDeg) < 0.5
      );
    case 'look':
      return (
        angleDiffDeg(camAfter.lookYawDeg, camBefore.lookYawDeg) < 0.5 &&
        Math.abs(camAfter.lookPitchDeg - camBefore.lookPitchDeg) < 0.5 &&
        Math.abs(camAfter.rollDeg - camBefore.rollDeg) < 0.5 &&
        Math.abs((camAfter.fovDeg ?? 56) - (camBefore.fovDeg ?? 56)) < 0.5
      );
    case 'radius':
    default:
      return (
        Math.abs(camAfter.radius - camBefore.radius) < 0.2 &&
        Math.abs(camAfter.elevationDeg - camBefore.elevationDeg) < 0.5
      );
  }
}

/**
 * Executes the headed Firefox Wayland NVIDIA WebGPU QA suite for one simulator.
 */
export async function runSimFirefoxQA(config) {
  const {
    shotDir,
    simDir,
    profilePrefix,
    timeoutMs = 45000,
    banner = '=== AUTOMATED HEADED FIREFOX NVIDIA QA ASSERTIONS ===',
    requireVolumeBaked = false,
    requireTidalComputed = false,
    requireSharedTextureWord = false,
    cameraKind = 'radius',
    extraPresetStep = null,
    secondSwitchCamera = null,
    roundTripLabel = 'Firefox live round-trip switch WebGL2 -> WebGPU succeeded cleanly',
  } = config;

  fs.mkdirSync(shotDir, { recursive: true });
  const script = buildInjectedScript(config);

  const { server, port, donePromise } = await startStaticServer({
    shotDir,
    enableQaEndpoints: true,
    injectTargetRel: `${simDir}/index.html`,
    injectScript: script,
  });

  const targetUrl = `http://127.0.0.1:${port}/${simDir}/?backend=webgpu`;
  let sawFirefoxOnNvidia = false;
  let report;
  let stderr = '';
  try {
    ({ sawFirefoxOnNvidia, report, stderr } = await runHeadedFirefoxQA({
      targetUrl,
      donePromise,
      profilePrefix,
      timeoutMs,
    }));
  } finally {
    server.close();
  }

  fs.writeFileSync(
    path.join(shotDir, 'firefox_qa_report.json'),
    JSON.stringify({ sawFirefoxOnNvidia, report, stderrSnippet: stderr.slice(-2000) }, null, 2)
  );

  console.log(`\n${banner}`);
  let qaFail = 0;
  const check = (cond, msg, detail = '') => {
    if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
    else {
      qaFail++;
      console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
    }
  };

  check(!report?.fatalError, 'Firefox QA script completed without fatal error', report?.fatalError || 'OK');
  check(sawFirefoxOnNvidia, 'nvidia-smi listed firefox under active NVIDIA GPU processes');
  check(
    stderr.includes('dom.webgpu.allow-present-without-readback') &&
      (!requireSharedTextureWord || stderr.includes('SharedTexture')),
    'Firefox stderr confirms SharedTexture readback workaround is active'
  );
  check(!/Device is lost/i.test(stderr), 'Firefox stderr contains zero WebGPU "Device is lost" errors');
  check((report?.runtimeErrors || []).length === 0, 'Zero Firefox page JS runtime errors', (report?.runtimeErrors || []).join(' | '));

  const s1 = report?.steps?.initialWebGPU;
  check(
    s1?.diag?.backend === 'webgpu' &&
      s1?.diag?.allShadersCompiled === true &&
      (!requireVolumeBaked || s1?.diag?.volumeBaked === true) &&
      (!requireTidalComputed || s1?.diag?.tidalComputed === true) &&
      s1?.diag?.skyMapLoaded === true,
    requireTidalComputed
      ? 'Initial Firefox WebGPU boot compiled, computed tidal field & loaded 4K sky'
      : requireVolumeBaked
      ? 'Initial Firefox WebGPU boot compiled, baked volume & loaded 4K sky'
      : 'Initial Firefox WebGPU boot compiled & loaded 4K sky',
    s1?.diag?.canvasFormat
  );
  check((s1?.fps || 0) > 2 && (s1?.rafCount || 0) > 15, 'Firefox WebGPU renders continuously over 2.6s', `fps=${s1?.fps}, rafs=${s1?.rafCount}`);
  check((s1?.pngBytes || 0) > 50000, 'Firefox WebGPU capturePNG() offscreen readback valid', `${s1?.pngBytes} bytes`);

  const s2 = report?.steps?.switchedWebGL2;
  check(
    s2?.diag?.backend === 'webgl2' && s2?.diag?.allShadersCompiled === true && s2?.diag?.skyMapLoaded === true,
    'Firefox live switch WebGPU -> WebGL2 succeeded cleanly',
    s2?.diag?.webglRenderer
  );
  check(
    checkCameraPreserved(cameraKind, s2?.camBefore, s2?.camAfter),
    cameraKind === 'pivotDistance'
      ? 'Firefox preserved camera pose & pivot across WebGPU -> WebGL2 switch'
      : 'Firefox preserved camera pose across WebGPU -> WebGL2 switch'
  );
  check((s2?.fps || 0) > 2 && (s2?.pngBytes || 0) > 50000, 'Firefox WebGL2 renders & exports PNG after switch', `fps=${s2?.fps}, ${s2?.pngBytes} bytes`);

  const s3 = report?.steps?.switchedBackWebGPU;
  check(
    s3?.diag?.backend === 'webgpu' &&
      s3?.diag?.allShadersCompiled === true &&
      (!requireVolumeBaked || s3?.diag?.volumeBaked === true) &&
      (!s3?.diag?.errors || s3.diag.errors.length === 0),
    roundTripLabel
  );
  if (secondSwitchCamera) {
    check(
      checkCameraPreserved(cameraKind, s3?.camBefore, s3?.camAfter),
      'Firefox preserved camera pose across WebGL2 -> WebGPU switch'
    );
  }
  check((s3?.fps || 0) > 2 && (s3?.pngBytes || 0) > 50000, 'Firefox WebGPU after round-trip switch renders continuously & exports PNG', `fps=${s3?.fps}, ${s3?.pngBytes} bytes`);

  if (extraPresetStep) {
    const s4 = report?.steps?.[extraPresetStep.stepKey];
    check(
      s4?.diag?.backend === 'webgpu' &&
        s4?.diag?.activePreset === extraPresetStep.presetId &&
        (s4?.pngBytes || 0) > 50000,
      extraPresetStep.label,
      `${s4?.pngBytes} bytes`
    );
  }

  process.exitCode = qaFail > 0 ? 1 : 0;
}
