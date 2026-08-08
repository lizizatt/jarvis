import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from './Timeline';
import type { TaskEvent } from '../types';

test('submits an open-ended answer with its question id', async () => {
  const onAnswer = vi.fn();
  render(<Timeline events={[{ sequence: 1, kind: 'agent_event', type: 'question', timestamp: '2026-08-07T00:00:00Z',
    prompt: 'Which branch?', questionId: 'q1', data: { rawEvent: { type: 'question' } } } as TaskEvent & Record<string, unknown>]} onAnswer={onAnswer} />);
  await userEvent.type(screen.getByPlaceholderText('Type your answer'), 'main');
  await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(onAnswer).toHaveBeenCalledWith('main', 'q1');
});

test('retires controls for an answered question', () => {
  const question = { sequence: 1, kind: 'agent_event', type: 'question', timestamp: '2026-08-07T00:00:00Z',
    prompt: 'Proceed?', questionId: 'q1', choices: ['Yes', 'No'], data: { rawEvent: { type: 'question' } } } as TaskEvent & Record<string, unknown>;
  const answer = { sequence: 2, kind: 'answer', type: 'message', timestamp: '2026-08-07T00:00:01Z',
    questionId: 'q1', message: 'Yes' } as TaskEvent & Record<string, unknown>;
  render(<Timeline events={[question, answer]} onAnswer={vi.fn()} />);
  expect(screen.getByText('Answered')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
});
