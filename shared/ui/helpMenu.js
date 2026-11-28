/**
 * helpMenu.js — Universal In-Sim Help Menu & Flight Manual shared by all 9
 * Interstellar Observatory simulators.
 *
 * Mounts `#btn-help-menu` into `.hud-top-right` and `#help-menu-overlay` inside
 * `#hud-chrome`, pulling canonical simulator metadata from `simRegistry.js` and
 * `home/catalogData.js` while customizing camera/interaction guidance per engine.
 */

import { getSimById } from '../simRegistry.js';
import { SIM_CATALOG_META } from '../../home/catalogData.js';

export const HELP_VERSION_LABEL = '0.1.4.3 beta';

const DEFAULT_CAMERA_BINDINGS = Object.freeze([
  Object.freeze({ keys: 'Drag', desc: 'Orbit azimuth & elevation' }),
  Object.freeze({ keys: 'Scroll / W S', desc: 'Radial zoom' }),
  Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Camera roll' }),
  Object.freeze({ keys: 'Shift-Drag', desc: 'Local look / tilt' }),
  Object.freeze({ keys: 'A / D / Arrows', desc: 'Smooth orbit flight' }),
  Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
]);

export const SIM_HELP_PROFILES = Object.freeze({
  blackhole: Object.freeze({
    signatureTitle: 'Kerr Horizon & Cinema Still',
    cameraBindings: DEFAULT_CAMERA_BINDINGS,
  }),
  wormhole: Object.freeze({
    signatureTitle: 'Dual-Universe Throat Traversal',
    cameraBindings: Object.freeze([
      Object.freeze({ keys: 'Drag', desc: 'Orbit portal' }),
      Object.freeze({ keys: 'Scroll / W S', desc: 'Step proper coordinate l' }),
      Object.freeze({ keys: 'Shift-Drag', desc: 'Look locally' }),
      Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Camera roll' }),
      Object.freeze({ keys: 'T', desc: 'Traverse throat (Univ A ⇄ B)' }),
      Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
    ]),
  }),
  binary: Object.freeze({
    signatureTitle: '2.5PN Inspiral & GW Sonification',
    cameraBindings: DEFAULT_CAMERA_BINDINGS,
  }),
  warp: Object.freeze({
    signatureTitle: 'External Chase ⇄ Inside Bridge',
    cameraBindings: Object.freeze([
      Object.freeze({ keys: 'Drag', desc: 'Orbit bubble / Look from Bridge' }),
      Object.freeze({ keys: 'Scroll / W S', desc: 'Zoom / Bridge FOV' }),
      Object.freeze({ keys: 'T', desc: 'Toggle Chase ↔ Inside Bridge' }),
      Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Camera roll' }),
      Object.freeze({ keys: 'Shift-Drag', desc: 'Local look' }),
      Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
    ]),
  }),
  supernova: Object.freeze({
    signatureTitle: 'Core-Collapse Detonation Sweep',
    cameraBindings: Object.freeze([
      Object.freeze({ keys: 'Drag', desc: 'Orbit remnant' }),
      Object.freeze({ keys: 'W / S / Scroll', desc: 'Fly inside / outside blast shell' }),
      Object.freeze({ keys: 'T', desc: 'Detonate & Evolve lifecycle sweep' }),
      Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Camera roll' }),
      Object.freeze({ keys: 'Shift-Drag', desc: 'Local look' }),
      Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
    ]),
  }),
  pulsar: Object.freeze({
    signatureTitle: 'Kerr–Schild Neutron Star & Radio Sweep',
    cameraBindings: DEFAULT_CAMERA_BINDINGS,
  }),
  starflight: Object.freeze({
    signatureTitle: 'Relativistic Viewport & Aberration',
    cameraBindings: Object.freeze([
      Object.freeze({ keys: 'Drag', desc: 'Look around relativistic sky' }),
      Object.freeze({ keys: 'Scroll / W S', desc: 'Optical FOV zoom' }),
      Object.freeze({ keys: 'T', desc: 'Flip Forward ↔ Aft viewport' }),
      Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Camera roll' }),
      Object.freeze({ keys: 'A / D / Arrows', desc: 'Smooth pan' }),
      Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
    ]),
  }),
  'lens-cluster': Object.freeze({
    signatureTitle: 'Interactive Source-Plane Dragging',
    cameraBindings: Object.freeze([
      Object.freeze({ keys: 'Drag', desc: 'Orbit view (or drag source)' }),
      Object.freeze({ keys: 'Shift-Drag', desc: 'Drag background galaxy directly' }),
      Object.freeze({ keys: 'T', desc: 'Toggle Drag Source ↔ Orbit View' }),
      Object.freeze({ keys: 'Scroll / W S', desc: 'Optical zoom' }),
      Object.freeze({ keys: 'Right-Drag / Q E', desc: 'Roll camera' }),
      Object.freeze({ keys: 'Double-Click / R', desc: 'Reset camera' }),
    ]),
  }),
  tde: Object.freeze({
    signatureTitle: 'Tidal Disruption Evolution Sweep',
    cameraBindings: DEFAULT_CAMERA_BINDINGS,
  }),
});

