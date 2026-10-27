// The hero of a running llm-inference (or llm-showcase) benchmark: every concurrent request as a live card, the
// sweep's levels, the aggregate output and where each stream stands. Before the first snapshot the same layout stands in as placeholders,
// so the panel never opens as an empty box. Level changes are announced once; nothing else is.
import { Check, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatedNumber } from '../../../design/components/AnimatedNumber';
import { announce } from '../../../design/components/LiveAnnouncer';
import { Panel } from '../../../design/components/Panel';
import { SegmentedControl } from '../../../design/components/SegmentedControl';
import { Skeleton } from '../../../design/components/Skeleton';
import { Sparkline } from '../../../design/components/Sparkline';
import { Stat } from '../../../design/components/Stat';
import type { Formatter } from '../../../lib/format';
import { formatValue } from '../model';
import {
  accumulate,
  cardState,
  countsText,
  densityFor,
  formatTokS,
  gridColumns,
  stateCounts,
  STATE_LOOK,
  type CardState,
  type Density,
  type DensityChoice,
  type LiveSnapshot,
  type Stream,
  type Texts,
} from './model';
import { SkeletonCard, StreamCard, StreamDialog } from './StreamCard';
import './streams.css';

const tokS = (n: number) => formatTokS(n);
const toneClass = (state: CardState) => (STATE_LOOK[state].tone === 'accent' ? 'strm-tone-accent' : `tone-${STATE_LOOK[state].tone}`);
const tokSText = (n: number) => `${formatTokS(n)} tok/s`;
const msParts: Formatter = (n, unit) => (unit === 's' || (!unit && n >= 1000) ? { value: formatValue(n / 1000), unit: 's' } : { value: formatValue(n), unit: 'ms' });
const tokSParts: Formatter = (n) => ({ value: formatTokS(n), unit: 'tok/s' });
const ofParts = (total: number): Formatter => (n) => ({ value: String(Math.round(n)), unit: `of ${total}` });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SIZES = [
  { value: 'text', label: 'Text', ariaLabel: 'Text: cards show several lines' },
  { value: 'compact', label: 'Compact', ariaLabel: 'Compact: one line per stream' },
] as const;

/** `requests`: the run's request count, which every later level of a sweep runs (at least one per stream). */
export function LivePanel({ snap, requests, actions }: { snap: LiveSnapshot; requests: number; actions?: ReactNode }) {
  const [choice, setChoice] = useState<DensityChoice>('auto');
  const [open, setOpen] = useState<number | null>(null);
  // The text each card has seen, folded in once per snapshot (derived state: no extra render pass per update).
  const [seen, setSeen] = useState<{ snap: LiveSnapshot; texts: Texts }>(() => ({ snap, texts: accumulate(null, snap) }));
  if (seen.snap !== snap) setSeen({ snap, texts: accumulate(seen.texts, snap) });

  const n = snap.streams.length;
  const density = densityFor(n, choice);
  const sweeping = snap.levels.length > 1;
  const levelText = `Level ${snap.level_index + 1} of ${snap.levels.length}`;

  // Announce a new level once (not on first sight: the page may open mid-sweep). 'info' is filtered by the announcer.
  const announced = useRef(snap.level_index);
  useEffect(() => {
    if (!sweeping || announced.current === snap.level_index) return;
    announced.current = snap.level_index;
    announce(`${levelText}: ${plural(snap.level, 'stream', 'streams')}`, 'warning');
  }, [sweeping, snap.level_index, snap.level, levelText]);

  const opened = open === null ? undefined : snap.streams.find((s) => s.slot === open);
  return (
    <Panel
      title={snap.showcase ? 'Streams' : 'Concurrency streams'}
      subtitle={`${plural(snap.level, 'stream', 'streams')} in flight${sweeping ? ` · level ${snap.level_index + 1} of ${snap.levels.length}` : ''}`}
      actions={
        <div className="strm-actions">
          {actions}
          <SegmentedControl label="Card size" size="sm" options={SIZES} value={density === 'compact' ? 'compact' : 'text'} onChange={setChoice} />
        </div>
      }
      className="strm-live"
    >
      <div className="strm-live__body">
        {sweeping ? <LevelRail levels={snap.levels} current={snap.level_index} requests={requests} snap={snap} /> : null}
        <StatRow snap={snap} />
        <Grid density={density} count={n} label={`Streams: ${countsText(stateCounts(snap.streams))}`}>
          {snap.streams.map((s) => (
            <StreamCard key={s.slot} stream={s} text={seen.texts.get(s.slot)} state={cardState(s, true)} density={density} requests={snap.requests} showcase={snap.showcase} live onOpen={setOpen} />
          ))}
        </Grid>
      </div>
      {opened ? (
        <StreamDialog
          stream={opened}
          text={seen.texts.get(opened.slot)}
          state={cardState(opened, true)}
          live
          requests={snap.requests}
          showcase={snap.showcase}
          context={sweeping ? `${levelText} · ${plural(snap.level, 'stream', 'streams')}` : plural(snap.level, 'stream', 'streams')}
          onClose={() => { setOpen(null); }}
        />
      ) : null}
    </Panel>
  );
}

