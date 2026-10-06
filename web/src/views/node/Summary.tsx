import { useCallback, useMemo } from 'react';
import { paths } from '../../app/routes';
import { BYTE_INCRS } from '../../charts/theme';
import { TimeSeriesChart, unsupportedReason, type SeriesSpec } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { bitrateParts, bytesParts, formatBitrate, formatBytes, formatPercent, formatWatts, percentParts, tempParts, wattsParts } from '../../lib/format';
import type { Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { LiveStat } from './parts/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { TabLink } from './parts/TabLink';
import { TempFooter } from './parts/TempFooter';
import { CollectorErrors, ThrottleNotice } from './parts/Notices';
import { cpuUtil, cx7Rails, gpuPower, gpuTemp, gpuUtil, memAvailable, NO_LINK_REASON, railShort, rootUsedPct, sumNet } from './parts/selectors';
import type { NodeTabProps } from './tabs';

const pct = (n: number) => formatPercent(n);
const CPU_SERIES: readonly SeriesSpec[] = [
  { key: 'cpu.perf_util', label: 'Performance' },
  { key: 'cpu.eff_util', label: 'Efficiency' },
];
const UTIL_SERIES: readonly SeriesSpec[] = [{ key: 'gpu0.util', label: 'Utilisation' }];
const POWER_SERIES: readonly SeriesSpec[] = [{ key: 'gpu0.power_w', label: 'GPU power' }];
const MEM_SERIES: readonly SeriesSpec[] = [
  { key: 'mem.used', label: 'Used' },
  { key: 'mem.gpu', label: 'GPU-allocated' },
];

export default function Summary({ nodeId }: NodeTabProps) {
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const gpu = info?.gpus[0];
  const memTotal = info?.mem_total ?? null;
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
  const powerUnsupported = unsupportedReason(info, 'gpu0.power_w');

  return (
    <div className="view nsum">
      <Panel label="At a glance">
        <NowLabel />
        <div className="nstats nstats--8">
          <LiveStat nodeId={nodeId} label="GPU utilisation" select={gpuUtil} metric="gpu0.util" format={percentParts} href={paths.node(nodeId, 'gpu')} footer={() => 'Time the GPU was busy'} />
          <LiveStat
            nodeId={nodeId}
            label="GPU temperature"
            select={gpuTemp}
            metric="gpu0.temp_c"
            format={tempParts}
            href={paths.node(nodeId, 'gpu')}
            footer={(v) => <TempFooter temp={v} slowdown={gpu?.temp_slowdown_c ?? null} shutdown={gpu?.temp_shutdown_c ?? null} />}
          />
          <LiveStat nodeId={nodeId} label="GPU power" select={gpuPower} metric="gpu0.power_w" format={wattsParts} unsupported={powerUnsupported} href={paths.node(nodeId, 'gpu')} footer={() => 'GPU rail only'} />
          <LiveStat
            nodeId={nodeId}
            label="Memory available"
            select={memAvailable}
            metric="mem.available"
            format={bytesParts}
            href={paths.node(nodeId, 'memory')}
            footer={() => (memTotal ? `of ${formatBytes(memTotal)} unified` : null)}
          />
          <LiveStat nodeId={nodeId} label="CPU utilisation" select={cpuUtil} metric="cpu.util" format={percentParts} href={paths.node(nodeId, 'cpu')} footer={() => (info ? `${info.cores.length} cores` : null)} />
          {(['in', 'out'] as const).map((dir) => (
            <LiveStat
              key={dir}
              nodeId={nodeId}
              label={`CX7 ${dir}`}
              select={dir === 'in' ? cx7Rx : cx7Tx}
              metric={dir === 'in' ? rxKeys : txKeys}
              format={bitrateParts}
              href={paths.node(nodeId, 'network')}
              unsupported={info && !rails.length ? NO_LINK_REASON : null}
              unsupportedLabel="No direct link"
              footer={() => (rails.length ? `${rails.length} cabled ${rails.length === 1 ? 'rail' : 'rails'}` : null)}
            />
          ))}
          <LiveStat nodeId={nodeId} label="Root disk used" select={rootUsedPct} metric="fs.root.used_pct" format={percentParts} href={paths.node(nodeId, 'storage')} footer={() => 'Filesystem /'} />
        </div>
      </Panel>

      <ThrottleNotice nodeId={nodeId} />
      <CollectorErrors nodeId={nodeId} link />

      <div className="nsum__charts">
        <Panel title="GPU utilisation" actions={<TabLink nodeId={nodeId} tab="gpu">GPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="GPU utilisation" series={UTIL_SERIES} format={pct} yMin={0} yMax={100} height={168} />
        </Panel>
        <Panel title="GPU power" subtitle="GPU rail only — not whole-system power" actions={<TabLink nodeId={nodeId} tab="gpu">GPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="GPU power" series={POWER_SERIES} format={formatWatts} yMin={0} height={168} />
        </Panel>
        <Panel title="Unified memory" actions={<TabLink nodeId={nodeId} tab="memory">Memory</TabLink>}>
          <TimeSeriesChart node={nodeId} title="Unified memory used" series={MEM_SERIES} format={formatBytes} yMin={0} yMax={memTotal ?? undefined} yIncrs={BYTE_INCRS} height={168} />
        </Panel>
        <Panel title="CPU utilisation" subtitle="By core type" actions={<TabLink nodeId={nodeId} tab="cpu">CPU</TabLink>}>
          <TimeSeriesChart node={nodeId} title="CPU utilisation by core type" series={CPU_SERIES} format={pct} yMin={0} yMax={100} height={168} />
        </Panel>
        <Panel title="ConnectX-7 throughput" subtitle="Inter-node traffic, both directions" className="nsum__wide" actions={<TabLink nodeId={nodeId} tab="network">Network</TabLink>}>
          {cx7Series.length ? (
            <TimeSeriesChart node={nodeId} title="ConnectX-7 throughput" series={cx7Series} format={formatBitrate} yMin={0} height={168} />
          ) : (
            <p className="nmuted">No ConnectX-7 link is cabled on {nodeId}.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
