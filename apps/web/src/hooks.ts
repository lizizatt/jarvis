import { useCallback, useEffect, useRef, useState } from 'react';

export function useLoad<T>(loader: () => Promise<T>, dependencies: readonly unknown[], isEqual?: (current: T, next: T) => boolean) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const next = await loader();
      setData((current) => current !== undefined && isEqual?.(current, next) ? current : next);
      setError('');
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Request failed'); }
    finally { if (showLoading) setLoading(false); }
  }, dependencies);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, error, loading, reload };
}

export function useVisiblePolling(callback: () => void, intervalMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) callbackRef.current();
    };
    const interval = window.setInterval(refresh, intervalMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [intervalMs]);
}

export function elapsed(from?: string, to?: string) {
  if (!from) return '0m';
  const seconds = Math.max(0, Math.floor((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
