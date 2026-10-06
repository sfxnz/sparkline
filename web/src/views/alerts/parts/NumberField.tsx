import { CircleAlert } from 'lucide-react';
import { useId } from 'react';
import './parts.css';

interface Props {
  value: string;
  onChange: (text: string) => void;
  unit?: string;
  /** Accessible name (visible label elsewhere: pass labelledBy). */
  label?: string;
  labelledBy?: string;
  error?: string;
  width?: string;
  id?: string;
  describedBy?: string;
}

/** Decimal text field with an inline unit and an inline error linked by aria-describedby. */
export function NumberField({ value, onChange, unit, label, labelledBy, error, width = '7.5rem', id, describedBy }: Props) {
  const errId = useId();
  const described = [describedBy, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <span className="ops-numfield">
      <span className={`ops-field${unit ? ' ops-field--unit' : ''}`} style={{ width }}>
        <input
          id={id}
          className="input"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          style={unit ? { paddingRight: `calc(${unit.length}ch + 1.25rem)` } : undefined}
          onChange={(e) => { onChange(e.target.value); }}
        />
        {unit ? <span className="ops-field__unit" aria-hidden="true">{unit}</span> : null}
      </span>
      {error ? (
        <span id={errId} className="ops-error">
          <CircleAlert aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </span>
  );
}
