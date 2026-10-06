// Parity with server/sparkline/common/metrics.py: the expected output was produced by the Python flatten()
// on the same fixture (src/test/fixtures/flatten.expected.json).
import expected from '../test/fixtures/flatten.expected.json';
import sample from '../test/fixtures/sample.json';
import { flatten, mountKey } from './metrics';
import type { Sample } from './types';

const s = sample as unknown as Sample;

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
});

describe('mountKey', () => {
  it.each(Object.entries(expected.mount_key))('%s -> %s (same as Python)', (mount, key) => {
    expect(mountKey(mount)).toBe(key);
  });
});
