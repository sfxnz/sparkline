import { act, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { NodeInfo, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { liveStore } from '../../../store/live';
import sampleJson from '../../../test/fixtures/sample.json';
import wsInfo from '../../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../../test/fixtures/platforms/workstation/sample.json';
import { ThrottleNotice } from './Notices';

describe('ThrottleNotice (Summary tab)', () => {
  it("explains only the worst reason under its heading, and points to the GPU tab for the rest", () => {
    const base = sampleJson as unknown as Sample;
    const gpu = base.gpu.map((g) => ({ ...g, throttle_mask: 0x4 | 0x20 | 0x40 })); // power cap, thermal, overheating
    act(() => {
      liveStore.pushSample({ ...base, node_id: 'nt1', ts: 1000, gpu });
      liveStore.flush();
    });
    render(
      <Router hook={memoryLocation({ path: '/' }).hook}>
        <ThrottleNotice nodeId="nt1" />
      </Router>,
    );
    expect(screen.getByText(/^Critical: Clocks limited by/)).toBeInTheDocument();
    const msg = document.querySelector('.nnote__msg')?.textContent ?? '';
    expect(msg).toMatch(/The GPU tab explains the others\.$/);
    expect(msg).not.toContain('Normal under sustained heavy load'); // the power cap's calm note is not mixed in
    liveStore.removeNode('nt1');
  });

  it.each([
    ['only GPU 3 is cut by overheating', { 3: 0x40 }, 'Critical: GPU 3: Clocks limited by overheating.', false],
    ['GPUs 1 and 2 share a thermal limit while GPU 3 idles', { 1: 0x20, 2: 0x20, 3: 0x1 }, 'Warning: GPUs 1 and 2: Clocks limited by thermal limit.', false],
    ['GPU 3 overheats while GPU 1 is at its thermal limit', { 1: 0x20, 3: 0x40 }, 'Critical: GPU 3: Clocks limited by overheating.', true],
  ])('names the GPUs on a four-GPU node when %s', (_, masks: Record<number, number>, heading, others) => {
    const reading = wsSample as unknown as Sample;
    useCluster.setState({ nodes: { ws1: { node_id: 'ws1', url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info: wsInfo as unknown as NodeInfo, next_retry_ts: null } } });
    act(() => {
      liveStore.pushSample({ ...reading, ts: 1000, gpu: reading.gpu.map((g) => ({ ...g, throttle_mask: masks[g.index] ?? 0 })) });
      liveStore.flush();
    });
    render(
      <Router hook={memoryLocation({ path: '/' }).hook}>
        <ThrottleNotice nodeId="ws1" />
      </Router>,
    );
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(document.querySelector('.nnote__msg')?.textContent.endsWith('The GPU tab explains the others.')).toBe(others);
    liveStore.removeNode('ws1');
  });
});
