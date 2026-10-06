import type { ReactNode } from 'react';
import './RingGauge.css';

interface Props {
  /** 0..1; null renders an empty track. */
  value: number | null;
  /** Accessible description, e.g. "Memory: 79% used (96.2 of 121.7 GiB)". */
  label: string;
  size?: number;
  stroke?: number;
  tone?: 'accent' | 'ok' | 'warn' | 'crit' | 'stale';
  /** Centre content (visual only; the label carries the meaning). */
  children?: ReactNode;
}

export function RingGauge({ value, label, size = 72, stroke = 7, tone = 'accent', children }: Props) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));
  return (
    <div className={`ring ring--${tone}`} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring__value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          opacity={value == null ? 0 : 1}
        />
      </svg>
      {children ? <div className="ring__center" aria-hidden="true">{children}</div> : null}
    </div>
  );
}