export function Grid({ density, count, label, children }: { density: Density; count: number; label?: string; children: ReactNode }) {
  return (
    <div className={`strm-grid strm-grid--${density}`} role={label ? 'list' : undefined} aria-label={label} style={{ '--cols': gridColumns(count, density) } as CSSProperties}>
      {children}
    </div>
  );
}

/** Every level of the sweep on one rail: finished ones with a check and their output (or how many failed, when
 * none got through), the current one with its progress, the rest quiet. Before the first snapshot (`snap` missing)
 * every level is still to come. */
function LevelRail({ levels, current, requests, snap }: { levels: readonly number[]; current: number; requests: number; snap?: LiveSnapshot }) {
  const finished = new Map((snap?.completed_levels ?? []).map((l) => [l.level, l]));
  return (
    <ol className="strm-rail" aria-label="Concurrency levels">
      {levels.map((level, i) => {
        const state = snap && i < current ? 'done' : snap && i === current ? 'current' : 'next';
        const done = state === 'done' ? finished.get(level) : undefined;
        const failed = done?.ok === 0 ? (done.failed ?? done.requests ?? 0) : 0; // every request of the level failed
        const fill = state === 'done' ? 1 : state === 'current' && snap?.requests ? snap.done / snap.requests : 0;
        return (
          <li key={level} className={`strm-rail__step is-${state}${failed ? ' is-failed tone-crit' : ''}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="strm-rail__head">
              <span className="strm-rail__mark" aria-hidden="true">{failed ? <CircleX /> : state === 'done' ? <Check strokeWidth={3} /> : null}</span>
              <span className="strm-rail__level">
                <span className="visually-hidden">{failed ? 'Failed: ' : state === 'done' ? 'Finished: ' : state === 'current' ? 'Running: ' : 'To come: '}</span>
                {plural(level, 'stream', 'streams')}
              </span>
            </span>
            <span className="strm-rail__value num">
              {failed
                ? `${failed} failed`
                : state === 'done'
                  ? done?.out_tok_s != null ? `${formatTokS(done.out_tok_s)} tok/s` : 'Done'
                  : state === 'current' && snap ? `${snap.done} of ${snap.requests}` : plural(Math.max(requests, level), 'request', 'requests')}
            </span>
            <span className="strm-rail__bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, fill)})` }} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Where each slot stands, one dot per stream in slot order, with the counts spelled out under it. */
function DotMatrix({ streams }: { streams: readonly Stream[] }) {
  const counts = stateCounts(streams);
  const text = countsText(counts);
  return (
    <span className="strm-dots">
      <span className="strm-dots__grid" role="img" aria-label={text} style={{ '--per-row': streams.length > 16 ? Math.ceil(streams.length / 2) : Math.max(8, streams.length) } as CSSProperties}>
        {streams.map((s) => <span key={s.slot} className={`strm-dot is-${cardState(s, true)} ${toneClass(cardState(s, true))}`} />)}
      </span>
      <span className="strm-dots__text" aria-hidden="true">{text}</span>
    </span>
  );
}

function StatRow({ snap }: { snap: LiveSnapshot }) {
  const counts = stateCounts(snap.streams);
  const active = counts.wait + counts.decode;
  const total = snap.streams.length;
  const activeParts = useMemo(() => ofParts(total), [total]);
  const requestParts = useMemo(() => ofParts(snap.requests), [snap.requests]);
  const hist = snap.tok_s_hist;
  const peak = Math.max(0, snap.tok_s ?? 0, ...hist.map((v) => v ?? 0));
  const sweeping = snap.levels.length > 1;
  const server = snap.server_tok_s !== null;
  return (
    <div className={`strm-stats${server ? ' strm-stats--server' : ''}`}>
      <div className="strm-hero">
        <div className="strm-hero__text">
          <span className="strm-hero__label">Aggregate output</span>
          <span className="strm-hero__value">
            <AnimatedNumber value={snap.tok_s} format={tokS} className="strm-hero__num" />
            <span className="strm-hero__unit">tok/s</span>
          </span>
          <span className="strm-hero__foot">{snap.showcase ? 'Sum of the decoding streams' : 'All streams over the last 2 s'}{peak > 0 ? ` · peak ${formatTokS(peak)}` : ''}</span>
        </div>
        <div className="strm-hero__trend">
          {hist.length > 1 ? <Sparkline label={sweeping ? 'Aggregate output this level' : 'Aggregate output'} values={hist} format={tokSText} height={48} min={0} /> : null}
        </div>
      </div>
      <Stat label="Active streams" value={active} format={activeParts} footer={<DotMatrix streams={snap.streams} />} />
      <Stat
        label="Requests done"
        value={snap.done}
        format={requestParts}
        footer={
          snap.failed ? (
            <span className="strm-failed tone-crit">
              <CircleX aria-hidden="true" />
              {snap.failed} failed
            </span>
          ) : sweeping ? 'This level' : 'None failed'
        }
      />
      <Stat label="Time to first token" value={snap.ttft_p50_ms} format={msParts} footer={sweeping ? 'Median this level' : 'Median so far'} />
      {server ? <Stat label="Server tok/s" value={snap.server_tok_s} format={tokSParts} footer="The server’s own count" /> : null}
    </div>
  );
}

/** Before the first snapshot: the panel as it will look, with the planned levels and one placeholder per stream. */
export function LiveSkeleton({ endpoint, levels, requests, title = 'Concurrency streams' }: { endpoint: string; levels: readonly number[]; requests: number; title?: string }) {
  const count = levels[0] ?? 1;
  const density = densityFor(count, 'auto');
  return (
    <Panel
      title={title}
      subtitle={
        <span className="strm-connecting">
          <LoaderCircle aria-hidden="true" className="strm-spin" />
          Connecting to {endpoint}…
        </span>
      }
      className="strm-live"
      busy
    >
      <div className="strm-live__body">
        {levels.length > 1 ? <LevelRail levels={levels} current={0} requests={requests} /> : null}
        <div className="strm-stats" aria-hidden="true">
          <div className="strm-hero">
            <div className="strm-hero__text">
              <span className="strm-hero__label">Aggregate output</span>
              <Skeleton width={150} height={40} radius={10} />
              <Skeleton width={180} height={10} />
            </div>
          </div>
          {['Active streams', 'Requests done', 'Time to first token'].map((label) => (
            <div key={label} className="stat">
              <div className="stat__label">{label}</div>
              <Skeleton width={84} height={24} radius={8} />
              <Skeleton width={110} height={10} />
            </div>
          ))}
        </div>
        <Grid density={density} count={count}>
          {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} slot={i} density={density} />)}
        </Grid>
      </div>
    </Panel>
  );
}
