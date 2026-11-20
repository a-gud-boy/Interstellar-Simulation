/**
 * Presets.js — Physically-parameterized Morris-Thorne / James-Thorne & Ellis
 * traversable wormhole presets and default simulator state.
 */

export const DEFAULT_STATE = Object.freeze({
  presetId: 'interstellar',

  // Wormhole metric & throat geometry
  metricType: 0,
  throatRadius: 2.0,
  throatLength: 0.6,
  lensingWidth: 1.35,

  // Throat caustic & swirling volumetric dust
  throatGlow: 0.22,
  dustDensity: 0.35,
  swirlSpeed: 0.85,

  // Dual-universe skies & landmarks
  skyIntensityA: 1.0,
  skyIntensityB: 1.15,
  planetVisible: 1,
  skyRotationA: Object.freeze([0.4, 0.2]),
  skyRotationB: Object.freeze([1.1, -0.15]),

  // Optics & render quality
  exposure: 1.05,
  bloomIntensity: 0.48,
  anamorphicIntensity: 0.20,
  quality: 1,
  resolutionScale: 1.0,

  // Transport controls
  paused: false,
  autoOrbit: true,
});

export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'interstellar',
    name: 'Interstellar Portal',
    shortName: 'Interstellar',
    hotkey: '1',
    params: Object.freeze({
      metricType: 0,
      throatRadius: 2.0,
      throatLength: 0.6,
      lensingWidth: 1.35,
      throatGlow: 0.22,
      dustDensity: 0.35,
      swirlSpeed: 0.85,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: 10.5,
      elevationDeg: 6.0,
      azimuthDeg: 0.0,
      lookYawDeg: 0.0,
      lookPitchDeg: 0.0,
      rollDeg: -4.0,
      fovDeg: 48.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'ellis',
    name: 'Pure Ellis Throat',
    shortName: 'Ellis',
    hotkey: '2',
    params: Object.freeze({
      metricType: 1,
      throatRadius: 2.2,
      throatLength: 0.0,
      lensingWidth: 1.0,
      throatGlow: 0.0,
      dustDensity: 0.0,
      swirlSpeed: 0.85,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: 9.5,
      elevationDeg: 8.0,
      azimuthDeg: 18.0,
      lookYawDeg: 0.0,
      lookPitchDeg: 0.0,
      rollDeg: 0.0,
      fovDeg: 46.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'tunnel',
    name: 'Long Throat Tunnel',
    shortName: 'Long Tunnel',
    hotkey: '3',
    params: Object.freeze({
      metricType: 0,
      throatRadius: 1.8,
      throatLength: 4.5,
      lensingWidth: 0.9,
      throatGlow: 0.55,
      dustDensity: 0.75,
      swirlSpeed: 1.1,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: 11.0,
      elevationDeg: 3.0,
      azimuthDeg: 0.0,
      lookYawDeg: 0.0,
      lookPitchDeg: 0.0,
      rollDeg: -6.0,
      fovDeg: 52.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'crossing',
    name: 'Inside the Throat',
    shortName: 'In Throat',
    hotkey: '4',
    params: Object.freeze({
      metricType: 0,
      throatRadius: 2.2,
      throatLength: 1.2,
      lensingWidth: 1.1,
      throatGlow: 0.45,
      dustDensity: 0.55,
      swirlSpeed: 1.0,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: 0.0,
      elevationDeg: 0.0,
      azimuthDeg: 0.0,
      lookYawDeg: 0.0,
      lookPitchDeg: 0.0,
      rollDeg: -5.0,
      fovDeg: 62.0,
      autoOrbit: false,
    }),
  }),

  Object.freeze({
    id: 'universe_b',
    name: 'Gargantua Side (Univ B)',
    shortName: 'Universe B',
    hotkey: '5',
    params: Object.freeze({
      metricType: 0,
      throatRadius: 2.0,
      throatLength: 0.6,
      lensingWidth: 1.35,
      throatGlow: 0.22,
      dustDensity: 0.35,
      swirlSpeed: 0.85,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: -10.5,
      elevationDeg: 7.0,
      azimuthDeg: 10.0,
      lookYawDeg: 180.0,
      lookPitchDeg: 0.0,
      rollDeg: 4.0,
      fovDeg: 48.0,
      autoOrbit: true,
    }),
  }),

  Object.freeze({
    id: 'einstein',
    name: 'Twin Einstein Rings',
    shortName: 'Einstein Rings',
    hotkey: '6',
    params: Object.freeze({
      metricType: 0,
      throatRadius: 1.6,
      throatLength: 0.25,
      lensingWidth: 0.45,
      throatGlow: 0.12,
      dustDensity: 0.15,
      swirlSpeed: 0.85,
      skyIntensityA: 1.0,
      skyIntensityB: 1.15,
      planetVisible: 1,
      skyRotationA: Object.freeze([0.4, 0.2]),
      skyRotationB: Object.freeze([1.1, -0.15]),
      exposure: 1.05,
      bloomIntensity: 0.48,
      anamorphicIntensity: 0.20,
    }),
    camera: Object.freeze({
      l: 13.0,
      elevationDeg: 4.0,
      azimuthDeg: -22.0,
      lookYawDeg: 0.0,
      lookPitchDeg: 0.0,
      rollDeg: 0.0,
      fovDeg: 42.0,
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
    skyRotationA: [...DEFAULT_STATE.skyRotationA],
    skyRotationB: [...DEFAULT_STATE.skyRotationB],
  };
}
