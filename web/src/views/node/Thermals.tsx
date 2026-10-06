// Thermals & Power: every temperature sensor grouped by where it sits, GPU rail power and energy, and the
// metrics this hardware does not report (fans, whole-system power) stated plainly instead of drawn as zero.
import { Thermometer } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { unsupportedReason } from '../../charts/TimeSeriesChart';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { Stat } from '../../design/components/Stat';
import { formatTemp, tempParts, wattsParts, type Formatter } from '../../lib/format';
import { useCluster } from '../../store/cluster';
import type { LiveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { ChartPanelSkeleton, StatSkeleton } from '../placeholders';
import { formatEnergyCost, formatKwh, joulesToKwh } from '../shared/energy';
import { useRangeHistory } from '../shared/live';
import { useLiveDerived, useSpanEnergy, useStaleSince } from './partsC/hooks';
import { NowLabel } from './parts/NowLabel';
import { EnergyPanel, PowerPanel } from './partsC/Power';
import { SensorGroupPanel } from './partsC/SensorGroup';
import { buildGroups, headroom, hottest, type SensorGroup } from './partsC/thermal';
import './partsC/partsC.css';

export default function Thermals({ nodeId }: { nodeId: string }) {
  const info = useCluster((s) => s.nodes[nodeId]?.info ?? null);
  const status = useCluster((s) => s.nodes[nodeId]?.status);
  const hasSample = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.lastTs(nodeId) !== null, [nodeId]), Object.is);
  const range = usePrefs((s) => s.timeRange);
  const { stale, updatedAt } = useStaleSince(nodeId);
  const groups = useMemo(() => buildGroups(info), [info]);
  const keys = useMemo(() => groups.flatMap((g) => g.sensors.map((s) => s.key)), [groups]);
  const history = useRangeHistory(nodeId, keys, range === 'live' ? null : range);

  if (!info || (!hasSample && (status === 'connecting' || status === 'online' || !status))) return <ThermalsSkeleton />;
  if (!hasSample) {
    return (
      <Panel label="Thermals">
        <EmptyState icon={Thermometer} title={`No readings from ${nodeId} yet`}>
          Temperatures and power appear here as soon as the agent on {nodeId} sends its first sample.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="view tp">
      <ThermalHeader nodeId={nodeId} groups={groups} stale={stale} updatedAt={updatedAt} fanReason={unsupportedReason(info, 'fan')} />
      <div className="tp-groups">
        {groups.map((g) => (
          <SensorGroupPanel key={g.id} nodeId={nodeId} group={g} info={info} range={range} history={history} stale={stale} />
        ))}
      </div>
      <div className="tp-power-row">
        <PowerPanel nodeId={nodeId} info={info} range={range} stale={stale} updatedAt={updatedAt} />
        <EnergyPanel nodeId={nodeId} info={info} range={range} stale={stale} />
      </div>
    </div>
  );
}

const sameHot = (a: { label: string; c: number } | null, b: { label: string; c: number } | null) =>
  a === b || (a !== null && b !== null && a.label === b.label && Math.round(a.c) === Math.round(b.c));

/** The one-glance answer: what is hottest, how close the GPU is to slowing down, what it draws, what today cost. */
function ThermalHeader({ nodeId, groups, stale, updatedAt, fanReason }: { nodeId: string; groups: SensorGroup[]; stale: boolean; updatedAt: number | null; fanReason: string | null }) {
  const hot = useLiveDerived(nodeId, useCallback((st: LiveStore) => hottest(groups, (k) => st.latestValue(nodeId, k)), [groups, nodeId]), sameHot);
  const gpuTemp = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, 'gpu0.temp_c'), [nodeId]), Object.is);
  const gpuPower = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, 'gpu0.power_w'), [nodeId]), Object.is);
  const gpuSensor = groups.find((g) => g.id === 'gpu')?.sensors[0];
  const room = headroom(gpuTemp, gpuSensor?.limit ?? null);

  return (
    <Panel label={`${nodeId} thermals and power summary`} className="tp-head">
      <NowLabel />
      <div className="nstats">
        <Stat label="Hottest sensor" value={hot?.c} format={tempParts} stale={stale} updatedAt={updatedAt} footer={hot ? hot.label : undefined} />
        <Stat
          label="GPU temperature"
          value={gpuTemp}
          format={tempParts}
          stale={stale}
          updatedAt={updatedAt}
          footer={room ? (room.degrees > 0 ? `${formatTemp(room.degrees)} below slowdown (${formatTemp(gpuSensor?.limit)})` : 'At the slowdown limit') : undefined}
        />
        <Stat label="GPU power" value={gpuPower} format={wattsParts} stale={stale} updatedAt={updatedAt} footer="GPU rail only" />
        <EnergyToday nodeId={nodeId} />
        <Stat label="Fans" value={null} format={wattsParts} unsupported={fanReason ?? 'No fan sensors are exposed by this hardware.'} />
      </div>
    </Panel>
  );
}

/** kWh in, always shown in kWh (3 significant figures), like the Overview's "Today": one unit for a figure that
 *  grows all day, so it never seems to drop when it crosses 1 kWh. */
const kwhParts: Formatter = (kwh) => {
  const t = formatKwh(kwh * 3.6e6).split(/\s/);
  return { value: t[0] ?? '', unit: t[1] ?? 'kWh' };
};

function EnergyToday({ nodeId }: { nodeId: string }) {
  const settings = useCluster((s) => s.cluster?.settings);
  const today = useSpanEnergy(nodeId, 'gpu0.energy_j', 'today');
  const j = today.state === 'ready' ? today.data : null;
  const cost = j == null || !settings ? undefined : `${formatEnergyCost(j, settings.energy_rate_per_kwh, settings.currency)} so far`;
  if (today.state === 'loading') {
    return (
      <div className="stat stat--md" aria-busy="true">
        <div className="stat__label">GPU energy today</div>
        <Skeleton width={84} height={24} radius={8} style={{ marginTop: 2 }} />
      </div>
    );
  }
  return (
    <Stat
      label="GPU energy today"
      value={j == null ? null : joulesToKwh(j)}
      format={kwhParts}
      footer={today.state === 'error' ? 'History unavailable' : cost}
    />
  );
}

function ThermalsSkeleton() {
  return (
    <div className="view tp" aria-busy="true">
      <Panel label="Thermals and power summary" busy className="tp-head">
        <div className="nstats">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>
      </Panel>
      <div className="tp-groups">
        <ChartPanelSkeleton title="GPU" height={260} />
        <ChartPanelSkeleton title="SoC · ACPI zones" height={260} />
        <ChartPanelSkeleton title="NVMe" height={260} />
        <ChartPanelSkeleton title="ConnectX-7" height={260} />
      </div>
    </div>
  );
}
