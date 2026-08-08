import { Bot, CheckCircle2, ChevronDown, CircleHelp, FilePenLine, Info, LoaderCircle, MessageSquare, Play, TerminalSquare, User, X } from 'lucide-react';
import { useState } from 'react';
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

export function compactToolActivity(events: TaskEvent[]): TaskEvent[] {
  const result: PresentedEvent[] = [];
  let operation: PresentedEvent | undefined;
  let output = '';
  const flushOperation = () => {
    if (!operation) return;
    result.push({ ...operation, output: output || undefined });
    operation = undefined;
    output = '';
  };
  for (const event of events as PresentedEvent[]) {
    const operationName = event.type === 'tool' ? toolOperationName(event) : undefined;
    if (event.type === 'tool' && event.phase === 'call') continue;
    if (event.type === 'tool' && event.phase === 'started') {
      if (operationName === 'ask_user') {
        flushOperation();
        continue;
      }
      flushOperation();
      operation = createOperation(event, 'running');
      continue;
    }
    if (event.type === 'question') {
      if (operation?.operation === 'ask_user') {
        operation = undefined;
        output = '';
      } else {
        flushOperation();
      }
      result.push(event);
      continue;
    }
    if (event.type === 'tool' && operationName === 'ask_user') continue;
    if (operation) {
      if (event.type === 'output') {
        if (typeof event.raw === 'string') output += event.raw;
        else if (typeof event.text === 'string') output += event.text;
      }
      if (event.type === 'command' && event.phase === 'finished' && typeof event.exitCode === 'number') {
        operation = { ...operation, exitCode: event.exitCode };
      }
      if (event.type === 'tool' && (event.phase === 'completed' || event.phase === 'failed')) {
        operation = { ...operation, status: event.phase === 'failed' ? 'failed' : 'completed', output: output || undefined };
        result.push(operation);
        operation = undefined;
        output = '';
      }
      continue;
    }
    if (event.type === 'tool' || event.type === 'file-read') continue;
    result.push(event);
  }
  flushOperation();
  return result;
}

function toolOperationName(event: PresentedEvent): string {
  return typeof event.name === 'string' ? event.name : typeof event.toolName === 'string' ? event.toolName : 'tool';
}

function createOperation(event: PresentedEvent, status: 'running' | 'completed' | 'failed'): PresentedEvent {
  const input = typeof event.input === 'object' && event.input !== null ? event.input as Record<string, unknown> : {};
  return { ...event, type: 'operation', status, operation: toolOperationName(event), input };
}

function operationPresentation(wire: PresentedEvent) {
  const input = typeof wire.input === 'object' && wire.input !== null ? wire.input as Record<string, unknown> : {};
  const running = wire.status === 'running';
  const failed = wire.status === 'failed';
  const path = typeof input.path === 'string' ? input.path : '';
  const command = typeof input.command === 'string' ? input.command : '';
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const operation = String(wire.operation ?? 'tool');
  const descriptions: Record<string, [string, string]> = {
    list_files: [`Listing files matching ${pattern || '**/*'}…`, `Listed files matching ${pattern || '**/*'}`],
    read_file: [`Reading ${path || 'file'}…`, `Read ${path || 'file'}`],
    write_file: [`Writing ${path || 'file'}…`, `Wrote ${path || 'file'}`],
    replace_text: [`Editing ${path || 'file'}…`, `Edited ${path || 'file'}`],
    run_command: [`Running ${command || 'command'}…`, `Ran ${command || 'command'}`],
    ask_user: ['Preparing a question…', 'Asked for input'],
  };
  const description = descriptions[operation] ?? [`Running ${operation}…`, `Completed ${operation}`];
  const explicitSummary = typeof wire.summary === 'string' ? wire.summary : undefined;
  let text = explicitSummary ?? (running ? description[0] : description[1]);
  if (!explicitSummary && failed) text = `${description[1]} failed`;
  if (!explicitSummary && !running && !failed && operation === 'run_command' && typeof wire.exitCode === 'number') {
    text = `${description[1]} (exit ${wire.exitCode})`;
  }
  return { Icon: running ? LoaderCircle : operation === 'run_command' ? TerminalSquare : FilePenLine,
    label: failed ? 'Failed' : running ? 'Current activity' : 'Completed', text };
}

function eventPresentation(event: TaskEvent) {
  const wire = event as TaskEvent & Record<string, unknown>;
  if (event.type === 'operation') return operationPresentation(wire);
  if (event.type === 'message') return { Icon: wire.role === 'user' ? User : Bot, label: String(wire.role ?? 'Message'), text: String(wire.text ?? event.message ?? '') };
  if (event.type === 'command') return { Icon: TerminalSquare, label: `Command ${wire.phase ?? ''}`, text: String(wire.command ?? event.summary ?? '') };
  if (event.type === 'tool') return { Icon: Play, label: `${wire.toolName ?? 'Tool'} ${wire.phase ?? ''}`, text: String(wire.summary ?? '') };
  if (event.type === 'file_change') return { Icon: FilePenLine, label: String(wire.change ?? 'Changed'), text: String(wire.path ?? '') };
  if (event.type === 'question') return { Icon: CircleHelp, label: wire.requiresApproval ? 'Approval needed' : 'Question', text: String(wire.prompt ?? event.message ?? '') };
  if (event.type === 'task_state') return { Icon: CheckCircle2, label: 'Task state', text: `${wire.previousState ? `${wire.previousState} → ` : ''}${wire.state ?? event.message ?? ''}` };
  return { Icon: MessageSquare, label: event.stream ?? event.type, text: event.message ?? event.summary ?? '' };
}

