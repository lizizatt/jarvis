import { Link } from 'react-router-dom';
import { ChevronRight, Coins, Cpu, MemoryStick } from 'lucide-react';
import { useLoad, useVisiblePolling } from '../hooks';
import { api } from '../api';
import { memoryPercent } from '../metrics';

function equalMetrics(current: Awaited<ReturnType<typeof api.metrics>>, next: Awaited<ReturnType<typeof api.metrics>>) {
  return current.timestamp === next.timestamp;
}

export function SystemWidget() {
  const { data, reload } = useLoad(api.metrics, [], equalMetrics);
  const { data: copilot, reload: reloadCopilot } = useLoad(api.copilotUsage, []);
  useVisiblePolling(() => void reload(false), 2_000);
  useVisiblePolling(() => void reloadCopilot(false), 60_000);
  if (!data?.history) return <Link to="/system" className="system-widget system-widget-empty" aria-label="System performance">
    <span className="muted">System…</span>
  </Link>;
  const memPercent = memoryPercent(data);
  return <Link to="/system" className="system-widget" aria-label={`System performance, ${data.cpuPercent.toFixed(0)} percent CPU, ${memPercent.toFixed(0)} percent memory. View details.`}>
    <div className="system-widget-metric">
      <Cpu size={14} />
      <span className="system-widget-value">{data.cpuPercent.toFixed(0)}<small>%</small></span>
    </div>
    <div className="system-widget-metric">
      <MemoryStick size={14} />
      <span className="system-widget-value">{memPercent.toFixed(0)}<small>%</small></span>
    </div>
    {copilot != null && <div className="system-widget-metric system-widget-credits">
      <Coins size={14} />
      <span className="system-widget-value">{copilot.creditsUsed.toLocaleString()}</span>
    </div>}
    <ChevronRight className="system-widget-chevron" size={16} aria-hidden="true" />
  </Link>;
}
