export type Quaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type Vector3 = [number, number, number];

export type OrientationSample = {
  alpha: number;
  beta: number;
  gamma: number;
  screenOrientationAngle?: number;
};

export type MotionVector = {
  x: number;
  y: number;
};

export type EulerYXZ = {
  x: number;
  y: number;
  z: number;
};

export type WindowAngles = {
  pitch: number;
  yaw: number;
  roll: number;
};

export type RelativeAngles = {
  pitch: number;
  yaw: number;
};

export const EARTH_ORBIT_PERIOD_SECONDS = 600;
export const DEFAULT_EARTH_ORBIT_ACCELERATION = 1;

export function earthOrbitPhaseSeconds(
  nowMilliseconds = Date.now(),
  acceleration = DEFAULT_EARTH_ORBIT_ACCELERATION
) {
  const elapsedSeconds = nowMilliseconds / 1000 * acceleration;
  return ((elapsedSeconds % EARTH_ORBIT_PERIOD_SECONDS) + EARTH_ORBIT_PERIOD_SECONDS) % EARTH_ORBIT_PERIOD_SECONDS;
}

export type AxisInversion = boolean | {
  pitch?: boolean;
  yaw?: boolean;
};

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function applyDeadZone(value: number, threshold = 0.01) {
  return Math.abs(value) < threshold ? 0 : value;
}

export function wrapAngleRadians(angle: number) {
  if (!Number.isFinite(angle)) return 0;
  const wrapped = ((angle + Math.PI) % (Math.PI * 2) + (Math.PI * 2)) % (Math.PI * 2) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export function shortestAngleDeltaRadians(from: number, to: number) {
  return wrapAngleRadians(to - from);
}

export function unwrapAngleRadians(previousUnwrapped: number, nextWrapped: number) {
  const previousWrapped = wrapAngleRadians(previousUnwrapped);
  return previousUnwrapped + shortestAngleDeltaRadians(previousWrapped, nextWrapped);
}

function toRadians(value: number) {
  return value * Math.PI / 180;
}

export function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const magnitude = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  if (!magnitude) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: quaternion.x / magnitude,
    y: quaternion.y / magnitude,
    z: quaternion.z / magnitude,
    w: quaternion.w / magnitude
  };
}

export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

export function inverseQuaternion(quaternion: Quaternion): Quaternion {
  const normSquared = quaternion.x ** 2 + quaternion.y ** 2 + quaternion.z ** 2 + quaternion.w ** 2;
  if (!normSquared) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: -quaternion.x / normSquared,
    y: -quaternion.y / normSquared,
    z: -quaternion.z / normSquared,
    w: quaternion.w / normSquared
  };
}

export function quaternionFromAxisAngle(axis: Vector3, degrees: number): Quaternion {
  const [axisX, axisY, axisZ] = axis;
  const axisMagnitude = Math.hypot(axisX, axisY, axisZ);
  if (!axisMagnitude) return { x: 0, y: 0, z: 0, w: 1 };

  const half = toRadians(degrees) / 2;
  const scale = Math.sin(half) / axisMagnitude;
  return normalizeQuaternion({
    x: axisX * scale,
    y: axisY * scale,
    z: axisZ * scale,
    w: Math.cos(half)
  });
}

export function rotateVector(vector: Vector3, quaternion: Quaternion): Vector3 {
  const normalizedQuaternion = normalizeQuaternion(quaternion);
  const vectorQuat: Quaternion = { x: vector[0], y: vector[1], z: vector[2], w: 0 };
  const rotated = multiplyQuaternions(
    multiplyQuaternions(normalizedQuaternion, vectorQuat),
    inverseQuaternion(normalizedQuaternion)
  );
  return [rotated.x, rotated.y, rotated.z];
}

function quaternionFromEulerYXZRadians(x: number, y: number, z: number): Quaternion {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  return normalizeQuaternion({
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3
  });
}

export function quaternionToEulerYXZ(quaternion: Quaternion): EulerYXZ {
  const normalized = normalizeQuaternion(quaternion);
  const { x, y, z, w } = normalized;

  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const xw = x * w;
  const yw = y * w;
  const zw = z * w;

  const m11 = 1 - 2 * (yy + zz);
  const m13 = 2 * (xz + yw);
  const m21 = 2 * (xy + zw);
  const m22 = 1 - 2 * (xx + zz);
  const m23 = 2 * (yz - xw);
  const m31 = 2 * (xz - yw);
  const m33 = 1 - 2 * (xx + yy);

  const pitch = Math.asin(-clamp(m23, -1, 1));
  const singular = Math.abs(m23) > 0.9999999;

  if (!singular) {
    return {
      x: pitch,
      y: Math.atan2(m13, m33),
      z: Math.atan2(m21, m22)
    };
  }

  return {
    x: pitch,
    y: Math.atan2(-m31, m11),
    z: 0
  };
}

