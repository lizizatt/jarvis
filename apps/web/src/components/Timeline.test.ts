import { coalesceAssistantMessages, compactToolActivity } from './Timeline';
import type { TaskEvent } from '../types';

function assistant(sequence: number, text: string): TaskEvent {
  return { sequence, type: 'message', timestamp: '2026-08-07T00:00:00Z', message: text,
    role: 'assistant', text } as TaskEvent & { role: string; text: string };
}

test('coalesces adjacent streamed assistant deltas', () => {
  const result = coalesceAssistantMessages([
    assistant(1, '##'), assistant(2, ' Repository'), assistant(3, ' summary'),
  ]) as Array<TaskEvent & { text?: string }>;
  expect(result).toHaveLength(1);
  expect(result[0].text).toBe('## Repository summary');
});

test('preserves tool boundaries between assistant response runs', () => {
  const tool = { sequence: 2, type: 'tool', timestamp: '2026-08-07T00:00:01Z' } as TaskEvent;
  const result = coalesceAssistantMessages([assistant(1, 'Before'), tool, assistant(3, 'After')]);
  expect(result).toHaveLength(3);
  expect(result.map((event) => event.type)).toEqual(['message', 'tool', 'message']);
});

test('projects a file tool lifecycle into one completed operation', () => {
  const events = [
    { sequence: 1, type: 'tool', phase: 'call', timestamp: '2026-08-07T00:00:00Z', name: 'read_file', input: { path: 'README.md' } },
    { sequence: 2, type: 'tool', phase: 'started', timestamp: '2026-08-07T00:00:01Z', name: 'read_file', input: { path: 'README.md' } },
    { sequence: 3, type: 'file-read', timestamp: '2026-08-07T00:00:02Z', path: '/repo/README.md' },
    { sequence: 4, type: 'tool', phase: 'completed', timestamp: '2026-08-07T00:00:03Z', name: 'read_file' },
  ] as Array<TaskEvent & Record<string, unknown>>;
  const result = compactToolActivity(events) as Array<TaskEvent & Record<string, unknown>>;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: 'operation', operation: 'read_file', status: 'completed', input: { path: 'README.md' } });
});

test('keeps one running operation until its completion arrives', () => {
  const result = compactToolActivity([
    { sequence: 1, type: 'tool', phase: 'started', timestamp: '2026-08-07T00:00:01Z', name: 'run_command', input: { command: 'npm test' } } as TaskEvent & Record<string, unknown>,
    { sequence: 2, type: 'output', timestamp: '2026-08-07T00:00:02Z', raw: 'passing\n' } as TaskEvent,
  ]) as Array<TaskEvent & Record<string, unknown>>;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: 'operation', operation: 'run_command', status: 'running', output: 'passing\n' });
});

test('shows the real question instead of a stuck ask_user placeholder', () => {
  const result = compactToolActivity([
    { sequence: 1, type: 'tool', phase: 'call', timestamp: '2026-08-07T00:00:00Z', name: 'ask_user', input: { prompt: 'Push now?' } } as TaskEvent & Record<string, unknown>,
    { sequence: 2, type: 'tool', phase: 'started', timestamp: '2026-08-07T00:00:01Z', name: 'ask_user', input: { prompt: 'Push now?' } } as TaskEvent & Record<string, unknown>,
    { sequence: 3, kind: 'question', type: 'question', timestamp: '2026-08-07T00:00:02Z', message: 'Push now?', prompt: 'Push now?', questionId: 'q1' } as TaskEvent & Record<string, unknown>,
    { sequence: 4, type: 'tool', phase: 'completed', timestamp: '2026-08-07T00:00:03Z', name: 'ask_user' } as TaskEvent & Record<string, unknown>,
  ]) as Array<TaskEvent & Record<string, unknown>>;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: 'question', prompt: 'Push now?' });
});

test('suppresses legacy ask_user wrapper events without a canonical prompt', () => {
  const wrapper = { sequence: 1, kind: 'question', type: 'question', timestamp: '2026-08-07T00:00:00Z',
    data: { rawEvent: { type: 'tool-completed', name: 'ask_user' } } } as TaskEvent;
  const canonical = { sequence: 2, kind: 'agent_event', type: 'question', timestamp: '2026-08-07T00:00:01Z',
    prompt: 'Proceed?', questionId: 'q1', data: { rawEvent: { type: 'question', prompt: 'Proceed?', questionId: 'q1' } } } as TaskEvent & Record<string, unknown>;
  const filtered = [wrapper, canonical].filter((event) => !(event.kind === 'question' && event.data?.rawEvent
    && typeof event.data.rawEvent === 'object' && (event.data.rawEvent as Record<string, unknown>).type !== 'question'));
  expect(filtered).toEqual([canonical]);
});
