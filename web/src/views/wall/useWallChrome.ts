import { useCallback, useEffect, useState } from 'react';

/** True after `ms` without pointer or keyboard activity (hides the cursor and the exit controls). */
export function useIdle(ms = 3000): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      setIdle(false);
      if (t) clearTimeout(t);
      t = setTimeout(() => { setIdle(true); }, ms);
    };
    wake();
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focusin'] as const;
    evs.forEach((e) => { window.addEventListener(e, wake, { passive: true }); });
    return () => {
      if (t) clearTimeout(t);
      evs.forEach((e) => { window.removeEventListener(e, wake); });
    };
  }, [ms]);
  return idle;
}

/** Fullscreen API state + toggle. `supported` is false where the browser does not allow it (e.g. iframes). */
export function useFullscreen() {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && document.fullscreenElement !== null);
  useEffect(() => {
    const sync = () => { setOn(document.fullscreenElement !== null); };
    document.addEventListener('fullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); };
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled;
  return { on, toggle, supported };
}

/** Keep a wall display awake (Screen Wake Lock) while this view is visible; silently does nothing if unsupported. */
export function useWakeLock(): void {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (disposed) void l.release().catch(() => undefined);
          else lock = l;
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}
