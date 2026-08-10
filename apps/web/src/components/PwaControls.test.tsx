import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PwaControls } from './PwaControls';

test('renders settings above page content in the document layer', async () => {
  render(<PwaControls />);

  await userEvent.click(screen.getByRole('button', { name: 'App and notification settings' }));

  expect(document.querySelector('.modal-backdrop')?.parentElement).toBe(document.body);
});
