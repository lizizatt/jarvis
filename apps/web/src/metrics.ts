import type { HostMetricsSample } from './types';

export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

export function memoryPercent(sample: Pick<HostMetricsSample, 'memoryUsedBytes' | 'memoryTotalBytes'>): number {
  return sample.memoryTotalBytes ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100 : 0;
}

export function sparklinePath(values: number[], width: number, height: number, max = 100): string {
  if (values.length < 2) return '';
  const step = width / (values.length - 1);
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)} ${(height - (Math.min(value, max) / max) * height).toFixed(1)}`).join(' ');
}
