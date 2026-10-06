// Small presentational pieces shared by the benchmark screens.
import {
  ArrowDownRight,
  ArrowUpRight,
  Cable,
  Cpu,
  Equal,
  Flame,
  HardDrive,
  Info,
  MemoryStick,
  MessageSquareText,
  Microchip,
  Thermometer,
  TrendingDown,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { InlineCode } from '../../design/components/InlineCode';
import { StatusPill } from '../../design/components/StatusPill';
import { Tooltip } from '../../design/components/Tooltip';
import type { BenchImpact, NodeStatus, Problem, RunStatus } from '../../lib/types';
import { IMPACT_LABEL, STATUS_LOOK, type Category, type DeltaLook } from './model';

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  compute: Microchip,
  memory: MemoryStick,
  cpu: Cpu,
  interconnect: Cable,
  storage: HardDrive,
  inference: MessageSquareText,
  soak: Flame,
};

export function RunStatusPill({ status, size = 'md', variant = 'pill' }: { status: RunStatus; size?: 'sm' | 'md'; variant?: 'pill' | 'inline' }) {
  const look = STATUS_LOOK[status];
  return <StatusPill status={look.status} label={look.label} size={size} variant={variant} />;
}

/** Thermal / power level and disruption, as icon + words (never colour alone). */
export function ImpactChips({ impact, compact }: { impact: BenchImpact; compact?: boolean }) {
  const chip = (Icon: LucideIcon, label: string, level: BenchImpact['thermal']) => (
    <li className={`bench-chip bench-chip--${level}`}>
      <Icon aria-hidden="true" />
      <span>
        {label} <span className="bench-chip__level">{IMPACT_LABEL[level].toLowerCase()}</span>
      </span>
    </li>
  );
  return (
    <ul className={`bench-chips${compact ? ' bench-chips--compact' : ''}`} aria-label="Expected impact">
      {chip(Thermometer, 'Thermal', impact.thermal)}
      {chip(Zap, 'Power', impact.power)}
      {impact.disruptive ? (
        <li className="bench-chip bench-chip--disruptive tone-warn">
          <TriangleAlert aria-hidden="true" />
          <span>Disrupts running workloads</span>
        </li>
      ) : null}
    </ul>
  );
}

/** Problem text for a tooltip: message, cause, fix. */
export function ProblemTip({ problem }: { problem: Problem }) {
  return (
    <span className="bench-tip">
      <strong>{problem.message}</strong>
      {problem.cause ? <span><InlineCode text={problem.cause} /></span> : null}
      {problem.fix ? <span><span className="bench-tip__k">Fix: </span><InlineCode text={problem.fix} /></span> : null}
    </span>
  );
}

const DOWN_LABEL: Partial<Record<NodeStatus, string>> = { stale: 'Not reporting', offline: 'Offline', error: 'Unreachable' };

/**
 * One node's availability for a bench. A node that is not reporting says so on every card (whatever the catalog
 * last said); otherwise "Ready", or "Unavailable" with the problem and its fix in a tooltip.
 */
export function Availability({ node, problem, nodeStatus }: { node: string; problem: Problem | null | undefined; nodeStatus?: NodeStatus }) {
  const down = nodeStatus ? DOWN_LABEL[nodeStatus] : undefined;
  if (!problem && !down) {
    return (
      <li className="bench-avail">
        <span className="bench-avail__node">{node}</span>
        <StatusPill status="healthy" label="Ready" variant="inline" size="sm" />
      </li>
    );
  }
  return (
    <li className="bench-avail">
      <span className="bench-avail__node">{node}</span>
      <StatusPill status={down ? (nodeStatus === 'stale' ? 'stale' : 'offline') : 'warning'} label={down ?? 'Unavailable'} variant="inline" size="sm" />
      {problem ? (
      <Tooltip content={<ProblemTip problem={problem} />}>
        <button type="button" className="bench-avail__info" aria-label={`Why ${node} can’t run this: ${problem.message}`}>
          <Info aria-hidden="true" />
        </button>
      </Tooltip>
      ) : null}
    </li>
  );
}

/** Delta vs a reference: arrow + signed % + (when worse beyond the threshold) the word "Regression". */
export function DeltaBadge({ delta, better, showHint }: { delta: DeltaLook | null; better?: 'higher' | 'lower'; showHint?: boolean }) {
  if (!delta) return <span className="t-tertiary">—</span>;
  const Icon = delta.tone === 'same' ? Equal : delta.pct > 0 ? ArrowUpRight : ArrowDownRight;
  const tone = delta.regression ? 'tone-crit' : delta.tone === 'better' ? 'tone-ok' : delta.tone === 'worse' ? 'tone-warn' : '';
  const word = delta.tone === 'same' ? 'about the same' : delta.tone;
  return (
    <span className={`bench-delta ${tone}`}>
      {delta.regression ? (
        <span className="bench-delta__flag">
          <TrendingDown aria-hidden="true" />
          Regression
        </span>
      ) : null}
      <span className="bench-delta__value num">
        <Icon aria-hidden="true" />
        {delta.text}
      </span>
      <span className="visually-hidden">, {word}</span>
      {showHint && better ? <span className="bench-delta__hint">{better === 'higher' ? 'higher is better' : 'lower is better'}</span> : null}
    </span>
  );
}

/** "Higher is better" with a small arrow, for result rows. */
export function BetterHint({ better }: { better: 'higher' | 'lower' }) {
  const Icon = better === 'higher' ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="bench-better">
      <Icon aria-hidden="true" />
      {better === 'higher' ? 'Higher is better' : 'Lower is better'}
    </span>
  );
}
