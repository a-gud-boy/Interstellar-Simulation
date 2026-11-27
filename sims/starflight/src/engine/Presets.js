/**
 * Presets.js — Relativistic starflight cruise regimes, aberration/Doppler showcase
 * presets, and default simulator state for the Relativistic Starflight Simulator.
 */

export const DEFAULT_STATE = Object.freeze({
  presetId: 'headlight_90',
  backend: 'webgl2',
  paused: false,
  autoOrbit: false,

  // Relativistic kinematics & flight mode
  flightMode: 0, // 0 = Manual v/c (rapidity), 1 = 1g Brachistochrone Cruise
  rapidity: 1.472219, // beta = 0.9000c
  properAccelG: 1.0,
  properTimeYr: 0.0,
  flightPosZ: 0.0,
  flightDir: 1, // +1 = Forward (+Z), -1 = Reverse (-Z)
  aberrationMode: 1, // 1 = Exact SR, 0 = Rest Frame

  // Multi-spectral sky, CMB & foreground corridor
  dopplerStrength: 1.0,
  cmbVisibility: 0.75,
  starDensity: 1.25,
  uvIrGain: 1.20,
  geometryVisibility: 1.25,
  dustDensity: 1.15,
  dustStreakScale: 1.0,
  beamingGain: 1.0,
  cmbTempScale: 1.0,

  // Sky, render quality & post-processing optics
  skyIntensity: 0.95,
  skyMode: 0, // 0 = 4K Milky Way, 1 = Procedural Deep Space
  skyRotation: Object.freeze([0.22, 0.16]),
  quality: 1, // 0 = Performance, 1 = Balanced, 2 = Cinema
  resolutionScale: 1.0,

  exposure: 1.08,
  bloomIntensity: 0.62,
  anamorphicIntensity: 0.36,
});

export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'sub_rel',
    name: '0.50c Sub-Relativistic',
    shortName: '0.50c Cruise',
    hotkey: '1',
    params: Object.freeze({
      rapidity: 0.549306,
      flightMode: 0,
      properAccelG: 1.0,
      properTimeYr: 0.0,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 1.3,
      dustDensity: 0.9,
      cmbVisibility: 0.55,
      starDensity: 1.15,
      uvIrGain: 1.0,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.32, 0.14]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 18,
      lookPitchDeg: 2,
      rollDeg: 0,
      fovDeg: 54,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'headlight_90',
    name: '0.90c Headlight Cone',
    shortName: '0.90c Cone',
    hotkey: '2',
    params: Object.freeze({
      rapidity: 1.472219,
      flightMode: 0,
      properAccelG: 1.0,
      properTimeYr: 0.0,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 1.25,
      dustDensity: 1.15,
      cmbVisibility: 0.75,
      starDensity: 1.25,
      uvIrGain: 1.20,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.22, 0.16]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 0,
      lookPitchDeg: 1.5,
      rollDeg: 0,
      fovDeg: 64,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'uv_milkyway',
    name: '0.995c UV Milky Way',
    shortName: '0.995c UV Sky',
    hotkey: '3',
    params: Object.freeze({
      rapidity: 2.993223,
      flightMode: 0,
      properAccelG: 1.0,
      properTimeYr: 0.0,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 0.9,
      dustDensity: 1.25,
      cmbVisibility: 1.05,
      starDensity: 1.45,
      uvIrGain: 1.60,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.18, 0.14]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 0,
      lookPitchDeg: 0,
      rollDeg: 0,
      fovDeg: 58,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'cmb_glow',
    name: '0.9999c CMB Glow',
    shortName: '0.9999c CMB',
    hotkey: '4',
    params: Object.freeze({
      rapidity: 4.951744,
      flightMode: 0,
      properAccelG: 1.0,
      properTimeYr: 0.0,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 0.35,
      dustDensity: 0.70,
      cmbVisibility: 1.85,
      starDensity: 1.35,
      uvIrGain: 1.65,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.18, 0.14]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 0,
      lookPitchDeg: 0,
      rollDeg: 0,
      fovDeg: 34,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'aft_redshift',
    name: 'Aft Redshift View',
    shortName: 'Aft Window',
    hotkey: '5',
    params: Object.freeze({
      rapidity: 1.589027,
      flightMode: 0,
      properAccelG: 1.0,
      properTimeYr: 0.0,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 1.25,
      dustDensity: 1.0,
      cmbVisibility: 0.45,
      starDensity: 1.30,
      uvIrGain: 1.80,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.22, 0.16]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 180,
      lookPitchDeg: 2,
      rollDeg: 0,
      fovDeg: 56,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'brachistochrone',
    name: '1g Brachistochrone Cruise',
    shortName: '1g Cruise',
    hotkey: '6',
    params: Object.freeze({
      flightMode: 1,
      properAccelG: 1.0,
      properTimeYr: 1.35,
      rapidity: 1.3935,
      flightDir: 1,
      aberrationMode: 1,
      geometryVisibility: 1.25,
      dustDensity: 1.20,
      cmbVisibility: 1.0,
      starDensity: 1.30,
      uvIrGain: 1.25,
      dopplerStrength: 1.0,
      dustStreakScale: 1.0,
      beamingGain: 1.0,
      cmbTempScale: 1.0,
      skyIntensity: 0.95,
      skyMode: 0,
      skyRotation: Object.freeze([0.22, 0.16]),
      exposure: 1.08,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.36,
    }),
    camera: Object.freeze({
      lookYawDeg: 12,
      lookPitchDeg: 2,
      rollDeg: 0,
      fovDeg: 58,
      autoOrbit: false,
    }),
  }),
]);

export function getPresetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function createInitialState() {
  return {
    ...DEFAULT_STATE,
    skyRotation: [...DEFAULT_STATE.skyRotation],
  };
}
