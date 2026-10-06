import { useState } from 'react';
import { Table, type Column } from '../../../design/components/Table';
import { formatBytes } from '../../../lib/format';
import type { ProcSample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { ProcTable as ProcessTable } from '../partsC/ProcTable';
import { sortProcs, type ProcSort } from '../partsC/procs';
import '../partsC/partsC.css';
import { RowsSkeleton } from '../../placeholders';
import { useFreshness } from './hooks';
import { procs as selectProcs } from './selectors';

const dash = <span className="nproc__none" aria-label="none">—</span>;

/** Last path part of the executable plus its arguments, for the second line under the process name. */
const cmdTail = (p: ProcSample) => p.cmdline.replace(/^\S*\//, '');

const nameCol: Column<ProcSample> = {
  id: 'name',
  header: 'Process',
  sortValue: (p) => p.name.toLowerCase(),
  render: (p) => (
    <span className="nproc__name">
      <span>
        {p.name} <span className="t-tertiary num">{p.pid}</span>
      </span>
      <span className="nproc__cmd" title={p.cmdline}>{cmdTail(p)}</span>
    </span>
  ),
};
const modelCol: Column<ProcSample> = {
  id: 'model',
  header: 'Model',
  sortValue: (p) => p.model?.toLowerCase() ?? null,
  render: (p) => (p.model ? <span className="nproc__tag" title={p.model}>{p.model}</span> : dash),
};
const containerCol: Column<ProcSample> = {
  id: 'container',
  header: 'Container',
  sortValue: (p) => p.container?.toLowerCase() ?? null,
  render: (p) => (p.container ? <span className="nproc__tag" title={p.container}>{p.container}</span> : dash),
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

const MEM_COLUMNS = [nameCol, modelCol, containerCol, totalCol, gpuMemCol, rssCol];

/** Processes holding GPU memory, largest first. */
export const gpuProcs = (list: readonly ProcSample[]) => list.filter((p) => p.gpu_mem != null && p.gpu_mem > 0);

/** Top memory consumers: resident set plus GPU allocations (unified memory), largest first, at most `n`. */
export function topMemoryProcs(list: readonly ProcSample[], n = 10): ProcSample[] {
  return [...list].sort((a, b) => b.rss + (b.gpu_mem ?? 0) - (a.rss + (a.gpu_mem ?? 0))).slice(0, n);
}

export function ProcTable({ nodeId, mode }: { nodeId: string; mode: 'gpu' | 'memory' }) {
  const list = useLatest(nodeId, selectProcs);
  const { stale } = useFreshness(nodeId);
  const memTotal = useCluster((s) => s.nodes[nodeId]?.info?.mem_total ?? null);
  const [sort, setSort] = useState<ProcSort>({ id: 'gpu_mem', dir: 'desc' });
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
          memTotal={memTotal}
          empty={<span className="nmuted">No processes are using the GPU right now.</span>}
        />
      </div>
    );
  }
  const rows = topMemoryProcs(list);
  return (
    <div className={stale ? 'ntable--stale' : undefined}>
      <Table
        caption={`Top memory consumers on ${nodeId}`}
        columns={MEM_COLUMNS}
        rows={rows}
        rowKey={(p) => p.pid}
        initialSort={{ id: 'total', dir: 'desc' }}
        empty="No processes reported."
      />
    </div>
  );
}
