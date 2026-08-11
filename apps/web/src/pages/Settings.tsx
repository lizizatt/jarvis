import { useState } from 'react';
import { ArrowLeft, ExternalLink, Radio, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useLoad } from '../hooks';
import { AmbientSigil } from '../components/Sigil';

export function Settings() {
  const { data: forwards = [], loading, error: loadError, reload } = useLoad(api.portForwards, []);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stoppingPort, setStoppingPort] = useState<number>();

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

  return <main className="detail-page settings-detail" data-testid="settings-page">
    <AmbientSigil />
    <header className="detail-header"><Link to="/" className="icon-button" aria-label="Back to repositories"><ArrowLeft /></Link><div><h1>General settings</h1><p>Jarvis host controls</p></div></header>
    <div className="detail-content settings-content">
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
