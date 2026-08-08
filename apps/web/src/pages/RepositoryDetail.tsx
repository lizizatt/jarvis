import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, GitCompare, History, MessageSquare, Monitor, Play, Plus, TerminalSquare } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useLoad } from '../hooks';
import { TaskPanel } from '../components/TaskPanel';
import { DiffPanel } from '../components/DiffPanel';
import { TaskStatusBadge } from '../components/Status';
import type { TaskSummary } from '../types';

type Tab = 'agent' | 'changes' | 'terminal' | 'preview';
const TerminalPanel = lazy(() => import('../components/TerminalPanel').then((module) => ({ default: module.TerminalPanel })));

export function RepositoryDetail() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const repository = useLoad(() => api.repository(id), [id]);
  const tasks = useLoad(() => api.tasks(id), [id]);
  const models = useLoad(() => api.models(id), [id]);
  const [selectedTask, setSelectedTask] = useState<string>();
  const initializedRepository = useRef<string | undefined>(undefined);
  const requestedTask = searchParams.get('task');
  const [tab, setTab] = useState<Tab>('agent');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  useEffect(() => {
    if (!tasks.data) return;
    const matchingRequestedTask = tasks.data.find((task) => task.id === requestedTask)?.id;
    if (matchingRequestedTask) setSelectedTask(matchingRequestedTask);
    else if (initializedRepository.current !== id) {
      initializedRepository.current = id;
      setSelectedTask(tasks.data.find((task) => ['starting', 'running', 'stopping'].includes(task.status))?.id ?? tasks.data[0]?.id);
    }
  }, [id, requestedTask, tasks.data]);
  const task = tasks.data?.find((item) => item.id === selectedTask);
  const availableModels = models.data ?? [];

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const prompt = data.get('prompt')?.toString().trim(); const modelId = data.get('modelId')?.toString() || 'auto'; if (!prompt) return;
    setStarting(true);
    try { const created = await api.startTask(id, prompt, modelId); tasks.setData([created, ...(tasks.data ?? [])]); setSelectedTask(created.id); setStartError(''); form.reset(); }
    catch (reason) { setStartError(reason instanceof Error ? reason.message : 'Unable to start task'); }
    finally { setStarting(false); }
  }
  function updateTask(updated: TaskSummary) { tasks.setData((tasks.data ?? []).map((item) => item.id === updated.id ? updated : item)); }

  if (repository.loading) return <main className="page"><div className="empty">Loading checkout…</div></main>;
  if (repository.error || !repository.data) return <main className="page"><Link to="/" className="back-link"><ArrowLeft />Repositories</Link><div className="notice error">{repository.error || 'Repository not found'}</div></main>;
  const repo = repository.data;
  return <main className="detail-page" data-testid="repository-detail">
    <header className="detail-header"><Link to="/" className="icon-button" aria-label="Back to repositories"><ArrowLeft /></Link><div><h1>{repo.name}</h1><p>{repo.status?.branch ?? repo.defaultBranch}</p></div><button className="icon-button" aria-label="New task" onClick={() => { setTab('agent'); setSelectedTask(undefined); }} data-testid="header-new-task"><Plus /></button>{repo.previewUrl && <a className="icon-button" aria-label="Open preview in new tab" href={repo.previewUrl} target="_blank" rel="noreferrer"><ExternalLink /></a>}</header>
    <nav className="tabs" aria-label="Repository views">{([['agent', MessageSquare, 'Agent'], ['changes', GitCompare, 'Changes'], ['terminal', TerminalSquare, 'Terminal'], ['preview', Monitor, 'Preview']] as const).map(([value, Icon, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)} data-testid={`tab-${value}`}><Icon size={18} />{label}</button>)}</nav>
    <div className="detail-content">
      {tab === 'agent' && <div className="agent-layout"><aside className="task-sidebar"><div className="sidebar-heading"><span><History size={16} />History</span><button className="icon-button" aria-label="New task" onClick={() => setSelectedTask(undefined)} data-testid="new-task"><Plus /></button></div><div className="task-history"><button className={!selectedTask ? 'new active' : 'new'} onClick={() => setSelectedTask(undefined)}><span>New task</span><Plus size={15} /></button>{tasks.data?.map((item) => <button key={item.id} className={item.id === selectedTask ? 'active' : ''} onClick={() => setSelectedTask(item.id)} data-testid={`history-${item.id}`}><span>{item.title ?? 'Developer task'}</span><TaskStatusBadge status={item.status} /></button>)}</div></aside><section className="agent-main">{task ? <TaskPanel task={task} onTaskChange={updateTask} /> : <div className="start-task" data-testid="start-task"><div><Play size={25} /><h2>Start a task</h2><p>Give the agent a clear goal for this checkout.</p></div><form onSubmit={start}><label htmlFor="initial-prompt" className="sr-only">Task prompt</label><textarea id="initial-prompt" name="prompt" rows={5} required placeholder="Describe the change, constraints, and how to verify it…" /><label htmlFor="task-model">Model</label><select id="task-model" name="modelId" defaultValue="auto" disabled={models.loading || !availableModels.length}><option value="auto">Auto</option>{availableModels.filter((model) => model.id !== 'auto').map((model) => <option key={model.id} value={model.id}>{model.name} · {model.family}</option>)}</select>{models.error && <p className="form-error" role="alert">{models.error}</p>}{startError && <p className="form-error" role="alert">{startError}</p>}<button className="button primary" disabled={starting || !availableModels.length}><Play size={16} />{starting ? 'Starting…' : 'Start agent'}</button></form></div>}</section></div>}
      {tab === 'changes' && <DiffPanel repositoryId={id} />}
      {tab === 'terminal' && <Suspense fallback={<div className="empty compact-empty">Loading terminal…</div>}><TerminalPanel repositoryId={id} /></Suspense>}
      {tab === 'preview' && <div className="preview-view">{repo.previewUrl ? <iframe title={`${repo.name} preview`} src={repo.previewUrl} data-testid="preview-frame" /> : <div className="empty"><Monitor /><h2>No preview available</h2><p>The Jarvis-managed landing page has not been created for this checkout.</p></div>}</div>}
    </div>
  </main>;
}
