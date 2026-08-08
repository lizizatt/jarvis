import { useCallback, useEffect, useState } from 'react';

export function useLoad<T>(loader: () => Promise<T>, dependencies: readonly unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await loader()); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Request failed'); }
    finally { setLoading(false); }
  }, dependencies);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, error, loading, reload };
}

export function elapsed(from?: string, to?: string) {
  if (!from) return '0m';
  const seconds = Math.max(0, Math.floor((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
