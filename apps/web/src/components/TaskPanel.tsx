import { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { api } from '../api';
import { useTaskStream } from '../useTaskStream';
import { TaskStatusBadge } from './Status';
import { Timeline } from './Timeline';
import type { TaskSummary } from '../types';

export function TaskPanel({ task: initialTask, onTaskChange }: { task: TaskSummary; onTaskChange: (task: TaskSummary) => void }) {
  const [task, setTask] = useState(initialTask);
  const [sending, setSending] = useState(false);
  const events = useTaskStream(task.id);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setTask(initialTask); }, [initialTask]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [events.length]);
  useEffect(() => {
    const lifecycle = [...events].reverse().find((event) => event.type === 'task_state') as (typeof events[number] & { state?: TaskSummary['status'] }) | undefined;
    if (lifecycle?.state && lifecycle.state !== task.status) { const updated = { ...task, status: lifecycle.state }; setTask(updated); onTaskChange(updated); }
  }, [events, onTaskChange, task]);

  async function send(text: string, questionId?: string, approval = false) {
    if (!text.trim() || sending || task.status === 'stopping') return;
    setSending(true);
    try {
      const updated = await api.message(task.id, text.trim(), approval ? 'approval' : questionId ? 'answer' : 'follow_up', questionId);
      setTask(updated); onTaskChange(updated);
    }
    finally { setSending(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form).get('message')?.toString() ?? '';
    await send(input); form.reset();
  }

  async function stop() {
    if (!confirm('Stop this task and all processes it started?')) return;
    const stopping = { ...task, status: 'stopping' as const };
    setTask(stopping); onTaskChange(stopping);
    try { const stopped = await api.stop(task.id); setTask(stopped); onTaskChange(stopped); }
    catch { const refreshed = await api.task(task.id); setTask(refreshed); onTaskChange(refreshed); }
  }

  const active = ['queued', 'starting', 'running', 'stopping'].includes(task.status);
  const resolvedModel = [...events].reverse().map((event) => (event as typeof event & { model?: { id?: string; name?: string; family?: string } }).model)
    .find((model) => model?.name || model?.family);
  const modelLabel = resolvedModel?.id === 'auto'
    ? resolvedModel.family ?? resolvedModel.name ?? task.modelId
    : resolvedModel?.name ?? resolvedModel?.family ?? task.modelId;
  return <section className="task-panel" data-testid={`task-${task.id}`}>
    <div className="task-meta"><TaskStatusBadge status={task.status} /><span className="session-id">Model {modelLabel}</span>{task.nativeSessionId && <span className="session-id">Session {task.nativeSessionId}</span>}</div>
    <Timeline events={events} onAnswer={send} />
    <div ref={endRef} />
    <div className="task-composer">
      <form onSubmit={submit}><label className="sr-only" htmlFor="follow-up">Follow-up message</label><textarea id="follow-up" name="message" rows={2} placeholder={task.status === 'stopping' ? 'Task is stopping…' : 'Send a follow-up…'} disabled={sending || task.status === 'stopping'} /><button className="icon-button send" type="submit" aria-label="Send message" disabled={sending || task.status === 'stopping'}><Send /></button></form>
      {active && <button className="button stop" onClick={stop} disabled={task.status === 'stopping'} data-testid="stop-task"><Square size={15} />{task.status === 'stopping' ? 'Stopping…' : 'Stop agent'}</button>}
    </div>
  </section>;
}
