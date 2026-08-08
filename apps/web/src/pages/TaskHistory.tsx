import { useState } from 'react';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { elapsed, useLoad } from '../hooks';
import { TaskStatusBadge } from '../components/Status';
import type { TaskSummary } from '../types';

const ACTIVE_STATES = ['queued', 'starting', 'running', 'stopping'];

export function TaskHistory() {
  const { id = '' } = useParams();
  const repository = useLoad(() => api.repository(id), [id]);
  const tasks = useLoad(() => api.tasks(id), [id]);
  const [error, setError] = useState('');

  async function remove(task: TaskSummary) {
    if (!confirm(`Delete "${task.title ?? 'this conversation'}"? This cannot be undone.`)) return;
    try { await api.deleteTask(task.id); tasks.setData((tasks.data ?? []).filter((item) => item.id !== task.id)); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete conversation'); }
  }

  return <main className="page history-page" data-testid="task-history-page">
    <header className="page-heading"><Link to={`/repositories/${id}`} className="icon-button" aria-label="Back to repository"><ArrowLeft /></Link><div><p className="eyebrow">{repository.data?.name}</p><h1>Manage history</h1></div></header>
    {error && <div className="notice error" role="alert">{error}</div>}
    {tasks.loading && <div className="empty">Loading conversations…</div>}
    {!tasks.loading && !tasks.data?.length && <div className="empty"><h2>No conversations yet</h2></div>}
    <section className="history-list">
      {tasks.data?.map((task) => <article className="history-row" key={task.id} data-testid={`history-row-${task.id}`}>
        <div className="history-main"><strong>{task.title ?? 'Developer task'}</strong><div className="history-meta"><TaskStatusBadge status={task.status} /><time>{elapsed(task.createdAt)} ago</time></div></div>
        <button className="icon-button" aria-label={`Delete conversation ${task.title ?? task.id}`} disabled={ACTIVE_STATES.includes(task.status)} onClick={() => void remove(task)} data-testid={`delete-${task.id}`}><Trash2 /></button>
      </article>)}
    </section>
  </main>;
}
