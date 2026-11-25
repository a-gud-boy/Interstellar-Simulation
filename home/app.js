/**
 * Interstellar Observatory — Ultra-Lightweight Homepage Controller
 * - Zero WebGL/WebGPU contexts, zero canvas elements, zero idle rAF loops.
 * - Dynamically renders Spotlight selector, zero-orphan 7-sim catalog, category filters,
 *   native <dialog> Quick-Inspect Dossier, global WebGL2/WebGPU link sync, and CLI copy actions.
 */

import { SIMULATORS } from '../shared/simRegistry.js';
import { CATEGORIES, SIM_CATALOG_META } from './catalogData.js';

const BACKEND_STORAGE_KEY = 'interstellar-backend';

const FALLBACK_ACCENTS = Object.freeze({
  blackhole: ['#f0b35a', '#f7ca82'],
  wormhole: ['#4ad4c4', '#7ce8da'],
  binary: ['#a78bfa', '#c4b5fd'],
  warp: ['#38bdf8', '#7dd3fc'],
  supernova: ['#fb923c', '#fdba74'],
  pulsar: ['#67e8f9', '#a5f3fc'],
  starflight: ['#60a5fa', '#93c5fd'],
});

const SIM_MAP = new Map(SIMULATORS.map((sim) => [sim.id, sim]));

const state = {
  backend: 'webgl2',
  spotlightId: SIMULATORS[0]?.id || 'blackhole',
  activeCategory: 'all',
  dossierSimId: null,
  lastFocusedTrigger: null,
};

function hexToRgbTriplet(hex, fallback = '240, 179, 90') {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function getSimMeta(sim) {
  const meta = SIM_CATALOG_META?.[sim.id] || {};
  const [fbAccent, fbBright] = FALLBACK_ACCENTS[sim.id] || ['#f0b35a', '#f7ca82'];
  const idx = SIMULATORS.indexOf(sim);
  return {
    index: meta.index || String(idx + 1).padStart(2, '0'),
    category: meta.category || 'gr',
    categoryLabel: meta.categoryLabel || 'Relativistic Physics',
    tagline: meta.tagline || sim.shortLabel,
    accent: meta.accent || fbAccent,
    accentBright: meta.accentBright || fbBright,
    preview: meta.preview || `./home/previews/${sim.id}.webp`,
    previewAlt: meta.previewAlt || `${sim.title} real-time relativistic simulation preview`,
    equation: meta.equation || '',
    metricName: meta.metricName || sim.shortLabel,
    cliFlag: meta.cliFlag || `--${sim.id}`,
    specialControl: meta.specialControl || 'Press Space for 128× Cinema Still accumulation',
    highlights: Array.isArray(meta.highlights) ? meta.highlights : [],
    specs: Array.isArray(meta.specs) ? meta.specs : [],
    presets: Array.isArray(meta.presets) ? meta.presets : [],
  };
}

function normalizeBackend(raw) {
  return String(raw || '').trim().toLowerCase() === 'webgpu' ? 'webgpu' : 'webgl2';
}

function getInitialBackend() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const fromUrl = params.get('backend');
    if (fromUrl) return normalizeBackend(fromUrl);
  } catch {
    // Ignore malformed query strings
  }
  try {
    const stored = window.sessionStorage?.getItem(BACKEND_STORAGE_KEY);
    if (stored) return normalizeBackend(stored);
  } catch {
    // sessionStorage unavailable
  }
  return 'webgl2';
}

function buildSimHref(sim, backend = state.backend) {
  return `./${sim.dir}/?backend=${normalizeBackend(backend)}`;
}

function wireImageFallback(img, frameEl) {
  if (!img || !frameEl) return;
  img.addEventListener('error', () => {
    frameEl.classList.add('is-fallback');
    frameEl.classList.remove('is-swapping');
  });
  img.addEventListener('load', () => {
    frameEl.classList.remove('is-fallback');
    frameEl.classList.remove('is-swapping');
  });
  if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
    frameEl.classList.add('is-fallback');
  }
}

/* ============================================================
   Global Rendering Backend Selector (Zero GPU Init Cost)
   ============================================================ */

