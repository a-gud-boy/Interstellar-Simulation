/**
 * Iconic astrophysical and cinematic presets + default simulator state
 * for Gargantua — Relativistic Black Hole Simulator.
 */

export const DEFAULT_STATE = Object.freeze({
  presetId: 'gargantua',

  // Spacetime physics
  spin: 0.998,
  relativisticMode: 0.18,
  lensingStrength: 1.0,

  // Accretion disk & corona
  diskTemp: 6800,
  diskDensity: 1.15,
  diskThickness: 0.85,
  diskOuterRadius: 19.5,
  turbulence: 1.1,
  orbitSpeed: 0.9,
  jetIntensity: 0.0,

  // Optics, sky & render quality
  exposure: 1.05,
  bloomIntensity: 0.52,
  anamorphicIntensity: 0.24,
  skyIntensity: 0.85,
  skyMode: 0,
  skyRotation: Object.freeze([0.45, 0.24]),
  quality: 1,
  resolutionScale: 1.0,

  // Transport controls
  paused: false,
  autoOrbit: true,
});

export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'gargantua',
    name: 'Gargantua (Interstellar)',
    shortName: 'Gargantua',
    hotkey: '1',
    params: Object.freeze({
      spin: 0.998,
      relativisticMode: 0.18,
      lensingStrength: 1.0,
      diskTemp: 6800,
      diskDensity: 1.15,
      diskThickness: 0.85,
      diskOuterRadius: 19.5,
      turbulence: 1.1,
      orbitSpeed: 0.9,
      jetIntensity: 0.0,
      exposure: 1.05,
      bloomIntensity: 0.52,
      anamorphicIntensity: 0.24,
      skyIntensity: 0.85,
      skyMode: 0,
      skyRotation: Object.freeze([0.45, 0.24]),
    }),
    camera: Object.freeze({
      radius: 30.5,
      elevationDeg: 5.2,
      azimuthDeg: 0.0,
      rollDeg: -5.5,
      fovDeg: 44.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'relativistic',
    name: 'Relativistic Exact (a=0.998)',
    shortName: 'Relativistic',
    hotkey: '2',
    params: Object.freeze({
      spin: 0.998,
      relativisticMode: 1.0,
      lensingStrength: 1.0,
      diskTemp: 9200,
      diskDensity: 1.05,
      diskThickness: 0.95,
      diskOuterRadius: 23.0,
      turbulence: 1.1,
      orbitSpeed: 0.9,
      jetIntensity: 0.0,
      exposure: 0.90,
      bloomIntensity: 0.50,
      anamorphicIntensity: 0.18,
      skyIntensity: 0.85,
      skyMode: 0,
      skyRotation: Object.freeze([0.45, 0.24]),
    }),
    camera: Object.freeze({
      radius: 23.0,
      elevationDeg: 9.0,
      azimuthDeg: 0.0,
      rollDeg: 0.0,
      fovDeg: 46.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'schwarzschild',
    name: 'Schwarzschild (a=0)',
    shortName: 'Schwarzschild',
    hotkey: '3',
    params: Object.freeze({
      spin: 0.0,
      relativisticMode: 0.65,
      lensingStrength: 1.0,
      diskTemp: 6000,
      diskDensity: 0.95,
      diskThickness: 0.95,
      diskOuterRadius: 25.0,
      turbulence: 1.0,
      orbitSpeed: 0.85,
      jetIntensity: 0.0,
      exposure: 0.80,
      bloomIntensity: 0.45,
      anamorphicIntensity: 0.16,
      skyIntensity: 0.90,
      skyMode: 0,
      skyRotation: Object.freeze([1.05, 0.20]),
    }),
    camera: Object.freeze({
      radius: 28.0,
      elevationDeg: 12.0,
      azimuthDeg: 0.0,
      rollDeg: 0.0,
      fovDeg: 46.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'millers',
    name: "Miller's Horizon (Close)",
    shortName: "Miller's",
    hotkey: '4',
    params: Object.freeze({
      spin: 0.998,
      relativisticMode: 0.25,
      lensingStrength: 1.0,
      diskTemp: 6500,
      diskDensity: 1.25,
      diskThickness: 0.9,
      diskOuterRadius: 23.0,
      turbulence: 1.15,
      orbitSpeed: 0.95,
      jetIntensity: 0.0,
      exposure: 1.0,
      bloomIntensity: 0.60,
      anamorphicIntensity: 0.30,
      skyIntensity: 0.85,
      skyMode: 0,
      skyRotation: Object.freeze([0.38, 0.20]),
    }),
    camera: Object.freeze({
      radius: 9.5,
      elevationDeg: 4.5,
      azimuthDeg: 0.0,
      rollDeg: -11.0,
      fovDeg: 58.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'm87',
    name: 'EHT M87* (Polar Ring)',
    shortName: 'EHT M87*',
    hotkey: '5',
    params: Object.freeze({
      spin: 0.94,
      relativisticMode: 0.85,
      lensingStrength: 1.0,
      diskTemp: 4200,
      diskDensity: 1.2,
      diskThickness: 1.35,
      diskOuterRadius: 16.0,
      turbulence: 1.15,
      orbitSpeed: 0.75,
      jetIntensity: 0.16,
      exposure: 1.1,
      bloomIntensity: 0.62,
      anamorphicIntensity: 0.16,
      skyIntensity: 0.75,
      skyMode: 0,
      skyRotation: Object.freeze([2.05, -0.32]),
    }),
    camera: Object.freeze({
      radius: 24.5,
      elevationDeg: 62.0,
      azimuthDeg: 0.0,
      rollDeg: 0.0,
      fovDeg: 45.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'quasar',
    name: 'Active Quasar Core',
    shortName: 'Quasar',
    hotkey: '6',
    params: Object.freeze({
      spin: 0.99,
      relativisticMode: 0.75,
      lensingStrength: 1.0,
      diskTemp: 12500,
      diskDensity: 1.45,
      diskThickness: 1.3,
      diskOuterRadius: 28.0,
      turbulence: 1.45,
      orbitSpeed: 1.35,
      jetIntensity: 0.75,
      exposure: 0.88,
      bloomIntensity: 0.60,
      anamorphicIntensity: 0.30,
      skyIntensity: 0.80,
      skyMode: 0,
      skyRotation: Object.freeze([-0.82, 0.35]),
    }),
    camera: Object.freeze({
      radius: 34.0,
      elevationDeg: 18.0,
      azimuthDeg: 0.0,
      rollDeg: -8.0,
      fovDeg: 50.0,
      autoOrbit: true,
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
