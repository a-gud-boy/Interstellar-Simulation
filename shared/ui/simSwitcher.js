/**
 * Renders and synchronizes the top-right 7-simulator navigation switcher and
 * Observatory Homepage return button from `shared/simRegistry.js`, preserving
 * the active rendering backend query parameter.
 */

import { SIMULATORS } from '../simRegistry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function normalizeBackend(raw) {
  if (!raw) return 'webgl2';
  const v = String(raw).trim().toLowerCase();
  return v === 'webgpu' ? 'webgpu' : 'webgl2';
}

function createHomeIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sim-switch-home-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const roof = document.createElementNS(SVG_NS, 'path');
  roof.setAttribute('d', 'M2.25 7.25 8 2.5l5.75 4.75');

  const walls = document.createElementNS(SVG_NS, 'path');
  walls.setAttribute('d', 'M4 6.25V13.25h8V6.25');

  const core = document.createElementNS(SVG_NS, 'circle');
  core.setAttribute('cx', '8');
  core.setAttribute('cy', '9.75');
  core.setAttribute('r', '1.15');
  core.setAttribute('fill', 'currentColor');
  core.setAttribute('stroke', 'none');

  svg.append(roof, walls, core);
  return svg;
}

/**
 * Populates `nav[aria-label="Simulation switcher"]` with canonical `#sim-switch-<id>` links
 * and mounts the `#sim-switch-home` Observatory Homepage link immediately alongside it.
 * @param {{ container?: Element | null, currentSimId?: string, initialBackend?: string }} [options]
 * @returns {{ links: HTMLAnchorElement[], homeLink: HTMLAnchorElement | null, syncBackend: (backend: string) => void }}
 */
export function mountSimSwitcher({
  container = null,
  currentSimId = '',
  initialBackend = 'webgl2',
} = {}) {
  const nav =
    container || document.querySelector('nav[aria-label="Simulation switcher"]');
  if (!nav) {
    return { links: [], homeLink: null, syncBackend: () => {} };
  }

  const activeId = (currentSimId || nav.getAttribute('data-current-sim') || '')
    .trim()
    .toLowerCase();
  const backend = normalizeBackend(initialBackend);
  const links = [];

  nav.textContent = '';

  const homeLink = document.createElement('a');
  homeLink.id = 'sim-switch-home';
  homeLink.className = nav.parentElement
    ? 'sim-switch-item sim-switch-home glass-surface'
    : 'sim-switch-item sim-switch-home';
  homeLink.setAttribute('data-home-href', '../');
  homeLink.setAttribute('aria-label', 'Return to Interstellar Observatory homepage');
  homeLink.title = 'Observatory Home';
  homeLink.href = `../?backend=${backend}`;
  homeLink.appendChild(createHomeIcon());

  if (nav.parentElement) {
    const existingHome = nav.parentElement.querySelector('#sim-switch-home');
    if (existingHome) existingHome.remove();
    nav.before(homeLink);
  } else {
    nav.appendChild(homeLink);
  }

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
    const homeBaseHref = homeLink.getAttribute('data-home-href');
    if (homeBaseHref) {
      homeLink.setAttribute('href', `${homeBaseHref}?backend=${normalized}`);
    }
    for (const link of links) {
      const baseHref = link.getAttribute('data-sim-href');
      if (baseHref) {
        link.setAttribute('href', `${baseHref}?backend=${normalized}`);
      }
    }
  }

  return { links, homeLink, syncBackend };
}
