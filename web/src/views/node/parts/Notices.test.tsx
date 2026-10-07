import { act, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { Sample } from '../../../lib/types';
import { liveStore } from '../../../store/live';
import sampleJson from '../../../test/fixtures/sample.json';
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
});
