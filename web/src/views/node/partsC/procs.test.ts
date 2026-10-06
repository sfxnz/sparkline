import type { ProcSample } from '../../../lib/types';
import { DEFAULT_VIEW, filterProcs, loadView, nextSort, saveView, shortCmd, sortProcs, VIEW_KEY } from './procs';

const GiB = 1024 ** 3;
const p = (pid: number, over: Partial<ProcSample>): ProcSample => ({
  pid, name: `p${pid}`, cmdline: `/usr/bin/p${pid}`, user: 'root', cpu_pct: 0, rss: 0, gpu_mem: null, gpu_util: null, container: null, model: null, ...over,
});
const rows = [
  p(1, { name: 'dockerd', cpu_pct: 0.4, rss: 112 << 20 }),
  p(2, { name: 'python', cmdline: 'python serve_stats.py --model /models/DeepSeek', cpu_pct: 160, rss: 4.6 * GiB, gpu_mem: 86 * GiB, gpu_util: 91, container: 'c5-2B-r0', model: 'DeepSeek-V4.1-Flash-EXL3' }),
  p(3, { name: 'Trainer', cpu_pct: 40, rss: 2 * GiB, gpu_mem: 8 * GiB, gpu_util: null, container: 'ft-job', user: 'spark' }),
  p(4, { name: 'tailscaled', cpu_pct: 0.3, rss: 52 << 20 }),
];
const pids = (r: ProcSample[]) => r.map((x) => x.pid);

describe('sortProcs', () => {
  it('defaults to GPU memory, biggest first, with non-GPU processes last (ordered by RSS)', () => {
    expect(pids(sortProcs(rows, DEFAULT_VIEW.sort))).toEqual([2, 3, 1, 4]);
  });

  it('keeps missing values last in both directions', () => {
    expect(pids(sortProcs(rows, { id: 'gpu_mem', dir: 'asc' }))).toEqual([3, 2, 1, 4]);
    expect(pids(sortProcs(rows, { id: 'gpu_util', dir: 'desc' })).slice(0, 1)).toEqual([2]);
    expect(pids(sortProcs(rows, { id: 'container', dir: 'asc' }))).toEqual([2, 3, 1, 4]);
  });

  it('sorts names case-insensitively and numbers numerically', () => {
    expect(pids(sortProcs(rows, { id: 'name', dir: 'asc' }))).toEqual([1, 2, 4, 3]);
    expect(pids(sortProcs(rows, { id: 'cpu_pct', dir: 'desc' }))).toEqual([2, 3, 1, 4]);
    // A process seen for the first time has no CPU reading yet: it sorts last, never as 0 %.
    const fresh = [...rows, p(5, { name: 'new', cpu_pct: null, rss: 9 * GiB })];
    expect(pids(sortProcs(fresh, { id: 'cpu_pct', dir: 'desc' })).at(-1)).toBe(5);
    expect(pids(sortProcs(fresh, { id: 'cpu_pct', dir: 'asc' })).at(-1)).toBe(5);
    expect(pids(sortProcs(rows, { id: 'rss', dir: 'asc' }))).toEqual([4, 1, 3, 2]);
  });

  it('does not mutate its input', () => {
    const copy = [...rows];
    sortProcs(rows, { id: 'rss', dir: 'asc' });
    expect(rows).toEqual(copy);
  });
});

describe('filterProcs', () => {
  it('matches name, cmdline, container, model, user and pid, case-insensitively', () => {
    expect(pids(filterProcs(rows, 'DOCKER'))).toEqual([1]);
    expect(pids(filterProcs(rows, 'serve_stats'))).toEqual([2]);
    expect(pids(filterProcs(rows, 'c5-2b'))).toEqual([2]);
    expect(pids(filterProcs(rows, 'deepseek'))).toEqual([2]);
    expect(pids(filterProcs(rows, 'spark'))).toEqual([3]);
    expect(pids(filterProcs(rows, '4'))).toEqual([2, 4]); // pid 4, and "V4.1" in the model name
  });

  it('requires every word to match and treats blank as no filter', () => {
    expect(pids(filterProcs(rows, 'python deepseek'))).toEqual([2]);
    expect(pids(filterProcs(rows, 'python trainer'))).toEqual([]);
    expect(filterProcs(rows, '   ')).toHaveLength(4);
  });
});

describe('nextSort', () => {
  it('flips the active column and starts new columns in their natural direction', () => {
    expect(nextSort({ id: 'gpu_mem', dir: 'desc' }, 'gpu_mem')).toEqual({ id: 'gpu_mem', dir: 'asc' });
    expect(nextSort({ id: 'gpu_mem', dir: 'desc' }, 'name')).toEqual({ id: 'name', dir: 'asc' });
    expect(nextSort({ id: 'name', dir: 'asc' }, 'cpu_pct')).toEqual({ id: 'cpu_pct', dir: 'desc' });
  });
});

describe('session view', () => {
  it('round-trips and rejects junk', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
    saveView({ sort: { id: 'cpu_pct', dir: 'asc' }, filter: 'vllm' }, storage);
    expect(loadView(storage)).toEqual({ sort: { id: 'cpu_pct', dir: 'asc' }, filter: 'vllm' });
    mem.set(VIEW_KEY, '{"sort":{"id":"rm -rf","dir":"up"},"filter":3}');
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
    mem.set(VIEW_KEY, 'not json');
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
  });

  it('survives storage that throws', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadView(bad)).toEqual(DEFAULT_VIEW);
    expect(() => { saveView(DEFAULT_VIEW, bad); }).not.toThrow();
  });
});

it('shortens long command lines and collapses whitespace', () => {
  expect(shortCmd('a   b')).toBe('a b');
  expect(shortCmd('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
});
