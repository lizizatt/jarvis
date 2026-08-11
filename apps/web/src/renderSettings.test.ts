import { SIGIL_FRAME_RATE_EVENT, getSigilFrameRate, setSigilFrameRate } from './renderSettings';

afterEach(() => {
  window.localStorage.removeItem('jarvis.sigilFrameRate.fps');
});

test('defaults to 24 fps when nothing is stored', () => {
  expect(getSigilFrameRate()).toBe(24);
});

test('persists and announces a new frame rate', () => {
  const listener = vi.fn();
  window.addEventListener(SIGIL_FRAME_RATE_EVENT, listener);

  setSigilFrameRate(30);

  expect(getSigilFrameRate()).toBe(30);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: 30 }));
  window.removeEventListener(SIGIL_FRAME_RATE_EVENT, listener);
});

test('ignores invalid stored values', () => {
  window.localStorage.setItem('jarvis.sigilFrameRate.fps', 'not-a-number');
  expect(getSigilFrameRate()).toBe(24);
});
