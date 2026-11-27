/**
 * CameraController.js — Critically-damped spherical orbit camera,
 * multi-input controller (mouse/touch/wheel/keyboard), smooth cubic preset flights,
 * and exact Kerr spacetime relativistic telemetry.
 */

import { computeKerrTelemetry } from './Physics.js';
import {
  DEG2RAD,
  RAD2DEG,
  clamp,
  wrapAngleDelta,
  easeOutCubic,
  stepCriticallyDamped,
  isEditableElement,
  computeSphericalOrbitBasisInto,
  createCanvasRectCache,
} from '../../../../shared/engine/BaseCamera.js';
export { computeKerrTelemetry };

const MIN_RADIUS = 2.8;
const MAX_RADIUS = 70.0;
const MIN_ELEVATION = -85.0 * DEG2RAD;
const MAX_ELEVATION = 85.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 22.0 * DEG2RAD;
const MAX_FOV = 85.0 * DEG2RAD;

const SPRING_OMEGA = 13.5; // Critically damped natural frequency (rad/s)
const AUTO_ORBIT_SPEED = 0.045; // Subtle cinematic horizontal drift (rad/s)
const AUTO_BREATH_AMP = 0.010; // ~0.57 deg gentle elevation breathing
const AUTO_BREATH_FREQ = 0.22; // rad/s
const INTERACTION_COOLDOWN = 2.4; // Seconds before auto-orbit gently resumes after manual drag

