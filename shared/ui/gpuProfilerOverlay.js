/**
 * gpuProfilerOverlay.js — Glassmorphic floating GPU Pass Profiler card (`G` hotkey)
 * showing live Raymarch, TAA, Bloom + Anamorphic, Composite, Total ms + 60-frame SVG sparkline.
 */

export function createGpuProfilerOverlay(mountEl) {
  const root = document.createElement('aside');
  root.id = 'gpu-profiler-overlay';
  root.className = 'gpu-profiler-overlay';
  root.setAttribute('aria-label', 'Live GPU Pass Profiler');
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;

  root.innerHTML = `
    <div class="gp-header">
      <div class="gp-title-wrap">
        <span class="gp-eyebrow">GPU PASS PROFILER</span>
        <span class="gp-badge" id="gp-backend-badge">WEBGL2 · TIMER</span>
      </div>
      <div class="gp-total-wrap">
        <span class="gp-total-val" id="gp-total-val">-- ms</span>
        <button type="button" class="gp-close" id="gp-close-btn" aria-label="Close GPU Profiler" title="Close (G)">×</button>
      </div>
    </div>
    <div class="gp-bars" id="gp-bars">
      ${[
        ['raymarch', 'Raymarch'],
        ['taa', 'TAA'],
        ['bloom', 'Bloom + Flare'],
        ['composite', 'AgX Comp'],
      ]
        .map(
          ([key, label]) => `
        <div class="gp-row" data-pass="${key}">
          <span class="gp-label">${label}</span>
          <div class="gp-track"><div class="gp-fill gp-fill-${key}" id="gp-bar-${key}"></div></div>
          <span class="gp-ms" id="gp-ms-${key}">--</span>
        </div>`
        )
        .join('')}
    </div>
    <div class="gp-spark-wrap">
      <svg class="gp-spark" viewBox="0 0 180 34" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="17" x2="180" y2="17" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2 3" />
        <polyline id="gp-spark-line" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="" />
      </svg>
      <div class="gp-foot">
        <span id="gp-cpu-val">CPU: -- ms</span>
        <span>Hot-key: G</span>
      </div>
    </div>
  `;

  (mountEl || document.body).appendChild(root);

  const badgeEl = root.querySelector('#gp-backend-badge');
  const totalEl = root.querySelector('#gp-total-val');
  const cpuEl = root.querySelector('#gp-cpu-val');
  const sparkEl = root.querySelector('#gp-spark-line');
  const closeBtn = root.querySelector('#gp-close-btn');
  const els = {
    raymarch: { bar: root.querySelector('#gp-bar-raymarch'), ms: root.querySelector('#gp-ms-raymarch') },
    taa: { bar: root.querySelector('#gp-bar-taa'), ms: root.querySelector('#gp-ms-taa') },
    bloom: { bar: root.querySelector('#gp-bar-bloom'), ms: root.querySelector('#gp-ms-bloom') },
    composite: { bar: root.querySelector('#gp-bar-composite'), ms: root.querySelector('#gp-ms-composite') },
  };

  let visible = false;
  let hudHidden = false;
  let onCloseCallback = null;

  function applyVisibility() {
    const show = visible && !hudHidden;
    root.hidden = !show;
    root.classList.toggle('is-open', show);
    root.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  closeBtn?.addEventListener('click', () => {
    setVisible(false);
    onCloseCallback?.(false);
  });

  function setVisible(next) {
    visible = Boolean(next);
    applyVisibility();
    return visible;
  }

  function setHudHidden(hidden) {
    hudHidden = Boolean(hidden);
    applyVisibility();
  }

  function onClose(cb) {
    onCloseCallback = cb;
  }

  function update(metrics) {
    if (!visible || !metrics) return;
    const modeTag = metrics.hardwareSupported ? 'HW TIMER' : 'CPU FALLBACK';
    if (badgeEl) badgeEl.textContent = `${String(metrics.backend || 'gpu').toUpperCase()} · ${modeTag}`;
    const total = Number(metrics.totalMs || 0);
    if (totalEl) totalEl.textContent = `${total.toFixed(2)} ms`;
    if (cpuEl) cpuEl.textContent = `CPU submit: ${Number(metrics.cpuMs || 0).toFixed(2)} ms`;

    const denom = Math.max(total, 1.0);
    const map = {
      raymarch: metrics.raymarchMs || 0,
      taa: metrics.taaMs || 0,
      bloom: metrics.bloomMs || 0,
      composite: metrics.compositeMs || 0,
    };
    for (const [k, val] of Object.entries(map)) {
      const slot = els[k];
      if (!slot) continue;
      const pct = metrics.hardwareSupported ? Math.min(100, Math.max(2, (val / denom) * 100)) : 0;
      if (slot.bar) slot.bar.style.width = `${pct.toFixed(1)}%`;
      if (slot.ms) slot.ms.textContent = metrics.hardwareSupported ? `${val.toFixed(2)}` : '—';
    }

    const hist = metrics.history || [];
    if (sparkEl && hist.length > 1) {
      let maxV = 4.0;
      for (let i = 0; i < hist.length; i++) {
        if (hist[i] > maxV) maxV = hist[i];
      }
      const n = hist.length;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const x = (i / Math.max(1, n - 1)) * 180;
        const y = 31 - Math.min(28, (hist[i] / maxV) * 28);
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      sparkEl.setAttribute('points', pts.join(' '));
    }
  }

  function destroy() {
    root.remove();
  }

  return {
    isVisible: () => visible,
    setVisible,
    setHudHidden,
    onClose,
    update,
    destroy,
  };
}
