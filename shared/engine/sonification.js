/**
 * sonification.js — Zero-dependency Web Audio API astrophysics sonification engine
 * for Binary Black Hole 2.5PN gravitational-wave chirps and Pulsar beam-sweep pulse trains.
 */

const TAU = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Computes deterministic Web Audio synthesis parameters for Binary Black Hole
 * 2.5PN Peters-Mathews inspiral + QNM ringdown chirp sonification.
 *
 * @param {object} binState
 * @param {object} [state]
 */
export function computeBinaryAudioParams(binState = {}, state = {}) {
  const paused = Boolean(state?.paused);
  const d = clamp(Number.isFinite(binState?.d) ? binState.d : 7.4, 1.5, 24.0);
  const eta = clamp(Number.isFinite(binState?.eta) ? binState.eta : 0.25, 0.02, 0.25);
  const ringdownFactor = clamp(
    Number.isFinite(binState?.ringdownFactor) ? binState.ringdownFactor : 0.0,
    0.0,
    1.0
  );
  const gwAmplitude = clamp(
    Number.isFinite(state?.gwAmplitude) ? state.gwAmplitude : 0.75,
    0.0,
    3.0
  );
  const gwPhaseRad = Number.isFinite(binState?.gwPhaseRad)
    ? binState.gwPhaseRad
    : 2.0 * (Number(binState?.phaseRad) || 0.0);
  const fGwHz = Number.isFinite(binState?.fGwHz) ? binState.fGwHz : 0.0;

  // Monotonic Keplerian chirp law: f_audio scales cleanly as d^(-3/2) into [38, 340] Hz
  const chirpRaw = 26.0 + 920.0 / Math.pow(d, 1.5) + ringdownFactor * 82.0;
  const freqHz = clamp(chirpRaw, 38.0, 340.0);
  const harmonicHz = freqHz * 2.0;

  // Quadrupole strain h ~ (4 * eta) / d modulated by user GW amplitude slider
  const strainScale = clamp((4.0 * eta) * (7.4 / d) * (0.45 + 0.32 * gwAmplitude), 0.06, 1.0);
  const active = !paused;
  const gain = active ? clamp(0.15 * strainScale + 0.14 * ringdownFactor, 0.025, 0.34) : 0.0;
  const ringdownGain = active ? clamp(ringdownFactor * 0.24, 0.0, 0.24) : 0.0;
  const filterCutoffHz = clamp(freqHz * 3.6 + ringdownFactor * 520.0, 140.0, 2200.0);
  const stereoPan = clamp(0.26 * Math.sin(gwPhaseRad), -0.35, 0.35);

  return {
    active,
    freqHz,
    harmonicHz,
    gain,
    ringdownGain,
    filterCutoffHz,
    stereoPan,
    fGwHz,
    separationM: d,
    ringdownFactor,
  };
}

/**
 * Computes deterministic Web Audio beam-sweep pulse train parameters for the
 * Magnetar & Millisecond Pulsar simulator from spinPhase, obliquityDeg, spinPeriodMs,
 * and observer camera direction.
 *
 * @param {object} pulsarTel
 * @param {object} [state]
 * @param {object} [camData]
 */