function QuestionActions({ wire, answered, onAnswer }: { wire: PresentedEvent; answered: boolean;
  onAnswer: (text: string, questionId?: string, approval?: boolean) => void }) {
  const [answer, setAnswer] = useState('');
  const choices = Array.isArray(wire.choices) ? wire.choices.filter((choice): choice is string => typeof choice === 'string') : [];
  const questionId = typeof wire.questionId === 'string' ? wire.questionId : undefined;
  if (answered) return <span className="question-answered">Answered</span>;
  if (choices.length) return <div className="question-actions">{choices.map((choice) =>
    <button className="button secondary compact" key={choice} onClick={() => onAnswer(choice, questionId, Boolean(wire.requiresApproval))}>{choice}</button>)}</div>;
  if (wire.requiresApproval) return <div className="question-actions"><button className="button primary compact" onClick={() => onAnswer('Approved', questionId, true)}>Approve</button><button className="button secondary compact" onClick={() => onAnswer('Denied', questionId, true)}>Deny</button></div>;
  return <form className="question-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) { onAnswer(answer.trim(), questionId); setAnswer(''); } }}>
    <label className="sr-only" htmlFor={`question-${wire.sequence}`}>Answer question</label>
    <input id={`question-${wire.sequence}`} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Type your answer" />
    <button className="button primary compact" type="submit" disabled={!answer.trim()}>Send answer</button>
  </form>;
}

// Drop the internal duplicate-tracking payload; every other field is already useful to inspect.
function inspectablePayload(event: PresentedEvent): Record<string, unknown> {
  const { data, ...rest } = event as Record<string, unknown> & { data?: unknown };
  void data;
  return rest;
}

function EntryInspector({ event, onClose }: { event: PresentedEvent; onClose: () => void }) {
  const { label } = eventPresentation(event);
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal entry-inspector" role="dialog" aria-modal="true" aria-labelledby="entry-inspector-title" onClick={(domEvent) => domEvent.stopPropagation()}>
      <header>
        <div><p className="eyebrow">Entry #{event.sequence}</p><h2 id="entry-inspector-title">{label}</h2></div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
      </header>
      <p className="entry-inspector-time">{new Date(event.timestamp).toLocaleString()}</p>
      <pre className="entry-inspector-json">{JSON.stringify(inspectablePayload(event), null, 2)}</pre>
    </section>
  </div>;
}

export function Timeline({ events, onAnswer }: { events: TaskEvent[]; onAnswer: (text: string, questionId?: string, approval?: boolean) => void }) {
  const [inspecting, setInspecting] = useState<PresentedEvent>();
  if (!events.length) return <div className="empty compact-empty" data-testid="timeline-empty">Waiting for agent activity…</div>;
  const visibleEvents = compactToolActivity(coalesceAssistantMessages(events.filter((event) => {
    if (event.kind === 'question' && event.data?.rawEvent && typeof event.data.rawEvent === 'object'
      && (event.data.rawEvent as Record<string, unknown>).type !== 'question') return false;
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
  })));
  const answeredQuestionIds = new Set(events.flatMap((event) => {
    const wire = event as PresentedEvent;
    return (wire.kind === 'answer' || wire.kind === 'approval') && typeof wire.questionId === 'string' ? [wire.questionId] : [];
  }));
  return <>
    <ol className="timeline" data-testid="task-timeline">
      {visibleEvents.map((event) => {
        const { Icon, label, text } = eventPresentation(event);
        const wire = event as TaskEvent & Record<string, unknown>;
        return <li key={`${event.sequence}-${event.id ?? event.type}`} className={`timeline-event event-${event.type}`} data-sequence={event.sequence}>
          <div className="event-icon"><Icon size={17} /></div>
          <div className="event-body">
            <button type="button" className="event-header" onClick={() => setInspecting(wire)} aria-label={`Inspect ${label} entry`}>
              <strong>{label}</strong>
              <span className="event-header-meta"><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><Info size={13} /></span>
            </button>
            {event.type === 'output' ? <details className="raw-output"><summary><ChevronDown size={15} />Raw {event.stream}</summary><pre>{String(wire.text ?? event.raw ?? text)}</pre></details> : <p>{text}</p>}
            {event.type === 'operation' && typeof wire.output === 'string' && <details className="raw-output"><summary><ChevronDown size={15} />{wire.operation === 'run_command' ? 'Command output' : 'Activity output'}</summary><pre>{wire.output}</pre></details>}
            {event.type === 'question' && <QuestionActions wire={wire} answered={typeof wire.questionId === 'string' && answeredQuestionIds.has(wire.questionId)} onAnswer={onAnswer} />}
          </div>
        </li>;
      })}
    </ol>
    {inspecting && <EntryInspector event={inspecting} onClose={() => setInspecting(undefined)} />}
  </>;
}
