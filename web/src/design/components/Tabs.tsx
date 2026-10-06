import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import './Tabs.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Content of the selected tab. */
  children: ReactNode;
}

/** ARIA tabs (automatic activation): roving tabindex, arrows/Home/End move and select. */
export function Tabs<T extends string>({ label, items, value, onChange, children }: Props<T>) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, items.findIndex((t) => t.id === value));

  const onKeyDown = (e: KeyboardEvent) => {
    const last = items.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const t = items[next];
    if (!t) return;
    onChange(t.id);
    refs.current[next]?.focus();
  };

  const selected = items[index];
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tabs__list">
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            id={`${base}-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={i === index}
            aria-controls={`${base}-panel`}
            tabIndex={i === index ? 0 : -1}
            className="tabs__tab"
            onKeyDown={onKeyDown}
            onClick={() => { onChange(t.id); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={selected ? `${base}-tab-${selected.id}` : undefined} className="tabs__panel">
        {children}
      </div>
    </div>
  );
}
