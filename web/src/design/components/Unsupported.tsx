import { Info } from 'lucide-react';
import { Fragment } from 'react';
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

const MAX_LINES = 6;
const SHOWN_LINES = 5;

/** A detail of several lines is one line per node (gapAcross). Past MAX_LINES the bubble shows the first few and a
 *  count, and the rest stay in its text, so the trigger's description still names every node. */
function Detail({ text }: { text: string }) {
  const lines = text.split('\n');
  if (lines.length < 2) return <span className="unsupported__detail">{text}</span>;
  const shown = lines.length > MAX_LINES ? lines.slice(0, SHOWN_LINES) : lines;
  const rest = lines.slice(shown.length);
  return (
    <span className="unsupported__detail unsupported__detail--lines">
      {shown.map((line, i) => (
        <Fragment key={line}>
          {i ? '\n' : null}
          <span className="unsupported__line">{line}</span>
        </Fragment>
      ))}
      {rest.length ? (
        <>
          <span className="unsupported__line" aria-hidden="true">{`and ${String(rest.length)} more nodes`}</span>
          {'\n'}
          <span className="visually-hidden">{rest.join('\n')}</span>
        </>
      ) : null}
    </span>
  );
}

export function Unsupported({ gap, block }: { gap: NotReported; block?: boolean }) {
  return (
    <span className={`unsupported${block ? ' unsupported--block' : ''}`}>
      <span className="unsupported__label">{gap.label}</span>
      <Tooltip content={<Detail text={gap.detail} />}>
        <button type="button" className="unsupported__info" aria-label="Why is this not reported?">
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
