import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { LIVE_WINDOW_S, TimeSeriesChart, unsupportedReason, type Threshold } from '../../../charts/TimeSeriesChart';
import { AnimatedNumber } from '../../../design/components/AnimatedNumber';
import { Panel } from '../../../design/components/Panel';
import { Sparkline } from '../../../design/components/Sparkline';
import '../../../design/components/Table.css';
import { Unsupported } from '../../../design/components/Unsupported';
import { DASH, formatTemp } from '../../../lib/format';
import type { TimeRange } from '../../../lib/prefs';
import type { HistoryResponse, NodeInfo } from '../../../lib/types';
import { serverNow } from '../../../store/cluster';
import { liveStore, type LiveStore } from '../../../store/live';
import type { Loadable } from '../../shared/live';
import { useLiveDerived } from './hooks';
import { chartSensors, headroom, minMax, shortLabels, type Sensor, type SensorGroup } from './thermal';

export const RANGE_SHORT: Record<TimeRange, string> = { live: `${LIVE_WINDOW_S / 60} min`, '5m': '5 min', '1h': '1 h', '24h': '24 h', '7d': '7 d' };

const tempText = (n: number) => n.toFixed(0);
const sameRounded = (a: { min: number | null; max: number | null }, b: { min: number | null; max: number | null }) =>
  Math.round(a.min ?? NaN) === Math.round(b.min ?? NaN) && Math.round(a.max ?? NaN) === Math.round(b.max ?? NaN);
const eqNullable = (a: { min: number | null; max: number | null }, b: { min: number | null; max: number | null }) =>
  (a.min === null) === (b.min === null) && (a.max === null) === (b.max === null) && sameRounded(a, b);

function subtitleFor(group: SensorGroup, charted: number): string {
  const s = group.sensors[0];
  const parts: string[] = [];
  if (group.id === 'gpu' && s) {
    if (s.limit != null) parts.push(`Slows down at ${formatTemp(s.limit)}`);
    if (s.hardLimit != null) parts.push(`shuts down at ${formatTemp(s.hardLimit)}`);
  } else {
    parts.push(`${group.sensors.length} ${group.sensors.length === 1 ? 'sensor' : 'sensors'}`);
    const crit = [...new Set(group.sensors.map((x) => x.limit).filter((x): x is number => x != null))];
    if (crit.length === 1 && crit[0] != null) parts.push(`critical at ${formatTemp(crit[0])}`);
    // Chosen when the page opened (colours stay with their sensors), so it does not claim to track the hottest.
    if (charted < group.sensors.length) parts.push(`chart shows ${charted} of ${group.sensors.length} (hottest when opened)`);
  }
  return parts.join(' · ');
}

interface Props {
  nodeId: string;
  group: SensorGroup;
  info: NodeInfo | null;
  range: TimeRange;
  history: Loadable<HistoryResponse>;
  stale: boolean;
  store?: LiveStore;
}

/** One sensor group: a table of readings (now, min/max over the range, trend, headroom) above a chart. */
export function SensorGroupPanel({ nodeId, group, info, range, history, stale, store = liveStore }: Props) {
  // Chosen once per group so colours stay attached to the same sensors while the page is open.
  const charted = useMemo(() => chartSensors(group, (k) => store.latestValue(nodeId, k)), [group, nodeId, store]);
  const series = useMemo(() => {
    const labels = shortLabels(charted.map((s) => s.label));
    return charted.map((s, i) => ({ key: s.key, label: labels[i] ?? s.label }));
  }, [charted]);
  const gpu = group.id === 'gpu' ? group.sensors[0] : undefined;
  // Same two lines as the GPU tab (labelled in the chart's legend row).
  const thresholds = useMemo<Threshold[] | undefined>(() => {
    if (gpu?.limit == null) return undefined;
    const t: Threshold[] = [{ value: gpu.limit, label: `Slowdown ${formatTemp(gpu.limit)}`, tone: 'warn' }];
    if (gpu.hardLimit != null) t.push({ value: gpu.hardLimit, label: `Shutdown ${formatTemp(gpu.hardLimit)}`, tone: 'crit' });
    return t;
  }, [gpu]);
  const hasLimits = group.sensors.some((x) => x.limit != null);
  // One sensor: its row sits above a full-width chart (side by side, the one-row table would leave a blank block).
  const single = group.sensors.length === 1;
  const chartHeight = single ? 150 : Math.min(300, Math.max(168, group.sensors.length * 38 + 20));
  const span = RANGE_SHORT[range];

  return (
    <Panel title={group.title} subtitle={subtitleFor(group, charted.length)} className={`tp-group${stale ? ' is-stale' : ''}`}>
      <div className={`tp-group__body${single ? ' tp-group__body--single' : ''}`}>
        <div className="table-wrap">
          <table className="table tp-sensors">
            <caption className="visually-hidden">{`${group.title} temperatures, with minimum and maximum over the last ${span}`}</caption>
            <thead>
              <tr>
                <th scope="col">Sensor</th>
                <th scope="col" className="is-end">Now</th>
                <th scope="col" className="is-end"><span className="tp-range-head">Min</span></th>
                <th scope="col" className="is-end"><span className="tp-range-head">Max</span></th>
                <th scope="col" className="tp-sensors__trend">Last {span}</th>
                {hasLimits ? <th scope="col" className="is-end">Headroom</th> : null}
              </tr>
            </thead>
            <tbody>
              {group.sensors.map((s) => (
                <SensorRow key={s.key} nodeId={nodeId} sensor={s} range={range} history={history} reason={unsupportedReason(info, s.key)} store={store} showRoom={hasLimits} />
              ))}
            </tbody>
          </table>
        </div>
        <TimeSeriesChart
          node={nodeId}
          title={`${group.title} temperature`}
          series={series}
          format={formatTemp}
          height={chartHeight}
          thresholds={thresholds}
          yMax={gpu?.limit ?? undefined}
          store={store}
        />
      </div>
    </Panel>
  );
}

