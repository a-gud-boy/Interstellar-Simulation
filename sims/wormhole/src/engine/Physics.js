/**
 * Physics.js — Morris–Thorne (James–Thorne Dneg) & Ellis drainhole metric
 * radial profile r(l), slope dr/dl, topological region, and apparent portal diameter.
 */

const RAD2DEG = 180 / Math.PI;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Computes exact Morris-Thorne (Interstellar James-Thorne Dneg) or Ellis drainhole
 * radial profile r(l), slope dr/dl, topological region, and apparent portal diameter.
 *
 * @param {object} state
 * @param {number} lVal
 * @returns {{
 *   l: number,
 *   rOfL: number,
 *   drdl: number,
 *   region: 'Universe A' | 'Throat' | 'Universe B',
 *   throatRadius: number,
 *   apparentThroatDeg: number
 * }}
 */
export function computeWormholeTelemetry(state = {}, lVal = 0.0) {
  const l = Number.isFinite(Number(lVal)) ? Number(lVal) : 0.0;
  const metricType = (state?.metricType | 0) === 1 ? 1 : 0;

  const rawRho = Number(state?.throatRadius);
  const throatRadius = Math.max(0.25, Number.isFinite(rawRho) ? rawRho : 2.0);

  const rawLen = Number(state?.throatLength);
  const a = Math.max(0.0, Number.isFinite(rawLen) ? rawLen : 0.25);

  const rawWidth = Number(state?.lensingWidth);
  const M = Math.max(0.05, Number.isFinite(rawWidth) ? rawWidth : 0.32);

  let rOfL;
  let drdl;

  if (metricType === 1) {
    // Pure Ellis drainhole: r(l) = sqrt(rho^2 + l^2), dr/dl = l / r(l)
    rOfL = Math.sqrt(throatRadius * throatRadius + l * l);
    drdl = l / Math.max(rOfL, 1e-8);
  } else {
    // Interstellar (James-Thorne Dneg) cylindrical throat + smooth arctan flare
    const absL = Math.abs(l);
    if (absL <= a) {
      rOfL = throatRadius;
      drdl = 0.0;
    } else {
      const x = (2.0 * (absL - a)) / (Math.PI * M);
      rOfL = throatRadius + M * (x * Math.atan(x) - 0.5 * Math.log(1.0 + x * x));
      const signL = l >= 0 ? 1.0 : -1.0;
      drdl = signL * (2.0 / Math.PI) * Math.atan(x);
    }
  }

  const throatBoundary = metricType === 0 ? Math.max(a, 0.35) : 0.35;
  let region;
  if (Math.abs(l) <= throatBoundary) {
    region = 'Throat';
  } else if (l > 0) {
    region = 'Universe A';
  } else {
    region = 'Universe B';
  }

  // Critical impact parameter for throat traversal is b_c = throatRadius, so sin(theta_half) = rho / r(l)
  const sinHalf = clamp(throatRadius / Math.max(rOfL, 1e-6), 0.0, 1.0);
  const apparentThroatDeg = 2.0 * Math.asin(sinHalf) * RAD2DEG;

  return {
    l,
    rOfL,
    drdl,
    region,
    throatRadius,
    apparentThroatDeg,
  };
}
