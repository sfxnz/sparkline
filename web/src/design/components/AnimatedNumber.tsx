import { useLayoutEffect, useRef } from 'react';
import { DASH } from '../../lib/format';
import { prefersReducedMotion, springs } from '../motion';

type Animate = typeof import('../animate').animate;
/** Kept out of the startup bundle: fetched right away, but numbers simply change instantly until it is here. */
let animate: Animate | null = null;
void import('../animate').then((m) => { animate = m.animate; }, () => undefined);

/**
 * Per-frame text write: skipped when the text is unchanged (most frames of a spring between 71 and 72 still read
 * "71"), and done in place on the existing text node, so it never inserts nodes (which would re-match `:has()`
 * rules on the card around it and force a style recalc of the whole card).
 */
function setText(el: HTMLElement, text: string): void {
  const node = el.firstChild;
  if (node && node === el.lastChild && node.nodeType === Node.TEXT_NODE) {
    if (node.nodeValue !== text) node.nodeValue = text;
  } else el.textContent = text;
}

interface Props {
  value: number | null | undefined;
  /** Number -> display text (without unit). Called every animation frame; keep it cheap. */
  format: (n: number) => string;
  className?: string;
  /** The unit the text is written in ("Mb/s"). When it changes the number jumps instead of interpolating, so a
   *  48 Gb/s -> 5 Mb/s change never shows in-between frames such as "48273 Mb/s". */
  scale?: string;
}

/**
 * Interpolates between values with a spring and writes the text directly, so a changing number costs no
 * React renders per frame. Instant on first paint, for missing values, and under reduced motion.
 */
export function AnimatedNumber({ value, format, className, scale }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const formatRef = useRef(format);
  const scaleRef = useRef(scale);

  useLayoutEffect(() => {
    formatRef.current = format;
    const el = ref.current;
    if (!el) return;
    const target = value == null || !Number.isFinite(value) ? null : value;
    const from = shown.current;
    const rescaled = scaleRef.current !== scale;
    scaleRef.current = scale;
    if (rescaled || !animate || target === null || from === null || from === target || prefersReducedMotion() || document.hidden) {
      shown.current = target;
      setText(el, target === null ? DASH : format(target));
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
        setText(el, formatRef.current(c));
      },
      onComplete: () => {
        shown.current = target;
        setText(el, formatRef.current(target));
      },
    });
    return () => {
      controls.stop();
    };
  }, [value, format, scale]);

  return <span ref={ref} className={`num${className ? ` ${className}` : ''}`} />;
}
