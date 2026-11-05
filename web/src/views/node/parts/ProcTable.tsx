import { Box, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Table, type Column } from '../../../design/components/Table';
import { formatBytes } from '../../../lib/format';
import { memoryLayout } from '../../../lib/memoryLayout';
import type { ProcSample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { CannotTellGpuProcesses, useGpuProcessesGap } from '../partsC/gpuProcesses';
import { Badge, ProcTable as ProcessTable } from '../partsC/ProcTable';
import { shortCmd, sortProcs, type ProcSort } from '../partsC/procs';
import '../partsC/partsC.css';
import { RowsSkeleton } from '../../placeholders';
import { useFreshness } from './hooks';
import { procs as selectProcs } from './selectors';

const dash = <span className="nproc__none" aria-label="none">—</span>;

const nameCol: Column<ProcSample> = {
  id: 'name',
  header: 'Process',
  sortValue: (p) => p.name.toLowerCase(),
  render: (p) => (
    // The Processes tab's name cell: one look for the same row on every tab.
    <span className="procs__name">
      <span className="procs__proc">
        {p.name}
        <span className="procs__pid num">{p.pid}</span>
      </span>
      <span className="procs__cmd" title={p.cmdline}>{shortCmd(p.cmdline)}</span>
    </span>
  ),
};
const modelCol: Column<ProcSample> = {
  id: 'model',
  header: 'Model',
  sortValue: (p) => p.model?.toLowerCase() ?? null,
  render: (p) => (p.model ? <Badge icon={<Sparkles />} text={p.model} label="Model" model /> : dash),
};
const containerCol: Column<ProcSample> = {
  id: 'container',
  header: 'Container',
  sortValue: (p) => p.container?.toLowerCase() ?? null,
  render: (p) => (p.container ? <Badge icon={<Box />} text={p.container} label="Container" /> : dash),
};
const gpuMemCol: Column<ProcSample> = {
  id: 'gpu_mem',
  header: 'GPU memory',
  align: 'end',
  sortValue: (p) => p.gpu_mem,
  render: (p) => (p.gpu_mem == null ? dash : formatBytes(p.gpu_mem)),
};
const rssCol: Column<ProcSample> = {
  id: 'rss',
  header: 'Resident (RSS)',
  align: 'end',
  sortValue: (p) => p.rss,
  render: (p) => formatBytes(p.rss),
};
const totalCol: Column<ProcSample> = {
  id: 'total',
  header: 'Total',
  align: 'end',
  sortValue: (p) => p.rss + (p.gpu_mem ?? 0),
  render: (p) => <strong>{formatBytes(p.rss + (p.gpu_mem ?? 0))}</strong>,
};

const MEM_COLUMNS = [nameCol, containerCol, modelCol, totalCol, gpuMemCol, rssCol];
const SYSTEM_COLUMNS = [nameCol, containerCol, modelCol, rssCol, gpuMemCol];

/** Processes holding GPU memory, largest first. */
export const gpuProcs = (list: readonly ProcSample[]) => list.filter((p) => p.gpu_mem != null && p.gpu_mem > 0);

/** Top memory consumers, largest first, at most `n`: resident set plus GPU allocations where the GPU keeps its
 *  memory in system RAM (unified memory), else resident set only. */
export function topMemoryProcs(list: readonly ProcSample[], sharesRam: boolean, n = 10): ProcSample[] {
  const size = (p: ProcSample) => p.rss + (sharesRam ? (p.gpu_mem ?? 0) : 0);
  return [...list].sort((a, b) => size(b) - size(a)).slice(0, n);
}

export function ProcTable({ nodeId, mode }: { nodeId: string; mode: 'gpu' | 'memory' }) {
  const list = useLatest(nodeId, selectProcs);
  const { stale } = useFreshness(nodeId);
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const [sort, setSort] = useState<ProcSort>({ id: 'gpu_mem', dir: 'desc' });
  const { gap, from } = useGpuProcessesGap(nodeId);
  if (!list) {
    // Processes refresh every few seconds; until the first list arrives, hold the table's shape.
    return stale ? <p className="nmuted ntable-pad">No process list was received before {nodeId} stopped reporting.</p> : <div className="ntable-pad"><RowsSkeleton rows={4} /></div>;
  }
  if (mode === 'gpu') {
    // The Processes tab's table, filtered to GPU users: one look for the same row on every tab.
    return (
      <div className={stale ? 'is-stale' : undefined}>
        <ProcessTable
          rows={sortProcs(gpuProcs(list), sort)}
          sort={sort}
          onSort={setSort}
          info={info}
          empty={<span className="nmuted">{gap ? <CannotTellGpuProcesses nodeId={nodeId} gap={gap} /> : `No processes are using the GPU right now${from ? ` (${from})` : ''}.`}</span>}
        />
      </div>
    );
  }
  const { sharesRam } = memoryLayout(info);
  const rows = topMemoryProcs(list, sharesRam);
  return (
    <div className={stale ? 'ntable--stale' : undefined}>
      <Table
        caption={`Top memory consumers on ${nodeId}`}
        columns={sharesRam ? MEM_COLUMNS : SYSTEM_COLUMNS}
        rows={rows}
        rowKey={(p) => p.pid}
        initialSort={{ id: sharesRam ? 'total' : 'rss', dir: 'desc' }}
        empty="No processes reported."
      />
    </div>
  );
}
