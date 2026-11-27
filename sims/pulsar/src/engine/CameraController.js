/**
 * PulsarCamera.js — Crust-safe spherical orbital + local-look camera controller
 * for the Magnetar & Millisecond Pulsar Simulator:
 *  - Safe inner distance clamp distance >= 2.2 R_* (max 36.0 R_*) keeping the camera
 *    cleanly outside the neutron star crust and spanning magnetosphere to PWN scales.
 *  - Pole-free, division-free right-handed orthonormal basis where cross(right, forward) === up
 *    strictly across all azimuths, elevations, rolls, and look offsets.
 *  - Critically-damped springs, cubic ease-out preset flights, mouse/wheel/touch/keyboard
 *    (arrows/WASD/QE) navigation, and double-click reset.
 */

import {
  DEG2RAD,
  RAD2DEG,
  clamp,
  wrapAngleDelta,
  easeOutCubic,
  stepCriticallyDamped,
  isEditableElement,
  applyLocalLookTriad as applyLocalLook,
} from '../../../../shared/engine/BaseCamera.js';

const MIN_DISTANCE = 2.2;
const MAX_DISTANCE = 36.0;
const MAX_PIVOT_RADIUS = 0.5;
const MIN_ELEVATION = -85.0 * DEG2RAD;
const MAX_ELEVATION = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH = 85.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 22.0 * DEG2RAD;
const MAX_FOV = 85.0 * DEG2RAD;

const SPRING_OMEGA = 13.5;
const AUTO_ORBIT_SPEED = 0.042;
const AUTO_BREATH_AMP = 0.010;
const AUTO_BREATH_FREQ = 0.20;
const INTERACTION_COOLDOWN = 2.4;

function clampPivot(p) {
  if (!Array.isArray(p) || p.length < 3) return [0.0, 0.0, 0.0];
  const x = Number.isFinite(Number(p[0])) ? Number(p[0]) : 0.0;
  const y = Number.isFinite(Number(p[1])) ? Number(p[1]) : 0.0;
  const z = Number.isFinite(Number(p[2])) ? Number(p[2]) : 0.0;
  const len = Math.hypot(x, y, z);
  if (len > MAX_PIVOT_RADIUS) {
    const s = MAX_PIVOT_RADIUS / len;
    return [x * s, y * s, z * s];
  }
  return [x, y, z];
}

function normalizeCamPatch(cam = {}) {
  const src = cam && typeof cam.camera === 'object' && cam.camera !== null ? cam.camera : cam;
  return src && typeof src === 'object' ? src : {};
}

