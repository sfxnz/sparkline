import { useCallback, useMemo } from 'react';
import { Link } from 'wouter';
import { LIVE_WINDOW_S, TimeSeriesChart, unsupportedReason } from '../../../charts/TimeSeriesChart';
import { Panel } from '../../../design/components/Panel';
import { Skeleton } from '../../../design/components/Skeleton';
import { Stat } from '../../../design/components/Stat';
import { Tooltip } from '../../../design/components/Tooltip';
import { Unsupported } from '../../../design/components/Unsupported';
import { DASH, formatWatts, wattsParts } from '../../../lib/format';
import type { TimeRange } from '../../../lib/prefs';
import type { NodeInfo } from '../../../lib/types';
import { paths } from '../../../app/routes';
import { serverNow, useCluster } from '../../../store/cluster';
import { liveStore, type LiveStore } from '../../../store/live';
import { counterDelta, formatEnergyAuto, formatEnergyCost, formatKwh, historyEnergy } from '../../shared/energy';
import { powerStats } from './energy';
import { useRangeHistory, type Loadable } from '../../shared/live';
import { useLiveDerived, useSpanEnergy } from './hooks';
import { RANGE_SHORT } from './SensorGroup';

const POWER = 'gpu0.power_w';
const ENERGY = 'gpu0.energy_j';
const POWER_SERIES = [{ key: POWER, label: 'GPU power' }] as const;
const DEFAULT_RATE = { energy_rate_per_kwh: 0.28, currency: '£' };

const roundEq = (a: { avg: number | null; peak: number | null }, b: { avg: number | null; peak: number | null }) =>
  (a.avg === null) === (b.avg === null) && (a.peak === null) === (b.peak === null) &&
  Math.round((a.avg ?? 0) * 10) === Math.round((b.avg ?? 0) * 10) && Math.round((a.peak ?? 0) * 10) === Math.round((b.peak ?? 0) * 10);

interface Props {
  nodeId: string;
  info: NodeInfo | null;
  range: TimeRange;
  stale: boolean;
  updatedAt: number | null;
  store?: LiveStore;
}

