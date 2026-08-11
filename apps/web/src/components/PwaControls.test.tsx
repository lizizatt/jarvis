import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PwaControls } from './PwaControls';

test('renders settings above page content in the document layer', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);

  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(document.querySelector('.modal-backdrop')?.parentElement).toBe(document.body);
});

test('persists the selected frame rate cap', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  const select = screen.getByLabelText('Animation frame rate');
  expect(select).toHaveValue('24');

  await userEvent.selectOptions(select, '30');
  expect(window.localStorage.getItem('jarvis.sigilFrameRate.fps')).toBe('30');
});
