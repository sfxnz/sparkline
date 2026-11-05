import gb10Info from '../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../test/fixtures/platforms/workstation/info.json';
import wsSample from '../test/fixtures/platforms/workstation/sample.json';
import { notReported } from './capabilities';
import { gpuProcessesGap, gpuSetGap, nodeGpuGap, nodeGpuKey, nodeTotalGap, totalFrom, totalGap } from './gpu';
import type { GpuSample, NodeInfo, Sample, Unsupported } from './types';

const gb10 = gb10Info as unknown as NodeInfo;
const ws1 = wsInfo as unknown as NodeInfo;
const sample = wsSample as unknown as Sample;
const LOST = 'NVML could not open GPU 0 (NVML: GPU is lost)';
const ws1With = (...unsupported: Unsupported[]): NodeInfo => ({ ...ws1, unsupported });
const lostGpu0 = (...more: Unsupported[]) => ws1With({ metric: 'gpu0', reason: LOST, kind: 'hardware' }, ...more);
const withGpu = (s: Sample, index: number, over: Partial<GpuSample>): Sample => ({ ...s, gpu: s.gpu.map((g) => (g.index === index ? { ...g, ...over } : g)) });
const noGpu = { gpus: [], unsupported: [{ metric: 'gpu*', reason: 'Install nvidia-ml-py to read NVIDIA GPU metrics', kind: 'dependency' }] } as unknown as NodeInfo;
const empty = (g: GpuSample): GpuSample => ({
  index: g.index, util: null, sm_mhz: null, gr_mhz: null, video_mhz: null, temp_c: null, power_w: null, energy_j: g.energy_j, pstate: null,
  throttle_mask: null, power_capped_pct: g.power_capped_pct, thermal_capped_pct: g.thermal_capped_pct, vram_used: null, shared_used: null,
});
const emptied = (s: Sample, indexes: readonly number[]): Sample => ({ ...s, gpu: s.gpu.map((g) => (indexes.includes(g.index) ? empty(g) : g)) });

describe('nodeGpuKey', () => {
  it("reads a one-GPU node from its GPU's own key, so its history from before the totals still charts", () => {
    expect(nodeGpuKey(gb10, 'util')).toBe('gpu0.util');
    expect(nodeGpuKey(gb10, 'power_w')).toBe('gpu0.power_w');
    expect(nodeGpuKey(noGpu, 'temp_c')).toBe('gpu0.temp_c');
  });

  it('reads a multi-GPU node from its total', () => {
    expect(nodeGpuKey(ws1, 'util')).toBe('gpu.util');
    expect(nodeGpuKey(ws1, 'temp_c')).toBe('gpu.temp_c');
    expect(nodeGpuKey(ws1, 'power_w')).toBe('gpu.power_w');
  });

  it('reads GPU memory from the node total on any node, since no GPU key has its name', () => {
    expect(nodeGpuKey(gb10, 'mem_used')).toBe('gpu.mem_used');
    expect(nodeGpuKey(ws1, 'mem_used')).toBe('gpu.mem_used');
  });
});

