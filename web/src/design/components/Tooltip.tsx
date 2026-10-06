import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import './Tooltip.css';

interface Props {
  content: ReactNode;
  /** A single focusable element. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom';
  delay?: number;
}

/** Shows on hover (after a short delay) and on keyboard focus; Escape dismisses. The trigger is linked with
 *  aria-describedby, and the bubble stays in the DOM so the description is always available to AT. */
export function Tooltip({ content, children, placement = 'top', delay = 350 }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  // Keep the bubble inside the viewport: an anchor near the right/left edge shifts it sideways. Checked on mount
  // (a hidden bubble still counts toward page width), on open and on resize; written only when it changes.
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el) return;
    const fit = () => {
      const cur = parseFloat(el.style.getPropertyValue('--tt-shift')) || 0;
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const margin = 8;
      let shift = 0;
      if (r.right - cur > vw - margin) shift = vw - margin - (r.right - cur);
      if (r.left - cur + shift < margin) shift = margin - (r.left - cur);
      if (Math.round(shift) !== Math.round(cur)) el.style.setProperty('--tt-shift', `${Math.round(shift)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => { window.removeEventListener('resize', fit); };
  }, [open]);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clear();
    setOpen(false);
  };
  const onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    clear();
    timer.current = setTimeout(() => { setOpen(true); }, delay);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');

  return (
    // Hover/focus listeners sit on the wrapper (focus events bubble in React); the child stays the focus target.
    <span
      className="tooltip-anchor"
      onPointerEnter={onPointerEnter}
      onPointerLeave={hide}
      onFocus={() => { clear(); setOpen(true); }}
      onBlur={hide}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      <span ref={bubble} id={id} role="tooltip" className={`tooltip tooltip--${placement}`} data-open={open || undefined}>
        {content}
      </span>
    </span>
  );
}
