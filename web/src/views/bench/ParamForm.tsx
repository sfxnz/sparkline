// Parameter form generated from a bench's BenchParam list: bounded numbers with units, enums as a segmented control
// (or a select when there are many choices), booleans as switches, multi-selects as checkbox groups. Errors are
// inline, linked to their field and always directly under the control (then the help); a field with an error is
// marked data-invalid so the dialog can move focus to the first one.
import { CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import type { BenchParam } from '../../lib/types';
import { NumberField } from '../alerts/parts/NumberField';
import { Select } from '../alerts/parts/Select';
import { Switch } from '../alerts/parts/Switch';
import { choiceLabel, isModelParam, type FormValue, type FormValues } from './model';

interface Props {
  params: readonly BenchParam[];
  values: FormValues;
  errors: Record<string, string>;
  onChange: (name: string, value: FormValue) => void;
  /** Rendered instead of these params (the node picker shows `rail` next to source/target). */
  skip?: readonly string[];
}

const fmtBound = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** "4–500" / "≥ 2" / "≤ 60", with the unit. */
function boundsText(p: BenchParam): string | null {
  const u = p.unit ? ` ${p.unit}` : '';
  if (p.min != null && p.max != null) return `${fmtBound(p.min)}–${fmtBound(p.max)}${u}`;
  if (p.min != null) return `at least ${fmtBound(p.min)}${u}`;
  if (p.max != null) return `at most ${fmtBound(p.max)}${u}`;
  return null;
}

const SEGMENTED_MAX = 4;
const segmentable = (p: BenchParam) => (p.choices?.length ?? 0) <= SEGMENTED_MAX && (p.choices ?? []).every((c) => choiceLabel(c, p).length <= 12);

export function ParamForm({ params, values, errors, onChange, skip = [] }: Props) {
  const shown = params.filter((p) => !skip.includes(p.name));
  if (!shown.length) return null;
  return (
    <div className="bench-form">
      {shown.map((p) => (
        <ParamField key={p.name} param={p} value={values[p.name]} error={errors[p.name]} onChange={(v) => { onChange(p.name, v); }} />
      ))}
    </div>
  );
}

export function ParamField({ param: p, value, error, onChange }: { param: BenchParam; value: FormValue | undefined; error?: string; onChange: (v: FormValue) => void }) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const bounds = p.type === 'int' || p.type === 'float' ? boundsText(p) : null;
  const help = [p.help, bounds ? `Range ${bounds}.` : null].filter(Boolean).join(' ');
  const describedBy = help ? helpId : undefined;

  if (p.type === 'multi') {
    const list = Array.isArray(value) ? value : [];
    return (
      <fieldset className="bench-field bench-field--group" data-invalid={error ? true : undefined} aria-describedby={[describedBy, error ? errId : null].filter(Boolean).join(' ') || undefined}>
        <legend className="bench-field__label">{p.label}</legend>
        <div className="bench-checks">
          {(p.choices ?? []).map((c) => (
            <label key={c} className="bench-check">
              <input
                type="checkbox"
                checked={list.includes(c)}
                onChange={(e) => { onChange(e.target.checked ? [...list, c] : list.filter((x) => x !== c)); }}
              />
              <span>{choiceLabel(c, p)}</span>
            </label>
          ))}
        </div>
        {error ? <FieldError id={errId} text={error} /> : null}
        {help ? <p id={helpId} className="bench-field__help">{help}</p> : null}
      </fieldset>
    );
  }

  let control;
  switch (p.type) {
    case 'int':
    case 'float':
      return (
        <div className="bench-field" data-invalid={error ? true : undefined}>
          <label className="bench-field__label" id={labelId} htmlFor={id}>{p.label}</label>
          <NumberField id={id} value={typeof value === 'string' ? value : ''} onChange={onChange} unit={p.unit ?? undefined} error={error} describedBy={describedBy} width="9rem" />
          {help ? <p id={helpId} className="bench-field__help">{help}</p> : null}
        </div>
      );
    case 'bool':
      control = <Switch id={id} checked={value === true} onChange={onChange} labelledBy={labelId} describedBy={describedBy} />;
      return (
        <div className="bench-field bench-field--inline">
          <span className="bench-field__label" id={labelId}>{p.label}</span>
          {control}
          {help ? <p id={helpId} className="bench-field__help">{help}</p> : null}
        </div>
      );
    case 'enum':
      control = segmentable(p) ? (
        <SegmentedControl
          label={p.label}
          options={(p.choices ?? []).map((c) => ({ value: c, label: choiceLabel(c, p) }))}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
        />
      ) : (
        <Select id={id} aria-describedby={describedBy} value={typeof value === 'string' ? value : ''} onChange={(e) => { onChange(e.target.value); }}>
          {(p.choices ?? []).map((c) => <option key={c} value={c}>{choiceLabel(c, p)}</option>)}
        </Select>
      );
      return (
        <div className="bench-field" data-invalid={error ? true : undefined}>
          {segmentable(p) ? <span className="bench-field__label" id={labelId}>{p.label}</span> : <label className="bench-field__label" htmlFor={id}>{p.label}</label>}
          {control}
          {error ? <FieldError id={errId} text={error} /> : null}
          {help ? <p id={helpId} className="bench-field__help">{help}</p> : null}
        </div>
      );
    default:
      return (
        <div className="bench-field" data-invalid={error ? true : undefined}>
          <label className="bench-field__label" htmlFor={id}>{p.label}</label>
          <input
            id={id}
            className="input bench-field__text"
            placeholder={isModelParam(p) ? 'First served model' : undefined}
            value={typeof value === 'string' ? value : ''}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={[describedBy, error ? errId : null].filter(Boolean).join(' ') || undefined}
            onChange={(e) => { onChange(e.target.value); }}
          />
          {error ? <FieldError id={errId} text={error} /> : null}
          {help ? <p id={helpId} className="bench-field__help">{help}</p> : null}
        </div>
      );
  }
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <span id={id} className="ops-error">
      <CircleAlert aria-hidden="true" />
      {text}
    </span>
  );
}
