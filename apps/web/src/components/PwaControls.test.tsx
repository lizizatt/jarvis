import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PwaControls } from './PwaControls';

afterEach(() => {
  window.localStorage.removeItem('jarvis.frostBlur.px');
  window.localStorage.removeItem('jarvis.motionLpfTauMs');
  document.documentElement.style.removeProperty('--panel-blur');
});

test('renders settings above page content in the document layer', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);

  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(document.querySelector('.modal-backdrop')?.parentElement).toBe(document.body);
});

test('links the gear menu to unified host controls', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);

  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(screen.getByRole('link', { name: 'Open host controls' })).toHaveAttribute('href', '/settings');
  expect(screen.getByText('Manage deployments and private Tailnet access.')).toBeVisible();
  expect(document.querySelector('.setting-row')).toHaveTextContent('Host controls');
});

test('persists the selected frame rate cap', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  const select = screen.getByLabelText('Animation frame rate');
  expect(select).toHaveValue('24');

  await userEvent.selectOptions(select, '30');
  expect(window.localStorage.getItem('jarvis.sigilFrameRate.fps')).toBe('30');
});

test('persists the selected motion smoothing amount', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  const slider = screen.getByLabelText('Motion smoothing');
  expect(slider).toHaveValue('80');

  fireEvent.change(slider, { target: { value: '120' } });
  expect(window.localStorage.getItem('jarvis.motionLpfTauMs')).toBe('120');
});

test('persists the selected frosting amount', async () => {
  render(<MemoryRouter><PwaControls /></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

  const slider = screen.getByLabelText('Frosting');
  expect(slider).toHaveValue('8');

  fireEvent.change(slider, { target: { value: '0' } });
  expect(window.localStorage.getItem('jarvis.frostBlur.px')).toBe('0');
  expect(document.documentElement.style.getPropertyValue('--panel-blur')).toBe('0px');
});
