/**
 * urlState.js — Shareable URL state serialization & deep-linking across
 * all Interstellar Simulation engines (`?preset=`, `?backend=`, `?tour=`, `#s=<base64url>`).
 * Pure ES module, zero dependencies, safe in both browser and Node.js.
 */

const EXCLUDED_STATE_KEYS = new Set([
  'backend',
  'paused',
  'presetId',
  'resolutionScale',
  'dprCap',
  'qualityProfile',
  'interactiveDragScale',
  'reducedGlass',
  'evolving',
  'samples',
  'simTime',
]);

const EXCLUDED_CAMERA_KEYS = new Set([
  'moved',
  'isTransitioning',
  'dragging',
  'traversing',
  'isTraversing',
]);

const SKY_ROTATION_KEYS = new Set(['skyRotation', 'skyRotationA', 'skyRotationB']);

function roundFloat(n, decimals = 4) {
  const factor = 10 ** decimals;
  const r = Math.round(n * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Encodes a UTF-8 string into URL-safe base64 without padding.
 * @param {string} str
 */
export function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(String(str));
  let b64;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64');
  } else {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decodes a URL-safe base64 string into UTF-8 text. Returns null on malformed input.
 * @param {string} b64url
 */
export function decodeBase64Url(b64url) {
  if (typeof b64url !== 'string' || !b64url) return null;
  try {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad === 2) b64 += '==';
    else if (pad === 3) b64 += '=';
    else if (pad === 1) return null;

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('utf8');
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Extracts finite pose fields from `camera.getState()`, stripping transient flags and velocity fields.
 * @param {Record<string, unknown> | null | undefined} camState
 */
export function sanitizeCameraPose(camState) {
  if (!camState || typeof camState !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(camState)) {
    if (EXCLUDED_CAMERA_KEYS.has(key) || key.endsWith('Vel') || key.startsWith('_')) {
      continue;
    }
    if (typeof val === 'number') {
      if (Number.isFinite(val)) out[key] = roundFloat(val, 4);
    } else if (typeof val === 'boolean') {
      out[key] = val;
    } else if (Array.isArray(val) && val.length >= 2 && val.length <= 4) {
      if (val.every((item) => typeof item === 'number' && Number.isFinite(item))) {
        out[key] = val.map((item) => roundFloat(item, 4));
      }
    }
  }
  return out;
}

function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((v, i) => typeof v === 'number' && typeof b[i] === 'number' && Math.abs(v - b[i]) < 1e-4)
    );
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-4;
  }
  return a === b;
}

/**
 * Computes only the simulation parameters that differ from `baseParams`.
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} [baseParams]
 */
export function computeParamDelta(state, baseParams = {}) {
  if (!state || typeof state !== 'object') return {};
  const delta = {};
  for (const [key, val] of Object.entries(state)) {
    if (EXCLUDED_STATE_KEYS.has(key) || key.startsWith('_')) continue;

    let cleanVal;
    if (SKY_ROTATION_KEYS.has(key) && Array.isArray(val) && val.length === 2) {
      const x = Number(val[0]);
      const y = Number(val[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      cleanVal = [roundFloat(x, 4), roundFloat(y, 4)];
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val)) continue;
      cleanVal = roundFloat(val, 4);
    } else if (typeof val === 'boolean' || typeof val === 'string') {
      cleanVal = val;
    } else {
      continue;
    }

    if (baseParams && key in baseParams) {
      if (valuesEqual(cleanVal, baseParams[key])) continue;
    }
    delta[key] = cleanVal;
  }
  return delta;
}

/**
 * Serializes simulator state into query parameters and optional `#s=` hash payload.
 */
export function serializeUrlState({
  backend = null,
  presetId = null,
  cameraState = null,
  state = null,
  baseParams = null,
  tourOpen = false,
} = {}) {
  const searchParams = new URLSearchParams();
  if (backend === 'webgpu' || backend === 'webgl2') {
    if (backend === 'webgpu') {
      searchParams.set('backend', 'webgpu');
    }
  }
  if (typeof presetId === 'string' && presetId.trim()) {
    searchParams.set('preset', presetId.trim());
  }
  if (tourOpen) {
    searchParams.set('tour', '1');
  }

  const cleanCam = sanitizeCameraPose(cameraState);
  const cleanParams = computeParamDelta(state, baseParams || {});
  const payload = {};
  if (Object.keys(cleanCam).length > 0) payload.c = cleanCam;
  if (Object.keys(cleanParams).length > 0) payload.m = cleanParams;

  const hash =
    Object.keys(payload).length > 0 ? `#s=${encodeBase64Url(JSON.stringify(payload))}` : '';

  return { searchParams, hash, payload };
}

/**
 * Builds a complete shareable URL preserving the current simulator origin and pathname.
 * @param {string} locationHref
 * @param {object} opts
 */
export function buildShareableUrl(locationHref, opts = {}) {
  const url = new URL(locationHref);
  const { searchParams, hash } = serializeUrlState(opts);
  const nextQuery = searchParams.toString();
  url.search = nextQuery ? `?${nextQuery}` : '';
  url.hash = hash;
  return url.toString();
}

function sanitizeParsedRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean' || typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v) && v.length >= 2 && v.length <= 4) {
      if (v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        out[k] = v;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parses URL search parameters and `#s=` hash safely. Never throws on malformed input.
 * @param {string} [search]
 * @param {string} [hash]
 */
export function parseUrlState(search = '', hash = '') {
  const out = {
    hasState: false,
    backend: null,
    presetId: null,
    tour: null,
    camera: null,
    params: null,
  };

  try {
    const query = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const rawBackend = (query.get('backend') || '').trim().toLowerCase();
    if (rawBackend === 'webgpu' || rawBackend === 'webgl2') {
      out.backend = rawBackend;
    } else if (rawBackend === 'webgl') {
      out.backend = 'webgl2';
    }

    const rawPreset = (query.get('preset') || '').trim();
    if (rawPreset) {
      out.presetId = rawPreset;
      out.hasState = true;
    }

    const rawTour = (query.get('tour') || '').trim().toLowerCase();
    if (rawTour === '1' || rawTour === 'true') {
      out.tour = true;
      out.hasState = true;
    } else if (rawTour === '0' || rawTour === 'false') {
      out.tour = false;
    }

    let encoded = null;
    const rawHash = String(hash || '').replace(/^#/, '');
    if (rawHash) {
      const hashParams = new URLSearchParams(rawHash);
      encoded = hashParams.get('s') || (rawHash.startsWith('s=') ? rawHash.slice(2) : null);
    }
    if (!encoded) {
      encoded = query.get('state');
    }

    if (encoded) {
      const jsonText = decodeBase64Url(encoded.trim());
      if (jsonText) {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const cam = sanitizeParsedRecord(parsed.c);
          const params = sanitizeParsedRecord(parsed.m);
          if (cam) {
            out.camera = cam;
            out.hasState = true;
          }
          if (params) {
            out.params = params;
            out.hasState = true;
          }
        }
      }
    }
  } catch {
    // Ignore malformed query/hash state
  }

  return out;
}
