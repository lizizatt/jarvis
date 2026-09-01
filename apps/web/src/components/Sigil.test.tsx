import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { EARTH_ORBIT_PERIOD_SECONDS } from '../virtualWindowMotion';
import { AmbientSigil } from './Sigil';

const { setView, setHorizonDebug, createVirtualWindowRenderer } = vi.hoisted(() => {
  const setView = vi.fn();
  const setHorizonDebug = vi.fn();
  return {
    setView,
    setHorizonDebug,
    createVirtualWindowRenderer: vi.fn(() => ({ setView, setHorizonDebug, resize: vi.fn(), dispose: vi.fn() }))
  };
});

vi.mock('../virtualWindowRenderer', () => ({
  createVirtualWindowRenderer
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
  setHorizonDebug.mockReset();
  createVirtualWindowRenderer.mockClear();
  animationFrame = undefined;
  vi.unstubAllGlobals();
});

test('only preserves the WebGL drawing buffer for screenshot harness captures', () => {
  const normalMount = render(<AmbientSigil />);
  expect(createVirtualWindowRenderer).toHaveBeenLastCalledWith(
    expect.any(HTMLCanvasElement),
    '/media/starmap_2020_4k.webp',
    { preserveDrawingBuffer: false }
  );
  normalMount.unmount();

  window.history.replaceState({}, '', '/?digitalWindowHarness=profile');
  const harnessMount = render(<AmbientSigil />);
  expect(createVirtualWindowRenderer).toHaveBeenLastCalledWith(
    expect.any(HTMLCanvasElement),
    '/media/starmap_2020_4k.webp',
    { preserveDrawingBuffer: true }
  );
  harnessMount.unmount();
  window.history.replaceState({}, '', '/');
});

test('keeps the earth orbit anchored to GMT wall-clock time across remounts', () => {
  const gmtMilliseconds = Date.UTC(2026, 7, 31, 12, 34, 56);
  const expectedOrbitPhase = gmtMilliseconds / 1000 % EARTH_ORBIT_PERIOD_SECONDS;
  vi.spyOn(Date, 'now').mockReturnValue(gmtMilliseconds);

  const firstMount = render(<AmbientSigil />);
  const firstOrbitPhase = setView.mock.calls.at(-1)?.[4];
  firstMount.unmount();

  setView.mockClear();
  const secondMount = render(<AmbientSigil />);
  const secondOrbitPhase = setView.mock.calls.at(-1)?.[4];
  secondMount.unmount();

  expect(firstOrbitPhase).toBe(expectedOrbitPhase);
  expect(secondOrbitPhase).toBe(expectedOrbitPhase);
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

  expect(setView).toHaveBeenCalledWith(
    expect.any(Number),
    expect.any(Number),
    expect.any(Number),
    expect.any(Number),
    expect.any(Number)
  );
  const [yaw, pitch] = setView.mock.calls.at(-1)!;
  expect(Math.hypot(yaw, pitch)).toBeGreaterThan(0.01);
});

test('keeps five subsequent frames stable under tiny hand-shake motion', () => {
  window.localStorage.setItem('jarvis.motionPermission.state', 'granted');
  window.localStorage.setItem('jarvis.motionBackground.enabled', '1');
  vi.stubGlobal('DeviceOrientationEvent', function DeviceOrientationEvent() {});
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    animationFrame = callback;
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);

  render(<AmbientSigil />);
  setView.mockClear();

  dispatchOrientation(0, 0, 0);

  const frames: Array<{ yaw: number; pitch: number }> = [];
  const tinyShakes = [6, -6, 5.5, -5.5, 6];
  for (const beta of tinyShakes) {
    now += 20;
    dispatchOrientation(0, beta, 0);
    animationFrame?.(now);
    const [yaw, pitch] = setView.mock.calls.at(-1) ?? [0, 0];
    frames.push({ yaw, pitch });
  }

  const deltas = frames.slice(1).map((frame, index) => {
    const previous = frames[index];
    return Math.hypot(frame.yaw - previous.yaw, frame.pitch - previous.pitch);
  });

  expect(deltas).toHaveLength(4);
  expect(Math.max(...deltas)).toBeLessThan(0.02);
});
