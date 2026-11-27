/**
 * WarpCamera.js — Dual-mode critically-damped camera controller for Warp Drive Transit:
 * - Mode 0 (External Chase): spherical orbit around bubble center (0, 0, 0) along +Z flight axis.
 * - Mode 1 (Inside Bridge): cockpit observer inside flat bubble core near (0, 0, -0.15)
 *   looking along +Z with full 360° yaw (including 180° aft causal horizon inspection).
 * - Smooth quaternion SLERP + position interpolation across frameBlend in [0, 1].
 */

import {
  DEG2RAD,
  RAD2DEG,
  clamp,
  wrapAngleDelta,
  easeOutCubic,
  easeInOutCubic,
  stepCriticallyDamped,
  isEditableElement,
  applyLocalLookTriad as applyLocalLook,
} from '../../../../shared/engine/BaseCamera.js';

const MIN_RADIUS = 3.5;
const MAX_RADIUS = 45.0;
const MIN_ELEVATION = -85.0 * DEG2RAD;
const MAX_ELEVATION = 85.0 * DEG2RAD;
const MIN_LOOK_PITCH = -85.0 * DEG2RAD;
const MAX_LOOK_PITCH = 85.0 * DEG2RAD;
const MIN_ROLL = -90.0 * DEG2RAD;
const MAX_ROLL = 90.0 * DEG2RAD;
const MIN_FOV = 22.0 * DEG2RAD;
const MAX_FOV = 90.0 * DEG2RAD;
const MIN_BRIDGE_FOV = 28.0 * DEG2RAD;
const MAX_BRIDGE_FOV = 90.0 * DEG2RAD;

const BRIDGE_POS = [0.0, 0.0, -0.15];

const SPRING_OMEGA = 13.5;
const FRAME_BLEND_OMEGA = 9.0;
const AUTO_ORBIT_SPEED = 0.042;
const AUTO_BREATH_AMP = 0.009;
const AUTO_BREATH_FREQ = 0.22;
const INTERACTION_COOLDOWN = 2.4;

/**
 * Converts a right-handed basis (right, up, -forward) in SO(3) to a unit quaternion [x, y, z, w].
 */
function basisToQuat(right, up, forward) {
  const m00 = right[0], m01 = up[0], m02 = -forward[0];
  const m10 = right[1], m11 = up[1], m12 = -forward[1];
  const m20 = right[2], m21 = up[2], m22 = -forward[2];

  const trace = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (trace > 0.0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m00 - m11 - m22));
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m11 - m00 - m22));
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m22 - m00 - m11));
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  const invLen = 1.0 / Math.max(Math.hypot(qx, qy, qz, qw), 1e-12);
  return [qx * invLen, qy * invLen, qz * invLen, qw * invLen];
}

/**
 * Shortest-arc SLERP between two unit quaternions, returning orthonormal { right, up, forward }.
 */
function slerpBases(bA, bB, t) {
  const qA = basisToQuat(bA.right, bA.up, bA.forward);
  let qB = basisToQuat(bB.right, bB.up, bB.forward);

  let dot = qA[0] * qB[0] + qA[1] * qB[1] + qA[2] * qB[2] + qA[3] * qB[3];
  if (dot < 0.0) {
    dot = -dot;
    qB = [-qB[0], -qB[1], -qB[2], -qB[3]];
  }

  let qx, qy, qz, qw;
  if (dot > 0.9995) {
    qx = qA[0] + t * (qB[0] - qA[0]);
    qy = qA[1] + t * (qB[1] - qA[1]);
    qz = qA[2] + t * (qB[2] - qA[2]);
    qw = qA[3] + t * (qB[3] - qA[3]);
  } else {
    const theta0 = Math.acos(clamp(dot, -1.0, 1.0));
    const sinTheta0 = Math.sin(theta0);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
    const s1 = sinTheta / sinTheta0;
    qx = s0 * qA[0] + s1 * qB[0];
    qy = s0 * qA[1] + s1 * qB[1];
    qz = s0 * qA[2] + s1 * qB[2];
    qw = s0 * qA[3] + s1 * qB[3];
  }

  const invLen = 1.0 / Math.max(Math.hypot(qx, qy, qz, qw), 1e-12);
  qx *= invLen;
  qy *= invLen;
  qz *= invLen;
  qw *= invLen;

  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;

  const right = [
    1.0 - 2.0 * (yy + zz),
    2.0 * (xy + wz),
    2.0 * (xz - wy),
  ];
  const up = [
    2.0 * (xy - wz),
    1.0 - 2.0 * (xx + zz),
    2.0 * (yz + wx),
  ];
  const forward = [
    -(2.0 * (xz + wy)),
    -(2.0 * (yz - wx)),
    -(1.0 - 2.0 * (xx + yy)),
  ];

  return { right, up, forward };
}