function initBackendControls() {
  const radiogroup = document.getElementById('backend-radiogroup');
  const supportDot = document.getElementById('webgpu-support-dot');
  const webgpuBtn = radiogroup?.querySelector('[data-backend="webgpu"]');

  // Lightweight feature check only — do not request a GPU adapter on homepage load.
  const hasWebGpuApi = typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (supportDot) {
    supportDot.classList.toggle('is-supported', hasWebGpuApi);
  }
  if (webgpuBtn) {
    webgpuBtn.title = hasWebGpuApi
      ? 'WebGPU API detected in this browser — launch simulators in WebGPU mode'
      : 'WebGPU API not detected in this browser — simulators will auto-fallback to WebGL2 if needed';
  }

  state.backend = getInitialBackend();
  applyBackend(state.backend, { announce: false });

  if (!radiogroup) return;
  const buttons = Array.from(radiogroup.querySelectorAll('.backend-opt'));

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const next = normalizeBackend(btn.dataset.backend);
      if (next !== state.backend) {
        applyBackend(next, { announce: true });
      }
    });
  }

  radiogroup.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = state.backend === 'webgl2' ? 'webgpu' : 'webgl2';
    applyBackend(next, { announce: true });
    const activeBtn = radiogroup.querySelector(`[data-backend="${next}"]`);
    activeBtn?.focus();
  });
}

function applyBackend(mode, { announce = false } = {}) {
  const normalized = normalizeBackend(mode);
  state.backend = normalized;

  try {
    window.sessionStorage?.setItem(BACKEND_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage quota / privacy restrictions
  }

  const radiogroup = document.getElementById('backend-radiogroup');
  if (radiogroup) {
    for (const btn of radiogroup.querySelectorAll('.backend-opt')) {
      const isSelected = btn.dataset.backend === normalized;
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
    }
  }

  const heroBackendPill = document.getElementById('hero-backend-pill');
  if (heroBackendPill) {
    heroBackendPill.textContent = normalized.toUpperCase();
  }

  // Sync every launch link across Hero, Catalog cards, and Footer
  for (const anchor of document.querySelectorAll('a[data-sim-launch]')) {
    const simId = anchor.getAttribute('data-sim-launch');
    const sim = SIM_MAP.get(simId);
    if (sim) {
      anchor.setAttribute('href', buildSimHref(sim, normalized));
    }
  }

  // Keep Dossier primary/secondary emphasis synced if open
  if (state.dossierSimId) {
    syncDossierLaunchButtons(state.dossierSimId);
  }

  if (announce) {
    const live = document.getElementById('backend-live-status');
    if (live) {
      live.textContent = `Global launch backend set to ${normalized === 'webgpu' ? 'WebGPU' : 'WebGL2'}.`;
    }
  }
}

/* ============================================================
   Interactive Hero Spotlight Switcher
   ============================================================ */

function renderSpotlightTabs() {
  const tablist = document.getElementById('spotlight-tablist');
  if (!tablist) return;
  tablist.textContent = '';

  const tabs = [];
  for (const sim of SIMULATORS) {
    const meta = getSimMeta(sim);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spotlight-pill';
    btn.setAttribute('role', 'tab');
    btn.dataset.simId = sim.id;
    btn.style.setProperty('--pill-accent', meta.accent);
    btn.style.setProperty('--pill-accent-bright', meta.accentBright);
    btn.style.setProperty('--pill-accent-rgb', hexToRgbTriplet(meta.accent));

    const dot = document.createElement('span');
    dot.className = 'spotlight-dot';
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = sim.shortLabel;

    btn.append(dot, label);
    btn.addEventListener('click', () => {
      setSpotlightSim(sim.id);
    });

    tabs.push(btn);
    tablist.appendChild(btn);
  }

  tablist.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const currentIdx = tabs.findIndex((t) => t.dataset.simId === state.spotlightId);
    if (currentIdx === -1) return;
    e.preventDefault();

    let nextIdx = currentIdx;
    if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;

    const nextTab = tabs[nextIdx];
    setSpotlightSim(nextTab.dataset.simId);
    nextTab.focus();
  });
}

