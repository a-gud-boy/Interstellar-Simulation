/**
 * Renders and synchronizes the top-right compact simulation selector pill,
 * categorized glass dropdown popover, and Observatory Homepage return button
 * from `shared/simRegistry.js`, preserving the active backend query parameter.
 */

import { SIM_CATEGORIES, SIMULATORS } from '../simRegistry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function normalizeBackend(raw) {
  if (!raw) return 'webgl2';
  const v = String(raw).trim().toLowerCase();
  return v === 'webgpu' ? 'webgpu' : 'webgl2';
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function createHomeIcon() {
  const svg = createSvgEl('svg', {
    class: 'sim-switch-home-icon',
    viewBox: '0 0 16 16',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.append(
    createSvgEl('path', { d: 'M2.25 7.25 8 2.5l5.75 4.75' }),
    createSvgEl('path', { d: 'M4 6.25V13.25h8V6.25' }),
    createSvgEl('circle', {
      cx: '8',
      cy: '9.75',
      r: '1.15',
      fill: 'currentColor',
      stroke: 'none',
    })
  );
  return svg;
}

function createChevronIcon() {
  const svg = createSvgEl('svg', {
    class: 'sim-switch-chevron',
    viewBox: '0 0 16 16',
    width: '12',
    height: '12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.appendChild(createSvgEl('path', { d: 'M4.25 6.25 8 10l3.75-3.75' }));
  return svg;
}

function createSearchIcon() {
  const svg = createSvgEl('svg', {
    class: 'sim-switch-search-icon',
    viewBox: '0 0 16 16',
    width: '13',
    height: '13',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.append(
    createSvgEl('circle', { cx: '7', cy: '7', r: '4.25' }),
    createSvgEl('path', { d: 'M10.2 10.2 13.5 13.5' })
  );
  return svg;
}

function groupSimulatorsByCategory() {
  const groups = [];
  const groupedIds = new Set();

  for (const cat of SIM_CATEGORIES) {
    const items = SIMULATORS.filter((sim) => sim.category === cat.id);
    if (items.length > 0) {
      groups.push({ id: cat.id, label: cat.label, sims: items });
      for (const s of items) groupedIds.add(s.id);
    }
  }

  const remaining = SIMULATORS.filter((sim) => !groupedIds.has(sim.id));
  if (remaining.length > 0) {
    groups.push({ id: 'other', label: 'Other', sims: remaining });
  }
  return groups;
}

/**
 * Populates `nav[aria-label="Simulation switcher"]` with a compact trigger pill
 * and categorized glass dropdown containing canonical `#sim-switch-<id>` links,
 * plus the `#sim-switch-home` Observatory Homepage link alongside it.
 * @param {{ container?: Element | null, currentSimId?: string, initialBackend?: string }} [options]
 */
export function mountSimSwitcher({
  container = null,
  currentSimId = '',
  initialBackend = 'webgl2',
} = {}) {
  const nav =
    container || document.querySelector('nav[aria-label="Simulation switcher"]');
  if (!nav) {
    return {
      links: [],
      homeLink: null,
      trigger: null,
      popover: null,
      syncBackend: () => {},
      open: () => {},
      close: () => {},
      isOpen: () => false,
    };
  }

  if (nav._simSwitcherAbort) {
    nav._simSwitcherAbort.abort();
  }
  const ac = new AbortController();
  nav._simSwitcherAbort = ac;

  const activeId = (currentSimId || nav.getAttribute('data-current-sim') || '')
    .trim()
    .toLowerCase();
  const activeSim =
    SIMULATORS.find((sim) => sim.id === activeId) || SIMULATORS[0] || null;
  const backend = normalizeBackend(initialBackend);
  const links = [];
  const itemRecords = [];
  const groupRecords = [];

  nav.textContent = '';
  nav.classList.remove('is-open');

  const homeLink = document.createElement('a');
  homeLink.id = 'sim-switch-home';
  homeLink.className = nav.parentElement
    ? 'sim-switch-item sim-switch-home glass-surface'
    : 'sim-switch-item sim-switch-home';
  homeLink.setAttribute('data-home-href', '../../');
  homeLink.setAttribute(
    'aria-label',
    'Return to Interstellar Observatory homepage'
  );
  homeLink.title = 'Observatory Home';
  homeLink.href = `../../?backend=${backend}`;
  homeLink.appendChild(createHomeIcon());

  if (nav.parentElement) {
    const existingHome = nav.parentElement.querySelector('#sim-switch-home');
    if (existingHome) existingHome.remove();
    nav.before(homeLink);
  } else {
    nav.appendChild(homeLink);
  }

  // Compact trigger pill
  const trigger = document.createElement('button');
  trigger.id = 'sim-switch-trigger';
  trigger.type = 'button';
  trigger.className = 'sim-switch-trigger';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'sim-switch-popover');
  trigger.setAttribute(
    'aria-label',
    `Switch simulation (current: ${activeSim ? activeSim.shortLabel : 'None'})`
  );

  const triggerDot = document.createElement('span');
  triggerDot.className = 'current-dot';
  triggerDot.setAttribute('aria-hidden', 'true');

  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'sim-switch-trigger-label';
  triggerLabel.textContent = activeSim ? activeSim.shortLabel : 'Simulations';

  trigger.append(triggerDot, triggerLabel, createChevronIcon());

  // Categorized glass popover
  const popover = document.createElement('div');
  popover.id = 'sim-switch-popover';
  popover.className = 'sim-switch-popover glass-surface';
  popover.setAttribute('role', 'region');
  popover.setAttribute('aria-label', 'Simulations menu');
  popover.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'sim-switch-popover-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'sim-switch-popover-title-row';

  const titleEl = document.createElement('span');
  titleEl.className = 'sim-switch-popover-title';
  titleEl.textContent = 'Simulations';

  const countEl = document.createElement('span');
  countEl.className = 'sim-switch-popover-count tabular';
  countEl.textContent = `${SIMULATORS.length} engines`;

  titleRow.append(titleEl, countEl);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'sim-switch-search-wrap';

  const searchInput = document.createElement('input');
  searchInput.id = 'sim-switch-search';
  searchInput.type = 'search';
  searchInput.className = 'sim-switch-search';
  searchInput.placeholder = 'Filter simulations…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', 'Filter simulations');
  searchInput.tabIndex = -1;

  searchWrap.append(createSearchIcon(), searchInput);
  header.append(titleRow, searchWrap);

  const listEl = document.createElement('div');
  listEl.className = 'sim-switch-list';

  let currentLinkEl = null;

  for (const group of groupSimulatorsByCategory()) {
    const section = document.createElement('section');
    section.className = 'sim-switch-group';
    section.setAttribute('data-category', group.id);

    const groupHeading = document.createElement('h3');
    groupHeading.className = 'sim-switch-group-label';
    groupHeading.textContent = group.label;

    const groupItems = document.createElement('div');
    groupItems.className = 'sim-switch-group-items';

    const groupLinks = [];

    for (const sim of group.sims) {
      const isCurrent = sim.id === activeId;
      const baseHref = isCurrent ? './' : `../../${sim.dir}/`;

      const a = document.createElement('a');
      a.id = `sim-switch-${sim.id}`;
      a.className = isCurrent ? 'sim-switch-item is-current' : 'sim-switch-item';
      a.setAttribute('data-sim-id', sim.id);
      a.setAttribute('data-sim-href', baseHref);
      a.href = `${baseHref}?backend=${backend}`;
      a.tabIndex = -1;

      if (isCurrent) {
        a.setAttribute('aria-current', 'page');
        currentLinkEl = a;
      } else {
        a.setAttribute('aria-label', sim.ariaLabel);
      }

      const dot = document.createElement('span');
      dot.className = isCurrent
        ? 'sim-switch-item-dot current-dot'
        : 'sim-switch-item-dot';
      dot.style.setProperty('--item-accent', sim.accent || 'var(--accent)');
      dot.style.setProperty(
        '--item-accent-bright',
        sim.accentBright || 'var(--accent-bright)'
      );
      dot.setAttribute('aria-hidden', 'true');

      const meta = document.createElement('span');
      meta.className = 'sim-switch-item-meta';

      const head = document.createElement('span');
      head.className = 'sim-switch-item-head';

      const nameEl = document.createElement('span');
      nameEl.className = 'sim-switch-item-name';
      nameEl.textContent = sim.shortLabel;
      head.appendChild(nameEl);

      if (isCurrent) {
        const activeTag = document.createElement('span');
        activeTag.className = 'sim-switch-active-tag';
        activeTag.textContent = 'Active';
        head.appendChild(activeTag);
      }

      const taglineEl = document.createElement('span');
      taglineEl.className = 'sim-switch-item-tagline';
      taglineEl.textContent = sim.tagline || sim.title;

      meta.append(head, taglineEl);
      a.append(dot, meta);

      groupItems.appendChild(a);
      links.push(a);
      groupLinks.push(a);

      const searchHaystack = [
        sim.shortLabel,
        sim.title,
        sim.tagline,
        sim.categoryLabel,
        ...(sim.aliases || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      itemRecords.push({ el: a, searchHaystack, section });
    }

    section.append(groupHeading, groupItems);
    listEl.appendChild(section);
    groupRecords.push({ section, links: groupLinks });
  }

  const emptyEl = document.createElement('p');
  emptyEl.className = 'sim-switch-empty';
  emptyEl.textContent = 'No matching simulations';
  emptyEl.hidden = true;
  listEl.appendChild(emptyEl);

  popover.append(header, listEl);
  nav.append(trigger, popover);

  let openState = false;

  function applyFilter(rawQuery = '') {
    const query = String(rawQuery).trim().toLowerCase();
    let visibleCount = 0;

    for (const rec of itemRecords) {
      const matched = !query || rec.searchHaystack.includes(query);
      rec.el.classList.toggle('is-filtered-out', !matched);
      if (matched) visibleCount++;
    }

    for (const grp of groupRecords) {
      const anyVisible = grp.links.some(
        (el) => !el.classList.contains('is-filtered-out')
      );
      grp.section.classList.toggle('is-filtered-out', !anyVisible);
    }

    emptyEl.hidden = visibleCount > 0;
  }

  function getVisibleLinks() {
    return links.filter((el) => !el.classList.contains('is-filtered-out'));
  }

  function setOpen(nextOpen, { returnFocus = false } = {}) {
    const target = Boolean(nextOpen);
    if (target === openState) return;
    openState = target;

    nav.classList.toggle('is-open', openState);
    popover.classList.toggle('is-open', openState);
    trigger.setAttribute('aria-expanded', openState ? 'true' : 'false');
    popover.setAttribute('aria-hidden', openState ? 'false' : 'true');

    const tabVal = openState ? 0 : -1;
    searchInput.tabIndex = tabVal;
    for (const link of links) {
      link.tabIndex = tabVal;
    }

    if (openState) {
      const drawer = document.getElementById('controls-drawer');
      if (drawer?.classList.contains('is-open')) {
        document.getElementById('controls-close')?.click();
      }
      searchInput.value = '';
      applyFilter('');
      searchInput.focus({ preventScroll: true });
      if (currentLinkEl && typeof currentLinkEl.scrollIntoView === 'function') {
        currentLinkEl.scrollIntoView({ block: 'nearest' });
      }
    } else {
      searchInput.value = '';
      applyFilter('');
      if (returnFocus) {
        trigger.focus({ preventScroll: true });
      }
    }
  }

  trigger.addEventListener(
    'click',
    (e) => {
      e.stopPropagation();
      setOpen(!openState);
    },
    { signal: ac.signal }
  );

  searchInput.addEventListener(
    'input',
    () => {
      applyFilter(searchInput.value);
    },
    { signal: ac.signal }
  );

  popover.addEventListener(
    'pointerdown',
    (e) => {
      e.stopPropagation();
    },
    { signal: ac.signal }
  );

  popover.addEventListener(
    'wheel',
    (e) => {
      e.stopPropagation();
    },
    { passive: true, signal: ac.signal }
  );

  popover.addEventListener(
    'keydown',
    (e) => {
      if (!openState) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false, { returnFocus: true });
        return;
      }

      if (e.key === 'Enter' && e.target === searchInput) {
        const firstVisible = getVisibleLinks()[0];
        if (firstVisible) {
          e.preventDefault();
          firstVisible.click();
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const focusables = [searchInput, ...getVisibleLinks()];
        if (focusables.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const curIdx = focusables.indexOf(document.activeElement);
        let nextIdx;
        if (e.key === 'ArrowDown') {
          nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % focusables.length;
        } else {
          nextIdx =
            curIdx <= 0 ? focusables.length - 1 : curIdx - 1;
        }
        focusables[nextIdx]?.focus({ preventScroll: false });
      }
    },
    { signal: ac.signal }
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (openState && !nav.contains(e.target)) {
        setOpen(false);
      }
    },
    { signal: ac.signal }
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (openState && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false, { returnFocus: true });
      }
    },
    { signal: ac.signal }
  );

  const controlsToggle = document.getElementById('controls-toggle');
  controlsToggle?.addEventListener(
    'click',
    () => {
      if (openState) setOpen(false);
    },
    { signal: ac.signal }
  );

  const hudChrome = document.getElementById('hud-chrome');
  if (hudChrome && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (openState && hudChrome.classList.contains('is-hud-hidden')) {
        setOpen(false);
      }
    });
    observer.observe(hudChrome, { attributes: true, attributeFilter: ['class'] });
    ac.signal.addEventListener('abort', () => observer.disconnect(), {
      once: true,
    });
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

  return {
    links,
    homeLink,
    trigger,
    popover,
    syncBackend,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => openState,
  };
}
