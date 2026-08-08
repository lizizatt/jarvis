import { coalesceAssistantMessages } from './Timeline';
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