function setSpotlightSim(simId) {
  const sim = SIM_MAP.get(simId) || SIMULATORS[0];
  if (!sim) return;
  const meta = getSimMeta(sim);
  state.spotlightId = sim.id;

  const root = document.documentElement;
  root.style.setProperty('--hero-accent', meta.accent);
  root.style.setProperty('--hero-accent-bright', meta.accentBright);
  root.style.setProperty('--hero-accent-rgb', hexToRgbTriplet(meta.accent));

  const img = document.getElementById('hero-preview-img');
  const frame = document.getElementById('hero-media-frame');
  if (img && frame) {
    frame.classList.remove('is-fallback');
    if (img.getAttribute('src') !== meta.preview) {
      frame.classList.add('is-swapping');
      img.setAttribute('src', meta.preview);
      img.setAttribute('alt', meta.previewAlt);
      img.addEventListener(
        'load',
        () => {
          frame.classList.remove('is-swapping');
        },
        { once: true }
      );
      // Clear swapping class quickly even if image is already cached or fails
      window.setTimeout(() => frame.classList.remove('is-swapping'), 160);
    } else {
      img.setAttribute('alt', meta.previewAlt);
    }
  }

  const indexEl = document.getElementById('hero-metric-index');
  const metricEl = document.getElementById('hero-metric-name');
  const titleEl = document.getElementById('hero-sim-title');
  const eqEl = document.getElementById('hero-sim-eq');
  const heroLaunchBtn = document.getElementById('hero-launch-btn');
  const heroLaunchLabel = document.getElementById('hero-launch-label');
  const heroFrameLaunch = document.getElementById('hero-frame-launch');
  const heroInspectBtn = document.getElementById('hero-inspect-btn');

  if (indexEl) indexEl.textContent = meta.index;
  if (metricEl) metricEl.textContent = meta.metricName;
  if (titleEl) titleEl.textContent = sim.title;
  if (eqEl) eqEl.textContent = meta.equation;

  const launchHref = buildSimHref(sim);
  const shortHeroName = sim.id === 'blackhole' ? 'Gargantua' : sim.shortLabel;

  if (heroLaunchBtn) {
    heroLaunchBtn.setAttribute('data-sim-launch', sim.id);
    heroLaunchBtn.setAttribute('href', launchHref);
  }
  if (heroLaunchLabel) {
    heroLaunchLabel.textContent = `Launch ${shortHeroName}`;
  }
  if (heroFrameLaunch) {
    heroFrameLaunch.setAttribute('data-sim-launch', sim.id);
    heroFrameLaunch.setAttribute('href', launchHref);
  }
  if (heroInspectBtn) {
    heroInspectBtn.setAttribute('data-inspect-sim', sim.id);
  }

  const tablist = document.getElementById('spotlight-tablist');
  if (tablist) {
    for (const tab of tablist.querySelectorAll('.spotlight-pill')) {
      const selected = tab.dataset.simId === sim.id;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
  }
}

/* ============================================================
   Category Filter Bar & Zero-Orphan 7-Card Catalog
   ============================================================ */

function getCategoryCount(categoryId) {
  if (categoryId === 'all') return SIMULATORS.length;
  return SIMULATORS.filter((sim) => getSimMeta(sim).category === categoryId).length;
}

function renderCategoryFilters() {
  const bar = document.getElementById('category-filter-bar');
  if (!bar) return;
  bar.textContent = '';

  const categories = Array.isArray(CATEGORIES) && CATEGORIES.length
    ? CATEGORIES
    : [{ id: 'all', label: 'All Engines' }];

  for (const cat of categories) {
    const count = getCategoryCount(cat.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn';
    btn.dataset.category = cat.id;
    btn.setAttribute('aria-pressed', cat.id === state.activeCategory ? 'true' : 'false');

    const label = document.createElement('span');
    label.textContent = cat.label;

    const countSpan = document.createElement('span');
    countSpan.className = 'filter-count tabular';
    countSpan.textContent = `(${count})`;

    btn.append(label, countSpan);
    btn.addEventListener('click', () => {
      if (state.activeCategory === cat.id) return;
      state.activeCategory = cat.id;
      updateCategoryButtons();
      renderCatalogGrid({ announce: true });
    });

    bar.appendChild(btn);
  }
}

function updateCategoryButtons() {
  const bar = document.getElementById('category-filter-bar');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('.filter-btn')) {
    btn.setAttribute('aria-pressed', btn.dataset.category === state.activeCategory ? 'true' : 'false');
  }
}

function createMediaFallbackNode() {
  const wrap = document.createElement('div');
  wrap.className = 'media-fallback';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML =
    '<svg viewBox="0 0 320 180" class="fallback-svg">' +
    '<rect width="320" height="180" fill="#060912"/>' +
    '<circle cx="160" cy="90" r="34" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2"/>' +
    '<ellipse cx="160" cy="90" rx="74" ry="18" transform="rotate(-12 160 90)" fill="none" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.2"/>' +
    '</svg>' +
    '<span class="fallback-label tabular">OBSERVATORY PREVIEW</span>';
  return wrap;
}

function createSimulatorCard(sim, { isFeatured = false, isSingle = false } = {}) {
  const meta = getSimMeta(sim);
  const article = document.createElement('article');
  article.className = isFeatured ? 'sim-card sim-card--featured' : 'sim-card';
  article.dataset.simId = sim.id;
  article.style.setProperty('--sim-accent', meta.accent);
  article.style.setProperty('--sim-accent-bright', meta.accentBright);
  article.style.setProperty('--sim-accent-rgb', hexToRgbTriplet(meta.accent));

  // Media preview (lazy-loaded below the fold)
  const media = document.createElement('div');
  media.className = 'sim-card-media';
  media.setAttribute('role', 'button');
  media.tabIndex = 0;
  media.setAttribute('aria-label', `Inspect ${sim.title} dossier`);

  const img = document.createElement('img');
  img.src = meta.preview;
  img.alt = meta.previewAlt;
  img.width = 960;
  img.height = 540;
  img.loading = 'lazy';
  img.decoding = 'async';
  wireImageFallback(img, media);

  const badges = document.createElement('div');
  badges.className = 'card-media-badges';

  const leftBadge = document.createElement('span');
  leftBadge.className = 'card-badge';
  const idxSpan = document.createElement('span');
  idxSpan.className = 'card-badge-idx tabular';
  idxSpan.textContent = meta.index;
  const catSpan = document.createElement('span');
  catSpan.textContent = meta.categoryLabel;
  leftBadge.append(idxSpan, catSpan);
  badges.appendChild(leftBadge);

  if (isFeatured) {
    const flagship = document.createElement('span');
    flagship.className = 'card-badge card-badge--flagship';
    flagship.textContent = 'FLAGSHIP ENGINE';
    badges.appendChild(flagship);
  }

  media.append(img, createMediaFallbackNode(), badges);

  media.addEventListener('click', () => openDossier(sim.id, media));
  media.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDossier(sim.id, media);
    }
  });

  // Body
  const body = document.createElement('div');
  body.className = 'sim-card-body';

  const tagline = document.createElement('p');
  tagline.className = 'sim-card-tagline';
  tagline.textContent = meta.tagline;

  const title = document.createElement('h3');
  title.className = 'sim-card-title';
  title.textContent = sim.title;

  const desc = document.createElement('p');
  desc.className = 'sim-card-desc';
  desc.textContent = sim.description;

  const eq = document.createElement('div');
  eq.className = 'equation-strip tabular';
  eq.title = meta.equation;
  eq.textContent = meta.equation;

  body.append(tagline, title, desc, eq);

  // Featured flagship or single-result card displays compact 3-cell specs inline
  if ((isFeatured || isSingle) && meta.specs.length > 0) {
    const specsDl = document.createElement('dl');
    specsDl.className = 'card-specs';
    for (const spec of meta.specs.slice(0, 3)) {
      const cell = document.createElement('div');
      cell.className = 'card-spec';
      const dt = document.createElement('dt');
      dt.textContent = spec.label;
      const dd = document.createElement('dd');
      dd.textContent = spec.value;
      cell.append(dt, dd);
      specsDl.appendChild(cell);
    }
    body.appendChild(specsDl);
  }

  if (meta.highlights.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    for (const item of meta.highlights.slice(0, 3)) {
      const chip = document.createElement('span');
      chip.className = 'physics-chip';
      chip.textContent = item;
      chips.appendChild(chip);
    }
    body.appendChild(chips);
  }

  const footer = document.createElement('div');
  footer.className = 'sim-card-footer';

  const detailsBtn = document.createElement('button');
  detailsBtn.type = 'button';
  detailsBtn.className = 'card-btn-details';
  detailsBtn.textContent = 'Details';
  detailsBtn.addEventListener('click', () => openDossier(sim.id, detailsBtn));

  const launchLink = document.createElement('a');
  launchLink.className = 'card-btn-launch';
  launchLink.setAttribute('data-sim-launch', sim.id);
  launchLink.href = buildSimHref(sim);
  launchLink.innerHTML = '<span>Launch</span><span aria-hidden="true">→</span>';

  footer.append(detailsBtn, launchLink);
  body.appendChild(footer);

  article.append(media, body);
  return article;
}