export class WarpCamera {
  /**
   * @param {HTMLCanvasElement | null} canvas
   * @param {object} initialCam
   * @param {{
   *   cameraMode?: number,
   *   onResetRequest?: () => void,
   *   onUserInteract?: () => void,
   *   onModeChange?: (mode: number) => void
   * }} [callbacks]
   */
  constructor(canvas, initialCam = {}, callbacks = {}) {
    this.canvas = canvas || null;
    this.onResetRequest = callbacks.onResetRequest || null;
    this.onUserInteract = callbacks.onUserInteract || null;
    this.onModeChange = callbacks.onModeChange || null;

    const rawMode = initialCam.cameraMode ?? callbacks.cameraMode ?? 0;
    const mode0 = (rawMode | 0) === 1 ? 1 : 0;

    const r0 = clamp(initialCam.radius ?? 11.8, MIN_RADIUS, MAX_RADIUS);
    const el0 = clamp((initialCam.elevationDeg ?? 15.0) * DEG2RAD, MIN_ELEVATION, MAX_ELEVATION);
    const az0 = (initialCam.azimuthDeg ?? 34.0) * DEG2RAD;
    const roll0 = clamp((initialCam.rollDeg ?? -3.0) * DEG2RAD, MIN_ROLL, MAX_ROLL);
    const fov0 = clamp((initialCam.fovDeg ?? 48.0) * DEG2RAD, MIN_FOV, MAX_FOV);
    const yaw0 = (initialCam.lookYawDeg ?? 0.0) * DEG2RAD;
    const pitch0 = clamp((initialCam.lookPitchDeg ?? 0.0) * DEG2RAD, MIN_LOOK_PITCH, MAX_LOOK_PITCH);

    this.cameraMode = mode0;
    this.frameBlend = mode0 === 1 ? 1.0 : 0.0;
    this.targetFrameBlend = this.frameBlend;
    this.velFrameBlend = 0.0;

    this.logRadius = Math.log(r0);
    this.elevation = el0;
    this.azimuth = az0;
    this.roll = roll0;
    this.fov = fov0;
    this.lookYaw = yaw0;
    this.lookPitch = pitch0;

    this.targetLogRadius = this.logRadius;
    this.targetElevation = el0;
    this.targetAzimuth = az0;
    this.targetRoll = roll0;
    this.targetFov = fov0;
    this.targetLookYaw = yaw0;
    this.targetLookPitch = pitch0;

    this.velLogRadius = 0;
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

    this._pos = [0, 0, r0];
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

    this._recomputeBasis();
    this._bindEvents();
  }

  get radius() {
    return Math.exp(this.logRadius);
  }

  getState() {
    return {
      radius: this.radius,
      azimuthDeg: this.azimuth * RAD2DEG,
      elevationDeg: this.elevation * RAD2DEG,
      rollDeg: this.roll * RAD2DEG,
      fovDeg: this.fov * RAD2DEG,
      lookYawDeg: this.lookYaw * RAD2DEG,
      lookPitchDeg: this.lookPitch * RAD2DEG,
      cameraMode: this.cameraMode,
      frameBlend: this.frameBlend,
    };
  }

  setCameraMode(mode, instant = false) {
    const nextMode = (mode | 0) === 1 ? 1 : 0;
    const prevMode = this.cameraMode;
    this.cameraMode = nextMode;
    this.targetFrameBlend = nextMode === 1 ? 1.0 : 0.0;

    if (nextMode !== prevMode) {
      // Smoothly recenter local look offset when switching between Chase & Bridge
      this.targetLookYaw = wrapAngleDelta(0.0);
      this.targetLookPitch = 0.0;
      if (instant) {
        this.lookYaw = 0.0;
        this.lookPitch = 0.0;
        this.velLookYaw = 0.0;
        this.velLookPitch = 0.0;
      }
    }

    if (instant) {
      this._flight = null;
      this.frameBlend = this.targetFrameBlend;
      this.velFrameBlend = 0.0;
      this._recomputeBasis();
      this._moved = true;
    } else if (this._flight) {
      this._flight.endFrameBlend = this.targetFrameBlend;
    }

    if (nextMode !== prevMode && this.onModeChange) {
      this.onModeChange(nextMode);
    }
    return nextMode;
  }

