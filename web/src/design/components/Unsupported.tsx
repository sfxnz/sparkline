import { Info } from 'lucide-react';
import type { NotReported } from '../../lib/capabilities';
import { Tooltip } from './Tooltip';
import './Unsupported.css';

export function Unsupported({ gap, block }: { gap: NotReported; block?: boolean }) {
  return (
    <span className={`unsupported${block ? ' unsupported--block' : ''}`}>
      <span className="unsupported__label">{gap.label}</span>
      <Tooltip content={gap.detail}>
        <button type="button" className="unsupported__info" aria-label="Why is this not reported?">
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
