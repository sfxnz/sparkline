import { decodeThrottle } from '../../../lib/throttle';
import { stack } from './StackedAreaChart';
import { mean, peak, tempHeadroom } from './gpu';
import { clockLevel, throttleHeadline } from './Notices';
import { gpuProcs, topMemoryProcs } from './ProcTable';
import type { ProcSample, Sample } from '../../../lib/types';

describe('peak / mean', () => {
  it('peak takes the max across samples and rollup maxima', () => {
    expect(peak([30, 31, null], [33, 41.2, null])).toBe(41.2);
    expect(peak(undefined, [])).toBeNull();
  });
  it('mean ignores nulls', () => {
    expect(mean([0, null, 100, 50])).toBe(50);
    expect(mean([null])).toBeNull();
  });
});

describe('tempHeadroom (GB10: slowdown 86 °C, shutdown 90 °C)', () => {
  it('reports degrees below slowdown, calm when there is room', () => {
    expect(tempHeadroom(66.3, 86, 90)).toMatchObject({ level: 'ok', text: '20 °C below slowdown (86 °C)' });
  });
  it('warns when close to slowdown', () => {
    expect(tempHeadroom(82, 86, 90)?.level).toBe('warn');
  });
  it('is critical above slowdown and at shutdown', () => {
    expect(tempHeadroom(87.6, 86, 90)).toMatchObject({ level: 'crit', text: '2 °C over slowdown · 2 °C to shutdown' });
    // Computed from the displayed (rounded) temperature, so the two figures add up: 88 °C is 2 over and 2 to go.
    expect(tempHeadroom(87.5, 86, 90)).toMatchObject({ level: 'crit', text: '2 °C over slowdown · 2 °C to shutdown' });
    expect(tempHeadroom(85.6, 86, 90)).toMatchObject({ level: 'crit', text: 'At slowdown (86 °C) · 4 °C to shutdown' });
    expect(tempHeadroom(90, 86, 90)?.text).toBe('At or above shutdown (90 °C)');
  });
  it('is null without a reading or thresholds', () => {
    expect(tempHeadroom(null, 86, 90)).toBeNull();
    expect(tempHeadroom(60, null, null)).toBeNull();
  });
});

describe('throttleHeadline', () => {
  it('says full speed only when no reasons are active and the clock is near its maximum', () => {
    expect(throttleHeadline(decodeThrottle(0), 'full')).toEqual({ text: 'Running at full speed — no clock limits active', severity: 'ok' });
    expect(throttleHeadline(decodeThrottle(0), 'idle').text).toBe('No clock limits active — clocks are low because the GPU is idle');
    expect(throttleHeadline(decodeThrottle(0)).text).toBe('No clock limits active');
  });
  it('places the clock against its maximum (an idle GB10 reports mask 0 at 208 of 3000 MHz)', () => {
    const at = (sm_mhz: number | null, util: number | null) => ({ gpu: [{ sm_mhz, util }] }) as unknown as Sample;
    expect(clockLevel(at(208, 0), 3000)).toBe('idle');
    expect(clockLevel(at(1200, 85), 3000)).toBe('low');
    expect(clockLevel(at(2900, 85), 3000)).toBe('full');
    expect(clockLevel(at(208, 0), null)).toBeNull();
    expect(clockLevel(null, 3000)).toBeNull();
  });
  it('treats idle as calm, not a limit', () => {
    expect(throttleHeadline(decodeThrottle(0x1)).severity).toBe('ok');
  });
  it('names the active limits with the worst severity', () => {
    expect(throttleHeadline(decodeThrottle(0x4 | 0x20 | 0x40))).toEqual({ text: 'Clocks limited by power cap, thermal limit, overheating', severity: 'critical' });
  });
});

describe('stack', () => {
  it('accumulates layers bottom-up and carries gaps from below', () => {
    expect(stack([[1, 2, null], [10, null, 5], [100, 100, 100]])).toEqual([
      [1, 2, null],
      [11, 2, 5],
      [111, 102, 105],
    ]);
  });
});

describe('process lists', () => {
  const p = (pid: number, rss: number, gpu_mem: number | null): ProcSample => ({ pid, name: `p${pid}`, cmdline: '', user: null, cpu_pct: 0, rss, gpu_mem, gpu_util: null, container: null, model: null });
  it('GPU processes are those holding GPU memory', () => {
    expect(gpuProcs([p(1, 5, null), p(2, 5, 0), p(3, 5, 10)]).map((x) => x.pid)).toEqual([3]);
  });
  it('top memory consumers rank by RSS plus GPU allocation', () => {
    expect(topMemoryProcs([p(1, 50, null), p(2, 5, 100), p(3, 20, 10)], 2).map((x) => x.pid)).toEqual([2, 1]);
  });
});
