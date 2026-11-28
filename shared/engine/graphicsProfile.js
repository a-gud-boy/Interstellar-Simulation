/**
 * graphicsProfile.js — Persistent graphics & quality profile preferences
 * (`Eco`, `Balanced`, `Ultra`, DPR cap, resolution scale, drag scaling, reduced glass).
 * Pure ES module, zero dependencies.
 */

export const GRAPHICS_STORAGE_KEY = 'interstellar_graphics_prefs_v1';
export const PERF_DRAG_SCALE_KEY = 'interstellar_perf_drag_scale';
export const PERF_REDUCED_GLASS_KEY = 'interstellar_perf_reduced_glass';

export const DPR_CAP_OPTIONS = Object.freeze([1.0, 1.5, 2.0]);

export const GRAPHICS_PROFILES = Object.freeze({
  eco: Object.freeze({
    id: 'eco',
    label: 'Eco',
    quality: 0,
    resolutionScale: 0.75,
    dprCap: 1.0,
    interactiveDragScale: true,
    reducedGlass: true,
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: 'Balanced',
    quality: 1,
    resolutionScale: 1.0,
    dprCap: 1.5,
    interactiveDragScale: false,
    reducedGlass: false,
  }),
  ultra: Object.freeze({
    id: 'ultra',
    label: 'Ultra',
    quality: 2,
    resolutionScale: 1.0,
    dprCap: 2.0,
    interactiveDragScale: false,
    reducedGlass: false,
  }),
});

export function clampDprCap(value, fallback = 1.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0.5, Math.min(3.0, Math.round(num * 100) / 100));
}

export function normalizeProfileId(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'eco' || v === 'balanced' || v === 'ultra' || v === 'custom') return v;
  return null;
}

export function inferQualityProfile({ quality, resolutionScale, dprCap }) {
  const q = Number(quality);
  const res = Number(resolutionScale);
  const dpr = Number(dprCap);
  for (const profile of Object.values(GRAPHICS_PROFILES)) {
    if (
      q === profile.quality &&
      Math.abs(res - profile.resolutionScale) < 0.02 &&
      Math.abs(dpr - profile.dprCap) < 0.05
    ) {
      return profile.id;
    }
  }
  return 'custom';
}

function readLegacyBool(storage, key, fallback = false) {
  try {
    const raw = storage?.getItem(key);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // Ignore restricted storage
  }
  return fallback;
}

/**
 * Loads saved graphics preferences from `localStorage` without altering default
 * simulator behavior when no preferences have been stored yet.
 * @param {Storage | null} [storage]
 */
export function loadGraphicsPrefs(
  storage = typeof window !== 'undefined' ? window.localStorage : null
) {
  const fallback = {
    hasStoredPrefs: false,
    profileId: null,
    quality: null,
    resolutionScale: null,
    dprCap: 1.5,
    interactiveDragScale: readLegacyBool(storage, PERF_DRAG_SCALE_KEY, false),
    reducedGlass: readLegacyBool(storage, PERF_REDUCED_GLASS_KEY, false),
  };

  if (!storage) return fallback;
  try {
    const raw = storage.getItem(GRAPHICS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;

    const quality =
      typeof parsed.quality === 'number' && Number.isFinite(parsed.quality)
        ? Math.max(0, Math.min(2, parsed.quality | 0))
        : null;
    const resolutionScale =
      typeof parsed.resolutionScale === 'number' && Number.isFinite(parsed.resolutionScale)
        ? Math.max(0.25, Math.min(1.0, parsed.resolutionScale))
        : null;
    const dprCap = clampDprCap(parsed.dprCap, 1.5);
    const interactiveDragScale =
      typeof parsed.interactiveDragScale === 'boolean'
        ? parsed.interactiveDragScale
        : fallback.interactiveDragScale;
    const reducedGlass =
      typeof parsed.reducedGlass === 'boolean'
        ? parsed.reducedGlass
        : fallback.reducedGlass;
    const profileId =
      normalizeProfileId(parsed.profileId) ||
      (quality !== null && resolutionScale !== null
        ? inferQualityProfile({ quality, resolutionScale, dprCap })
        : 'custom');

    return {
      hasStoredPrefs: true,
      profileId,
      quality,
      resolutionScale,
      dprCap,
      interactiveDragScale,
      reducedGlass,
    };
  } catch {
    return fallback;
  }
}

/**
 * Persists graphics preferences into `localStorage` and mirrors legacy flags.
 * @param {object} prefs
 * @param {Storage | null} [storage]
 */
export function saveGraphicsPrefs(
  prefs,
  storage = typeof window !== 'undefined' ? window.localStorage : null
) {
  if (!storage || !prefs || typeof prefs !== 'object') return false;
  const dprCap = clampDprCap(prefs.dprCap, 1.5);
  const quality =
    typeof prefs.quality === 'number' && Number.isFinite(prefs.quality)
      ? Math.max(0, Math.min(2, prefs.quality | 0))
      : null;
  const resolutionScale =
    typeof prefs.resolutionScale === 'number' && Number.isFinite(prefs.resolutionScale)
      ? Math.max(0.25, Math.min(1.0, prefs.resolutionScale))
      : null;
  const interactiveDragScale = Boolean(prefs.interactiveDragScale);
  const reducedGlass = Boolean(prefs.reducedGlass);
  const profileId =
    normalizeProfileId(prefs.profileId) ||
    (quality !== null && resolutionScale !== null
      ? inferQualityProfile({ quality, resolutionScale, dprCap })
      : 'custom');

  try {
    storage.setItem(
      GRAPHICS_STORAGE_KEY,
      JSON.stringify({
        profileId,
        quality,
        resolutionScale,
        dprCap,
        interactiveDragScale,
        reducedGlass,
      })
    );
    storage.setItem(PERF_DRAG_SCALE_KEY, interactiveDragScale ? '1' : '0');
    storage.setItem(PERF_REDUCED_GLASS_KEY, reducedGlass ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
