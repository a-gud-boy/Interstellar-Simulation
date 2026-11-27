/**
 * BaseCamera.js — Shared critically damped spring integrators, spherical/local-look
 * orthonormal basis math, cubic flight easing, and input normalization helpers
 * shared across all 7 Interstellar Simulation camera controllers.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const DEFAULT_SPRING_OMEGA = 13.5;
export const DEFAULT_INTERACTION_COOLDOWN = 2.4;

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function wrapAngleDelta(delta) {
  let d = (delta + Math.PI) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d - Math.PI;
}

export function easeOutCubic(t) {
  const u = 1.0 - clamp(t, 0, 1);
  return 1.0 - u * u * u;
}

export function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - Math.pow(-2.0 * x + 2.0, 3) * 0.5;
}

export function stepCriticallyDamped(current, velocity, target, omega, dt) {
  const diff = current - target;
  const exp = Math.exp(-omega * dt);
  const next = target + (diff + (velocity + omega * diff) * dt) * exp;
  const nextVel = (velocity - omega * (velocity + omega * diff) * dt) * exp;
  if (Math.abs(next - target) < 1e-6 && Math.abs(nextVel) < 1e-6) {
    return [target, 0.0];
  }
  return [next, nextVel];
}

export function isEditableElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export function normalizeWheelDelta(e) {
  const modeScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
  return clamp(e.deltaY * modeScale, -240, 240);
}

/**
 * Applies local lookYaw, lookPitch, and roll around an orthonormal triad (r0, u0, f0),
 * preserving exact right-handedness cross(right, forward) === up without divisions.
 */
export function applyLocalLookTriad(r0, u0, f0, lookYaw, lookPitch, roll) {
  const cosY = Math.cos(lookYaw);
  const sinY = Math.sin(lookYaw);

  const fYx = cosY * f0[0] + sinY * r0[0];
  const fYy = cosY * f0[1] + sinY * r0[1];
  const fYz = cosY * f0[2] + sinY * r0[2];

  const rYx = cosY * r0[0] - sinY * f0[0];
  const rYy = cosY * r0[1] - sinY * f0[1];
  const rYz = cosY * r0[2] - sinY * f0[2];

  const cosP = Math.cos(lookPitch);
  const sinP = Math.sin(lookPitch);

  const fx = cosP * fYx + sinP * u0[0];
  const fy = cosP * fYy + sinP * u0[1];
  const fz = cosP * fYz + sinP * u0[2];

  const uPx = -sinP * fYx + cosP * u0[0];
  const uPy = -sinP * fYy + cosP * u0[1];
  const uPz = -sinP * fYz + cosP * u0[2];

  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  const rx = cosR * rYx + sinR * uPx;
  const ry = cosR * rYy + sinR * uPy;
  const rz = cosR * rYz + sinR * uPz;

  const ux = -sinR * rYx + cosR * uPx;
  const uy = -sinR * rYy + cosR * uPy;
  const uz = -sinR * rYz + cosR * uPz;

  return {
    right: [rx, ry, rz],
    up: [ux, uy, uz],
    forward: [fx, fy, fz],
  };
}

/**
 * Computes pole-free right-handed orbital triad looking toward the origin at (azimuth, elevation)
 * with Dutch roll applied around forward. Column-major mat3: [right, up, forward].
 */
export function computeSphericalOrbitBasis(azimuth, elevation, roll) {
  const cosEl = Math.cos(elevation);
  const sinEl = Math.sin(elevation);
  const cosAz = Math.cos(azimuth);
  const sinAz = Math.sin(azimuth);

  const uxDir = cosEl * sinAz;
  const uyDir = sinEl;
  const uzDir = cosEl * cosAz;

  const fx = -uxDir;
  const fy = -uyDir;
  const fz = -uzDir;

  let r0x = -fz;
  const r0y = 0.0;
  let r0z = fx;
  const r0Len = Math.hypot(r0x, r0z);
  if (r0Len < 1e-6) {
    r0x = cosAz;
    r0z = -sinAz;
  } else {
    r0x /= r0Len;
    r0z /= r0Len;
  }

  let u0x = r0y * fz - r0z * fy;
  let u0y = r0z * fx - r0x * fz;
  let u0z = r0x * fy - r0y * fx;
  const u0Len = Math.hypot(u0x, u0y, u0z) || 1.0;
  u0x /= u0Len;
  u0y /= u0Len;
  u0z /= u0Len;

  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  return {
    posUnit: [uxDir, uyDir, uzDir],
    right: [cosR * r0x + sinR * u0x, cosR * r0y + sinR * u0y, cosR * r0z + sinR * u0z],
    up: [-sinR * r0x + cosR * u0x, -sinR * r0y + cosR * u0y, -sinR * r0z + cosR * u0z],
    forward: [fx, fy, fz],
  };
}
