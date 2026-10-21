// The evaluation while it runs: the score so far with the outcome counts, the scenario running now (live timer), the
// board of every scenario by category and the latest verdicts (elapsed and remaining time are the run's Progress
// panel's). Before the first snapshot the same layout shimmers while the payload checks the endpoint.
import { LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { announce } from '../../../design/components/LiveAnnouncer';
import { Skeleton } from '../../../design/components/Skeleton';
import { useNow } from '../../../design/useNow';
import type { BenchRun } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { Banner } from '../../alerts/parts/Banner';
import { stopwatch } from '../model';
import { Board, BoardSkeleton } from './Board';
import {
  boardGroups,
  boardTiles,
  categoryLabels,
  quarter,
  scenarios,
  scorePct,
  STATUS_LOOK,
  ownWarnings,
  SUITE_SHAPE,
  warningParts,
  type Live,
  type NodeEval,
  type Tile,
} from './model';
import { CategoryTag, Counters, DifficultyDots, OutcomeBar, ScoreRing, StatusGlyph } from './parts';

export function LiveView({ ev, live, onOpen }: { ev: NodeEval; live: Live; onOpen: (id: string) => void }) {
  const tiles = useMemo(() => boardTiles(live, ev.records, true), [live, ev.records]);
  const groups = useMemo(() => boardGroups(tiles, categoryLabels(live, ev.records)), [tiles, live, ev.records]);
  const summaries = useMemo(() => new Map([...ev.records.map((r) => [r.id, r.summary] as const), ...live.recent.map((r) => [r.id, r.summary] as const)]), [ev.records, live.recent]);
  const finished = useMemo(() => new Set(ev.records.map((r) => r.id)), [ev.records]);
  const score = scorePct(live.points, live.maxPoints);
  useMilestones(live, score);

  return (
    <div className="te">
      <LiveNotes live={live} />
      <div className="te-hero">
        <ScoreBlock score={score} caption="Score so far" lines={[live.maxPoints ? `${live.points} of ${live.maxPoints} points` : 'Nothing graded yet', `${live.done} of ${live.total} scenarios`]} />
        <Counters counts={live.counts} />
        <OutcomeBar counts={live.counts} total={live.total} label={outcomeLabel(live.counts, live.done, live.total)} />
      </div>
      {/* A short board (Core, Hard Mode) sits beside the running scenario, with the latest verdicts across below. */}
      <div className={`te-live${groups.length <= 6 ? ' te-live--compact' : ''}`}>
        <NowRunning live={live} />
        <div className="te-live__board">
          <h3 className="te-h">Scenarios</h3>
          <Board groups={groups} summaries={summaries} onOpen={onOpen} latest={live.recent[0]?.id} label="Scenario board" />
        </div>
        <Recent live={live} tiles={tiles} finished={finished} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** "12 of 69 scenarios done: 9 passed, 2 partial, 1 failed, 0 excluded". */
export function outcomeLabel(c: Record<'pass' | 'partial' | 'fail' | 'excluded', number>, done: number, total: number): string {
  return `${done} of ${total} scenarios done: ${c.pass} passed, ${c.partial} partial, ${c.fail} failed, ${c.excluded} excluded`;
}

/** The ring with its caption and two lines of context ("20 of 24 points", "12 of 69 scenarios"). */
export function ScoreBlock({ score, caption, lines, tone }: { score: number | null; caption: string; lines: readonly string[]; tone?: 'accent' | 'stale' }) {
  return (
    <div className="te-score">
      <ScoreRing score={score} size={104} tone={tone} label={score === null ? `${caption}: nothing graded yet` : `${caption}: ${score}%`} />
      <div className="te-score__text">
        <p className="te-score__caption">{caption}</p>
        {lines.map((l) => <p key={l} className="te-score__line num">{l}</p>)}
      </div>
    </div>
  );
}

/** Quarter milestones, announced once each while the run is on screen (never per scenario). */
function useMilestones(live: Live, score: number | null) {
  const q = quarter(live.done, live.total);
  const seen = useRef(q);
  useEffect(() => {
    // 'warning': the announcer drops 'info' (as for "Reconnected to Sparkline.").
    if (q > seen.current && q < 4) announce(`Tool-calling evaluation ${q * 25}% done: ${live.done} of ${live.total} scenarios${score === null ? '' : `, score so far ${score}%`}.`, 'warning');
    seen.current = q;
  }, [q, live.done, live.total, score]);
}

/** Preflight warnings (the payload's own text, which may carry `code`) and scenarios excluded so far. */
function LiveNotes({ live }: { live: Live }) {
  const n = live.counts.excluded;
  const warnings = ownWarnings(live.warnings, n > 0);
  if (!warnings.length && !n) return null;
  return (
    <div className="te-notes">
      {warnings.map((w) => {
        const { title, text } = warningParts(w);
        return <Banner key={w} tone="warn" title={title} text={text || undefined} />;
      })}
      {n ? (
        <Banner
          tone="warn"
          title={`${scenarios(n)} excluded so far`}
          text={`${n === 1 ? 'It' : 'They'} timed out or hit server errors, so ${n === 1 ? 'it doesn’t' : 'they don’t'} count toward the score, and the final score won’t be comparable with complete runs.`}
        />
      ) : null}
    </div>
  );
}

function NowRunning({ live }: { live: Live }) {
  const cur = live.current;
  return (
    <section className={`te-now${cur ? ' is-busy' : ''}`} aria-label="Now running">
      {/* Keyed: each scenario swaps in at once and fades up (CSS), however fast the scenarios come. */}
      <div key={cur?.id ?? 'between'} className="te-now__body">
        {cur ? (
          <>
            <div className="te-now__top">
              <p className="te-now__eyebrow">
                <span className="te-now__dot" aria-hidden="true" />
                Now running · {Math.min(live.done + 1, live.total)} of {live.total}
              </p>
              <RunningTimer since={cur.startedTs} />
            </div>
            <p className="te-now__title">
              <span className="te-now__id num">{cur.id}</span> {cur.title}
            </p>
            <div className="te-now__meta">
              <span className="te-now__cat">
                <CategoryTag cat={cur.category} />
                {live.catLabels[cur.category] ?? ''}
              </span>
              <DifficultyDots value={cur.difficulty} />
            </div>
            {cur.expected ? <p className="te-now__what">{cur.expected}</p> : null}
          </>
        ) : (
          <p className="te-now__idle">
            <LoaderCircle aria-hidden="true" className="te-glyph--spin" />
            {live.done >= live.total ? 'Scoring the run…' : 'Starting the next scenario…'}
          </p>
        )}
      </div>
    </section>
  );
}

function RunningTimer({ since }: { since: number | null }) {
  const now = useNow(1000) / 1000 + useCluster.getState().clockOffset;
  if (since === null) return null;
  return (
    <span className="te-now__timer num">
      <span className="visually-hidden">Running for </span>
      {stopwatch(Math.max(0, now - since))}
    </span>
  );
}

function Recent({ live, tiles, finished, onOpen }: { live: Live; tiles: readonly Tile[]; finished: ReadonlySet<string>; onOpen: (id: string) => void }) {
  const titles = useMemo(() => new Map(tiles.map((t) => [t.id, t.title])), [tiles]);
  return (
    <div className="te-recent">
      <h3 className="te-h">Recent results</h3>
      {live.recent.length ? (
        // A new verdict fades in at the top (CSS, on mount only); the rest move down at once, whatever the pace.
        <ol className="te-recent__list">
          {live.recent.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`te-recent__item tone-${STATUS_LOOK[r.outcome].tone ?? 'stale'}`}
                aria-label={`${r.id} ${titles.get(r.id) || ''}: ${STATUS_LOOK[r.outcome].label.toLowerCase()}${r.summary ? `. ${r.summary}` : ''}`}
                disabled={!finished.has(r.id)}
                onClick={() => { onOpen(r.id); }}
              >
                <StatusGlyph status={r.outcome} />
                <span className="te-recent__id num">{r.id}</span>
                <span className="te-recent__title">{titles.get(r.id) || r.id}</span>
                <span className="te-recent__verdict">{STATUS_LOOK[r.outcome].label}</span>
                {r.summary ? <span className="te-recent__summary">{r.summary}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="te-empty">Each finished scenario appears here with the evaluator’s verdict.</p>
      )}
    </div>
  );
}

/** What the payload is doing before its first snapshot: its phase ("Checking tool calling") at the endpoint. */
function waitingText(run: BenchRun, endpoint: string): string {
  if (run.status === 'queued') return 'Waiting to start…';
  const phase = run.phase.replace(/…$/, '').trim();
  return phase && phase !== 'Starting' ? `${phase} · ${endpoint}` : `Checking that ${endpoint} accepts tool calls…`;
}

/** Before the first snapshot: the live layout as skeletons (the board in the suite's real shape). */
export function WaitingView({ run, endpoint, message }: { run: BenchRun; endpoint: string; message?: string }) {
  const suite = typeof run.params.suite === 'string' ? run.params.suite : '';
  const shape = SUITE_SHAPE[suite] ?? SUITE_SHAPE.standard ?? [];
  return (
    <div className="te">
      <p className="te-status">
        <LoaderCircle aria-hidden="true" className="te-glyph--spin" />
        {message ?? waitingText(run, endpoint)}
      </p>
      <div className="te-hero" aria-hidden="true">
        <div className="te-score">
          <Skeleton width={104} height={104} radius="50%" />
          <div className="te-score__text">
            <Skeleton width={80} height={11} />
            <Skeleton width={112} height={14} />
            <Skeleton width={128} height={14} />
          </div>
        </div>
        <div className="te-counters">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="te-counter">
              <Skeleton width={30} height={26} radius={6} />
              <Skeleton width={58} height={11} />
            </div>
          ))}
        </div>
        <Skeleton className="te-obar" height={8} radius={999} />
      </div>
      <div className={`te-live${shape.length <= 6 ? ' te-live--compact' : ''}`} aria-hidden="true">
        <div className="te-now te-now--skeleton">
          <Skeleton width={150} height={11} />
          <Skeleton width="72%" height={18} radius={6} />
          <Skeleton width={180} height={14} />
          <Skeleton width="92%" height={13} />
        </div>
        <div className="te-live__board">
          <Skeleton width={72} height={11} className="te-h" />
          <BoardSkeleton shape={shape} />
        </div>
        <div className="te-recent">
          <Skeleton width={96} height={11} className="te-h" />
          {[0, 1, 2].map((i) => <Skeleton key={i} height={44} radius={10} />)}
        </div>
      </div>
    </div>
  );
}
