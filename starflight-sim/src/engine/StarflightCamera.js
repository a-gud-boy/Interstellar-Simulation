/**
 * StarflightCamera.js — Panoramic bridge observatory camera controller for the
 * Relativistic Starflight Simulator:
 *  - Fixed at ship bridge origin [0, 0, 0], looking forward along +Z (0 deg) or
 *    aft along -Z (180 deg) across full 360 deg yaw, pitch in [-85, 85] deg,
 *    roll in [-90, 90] deg, and deep-cone telephoto zoom fov in [8, 95] deg.
 *  - Pole-free, division-free right-handed orthonormal basis where
 *    cross(right, forward) === up strictly at all angles.
 *  - Critically-damped springs, cubic ease-out preset flights, smooth Forward <-> Aft
 *    flip, mouse/wheel/touch/keyboard navigation, and double-click reset.
 */

const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

const MIN_LOOK_PITCH = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH = 85.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 8.0 * DEG2RAD;
const MAX_FOV = 95.0 * DEG2RAD;

const SPRING_OMEGA = 13.5;
const AUTO_PAN_YAW_AMP = 18.0 * DEG2RAD;
const AUTO_PAN_PITCH_AMP = 5.0 * DEG2RAD;
const AUTO_PAN_YAW_FREQ = 0.24;
const AUTO_PAN_PITCH_FREQ = 0.37;
const INTERACTION_COOLDOWN = 2.4;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function wrapAngleDelta(delta) {
  let d = (delta + Math.PI) % (2.0 * Math.PI);
  if (d < 0.0) d += 2.0 * Math.PI;
  return d - Math.PI;
}

