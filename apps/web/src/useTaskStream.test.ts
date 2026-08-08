import { mergeOrdered } from './useTaskStream';
import type { TaskEvent } from './types';

const event = (sequence: number): TaskEvent => ({ sequence, type: 'message', timestamp: '2026-01-01T00:00:00Z', message: String(sequence) });

test('deduplicates replayed events and preserves sequence order', () => {
  expect(mergeOrdered([event(2)], [event(1), event(2), event(3)]).map((item) => item.sequence)).toEqual([1, 2, 3]);
});

test('preserves structured types from wrapped agent events', () => {
  const [normalized] = mergeOrdered([], [{ sequence: 1, kind: 'agent_event', type: '', timestamp: '',
    payload: { event: { type: 'command', command: 'npm test' } } } as TaskEvent & { payload: unknown }]);
  expect(normalized).toMatchObject({ type: 'command', command: 'npm test' });
});
