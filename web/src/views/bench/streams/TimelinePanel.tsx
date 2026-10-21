// Every request of a level on a swimlane per stream: a light segment while it waited for its first token, a solid one
// while it decoded, failures in the critical tone. Hover or arrow keys show one request; a level picker switches
// levels of a sweep, and the data table lists the same requests.
import { Table2 } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from '../../../design/components/Button';
import { Panel } from '../../../design/components/Panel';
import { SegmentedControl } from '../../../design/components/SegmentedControl';
import { Table } from '../../../design/components/Table';
import { Tooltip } from '../../../design/components/Tooltip';
import { valueWithUnit } from '../model';
import { formatTokS, laneHeight, lanesOf, niceTicks, requestRate, requestText, slotLabel, type LevelTimeline, type TimelineRequest } from './model';
import { useWidth } from './useWidth';

const GUTTER = 40;
const AXIS = 24;
const RIGHT = 10;

const seconds = (s: number) => `${Number(s.toPrecision(3))} s`;

function Lanes({ t }: { t: LevelTimeline }) {
  const [ref, width] = useWidth(640);
  const { lanes, bySlot } = useMemo(() => lanesOf(t), [t]);
  const [sel, setSel] = useState<TimelineRequest | null>(null);
  const [byKey, setByKey] = useState(false);
  const lh = laneHeight(lanes);
  const plotH = lanes * lh;
  const { ticks, top } = niceTicks(Math.max(...t.requests.map((r) => r.end), 0.1), Math.max(4, Math.min(8, Math.floor(width / 70))));
  const innerW = Math.max(40, width - GUTTER - RIGHT);
  const x = (s: number) => GUTTER + (s / (top || 1)) * innerW;
  const every = lanes <= 16 ? 1 : 4;

  const at = (clientX: number, clientY: number, el: HTMLElement): TimelineRequest | null => {
    const r = el.getBoundingClientRect();
    const lane = Math.floor((clientY - r.top) / lh);
    const list = bySlot[Math.min(lanes - 1, Math.max(0, lane))] ?? [];
    const s = ((clientX - r.left - GUTTER) / innerW) * top;
    let best: TimelineRequest | null = null;
    let gap = Infinity;
    for (const q of list) {
      const d = s < q.sent ? q.sent - s : s > q.end ? s - q.end : 0;
      if (d < gap) {
        gap = d;
        best = q;
      }
    }
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    const cur = sel ?? bySlot.flat()[0] ?? null;
    if (!cur) return;
    const lane = bySlot[cur.slot] ?? [];
    const k = lane.indexOf(cur);
    let next: TimelineRequest | null | undefined;
    if (e.key === 'ArrowRight') next = lane[Math.min(lane.length - 1, k + 1)];
    else if (e.key === 'ArrowLeft') next = lane[Math.max(0, k - 1)];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const other = bySlot[cur.slot + (e.key === 'ArrowDown' ? 1 : -1)];
      next = other?.length ? other.reduce((a, b) => (Math.abs(b.sent - cur.sent) < Math.abs(a.sent - cur.sent) ? b : a)) : cur;
    } else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    setSel(next === undefined ? cur : next);
  };

  const failed = t.requests.filter((r) => !r.ok).length;
  const summary = `Stream timeline, ${lanes} streams, ${t.requests.length} requests over ${seconds(Math.max(...t.requests.map((r) => r.end), 0))}${failed ? `, ${failed} failed` : ''}. Use the arrow keys to read each request.`;
  const tipX = sel ? Math.min(Math.max(x((sel.sent + sel.end) / 2), 110), width - 110) : 0;

  return (
    <>
      {/* A focusable image (as the charts are): arrow keys move between requests, the readout shows the current one. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={ref}
        className="strm-lanes"
        role="img"
        aria-label={summary}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onPointerMove={(e) => { setSel(at(e.clientX, e.clientY, e.currentTarget)); setByKey(false); }}
        onPointerLeave={() => { setSel(null); }}
        onFocus={() => { setSel((s) => s ?? bySlot.flat()[0] ?? null); setByKey(true); }}
        onBlur={() => { setSel(null); }}
        onKeyDown={(e) => { onKey(e); setByKey(true); }}
      >
        {width > 0 ? (
          <svg width={width} height={plotH + AXIS} aria-hidden="true">
            {ticks.map((s, k) => (
              <g key={s}>
                <line className="strm-chart__grid" x1={x(s)} x2={x(s)} y1={0} y2={plotH} />
                {/* The last label ends at its rule, so it never runs off the right edge. */}
                <text className="strm-chart__tick" x={x(s)} y={plotH + 16} textAnchor={k === ticks.length - 1 && k > 0 ? 'end' : 'middle'}>{seconds(s)}</text>
              </g>
            ))}
            {bySlot.map((list, slot) => (
              <g key={slot} transform={`translate(0 ${slot * lh})`}>
                {slot % every === 0 ? <text className="strm-lanes__label" x={0} y={lh / 2} dy="0.34em">{slotLabel(slot)}</text> : null}
                {list.map((q) => {
                  const x0 = x(q.sent) + 1;
                  const x1 = Math.max(x0 + 2, x(q.end) - 1);
                  const xf = q.first === null ? x1 : Math.min(x1, Math.max(x0, x(q.first)));
                  const h = lh >= 20 ? lh - 8 : lh - 5;
                  const top = (lh - h) / 2;
                  return (
                    <g key={q.req} className={`strm-req${q.ok ? '' : ' is-failed tone-crit'}${sel === q ? ' is-selected' : ''}`}>
                      <rect className="strm-req__wait" x={x0} y={top} width={Math.max(0, xf - x0)} height={h} rx={Math.min(3, h / 2)} />
                      {xf < x1 ? <rect className="strm-req__decode" x={xf} y={top} width={x1 - xf} height={h} rx={Math.min(3, h / 2)} /> : null}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        ) : null}
        {sel ? (
          <div className="strm-tip strm-tip--lanes" style={{ left: tipX, top: Math.max(0, sel.slot * lh - 6) }} aria-hidden="true">
            <span className="strm-tip__title">{slotLabel(sel.slot)} · {sel.ok ? 'finished' : 'failed'}</span>
            <span className="strm-tip__row"><strong>{requestText(sel)}</strong></span>
          </div>
        ) : null}
      </div>
      {/* The request the arrow keys reached, for screen readers (outside the image, whose content is not exposed). */}
      <span className="visually-hidden" aria-live="polite">{sel && byKey ? `${slotLabel(sel.slot)}, ${requestText(sel)}` : ''}</span>
    </>
  );
}

function RequestsTable({ t }: { t: LevelTimeline }) {
  return (
    <div className="strm-tl__table">
      <Table
        caption={`Requests at ${t.level} ${t.level === 1 ? 'stream' : 'streams'}`}
        rows={t.requests}
        rowKey={(r) => `${r.slot}:${r.req}`}
        maxHeight={320}
        initialSort={{ id: 'req', dir: 'asc' }}
        columns={[
          { id: 'req', header: 'Request', sortValue: (r) => r.req, render: (r) => <span className="num">{r.req}</span> },
          { id: 'slot', header: 'Stream', sortValue: (r) => r.slot, render: (r) => <span className="strm-mono">{slotLabel(r.slot)}</span> },
          { id: 'sent', header: 'Sent', align: 'end', sortValue: (r) => r.sent, render: (r) => <span className="num">{r.sent.toFixed(2)} s</span> },
          { id: 'ttft', header: 'TTFT', align: 'end', sortValue: (r) => (r.first === null ? null : r.first - r.sent), render: (r) => <span className="num">{r.first === null ? '—' : valueWithUnit((r.first - r.sent) * 1000, 'ms')}</span> },
          { id: 'dur', header: 'Duration', align: 'end', sortValue: (r) => r.end - r.sent, render: (r) => <span className="num">{valueWithUnit(r.end - r.sent, 's')}</span> },
          { id: 'tokens', header: 'Tokens', align: 'end', sortValue: (r) => r.tokens, render: (r) => <span className="num">{r.tokens}</span> },
          { id: 'rate', header: 'Decode tok/s', align: 'end', sortValue: requestRate, render: (r) => <span className="num">{formatTokS(requestRate(r))}</span> },
          { id: 'ok', header: 'Result', sortValue: (r) => (r.ok ? 1 : 0), render: (r) => (r.ok ? 'Finished' : <span className="tone-crit strm-failed-cell">Failed</span>) },
        ]}
      />
    </div>
  );
}

export function TimelinePanel({ timelines, actions }: { timelines: readonly LevelTimeline[]; actions?: ReactNode }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const t = timelines.find((x) => x.level === picked) ?? timelines.at(-1);
  if (!t) return null;
  const span = Math.max(...t.requests.map((r) => r.end), 0);
  const failed = t.requests.some((r) => !r.ok);
  return (
    <Panel
      title="Stream timeline"
      subtitle={`One lane per stream · ${t.requests.length} ${t.requests.length === 1 ? 'request' : 'requests'} at ${t.level} ${t.level === 1 ? 'stream' : 'streams'} over ${seconds(span)}`}
      className="strm-tl"
      actions={
        <div className="strm-actions">
          {actions}
          {timelines.length > 1 ? (
            <SegmentedControl
              label="Level"
              size="sm"
              options={timelines.map((x) => ({ value: String(x.level), label: String(x.level), ariaLabel: `${x.level} ${x.level === 1 ? 'stream' : 'streams'}` }))}
              value={String(t.level)}
              onChange={(v) => { setPicked(Number(v)); }}
            />
          ) : null}
          <Tooltip content={table ? 'Hide data table' : 'Show data table'} placement="bottom">
            <IconButton size="sm" aria-label="Stream timeline: data table" aria-expanded={table} icon={<Table2 />} className={table ? 'is-pressed' : undefined} onClick={() => { setTable(!table); }} />
          </Tooltip>
        </div>
      }
    >
      <div className="strm-tl__body">
        <ul className="strm-legend strm-legend--lanes" aria-label="Legend">
          <li><span className="strm-legend__swatch is-wait" />Waiting for first token</li>
          <li><span className="strm-legend__swatch is-decode" />Decoding</li>
          {failed ? <li><span className="strm-legend__swatch is-failed tone-crit" />Failed</li> : null}
          <li className="strm-legend__x">Seconds since the level started</li>
        </ul>
        <Lanes key={t.level} t={t} />
        {t.truncated ? <p className="strm-note">Shows the first {t.requests.length} requests of this level; the payload keeps no more.</p> : null}
        {table ? <RequestsTable t={t} /> : null}
      </div>
    </Panel>
  );
}
