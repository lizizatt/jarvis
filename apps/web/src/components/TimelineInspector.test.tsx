import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from './Timeline';
import type { TaskEvent } from '../types';

test('inspects a timeline entry to show its raw data, then closes it', async () => {
  const event = { sequence: 3, kind: 'agent_event', type: 'operation', timestamp: '2026-08-07T00:00:00Z',
    operation: 'read_file', status: 'completed', input: { path: 'README.md' } } as TaskEvent & Record<string, unknown>;
  render(<Timeline events={[event]} onAnswer={vi.fn()} />);

  await userEvent.click(screen.getByRole('button', { name: 'Inspect Completed entry' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Entry #3')).toBeVisible();
  expect(within(dialog).getByText(/"operation": "read_file"/)).toBeVisible();
  expect(within(dialog).getByText(/"path": "README\.md"/)).toBeVisible();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
