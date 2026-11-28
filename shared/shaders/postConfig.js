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
    prefilterThreshold: 1.30,
    prefilterKnee: 0.45,
    prefilterClampMax: 11.0,
    upsampleRadius: 1.05,
    upsampleWeight: 0.66,
    anaThreshold: 1.85,
    anaSpread0: 1.05,
    anaSpread1: 1.15,
    defaultBloomIntensity: 0.58,
    defaultAnamorphicIntensity: 0.45,
  }),
  pulsar: Object.freeze({
    coreTint: Object.freeze([0.96, 0.99, 1.05]),
    outerTint: Object.freeze([0.60, 0.86, 1.24]),
    fringeStart: 0.16,
    fringeMix: 0.48,
    bloomGain: 0.095,
    anamorphicGain: 0.28,
    prefilterThreshold: 1.25,
    prefilterKnee: 0.45,
    prefilterClampMax: 16.0,
    upsampleRadius: 0.88,
    upsampleWeight: 0.52,
    anaThreshold: 1.85,
    anaSpread0: 1.05,
    anaSpread1: 1.15,
    defaultBloomIntensity: 0.62,
    defaultAnamorphicIntensity: 0.42,
  }),
  starflight: Object.freeze({
    coreTint: Object.freeze([1.02, 0.99, 0.96]),
    outerTint: Object.freeze([0.84, 0.92, 1.08]),
    fringeStart: 0.18,
    fringeMix: 0.35,
    bloomGain: 0.105,
    anamorphicGain: 0.14,
    prefilterThreshold: 1.15,
    prefilterKnee: 0.45,
    prefilterClampMax: 16.0,
    upsampleRadius: 1.05,
    upsampleWeight: 0.66,
    anaThreshold: 2.45,
    anaSpread0: 1.05,
    anaSpread1: 1.15,
    defaultBloomIntensity: 0.58,
    defaultAnamorphicIntensity: 0.45,
  }),
  lensCluster: Object.freeze({
    coreTint: Object.freeze([1.05, 0.96, 0.90]),
    outerTint: Object.freeze([0.78, 0.88, 1.18]),
    fringeStart: 0.17,
    fringeMix: 0.40,
    bloomGain: 0.095,
    anamorphicGain: 0.18,
    prefilterThreshold: 1.20,
    prefilterKnee: 0.45,
    prefilterClampMax: 15.0,
    upsampleRadius: 1.00,
    upsampleWeight: 0.62,
    anaThreshold: 2.10,
    anaSpread0: 1.05,
    anaSpread1: 1.15,
    defaultBloomIntensity: 0.56,
    defaultAnamorphicIntensity: 0.36,
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
