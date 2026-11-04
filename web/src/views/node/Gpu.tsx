import { CircleCheck, Clock, Unplug } from 'lucide-react';
import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { TimeSeriesChart, type SeriesSpec, type Threshold } from '../../charts/TimeSeriesChart';
import { gpuColor } from '../../charts/theme';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { Stat } from '../../design/components/Stat';
import { Skeleton } from '../../design/components/Skeleton';
import '../../design/components/StatusPill.css';
import { useNow } from '../../design/useNow';
import { notReported, type NotReported } from '../../lib/capabilities';
import { NoData, Unsupported } from '../../design/components/Unsupported';
import { energyParts, formatAgo, formatFreq, formatPercent, formatTemp, formatWatts, percentParts, tempParts, wattsParts, type Formatter } from '../../lib/format';
import { gpuKey, type GpuField, type GpuReading } from '../../lib/metrics';
import { decodeThrottle } from '../../lib/throttle';
import type { GpuInfo, NodeInfo, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { liveStore, useLatest } from '../../store/live';
import { formatEnergyAuto, formatEnergyCost, historyEnergy } from '../shared/energy';
import { mean, peak } from './parts/gpu';
import { TempFooter } from './parts/TempFooter';
import { RANGE_PHRASE, spanPhrase } from '../shared/live';
import { serverNow } from '../../store/cluster';
import type { TimeRange } from '../../lib/prefs';
import { useFreshness, useRangeData, type RangeData } from './parts/hooks';
import { LiveStat } from './parts/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { clockLevel, CollectorErrors, SEVERITY_META, throttleBadge, throttleHeadline, ThrottleRows } from './parts/Notices';
import { ProcTable } from './parts/ProcTable';
import { gpuPresent, gpuSelector } from './parts/selectors';
import type { NodeTabProps } from './tabs';
import { gpuAt, notResponding } from '../../lib/gpu';

const pct = (n: number) => formatPercent(n);
const pct1 = (n: number) => formatPercent(n, n > 0 && n < 10 ? 1 : 0);
const pstateParts: Formatter = (n) => ({ value: `P${Math.round(n)}`, unit: '' });

/** One unit on the clock axis: "0.00 GHz" at the bottom rather than "0 MHz" under "1.00 GHz". */
const formatGhz = (mhz: number) => `${(mhz / 1000).toFixed(2)}\u00a0GHz`;

const series = (index: number, field: GpuReading, label: string): SeriesSpec => ({ key: gpuKey(index, field), label });
const rangeKeys = (index: number) => (['power_w', 'energy_j', 'power_capped_pct', 'thermal_capped_pct'] as const).map((f) => gpuKey(index, f));

const sameGap = (a: NotReported | null, b: NotReported | null) => a?.label === b?.label && a?.detail === b?.detail;

/** Why a key of GPU `index` has no value: the node declares it not reported, or the GPU sent nothing this tick. */
function useGpuGap(nodeId: string, info: NodeInfo | null | undefined, index: number) {
  const silent = useLatest(nodeId, useCallback((s: Sample | null) => notResponding(info, s, index), [info, index]), sameGap);
  return (key: string) => notReported(info, key) ?? silent;
}

/** "2.17 / 3.00 GHz": the current SM clock over the GPU's maximum. */
function smOverMax(maxMhz: number | null | undefined): Formatter {
  if (!maxMhz) return (n) => ({ value: (n / 1000).toFixed(2), unit: 'GHz' });
  const max = (maxMhz / 1000).toFixed(2);
  return (n) => ({ value: (n / 1000).toFixed(2), unit: `/ ${max} GHz` });
}

function tempThresholds(slowdown: number | null, shutdown: number | null): Threshold[] {
  const t: Threshold[] = [];
  // Only 4 °C apart: the chart draws the lines and keys their labels in its legend row, so they never collide.
  if (slowdown != null) t.push({ value: slowdown, label: `Slowdown ${formatTemp(slowdown)}`, tone: 'warn' });
  if (shutdown != null) t.push({ value: shutdown, label: `Shutdown ${formatTemp(shutdown)}`, tone: 'crit' });
  return t;
}

/** The GPU a view is about, and what its stats need from the node. */
interface GpuCtx {
  nodeId: string;
  index: number;
  gpu: GpuInfo | undefined;
  info: NodeInfo | null | undefined;
  /** One section among several: the name is the section's subtitle, and power reads against this GPU's limit. */
  multi: boolean;
  currency: string;
  rate: number | null;
}

/**
 * One stat of a GPU: a live reading of its sample, or a figure NodeInfo fixes. Each derives "not reported" from its
 * own key (gpu{index}.{field}), so an unsupported entry lands on the right GPU only. Later fields (VRAM, fan, memory
 * clock, PCIe) are further entries.
 */
type GpuStatSpec =
  | { label: string; reading: GpuReading; format: Formatter; footer?: (value: number | null) => ReactNode }
  | { label: string; field: GpuField; value: number | null; format: Formatter; missingFooter?: ReactNode };

function gpuStats(c: GpuCtx, smFormat: Formatter): GpuStatSpec[] {
  const { nodeId, index, gpu } = c;
  const smMax = gpu?.sm_mhz_max ?? null;
  const slowdown = gpu?.temp_slowdown_c ?? null;
  const shutdown = gpu?.temp_shutdown_c ?? null;
  const limit = gpu?.power_limit_w ?? null;
  return [
    { label: 'Utilisation', reading: 'util', format: percentParts, footer: () => (c.multi ? 'Time the GPU was busy' : (gpu?.name ?? null)) },
    { label: 'SM clock', reading: 'sm_mhz', format: smFormat, footer: (v) => (v != null && smMax ? `${Math.round((100 * v) / smMax)}% of maximum` : null) },
    { label: 'Temperature', reading: 'temp_c', format: tempParts, footer: (v) => <TempFooter temp={v} slowdown={slowdown} shutdown={shutdown} /> },
    {
      label: 'GPU power',
      reading: 'power_w',
      format: wattsParts,
      footer:
        c.multi && limit
          ? (v) => (v != null ? `${Math.round((100 * v) / limit)}% of the ${formatWatts(limit)} limit` : null)
          : () => <PowerPeak nodeId={nodeId} index={index} idle={c.multi ? null : 'GPU rail only'} />,
    },
    {
      label: 'Power limit',
      field: 'power_limit_w',
      value: limit,
      format: wattsParts,
      missingFooter: <PowerTypical nodeId={nodeId} index={index} />,
    },
    { label: 'Performance state', reading: 'pstate', format: pstateParts, footer: (v) => (v === 0 ? 'Maximum performance' : v != null ? 'Reduced performance state' : null) },
    { label: 'Energy since driver load', reading: 'energy_j', format: energyParts, footer: () => <RangeEnergy nodeId={nodeId} index={index} currency={c.currency} rate={c.rate} /> },
  ];
}

function GpuStats({ c }: { c: GpuCtx }) {
  const smMax = c.gpu?.sm_mhz_max ?? null;
  const smFormat = useMemo(() => smOverMax(smMax), [smMax]);
  const gap = useGpuGap(c.nodeId, c.info, c.index);
  return (
    <>
      {gpuStats(c, smFormat).map((spec) => {
        if ('reading' in spec) {
          const key = gpuKey(c.index, spec.reading);
          return (
            <LiveStat
              key={spec.label}
              nodeId={c.nodeId}
              label={spec.label}
              select={gpuSelector(c.index, spec.reading)}
              metric={key}
              format={spec.format}
              unsupported={gap(key)}
              footer={spec.footer}
            />
          );
        }
        if (spec.value != null) return <Stat key={spec.label} label={spec.label} value={spec.value} format={spec.format} />;
        return (
          <Stat
            key={spec.label}
            label={spec.label}
            value={null}
            format={spec.format}
            unsupported={notReported(c.info, gpuKey(c.index, spec.field))}
            reporting
            gapFooter={spec.missingFooter}
          />
        );
      })}
    </>
  );
}

export default function Gpu({ nodeId }: NodeTabProps) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const currency = useCluster((s) => s.cluster?.settings.currency ?? '£');
  const rate = useCluster((s) => s.cluster?.settings.energy_rate_per_kwh ?? null);
  const gpus = info?.gpus ?? [];
  if (gpus.length > 1) return <MultiGpu nodeId={nodeId} info={info} gpus={gpus} currency={currency} rate={rate} />;
  return <SingleGpu c={{ nodeId, index: 0, gpu: gpuAt(gpus, 0), info, multi: false, currency, rate }} />;
}

