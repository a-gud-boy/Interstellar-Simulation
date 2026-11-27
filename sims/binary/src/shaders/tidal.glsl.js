/**
 * WebGL2 GLSL 300 es 256x256 co-rotating tidal hydrodynamics & spiral shockwave
 * ping-pong solver for Binary Black Hole Inspiral & GW Lensing Simulator.
 *
 * Output RGBA16F channels:
 *   R: Surface density Sigma (circumbinary disk, twin mini-disks, tidal bridges, L1 stream)
 *   G: Thermal / shock heating temperature multiplier (>= 1.0)
 *   B: Lab-frame velocity X projected into co-rotating basis (v_x_corot_lab)
 *   A: Lab-frame velocity Z projected into co-rotating basis (v_z_corot_lab)
 */

export const TIDAL_FIELD_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uPrevTidal;
uniform vec2  uTexelSize;
uniform float uSeparation;
uniform float uMassRatio;
uniform float uOmega;
uniform float uDiskDensity;
uniform float uBridgeIntensity;
uniform float uDiskOuterRadius;
uniform float uFieldHalfSize;
uniform float uTime;
uniform float uDt;
uniform int   uReset;
uniform float uRocheL1;
uniform float uRocheL2;
uniform float uRCavity;
uniform float uRingdown;

vec2 closestOnSegment(vec2 p, vec2 a, vec2 b, out float segT) {
  vec2 ab = b - a;
  float len2 = max(dot(ab, ab), 1e-6);
  segT = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
  return a + ab * segT;
}

void evalBezierStream(
  vec2 p,
  vec2 p0,
  vec2 p1,
  vec2 p2,
  vec2 p3,
  out float minDist,
  out float bestS,
  out vec2 bestTan
) {
  float minDistSq = 1e12;
  bestS = 0.0;
  vec2 bestVec = vec2(1.0, 0.0);

  vec2 prev = p0;
  const int SEGS = 6;
  for (int i = 1; i <= SEGS; ++i) {
    float t = float(i) / float(SEGS);
    float it = 1.0 - t;
    vec2 cur = (it * it * it) * p0
             + (3.0 * it * it * t) * p1
             + (3.0 * it * t * t) * p2
             + (t * t * t) * p3;
    float segT;
    vec2 q = closestOnSegment(p, prev, cur, segT);
    vec2 dp = p - q;
    float distSq = dot(dp, dp);
    if (distSq < minDistSq) {
      minDistSq = distSq;
      bestS = (float(i - 1) + segT) / float(SEGS);
      bestVec = cur - prev;
    }
    prev = cur;
  }
  minDist = sqrt(minDistSq);
  float dLenSq = dot(bestVec, bestVec);
  bestTan = dLenSq > 1e-10 ? (bestVec * inversesqrt(dLenSq)) : vec2(1.0, 0.0);
}

