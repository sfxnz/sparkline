// Unified-memory breakdown: one bar that always sums to MemTotal.
// The agent splits `used` (= total - available) into gpu / anon / shmem / kernel / other; page cache is
// reported separately because it is reclaimable and therefore counts toward `available`.
import type { MemSample } from '../../../lib/types';

export type MemSegmentKey = 'gpu' | 'anon' | 'shmem' | 'kernel' | 'other' | 'cache' | 'free';

export interface MemSegmentMeta {
  key: MemSegmentKey;
  label: string;
  /** One line for the legend tooltip / table. */
  help: string;
  group: 'used' | 'available';
}

/** Display order: everything in use first, then what is available (reclaimable cache, then free). */
export const MEM_SEGMENTS: readonly MemSegmentMeta[] = [
  { key: 'gpu', label: 'GPU-allocated', help: 'Memory the GPU driver allocated for CUDA processes (models, KV cache).', group: 'used' },
  { key: 'anon', label: 'Processes', help: 'Anonymous memory of CPU processes (heaps, stacks).', group: 'used' },
  { key: 'shmem', label: 'Shared', help: 'Shared memory and tmpfs.', group: 'used' },
  { key: 'kernel', label: 'Kernel', help: 'Slab caches, kernel stacks and page tables.', group: 'used' },
  { key: 'other', label: 'Other', help: 'In use but not attributed above (driver buffers, unaccounted pages).', group: 'used' },
  { key: 'cache', label: 'Page cache', help: 'File data cached in memory. Reclaimed on demand, so it counts toward available.', group: 'available' },
  { key: 'free', label: 'Free', help: 'Not used for anything.', group: 'available' },
];

export interface MemSegment extends MemSegmentMeta {
  bytes: number;
  /** Share of total, 0..1. */
  fraction: number;
}

export interface MemBreakdown {
  total: number;
  used: number;
  available: number;
  /** Segments in display order; they sum to `total`. GPU is omitted when the hardware does not report it. */
  segments: MemSegment[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function memoryBreakdown(m: MemSample): MemBreakdown {
  const total = Math.max(0, m.total);
  const available = clamp(m.available, 0, total);
  const used = total - available;

  // Allocate `used` in the agent's order, each part capped to what is left, so the bar can never overflow.
  let left = used;
  const take = (v: number | null) => {
    const t = clamp(v ?? 0, 0, left);
    left -= t;
    return t;
  };
  const gpu = take(m.gpu);
  const anon = take(m.anon);
  const shmem = take(m.shmem);
  const kernel = take(m.kernel);
  const other = left; // whatever remains of used (normally equal to m.other)
  const cache = clamp(m.cache, 0, available);
  const free = available - cache;

  const bytes: Record<MemSegmentKey, number> = { gpu, anon, shmem, kernel, other, cache, free };
  const segments = MEM_SEGMENTS.filter((s) => !(s.key === 'gpu' && m.gpu == null)).map((s) => ({
    ...s,
    bytes: bytes[s.key],
    fraction: total > 0 ? bytes[s.key] / total : 0,
  }));
  return { total, used, available, segments };
}

export type PressureLevel = 'none' | 'some' | 'high';

/** Plain-English reading of PSI memory pressure (avg10, % of time). null when PSI is not reported. */
export function memoryPressure(some: number | null | undefined, full: number | null | undefined): { level: PressureLevel; text: string } | null {
  if (some == null || !Number.isFinite(some)) return null;
  const f = full != null && Number.isFinite(full) ? full : 0;
  if (some < 0.5 && f < 0.5) return { level: 'none', text: 'No memory pressure' };
  const pct = (v: number) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
  const base = `Processes are stalling on memory ${pct(some)} of the time`;
  const text = f >= 0.5 ? `${base}; all work is stalled ${pct(f)} of the time` : base;
  return { level: f >= 10 || some >= 25 ? 'high' : 'some', text };
}