export function orientationToQuaternion(sample: OrientationSample): Quaternion {
  // Matches the DeviceOrientationControls transform in Three.js:
  // euler(beta, alpha, -gamma, 'YXZ') * Rx(-PI/2) * Rz(-screenOrientation)
  const device = quaternionFromEulerYXZRadians(
    toRadians(sample.beta),
    toRadians(sample.alpha),
    toRadians(-sample.gamma)
  );
  const cameraAlignment = quaternionFromAxisAngle([1, 0, 0], -90);
  const screen = quaternionFromAxisAngle([0, 0, 1], -(sample.screenOrientationAngle ?? 0));
  return normalizeQuaternion(multiplyQuaternions(multiplyQuaternions(device, cameraAlignment), screen));
}

export function relativeQuaternion(reference: Quaternion, current: Quaternion): Quaternion {
  return normalizeQuaternion(multiplyQuaternions(inverseQuaternion(reference), current));
}

export function relativeQuaternionToWindowAngles(relative: Quaternion): WindowAngles {
  const forward = rotateVector([0, 0, -1], relative);
  const right = rotateVector([1, 0, 0], relative);

  const safeForwardY = clamp(forward[1], -1, 1);
  const pitch = Math.asin(safeForwardY);

  const yaw = Math.atan2(forward[0], -forward[2]);

  // Roll around view axis from transformed right vector projected in camera plane.
  const roll = Math.atan2(right[1], right[0]);

  return {
    pitch: Number.isFinite(pitch) ? pitch : 0,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    roll: Number.isFinite(roll) ? roll : 0
  };
}

export function anglesFromRelativeQuaternion(relative: Quaternion): RelativeAngles {
  const forward = rotateVector([0, 0, -1], relative);
  const safeForwardY = clamp(forward[1], -1, 1);
  return {
    pitch: Math.asin(safeForwardY),
    yaw: Math.atan2(forward[0], -forward[2])
  };
}

function inversionFlags(invert: AxisInversion) {
  if (typeof invert === 'boolean') {
    const direction = invert ? -1 : 1;
    return { pitch: direction, yaw: direction };
  }
  return {
    pitch: invert.pitch ? -1 : 1,
    yaw: invert.yaw ? -1 : 1
  };
}

export function motionFromRelativeAngles(
  angles: RelativeAngles,
  gain = 1.45,
  invert: AxisInversion = false,
  fullTurnRadians = Math.PI * 2
): MotionVector {
  const { pitch, yaw } = inversionFlags(invert);
  const halfTurn = Math.max(fullTurnRadians / 2, 0.000001);

  return {
    x: clamp((angles.pitch / halfTurn) * gain * pitch, -1, 1),
    y: clamp((angles.yaw / halfTurn) * gain * yaw, -1, 1)
  };
}

export function wrapTurns(turns: number) {
  if (!Number.isFinite(turns)) return 0;
  return ((turns % 1) + 1) % 1;
}

export function wrapCenteredTurns(turns: number) {
  const wrapped = wrapTurns(turns);
  return wrapped >= 0.5 ? wrapped - 1 : wrapped;
}

export function wrapPanPixels(pixels: number, pixelsPerTurn: number) {
  if (!Number.isFinite(pixels) || !Number.isFinite(pixelsPerTurn) || pixelsPerTurn <= 0) return 0;
  const turns = pixels / pixelsPerTurn;
  return wrapCenteredTurns(turns) * pixelsPerTurn;
}

export function panFromRelativeAngles(
  angles: RelativeAngles,
  pixelsPerTurnX = 1400,
  pixelsPerTurnY = 900
): MotionVector {
  const turnsPerRadian = 1 / (Math.PI * 2);
  return {
    x: wrapCenteredTurns(angles.yaw * turnsPerRadian) * pixelsPerTurnX,
    y: wrapCenteredTurns(angles.pitch * turnsPerRadian) * pixelsPerTurnY
  };
}

export function panFromUnwrappedAngles(
  pitchRadians: number,
  yawRadians: number,
  pixelsPerTurnX = 1400,
  pixelsPerTurnY = 900,
  invert: AxisInversion = false
): MotionVector {
  const turnsPerRadian = 1 / (Math.PI * 2);
  const { pitch, yaw } = inversionFlags(invert);
  return {
    x: yawRadians * turnsPerRadian * pixelsPerTurnX * yaw,
    y: pitchRadians * turnsPerRadian * pixelsPerTurnY * pitch
  };
}

export function motionFromRelativeQuaternion(relative: Quaternion, gain = 1.45, invert: AxisInversion = false): MotionVector {
  return motionFromRelativeAngles(anglesFromRelativeQuaternion(relative), gain, invert);
}
