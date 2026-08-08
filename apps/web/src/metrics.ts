import type { HostMetricsSample } from './types';

export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

export function memoryPercent(sample: Pick<HostMetricsSample, 'memoryUsedBytes' | 'memoryTotalBytes'>): number {
  return sample.memoryTotalBytes ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100 : 0;
}
