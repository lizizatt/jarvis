import { formatBytes, memoryPercent } from './metrics';

test('formats memory values and handles a zero total', () => {
  expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
  expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  expect(memoryPercent({ memoryUsedBytes: 10, memoryTotalBytes: 0 })).toBe(0);
});