import { platformSheet, type SkippedBackend } from '../../../lib/platform';
import type { NodeInfo, UnsupportedKind } from '../../../lib/types';

const KIND_TONE: Record<UnsupportedKind, string> = { access: 'tone-warn', dependency: 'tone-warn', hardware: 'tone-info', agent: 'tone-info' };

export function PlatformSheet({ info }: { info: NodeInfo }) {
  const sheet = platformSheet(info);
  return (
    <div className="nsheet">
      <div className="nsheet__group">
        <h3 className="nsheet__label">Platform</h3>
        <p className="nsheet__primary">{sheet.platform}</p>
        {info.os ? <p className="nsheet__line">{info.os}</p> : null}
        {info.kernel ? <p className="nsheet__line"><code>{info.kernel}</code></p> : null}
      </div>

      <div className="nsheet__group">
        <h3 className="nsheet__label">GPU backend</h3>
        {sheet.backends.length ? (
          <ul className="nsheet__list">
            {sheet.backends.map((b) => (
              <li key={`${b.vendor}/${b.backend}`} className="nsheet__backend">
                <p className="nsheet__primary">
                  {b.vendor} <code>{b.backend}</code>
                </p>
                <p className="nsheet__line num">
                  {countGpus(b.gpus.length + b.notResponding.length)}
                  {b.gpus.length ? ` · ${[...new Set(b.gpus)].join(', ')}` : ''}
                </p>
                {b.notResponding.length ? (
                  <ul className="nsheet__list nsheet__skips">
                    {b.notResponding.map((g) => (
                      <li key={g.index} className="nsheet__skip">
                        <p className="nsheet__skiphead">
                          <code>GPU {g.index}</code>
                          <span className="nsheet__tag tone-warn">Not responding</span>
                        </p>
                        <p className="nsheet__reason">{g.reason}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="nsheet__primary">{sheet.missing}</p>
        )}
        {sheet.skipped.length ? (
          <div className="nsheet__skipped">
            {sheet.backends.length ? <p className="nsheet__sublabel">Skipped</p> : null}
            <ul className="nsheet__list nsheet__skips">
              {sheet.skipped.map((s) => <SkippedRow key={s.backend ?? ''} item={s} />)}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="nsheet__group">
        <h3 className="nsheet__label">Versions</h3>
        {sheet.versions.length ? (
          sheet.versions.map((g) => (
            <div key={g.vendor} className="nsheet__vgroup">
              <h4 className="nsheet__sublabel">{g.vendor}</h4>
              <dl className="nsheet__kv">
                {g.rows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd className="num">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))
        ) : (
          <p className="nsheet__line">No GPU versions reported</p>
        )}
        <dl className="nsheet__kv nsheet__kv--agent">
          <div>
            <dt>Sparkline agent</dt>
            <dd className="num">{info.agent_version}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

const countGpus = (n: number) => `${String(n)} ${n === 1 ? 'GPU' : 'GPUs'}`;

function SkippedRow({ item }: { item: SkippedBackend }) {
  return (
    <li className="nsheet__skip">
      <p className="nsheet__skiphead">
        {item.backend ? <code>{item.backend}</code> : null}
        <span className={`nsheet__tag ${KIND_TONE[item.gap.kind]}`}>{item.gap.label}</span>
      </p>
      <p className="nsheet__reason">{item.gap.detail}</p>
    </li>
  );
}
