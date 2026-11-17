// Parity with server/sparkline/common/metrics.py: the expected output was produced by the Python flatten()
// on the same fixture (src/test/fixtures/flatten.expected.json).
import expected from '../test/fixtures/flatten.expected.json';
import sample from '../test/fixtures/sample.json';
import { flatten, GPU_TOTALS, mountKey } from './metrics';
import type { Sample } from './types';

const s = sample as unknown as Sample;
const gpuTotals = expected.gpu_totals as unknown as { case: string; gpu: Sample['gpu']; errors: Sample['errors']; flatten: Record<string, number> }[];

describe('flatten', () => {
  it('produces exactly the keys and values of the Python flatten()', () => {
    const got = Object.fromEntries(flatten(s));
    expect(Object.keys(got).sort()).toEqual(Object.keys(expected.flatten).sort());
    for (const [k, v] of Object.entries(expected.flatten)) expect(got[k]).toBeCloseTo(v, 9);
  });

  it('omits unsupported (null) metrics instead of reporting 0', () => {
    const got = flatten(s);
    expect(got.has('gpu0.thermal_capped_pct')).toBe(false);
    expect(got.has('mem.psi_full')).toBe(false);
    expect(got.has('cpu.core1.mhz')).toBe(false);
    expect(got.has('temp.nvme.composite')).toBe(false);
    expect(got.has('fs.data_models.used_pct')).toBe(false); // total 0
  });

  it('writes a model server\'s readings and no key for a field with nothing to say', () => {
    const got = flatten(s);
    expect(got.get('llm.8000.up')).toBe(1);
    expect(got.get('llm.9931.up')).toBe(0);
    expect(s.llm?.[0]?.reports).toContain('ttft_p50_s');
    expect(got.has('llm.8000.ttft_p50_s')).toBe(false);
    expect(got.has('llm.8000.kv_cache_pct')).toBe(false);
    expect(got.get('llm.8000.itl_p50_s')).toBe(0.021); // a field from a newer agent keeps its history
  });

  it('writes no llm key for a sample from an agent that predates model servers', () => {
    expect([...flatten({ ...s, llm: undefined }).keys()].filter((k) => k.startsWith('llm.'))).toEqual([]);
  });

  it('totals the GPUs by the same rules as the Python GPU_TOTALS', () => {
    expect(GPU_TOTALS).toEqual(expected.gpu_total_rules);
  });

  it.each(gpuTotals)('writes the node GPU totals like the Python flatten(): $case', ({ gpu, errors, flatten: want }) => {
    const got = Object.fromEntries([...flatten({ ...s, gpu, errors })].filter(([k]) => k.startsWith('gpu')));
    expect(got).toEqual(want);
  });

  it('writes no mem.* keys for the agent\'s placeholder reading (total 0), like the Python flatten()', () => {
    const got = Object.fromEntries(flatten({ ...s, mem: expected.mem_placeholder.mem }));
    expect(got).toEqual(expected.mem_placeholder.flatten);
    expect(Object.keys(got).filter((k) => k.startsWith('mem.'))).toEqual([]);
  });
});

describe('mountKey', () => {
  it.each(Object.entries(expected.mount_key))('%s -> %s (same as Python)', (mount, key) => {
    expect(mountKey(mount)).toBe(key);
  });
});
