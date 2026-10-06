// Processes: the node's top consumers from the latest process refresh (every ~5 s). Between refreshes the
// LiveStore keeps the last list, so the table never flashes; sort and filter persist for the browser session.
import { ListX, Search, SearchX, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '../../design/components/Button';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { formatBytes } from '../../lib/format';
import type { ProcSample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { liveStore, useLatest } from '../../store/live';
import { RowsSkeleton } from '../placeholders';
import { useNodeStale } from '../shared/live';
import { ProcTable } from './partsC/ProcTable';
import { filterProcs, loadView, saveView, sortProcs, type ProcView } from './partsC/procs';
import { UpdatedAgo } from './partsC/UpdatedAgo';
import './partsC/partsC.css';

/** When the list was collected: the agent's procs_ts, or (older agents) when the page first saw that list. */
const seenAt = new WeakMap<readonly ProcSample[], number>();
function listTs(node: string, procs: readonly ProcSample[] | null): number | null {
  if (!procs) return null;
  const latest = liveStore.latest(node);
  if (latest?.procs_ts != null) return latest.procs_ts;
  let t = seenAt.get(procs);
  if (t === undefined) {
    t = latest?.ts ?? Date.now() / 1000;
    seenAt.set(procs, t);
  }
  return t;
}

export default function Processes({ nodeId }: { nodeId: string }) {
  // Same array on ticks without a refresh, so this re-renders only when the list changes (~every 5 s).
  const procs = useLatest(nodeId, (s) => s?.procs ?? null);
  const hasSample = useLatest(nodeId, (s) => s !== null);
  const memTotal = useCluster((s) => s.nodes[nodeId]?.info?.mem_total ?? null);
  const status = useCluster((s) => s.nodes[nodeId]?.status);
  const stale = useNodeStale(nodeId);
  const [view, setView] = useState<ProcView>(loadView);
  useEffect(() => { saveView(view); }, [view]);

  const rows = useMemo(() => (procs ? sortProcs(filterProcs(procs, view.filter), view.sort) : []), [procs, view]);
  const summary = useMemo(() => {
    if (!procs) return null;
    const onGpu = procs.filter((p) => p.gpu_mem != null);
    const gpuBytes = onGpu.reduce((a, p) => a + (p.gpu_mem ?? 0), 0);
    // The agent sends the biggest consumers (top by GPU memory, memory and CPU), not every process on the node.
    return `The ${procs.length} biggest ${procs.length === 1 ? 'consumer' : 'consumers'} · ${onGpu.length} on the GPU${onGpu.length ? ` using ${formatBytes(gpuBytes)}` : ''}`;
  }, [procs]);
  const ts = listTs(nodeId, procs);
  const waiting = !procs && !stale && (hasSample || status === 'connecting' || status === 'online' || !status);

  return (
    <Panel
      title="Top processes"
      subtitle={summary ?? (waiting ? 'Waiting for the first process list…' : undefined)}
      className={`procs${stale ? ' is-stale' : ''}`}
      flush
      busy={waiting}
      actions={
        <div className="procs__tools">
          {procs ? <UpdatedAgo ts={ts} stale={stale} suffix="refreshes every 5 s" /> : null}
          {procs ? <FilterInput value={view.filter} onChange={(filter) => { setView((v) => ({ ...v, filter })); }} /> : null}
        </div>
      }
    >
      {procs ? (
        <ProcTable
          rows={rows}
          sort={view.sort}
          onSort={(sort) => { setView((v) => ({ ...v, sort })); }}
          memTotal={memTotal}
          empty={
            procs.length === 0 ? (
              <EmptyState icon={ListX} title="No processes reported" compact>
                {nodeId} sent an empty process list. It refreshes every 5 seconds.
              </EmptyState>
            ) : (
              <EmptyState
                icon={SearchX}
                title={`No processes match “${view.filter.trim()}”`}
                compact
                action={<Button size="sm" onClick={() => { setView((v) => ({ ...v, filter: '' })); }}>Show all processes</Button>}
              >
                The filter checks name, command line, container, model, user and PID.
              </EmptyState>
            )
          }
        />
      ) : waiting ? (
        <div className="procs__loading">
          <RowsSkeleton rows={6} />
        </div>
      ) : (
        <EmptyState icon={ListX} title={`No process list from ${nodeId}`}>
          {stale
            ? `No process list has arrived from ${nodeId} since this page opened. Process lists are live only, so the table fills in once ${nodeId} reconnects.`
            : 'Process lists arrive every 5 seconds once the agent is connected.'}
        </EmptyState>
      )}
    </Panel>
  );
}

function FilterInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="procs__search" role="search">
      <label htmlFor={id} className="visually-hidden">Filter processes</label>
      <Search aria-hidden="true" />
      <input
        ref={ref}
        id={id}
        type="search"
        value={value}
        placeholder="Filter by name, container, model…"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <IconButton
          size="sm"
          className="procs__clear"
          aria-label="Clear filter"
          icon={<X />}
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
