import { CircleCheck } from 'lucide-react';
import { useMemo } from 'react';
import { TimeSeriesChart, unsupportedReason, type SeriesSpec, type Threshold } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { Stat } from '../../design/components/Stat';
import { Skeleton } from '../../design/components/Skeleton';
import { energyParts, formatFreq, formatPercent, formatTemp, formatWatts, percentParts, tempParts, wattsParts, type Formatter } from '../../lib/format';
import { decodeThrottle } from '../../lib/throttle';
import { useCluster } from '../../store/cluster';
import { useLatest } from '../../store/live';
import { formatEnergyAuto, formatEnergyCost, historyEnergy } from '../shared/energy';
import { mean, peak } from './parts/gpu';
import { TempFooter } from './parts/TempFooter';
import { RANGE_PHRASE, spanPhrase } from '../shared/live';
import { serverNow } from '../../store/cluster';
import type { TimeRange } from '../../lib/prefs';
import { useRangeData, type RangeData } from './parts/hooks';
import { LiveStat } from './parts/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { clockLevel, CollectorErrors, SEVERITY_META, selectThrottleMask, throttleHeadline, ThrottleRows } from './parts/Notices';
import { ProcTable } from './parts/ProcTable';
import { gpuEnergy, gpuPower, gpuPstate, gpuSm, gpuTemp, gpuUtil } from './parts/selectors';
import type { NodeTabProps } from './tabs';

const pct = (n: number) => formatPercent(n);
const pct1 = (n: number) => formatPercent(n, n > 0 && n < 10 ? 1 : 0);
const pstateParts: Formatter = (n) => ({ value: `P${Math.round(n)}`, unit: '' });

const UTIL: readonly SeriesSpec[] = [{ key: 'gpu0.util', label: 'Utilisation' }];
const SM: readonly SeriesSpec[] = [{ key: 'gpu0.sm_mhz', label: 'SM clock' }];
/** One unit on the clock axis: "0.00 GHz" at the bottom rather than "0 MHz" under "1.00 GHz". */
const formatGhz = (mhz: number) => `${(mhz / 1000).toFixed(2)}\u00a0GHz`;
const TEMP: readonly SeriesSpec[] = [{ key: 'gpu0.temp_c', label: 'GPU temperature' }];
const POWER: readonly SeriesSpec[] = [{ key: 'gpu0.power_w', label: 'GPU power' }];
const CAPPED: readonly SeriesSpec[] = [
  { key: 'gpu0.power_capped_pct', label: 'Power-capped' },
  { key: 'gpu0.thermal_capped_pct', label: 'Thermal-capped' },
];
const RANGE_KEYS = ['gpu0.power_w', 'gpu0.energy_j', 'gpu0.power_capped_pct', 'gpu0.thermal_capped_pct'] as const;

/** "2.17 / 3.00 GHz": the current SM clock over the GPU's maximum. */
function smOverMax(maxMhz: number | null | undefined): Formatter {
  if (!maxMhz) return (n) => ({ value: (n / 1000).toFixed(2), unit: 'GHz' });
  const max = (maxMhz / 1000).toFixed(2);
  return (n) => ({ value: (n / 1000).toFixed(2), unit: `/ ${max} GHz` });
}

