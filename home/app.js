/**
 * Interstellar Observatory — Full-Bleed Flight Launcher Controller
 * Zero GPU initialization, zero <canvas>, zero idle rAF loops.
 */

import { SIMULATORS, getSimById } from '../shared/simRegistry.js';
import { CATEGORIES, SIM_CATALOG_META } from './catalogData.js';

const BACKEND_STORAGE_KEY = 'interstellar-backend';

const state = {
  backend: readInitialBackend(),
  category: 'all',
  spotlight: 'blackhole',
};

function readInitialBackend() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const fromQuery = params.get('backend');
    if (fromQuery === 'webgpu' || fromQuery === 'webgl2') {
      return fromQuery;
    }
    const stored = window.sessionStorage.getItem(BACKEND_STORAGE_KEY);
    if (stored === 'webgpu' || stored === 'webgl2') {
      return stored;
    }
  } catch {
    // sessionStorage unavailable
  }
  return 'webgl2';
}

function persistBackend(backend) {
  try {
    window.sessionStorage.setItem(BACKEND_STORAGE_KEY, backend);
  } catch {
    // ignore storage errors
  }
}

export function getSimMeta(sim) {
  return SIM_CATALOG_META[sim.id];
}

function hexToRgbTuple(hex) {
  const clean = String(hex || '#f0b35a').replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return '240, 179, 90';
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

export function buildSimHref(sim, extraParams = {}) {
  const params = new URLSearchParams();
  if (state.backend === 'webgpu') {
    params.set('backend', 'webgpu');
  }
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null && v !== '') {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return `./${sim.dir}/${qs ? `?${qs}` : ''}`;
}

function getFilteredSimulators() {
  if (state.category === 'all') {
    return SIMULATORS;
  }
  return SIMULATORS.filter((sim) => getSimMeta(sim)?.category === state.category);
}

function applyAccentTheme(meta) {
  const rgb = hexToRgbTuple(meta.accent);
  document.body.style.setProperty('--active-accent', meta.accent);
  document.body.style.setProperty('--active-accent-bright', meta.accentBright);
  document.body.style.setProperty('--active-accent-rgb', rgb);
}

function renderHeroStage(sim) {
  const meta = getSimMeta(sim);
  if (!meta) return;

  applyAccentTheme(meta);

  const bgImg = document.getElementById('stage-bg-img');
  if (bgImg && bgImg.getAttribute('src') !== meta.preview) {
    bgImg.classList.add('is-swapping');
    bgImg.src = meta.preview;
    bgImg.alt = meta.previewAlt || '';
    const finishSwap = () => bgImg.classList.remove('is-swapping');
    if (bgImg.complete) {
      finishSwap();
    } else {
      bgImg.addEventListener('load', finishSwap, { once: true });
      bgImg.addEventListener('error', finishSwap, { once: true });
    }
  }

  const eyebrowEl = document.getElementById('hero-eyebrow');
  if (eyebrowEl) {
    eyebrowEl.textContent = `${meta.index} / 07 · ${meta.categoryLabel.toUpperCase()}`;
  }

  const titleEl = document.getElementById('hero-sim-title');
  if (titleEl) {
    titleEl.textContent = sim.shortLabel;
  }

  const subtitleEl = document.getElementById('hero-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = `${sim.title} · ${meta.metricName}`;
  }

  const descEl = document.getElementById('hero-desc');
  if (descEl) {
    descEl.textContent = sim.description;
  }

  const eqEl = document.getElementById('hero-equation');
  if (eqEl) {
    eqEl.textContent = meta.equation;
  }

  const specsEl = document.getElementById('hero-specs');
  if (specsEl) {
    specsEl.replaceChildren(
      ...meta.specs.map((spec) => {
        const col = document.createElement('div');
        col.className = 'spec-col';
        const dt = document.createElement('dt');
        dt.textContent = spec.label;
        const dd = document.createElement('dd');
        dd.textContent = spec.value;
        col.append(dt, dd);
        return col;
      })
    );
  }

  const launchBtn = document.getElementById('hero-launch-btn');
  if (launchBtn) {
    launchBtn.href = buildSimHref(sim);
    launchBtn.setAttribute('data-sim-launch', sim.id);
    launchBtn.setAttribute(
      'aria-label',
      `Enter ${sim.title} using ${state.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}`
    );
  }

  const grid = document.getElementById('catalog-grid');
  if (grid) {
    for (const card of grid.querySelectorAll('.sim-card')) {
      const active = card.getAttribute('data-sim-id') === sim.id;
      card.classList.toggle('is-active', active);
      const selectBtn = card.querySelector('.sim-card-select');
      if (selectBtn) {
        selectBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
  }
}

function buildFilmstripCard(sim) {
  const meta = getSimMeta(sim);
  const rgb = hexToRgbTuple(meta.accent);

  const card = document.createElement('article');
  card.className = `sim-card${sim.id === state.spotlight ? ' is-active' : ''}`;
  card.setAttribute('role', 'listitem');
  card.setAttribute('data-sim-id', sim.id);
  card.setAttribute('data-category', meta.category);
  card.style.setProperty('--card-accent-bright', meta.accentBright);
  card.style.setProperty('--card-accent-rgb', rgb);

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'sim-card-select';
  selectBtn.setAttribute('aria-label', `Preview ${sim.title}`);
  selectBtn.setAttribute('aria-pressed', sim.id === state.spotlight ? 'true' : 'false');

  const img = document.createElement('img');
  img.className = 'sim-card-thumb';
  img.src = meta.preview;
  img.alt = meta.previewAlt || sim.title;
  img.decoding = 'async';

  const scrim = document.createElement('span');
  scrim.className = 'sim-card-scrim';
  scrim.setAttribute('aria-hidden', 'true');

  const top = document.createElement('span');
  top.className = 'sim-card-top';

  const idx = document.createElement('span');
  idx.className = 'sim-card-idx';
  idx.textContent = meta.index;

  const badge = document.createElement('span');
  badge.className = 'sim-card-active-pill';
  badge.textContent = 'ACTIVE';

  top.append(idx, badge);

  const bottom = document.createElement('span');
  bottom.className = 'sim-card-bottom';

  const metric = document.createElement('span');
  metric.className = 'sim-card-metric';
  metric.textContent = meta.metricName;

  const name = document.createElement('strong');
  name.className = 'sim-card-name';
  name.textContent = sim.shortLabel;

  bottom.append(metric, name);
  selectBtn.append(img, scrim, top, bottom);

  const launchLink = document.createElement('a');
  launchLink.className = 'sim-card-go';
  launchLink.href = buildSimHref(sim);
  launchLink.setAttribute('data-sim-launch', sim.id);
  launchLink.setAttribute('aria-label', `Launch ${sim.title}`);
  launchLink.textContent = '↗';

  selectBtn.addEventListener('click', () => {
    setSpotlight(sim.id);
  });

  selectBtn.addEventListener('dblclick', () => {
    window.location.href = buildSimHref(sim);
  });

  card.append(selectBtn, launchLink);
  return card;
}

function renderFilmstripDock() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  grid.replaceChildren(...SIMULATORS.map(buildFilmstripCard));
  applyCategoryFilter(state.category);
}

function applyCategoryFilter(categoryId) {
  state.category = categoryId;

  const filterBar = document.getElementById('category-filter-bar');
  if (filterBar) {
    for (const pill of filterBar.querySelectorAll('.filter-pill')) {
      const match = pill.getAttribute('data-category') === categoryId;
      pill.classList.toggle('is-active', match);
      pill.setAttribute('aria-selected', match ? 'true' : 'false');
    }
  }

  const grid = document.getElementById('catalog-grid');
  if (grid) {
    for (const card of grid.querySelectorAll('.sim-card')) {
      const visible =
        categoryId === 'all' || card.getAttribute('data-category') === categoryId;
      card.hidden = !visible;
    }
  }

  const visibleSims = getFilteredSimulators();
  if (visibleSims.length > 0 && !visibleSims.some((s) => s.id === state.spotlight)) {
    state.spotlight = visibleSims[0].id;
  }

  const activeSim = getSimById(state.spotlight) || visibleSims[0] || SIMULATORS[0];
  if (activeSim) {
    renderHeroStage(activeSim);
  }
}

function setSpotlight(simId) {
  const sim = getSimById(simId);
  if (!sim) return;
  state.spotlight = sim.id;
  renderHeroStage(sim);
}

function updateBackendUI() {
  const group = document.getElementById('backend-radiogroup');
  if (group) {
    for (const btn of group.querySelectorAll('.backend-pill')) {
      const selected = btn.getAttribute('data-backend') === state.backend;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
  }

  for (const link of document.querySelectorAll('a[data-sim-launch]')) {
    const simId = link.getAttribute('data-sim-launch');
    const sim = getSimById(simId);
    if (!sim) continue;
    const preset = link.getAttribute('data-preset');
    if (link.id === 'dossier-launch-webgl2') {
      link.href = `./${sim.dir}/`;
    } else if (link.id === 'dossier-launch-webgpu') {
      link.href = `./${sim.dir}/?backend=webgpu`;
    } else {
      link.href = buildSimHref(sim, preset ? { preset } : {});
    }
  }

  const activeSim = getSimById(state.spotlight);
  if (activeSim) {
    const launchBtn = document.getElementById('hero-launch-btn');
    if (launchBtn) {
      launchBtn.setAttribute(
        'aria-label',
        `Enter ${activeSim.title} using ${state.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}`
      );
    }
  }
}

function initCategoryFilters() {
  const bar = document.getElementById('category-filter-bar');
  if (!bar) return;

  bar.replaceChildren(
    ...CATEGORIES.map((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `filter-pill${cat.id === state.category ? ' is-active' : ''}`;
      btn.setAttribute('data-category', cat.id);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', cat.id === state.category ? 'true' : 'false');
      btn.textContent = cat.id === 'all' ? 'All 7' : cat.label;
      btn.addEventListener('click', () => applyCategoryFilter(cat.id));
      return btn;
    })
  );
}

function initBackendControls() {
  const group = document.getElementById('backend-radiogroup');
  if (!group) return;

  for (const btn of group.querySelectorAll('.backend-pill')) {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-backend');
      if (next !== 'webgl2' && next !== 'webgpu') return;
      state.backend = next;
      persistBackend(next);
      updateBackendUI();
    });
  }

  updateBackendUI();
}

function populateDossier(sim) {
  const meta = getSimMeta(sim);
  if (!meta) return;

  const badge = document.getElementById('dossier-badge');
  if (badge) {
    badge.textContent = `${meta.index} / 07 · ${meta.categoryLabel.toUpperCase()} · ${meta.metricName.toUpperCase()}`;
  }

  const title = document.getElementById('dossier-title');
  if (title) title.textContent = sim.title;

  const tagline = document.getElementById('dossier-tagline');
  if (tagline) tagline.textContent = meta.tagline;

  const desc = document.getElementById('dossier-desc');
  if (desc) desc.textContent = sim.description;

  const eq = document.getElementById('dossier-equation');
  if (eq) eq.textContent = meta.equation;

  const ctrl = document.getElementById('dossier-control');
  if (ctrl) ctrl.textContent = meta.specialControl;

  const specs = document.getElementById('dossier-specs');
  if (specs) {
    specs.replaceChildren(
      ...meta.specs.map((spec) => {
        const card = document.createElement('div');
        card.className = 'dossier-spec-item';
        const k = document.createElement('span');
        k.className = 'meta-k';
        k.textContent = spec.label;
        const v = document.createElement('strong');
        v.textContent = spec.value;
        card.append(k, v);
        return card;
      })
    );
  }

  const presetsGrid = document.getElementById('dossier-presets');
  if (presetsGrid) {
    presetsGrid.replaceChildren(
      ...meta.presets.map((preset) => {
        const chip = document.createElement('a');
        chip.className = 'preset-launch-chip';
        chip.href = buildSimHref(sim, { preset: preset.id });
        chip.setAttribute('data-sim-launch', sim.id);
        chip.setAttribute('data-preset', preset.id);

        const name = document.createElement('span');
        name.className = 'preset-chip-title';
        name.textContent = preset.name;

        const sub = document.createElement('span');
        sub.className = 'preset-chip-sub';
        sub.textContent = preset.summary;

        chip.append(name, sub);
        return chip;
      })
    );
  }

  const cliCmd = document.getElementById('dossier-cli-cmd');
  if (cliCmd) {
    cliCmd.textContent = `./launch.sh ${meta.cliFlag}${state.backend === 'webgpu' ? ' --webgpu' : ''}`;
  }

  const webgl2Link = document.getElementById('dossier-launch-webgl2');
  if (webgl2Link) {
    webgl2Link.setAttribute('data-sim-launch', sim.id);
    webgl2Link.href = `./${sim.dir}/`;
  }

  const webgpuLink = document.getElementById('dossier-launch-webgpu');
  if (webgpuLink) {
    webgpuLink.setAttribute('data-sim-launch', sim.id);
    webgpuLink.href = `./${sim.dir}/?backend=webgpu`;
  }
}

function wireCopyButton(button, getText) {
  if (!button) return;
  button.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = prev;
      }, 1200);
    } catch {
      // clipboard blocked in non-HTTPS contexts
    }
  });
}

