/**
 * Optical post-processing grading profiles for the shared HDR pipeline.
 * All simulators share the exact same TAA, Karis/Jimenez bloom, Panavision
 * anamorphic streak, and Troy Sobotka AgX tone-mapping passes, differing only
 * in per-simulator lens coating tint and bloom/anamorphic gains.
 */

export const POST_OPTICS_PROFILES = Object.freeze({
  default: Object.freeze({
    coreTint: Object.freeze([1.04, 0.96, 0.87]),
    outerTint: Object.freeze([0.76, 0.90, 1.16]),
    fringeStart: 0.18,
    fringeMix: 0.42,
    bloomGain: 0.085,
    anamorphicGain: 0.22,
  }),
  pulsar: Object.freeze({
    coreTint: Object.freeze([0.96, 0.99, 1.05]),
    outerTint: Object.freeze([0.60, 0.86, 1.24]),
    fringeStart: 0.16,
    fringeMix: 0.48,
    bloomGain: 0.095,
    anamorphicGain: 0.28,
  }),
  starflight: Object.freeze({
    coreTint: Object.freeze([1.02, 0.99, 0.96]),
    outerTint: Object.freeze([0.84, 0.92, 1.08]),
    fringeStart: 0.18,
    fringeMix: 0.35,
    bloomGain: 0.105,
    anamorphicGain: 0.14,
  }),
});

/**
 * Resolves a named optical profile or merges a custom profile override onto `default`.
 * @param {string | Partial<typeof POST_OPTICS_PROFILES.default>} [profileOrName='default']
 */
export function resolvePostOpticsProfile(profileOrName = 'default') {
  if (typeof profileOrName === 'string') {
    const profile = POST_OPTICS_PROFILES[profileOrName];
    if (!profile) {
      throw new Error(`Unknown post optics profile: "${profileOrName}"`);
    }
    return profile;
  }
  if (profileOrName && typeof profileOrName === 'object') {
    return Object.freeze({ ...POST_OPTICS_PROFILES.default, ...profileOrName });
  }
  return POST_OPTICS_PROFILES.default;
}

/**
 * Formats a finite number as a valid GLSL/WGSL floating-point literal.
 * @param {number} n
 * @returns {string}
 */
export function formatShaderFloat(n) {
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite shader optical constant: ${n}`);
  }
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}
