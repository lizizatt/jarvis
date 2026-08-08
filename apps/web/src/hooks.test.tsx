import { act, renderHook, waitFor } from '@testing-library/react';
import { useLoad } from './hooks';

test('retains the previous data reference when a background reload is unchanged', async () => {
  const first = [{ id: 'repo-1', name: 'Flight controls' }];
  const loader = vi.fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce([{ id: 'repo-1', name: 'Flight controls' }]);
  const { result } = renderHook(() => useLoad(loader, [], (current, next) => JSON.stringify(current) === JSON.stringify(next)));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const initialReference = result.current.data;

  await act(async () => { await result.current.reload(false); });

  expect(result.current.data).toBe(initialReference);
  expect(result.current.loading).toBe(false);
});
