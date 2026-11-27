/**
 * Physics.js — Exact Kerr metric relativistic telemetry in geometrised units (G = c = M = 1).
 */

const RAD2DEG = 180 / Math.PI;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Exact Kerr metric relativistic quantities in geometrised units (G = c = M = 1).
 * Exported as a pure function as well for testing/verification.
 */
export function computeKerrTelemetry(spin, radiusEuclidean, elevationRad) {
  const a = clamp(Number.isFinite(spin) ? spin : 0, 0, 0.998);
  const a2 = a * a;

  // Event horizon r+ = 1 + sqrt(1 - a^2)
  const horizonR = 1.0 + Math.sqrt(Math.max(0, 1.0 - a2));

  // Exact Bardeen-Press-Teukolsky (1972) prograde ISCO radius
  const oneMinusA2 = Math.max(0, 1.0 - a2);
  const z1 =
    1.0 +
    Math.cbrt(oneMinusA2) * (Math.cbrt(1.0 + a) + Math.cbrt(Math.max(0, 1.0 - a)));
  const z2 = Math.sqrt(3.0 * a2 + z1 * z1);
  const iscoR = 3.0 + z2 - Math.sqrt(Math.max(0, (3.0 - z1) * (3.0 + z1 + 2.0 * z2)));

  // Exact prograde & retrograde equatorial photon radii (Bardeen 1972)
  const photonProgradeR = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(clamp(-a, -1, 1))));
  const photonRetrogradeR = 2.0 * (1.0 + Math.cos((2.0 / 3.0) * Math.acos(clamp(a, -1, 1))));

  // Convert camera Euclidean Kerr-Schild coordinates to exact Boyer-Lindquist / KS radius r
  const R = Math.max(horizonR + 0.02, radiusEuclidean);
  const y = R * Math.sin(elevationRad);
  const u = R * R - a2;
  const r2 = 0.5 * (u + Math.sqrt(Math.max(0, u * u + 4.0 * a2 * y * y)));
  const r = Math.max(horizonR + 0.02, Math.sqrt(r2));

  const cosTheta = clamp(y / r, -1, 1);
  const sin2Theta = Math.max(0, 1.0 - cosTheta * cosTheta);

  // Kerr metric functions at observer (r, theta)
  const sigma = r * r + a2 * cosTheta * cosTheta;
  const delta = Math.max(1e-5, r * r - 2.0 * r + a2);
  const A = (r * r + a2) * (r * r + a2) - a2 * delta * sin2Theta;

  // ZAMO lapse alpha = sqrt(Sigma * Delta / A); reduces identically to sqrt(1 - 2/r) for a = 0
  const alphaZamo = Math.sqrt(clamp((sigma * delta) / Math.max(A, 1e-6), 1e-6, 1.0));
  const timeDilation = 1.0 / alphaZamo;

  // Local prograde circular orbital velocity v/c measured by a ZAMO (Bardeen-Press-Teukolsky eq. 3.10)
  const rOrb = Math.max(r, photonProgradeR + 1e-3);
  const rOrb2 = rOrb * rOrb;
  const deltaEq = Math.max(1e-6, rOrb2 - 2.0 * rOrb + a2);
  const Aeq = (rOrb2 + a2) * (rOrb2 + a2) - a2 * deltaEq;
  const omegaKepler = 1.0 / (Math.pow(rOrb, 1.5) + a);
  const omegaFrame = (2.0 * a * rOrb) / Math.max(Aeq, 1e-6);
  const orbitalVelocityC = clamp(
    (Aeq / (rOrb2 * Math.sqrt(deltaEq))) * (omegaKepler - omegaFrame),
    0.0,
    0.9999
  );

  // Apparent shadow angular diameter (degrees) using exact critical impact parameter
  // Schwarzschild: b_c = 3*sqrt(3) M = 5.19615 M; Kerr mean shadow radius contracts slightly with a^2
  const bCritMean = 3.0 * Math.sqrt(3.0) * (1.0 - 0.065 * a2);
  const sinHalfShadow = clamp((bCritMean * alphaZamo) / r, 0.0, 1.0);
  let halfAngleRad = Math.asin(sinHalfShadow);
  if (r < 3.0 && a < 0.5) {
    halfAngleRad = Math.PI - halfAngleRad;
  }
  const shadowAngularDeg = 2.0 * halfAngleRad * RAD2DEG;

  return {
    rOverM: r,
    rOverRs: r * 0.5,
    iscoR,
    horizonR,
    photonProgradeR,
    photonRetrogradeR,
    timeDilation,
    orbitalVelocityC,
    shadowAngularDeg,
  };
}