function easeOutCubic(t) {
  const u = 1.0 - clamp(t, 0.0, 1.0);
  return 1.0 - u * u * u;
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
 * Applies local lookYaw, lookPitch, and roll around initial bridge triad
 * r0 = [-1, 0, 0], u0 = [0, 1, 0], f0 = [0, 0, 1],
 * preserving exact right-handedness cross(right, forward) === up without divisions.
 */
function applyLocalLook(lookYaw, lookPitch, roll) {
  const r0 = [-1.0, 0.0, 0.0];
  const u0 = [0.0, 1.0, 0.0];
  const f0 = [0.0, 0.0, 1.0];

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

function normalizeCamPatch(cam = {}) {
  const src = cam && typeof cam.camera === 'object' && cam.camera !== null ? cam.camera : cam;
  return src && typeof src === 'object' ? src : {};
}

export class StarflightCamera {
  /**
   * @param {HTMLCanvasElement | null} canvas
   * @param {object} [initialCam]
   * @param {{ onResetRequest?: () => void, onUserInteract?: () => void }} [callbacks]
   */
  constructor(canvas, initialCam = {}, callbacks = {}) {
    this.canvas = canvas || null;
    this.onResetRequest = callbacks.onResetRequest || null;
    this.onUserInteract = callbacks.onUserInteract || null;

    const init = normalizeCamPatch(initialCam);
    this._initialCam = {
      lookYawDeg: Number.isFinite(Number(init.lookYawDeg)) ? Number(init.lookYawDeg) : 0.0,
      lookPitchDeg: clamp(
        Number.isFinite(Number(init.lookPitchDeg)) ? Number(init.lookPitchDeg) : 2.0,
        -85.0,
        85.0
      ),
      rollDeg: clamp(
        Number.isFinite(Number(init.rollDeg)) ? Number(init.rollDeg) : 0.0,
        -90.0,
        90.0
      ),
      fovDeg: clamp(
        Number.isFinite(Number(init.fovDeg)) ? Number(init.fovDeg) : 56.0,
        8.0,
        95.0
      ),
    };

    const yaw0 = this._initialCam.lookYawDeg * DEG2RAD;
    const pitch0 = clamp(this._initialCam.lookPitchDeg * DEG2RAD, MIN_LOOK_PITCH, MAX_LOOK_PITCH);
    const roll0 = clamp(this._initialCam.rollDeg * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp(this._initialCam.fovDeg * DEG2RAD, MIN_FOV, MAX_FOV);

    this.lookYaw = yaw0;
    this.lookPitch = pitch0;
    this.roll = roll0;
    this.fov = fov0;

    this.targetLookYaw = yaw0;
    this.targetLookPitch = pitch0;
    this.targetRoll = roll0;
    this.targetFov = fov0;

    this.velLookYaw = 0.0;
    this.velLookPitch = 0.0;
    this.velRoll = 0.0;
    this.velFov = 0.0;

    this._flight = null;
    this._autoPanTime = 0.0;
    this._autoBaseYaw = yaw0;
    this._autoBasePitch = pitch0;
    this._interactionCooldown = 0.0;

    this._pos = [0.0, 0.0, 0.0];
    this._right = [-1.0, 0.0, 0.0];
    this._up = [0.0, 1.0, 0.0];
    this._forward = [0.0, 0.0, 1.0];
    this._basis = new Float32Array(9);
    this._moved = true;
    this._prevSignature = null;

    this._pointers = new Map();
    this._pinchPrevDist = null;
    this._dragMode = null;
    this._keys = new Set();
    this._windowBound = false;
    this._canvasBoundTo = null;
    this._handlersReady = false;

    this._recomputeBasis();
    this.attachEvents(this.canvas);
  }

  getState() {
    return {
      pos: [0.0, 0.0, 0.0],
      lookYawDeg: this.lookYaw * RAD2DEG,
      lookPitchDeg: this.lookPitch * RAD2DEG,
      rollDeg: this.roll * RAD2DEG,
      fovDeg: this.fov * RAD2DEG,
    };
  }

  setState(patch = {}) {
    this.flyTo(patch, 0);
    return this.getState();
  }

  setImmediate(patch = {}) {
    return this.setState(patch);
  }

  applyPreset(cam = {}, duration = 1.0) {
    const patch = normalizeCamPatch(cam);
    this.flyTo(patch, duration);
  }

  reset(durationOrCam = 0.9) {
    if (typeof durationOrCam === 'object' && durationOrCam !== null) {
      this.flyTo(normalizeCamPatch(durationOrCam), 0);
      return this.getState();
    }
    const dur = Number.isFinite(Number(durationOrCam)) ? Number(durationOrCam) : 0.9;
    this.flyTo(this._initialCam, dur);
    return this.getState();
  }

  flyTo(camPatch = {}, duration = 1.0) {
    const patch = normalizeCamPatch(camPatch);

    const hasYaw = patch.lookYawDeg !== undefined && Number.isFinite(Number(patch.lookYawDeg));
    const destYawRaw = hasYaw ? Number(patch.lookYawDeg) * DEG2RAD : this.lookYaw;
    let deltaYaw = hasYaw ? wrapAngleDelta(destYawRaw - this.lookYaw) : 0.0;
    // Keep explicit +180 deg targets positive when turning from near 0
    if (hasYaw && Math.abs(Math.abs(deltaYaw) - Math.PI) < 1e-6) {
      deltaYaw = destYawRaw >= this.lookYaw ? Math.PI : -Math.PI;
    }
    const destYaw = hasYaw ? this.lookYaw + deltaYaw : this.lookYaw;

    const destPitch = clamp(
      (patch.lookPitchDeg !== undefined ? Number(patch.lookPitchDeg) : this.lookPitch * RAD2DEG) *
        DEG2RAD,
      MIN_LOOK_PITCH,
      MAX_LOOK_PITCH
    );
    const destRoll = clamp(
      (patch.rollDeg !== undefined ? Number(patch.rollDeg) : this.roll * RAD2DEG) * DEG2RAD,
      MIN_ROLL,
      MAX_ROLL
    );
    const destFov = clamp(
      (patch.fovDeg !== undefined ? Number(patch.fovDeg) : this.fov * RAD2DEG) * DEG2RAD,
      MIN_FOV,
      MAX_FOV
    );

    if (!duration || duration <= 0.0) {
      this._flight = null;
      const immediateYaw = hasYaw ? destYawRaw : this.lookYaw;
      this.lookYaw = this.targetLookYaw = immediateYaw;
      this.lookPitch = this.targetLookPitch = destPitch;
      this.roll = this.targetRoll = destRoll;
      this.fov = this.targetFov = destFov;

      this.velLookYaw = 0.0;
      this.velLookPitch = 0.0;
      this.velRoll = 0.0;
      this.velFov = 0.0;

      this._autoBaseYaw = immediateYaw;
      this._autoBasePitch = destPitch;
      this._autoPanTime = 0.0;
      this._interactionCooldown = 0.0;
      this._recomputeBasis();
      this._moved = true;
    } else {
      this._flight = {
        elapsed: 0.0,
        duration,
        startLookYaw: this.lookYaw,
        startLookPitch: this.lookPitch,
        startRoll: this.roll,
        startFov: this.fov,
        endLookYaw: destYaw,
        endLookPitch: destPitch,
        endRoll: destRoll,
        endFov: destFov,
      };
      this.velLookYaw = 0.0;
      this.velLookPitch = 0.0;
      this.velRoll = 0.0;
      this.velFov = 0.0;
      this._interactionCooldown = 0.0;
    }
  }

  /**
   * Smoothly rotates lookYawDeg by 180 deg when near Forward (0 deg) or Aft (180 deg),
   * or toggles cleanly to Aft (180 deg) vs Forward (0 deg) from side windows.
   * @param {number} [duration=0.9]
   */
  flipAftForward(duration = 0.9) {
    const baseYaw = this._flight ? this._flight.endLookYaw : this.lookYaw;
    const wrapped = wrapAngleDelta(baseYaw);
    const absYaw = Math.abs(wrapped);
    const nearForward = absYaw <= 30.0 * DEG2RAD;
    const nearAft = Math.abs(absYaw - Math.PI) <= 30.0 * DEG2RAD;

    let destYaw;
    if (nearForward) {
      destYaw = baseYaw + (baseYaw <= Math.PI * 0.5 ? Math.PI : -Math.PI);
    } else if (nearAft) {
      destYaw = baseYaw + (baseYaw >= 0.0 ? -Math.PI : Math.PI);
    } else {
      const targetWrapped = absYaw <= Math.PI * 0.5 ? Math.PI : 0.0;
      destYaw = baseYaw + wrapAngleDelta(targetWrapped - wrapped);
    }

    if (!duration || duration <= 0.0) {
      this._flight = null;
      this.lookYaw = this.targetLookYaw = destYaw;
      this.velLookYaw = 0.0;
      this._autoBaseYaw = destYaw;
      this._autoPanTime = 0.0;
      this._interactionCooldown = 0.0;
      this._recomputeBasis();
      this._moved = true;
    } else {
      this._flight = {
        elapsed: 0.0,
        duration,
        startLookYaw: this.lookYaw,
        startLookPitch: this.lookPitch,
        startRoll: this.roll,
        startFov: this.fov,
        endLookYaw: destYaw,
        endLookPitch: this.targetLookPitch,
        endRoll: this.targetRoll,
        endFov: this.targetFov,
      };
      this.velLookYaw = 0.0;
      this.velLookPitch = 0.0;
      this.velRoll = 0.0;
      this.velFov = 0.0;
      this._interactionCooldown = 0.0;
    }

    return this.getState();
  }

  _cancelFlight() {
    if (this._flight) {
      this._flight = null;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
    }
  }

  _markUserInteraction() {
    this._cancelFlight();
    this._interactionCooldown = INTERACTION_COOLDOWN;
    this._autoBaseYaw = this.targetLookYaw;
    this._autoBasePitch = this.targetLookPitch;
    this._autoPanTime = 0.0;
    if (this.onUserInteract) {
      this.onUserInteract();
    }
  }

  _ensureHandlers() {
    if (this._handlersReady) return;
    this._handlersReady = true;

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
        this._dragMode = e.button === 2 ? 'roll' : 'look';
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
          this.targetFov = clamp(this.targetFov * ratio, MIN_FOV, MAX_FOV);
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
      } else {
        const fovGain = clamp(this.fov / (55.0 * DEG2RAD), 0.25, 1.4);
        this.targetLookYaw += dx * scale * 2.4 * fovGain;
        this.targetLookPitch = clamp(
          this.targetLookPitch - dy * scale * 2.1 * fovGain,
          MIN_LOOK_PITCH,
          MAX_LOOK_PITCH
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
        this._dragMode = 'look';
        this._pinchPrevDist = null;
      }
    };

    this._onWheel = (e) => {
      e.preventDefault();
      const modeScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
      const delta = clamp(e.deltaY * modeScale, -240, 240);
      const factor = Math.exp(delta * 0.00115);
      this.targetFov = clamp(this.targetFov * factor, MIN_FOV, MAX_FOV);
      this._markUserInteraction();
    };

    this._onDblClick = (e) => {
      e.preventDefault();
      if (this.onResetRequest) {
        this.onResetRequest();
      } else {
        this.reset(0.9);
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

  attachEvents(targetCanvas = this.canvas) {
    this._ensureHandlers();

    if (!this._windowBound && typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      this._windowBound = true;
    }

    if (targetCanvas) {
      if (this._canvasBoundTo && this._canvasBoundTo !== targetCanvas) {
        this._unbindCanvasEvents(this._canvasBoundTo);
      }
      this.canvas = targetCanvas;
      this._bindCanvasEvents(targetCanvas);
    }
  }

  detachEvents() {
    if (this._canvasBoundTo) {
      this._unbindCanvasEvents(this._canvasBoundTo);
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
    this._keys.clear();
    this._pointers.clear();
    this._dragMode = null;
    this._pinchPrevDist = null;
  }

  setCanvas(newCanvas) {
    if (this._canvasBoundTo && this._canvasBoundTo !== newCanvas) {
      this._unbindCanvasEvents(this._canvasBoundTo);
    }
    this._pointers.clear();
    this._dragMode = null;
    this._pinchPrevDist = null;
    this.canvas = newCanvas || null;
    if (this.canvas) {
      this.attachEvents(this.canvas);
    }
    this._moved = true;
  }

  _getPinchDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return null;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  hasMotion() {
    if (this._moved || this._flight !== null || this._pointers.size > 0 || this._keys.size > 0) {
      return true;
    }
    const maxVel = Math.max(
      Math.abs(this.velLookYaw),
      Math.abs(this.velLookPitch),
      Math.abs(this.velRoll),
      Math.abs(this.velFov)
    );
    return maxVel > 1e-5;
  }

  /**
   * Advances critically-damped springs, preset flights, and optional panoramic auto-pan.
   * Accepts `update(dt, autoPan)` or `update(dt, { paused, autoOrbit, autoPan })`.
   */
  update(dt, autoPanOrOpts = false) {
    const clampedDt = clamp(Number.isFinite(dt) ? dt : 0.0, 0.0, 0.05);
    let autoPan = false;
    let paused = false;
    if (typeof autoPanOrOpts === 'object' && autoPanOrOpts !== null) {
      paused = Boolean(autoPanOrOpts.paused);
      if (autoPanOrOpts.autoPan !== undefined) {
        autoPan = Boolean(autoPanOrOpts.autoPan);
      } else if (autoPanOrOpts.autoOrbit !== undefined) {
        autoPan = Boolean(autoPanOrOpts.autoOrbit);
      }
    } else if (typeof autoPanOrOpts === 'boolean') {
      autoPan = autoPanOrOpts;
    }

    if (this._keys.size > 0) {
      const fovGain = clamp(this.fov / (55.0 * DEG2RAD), 0.25, 1.4);
      const lookRate = 1.05 * fovGain * clampedDt;
      const rollRate = 0.75 * clampedDt;
      const zoomFactor = Math.exp(0.75 * clampedDt);

      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) {
        this.targetLookYaw -= lookRate;
      }
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) {
        this.targetLookYaw += lookRate;
      }
      if (this._keys.has('ArrowUp')) {
        this.targetLookPitch = clamp(this.targetLookPitch + lookRate, MIN_LOOK_PITCH, MAX_LOOK_PITCH);
      }
      if (this._keys.has('ArrowDown')) {
        this.targetLookPitch = clamp(this.targetLookPitch - lookRate, MIN_LOOK_PITCH, MAX_LOOK_PITCH);
      }
      if (this._keys.has('KeyW')) {
        this.targetFov = clamp(this.targetFov / zoomFactor, MIN_FOV, MAX_FOV);
      }
      if (this._keys.has('KeyS')) {
        this.targetFov = clamp(this.targetFov * zoomFactor, MIN_FOV, MAX_FOV);
      }
      if (this._keys.has('KeyQ')) {
        this.targetRoll = clamp(this.targetRoll - rollRate, MIN_ROLL, MAX_ROLL);
      }
      if (this._keys.has('KeyE')) {
        this.targetRoll = clamp(this.targetRoll + rollRate, MIN_ROLL, MAX_ROLL);
      }

      this._interactionCooldown = INTERACTION_COOLDOWN;
      this._autoBaseYaw = this.targetLookYaw;
      this._autoBasePitch = this.targetLookPitch;
    }

    if (this._flight) {
      const f = this._flight;
      f.elapsed += clampedDt;
      const t = clamp(f.elapsed / f.duration, 0.0, 1.0);
      const e = easeOutCubic(t);

      this.lookYaw = f.startLookYaw + (f.endLookYaw - f.startLookYaw) * e;
      this.lookPitch = clamp(
        f.startLookPitch + (f.endLookPitch - f.startLookPitch) * e,
        MIN_LOOK_PITCH,
        MAX_LOOK_PITCH
      );
      this.roll = clamp(f.startRoll + (f.endRoll - f.startRoll) * e, MIN_ROLL, MAX_ROLL);
      this.fov = clamp(f.startFov + (f.endFov - f.startFov) * e, MIN_FOV, MAX_FOV);

      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;

      if (t >= 1.0) {
        this._autoBaseYaw = this.lookYaw;
        this._autoBasePitch = this.lookPitch;
        this._autoPanTime = 0.0;
        this._flight = null;
      }
    } else {
      const interacting = this._pointers.size > 0 || this._keys.size > 0;
      if (this._interactionCooldown > 0.0 && !interacting) {
        this._interactionCooldown = Math.max(0.0, this._interactionCooldown - clampedDt);
      }

      if (autoPan && !paused && !interacting && this._interactionCooldown <= 0.0) {
        this._autoPanTime += clampedDt;
        const ramp = clamp(this._autoPanTime / 1.5, 0.0, 1.0);
        this.targetLookYaw =
          this._autoBaseYaw + Math.sin(this._autoPanTime * AUTO_PAN_YAW_FREQ) * AUTO_PAN_YAW_AMP * ramp;
        this.targetLookPitch = clamp(
          this._autoBasePitch +
            Math.sin(this._autoPanTime * AUTO_PAN_PITCH_FREQ) * AUTO_PAN_PITCH_AMP * ramp,
          MIN_LOOK_PITCH,
          MAX_LOOK_PITCH
        );
      }

      if (clampedDt > 0.0) {
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
        this.lookPitch = clamp(this.lookPitch, MIN_LOOK_PITCH, MAX_LOOK_PITCH);

        [this.roll, this.velRoll] = stepCriticallyDamped(
          this.roll,
          this.velRoll,
          this.targetRoll,
          SPRING_OMEGA,
          clampedDt
        );
        this.roll = clamp(this.roll, MIN_ROLL, MAX_ROLL);

        [this.fov, this.velFov] = stepCriticallyDamped(
          this.fov,
          this.velFov,
          this.targetFov,
          SPRING_OMEGA,
          clampedDt
        );
        this.fov = clamp(this.fov, MIN_FOV, MAX_FOV);
      }
    }

    this._recomputeBasis();
  }

  _recomputeBasis() {
    const pose = applyLocalLook(this.lookYaw, this.lookPitch, this.roll);

    this._pos[0] = 0.0;
    this._pos[1] = 0.0;
    this._pos[2] = 0.0;

    this._right[0] = pose.right[0];
    this._right[1] = pose.right[1];
    this._right[2] = pose.right[2];

    this._up[0] = pose.up[0];
    this._up[1] = pose.up[1];
    this._up[2] = pose.up[2];

    this._forward[0] = pose.forward[0];
    this._forward[1] = pose.forward[1];
    this._forward[2] = pose.forward[2];

    const b = this._basis;
    b[0] = pose.right[0];
    b[1] = pose.right[1];
    b[2] = pose.right[2];
    b[3] = pose.up[0];
    b[4] = pose.up[1];
    b[5] = pose.up[2];
    b[6] = pose.forward[0];
    b[7] = pose.forward[1];
    b[8] = pose.forward[2];

    const sig = [
      this._right[0], this._right[1], this._right[2],
      this._up[0], this._up[1], this._up[2],
      this._forward[0], this._forward[1], this._forward[2],
      this.fov,
    ];
    if (!this._prevSignature) {
      this._moved = true;
      this._prevSignature = sig;
    } else {
      let maxDiff = 0.0;
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

  getMatrices() {
    return {
      pos: [0.0, 0.0, 0.0],
      right: [this._right[0], this._right[1], this._right[2]],
      up: [this._up[0], this._up[1], this._up[2]],
      forward: [this._forward[0], this._forward[1], this._forward[2]],
      basis: this._basis,
      fovY: this.fov,
      moved: this._moved,
    };
  }

  getCameraMatrices() {
    return this.getMatrices();
  }

  dispose() {
    this.detachEvents();
  }
}
