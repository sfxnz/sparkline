import { Info } from 'lucide-react';
import { Tooltip } from './Tooltip';
import './Unsupported.css';

/** A metric this hardware does not report. Never rendered as 0 or as an empty chart. */
export function Unsupported({ reason, label = 'Not reported by this hardware', block }: { reason: string; label?: string; block?: boolean }) {
  return (
    <span className={`unsupported${block ? ' unsupported--block' : ''}`}>
      <span className="unsupported__label">{label}</span>
      <Tooltip content={reason}>
        <button type="button" className="unsupported__info" aria-label="Why is this not reported?">
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