export class PulsarCamera {
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
      distance: clamp(init.distance ?? init.radius ?? 10.5, MIN_DISTANCE, MAX_DISTANCE),
      pivot: clampPivot(init.pivot),
      azimuthDeg: Number.isFinite(Number(init.azimuthDeg)) ? Number(init.azimuthDeg) : 28.0,
      elevationDeg: Number.isFinite(Number(init.elevationDeg)) ? Number(init.elevationDeg) : 18.0,
      rollDeg: Number.isFinite(Number(init.rollDeg)) ? Number(init.rollDeg) : -2.0,
      fovDeg: Number.isFinite(Number(init.fovDeg)) ? Number(init.fovDeg) : 48.0,
      lookYawDeg: Number.isFinite(Number(init.lookYawDeg)) ? Number(init.lookYawDeg) : 0.0,
      lookPitchDeg: Number.isFinite(Number(init.lookPitchDeg)) ? Number(init.lookPitchDeg) : 0.0,
    };

    const d0 = this._initialCam.distance;
    const p0 = [...this._initialCam.pivot];
    const el0 = clamp(this._initialCam.elevationDeg * DEG2RAD, MIN_ELEVATION, MAX_ELEVATION);
    const az0 = this._initialCam.azimuthDeg * DEG2RAD;
    const roll0 = clamp(this._initialCam.rollDeg * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp(this._initialCam.fovDeg * DEG2RAD, MIN_FOV, MAX_FOV);
    const yaw0 = this._initialCam.lookYawDeg * DEG2RAD;
    const pitch0 = clamp(this._initialCam.lookPitchDeg * DEG2RAD, MIN_LOOK_PITCH, MAX_LOOK_PITCH);

    this.distance = d0;
    this.pivot = [...p0];
    this.elevation = el0;
    this.azimuth = az0;
    this.roll = roll0;
    this.fov = fov0;
    this.lookYaw = yaw0;
    this.lookPitch = pitch0;

    this.targetDistance = d0;
    this.targetPivot = [...p0];
    this.targetElevation = el0;
    this.targetAzimuth = az0;
    this.targetRoll = roll0;
    this.targetFov = fov0;
    this.targetLookYaw = yaw0;
    this.targetLookPitch = pitch0;

    this.velDistance = 0;
    this.velPivot = [0, 0, 0];
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velRoll = 0;
    this.velFov = 0;
    this.velLookYaw = 0;
    this.velLookPitch = 0;

    this._flight = null;
    this._autoOrbitTime = 0;
    this._autoBaseElevation = el0;
    this._interactionCooldown = 0;

    this._pos = [0, 0, d0];
    this._right = [1, 0, 0];
    this._up = [0, 1, 0];
    this._forward = [0, 0, -1];
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

  get radius() {
    return Math.hypot(this._pos[0], this._pos[1], this._pos[2]);
  }

  getState() {
    return {
      distance: this.distance,
      radius: this.radius,
      pivot: [...this.pivot],
      pos: [...this._pos],
      azimuthDeg: this.azimuth * RAD2DEG,
      elevationDeg: this.elevation * RAD2DEG,
      rollDeg: this.roll * RAD2DEG,
      fovDeg: this.fov * RAD2DEG,
      lookYawDeg: this.lookYaw * RAD2DEG,
      lookPitchDeg: this.lookPitch * RAD2DEG,
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

  reset(durationOrCam = 0) {
    if (typeof durationOrCam === 'object' && durationOrCam !== null) {
      this.flyTo(normalizeCamPatch(durationOrCam), 0);
      return this.getState();
    }
    const dur = Number.isFinite(Number(durationOrCam)) ? Number(durationOrCam) : 0;
    this.flyTo(this._initialCam, dur);
    return this.getState();
  }

  flyTo(camPatch = {}, duration = 1.0) {
    const patch = normalizeCamPatch(camPatch);
    const destPivot = Array.isArray(patch.pivot) && patch.pivot.length >= 3
      ? clampPivot(patch.pivot)
      : [...this.pivot];
    const destDist = clamp(
      patch.distance ?? patch.radius ?? this.distance,
      MIN_DISTANCE,
      MAX_DISTANCE
    );

    const destEl = clamp(
      (patch.elevationDeg ?? this.elevation * RAD2DEG) * DEG2RAD,
      MIN_ELEVATION,
      MAX_ELEVATION
    );
    const destAzRaw = (patch.azimuthDeg ?? this.azimuth * RAD2DEG) * DEG2RAD;
    const destAz = this.azimuth + wrapAngleDelta(destAzRaw - this.azimuth);
    const destRoll = clamp(
      (patch.rollDeg ?? this.roll * RAD2DEG) * DEG2RAD,
      MIN_ROLL,
      MAX_ROLL
    );
    const destFov = clamp(
      (patch.fovDeg ?? this.fov * RAD2DEG) * DEG2RAD,
      MIN_FOV,
      MAX_FOV
    );
    const destYawRaw = (patch.lookYawDeg ?? this.lookYaw * RAD2DEG) * DEG2RAD;
    const destYaw = this.lookYaw + wrapAngleDelta(destYawRaw - this.lookYaw);
    const destPitch = clamp(
      (patch.lookPitchDeg ?? this.lookPitch * RAD2DEG) * DEG2RAD,
      MIN_LOOK_PITCH,
      MAX_LOOK_PITCH
    );

    if (!duration || duration <= 0) {
      this._flight = null;
      this.distance = this.targetDistance = destDist;
      this.pivot = [...destPivot];
      this.targetPivot = [...destPivot];
      this.elevation = this.targetElevation = destEl;
      this.azimuth = this.targetAzimuth = destAzRaw;
      this.roll = this.targetRoll = destRoll;
      this.fov = this.targetFov = destFov;
      this.lookYaw = this.targetLookYaw = destYawRaw;
      this.lookPitch = this.targetLookPitch = destPitch;

      this.velDistance = 0;
      this.velPivot = [0, 0, 0];
      this.velElevation = 0;
      this.velAzimuth = 0;
      this.velRoll = 0;
      this.velFov = 0;
      this.velLookYaw = 0;
      this.velLookPitch = 0;

      this._autoBaseElevation = destEl;
      this._autoOrbitTime = 0;
      this._interactionCooldown = 0;
      this._recomputeBasis();
      this._moved = true;
    } else {
      this._flight = {
        elapsed: 0,
        duration,
        startDistance: this.distance,
        startPivot: [...this.pivot],
        startElevation: this.elevation,
        startAzimuth: this.azimuth,
        startRoll: this.roll,
        startFov: this.fov,
        startLookYaw: this.lookYaw,
        startLookPitch: this.lookPitch,
        endDistance: destDist,
        endPivot: [...destPivot],
        endElevation: destEl,
        endAzimuth: destAz,
        endRoll: destRoll,
        endFov: destFov,
        endLookYaw: destYaw,
        endLookPitch: destPitch,
      };
      this.velDistance = 0;
      this.velPivot = [0, 0, 0];
      this.velElevation = 0;
      this.velAzimuth = 0;
      this.velRoll = 0;
      this.velFov = 0;
      this.velLookYaw = 0;
      this.velLookPitch = 0;
      this._interactionCooldown = 0;
    }
  }

  _cancelFlight() {
    if (this._flight) {
      this._flight = null;
      this.targetDistance = this.distance;
      this.targetPivot = [...this.pivot];
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
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
          this.targetDistance = clamp(
            this.targetDistance * ratio,
            MIN_DISTANCE,
            MAX_DISTANCE
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
      } else if (this._dragMode === 'look' || e.shiftKey) {
        this.targetLookYaw += dx * scale * 2.5;
        this.targetLookPitch = clamp(
          this.targetLookPitch - dy * scale * 2.1,
          MIN_LOOK_PITCH,
          MAX_LOOK_PITCH
        );
      } else {
        this.targetAzimuth += dx * scale * 3.0;
        this.targetElevation = clamp(
          this.targetElevation + dy * scale * 2.3,
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
      const factor = Math.exp(delta * 0.00115);
      this.targetDistance = clamp(this.targetDistance * factor, MIN_DISTANCE, MAX_DISTANCE);
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
      Math.abs(this.velDistance),
      Math.abs(this.velElevation),
      Math.abs(this.velAzimuth),
      Math.abs(this.velRoll),
      Math.abs(this.velFov),
      Math.abs(this.velLookYaw),
      Math.abs(this.velLookPitch),
      Math.abs(this.velPivot[0]),
      Math.abs(this.velPivot[1]),
      Math.abs(this.velPivot[2])
    );
    return maxVel > 1e-5;
  }

  update(dt, autoOrbitOrOpts = true) {
    const clampedDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
    let autoOrbit = true;
    let paused = false;
    if (typeof autoOrbitOrOpts === 'object' && autoOrbitOrOpts !== null) {
      paused = Boolean(autoOrbitOrOpts.paused);
      autoOrbit = autoOrbitOrOpts.autoOrbit !== undefined ? Boolean(autoOrbitOrOpts.autoOrbit) : true;
    } else if (typeof autoOrbitOrOpts === 'boolean') {
      autoOrbit = autoOrbitOrOpts;
    }

    if (this._keys.size > 0) {
      const orbitRate = 0.85 * clampedDt;
      const elevRate = 0.65 * clampedDt;
      const rollRate = 0.75 * clampedDt;
      const zoomFactor = Math.exp(0.75 * clampedDt);

      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) {
        this.targetAzimuth += orbitRate;
      }
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) {
        this.targetAzimuth -= orbitRate;
      }
      if (this._keys.has('ArrowUp')) {
        this.targetElevation = clamp(this.targetElevation + elevRate, MIN_ELEVATION, MAX_ELEVATION);
      }
      if (this._keys.has('ArrowDown')) {
        this.targetElevation = clamp(this.targetElevation - elevRate, MIN_ELEVATION, MAX_ELEVATION);
      }
      if (this._keys.has('KeyW')) {
        this.targetDistance = clamp(this.targetDistance / zoomFactor, MIN_DISTANCE, MAX_DISTANCE);
      }
      if (this._keys.has('KeyS')) {
        this.targetDistance = clamp(this.targetDistance * zoomFactor, MIN_DISTANCE, MAX_DISTANCE);
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

    if (this._flight) {
      const f = this._flight;
      f.elapsed += clampedDt;
      const t = clamp(f.elapsed / f.duration, 0, 1);
      const e = easeOutCubic(t);

      this.distance = clamp(
        f.startDistance + (f.endDistance - f.startDistance) * e,
        MIN_DISTANCE,
        MAX_DISTANCE
      );
      this.pivot = [
        f.startPivot[0] + (f.endPivot[0] - f.startPivot[0]) * e,
        f.startPivot[1] + (f.endPivot[1] - f.startPivot[1]) * e,
        f.startPivot[2] + (f.endPivot[2] - f.startPivot[2]) * e,
      ];
      this.elevation = f.startElevation + (f.endElevation - f.startElevation) * e;
      this.azimuth = f.startAzimuth + (f.endAzimuth - f.startAzimuth) * e;
      this.roll = f.startRoll + (f.endRoll - f.startRoll) * e;
      this.fov = f.startFov + (f.endFov - f.startFov) * e;
      this.lookYaw = f.startLookYaw + (f.endLookYaw - f.startLookYaw) * e;
      this.lookPitch = f.startLookPitch + (f.endLookPitch - f.startLookPitch) * e;

      this.targetDistance = this.distance;
      this.targetPivot = [...this.pivot];
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;

      if (t >= 1) {
        this._autoBaseElevation = this.elevation;
        this._autoOrbitTime = 0;
        this._flight = null;
      }
    } else {
      const interacting = this._pointers.size > 0 || this._keys.size > 0;
      if (this._interactionCooldown > 0 && !interacting) {
        this._interactionCooldown = Math.max(0, this._interactionCooldown - clampedDt);
      }

      if (autoOrbit && !paused && !interacting && this._interactionCooldown <= 0) {
        this._autoOrbitTime += clampedDt;
        const ramp = clamp(this._autoOrbitTime / 1.5, 0, 1);
        this.targetAzimuth += AUTO_ORBIT_SPEED * ramp * clampedDt;
        this.targetElevation = clamp(
          this._autoBaseElevation +
            Math.sin(this._autoOrbitTime * AUTO_BREATH_FREQ) * AUTO_BREATH_AMP * ramp,
          MIN_ELEVATION,
          MAX_ELEVATION
        );
      }

      if (clampedDt > 0) {
        [this.distance, this.velDistance] = stepCriticallyDamped(
          this.distance,
          this.velDistance,
          this.targetDistance,
          SPRING_OMEGA,
          clampedDt
        );
        this.distance = clamp(this.distance, MIN_DISTANCE, MAX_DISTANCE);

        for (let i = 0; i < 3; i++) {
          [this.pivot[i], this.velPivot[i]] = stepCriticallyDamped(
            this.pivot[i],
            this.velPivot[i],
            this.targetPivot[i],
            SPRING_OMEGA,
            clampedDt
          );
        }
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
      }
    }

    this._recomputeBasis();
  }

  _computePoseFrom(distance, pivot, azimuth, elevation, roll, lookYaw, lookPitch) {
    const safeDist = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
    const cosEl = Math.cos(elevation);
    const sinEl = Math.sin(elevation);
    const cosAz = Math.cos(azimuth);
    const sinAz = Math.sin(azimuth);

    // Pole-free, division-free right-handed orbital basis (cross(r0, f0) === u0)
    const f0 = [cosEl * sinAz, -sinEl, -cosEl * cosAz];
    const r0 = [cosAz, 0.0, sinAz];
    const u0 = [sinEl * sinAz, cosEl, -sinEl * cosAz];

    const pos = [
      pivot[0] - f0[0] * safeDist,
      pivot[1] - f0[1] * safeDist,
      pivot[2] - f0[2] * safeDist,
    ];

    const basis = applyLocalLook(r0, u0, f0, lookYaw, lookPitch, roll);
    return { pos, ...basis };
  }

  _recomputeBasis() {
    const pose = this._computePoseFrom(
      this.distance,
      this.pivot,
      this.azimuth,
      this.elevation,
      this.roll,
      this.lookYaw,
      this.lookPitch
    );

    this._pos[0] = pose.pos[0];
    this._pos[1] = pose.pos[1];
    this._pos[2] = pose.pos[2];

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
      this._pos[0], this._pos[1], this._pos[2],
      this._right[0], this._right[1], this._right[2],
      this._up[0], this._up[1], this._up[2],
      this._forward[0], this._forward[1], this._forward[2],
      this.fov,
    ];
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

  getMatrices() {
    return {
      pos: [this._pos[0], this._pos[1], this._pos[2]],
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

export { PulsarCamera as CameraController };
