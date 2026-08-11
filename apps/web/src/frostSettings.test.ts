import { FROST_BLUR_EVENT, getFrostBlur, setFrostBlur } from './frostSettings';

afterEach(() => {
  window.localStorage.removeItem('jarvis.frostBlur.px');
  document.documentElement.style.removeProperty('--panel-blur');
});

test('defaults to 8px when nothing is stored', () => {
  expect(getFrostBlur()).toBe(8);
});

test('persists, announces, and applies a new blur amount', () => {
  const listener = vi.fn();
  window.addEventListener(FROST_BLUR_EVENT, listener);

  setFrostBlur(0);

  expect(getFrostBlur()).toBe(0);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: 0 }));
  expect(document.documentElement.style.getPropertyValue('--panel-blur')).toBe('0px');
  window.removeEventListener(FROST_BLUR_EVENT, listener);
});

test('ignores invalid stored values', () => {
  window.localStorage.setItem('jarvis.frostBlur.px', 'not-a-number');
  expect(getFrostBlur()).toBe(8);
});
