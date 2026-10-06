import { cloneElement, useEffect, useId, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from 'react';
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
      <span id={id} role="tooltip" className={`tooltip tooltip--${placement}`} data-open={open || undefined}>
        {content}
      </span>
    </span>
  );
}