describe('gpuSetGap', () => {
  it("answers on GB10 exactly as GPU 0's own key does", () => {
    for (const field of ['proc_mem', 'power_limit_w', 'energy_j', 'util'] as const) {
      for (const mode of ['any', 'every'] as const) expect(gpuSetGap(gb10, field, mode)).toEqual(notReported(gb10, `gpu0.${field}`));
    }
    expect(gpuSetGap(gb10, 'power_limit_w', 'every')?.detail).toMatch(/GB10/);
  });

  it('answers for gpu0 on a node that lists no GPU', () => {
    expect(gpuSetGap(noGpu, 'proc_mem', 'any')).toEqual(notReported(noGpu, 'gpu0.proc_mem'));
    expect(gpuSetGap(noGpu, 'proc_mem', 'any')?.label).toBe('Helper tool missing');
  });

  it('on ws1, a field one GPU lacks is missing from every sum but not from the set', () => {
    const info = ws1With({ metric: 'gpu2.energy_j', reason: 'NVML: Not Supported', kind: 'hardware' });
    expect(gpuSetGap(info, 'energy_j', 'any')).toBeNull();
    expect(gpuSetGap(info, 'energy_j', 'every')).toEqual({ kind: 'hardware', label: 'Not reported by this hardware', detail: 'GPU 2: NVML: Not Supported' });
    expect(gpuSetGap(ws1, 'energy_j', 'every')).toBeNull();
  });

  it('on ws1, a field no GPU reports is missing from the set, naming the first GPU', () => {
    const info = ws1With({ metric: 'gpu*.proc_mem', reason: 'Needs root to read other users’ processes', kind: 'access' });
    expect(gpuSetGap(info, 'proc_mem', 'any')).toEqual({ kind: 'access', label: 'No access', detail: 'GPU 0: Needs root to read other users’ processes' });
  });

  it("keeps counting the other GPUs' processes when GPU 0 is lost, and says so for a sum", () => {
    expect(gpuSetGap(lostGpu0(), 'proc_mem', 'any')).toBeNull();
    expect(gpuSetGap(lostGpu0(), 'energy_j', 'every')).toEqual({ kind: 'hardware', label: 'Not responding', detail: `GPU 0: ${LOST}`, silent: true });
  });

  it('names a GPU that answers when GPU 0 is lost and the others lack the field too', () => {
    const info = lostGpu0({ metric: 'gpu1.proc_mem', reason: 'Not reported by the amdgpu-sysfs backend', kind: 'agent' }, { metric: 'gpu2.proc_mem', reason: 'Not reported by the amdgpu-sysfs backend', kind: 'agent' }, { metric: 'gpu3.proc_mem', reason: 'Not reported by the amdgpu-sysfs backend', kind: 'agent' });
    expect(gpuSetGap(info, 'proc_mem', 'any')).toEqual({ kind: 'agent', label: 'Not collected yet', detail: 'GPU 1: Not reported by the amdgpu-sysfs backend' });
  });
});

describe('totalFrom', () => {
  it('counts the GPUs a mean or a maximum reads while one is lost or silent', () => {
    expect(totalFrom(ws1, sample, 'util')).toBeNull();
    expect(totalFrom(lostGpu0(), withGpu(sample, 0, { util: null, temp_c: null }), 'util')).toEqual({ from: 3, of: 4 });
    expect(totalFrom(ws1, { ...sample, gpu: sample.gpu.filter((g) => g.index !== 2) }, 'temp_c')).toEqual({ from: 3, of: 4 });
  });

  it('is null on a one-GPU node and when no GPU has the field', () => {
    expect(totalFrom(gb10, { ...sample, gpu: [] }, 'util')).toBeNull();
    expect(totalFrom(ws1, { ...sample, gpu: sample.gpu.map((g) => ({ ...g, util: null })) }, 'util')).toBeNull();
  });
});