function SingleGpu({ c }: { c: GpuCtx }) {
  const { nodeId, index, gpu } = c;
  const smMax = gpu?.sm_mhz_max ?? null;
  const slowdown = gpu?.temp_slowdown_c ?? null;
  const shutdown = gpu?.temp_shutdown_c ?? null;
  const thresholds = useMemo(() => tempThresholds(slowdown, shutdown), [slowdown, shutdown]);
  const gap = useGpuGap(nodeId, c.info, index);

  return (
    <div className="view">
      <CollectorErrors nodeId={nodeId} only={['gpu']} />
      <Panel label={`${gpu?.name ?? 'GPU'} now`}>
        <NowLabel />
        <div className="nstats ngpu__stats">
          <GpuStats c={c} />
        </div>
      </Panel>

      {/* One panel. Left: why the clocks are limited now, then how much of the range they were (averages, said so).
          Right: the per-sample history; its legend is the latest sample ("now") or the one under the cursor. */}
      <Panel title="Clock limits" subtitle="Why the GPU is not running at full clock, from the driver">
        <div className="ngpu__throttle">
          <div className="nclock">
            <ThrottleNow nodeId={nodeId} index={index} smMax={smMax} gap={gap(gpuKey(index, 'throttle_mask'))} />
            <CappedShare nodeId={nodeId} index={index} info={c.info} />
          </div>
          <div className="nclock-time">
            <h3 className="nclock-time__title">Time clock-limited</h3>
            <p className="nclock-time__sub">Share of each sample interval the GPU spent power- or thermal-capped</p>
            <TimeSeriesChart
              node={nodeId}
              title="Time clock-limited"
              series={[series(index, 'power_capped_pct', 'Power-capped'), series(index, 'thermal_capped_pct', 'Thermal-capped')]}
              format={pct1}
              yMin={0}
              yMax={100}
              height={164}
            />
          </div>
        </div>
      </Panel>

      <div className="ngpu__charts">
        <Panel title="Utilisation" subtitle="Share of time the GPU was busy">
          <TimeSeriesChart node={nodeId} title="GPU utilisation" series={[series(index, 'util', 'Utilisation')]} format={pct} yMin={0} yMax={100} />
        </Panel>
        <Panel title="SM clock" subtitle={smMax ? `Chart top is the ${formatFreq(smMax)} maximum` : undefined}>
          <TimeSeriesChart node={nodeId} title="SM clock" series={[series(index, 'sm_mhz', 'SM clock')]} format={formatGhz} yMin={0} yMax={smMax ?? undefined} />
        </Panel>
        <Panel title="Temperature" subtitle="Dashed: the GPU’s slowdown and shutdown points">
          <TimeSeriesChart
            node={nodeId}
            title="GPU temperature"
            series={[series(index, 'temp_c', 'GPU temperature')]}
            format={formatTemp}
            thresholds={thresholds}
            yMin={30}
            yMax={shutdown != null ? shutdown + 4 : undefined}
          />
        </Panel>
        <Panel title="GPU power" subtitle="GPU rail only, not whole-system power">
          <TimeSeriesChart node={nodeId} title="GPU power" series={[series(index, 'power_w', 'GPU power')]} format={formatWatts} yMin={0} />
        </Panel>
      </div>

      <GpuProcesses nodeId={nodeId} />
    </div>
  );
}

