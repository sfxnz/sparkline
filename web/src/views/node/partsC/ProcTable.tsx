import { Box, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Sparkles } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import '../../../design/components/Table.css';
import { Tooltip } from '../../../design/components/Tooltip';
import { DASH, formatBytes } from '../../../lib/format';
import type { ProcSample } from '../../../lib/types';
import { nextSort, shortCmd, type ProcSort, type ProcSortId } from './procs';

interface Col {
  id: ProcSortId;
  header: string;
  end?: boolean;
  width?: string;
}

const COLS: readonly Col[] = [
  { id: 'name', header: 'Process' },
  { id: 'container', header: 'Container', width: '9.5rem' },
  { id: 'model', header: 'Model', width: '14rem' },
  { id: 'gpu_mem', header: 'GPU memory', end: true, width: '8rem' },
  { id: 'gpu_util', header: 'GPU util', end: true, width: '6rem' },
  { id: 'cpu_pct', header: 'CPU cores', end: true, width: '6rem' },
  { id: 'rss', header: 'Memory (RSS)', end: true, width: '7.5rem' },
];

interface Props {
  rows: readonly ProcSample[];
  sort: ProcSort;
  onSort: (s: ProcSort) => void;
  /** Unified memory total, for the GPU-memory share bar. */
  memTotal: number | null;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
}

/** Sortable process table with expandable rows (full command line, PID, user). Sorting is controlled by the parent. */
export function ProcTable({ rows, sort, onSort, memTotal, empty }: Props) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (pid: number) => {
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(pid)) n.add(pid);
      return n;
    });
  };

  return (
    <div className="table-wrap">
      <table className="table procs-table">
        <caption className="visually-hidden">Top processes by resource use. Column headers sort the table; each row expands to show its full command line.</caption>
        <thead>
          <tr>
            {COLS.map((c) => {
              const active = sort.id === c.id;
              const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
              return (
                <th key={c.id} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={c.end ? 'is-end' : undefined} style={{ width: c.width }}>
                  <button type="button" className={`table__sort${active ? ' is-active' : ''}`} onClick={() => { onSort(nextSort(sort, c.id)); }}>
                    <span>{c.header}</span>
                    <Icon aria-hidden="true" />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={COLS.length} className="table__empty">{empty}</td>
            </tr>
          ) : (
            rows.map((p) => {
              const isOpen = open.has(p.pid);
              const detailId = `proc-detail-${p.pid}`;
              return (
                <Fragment key={p.pid}>
                  <tr className={isOpen ? 'procs__row--open' : undefined}>
                    <td className="procs__proc-cell">
                      <div className="procs__name-cell">
                        <button
                          type="button"
                          className="procs__toggle"
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? detailId : undefined}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${p.name} (PID ${p.pid})`}
                          onClick={() => { toggle(p.pid); }}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                        <div className="procs__name">
                          <span className="procs__proc">
                            {p.name}
                            <span className="procs__pid num">{p.pid}</span>
                          </span>
                          <span className="procs__cmd" title={p.cmdline}>{shortCmd(p.cmdline)}</span>
                        </div>
                      </div>
                    </td>
                    <td>{p.container ? <Badge icon={<Box />} text={p.container} label="Container" /> : <span className="procs__none">{DASH}</span>}</td>
                    <td>{p.model ? <Badge icon={<Sparkles />} text={p.model} label="Model" model /> : <span className="procs__none">{DASH}</span>}</td>
                    <td className="is-end"><GpuMem bytes={p.gpu_mem} total={memTotal} /></td>
                    <td className="is-end num"><GpuUtil p={p} /></td>
                    <td className="is-end num"><CpuCores pct={p.cpu_pct} /></td>
                    <td className="is-end num">{formatBytes(p.rss)}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="procs__detail procs__row--open" id={detailId}>
                      <td colSpan={COLS.length} className="procs__proc-cell">
                        <dl>
                          <dt>Command line</dt>
                          <dd><code>{p.cmdline || DASH}</code></dd>
                          <dt>PID</dt>
                          <dd className="num">{p.pid}</dd>
                          <dt>User</dt>
                          <dd>{p.user ?? DASH}</dd>
                          {p.container ? (<><dt>Container</dt><dd>{p.container}</dd></>) : null}
                          {p.model ? (<><dt>Model</dt><dd>{p.model}</dd></>) : null}
                        </dl>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ icon, text, label, model }: { icon: ReactNode; text: string; label: string; model?: boolean }) {
  return (
    <span className={`procs__badge${model ? ' procs__badge--model' : ''}`} title={`${label}: ${text}`}>
      <span aria-hidden="true" style={{ display: 'contents' }}>{icon}</span>
      <span className="visually-hidden">{label}: </span>
      <span>{text}</span>
    </span>
  );
}

function GpuMem({ bytes, total }: { bytes: number | null; total: number | null }) {
  if (bytes == null) return <span className="procs__none">{DASH}</span>;
  const share = total ? Math.min(1, bytes / total) : null;
  return (
    <span className="procs__mem">
      <span className="num">{formatBytes(bytes)}</span>
      {share !== null ? (
        <span className="procs__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(2, share * 100)}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/** CPU as cores in use ("1.21" = one core and a fifth), so it never reads as a share of the whole node (which the CPU
 *  tab shows as a %). No reading yet for a process seen for the first time. */
function CpuCores({ pct }: { pct: number | null }) {
  if (pct == null) {
    return (
      <Tooltip content="No reading yet: CPU use is measured between two process refreshes, so a new process shows it from the next one." placement="top">
        <button type="button" className="procs__na" aria-label="No CPU reading yet for this process">{DASH}</button>
      </Tooltip>
    );
  }
  const cores = pct / 100;
  return <>{cores.toFixed(cores < 10 ? 2 : 1)}</>;
}

function GpuUtil({ p }: { p: ProcSample }) {
  if (p.gpu_util != null) return <>{p.gpu_util.toFixed(0)}%</>;
  if (p.gpu_mem == null) return <span className="procs__none">{DASH}</span>; // not on the GPU at all
  return (
    <Tooltip content="Not reported: the driver returned no utilisation samples for this process. Its GPU memory is still counted." placement="top">
      <button type="button" className="procs__na" aria-label="GPU utilisation not reported for this process">{DASH}</button>
    </Tooltip>
  );
}
