import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { DASH, formatAgo, type Formatter } from '../../lib/format';
import { useNow } from '../useNow';
import { AnimatedNumber } from './AnimatedNumber';
import { Unsupported } from './Unsupported';
import './Stat.css';

interface Props {
  label: string;
  value: number | null | undefined;
  format: Formatter;
  /** Optional change vs a reference, already formatted, with its direction (for icon + accessible text). */
  delta?: { text: string; direction: 'up' | 'down' | 'flat'; label?: string };
  /** Dim the value; without a footer, also show "updated 12 s ago" (epoch seconds of the last real update). */
  stale?: boolean;
  updatedAt?: number | null;
  /** Reason text when the hardware does not report this metric. */
  unsupported?: string;
  /** Short label for the unsupported state (default "Not reported by this hardware"). */
  unsupportedLabel?: string;
  size?: 'md' | 'lg';
  footer?: ReactNode;
}

export function Stat({ label, value, format, delta, stale, updatedAt, unsupported, unsupportedLabel, size = 'md', footer }: Props) {
  const target = value == null || !Number.isFinite(value) ? null : format(value);
  const unit = target?.unit ?? '';
  const textFor = useCallback((n: number) => format(n, unit || undefined).value, [format, unit]);
  const DeltaIcon = delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : Minus;

  return (
    <div className={`stat stat--${size}${stale ? ' stat--stale' : ''}`}>
      <div className="stat__label">{label}</div>
      {unsupported ? (
        <div className="stat__unsupported">
          <Unsupported reason={unsupported} label={unsupportedLabel} />
        </div>
      ) : (
        <div className="stat__value">
          <AnimatedNumber value={value} format={textFor} className="stat__number" />
          {unit && target?.value !== DASH ? <span className="stat__unit">{unit}</span> : null}
          {delta ? (
            <span className={`stat__delta stat__delta--${delta.direction}`}>
              <DeltaIcon aria-hidden="true" />
              <span>{delta.text}</span>
              {delta.label ? <span className="stat__delta-label">{delta.label}</span> : null}
            </span>
          ) : null}
        </div>
      )}
      {/* Stale: the value dims. A stat keeps its own caption (its context still matters, and the screen labels the
          group "last known values" once); only a stat with no caption says its age itself. */}
      {footer ? <div className="stat__footer">{footer}</div> : stale && !unsupported ? <StaleNote updatedAt={updatedAt ?? null} /> : null}
    </div>
  );
}

function StaleNote({ updatedAt }: { updatedAt: number | null }) {
  const now = useNow(1000);
  return <div className="stat__footer stat__footer--stale">{updatedAt ? `Updated ${formatAgo(updatedAt, now / 1000)}` : 'No recent data'}</div>;
}