  toggleCameraMode(instant = false) {
    const nextMode = this.cameraMode === 1 ? 0 : 1;
    return this.setCameraMode(nextMode, instant);
  }

  flyTo(camPatch = {}, duration = 1.0, targetMode = undefined) {
    const resolvedMode =
      targetMode !== undefined
        ? ((targetMode | 0) === 1 ? 1 : 0)
        : camPatch.cameraMode !== undefined
          ? ((camPatch.cameraMode | 0) === 1 ? 1 : 0)
          : this.cameraMode;

    const prevMode = this.cameraMode;
    this.cameraMode = resolvedMode;
    const destFrameBlend = resolvedMode === 1 ? 1.0 : 0.0;

    const destRadius = clamp(camPatch.radius ?? this.radius, MIN_RADIUS, MAX_RADIUS);
    const destLogRadius = Math.log(destRadius);
    const destEl = clamp(
      (camPatch.elevationDeg ?? this.elevation * RAD2DEG) * DEG2RAD,
      MIN_ELEVATION,
      MAX_ELEVATION
    );
    const destAzRaw = (camPatch.azimuthDeg ?? this.azimuth * RAD2DEG) * DEG2RAD;
    const destAz = this.azimuth + wrapAngleDelta(destAzRaw - this.azimuth);
    const destRoll = clamp(
      (camPatch.rollDeg ?? this.roll * RAD2DEG) * DEG2RAD,
      MIN_ROLL,
      MAX_ROLL
    );
    const destFov = clamp(
      (camPatch.fovDeg ?? this.fov * RAD2DEG) * DEG2RAD,
      MIN_FOV,
      MAX_FOV
    );
    const destYawRaw = (camPatch.lookYawDeg ?? this.lookYaw * RAD2DEG) * DEG2RAD;
    const destYaw = this.lookYaw + wrapAngleDelta(destYawRaw - this.lookYaw);
    const destPitch = clamp(
      (camPatch.lookPitchDeg ?? this.lookPitch * RAD2DEG) * DEG2RAD,
      MIN_LOOK_PITCH,
      MAX_LOOK_PITCH
    );

    if (!duration || duration <= 0) {
      this._flight = null;
      this.logRadius = this.targetLogRadius = destLogRadius;
      this.elevation = this.targetElevation = destEl;
      this.azimuth = this.targetAzimuth = destAzRaw;
      this.roll = this.targetRoll = destRoll;
      this.fov = this.targetFov = destFov;
      this.lookYaw = this.targetLookYaw = destYawRaw;
      this.lookPitch = this.targetLookPitch = destPitch;
      this.frameBlend = this.targetFrameBlend = destFrameBlend;

      this.velLogRadius = 0;
      this.velElevation = 0;
      this.velAzimuth = 0;
      this.velRoll = 0;
      this.velFov = 0;
      this.velLookYaw = 0;
      this.velLookPitch = 0;
      this.velFrameBlend = 0;

      this._autoBaseElevation = destEl;
      this._autoOrbitTime = 0;
      this._interactionCooldown = 0;
      this._recomputeBasis();
      this._moved = true;
    } else {
      this._flight = {
        elapsed: 0,
        duration,
        startLogRadius: this.logRadius,
        startElevation: this.elevation,
        startAzimuth: this.azimuth,
        startRoll: this.roll,
        startFov: this.fov,
        startLookYaw: this.lookYaw,
        startLookPitch: this.lookPitch,
        startFrameBlend: this.frameBlend,
        endLogRadius: destLogRadius,
        endElevation: destEl,
        endAzimuth: destAz,
        endRoll: destRoll,
        endFov: destFov,
        endLookYaw: destYaw,
        endLookPitch: destPitch,
        endFrameBlend: destFrameBlend,
      };
      this.targetFrameBlend = destFrameBlend;
      this.velLogRadius = 0;
      this.velElevation = 0;
      this.velAzimuth = 0;
      this.velRoll = 0;
      this.velFov = 0;
      this.velLookYaw = 0;
      this.velLookPitch = 0;
      this.velFrameBlend = 0;
      this._interactionCooldown = 0;
    }

    if (resolvedMode !== prevMode && this.onModeChange) {
      this.onModeChange(resolvedMode);
    }
  }

