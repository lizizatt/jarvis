import { useEffect, useRef } from 'react';
import { paintDitheredSeries } from '../dither';

const GOLD: readonly [number, number, number] = [239, 189, 73];

export function DitherSparkline({ values, className, cell = 2 }: { values: number[]; className?: string; cell?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => paintDitheredSeries(canvas, values, GOLD, { cell });
    paint();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [values, cell]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
