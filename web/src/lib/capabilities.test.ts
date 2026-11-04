import { notReported } from './capabilities';
import type { NodeInfo, Unsupported } from './types';

const node = (...unsupported: Unsupported[]) => ({ unsupported }) as unknown as NodeInfo;
const HARDWARE = 'Not reported by this hardware';

describe('notReported', () => {
  it('covers an exact key and every key under it, but not a key that only shares a prefix', () => {
    const info = node({ metric: 'gpu0.power_limit_w', reason: 'NVML: Not Supported' }, { metric: 'fan', reason: 'No fan sensors' });
    expect(notReported(info, 'gpu0.power_limit_w')).toEqual({ label: HARDWARE, detail: 'NVML: Not Supported' });
    expect(notReported(info, 'fan.0.rpm')).toEqual({ label: HARDWARE, detail: 'No fan sensors' });
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

  it('reads an entry without a kind, as an older agent sends it, as not reported by the hardware', () => {
    expect(notReported(node({ metric: 'cpu.temp', reason: 'No CPU sensor' }), 'cpu.temp')).toEqual({ label: HARDWARE, detail: 'No CPU sensor' });
  });

  it('shows the agent reason itself as the label when a privilege or a helper tool is missing', () => {
    const info = node({ metric: 'gpu0.mem_mhz', reason: 'Needs root', kind: 'access' }, { metric: 'gpu*', reason: 'Install nvidia-ml-py', kind: 'dependency' });
    expect(notReported(info, 'gpu0.mem_mhz')?.label).toBe('Needs root');
    expect(notReported(info, 'gpu1.util')?.label).toBe('Install nvidia-ml-py');
  });

  it('answers null without node info', () => {
    expect(notReported(null, 'gpu0.util')).toBeNull();
    expect(notReported(undefined, 'gpu0.util')).toBeNull();
  });
});