const TAB_ITEMS = Object.freeze([
  Object.freeze({ id: 'controls', btnId: 'help-tab-controls', label: 'Controls & Keys' }),
  Object.freeze({ id: 'physics', btnId: 'help-tab-physics', label: 'Physics & Presets' }),
  Object.freeze({ id: 'tips', btnId: 'help-tab-tips', label: 'Observatory & Tips' }),
]);

const OBSERVATORY_TIPS = Object.freeze([
  Object.freeze({
    title: '128× Cinema Still & PNG Capture',
    body: 'Press Space to freeze simulation motion and accumulate up to 128 jittered temporal antialiasing samples, then press P to save a lossless PNG frame.',
  }),
  Object.freeze({
    title: 'Quality Profiles & Performance',
    body: 'Open Controls (C) → Display & Performance to switch Eco / Balanced / Ultra profiles, adjust DPR Cap (1.0×–2.0×), enable 0.75× drag scaling, or press G for the live GPU Pass Profiler.',
  }),
  Object.freeze({
    title: 'Live WebGL2 ⇄ WebGPU Switching',
    body: 'Switch rendering backends on the fly inside Controls → Optics, Sky & Quality without losing camera pose, and press L anytime to copy a shareable #s= URL.',
  }),
  Object.freeze({
    title: 'Navigation & Cross-Sim Switcher',
    body: 'Use the top-right simulation switcher to search and jump directly across all 9 relativistic engines, or click the Home icon to return to the zero-GPU Observatory Homepage.',
  }),
]);

function formatBackendLabel(backend) {
  return String(backend || '').toLowerCase() === 'webgpu' ? 'WebGPU' : 'WebGL2';
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function createHelpSvgIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('aria-hidden', 'true');

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '10');
  circle.setAttribute('cy', '10');
  circle.setAttribute('r', '7.2');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7.9 7.8a2.25 2.25 0 0 1 4.25.95c0 1.35-1.55 1.75-2.05 2.55-.15.24-.15.55-.15.85');
  path.setAttribute('stroke-linecap', 'round');

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', '10');
  dot.setAttribute('cy', '14.2');
  dot.setAttribute('r', '0.9');
  dot.setAttribute('fill', 'currentColor');
  dot.setAttribute('stroke', 'none');

  svg.append(circle, path, dot);
  return svg;
}

/**
 * Mounts the Help pill button and Help Menu modal for the active simulator.
 */
