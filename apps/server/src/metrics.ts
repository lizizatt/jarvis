import os from 'node:os';

export interface HostMetricsSample {
  timestamp: string;
  cpuPercent: number;
  perCorePercent: number[];
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  loadAverage: [number, number, number];
}

export interface HostMetrics extends HostMetricsSample {
  cpuCount: number;
  history: HostMetricsSample[];
}

interface CoreTimes { idle: number; total: number }

interface HostMetricsSource {
  cpus(): os.CpuInfo[];
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
}

const HISTORY_LIMIT = 60;
const SAMPLE_INTERVAL_MS = 2_000;

function coreTimes(cpu: os.CpuInfo): CoreTimes {
  const times = cpu.times;
  const total = times.user + times.nice + times.sys + times.idle + times.irq;
  return { idle: times.idle, total };
}

function deltaFrom(previous: CoreTimes, current: CoreTimes): CoreTimes | undefined {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  return totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta ? { idle: idleDelta, total: totalDelta } : undefined;
}

function percentFrom(previous: CoreTimes, current: CoreTimes): number {
  const delta = deltaFrom(previous, current);
  return delta ? ((delta.total - delta.idle) / delta.total) * 100 : 0;
}

export class HostMetricsSampler {
  private history: HostMetricsSample[] = [];
  private previousCoreTimes: CoreTimes[] = [];
  private timer: NodeJS.Timeout;

  constructor(private readonly source: HostMetricsSource = os, intervalMs = SAMPLE_INTERVAL_MS) {
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  private sample(): void {
    const cpus = this.source.cpus();
    const currentCoreTimes = cpus.map(coreTimes);
    const previousCoreTimes = currentCoreTimes.map((current, index) => this.previousCoreTimes[index] ?? current);
    const perCorePercent = currentCoreTimes.map((current, index) => percentFrom(previousCoreTimes[index], current));
    const totalDelta = currentCoreTimes.reduce((sum, current, index) => {
      const delta = deltaFrom(previousCoreTimes[index], current);
      return delta ? { idle: sum.idle + delta.idle, total: sum.total + delta.total } : sum;
    }, { idle: 0, total: 0 });
    this.previousCoreTimes = currentCoreTimes;
    const memoryTotalBytes = this.source.totalmem();
    const loadAverage = this.source.loadavg();
    const sample: HostMetricsSample = {
      timestamp: new Date().toISOString(),
      cpuPercent: totalDelta.total ? ((totalDelta.total - totalDelta.idle) / totalDelta.total) * 100 : 0,
      perCorePercent,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - this.source.freemem()),
      memoryTotalBytes,
      loadAverage: [loadAverage[0] ?? 0, loadAverage[1] ?? 0, loadAverage[2] ?? 0]
    };
    this.history.push(sample);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  current(): HostMetrics {
    const latest = this.history[this.history.length - 1];
    return { ...latest, cpuCount: latest.perCorePercent.length, history: [...this.history] };
  }

  close(): void {
    clearInterval(this.timer);
  }
}