export class CameraController {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} initialCamera
   * @param {{ onResetRequest?: () => void, onUserInteract?: () => void }} [callbacks]
   */
  constructor(canvas, initialCamera = {}, callbacks = {}) {
    this.canvas = canvas;
    this.onResetRequest = callbacks.onResetRequest || null;
    this.onUserInteract = callbacks.onUserInteract || null;

    const r0 = clamp(initialCamera.radius ?? 25.0, MIN_RADIUS, MAX_RADIUS);
    const el0 = clamp((initialCamera.elevationDeg ?? 7.5) * DEG2RAD, MIN_ELEVATION, MAX_ELEVATION);
    const az0 = (initialCamera.azimuthDeg ?? 0.0) * DEG2RAD;
    const roll0 = clamp((initialCamera.rollDeg ?? -6.0) * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp((initialCamera.fovDeg ?? 46.0) * DEG2RAD, MIN_FOV, MAX_FOV);

    // Current rendered spherical state (logRadius for perceptually uniform zoom)
    this.logRadius = Math.log(r0);
    this.elevation = el0;
    this.azimuth = az0;
    this.roll = roll0;
    this.fov = fov0;

    // Target spherical state
    this.targetLogRadius = this.logRadius;
    this.targetElevation = el0;
    this.targetAzimuth = az0;
    this.targetRoll = roll0;
    this.targetFov = fov0;

    // Critically-damped spring velocities
    this.velLogRadius = 0;
    this.velElevation = 0;
    this.velAzimuth = 0;
    this.velRoll = 0;
    this.velFov = 0;

    // Smooth preset flight state
    this._flight = null;

    // Auto-orbit state
    this._autoOrbitTime = 0;
    this._autoBaseElevation = el0;
    this._interactionCooldown = 0;

    // Cached output buffers
    this._pos = [0, 0, r0];
    this._posUnit = [0, 0, 1];
    this._basis = new Float32Array(9);
    this._moved = true;
    this._hasPrevSignature = false;
    this._prevSignature = new Float64Array(10);

    // Active pointer & keyboard state
    this._pointers = new Map();
    this._pinchPrevDist = null;
    this._dragMode = null; // 'orbit' | 'roll' | 'pinch'
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

  /**
   * Smoothly fly camera to a preset using cubic ease-out interpolation.
   * Pass duration = 0 to snap immediately.
   */
  flyTo(camPreset = {}, duration = 1.2) {
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

  /**
   * Immediately set camera pose (used by programmatic verification API).
   */
  setImmediate(camPatch = {}) {
    this.flyTo(camPatch, 0);
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

  _bindEvents() {
    this._onContextMenu = (e) => {
      e.preventDefault();
    };

    this._onPointerDown = (e) => {
      if (e.button !== 0 && e.button !== 2 && e.pointerType === 'mouse') return;
      this.canvas?.setPointerCapture?.(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });

      if (this._pointers.size === 1) {
        this._dragMode = e.button === 2 || e.shiftKey ? 'roll' : 'orbit';
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
      const scale = 1.0 / Math.max(Math.min(rect.width, rect.height), 320);

      if (this._dragMode === 'roll' || e.shiftKey) {
        this.targetRoll = clamp(this.targetRoll + dx * scale * 2.2, MIN_ROLL, MAX_ROLL);
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
      // Normalize trackpad pixels vs mouse wheel lines
      const modeScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
      const delta = clamp(e.deltaY * modeScale, -240, 240);
      this.targetLogRadius = clamp(
        this.targetLogRadius + delta * 0.00115,
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

    if (this.canvas) {
      this._bindCanvasEvents(this.canvas);
    }
  }

  _bindCanvasEvents(targetCanvas) {
    if (!targetCanvas || this._canvasBoundTo === targetCanvas) return;
    targetCanvas.addEventListener('contextmenu', this._onContextMenu);
    targetCanvas.addEventListener('pointerdown', this._onPointerDown);
    targetCanvas.addEventListener('wheel', this._onWheel, { passive: false });
    targetCanvas.addEventListener('dblclick', this._onDblClick);
    this._canvasBoundTo = targetCanvas;
  }

  _unbindCanvasEvents(targetCanvas) {
    if (!targetCanvas || this._canvasBoundTo !== targetCanvas) return;
    targetCanvas.removeEventListener('contextmenu', this._onContextMenu);
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
    this._rectCache?.invalidate();
    this._moved = true;
  }

  _getPinchDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return null;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  /**
   * Advance camera physics, preset flights, keyboard navigation, and gentle auto-orbit.
   */
  update(dt, { paused = false, autoOrbit = true } = {}) {
    const clampedDt = clamp(dt, 0, 0.05);

    // 1. Continuous keyboard fine camera control
    if (this._keys.size > 0) {
      const orbitRate = 0.85 * clampedDt;
      const elevRate = 0.65 * clampedDt;
      const zoomRate = 0.72 * clampedDt;
      const rollRate = 0.75 * clampedDt;

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
        this.targetLogRadius = clamp(
          this.targetLogRadius - zoomRate,
          Math.log(MIN_RADIUS),
          Math.log(MAX_RADIUS)
        );
      }
      if (this._keys.has('KeyS')) {
        this.targetLogRadius = clamp(
          this.targetLogRadius + zoomRate,
          Math.log(MIN_RADIUS),
          Math.log(MAX_RADIUS)
        );
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

    // 2. Smooth cubic ease-out preset transition
    if (this._flight) {
      const f = this._flight;
      f.elapsed += clampedDt;
      const t = clamp(f.elapsed / f.duration, 0, 1);
      const e = easeOutCubic(t);

      this.logRadius = f.startLogRadius + (f.endLogRadius - f.startLogRadius) * e;
      this.elevation = f.startElevation + (f.endElevation - f.startElevation) * e;
      this.azimuth = f.startAzimuth + (f.endAzimuth - f.startAzimuth) * e;
      this.roll = f.startRoll + (f.endRoll - f.startRoll) * e;
      this.fov = f.startFov + (f.endFov - f.startFov) * e;

      this.targetLogRadius = this.logRadius;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;

      if (t >= 1) {
        this._autoBaseElevation = this.elevation;
        this._autoOrbitTime = 0;
        this._flight = null;
      }
    } else {
      // 3. Gentle auto-orbit (yields to user interaction and halts when paused so 128-sample cinema still converges!)
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
        [this.logRadius, this.velLogRadius] = stepCriticallyDamped(
          this.logRadius,
          this.velLogRadius,
          this.targetLogRadius,
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
    const r = Math.exp(this.logRadius);
    const b = this._basis;
    computeSphericalOrbitBasisInto(this._posUnit, b, this.azimuth, this.elevation, this.roll);

    // Camera position in Kerr-Schild Cartesian coords (spin = +Y, disk = X-Z plane)
    // At az=0, el=0: pos = (0, 0, +r) looking toward origin along -Z
    const px = r * this._posUnit[0];
    const py = r * this._posUnit[1];
    const pz = r * this._posUnit[2];
    this._pos[0] = px;
    this._pos[1] = py;
    this._pos[2] = pz;

    // Check whether camera pose actually changed since last frame (zero allocation)
    const prev = this._prevSignature;
    if (!this._hasPrevSignature) {
      this._moved = true;
      this._hasPrevSignature = true;
      prev[0] = px; prev[1] = py; prev[2] = pz;
      prev[3] = b[0]; prev[4] = b[1]; prev[5] = b[2];
      prev[6] = b[3]; prev[7] = b[4]; prev[8] = b[5];
      prev[9] = this.fov;
    } else {
      const maxDiff = Math.max(
        Math.abs(px - prev[0]),
        Math.abs(py - prev[1]),
        Math.abs(pz - prev[2]),
        Math.abs(b[0] - prev[3]),
        Math.abs(b[1] - prev[4]),
        Math.abs(b[2] - prev[5]),
        Math.abs(b[3] - prev[6]),
        Math.abs(b[4] - prev[7]),
        Math.abs(b[5] - prev[8]),
        Math.abs(this.fov - prev[9])
      );
      this._moved = maxDiff > 1e-6;
      if (this._moved) {
        prev[0] = px; prev[1] = py; prev[2] = pz;
        prev[3] = b[0]; prev[4] = b[1]; prev[5] = b[2];
        prev[6] = b[3]; prev[7] = b[4]; prev[8] = b[5];
        prev[9] = this.fov;
      }
    }
  }

  getCameraMatrices() {
    return {
      pos: [this._pos[0], this._pos[1], this._pos[2]],
      basis: this._basis,
      fovY: this.fov,
      moved: this._moved,
    };
  }

  getRelativisticTelemetry(spin) {
    return computeKerrTelemetry(spin, this.radius, this.elevation);
  }

  dispose() {
    this._rectCache?.dispose();
    if (this.canvas) {
      this._unbindCanvasEvents(this.canvas);
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
