// The trials of a run that repeats the suite (tool-eval-bench's --trials): while it runs, or once it stopped, a rail of
// every trial on a shared 0-100 scale with the finished ones' scores and their mean; after it, every trial's score as
// a dot plot with the mean, the 95% confidence interval and the range. Runs of a single trial show neither.
import type { CSSProperties } from 'react';
import { oneDecimal, plotDomain, spread, type Live, type TrialStats } from './model';

type Slot = 'done' | 'running' | 'stopped' | 'next';

export function TrialRail({ live, active }: { live: Live; active: boolean }) {
  const byTrial = new Map(live.trialScores.map((t) => [t.trial, t.score]));
  const scores = live.trialScores.flatMap((t) => (t.score === null ? [] : [t.score]));
  const { mean, stddev } = spread(scores);
  const slots = Array.from({ length: live.trials }, (_, i) => {
    const n = i + 1;
    const slot: Slot = byTrial.has(n) || n < live.trial ? 'done' : n === live.trial ? (active ? 'running' : 'stopped') : 'next';
    return { n, slot, score: byTrial.get(n) ?? null };
  });
  const later = slots.filter((s) => s.slot === 'next').length;
  const label = [
    `Score per trial on a 0 to 100 scale: ${slots.filter((s) => s.slot === 'done').map((s) => `trial ${s.n} ${s.score === null ? 'no score' : `${s.score}%`}`).join(', ') || 'none finished yet'}`,
    `trial ${live.trial} ${active ? 'running' : 'stopped'}`,
    later ? `${later} still to run` : '',
    mean === null ? '' : `mean ${oneDecimal(mean)}`,
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <section className="te-trials" aria-label="Trials">
      <div className="te-trials__head">
        <p className="te-trials__title">
          Trial <span className="num">{live.trial}</span> of <span className="num">{live.trials}</span>
          {active ? null : <span className="te-trials__state"> · stopped</span>}
        </p>
        {mean === null ? (
          <p className="te-trials__sub">Each trial’s score and the mean appear here as the trials finish.</p>
        ) : (
          <p className="te-trials__sub">
            {active ? 'Mean so far' : 'Mean'} <strong className="num">{oneDecimal(mean)}</strong>
            {stddev === null ? null : <span className="num"> ± {oneDecimal(stddev)}</span>}
            {' · '}
            {scores.length} of {live.trials} finished
          </p>
        )}
      </div>
      <div className="te-trials__plot" role="img" aria-label={label} style={{ '--te-trials': live.trials } as CSSProperties}>
        {slots.map((s) => (
          <span key={`v${s.n}`} className={`te-trials__value num is-${s.slot}`} style={{ gridColumn: s.n }} aria-hidden="true">
            {s.slot === 'running' ? 'now' : s.score === null ? '—' : s.score}
          </span>
        ))}
        {slots.map((s) => (
          <span key={`t${s.n}`} className={`te-trials__track is-${s.slot}`} style={{ gridColumn: s.n }} aria-hidden="true">
            {s.score === null ? null : <span style={{ height: `${Math.min(100, Math.max(0, s.score))}%` }} />}
          </span>
        ))}
        {mean === null ? null : (
          <span className="te-trials__overlay" aria-hidden="true">
            <span className="te-trials__mean" style={{ bottom: `${mean}%` }} />
          </span>
        )}
        {slots.map((s) => (
          <span key={`l${s.n}`} className={`te-trials__label is-${s.slot}`} style={{ gridColumn: s.n }} aria-hidden="true">
            T{s.n}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Every trial's score as a dot (equal scores stack), over the 95% confidence interval of the mean, the range and the
 * mean itself; the axis spans the scores, not 0-100, so a spread of a few points stays visible. */
export function TrialPlot({ stats }: { stats: TrialStats }) {
  const scores = stats.scores;
  const mean = stats.mean ?? spread(scores).mean;
  const min = stats.min ?? (scores.length ? Math.min(...scores) : null);
  const max = stats.max ?? (scores.length ? Math.max(...scores) : null);
  const { lo, hi, ticks } = plotDomain([...scores, ...(stats.ci95 ?? []), ...(mean === null ? [] : [mean])]);
  const at = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
  const span = (a: number, b: number): CSSProperties => ({ left: `${at(a)}%`, width: `${at(b) - at(a)}%` });
  const stacked = new Map<number, number>();
  const dots = scores.map((score, i) => {
    const level = stacked.get(score) ?? 0;
    stacked.set(score, level + 1);
    return { trial: i + 1, score, level };
  });
  const levels = Math.max(1, ...stacked.values());
  const ci = stats.ci95;
  const range = min !== null && max !== null ? `${min}–${max}` : '—';
  const label = [
    `Score of each of the ${scores.length} trials, on a ${lo} to ${hi} scale: ${scores.join(', ')}`,
    mean === null ? '' : `mean ${oneDecimal(mean)}`,
    ci ? `95% confidence interval ${oneDecimal(ci[0])} to ${oneDecimal(ci[1])}` : '',
    min !== null && max !== null ? `range ${min} to ${max}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <figure className="te-tplot">
      <figcaption className="te-h">Score per trial</figcaption>
      <div className="te-tplot__chart" role="img" aria-label={label}>
        <div className="te-tplot__plot" style={{ '--te-levels': levels } as CSSProperties}>
          {ticks.map((t) => <span key={t} className="te-tplot__grid" style={{ left: `${at(t)}%` }} />)}
          {ci ? <span className="te-tplot__ci" style={span(ci[0], ci[1])} /> : null}
          {min !== null && max !== null ? <span className="te-tplot__range" style={span(min, max)} /> : null}
          {mean === null ? null : <span className="te-tplot__mean" style={{ left: `${at(mean)}%` }} />}
          {dots.map((d) => (
            <span key={d.trial} className="te-tplot__dot" title={`Trial ${d.trial}: ${d.score}%`} style={{ left: `${at(d.score)}%`, '--te-level': d.level } as CSSProperties} />
          ))}
        </div>
        <div className="te-tplot__axis" aria-hidden="true">
          {ticks.map((t) => <span key={t} style={{ left: `${at(t)}%` }}>{t}</span>)}
        </div>
      </div>
      {/* The legend, with each mark's value. */}
      <dl className="te-tstats">
        <div>
          <dt><span className="te-tstats__key is-dot" aria-hidden="true" />Trials</dt>
          <dd className="num">{scores.length}</dd>
        </div>
        <div>
          <dt><span className="te-tstats__key is-mean" aria-hidden="true" />Mean</dt>
          <dd className="num">{mean === null ? '—' : oneDecimal(mean)}</dd>
        </div>
        <div>
          <dt><span className="te-tstats__key is-ci" aria-hidden="true" />95% CI</dt>
          <dd className="num">{ci ? `${oneDecimal(ci[0])}–${oneDecimal(ci[1])}` : '—'}</dd>
        </div>
        <div>
          <dt><span className="te-tstats__key is-range" aria-hidden="true" />Range</dt>
          <dd className="num">{range}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd className="num">{stats.median === null ? '—' : Number.isInteger(stats.median) ? stats.median : oneDecimal(stats.median)}</dd>
        </div>
      </dl>
    </figure>
  );
}
