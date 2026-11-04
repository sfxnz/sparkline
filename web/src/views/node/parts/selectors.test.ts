import { act, renderHook } from '@testing-library/react';
import type { NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useLiveConditions } from '../../../store/attention';
import { useCluster } from '../../../store/cluster';
import { liveStore } from '../../../store/live';
import sampleJson from '../../../test/fixtures/sample.json';
import { clockLevel, selectThrottleMask } from './Notices';
import { gpuEnergy, gpuPower, gpuPstate, gpuSm, gpuTemp, gpuUtil } from './selectors';

const onlyOthers = { gpu: [{ index: 1, util: 37, sm_mhz: 2900, temp_c: 99, power_w: 140, pstate: 2, energy_j: 5, throttle_mask: 0x40 }] } as unknown as Sample;

describe('GPU 0 selectors on a sample without GPU 0', () => {
  it.each([gpuUtil, gpuSm, gpuTemp, gpuPower, gpuPstate, gpuEnergy, selectThrottleMask])('%o reads nothing rather than GPU 1', (select) => {
    expect(select(onlyOthers)).toBeNull();
  });
  it('gives no clock level from another GPU', () => {
    expect(clockLevel(onlyOthers, 3000)).toBeNull();
  });
  it('picks GPU 0 wherever it sits', () => {
    const both = { gpu: [...onlyOthers.gpu, { index: 0, util: 91 }] } as unknown as Sample;
    expect(gpuUtil(both)).toBe(91);
  });
});

describe('node attention on a sample without GPU 0', () => {
  it("does not raise GPU 0's slowdown from another GPU's temperature", () => {
    const base = sampleJson as unknown as Sample;
    const info = { gpus: [{ index: 0, temp_slowdown_c: 86 }, { index: 1, temp_slowdown_c: 110 }] } as unknown as NodeInfo;
    const node = { node_id: 'att', status: 'online', info } as unknown as NodeState;
    useCluster.setState({ nodes: { att: node } });
    act(() => {
      liveStore.pushSample({ ...base, node_id: 'att', ts: 1000, gpu: [{ ...base.gpu[0], index: 1, temp_c: 99, throttle_mask: 0 }] });
      liveStore.flush();
    });
    const { result } = renderHook(() => useLiveConditions(['att']));
    expect(result.current.att).toBeNull();
    liveStore.removeNode('att');
  });
});
