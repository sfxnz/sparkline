import { act, fireEvent, render, screen } from '@testing-library/react';
import sampleJson from '../test/fixtures/sample.json';
import type { CoreInfo, Sample } from '../lib/types';
import { LiveStore } from '../store/live';
import { Heatmap } from './Heatmap';

const base = sampleJson as unknown as Sample;
const mk = (ts: number, util: number): Sample => ({ ...base, node_id: 'spark1', ts, cpu: { ...base.cpu, per_core: [util, util, util] } });
const cores: CoreInfo[] = [0, 1, 2].map((id) => ({ id, kind: 'performance', model: null, max_mhz: null, cluster: null }));

describe('Heatmap', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('readout changes only on arrow keys, not when new samples arrive', () => {
    let t = 10_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const frames: (() => void)[] = [];
    const store = new LiveStore(16, (cb) => frames.push(cb));
    const now = Date.now() / 1000;
    store.pushSample(mk(now - 1, 35));
    render(<Heatmap node="spark1" cores={cores} store={store} />);
    const img = screen.getByRole('img');
    img.focus();
    fireEvent.keyDown(img, { key: 'ArrowDown' });
    const live = img.parentElement?.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('Core 0 · Performance: 35% now');
    const label = img.getAttribute('aria-label');

    t += 6000; // past the 5 s summary cadence
    act(() => {
      store.pushSample(mk(now, 80));
      frames.splice(0).forEach((f) => { f(); });
    });
    expect(live).toHaveTextContent('Core 0 · Performance: 35% now');
    expect(img.getAttribute('aria-label')).toBe(label);

    fireEvent.keyDown(img, { key: 'ArrowDown' });
    expect(live).toHaveTextContent('Core 1 · Performance: 80% now');
    clock.mockRestore();
  });
});
