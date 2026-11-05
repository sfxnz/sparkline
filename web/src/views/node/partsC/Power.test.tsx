import { act, render, screen } from '@testing-library/react';
import gb10Info from '../../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../../test/fixtures/platforms/gb10/sample.json';
import type { NodeInfo, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { liveStore } from '../../../store/live';
import { PowerPanel } from './Power';

vi.mock('../../../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

const now = Date.now() / 1000;
const info = gb10Info as unknown as NodeInfo;
const reading = gb10Sample as unknown as Sample;

const show = (sample: Sample) => {
  useCluster.setState({ clockOffset: 0, nodes: { spark1: { node_id: 'spark1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, info, next_retry_ts: null } } });
  act(() => {
    liveStore.removeNode('spark1');
    liveStore.pushSample({ ...sample, ts: now });
    liveStore.flush();
  });
  render(<PowerPanel nodeId="spark1" info={info} range="live" stale={false} updatedAt={null} />);
  return screen.getByText('Now', { selector: '.stat__label' }).closest('.stat') as HTMLElement;
};

describe('the GPU power panel on a GB10', () => {
  it('reads the GPU power now', () => {
    expect(show(reading)).toHaveTextContent(/^Now24\.5W$/);
  });

  it('reads Not responding as the power now while the GPU sends no reading', () => {
    expect(show({ ...reading, gpu: [], errors: { gpu: 'nvml: NVMLError_Unknown: Unknown Error' } })).toHaveTextContent('Not responding');
  });
});
