import { useEffect, useState } from 'react';
import type { Severity } from '../../lib/types';

// Polite screen-reader announcements for warning/critical events only. Identical messages within DEDUPE_MS are
// dropped and announcements are at least MIN_GAP_MS apart; a burst collapses into one summary sentence.
export const DEDUPE_MS = 30_000;
export const MIN_GAP_MS = 4_000;

export class Announcer {
  private queue: string[] = [];
  private readonly recent = new Map<string, number>();
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  listener: ((message: string) => void) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  announce(text: string, severity: Severity): void {
    if (severity === 'info') return;
    const t = this.now();
    for (const [k, at] of this.recent) if (t - at >= DEDUPE_MS) this.recent.delete(k);
    if (this.recent.has(text)) return;
    this.recent.set(text, t);
    this.queue.push(text);
    this.pump();
  }

  private pump(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastAt + MIN_GAP_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const q = this.queue;
      this.queue = [];
      if (!q.length) return;
      this.lastAt = this.now();
      this.listener?.(q.length === 1 ? (q[0] ?? '') : `${q.length} new alerts. Latest: ${q[q.length - 1] ?? ''}`);
    }, wait);
  }
}

export const announcer = new Announcer();
export const announce = (text: string, severity: Severity) => { announcer.announce(text, severity); };

/** Mount once near the root. */
export function LiveAnnouncer() {
  const [message, setMessage] = useState({ text: '', n: 0 });
  useEffect(() => {
    announcer.listener = (text) => { setMessage((m) => ({ text, n: m.n + 1 })); };
    return () => { announcer.listener = null; };
  }, []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
      <span key={message.n}>{message.text}</span>
    </div>
  );
}
