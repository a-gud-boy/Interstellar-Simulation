#!/usr/bin/env node
/**
 * Interstellar Observatory Homepage — Automated Hardware Chrome QA, Low-Resource Audit & Visual Capture Suite
 *
 * Verifies:
 *  1. Homepage Load & Zero Errors (1440x810): 0 console/runtime/HTTP errors, 8 cards, all preview <img> loaded, 0 horizontal overflow
 *  2. Strict Low-Resource Audit: 0 <canvas> elements, 0 idle rAF ticks over 1500ms, 0 milkyway_4k.jpg requests, total transfer < 1.2 MB
 *  3. Interactive UX Flows: hero spotlight switcher, category filter pills, global WebGL2 <-> WebGPU toggle,
 *     Quick-Inspect <dialog> dossier (open, 6 presets + equation, close button + Escape),
 *     and Navigation E2E (launch simulator with ?backend=webgpu + return via #sim-switch-home preserving ?backend=webgpu)
 *  4. Routing Backwards Compatibility: /?sim=pulsar&backend=webgpu redirects to /sims/pulsar/?backend=webgpu; /?hub renders homepage
 *  5. Visual Screenshots at desktop (1440x810) and mobile (390x844, zero horizontal overflow)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../testing/staticServer.mjs';
import { sleep, launchChromeDualCDP } from '../testing/chromeCdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

const DESKTOP_W = 1440;
const DESKTOP_H = 810;
const MOBILE_W = 390;
const MOBILE_H = 844;

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port, getSkyRequestCount } = await startStaticServer({ preferredPort: 8791 });
  const debugPort = 9650 + Math.floor(Math.random() * 250);
  const cdp = await launchChromeDualCDP({
    debugPort,
    viewportW: DESKTOP_W,
    viewportH: DESKTOP_H,
    profilePrefix: 'interstellar-homepage-qa-',
  });

  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const failedRequests = [];
  let currentStep = 'init';

  // Track network traffic for homepage load audit
  let trackHomepageNetwork = true;
  const homepageRequests = new Map(); // requestId -> { url, status, encodedBytes }

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: DESKTOP_W,
      height: DESKTOP_H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') consoleErrors.push(text);
      else if (p.type === 'warning') consoleWarnings.push(text);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const ex = p.exceptionDetails;
      exceptions.push(`[${currentStep}] ${ex?.exception?.description || ex?.text || JSON.stringify(ex)}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') consoleErrors.push(`[Log] ${p.entry.text}`);
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response.status >= 400) {
        failedRequests.push(`${p.response.status} ${p.response.url}`);
      }
      if (trackHomepageNetwork) {
        homepageRequests.set(p.requestId, {
          url: p.response.url,
          status: p.response.status,
          mimeType: p.response.mimeType,
          encodedBytes: 0,
        });
      }
    });
    cdp.on('Network.loadingFinished', (p) => {
      if (trackHomepageNetwork && homepageRequests.has(p.requestId)) {
        homepageRequests.get(p.requestId).encodedBytes = p.encodedDataLength || 0;
      }
    });
    cdp.on('Network.loadingFailed', (p) => {
      if (p.canceled || p.errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`FAILED: ${p.errorText}`);
    });

    const evalJS = async (expression, awaitPromise = false) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result?.value;
    };

    const waitForCondition = async (expr, maxMs = 12000, pollMs = 100) => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        try {
          const val = await evalJS(expr);
          if (val) return val;
        } catch {
          // page mid-navigation
        }
        await sleep(pollMs);
      }
      return await evalJS(expr);
    };

    const captureShot = async (filename) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(SHOT_DIR, filename);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      return outPath;
    };

    const pressKey = async (key, code, keyCode) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await sleep(180);
    };

    // =========================================================================
    // TEST 1 & 2: Homepage Load, Low-Resource Audit & Desktop Screenshots
    // =========================================================================
    const homeUrl = `http://127.0.0.1:${port}/`;
    currentStep = '1_home_load';
    console.log(`1. Navigating to Homepage ${homeUrl} (${DESKTOP_W}x${DESKTOP_H})...`);
    await cdp.send('Page.navigate', { url: homeUrl });

    await waitForCondition(
      `document.readyState === 'complete' && document.querySelectorAll('#catalog-grid .sim-card').length === 9 && document.getElementById('stage-bg-img')?.complete && document.getElementById('stage-bg-img')?.naturalWidth > 0`
    );
    await sleep(300);

    // Capture full-bleed Observatory Hero screenshot
    const shotDesktopHero = await captureShot('01_desktop_hero.png');
    console.log('Captured 01_desktop_hero.png');

    // Audit idle rAF (0 ticks over 1500ms) BEFORE any pointer/scroll interaction
    currentStep = '2_idle_audit';
    console.log('2. Running Strict Low-Resource Audit (1500ms idle rAF + canvas + network)...');
    const idleAudit = await evalJS(
      `(async () => {
        const canvasCount = document.querySelectorAll('canvas').length;
        let rafCount = 0;
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = function (...args) {
          rafCount++;
          return origRaf.apply(this, args);
        };
        await new Promise((r) => setTimeout(r, 1500));
        window.requestAnimationFrame = origRaf;
        return {
          canvasCount,
          idleRafCount: rafCount,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          overflowPx: document.documentElement.scrollWidth - window.innerWidth,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        };
      })()`,
      true
    );

    const loadStats = await evalJS(`(() => {
      const cards = Array.from(document.querySelectorAll('#catalog-grid .sim-card'));
      const imgs = Array.from(document.querySelectorAll('img')).map((img) => ({
        id: img.id || img.closest('.sim-card')?.dataset?.simId || 'img',
        src: img.getAttribute('src'),
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      }));
      return {
        cardCount: cards.length,
        cardIds: cards.map((c) => c.dataset.simId),
        imgCount: imgs.length,
        allImgsLoaded: imgs.length >= 8 && imgs.every((i) => i.complete && i.naturalWidth > 0),
        imgs,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`);

    // Snapshot homepage network weight before navigating to simulators
    trackHomepageNetwork = false;
    const homepageReqList = Array.from(homepageRequests.values());
    const homepageTotalBytes = homepageReqList.reduce((acc, r) => acc + (r.encodedBytes || 0), 0);
    const homepageSkyRequests = homepageReqList.filter((r) => r.url.includes('milkyway_4k.jpg')).length;
    const serverSkyRequestsOnHome = getSkyRequestCount();

    console.log(
      `Homepage payload: ${(homepageTotalBytes / 1024).toFixed(1)} KB across ${homepageReqList.length} requests (skyRequests=${serverSkyRequestsOnHome}, idleRaf=${idleAudit.idleRafCount})`
    );

    // =========================================================================
    // TEST 3: Interactive UX Flows
    // =========================================================================
    console.log('3. Testing interactive UX flows (Filmstrip Switcher, Filters, Backend Toggle, Dossier, Controls, Navigation E2E)...');

    // 3a. Bottom filmstrip spotlight switcher (Black Hole -> Wormhole)
    const heroBefore = await evalJS(`({
      title: document.getElementById('hero-sim-title')?.textContent?.trim(),
      imgSrc: document.getElementById('stage-bg-img')?.getAttribute('src'),
      launchHref: document.getElementById('hero-launch-btn')?.getAttribute('href'),
    })`);

    await evalJS(`document.querySelector('#catalog-grid .sim-card[data-sim-id="wormhole"] .sim-card-select')?.click()`);
    await waitForCondition(
      `document.getElementById('stage-bg-img')?.getAttribute('src')?.includes('wormhole.webp') && document.getElementById('stage-bg-img')?.complete && document.getElementById('stage-bg-img')?.naturalWidth > 0`
    );
    await sleep(220);

    const shotWormholeSpotlight = await captureShot('02_desktop_wormhole_spotlight.png');
    console.log('Captured 02_desktop_wormhole_spotlight.png');

    const heroAfter = await evalJS(`({
      title: document.getElementById('hero-sim-title')?.textContent?.trim(),
      imgSrc: document.getElementById('stage-bg-img')?.getAttribute('src'),
      imgWidth: document.getElementById('stage-bg-img')?.naturalWidth,
      launchHref: document.getElementById('hero-launch-btn')?.getAttribute('href'),
      activeCardId: document.querySelector('#catalog-grid .sim-card.is-active')?.getAttribute('data-sim-id'),
      cardBtnPressed: document.querySelector('#catalog-grid .sim-card[data-sim-id="wormhole"] .sim-card-select')?.getAttribute('aria-pressed'),
    })`);

    // Switch back to blackhole for clean baseline
    await evalJS(`document.querySelector('#catalog-grid .sim-card[data-sim-id="blackhole"] .sim-card-select')?.click()`);
    await waitForCondition(`document.getElementById('stage-bg-img')?.getAttribute('src')?.includes('blackhole.webp')`);
    await sleep(160);

    // 3b. Category filter pills (General Relativity -> 3 cards; All -> 8 cards)
    await evalJS(`document.querySelector('#category-filter-bar button[data-category="gr"]')?.click()`);
    await sleep(150);
    const filterGR = await evalJS(`(() => {
      const visible = Array.from(document.querySelectorAll('#catalog-grid .sim-card')).filter((c) => !c.hidden);
      return {
        count: visible.length,
        ids: visible.map((c) => c.dataset.simId),
        selected: document.querySelector('#category-filter-bar button[data-category="gr"]')?.getAttribute('aria-selected'),
      };
    })()`);
    const shotFilteredGR = await captureShot('03_desktop_filtered_gr.png');
    console.log('Captured 03_desktop_filtered_gr.png');

    await evalJS(`document.querySelector('#category-filter-bar button[data-category="all"]')?.click()`);
    await sleep(150);
    const filterAll = await evalJS(`(() => {
      const visible = Array.from(document.querySelectorAll('#catalog-grid .sim-card')).filter((c) => !c.hidden);
      return {
        count: visible.length,
        ids: visible.map((c) => c.dataset.simId),
      };
    })()`);

    // 3c. Global Backend toggle (WebGL2 -> WebGPU)
    await evalJS(`document.querySelector('#backend-radiogroup button[data-backend="webgpu"]')?.click()`);
    await sleep(120);
    const backendToggleCheck = await evalJS(`(() => {
      const glChecked = document.querySelector('#backend-radiogroup button[data-backend="webgl2"]')?.getAttribute('aria-checked');
      const gpuChecked = document.querySelector('#backend-radiogroup button[data-backend="webgpu"]')?.getAttribute('aria-checked');
      const dynamicLinks = Array.from(document.querySelectorAll('a[data-sim-launch]')).filter((a) => a.id !== 'dossier-launch-webgl2');
      return {
        glChecked,
        gpuChecked,
        launchCount: dynamicLinks.length,
        allHaveWebGPU: dynamicLinks.length >= 8 && dynamicLinks.every((l) => l.getAttribute('href')?.includes('backend=webgpu')),
        sampleHrefs: dynamicLinks.slice(0, 4).map((a) => ({ id: a.id || a.dataset.simLaunch, href: a.getAttribute('href') })),
      };
    })()`);

    // 3d. Quick-Inspect <dialog> dossier (Hero inspect button -> 6 presets & equation -> close -> Escape)
    await evalJS(`document.getElementById('hero-inspect-btn')?.click()`);
    await waitForCondition(`document.getElementById('sim-dossier')?.open === true`);
    await sleep(200);

    const dossierOpenCheck = await evalJS(`({
      open: document.getElementById('sim-dossier')?.open === true,
      title: document.getElementById('dossier-title')?.textContent?.trim(),
      equation: document.getElementById('dossier-equation')?.textContent?.trim(),
      presetCount: document.querySelectorAll('#dossier-presets .preset-launch-chip').length,
      specCount: document.querySelectorAll('#dossier-specs .dossier-spec-item').length,
      cliCmd: document.getElementById('dossier-cli-cmd')?.textContent?.trim(),
      webglHref: document.getElementById('dossier-launch-webgl2')?.getAttribute('href'),
      webgpuHref: document.getElementById('dossier-launch-webgpu')?.getAttribute('href'),
    })`);

    const shotDesktopDossier = await captureShot('04_desktop_dossier_open.png');
    console.log('Captured 04_desktop_dossier_open.png');

    await evalJS(`document.querySelector('#sim-dossier [data-close-dialog="sim-dossier"]')?.click()`);
    await sleep(140);
    const closedViaButton = await evalJS(`document.getElementById('sim-dossier')?.open === false`);

    // Re-open via Hero Inspect button and verify Escape closes cleanly
    await evalJS(`document.getElementById('hero-inspect-btn')?.click()`);
    await waitForCondition(`document.getElementById('sim-dossier')?.open === true`);
    await sleep(120);
    await pressKey('Escape', 'Escape', 27);
    const closedViaEscape = await evalJS(`document.getElementById('sim-dossier')?.open === false`);

    // 3e. Controls <dialog> (Topbar Controls button -> screenshot -> Escape)
    await evalJS(`document.getElementById('open-controls-btn')?.click()`);
    await waitForCondition(`document.getElementById('controls-dialog')?.open === true`);
    await sleep(180);
    const shotDesktopControls = await captureShot('05_desktop_controls_dialog.png');
    console.log('Captured 05_desktop_controls_dialog.png');
    await pressKey('Escape', 'Escape', 27);
    const controlsClosedViaEscape = await evalJS(`document.getElementById('controls-dialog')?.open === false`);

    // 3f. Navigation E2E: Launch simulator with ?backend=webgpu -> return via #sim-switch-home preserving ?backend=webgpu
    currentStep = '4a_launch_blackhole';
    console.log('4. Testing Navigation E2E (Homepage -> sims/blackhole ?backend=webgpu -> #sim-switch-home -> Homepage)...');
    await evalJS(`document.getElementById('hero-launch-btn')?.click()`);
    const simLaunchDiag = await waitForCondition(`(() => {
      const api = window.__GARGANTUA__;
      const d = api?.getDiagnostics?.();
      const homeLink = document.getElementById('sim-switch-home');
      if (window.location.pathname.includes('/sims/blackhole/') && d && d.backend === 'webgpu' && !d.switchingBackend && homeLink) {
        return {
          pathname: window.location.pathname,
          search: window.location.search,
          backend: d.backend,
          allShadersCompiled: d.allShadersCompiled,
          homeHref: homeLink.getAttribute('href'),
          homeHasSimHrefAttr: homeLink.hasAttribute('data-sim-href'),
          simSwitchCount: document.querySelectorAll('nav[aria-label="Simulation switcher"] a[data-sim-href]').length,
        };
      }
      return null;
    })()`, 15000, 120);

    currentStep = '4b_return_home';
    await evalJS(`document.getElementById('sim-switch-home')?.click()`);
    const returnedHomeCheck = await waitForCondition(`(() => {
      const gpuBtn = document.querySelector('#backend-radiogroup button[data-backend="webgpu"]');
      const cards = document.querySelectorAll('#catalog-grid .sim-card');
      if (window.location.pathname === '/' && cards.length === 9 && gpuBtn) {
        return {
          pathname: window.location.pathname,
          search: window.location.search,
          gpuChecked: gpuBtn.getAttribute('aria-checked'),
          heroLaunchHref: document.getElementById('hero-launch-btn')?.getAttribute('href'),
        };
      }
      return null;
    })()`, 10000, 100);

    // =========================================================================
    // TEST 4: Routing Backwards Compatibility
    // =========================================================================
    currentStep = '5a_redirect_pulsar';
    console.log('5. Testing Routing Backwards Compatibility (/?sim=pulsar&backend=webgpu & /?hub)...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?sim=pulsar&backend=webgpu` });
    const redirectPulsarCheck = await waitForCondition(`(() => {
      const d = window.__PULSAR__?.getDiagnostics?.();
      if (window.location.pathname.includes('/sims/pulsar/') && d && d.backend === 'webgpu' && !d.switchingBackend) {
        return {
          pathname: window.location.pathname,
          search: window.location.search,
          backend: d.backend,
          allShadersCompiled: d.allShadersCompiled,
        };
      }
      return null;
    })()`, 15000, 120);

    currentStep = '5b_hub_param';
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?hub` });
    const hubCheck = await waitForCondition(`(() => {
      const cards = document.querySelectorAll('#catalog-grid .sim-card');
      if (window.location.pathname === '/' && window.location.search.includes('hub') && cards.length === 9) {
        return {
          pathname: window.location.pathname,
          search: window.location.search,
          cardCount: cards.length,
          canvasCount: document.querySelectorAll('canvas').length,
        };
      }
      return null;
    })()`, 10000, 100);

    // =========================================================================
    // TEST 5: Mobile Viewport (390x844) Layout & Zero Overflow Audit
    // =========================================================================
    currentStep = '6_mobile_audit';
    console.log(`6. Auditing Mobile Viewport (${MOBILE_W}x${MOBILE_H})...`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: MOBILE_W,
      height: MOBILE_H,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitForCondition(
      `document.readyState === 'complete' && document.querySelectorAll('#catalog-grid .sim-card').length === 9 && document.getElementById('stage-bg-img')?.complete && document.getElementById('stage-bg-img')?.naturalWidth > 0`
    );
    await sleep(300);

    const mobileHeroOverflow = await evalJS(`({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    })`);
    const shotMobileHero = await captureShot('06_mobile_top.png');
    console.log('Captured 06_mobile_top.png');

    await evalJS(`document.getElementById('catalog-grid')?.scrollIntoView({ behavior: 'instant', block: 'center' })`);
    await sleep(350);
    const mobileCatalogOverflow = await evalJS(`({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    })`);
    const shotMobileCatalog = await captureShot('07_mobile_filmstrip.png');
    console.log('Captured 07_mobile_filmstrip.png');

    // =========================================================================
    // Report & Assertions
    // =========================================================================
    const report = {
      loadStats,
      idleAudit,
      network: {
        requestCount: homepageReqList.length,
        totalBytes: homepageTotalBytes,
        totalKB: +(homepageTotalBytes / 1024).toFixed(1),
        homepageSkyRequests,
        serverSkyRequestsOnHome,
        requests: homepageReqList,
      },
      interactions: {
        heroBefore,
        heroAfter,
        filterGR,
        filterAll,
        backendToggleCheck,
        dossierOpenCheck,
        closedViaButton,
        closedViaEscape,
        controlsClosedViaEscape,
        simLaunchDiag,
        returnedHomeCheck,
      },
      routing: {
        redirectPulsarCheck,
        hubCheck,
      },
      mobile: {
        mobileHeroOverflow,
        mobileCatalogOverflow,
      },
      screenshots: {
        desktopHero: shotDesktopHero,
        desktopWormholeSpotlight: shotWormholeSpotlight,
        desktopFilteredGR: shotFilteredGR,
        desktopDossier: shotDesktopDossier,
        desktopControls: shotDesktopControls,
        mobileTop: shotMobileHero,
        mobileFilmstrip: shotMobileCatalog,
      },
      errors: { consoleErrors, consoleWarnings, exceptions, failedRequests },
    };

    fs.writeFileSync(path.join(SHOT_DIR, 'homepage_qa_report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== AUTOMATED HOMEPAGE QA ASSERTIONS ===');
    let qaFail = 0;
    const check = (cond, msg, detail = '') => {
      if (cond) console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ''}`);
      else {
        qaFail++;
        console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`);
      }
    };

    check(consoleErrors.length === 0, 'Zero JS console errors', consoleErrors.join(' | '));
    check(exceptions.length === 0, 'Zero uncaught runtime exceptions', exceptions.join(' | '));
    check(failedRequests.length === 0, 'Zero failed HTTP/network requests', failedRequests.join(' | '));

    check(loadStats.cardCount === 9, 'All 9 simulator filmstrip cards rendered', loadStats.cardIds.join(', '));
    check(
      loadStats.allImgsLoaded === true,
      'All homepage preview <img> elements decoded cleanly (complete && naturalWidth > 0)',
      `${loadStats.imgCount} images`
    );
    check(
      idleAudit.scrollWidth <= idleAudit.innerWidth &&
        loadStats.scrollWidth <= loadStats.innerWidth &&
        idleAudit.scrollHeight <= idleAudit.innerHeight + 1,
      'Single-viewport desktop fit (zero horizontal or vertical overflow at 1440x810)',
      `w=${idleAudit.scrollWidth}/${idleAudit.innerWidth}, h=${idleAudit.scrollHeight}/${idleAudit.innerHeight}`
    );

    check(idleAudit.canvasCount === 0, 'Zero <canvas> elements on homepage', `canvasCount=${idleAudit.canvasCount}`);
    check(
      idleAudit.idleRafCount === 0,
      'Zero requestAnimationFrame callbacks fired during 1500ms idle',
      `idleRafCount=${idleAudit.idleRafCount}`
    );
    check(
      homepageSkyRequests === 0 && serverSkyRequestsOnHome === 0,
      'Zero requests to milkyway_4k.jpg on homepage',
      `cdp=${homepageSkyRequests}, server=${serverSkyRequestsOnHome}`
    );
    check(
      homepageTotalBytes > 0 && homepageTotalBytes < 1.2 * 1024 * 1024,
      'Total homepage network weight is lightweight (< 1.2 MB)',
      `${(homepageTotalBytes / 1024).toFixed(1)} KB`
    );

    check(
      heroAfter.title !== heroBefore.title &&
        heroAfter.imgSrc !== heroBefore.imgSrc &&
        heroAfter.imgSrc?.includes('wormhole.webp') &&
        heroAfter.imgWidth > 0 &&
        heroAfter.launchHref?.includes('sims/wormhole') &&
        heroAfter.activeCardId === 'wormhole' &&
        heroAfter.cardBtnPressed === 'true',
      'Filmstrip spotlight switcher updates stage backdrop, title, active pill, and launch href',
      `${heroBefore.title} -> ${heroAfter.title}`
    );

    check(
      filterGR.count === 3 &&
        filterGR.ids.includes('blackhole') &&
        filterGR.ids.includes('binary') &&
        filterGR.ids.includes('lens-cluster') &&
        filterAll.count === 9,
      'Category filter pills filter General Relativity to 3 sims (blackhole, binary, lens-cluster) and restore all 9',
      `GR=[${filterGR.ids.join(', ')}], All=${filterAll.count}`
    );

    check(
      backendToggleCheck.glChecked === 'false' &&
        backendToggleCheck.gpuChecked === 'true' &&
        backendToggleCheck.allHaveWebGPU === true,
      'Global backend toggle WebGL2 -> WebGPU updates launch hrefs across Hero & Filmstrip',
      `${backendToggleCheck.launchCount} launch links synced`
    );

    check(
      dossierOpenCheck.open === true &&
        dossierOpenCheck.presetCount === 6 &&
        Boolean(dossierOpenCheck.equation) &&
        closedViaButton === true &&
        closedViaEscape === true &&
        controlsClosedViaEscape === true,
      'Quick-Inspect <dialog> dossier (6 presets + equation) and Controls <dialog> open and close cleanly',
      `presets=${dossierOpenCheck.presetCount}, eq="${dossierOpenCheck.equation}"`
    );

    check(
      simLaunchDiag?.pathname?.includes('/sims/blackhole/') &&
        simLaunchDiag?.search?.includes('backend=webgpu') &&
        simLaunchDiag?.backend === 'webgpu' &&
        simLaunchDiag?.allShadersCompiled === true &&
        simLaunchDiag?.homeHref === '../../?backend=webgpu' &&
        simLaunchDiag?.homeHasSimHrefAttr === false &&
        simLaunchDiag?.simSwitchCount === 9,
      'Launching simulator from homepage boots in WebGPU with #sim-switch-home synced cleanly',
      JSON.stringify(simLaunchDiag)
    );

    check(
      returnedHomeCheck?.pathname === '/' &&
        returnedHomeCheck?.search?.includes('backend=webgpu') &&
        returnedHomeCheck?.gpuChecked === 'true' &&
        returnedHomeCheck?.heroLaunchHref?.includes('?backend=webgpu'),
      'Clicking #sim-switch-home returns to / preserving ?backend=webgpu and active WebGPU toggle',
      JSON.stringify(returnedHomeCheck)
    );

    check(
      redirectPulsarCheck?.pathname?.includes('/sims/pulsar/') &&
        redirectPulsarCheck?.search?.includes('backend=webgpu') &&
        redirectPulsarCheck?.backend === 'webgpu' &&
        redirectPulsarCheck?.allShadersCompiled === true,
      'Backwards-compatible /?sim=pulsar&backend=webgpu redirects immediately to /sims/pulsar/?backend=webgpu',
      JSON.stringify(redirectPulsarCheck)
    );

    check(
      hubCheck?.pathname === '/' && hubCheck?.cardCount === 9 && hubCheck?.canvasCount === 0,
      'Backwards-compatible /?hub renders the Observatory Homepage cleanly',
      JSON.stringify(hubCheck)
    );

    check(
      mobileHeroOverflow.scrollWidth <= mobileHeroOverflow.innerWidth &&
        mobileCatalogOverflow.scrollWidth <= mobileCatalogOverflow.innerWidth,
      'Zero horizontal overflow at mobile 390x844 (top + filmstrip)',
      `top=${mobileHeroOverflow.scrollWidth}/${mobileHeroOverflow.innerWidth}, dock=${mobileCatalogOverflow.scrollWidth}/${mobileCatalogOverflow.innerWidth}`
    );

    console.log(`\nHOMEPAGE QA REPORT WRITTEN: ${path.join(SHOT_DIR, 'homepage_qa_report.json')}`);
    process.exitCode = qaFail > 0 ? 1 : 0;
  } finally {
    await cdp.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('FATAL HOMEPAGE QA ERROR:', err);
  process.exit(1);
});