interface MultiProps {
  nodeId: string;
  info: NodeInfo | null | undefined;
  gpus: readonly GpuInfo[];
  currency: string;
  rate: number | null;
}

function MultiGpu({ nodeId, info, gpus, currency, rate }: MultiProps) {
  const allId = useId();
  const perGpu = (field: GpuReading): SeriesSpec[] => gpus.map((g) => ({ key: gpuKey(g.index, field), label: `GPU ${g.index}`, gpu: g.index }));
  const smMaxes = gpus.map((g) => g.sm_mhz_max);
  const smTop = smMaxes.every((m) => m != null) ? Math.max(...smMaxes) : null;
  // One set of dashed lines is true for every series only when all GPUs share both points.
  const first = gpus[0];
  const agree = gpus.every((g) => g.temp_slowdown_c === first?.temp_slowdown_c) && gpus.every((g) => g.temp_shutdown_c === first?.temp_shutdown_c);
  const slowdown = agree ? (first?.temp_slowdown_c ?? null) : null;
  const shutdown = agree ? (first?.temp_shutdown_c ?? null) : null;
  const thresholds = useMemo(() => tempThresholds(slowdown, shutdown), [slowdown, shutdown]);

  return (
    <div className="view">
      <CollectorErrors nodeId={nodeId} only={['gpu']} />
      <NowLabel />
      <div className="ngpu__sections">
        {gpus.map((g) => (
          <GpuSection key={g.index} c={{ nodeId, index: g.index, gpu: g, info, multi: true, currency, rate }} />
        ))}
      </div>

      <section className="ngpu-group" aria-labelledby={allId}>
        <header className="ngpu-group__head">
          <h2 id={allId} className="ngpu-group__title">All GPUs</h2>
          <span className="ngpu-group__note">One line per GPU, in its section’s colour</span>
        </header>
        <div className="ngpu__charts">
          <Panel title="Utilisation" subtitle="Share of time each GPU was busy">
            <TimeSeriesChart node={nodeId} title="GPU utilisation" series={perGpu('util')} format={pct} yMin={0} yMax={100} />
          </Panel>
          <Panel title="SM clock" subtitle={smTop ? `Chart top is the highest maximum, ${formatFreq(smTop)}` : undefined}>
            <TimeSeriesChart node={nodeId} title="SM clock" series={perGpu('sm_mhz')} format={formatGhz} yMin={0} yMax={smTop ?? undefined} />
          </Panel>
          <Panel title="Temperature" subtitle={thresholds.length ? 'Dashed: the slowdown and shutdown points all GPUs share' : 'Each GPU’s section shows its own slowdown point'}>
            <TimeSeriesChart
              node={nodeId}
              title="GPU temperature"
              series={perGpu('temp_c')}
              format={formatTemp}
              thresholds={thresholds}
              yMin={30}
              yMax={shutdown != null ? shutdown + 4 : undefined}
            />
          </Panel>
          <Panel title="GPU power" subtitle="Per GPU, as the driver reports it">
            <TimeSeriesChart node={nodeId} title="GPU power" series={perGpu('power_w')} format={formatWatts} yMin={0} />
          </Panel>
        </div>
      </section>

      <GpuProcesses nodeId={nodeId} />
    </div>
  );
}