  setImmediate(patch = {}) {
    this.flyTo(patch, 0, patch.cameraMode);
  }

  _cancelFlight() {
    if (this._flight) {
      this._flight = null;
      this.targetLogRadius = this.logRadius;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetFrameBlend = this.cameraMode === 1 ? 1.0 : 0.0;
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
        } else if (e.button === 1 || e.shiftKey || this.cameraMode === 1) {
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
          if (this.cameraMode === 1) {
            this.targetFov = clamp(
              this.targetFov * ratio,
              MIN_BRIDGE_FOV,
              MAX_BRIDGE_FOV
            );
          } else {
            this.targetLogRadius = clamp(
              this.targetLogRadius + Math.log(ratio),
              Math.log(MIN_RADIUS),
              Math.log(MAX_RADIUS)
            );
          }
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
      } else if (this._dragMode === 'look' || e.shiftKey || this.cameraMode === 1) {
        this.targetLookYaw += dx * scale * 2.6;
        this.targetLookPitch = clamp(
          this.targetLookPitch - dy * scale * 2.2,
          MIN_LOOK_PITCH,
          MAX_LOOK_PITCH
        );
      } else {
        this.targetAzimuth += dx * scale * 3.1;
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
        // Ignore if already released
      }
      if (this._pointers.size === 0) {
        this._dragMode = null;
        this._pinchPrevDist = null;
      } else if (this._pointers.size === 1) {
        this._dragMode = this.cameraMode === 1 ? 'look' : 'orbit';
        this._pinchPrevDist = null;
      }
    };

    this._onWheel = (e) => {
      e.preventDefault();
      const modeScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
      const delta = clamp(e.deltaY * modeScale, -240, 240);
      if (this.cameraMode === 1) {
        this.targetFov = clamp(
          this.targetFov + delta * 0.0009,
          MIN_BRIDGE_FOV,
          MAX_BRIDGE_FOV
        );
      } else {
        this.targetLogRadius = clamp(
          this.targetLogRadius + delta * 0.00115,
          Math.log(MIN_RADIUS),
          Math.log(MAX_RADIUS)
        );
      }
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
   * Advances critically-damped camera springs, preset flights, frameBlend, and auto-orbit.
   * Accepts either `update(dt, autoOrbit)` or `update(dt, { paused, autoOrbit })`.
   */
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
      const lookRate = 1.05 * clampedDt;
      const zoomRate = 0.72 * clampedDt;
      const fovRate = 0.52 * clampedDt;
      const rollRate = 0.75 * clampedDt;

      if (this.cameraMode === 1) {
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
          this.targetFov = clamp(this.targetFov - fovRate, MIN_BRIDGE_FOV, MAX_BRIDGE_FOV);
        }
        if (this._keys.has('KeyS')) {
          this.targetFov = clamp(this.targetFov + fovRate, MIN_BRIDGE_FOV, MAX_BRIDGE_FOV);
        }
      } else {
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
      const eBlend = easeInOutCubic(t);

      this.logRadius = f.startLogRadius + (f.endLogRadius - f.startLogRadius) * e;
      this.elevation = f.startElevation + (f.endElevation - f.startElevation) * e;
      this.azimuth = f.startAzimuth + (f.endAzimuth - f.startAzimuth) * e;
      this.roll = f.startRoll + (f.endRoll - f.startRoll) * e;
      this.fov = f.startFov + (f.endFov - f.startFov) * e;
      this.lookYaw = f.startLookYaw + (f.endLookYaw - f.startLookYaw) * e;
      this.lookPitch = f.startLookPitch + (f.endLookPitch - f.startLookPitch) * e;
      this.frameBlend = f.startFrameBlend + (f.endFrameBlend - f.startFrameBlend) * eBlend;

      this.targetLogRadius = this.logRadius;
      this.targetElevation = this.elevation;
      this.targetAzimuth = this.azimuth;
      this.targetRoll = this.roll;
      this.targetFov = this.fov;
      this.targetLookYaw = this.lookYaw;
      this.targetLookPitch = this.lookPitch;
      this.targetFrameBlend = f.endFrameBlend;

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

      if (
        this.cameraMode === 0 &&
        autoOrbit &&
        !paused &&
        !interacting &&
        this._interactionCooldown <= 0
      ) {
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
        [this.frameBlend, this.velFrameBlend] = stepCriticallyDamped(
          this.frameBlend,
          this.velFrameBlend,
          this.targetFrameBlend,
          FRAME_BLEND_OMEGA,
          clampedDt
        );
      }
    }

