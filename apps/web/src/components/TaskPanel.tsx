import { useEffect, useRef, useState } from 'react';
import { ChevronsDown, ChevronsUp, Send, Square } from 'lucide-react';
import { api } from '../api';
import { useTaskStream } from '../useTaskStream';
import { TaskStatusBadge } from './Status';
import { Timeline } from './Timeline';
import type { TaskSummary } from '../types';

export function TaskPanel({ task: initialTask, onTaskChange }: { task: TaskSummary; onTaskChange: (task: TaskSummary) => void }) {
  const [task, setTask] = useState(initialTask);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const events = useTaskStream(task.id);
  const topRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastLifecycle = useRef<{ taskId: string; sequence: number } | undefined>(undefined);
  useEffect(() => { setTask(initialTask); }, [initialTask]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); }, [events.length]);
  useEffect(() => {
    const lifecycle = [...events].reverse().find((event) => event.type === 'task_state') as (typeof events[number] & { state?: TaskSummary['status'] }) | undefined;
    const previous = lastLifecycle.current;
    if (!lifecycle?.state || (previous?.taskId === task.id && lifecycle.sequence <= previous.sequence)) return;
    lastLifecycle.current = { taskId: task.id, sequence: lifecycle.sequence };
    if (lifecycle.state !== task.status) { const updated = { ...task, status: lifecycle.state }; setTask(updated); onTaskChange(updated); }
  }, [events, onTaskChange, task]);

  function scrollToTop() { topRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }
  function scrollToBottom() { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); }

  async function send(text: string, questionId?: string, approval = false): Promise<boolean> {
    if (!text.trim() || sending || task.status === 'stopping') return false;
    setSending(true);
    setSendError('');
    try {
      const updated = await api.message(task.id, text.trim(), approval ? 'approval' : questionId ? 'answer' : 'follow_up', questionId);
      setTask(updated); onTaskChange(updated);
      return true;
    }
    catch (error) {
      setSendError(error instanceof Error ? error.message : 'Unable to send message');
      return false;
    }
    finally { setSending(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form).get('message')?.toString() ?? '';
    if (await send(input)) form.reset();
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
    <div ref={topRef} className="scroll-top-anchor" aria-hidden="true" />
    <div className="scroll-controls"><button className="icon-button" aria-label="Scroll to top" onClick={scrollToTop} data-testid="scroll-top"><ChevronsUp /></button><button className="icon-button" aria-label="Scroll to bottom" onClick={scrollToBottom} data-testid="scroll-bottom"><ChevronsDown /></button></div>
    <div className="task-meta"><TaskStatusBadge status={task.status} /><span className="session-id">{task.origin === 'vscode-chat' ? 'VS Code Chat' : 'Jarvis'}</span><span className="session-id">Model {modelLabel}</span>{task.nativeSessionId && <span className="session-id">Session {task.nativeSessionId}</span>}</div>
    <Timeline events={events} onAnswer={send} />
    <div ref={endRef} className="scroll-anchor" />
    <div className="task-composer">
      {sendError && <p className="form-error" role="alert">{sendError}</p>}
      <form onSubmit={submit}><label className="sr-only" htmlFor="follow-up">Follow-up message</label><textarea id="follow-up" name="message" rows={2} placeholder={task.status === 'stopping' ? 'Task is stopping…' : 'Send a follow-up…'} disabled={sending || task.status === 'stopping'} /><button className="icon-button send" type="submit" aria-label="Send message" disabled={sending || task.status === 'stopping'}><Send /></button></form>
      {active && <button className="button stop" onClick={stop} disabled={task.status === 'stopping'} data-testid="stop-task"><Square size={15} />{task.status === 'stopping' ? 'Stopping…' : 'Stop agent'}</button>}
    </div>
  </section>;
}
