import { ChevronRight, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { paths, type NodeTab } from '../../../app/routes';
import { lostGpu, notReported } from '../../../lib/capabilities';
import { decodeThrottle, worstSeverity, type ThrottleReason } from '../../../lib/throttle';
import type { NodeInfo, Sample, Severity } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { andList, gpuAt, reportingGpus, silentBackends, type SilentBackend } from '../../../lib/gpu';

// ------------------------------------------------------------------ collector errors

const COLLECTORS: Record<string, { label: string; tab?: NodeTab; metric: string }> = {
  gpu: { label: 'GPU metrics', tab: 'gpu', metric: 'gpu0' },
  memory: { label: 'Memory metrics', tab: 'memory', metric: 'mem' },
  cpu: { label: 'CPU metrics', tab: 'cpu', metric: 'cpu' },
  net: { label: 'Network metrics', tab: 'network', metric: 'net' },
  storage: { label: 'Storage metrics', tab: 'storage', metric: 'disk' },
  thermal: { label: 'Temperature sensors', tab: 'thermals', metric: 'temp' },
  procs: { label: 'Process list', tab: 'processes', metric: 'procs' },
};

export const collectorLabel = (name: string) => COLLECTORS[name]?.label ?? `${name.charAt(0).toUpperCase()}${name.slice(1)} metrics`;

const NO_ERRORS: Record<string, string> = {};
const selectErrors = (s: Sample | null) => s?.errors ?? NO_ERRORS;
const sameErrors = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

const selectReporting = (s: Sample | null) => s?.gpu.map((g) => g.index).join(',') ?? '';

/** A lost GPU 0 declares `gpu0` too, but the GPU collector still runs and reads the other GPUs. */
const collectorDown = (info: NodeInfo | null | undefined, name: string) =>
  notReported(info, COLLECTORS[name]?.metric ?? name) !== null && !(name === 'gpu' && lostGpu(info, 0));

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Collector failures from the latest sample, as calm inline notes. `only` limits them to some collectors. A collector
 *  whose metrics the node declares not reported (it could not start) is left out: its panels already say why. While
 *  some GPUs still report, a GPU failure is one note per backend that went silent, naming its GPUs. */
export function CollectorErrors({ nodeId, only, link }: { nodeId: string; only?: readonly string[]; link?: boolean }) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const errors = useLatest(nodeId, selectErrors, sameErrors);
  const reportingKey = useLatest(nodeId, selectReporting);
  const entries = Object.entries(errors).filter(([k]) => (!only || only.includes(k)) && !collectorDown(info, k));
  if (!entries.length) return null;
  const reporting = reportingKey ? reportingGpus(info, reportingKey.split(',').map(Number)) : [];
  const silent = reporting.length ? silentBackends(info, errors.gpu, reporting) : [];
  return (
    <ul className="nnotes" aria-label="Metrics unavailable">
      {entries.flatMap(([name, msg]) => {
        const tab = COLLECTORS[name]?.tab;
        const details = link && tab ? (
          <Link href={paths.node(nodeId, tab)} className="nnote__link">
            Details<ChevronRight aria-hidden="true" />
          </Link>
        ) : null;
        if (name === 'gpu' && silent.length) {
          return silent.map((b) => <SilentNote key={`gpu/${b.backend}`} item={b} reporting={reporting} details={details} />);
        }
        return [
          <li key={name} className="nnote tone-warn">
            <TriangleAlert className="nnote__icon" aria-hidden="true" />
            <p className="nnote__text">
              <strong>{collectorLabel(name)} unavailable:</strong> <span className="nnote__msg">{sentence(msg)}</span>
              <span className="nnote__aside"> Other panels are unaffected.</span>
            </p>
            {details}
          </li>,
        ];
      })}
    </ul>
  );
}

function SilentNote({ item, reporting, details }: { item: SilentBackend; reporting: readonly number[]; details: ReactNode }) {
  const indexes = item.gpus.map((g) => g.index);
  const names = [...new Set(item.gpus.map((g) => g.name))].join(', ');
  const others = reporting.filter((i) => !indexes.includes(i));
  return (
    <li className="nnote tone-warn">
      <TriangleAlert className="nnote__icon" aria-hidden="true" />
      <p className="nnote__text">
        <strong>{indexes.length === 1 ? 'GPU' : 'GPUs'} {andList(indexes)} ({names}) not responding:</strong>{' '}
        <span className="nnote__msg">{sentence(item.message ?? 'no reading this tick')}</span>
        <span className="nnote__aside">
          {' '}The <code>{item.backend}</code> backend sent no reading this tick. {others.length === 1 ? 'GPU' : 'GPUs'} {andList(others)} still{' '}
          {others.length === 1 ? 'reports' : 'report'}.
        </span>
      </p>
      {details}
    </li>
  );
}

