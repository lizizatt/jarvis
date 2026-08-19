import {
  applyDeadZone,
  earthOrbitPhaseSeconds,
  EARTH_ORBIT_PERIOD_SECONDS,
  gravityToWindowAngles,
  motionFromRelativeQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  orientationToQuaternion,
  panFromUnwrappedAngles,
  quaternionFromAxisAngle,
  wrapPanPixels,
  relativeQuaternion,
  rotateVector,
  unwrapAngleRadians
} from './virtualWindowMotion';

test('derives the earth orbit from wall-clock time and acceleration', () => {
  expect(earthOrbitPhaseSeconds(0)).toBe(0);
  expect(earthOrbitPhaseSeconds(EARTH_ORBIT_PERIOD_SECONDS * 1000)).toBe(0);
  expect(earthOrbitPhaseSeconds(125_000, 2)).toBeCloseTo(250, 6);
  expect(earthOrbitPhaseSeconds(125_000, 2)).not.toBe(earthOrbitPhaseSeconds(0));
});

test('derives horizon pitch and roll from gravity, independent of yaw', () => {
  const neutral = gravityToWindowAngles([0, -9.8, 0]);
  const pitched = gravityToWindowAngles([0, -9.8 * Math.cos(Math.PI / 6), 9.8 * Math.sin(Math.PI / 6)]);
  const rolled = gravityToWindowAngles([9.8 * Math.sin(Math.PI / 6), -9.8 * Math.cos(Math.PI / 6), 0]);
  const yawed = gravityToWindowAngles([0, -9.8, 0]);

  expect(neutral.pitch).toBeCloseTo(0, 6);
  expect(neutral.roll).toBeCloseTo(0, 6);
  expect(pitched.pitch).toBeCloseTo(Math.PI / 6, 6);
  expect(rolled.roll).toBeCloseTo(Math.PI / 6, 6);
  expect(yawed).toEqual(neutral);
});

test('keeps neutral motion at zero when orientation matches reference', () => {
  const reference = orientationToQuaternion({ alpha: 0, beta: 0, gamma: 0, screenOrientationAngle: 0 });
  const current = orientationToQuaternion({ alpha: 0, beta: 0, gamma: 0, screenOrientationAngle: 0 });
  const relative = relativeQuaternion(reference, current);
  const motion = motionFromRelativeQuaternion(relative);
  expect(motion.x).toBeCloseTo(0, 6);
  expect(motion.y).toBeCloseTo(0, 6);
});

test('maps pitch and yaw rotations to independent motion axes', () => {
  const pitchForward = quaternionFromAxisAngle([1, 0, 0], 40);
  const yawRight = quaternionFromAxisAngle([0, 1, 0], 40);

  const pitchMotion = motionFromRelativeQuaternion(pitchForward, 1);
  const yawMotion = motionFromRelativeQuaternion(yawRight, 1);

  expect(Math.abs(pitchMotion.x)).toBeGreaterThan(0.2);
  expect(Math.abs(pitchMotion.y)).toBeLessThan(0.05);
  expect(Math.abs(yawMotion.y)).toBeGreaterThan(0.2);
  expect(Math.abs(yawMotion.x)).toBeLessThan(0.05);
});

test('uses full yaw range instead of saturating at ±90°', () => {
  const yawNinety = motionFromRelativeQuaternion(quaternionFromAxisAngle([0, 1, 0], 90), 1);
  const yawOneThirtyFive = motionFromRelativeQuaternion(quaternionFromAxisAngle([0, 1, 0], 135), 1);

  expect(Math.abs(yawOneThirtyFive.y)).toBeGreaterThan(Math.abs(yawNinety.y));
  expect(Math.abs(yawOneThirtyFive.y)).toBeLessThanOrEqual(1);
});

test('inverted mode mirrors both axes', () => {
  const relative = normalizeQuaternion(multiplyQuaternions(
    quaternionFromAxisAngle([0, 1, 0], 15),
    quaternionFromAxisAngle([1, 0, 0], -12)
  ));

  const normal = motionFromRelativeQuaternion(relative, 1);
  const inverted = motionFromRelativeQuaternion(relative, 1, true);

  expect(inverted.x).toBeCloseTo(-normal.x, 6);
  expect(inverted.y).toBeCloseTo(-normal.y, 6);
});

test('supports axis-specific inversion', () => {
  const relative = normalizeQuaternion(multiplyQuaternions(
    quaternionFromAxisAngle([0, 1, 0], 20),
    quaternionFromAxisAngle([1, 0, 0], -10)
  ));

  const normal = motionFromRelativeQuaternion(relative, 1, false);
  const yawOnlyInverted = motionFromRelativeQuaternion(relative, 1, { pitch: false, yaw: true });

  expect(yawOnlyInverted.x).toBeCloseTo(normal.x, 6);
  expect(yawOnlyInverted.y).toBeCloseTo(-normal.y, 6);
});

test('unwrapped pan is continuous across full turns and can invert', () => {
  const pixelsPerTurnX = 2100;
  const nearTurn = panFromUnwrappedAngles(0, Math.PI * 1.95, pixelsPerTurnX, 980);
  const overTurn = panFromUnwrappedAngles(0, Math.PI * 2.05, pixelsPerTurnX, 980);
  const inverted = panFromUnwrappedAngles(0, Math.PI * 0.5, pixelsPerTurnX, 980, true);
  const normal = panFromUnwrappedAngles(0, Math.PI * 0.5, pixelsPerTurnX, 980, false);

  expect(overTurn.x).toBeGreaterThan(nearTurn.x);
  expect(Math.abs(overTurn.x - nearTurn.x)).toBeGreaterThan(60);
  expect(inverted.x).toBeCloseTo(-normal.x, 6);
});

