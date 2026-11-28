/**
 * ControlsHUD.js — Observatory HUD, compact TDE telemetry bar, preset/transport dock,
 * and collapsible Tidal Stream & Kerr Shock controls drawer for sims/tde/.
 */

const CONTROL_SECTIONS = [
  {
    id: 'encounter',
    title: 'SMBH & Tidal Encounter',
    open: true,
    controls: [
      {
        type: 'range',
        key: 'spin',
        label: 'Kerr Spin (a/M)',
        min: 0.0,
        max: 0.998,
        step: 0.002,
        format: (v) => v.toFixed(3),
      },
      {
        type: 'range',
        key: 'bhMassM6',
        label: 'SMBH Mass (M_BH)',
        min: 0.2,
        max: 120.0,
        step: 0.2,
        hints: ['0.2×10⁶M☉', '120×10⁶M☉'],
        format: (v) => `${v.toFixed(1)}×10⁶M☉`,
      },
      {
        type: 'range',
        key: 'beta',
        label: 'Penetration (β = r_t/r_p)',
        min: 0.4,
        max: 6.5,
        step: 0.05,
        hints: ['Grazing 0.4', 'Deep 6.5'],
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'starMassSolar',
        label: 'Star Mass (M★)',
        min: 0.2,
        max: 10.0,
        step: 0.1,
        format: (v) => `${v.toFixed(1)} M☉`,
      },
      {
        type: 'range',
        key: 'tdePhase',
        label: 'Disruption Stage (τ)',
        min: 0.02,
        max: 1.0,
        step: 0.01,
        hints: ['Tidal Rip', 'Circularized'],
        format: (v) => `${Math.round(v * 100)}%`,
      },
      {
        type: 'range',
        key: 'streamTiltDeg',
        label: 'Orbital Inclination Tilt',
        min: -35.0,
        max: 35.0,
        step: 0.5,
        format: (v) => `${v.toFixed(1)}°`,
      },
      {
        type: 'range',
        key: 'lensingStrength',
        label: 'Gravitational Lensing',
        min: 0.0,
        max: 1.0,
        step: 0.01,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'relativisticMode',
        label: 'Doppler Beaming',
        min: 0.0,
        max: 1.0,
        step: 0.01,
        hints: ['Cinematic', 'Physical Exact'],
        format: (v) => `${Math.round(v * 100)}%`,
      },
    ],
  },
  {
    id: 'stream',
    title: 'Debris Stream, Shock & Jet',
    open: true,
    controls: [
      {
        type: 'range',
        key: 'streamDensity',
        label: 'Tidal Stream Density',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'shockIntensity',
        label: 'Self-Intersection Shock',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'diskDensity',
        label: 'Circularized Disk Density',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'diskTemp',
        label: 'Disk Peak Temperature',
        min: 4000,
        max: 24000,
        step: 200,
        format: (v) => `${Math.round(v).toLocaleString('en-US')} K`,
      },
      {
        type: 'range',
        key: 'jetIntensity',
        label: 'Relativistic Jet Power',
        min: 0.0,
        max: 1.8,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'flowSpeed',
        label: 'Stream Fallback Flow',
        min: 0.0,
        max: 3.0,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
      },
    ],
  },
  {
    id: 'optics',
    title: 'Optics, Sky & Quality',
    open: true,
    controls: [
      {
        type: 'range',
        key: 'exposure',
        label: 'Exposure',
        min: 0.3,
        max: 3.0,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'bloomIntensity',
        label: 'HDR Bloom',
        min: 0.0,
        max: 1.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'anamorphicIntensity',
        label: 'Anamorphic Streak',
        min: 0.0,
        max: 1.2,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'skyIntensity',
        label: 'Sky Brightness',
        min: 0.0,
        max: 3.0,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'select',
        key: 'skyMode',
        label: 'Background Sky Source',
        options: [
          { value: 0, label: 'Hybrid 4K + Micro-Stars' },
          { value: 1, label: '4K NASA/ESO Map' },
          { value: 2, label: 'Procedural Deep Field' },
        ],
      },
      {
        type: 'segmented',
        key: 'quality',
        label: 'Ray-Trace Quality',
        options: [
          { value: 0, label: 'Medium' },
          { value: 1, label: 'High' },
          { value: 2, label: 'Ultra Cinema' },
        ],
      },
      {
        type: 'segmented',
        key: 'resolutionScale',
        label: 'Render Resolution',
        options: [
          { value: 0.5, label: '0.5×' },
          { value: 0.75, label: '0.75×' },
          { value: 1.0, label: '1.0×' },
        ],
      },
      {
        type: 'segmented',
        key: 'backend',
        label: 'Rendering Backend',
        options: [
          { value: 'webgl2', label: 'WebGL2' },
          { value: 'webgpu', label: 'WebGPU' },
        ],
        statusNoteId: 'backend-status-note',
      },
    ],
  },
];

