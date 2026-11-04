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
    expect(sheet.missing).toBeNull();
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

  it('lists each skipped backend with its own kind, reading each reason whole', () => {
    const sheet = platformSheet(node({
      platform: 'darwin',
      gpus: [gpu('Test Apple GPU', { vendor: 'apple', backend: 'ioreg' })],
      unsupported: [
        { metric: 'gpu.backend.apple', reason: 'Install macmon (0.9.0 or later); it reads power and clocks', kind: 'dependency' },
        { metric: 'gpu.backend.powermetrics', reason: 'Needs root', kind: 'access' },
      ],
    }));
    expect(sheet.missing).toBeNull();
    expect(sheet.skipped).toEqual([
      { backend: 'apple', gap: { kind: 'dependency', label: 'Helper tool missing', detail: 'Install macmon (0.9.0 or later); it reads power and clocks' } },
      { backend: 'powermetrics', gap: { kind: 'access', label: 'No access', detail: 'Needs root' } },
    ]);
  });

  it('says why no backend is in use: none opened, no GPU found, or nothing reported', () => {
    const gap = (metric: string, reason: string, kind: Unsupported['kind'] = 'hardware'): Unsupported => ({ metric, reason, kind });
    const failed = platformSheet(node({ unsupported: [gap('gpu.backend', 'nvml: NVML sees 1 GPU but could not open it'), gap('gpu.backend.nvml', 'NVML sees 1 GPU but could not open it')] }));
    expect(failed.missing).toBe('No GPU backend opened');
    expect(failed.skipped.map((s) => s.backend)).toEqual(['nvml']);

    const absent = platformSheet(node({ unsupported: [gap('gpu*', 'nvml: No NVIDIA driver is loaded'), gap('gpu.backend.nvml', 'No NVIDIA driver is loaded')] }));
    expect(absent.missing).toBe('No GPU found');

    const darwin = platformSheet(node({ unsupported: [gap('gpu.backend', 'No GPU backend reads darwin yet', 'agent')] }));
    expect(darwin.missing).toBe('No GPU backend opened');
    expect(darwin.skipped).toEqual([{ backend: null, gap: { kind: 'agent', label: 'Not collected yet', detail: 'No GPU backend reads darwin yet' } }]);

    expect(platformSheet(node({})).missing).toBe('No GPUs reported');

    const older = platformSheet(node({ unsupported: [gap('gpu*', 'Install nvidia-ml-py to read NVIDIA GPU metrics', 'dependency')] }));
    expect(older.missing).toBe('No GPU data');
    expect(older.skipped).toEqual([{ backend: null, gap: { kind: 'dependency', label: 'Helper tool missing', detail: 'Install nvidia-ml-py to read NVIDIA GPU metrics' } }]);
  });
});
