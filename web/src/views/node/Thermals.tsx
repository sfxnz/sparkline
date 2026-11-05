// Thermals & Power: every temperature sensor grouped by where it sits, GPU rail power and energy, and the
// metrics this hardware does not report (fans, whole-system power) stated plainly instead of drawn as zero.
import { CircleSlash, Thermometer } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { Stat } from '../../design/components/Stat';
import { notReported, type NotReported } from '../../lib/capabilities';
import { gpuIndexes, gpuSetGap, nodeGpuKey, notResponding } from '../../lib/gpu';
import { tempParts, wattsParts, type Formatter } from '../../lib/format';
import type { NodeInfo, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useLatest, type LiveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { ChartPanelSkeleton, StatSkeleton } from '../placeholders';
import { energyKeys, formatEnergyCost, formatKwh, joulesToKwh } from '../shared/energy';
import { useRangeHistory } from '../shared/live';
import { sameGap } from '../shared/totalGap';
import { useLiveDerived, useSpanEnergy, useStaleSince } from './partsC/hooks';
import { CollectorErrors } from './parts/Notices';
import { NowLabel } from './parts/NowLabel';
import { NodeTempFooter } from './parts/TempFooter';
import { useNodeGpuGap } from './parts/useGpuGap';
import { EnergyPanel, PowerPanel } from './partsC/Power';
import { SensorGroupPanel } from './partsC/SensorGroup';
import { buildGroups, hottest, type SensorGroup } from './partsC/thermal';
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
  // Board sensors come from hwmon; the GPU's temperature, power and energy come from NVML and still read without it.
  const sensorGap = notReported(info, 'temp');

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
      <CollectorErrors nodeId={nodeId} only={['gpu', 'thermal']} />
      <ThermalHeader nodeId={nodeId} groups={groups} stale={stale} updatedAt={updatedAt} sensorGap={sensorGap} />
      <div className="tp-groups">
        {groups.map((g) => (
          <SensorGroupPanel key={g.id} nodeId={nodeId} group={g} info={info} range={range} history={history} stale={stale} />
        ))}
        {sensorGap ? (
          <Panel title="Board sensors" subtitle="Temperatures outside the GPU, read from hwmon">
            <EmptyState icon={CircleSlash} title={sensorGap.label} compact>{sensorGap.detail}</EmptyState>
          </Panel>
        ) : null}
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
function ThermalHeader({ nodeId, groups, stale, updatedAt, sensorGap }: { nodeId: string; groups: SensorGroup[]; stale: boolean; updatedAt: number | null; sensorGap: NotReported | null }) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const hot = useLiveDerived(nodeId, useCallback((st: LiveStore) => hottest(groups, (k) => st.latestValue(nodeId, k)), [groups, nodeId]), sameHot);
  const tempKey = nodeGpuKey(info, 'temp_c');
  const powerKey = nodeGpuKey(info, 'power_w');
  const gpuTemp = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, tempKey), [nodeId, tempKey]), Object.is);
  const gpuPower = useLiveDerived(nodeId, useCallback((st: LiveStore) => st.latestValue(nodeId, powerKey), [nodeId, powerKey]), Object.is);
  const anySensor = groups.some((g) => g.sensors.some((s) => !notReported(info, s.key)));
  const tempGap = useNodeGpuGap(nodeId, 'temp_c');
  const powerGap = useNodeGpuGap(nodeId, 'power_w');
  const energyGap = useLatest(nodeId, useCallback((s: Sample | null) => gpuEnergyGap(info, s), [info]), sameGap);

  return (
    <Panel label={`${nodeId} thermals and power summary`} className="tp-head">
      <NowLabel />
      <div className="nstats">
        <Stat label="Hottest sensor" value={hot?.c} format={tempParts} stale={stale} updatedAt={updatedAt} unsupported={anySensor ? null : sensorGap} reporting={!stale} footer={hot?.label} />
        <Stat
          label="GPU temperature"
          value={gpuTemp}
          format={tempParts}
          stale={stale}
          updatedAt={updatedAt}
          unsupported={tempGap}
          reporting={!stale}
          footer={gpuTemp == null ? undefined : <NodeTempFooter nodeId={nodeId} oneGpuTemp={gpuTemp} />}
        />
        <Stat label="GPU power" value={gpuPower} format={wattsParts} stale={stale} updatedAt={updatedAt} unsupported={powerGap} reporting={!stale} footer="GPU rail only" />
        <EnergyToday nodeId={nodeId} gap={energyGap} />
        <Stat label="Fans" value={null} format={wattsParts} unsupported={notReported(info, 'fan')} reporting />
      </div>
    </Panel>
  );
}

function gpuEnergyGap(info: NodeInfo | null | undefined, s: Sample | null): NotReported | null {
  const declared = gpuSetGap(info, 'energy_j', 'every');
  if (declared) return declared;
  const indexes = gpuIndexes(info);
  for (const i of indexes) {
    const gap = notResponding(info, s, i);
    if (gap) return gap;
  }
  return null;
}

/** kWh in, always shown in kWh (3 significant figures), like the Overview's "Today": one unit for a figure that
 *  grows all day, so it never seems to drop when it crosses 1 kWh. */
const kwhParts: Formatter = (kwh) => {
  const t = formatKwh(kwh * 3.6e6).split(/\s/);
  return { value: t[0] ?? '', unit: t[1] ?? 'kWh' };
};

function EnergyToday({ nodeId, gap }: { nodeId: string; gap: NotReported | null }) {
  const settings = useCluster((s) => s.cluster?.settings);
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const today = useSpanEnergy(nodeId, energyKeys(info), 'today');
  const j = today.state === 'ready' ? today.data : null;
  const cost = j == null || !settings ? undefined : `${formatEnergyCost(j, settings.energy_rate_per_kwh, settings.currency)} so far`;
  if (today.state === 'loading' && !gap) {
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
      unsupported={gap}
      reporting={today.state === 'ready'}
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
