import {
  MOTION_LPF_TAU_DEFAULT,
  MOTION_LPF_TAU_EVENT,
  clampMotionLpfTauMs,
  getMotionLpfTauMs,
  setMotionLpfTauMs
} from './motionFilterSettings';

afterEach(() => {
  window.localStorage.removeItem('jarvis.motionLpfTauMs');
});

test('returns default LPF duration when no value is stored', () => {
  expect(getMotionLpfTauMs()).toBe(MOTION_LPF_TAU_DEFAULT);
});

test('clamps LPF duration writes and dispatches an update event', () => {
  const listener = vi.fn();
  window.addEventListener(MOTION_LPF_TAU_EVENT, listener as EventListener);

  setMotionLpfTauMs(9999);

  expect(window.localStorage.getItem('jarvis.motionLpfTauMs')).toBe('5000');
  expect(listener).toHaveBeenCalledTimes(1);
  expect((listener.mock.calls[0]?.[0] as CustomEvent<number>).detail).toBe(5000);

  window.removeEventListener(MOTION_LPF_TAU_EVENT, listener as EventListener);
});

test('clamp helper bounds invalid numbers', () => {
  expect(clampMotionLpfTauMs(Number.NaN)).toBe(MOTION_LPF_TAU_DEFAULT);
  expect(clampMotionLpfTauMs(-5)).toBe(0);
  expect(clampMotionLpfTauMs(5005)).toBe(5000);
});
