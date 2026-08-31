import { useState } from 'react';
import { ArrowLeft, ExternalLink, Power, Radio, RefreshCw, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useLoad } from '../hooks';
import { AmbientSigil } from '../components/Sigil';
import type { Deployment, DeploymentAction } from '../types';

export function Settings() {
  const { data: forwards = [], loading, error: loadError, reload } = useLoad(api.portForwards, []);
  const { data: deployments = [], loading: deploymentsLoading, error: deploymentsLoadError,
    reload: reloadDeployments } = useLoad(api.deployments, []);
  const [error, setError] = useState('');
  const [deploymentError, setDeploymentError] = useState('');
  const [deploymentMessage, setDeploymentMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stoppingPort, setStoppingPort] = useState<number>();
  const [deploymentAction, setDeploymentAction] = useState<{ id: string; action: DeploymentAction }>();

  async function expose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const port = Number(data.get('port'));
    setSubmitting(true);
    try { await api.exposePort(port); setError(''); await reload(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to expose port'); }
    finally { setSubmitting(false); }
  }

  async function stop(port: number) {
    setStoppingPort(port);
    try { await api.closePort(port); setError(''); await reload(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to stop sharing'); }
    finally { setStoppingPort(undefined); }
  }

  async function control(deployment: Deployment, action: DeploymentAction) {
    if (deployment.kind === 'self' && !confirm(deployment.warning ?? 'Restart Jarvis? This may interrupt active work.')) return;
    setDeploymentAction({ id: deployment.id, action });
    setDeploymentMessage('');
    setDeploymentError('');
    try {
      const result = await api.deploymentAction(deployment.id, action);
      if (result.scheduled) {
        setDeploymentMessage('Jarvis restart scheduled. Waiting for the dashboard to reconnect…');
        await waitForJarvis();
        setDeploymentMessage('Jarvis restarted.');
      }
      await reloadDeployments(false);
    } catch (reason) { setDeploymentError(reason instanceof Error ? reason.message : `Unable to ${action} ${deployment.name}`); }
    finally { setDeploymentAction(undefined); }
  }

  return <main className="detail-page settings-detail" data-testid="settings-page">
    <AmbientSigil />
    <header className="detail-header"><Link to="/" className="icon-button" aria-label="Back to repositories"><ArrowLeft /></Link><div><h1>General settings</h1><p>Jarvis host controls</p></div></header>
    <div className="detail-content settings-content">
      <section className="settings-section" aria-labelledby="deployments-title">
        <div><p className="eyebrow">Host processes</p><h2 id="deployments-title">Managed deployments</h2><p className="muted">Start, stop, or restart tools installed under Jarvis management.</p></div>
        {(deploymentError || deploymentsLoadError) && <div className="notice error" role="alert">{deploymentError || deploymentsLoadError}</div>}
        {deploymentMessage && <div className="notice" role="status">{deploymentMessage}</div>}
        {!deploymentsLoading && deployments.length === 0 && <p className="muted">No managed deployments are installed.</p>}
        <div className="deployment-list">
          {deployments.map((deployment) => {
            const pending = deploymentAction?.id === deployment.id;
            const active = deployment.state === 'running' || deployment.state === 'starting';
            const toggleAction: DeploymentAction = active ? 'stop' : 'start';
            return <div className="deployment-row" key={deployment.id}>
              <div className="deployment-summary">
                <div><strong>{deployment.name}</strong><span className={`deployment-state ${deployment.state}`}>{deployment.state}</span></div>
                {deployment.healthy === false && <p>Process is running but its health check failed.</p>}
                {deployment.detail && <p>{deployment.detail}</p>}
              </div>
              <div className="deployment-actions">
                {deployment.actions.includes('start') && deployment.actions.includes('stop') && <button type="button" role="switch" aria-checked={active} aria-label={`${active ? 'Stop' : 'Start'} ${deployment.name}`} className="deployment-switch" disabled={pending || deployment.state === 'unavailable'} onClick={() => void control(deployment, toggleAction)}><span /><Power size={15} /></button>}
                {deployment.actions.includes('restart') && <button type="button" className="icon-button" aria-label={`Restart ${deployment.name}`} title={`Restart ${deployment.name}`} disabled={pending || deployment.state === 'unavailable'} onClick={() => void control(deployment, 'restart')}><RefreshCw className={pending && deploymentAction.action === 'restart' ? 'spin' : ''} /></button>}
              </div>
            </div>;
          })}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="port-forward-title">
        <div><p className="eyebrow">Tailnet access</p><h2 id="port-forward-title">Expose a local port</h2><p className="muted">Publish a running local web tool through private Tailscale HTTPS.</p></div>
        <form className="port-forward-form" onSubmit={expose}>
          <label htmlFor="port">Local port<input id="port" name="port" type="number" inputMode="numeric" min="1" max="65535" defaultValue="8080" required /></label>
          <button className="button primary" disabled={submitting}><Radio size={17} />{submitting ? 'Exposing…' : 'Expose port'}</button>
        </form>
        {(error || loadError) && <div className="notice error" role="alert">{error || loadError}</div>}
        {!loading && forwards.length === 0 && <p className="muted">No ports are currently shared.</p>}
        {forwards.map((forward) => <div className="port-forward-result" role="status" key={forward.port}>
          <span>Tailnet link · port {forward.port}</span>
          <a href={forward.url} target="_blank" rel="noreferrer">{forward.url}<ExternalLink size={16} /></a>
          <button type="button" className="button secondary compact" onClick={() => void stop(forward.port)} disabled={stoppingPort === forward.port}><Square size={14} />{stoppingPort === forward.port ? 'Stopping…' : 'Stop sharing'}</button>
        </div>)}
      </section>
    </div>
  </main>;
}

async function waitForJarvis(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await api.health(); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 1_000)); }
  }
  throw new Error('Jarvis did not reconnect after restarting');
}
