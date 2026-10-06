// "Cores now": one compact cell per core (utilisation + current clock), grouped like the heatmap. Each cell
// subscribes to its own core, so a tick re-renders only cells whose numbers changed. One tab stop; arrow keys move.
import { useRef, useState, type KeyboardEvent } from 'react';
import { Tooltip } from '../../../design/components/Tooltip';
import { formatFreq } from '../../../lib/format';
import type { CoreInfo } from '../../../lib/types';
import { useLastKnown } from './hooks';
import { groupCores, groupDetail } from './cores';

export function CoreGrid({ node, cores }: { node: string; cores: readonly CoreInfo[] }) {
  const groups = groupCores(cores);
  const flat = groups.flatMap((g) => g.cores);
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLSpanElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent) => {
    const last = flat.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(last, active + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(0, active - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };

  let index = 0;
  return (
    <div className="nb-cores">
      {groups.map((g) => (
        <section key={g.kind} className="nb-cores__group" aria-label={`${g.name} cores`}>
          <h3 className="nb-cores__head">
            <span className="nb-cores__name">{g.name}</span>
            <span className="nb-cores__detail">{groupDetail(g)}</span>
          </h3>
          <ul className="nb-cores__cells">
            {g.cores.map((c) => {
              const i = index++;
              return (
                <CoreCell
                  key={c.id}
                  node={node}
                  core={c}
                  focusable={i === active}
                  onFocus={() => { setActive(i); }}
                  onKeyDown={onKeyDown}
                  cellRef={(el) => { refs.current[i] = el; }}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface CellProps {
  node: string;
  core: CoreInfo;
  focusable: boolean;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  cellRef: (el: HTMLSpanElement | null) => void;
}

function CoreCell({ node, core, focusable, onFocus, onKeyDown, cellRef }: CellProps) {
  const util = useLastKnown(node, `cpu.core${core.id}.util`, 1);
  const mhz = useLastKnown(node, `cpu.core${core.id}.mhz`, 10);
  const utilText = util === null ? '—' : `${util}%`;
  const ghz = mhz === null ? '—' : (mhz / 1000).toFixed(2);
  const max = core.max_mhz ? ` of ${formatFreq(core.max_mhz)} max` : '';
  const tip = `Core ${core.id}${core.model ? ` · ${core.model}` : ''}: ${util === null ? 'no data' : `${util}% busy`}, ${mhz === null ? 'clock unknown' : `${formatFreq(mhz)}${max}`}`;
  return (
    <li className="nb-core">
      <Tooltip content={tip} delay={200}>
        {/* A focusable image (roving tabindex) so the tooltip is keyboard reachable; arrows move between cores. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <span
          ref={cellRef}
          className="nb-core__cell"
          role="img"
          aria-label={tip}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={focusable ? 0 : -1}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
        >
          <span className="nb-core__id" aria-hidden="true">{core.id}</span>
          <span className="nb-core__util num" aria-hidden="true">{utilText}</span>
          <span className="nb-core__ghz num" aria-hidden="true">{ghz}<span className="nb-core__unit"> GHz</span></span>
          <span className="nb-core__bar" aria-hidden="true">
            <span className="nb-core__fill" style={{ transform: `scaleX(${(util ?? 0) / 100})` }} />
          </span>
        </span>
      </Tooltip>
    </li>
  );
}