export default function Gpu({ nodeId }: NodeTabProps) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const gpu = info?.gpus[0];
  const currency = useCluster((s) => s.cluster?.settings.currency ?? '£');
  const rate = useCluster((s) => s.cluster?.settings.energy_rate_per_kwh ?? null);
  const smMax = gpu?.sm_mhz_max ?? null;
  const smFormat = useMemo(() => smOverMax(smMax), [smMax]);
  const slowdown = gpu?.temp_slowdown_c ?? null;
  const shutdown = gpu?.temp_shutdown_c ?? null;
  const thresholds = useMemo<Threshold[]>(() => {
    const t: Threshold[] = [];
    // Only 4 °C apart: the chart draws the lines and keys their labels in its legend row, so they never collide.
    if (slowdown != null) t.push({ value: slowdown, label: `Slowdown ${formatTemp(slowdown)}`, tone: 'warn' });
    if (shutdown != null) t.push({ value: shutdown, label: `Shutdown ${formatTemp(shutdown)}`, tone: 'crit' });
    return t;
  }, [slowdown, shutdown]);
  const limitReason = unsupportedReason(info, 'gpu0.power_limit_w');

  return (
    <div className="view">
      <CollectorErrors nodeId={nodeId} only={['gpu']} />
      <Panel label={`${gpu?.name ?? 'GPU'} now`}>
        <NowLabel />
        <div className="nstats ngpu__stats">
          <LiveStat nodeId={nodeId} label="Utilisation" select={gpuUtil} metric="gpu0.util" format={percentParts} footer={() => gpu?.name ?? null} />
          <LiveStat
            nodeId={nodeId}
            label="SM clock"
            select={gpuSm} metric="gpu0.sm_mhz"
            format={smFormat}
            footer={(v) => (v != null && smMax ? `${Math.round((100 * v) / smMax)}% of maximum` : null)}
          />
          <LiveStat
            nodeId={nodeId}
            label="Temperature"
            select={gpuTemp} metric="gpu0.temp_c"
            format={tempParts}
            footer={(v) => <TempFooter temp={v} slowdown={slowdown} shutdown={shutdown} />}
          />
          <LiveStat
            nodeId={nodeId}
            label="GPU power"
            select={gpuPower} metric="gpu0.power_w"
            format={wattsParts}
            unsupported={unsupportedReason(info, 'gpu0.power_w')}
            footer={() => <PowerPeak nodeId={nodeId} />}
          />
          {gpu?.power_limit_w != null ? (
            <Stat label="Power limit" value={gpu.power_limit_w} format={wattsParts} />
          ) : (
            <Stat
              label="Power limit"
              value={null}
              format={wattsParts}
              unsupported={limitReason ?? 'The driver does not report a power limit for this GPU.'}
              footer={<PowerTypical nodeId={nodeId} />}
            />
          )}
          <LiveStat nodeId={nodeId} label="Performance state" select={gpuPstate} format={pstateParts} footer={(v) => (v === 0 ? 'Maximum performance' : v != null ? 'Reduced performance state' : null)} />
          <LiveStat
            nodeId={nodeId}
            label="Energy since driver load"
            select={gpuEnergy} metric="gpu0.energy_j"
            format={energyParts}
            footer={() => <RangeEnergy nodeId={nodeId} currency={currency} rate={rate} />}
          />
        </div>
      </Panel>

      {/* One panel. Left: why the clocks are limited now, then how much of the range they were (averages, said so).
          Right: the per-sample history; its legend is the latest sample ("now") or the one under the cursor. */}
      <Panel title="Clock limits" subtitle="Why the GPU is not running at full clock, from the driver">
        <div className="ngpu__throttle">
          <div className="nclock">
            <ThrottleNow nodeId={nodeId} smMax={smMax} />
            <CappedShare nodeId={nodeId} />
          </div>
          <div className="nclock-time">
            <h3 className="nclock-time__title">Time clock-limited</h3>
            <p className="nclock-time__sub">Share of each sample interval the GPU spent power- or thermal-capped</p>
            <TimeSeriesChart node={nodeId} title="Time clock-limited" series={CAPPED} format={pct1} yMin={0} yMax={100} height={164} />
          </div>
        </div>
      </Panel>

      <div className="ngpu__charts">
        <Panel title="Utilisation" subtitle="Share of time the GPU was busy">
          <TimeSeriesChart node={nodeId} title="GPU utilisation" series={UTIL} format={pct} yMin={0} yMax={100} />
        </Panel>
        <Panel title="SM clock" subtitle={smMax ? `Chart top is the ${formatFreq(smMax)} maximum` : undefined}>
          <TimeSeriesChart node={nodeId} title="SM clock" series={SM} format={formatGhz} yMin={0} yMax={smMax ?? undefined} />
        </Panel>
        <Panel title="Temperature" subtitle="Dashed: the GPU’s slowdown and shutdown points">
          <TimeSeriesChart
            node={nodeId}
            title="GPU temperature"
            series={TEMP}
            format={formatTemp}
            thresholds={thresholds}
            yMin={30}
            yMax={shutdown != null ? shutdown + 4 : undefined}
          />
        </Panel>
        <Panel title="GPU power" subtitle="GPU rail only, not whole-system power">
          <TimeSeriesChart node={nodeId} title="GPU power" series={POWER} format={formatWatts} yMin={0} />
        </Panel>
      </div>

      <Panel title="GPU processes" subtitle="Processes holding GPU memory. Refreshed every few seconds." flush>
        <ProcTable nodeId={nodeId} mode="gpu" />
      </Panel>
    </div>
  );
}

