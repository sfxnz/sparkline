import { animate } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { DASH } from '../../lib/format';
import { prefersReducedMotion, springs } from '../motion';

interface Props {
  value: number | null | undefined;
  /** Number -> display text (without unit). Called every animation frame; keep it cheap. */
  format: (n: number) => string;
  className?: string;
}

/**
 * Interpolates between values with a spring and writes textContent directly, so a changing number costs no
 * React renders per frame. Instant on first paint, for missing values, and under reduced motion.
 */
export function AnimatedNumber({ value, format, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const formatRef = useRef(format);

  useLayoutEffect(() => {
    formatRef.current = format;
    const el = ref.current;
    if (!el) return;
    const target = value == null || !Number.isFinite(value) ? null : value;
    const from = shown.current;
    if (target === null || from === null || from === target || prefersReducedMotion() || document.hidden) {
      shown.current = target;
      el.textContent = target === null ? DASH : format(target);
      return;
    }
    // Clamped to the interval being crossed: a spring's slight overshoot must never show a value that was never
    // measured (e.g. "-4 B/s" while a throughput settles at 0).
    const lo = Math.min(from, target);
    const hi = Math.max(from, target);
    const controls = animate(from, target, {
      ...springs.snappy,
      onUpdate: (v) => {
        const c = Math.min(hi, Math.max(lo, v));
        shown.current = c;
        el.textContent = formatRef.current(c);
      },
      onComplete: () => {
        shown.current = target;
        el.textContent = formatRef.current(target);
      },
    });
    return () => {
      controls.stop();
    };
  }, [value, format]);

  return <span ref={ref} className={`num${className ? ` ${className}` : ''}`} />;
}
