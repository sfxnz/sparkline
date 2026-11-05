import { Info } from 'lucide-react';
import type { NotReported } from '../../lib/capabilities';
import { Tooltip } from './Tooltip';
import './Unsupported.css';

export function NoData({ block }: { block?: boolean }) {
  return (
    <span className={`unsupported${block ? ' unsupported--block' : ''}`}>
      <span className="unsupported__label">No data</span>
      <Tooltip content="This node is reporting, but has sent no value for this metric.">
        <button type="button" className="unsupported__info" aria-label="Why is there no data?">
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}

export function Unsupported({ gap, block }: { gap: NotReported; block?: boolean }) {
  return (
    <span className={`unsupported${block ? ' unsupported--block' : ''}`}>
      <span className="unsupported__label">{gap.label}</span>
      <Tooltip content={<span className="unsupported__detail">{gap.detail}</span>}>
        <button type="button" className="unsupported__info" aria-label="Why is this not reported?">
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
