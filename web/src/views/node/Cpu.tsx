// CPU tab: how busy the CPU is, split by core type, and which cores carry the load.
import { useCallback, useMemo } from 'react';
import { TimeSeriesChart } from '../../charts/TimeSeriesChart';
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { percentParts, tempParts } from '../../lib/format';
import type { NodeInfo } from '../../lib/types';
import { notReported } from '../../lib/capabilities';
import { ChartPanelSkeleton, StatSkeleton } from '../placeholders';
import { CoreGrid } from './partsB/CoreGrid';
import { coreLayout, type CoreGroup, type CoreLayout } from '../../lib/cores';
import { groupSize, loadFormatter, meanUtil, utilSeries } from './partsB/cores';
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
  if (!info || !hasData) return <CpuSkeleton split={info ? coreLayout(info.cores, info.cpu_model).split : true} />;
  return <CpuView node={nodeId} info={info} />;
}

function CpuView({ node, info }: { node: string; info: NodeInfo }) {
  const layout = useMemo(() => coreLayout(info.cores, info.cpu_model), [info.cores, info.cpu_model]);
  const perf = layout.groups.find((g) => g.kind === 'performance');
  const eff = layout.groups.find((g) => g.kind === 'efficiency');
  const n = info.cores.length;
  const stale = useNodeStale(node);
  const pct = useCallback((v: number) => `${v.toFixed(0)}%`, []);
  const loadParts = useMemo(() => loadFormatter(n), [n]);
  const psiUnsupported = notReported(info, 'cpu.psi_some');

  return (
    <div className="view view--flush nb">
      <Panel label="CPU summary">
        <NowLabel />
        <div className="nstats">
          <LiveStat node={node} label="CPU utilisation" format={percentParts} metric="cpu.util" unsupported={notReported(info, 'cpu.util')} footer={`Average of ${n} cores`} />
          {perf ? (
            <LiveStat
              node={node}
              label="Performance cores"
              format={percentParts}
              derive={(get) => get('cpu.perf_util') ?? meanUtil(perf.cores.map((c) => get(`cpu.core${c.id}.util`)))}
              footer={groupSize(perf)}
            />
          ) : null}
          {eff ? (
            <LiveStat
              node={node}
              label="Efficiency cores"
              format={percentParts}
              derive={(get) => get('cpu.eff_util') ?? meanUtil(eff.cores.map((c) => get(`cpu.core${c.id}.util`)))}
              footer={groupSize(eff)}
            />
          ) : null}
          <LiveStat node={node} label="Load average · 1 min" format={loadParts} metric="cpu.load1" unsupported={notReported(info, 'cpu.load1')} footer={<LoadFooter node={node} />} />
          <LiveStat
            node={node}
            label="CPU pressure"
            format={percentParts}
            metric="cpu.psi_some"
            unsupported={psiUnsupported}
            footer="Waiting for a CPU · 10 s avg"
          />
          <LiveStat node={node} label="CPU temperature" format={tempParts} metric="cpu.temp" unsupported={notReported(info, 'cpu.temp')} footer="Hottest CPU sensor" />
        </div>
      </Panel>

      <Panel title="Per-core utilisation" subtitle={heatmapSubtitle(layout)} actions={stale ? <StaleSince node={node} /> : undefined}>
        <div className={`nb-heatmap-wrap${stale ? ' is-stale' : ''}`}>
          <RangeHeatmap node={node} cores={info.cores} cpuModel={info.cpu_model} />
        </div>
      </Panel>

      <div className="grid nb-grid-cpu">
        <Panel title="Cores now" subtitle="Utilisation and current clock">
          <div className={stale ? 'is-stale' : undefined}>
            <CoreGrid node={node} layout={layout} />
          </div>
        </Panel>
        <Panel title={layout.split ? 'Utilisation by core type' : 'Utilisation'} subtitle={layout.split ? 'Average across the cores of each kind' : 'Average across all cores'}>
          <TimeSeriesChart node={node} title={layout.split ? 'CPU utilisation by core type' : 'CPU utilisation'} series={utilSeries(layout, { designs: true })} format={pct} yMin={0} yMax={100} height={282} />
        </Panel>
      </div>
    </div>
  );
}

function heatmapSubtitle({ product, split, groups }: CoreLayout): string {
  const facts = (g: CoreGroup) => [g.design, g.maxMhz ? `up to ${(g.maxMhz / 1000).toFixed(2)} GHz` : null].filter(Boolean).join(', ');
  const parts = groups.map((g) => (facts(g) ? `${g.label.toLowerCase()} (${facts(g)})` : g.label.toLowerCase()));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} above ${parts[parts.length - 1] ?? ''}` : (parts[0] ?? 'cores');
  const rows = 'One row per core, coloured by utilisation (scale below).';
  if (!product) return `${list.charAt(0).toUpperCase()}${list.slice(1)}. ${rows}`;
  if (split) return `${product}: ${list}. ${rows}`;
  return `${[product, ...groups.map(facts)].filter(Boolean).join(', ')}. ${rows}`;
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

function CpuSkeleton({ split }: { split: boolean }) {
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
        <ChartPanelSkeleton title={split ? 'Utilisation by core type' : 'Utilisation'} height={270} />
      </div>
    </div>
  );
}