// ------------------------------------------------------------------ throttle reasons

export const SEVERITY_META: Record<Severity, { label: string; icon: LucideIcon; tone: string }> = {
  info: { label: 'Info', icon: Info, tone: 'tone-info' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'tone-warn' },
  critical: { label: 'Critical', icon: OctagonAlert, tone: 'tone-crit' },
};

export const selectThrottleMask = (s: Sample | null) => gpuAt(s?.gpu, 0)?.throttle_mask ?? null;

/** Reasons that actually limit clocks ("Idle" only means there is no work). */
export const limiting = (reasons: readonly ThrottleReason[]) => reasons.filter((r) => r.code !== 'gpu_idle');

/** Where the SM clock sits against its maximum: near it ('full'), well below it with no work ('idle') or with work
 *  ('low'), or unknown (null). An idle GB10 reports mask 0x0 at about 7% of its maximum clock. */
export type ClockLevel = 'full' | 'idle' | 'low' | null;
export function clockLevel(s: Sample | null, maxMhz: number | null): ClockLevel {
  const g = gpuAt(s?.gpu, 0);
  if (g?.sm_mhz == null || !maxMhz) return null;
  if (g.sm_mhz >= 0.8 * maxMhz) return 'full';
  return g.util == null || g.util < 10 ? 'idle' : 'low';
}

const NO_LIMIT_TEXT: Record<Exclude<ClockLevel, null> | 'unknown', string> = {
  full: 'Running at full speed — no clock limits active',
  idle: 'No clock limits active — clocks are low because the GPU is idle',
  low: 'No clock limits active — the driver is running the clocks below maximum',
  unknown: 'No clock limits active',
};

export function throttleHeadline(reasons: readonly ThrottleReason[], clocks: ClockLevel = null): { text: string; severity: Severity | 'ok' } {
  const active = limiting(reasons);
  if (!active.length) {
    return reasons.length
      ? { text: 'Idle — clocks are lowered because there is no work', severity: 'ok' }
      : { text: NO_LIMIT_TEXT[clocks ?? 'unknown'], severity: 'ok' };
  }
  const sev = worstSeverity(active) ?? 'info';
  const names = active.map((r) => r.title.toLowerCase()).join(', ');
  return { text: `Clocks limited by ${names}`, severity: sev };
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const worstFirst = (reasons: readonly ThrottleReason[]) => [...reasons].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.bit - b.bit);

/** Active reasons, most severe first. */
export function ThrottleRows({ reasons }: { reasons: readonly ThrottleReason[] }) {
  const sorted = worstFirst(reasons);
  return (
    <ul className="throttle">
      {sorted.map((r) => {
        const m = SEVERITY_META[r.severity];
        const Icon = m.icon;
        return (
          <li key={r.bit} className={`throttle__row ${m.tone}`}>
            <span className="throttle__sev">
              <Icon aria-hidden="true" />
              <span>{m.label}</span>
            </span>
            <span className="throttle__body">
              <span className="throttle__title">{r.title}</span>
              <span className="throttle__why">{r.explanation}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Summary-tab note: shown only while something limits the clocks. */
export function ThrottleNotice({ nodeId }: { nodeId: string }) {
  const mask = useLatest(nodeId, selectThrottleMask);
  const reasons = decodeThrottle(mask);
  const active = limiting(reasons);
  if (!active.length) return null;
  const head = throttleHeadline(reasons);
  const m = SEVERITY_META[head.severity === 'ok' ? 'info' : head.severity];
  const Icon = m.icon;
  return (
    <div className={`nnote ${m.tone}`}>
      <Icon className="nnote__icon" aria-hidden="true" />
      <p className="nnote__text">
        {/* Only the worst reason's explanation: three explanations under one heading read as a wall of text,
            and the GPU tab lists every reason with its own. */}
        <strong>{m.label}: {head.text}.</strong> <span className="nnote__msg">{worstFirst(active)[0]?.explanation}{active.length > 1 ? ' The GPU tab explains the others.' : ''}</span>
      </p>
      <Link href={paths.node(nodeId, 'gpu')} className="nnote__link">
        GPU<ChevronRight aria-hidden="true" />
      </Link>
    </div>
  );
}
