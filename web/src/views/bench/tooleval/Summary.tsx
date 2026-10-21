// After the run: the score with its rating and the verdict counts (the live view's hero, settled), the facts that
// qualify it (share graded, safety gate, deployability, latency, tokens), the reasons a score is capped or not
// comparable, upstream's own JSON and the comparability note; then the score per category and per Hard Mode
// capability. A run that stopped early shows what finished, clearly marked incomplete.
import { Download, ShieldAlert, ShieldCheck, Star, TrendingDown, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../../design/components/Button';
import { announce } from '../../../design/components/LiveAnnouncer';
import { Panel } from '../../../design/components/Panel';
import type { BenchRun } from '../../../lib/types';
import { Banner } from '../../alerts/parts/Banner';
import { valueWithUnit } from '../model';
import { Board } from './Board';
import { outcomeLabel, ScoreBlock } from './Live';
import {
  boardGroups,
  boardTiles,
  categoryLabels,
  excludedSentence,
  formatRate,
  formatTokens,
  OUTCOMES,
  ownWarnings,
  parseRating,
  scenarios,
  scorePct,
  tally,
  warningParts,
  weakestCategory,
  type NodeEval,
  type Outcome,
  type Summary,
} from './model';
import { CategoryTag, Counters, OutcomeBar, ScoreRing, StatusGlyph } from './parts';

const UPSTREAM = 'https://github.com/SeraphimSerapis/tool-eval-bench';

/** Verdict counts from the summary (authoritative even if a record was dropped on the way). */
function summaryCounts(s: Summary): Record<Outcome, number> {
  const c: Record<Outcome, number> = { pass: 0, partial: 0, fail: 0, excluded: s.excluded.length };
  for (const cat of s.categories) {
    c.pass += cat.pass;
    c.partial += cat.partial;
    c.fail += cat.fail;
  }
  return c;
}

export function DoneView({ run, ev, summary, countUp }: { run: BenchRun; ev: NodeEval; summary: Summary; countUp: boolean }) {
  const rating = parseRating(summary.rating);
  const counts = summaryCounts(summary);
  const total = OUTCOMES.reduce((a, o) => a + counts[o], 0);
  const graded = total - counts.excluded;
  // Count up from zero once, when the run finished while on screen (AnimatedNumber is instant under reduced motion).
  const [shown, setShown] = useState(countUp ? 0 : summary.score);
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setShown(summary.score); });
    return () => { cancelAnimationFrame(raf); };
  }, [summary.score]);
  const word = rating?.word ?? '';
  const said = useRef(false);
  useEffect(() => {
    // The result is the milestone worth hearing, once ('warning': the announcer drops 'info'); not again when another
    // node's result is picked.
    if (!countUp || said.current || summary.score === null) return;
    said.current = true;
    announce(`Tool-calling score ${summary.score}%${word ? `, rated ${word}` : ''}.`, 'warning');
  }, [countUp, summary.score, word]);

  const violations = summary.safetyWarnings.length;
  const gate = violations === 0 && summary.safetyGatePassed !== false;
  return (
    <div className="te">
      <div className="te-hero te-hero--done">
        <div className="te-score te-score--lg">
          <ScoreRing score={shown} size={136} label={summary.score === null ? 'No score' : `Tool-calling score ${summary.score}%${word ? `, rated ${word}` : ''}`} />
          <div className="te-score__text">
            {rating ? (
              <p className="te-rating">
                <Stars n={rating.stars} />
                <span className="te-rating__word">{rating.word}</span>
                <span className="visually-hidden">, {rating.stars} of 5 stars</span>
              </p>
            ) : null}
            {rating?.capped ? (
              <p className="te-capped tone-warn">
                <ShieldAlert aria-hidden="true" />
                Safety-capped rating
              </p>
            ) : null}
            <p className="te-score__line num">
              {summary.totalPoints ?? '—'} of {summary.maxPoints ?? '—'} points
            </p>
          </div>
        </div>
        <Counters counts={counts} />
        <OutcomeBar counts={counts} total={total} label={outcomeLabel(counts, total, total)} />
        <dl className="te-kpis">
          <Kpi
            label="Scenarios graded"
            value={summary.completionRate === null ? '—' : formatRate(summary.completionRate)}
            foot={`${graded} of ${total}`}
            tone={summary.completionRate !== null && summary.completionRate < 100 ? 'warn' : undefined}
          />
          <Kpi
            label="Safety gate"
            value={gate ? 'Passed' : 'Failed'}
            icon={gate ? ShieldCheck : ShieldAlert}
            tone={gate ? 'ok' : 'crit'}
            alert={!gate}
            foot={gate ? 'No violations' : `${violations} ${violations === 1 ? 'violation' : 'violations'}${rating?.capped ? ', rating capped' : ''}`}
          />
          <Kpi label="Deployability" value={summary.deployability === null ? '—' : `${summary.deployability}%`} foot="Score and speed" />
          <Kpi label="Responsiveness" value={summary.responsiveness === null ? '—' : `${summary.responsiveness}%`} foot="From the median turn" />
          {/* As the run's results show it ("2437 ms"), so the same number reads the same on the page. */}
          <Kpi label="Median turn latency" value={valueWithUnit(summary.medianTurnMs, 'ms')} foot="One model response" />
          <Kpi label="Tokens" value={formatTokens(summary.totalTokens)} foot={summary.tokenEfficiency === null ? 'Prompt and completion' : `${summary.tokenEfficiency} points per 1k`} />
        </dl>
      </div>
      <SummaryNotes summary={summary} capped={rating?.capped ?? false} warnings={ev.live?.warnings ?? []} />
      <Credits summary={summary} runId={run.id} />
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span className="te-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={i <= n ? 'is-on' : undefined} strokeWidth={2} />)}
    </span>
  );
}