test('pan supports axis-specific inversion', () => {
  const normal = panFromUnwrappedAngles(Math.PI * 0.25, Math.PI * 0.5, 2100, 980, false);
  const yawOnlyInverted = panFromUnwrappedAngles(Math.PI * 0.25, Math.PI * 0.5, 2100, 980, { pitch: false, yaw: true });

  expect(yawOnlyInverted.x).toBeCloseTo(-normal.x, 6);
  expect(yawOnlyInverted.y).toBeCloseTo(normal.y, 6);
});

test('wrapPanPixels constrains large unwrapped pan offsets while staying continuous', () => {
  const pixelsPerTurnX = 2100;
  const wrappedOne = wrapPanPixels(0.9 * pixelsPerTurnX, pixelsPerTurnX);
  const wrappedTwo = wrapPanPixels(1.1 * pixelsPerTurnX, pixelsPerTurnX);

  expect(wrappedOne).toBeCloseTo(-210, 6);
  expect(wrappedTwo).toBeCloseTo(210, 6);
});

test('stays stable near high pitch without gimbal lock jumps', () => {
  const base = quaternionFromAxisAngle([1, 0, 0], 88);
  const nearA = normalizeQuaternion(multiplyQuaternions(quaternionFromAxisAngle([0, 1, 0], 8), base));
  const nearB = normalizeQuaternion(multiplyQuaternions(quaternionFromAxisAngle([0, 1, 0], 9), base));

  const motionA = motionFromRelativeQuaternion(nearA, 1);
  const motionB = motionFromRelativeQuaternion(nearB, 1);

  expect(Number.isFinite(motionA.x)).toBe(true);
  expect(Number.isFinite(motionA.y)).toBe(true);
  expect(Number.isFinite(motionB.x)).toBe(true);
  expect(Number.isFinite(motionB.y)).toBe(true);
  expect(Math.abs(motionA.x - motionB.x)).toBeLessThan(0.2);
  expect(Math.abs(motionA.y - motionB.y)).toBeLessThan(0.2);
});

test('screen orientation remaps axes while preserving motion magnitude', () => {
  const base = orientationToQuaternion({ alpha: 0, beta: 0, gamma: 0, screenOrientationAngle: 0 });
  const portraitTilt = orientationToQuaternion({ alpha: 0, beta: 18, gamma: 0, screenOrientationAngle: 0 });
  const landscapeReference = orientationToQuaternion({ alpha: 0, beta: 0, gamma: 0, screenOrientationAngle: 90 });
  const landscapeTilt = orientationToQuaternion({ alpha: 0, beta: 18, gamma: 0, screenOrientationAngle: 90 });

  const portraitRelative = relativeQuaternion(base, portraitTilt);
  const landscapeRelative = relativeQuaternion(landscapeReference, landscapeTilt);

  const portraitMotion = motionFromRelativeQuaternion(portraitRelative, 1);
  const landscapeMotion = motionFromRelativeQuaternion(landscapeRelative, 1);

  const portraitMagnitude = Math.hypot(portraitMotion.x, portraitMotion.y);
  const landscapeMagnitude = Math.hypot(landscapeMotion.x, landscapeMotion.y);

  expect(portraitMagnitude).toBeCloseTo(landscapeMagnitude, 3);
  expect(Math.abs(portraitMotion.x)).toBeCloseTo(Math.abs(landscapeMotion.y), 3);
  expect(Math.abs(portraitMotion.y)).toBeCloseTo(Math.abs(landscapeMotion.x), 3);
});

test('applies dead-zone threshold for jitter suppression', () => {
  expect(applyDeadZone(0.005, 0.01)).toBe(0);
  expect(applyDeadZone(-0.02, 0.01)).toBe(-0.02);
});

test('rotates vectors by quaternion without changing length', () => {
  const q = orientationToQuaternion({ alpha: 0, beta: 35, gamma: -10, screenOrientationAngle: 0 });
  const v = rotateVector([0, 0, 1], q);
  const length = Math.hypot(v[0], v[1], v[2]);
  expect(length).toBeCloseTo(1, 6);
});

test('axis-angle quaternion rotates basis as expected', () => {
  const quarterTurnZ = quaternionFromAxisAngle([0, 0, 1], 90);
  const rotated = rotateVector([1, 0, 0], quarterTurnZ);
  expect(rotated[0]).toBeCloseTo(0, 6);
  expect(rotated[1]).toBeCloseTo(1, 6);
  expect(rotated[2]).toBeCloseTo(0, 6);
});

test('quaternion multiplication composes rotations in order', () => {
  const pitch = quaternionFromAxisAngle([1, 0, 0], 25);
  const yaw = quaternionFromAxisAngle([0, 1, 0], -30);
  const combined = normalizeQuaternion(multiplyQuaternions(yaw, pitch));

  const step = rotateVector(rotateVector([0, 0, 1], pitch), yaw);
  const direct = rotateVector([0, 0, 1], combined);

  expect(direct[0]).toBeCloseTo(step[0], 6);
  expect(direct[1]).toBeCloseTo(step[1], 6);
  expect(direct[2]).toBeCloseTo(step[2], 6);
});

test('unwrapAngleRadians preserves continuity across the branch cut', () => {
  expect(unwrapAngleRadians(Math.PI * 0.95, -Math.PI * 0.95)).toBeCloseTo(Math.PI * 1.05, 6);
});
