/**
 * pwaRegister.js — Lightweight Service Worker registration & cache status helper.
 *
 * Skips silently on file:// or unsupported browsers, resolves relative paths from
 * import.meta.url so subdirectory simulators (/sims/<id>/) and GitHub Pages subpaths
 * both register the root Service Worker cleanly after page load.
 */

let registrationPromise = null;

function isSupportedOrigin() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  const { protocol, hostname } = window.location;
  if (protocol === 'https:') return true;
  if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')) {
    return true;
  }
  return false;
}

export function registerObservatorySw({ swPath, scope } = {}) {
  if (!isSupportedOrigin()) {
    return Promise.resolve(null);
  }
  if (registrationPromise) {
    return registrationPromise;
  }

  const resolvedSwPath = swPath || new URL('../../sw.js', import.meta.url).href;
  const resolvedScope = scope || new URL('../../', import.meta.url).href;

  const doRegister = async () => {
    try {
      return await navigator.serviceWorker.register(resolvedSwPath, { scope: resolvedScope });
    } catch {
      return null;
    }
  };

  registrationPromise = new Promise((resolve) => {
    if (document.readyState === 'complete') {
      doRegister().then(resolve);
    } else {
      window.addEventListener(
        'load',
        () => {
          doRegister().then(resolve);
        },
        { once: true }
      );
    }
  });

  return registrationPromise;
}

async function postSwMessage(payload, timeoutMs = 1500) {
  if (!isSupportedOrigin()) return null;
  let worker = navigator.serviceWorker.controller;
  if (!worker) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      worker = reg?.active || reg?.waiting || reg?.installing || null;
    } catch {
      return null;
    }
  }
  if (!worker) return null;

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data ?? null);
    };
    try {
      worker.postMessage(payload, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export function getSwCacheStatus(timeoutMs = 1500) {
  return postSwMessage({ type: 'GET_CACHE_STATUS' }, timeoutMs);
}

export function clearSwCaches(timeoutMs = 1500) {
  return postSwMessage({ type: 'CLEAR_CACHE' }, timeoutMs);
}