function ThrottleNow({ nodeId, smMax }: { nodeId: string; smMax: number | null }) {
  const mask = useLatest(nodeId, selectThrottleMask);
  const clocks = useLatest(nodeId, (s) => clockLevel(s, smMax));
  const reasons = decodeThrottle(mask);
  const head = throttleHeadline(reasons, clocks);
  const meta = head.severity === 'ok' ? null : SEVERITY_META[head.severity];
  const Icon = meta?.icon ?? CircleCheck;
  if (mask === null) {
    return (
      <div className="throttle-head" aria-busy="true">
        <Skeleton width={32} height={32} radius={10} />
        <Skeleton width={260} height={16} />
      </div>
    );
  }
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
      {reasons.length ? <ThrottleRows reasons={reasons} /> : null}
    </>
  );
}

// Range aggregates live in small leaves, so a range refresh re-renders only the numbers that use it.

/** "last 15 min", or the span the data really covers ("last 3 min") when it is shorter. */
const phraseOf = (range: TimeRange, data: RangeData | null) => spanPhrase(range, data?.ts[0], serverNow());

function PowerPeak({ nodeId }: { nodeId: string }) {
  const { range, data } = useRangeData(nodeId, RANGE_KEYS);
  const p = data ? peak(data.series['gpu0.power_w'], data.max['gpu0.power_w']) : null;
  return <>{p != null ? `Peak ${formatWatts(p)} · ${phraseOf(range, data)}` : 'GPU rail only'}</>;
}

function PowerTypical({ nodeId }: { nodeId: string }) {
  const { range, data } = useRangeData(nodeId, RANGE_KEYS);
  const avg = data ? mean(data.series['gpu0.power_w']) : null;
  return avg != null ? <>Typical {formatWatts(avg)} · {phraseOf(range, data)}</> : null;
}

function RangeEnergy({ nodeId, currency, rate }: { nodeId: string; currency: string; rate: number | null }) {
  const { range, data, error } = useRangeData(nodeId, RANGE_KEYS);
  if (error) return <>Range total unavailable</>;
  if (!data) return <Skeleton width={110} height={10} />;
  const j = historyEnergy(data.series['gpu0.energy_j'], data.min['gpu0.energy_j']);
  if (j == null) return <>No energy readings {RANGE_PHRASE[range]}</>;
  return (
    <span className="num">
      {formatEnergyAuto(j)} {phraseOf(range, data)}
      {rate != null ? ` · ${formatEnergyCost(j, rate, currency)}` : ''}
    </span>
  );
}

function CappedShare({ nodeId }: { nodeId: string }) {
  const { range, data } = useRangeData(nodeId, RANGE_KEYS);
  const phrase = phraseOf(range, data);
  return (
    <div className="ncapped">
      <Stat label="Time power-capped" value={data ? mean(data.series['gpu0.power_capped_pct']) : null} format={percentParts} footer={`Average over the ${phrase}`} />
      <Stat label="Time thermal-capped" value={data ? mean(data.series['gpu0.thermal_capped_pct']) : null} format={percentParts} footer={`Average over the ${phrase}`} />
    </div>
  );
}
