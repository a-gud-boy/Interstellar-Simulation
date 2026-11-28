/**
 * cinemaRecorder.js — Deterministic PNG Frame-Sequence (.zip) & MediaRecorder WebM
 * recorder for Interstellar Simulation (`live`, `turntable`, and `evolution` modes).
 * Pure ES module, zero external dependencies.
 */

export const RECORDER_MODES = Object.freeze([
  { id: 'live', label: 'Live' },
  { id: 'turntable', label: '360° Orbit' },
  { id: 'evolution', label: 'Evolution' },
]);

export const RECORDER_FORMATS = Object.freeze([
  { id: 'webm', label: 'WebM Video' },
  { id: 'frames', label: 'PNG Zip' },
]);

export const RECORDER_DURATIONS = Object.freeze([4, 8, 12]);
export const RECORDER_FPS_OPTIONS = Object.freeze([24, 30, 60]);
const MAX_SEQUENCE_FRAMES = 360;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes standard IEEE 802.3 CRC-32 over a Uint8Array.
 * @param {Uint8Array} bytes
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds an uncompressed (STORE method 0) PKZIP archive in memory.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function buildStoreZip(entries) {
  const encoder = new TextEncoder();
  const prepared = [];
  let localTotal = 0;
  let centralTotal = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name || 'file.bin'));
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || 0);
    const crc = crc32(data);
    prepared.push({ nameBytes, data, crc, offset: localTotal });
    localTotal += 30 + nameBytes.length + data.length;
    centralTotal += 46 + nameBytes.length;
  }

  const out = new Uint8Array(localTotal + centralTotal + 22);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const item of prepared) {
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 flag
    view.setUint16(pos + 8, 0, true); // Compression: STORE
    view.setUint16(pos + 10, 0, true); // Mod time
    view.setUint16(pos + 12, 0x5421, true); // Mod date
    view.setUint32(pos + 14, item.crc, true);
    view.setUint32(pos + 18, item.data.length, true);
    view.setUint32(pos + 22, item.data.length, true);
    view.setUint16(pos + 26, item.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(item.nameBytes, pos + 30);
    out.set(item.data, pos + 30 + item.nameBytes.length);
    pos += 30 + item.nameBytes.length + item.data.length;
  }

  const centralStart = pos;
  for (const item of prepared) {
    view.setUint32(pos, 0x02014b50, true); // Central directory signature
    view.setUint16(pos + 4, 20, true); // Version made by
    view.setUint16(pos + 6, 20, true); // Version needed
    view.setUint16(pos + 8, 0x0800, true); // UTF-8 flag
    view.setUint16(pos + 10, 0, true); // Compression: STORE
    view.setUint16(pos + 12, 0, true); // Mod time
    view.setUint16(pos + 14, 0x5421, true); // Mod date
    view.setUint32(pos + 16, item.crc, true);
    view.setUint32(pos + 20, item.data.length, true);
    view.setUint32(pos + 24, item.data.length, true);
    view.setUint16(pos + 28, item.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, item.offset, true);
    out.set(item.nameBytes, pos + 46);
    pos += 46 + item.nameBytes.length;
  }

  // End of central directory
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralTotal, true);
  view.setUint32(pos + 16, centralStart, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

export const EVOLUTION_PROFILES = Object.freeze({
  blackhole: 'Kerr Orbital Sweep',
  wormhole: 'Throat Traversal (A ⇄ B)',
  binary: '2.5PN Binary Inspiral',
  warp: 'Subluminal → 3.5c FTL Ramp',
  supernova: 'Core-Collapse Detonation',
  pulsar: 'Lighthouse Pulse Sweep',
  starflight: '0.25c → 0.999c Lorentz Boost',
  'lens-cluster': 'Caustic Crossing Orbit',
  tde: 'Pericenter Rip → t^(−5/3) Fallback',
});

function pickWebmMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

function makeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function applyTurntablePose(simId, camera, startCam, u) {
  if (!camera || !startCam || typeof camera.setImmediate !== 'function') return;
  const clamped = Math.max(0, Math.min(1, u));
  const useLookYaw =
    simId === 'starflight' || (simId === 'warp' && Number(startCam.cameraMode) === 1);
  if (useLookYaw && Number.isFinite(startCam.lookYawDeg)) {
    camera.setImmediate({ lookYawDeg: startCam.lookYawDeg + clamped * 360.0 });
  } else if (Number.isFinite(startCam.azimuthDeg)) {
    camera.setImmediate({ azimuthDeg: startCam.azimuthDeg + clamped * 360.0 });
  }
}

/**
 * Creates a dual-mode (MediaRecorder WebM + deterministic PNG .zip) cinema recorder.
 */
export function createCinemaRecorder({
  simId,
  screenshotPrefix = simId,
  getCanvas,
  getState,
  getCamera,
  getRenderer,
  getBackend,
  getSimTime,
  setSimTime,
  stepSimulation,
  renderImmediate,
  handleAction,
  applyParamChange,
  downloadBlob,
  onStateChange = () => {},
  onToast = () => {},
}) {
  let active = false;
  let abortRequested = false;
  let mode = 'turntable';
  let format = 'webm';
  let durationSec = 8;
  let fps = 30;
  let elapsedSec = 0;
  let frameIndex = 0;
  let totalFrames = 0;
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let startCamera = null;
  let savedAutoOrbit = false;
  let savedPaused = false;

  function snapshotState() {
    return {
      active,
      mode,
      format,
      durationSec,
      fps,
      elapsedSec,
      frameIndex,
      totalFrames,
      evolutionLabel: EVOLUTION_PROFILES[simId] || 'Physics Evolution',
      webmSupported: Boolean(pickWebmMimeType()),
    };
  }

  function emitState() {
    onStateChange(snapshotState());
  }

  function setupMotionForStart(targetMode) {
    const state = getState();
    const camera = getCamera();
    startCamera = camera?.getState?.() ? { ...camera.getState() } : null;
    savedAutoOrbit = Boolean(state.autoOrbit);
    savedPaused = Boolean(state.paused);

    if (targetMode === 'turntable') {
      state.paused = false;
      state.autoOrbit = false;
    } else if (targetMode === 'evolution') {
      state.paused = false;
      if (simId === 'supernova') {
        handleAction('detonate');
      } else if (simId === 'wormhole') {
        state.autoOrbit = false;
        handleAction('traverse');
      } else if (simId === 'binary') {
        applyParamChange?.('inspiralEnabled', true, { syncUi: true });
      } else if (simId === 'lens-cluster') {
        applyParamChange?.('sourceOrbitSpeed', 0.65, { syncUi: true });
      } else if (simId === 'tde') {
        applyParamChange?.('tdePhase', 0.08, { syncUi: true });
      } else if (simId === 'warp') {
        state.autoOrbit = false;
        applyParamChange?.('warpSpeed', 0.6, { syncUi: true });
      } else if (simId === 'starflight') {
        state.autoOrbit = false;
        applyParamChange?.('flightMode', 0, { syncUi: true });
        applyParamChange?.('rapidity', 0.25, { syncUi: true });
      } else if (simId === 'blackhole') {
        state.autoOrbit = false;
      }
    }
  }

  function restoreMotionAfterStop() {
    const state = getState();
    if (state) {
      state.autoOrbit = savedAutoOrbit;
      state.paused = savedPaused;
    }
  }

  function applyScriptedStep(u) {
    const camera = getCamera();
    if (mode === 'turntable') {
      applyTurntablePose(simId, camera, startCamera, u);
      return;
    }
    if (mode === 'evolution') {
      if (simId === 'warp') {
        const speed = 0.6 + 2.9 * Math.max(0, Math.min(1, u));
        applyParamChange?.('warpSpeed', speed, { syncUi: true });
      } else if (simId === 'starflight') {
        const eta = 0.25 + 3.95 * Math.max(0, Math.min(1, u));
        applyParamChange?.('rapidity', eta, { syncUi: true });
      } else if (simId === 'tde') {
        const phase = 0.08 + 0.88 * Math.max(0, Math.min(1, u));
        applyParamChange?.('tdePhase', phase, { syncUi: true });
      } else if (simId === 'blackhole' && startCamera && camera?.setImmediate) {
        const baseEl = Number(startCamera.elevationDeg) || 12;
        camera.setImmediate({
          azimuthDeg: (Number(startCamera.azimuthDeg) || 0) + u * 220.0,
          elevationDeg: Math.max(-75, Math.min(75, baseEl + Math.sin(u * Math.PI) * 14.0)),
        });
      }
    }
  }

  async function runDeterministicFramesSequence() {
    const renderer = getRenderer();
    if (!renderer) {
      active = false;
      emitState();
      return { ok: false, error: 'Renderer unavailable.' };
    }

    const dt = 1 / fps;
    const entries = [];
    const maxFrames = Math.min(MAX_SEQUENCE_FRAMES, Math.max(2, Math.round(durationSec * fps)));
    totalFrames = maxFrames;
    frameIndex = 0;
    elapsedSec = 0;
    emitState();

    try {
      for (let i = 0; i < maxFrames; i++) {
        if (abortRequested) break;
        const u = maxFrames > 1 ? i / (maxFrames - 1) : 1;
        applyScriptedStep(u);
        if (typeof stepSimulation === 'function') {
          stepSimulation(dt);
        } else if (typeof getSimTime === 'function' && typeof setSimTime === 'function') {
          setSimTime(getSimTime() + dt);
        }
        renderImmediate({ dt, isMotion: true, forceComposite: true });

        const state = getState();
        const camera = getCamera();
        const camMatrices = camera?.getCameraMatrices?.() || camera?.getMatrices?.();
        const blob = await renderer.capturePNG(state, camMatrices, getSimTime?.() ?? 0);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const padded = String(i + 1).padStart(4, '0');
        entries.push({ name: `frame_${padded}.png`, data: bytes });
        frameIndex = i + 1;
        elapsedSec = frameIndex * dt;
        emitState();

        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      if (entries.length > 0) {
        const manifest = {
          simId,
          backend: getBackend?.() || 'webgl2',
          presetId: getState()?.presetId || 'custom',
          mode,
          fps,
          frameCount: entries.length,
          width: renderer.width,
          height: renderer.height,
          ffmpegCommand: `ffmpeg -framerate ${fps} -i frame_%04d.png -c:v libx264 -crf 16 -pix_fmt yuv420p ${screenshotPrefix}-${mode}.mp4`,
        };
        entries.push({
          name: 'manifest.json',
          data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        });

        const zipBytes = buildStoreZip(entries);
        const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
        const filename = `${screenshotPrefix}-${mode}-${getBackend?.() || 'webgl2'}-${getState()?.presetId || 'custom'}-${makeTimestamp()}.zip`;
        downloadBlob(zipBlob, filename);
        onToast(`Saved ${entries.length - 1} PNG frames → ${filename}`);
      }
      return { ok: true, frameCount: entries.length - 1, format: 'frames' };
    } catch (err) {
      onToast(`Frame sequence export failed: ${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      active = false;
      abortRequested = false;
      restoreMotionAfterStop();
      emitState();
    }
  }

  function startWebmRecording() {
    const canvas = getCanvas();
    const mimeType = pickWebmMimeType();
    if (!canvas || typeof canvas.captureStream !== 'function' || !mimeType) {
      onToast('WebM MediaRecorder unavailable here — use PNG Zip format.');
      return { ok: false, error: 'MediaRecorder/captureStream unavailable.' };
    }

    try {
      mediaStream = canvas.captureStream(fps);
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType,
        videoBitsPerSecond: 12_000_000,
      });
      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunks.push(ev.data);
        }
      };
      mediaRecorder.onstop = () => {
        const chunks = recordedChunks;
        recordedChunks = [];
        try {
          mediaStream?.getTracks?.().forEach((t) => t.stop());
        } catch {
          // ignore
        }
        mediaStream = null;
        mediaRecorder = null;
        active = false;
        abortRequested = false;
        restoreMotionAfterStop();
        emitState();

        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: mimeType });
          const filename = `${screenshotPrefix}-${mode}-${getBackend?.() || 'webgl2'}-${getState()?.presetId || 'custom'}-${makeTimestamp()}.webm`;
          downloadBlob(blob, filename);
          onToast(`Saved WebM cinema clip → ${filename}`);
        }
      };

      active = true;
      abortRequested = false;
      elapsedSec = 0;
      frameIndex = 0;
      totalFrames = Math.round(durationSec * fps);
      setupMotionForStart(mode);
      mediaRecorder.start(250);
      emitState();
      onToast(`Recording ${durationSec}s ${mode} WebM…`);
      return { ok: true, format: 'webm', mimeType };
    } catch (err) {
      active = false;
      mediaRecorder = null;
      mediaStream = null;
      restoreMotionAfterStop();
      emitState();
      onToast(`WebM recording failed: ${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    }
  }

  return {
    start(opts = {}) {
      if (active) return Promise.resolve({ ok: false, error: 'Recorder already active.' });
      if (opts.mode && RECORDER_MODES.some((m) => m.id === opts.mode)) mode = opts.mode;
      if (opts.format && RECORDER_FORMATS.some((f) => f.id === opts.format)) format = opts.format;
      if (Number.isFinite(Number(opts.durationSec))) {
        durationSec = Math.max(2, Math.min(30, Math.round(Number(opts.durationSec))));
      }
      if (Number.isFinite(Number(opts.fps))) {
        fps = Math.max(15, Math.min(60, Math.round(Number(opts.fps))));
      }

      if (format === 'frames') {
        active = true;
        abortRequested = false;
        setupMotionForStart(mode);
        return runDeterministicFramesSequence();
      }
      return Promise.resolve(startWebmRecording());
    },

    stop() {
      if (!active) return false;
      abortRequested = true;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      return true;
    },

    configure(opts = {}) {
      if (opts.mode && RECORDER_MODES.some((m) => m.id === opts.mode)) mode = opts.mode;
      if (opts.format && RECORDER_FORMATS.some((f) => f.id === opts.format)) format = opts.format;
      if (Number.isFinite(Number(opts.durationSec))) {
        durationSec = Math.max(2, Math.min(30, Math.round(Number(opts.durationSec))));
      }
      if (Number.isFinite(Number(opts.fps))) {
        fps = Math.max(15, Math.min(60, Math.round(Number(opts.fps))));
      }
      emitState();
      return snapshotState();
    },

    tick(dt) {
      if (!active || format !== 'webm') return;
      elapsedSec += Math.max(0, dt);
      frameIndex = Math.min(totalFrames, Math.round(elapsedSec * fps));
      const u = durationSec > 0 ? Math.min(1, elapsedSec / durationSec) : 1;
      applyScriptedStep(u);
      emitState();
      if (elapsedSec >= durationSec) {
        this.stop();
      }
    },

    isRecording() {
      return active;
    },

    getState() {
      return snapshotState();
    },

    dispose() {
      this.stop();
    },
  };
}
