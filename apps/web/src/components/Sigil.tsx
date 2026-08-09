import { useEffect, useRef } from 'react';
import {
  MOTION_BACKGROUND_EVENT,
  MOTION_PERMISSION_EVENT,
  announceMotionPermission,
  getMotionPermissionState,
  isMotionBackgroundEnabled,
  requestMotionPermission,
  setMotionBackgroundEnabled
} from '../motion';
import {
  applyDeadZone,
  clamp,
  anglesFromRelativeQuaternion,
  motionFromRelativeAngles,
  orientationToQuaternion,
  relativeQuaternion,
  unwrapAngleRadians,
  type Quaternion
} from '../virtualWindowMotion';
import { createVirtualWindowRenderer } from '../virtualWindowRenderer';

const STARMAP_URL = '/media/starmap_2020_4k.png';

export function AmbientSigil() {
  const backgroundRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const hostEl = backgroundRef.current;
    const canvas = canvasRef.current;
    if (!hostEl || !canvas || typeof window === 'undefined') return;
    const renderer = createVirtualWindowRenderer(canvas, STARMAP_URL);

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const target = { x: 0, y: 0 };
    const targetPan = { x: 0, y: 0 };
    let motionEnabled = isMotionBackgroundEnabled();
    let pointerActive = false;
    const current = { x: 0, y: 0 };
    const currentPan = { x: 0, y: 0 };
    let lastSensorUpdate = 0;
    let disposed = false;
    let frame = 0;
    let orientationActive = false;
    let referenceQuaternion: Quaternion | null = null;
    let referenceAngles: { pitch: number; yaw: number } | null = null;
    let unwrappedPitch = 0;
    let unwrappedYaw = 0;

    function drawScene(time = 0) {
      // Stars and sigils share spherical UV coordinates, so both remain behind
      // the window and track the same full-surround view.
      renderer?.setView(currentPan.x, currentPan.y, reducedMotion ? 0 : time / 1000);
    }

    function screenOrientationAngle() {
      const angle = window.screen?.orientation?.angle;
      if (typeof angle === 'number') return angle;
      if (typeof window.orientation === 'number') return window.orientation;
      return undefined;
    }

    function readOrientation(alpha: number, beta: number, gamma: number) {
      const currentQuaternion = orientationToQuaternion({
        alpha,
        beta,
        gamma,
        screenOrientationAngle: screenOrientationAngle()
      });
      if (!referenceQuaternion) {
        referenceQuaternion = currentQuaternion;
        referenceAngles = null;
        unwrappedPitch = 0;
        unwrappedYaw = 0;
        target.x = 0;
        target.y = 0;
        targetPan.x = 0;
        targetPan.y = 0;
      } else {
        const relative = relativeQuaternion(referenceQuaternion, currentQuaternion);
        const angles = anglesFromRelativeQuaternion(relative);

        if (!referenceAngles) {
          referenceAngles = { pitch: angles.pitch, yaw: angles.yaw };
          unwrappedPitch = angles.pitch;
          unwrappedYaw = angles.yaw;
        } else {
          unwrappedPitch = unwrapAngleRadians(unwrappedPitch, angles.pitch);
          unwrappedYaw = unwrapAngleRadians(unwrappedYaw, angles.yaw);
        }

        const relativeUnwrapped = {
          pitch: unwrappedPitch - referenceAngles.pitch,
          yaw: unwrappedYaw - referenceAngles.yaw
        };

        const motion = motionFromRelativeAngles(relativeUnwrapped, 1.85, false, Math.PI * 2);
        target.x = applyDeadZone(clamp(motion.x, -1, 1));
        target.y = applyDeadZone(clamp(motion.y, -1, 1));

        targetPan.x = relativeUnwrapped.yaw;
        targetPan.y = clamp(relativeUnwrapped.pitch, -Math.PI / 2, Math.PI / 2);
      }
      lastSensorUpdate = performance.now();
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.alpha !== 'number' || typeof event.beta !== 'number' || typeof event.gamma !== 'number') return;
      readOrientation(event.alpha, event.beta, event.gamma);
    };

    function ensureOrientationListener() {
      if (orientationActive) return;
      window.addEventListener('deviceorientation', onOrientation, { passive: true });
      orientationActive = true;
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!motionEnabled || (lastSensorUpdate && performance.now() - lastSensorUpdate < 1500)) return;
      const x = (event.clientY / window.innerHeight) * 2 - 1;
      const y = (event.clientX / window.innerWidth) * 2 - 1;
      pointerActive = true;
      target.x = applyDeadZone(clamp(x, -1, 1), 0.04);
      target.y = applyDeadZone(clamp(y, -1, 1), 0.04);
      targetPan.x = y * 0.32;
      targetPan.y = x * 0.18;
    };

    const onPointerLeave = () => {
      pointerActive = false;
    };

    const requestFromGesture = () => {
      if (!motionEnabled) return;
      void requestMotionPermission().then((permission) => {
        announceMotionPermission(permission);
        if (permission === 'granted') {
          setMotionBackgroundEnabled(true);
          motionEnabled = true;
          ensureOrientationListener();
          return;
        }
        setMotionBackgroundEnabled(false);
        motionEnabled = false;
        referenceQuaternion = null;
        referenceAngles = null;
        unwrappedPitch = 0;
        unwrappedYaw = 0;
        target.x = 0;
        target.y = 0;
      }).catch(() => undefined);
    };

    const onPermissionChange = (event: Event) => {
      const permission = (event as CustomEvent<'granted' | 'denied' | 'unsupported'>).detail;
      if (permission === 'granted' && motionEnabled) ensureOrientationListener();
    };

    const onMotionBackgroundChange = (event: Event) => {
      motionEnabled = Boolean((event as CustomEvent<boolean>).detail);
      if (!motionEnabled) {
        pointerActive = false;
        target.x = 0;
        target.y = 0;
        targetPan.x = 0;
        targetPan.y = 0;
        referenceQuaternion = null;
        referenceAngles = null;
        unwrappedPitch = 0;
        unwrappedYaw = 0;
        return;
      }
      if (getMotionPermissionState() === 'granted') ensureOrientationListener();
    };

    if (motionEnabled && getMotionPermissionState() === 'granted') ensureOrientationListener();
    window.addEventListener(MOTION_PERMISSION_EVENT, onPermissionChange as EventListener);
    window.addEventListener(MOTION_BACKGROUND_EVENT, onMotionBackgroundChange as EventListener);
    window.addEventListener('pointerdown', requestFromGesture, { once: true, passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave, { passive: true });

    const onResize = () => renderer?.resize();
    window.addEventListener('resize', onResize, { passive: true });

    const animate = (time: number) => {
      if (disposed) return;
      const sensorFresh = motionEnabled && time - lastSensorUpdate < 1200;
      if (!motionEnabled) {
        target.x = 0;
        target.y = 0;
        targetPan.x = 0;
        targetPan.y = 0;
      } else if (!sensorFresh && !pointerActive) {
        const driftFactor = reducedMotion ? 0 : 0.35;
        target.x = Math.sin(time * 0.00012) * 0.12 * driftFactor;
        target.y = Math.cos(time * 0.00009) * 0.14 * driftFactor;
        targetPan.x = Math.sin(time * 0.00006) * 0.05 * driftFactor;
        targetPan.y = Math.cos(time * 0.00005) * 0.03 * driftFactor;
      }
      const blend = reducedMotion ? 0.025 : sensorFresh ? 0.22 : pointerActive ? 0.1 : 0.045;
      current.x += (target.x - current.x) * blend;
      current.y += (target.y - current.y) * blend;
      currentPan.x += (targetPan.x - currentPan.x) * blend;
      currentPan.y += (targetPan.y - currentPan.y) * blend;
      drawScene(time);
      frame = window.requestAnimationFrame(animate);
    };

    drawScene();
    frame = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      if (orientationActive) window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('pointerdown', requestFromGesture);
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('resize', onResize);
      window.removeEventListener(MOTION_PERMISSION_EVENT, onPermissionChange as EventListener);
      window.removeEventListener(MOTION_BACKGROUND_EVENT, onMotionBackgroundChange as EventListener);
      renderer?.dispose();
    };
  }, []);

  return <div
    ref={backgroundRef}
    className="ambient-sigil virtual-window"
    aria-hidden="true"
  >
    <canvas ref={canvasRef} className="virtual-window-canvas" />
    <div
      className="virtual-window-stars"
      style={{ backgroundImage: `url(${STARMAP_URL})` }}
    />
    <div className="virtual-window-glass" />
    <div className="virtual-window-vignette" />
  </div>;
}

export function JarvisMark() {
  return <svg className="jarvis-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
    <circle cx="22" cy="22" r="18" />
    <path d="m22 5 12 29H10L22 5Z" />
    <path d="M22 10v24M10 22h24" />
    <circle className="jarvis-mark-core" cx="22" cy="22" r="3" />
  </svg>;
}
