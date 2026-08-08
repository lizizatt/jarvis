import { Bot, CheckCircle2, ChevronDown, CircleHelp, FilePenLine, MessageSquare, Play, TerminalSquare, User } from 'lucide-react';
import type { TaskEvent } from '../types';

type PresentedEvent = TaskEvent & Record<string, unknown>;

export function coalesceAssistantMessages(events: TaskEvent[]): TaskEvent[] {
  const result: PresentedEvent[] = [];
  for (const event of events as PresentedEvent[]) {
    const previous = result[result.length - 1];
    if (event.type === 'message' && event.role === 'assistant'
      && previous?.type === 'message' && previous.role === 'assistant') {
      const text = `${typeof previous.text === 'string' ? previous.text : previous.message ?? ''}${typeof event.text === 'string' ? event.text : event.message ?? ''}`;
      result[result.length - 1] = { ...previous, text, message: text };
    } else {
      result.push(event);
    }
  }
  return result;
}

function eventPresentation(event: TaskEvent) {
  const wire = event as TaskEvent & Record<string, unknown>;
  if (event.type === 'message') return { Icon: wire.role === 'user' ? User : Bot, label: String(wire.role ?? 'Message'), text: String(wire.text ?? event.message ?? '') };
  if (event.type === 'command') return { Icon: TerminalSquare, label: `Command ${wire.phase ?? ''}`, text: String(wire.command ?? event.summary ?? '') };
  if (event.type === 'tool') return { Icon: Play, label: `${wire.toolName ?? 'Tool'} ${wire.phase ?? ''}`, text: String(wire.summary ?? '') };
  if (event.type === 'file_change') return { Icon: FilePenLine, label: String(wire.change ?? 'Changed'), text: String(wire.path ?? '') };
  if (event.type === 'question') return { Icon: CircleHelp, label: wire.requiresApproval ? 'Approval needed' : 'Question', text: String(wire.prompt ?? event.message ?? '') };
  if (event.type === 'task_state') return { Icon: CheckCircle2, label: 'Task state', text: `${wire.previousState ? `${wire.previousState} → ` : ''}${wire.state ?? event.message ?? ''}` };
  return { Icon: MessageSquare, label: event.stream ?? event.type, text: event.message ?? event.summary ?? '' };
}

export function Timeline({ events, onAnswer }: { events: TaskEvent[]; onAnswer: (text: string, questionId?: string, approval?: boolean) => void }) {
  if (!events.length) return <div className="empty compact-empty" data-testid="timeline-empty">Waiting for agent activity…</div>;
  const visibleEvents = coalesceAssistantMessages(events.filter((event) => {
    if (event.kind !== 'agent_event' || event.data?.rawEvent === null || typeof event.data?.rawEvent !== 'object') return true;
    const rawEvent = event.data.rawEvent as Record<string, unknown>;
    if (rawEvent.type !== 'question') return true;
    return !events.some((candidate) => {
      if (candidate.kind !== 'question') return false;
      const candidateEvent = candidate.data?.rawEvent;
      if (typeof candidateEvent !== 'object' || candidateEvent === null) return false;
      const derived = candidateEvent as Record<string, unknown>;
      return (typeof rawEvent.questionId === 'string' && rawEvent.questionId === derived.questionId)
        || String(rawEvent.prompt ?? '') === String(derived.prompt ?? '');
    });
  }));
  return <ol className="timeline" data-testid="task-timeline">
    {visibleEvents.map((event) => {
      const { Icon, label, text } = eventPresentation(event);
      const wire = event as TaskEvent & Record<string, unknown>;
      const choices = Array.isArray(wire.choices) ? wire.choices as string[] : [];
      return <li key={`${event.sequence}-${event.id ?? event.type}`} className={`timeline-event event-${event.type}`} data-sequence={event.sequence}>
        <div className="event-icon"><Icon size={17} /></div>
        <div className="event-body"><header><strong>{label}</strong><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
          {event.type === 'output' ? <details className="raw-output"><summary><ChevronDown size={15} />Raw {event.stream}</summary><pre>{String(wire.text ?? event.raw ?? text)}</pre></details> : <p>{text}</p>}
          {event.type === 'question' && <div className="question-actions">{choices.map((choice) => <button className="button secondary compact" key={choice} onClick={() => onAnswer(choice, String(wire.questionId), Boolean(wire.requiresApproval))}>{choice}</button>)}{Boolean(wire.requiresApproval) && choices.length === 0 && <><button className="button primary compact" onClick={() => onAnswer('Approved', String(wire.questionId), true)}>Approve</button><button className="button secondary compact" onClick={() => onAnswer('Denied', String(wire.questionId), true)}>Deny</button></>}</div>}
        </div>
      </li>;
    })}
  </ol>;
}