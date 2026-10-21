// Text that types itself and counters that tick, for up to 32 live stream cards: one requestAnimationFrame loop
// drives them all and writes the DOM directly, so a 2 Hz feed reads as continuous without a React render per frame.
// Each update reveals exactly the characters the payload appended, spread over REVEAL_MS. Instant under reduced
// motion and in hidden tabs (where frames do not run, and a backlog must not replay on return).
import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../../design/motion';

export const REVEAL_MS = 450;

type Job = (now: number) => boolean;
const jobs = new Set<Job>();
let frame = 0;

function tick() {
  const now = performance.now(); // the same clock the jobs started on (a frame's own timestamp may not be, outside browsers)
  for (const job of jobs) if (!job(now)) jobs.delete(job);
  frame = jobs.size ? requestAnimationFrame(tick) : 0;
}

/** Run `job` every animation frame until it returns false or the returned function is called. */
function everyFrame(job: Job): () => void {
  jobs.add(job);
  if (!frame) frame = requestAnimationFrame(tick);
  return () => { jobs.delete(job); };
}

/** Replace the element's text in place (no new nodes), and only when it changed. */
function writeText(el: HTMLElement, text: string): void {
  const node = el.firstChild;
  if (node && node === el.lastChild && node.nodeType === Node.TEXT_NODE) {
    if (node.nodeValue !== text) node.nodeValue = text;
  } else el.textContent = text;
}

/** `text` without its last `hidden` UTF-16 units, never splitting a surrogate pair. */
export function shownPart(text: string, hidden: number): string {
  let cut = Math.max(0, text.length - Math.max(0, Math.round(hidden)));
  const c = text.charCodeAt(cut - 1);
  if (cut > 0 && cut < text.length && c >= 0xd800 && c <= 0xdbff) cut--;
  return text.slice(0, cut);
}

/**
 * A span showing `text`, typing out its last `added` characters (new since the previous update) over REVEAL_MS, also
 * when the span has just mounted (a request that starts decoding, an answer that follows its reasoning). A new `id`
 * (another request) starts over. Text a slot already had when first seen comes with `added` 0 and shows at once, as
 * does anything not `live`.
 */
export function useTypewriter(text: string, added: number, id: string, live: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const st = useRef<{ id: string | null; text: string; hidden: number }>({ id: null, text: '', hidden: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = st.current;
    const sameRequest = s.id === id;
    if (!live || prefersReducedMotion() || document.hidden) s.hidden = 0;
    // The same text again (an effect run twice, as in StrictMode) keeps its progress instead of hiding `added` again.
    else if (!sameRequest || s.text !== text) s.hidden = Math.min(text.length, (sameRequest ? s.hidden : 0) + added);
    s.id = id;
    s.text = text;
    writeText(el, shownPart(text, s.hidden));
    if (!s.hidden) return;
    const from = s.hidden;
    const start = performance.now();
    return everyFrame((now) => {
      const p = Math.min(1, (now - start) / REVEAL_MS);
      s.hidden = from * (1 - p);
      writeText(el, shownPart(text, s.hidden));
      return p < 1;
    });
  }, [text, added, id, live]);
  return ref;
}

/**
 * A span counting up in real time from `ms` (a duration the payload measured at its last snapshot), never backwards
 * within one `id`. Under reduced motion it ticks four times a second instead of every frame.
 */
export function useCountUp(ms: number | null, id: string, format: (ms: number) => string) {
  const ref = useRef<HTMLSpanElement>(null);
  const st = useRef({ id: '', shown: 0, wrote: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || ms == null) return;
    const s = st.current;
    if (s.id !== id) {
      s.id = id;
      s.shown = 0;
    }
    const start = performance.now();
    const slow = prefersReducedMotion();
    const paint = (now: number) => {
      s.shown = Math.max(s.shown, ms + (now - start));
      if (!slow || now - s.wrote >= 250) {
        s.wrote = now;
        writeText(el, format(s.shown));
      }
      return true;
    };
    paint(start);
    return everyFrame(paint);
  }, [ms, id, format]);
  return ref;
}
