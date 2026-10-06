// Process table logic: sorting, filtering and the per-session view state. Pure; unit-tested in procs.test.ts.
import type { ProcSample } from '../../../lib/types';

export type ProcSortId = 'name' | 'container' | 'model' | 'gpu_mem' | 'gpu_util' | 'cpu_pct' | 'rss';
export type SortDir = 'asc' | 'desc';
export interface ProcSort {
  id: ProcSortId;
  dir: SortDir;
}
export interface ProcView {
  sort: ProcSort;
  filter: string;
}

export const DEFAULT_VIEW: ProcView = { sort: { id: 'gpu_mem', dir: 'desc' }, filter: '' };
const SORT_IDS: readonly ProcSortId[] = ['name', 'container', 'model', 'gpu_mem', 'gpu_util', 'cpu_pct', 'rss'];
/** Text columns start ascending; numeric columns start with the biggest consumer first. */
export const defaultDir = (id: ProcSortId): SortDir => (id === 'name' || id === 'container' || id === 'model' ? 'asc' : 'desc');

function key(p: ProcSample, id: ProcSortId): number | string | null {
  switch (id) {
    case 'name':
      return p.name.toLowerCase();
    case 'container':
      return p.container?.toLowerCase() ?? null;
    case 'model':
      return p.model?.toLowerCase() ?? null;
    default:
      return p[id];
  }
}

/** Sort by a column; missing values always sort last (either direction); ties fall back to RSS desc, then pid. */
export function sortProcs(rows: readonly ProcSample[], sort: ProcSort): ProcSample[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a, sort.id);
    const y = key(b, sort.id);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      if (c !== 0) return c * sign;
    }
    return b.rss - a.rss || a.pid - b.pid;
  });
}

/** Case-insensitive match on name, command line, container, model, user or pid. Every word must match. */
export function filterProcs(rows: readonly ProcSample[], query: string): ProcSample[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((p) => {
    const hay = [p.name, p.cmdline, p.container ?? '', p.model ?? '', p.user ?? '', String(p.pid)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Clicking the active column flips direction; a new column starts in its natural direction. */
export function nextSort(current: ProcSort, id: ProcSortId): ProcSort {
  return current.id === id ? { id, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: defaultDir(id) };
}

export const VIEW_KEY = 'sparkline.processes.view';

/** The table's sort and filter for this browser session (sessionStorage may be unavailable: then defaults). */
export function loadView(storage: Pick<Storage, 'getItem'> | null = safeSession()): ProcView {
  try {
    const raw = JSON.parse(storage?.getItem(VIEW_KEY) ?? 'null') as Partial<ProcView> | null;
    const id = raw?.sort?.id;
    const dir = raw?.sort?.dir;
    return {
      sort: id && SORT_IDS.includes(id) && (dir === 'asc' || dir === 'desc') ? { id, dir } : DEFAULT_VIEW.sort,
      filter: typeof raw?.filter === 'string' ? raw.filter.slice(0, 200) : '',
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: ProcView, storage: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try {
    storage?.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* storage unavailable: the view lasts until the tab closes */
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Command line shortened for the row (the expanded row shows it in full). */
export function shortCmd(cmdline: string, max = 90): string {
  const s = cmdline.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