export function computePulsarAudioParams(pulsarTel = {}, state = {}, camData = null) {
  const paused = Boolean(state?.paused);
  const obliquityDeg = clamp(
    Number.isFinite(state?.obliquityDeg) ? state.obliquityDeg : 45.0,
    0.0,
    90.0
  );
  const obliquityRad = Number.isFinite(pulsarTel?.obliquityRad)
    ? pulsarTel.obliquityRad
    : (obliquityDeg * Math.PI) / 180.0;
  const spinPhase = Number.isFinite(state?.spinPhase) ? state.spinPhase : 0.0;
  const spinPeriodMs = clamp(
    Number.isFinite(pulsarTel?.spinPeriodMs)
      ? pulsarTel.spinPeriodMs
      : Number.isFinite(state?.spinPeriodMs)
        ? state.spinPeriodMs
        : 33.0,
    1.4,
    500.0
  );
  const spinFreqHz = Number.isFinite(pulsarTel?.spinFreqHz)
    ? pulsarTel.spinFreqHz
    : 1000.0 / spinPeriodMs;
  const omegaVis = Number.isFinite(pulsarTel?.omegaVis) ? pulsarTel.omegaVis : 1.0;
  const beamIntensity = clamp(
    Number.isFinite(state?.beamIntensity) ? state.beamIntensity : 1.35,
    0.0,
    2.5
  );
  const coneHalfAngle = clamp(
    Number.isFinite(state?.beamConeHalfAngle) ? state.beamConeHalfAngle : 0.30,
    0.12,
    0.65
  );

  // Unit vector pointing from neutron star toward observer camera
  let cx = 0.0;
  let cy = 0.25;
  let cz = 0.968;
  const pos = camData?.pos;
  if (Array.isArray(pos) && pos.length >= 3) {
    const len = Math.hypot(pos[0], pos[1], pos[2]);
    if (len > 1e-5) {
      cx = pos[0] / len;
      cy = pos[1] / len;
      cz = pos[2] / len;
    }
  }

  // Matches pulsar.wgsl rotateY(+spinPhase) applied to body dipole axis (sinObl, cosObl, 0)
  const sinObl = Math.sin(obliquityRad);
  const cosObl = Math.cos(obliquityRad);
  const cosP = Math.cos(spinPhase);
  const sinP = Math.sin(spinPhase);
  const muX = cosP * sinObl;
  const muY = cosObl;
  const muZ = -sinP * sinObl;

  // Observer sightline alignment with North (+mu) and South (-mu) magnetic poles
  const cosNorth = clamp(muX * cx + muY * cy + muZ * cz, -1.0, 1.0);
  const cosSouth = -cosNorth;

  const sigma = Math.max(coneHalfAngle * 1.15, 0.24);
  const angN = Math.acos(cosNorth);
  const angS = Math.acos(cosSouth);
  const mainBeam = Math.exp(-0.5 * (angN / sigma) * (angN / sigma));
  const interBeam = 0.72 * Math.exp(-0.5 * (angS / (sigma * 1.1)) * (angS / (sigma * 1.1)));

  // Soft baseline + crisp lighthouse peak envelope
  const beamFactor = clamp(beamIntensity / 1.35, 0.0, 1.8);
  const pulseEnvelope = clamp(mainBeam * beamFactor, 0.0, 1.0);
  const interpulseEnvelope = clamp(interBeam * beamFactor, 0.0, 1.0);
  const peakPulse = Math.max(pulseEnvelope, interpulseEnvelope);

  // Carrier pitch tracks spin rate log-compressed so MSPs whine higher than slow magnetars
  const carrierHz = clamp(
    95.0 + 48.0 * Math.log2(1.0 + spinFreqHz / 6.0) + peakPulse * 95.0,
    95.0,
    780.0
  );
  const active = !paused;
  const masterGain = active ? clamp((0.02 + 0.26 * peakPulse) * Math.min(beamFactor, 1.3), 0.0, 0.34) : 0.0;
  const noiseGain = active ? clamp((0.015 + 0.24 * peakPulse) * Math.min(beamFactor, 1.3), 0.0, 0.30) : 0.0;
  const filterCutoffHz = clamp(420.0 + peakPulse * 2600.0, 320.0, 3600.0);

  // Tangential sweep across sightline drives subtle stereo sweep as beam passes
  const crossY = cx * muZ - cz * muX;
  const stereoPan = clamp(crossY * 0.45, -0.45, 0.45);
  const sweepRateHz = omegaVis / TAU;

  return {
    active,
    pulseEnvelope,
    interpulseEnvelope,
    peakPulse,
    carrierHz,
    noiseGain,
    masterGain,
    filterCutoffHz,
    stereoPan,
    sweepRateHz,
    spinFreqHz,
    spinPeriodMs,
  };
}

