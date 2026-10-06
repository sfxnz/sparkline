import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import './SegmentedControl.css';

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** Longer accessible label when `label` is terse ("5m" -> "Last 5 minutes"). */
  ariaLabel?: string;
}

interface Props<T extends string> {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

/** Radio-group semantics: one tab stop, arrow keys move and select, Home/End jump. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, size = 'md' }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`segmented segmented--${size}`}
      style={{ '--seg-count': options.length, '--seg-index': index } as CSSProperties}
    >
      <span className="segmented__thumb" aria-hidden="true" />
      {options.map((o, i) => {
        const checked = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            tabIndex={checked ? 0 : -1}
            className="segmented__option"
            onKeyDown={onKeyDown}
            onClick={() => { onChange(o.value); }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
