// Small presentational pieces of the tool-calling evaluation: status glyphs and verdict pills, difficulty dots, the
// category tag, the outcome bar with its counters (which double as the board's legend) and the score ring.
import { Circle, CircleCheck, CircleSlash, CircleX, Contrast, LoaderCircle, type LucideIcon } from 'lucide-react';
import { AnimatedNumber } from '../../../design/components/AnimatedNumber';
import { RingGauge } from '../../../design/components/RingGauge';
import '../../../design/components/StatusPill.css'; // verdict pills share the status pill's look
import { difficultyText, OUTCOMES, STATUS_LOOK, type Outcome, type TileStatus } from './model';
import './tooleval.css';

/** Circle-family glyphs, so a tile, a counter and a pill read as one set (status never by colour alone). */
export const STATUS_ICON: Record<TileStatus, LucideIcon> = {
  pass: CircleCheck,
  partial: Contrast,
  fail: CircleX,
  excluded: CircleSlash,
  pending: Circle,
  running: LoaderCircle,
};

export function StatusGlyph({ status }: { status: TileStatus }) {
  const Icon = STATUS_ICON[status];
  return <Icon aria-hidden="true" strokeWidth={2.25} className={`te-glyph${status === 'running' ? ' te-glyph--spin' : ''}`} />;
}

/** "Passed" / "Partial" / "Failed" / "Excluded" as icon + word in the verdict's tone. */
export function VerdictPill({ outcome, size = 'sm' }: { outcome: Outcome; size?: 'sm' | 'md' }) {
  const look = STATUS_LOOK[outcome];
  return (
    <span className={`status status--pill status--${size} tone-${look.tone ?? 'stale'}`}>
      <StatusGlyph status={outcome} />
      <span className="status__label">{look.label}</span>
    </span>
  );
}

/** Five dots, the first `value` filled; the accessible name says it in words. */
export function DifficultyDots({ value }: { value: number | null }) {
  if (value === null) return <span className="t-tertiary">—</span>;
  return (
    <span className="te-dots" role="img" aria-label={difficultyText(value)}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= value ? 'is-on' : undefined} />)}
    </span>
  );
}

/** Category letter as a neutral tag (categories are not statuses). */
export function CategoryTag({ cat }: { cat: string }) {
  return <span className="te-cattag" aria-hidden="true">{cat || '?'}</span>;
}

/** Finished scenarios as one bar split by verdict, on a track for the ones still to run. */
export function OutcomeBar({ counts, total, label }: { counts: Record<Outcome, number>; total: number; label: string }) {
  const done = OUTCOMES.reduce((a, o) => a + counts[o], 0);
  const rest = Math.max(0, total - done);
  return (
    <div className="te-obar" role="img" aria-label={label}>
      {OUTCOMES.map((o) => (counts[o] > 0 ? <span key={o} className={`te-obar__seg tone-${STATUS_LOOK[o].tone ?? 'stale'}`} style={{ flexGrow: counts[o] }} /> : null))}
      {rest > 0 || done === 0 ? <span className="te-obar__rest" style={{ flexGrow: Math.max(rest, 1) }} /> : null}
    </div>
  );
}

/** Passed / partial / failed / excluded counts: icon + number + word in each verdict's tone. */
export function Counters({ counts }: { counts: Record<Outcome, number> }) {
  return (
    <dl className="te-counters">
      {OUTCOMES.map((o) => (
        <div key={o} className={`te-counter tone-${STATUS_LOOK[o].tone ?? 'stale'}${counts[o] ? '' : ' is-zero'}`}>
          <dt>
            <StatusGlyph status={o} />
            {STATUS_LOOK[o].label}
          </dt>
          <dd className="num">{counts[o]}</dd>
        </div>
      ))}
    </dl>
  );
}

const pctText = (n: number) => String(Math.round(n));

/** The score as a ring with the number inside; null shows an empty track and a dash. */
export function ScoreRing({ score, label, size, tone = 'accent' }: { score: number | null; label: string; size: number; tone?: 'accent' | 'stale' }) {
  return (
    <RingGauge value={score === null ? null : score / 100} label={label} size={size} stroke={Math.round(size / 11)} tone={tone}>
      <span className={`te-ring${size >= 128 ? ' te-ring--lg' : ''}`}>
        <AnimatedNumber value={score} format={pctText} className="te-ring__num" />
        {score !== null ? <span className="te-ring__unit">%</span> : null}
      </span>
    </RingGauge>
  );
}
