import { useEffect, useRef, useState } from 'react';

/** An element's content width, kept current by a ResizeObserver; `fallback` where there is none (tests). */
export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(typeof ResizeObserver === 'undefined' ? fallback : 0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { setWidth(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);
  return [ref, width] as const;
}
