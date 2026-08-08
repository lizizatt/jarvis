import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SystemWidget } from './SystemWidget';

afterEach(() => { vi.unstubAllGlobals(); });

test('shows current load and navigates to system details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    timestamp: new Date().toISOString(), cpuPercent: 25, perCorePercent: [25], cpuCount: 1,
    memoryUsedBytes: 500, memoryTotalBytes: 1_000, loadAverage: [1, 2, 3], history: []
  }))));
  render(<MemoryRouter><Routes><Route path="/" element={<SystemWidget />} /><Route path="/system" element={<div>System details</div>} /></Routes></MemoryRouter>);

  const link = await screen.findByRole('link', { name: /25 percent CPU, 50 percent memory/i });
  expect(link).toHaveAttribute('href', '/system');
  await userEvent.click(link);
  expect(screen.getByText('System details')).toBeVisible();
});