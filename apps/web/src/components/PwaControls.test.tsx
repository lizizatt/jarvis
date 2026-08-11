import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PwaControls } from './PwaControls';

test('renders settings above page content in the document layer', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);

  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(document.querySelector('.modal-backdrop')?.parentElement).toBe(document.body);
});
