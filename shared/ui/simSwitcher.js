/**
 * Renders and synchronizes the top-right 7-simulator navigation switcher from
 * `shared/simRegistry.js`, preserving the active rendering backend query parameter.
 */

import { SIMULATORS } from '../simRegistry.js';

function normalizeBackend(raw) {
  if (!raw) return 'webgl2';
  const v = String(raw).trim().toLowerCase();
  return v === 'webgpu' ? 'webgpu' : 'webgl2';
}

/**
 * Populates `nav[aria-label="Simulation switcher"]` with canonical `#sim-switch-<id>` links.
 * @param {{ container?: Element | null, currentSimId?: string, initialBackend?: string }} [options]
 * @returns {{ links: HTMLAnchorElement[], syncBackend: (backend: string) => void }}
 */
export function mountSimSwitcher({
  container = null,
  currentSimId = '',
  initialBackend = 'webgl2',
} = {}) {
  const nav =
    container || document.querySelector('nav[aria-label="Simulation switcher"]');
  if (!nav) {
    return { links: [], syncBackend: () => {} };
  }

  const activeId = (currentSimId || nav.getAttribute('data-current-sim') || '')
    .trim()
    .toLowerCase();
  const backend = normalizeBackend(initialBackend);
  const links = [];

  nav.textContent = '';

  for (const sim of SIMULATORS) {
    const isCurrent = sim.id === activeId;
    const baseHref = isCurrent ? './' : `../${sim.dir}/`;

    const a = document.createElement('a');
    a.id = `sim-switch-${sim.id}`;
    a.className = isCurrent ? 'sim-switch-item is-current' : 'sim-switch-item';
    a.setAttribute('data-sim-id', sim.id);
    a.setAttribute('data-sim-href', baseHref);
    a.href = `${baseHref}?backend=${backend}`;

    if (isCurrent) {
      a.setAttribute('aria-current', 'page');
      const dot = document.createElement('span');
      dot.className = 'current-dot';
      dot.setAttribute('aria-hidden', 'true');
      a.appendChild(dot);
    } else {
      a.setAttribute('aria-label', sim.ariaLabel);
    }

    const label = document.createElement('span');
    label.textContent = sim.shortLabel;
    a.appendChild(label);

    nav.appendChild(a);
    links.push(a);
  }

  function syncBackend(nextBackend) {
    const normalized = normalizeBackend(nextBackend);
    for (const link of links) {
      const baseHref = link.getAttribute('data-sim-href');
      if (baseHref) {
        link.setAttribute('href', `${baseHref}?backend=${normalized}`);
      }
    }
  }

  return { links, syncBackend };
}