export function createHelpMenu({
  simId,
  presets = [],
  getActivePresetId = () => null,
  getBackend = () => 'webgl2',
  hasAudio = false,
  audioLabel = '',
  onSelectPreset = () => {},
  onAction = () => {},
  onOpenChange = () => {},
} = {}) {
  const sim = getSimById(simId) || {
    id: simId || 'blackhole',
    title: 'Interstellar Simulator',
    tagline: 'Real-time relativistic GPU ray-tracer',
    categoryLabel: 'Relativity',
    description: '',
  };
  const catalogMeta = SIM_CATALOG_META[sim.id] || {};
  const helpProfile = SIM_HELP_PROFILES[sim.id] || {
    signatureTitle: 'Signature Control',
    cameraBindings: DEFAULT_CAMERA_BINDINGS,
  };

  let openState = false;
  let activeTab = 'controls';
  let activeBackend = formatBackendLabel(getBackend());
  let activePresetId = getActivePresetId();

  let triggerBtn = null;
  let overlayEl = null;
  let dialogEl = null;
  let footerBackendEl = null;
  const tabButtons = new Map();
  const tabPanels = new Map();
  const presetCards = [];

  function ensureTriggerButton() {
    if (typeof document === 'undefined') return null;
    if (triggerBtn && triggerBtn.isConnected) return triggerBtn;

    const existing = document.getElementById('btn-help-menu');
    if (existing) {
      triggerBtn = existing;
      return triggerBtn;
    }

    const topRight = document.querySelector('.hud-top-right');
    if (!topRight) return null;

    const btn = document.createElement('button');
    btn.id = 'btn-help-menu';
    btn.type = 'button';
    btn.className = 'pill-button glass-surface help-toggle-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'help-menu-dialog');
    btn.setAttribute('aria-label', 'Open Help Menu (?)');
    btn.title = 'Help Menu (? / F1)';

    const label = createEl('span', '', 'Help');
    btn.append(createHelpSvgIcon(), label);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    const hideBtn = document.getElementById('btn-hide-ui');
    if (hideBtn && hideBtn.parentElement === topRight) {
      topRight.insertBefore(btn, hideBtn);
    } else {
      topRight.appendChild(btn);
    }

    triggerBtn = btn;
    return triggerBtn;
  }

  function buildKeyGrid(rows) {
    const grid = createEl('div', 'help-key-grid');
    for (const item of rows) {
      const row = createEl('div', 'help-key-row');
      const kbd = createEl('kbd', 'help-kbd tabular', item.keys);
      const textWrap = createEl('span', 'help-key-desc-wrap');
      const desc = createEl('span', 'help-key-desc', item.desc);
      textWrap.appendChild(desc);
      if (item.badge) {
        const b = createEl(
          'span',
          item.badgeActive ? 'badge badge-accent help-key-badge' : 'badge badge-muted help-key-badge',
          item.badge
        );
        textWrap.appendChild(b);
      }
      row.append(kbd, textWrap);
      grid.appendChild(row);
    }
    return grid;
  }

  function buildControlsPanel() {
    const panel = createEl('section', 'help-tabpanel');
    panel.id = 'help-panel-controls';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'help-tab-controls');

    // Signature control callout
    const callout = createEl('div', 'help-callout');
    const calloutHead = createEl('div', 'help-callout-head');
    calloutHead.appendChild(createEl('span', 'help-callout-eyebrow', helpProfile.signatureTitle));
    if (hasAudio) {
      calloutHead.appendChild(
        createEl('span', 'badge badge-accent', `Audio Sonification (M): ${audioLabel || 'Ready'}`)
      );
    }
    const calloutBody = createEl(
      'p',
      'help-callout-body',
      catalogMeta.specialControl ||
        'Space freezes simulation motion to accumulate 128-sample cinema still frames.'
    );
    callout.append(calloutHead, calloutBody);
    panel.appendChild(callout);

    // Camera & Navigation
    panel.appendChild(createEl('h3', 'help-section-title', 'Camera & Navigation'));
    panel.appendChild(buildKeyGrid(helpProfile.cameraBindings));

    // Universal Observatory Shortcuts
    panel.appendChild(createEl('h3', 'help-section-title', 'Universal Observatory Shortcuts'));
    const universalRows = [
      { keys: '1 – 6', desc: 'Load physics preset' },
      { keys: 'Space', desc: 'Pause & 128× Cinema Still' },
      { keys: 'O', desc: 'Toggle auto-orbit / cruise' },
      { keys: 'C', desc: 'Open / close Controls drawer' },
      { keys: 'I', desc: 'Interactive Physics Tour ([ / ] step)' },
      { keys: 'V', desc: 'Cinema Recorder (WebM / PNG zip)' },
      { keys: 'G', desc: 'Live GPU Pass Profiler overlay' },
      { keys: 'L', desc: 'Copy shareable URL state' },
      {
        keys: 'M',
        desc: 'Audio sonification',
        badge: hasAudio ? 'Active on this sim' : 'Binary & Pulsar',
        badgeActive: hasAudio,
      },
      { keys: 'P', desc: 'Capture PNG screenshot' },
      { keys: 'R', desc: 'Reset camera to preset' },
      { keys: 'H', desc: 'Hide / restore HUD' },
      { keys: '? / F1', desc: 'Toggle this Help Menu' },
    ];
    panel.appendChild(buildKeyGrid(universalRows));

    return panel;
  }

  function buildPhysicsPanel() {
    const panel = createEl('section', 'help-tabpanel');
    panel.id = 'help-panel-physics';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'help-tab-physics');
    panel.hidden = true;

    const overview = createEl(
      'p',
      'help-physics-desc',
      catalogMeta.description || sim.description || sim.tagline
    );
    panel.appendChild(overview);

    if (Array.isArray(catalogMeta.specs) && catalogMeta.specs.length > 0) {
      const specsRow = createEl('div', 'help-spec-strip');
      for (const spec of catalogMeta.specs) {
        const cell = createEl('div', 'help-spec-cell');
        cell.append(
          createEl('span', 'help-spec-label', spec.label),
          createEl('span', 'help-spec-value tabular', spec.value)
        );
        specsRow.appendChild(cell);
      }
      panel.appendChild(specsRow);
    }

    const headRow = createEl('div', 'help-section-head-row');
    headRow.append(
      createEl('h3', 'help-section-title', 'Curated Physics Presets'),
      createEl('span', 'help-section-note', 'Click any preset to apply immediately')
    );
    panel.appendChild(headRow);

    const grid = createEl('div', 'help-preset-grid');
    presetCards.length = 0;

    const catalogPresets = Array.isArray(catalogMeta.presets) ? catalogMeta.presets : [];
    const sourceList = presets.length > 0 ? presets : catalogPresets;

    sourceList.forEach((p, idx) => {
      const catMatch = catalogPresets.find((cp) => cp.id === p.id) || catalogPresets[idx] || {};
      const presetId = p.id;
      const presetName = catMatch.name || p.name || p.shortLabel || presetId;
      const presetSummary = catMatch.summary || p.description || '';

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'help-preset-card';
      card.setAttribute('data-preset-id', presetId);

      const cardHead = createEl('div', 'help-preset-head');
      const keyNameWrap = createEl('span', 'help-preset-title-wrap');
      const keycap = createEl('kbd', 'keycap tabular', String(idx + 1));
      const nameEl = createEl('strong', 'help-preset-name', presetName);
      keyNameWrap.append(keycap, nameEl);

      const activeTag = createEl('span', 'help-preset-active-tag', 'Active');
      cardHead.append(keyNameWrap, activeTag);

      const summaryEl = createEl('p', 'help-preset-summary', presetSummary);
      card.append(cardHead, summaryEl);

      card.addEventListener('click', () => {
        activePresetId = presetId;
        syncPresetHighlight();
        close({ returnFocus: false });
        onSelectPreset(presetId);
      });

      grid.appendChild(card);
      presetCards.push({ id: presetId, el: card });
    });

    panel.appendChild(grid);

    const tourCtaWrap = createEl('div', 'help-tour-cta-row');
    const tourCta = document.createElement('button');
    tourCta.type = 'button';
    tourCta.id = 'help-open-tour-btn';
    tourCta.className = 'drawer-action-btn help-tour-cta';
    tourCta.textContent = 'Launch Interactive Physics Tour (I)';
    tourCta.addEventListener('click', () => {
      close({ returnFocus: false });
      onAction('togglePhysicsTour', true);
    });
    tourCtaWrap.appendChild(tourCta);
    panel.appendChild(tourCtaWrap);

    return panel;
  }

  function buildTipsPanel() {
    const panel = createEl('section', 'help-tabpanel');
    panel.id = 'help-panel-tips';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'help-tab-tips');
    panel.hidden = true;

    const tipsGrid = createEl('div', 'help-tips-grid');
    for (const tip of OBSERVATORY_TIPS) {
      const card = createEl('article', 'help-tip-card');
      card.append(
        createEl('h4', 'help-tip-title', tip.title),
        createEl('p', 'help-tip-body', tip.body)
      );
      tipsGrid.appendChild(card);
    }
    panel.appendChild(tipsGrid);

    panel.appendChild(createEl('h3', 'help-section-title', 'Quick Actions'));
    const actionsRow = createEl('div', 'help-quick-actions');
    const quickDefs = [
      { id: 'help-qa-controls', label: 'Open Controls (C)', action: 'toggleControls', closeFirst: true },
      { id: 'help-qa-tour', label: 'Physics Tour (I)', action: 'togglePhysicsTour', payload: true, closeFirst: true },
      { id: 'help-qa-profiler', label: 'GPU Profiler (G)', action: 'toggleProfiler', closeFirst: false },
      { id: 'help-qa-share', label: 'Copy Share URL (L)', action: 'copyShareUrl', closeFirst: false },
      { id: 'help-qa-reset', label: 'Reset Camera (R)', action: 'resetCamera', closeFirst: false },
    ];
    for (const qd of quickDefs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = qd.id;
      btn.className = 'drawer-action-btn help-quick-btn';
      btn.textContent = qd.label;
      btn.addEventListener('click', () => {
        if (qd.closeFirst) close({ returnFocus: false });
        onAction(qd.action, qd.payload);
      });
      actionsRow.appendChild(btn);
    }
    panel.appendChild(actionsRow);

    return panel;
  }

  function ensureOverlayDom() {
    if (typeof document === 'undefined') return;
    if (overlayEl) return;

    const mountRoot = document.getElementById('hud-chrome') || document.body;
    if (!mountRoot) return;

    overlayEl = createEl('div', 'help-modal-backdrop');
    overlayEl.id = 'help-menu-overlay';
    overlayEl.setAttribute('aria-hidden', 'true');
    overlayEl.hidden = true;

    overlayEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target === overlayEl) {
        close({ returnFocus: true });
      }
    });
    overlayEl.addEventListener('wheel', (e) => {
      e.stopPropagation();
    }, { passive: true });

    dialogEl = createEl('section', 'help-modal glass-surface');
    dialogEl.id = 'help-menu-dialog';
    dialogEl.setAttribute('role', 'dialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.setAttribute('aria-labelledby', 'help-menu-title');
    dialogEl.tabIndex = -1;

    // Header
    const header = createEl('header', 'help-modal-header');
    const titleBlock = createEl('div', 'help-modal-title-block');
    const idxText = catalogMeta.index || '01';
    const catText = (catalogMeta.categoryLabel || sim.categoryLabel || 'Relativity').toUpperCase();
    const eyebrow = createEl(
      'p',
      'help-modal-eyebrow tabular',
      `HELP & FLIGHT MANUAL · ${idxText} / 09 · ${catText}`
    );
    const title = createEl('h2', 'help-modal-title', sim.title);
    title.id = 'help-menu-title';
    const tagline = createEl('p', 'help-modal-tagline', sim.tagline || '');
    titleBlock.append(eyebrow, title, tagline);

    if (catalogMeta.equation) {
      const eqRibbon = createEl('div', 'help-modal-eq-ribbon');
      eqRibbon.append(
        createEl('span', 'help-eq-label', 'METRIC'),
        createEl('code', 'help-modal-eq tabular', catalogMeta.equation)
      );
      titleBlock.appendChild(eqRibbon);
    }

    const closeBtn = document.createElement('button');
    closeBtn.id = 'help-close-btn';
    closeBtn.type = 'button';
    closeBtn.className = 'icon-button help-close-btn';
    closeBtn.setAttribute('aria-label', 'Close Help Menu (Esc)');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => close({ returnFocus: true }));

    header.append(titleBlock, closeBtn);

    // Tab bar
    const tabBar = createEl('div', 'help-tabs');
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Help sections');
    tabButtons.clear();
    for (const tab of TAB_ITEMS) {
      const btn = document.createElement('button');
      btn.id = tab.btnId;
      btn.type = 'button';
      btn.className = 'help-tab-btn';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-help-tab', tab.id);
      btn.textContent = tab.label;
      btn.addEventListener('click', () => setTab(tab.id));
      tabBar.appendChild(btn);
      tabButtons.set(tab.id, btn);
    }

    // Body
    const body = createEl('div', 'help-modal-body');
    const controlsPanel = buildControlsPanel();
    const physicsPanel = buildPhysicsPanel();
    const tipsPanel = buildTipsPanel();
    tabPanels.clear();
    tabPanels.set('controls', controlsPanel);
    tabPanels.set('physics', physicsPanel);
    tabPanels.set('tips', tipsPanel);
    body.append(controlsPanel, physicsPanel, tipsPanel);

    // Footer
    const footer = createEl('footer', 'help-modal-footer');
    footerBackendEl = createEl(
      'span',
      'help-footer-meta tabular',
      `Interstellar Observatory · v${HELP_VERSION_LABEL} · ${activeBackend}`
    );

    const footerRight = createEl('div', 'help-footer-right');
    const escHint = createEl('span', 'help-footer-hint');
    const kbdEsc = createEl('kbd', 'keycap', 'Esc');
    const kbdQ = createEl('kbd', 'keycap', '?');
    escHint.append(kbdEsc, document.createTextNode(' or '), kbdQ, document.createTextNode(' to close'));

    const footerCloseBtn = document.createElement('button');
    footerCloseBtn.id = 'help-footer-close-btn';
    footerCloseBtn.type = 'button';
    footerCloseBtn.className = 'drawer-action-btn help-footer-close-btn';
    footerCloseBtn.textContent = 'Close';
    footerCloseBtn.addEventListener('click', () => close({ returnFocus: true }));

    footerRight.append(escHint, footerCloseBtn);
    footer.append(footerBackendEl, footerRight);

    dialogEl.append(header, tabBar, body, footer);
    overlayEl.appendChild(dialogEl);
    mountRoot.appendChild(overlayEl);

    syncTabUi();
    syncPresetHighlight();
  }

  function syncTabUi() {
    for (const [id, btn] of tabButtons.entries()) {
      const selected = id === activeTab;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.classList.toggle('is-active', selected);
    }
    for (const [id, panel] of tabPanels.entries()) {
      panel.hidden = id !== activeTab;
    }
  }

  function syncPresetHighlight() {
    const cur = activePresetId || getActivePresetId();
    for (const rec of presetCards) {
      const isAct = Boolean(cur && rec.id === cur);
      rec.el.classList.toggle('is-active', isAct);
      rec.el.setAttribute('aria-pressed', isAct ? 'true' : 'false');
    }
  }

  function syncBackendText() {
    if (footerBackendEl) {
      footerBackendEl.textContent = `Interstellar Observatory · v${HELP_VERSION_LABEL} · ${activeBackend}`;
    }
  }

  function setTab(tabId) {
    if (!TAB_ITEMS.some((t) => t.id === tabId)) return activeTab;
    activeTab = tabId;
    if (overlayEl) {
      syncTabUi();
      if (tabId === 'physics') syncPresetHighlight();
    }
    return activeTab;
  }

  function setOpen(nextOpen, { returnFocus = false } = {}) {
    const target = Boolean(nextOpen);
    if (target === openState) return openState;
    openState = target;

    if (openState) {
      ensureTriggerButton();
      ensureOverlayDom();
      activePresetId = getActivePresetId() || activePresetId;
      activeBackend = formatBackendLabel(getBackend());
      syncTabUi();
      syncPresetHighlight();
      syncBackendText();
    }

    if (overlayEl) {
      overlayEl.hidden = !openState;
      overlayEl.classList.toggle('is-open', openState);
      overlayEl.setAttribute('aria-hidden', openState ? 'false' : 'true');
    }

    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', openState ? 'true' : 'false');
    }

    onOpenChange(openState);

    if (openState) {
      dialogEl?.focus({ preventScroll: true });
    } else if (returnFocus) {
      triggerBtn?.focus({ preventScroll: true });
    }

    return openState;
  }

  function open() {
    return setOpen(true);
  }

  function close({ returnFocus = false } = {}) {
    return setOpen(false, { returnFocus });
  }

  function toggle(explicit) {
    const target = typeof explicit === 'boolean' ? explicit : !openState;
    return setOpen(target, { returnFocus: !target });
  }

  ensureTriggerButton();

  return {
    open,
    close,
    toggle,
    isOpen: () => openState,
    setTab,
    syncPreset(presetId) {
      activePresetId = presetId;
      if (overlayEl) syncPresetHighlight();
    },
    syncBackend(backend) {
      activeBackend = formatBackendLabel(backend);
      syncBackendText();
    },
    getState() {
      return {
        open: openState,
        tab: activeTab,
        simId: sim.id,
        backend: activeBackend,
        presetId: activePresetId || getActivePresetId(),
        presetCardCount: presetCards.length,
        hasTriggerButton: Boolean(triggerBtn && triggerBtn.isConnected),
      };
    },
    dispose() {
      triggerBtn?.remove();
      overlayEl?.remove();
      triggerBtn = null;
      overlayEl = null;
      dialogEl = null;
    },
  };
}
