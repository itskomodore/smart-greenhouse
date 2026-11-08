import { useEffect, useState } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

/** Tracks prefers-color-scheme so canvas colours (uPlot) can follow the OS theme. */
export function useDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia?.(QUERY).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}