function SensorRow({ nodeId, sensor, range, history, reason, store, showRoom }: { nodeId: string; sensor: Sensor; range: TimeRange; history: Loadable<HistoryResponse>; reason: string | null; store: LiveStore; showRoom: boolean }) {
  // From the ring buffer rather than the last Sample, so readings seeded from history show while a node is offline.
  const now = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, sensor.key), [nodeId, sensor.key]), Object.is, store);
  const live = range === 'live';
  const liveRange = useLiveDerived(
    nodeId,
    useCallback((st: LiveStore) => minMax(st.window(nodeId, [sensor.key], serverNow() - LIVE_WINDOW_S).values[0] ?? []), [nodeId, sensor.key]),
    eqNullable,
    store,
  );
  const hist = history.state === 'ready' ? history.data : null;
  const histRange = useMemo(() => {
    if (!hist) return { min: null, max: null };
    const lo = minMax(hist.min[sensor.key] ?? hist.series[sensor.key] ?? []).min;
    const hi = minMax(hist.max[sensor.key] ?? hist.series[sensor.key] ?? []).max;
    return { min: lo, max: hi };
  }, [hist, sensor.key]);
  const { min, max } = live ? liveRange : histRange;
  const room = headroom(now, sensor.limit);

  if (reason) {
    return (
      <tr>
        <th scope="row" className="tp-sensors__label">{sensor.label}</th>
        <td colSpan={showRoom ? 5 : 4}><Unsupported reason={reason} /></td>
      </tr>
    );
  }

  return (
    <tr>
      <th scope="row" className="tp-sensors__label">{sensor.label}</th>
      <td className="is-end tp-sensors__now">
        <AnimatedNumber value={now} format={tempText} className="tp-dim" />
        {now != null ? <span className="tp-unit tp-dim">°C</span> : null}
      </td>
      <td className="is-end tp-sensors__mm num"><span className="tp-dim">{live || hist ? formatTemp(min) : DASH}</span></td>
      <td className="is-end tp-sensors__mm num"><span className="tp-dim">{live || hist ? formatTemp(max) : DASH}</span></td>
      <td className="tp-sensors__trend">
        <div className="tp-dim">
          {live ? (
            <Sparkline label={`${sensor.label} temperature`} format={formatTemp} source={{ node: nodeId, metric: sensor.key, windowS: LIVE_WINDOW_S }} store={store} height={24} />
          ) : hist ? (
            <Sparkline label={`${sensor.label} temperature`} format={formatTemp} values={hist.series[sensor.key] ?? []} ts={hist.ts} height={24} />
          ) : (
            <span className="tp-trend-placeholder" aria-hidden="true" />
          )}
        </div>
      </td>
      {showRoom ? (
        <td className="is-end tp-sensors__room">
          <Headroom room={room} limitLabel={sensor.limitLabel} />
        </td>
      ) : null}
    </tr>
  );
}

function Headroom({ room, limitLabel }: { room: ReturnType<typeof headroom>; limitLabel: string }) {
  if (!room) return <span className="tp-room tp-room--none" title="This sensor reports no limit">{DASH}</span>;
  const Icon = room.tone === 'crit' ? OctagonAlert : room.tone === 'warn' ? TriangleAlert : null;
  const text = room.degrees <= 0 ? `At ${limitLabel}` : formatTemp(room.degrees);
  return (
    <span className={`tp-room tp-dim${room.tone !== 'ok' ? ` tone-${room.tone} tp-room--alert` : ''}`}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span className="num">{text}</span>
      {room.degrees > 0 ? <span className="tp-room__to"> to {limitLabel}</span> : null}
    </span>
  );
}
