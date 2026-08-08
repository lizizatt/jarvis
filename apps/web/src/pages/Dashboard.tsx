import { useEffect } from 'react';
import { ArrowDown, ArrowUp, GitBranch, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { elapsed, useLoad } from '../hooks';
import { TaskStatusBadge } from '../components/Status';
import { PwaControls } from '../components/PwaControls';

export function Dashboard() {
  const { data: repositories = [], setData, error, loading, reload } = useLoad(api.repositories, []);

  useEffect(() => {
    const refresh = window.setInterval(() => void reload(), 2_000);
    return () => { window.clearInterval(refresh); };
  }, [reload]);

  return <main className="page dashboard" data-testid="dashboard">
    <header className="page-heading"><div><p className="eyebrow">Laptop control plane</p><h1>Repositories</h1><p className="muted">{repositories.length} server-managed checkout{repositories.length === 1 ? '' : 's'}</p></div><div className="heading-actions"><PwaControls /></div></header>
    {error && <div className="notice error" role="alert">{error}</div>}
    {loading && <div className="empty">Loading repositories…</div>}
    {!loading && repositories.length === 0 && <div className="empty"><GitBranch size={28} /><h2>No checkouts configured</h2><p>Register repositories from the Jarvis server.</p></div>}
    <section className="repo-list" aria-label="Registered repositories">
      {repositories.map((repo) => <article className="repo-row" key={repo.id} data-testid={`repository-${repo.id}`}>
        <Link className="repo-main" to={`/repositories/${repo.id}`}>
          <div className="repo-title"><h2>{repo.name}</h2>{repo.status?.dirty && <span className="dirty">Modified</span>}</div>
          <div className="git-facts"><span><GitBranch size={15} />{repo.status?.branch ?? repo.defaultBranch ?? 'unknown'}</span><span><ArrowUp size={14} />{repo.status?.ahead ?? 0}</span><span><ArrowDown size={14} />{repo.status?.behind ?? 0}</span></div>
          {repo.activeTask ? <div className="activity"><TaskStatusBadge status={repo.activeTask.status} /><strong>{repo.activeTask.latestAction ?? repo.activeTask.title ?? 'Agent is working'}</strong><time>{elapsed(repo.activeTask.startedAt ?? repo.activeTask.createdAt)}</time></div> : <p className="idle">Ready for a new task</p>}
        </Link>
        {repo.activeTask && ['queued', 'starting', 'running', 'stopping'].includes(repo.activeTask.status) && <button className="button stop compact" aria-label={`Stop task in ${repo.name}`} disabled={repo.activeTask.status === 'stopping'} onClick={() => { if (confirm(`Stop the active task in ${repo.name}?`)) { setData(repositories.map((item) => item.id === repo.id && item.activeTask ? { ...item, activeTask: { ...item.activeTask, status: 'stopping' } } : item)); void api.stop(repo.activeTask!.id).catch(() => reload()); } }}><Square size={14} />{repo.activeTask.status === 'stopping' ? 'Stopping' : 'Stop'}</button>}
      </article>)}
    </section>
  </main>;
}
