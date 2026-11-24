/**
 * Canonical registry of all Interstellar Spacetime Simulators.
 * Single source of truth for root routing, fallback cards, top-right nav switcher,
 * launch/test tooling, and shared verification scripts.
 */

export const SIMULATORS = Object.freeze([
  Object.freeze({
    id: 'blackhole',
    dir: 'blackhole-sim',
    shortLabel: 'Black Hole',
    title: 'Gargantua — Kerr Black Hole',
    ariaLabel: 'Switch to Gargantua Black Hole Simulator',
    debugHandle: '__GARGANTUA__',
    accentVar: '--accent',
    cardClass: '',
    aliases: Object.freeze(['blackhole', 'blackhole-sim', 'gargantua', 'bh']),
    description:
      '3D Outgoing Kerr–Schild ray-traced accretion disk, relativistic Doppler beaming, and 128-sample cinema still mode.',
  }),
  Object.freeze({
    id: 'wormhole',
    dir: 'wormhole-sim',
    shortLabel: 'Wormhole',
    title: 'Morris–Thorne Traversable Wormhole',
    ariaLabel: 'Switch to Traversable Wormhole Simulator',
    debugHandle: '__WORMHOLE__',
    accentVar: '--accent-teal',
    cardClass: 'wormhole',
    aliases: Object.freeze(['wormhole', 'wormhole-sim', 'wh']),
    description:
      'James–Thorne & Ellis spacetime throat linking Universe A (4K Milky Way) and Universe B (Exotic Golden–Teal Nebula).',
  }),
  Object.freeze({
    id: 'binary',
    dir: 'binary-bh-sim',
    shortLabel: 'Binary BH',
    title: 'Binary Black Hole Inspiral & GW Lensing',
    ariaLabel: 'Switch to Binary Black Hole Simulator',
    debugHandle: '__BINARY_BH__',
    accentVar: '--accent-violet',
    cardClass: 'binary',
    aliases: Object.freeze(['binary', 'binary-bh', 'binary-bh-sim', 'bbh']),
    description:
      'Two-body Brill–Lindquist + 2.5PN inspiral, retarded gravitational wave shear, fractal eyebrow shadows, and tidal gas bridges.',
  }),
  Object.freeze({
    id: 'warp',
    dir: 'warp-drive-sim',
    shortLabel: 'Warp Drive',
    title: 'Alcubierre Warp Drive — FTL Spacetime',
    ariaLabel: 'Switch to Alcubierre Warp Drive Simulator',
    debugHandle: '__WARP_DRIVE__',
    accentVar: '--accent-cyan',
    cardClass: 'warp',
    aliases: Object.freeze(['warp', 'warp-drive', 'warp-drive-sim', 'alcubierre']),
    description:
      'Alcubierre, Natário zero-expansion, and Lentz soliton warp metrics with ADM null geodesic ray-tracing, relativistic Doppler bow caustics, and Inside Bridge causal horizon.',
  }),
  Object.freeze({
    id: 'supernova',
    dir: 'supernova-sim',
    shortLabel: 'Supernova',
    title: 'Supernova Remnant — Volumetric Nebula',
    ariaLabel: 'Switch to Supernova Remnant Simulator',
    debugHandle: '__SUPERNOVA__',
    accentVar: '--accent-nebula',
    cardClass: 'supernova',
    aliases: Object.freeze(['supernova', 'supernova-sim', 'snr', 'nebula']),
    description:
      'Multi-scattering radiative transfer across Sedov–Taylor shock shells, Rayleigh–Taylor filaments, Bok globules, Hubble SHO / True Color palettes, and deep interior fly-through.',
  }),
  Object.freeze({
    id: 'pulsar',
    dir: 'pulsar-sim',
    shortLabel: 'Pulsar',
    title: 'Magnetar & Millisecond Pulsar',
    ariaLabel: 'Switch to Magnetar & Pulsar Simulator',
    debugHandle: '__PULSAR__',
    accentVar: '--accent-pulsar',
    cardClass: 'pulsar',
    aliases: Object.freeze(['pulsar', 'pulsar-sim', 'magnetar', 'ns']),
    description:
      'Outgoing Kerr–Schild light bending exposing >50% of the neutron star crust, twisted pair-plasma dipole loops, sweeping lighthouse beams, and PWN torus & jets.',
  }),
  Object.freeze({
    id: 'starflight',
    dir: 'starflight-sim',
    shortLabel: 'Starflight',
    title: 'Relativistic Starflight — Aberration & Doppler Sky',
    ariaLabel: 'Switch to Relativistic Starflight Simulator',
    debugHandle: '__STARFLIGHT__',
    accentVar: '--accent-starflight',
    cardClass: 'starflight',
    aliases: Object.freeze(['starflight', 'starflight-sim', 'sf', 'relativistic']),
    description:
      'Exact Special Relativistic Lorentz null-ray aberration up to 0.9999996c, Planck blackbody UV/IR & CMB blue-shift, Penrose–Terrell rotation on 3D foreground beacons, and 1g brachistochrone cruise.',
  }),
]);

/**
 * Finds a simulator entry by its canonical `id`.
 * @param {string} id
 */
export function getSimById(id) {
  const key = String(id || '').trim().toLowerCase();
  return SIMULATORS.find((sim) => sim.id === key) || null;
}

/**
 * Resolves any CLI/URL alias (or directory name) to its simulator entry.
 * Returns `SIMULATORS[0]` (blackhole) when empty/unmatched unless `strict` is true.
 * @param {string} raw
 * @param {{ strict?: boolean }} [options]
 */
export function resolveSimByAlias(raw, { strict = false } = {}) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) {
    return strict ? null : SIMULATORS[0];
  }
  const found = SIMULATORS.find(
    (sim) => sim.id === key || sim.dir === key || sim.aliases.includes(key)
  );
  if (found) return found;
  return strict ? null : SIMULATORS[0];
}