function createNoiseBuffer(ctx, durationSec = 2.0) {
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.max(1024, Math.floor(sampleRate * durationSec));
  const buf = ctx.createBuffer(1, length, sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic pink-tinted noise so radio bursts sound rich without harsh aliasing
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let seed = 0x13579bdf;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2.0 - 1.0;
    b0 = 0.997 * b0 + white * 0.029;
    b1 = 0.985 * b1 + white * 0.032;
    b2 = 0.950 * b2 + white * 0.048;
    data[i] = clamp((b0 + b1 + b2 + white * 0.18) * 1.4, -1.0, 1.0);
  }
  return buf;
}

/**
 * Creates a lazy Web Audio synthesizer bound to simulator telemetry frames.
 *
 * @param {{ simId: string, onStateChange?: (s: object) => void }} opts
 */
export function createSonificationEngine({ simId, onStateChange = null } = {}) {
  let enabled = false;
  let volume = 0.55;
  let audioCtx = null;
  let nodes = null;
  let disposed = false;
  let lastReadout = '';

  function getAudioCtor() {
    if (typeof window === 'undefined') return null;
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function ensureGraph() {
    if (nodes || disposed) return Boolean(nodes);
    const Ctor = getAudioCtor();
    if (!Ctor) return false;
    try {
      audioCtx = new Ctor();
    } catch {
      return false;
    }

    const masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.0;
    const panner =
      typeof audioCtx.createStereoPanner === 'function' ? audioCtx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = 0.0;
      panner.connect(masterGain);
    }
    masterGain.connect(audioCtx.destination);
    const targetInput = panner || masterGain;

    const filter = audioCtx.createBiquadFilter();
    filter.type = simId === 'pulsar' ? 'bandpass' : 'lowpass';
    filter.frequency.value = simId === 'pulsar' ? 900.0 : 320.0;
    filter.Q.value = simId === 'pulsar' ? 2.2 : 1.1;
    filter.connect(targetInput);

    if (simId === 'pulsar') {
      const noiseSrc = audioCtx.createBufferSource();
      noiseSrc.buffer = createNoiseBuffer(audioCtx, 2.0);
      noiseSrc.loop = true;
      const noiseGain = audioCtx.createGain();
      noiseGain.gain.value = 0.0;
      noiseSrc.connect(noiseGain);
      noiseGain.connect(filter);

      const toneOsc = audioCtx.createOscillator();
      toneOsc.type = 'triangle';
      toneOsc.frequency.value = 140.0;
      const toneGain = audioCtx.createGain();
      toneGain.gain.value = 0.0;
      toneOsc.connect(toneGain);
      toneGain.connect(targetInput);

      noiseSrc.start();
      toneOsc.start();
      nodes = { masterGain, panner, filter, noiseSrc, noiseGain, toneOsc, toneGain };
    } else {
      // Binary 2.5PN quadrupole chirp + 2nd harmonic + sub-bass + ringdown bell
      const oscFund = audioCtx.createOscillator();
      oscFund.type = 'sine';
      oscFund.frequency.value = 72.0;

      const oscHarm = audioCtx.createOscillator();
      oscHarm.type = 'triangle';
      oscHarm.frequency.value = 144.0;
      const harmGain = audioCtx.createGain();
      harmGain.gain.value = 0.28;

      const oscRing = audioCtx.createOscillator();
      oscRing.type = 'sine';
      oscRing.frequency.value = 240.0;
      const ringGain = audioCtx.createGain();
      ringGain.gain.value = 0.0;

      oscFund.connect(filter);
      oscHarm.connect(harmGain);
      harmGain.connect(filter);
      oscRing.connect(ringGain);
      ringGain.connect(targetInput);

      oscFund.start();
      oscHarm.start();
      oscRing.start();
      nodes = { masterGain, panner, filter, oscFund, oscHarm, harmGain, oscRing, ringGain };
    }

    return true;
  }

  function emitState() {
    onStateChange?.(getState());
  }

  function getState() {
    return {
      supported: Boolean(getAudioCtor()),
      enabled,
      volume,
      contextState: audioCtx ? audioCtx.state : 'uninitialized',
      readout: lastReadout,
    };
  }

  function setEnabled(next) {
    if (disposed) return false;
    const want = Boolean(next);
    if (want) {
      if (!ensureGraph()) {
        enabled = false;
        emitState();
        return false;
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => {});
      }
      enabled = true;
    } else {
      enabled = false;
      if (nodes && audioCtx) {
        const now = audioCtx.currentTime;
        nodes.masterGain.gain.setTargetAtTime(0.0, now, 0.03);
      }
    }
    emitState();
    return enabled;
  }

  function toggle(explicit) {
    return setEnabled(typeof explicit === 'boolean' ? explicit : !enabled);
  }

  function setVolume(v) {
    const num = Number(v);
    if (Number.isFinite(num)) {
      volume = clamp(num, 0.0, 1.0);
    }
    emitState();
    return volume;
  }

  function update(payload = {}) {
    if (disposed) return;

    if (simId === 'pulsar') {
      const p = computePulsarAudioParams(payload.pulsarTel, payload.state, payload.camData);
      lastReadout = p.active
        ? `Sweep ${p.sweepRateHz.toFixed(2)} Hz · Carrier ${Math.round(p.carrierHz)} Hz · Beam ${(p.peakPulse * 100).toFixed(0)}%`
        : 'Paused · Sweep muted';
      if (!enabled || !nodes || !audioCtx) return;
      const now = audioCtx.currentTime;
      const vol = volume * 0.9;
      nodes.filter.frequency.setTargetAtTime(p.filterCutoffHz, now, 0.025);
      nodes.toneOsc.frequency.setTargetAtTime(p.carrierHz, now, 0.025);
      nodes.toneGain.gain.setTargetAtTime(p.masterGain * vol * 0.55, now, 0.02);
      nodes.noiseGain.gain.setTargetAtTime(p.noiseGain * vol, now, 0.02);
      nodes.masterGain.gain.setTargetAtTime(p.active ? volume : 0.0, now, 0.025);
      if (nodes.panner) {
        nodes.panner.pan.setTargetAtTime(p.stereoPan, now, 0.03);
      }
      return;
    }

    const b = computeBinaryAudioParams(payload.binState, payload.state);
    lastReadout = b.active
      ? `Chirp ${Math.round(b.freqHz)} Hz · d=${b.separationM.toFixed(2)}M · f_GW ${b.fGwHz.toFixed(0)} Hz`
      : 'Paused · Chirp muted';
    if (!enabled || !nodes || !audioCtx) return;
    const now = audioCtx.currentTime;
    const vol = volume;
    nodes.oscFund.frequency.setTargetAtTime(b.freqHz, now, 0.03);
    nodes.oscHarm.frequency.setTargetAtTime(b.harmonicHz, now, 0.03);
    nodes.oscRing.frequency.setTargetAtTime(Math.min(b.freqHz * 2.4, 580.0), now, 0.03);
    nodes.filter.frequency.setTargetAtTime(b.filterCutoffHz, now, 0.03);
    nodes.ringGain.gain.setTargetAtTime(b.ringdownGain * vol, now, 0.03);
    nodes.masterGain.gain.setTargetAtTime(b.gain * vol, now, 0.03);
    if (nodes.panner) {
      nodes.panner.pan.setTargetAtTime(b.stereoPan, now, 0.04);
    }
  }

  function dispose() {
    disposed = true;
    enabled = false;
    if (nodes) {
      try {
        nodes.noiseSrc?.stop?.();
        nodes.toneOsc?.stop?.();
        nodes.oscFund?.stop?.();
        nodes.oscHarm?.stop?.();
        nodes.oscRing?.stop?.();
      } catch {
        // Ignore stopped oscillator errors
      }
      nodes = null;
    }
    if (audioCtx) {
      void audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  return {
    toggle,
    setEnabled,
    setVolume,
    update,
    getState,
    dispose,
  };
}
