import {
  getMotionPermissionState,
  isMotionBackgroundEnabled,
  requestMotionPermission,
  setMotionBackgroundEnabled,
  type MotionPermissionState
} from './motion';

type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

const originalOrientation = window.DeviceOrientationEvent;

function mockOrientation(permissionImpl?: () => Promise<'granted' | 'denied'>) {
  const ctor = function MockOrientation() {} as unknown as DeviceOrientationWithPermission;
  if (permissionImpl) ctor.requestPermission = permissionImpl;
  Object.defineProperty(window, 'DeviceOrientationEvent', {
    configurable: true,
    writable: true,
    value: ctor
  });
}

function clearStorage() {
  window.localStorage.removeItem('jarvis.motionBackground.enabled');
  window.localStorage.removeItem('jarvis.motionPermission.state');
}

afterEach(() => {
  clearStorage();
  Object.defineProperty(window, 'DeviceOrientationEvent', {
    configurable: true,
    writable: true,
    value: originalOrientation
  });
});

test('defaults motion background to enabled after permission is granted', async () => {
  mockOrientation(() => Promise.resolve('granted'));
  await expect(requestMotionPermission()).resolves.toBe('granted');
  expect(isMotionBackgroundEnabled()).toBe(true);
});

test('respects explicit motion background toggle off in local storage', async () => {
  mockOrientation(() => Promise.resolve('granted'));
  await expect(requestMotionPermission()).resolves.toBe('granted');
  setMotionBackgroundEnabled(false);
  expect(isMotionBackgroundEnabled()).toBe(false);
});

test('reports prompt when iOS-style permission API exists and no stored state', () => {
  mockOrientation(() => Promise.resolve('granted'));
  expect(getMotionPermissionState()).toBe('prompt' satisfies MotionPermissionState);
});
