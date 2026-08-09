import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { TaskEvent } from './types';

function normalize(event: TaskEvent & { kind?: string; payload?: unknown; createdAt?: string; text?: string }): TaskEvent {
  const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : {};
  const nested = typeof payload.event === 'object' && payload.event !== null ? payload.event as Record<string, unknown>
    : event.kind === 'agent_event' ? payload : {};
  const message = event.message ?? event.text ?? String(payload.text ?? payload.message ?? nested.message ?? nested.text ?? '');
  const wireType = String(nested.type ?? '');
  const worker = normalizeWorkerEvent(wireType, nested);
  const type = event.kind === 'lifecycle' ? 'task_state' : event.kind === 'user_message' ? 'message'
    : event.kind === 'stderr' ? 'output' : event.kind === 'agent_event' ? wireType || 'agent_event'
      : (event.type ?? event.kind ?? wireType) || 'event';
  return { ...event, ...payload, ...nested, ...worker, type: worker.type ?? type, timestamp: event.timestamp ?? event.createdAt ?? new Date().toISOString(),
    message: message || undefined, stream: event.kind === 'stderr' ? 'stderr' : event.stream,
    raw: event.raw ?? (event.kind === 'stderr' ? String(payload.text ?? '') : undefined), data: { ...payload, rawEvent: nested } };
}

function normalizeWorkerEvent(type: string, event: Record<string, unknown>): Partial<TaskEvent> & Record<string, unknown> {
  if (type === 'text') return { type: 'message', role: 'assistant' };
  if (type === 'command-started') return { type: 'command', phase: 'started' };
  if (type === 'command-finished') return { type: 'command', phase: 'finished' };
  if (type === 'command-output') return { type: 'output',
    stream: event.stream === 'stderr' ? 'stderr' : 'stdout', raw: typeof event.text === 'string' ? event.text : '' };
  if (type === 'tool-call' || type.startsWith('tool-')) return { type: 'tool', phase: type.replace('tool-', '') };
  if (type === 'file-written' || type === 'file-changed') return { type: 'file_change', change: type === 'file-written' ? 'Written' : 'Changed' };
  return {};
}

export function mergeOrdered(current: TaskEvent[], incoming: TaskEvent[]) {
  const events = new Map(current.map((event) => [event.sequence, event]));
  incoming.forEach((event) => events.set(event.sequence, normalize(event)));
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}

export function useTaskStream(taskId?: string) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const lastSequence = useRef(0);
  useEffect(() => {
    if (!taskId) { setEvents([]); return; }
    const activeTaskId = taskId;
    let active = true;
    async function replay(after = lastSequence.current) {
      const next = await api.events(activeTaskId, after);
      if (!active) return;
      setEvents((current) => mergeOrdered(current, next));
      lastSequence.current = Math.max(lastSequence.current, ...next.map((event) => event.sequence), 0);
    }
    setEvents([]); lastSequence.current = 0; void replay(0);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let retry = 0;
    function connect() {
      if (!active) return;
      socket = new WebSocket(`${protocol}//${location.host}/ws/tasks?taskId=${encodeURIComponent(activeTaskId)}`);
      socket.addEventListener('open', () => { retry = 0; void replay(lastSequence.current); });
      socket.addEventListener('message', (message) => {
        if (!active) return;
        try {
          const event = JSON.parse(String(message.data)) as TaskEvent & { taskId?: string };
          if (event.sequence > lastSequence.current + 1) { void replay(lastSequence.current); return; }
          lastSequence.current = Math.max(lastSequence.current, event.sequence);
          setEvents((current) => mergeOrdered(current, [event]));
        } catch { void replay(lastSequence.current); }
      });
      socket.addEventListener('close', () => {
        if (active) reconnectTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      });
    }
    connect();
    return () => { active = false; if (reconnectTimer) window.clearTimeout(reconnectTimer); socket?.close?.(); };
  }, [taskId]);
  return events;
}