function initDialogs() {
  const dossierDialog = document.getElementById('sim-dossier');
  const controlsDialog = document.getElementById('controls-dialog');

  const inspectBtn = document.getElementById('hero-inspect-btn');
  if (inspectBtn && dossierDialog) {
    inspectBtn.addEventListener('click', () => {
      const sim = getSimById(state.spotlight) || SIMULATORS[0];
      if (!sim) return;
      populateDossier(sim);
      if (typeof dossierDialog.showModal === 'function') {
        dossierDialog.showModal();
      } else {
        dossierDialog.setAttribute('open', '');
      }
    });
  }

  const openControlsBtn = document.getElementById('open-controls-btn');
  if (openControlsBtn && controlsDialog) {
    openControlsBtn.addEventListener('click', () => {
      if (typeof controlsDialog.showModal === 'function') {
        controlsDialog.showModal();
      } else {
        controlsDialog.setAttribute('open', '');
      }
    });
  }

  for (const closeBtn of document.querySelectorAll('[data-close-dialog]')) {
    closeBtn.addEventListener('click', () => {
      const targetId = closeBtn.getAttribute('data-close-dialog');
      const dlg = targetId ? document.getElementById(targetId) : null;
      if (dlg && typeof dlg.close === 'function') {
        dlg.close();
      } else if (dlg) {
        dlg.removeAttribute('open');
      }
    });
  }

  for (const dlg of [dossierDialog, controlsDialog]) {
    if (!dlg) continue;
    dlg.addEventListener('click', (event) => {
      if (event.target === dlg) {
        if (typeof dlg.close === 'function') {
          dlg.close();
        } else {
          dlg.removeAttribute('open');
        }
      }
    });
  }

  const dossierCopy = document.getElementById('dossier-copy-cli');
  wireCopyButton(dossierCopy, () => document.getElementById('dossier-cli-cmd')?.textContent || '');

  for (const btn of document.querySelectorAll('#controls-dialog .cli-copy-btn[data-copy-text]')) {
    wireCopyButton(btn, () => btn.getAttribute('data-copy-text') || '');
  }
}

function initKeyboardNav() {
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const dossierOpen = document.getElementById('sim-dossier')?.open;
    const controlsOpen = document.getElementById('controls-dialog')?.open;
    if (dossierOpen || controlsOpen) return;

    const visible = getFilteredSimulators();
    if (visible.length === 0) return;

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const idx = Math.max(0, visible.findIndex((s) => s.id === state.spotlight));
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = visible[(idx + step + visible.length) % visible.length];
      setSpotlight(next.id);
      return;
    }

    if (event.key === 'Enter') {
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName !== 'HTML') {
        return;
      }
      const sim = getSimById(state.spotlight);
      if (sim) {
        window.location.href = buildSimHref(sim);
      }
    }
  });
}

function bootHomepage() {
  initCategoryFilters();
  renderFilmstripDock();
  initBackendControls();
  initDialogs();
  initKeyboardNav();
}

bootHomepage();
