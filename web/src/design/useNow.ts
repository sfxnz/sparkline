import { useEffect, useState } from 'react';

/** Current time in ms, refreshed every `intervalMs` (for "12 s ago" labels). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); }, intervalMs);
    return () => { clearInterval(t); };
  }, [intervalMs]);
  return now;
}