function renderCatalogGrid({ announce = false } = {}) {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  const visibleSims =
    state.activeCategory === 'all'
      ? SIMULATORS
      : SIMULATORS.filter((sim) => getSimMeta(sim).category === state.activeCategory);

  const isAll = state.activeCategory === 'all';
  const isSingle = visibleSims.length === 1;

  grid.classList.toggle('is-featured-layout', isAll);
  grid.dataset.count = String(visibleSims.length);
  grid.textContent = '';

  const fragment = document.createDocumentFragment();
  visibleSims.forEach((sim, idx) => {
    fragment.appendChild(
      createSimulatorCard(sim, {
        isFeatured: isAll && idx === 0,
        isSingle,
      })
    );
  });
  grid.appendChild(fragment);

  if (announce) {
    const live = document.getElementById('catalog-live-status');
    if (live) {
      const cat = (CATEGORIES || []).find((c) => c.id === state.activeCategory);
      const label = cat ? cat.label : state.activeCategory;
      live.textContent = `Showing ${visibleSims.length} simulator${visibleSims.length === 1 ? '' : 's'} in ${label}.`;
    }
  }
}

/* ============================================================
   Dormant Pointer-Follow Card Glow (0 ticks/sec when idle)
   ============================================================ */

function initDormantCardSpotlight() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
  if (reducedMotion || coarsePointer) return;

  let rafId = 0;
  let pendingCard = null;
  let pendingX = 0;
  let pendingY = 0;

  grid.addEventListener(
    'pointermove',
    (e) => {
      const card = e.target?.closest?.('.sim-card');
      if (!card) return;
      pendingCard = card;
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (rafId) return;

      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        if (!pendingCard) return;
        const rect = pendingCard.getBoundingClientRect();
        pendingCard.style.setProperty('--mx', `${Math.round(pendingX - rect.left)}px`);
        pendingCard.style.setProperty('--my', `${Math.round(pendingY - rect.top)}px`);
        pendingCard = null;
      });
    },
    { passive: true }
  );

  grid.addEventListener('pointerleave', () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    pendingCard = null;
  });
}

