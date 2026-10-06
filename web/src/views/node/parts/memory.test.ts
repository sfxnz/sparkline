import type { MemSample } from '../../../lib/types';
import { memoryBreakdown, memoryPressure, type MemSegmentKey } from './memory';

const GiB = 1024 ** 3;
// Shape of a real spark1 reading: ~86 GB GPU-allocated out of 121.7 GiB.
const base: MemSample = {
  total: 130_722_492_416,
  available: 32_201_979_144,
  used: 98_520_513_272,
  free: 17_806_332_357,
  gpu: 86_038_387_060,
  anon: 5_269_838_730,
  cache: 14_395_646_787,
  shmem: 1_503_238_553,
  kernel: 3_776_313_646,
  other: 1_932_735_283,
  swap_total: 16 * GiB,
  swap_used: 4 * GiB,
  psi_some: 0,
  psi_full: 0,
};

const bytesOf = (b: ReturnType<typeof memoryBreakdown>) =>
  Object.fromEntries(b.segments.map((s) => [s.key, s.bytes])) as Record<MemSegmentKey, number>;

describe('memoryBreakdown', () => {
  it('splits total into used parts, reclaimable cache and free, summing exactly to total', () => {
    const b = memoryBreakdown(base);
    const sum = b.segments.reduce((a, s) => a + s.bytes, 0);
    expect(sum).toBe(base.total);
    expect(b.used).toBe(base.total - base.available);
    expect(b.segments.map((s) => s.key)).toEqual(['gpu', 'anon', 'shmem', 'kernel', 'other', 'cache', 'free']);
    const by = bytesOf(b);
    expect(by.gpu).toBe(base.gpu);
    expect(by.anon).toBe(base.anon);
    expect(by.other).toBe(base.other); // the agent's remainder of used
    expect(by.cache).toBe(base.cache);
    expect(by.free).toBe(base.available - base.cache); // cache + free == available
    expect(b.segments.reduce((a, s) => a + s.fraction, 0)).toBeCloseTo(1, 10);
  });

  it('marks cache and free as the available group', () => {
    const b = memoryBreakdown(base);
    const avail = b.segments.filter((s) => s.group === 'available').reduce((a, s) => a + s.bytes, 0);
    expect(avail).toBe(b.available);
  });

  it('never overflows when parts exceed used (caps in agent order, other absorbs nothing)', () => {
    const b = memoryBreakdown({ ...base, available: 100 * GiB, gpu: 30 * GiB, anon: 10 * GiB });
    const used = base.total - 100 * GiB;
    const by = bytesOf(b);
    expect(by.gpu).toBe(Math.min(30 * GiB, used));
    expect(by.gpu + by.anon + by.shmem + by.kernel + by.other).toBe(used);
    expect(by.other).toBeGreaterThanOrEqual(0);
  });

  it('puts unattributed used memory in Other', () => {
    const b = memoryBreakdown({ ...base, gpu: 0, anon: 0, shmem: 0, kernel: 0, other: 0 });
    expect(bytesOf(b).other).toBe(base.total - base.available);
  });

  it('omits the GPU segment when the hardware does not report it', () => {
    const b = memoryBreakdown({ ...base, gpu: null });
    expect(b.segments.some((s) => s.key === 'gpu')).toBe(false);
    expect(b.segments.reduce((a, s) => a + s.bytes, 0)).toBe(base.total);
  });

  it('caps page cache at available and clamps nonsense inputs', () => {
    const b = memoryBreakdown({ ...base, cache: base.total, available: base.total * 2 });
    const by = bytesOf(b);
    expect(b.available).toBe(base.total);
    expect(by.cache).toBe(base.total);
    expect(by.free).toBe(0);
    expect(memoryBreakdown({ ...base, total: 0 }).segments.every((s) => s.fraction === 0)).toBe(true);
  });
});

describe('memoryPressure', () => {
  it('is null when PSI is not reported', () => {
    expect(memoryPressure(null, null)).toBeNull();
  });
  it('reads calm at (near) zero', () => {
    expect(memoryPressure(0, 0)).toEqual({ level: 'none', text: 'No memory pressure' });
    expect(memoryPressure(0.3, 0.1)?.level).toBe('none');
  });
  it('describes partial stalls in plain English', () => {
    expect(memoryPressure(3.24, 0)).toEqual({ level: 'some', text: 'Processes are stalling on memory 3.2% of the time' });
  });
  it('adds full stalls and escalates', () => {
    const p = memoryPressure(40, 12);
    expect(p?.level).toBe('high');
    expect(p?.text).toBe('Processes are stalling on memory 40% of the time; all work is stalled 12% of the time');
  });
});