    this._recomputeBasis();
  }

  _computeChasePose() {
    const r = Math.exp(this.logRadius);
    const cosEl = Math.cos(this.elevation);
    const sinEl = Math.sin(this.elevation);
    const cosAz = Math.cos(this.azimuth);
    const sinAz = Math.sin(this.azimuth);

    // az=0, el=0 places camera on +Z looking back at origin; az=34, el=15 gives 3/4 view
    // with forward (+Z) bow facing camera-right/front and aft (-Z) wake trailing camera-left/back.
    const px = -r * cosEl * sinAz;
    const py = r * sinEl;
    const pz = r * cosEl * cosAz;

    const invR = 1.0 / Math.max(r, 1e-6);
    const f0 = [-px * invR, -py * invR, -pz * invR];

    let r0x = -f0[2];
    let r0z = f0[0];
    const r0Len = Math.hypot(r0x, r0z);
    if (r0Len < 1e-6) {
      r0x = cosAz;
      r0z = sinAz;
    } else {
      r0x /= r0Len;
      r0z /= r0Len;
    }
    const r0 = [r0x, 0.0, r0z];

    let u0x = -r0z * f0[1];
    let u0y = r0z * f0[0] - r0x * f0[2];
    let u0z = r0x * f0[1];
    const u0Len = Math.hypot(u0x, u0y, u0z) || 1.0;
    const u0 = [u0x / u0Len, u0y / u0Len, u0z / u0Len];

    const basis = applyLocalLook(r0, u0, f0, this.lookYaw, this.lookPitch, this.roll);
    return { pos: [px, py, pz], ...basis };
  }

  _computeBridgePose() {
    // Inside flat bubble core looking forward along +Z when lookYaw=0, lookPitch=0
    const r0 = [-1.0, 0.0, 0.0];
    const u0 = [0.0, 1.0, 0.0];
    const f0 = [0.0, 0.0, 1.0];
    const basis = applyLocalLook(r0, u0, f0, this.lookYaw, this.lookPitch, this.roll);
    return { pos: [...BRIDGE_POS], ...basis };
  }

  _recomputeBasis() {
    const t = clamp(this.frameBlend, 0.0, 1.0);
    let pose;
    if (t <= 1e-5) {
      pose = this._computeChasePose();
    } else if (t >= 1.0 - 1e-5) {
      pose = this._computeBridgePose();
    } else {
      const chase = this._computeChasePose();
      const bridge = this._computeBridgePose();
      const smoothT = easeInOutCubic(t);
      const pos = [
        chase.pos[0] + (bridge.pos[0] - chase.pos[0]) * smoothT,
        chase.pos[1] + (bridge.pos[1] - chase.pos[1]) * smoothT,
        chase.pos[2] + (bridge.pos[2] - chase.pos[2]) * smoothT,
      ];
      const blended = slerpBases(chase, bridge, smoothT);
      pose = { pos, ...blended };
    }

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
      this.fov, this.cameraMode, this.frameBlend,
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

  getCameraMatrices() {
    return {
      pos: [this._pos[0], this._pos[1], this._pos[2]],
      right: [this._right[0], this._right[1], this._right[2]],
      up: [this._up[0], this._up[1], this._up[2]],
      forward: [this._forward[0], this._forward[1], this._forward[2]],
      basis: this._basis,
      fovY: this.fov,
      cameraMode: this.cameraMode,
      frameBlend: this.frameBlend,
      moved: this._moved,
    };
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

export { WarpCamera as CameraController };
