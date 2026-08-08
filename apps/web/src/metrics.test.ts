import { formatBytes, memoryPercent, sparklinePath } from './metrics';

test('formats memory values and handles a zero total', () => {
  expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
  expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  expect(memoryPercent({ memoryUsedBytes: 10, memoryTotalBytes: 0 })).toBe(0);
});

test('only draws a sparkline when at least two points are available', () => {
  expect(sparklinePath([], 60, 20)).toBe('');
  expect(sparklinePath([50], 60, 20)).toBe('');
  expect(sparklinePath([0, 100], 60, 20)).toBe('M0.0 20.0 L60.0 0.0');
});