import { ArrowLeft, Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { AmbientSigil } from '../components/Sigil';
import { DitherSparkline } from '../components/DitherSparkline';
import { formatBytes, memoryPercent } from '../metrics';
import type { CopilotUsage, HostMetrics } from '../types';

function equalMetrics(current: HostMetrics, next: HostMetrics) {
  return current.timestamp === next.timestamp;
}

export function SystemDetail() {
  const { data, error, loading, reload } = useLoad(api.metrics, [], equalMetrics);
  const { data: copilot, reload: reloadCopilot } = useLoad(api.copilotUsage, []);
  useEffect(() => {
    const refresh = window.setInterval(() => void reload(false), 2_000);
    const refreshCopilot = window.setInterval(() => void reloadCopilot(false), 60_000);
    return () => { window.clearInterval(refresh); window.clearInterval(refreshCopilot); };
  }, [reload, reloadCopilot]);

  return <main className="detail-page system-detail" data-testid="system-detail">
    <AmbientSigil />
    <header className="detail-header"><Link to="/" className="icon-button" aria-label="Back to repositories"><ArrowLeft /></Link><div><h1>System performance</h1><p>Host CPU and memory</p></div></header>
    <div className="detail-content system-content">
      {loading && !data?.history && <div className="empty">Loading metrics…</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {data?.history && <SystemBody metrics={data} copilot={copilot ?? null} />}
    </div>
  </main>;
}

function SystemBody({ metrics, copilot }: { metrics: HostMetrics; copilot: CopilotUsage | null }) {
  const memPercent = memoryPercent(metrics);
  const cpuHistory = metrics.history.map((sample) => sample.cpuPercent);
  const memHistory = metrics.history.map((sample) => memoryPercent(sample));
  const stale = Date.now() - new Date(metrics.timestamp).getTime() > 15_000;
  return <>
    {stale && <div className="notice" role="status">Metrics feed is stale. Last sample {new Date(metrics.timestamp).toLocaleTimeString()}.</div>}
    <section className="metric-grid">
      <div className="metric-card">
        <div className="metric-head"><span>CPU</span><span>{metrics.cpuCount} cores</span></div>
        <div className="metric-value">{metrics.cpuPercent.toFixed(0)}<small>%</small></div>
        <DitherSparkline values={cpuHistory} className="metric-chart" />
      </div>
      <div className="metric-card">
        <div className="metric-head"><span>Memory</span><span>{formatBytes(metrics.memoryTotalBytes)}</span></div>
        <div className="metric-value">{memPercent.toFixed(0)}<small>%</small></div>
        <DitherSparkline values={memHistory} className="metric-chart" />
        <p className="metric-detail">{formatBytes(metrics.memoryUsedBytes)} used of {formatBytes(metrics.memoryTotalBytes)}</p>
      </div>
      {copilot && <div className="metric-card">
        <div className="metric-head"><span>Copilot credits</span><Coins size={14} /></div>
        <div className="metric-value">{copilot.creditsUsed.toLocaleString()}</div>
        <p className="metric-detail">Premium interactions this cycle · resets {new Date(copilot.quotaResetDate).toLocaleDateString()}</p>
      </div>}
    </section>
    <section className="core-grid" aria-label="Per-core load">
      {metrics.perCorePercent.map((percent, index) => <div className="core-row" key={index}>
        <span className="core-label">C{index}</span>
        <div className="core-bar"><div className="core-bar-fill" style={{ width: `${Math.round(percent)}%` }} /></div>
        <span className="core-percent">{percent.toFixed(0)}%</span>
      </div>)}
    </section>
    <section className="load-average" aria-label="Load average">
      <div className="metric-head"><span>Load average</span><span>1 / 5 / 15 min</span></div>
      <div className="load-values">{metrics.loadAverage.map((value, index) => <span key={index}>{value.toFixed(2)}</span>)}</div>
    </section>
    <p className="metric-timestamp">Sampled {new Date(metrics.timestamp).toLocaleTimeString()}</p>
  </>;
}