/** GPU rail power over the selected range, with now / average / peak, and the (unsupported) power limit. */
export function PowerPanel({ nodeId, info, range, stale, updatedAt, store = liveStore }: Props) {
  const live = range === 'live';
  const now = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, POWER), [nodeId]), Object.is, store);
  const liveStats = useLiveDerived(
    nodeId,
    useCallback((st: LiveStore) => powerStats(st.window(nodeId, [POWER], serverNow() - LIVE_WINDOW_S).values[0] ?? []), [nodeId]),
    roundEq,
    store,
  );
  const hist = useRangeHistory(nodeId, [POWER], live ? null : range);
  const histStats = useMemo(
    () => (hist.state === 'ready' ? powerStats(hist.data.series[POWER] ?? [], hist.data.max[POWER]) : null),
    [hist],
  );
  const stats = live ? liveStats : histStats;
  const span = RANGE_SHORT[range];
  const limitReason = unsupportedReason(info, 'gpu0.power_limit_w') ?? 'GB10 does not report a GPU power limit (NVML: Not Supported).';
  const powerReason = unsupportedReason(info, POWER);

  return (
    <Panel
      title="GPU power"
      subtitle="GPU rail only, measured by NVML. This is not whole-system or wall power."
      className={`tp-power${stale ? ' is-stale' : ''}`}
    >
      <div className="tp-power__body">
        <TimeSeriesChart node={nodeId} title="GPU power" series={POWER_SERIES} format={formatWatts} height={228} yMin={0} store={store} />
        <div className="tp-power__stats">
          <Stat label="Now" value={now} format={wattsParts} stale={stale} updatedAt={updatedAt} unsupported={powerReason ?? undefined} />
          <RangeStat label={`Average · ${span}`} value={stats?.avg ?? null} loading={!live && hist.state === 'loading'} error={!live && hist.state === 'error'} />
          <RangeStat label={`Peak · ${span}`} value={stats?.peak ?? null} loading={!live && hist.state === 'loading'} error={!live && hist.state === 'error'} />
          <div className="stat">
            <div className="stat__label">Power limit</div>
            <div className="stat__unsupported">
              <Unsupported reason={limitReason} />
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function RangeStat({ label, value, loading, error }: { label: string; value: number | null; loading: boolean; error: boolean }) {
  if (loading) {
    return (
      <div className="stat" aria-busy="true">
        <div className="stat__label">{label}</div>
        <Skeleton width={84} height={26} radius={8} style={{ marginTop: 2 }} />
      </div>
    );
  }
  return <Stat label={label} value={value} format={wattsParts} footer={error ? 'History unavailable' : undefined} />;
}

/** Energy the GPU rail used over the range, today and the last 7 days, priced at the configured rate. */
export function EnergyPanel({ nodeId, info, range, stale, store = liveStore }: Omit<Props, 'updatedAt'>) {
  const settings = useCluster((s) => s.cluster?.settings) ?? DEFAULT_RATE;
  const rate = settings.energy_rate_per_kwh;
  const currency = settings.currency;
  const live = range === 'live';
  const energyReason = unsupportedReason(info, ENERGY);
  const systemReason = unsupportedReason(info, 'system.power_w') ?? 'Whole-system power is not exposed; only the GPU rail (NVML) is.';

  const liveJ = useLiveDerived(
    nodeId,
    useCallback((st: LiveStore) => counterDelta(st.window(nodeId, [ENERGY], serverNow() - LIVE_WINDOW_S).values[0] ?? []), [nodeId]),
    (a, b) => (a === null ? b === null : b !== null && Math.round(a) === Math.round(b)),
    store,
  );
  const rangeHist = useRangeHistory(nodeId, [ENERGY], live ? null : range);
  const rangeJ: Loadable<number | null> = live
    ? { state: 'ready', data: liveJ }
    : rangeHist.state === 'ready'
      ? { state: 'ready', data: historyEnergy(rangeHist.data.series[ENERGY], rangeHist.data.min[ENERGY]) }
      : rangeHist;
  const todayJ = useSpanEnergy(nodeId, ENERGY, 'today', store);
  const weekJ = useSpanEnergy(nodeId, ENERGY, '7d', store);

  return (
    <Panel
      title="GPU energy"
      subtitle={
        <>
          Priced at <span className="num">{currency}{rate.toFixed(2)}</span> per kWh ·{' '}
          <Link href={paths.settings}>Change rate</Link>
        </>
      }
      className={`tp-energy${stale ? ' is-stale' : ''}`}
    >
      {energyReason ? (
        <Unsupported reason={energyReason} block />
      ) : (
        <dl className="tp-energy__list">
          {range === '7d' ? null : <EnergyRow label={`Last ${RANGE_SHORT[range]}`} value={rangeJ} rate={rate} currency={currency} />}
          {/* Day and week totals in kWh, like the header's "GPU energy today" and the Overview. */}
          <EnergyRow label="Today" value={todayJ} rate={rate} currency={currency} kwh />
          <EnergyRow label="Last 7 days" value={weekJ} rate={rate} currency={currency} kwh />
        </dl>
      )}
      <div className="tp-energy__system">
        <div className="tp-energy__system-head">
          <span className="tp-energy__system-label">Whole-system power</span>
          <Unsupported reason={systemReason} />
        </div>
        <p className="tp-note">
          These totals are the GPU rail only. CPU, memory, NIC and storage draw more on top, so the wall figure is higher.
        </p>
      </div>
    </Panel>
  );
}

function EnergyRow({ label, value, rate, currency, kwh }: { label: string; value: Loadable<number | null>; rate: number; currency: string; kwh?: boolean }) {
  return (
    <div className="tp-energy__row">
      <dt>{label}</dt>
      <dd>
        {value.state === 'loading' ? (
          <>
            <Skeleton width={76} height={20} radius={6} />
            <Skeleton width={44} height={14} />
          </>
        ) : value.state === 'error' ? (
          <Tooltip content={`History unavailable: ${value.message}`}>
            <button type="button" className="tp-energy__err">{DASH}<span className="visually-hidden"> History unavailable</span></button>
          </Tooltip>
        ) : (
          <>
            <span className="tp-energy__kwh num tp-dim">{kwh ? formatKwh(value.data) : formatEnergyAuto(value.data)}</span>
            <span className="tp-energy__cost num tp-dim">{value.data == null ? '' : formatEnergyCost(value.data, rate, currency)}</span>
          </>
        )}
      </dd>
    </div>
  );
}
