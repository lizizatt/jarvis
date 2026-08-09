type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export type MotionPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';
export const MOTION_PERMISSION_EVENT = 'jarvis:motion-permission-change';
export const MOTION_BACKGROUND_EVENT = 'jarvis:motion-background-change';
const MOTION_BACKGROUND_KEY = 'jarvis.motionBackground.enabled';
const MOTION_PERMISSION_KEY = 'jarvis.motionPermission.state';

function orientationType() {
  if (typeof window === 'undefined') return undefined;
  return window.DeviceOrientationEvent as DeviceOrientationWithPermission | undefined;
}

function readStoredPermissionState(): Exclude<MotionPermissionState, 'prompt'> | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage.getItem(MOTION_PERMISSION_KEY);
    if (value === 'granted' || value === 'denied' || value === 'unsupported') return value;
  } catch {
    // Ignore storage failures.
  }
  return undefined;
}

function storePermissionState(state: Exclude<MotionPermissionState, 'prompt'>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOTION_PERMISSION_KEY, state);
  } catch {
    // Ignore storage failures.
  }
}

export function getMotionPermissionState(): MotionPermissionState {
  const orientation = orientationType();
  if (!orientation) return 'unsupported';
  if (typeof orientation.requestPermission === 'function') {
    const stored = readStoredPermissionState();
    return stored ?? 'prompt';
  }
  return 'granted';
}

export async function requestMotionPermission(): Promise<Exclude<MotionPermissionState, 'prompt'>> {
  const orientation = orientationType();
  if (!orientation) {
    storePermissionState('unsupported');
    return 'unsupported';
  }
  if (typeof orientation.requestPermission === 'function') {
    try {
      const permission = await orientation.requestPermission();
      storePermissionState(permission);
      return permission;
    } catch {
      storePermissionState('denied');
      return 'denied';
    }
  }
  storePermissionState('granted');
  return 'granted';
}

export function isMotionBackgroundEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(MOTION_BACKGROUND_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    return getMotionPermissionState() === 'granted';
  } catch {
    return getMotionPermissionState() === 'granted';
  }
}

export function setMotionBackgroundEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOTION_BACKGROUND_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage failures (private mode / blocked storage).
  }
  window.dispatchEvent(new CustomEvent(MOTION_BACKGROUND_EVENT, { detail: enabled }));
}

export function announceMotionPermission(state: Exclude<MotionPermissionState, 'prompt'>) {
  if (typeof window === 'undefined') return;
  storePermissionState(state);
  window.dispatchEvent(new CustomEvent(MOTION_PERMISSION_EVENT, { detail: state }));
}