/* ============================================================
   Native <dialog> Quick-Inspect Observatory Dossier
   ============================================================ */

function syncDossierLaunchButtons(simId) {
  const sim = SIM_MAP.get(simId);
  if (!sim) return;
  const glBtn = document.getElementById('dossier-launch-webgl2');
  const gpuBtn = document.getElementById('dossier-launch-webgpu');
  if (!glBtn || !gpuBtn) return;

  glBtn.href = buildSimHref(sim, 'webgl2');
  gpuBtn.href = buildSimHref(sim, 'webgpu');

  const isGpu = state.backend === 'webgpu';
  glBtn.className = isGpu ? 'btn btn-secondary' : 'btn btn-primary';
  gpuBtn.className = isGpu ? 'btn btn-primary' : 'btn btn-secondary';
}

function openDossier(simId, triggerEl = null) {
  const dialog = document.getElementById('sim-dossier');
  const sim = SIM_MAP.get(simId);
  if (!dialog || !sim) return;

  const meta = getSimMeta(sim);
  state.dossierSimId = sim.id;
  state.lastFocusedTrigger = triggerEl || document.activeElement;

  dialog.style.setProperty('--sim-accent', meta.accent);
  dialog.style.setProperty('--sim-accent-bright', meta.accentBright);
  dialog.style.setProperty('--sim-accent-rgb', hexToRgbTriplet(meta.accent));

  const frame = document.getElementById('dossier-media-frame');
  if (frame) {
    let img = document.getElementById('dossier-img');
    if (!img) {
      img = document.createElement('img');
      img.id = 'dossier-img';
      img.width = 960;
      img.height = 540;
      img.decoding = 'async';
      wireImageFallback(img, frame);
      frame.prepend(img);
    }
    frame.classList.remove('is-fallback');
    img.src = meta.preview;
    img.alt = meta.previewAlt;
  }

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('dossier-index', meta.index);
  setText('dossier-category', meta.categoryLabel);
  setText('dossier-tagline', meta.tagline);
  setText('dossier-title', sim.title);
  setText('dossier-desc', sim.description);
  setText('dossier-metric-name', meta.metricName);
  setText('dossier-equation', meta.equation);
  setText('dossier-special-control', meta.specialControl);

  const cliCommand = `./launch.sh ${meta.cliFlag}`;
  setText('dossier-cli-cmd', cliCommand);
  const copyBtn = document.getElementById('dossier-copy-btn');
  if (copyBtn) {
    copyBtn.dataset.copy = cliCommand;
    copyBtn.classList.remove('is-copied');
    const txt = copyBtn.querySelector('.copy-btn-text');
    if (txt) txt.textContent = 'Copy';
  }

  const specsDl = document.getElementById('dossier-specs');
  if (specsDl) {
    specsDl.textContent = '';
    for (const spec of meta.specs) {
      const cell = document.createElement('div');
      cell.className = 'dossier-spec';
      const dt = document.createElement('dt');
      dt.textContent = spec.label;
      const dd = document.createElement('dd');
      dd.textContent = spec.value;
      cell.append(dt, dd);
      specsDl.appendChild(cell);
    }
  }

  const presetsOl = document.getElementById('dossier-presets');
  if (presetsOl) {
    presetsOl.textContent = '';
    meta.presets.forEach((preset, idx) => {
      const li = document.createElement('li');
      li.className = 'dossier-preset-card';

      const num = document.createElement('span');
      num.className = 'dossier-preset-num';
      num.textContent = String(idx + 1);

      const copy = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'dossier-preset-name';
      name.textContent = preset.name;
      const summary = document.createElement('span');
      summary.className = 'dossier-preset-summary';
      summary.textContent = preset.summary;
      copy.append(name, summary);

      li.append(num, copy);
      presetsOl.appendChild(li);
    });
  }

  syncDossierLaunchButtons(sim.id);

  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function initDossierModal() {
  const dialog = document.getElementById('sim-dossier');
  const closeBtn = document.getElementById('dossier-close-btn');
  const heroInspectBtn = document.getElementById('hero-inspect-btn');

  heroInspectBtn?.addEventListener('click', () => {
    const id = heroInspectBtn.getAttribute('data-inspect-sim') || state.spotlightId;
    openDossier(id, heroInspectBtn);
  });

  closeBtn?.addEventListener('click', () => {
    dialog?.close();
  });

  // Backdrop click closes native <dialog>
  dialog?.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });

  dialog?.addEventListener('close', () => {
    state.dossierSimId = null;
    if (state.lastFocusedTrigger && typeof state.lastFocusedTrigger.focus === 'function') {
      state.lastFocusedTrigger.focus();
    }
    state.lastFocusedTrigger = null;
  });
}