vec4 evalEquilibrium(vec2 posRot) {
  float q = clamp(uMassRatio, 0.05, 1.0);
  float m1 = 1.0 / (1.0 + q);
  float m2 = q / (1.0 + q);
  float eta = m1 * m2;
  float d = max(uSeparation, 1.4);

  vec2 c1 = vec2(-m2 * d, 0.0);
  vec2 c2 = vec2(+m1 * d, 0.0);

  float r = length(posRot);
  float phi = atan(posRot.y, posRot.x);

  // 1. Circumbinary Disk (CBD) with eccentric cleared tidal cavity, lump & m=2 trailing spirals
  float cbdSigma = 0.0;
  float cbdTemp = 1.0;
  vec2 vCbd = vec2(0.0);

  float rCav = max(uRCavity, d * 1.5);
  float rOuter = max(uDiskOuterRadius, rCav + 4.0);
  if (uDiskDensity > 0.001 && r < rOuter * 1.12) {
    float ecc = 0.14 * clamp(4.0 * eta, 0.25, 1.0);
    float phiPrec = phi - 0.12 * uTime;
    float rCavEff = rCav * (1.0 + ecc * cos(phiPrec));

    float cavWall = smoothstep(rCavEff * 0.76, rCavEff * 1.18, r);
    float outerMask = 1.0 - smoothstep(rOuter * 0.72, rOuter * 1.06, r);
    float rPeak = max(rCav * 1.22, 2.5);
    float radProf = pow(clamp(rPeak / max(r, rPeak * 0.72), 0.10, 1.45), 0.72);

    // Trailing m=2 Lindblad spiral shock arms (alpha decreases with phi_orb -> +alpha lags behind)
    float spiralArg = 2.0 * (phi - 1.95 * log(max(r / max(rCav, 1.0), 0.45)));
    float sCos = max(0.5 + 0.5 * cos(spiralArg), 0.0);
    float spiralShock = sCos * sCos * sCos;

    // Precessing overdense cavity-edge lump
    float lumpDist = (r - rCavEff * 1.07) / max(0.26 * rCav, 0.5);
    float lumpRad = exp(-lumpDist * lumpDist);
    float lumpAz = pow(max(0.5 + 0.5 * cos(phiPrec), 0.0), 2.2);
    float lump = 0.50 * lumpRad * lumpAz;

    cbdSigma = uDiskDensity * cavWall * outerMask * (radProf * (0.45 + 0.58 * spiralShock) + lump);
    float rimDist = (r - rCavEff) / max(0.24 * rCav, 0.4);
    cbdTemp = 1.0 + 0.34 * spiralShock + 0.28 * lump + 0.20 * exp(-rimDist * rimDist);

    float safeR = max(r, 1.2);
    float omegaCbd = 1.0 / (safeR * sqrt(safeR) + 0.5 * (3.0 - eta) * sqrt(safeR));
    vec2 tangentCbd = vec2(posRot.y, -posRot.x);
    vCbd = omegaCbd * tangentCbd - 0.035 * omegaCbd * posRot;
  }

  // 2. Twin Mini-Disks inside Eggleton Roche lobes
  float miniSigma1 = 0.0;
  float miniSigma2 = 0.0;
  float miniTemp1 = 1.0;
  float miniTemp2 = 1.0;
  vec2 vMini1 = vec2(0.0);
  vec2 vMini2 = vec2(0.0);
  float d1 = 0.0;
  float d2 = 0.0;

  if (uBridgeIntensity > 0.001) {
    // Primary mini-disk (BH1)
    vec2 dVec1 = posRot - c1;
    d1 = length(dVec1);
    float rIn1 = 1.75 * m1;
    float rOut1 = max(rIn1 + 0.45, min(0.84 * max(uRocheL1, 0.5), 0.45 * d));
    if (d1 < rOut1 * 1.15 && d1 > 0.45 * m1) {
      float mMask1 = smoothstep(rIn1 * 0.72, rIn1 * 1.16, d1)
                   * (1.0 - smoothstep(rOut1 * 0.68, rOut1 * 1.08, d1));
      float phi1 = atan(dVec1.y, dVec1.x);
      float sBase1 = max(0.5 + 0.5 * cos(2.0 * (phi1 - 1.45 * log(max(d1 / max(rIn1, 0.1), 0.45)))), 0.0);
      float sp1 = sBase1 * sBase1;
      miniSigma1 = uBridgeIntensity * (0.62 + 0.52 * m1) * mMask1 * (0.66 + 0.44 * sp1);
      miniTemp1 = 1.68 + 0.55 * (1.0 - smoothstep(rIn1, rOut1, d1)) + 0.30 * sp1 + 0.35 * uRingdown;

      float safeD1 = max(d1, 1.35 * m1);
      float omega1 = sqrt(m1 / (safeD1 * safeD1 * safeD1));
      vec2 vBH1 = vec2(uOmega * c1.y, -uOmega * c1.x);
      vMini1 = vBH1 + omega1 * vec2(dVec1.y, -dVec1.x) - 0.04 * omega1 * dVec1;
    }

    // Secondary mini-disk (BH2)
    vec2 dVec2 = posRot - c2;
    d2 = length(dVec2);
    float rIn2 = 1.75 * m2;
    float rOut2 = max(rIn2 + 0.35, min(0.84 * max(uRocheL2, 0.35), 0.44 * d));
    if (d2 < rOut2 * 1.15 && d2 > 0.45 * m2) {
      float mMask2 = smoothstep(rIn2 * 0.72, rIn2 * 1.16, d2)
                   * (1.0 - smoothstep(rOut2 * 0.68, rOut2 * 1.08, d2));
      float phi2 = atan(dVec2.y, dVec2.x);
      float sBase2 = max(0.5 + 0.5 * cos(2.0 * (phi2 - 1.45 * log(max(d2 / max(rIn2, 0.1), 0.45)))), 0.0);
      float sp2 = sBase2 * sBase2;
      miniSigma2 = uBridgeIntensity * (0.58 + 0.56 * m2) * mMask2 * (0.66 + 0.44 * sp2);
      miniTemp2 = 1.76 + 0.60 * (1.0 - smoothstep(rIn2, rOut2, d2)) + 0.30 * sp2 + 0.35 * uRingdown;

      float safeD2 = max(d2, 1.35 * m2);
      float omega2 = sqrt(m2 / (safeD2 * safeD2 * safeD2));
      vec2 vBH2 = vec2(uOmega * c2.y, -uOmega * c2.x);
      vMini2 = vBH2 + omega2 * vec2(dVec2.y, -dVec2.x) - 0.04 * omega2 * dVec2;
    }
  }

  // 3. Twin S-shaped Tidal Gas Bridges + Inner L1 Sloshing Stream
  float bridgeSigma = 0.0;
  float bridgeTemp = 1.0;
  vec2 vBridge = vec2(0.0);

  if (uBridgeIntensity > 0.001 && r < rCav * 1.25) {
    float rOut1Est = max(1.75 * m1 + 0.45, min(0.84 * max(uRocheL1, 0.5), 0.45 * d));
    float rOut2Est = max(1.75 * m2 + 0.35, min(0.84 * max(uRocheL2, 0.35), 0.44 * d));

    float dist1, s1;
    vec2 tan1;
    evalBezierStream(
      posRot,
      vec2(rCav * 1.06 * cos(2.52), rCav * 1.06 * sin(2.52)),
      vec2(-0.70 * rCav, +0.35 * rCav),
      vec2(c1.x - 0.12 * d, +0.28 * d),
      c1 + vec2(0.0, +0.52 * rOut1Est),
      dist1, s1, tan1
    );

    float dist2, s2;
    vec2 tan2;
    evalBezierStream(
      posRot,
      vec2(rCav * 1.06 * cos(-0.62), rCav * 1.06 * sin(-0.62)),
      vec2(+0.70 * rCav, -0.35 * rCav),
      vec2(c2.x + 0.12 * d, -0.28 * d),
      c2 + vec2(0.0, -0.52 * rOut2Est),
      dist2, s2, tan2
    );

    float distL1, sL1;
    vec2 tanL1;
    evalBezierStream(
      posRot,
      c1 + vec2(0.35 * rOut1Est, +0.12 * d),
      vec2((m1 - m2) * 0.12 * d, +0.06 * d),
      vec2((m1 - m2) * 0.18 * d, -0.06 * d),
      c2 + vec2(-0.35 * rOut2Est, -0.12 * d),
      distL1, sL1, tanL1
    );

    float baseW = 0.085 * d + 0.042 * rCav;
    float w1 = baseW * mix(1.25, 0.42, s1);
    float w2 = baseW * mix(1.25, 0.42, s2);
    float wL = baseW * 0.65;

    float clumps1 = 0.72 + 0.34 * sin(s1 * 14.0 - uTime * 2.2);
    float clumps2 = 0.72 + 0.34 * sin(s2 * 14.0 - uTime * 2.2 + 1.7);
    float clumpsL = 0.68 + 0.32 * sin(sL1 * 10.0 + uTime * 1.6);

    float mask1 = exp(-(dist1 * dist1) / max(w1 * w1, 1e-4)) * smoothstep(0.0, 0.10, s1) * (1.0 - smoothstep(0.88, 1.0, s1));
    float mask2 = exp(-(dist2 * dist2) / max(w2 * w2, 1e-4)) * smoothstep(0.0, 0.10, s2) * (1.0 - smoothstep(0.88, 1.0, s2));
    float maskL = exp(-(distL1 * distL1) / max(wL * wL, 1e-4)) * smoothstep(0.0, 0.15, sL1) * (1.0 - smoothstep(0.85, 1.0, sL1));

    // Avoid illuminating inside horizons
    float horCut = smoothstep(0.85 * m1, 1.35 * m1, d1) * smoothstep(0.85 * m2, 1.35 * m2, d2);

    float st1 = mask1 * clumps1 * horCut;
    float st2 = mask2 * clumps2 * horCut;
    float stL = maskL * clumpsL * horCut * 0.65;

    bridgeSigma = uBridgeIntensity * (0.95 * st1 + 0.95 * st2 + 0.75 * stL);
    float impactHeat = max(st1 * smoothstep(0.65, 0.95, s1), st2 * smoothstep(0.65, 0.95, s2));
    bridgeTemp = 1.32 + 0.65 * impactHeat + 0.30 * uRingdown;

    float streamSpeed = min(0.55, sqrt(1.0 / max(r, 1.5)) * 1.15);
    vec2 vSt1 = vec2(uOmega * posRot.y, -uOmega * posRot.x) + tan1 * streamSpeed;
    vec2 vSt2 = vec2(uOmega * posRot.y, -uOmega * posRot.x) + tan2 * streamSpeed;
    vec2 vStL = vec2(uOmega * posRot.y, -uOmega * posRot.x) + tanL1 * (0.35 * streamSpeed);
    float wSumB = st1 + st2 + stL + 1e-5;
    vBridge = (st1 * vSt1 + st2 * vSt2 + stL * vStL) / wSumB;
  }

  float totalSigma = cbdSigma + miniSigma1 + miniSigma2 + bridgeSigma;
  float wSum = cbdSigma + miniSigma1 + miniSigma2 + bridgeSigma + 1e-5;
  float totalTemp = (cbdSigma * cbdTemp + miniSigma1 * miniTemp1 + miniSigma2 * miniTemp2 + bridgeSigma * bridgeTemp) / wSum;
  if (totalSigma < 1e-5) {
    totalTemp = 1.0;
  }
  vec2 totalVel = (cbdSigma * vCbd + miniSigma1 * vMini1 + miniSigma2 * vMini2 + bridgeSigma * vBridge) / wSum;

  // Clamp physical velocity safely subluminal
  float vMag = length(totalVel);
  if (vMag > 0.72) {
    totalVel *= (0.72 / vMag);
  }

  return vec4(clamp(totalSigma, 0.0, 8.0), clamp(totalTemp, 0.8, 3.2), totalVel.x, totalVel.y);
}

