import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../lib/api';
import type { NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { usePrefs } from '../store/prefs';
import { HistoryUnavailable } from './HistoryUnavailable';

const node = (status: NodeState['status']): NodeState => ({ node_id: 'spark3', url: '', status, since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null });
const body = JSON.stringify({ problem: { message: 'Agent unreachable on spark3', cause: 'Connection refused at 10.20.20.61:9750', fix: 'Check `systemctl status sparkline-agent` on spark3' } });
const apiError = new ApiError('server', 503, body.slice(0, 300), body);

describe('HistoryUnavailable', () => {
  beforeEach(() => { usePrefs.setState({ timeRange: '1h' }); });

  it("shows the console's problem as plain text, never the raw JSON body", () => {
    useCluster.setState({ nodes: { spark3: node('online') } });
    const { container } = render(<HistoryUnavailable node="spark3" error={apiError} onRetry={() => undefined} />);
    expect(screen.getByText('Agent unreachable on spark3')).toBeInTheDocument();
    expect(screen.getByText('Connection refused at 10.20.20.61:9750')).toBeInTheDocument();
    expect(container.textContent).not.toContain('{');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says once, in plain words, that an unreachable node has no history, and offers Live', async () => {
    useCluster.setState({ nodes: { spark3: node('offline') } });
    render(<HistoryUnavailable node="spark3" error={apiError} onRetry={() => undefined} />);
    expect(screen.getByText('spark3 is unreachable')).toBeInTheDocument();
    expect(screen.queryByText(/Connection refused/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show live' }));
    expect(usePrefs.getState().timeRange).toBe('live');
  });
});
