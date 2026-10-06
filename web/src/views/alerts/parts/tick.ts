import { useSyncExternalStore } from 'react';

// One shared interval per period for "4 min ago" labels: a long timeline re-renders only its time leaves,
// and N rows do not create N timers.
class Ticker {
  private now = Date.now();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ms: number) {}

  readonly subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    if (!this.timer) {
      this.now = Date.now();
      this.timer = setInterval(() => {
        this.now = Date.now();
        this.listeners.forEach((l) => { l(); });
      }, this.ms);
    }
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  readonly get = () => this.now;
}

const tickers = new Map<number, Ticker>();
function tickerFor(ms: number): Ticker {
  let t = tickers.get(ms);
  if (!t) {
    t = new Ticker(ms);
    tickers.set(ms, t);
  }
  return t;
}

/** Current time in epoch ms, refreshed every `ms` through a shared timer. */
export function useTick(ms = 10_000): number {
  const t = tickerFor(ms);
  return useSyncExternalStore(t.subscribe, t.get, t.get);
}
