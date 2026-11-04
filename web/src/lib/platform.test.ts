import { platformSheet } from './platform';
import type { GpuInfo, NodeInfo, Unsupported } from './types';

const gpu = (name: string, more: Partial<GpuInfo> = {}) => ({ name, ...more }) as GpuInfo;
const node = (more: Partial<NodeInfo>) => ({ gpus: [], unsupported: [], ...more }) as unknown as NodeInfo;

describe('platformSheet', () => {
  it('reads an older payload without platform, vendor, backend or versions as Linux, NVIDIA, nvml and no versions', () => {
    const sheet = platformSheet(node({ gpus: [gpu('Test GPU')] }));
    expect(sheet.platform).toBe('Linux');
    expect(sheet.backends).toEqual([{ vendor: 'NVIDIA', backend: 'nvml', gpus: ['Test GPU'] }]);
    expect(sheet.versions).toEqual([]);
    expect(sheet.backendGap).toBeNull();
    expect(sheet.skipped).toEqual([]);
  });

  it('names macOS and groups GPUs by vendor and backend in index order', () => {
    const sheet = platformSheet(node({
      platform: 'darwin',
      gpus: [gpu('A', { vendor: 'amd', backend: 'amdgpu-sysfs' }), gpu('N'), gpu('A', { vendor: 'amd', backend: 'amdgpu-sysfs' }), gpu('M', { vendor: 'apple', backend: 'ioreport' })],
    }));
    expect(sheet.platform).toBe('macOS');
    expect(sheet.backends).toEqual([
      { vendor: 'AMD', backend: 'amdgpu-sysfs', gpus: ['A', 'A'] },
      { vendor: 'NVIDIA', backend: 'nvml', gpus: ['N'] },
      { vendor: 'Apple', backend: 'ioreport', gpus: ['M'] },
    ]);
  });

  it('shows a platform and a vendor a newer agent sends as sent, never as Linux or NVIDIA', () => {
    const sheet = platformSheet(node({ platform: 'freebsd', gpus: [gpu('Arc', { vendor: 'intel', backend: 'level-zero' })] }));
    expect(sheet.platform).toBe('freebsd');
    expect(sheet.backends).toEqual([{ vendor: 'intel', backend: 'level-zero', gpus: ['Arc'] }]);
  });

  it('groups versions by vendor prefix, NVIDIA then AMD then Apple then unknown prefixes, labels printed as sent', () => {
    const sheet = platformSheet(node({
      versions: { 'future.Thing': '1', 'apple.macOS': '999.1', 'amd.ROCm': '999.2', 'nvidia.Driver': '999.3', 'nvidia.CUDA': '999.4', 'amd.amdgpu driver': '999.5' },
    }));
    expect(sheet.versions).toEqual([
      { vendor: 'NVIDIA', rows: [{ label: 'Driver', value: '999.3' }, { label: 'CUDA', value: '999.4' }] },
      { vendor: 'AMD', rows: [{ label: 'ROCm', value: '999.2' }, { label: 'amdgpu driver', value: '999.5' }] },
      { vendor: 'Apple', rows: [{ label: 'macOS', value: '999.1' }] },
      { vendor: 'future', rows: [{ label: 'Thing', value: '1' }] },
    ]);
  });

  it('splits the gpu.backend reason into one skipped backend per failure, keeping a reason it cannot parse whole', () => {
    const entry = (reason: string): Unsupported => ({ metric: 'gpu.backend', reason, kind: 'access' });
    const several = platformSheet(node({ unsupported: [entry('nvml: NVML unavailable (NVML: Driver/library version mismatch); amdgpu-sysfs: Permission denied: /dev/kfd')] }));
    expect(several.backendGap).toEqual({ kind: 'access', label: 'No access', detail: 'nvml: NVML unavailable (NVML: Driver/library version mismatch); amdgpu-sysfs: Permission denied: /dev/kfd' });
    expect(several.skipped).toEqual([
      { backend: 'nvml', reason: 'NVML unavailable (NVML: Driver/library version mismatch)' },
      { backend: 'amdgpu-sysfs', reason: 'Permission denied: /dev/kfd' },
    ]);
    expect(platformSheet(node({ unsupported: [entry('No GPU backend reads darwin yet')] })).skipped).toEqual([{ backend: null, reason: 'No GPU backend reads darwin yet' }]);
  });
});
