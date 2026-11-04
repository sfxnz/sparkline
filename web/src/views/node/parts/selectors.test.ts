import { act, renderHook } from '@testing-library/react';
import { gpuAt } from '../../../lib/gpu';
import type { GpuSample, NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useLiveConditions } from '../../../store/attention';
import { useCluster } from '../../../store/cluster';
import { liveStore } from '../../../store/live';
import sampleJson from '../../../test/fixtures/sample.json';
import { clockLevel } from './Notices';
import { gpuSelector, nodeGpuSelector } from './selectors';

const onlyOthers = { gpu: [{ index: 1, util: 37, sm_mhz: 2900, temp_c: 99, power_w: 140, pstate: 2, energy_j: 5, throttle_mask: 0x40 }] } as unknown as Sample;

describe('GPU 0 selectors on a sample without GPU 0', () => {
  it.each(['util', 'sm_mhz', 'temp_c', 'power_w', 'pstate', 'energy_j', 'throttle_mask'] as const)('%s of GPU 0 reads nothing rather than GPU 1', (reading) => {
    expect(gpuSelector(0, reading)(onlyOthers)).toBeNull();
  });
  it('gives no clock level from another GPU', () => {
    expect(clockLevel(onlyOthers, 3000, 0)).toBeNull();
  });
  it('picks GPU 0 wherever it sits', () => {
    const both = { gpu: [...onlyOthers.gpu, { index: 0, util: 91 }] } as unknown as Sample;
    expect(gpuSelector(0, 'util')(both)).toBe(91);
  });
});

describe('node GPU selectors', () => {
  const sample = { gpu: [{ index: 0, util: 90, temp_c: 70, power_w: 250 }, { index: 1, util: 30, temp_c: 80, power_w: 200 }], errors: {} } as unknown as Sample;
  const one = { gpus: [{ index: 0 }] } as unknown as NodeInfo;
  const two = { gpus: [{ index: 0 }, { index: 1 }] } as unknown as NodeInfo;

  it("read a one-GPU node's own GPU", () => {
    expect(nodeGpuSelector(one, 'util')(sample)).toBe(90);
    expect(nodeGpuSelector(one, 'temp_c')(sample)).toBe(70);
  });
  it('read the totals on a node with several GPUs, as flatten writes them', () => {
    expect(nodeGpuSelector(two, 'util')(sample)).toBe(60);
    expect(nodeGpuSelector(two, 'temp_c')(sample)).toBe(80);
    expect(nodeGpuSelector(two, 'power_w')(sample)).toBe(450);
    expect(nodeGpuSelector(two, 'power_w')(null)).toBeNull();
  });
});

describe('node attention on a sample without GPU 0', () => {
  it("does not raise GPU 0's slowdown from another GPU's temperature", () => {
    const base = sampleJson as unknown as Sample;
    const info = { gpus: [{ index: 0, temp_slowdown_c: 86 }, { index: 1, temp_slowdown_c: 110 }], unsupported: [] } as unknown as NodeInfo;
    const node = { node_id: 'att', status: 'online', info } as unknown as NodeState;
    useCluster.setState({ nodes: { att: node } });
    act(() => {
      liveStore.pushSample({ ...base, node_id: 'att', ts: 1000, gpu: [{ ...(gpuAt(base.gpu, 0) as GpuSample), index: 1, temp_c: 99, throttle_mask: 0 }] });
      liveStore.flush();
    });
    const { result } = renderHook(() => useLiveConditions(['att']));
    expect(result.current.att).toBeNull();
    liveStore.removeNode('att');
  });
});