void main() {
  vec2 posRot = (vUv * 2.0 - 1.0) * uFieldHalfSize;
  vec4 eq = evalEquilibrium(posRot);

  if (uReset == 1 || uDt <= 1e-6) {
    fragColor = eq;
    return;
  }

  // Semi-Lagrangian advection in co-rotating frame + shock-convergence heating
  vec4 curPrev = texture(uPrevTidal, vUv);
  vec2 vLab = curPrev.ba;
  vec2 uCorot = vec2(vLab.x - uOmega * posRot.y, vLab.y + uOmega * posRot.x);

  float advectDt = clamp(uDt * 12.0, 0.0, 0.25);
  vec2 prevPos = posRot - uCorot * advectDt;
  vec2 prevUv = clamp(prevPos / (2.0 * uFieldHalfSize) + 0.5, vec2(0.002), vec2(0.998));
  vec4 advected = texture(uPrevTidal, prevUv);

  // Estimate velocity convergence -div(u_corot) for spiral shock heating
  vec4 ppx = texture(uPrevTidal, clamp(vUv + vec2(uTexelSize.x, 0.0), vec2(0.002), vec2(0.998)));
  vec4 pmx = texture(uPrevTidal, clamp(vUv - vec2(uTexelSize.x, 0.0), vec2(0.002), vec2(0.998)));
  vec4 ppy = texture(uPrevTidal, clamp(vUv + vec2(0.0, uTexelSize.y), vec2(0.002), vec2(0.998)));
  vec4 pmy = texture(uPrevTidal, clamp(vUv - vec2(0.0, uTexelSize.y), vec2(0.002), vec2(0.998)));
  float cellWorld = 2.0 * uFieldHalfSize * uTexelSize.x;
  float divU = ((ppx.b - pmx.b) + (ppy.a - pmy.a)) / max(2.0 * cellWorld, 1e-3);
  float shockHeat = clamp(max(0.0, -divU) * 0.45, 0.0, 0.65);

  float relax = clamp(uDt * 1.45, 0.04, 0.35);
  vec4 nextState = mix(advected, eq, relax);
  nextState.g = clamp(max(nextState.g, eq.g) + shockHeat * 0.35, 0.8, 3.2);

  // Clean NaN/Inf safeguard
  bvec4 bad = bvec4(
    isnan(nextState.r) || isinf(nextState.r),
    isnan(nextState.g) || isinf(nextState.g),
    isnan(nextState.b) || isinf(nextState.b),
    isnan(nextState.a) || isinf(nextState.a)
  );
  nextState = mix(nextState, eq, bad);

  fragColor = nextState;
}
`;