function Kpi({ label, value, foot, tone, icon: Icon, alert }: { label: string; value: string; foot: string; tone?: 'ok' | 'warn' | 'crit'; icon?: LucideIcon; alert?: boolean }) {
  return (
    <div className={`te-kpi${tone ? ` tone-${tone}` : ''}${alert || tone === 'warn' ? ' is-alert' : ''}`}>
      <dt>{label}</dt>
      <dd className="te-kpi__value">
        {Icon ? <Icon aria-hidden="true" /> : null}
        {value}
      </dd>
      <dd className="te-kpi__foot">{foot}</dd>
    </div>
  );
}

/** What capped the rating (each violation), why the score is not comparable (exclusions), preflight warnings. */
function SummaryNotes({ summary, capped, warnings: all }: { summary: Summary; capped: boolean; warnings: readonly string[] }) {
  const n = summary.excluded.length;
  const v = summary.safetyWarnings.length;
  const warnings = ownWarnings(all, n > 0);
  if (!n && !v && !warnings.length) return null;
  const [lead = '', rest = ''] = excludedSentence(n).split('; ');
  return (
    <div className="te-notes">
      {v ? (
        <div className="ops-banner tone-crit te-safety">
          <ShieldAlert aria-hidden="true" />
          <div>
            <p className="ops-banner__title">{capped ? 'Safety violations capped the rating' : v === 1 ? 'A safety violation' : `${v} safety violations`}</p>
            <p className="ops-banner__text">
              {capped
                ? 'The safety-critical scenarios scored under 50%, so the rating is capped. The score itself is unchanged.'
                : 'The rating is not capped: the safety-critical scenarios still scored 50% or more.'}
            </p>
            <ul className="te-safety__list">
              {summary.safetyWarnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
          <span />
        </div>
      ) : null}
      {n ? <Banner tone="warn" title={lead} text={`${rest.charAt(0).toUpperCase()}${rest.slice(1)} Excluded: ${summary.excluded.join(', ')}.`} /> : null}
      {warnings.map((w) => {
        const { title, text } = warningParts(w);
        return <Banner key={w} tone="warn" title={title} text={text || undefined} />;
      })}
    </div>
  );
}

/** Upstream's own JSON as a file (it never leaves the browser). */
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

function Credits({ summary, runId }: { summary: Summary; runId: string }) {
  const envelope = summary.envelope;
  return (
    <footer className="te-foot">
      {envelope ? (
        <div className="te-foot__download">
          <Button size="sm" icon={<Download />} onClick={() => { download(envelope, `tool-eval-bench-${runId}.json`); }}>
            Download tool-eval-bench JSON
          </Button>
          <span>Upstream’s own result format, for comparing with sparkrun or Spark Arena runs.</span>
        </div>
      ) : null}
      <p>
        Scores compare only between runs of the same tool-eval-bench version and settings
        {summary.fingerprint ? <> (fingerprint <code>{summary.fingerprint}</code>)</> : null}. Scenarios and grading:{' '}
        <a href={UPSTREAM} target="_blank" rel="noreferrer">tool-eval-bench</a> by SeraphimSerapis (MIT).
      </p>
    </footer>
  );
}

// ------------------------------------------------------------------------------------------------ categories

const COUNT_WORD = { pass: 'passed', partial: 'partial', fail: 'failed' } as const;

/** A verdict count: glyph + number (+ the word, shown where no column header names it). */
function Count({ n, outcome }: { n: number; outcome: 'pass' | 'partial' | 'fail' }) {
  return (
    <span className={`te-count tone-${outcome === 'pass' ? 'ok' : outcome === 'partial' ? 'warn' : 'crit'}${n ? '' : ' is-zero'}`}>
      {n ? <StatusGlyph status={outcome} /> : null}
      <span className="num">{n}</span>
      <span className="te-count__word"> {COUNT_WORD[outcome]}</span>
    </span>
  );
}

/** One labelled bar per row: the percentage of points earned, its value at the tip, then the row's own facts. */
function ScoreRows({ label, head, rows }: { label: string; head: readonly string[]; rows: readonly { key: string; name: ReactNode; percent: number | null; facts: ReactNode }[] }) {
  return (
    <ul className="te-rows" aria-label={label} style={{ '--te-facts': head.length - 3 } as CSSProperties}>
      <li className="te-rows__head" aria-hidden="true">
        {head.map((h, i) => <span key={i}>{h}</span>)}
      </li>
      {rows.map((r) => (
        <li key={r.key} className="te-row">
          <span className="te-row__name">{r.name}</span>
          <span className="te-row__bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.max(0, r.percent ?? 0))}%` }} />
          </span>
          <span className="te-row__pct num">{r.percent === null ? '—' : `${r.percent}%`}</span>
          <span className="te-row__facts">{r.facts}</span>
        </li>
      ))}
    </ul>
  );
}

export function CategoryPanel({ summary }: { summary: Summary }) {
  const weakest = weakestCategory(summary);
  const cats = useMemo(
    () =>
      summary.categories.map((c) => ({
        key: c.category,
        percent: c.percent,
        name: (
          <>
            <CategoryTag cat={c.category} />
            <span className="visually-hidden">{c.category} · </span>
            <span className="te-row__label">{c.label || c.category}</span>
            {c.category === weakest ? (
              <span className="te-weakest">
                <TrendingDown aria-hidden="true" />
                Weakest
              </span>
            ) : null}
          </>
        ),
        facts: (
          <>
            <Count n={c.pass} outcome="pass" />
            <Count n={c.partial} outcome="partial" />
            <Count n={c.fail} outcome="fail" />
          </>
        ),
      })),
    [summary.categories, weakest],
  );
  if (!cats.length) return null;
  const caps = summary.capabilities.map((c) => ({
    key: c.capability,
    percent: c.percent,
    name: <span className="te-row__label">{c.label || c.capability}</span>,
    facts: <span className="te-row__points num">{c.earned} of {c.max} points</span>,
  }));
  return (
    <Panel title="Score per category" subtitle="Points earned of those possible: a pass scores 2, a partial 1">
      <div className="te">
        <ScoreRows label="Score per category" head={['Category', 'Score', '', 'Passed', 'Partial', 'Failed']} rows={cats} />
        {caps.length ? (
          <div>
            <h3 className="te-h">Hard Mode by capability</h3>
            <p className="te-caps__sub">Each Hard Mode scenario tests one or more capabilities and counts under each.</p>
            <ScoreRows label="Hard Mode score per capability" head={['Capability', 'Score', '', 'Points']} rows={caps} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ stopped early

export function StoppedView({ run, ev, onOpen }: { run: BenchRun; ev: NodeEval; onOpen: (id: string) => void }) {
  const tiles = useMemo(() => boardTiles(ev.live, ev.records, false), [ev.live, ev.records]);
  const groups = useMemo(() => boardGroups(tiles, categoryLabels(ev.live, ev.records)), [tiles, ev.live, ev.records]);
  const summaries = useMemo(() => new Map(ev.records.map((r) => [r.id, r.summary])), [ev.records]);
  const t = tally(tiles);
  const total = Math.max(ev.live?.total ?? 0, tiles.length);
  const cancelled = run.status === 'cancelled' || ev.status === 'cancelled';
  const how = cancelled ? 'was cancelled' : run.status === 'failed' || ev.status === 'failed' ? 'stopped' : 'ended without a summary';
  const ungraded = t.done > 0 && t.maxPoints === 0;
  return (
    <div className="te">
      <div className="te-notes">
        {ungraded ? (
          <Banner tone="warn" title={`Incomplete: none of the ${scenarios(t.done)} that ran could be graded`} text="They timed out or hit connection or server errors, so there is no score." />
        ) : (
          <Banner
            tone={cancelled ? 'stale' : 'warn'}
            title={`Incomplete: the evaluation ${how} after ${t.done} of ${total} scenarios`}
            text="The score covers only the finished scenarios, so it isn’t comparable with complete runs."
          />
        )}
        {ownWarnings(ev.live?.warnings ?? [], true).map((w) => {
          const { title, text } = warningParts(w);
          return <Banner key={w} tone="warn" title={title} text={text || undefined} />;
        })}
      </div>
      <div className="te-hero">
        <ScoreBlock score={scorePct(t.points, t.maxPoints)} tone="stale" caption="Score of finished scenarios" lines={[t.maxPoints ? `${t.points} of ${t.maxPoints} points` : 'Nothing graded', `${t.done} of ${total} scenarios`]} />
        <Counters counts={t.counts} />
        <OutcomeBar counts={t.counts} total={total} label={outcomeLabel(t.counts, t.done, total)} />
      </div>
      <div className="te-stopped__board">
        <h3 className="te-h">Scenarios</h3>
        <Board groups={groups} summaries={summaries} onOpen={onOpen} wide label="Scenario board" />
      </div>
    </div>
  );
}
