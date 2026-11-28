/**
 * Interstellar Observatory Service Worker
 *
 * Compatible with GitHub Pages subpaths and `.nojekyll`.
 * - Install precaches ONLY the lightweight launcher shell (<150 KB).
 *   `shared/assets/milkyway_4k.jpg` (3.7 MB) and `home/previews/*.webp` are
 *   NEVER precached on install; they are populated lazily on first fetch via
 *   Cache-First so the Observatory Homepage stays zero-overhead.
 * - HTML / ES modules / CSS / WGSL shaders / JSON use Network-First with cache
 *   fallback for offline launches.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `interstellar-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `interstellar-assets-${CACHE_VERSION}`;

const SHELL_PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './home/styles.css',
  './home/app.js',
  './home/catalogData.js',
  './shared/simRegistry.js',
  './shared/ui/base.css',
  './shared/assets/app-icon.svg',
];

function scopeUrl(relPath) {
  const base = self.registration?.scope || self.location.href;
  return new URL(relPath, base).href;
}

function isHeavyAssetUrl(url) {
  const p = url.pathname;
  return (
    p.endsWith('/shared/assets/milkyway_4k.jpg') ||
    (p.includes('/home/previews/') && p.endsWith('.webp')) ||
    p.endsWith('/shared/assets/physicalLutsData.js') ||
    p.endsWith('/shared/assets/app-icon-256.png')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        SHELL_PRECACHE.map(async (rel) => {
          const target = scopeUrl(rel);
          try {
            const resp = await fetch(target, { cache: 'no-cache' });
            if (resp && resp.ok && resp.status === 200) {
              await cache.put(target, resp.clone());
            }
          } catch {
            // Ignore transient offline errors during install
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('interstellar-') && name !== SHELL_CACHE && name !== ASSET_CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.status === 200) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.status === 200) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match(scopeUrl('./index.html'));
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isHeavyAssetUrl(url)) {
    event.respondWith(cacheFirstAsset(request));
  } else {
    event.respondWith(networkFirstShell(request));
  }
});

async function collectCacheStatus() {
  const [shellCache, assetCache] = await Promise.all([
    caches.open(SHELL_CACHE),
    caches.open(ASSET_CACHE),
  ]);
  const [shellKeys, assetKeys] = await Promise.all([
    shellCache.keys(),
    assetCache.keys(),
  ]);
  const hasSkyCached = assetKeys.some((req) => req.url.endsWith('/shared/assets/milkyway_4k.jpg'));
  return {
    cacheVersion: CACHE_VERSION,
    shellCache: SHELL_CACHE,
    assetCache: ASSET_CACHE,
    shellCount: shellKeys.length,
    assetCount: assetKeys.length,
    hasSkyCached,
    precacheIncludesHeavyAssets: SHELL_PRECACHE.some(
      (p) => p.includes('milkyway_4k') || p.endsWith('.webp')
    ),
  };
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const replyPort = event.ports && event.ports[0];
  const respond = (payload) => {
    if (replyPort) {
      replyPort.postMessage(payload);
    } else if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(payload);
    }
  };

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'GET_CACHE_STATUS') {
    event.waitUntil(collectCacheStatus().then(respond));
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      Promise.all([caches.delete(SHELL_CACHE), caches.delete(ASSET_CACHE)]).then(() => {
        respond({ cleared: true });
      })
    );
  }
});
