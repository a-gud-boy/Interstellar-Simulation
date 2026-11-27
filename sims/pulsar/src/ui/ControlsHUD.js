/**
 * ControlsHUD.js — Observatory HUD, compact relativistic pulsar telemetry bar,
 * preset/transport dock, and collapsible Magnetosphere & GR Optics drawer.
 */

const CONTROL_SECTIONS = [
  {
    id: 'spacetime',
    title: 'Spacetime & Spin',
    open: true,
    controls: [
      {
        type: 'segmented',
        key: 'lensingMode',
        label: 'Spacetime Curvature',
        options: [
          { value: 1, label: 'GR Curved' },
          { value: 0, label: 'Flat Space' },
        ],
      },
      {
        type: 'range',
        key: 'compactness',
        label: 'Compactness (M/R)',
        min: 0.12,
        max: 0.30,
        step: 0.005,
        hints: ['0.12 (17.2 km)', '0.30 (6.9 km)'],
        format: (v) => v.toFixed(3),
      },
      {
        type: 'range',
        key: 'spinPeriodMs',
        label: 'Spin Period (P)',
        min: 1.4,
        max: 500.0,
        step: 0.1,
        hints: ['1.4 ms (MSP)', '500 ms (Magnetar)'],
        format: (v) => (v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`),
      },
      {
        type: 'range',
        key: 'spinVisualSpeed',
        label: 'Spin Visual Speed',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
      },
    ],
  },
  {
    id: 'magnetosphere',
    title: 'Magnetosphere & PWN',
    open: true,
    controls: [
      {
        type: 'range',
        key: 'obliquityDeg',
        label: 'Magnetic Obliquity (α)',
        min: 0,
        max: 90,
        step: 1,
        hints: ['0° Aligned', '90° Orthogonal'],
        format: (v) => `${Math.round(v)}°`,
      },
      {
        type: 'range',
        key: 'twistShear',
        label: 'Magnetospheric Twist',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'beamIntensity',
        label: 'Lighthouse Beam Gain',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'plasmaDensity',
        label: 'Pair-Plasma Density',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'pwnVisibility',
        label: 'PWN Torus & Jets',
        min: 0.0,
        max: 2.0,
        step: 0.05,
        format: (v) => v.toFixed(2),
      },
      {
        type: 'range',
        key: 'magnetarCrackGlow',
        label: 'Magnetar Shear Arcs',
        min: 0.0,
        max: 2.5,
        step: 0.05,
        format: (v) => v.toFixed(2),
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
          { value: 0, label: '4K Milky Way' },
          { value: 1, label: 'Procedural' },
        ],
      },
      {
        type: 'segmented',
        key: 'quality',
        label: 'Ray-Trace Quality',
        options: [
          { value: 0, label: 'Performance' },
          { value: 1, label: 'Balanced' },
          { value: 2, label: 'Cinema' },
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
  const noParens = raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (noParens.length <= 14) return noParens;
  return noParens.split(/\s+/).slice(0, 2).join(' ');
}

function setTextIfChanged(el, cache, key, nextText) {
  if (!el || cache[key] === nextText) return;
  cache[key] = nextText;
  el.textContent = nextText;
}

function formatLightCylinder(rLightCylKm, rLightCylNorm) {
  if (!Number.isFinite(rLightCylKm)) return '--';
  const kmStr = rLightCylKm >= 10000
    ? `${(rLightCylKm / 1000).toFixed(1)}k km`
    : `${Math.round(rLightCylKm)} km`;
  if (!Number.isFinite(rLightCylNorm)) return kmStr;
  const normStr = rLightCylNorm >= 100
    ? `${Math.round(rLightCylNorm)} R*`
    : `${rLightCylNorm.toFixed(1)} R*`;
  return `${kmStr} / ${normStr}`;
}

function formatSpinFreq(freqHz) {
  if (!Number.isFinite(freqHz)) return '--';
  if (freqHz >= 10) return `${freqHz.toFixed(1)} Hz`;
  return `${freqHz.toFixed(2)} Hz`;
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

  const telRedshift = document.getElementById('tel-redshift');
  const telVisibleFrac = document.getElementById('tel-visible-frac');
  const telLightCyl = document.getElementById('tel-light-cyl');
  const telSpinFreq = document.getElementById('tel-spin-freq');
  const telCompactness = document.getElementById('tel-compactness');
  const telFrame = document.getElementById('tel-frame');

  const drawerPhysicsMeta = document.getElementById('drawer-physics-meta');
  const drawerRendererName = document.getElementById('drawer-renderer-name');

  const btnPlayPause = document.getElementById('btn-play-pause');
  const labelPlayPause = document.getElementById('label-play-pause');
  const btnAutoOrbit = document.getElementById('btn-auto-orbit');
  const btnResetCam = document.getElementById('btn-reset-cam') || document.getElementById('btn-reset-camera');
  const btnCapturePng = document.getElementById('btn-capture-png') || document.getElementById('btn-screenshot');
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

          const initialVal = state[spec.key] ?? spec.min;
          input.value = String(initialVal);
          syncRangeVisuals(input, valueEl, spec.format);

          input.addEventListener('input', () => {
            syncRangeVisuals(input, valueEl, spec.format);
            onParamChange(spec.key, Number(input.value));
          });

          row.appendChild(input);

          if (spec.hints) {
            const hintsRow = document.createElement('div');
            hintsRow.className = 'control-scale-hints';
            const leftHint = document.createElement('span');
            leftHint.textContent = spec.hints[0];
            const rightHint = document.createElement('span');
            rightHint.textContent = spec.hints[1];
            hintsRow.append(leftHint, rightHint);
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
            const optionEl = document.createElement('option');
            optionEl.value = String(opt.value);
            optionEl.textContent = opt.label;
            select.appendChild(optionEl);
          }

          if (state[spec.key] !== undefined) {
            select.value = String(state[spec.key]);
          }

          select.addEventListener('change', () => {
            onParamChange(spec.key, Number(select.value));
          });

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
          const matchesOption = (optVal, targetVal) => {
            if (typeof optVal === 'number') {
              return Math.abs(optVal - Number(targetVal)) < 1e-4;
            }
            return String(optVal) === String(targetVal);
          };

          const selectSegment = (val, emit) => {
            let matchedEntry = null;
            for (const entry of buttons) {
              const active = matchesOption(entry.value, val);
              entry.btn.setAttribute('aria-checked', active ? 'true' : 'false');
              if (active) matchedEntry = entry;
            }
            if (emit && matchedEntry && !matchedEntry.btn.disabled) {
              onParamChange(spec.key, matchedEntry.value);
            }
          };

          spec.options.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = `${controlId}-${opt.value}`;
            btn.dataset.value = String(opt.value);
            btn.className = 'segmented-btn';
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', 'false');
            btn.textContent = opt.label;

            btn.addEventListener('click', () => {
              if (!btn.disabled) {
                selectSegment(opt.value, true);
              }
            });
            btn.addEventListener('keydown', (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const next = buttons[(idx + 1) % buttons.length];
                next.btn.focus();
                if (!next.btn.disabled) selectSegment(next.value, true);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = buttons[(idx - 1 + buttons.length) % buttons.length];
                prev.btn.focus();
                if (!prev.btn.disabled) selectSegment(prev.value, true);
              }
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
            setDisabled(disabled) {
              const dis = Boolean(disabled);
              group.setAttribute('aria-busy', dis ? 'true' : 'false');
              for (const entry of buttons) {
                entry.btn.disabled = dis;
              }
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
      const fullName = preset.name || preset.label || id;
      const displayName = compactPresetLabel(preset, id);
      presetMeta.set(id, fullName);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-btn';
      btn.dataset.presetId = id;
      btn.setAttribute('aria-pressed', 'false');
      if (displayName !== fullName) {
        btn.setAttribute('aria-label', `${fullName} (Preset ${index + 1})`);
      }

      const keycap = document.createElement('kbd');
      keycap.className = 'keycap';
      keycap.textContent = String(preset.hotkey || index + 1);

      const text = document.createElement('span');
      text.textContent = displayName;

      btn.append(keycap, text);
      btn.addEventListener('click', () => {
        onPresetSelect(id);
      });

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
      const autoOrbit = Boolean(targetState.autoOrbit);
      btnAutoOrbit.setAttribute('aria-pressed', autoOrbit ? 'true' : 'false');
    }
  }

  function syncState(newState) {
    if (!newState || typeof newState !== 'object') return;
    for (const [key, binding] of controlBindings.entries()) {
      if (key in newState) {
        binding.set(newState[key]);
      }
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
    if (!text) return;
    setTextIfChanged(skyBadge, textCache, 'skyBadge', String(text));
  }

  function updateTelemetry(tel = {}, stateArg = null, diagArg = null) {
    const surfaceRedshiftZ = tel?.surfaceRedshiftZ;
    const visibleSurfaceFraction = tel?.visibleSurfaceFraction;
    const rLightCylKm = tel?.rLightCylKm;
    const rLightCylNorm = tel?.rLightCylNorm;
    const spinFreqHz = tel?.spinFreqHz;
    const compactness = tel?.compactness;
    const stellarRadiusKm = tel?.stellarRadiusKm;
    const lensingStrength = tel?.lensingStrength;

    const fps = diagArg?.fps ?? tel?.fps;
    const samples = diagArg?.samples ?? tel?.samples;
    const rendererName = diagArg?.gpuRenderer ?? diagArg?.webglRenderer ?? tel?.rendererName;
    const lensingMode = stateArg?.lensingMode ?? (Number.isFinite(lensingStrength) ? (lensingStrength > 0.5 ? 1 : 0) : 1);

    if (Number.isFinite(surfaceRedshiftZ)) {
      setTextIfChanged(telRedshift, textCache, 'redshift', surfaceRedshiftZ.toFixed(3));
    }

    if (Number.isFinite(visibleSurfaceFraction)) {
      setTextIfChanged(
        telVisibleFrac,
        textCache,
        'visibleFrac',
        `${(visibleSurfaceFraction * 100).toFixed(1)}%`
      );
    }

    if (Number.isFinite(rLightCylKm)) {
      setTextIfChanged(
        telLightCyl,
        textCache,
        'lightCyl',
        formatLightCylinder(rLightCylKm, rLightCylNorm)
      );
    }

    if (Number.isFinite(spinFreqHz)) {
      setTextIfChanged(telSpinFreq, textCache, 'spinFreq', formatSpinFreq(spinFreqHz));
    }

    if (Number.isFinite(compactness)) {
      const radStr = Number.isFinite(stellarRadiusKm) ? ` · ${stellarRadiusKm.toFixed(1)} km` : '';
      setTextIfChanged(telCompactness, textCache, 'compactness', `${compactness.toFixed(3)}${radStr}`);
    }

    if (Number.isFinite(fps) || Number.isFinite(samples)) {
      const fpsStr = Number.isFinite(fps) ? `${Math.round(fps)}` : '--';
      const smpStr = Number.isFinite(samples) ? `${samples}/128` : '--';
      setTextIfChanged(telFrame, textCache, 'frame', `${fpsStr} · ${smpStr}`);
    }

    if (Number.isFinite(compactness) || Number.isFinite(surfaceRedshiftZ)) {
      const curvLabel = lensingMode === 0 ? 'Flat Space' : 'GR Curved';
      const mrStr = Number.isFinite(compactness) ? compactness.toFixed(3) : '--';
      const zStr = Number.isFinite(surfaceRedshiftZ) ? surfaceRedshiftZ.toFixed(3) : '--';
      setTextIfChanged(
        drawerPhysicsMeta,
        textCache,
        'physicsMeta',
        `${curvLabel} · M/R ${mrStr} · z ${zStr}`
      );
    }

    if (rendererName) {
      setTextIfChanged(drawerRendererName, textCache, 'rendererName', String(rendererName));
    }
  }

  function toggleHud(visible) {
    const next = typeof visible === 'boolean' ? visible : !hudVisible;
    const focusWasInsideChrome = hudChrome.contains(document.activeElement);
    const focusWasOnRestore = document.activeElement === btnRestoreHud;
    hudVisible = next;

    hudChrome.classList.toggle('is-hud-hidden', !hudVisible);
    hudChrome.inert = !hudVisible;
    btnRestoreHud.hidden = hudVisible;

    if (!hudVisible && drawerOpen) {
      setDrawerOpen(false);
    }

    if (!hudVisible && focusWasInsideChrome) {
      btnRestoreHud.focus({ preventScroll: true });
    } else if (hudVisible && focusWasOnRestore) {
      (lastHideTrigger || btnHideUi || btnHideHud)?.focus({ preventScroll: true });
    }

    return hudVisible;
  }

  function setLoading(isLoading, message) {
    const active = Boolean(isLoading);
    loadingIndicator.hidden = !active;
    if (message) {
      setTextIfChanged(loadingMessage, textCache, 'loading', String(message));
    }
  }

  function setError(message) {
    if (!message) {
      errorNotice.hidden = true;
      return;
    }
    errorMessage.textContent = String(message);
    errorNotice.hidden = false;
  }

  controlsToggle.addEventListener('click', () => {
    setDrawerOpen(!drawerOpen, { returnFocus: drawerOpen });
  });

  controlsClose.addEventListener('click', () => {
    setDrawerOpen(false, { returnFocus: true });
  });

  controlsDrawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      e.stopPropagation();
      setDrawerOpen(false, { returnFocus: true });
    }
  });

  btnPlayPause.addEventListener('click', () => onAction('togglePause'));
  btnAutoOrbit.addEventListener('click', () => onAction('toggleAutoOrbit'));
  if (btnResetCam) {
    btnResetCam.addEventListener('click', () => onAction('resetCamera'));
  }
  if (btnCapturePng) {
    btnCapturePng.addEventListener('click', () => onAction('screenshot'));
  }
  if (btnHideHud) {
    btnHideHud.addEventListener('click', () => {
      lastHideTrigger = btnHideHud;
      onAction('toggleHud');
    });
  }
  if (btnHideUi) {
    btnHideUi.addEventListener('click', () => {
      lastHideTrigger = btnHideUi;
      onAction('toggleHud');
    });
  }
  btnRestoreHud.addEventListener('click', () => onAction('toggleHud'));

  function setBackendState({ backend, busy = false, statusNote = '' } = {}) {
    const binding = controlBindings.get('backend');
    if (!binding) return;
    if (backend) {
      binding.set(backend);
    }
    if (typeof binding.setDisabled === 'function') {
      binding.setDisabled(Boolean(busy));
    }
    if (binding.statusEl) {
      const note = String(statusNote || '').trim();
      if (note) {
        binding.statusEl.textContent = note;
        binding.statusEl.hidden = false;
      } else {
        binding.statusEl.textContent = '';
        binding.statusEl.hidden = true;
      }
    }
  }

  buildControls();
  buildPresets();
  syncState(state);
  setDrawerOpen(false);
  if (presets.length > 0) {
    setActivePreset(state.presetId || presets[0].id);
  }

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
