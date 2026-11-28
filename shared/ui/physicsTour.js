/**
 * physicsTour.js — Interactive Physics Tour & Annotated HUD Overlay.
 * Renders floating reticle pins and a bottom-left guided explanation card inside `#hud-chrome`.
 */

import { getPresetTour } from './physicsTourData.js';

export function createPhysicsTour({
  simId,
  getPresetId = () => null,
  getTelemetrySummary = () => '',
  onOpenChange = () => {},
} = {}) {
  const hudChrome = typeof document !== 'undefined' ? document.getElementById('hud-chrome') : null;
  let open = false;
  let activePresetId = getPresetId();
  let activeStep = 0;

  let layerEl = null;
  let pinsLayerEl = null;
  let cardEl = null;
  let eyebrowEl = null;
  let headlineEl = null;
  let formulaEl = null;
  let summaryEl = null;
  let liveNoteEl = null;
  let calloutTitleEl = null;
  let calloutMetricEl = null;
  let calloutDetailEl = null;
  let stepperDotsEl = null;
  let btnPrev = null;
  let btnNext = null;
  let btnClose = null;
  const pinButtons = [];

  function ensureDom() {
    if (layerEl || !hudChrome) return;

    layerEl = document.createElement('section');
    layerEl.id = 'physics-tour-overlay';
    layerEl.className = 'physics-tour-layer';
    layerEl.setAttribute('aria-label', 'Interactive Physics Tour');
    layerEl.hidden = true;

    pinsLayerEl = document.createElement('div');
    pinsLayerEl.className = 'physics-tour-pins';

    cardEl = document.createElement('article');
    cardEl.className = 'tour-card glass-surface';
    cardEl.setAttribute('role', 'region');
    cardEl.setAttribute('aria-label', 'Relativistic Phenomena Guide');

    const header = document.createElement('header');
    header.className = 'tour-card-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'tour-card-title-wrap';

    eyebrowEl = document.createElement('span');
    eyebrowEl.className = 'tour-eyebrow tabular';

    headlineEl = document.createElement('h3');
    headlineEl.className = 'tour-headline';

    titleWrap.append(eyebrowEl, headlineEl);

    btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.id = 'tour-close-btn';
    btnClose.className = 'icon-button tour-close-btn';
    btnClose.setAttribute('aria-label', 'Close Physics Tour (I)');
    btnClose.textContent = '✕';
    btnClose.addEventListener('click', () => setOpen(false));

    header.append(titleWrap, btnClose);

    formulaEl = document.createElement('code');
    formulaEl.className = 'tour-formula tabular';

    summaryEl = document.createElement('p');
    summaryEl.className = 'tour-summary';

    liveNoteEl = document.createElement('p');
    liveNoteEl.className = 'tour-live-note tabular';

    const calloutBox = document.createElement('div');
    calloutBox.className = 'tour-callout-box';

    const calloutHead = document.createElement('div');
    calloutHead.className = 'tour-callout-head';

    calloutTitleEl = document.createElement('strong');
    calloutTitleEl.className = 'tour-callout-title';

    calloutMetricEl = document.createElement('span');
    calloutMetricEl.className = 'badge badge-accent tabular tour-callout-metric';

    calloutHead.append(calloutTitleEl, calloutMetricEl);

    calloutDetailEl = document.createElement('p');
    calloutDetailEl.className = 'tour-callout-detail';

    calloutBox.append(calloutHead, calloutDetailEl);

    const footer = document.createElement('footer');
    footer.className = 'tour-stepper';

    btnPrev = document.createElement('button');
    btnPrev.type = 'button';
    btnPrev.id = 'tour-prev-btn';
    btnPrev.className = 'tour-step-btn';
    btnPrev.textContent = '← Prev';
    btnPrev.addEventListener('click', () => step(-1));

    stepperDotsEl = document.createElement('div');
    stepperDotsEl.className = 'tour-step-dots';

    btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.id = 'tour-next-btn';
    btnNext.className = 'tour-step-btn';
    btnNext.textContent = 'Next →';
    btnNext.addEventListener('click', () => step(1));

    footer.append(btnPrev, stepperDotsEl, btnNext);

    cardEl.append(header, formulaEl, summaryEl, liveNoteEl, calloutBox, footer);
    layerEl.append(pinsLayerEl, cardEl);
    hudChrome.appendChild(layerEl);
  }

  function render() {
    if (!open) return;
    ensureDom();
    if (!layerEl) return;

    const tour = getPresetTour(simId, activePresetId || getPresetId());
    if (!tour || !Array.isArray(tour.callouts) || tour.callouts.length === 0) return;

    const count = tour.callouts.length;
    activeStep = ((activeStep % count) + count) % count;
    const current = tour.callouts[activeStep];

    eyebrowEl.textContent = `PHYSICS TOUR · ${activeStep + 1} / ${count}`;
    headlineEl.textContent = tour.headline;
    formulaEl.textContent = tour.formula;
    summaryEl.textContent = tour.summary;

    const liveText = getTelemetrySummary?.() || '';
    liveNoteEl.textContent = liveText;
    liveNoteEl.hidden = !liveText;

    calloutTitleEl.textContent = `${activeStep + 1}. ${current.title}`;
    calloutMetricEl.textContent = current.metric;
    calloutDetailEl.textContent = current.detail;

    // Render pins
    pinsLayerEl.textContent = '';
    pinButtons.length = 0;
    stepperDotsEl.textContent = '';

    tour.callouts.forEach((c, idx) => {
      const isCur = idx === activeStep;

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = isCur ? 'tour-pin is-active' : 'tour-pin';
      pin.style.left = `${(c.x * 100).toFixed(2)}%`;
      pin.style.top = `${(c.y * 100).toFixed(2)}%`;
      pin.setAttribute('aria-pressed', isCur ? 'true' : 'false');
      pin.setAttribute('aria-label', `Callout ${idx + 1}: ${c.title}`);

      const ring = document.createElement('span');
      ring.className = 'tour-pin-ring';
      ring.setAttribute('aria-hidden', 'true');

      const num = document.createElement('span');
      num.className = 'tour-pin-num tabular';
      num.textContent = String(idx + 1);

      const lbl = document.createElement('span');
      lbl.className = 'tour-pin-label';
      lbl.textContent = c.title;

      pin.append(ring, num, lbl);
      pin.addEventListener('click', () => selectCallout(idx));
      pinsLayerEl.appendChild(pin);
      pinButtons.push(pin);

      const dotBtn = document.createElement('button');
      dotBtn.type = 'button';
      dotBtn.className = isCur ? 'tour-dot-btn is-active' : 'tour-dot-btn';
      dotBtn.textContent = String(idx + 1);
      dotBtn.setAttribute('aria-pressed', isCur ? 'true' : 'false');
      dotBtn.addEventListener('click', () => selectCallout(idx));
      stepperDotsEl.appendChild(dotBtn);
    });
  }

  function setOpen(nextOpen) {
    const target = Boolean(nextOpen);
    if (target === open) return open;
    open = target;
    ensureDom();
    if (layerEl) {
      layerEl.hidden = !open;
    }
    if (open) {
      activePresetId = getPresetId() || activePresetId;
      activeStep = 0;
      render();
    }
    onOpenChange(open);
    return open;
  }

  function selectCallout(idx) {
    activeStep = Number(idx) || 0;
    if (open) render();
  }

  function step(delta) {
    activeStep += Number(delta) || 0;
    if (open) render();
  }

  return {
    setOpen,
    toggle(explicit) {
      return setOpen(typeof explicit === 'boolean' ? explicit : !open);
    },
    isOpen() {
      return open;
    },
    setPreset(presetId) {
      activePresetId = presetId;
      activeStep = 0;
      if (open) render();
    },
    selectCallout,
    step,
    updateLiveNote(text) {
      if (liveNoteEl && open) {
        liveNoteEl.textContent = text || '';
        liveNoteEl.hidden = !text;
      }
    },
    getState() {
      const tour = getPresetTour(simId, activePresetId || getPresetId());
      return {
        open,
        presetId: activePresetId || getPresetId(),
        stepIndex: activeStep,
        stepCount: tour?.callouts?.length || 0,
        activeCalloutTitle: tour?.callouts?.[activeStep]?.title || null,
      };
    },
    dispose() {
      layerEl?.remove();
      layerEl = null;
    },
  };
}
