import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Cpu, MemoryStick } from 'lucide-react';
import { useLoad } from '../hooks';
import { api } from '../api';
import { memoryPercent } from '../metrics';
import { DitherSparkline } from './DitherSparkline';

function equalMetrics(current: Awaited<ReturnType<typeof api.metrics>>, next: Awaited<ReturnType<typeof api.metrics>>) {
  return current.timestamp === next.timestamp;
}

export function SystemWidget() {
  const { data, reload } = useLoad(api.metrics, [], equalMetrics);
  useEffect(() => {
    const refresh = window.setInterval(() => void reload(false), 2_000);
    return () => { window.clearInterval(refresh); };
  }, [reload]);
  if (!data?.history) return <Link to="/system" className="system-widget system-widget-empty" aria-label="System performance">
    <span className="muted">System…</span>
  </Link>;
  const memPercent = memoryPercent(data);
  const cpuHistory = data.history.map((sample) => sample.cpuPercent);
  const memHistory = data.history.map((sample) => memoryPercent(sample));
  return <Link to="/system" className="system-widget" aria-label={`System performance, ${data.cpuPercent.toFixed(0)} percent CPU, ${memPercent.toFixed(0)} percent memory. View details.`}>
    <div className="system-widget-metric">
      <Cpu size={14} />
      <span className="system-widget-value">{data.cpuPercent.toFixed(0)}<small>%</small></span>
      <DitherSparkline values={cpuHistory} className="system-widget-spark" cell={1} />
    </div>
    <div className="system-widget-metric">
      <MemoryStick size={14} />
      <span className="system-widget-value">{memPercent.toFixed(0)}<small>%</small></span>
      <DitherSparkline values={memHistory} className="system-widget-spark" cell={1} />
    </div>
    <ChevronRight className="system-widget-chevron" size={16} aria-hidden="true" />
  </Link>;
}
