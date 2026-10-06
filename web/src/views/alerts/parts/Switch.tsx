import './parts.css';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when there is no visible <label> (use labelledBy otherwise). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  id?: string;
}

/** On/off switch (role="switch"): Space/Enter toggle, state is also spoken, never colour alone (the knob moves). */
export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled, id }: Props) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className="ops-switch"
      onClick={() => { onChange(!checked); }}
    >
      <span className="ops-switch__knob" aria-hidden="true" />
    </button>
  );
}
