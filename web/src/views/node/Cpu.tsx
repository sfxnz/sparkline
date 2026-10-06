// CPU tab: how busy the CPU is, split by core type, and which cores carry the load.
import { useCallback, useMemo } from 'react';
import { TimeSeriesChart, unsupportedReason } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { percentParts } from '../../lib/format';
import type { NodeInfo } from '../../lib/types';
import { ChartPanelSkeleton, StatSkeleton } from '../placeholders';
import { CoreGrid } from './partsB/CoreGrid';
import { groupCores, loadFormatter, meanUtil } from './partsB/cores';
import { useNodeStale } from '../shared/live';
import { useDerived, useHasData, useNodeInfo } from './partsB/hooks';
import { LiveStat } from './partsB/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { RangeHeatmap } from './partsB/RangeHeatmap';
import { StaleSince } from './partsB/StaleSince';
import './partsB/partsB.css';

export default function Cpu({ nodeId }: { nodeId: string }) {
  const info = useNodeInfo(nodeId);
  const hasData = useHasData(nodeId);
  if (!info || !hasData) return <CpuSkeleton />;
  return <CpuView node={nodeId} info={info} />;
}

function CpuView({ node, info }: { node: string; info: NodeInfo }) {
  const groups = groupCores(info.cores);
  const perf = groups.find((g) => g.kind === 'performance');
  const eff = groups.find((g) => g.kind === 'efficiency');
  const n = info.cores.length;
  const stale = useNodeStale(node);
  const pct = useCallback((v: number) => `${v.toFixed(0)}%`, []);
  const loadParts = useMemo(() => loadFormatter(n), [n]);
  const psiUnsupported = unsupportedReason(info, 'cpu.psi_some');
  const cpuTempUnsupported = unsupportedReason(info, 'cpu.temp');

  const typeSeries = [
    ...(perf ? [{ key: 'cpu.perf_util', label: perf.model ? `Performance (${perf.model})` : 'Performance' }] : []),
    ...(eff ? [{ key: 'cpu.eff_util', label: eff.model ? `Efficiency (${eff.model})` : 'Efficiency' }] : []),
    ...(!perf && !eff ? [{ key: 'cpu.util', label: 'All cores' }] : []),
  ];

  return (
    <div className="view view--flush nb">
      <Panel label="CPU summary">
        <NowLabel />
        <div className="nstats">
          <LiveStat node={node} label="CPU utilisation" format={percentParts} metric="cpu.util" footer={`Average of ${n} cores`} />
          {perf ? (
            <LiveStat
              node={node}
              label="Performance cores"
              format={percentParts}
              derive={(get) => get('cpu.perf_util') ?? meanUtil(perf.cores.map((c) => get(`cpu.core${c.id}.util`)))}
              footer={`${perf.cores.length} × ${perf.model ?? 'cores'}`}
            />
          ) : null}
          {eff ? (
            <LiveStat
              node={node}
              label="Efficiency cores"
              format={percentParts}
              derive={(get) => get('cpu.eff_util') ?? meanUtil(eff.cores.map((c) => get(`cpu.core${c.id}.util`)))}
              footer={`${eff.cores.length} × ${eff.model ?? 'cores'}`}
            />
          ) : null}
          <LiveStat node={node} label="Load average · 1 min" format={loadParts} metric="cpu.load1" footer={<LoadFooter node={node} />} />
          <LiveStat
            node={node}
            label="CPU pressure"
            format={percentParts}
            metric="cpu.psi_some"
            unsupported={psiUnsupported}
            footer="Waiting for a CPU · 10 s avg"
          />
          {/* Only when the agent says it is not reported (GB10): never a stat that would just show a dash. */}
          {cpuTempUnsupported ? <LiveStat node={node} label="CPU temperature" format={percentParts} unsupported={cpuTempUnsupported} /> : null}
        </div>
      </Panel>

      <Panel title="Per-core utilisation" subtitle={heatmapSubtitle(groups)} actions={stale ? <StaleSince node={node} /> : undefined}>
        <div className={`nb-heatmap-wrap${stale ? ' is-stale' : ''}`}>
          <RangeHeatmap node={node} cores={info.cores} />
        </div>
      </Panel>

      <div className="grid nb-grid-cpu">
        <Panel title="Cores now" subtitle="Utilisation and current clock">
          <div className={stale ? 'is-stale' : undefined}>
            <CoreGrid node={node} cores={info.cores} />
          </div>
        </Panel>
        <Panel title="Utilisation by core type">
          <TimeSeriesChart node={node} title="CPU utilisation by core type" series={typeSeries} format={pct} yMin={0} yMax={100} height={282} />
        </Panel>
      </div>
    </div>
  );
}

/** "Performance cores (Cortex-X925, up to 3.90 GHz) above efficiency cores (…). Brighter is busier." */
function heatmapSubtitle(groups: ReturnType<typeof groupCores>): string {
  const parts = groups.map((g) => `${g.name.toLowerCase()} cores${g.model ? ` (${g.model}${g.maxMhz ? `, up to ${(g.maxMhz / 1000).toFixed(2)} GHz` : ''})` : ''}`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} above ${parts[parts.length - 1] ?? ''}` : (parts[0] ?? 'cores');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. One row per core; brighter is busier.`;
}

/** "5 min 3.10 · 15 min 2.95" (from the latest sample: the 5/15-minute loads are not kept in history). */
function LoadFooter({ node }: { node: string }) {
  const text = useDerived(node, (get) => {
    const l5 = get('cpu.load5');
    const l15 = get('cpu.load15');
    return l5 === null || l15 === null ? '' : `5 min ${l5.toFixed(2)} · 15 min ${l15.toFixed(2)}`;
  });
  return <span className="num">{text}</span>;
}

function CpuSkeleton() {
  return (
    <div className="view view--flush nb" aria-busy="true">
      <Panel label="CPU summary" busy>
        <div className="nstats">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>
      </Panel>
      <Panel title="Per-core utilisation" busy>
        <Skeleton height={290} radius={6} />
      </Panel>
      <div className="grid nb-grid-cpu">
        <ChartPanelSkeleton title="Cores now" height={260} />
        <ChartPanelSkeleton title="Utilisation by core type" height={270} />
      </div>
    </div>
  );
}