/* ============================================================
   Copy-to-Clipboard CLI Buttons
   ============================================================ */

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function initCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.copy-btn');
    if (!btn) return;
    const text = btn.dataset.copy;
    if (!text) return;

    const ok = await copyText(text);
    const labelEl = btn.querySelector('.copy-btn-text');
    if (labelEl) {
      labelEl.textContent = ok ? 'Copied ✓' : 'Failed';
    }
    btn.classList.toggle('is-copied', ok);

    window.clearTimeout(Number(btn.dataset.copyTimer || 0));
    const timer = window.setTimeout(() => {
      if (labelEl) labelEl.textContent = 'Copy';
      btn.classList.remove('is-copied');
    }, 1600);
    btn.dataset.copyTimer = String(timer);
  });
}

/* ============================================================
   Stats & Boot
   ============================================================ */

function updateTelemetrySummary() {
  const presetCountEl = document.getElementById('stat-preset-count');
  if (!presetCountEl) return;
  const totalPresets = SIMULATORS.reduce((sum, sim) => sum + getSimMeta(sim).presets.length, 0);
  if (totalPresets > 0) {
    presetCountEl.textContent = String(totalPresets);
  }
}

function init() {
  const heroImg = document.getElementById('hero-preview-img');
  const heroFrame = document.getElementById('hero-media-frame');
  wireImageFallback(heroImg, heroFrame);

  state.backend = getInitialBackend();
  updateTelemetrySummary();
  renderSpotlightTabs();
  renderCategoryFilters();
  renderCatalogGrid({ announce: false });
  initBackendControls();
  setSpotlightSim(state.spotlightId);
  initDossierModal();
  initCopyButtons();
  initDormantCardSpotlight();
}

init();
