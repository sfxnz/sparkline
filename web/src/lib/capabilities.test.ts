import { notReported } from './capabilities';
import type { NodeInfo, Unsupported } from './types';

const node = (...unsupported: Unsupported[]) => ({ unsupported }) as unknown as NodeInfo;
const HARDWARE = 'Not reported by this hardware';

describe('notReported', () => {
  it('covers an exact key and every key under it, but not a key that only shares a prefix', () => {
    const info = node({ metric: 'gpu0.power_limit_w', reason: 'NVML: Not Supported' }, { metric: 'fan', reason: 'No fan sensors' });
    expect(notReported(info, 'gpu0.power_limit_w')).toEqual({ kind: 'hardware', label: HARDWARE, detail: 'NVML: Not Supported' });
    expect(notReported(info, 'fan.0.rpm')).toEqual({ kind: 'hardware', label: HARDWARE, detail: 'No fan sensors' });
    expect(notReported(info, 'fans')).toBeNull();
    expect(notReported(info, 'gpu1.power_limit_w')).toBeNull();
  });

  it('lets gpu* stand for any GPU index, and only an index', () => {
    const info = node({ metric: 'gpu*.power_limit_w', reason: 'No limit' }, { metric: 'gpu*', reason: 'No NVML' });
    expect(notReported(info, 'gpu0.power_limit_w')?.detail).toBe('No limit');
    expect(notReported(info, 'gpu3.power_limit_w')?.detail).toBe('No limit');
    expect(notReported(info, 'gpu12.util')?.detail).toBe('No NVML');
    expect(notReported(info, 'gpux.util')).toBeNull();
    expect(notReported(info, 'gpus')).toBeNull();
    expect(notReported(info, 'gpu')).toBeNull();
  });

  it('answers with the most specific entry whatever the order: exact key, then longest prefix, then wildcard', () => {
    const wild = { metric: 'gpu*', reason: 'Install nvidia-ml-py', kind: 'dependency' } as const;
    const gpu0 = { metric: 'gpu0', reason: 'GPU 0 is gone' };
    const exact = { metric: 'gpu0.power_limit_w', reason: 'Permission denied', kind: 'access' } as const;
    for (const info of [node(wild, gpu0, exact), node(exact, gpu0, wild)]) {
      expect(notReported(info, 'gpu0.power_limit_w')).toEqual({ kind: 'access', label: 'No access', detail: 'Permission denied' });
      expect(notReported(info, 'gpu0.util')?.detail).toBe('GPU 0 is gone');
      expect(notReported(info, 'gpu1.util')?.detail).toBe('Install nvidia-ml-py');
    }
    const wilds = node({ metric: 'gpu*', reason: 'all' }, { metric: 'gpu*.power_limit_w', reason: 'limit' });
    expect(notReported(wilds, 'gpu2.power_limit_w')?.detail).toBe('limit');
  });

  it('reads an entry without a kind, as an older agent sends it, as not reported by the hardware', () => {
    expect(notReported(node({ metric: 'cpu.temp', reason: 'No CPU sensor' }), 'cpu.temp')).toEqual({ kind: 'hardware', label: HARDWARE, detail: 'No CPU sensor' });
  });

  it('reads a kind this console predates as not reported by the hardware', () => {
    const future = { metric: 'cpu.temp', reason: 'Needs CAP_PERFMON', kind: 'capability' } as unknown as Unsupported;
    expect(notReported(node(future), 'cpu.temp')).toEqual({ kind: 'hardware', label: HARDWARE, detail: 'Needs CAP_PERFMON' });
  });

  it('gives each kind a short label and keeps the agent reason for the tooltip', () => {
    const info = node(
      { metric: 'gpu0.mem_mhz', reason: "Permission denied to the agent's user (NVML: Insufficient Permissions)", kind: 'access' },
      { metric: 'gpu*', reason: 'Install nvidia-ml-py to read NVIDIA GPU metrics', kind: 'dependency' },
    );
    expect(notReported(info, 'gpu0.mem_mhz')).toEqual({ kind: 'access', label: 'No access', detail: "Permission denied to the agent's user (NVML: Insufficient Permissions)" });
    expect(notReported(info, 'gpu1.util')).toEqual({ kind: 'dependency', label: 'Helper tool missing', detail: 'Install nvidia-ml-py to read NVIDIA GPU metrics' });
  });

  it('says a metric the agent does not read yet is not collected, not missing from the hardware', () => {
    const info = node({ metric: 'fan', reason: 'Fan speed is not collected yet (hwmon exposes 2 fan sensors)', kind: 'agent' });
    expect(notReported(info, 'fan')).toEqual({ kind: 'agent', label: 'Not collected yet', detail: 'Fan speed is not collected yet (hwmon exposes 2 fan sensors)' });
  });

  it('answers null without node info', () => {
    expect(notReported(null, 'gpu0.util')).toBeNull();
    expect(notReported(undefined, 'gpu0.util')).toBeNull();
  });
});
