import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { ClusterState, NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import Node, { NodeNotice } from './Node';

// Tab bodies are their own lazy chunks (charts need a real browser); here each one just names itself.
vi.mock('./node/tabs', () => {
  const tab = (name: string) => ({ nodeId }: { nodeId: string }) => <p>{`${name} of ${nodeId}`}</p>;
  return {
    TAB_COMPONENTS: {
      summary: tab('Summary'), gpu: tab('GPU'), memory: tab('Memory'), cpu: tab('CPU'),
      network: tab('Network'), storage: tab('Storage'), thermals: tab('Thermals'), processes: tab('Processes'),
    },
  };
});

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
    expect(screen.getByText('Not live: the connection to Sparkline was lost')).toBeInTheDocument();
    expect(screen.getByText(/Last known values · 12\ss ago/)).toBeInTheDocument();
  });

  it('says data is not live when the node is stale', () => {
    setNode({ status: 'stale' });
    render(<NodeNotice id="spark2" />);
    expect(screen.getByText('spark2 is not reporting')).toBeInTheDocument();
    expect(screen.getByText(/Last known values · 12\ss ago/)).toBeInTheDocument();
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
    expect(screen.getByText(/retrying in [45]\ss/)).toBeInTheDocument();
    // One compact banner, labelled for the node, with identity above it on the page.
    expect(screen.getByRole('region', { name: 'spark2 status' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/nodes/spark2/retry', expect.objectContaining({ method: 'POST' }));
    fetchSpy.mockRestore();
  });
});

describe('Node page', () => {
  const hello = (nodes: NodeState[]): ClusterState => ({
    nodes,
    settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
    demo: true,
    version: '0',
    server_time: Date.now() / 1000,
  });
  const renderAt = (path: string) => {
    const loc = memoryLocation({ path, record: true });
    render(
      <Router hook={loc.hook}>
        <Route path="/node/:id/:tab?" component={Node} />
      </Router>,
    );
    return loc;
  };

  beforeEach(() => {
    setConn('live');
    useCluster.getState().setHello(hello([base, { ...base, node_id: 'spark1' }]));
  });

  it('shows a designed not-found state with links to the known nodes', () => {
    renderAt('/node/nope');
    expect(screen.getByText('There is no node called “nope”')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'spark1' })).toHaveAttribute('href', '/node/spark1');
    expect(screen.getByRole('link', { name: 'Go to Overview' })).toBeInTheDocument();
  });

  it('selects the tab from the URL, defaults to Summary, and moves with the arrow keys', async () => {
    const user = userEvent.setup();
    const loc = renderAt('/node/spark2/gpu');
    expect(screen.getByRole('heading', { name: 'spark2' })).toBeInTheDocument();
    const gpu = screen.getByRole('tab', { name: 'GPU' });
    expect(gpu).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('GPU of spark2')).toBeInTheDocument();
    gpu.focus();
    await user.keyboard('{ArrowRight}');
    expect(loc.history.at(-1)).toBe('/node/spark2/memory');
    expect(await screen.findByText('Memory of spark2')).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(loc.history.at(-1)).toBe('/node/spark2');
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
  });
});