/** One GPU of several: its live stats and clock limits, or a notice when the latest sample has nothing for it. */
function GpuSection({ c }: { c: GpuCtx }) {
  const { nodeId, index, gpu } = c;
  const present = useLatest(nodeId, gpuPresent(index));
  const { waiting } = useFreshness(nodeId);
  const gap = useGpuGap(nodeId, c.info, index);
  const silent = gap(`gpu${index}`);
  const name = `GPU ${index}`;
  return (
    <Panel
      className="ngpu-section"
      label={name}
      title={
        <>
          <span className="ngpu-section__swatch" style={{ background: gpuColor(index) }} aria-hidden="true" />
          {name}
        </>
      }
      subtitle={gpu?.name}
      actions={present === false ? null : <GpuStatus nodeId={nodeId} index={index} />}
      busy={waiting}
    >
      {present === false ? (
        <EmptyState icon={Unplug} title={`${name} not responding`} compact>
          {silent?.detail ?? 'The latest sample has no entry for this GPU.'} The other GPUs are unaffected.
        </EmptyState>
      ) : (
        <>
          <div className="nstats ngpu-section__stats">
            <GpuStats c={c} />
          </div>
          <div className="nclock ngpu-section__clock">
            <ThrottleNow nodeId={nodeId} index={index} smMax={gpu?.sm_mhz_max ?? null} gap={gap(gpuKey(index, 'throttle_mask'))} rows="alerts" />
            <CappedShare nodeId={nodeId} index={index} info={c.info} />
          </div>
        </>
      )}
    </Panel>
  );
}

/** A section's compact status: its clock-limit badge, or the age of its values once the node stops reporting. */
function GpuStatus({ nodeId, index }: { nodeId: string; index: number }) {
  const mask = useLatest(nodeId, gpuSelector(index, 'throttle_mask'));
  const { stale } = useFreshness(nodeId);
  if (stale) return <StaleSince nodeId={nodeId} />;
  if (mask === null) return null;
  const badge = throttleBadge(decodeThrottle(mask));
  const meta = badge.severity === 'ok' ? null : SEVERITY_META[badge.severity];
  const Icon = meta?.icon ?? CircleCheck;
  return (
    <span className={`status status--pill status--sm ${meta?.tone ?? 'tone-ok'}`}>
      <Icon className="status__icon" aria-hidden="true" strokeWidth={2.25} />
      <span className="status__label">{badge.label}</span>
    </span>
  );
}

function StaleSince({ nodeId }: { nodeId: string }) {
  useNow(1000);
  const last = liveStore.lastTs(nodeId);
  return (
    <span className="status status--pill status--sm tone-stale">
      <Clock className="status__icon" aria-hidden="true" strokeWidth={2.25} />
      <span className="status__label">{last ? `Updated ${formatAgo(last, serverNow())}` : 'No recent data'}</span>
    </span>
  );
}

function GpuProcesses({ nodeId }: { nodeId: string }) {
  return (
    <Panel title="GPU processes" subtitle="Processes holding GPU memory. Refreshed every few seconds." flush>
      <ProcTable nodeId={nodeId} mode="gpu" />
    </Panel>
  );
}

