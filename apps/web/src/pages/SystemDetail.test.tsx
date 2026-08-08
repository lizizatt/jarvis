import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SystemDetail } from './SystemDetail';

afterEach(() => { vi.unstubAllGlobals(); });

test('renders host metrics and returns to the dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    timestamp: new Date().toISOString(), cpuPercent: 25, perCorePercent: [10, 40], cpuCount: 2,
    memoryUsedBytes: 512 * 1024 ** 2, memoryTotalBytes: 1024 ** 3, loadAverage: [1, 2, 3],
    history: [{ timestamp: new Date().toISOString(), cpuPercent: 25, perCorePercent: [10, 40],
      memoryUsedBytes: 512 * 1024 ** 2, memoryTotalBytes: 1024 ** 3, loadAverage: [1, 2, 3] }]
  }))));
  render(<MemoryRouter initialEntries={['/system']}><Routes><Route path="/" element={<div>Dashboard</div>} /><Route path="/system" element={<SystemDetail />} /></Routes></MemoryRouter>);

  expect(await screen.findByText('2 cores')).toBeVisible();
  const cores = screen.getByRole('region', { name: 'Per-core load' });
  expect(within(cores).getByText('C0')).toBeVisible();
  expect(within(cores).getByText('40%')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Load average' })).toHaveTextContent('1.00');
  await userEvent.click(screen.getByRole('link', { name: 'Back to repositories' }));
  expect(screen.getByText('Dashboard')).toBeVisible();
});