import { useCallback, useMemo } from 'react';
import { paths } from '../../app/routes';
import { BYTE_INCRS } from '../../charts/theme';
import { TimeSeriesChart, type SeriesSpec } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { Unsupported } from '../../design/components/Unsupported';
import { bitrateParts, bytesParts, formatBitrate, formatBytes, formatPercent, formatWatts, percentParts, tempParts, wattsParts } from '../../lib/format';
import { interconnectGap, notReported } from '../../lib/capabilities';
import { nodeGpuKey } from '../../lib/gpu';
import { memoryLayout } from '../../lib/memoryLayout';
import type { Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { LiveStat } from './parts/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { TabLink } from './parts/TabLink';
import { NodeTempFooter } from './parts/TempFooter';
import { useNodeGpuGap } from './parts/useGpuGap';
import { useTotalFrom } from '../shared/totalGap';
import { CollectorErrors, ThrottleNotice } from './parts/Notices';
import { cpuUtil, cx7Rails, memAvailable, NO_LINK_REASON, nodeGpuSelector, railShort, rootUsedPct, sumNet } from './parts/selectors';
import type { NodeTabProps } from './tabs';

const pct = (n: number) => formatPercent(n);
const CPU_SERIES: readonly SeriesSpec[] = [
  { key: 'cpu.perf_util', label: 'Performance' },
  { key: 'cpu.eff_util', label: 'Efficiency' },
];
const MEM_SERIES: readonly SeriesSpec[] = [
  { key: 'mem.used', label: 'Used' },
  { key: 'mem.gpu', label: 'GPU-allocated' },
];
const SYSTEM_SERIES = MEM_SERIES.filter((s) => s.key !== 'mem.gpu');

export default function Summary({ nodeId }: NodeTabProps) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const utilKey = nodeGpuKey(info, 'util');
  const tempKey = nodeGpuKey(info, 'temp_c');
  const powerKey = nodeGpuKey(info, 'power_w');
  const utilFrom = useTotalFrom(nodeId, 'util');
  const utilSeries = useMemo<SeriesSpec[]>(() => [{ key: utilKey, label: utilFrom ? `Utilisation (${utilFrom})` : 'Utilisation' }], [utilKey, utilFrom]);
  const powerSeries = useMemo<SeriesSpec[]>(() => [{ key: powerKey, label: 'GPU power' }], [powerKey]);
  const memTotal = info?.mem_total ?? null;
  const layout = useMemo(() => memoryLayout(info), [info]);
  const unified = layout.name === 'Unified memory';
  const rails = useMemo(() => cx7Rails(info), [info]);
  const railNames = useMemo(() => rails.map((r) => r.name), [rails]);
  const railId = railNames.join(',');
  // Stable per rail set, so the subscriptions only change when the interfaces do.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cx7Rx = useCallback((s: Sample | null) => sumNet(s, railNames, 'rx_bps'), [railId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cx7Tx = useCallback((s: Sample | null) => sumNet(s, railNames, 'tx_bps'), [railId]);
  const rxKeys = useMemo(() => railNames.map((n) => `net.${n}.rx_bps`), [railNames]);
  const txKeys = useMemo(() => railNames.map((n) => `net.${n}.tx_bps`), [railNames]);
  const cx7Series = useMemo<SeriesSpec[]>(
    () => rails.flatMap((r) => [
      { key: `net.${r.name}.rx_bps`, label: `${railShort(r.label)} in` },
      { key: `net.${r.name}.tx_bps`, label: `${railShort(r.label)} out` },
    ]),
    [rails],
  );
  const utilGap = useNodeGpuGap(nodeId, 'util');
  const tempGap = useNodeGpuGap(nodeId, 'temp_c');
  const powerGap = useNodeGpuGap(nodeId, 'power_w');
  const netGap = interconnectGap(info);

  return (
    <div className="view nsum">
      <Panel label="At a glance">
        <NowLabel />
        <div className="nstats nstats--8">
          <LiveStat nodeId={nodeId} label="GPU utilisation" select={nodeGpuSelector(info, 'util')} metric={utilKey} format={percentParts} unsupported={utilGap} href={paths.node(nodeId, 'gpu')} footer={() => `Time the GPU was busy${utilFrom ? ` · ${utilFrom}` : ''}`} />
          <LiveStat
            nodeId={nodeId}
            label="GPU temperature"
            select={nodeGpuSelector(info, 'temp_c')}
            metric={tempKey}
            format={tempParts}
            unsupported={tempGap}
            href={paths.node(nodeId, 'gpu')}
            footer={(v) => <NodeTempFooter nodeId={nodeId} oneGpuTemp={v} />}
          />
          <LiveStat nodeId={nodeId} label="GPU power" select={nodeGpuSelector(info, 'power_w')} metric={powerKey} format={wattsParts} unsupported={powerGap} href={paths.node(nodeId, 'gpu')} footer={() => 'GPU rail only'} />
          <LiveStat
            nodeId={nodeId}
            label="Memory available"
            select={memAvailable}
            metric="mem.available"
            format={bytesParts}
            unsupported={notReported(info, 'mem.available')}
            href={paths.node(nodeId, 'memory')}
            footer={() => (memTotal ? `of ${formatBytes(memTotal)} ${unified ? 'unified' : 'system'}` : null)}
          />
          <LiveStat nodeId={nodeId} label="CPU utilisation" select={cpuUtil} metric="cpu.util" format={percentParts} unsupported={notReported(info, 'cpu.util')} href={paths.node(nodeId, 'cpu')} footer={() => (info ? `${info.cores.length} cores` : null)} />
          {(['in', 'out'] as const).map((dir) => (
            <LiveStat
              key={dir}
              nodeId={nodeId}
              label={`ConnectX-7 ${dir}`}
              select={dir === 'in' ? cx7Rx : cx7Tx}
              metric={dir === 'in' ? rxKeys : txKeys}
              format={bitrateParts}
              href={paths.node(nodeId, 'network')}
              unsupported={netGap ?? (info && !rails.length ? { kind: 'hardware', label: 'No direct link', detail: NO_LINK_REASON } : null)}
              footer={() => (rails.length ? `${rails.length} cabled ${rails.length === 1 ? 'rail' : 'rails'}` : null)}
            />
          ))}
          <LiveStat nodeId={nodeId} label="Root disk used" select={rootUsedPct} metric="fs.root.used_pct" format={percentParts} unsupported={notReported(info, 'fs.root.used_pct')} href={paths.node(nodeId, 'storage')} footer={() => 'Filesystem /'} />
        </div>
      </Panel>

      <ThrottleNotice nodeId={nodeId} />
      <CollectorErrors nodeId={nodeId} link />

      <div className="nsum__charts">
        <Panel title="GPU utilisation" subtitle="Share of time the GPU was busy" actions={<TabLink nodeId={nodeId} tab="gpu">GPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="GPU utilisation" series={utilSeries} format={pct} yMin={0} yMax={100} height={168} />
        </Panel>
        <Panel title="GPU power" subtitle="GPU rail only — not whole-system power" actions={<TabLink nodeId={nodeId} tab="gpu">GPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="GPU power" series={powerSeries} format={formatWatts} yMin={0} height={168} />
        </Panel>
        <Panel title={layout.name} subtitle={unified ? 'Shared by CPU and GPU' : layout.sharesRam ? 'Host RAM, with the GPU memory held in it' : 'Host RAM; VRAM is on the Memory tab'} actions={<TabLink nodeId={nodeId} tab="memory">Memory</TabLink>}>
          <TimeSeriesChart node={nodeId} title={`${layout.name} used`} series={layout.sharesRam ? MEM_SERIES : SYSTEM_SERIES} format={formatBytes} yMin={0} yMax={memTotal ?? undefined} yIncrs={BYTE_INCRS} height={168} />
        </Panel>
        <Panel title="CPU utilisation" subtitle="By core type" actions={<TabLink nodeId={nodeId} tab="cpu">CPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="CPU utilisation by core type" series={CPU_SERIES} format={pct} yMin={0} yMax={100} height={168} />
        </Panel>
        <Panel title="ConnectX-7 throughput" subtitle="Inter-node traffic, both directions" className="nsum__wide" actions={<TabLink nodeId={nodeId} tab="network">Network</TabLink>}>
          {netGap ? (
            <Unsupported gap={netGap} block />
          ) : cx7Series.length ? (
            <TimeSeriesChart node={nodeId} title="ConnectX-7 throughput" series={cx7Series} format={formatBitrate} yMin={0} height={168} />
          ) : (
            <p className="nmuted">No ConnectX-7 link is cabled on {nodeId}.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
