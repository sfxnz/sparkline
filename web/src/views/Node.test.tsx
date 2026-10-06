import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { NodeNotice } from './Node';

const now = Date.now() / 1000;
const base: NodeState = { node_id: 'spark2', url: 'http://10.20.20.195:9750', status: 'online', since: now, last_sample_ts: now - 12, error: null, info: null, next_retry_ts: null };
const setNode = (n: Partial<NodeState>) => { useCluster.setState({ clockOffset: 0, nodes: { spark2: { ...base, ...n } } }); };
const setConn = (status: 'live' | 'reconnecting') => { useConnection.setState({ status, everLive: true }); };

describe('NodeNotice', () => {
  beforeEach(() => { setConn('live'); });

  it('renders nothing while the node is online', () => {
    setNode({});
    const { container } = render(<NodeNotice id="spark2" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says values are not live when the browser has lost the console, even if the last status was online', () => {
    setNode({});
    setConn('reconnecting');
    render(<NodeNotice id="spark2" />);
    expect(screen.getByText('No new data from spark2')).toBeInTheDocument();
    expect(screen.getByText(/Lost the connection to Sparkline\. Last sample 12 s ago\. Values are not live\./)).toBeInTheDocument();
  });

  it('says data is not live when the node is stale', () => {
    setNode({ status: 'stale' });
    render(<NodeNotice id="spark2" />);
    expect(screen.getByText('No new data from spark2')).toBeInTheDocument();
    expect(screen.getByText(/Last sample 12 s ago\. Values are not live\./)).toBeInTheDocument();
  });

  it('shows the console Problem copy when offline and retries the node on demand', async () => {
    setNode({
      status: 'offline',
      error: { message: 'Agent unreachable on spark2', cause: 'Connection refused at 10.20.20.195:9750', fix: 'Check `systemctl status sparkline-agent` on spark2' },
      next_retry_ts: now + 4,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(base), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<NodeNotice id="spark2" />);
    expect(screen.getByText('Agent unreachable on spark2')).toBeInTheDocument();
    expect(screen.getByText('Connection refused at 10.20.20.195:9750')).toBeInTheDocument();
    expect(screen.getByText('systemctl status sparkline-agent')).toBeInTheDocument();
    expect(screen.getByText(/Retrying automatically in [45] s\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/nodes/spark2/retry', expect.objectContaining({ method: 'POST' }));
    fetchSpy.mockRestore();
  });
});
