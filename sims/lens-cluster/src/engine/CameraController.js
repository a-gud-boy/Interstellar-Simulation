/**
 * CameraController.js — Critically-damped spherical orbit camera + interactive
 * source-plane dragging hook for Gravitational Lensing Observatory (sims/lens-cluster/).
 */

import {
  DEG2RAD,
  RAD2DEG,
  clamp,
  wrapAngleDelta,
  easeOutCubic,
  stepCriticallyDamped,
  isEditableElement,
  normalizeWheelDelta,
  computeSphericalOrbitBasisInto,
  createCanvasRectCache,
} from '../../../../shared/engine/BaseCamera.js';

const MIN_RADIUS = 5.0;
const MAX_RADIUS = 36.0;
const MIN_ELEVATION = -82.0 * DEG2RAD;
const MAX_ELEVATION = 82.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 20.0 * DEG2RAD;
const MAX_FOV = 75.0 * DEG2RAD;

const SPRING_OMEGA = 13.5;
const AUTO_ORBIT_SPEED = 0.04;
const INTERACTION_COOLDOWN = 2.4;

export class LensClusterCamera {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} initialCamera
   * @param {{
   *   onResetRequest?: () => void,
   *   onUserInteract?: () => void,
   *   getDragMode?: () => number,
   *   onSourceDrag?: (dsx: number, dsy: number) => void,
   * }} [callbacks]
   */
  constructor(canvas, initialCamera = {}, callbacks = {}) {
    this.canvas = canvas;
    this.onResetRequest = callbacks.onResetRequest || null;
    this.onUserInteract = callbacks.onUserInteract || null;
    this.getDragMode = callbacks.getDragMode || null;
    this.onSourceDrag = callbacks.onSourceDrag || null;

    this._initialCam = { ...initialCamera };

    const r0 = clamp(initialCamera.radius ?? 16.5, MIN_RADIUS, MAX_RADIUS);
    const el0 = clamp((initialCamera.elevationDeg ?? 8.5) * DEG2RAD, MIN_ELEVATION, MAX_ELEVATION);
    const az0 = (initialCamera.azimuthDeg ?? -10.0) * DEG2RAD;
    const roll0 = clamp((initialCamera.rollDeg ?? -3.0) * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp((initialCamera.fovDeg ?? 42.0) * DEG2RAD, MIN_FOV, MAX_FOV);

    this.logRadius = Math.log(r0);
    this.elevation = el0;
    this.azimuth = az0;
    this.roll = roll0;
    this.fov = fov0;

    this.targetLogRadius = this.logRadius;
    this.targetElevation = el0;
    this.targetAzimuth = az0;
    this.targetRoll = roll0;
    this.targetFov = fov0;

    this.velLogRadius = 0;
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velRoll = 0;
    this.velFov = 0;

    this._flight = null;
    this._autoOrbitTime = 0;
    this._autoBaseElevation = el0;
    this._interactionCooldown = 0;

    this._pos = [0, 0, r0];
    this._basis = new Float32Array(9);
    this._moved = true;
    this._hasPrevSignature = false;
    this._prevSignature = new Float64Array(5);

    this._pointers = new Map();
    this._pinchPrevDist = null;
    this._dragMode = null; // 'orbit' | 'roll' | 'pinch' | 'source'
    this._keys = new Set();
    this._windowBound = false;
    this._canvasBoundTo = null;
    this._rectCache = createCanvasRectCache(() => this.canvas);

    this._recomputeBasis();
    this._bindEvents();
  }

  get radius() {
    return Math.exp(this.logRadius);
  }

  getState() {
    return {
      radius: this.radius,
      elevationDeg: this.elevation * RAD2DEG,
      azimuthDeg: this.azimuth * RAD2DEG,
      rollDeg: this.roll * RAD2DEG,
      fovDeg: this.fov * RAD2DEG,
    };
  }

  setState(patch = {}) {
    this.flyTo(patch, 0);
    return this.getState();
  }

  setImmediate(patch = {}) {
    this.flyTo(patch, 0);
  }

  applyPreset(camPreset = {}, duration = 1.0) {
    this.flyTo(camPreset, duration);
  }

  flyTo(camPreset = {}, duration = 1.0) {
    const destRadius = clamp(camPreset.radius ?? this.radius, MIN_RADIUS, MAX_RADIUS);
    const destLogRadius = Math.log(destRadius);
    const destEl = clamp(
      (camPreset.elevationDeg ?? this.elevation * RAD2DEG) * DEG2RAD,
      MIN_ELEVATION,
      MAX_ELEVATION
    );
    const destAzRaw = (camPreset.azimuthDeg ?? this.azimuth * RAD2DEG) * DEG2RAD;
    const destAz = this.azimuth + wrapAngleDelta(destAzRaw - this.azimuth);
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
      this.logRadius = this.targetLogRadius = destLogRadius;
      this.elevation = this.targetElevation = destEl;
      this.azimuth = this.targetAzimuth = destAzRaw;
      this.roll = this.targetRoll = destRoll;
      this.fov = this.targetFov = destFov;
      this.velLogRadius = 0;
      this.velElevation = 0;
      this.velAzimuth = 0;
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
      startLogRadius: this.logRadius,
      startElevation: this.elevation,
      startAzimuth: this.azimuth,
      startRoll: this.roll,
      startFov: this.fov,
      endLogRadius: destLogRadius,
      endElevation: destEl,
      endAzimuth: destAz,
      endRoll: destRoll,
      endFov: destFov,
    };
    this.velLogRadius = 0;
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velRoll = 0;
    this.velFov = 0;
    this._interactionCooldown = 0;
  }

  _cancelFlight() {
    if (this._flight) {
      this._flight = null;
      this.targetLogRadius = this.logRadius;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
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

  _getPinchDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  }

  _bindEvents() {
    this._onContextMenu = (e) => {
      e.preventDefault();
    };

    this._onPointerDown = (e) => {
      if (e.button !== 0 && e.button !== 2 && e.pointerType === 'mouse') return;
      this.canvas?.setPointerCapture?.(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });

      if (this._pointers.size === 1) {
        if (e.button === 2) {
          this._dragMode = 'roll';
        } else {
          const isSourceMode = Boolean(this.getDragMode?.()) || e.shiftKey;
          this._dragMode = isSourceMode ? 'source' : 'orbit';
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
          this.targetLogRadius = clamp(
            this.targetLogRadius + Math.log(ratio),
            Math.log(MIN_RADIUS),
            Math.log(MAX_RADIUS)
          );
          this._markUserInteraction();
        }
        this._pinchPrevDist = dist;
        return;
      }

      const rect = this._rectCache.getRect();
      const h = Math.max(rect.height || 720, 320);
      const scale = 1.0 / Math.max(Math.min(rect.width, h), 320);

      if (this._dragMode === 'source' && this.onSourceDrag) {
        // Map screen-space drag directly into lens-plane arcseconds aligned with camera view
        const arcsecPerPixel = (2.0 * this.radius * Math.tan(0.5 * this.fov)) / h;
        const cosR = Math.cos(this.roll);
        const sinR = Math.sin(this.roll);
        const vx = dx * arcsecPerPixel;
        const vy = -dy * arcsecPerPixel;
        const dsx = vx * cosR - vy * sinR;
        const dsy = vx * sinR + vy * cosR;
        this.onSourceDrag(dsx, dsy);
        this._markUserInteraction();
        return;
      }

      if (this._dragMode === 'roll') {
        this.targetRoll = clamp(this.targetRoll + dx * scale * 2.2, MIN_ROLL, MAX_ROLL);
      } else {
        this.targetAzimuth -= dx * scale * 2.8;
        this.targetElevation = clamp(
          this.targetElevation + dy * scale * 2.2,
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
        // Ignore if capture already released
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
      const delta = normalizeWheelDelta(e);
      this.targetLogRadius = clamp(
        this.targetLogRadius + delta * 0.0011,
        Math.log(MIN_RADIUS),
        Math.log(MAX_RADIUS)
      );
      this._markUserInteraction();
    };

    this._onDblClick = (e) => {
      e.preventDefault();
      if (this.onResetRequest) {
        this.onResetRequest();
      }
    };

    this._onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableElement(document.activeElement)) return;
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

    if (!this._windowBound) {
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      this._windowBound = true;
    }

    this._attachCanvasListeners(this.canvas);
  }

  _attachCanvasListeners(canvas) {
    if (!canvas || this._canvasBoundTo === canvas) return;
    if (this._canvasBoundTo) {
      this._canvasBoundTo.removeEventListener('contextmenu', this._onContextMenu);
      this._canvasBoundTo.removeEventListener('pointerdown', this._onPointerDown);
      this._canvasBoundTo.removeEventListener('wheel', this._onWheel);
      this._canvasBoundTo.removeEventListener('dblclick', this._onDblClick);
    }
    canvas.addEventListener('contextmenu', this._onContextMenu);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('dblclick', this._onDblClick);
    this._canvasBoundTo = canvas;
    this._rectCache.invalidate();
  }

  setCanvas(canvas) {
    this.canvas = canvas;
    this._attachCanvasListeners(canvas);
  }

  update(dt, autoOrbit = false) {
    const safeDt = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    if (safeDt <= 0) {
      return this._moved;
    }

    // Continuous keyboard navigation
    let keyMoved = false;
    const zoomRate = 0.85;
    const orbitRate = 0.95;
    const rollRate = 1.05;

    if (this._keys.has('KeyW')) {
      this.targetLogRadius = clamp(
        this.targetLogRadius - zoomRate * safeDt,
        Math.log(MIN_RADIUS),
        Math.log(MAX_RADIUS)
      );
      keyMoved = true;
    }
    if (this._keys.has('KeyS')) {
      this.targetLogRadius = clamp(
        this.targetLogRadius + zoomRate * safeDt,
        Math.log(MIN_RADIUS),
        Math.log(MAX_RADIUS)
      );
      keyMoved = true;
    }
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) {
      this.targetAzimuth -= orbitRate * safeDt;
      keyMoved = true;
    }
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) {
      this.targetAzimuth += orbitRate * safeDt;
      keyMoved = true;
    }
    if (this._keys.has('ArrowUp')) {
      this.targetElevation = clamp(
        this.targetElevation + orbitRate * 0.75 * safeDt,
        MIN_ELEVATION,
        MAX_ELEVATION
      );
      keyMoved = true;
    }
    if (this._keys.has('ArrowDown')) {
      this.targetElevation = clamp(
        this.targetElevation - orbitRate * 0.75 * safeDt,
        MIN_ELEVATION,
        MAX_ELEVATION
      );
      keyMoved = true;
    }
    if (this._keys.has('KeyQ')) {
      this.targetRoll = clamp(this.targetRoll - rollRate * safeDt, MIN_ROLL, MAX_ROLL);
      keyMoved = true;
    }
    if (this._keys.has('KeyE')) {
      this.targetRoll = clamp(this.targetRoll + rollRate * safeDt, MIN_ROLL, MAX_ROLL);
      keyMoved = true;
    }
    if (keyMoved) {
      this._interactionCooldown = INTERACTION_COOLDOWN;
    }

    if (this._flight) {
      this._flight.elapsed += safeDt;
      const u = clamp(this._flight.elapsed / Math.max(this._flight.duration, 1e-4), 0, 1);
      const e = easeOutCubic(u);
      this.logRadius = this.targetLogRadius =
        this._flight.startLogRadius + (this._flight.endLogRadius - this._flight.startLogRadius) * e;
      this.elevation = this.targetElevation =
        this._flight.startElevation + (this._flight.endElevation - this._flight.startElevation) * e;
      this.azimuth = this.targetAzimuth =
        this._flight.startAzimuth + (this._flight.endAzimuth - this._flight.startAzimuth) * e;
      this.roll = this.targetRoll =
        this._flight.startRoll + (this._flight.endRoll - this._flight.startRoll) * e;
      this.fov = this.targetFov =
        this._flight.startFov + (this._flight.endFov - this._flight.startFov) * e;
      if (u >= 1) {
        this._flight = null;
        this._autoBaseElevation = this.elevation;
        this._autoOrbitTime = 0;
      }
    } else {
      if (this._interactionCooldown > 0) {
        this._interactionCooldown = Math.max(0, this._interactionCooldown - safeDt);
      } else if (autoOrbit && this._pointers.size === 0) {
        this._autoOrbitTime += safeDt;
        this.targetAzimuth += AUTO_ORBIT_SPEED * safeDt;
        this.targetElevation = clamp(
          this._autoBaseElevation + Math.sin(this._autoOrbitTime * 0.25) * 0.012,
          MIN_ELEVATION,
          MAX_ELEVATION
        );
      }

      [this.logRadius, this.velLogRadius] = stepCriticallyDamped(
        this.logRadius,
        this.velLogRadius,
        this.targetLogRadius,
        SPRING_OMEGA,
        safeDt
      );
      [this.elevation, this.velElevation] = stepCriticallyDamped(
        this.elevation,
        this.velElevation,
        this.targetElevation,
        SPRING_OMEGA,
        safeDt
      );
      [this.azimuth, this.velAzimuth] = stepCriticallyDamped(
        this.azimuth,
        this.velAzimuth,
        this.targetAzimuth,
        SPRING_OMEGA,
        safeDt
      );
      [this.roll, this.velRoll] = stepCriticallyDamped(
        this.roll,
        this.velRoll,
        this.targetRoll,
        SPRING_OMEGA,
        safeDt
      );
      [this.fov, this.velFov] = stepCriticallyDamped(
        this.fov,
        this.velFov,
        this.targetFov,
        SPRING_OMEGA,
        safeDt
      );
    }

    this._recomputeBasis();
    return this._moved;
  }

  _recomputeBasis() {
    const r = this.radius;
    const prev = this._prevSignature;
    const moved =
      !this._hasPrevSignature ||
      Math.abs(r - prev[0]) > 1e-6 ||
      Math.abs(this.elevation - prev[1]) > 1e-6 ||
      Math.abs(this.azimuth - prev[2]) > 1e-6 ||
      Math.abs(this.roll - prev[3]) > 1e-6 ||
      Math.abs(this.fov - prev[4]) > 1e-6;

    this._hasPrevSignature = true;
    prev[0] = r;
    prev[1] = this.elevation;
    prev[2] = this.azimuth;
    prev[3] = this.roll;
    prev[4] = this.fov;

    computeSphericalOrbitBasisInto(this._pos, this._basis, this.azimuth, this.elevation, this.roll);
    this._pos[0] *= r;
    this._pos[1] *= r;
    this._pos[2] *= r;
    this._moved = moved;
  }

  hasMotion() {
    return (
      Boolean(this._flight) ||
      this._keys.size > 0 ||
      this._pointers.size > 0 ||
      Math.abs(this.velLogRadius) > 1e-5 ||
      Math.abs(this.velElevation) > 1e-5 ||
      Math.abs(this.velAzimuth) > 1e-5 ||
      Math.abs(this.velRoll) > 1e-5 ||
      Math.abs(this.velFov) > 1e-5
    );
  }

  getMatrices() {
    const b = this._basis;
    const right = [b[0], b[1], b[2]];
    const up = [b[3], b[4], b[5]];
    const forward = [b[6], b[7], b[8]];
    const moved = this._moved;
    this._moved = false;
    return {
      pos: [...this._pos],
      right,
      up,
      forward,
      basis: this._basis,
      fovY: this.fov,
      moved,
    };
  }

  dispose() {
    if (this._canvasBoundTo) {
      this._canvasBoundTo.removeEventListener('contextmenu', this._onContextMenu);
      this._canvasBoundTo.removeEventListener('pointerdown', this._onPointerDown);
      this._canvasBoundTo.removeEventListener('wheel', this._onWheel);
      this._canvasBoundTo.removeEventListener('dblclick', this._onDblClick);
      this._canvasBoundTo = null;
    }
    if (this._windowBound) {
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

export { LensClusterCamera as CameraController };
