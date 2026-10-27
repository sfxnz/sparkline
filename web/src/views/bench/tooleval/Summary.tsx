// After the run: the score with its rating and the verdict counts (the live view's hero, settled), the facts that
// qualify it (share graded, safety gate, deployability, latency, tokens), the reasons a score is capped or not
// comparable, upstream's own JSON and the comparability note; then the score per category and per Hard Mode
// capability. A run of several trials leads with the mean score, every trial's score and how reliably scenarios pass
// (the rest is the last trial's, as in upstream's JSON). A run that stopped early shows what finished, clearly marked
// incomplete.
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
  oneDecimal,
  OUTCOMES,
  ownWarnings,
  parseRating,
  scenarios,
  scorePct,
  tally,
  trialRecords,
  warningParts,
  weakestCategory,
  type NodeEval,
  type Outcome,
  type Rating,
  type Summary,
  type TrialStats,
} from './model';
import { CategoryTag, Counters, OutcomeBar, ScoreRing, StatusGlyph } from './parts';
import { TrialPlot, TrialRail } from './Trials';

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
  // Over several trials the headline is the mean, rated as upstream rates it, and safety covers every trial.
  const stats = summary.trials > 1 ? summary.trialStats : null;
  const score = stats ? (stats.mean ?? summary.score) : summary.score;
  const rating = parseRating(stats?.rating || summary.rating);
  const counts = summaryCounts(summary);
  const total = OUTCOMES.reduce((a, o) => a + counts[o], 0);
  const graded = total - counts.excluded;
  // Count up from zero once, when the run finished while on screen (AnimatedNumber is instant under reduced motion).
  const [shown, setShown] = useState(countUp ? 0 : score);
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setShown(score); });
    return () => { cancelAnimationFrame(raf); };
  }, [score]);
  const word = rating?.word ?? '';
  const spoken = score === null ? '' : stats ? `Tool-calling mean score ${oneDecimal(score)}% over ${summary.trials} trials` : `Tool-calling score ${score}%`;
  const said = useRef(false);
  useEffect(() => {
    // The result is the milestone worth hearing, once ('warning': the announcer drops 'info'); not again when another
    // node's result is picked.
    if (!countUp || said.current || !spoken) return;
    said.current = true;
    announce(`${spoken}${word ? `, rated ${word}` : ''}.`, 'warning');
  }, [countUp, spoken, word]);

  const violations = stats ? stats.safetyWarnings : summary.safetyWarnings;
  const gate = violations.length === 0 && (stats !== null || summary.safetyGatePassed !== false);
  const gateKpi = (
    <Kpi
      label="Safety gate"
      value={gate ? 'Passed' : 'Failed'}
      icon={gate ? ShieldCheck : ShieldAlert}
      tone={gate ? 'ok' : 'crit'}
      alert={!gate}
      foot={gate ? (stats ? 'No violations in any trial' : 'No violations') : `${violations.length} ${violations.length === 1 ? 'violation' : 'violations'}${rating?.capped ? ', rating capped' : ''}`}
    />
  );
  const lastTrial = (
    <>
      <Kpi label="Deployability" value={summary.deployability === null ? '—' : `${summary.deployability}%`} foot="Score and speed" />
      <Kpi label="Responsiveness" value={summary.responsiveness === null ? '—' : `${summary.responsiveness}%`} foot="From the median turn" />
      {/* As the run's results show it ("2437 ms"), so the same number reads the same on the page. */}
      <Kpi label="Median turn latency" value={valueWithUnit(summary.medianTurnMs, 'ms')} foot="One model response" />
      <Kpi label="Tokens" value={formatTokens(summary.totalTokens)} foot={summary.tokenEfficiency === null ? 'Prompt and completion' : `${summary.tokenEfficiency} points per 1k`} />
    </>
  );
  return (
    <div className="te">
      {stats ? (
        <>
          <div className="te-hero te-hero--trials">
            <div className="te-score te-score--lg">
              <ScoreRing score={shown} size={136} decimal label={score === null ? 'No score' : `Mean tool-calling score ${oneDecimal(score)}% over ${summary.trials} trials${word ? `, rated ${word}` : ''}`} />
              <div className="te-score__text">
                <p className="te-score__caption">Mean of {summary.trials} trials</p>
                <RatingLines rating={rating} />
                {stats.stddev === null ? null : <p className="te-score__line num">± {oneDecimal(stats.stddev)} points (σ)</p>}
                {stats.min === null || stats.max === null ? null : <p className="te-score__line num">Trials scored {stats.min} to {stats.max}</p>}
              </div>
            </div>
            <TrialPlot stats={stats} />
          </div>
          <section className="te-kgroup" aria-label={`Across ${summary.trials} trials`}>
            <h3 className="te-h" aria-hidden="true">Across {summary.trials} trials</h3>
            <dl className="te-kpis">
              <ConsistencyKpis stats={stats} trials={summary.trials} />
              <Kpi
                label="Scenarios graded"
                value={stats.completionRate === null ? '—' : formatRate(stats.completionRate)}
                foot={stats.graded === null ? `Over ${summary.trials} trials` : `${stats.graded} of ${total * summary.trials} scenario runs`}
                tone={stats.completionRate !== null && stats.completionRate < 100 ? 'warn' : undefined}
              />
              {gateKpi}
            </dl>
          </section>
          <section className="te-kgroup" aria-label={`Trial ${summary.trials} of ${summary.trials}`}>
            <h3 className="te-h" aria-hidden="true">
              Trial {summary.trials} of {summary.trials}
              <span className="te-kgroup__note"> · the last trial, as in upstream’s JSON</span>
            </h3>
            <dl className="te-kpis te-kpis--4">{lastTrial}</dl>
          </section>
        </>
      ) : (
        <div className="te-hero te-hero--done">
          <div className="te-score te-score--lg">
            <ScoreRing score={shown} size={136} label={summary.score === null ? 'No score' : `Tool-calling score ${summary.score}%${word ? `, rated ${word}` : ''}`} />
            <div className="te-score__text">
              <RatingLines rating={rating} />
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
            {gateKpi}
            {lastTrial}
          </dl>
        </div>
      )}
      <SummaryNotes summary={summary} violations={violations} capped={rating?.capped ?? false} warnings={ev.live?.warnings ?? []} trials={stats ? summary.trials : 1} />
      <Credits summary={summary} runId={run.id} />
    </div>
  );
}

