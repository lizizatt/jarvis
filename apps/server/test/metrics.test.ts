import type os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostMetricsSampler } from '../src/metrics.js';

type CpuTimes = os.CpuInfo['times'];

function cpu(times: Partial<CpuTimes>): os.CpuInfo {
  return { model: 'test', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times } };
}

function source(samples: os.CpuInfo[][]) {
  let index = 0;
  return {
    cpus: () => samples[Math.min(index++, samples.length - 1)] ?? [],
    totalmem: () => 1_000,
    freemem: () => 250,
    loadavg: () => [1, 2, 3]
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('HostMetricsSampler', () => {
  it('reports a zero first sample and supports hosts with no visible cores', () => {
    vi.useFakeTimers();
    const sampler = new HostMetricsSampler(source([]));
    expect(sampler.current()).toMatchObject({ cpuCount: 0, cpuPercent: 0, perCorePercent: [], memoryUsedBytes: 750 });
    sampler.close();
  });

  it('uses aggregate CPU time deltas instead of averaging core percentages', () => {
    vi.useFakeTimers();
    const sampler = new HostMetricsSampler(source([
      [cpu({ idle: 90, user: 10 }), cpu({ idle: 90, user: 10 })],
      [cpu({ idle: 90, user: 20 }), cpu({ idle: 180, user: 20 })]
    ]));
    vi.advanceTimersByTime(2_000);
    expect(sampler.current().perCorePercent).toEqual([100, 10]);
    expect(sampler.current().cpuPercent).toBeCloseTo(18.18, 2);
    sampler.close();
  });

  it('ignores a core whose counters reset', () => {
    vi.useFakeTimers();
    const sampler = new HostMetricsSampler(source([
      [cpu({ idle: 90, user: 10 }), cpu({ idle: 90, user: 10 })],
      [cpu({ idle: 5, user: 5 }), cpu({ idle: 180, user: 20 })]
    ]));
    vi.advanceTimersByTime(2_000);
    expect(sampler.current()).toMatchObject({ cpuPercent: 10, perCorePercent: [0, 10] });
    sampler.close();
  });

  it('keeps only 60 samples, returns a snapshot, and clears its interval', () => {
    vi.useFakeTimers();
    const sampler = new HostMetricsSampler(source([[cpu({ idle: 1 })]]));
    vi.advanceTimersByTime(120_000);
    const current = sampler.current();
    expect(current.history).toHaveLength(60);
    current.history.length = 0;
    expect(sampler.current().history).toHaveLength(60);
    expect(vi.getTimerCount()).toBe(1);
    sampler.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});