/** `rows="alerts"` (a section among several) lists only the warning and critical reasons: the headline already names
 *  the informational ones, and repeating them in every section buries the GPU that needs attention. */
function ThrottleNow({ nodeId, index, smMax, gap, rows = 'all' }: { nodeId: string; index: number; smMax: number | null; gap: NotReported | null; rows?: 'all' | 'alerts' }) {
  const { waiting } = useFreshness(nodeId);
  const mask = useLatest(nodeId, gpuSelector(index, 'throttle_mask'));
  const clocks = useLatest(nodeId, (s) => clockLevel(s, smMax, index));
  const reasons = decodeThrottle(mask);
  const head = throttleHeadline(reasons, clocks);
  const meta = head.severity === 'ok' ? null : SEVERITY_META[head.severity];
  const listed = rows === 'all' ? reasons : reasons.filter((r) => r.severity !== 'info');
  const Icon = meta?.icon ?? CircleCheck;
  if (mask === null && waiting && !gap) {
    return (
      <div className="throttle-head" aria-busy="true">
        <Skeleton width={32} height={32} radius={10} />
        <Skeleton width={260} height={16} />
      </div>
    );
  }
  if (mask === null) return gap ? <Unsupported gap={gap} block /> : <NoData block />;
  return (
    <>
      <div className={`throttle-head ${meta?.tone ?? 'tone-ok'}`}>
        <span className="throttle-head__icon" aria-hidden="true"><Icon /></span>
        <div>
          <p className="throttle-head__text">
            {meta ? <span className="visually-hidden">{meta.label}: </span> : null}
            {head.text}
          </p>
          <p className="throttle-head__sub num">Clocks-event mask 0x{mask.toString(16)}</p>
        </div>
      </div>
      {listed.length ? <ThrottleRows reasons={listed} /> : null}
    </>
  );
}

// Range aggregates live in small leaves, so a range refresh re-renders only the numbers that use it.

/** "last 15 min", or the span the data really covers ("last 3 min") when it is shorter. */
const phraseOf = (range: TimeRange, data: RangeData | null) => spanPhrase(range, data?.ts[0], serverNow());

function useGpuRange(nodeId: string, index: number) {
  const keys = useMemo(() => rangeKeys(index), [index]);
  return useRangeData(nodeId, keys);
}

function PowerPeak({ nodeId, index, idle }: { nodeId: string; index: number; idle: string | null }) {
  const { range, data } = useGpuRange(nodeId, index);
  const key = gpuKey(index, 'power_w');
  const p = data ? peak(data.series[key], data.max[key]) : null;
  return <>{p != null ? `Peak ${formatWatts(p)} · ${phraseOf(range, data)}` : idle}</>;
}

function PowerTypical({ nodeId, index }: { nodeId: string; index: number }) {
  const { range, data } = useGpuRange(nodeId, index);
  const avg = data ? mean(data.series[gpuKey(index, 'power_w')]) : null;
  return avg != null ? <>Typical {formatWatts(avg)} · {phraseOf(range, data)}</> : null;
}

function RangeEnergy({ nodeId, index, currency, rate }: { nodeId: string; index: number; currency: string; rate: number | null }) {
  const { range, data, error } = useGpuRange(nodeId, index);
  if (error) return <>Range total unavailable</>;
  if (!data) return <Skeleton width={110} height={10} />;
  const key = gpuKey(index, 'energy_j');
  const j = historyEnergy(data.series[key], data.min[key]);
  if (j == null) return <>No energy readings {RANGE_PHRASE[range]}</>;
  return (
    <span className="num">
      {formatEnergyAuto(j)} {phraseOf(range, data)}
      {rate != null ? ` · ${formatEnergyCost(j, rate, currency)}` : ''}
    </span>
  );
}

function CappedShare({ nodeId, index, info }: { nodeId: string; index: number; info: NodeInfo | null | undefined }) {
  const { range, data } = useGpuRange(nodeId, index);
  const phrase = phraseOf(range, data);
  return (
    <div className="ncapped">
      {(['power', 'thermal'] as const).map((cap) => {
        const key = gpuKey(index, `${cap}_capped_pct`);
        return (
          <Stat
            key={cap}
            label={`Time ${cap}-capped`}
            value={data ? mean(data.series[key]) : null}
            format={percentParts}
            unsupported={notReported(info, key)}
            reporting={data !== null}
            footer={`Average over the ${phrase}`}
          />
        );
      })}
    </div>
  );
}