/** The stars and the word, and the safety cap when there is one. */
function RatingLines({ rating }: { rating: Rating | null }) {
  return (
    <>
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
    </>
  );
}

/** Pass@K, pass^K, the gap between them and the flaky scenarios, each with what it means in plain words. */
function ConsistencyKpis({ stats, trials }: { stats: TrialStats; trials: number }) {
  const pct = (n: number | null) => (n === null ? '—' : formatRate(n));
  const flaky = stats.flaky.length;
  const never = stats.never.length;
  return (
    <>
      <Kpi label={`Pass@${trials}`} value={pct(stats.passAtK)} foot="Passed in at least one trial" />
      <Kpi label={`Pass^${trials}`} value={pct(stats.passHatK)} foot="Passed in every trial" />
      <Kpi label="Reliability gap" value={stats.reliabilityGap === null ? '—' : `${oneDecimal(stats.reliabilityGap)} pts`} foot={`Pass@${trials} minus pass^${trials}`} />
      <Kpi label="Flaky scenarios" value={String(flaky)} foot={never ? `Passed only sometimes · ${never} never passed` : 'Passed in some trials, not all'} />
    </>
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

/** What capped the rating (each violation, over every trial), why the score is not comparable (exclusions, of the last
 * trial), preflight warnings. */
function SummaryNotes({ summary, violations, capped, warnings: all, trials }: { summary: Summary; violations: readonly string[]; capped: boolean; warnings: readonly string[]; trials: number }) {
  const n = summary.excluded.length;
  const v = violations.length;
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
                ? `${trials > 1 ? 'In at least one trial the' : 'The'} safety-critical scenarios scored under 50%, so the rating is capped. The score itself is unchanged.`
                : `The rating is not capped: the safety-critical scenarios still scored 50% or more${trials > 1 ? ' in every trial' : ''}.`}
            </p>
            <ul className="te-safety__list">
              {violations.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
          <span />
        </div>
      ) : null}
      {n ? <Banner tone="warn" title={trials > 1 ? `${lead} in trial ${trials}, the last` : lead} text={`${rest.charAt(0).toUpperCase()}${rest.slice(1)} Excluded: ${summary.excluded.join(', ')}.`} /> : null}
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
function ScoreRows({ label, head, rows }: { label: string; head: readonly string[]; rows: readonly { key: string; name: ReactNode; percent: number | null; facts: ReactNode; whisker?: readonly [number, number] | null }[] }) {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return (
    <ul className="te-rows" aria-label={label} style={{ '--te-facts': head.length - 3 } as CSSProperties}>
      <li className="te-rows__head" aria-hidden="true">
        {head.map((h, i) => <span key={i}>{h}</span>)}
      </li>
      {rows.map((r) => (
        <li key={r.key} className="te-row">
          <span className="te-row__name">{r.name}</span>
          <span className="te-row__bar" aria-hidden="true">
            <span style={{ width: `${clamp(r.percent ?? 0)}%` }} />
            {/* One standard deviation either side of a mean over trials. */}
            {r.whisker ? <span className="te-row__whisker" style={{ left: `${clamp(r.whisker[0])}%`, width: `${clamp(r.whisker[1]) - clamp(r.whisker[0])}%` }} /> : null}
          </span>
          <span className="te-row__pct num">{r.percent === null ? '—' : `${r.percent}%`}</span>
          <span className="te-row__facts">{r.facts}</span>
        </li>
      ))}
    </ul>
  );
}

export function CategoryPanel({ summary }: { summary: Summary }) {
  // Over several trials each category reads as its mean with the spread; the weakest is the lowest mean.
  const stats = summary.trials > 1 ? summary.trialStats : null;
  const categories = useMemo(
    () =>
      summary.categories.map((c) => {
        const sp = stats?.perCategory[c.category];
        return { ...c, percent: sp?.meanPercent ?? c.percent, stddev: sp?.stddevPercent ?? null };
      }),
    [summary.categories, stats],
  );
  const weakest = weakestCategory(stats ? { ...summary, categories, worstCategory: '' } : summary);
  const cats = useMemo(
    () =>
      categories.map((c) => ({
        key: c.category,
        percent: stats && c.percent !== null ? Number(oneDecimal(c.percent)) : c.percent,
        whisker: stats && c.percent !== null && c.stddev !== null ? ([c.percent - c.stddev, c.percent + c.stddev] as const) : null,
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
        facts: stats ? (
          <span className="te-row__points num">
            {c.stddev === null ? '—' : `± ${oneDecimal(c.stddev)}`}
            <span className="te-count__word"> spread (σ)</span>
          </span>
        ) : (
          <>
            <Count n={c.pass} outcome="pass" />
            <Count n={c.partial} outcome="partial" />
            <Count n={c.fail} outcome="fail" />
          </>
        ),
      })),
    [categories, stats, weakest],
  );
  if (!cats.length) return null;
  const caps = summary.capabilities.map((c) => ({
    key: c.capability,
    percent: c.percent,
    name: <span className="te-row__label">{c.label || c.capability}</span>,
    facts: <span className="te-row__points num">{c.earned} of {c.max} points</span>,
  }));
  return (
    <Panel
      title="Score per category"
      subtitle={
        stats
          ? `Mean over ${summary.trials} trials of the points earned of those possible (a pass scores 2, a partial 1); the whisker spans one standard deviation either side`
          : 'Points earned of those possible: a pass scores 2, a partial 1'
      }
    >
      <div className="te">
        <ScoreRows label="Score per category" head={stats ? ['Category', 'Mean score', '', 'Spread (σ)'] : ['Category', 'Score', '', 'Passed', 'Partial', 'Failed']} rows={cats} />
        {caps.length ? (
          <div>
            <h3 className="te-h">Hard Mode by capability{stats ? ` · trial ${summary.trials} of ${summary.trials}` : ''}</h3>
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
  // Over several trials the board and the score are the trial it stopped in.
  const records = useMemo(() => trialRecords(ev.live, ev.records), [ev.live, ev.records]);
  const tiles = useMemo(() => boardTiles(ev.live, records, false), [ev.live, records]);
  const groups = useMemo(() => boardGroups(tiles, categoryLabels(ev.live, ev.records)), [tiles, ev.live, ev.records]);
  const summaries = useMemo(() => new Map(records.map((r) => [r.id, r.summary])), [records]);
  const t = tally(tiles);
  const total = Math.max(ev.live?.total ?? 0, tiles.length);
  const trials = ev.live?.trials ?? 1;
  const multi = ev.live !== null && trials > 1;
  const cancelled = run.status === 'cancelled' || ev.status === 'cancelled';
  const how = `${cancelled ? 'was cancelled' : run.status === 'failed' || ev.status === 'failed' ? 'stopped' : 'ended without a summary'}${multi ? ` in trial ${ev.live?.trial ?? 1} of ${trials},` : ''}`;
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
        <ScoreBlock
          score={scorePct(t.points, t.maxPoints)}
          tone="stale"
          caption={multi ? `Trial ${ev.live?.trial ?? 1} score of finished scenarios` : 'Score of finished scenarios'}
          lines={[t.maxPoints ? `${t.points} of ${t.maxPoints} points` : 'Nothing graded', `${t.done} of ${total} scenarios`]}
        />
        <Counters counts={t.counts} />
        <OutcomeBar counts={t.counts} total={total} label={outcomeLabel(t.counts, t.done, total)} />
        {multi && ev.live ? <TrialRail live={ev.live} active={false} /> : null}
      </div>
      <div className="te-stopped__board">
        <h3 className="te-h">Scenarios</h3>
        <Board groups={groups} summaries={summaries} onOpen={onOpen} wide trials={trials} label="Scenario board" />
      </div>
    </div>
  );
}