function syncRangeVisuals(input, valueEl, format) {
  const numeric = Number(input.value);
  const formatted = format(numeric);
  input.style.setProperty('--attr-min', input.min || '0');
  input.style.setProperty('--attr-max', input.max || '1');
  input.style.setProperty('--control-value', String(numeric));
  input.setAttribute('aria-valuetext', formatted);
  valueEl.textContent = formatted;
}

function compactPresetLabel(preset, fallbackId) {
  if (preset.shortName) return preset.shortName;
  if (preset.label) return preset.label;
  const raw = preset.name || fallbackId;
  return raw.split(/\s+/).slice(0, 2).join(' ');
}

function setTextIfChanged(el, cache, key, nextText) {
  if (!el || cache[key] === nextText) return;
  cache[key] = nextText;
  el.textContent = nextText;
}

export function createHUD({
  state = {},
  presets = [],
  onParamChange = () => {},
  onPresetSelect = () => {},
  onAction = () => {},
} = {}) {
  const hudChrome = document.getElementById('hud-chrome');
  const controlsToggle = document.getElementById('controls-toggle');
  const controlsClose = document.getElementById('controls-close');
  const controlsDrawer = document.getElementById('controls-drawer');
  const controlsSections = document.getElementById('controls-sections');
  const presetList = document.getElementById('preset-list');

  const presetBadge = document.getElementById('hud-preset-badge');
  const skyBadge = document.getElementById('hud-sky-badge');

  const telTidalRadius = document.getElementById('tel-tidal-radius');
  const telPericenter = document.getElementById('tel-pericenter');
  const telPrecession = document.getElementById('tel-precession');
  const telFallback = document.getElementById('tel-fallback');
  const telHills = document.getElementById('tel-hills');
  const telFrame = document.getElementById('tel-frame');

  const drawerPhysicsMeta = document.getElementById('drawer-physics-meta');
  const drawerRendererName = document.getElementById('drawer-renderer-name');

  const btnPlayPause = document.getElementById('btn-play-pause');
  const labelPlayPause = document.getElementById('label-play-pause');
  const btnDisrupt = document.getElementById('btn-disrupt');
  const btnAutoOrbit = document.getElementById('btn-auto-orbit');
  const btnResetCam = document.getElementById('btn-reset-cam');
  const btnCapturePng = document.getElementById('btn-capture-png');
  const btnHideHud = document.getElementById('btn-hide-hud');
  const btnHideUi = document.getElementById('btn-hide-ui');
  const btnRestoreHud = document.getElementById('btn-restore-hud');

  const loadingIndicator = document.getElementById('loading-indicator');
  const loadingMessage = document.getElementById('loading-message');
  const errorNotice = document.getElementById('webgl-error');
  const errorMessage = document.getElementById('webgl-error-message');

  const controlBindings = new Map();
  const presetButtons = new Map();
  const presetMeta = new Map();
  const textCache = Object.create(null);

  let drawerOpen = false;
  let hudVisible = true;
  let lastHideTrigger = btnHideUi || btnHideHud;

  function setDrawerOpen(open, { returnFocus = false } = {}) {
    drawerOpen = Boolean(open);
    controlsDrawer.classList.toggle('is-open', drawerOpen);
    controlsDrawer.setAttribute('aria-hidden', drawerOpen ? 'false' : 'true');
    controlsDrawer.inert = !drawerOpen;
    controlsToggle.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    if (drawerOpen) {
      controlsClose.focus({ preventScroll: true });
    } else if (returnFocus && hudVisible) {
      controlsToggle.focus({ preventScroll: true });
    }
  }

  function buildControls() {
    controlsSections.textContent = '';
    for (const section of CONTROL_SECTIONS) {
      const details = document.createElement('details');
      details.className = 'control-section';
      details.open = Boolean(section.open);
      const summary = document.createElement('summary');
      const titleSpan = document.createElement('span');
      titleSpan.textContent = section.title;
      summary.appendChild(titleSpan);
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'section-body';
      for (const spec of section.controls) {
        const row = document.createElement('div');
        row.className = 'control-row';
        const controlId = `ctrl-${spec.key}`;
        if (spec.type === 'range') {
          const labelRow = document.createElement('div');
          labelRow.className = 'control-label-row';
          const label = document.createElement('label');
          label.className = 'control-label';
          label.htmlFor = controlId;
          label.textContent = spec.label;
          const valueEl = document.createElement('output');
          valueEl.className = 'control-value tabular';
          valueEl.htmlFor = controlId;
          labelRow.append(label, valueEl);
          row.appendChild(labelRow);

          const input = document.createElement('input');
          input.type = 'range';
          input.id = controlId;
          input.className = 'hud-slider';
          input.min = String(spec.min);
          input.max = String(spec.max);
          input.step = String(spec.step);
          input.value = String(state[spec.key] ?? spec.min);
          syncRangeVisuals(input, valueEl, spec.format);
          input.addEventListener('input', () => {
            syncRangeVisuals(input, valueEl, spec.format);
            onParamChange(spec.key, Number(input.value));
          });
          row.appendChild(input);

          if (spec.hints) {
            const hintsRow = document.createElement('div');
            hintsRow.className = 'control-scale-hints';
            const left = document.createElement('span');
            left.textContent = spec.hints[0];
            const right = document.createElement('span');
            right.textContent = spec.hints[1];
            hintsRow.append(left, right);
            row.appendChild(hintsRow);
          }

          controlBindings.set(spec.key, {
            type: 'range',
            set(val) {
              if (val === undefined || val === null) return;
              input.value = String(val);
              syncRangeVisuals(input, valueEl, spec.format);
            },
          });
        } else if (spec.type === 'select') {
          const label = document.createElement('label');
          label.className = 'control-label';
          label.htmlFor = controlId;
          label.textContent = spec.label;
          row.appendChild(label);

          const select = document.createElement('select');
          select.id = controlId;
          select.className = 'hud-select';
          for (const opt of spec.options) {
            const o = document.createElement('option');
            o.value = String(opt.value);
            o.textContent = opt.label;
            select.appendChild(o);
          }
          if (state[spec.key] !== undefined) select.value = String(state[spec.key]);
          select.addEventListener('change', () => onParamChange(spec.key, Number(select.value)));
          row.appendChild(select);
          controlBindings.set(spec.key, {
            type: 'select',
            set(val) {
              if (val === undefined || val === null) return;
              select.value = String(val);
            },
          });
        } else if (spec.type === 'segmented') {
          const labelId = `${controlId}-label`;
          const label = document.createElement('span');
          label.id = labelId;
          label.className = 'control-label';
          label.textContent = spec.label;
          row.appendChild(label);

          const group = document.createElement('div');
          group.id = controlId;
          group.className = 'segmented-group';
          group.style.setProperty('--seg-cols', String(spec.options.length));
          group.setAttribute('role', 'radiogroup');
          group.setAttribute('aria-labelledby', labelId);

          const buttons = [];
          const matchesOption = (a, b) =>
            typeof a === 'number' ? Math.abs(a - Number(b)) < 1e-4 : String(a) === String(b);

          const selectSegment = (val, emit) => {
            let matched = null;
            for (const entry of buttons) {
              const active = matchesOption(entry.value, val);
              entry.btn.setAttribute('aria-checked', active ? 'true' : 'false');
              if (active) matched = entry;
            }
            if (emit && matched && !matched.btn.disabled) {
              onParamChange(spec.key, matched.value);
            }
          };

          spec.options.forEach((opt) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = `${controlId}-${opt.value}`;
            btn.dataset.value = String(opt.value);
            btn.className = 'segmented-btn';
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', 'false');
            btn.textContent = opt.label;
            btn.addEventListener('click', () => {
              if (!btn.disabled) selectSegment(opt.value, true);
            });
            buttons.push({ btn, value: opt.value });
            group.appendChild(btn);
          });

          selectSegment(state[spec.key] ?? spec.options[0].value, false);
          row.appendChild(group);

          let statusEl = null;
          if (spec.statusNoteId) {
            statusEl = document.createElement('p');
            statusEl.id = spec.statusNoteId;
            statusEl.className = 'control-status-note';
            statusEl.setAttribute('role', 'status');
            statusEl.setAttribute('aria-live', 'polite');
            statusEl.hidden = true;
            row.appendChild(statusEl);
          }

          controlBindings.set(spec.key, {
            type: 'segmented',
            group,
            statusEl,
            set(val) {
              if (val === undefined || val === null) return;
              selectSegment(val, false);
            },
            setDisabled(dis) {
              group.setAttribute('aria-busy', dis ? 'true' : 'false');
              for (const entry of buttons) entry.btn.disabled = Boolean(dis);
            },
          });
        }
        body.appendChild(row);
      }
      details.appendChild(body);
      controlsSections.appendChild(details);
    }
  }

  function buildPresets() {
    presetList.textContent = '';
    presetButtons.clear();
    presetMeta.clear();
    presets.forEach((preset, index) => {
      const id = preset.id ?? String(index);
      const fullName = preset.name || id;
      const displayName = compactPresetLabel(preset, id);
      presetMeta.set(id, fullName);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-btn';
      btn.dataset.presetId = id;
      btn.setAttribute('aria-pressed', 'false');
      const keycap = document.createElement('kbd');
      keycap.className = 'keycap';
      keycap.textContent = String(preset.hotkey || index + 1);
      const text = document.createElement('span');
      text.textContent = displayName;
      btn.append(keycap, text);
      btn.addEventListener('click', () => onPresetSelect(id));
      presetButtons.set(id, btn);
      presetList.appendChild(btn);
    });
  }

  function syncTransportState(targetState) {
    if (!targetState) return;
    if ('paused' in targetState) {
      const isPaused = Boolean(targetState.paused);
      btnPlayPause.setAttribute('aria-pressed', isPaused ? 'true' : 'false');
      labelPlayPause.textContent = isPaused ? 'Resume' : 'Pause';
    }
    if ('autoOrbit' in targetState) {
      btnAutoOrbit.setAttribute('aria-pressed', targetState.autoOrbit ? 'true' : 'false');
    }
    if ('sweeping' in targetState && btnDisrupt) {
      btnDisrupt.setAttribute('aria-pressed', targetState.sweeping ? 'true' : 'false');
    }
  }

  function syncState(newState) {
    if (!newState || typeof newState !== 'object') return;
    for (const [key, binding] of controlBindings.entries()) {
      if (key in newState) binding.set(newState[key]);
    }
    syncTransportState(newState);
  }

  function setActivePreset(presetId) {
    for (const [id, btn] of presetButtons.entries()) {
      const active = id === presetId;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const label = presetMeta.get(presetId) || presetId || 'Custom';
    setTextIfChanged(presetBadge, textCache, 'presetBadge', label);
  }

  function setSkyStatus(text) {
    if (text) setTextIfChanged(skyBadge, textCache, 'skyBadge', String(text));
  }

  function updateTelemetry(tel = {}) {
    if (Number.isFinite(tel.rTidalRg) && Number.isFinite(tel.beta)) {
      setTextIfChanged(
        telTidalRadius,
        textCache,
        'tidal',
        `${tel.rTidalRg.toFixed(1)} (${tel.beta.toFixed(2)})`
      );
    }
    if (Number.isFinite(tel.rPeriRg)) {
      setTextIfChanged(telPericenter, textCache, 'peri', `${tel.rPeriRg.toFixed(1)} r_g`);
    }
    if (Number.isFinite(tel.precessDeg)) {
      setTextIfChanged(telPrecession, textCache, 'precess', `${tel.precessDeg.toFixed(1)}°`);
    }
    if (Number.isFinite(tel.eddingtonRatio)) {
      const val = tel.eddingtonRatio >= 100
        ? `${Math.round(tel.eddingtonRatio)}×`
        : `${tel.eddingtonRatio.toFixed(1)}×`;
      setTextIfChanged(telFallback, textCache, 'fallback', val);
    }
    if (Number.isFinite(tel.hillsMassM6)) {
      const tag = tel.swallowedDirect ? 'SWALLOW' : `${tel.hillsMassM6.toFixed(0)} M₆`;
      setTextIfChanged(telHills, textCache, 'hills', tag);
    }
    if (Number.isFinite(tel.fps) || Number.isFinite(tel.samples)) {
      const fpsStr = Number.isFinite(tel.fps) ? `${Math.round(tel.fps)}` : '--';
      const smpStr = Number.isFinite(tel.samples) ? `${tel.samples}/128` : '--';
      setTextIfChanged(telFrame, textCache, 'frame', `${fpsStr} · ${smpStr}`);
    }
    if (Number.isFinite(tel.horizonR) && Number.isFinite(tel.fallbackTimeDays)) {
      setTextIfChanged(
        drawerPhysicsMeta,
        textCache,
        'physicsMeta',
        `r+ ${tel.horizonR.toFixed(2)} M · t_fb ${tel.fallbackTimeDays.toFixed(0)} d`
      );
    }
    if (tel.rendererName) {
      setTextIfChanged(drawerRendererName, textCache, 'rendererName', String(tel.rendererName));
    }
  }

  function toggleHud(visible) {
    const next = typeof visible === 'boolean' ? visible : !hudVisible;
    const focusInside = hudChrome.contains(document.activeElement);
    const focusRestore = document.activeElement === btnRestoreHud;
    hudVisible = next;
    hudChrome.classList.toggle('is-hud-hidden', !hudVisible);
    hudChrome.inert = !hudVisible;
    btnRestoreHud.hidden = hudVisible;
    if (!hudVisible && drawerOpen) setDrawerOpen(false);
    if (!hudVisible && focusInside) btnRestoreHud.focus({ preventScroll: true });
    else if (hudVisible && focusRestore) (lastHideTrigger || btnHideUi || btnHideHud)?.focus({ preventScroll: true });
    return hudVisible;
  }

  function setLoading(isLoading, message) {
    loadingIndicator.hidden = !Boolean(isLoading);
    if (message) setTextIfChanged(loadingMessage, textCache, 'loading', String(message));
  }

  function setError(message) {
    if (!message) {
      errorNotice.hidden = true;
      return;
    }
    errorMessage.textContent = String(message);
    errorNotice.hidden = false;
  }

  controlsToggle.addEventListener('click', () => setDrawerOpen(!drawerOpen, { returnFocus: drawerOpen }));
  controlsClose.addEventListener('click', () => setDrawerOpen(false, { returnFocus: true }));
  controlsDrawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      e.stopPropagation();
      setDrawerOpen(false, { returnFocus: true });
    }
  });

  btnPlayPause.addEventListener('click', () => onAction('togglePause'));
  btnDisrupt?.addEventListener('click', () => onAction('disruptEvolve'));
  btnAutoOrbit.addEventListener('click', () => onAction('toggleAutoOrbit'));
  btnResetCam.addEventListener('click', () => onAction('resetCamera'));
  btnCapturePng.addEventListener('click', () => onAction('screenshot'));
  btnHideHud.addEventListener('click', () => {
    lastHideTrigger = btnHideHud;
    onAction('toggleHud');
  });
  btnHideUi?.addEventListener('click', () => {
    lastHideTrigger = btnHideUi;
    onAction('toggleHud');
  });
  btnRestoreHud.addEventListener('click', () => onAction('toggleHud'));

  function setBackendState({ backend, busy = false, statusNote = '' } = {}) {
    const binding = controlBindings.get('backend');
    if (!binding) return;
    if (backend) binding.set(backend);
    if (typeof binding.setDisabled === 'function') binding.setDisabled(Boolean(busy));
    if (binding.statusEl) {
      const note = String(statusNote || '').trim();
      binding.statusEl.textContent = note;
      binding.statusEl.hidden = !note;
    }
  }

  buildControls();
  buildPresets();
  syncState(state);
  setDrawerOpen(false);
  if (presets.length > 0) setActivePreset(state.presetId || presets[0].id);

  return {
    syncState,
    updateTelemetry,
    setActivePreset,
    setSkyStatus,
    setBackendState,
    toggleHud,
    setLoading,
    setError,
  };
}
