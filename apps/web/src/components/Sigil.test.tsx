import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AmbientSigil } from './Sigil';

const setView = vi.fn();

vi.mock('../virtualWindowRenderer', () => ({
  createVirtualWindowRenderer: vi.fn(() => ({ setView, resize: vi.fn(), dispose: vi.fn() }))
}));

let animationFrame: FrameRequestCallback | undefined;

function dispatchOrientation(alpha: number, beta: number, gamma: number) {
  const event = new Event('deviceorientation');
  Object.defineProperties(event, {
    alpha: { value: alpha },
    beta: { value: beta },
    gamma: { value: gamma }
  });
  window.dispatchEvent(event);
}

afterEach(() => {
  window.localStorage.clear();
  setView.mockReset();
  animationFrame = undefined;
  vi.unstubAllGlobals();
});

test('moves the virtual window on the first tilt after calibration', () => {
  window.localStorage.setItem('jarvis.motionPermission.state', 'granted');
  window.localStorage.setItem('jarvis.motionBackground.enabled', '1');
  vi.stubGlobal('DeviceOrientationEvent', function DeviceOrientationEvent() {});
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    animationFrame = callback;
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  render(<AmbientSigil />);
  setView.mockClear();
  dispatchOrientation(0, 0, 0);
  dispatchOrientation(0, 20, 0);
  animationFrame?.(100);

  expect(setView).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.any(Number));
  const [yaw, pitch] = setView.mock.calls.at(-1)!;
  expect(Math.hypot(yaw, pitch)).toBeGreaterThan(0.01);
});