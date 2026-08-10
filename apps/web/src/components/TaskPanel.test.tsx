import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useTaskStream } from '../useTaskStream';
import { TaskPanel } from './TaskPanel';

vi.mock('../useTaskStream', () => ({ useTaskStream: vi.fn() }));

const scrollIntoView = vi.fn();

afterEach(() => {
  vi.mocked(useTaskStream).mockReset();
  scrollIntoView.mockReset();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
});

test('opens initial task history at the top', () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.mocked(useTaskStream).mockReturnValue({ taskId: 'task-1', initialHistoryLoaded: true, events: [{ id: 'event-1', sequence: 1, type: 'message', timestamp: '2026-08-10T12:00:00Z', message: 'Latest task history' }] });

  render(<TaskPanel task={{ id: 'task-1', status: 'completed', origin: 'jarvis-pwa', modelId: 'auto', createdAt: '2026-08-10T12:00:00Z' }} onTaskChange={vi.fn()} />);

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  expect(scrollIntoView).not.toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
});