describe('totalGap', () => {
  it('is null while every GPU reports', () => {
    for (const field of ['util', 'temp_c', 'power_w'] as const) expect(totalGap(ws1, sample, field)).toBeNull();
  });

  it('names the GPU whose power reading is missing, since a sum without it would understate', () => {
    const s = withGpu(sample, 2, { power_w: null });
    expect(totalGap(ws1, s, 'power_w')).toEqual({ kind: 'hardware', label: 'No total', detail: 'GPU 2 sent no power reading this tick, so a sum would understate.', silent: true });
    expect(totalGap(ws1, s, 'util')).toBeNull();
    expect(totalGap(ws1, withGpu(s, 3, { power_w: null }), 'power_w')?.detail).toBe('GPUs 2 and 3 sent no power reading this tick, so a sum would understate.');
  });

  it('names the GPU that sent neither VRAM nor shared memory, on one GPU as on several', () => {
    const vram = { ...sample, gpu: sample.gpu.map((g) => ({ ...g, vram_used: 40 * 1024 ** 3 })) };
    expect(totalGap(ws1, vram, 'mem_used')).toBeNull();
    expect(totalGap(ws1, withGpu(vram, 2, { vram_used: null }), 'mem_used')?.detail).toBe('GPU 2 sent no memory reading this tick, so a sum would understate.');
    const oneGpu = { ...sample, gpu: vram.gpu.filter((g) => g.index === 0).map((g) => ({ ...g, vram_used: null, shared_used: null })) };
    expect(totalGap(gb10, oneGpu, 'mem_used')?.detail).toBe('GPU 0 sent no memory reading this tick, so a sum would understate.');
    expect(totalGap(gb10, withGpu(oneGpu, 0, { shared_used: 0 }), 'mem_used')).toBeNull();
  });

  it("gives the failed backend's own error for the GPUs it dropped", () => {
    const s = { ...sample, gpu: sample.gpu.filter((g) => g.index < 2), errors: { gpu: 'nvml: RuntimeError: NVML read failed' } };
    expect(totalGap(ws1, s, 'power_w')?.detail).toBe('GPUs 2 and 3 not responding (RuntimeError: NVML read failed), so a sum would understate.');
  });

  it('leaves a declared gap to notReported, which reads No total with the lost GPU it names', () => {
    const info = lostGpu0({ metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' });
    const s = withGpu(sample, 0, { util: null, temp_c: null, power_w: null });
    expect(totalGap(info, s, 'power_w')).toBeNull();
    expect(notReported(info, nodeGpuKey(info, 'power_w'))).toEqual({ kind: 'hardware', label: 'No total', detail: `GPU 0: ${LOST}` });
  });
});

describe('the gap of a node figure that reads less than every GPU the node lists', () => {
  const NVML_DOWN = 'NVMLError_Unknown: Unknown Error';
  const gb10Reading = gb10Sample as unknown as Sample;
  const backendDown = (s: Sample): Sample => ({ ...s, gpu: [], errors: { gpu: `nvml: ${NVML_DOWN}` } });
  const lostReason = (i: number) => `NVML could not open GPU ${String(i)} (NVML: GPU is lost)`;

  it('says a GB10 whose GPU is missing from the sample is not responding, with its backend error', () => {
    for (const field of ['util', 'temp_c', 'power_w'] as const) {
      expect(totalGap(gb10, backendDown(gb10Reading), field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: `GPU 0 not responding (${NVML_DOWN}).`, silent: true });
    }
  });

  it('says a GB10 whose GPU sends no power reading has no total, with no sum to understate', () => {
    expect(totalGap(gb10, withGpu(gb10Reading, 0, { power_w: null }), 'power_w')).toEqual({ kind: 'hardware', label: 'No total', detail: 'GPU 0 sent no power reading this tick.', silent: true });
    expect(totalGap(gb10, gb10Reading, 'power_w')).toBeNull();
  });

  it('says ws1 is not responding, not that it has no total, while none of its GPUs is in the sample', () => {
    for (const field of ['util', 'temp_c', 'power_w'] as const) {
      expect(nodeTotalGap(ws1, backendDown(sample), field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: `GPUs 0, 1, 2 and 3 not responding (${NVML_DOWN}).`, silent: true });
    }
  });

  it('names the lost GPU first while GPU 0 is lost and its backend drops the other three', () => {
    const info = lostGpu0({ metric: 'gpu.power_w', reason: `GPU 0: ${LOST}`, kind: 'hardware' });
    for (const field of ['util', 'power_w'] as const) {
      expect(nodeTotalGap(info, backendDown(sample), field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: `GPU 0: ${LOST}; GPUs 1, 2 and 3 not responding (${NVML_DOWN}).`, silent: true });
    }
  });

  it('says ws1 is not responding while every GPU is lost, though the agent declares its totals', () => {
    const info = ws1With(
      ...[0, 1, 2, 3].map((i): Unsupported => ({ metric: `gpu${String(i)}`, reason: lostReason(i), kind: 'hardware' })),
      ...(['util', 'temp_c', 'power_w'] as const).map((f): Unsupported => ({ metric: `gpu.${f}`, reason: `GPU 0: ${lostReason(0)}`, kind: 'hardware' })),
    );
    const s = { ...sample, gpu: [0, 1, 2, 3].map((index) => ({ index })) } as Sample;
    for (const field of ['util', 'temp_c', 'power_w'] as const) {
      expect(nodeTotalGap(info, s, field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: `${[0, 1, 2, 3].map((i) => `GPU ${String(i)}: ${lostReason(i)}`).join('; ')}.`, silent: true });
    }
  });
});

describe('a GPU that stays in the sample with every fresh reading empty, as NVML sends it when its reads fail', () => {
  const gb10Reading = gb10Sample as unknown as Sample;

  it('says a GB10 whose GPU sends only its energy counter and capped shares is not responding, as if it were missing', () => {
    for (const field of ['util', 'temp_c', 'power_w'] as const) {
      expect(nodeGpuGap(gb10, emptied(gb10Reading, [0]), field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: 'GPU 0 sent no reading this tick.', silent: true });
      expect(nodeGpuGap(gb10, gb10Reading, field)).toBeNull();
    }
  });

  it('says ws1 is not responding while all four GPUs send only those readings', () => {
    for (const field of ['util', 'temp_c', 'power_w'] as const) {
      expect(nodeTotalGap(ws1, emptied(sample, [0, 1, 2, 3]), field)).toEqual({ kind: 'hardware', label: 'Not responding', detail: 'GPUs 0, 1, 2 and 3 sent no reading this tick.', silent: true });
    }
  });

  it('names an empty GPU beside answering ones as sending no reading at all, not as missing its power', () => {
    expect(totalGap(ws1, emptied(sample, [2]), 'power_w')?.detail).toBe('GPU 2 sent no reading this tick, so a sum would understate.');
  });

  it('cannot tell the processes of such a GPU once it is quiet', () => {
    expect(gpuProcessesGap(gb10, emptied(gb10Reading, [0]), [0])?.label).toBe('Not responding');
    expect(gpuProcessesGap(gb10, emptied(gb10Reading, [0]), [])).toBeNull();
  });
});

describe('how long a silent GPU has sent nothing', () => {
  const gb10Reading = gb10Sample as unknown as Sample;
  const raised = (s: Sample, error: string): Sample => ({ ...s, gpu: [], errors: { ...s.errors, gpu: `nvml: ${error}` } });

  it('says GPU 2 has sent no reading for 40 s once it has been silent that long', () => {
    expect(totalGap(ws1, emptied(sample, [2]), 'power_w', () => 40)?.detail).toBe('GPU 2 has sent no reading for 40\u00a0s, so a sum would understate.');
  });

  it('still says this tick for a silence of 0 s, or one the caller cannot time', () => {
    for (const silentFor of [() => 0, () => null, undefined]) {
      expect(totalGap(ws1, emptied(sample, [2]), 'power_w', silentFor)?.detail).toBe('GPU 2 sent no reading this tick, so a sum would understate.');
    }
  });

  it('gives a group of silent GPUs the shortest of their silences, as the banner does', () => {
    expect(nodeTotalGap(ws1, emptied(sample, [0, 1, 2, 3]), 'util', (i) => 40 + i)?.detail).toBe('GPUs 0, 1, 2 and 3 have sent no reading for 40\u00a0s.');
  });

  it('says how long a GPU whose backend raised has not responded, beside the error', () => {
    expect(nodeGpuGap(gb10, raised(gb10Reading, 'RuntimeError: boom'), 'power_w', () => 43)?.detail).toBe('GPU 0 not responding for 43\u00a0s (RuntimeError: boom).');
  });

  it('says how long in why the GPU processes are not known', () => {
    expect(gpuProcessesGap(gb10, emptied(gb10Reading, [0]), [0], () => 40)?.detail).toBe('GPU 0 has sent no reading for 40\u00a0s.');
  });
});
