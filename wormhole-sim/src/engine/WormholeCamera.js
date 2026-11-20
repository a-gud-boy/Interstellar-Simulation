/**
 * WormholeCamera.js — Critically-damped Morris-Thorne wormhole camera controller,
 * multi-input navigation (left-drag orbit, right-drag/Q/E roll, shift/middle-drag
 * look yaw/pitch, wheel/pinch/W/S smooth through-throat proper-distance l motion),
 * smooth cubic flights & zero-flip l=0 traversal, and exact wormhole telemetry.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const MIN_L = -35.0;
const MAX_L = 35.0;
const MIN_ELEVATION = -85.0 * DEG2RAD;
const MAX_ELEVATION = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH = 85.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 22.0 * DEG2RAD;
const MAX_FOV = 85.0 * DEG2RAD;

const SPRING_OMEGA = 13.5; // Critically damped natural frequency (rad/s)
const AUTO_ORBIT_SPEED = 0.045; // Gentle cinematic angular drift (rad/s)
const AUTO_BREATH_AMP = 0.010; // ~0.57 deg gentle elevation breathing
const AUTO_BREATH_FREQ = 0.22; // rad/s
const INTERACTION_COOLDOWN = 2.4; // Seconds before auto-orbit gently resumes

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function wrapAngleDelta(delta) {
  let d = (delta + Math.PI) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d - Math.PI;
}

function easeOutCubic(t) {
  const u = 1.0 - clamp(t, 0, 1);
  return 1.0 - u * u * u;
}

function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - Math.pow(-2.0 * x + 2.0, 3) * 0.5;
}

function stepCriticallyDamped(current, velocity, target, omega, dt) {
  const diff = current - target;
  const exp = Math.exp(-omega * dt);
  const next = target + (diff + (velocity + omega * diff) * dt) * exp;
  const nextVel = (velocity - omega * (velocity + omega * diff) * dt) * exp;
  if (Math.abs(next - target) < 1e-6 && Math.abs(nextVel) < 1e-6) {
    return [target, 0.0];
  }
  return [next, nextVel];
}

function isEditableElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
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
  const a = Math.max(0.0, Number.isFinite(rawLen) ? rawLen : 0.6);

  const rawWidth = Number(state?.lensingWidth);
  const M = Math.max(0.05, Number.isFinite(rawWidth) ? rawWidth : 1.35);

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

export class WormholeCamera {
  /**
   * @param {HTMLCanvasElement | null} canvas
   * @param {object} initialCam
   * @param {{ onResetRequest?: () => void, onUserInteract?: () => void }} [callbacks]
   */
  constructor(canvas, initialCam = {}, callbacks = {}) {
    this.canvas = canvas || null;
    this.onResetRequest = callbacks.onResetRequest || null;
    this.onUserInteract = callbacks.onUserInteract || null;

    const l0 = clamp(initialCam.l ?? 10.5, MIN_L, MAX_L);
    const el0 = clamp((initialCam.elevationDeg ?? 6.0) * DEG2RAD, MIN_ELEVATION, MAX_ELEVATION);
    const az0 = (initialCam.azimuthDeg ?? 0.0) * DEG2RAD;
    const yaw0 = (initialCam.lookYawDeg ?? 0.0) * DEG2RAD;
    const pitch0 = clamp((initialCam.lookPitchDeg ?? 0.0) * DEG2RAD, MIN_LOOK_PITCH, MAX_LOOK_PITCH);
    const roll0 = clamp((initialCam.rollDeg ?? -4.0) * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp((initialCam.fovDeg ?? 48.0) * DEG2RAD, MIN_FOV, MAX_FOV);

    // Current rendered camera coordinates
    this.l = l0;
    this.elevation = el0;
    this.azimuth = az0;
    this.lookYaw = yaw0;
    this.lookPitch = pitch0;
    this.roll = roll0;
    this.fov = fov0;

    // Spring target coordinates
    this.targetL = l0;
    this.targetElevation = el0;
    this.targetAzimuth = az0;
    this.targetLookYaw = yaw0;
    this.targetLookPitch = pitch0;
    this.targetRoll = roll0;
    this.targetFov = fov0;

    // Critically-damped spring velocities
    this.velL = 0;
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velLookYaw = 0;
    this.velLookPitch = 0;
    this.velRoll = 0;
    this.velFov = 0;

    // Flight state (preset transitions & through-throat traversal)
    this._flight = null;

    // Auto-orbit state
    this._autoOrbitTime = 0;
    this._autoBaseElevation = el0;
    this._interactionCooldown = 0;

    // Cached matrix outputs
    this._n0 = [0, 0, 1];
    this._basis = new Float32Array(9);
    this._moved = true;
    this._prevSignature = null;

    // Active input tracking
    this._pointers = new Map();
    this._pinchPrevDist = null;
    this._dragMode = null; // 'orbit' | 'roll' | 'look' | 'pinch'
    this._keys = new Set();
    this._windowBound = false;
    this._canvasBoundTo = null;

    this._recomputeBasis();
    this._bindEvents();
  }

  getState() {
    return {
      l: this.l,
      elevationDeg: this.elevation * RAD2DEG,
      azimuthDeg: this.azimuth * RAD2DEG,
      lookYawDeg: this.lookYaw * RAD2DEG,
      lookPitchDeg: this.lookPitch * RAD2DEG,
      rollDeg: this.roll * RAD2DEG,
      fovDeg: this.fov * RAD2DEG,
    };
  }

  /**
   * Smoothly fly camera to a target pose using cubic ease-out interpolation.
   * Pass duration = 0 to snap immediately.
   */
  flyTo(camPreset = {}, duration = 1.2, easeMode = 'outCubic') {
    const destL = clamp(camPreset.l ?? this.l, MIN_L, MAX_L);
    const destEl = clamp(
      (camPreset.elevationDeg ?? this.elevation * RAD2DEG) * DEG2RAD,
      MIN_ELEVATION,
      MAX_ELEVATION
    );
    const destAzRaw = (camPreset.azimuthDeg ?? this.azimuth * RAD2DEG) * DEG2RAD;
    const destAz = this.azimuth + wrapAngleDelta(destAzRaw - this.azimuth);

    const destYawRaw = (camPreset.lookYawDeg ?? this.lookYaw * RAD2DEG) * DEG2RAD;
    const destYaw = this.lookYaw + wrapAngleDelta(destYawRaw - this.lookYaw);

    const destPitch = clamp(
      (camPreset.lookPitchDeg ?? this.lookPitch * RAD2DEG) * DEG2RAD,
      MIN_LOOK_PITCH,
      MAX_LOOK_PITCH
    );
    const destRoll = clamp(
      (camPreset.rollDeg ?? this.roll * RAD2DEG) * DEG2RAD,
      MIN_ROLL,
      MAX_ROLL
    );
    const destFov = clamp(
      (camPreset.fovDeg ?? this.fov * RAD2DEG) * DEG2RAD,
      MIN_FOV,
      MAX_FOV
    );

    if (!duration || duration <= 0) {
      this._flight = null;
      this.l = this.targetL = destL;
      this.elevation = this.targetElevation = destEl;
      this.azimuth = this.targetAzimuth = destAzRaw;
      this.lookYaw = this.targetLookYaw = destYawRaw;
      this.lookPitch = this.targetLookPitch = destPitch;
      this.roll = this.targetRoll = destRoll;
      this.fov = this.targetFov = destFov;
      this.velL = 0;
      this.velElevation = 0;
      this.velAzimuth = 0;
      this.velLookYaw = 0;
      this.velLookPitch = 0;
      this.velRoll = 0;
      this.velFov = 0;
      this._autoBaseElevation = destEl;
      this._autoOrbitTime = 0;
      this._interactionCooldown = 0;
      this._recomputeBasis();
      this._moved = true;
      return;
    }

    this._flight = {
      elapsed: 0,
      duration,
      easeMode,
      startL: this.l,
      startElevation: this.elevation,
      startAzimuth: this.azimuth,
      startLookYaw: this.lookYaw,
      startLookPitch: this.lookPitch,
      startRoll: this.roll,
      startFov: this.fov,
      endL: destL,
      endElevation: destEl,
      endAzimuth: destAz,
      endLookYaw: destYaw,
      endLookPitch: destPitch,
      endRoll: destRoll,
      endFov: destFov,
    };
    this.velL = 0;
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velLookYaw = 0;
    this.velLookPitch = 0;
    this.velRoll = 0;
    this.velFov = 0;
    this._interactionCooldown = 0;
  }

  /**
   * Smoothly flies proper coordinate l across l=0 to the opposite universe
   * while holding lookYaw/basis orientation continuous (ZERO flip at l=0).
   */
  traverse(duration = 3.2) {
    const startL = this.l;
    let targetL;
    if (Math.abs(startL) < 0.5) {
      // Starting inside the throat: emerge out the side we are currently facing
      targetL = Math.cos(this.lookYaw) >= 0 ? -10.5 : 10.5;
    } else {
      const mag = Math.max(Math.abs(startL), 2.0);
      targetL = startL > 0 ? -mag : mag;
    }
    this.flyTo({ l: clamp(targetL, MIN_L, MAX_L) }, duration, 'inOutCubic');
    return targetL;
  }

  /**
   * Immediately set camera pose (used by programmatic verification API).
   */
  setImmediate(camPatch = {}) {
    this.flyTo(camPatch, 0);
  }

  _cancelFlight() {
    if (this._flight) {
      this._flight = null;
      this.targetL = this.l;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
    }
  }

  _markUserInteraction() {
    this._cancelFlight();
    this._interactionCooldown = INTERACTION_COOLDOWN;
    this._autoBaseElevation = this.targetElevation;
    this._autoOrbitTime = 0;
    if (this.onUserInteract) {
      this.onUserInteract();
    }
  }

  _forwardMoveSign() {
    // When |lookYaw| <= 90 deg, camera looks along -n0 (-l direction into throat from Univ A).
    // When |lookYaw| > 90 deg (e.g. Univ B preset lookYaw=180), camera looks along +n0 (+l direction).
    return Math.cos(this.targetLookYaw) >= 0 ? -1.0 : 1.0;
  }

  _bindEvents() {
    this._onContextMenu = (e) => {
      e.preventDefault();
    };

    this._onAuxClick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };

    this._onPointerDown = (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2 && e.pointerType === 'mouse') {
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
      }
      this.canvas?.setPointerCapture?.(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });

      if (this._pointers.size === 1) {
        if (e.button === 2) {
          this._dragMode = 'roll';
        } else if (e.button === 1 || e.shiftKey) {
          this._dragMode = 'look';
        } else {
          this._dragMode = 'orbit';
        }
      } else if (this._pointers.size === 2) {
        this._dragMode = 'pinch';
        this._pinchPrevDist = this._getPinchDistance();
      }
      this._markUserInteraction();
    };

    this._onPointerMove = (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev) return;

      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;

      if (this._pointers.size >= 2) {
        const dist = this._getPinchDistance();
        if (this._pinchPrevDist && dist > 1) {
          const ratio = this._pinchPrevDist / dist;
          const stepMag = 2.5 + Math.abs(this.targetL);
          const sign = this._forwardMoveSign();
          // Pinch out (dist > prevDist -> ratio < 1 -> log < 0) moves forward along camera facing
          this.targetL = clamp(
            this.targetL + (-sign) * Math.log(ratio) * stepMag,
            MIN_L,
            MAX_L
          );
          this._markUserInteraction();
        }
        this._pinchPrevDist = dist;
        return;
      }

      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
      const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: vw, height: vh };
      const scale = 1.0 / Math.max(Math.min(rect.width, rect.height), 320);

      if (this._dragMode === 'roll') {
        this.targetRoll = clamp(this.targetRoll + dx * scale * 2.2, MIN_ROLL, MAX_ROLL);
      } else if (this._dragMode === 'look' || (this._dragMode === 'orbit' && e.shiftKey)) {
        this.targetLookYaw += dx * scale * 2.6;
        this.targetLookPitch = clamp(
          this.targetLookPitch - dy * scale * 2.2,
          MIN_LOOK_PITCH,
          MAX_LOOK_PITCH
        );
      } else {
        this.targetAzimuth -= dx * scale * 3.1;
        this.targetElevation = clamp(
          this.targetElevation + dy * scale * 2.4,
          MIN_ELEVATION,
          MAX_ELEVATION
        );
      }
      this._markUserInteraction();
    };

    this._onPointerUp = (e) => {
      this._pointers.delete(e.pointerId);
      try {
        this.canvas?.releasePointerCapture?.(e.pointerId);
      } catch {
        // Ignore if capture was already released
      }
      if (this._pointers.size === 0) {
        this._dragMode = null;
        this._pinchPrevDist = null;
      } else if (this._pointers.size === 1) {
        this._dragMode = 'orbit';
        this._pinchPrevDist = null;
      }
    };

    this._onWheel = (e) => {
      e.preventDefault();
      const modeScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
      const delta = clamp(e.deltaY * modeScale, -240, 240);
      const speed = 0.0022 * (2.5 + Math.abs(this.targetL));
      const sign = this._forwardMoveSign();
      // Scroll up (delta < 0) moves forward in facing direction; scroll down (delta > 0) pulls back
      this.targetL = clamp(this.targetL + (-sign) * delta * speed, MIN_L, MAX_L);
      this._markUserInteraction();
    };

    this._onDblClick = (e) => {
      e.preventDefault();
      if (this.onResetRequest) {
        this.onResetRequest();
      }
    };

    this._onKeyDown = (e) => {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableElement(activeEl)) return;
      const code = e.code;
      if (
        code === 'KeyW' ||
        code === 'KeyA' ||
        code === 'KeyS' ||
        code === 'KeyD' ||
        code === 'KeyQ' ||
        code === 'KeyE' ||
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight'
      ) {
        this._keys.add(code);
        this._markUserInteraction();
      }
    };

    this._onKeyUp = (e) => {
      this._keys.delete(e.code);
    };

    this._onBlur = () => {
      this._keys.clear();
      this._pointers.clear();
      this._dragMode = null;
      this._pinchPrevDist = null;
    };

    if (!this._windowBound && typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      this._windowBound = true;
    }

    if (this.canvas) {
      this._bindCanvasEvents(this.canvas);
    }
  }

  _bindCanvasEvents(targetCanvas) {
    if (!targetCanvas || this._canvasBoundTo === targetCanvas) return;
    targetCanvas.addEventListener('contextmenu', this._onContextMenu);
    targetCanvas.addEventListener('auxclick', this._onAuxClick);
    targetCanvas.addEventListener('pointerdown', this._onPointerDown);
    targetCanvas.addEventListener('wheel', this._onWheel, { passive: false });
    targetCanvas.addEventListener('dblclick', this._onDblClick);
    this._canvasBoundTo = targetCanvas;
  }

  _unbindCanvasEvents(targetCanvas) {
    if (!targetCanvas || this._canvasBoundTo !== targetCanvas) return;
    targetCanvas.removeEventListener('contextmenu', this._onContextMenu);
    targetCanvas.removeEventListener('auxclick', this._onAuxClick);
    targetCanvas.removeEventListener('pointerdown', this._onPointerDown);
    targetCanvas.removeEventListener('wheel', this._onWheel);
    targetCanvas.removeEventListener('dblclick', this._onDblClick);
    this._canvasBoundTo = null;
  }

  /**
   * Rebinds pointer/wheel/dblclick listeners when swapping the underlying <canvas>
   * element across rendering backends while preserving camera pose and springs.
   */
  setCanvas(newCanvas) {
    if (this.canvas && this.canvas !== newCanvas) {
      this._unbindCanvasEvents(this.canvas);
    }
    this._pointers.clear();
    this._dragMode = null;
    this._pinchPrevDist = null;
    this.canvas = newCanvas || null;
    if (this.canvas) {
      this._bindCanvasEvents(this.canvas);
    }
    this._moved = true;
  }

  _getPinchDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return null;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /**
   * Advance camera springs, preset/traversal flights, keyboard navigation, and gentle auto-orbit.
   */
  update(dt, { paused = false, autoOrbit = true } = {}) {
    const clampedDt = clamp(dt, 0, 0.05);

    // 1. Continuous keyboard navigation
    if (this._keys.size > 0) {
      const orbitRate = 0.85 * clampedDt;
      const elevRate = 0.65 * clampedDt;
      const moveRate = (3.4 + 0.55 * Math.abs(this.targetL)) * clampedDt;
      const rollRate = 0.75 * clampedDt;
      const sign = this._forwardMoveSign();

      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) {
        this.targetAzimuth -= orbitRate;
      }
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) {
        this.targetAzimuth += orbitRate;
      }
      if (this._keys.has('ArrowUp')) {
        this.targetElevation = clamp(this.targetElevation + elevRate, MIN_ELEVATION, MAX_ELEVATION);
      }
      if (this._keys.has('ArrowDown')) {
        this.targetElevation = clamp(this.targetElevation - elevRate, MIN_ELEVATION, MAX_ELEVATION);
      }
      if (this._keys.has('KeyW')) {
        this.targetL = clamp(this.targetL + sign * moveRate, MIN_L, MAX_L);
      }
      if (this._keys.has('KeyS')) {
        this.targetL = clamp(this.targetL - sign * moveRate, MIN_L, MAX_L);
      }
      if (this._keys.has('KeyQ')) {
        this.targetRoll = clamp(this.targetRoll - rollRate, MIN_ROLL, MAX_ROLL);
      }
      if (this._keys.has('KeyE')) {
        this.targetRoll = clamp(this.targetRoll + rollRate, MIN_ROLL, MAX_ROLL);
      }
      this._interactionCooldown = INTERACTION_COOLDOWN;
      this._autoBaseElevation = this.targetElevation;
    }

    // 2. Smooth cubic preset transition / through-throat traversal
    if (this._flight) {
      const f = this._flight;
      f.elapsed += clampedDt;
      const t = clamp(f.elapsed / f.duration, 0, 1);
      const e = f.easeMode === 'inOutCubic' ? easeInOutCubic(t) : easeOutCubic(t);

      this.l = f.startL + (f.endL - f.startL) * e;
      this.elevation = f.startElevation + (f.endElevation - f.startElevation) * e;
      this.azimuth = f.startAzimuth + (f.endAzimuth - f.startAzimuth) * e;
      this.lookYaw = f.startLookYaw + (f.endLookYaw - f.startLookYaw) * e;
      this.lookPitch = f.startLookPitch + (f.endLookPitch - f.startLookPitch) * e;
      this.roll = f.startRoll + (f.endRoll - f.startRoll) * e;
      this.fov = f.startFov + (f.endFov - f.startFov) * e;

      this.targetL = this.l;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;

      if (t >= 1) {
        this._autoBaseElevation = this.elevation;
        this._autoOrbitTime = 0;
        this._flight = null;
      }
    } else {
      // 3. Gentle auto-orbit (yields to user interaction and halts when paused)
      const interacting = this._pointers.size > 0 || this._keys.size > 0;
      if (this._interactionCooldown > 0 && !interacting) {
        this._interactionCooldown = Math.max(0, this._interactionCooldown - clampedDt);
      }

      if (autoOrbit && !paused && !interacting && this._interactionCooldown <= 0) {
        this._autoOrbitTime += clampedDt;
        const ramp = clamp(this._autoOrbitTime / 1.5, 0, 1);
        this.targetAzimuth += AUTO_ORBIT_SPEED * ramp * clampedDt;
        this.targetElevation = clamp(
          this._autoBaseElevation + Math.sin(this._autoOrbitTime * AUTO_BREATH_FREQ) * AUTO_BREATH_AMP * ramp,
          MIN_ELEVATION,
          MAX_ELEVATION
        );
      }

      // 4. Critically-damped spring integration
      if (clampedDt > 0) {
        [this.l, this.velL] = stepCriticallyDamped(
          this.l,
          this.velL,
          this.targetL,
          SPRING_OMEGA,
          clampedDt
        );
        [this.elevation, this.velElevation] = stepCriticallyDamped(
          this.elevation,
          this.velElevation,
          this.targetElevation,
          SPRING_OMEGA,
          clampedDt
        );
        [this.azimuth, this.velAzimuth] = stepCriticallyDamped(
          this.azimuth,
          this.velAzimuth,
          this.targetAzimuth,
          SPRING_OMEGA,
          clampedDt
        );
        [this.lookYaw, this.velLookYaw] = stepCriticallyDamped(
          this.lookYaw,
          this.velLookYaw,
          this.targetLookYaw,
          SPRING_OMEGA,
          clampedDt
        );
        [this.lookPitch, this.velLookPitch] = stepCriticallyDamped(
          this.lookPitch,
          this.velLookPitch,
          this.targetLookPitch,
          SPRING_OMEGA,
          clampedDt
        );
        [this.roll, this.velRoll] = stepCriticallyDamped(
          this.roll,
          this.velRoll,
          this.targetRoll,
          SPRING_OMEGA,
          clampedDt
        );
        [this.fov, this.velFov] = stepCriticallyDamped(
          this.fov,
          this.velFov,
          this.targetFov,
          SPRING_OMEGA,
          clampedDt
        );
      }
    }

    this._recomputeBasis();
  }

  _recomputeBasis() {
    const cosEl = Math.cos(this.elevation);
    const sinEl = Math.sin(this.elevation);
    const cosAz = Math.cos(this.azimuth);
    const sinAz = Math.sin(this.azimuth);

    // Observer unit angular position n0 on S^2 (independent of sign(l) for zero-flip l=0 crossing)
    const nx = cosEl * sinAz;
    const ny = sinEl;
    const nz = cosEl * cosAz;
    this._n0[0] = nx;
    this._n0[1] = ny;
    this._n0[2] = nz;

    // Base forward f0 = -n0 (looking in the -l direction: into the throat from Universe A)
    const f0x = -nx;
    const f0y = -ny;
    const f0z = -nz;

    // Base horizon right r0 = normalize(cross(f0, worldUp=(0,1,0))) = normalize(-f0z, 0, f0x)
    let r0x = -f0z;
    let r0y = 0.0;
    let r0z = f0x;
    const r0Len = Math.hypot(r0x, r0z);
    if (r0Len < 1e-6) {
      r0x = cosAz;
      r0z = -sinAz;
    } else {
      r0x /= r0Len;
      r0z /= r0Len;
    }

    // Base horizon up u0 = normalize(cross(r0, f0))
    let u0x = r0y * f0z - r0z * f0y;
    let u0y = r0z * f0x - r0x * f0z;
    let u0z = r0x * f0y - r0y * f0x;
    const u0Len = Math.hypot(u0x, u0y, u0z) || 1.0;
    u0x /= u0Len;
    u0y /= u0Len;
    u0z /= u0Len;

    // Apply local lookYaw around u0 (lookYaw = 180 deg points along +n0 into throat from Universe B)
    const cosY = Math.cos(this.lookYaw);
    const sinY = Math.sin(this.lookYaw);
    const fYx = cosY * f0x + sinY * r0x;
    const fYy = cosY * f0y + sinY * r0y;
    const fYz = cosY * f0z + sinY * r0z;

    const rYx = cosY * r0x - sinY * f0x;
    const rYy = cosY * r0y - sinY * f0y;
    const rYz = cosY * r0z - sinY * f0z;

    // Apply local lookPitch around rYaw
    const cosP = Math.cos(this.lookPitch);
    const sinP = Math.sin(this.lookPitch);
    const fx = cosP * fYx + sinP * u0x;
    const fy = cosP * fYy + sinP * u0y;
    const fz = cosP * fYz + sinP * u0z;

    const uPx = -sinP * fYx + cosP * u0x;
    const uPy = -sinP * fYy + cosP * u0y;
    const uPz = -sinP * fYz + cosP * u0z;

    // Apply Dutch roll around final forward axis
    const cosR = Math.cos(this.roll);
    const sinR = Math.sin(this.roll);

    const rx = cosR * rYx + sinR * uPx;
    const ry = cosR * rYy + sinR * uPy;
    const rz = cosR * rYz + sinR * uPz;

    const ux = -sinR * rYx + cosR * uPx;
    const uy = -sinR * rYy + cosR * uPy;
    const uz = -sinR * rYz + cosR * uPz;

    // Column-major mat3: col0 = right, col1 = up, col2 = forward
    const b = this._basis;
    b[0] = rx;
    b[1] = ry;
    b[2] = rz;
    b[3] = ux;
    b[4] = uy;
    b[5] = uz;
    b[6] = fx;
    b[7] = fy;
    b[8] = fz;

    const sig = [this.l, nx, ny, nz, rx, ry, rz, ux, uy, uz, fx, fy, fz, this.fov];
    if (!this._prevSignature) {
      this._moved = true;
      this._prevSignature = sig;
    } else {
      let maxDiff = 0;
      for (let i = 0; i < sig.length; i++) {
        const d = Math.abs(sig[i] - this._prevSignature[i]);
        if (d > maxDiff) maxDiff = d;
      }
      this._moved = maxDiff > 1e-6;
      if (this._moved) {
        this._prevSignature = sig;
      }
    }
  }

  getCameraMatrices() {
    return {
      l: this.l,
      n0: [this._n0[0], this._n0[1], this._n0[2]],
      basis: this._basis,
      fovY: this.fov,
      moved: this._moved,
    };
  }

  getWormholeTelemetry(state) {
    return computeWormholeTelemetry(state, this.l);
  }

  dispose() {
    if (this.canvas) {
      this._unbindCanvasEvents(this.canvas);
    }
    if (this._windowBound && typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      this._windowBound = false;
    }
  }
}
