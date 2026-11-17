// The overview on a first run: a node that has never answered gets a setup card with the whole fix, and the page
// says nothing is wrong. See lib/onboarding.ts for the rules these screens are drawn from.
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { ClusterState, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useEvents } from '../../store/events';
import { liveStore } from '../../store/live';
import { dispatch } from '../../store/session';
import sampleJson from '../../test/fixtures/sample.json';
import { preloadSummary } from '../node/tabs';
import Node from '../Node';
import Overview from '../Overview';

vi.mock('../../charts/TimeSeriesChart', async (importActual) => ({
  ...(await importActual<typeof import('../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: () => null,
}));

const now = Date.now() / 1000;
const fresh = (id: string, p: Partial<NodeState> = {}): NodeState => ({
  node_id: id, url: `http://192.168.1.11:9750`, status: 'connecting', since: now, last_sample_ts: null, error: null, info: null, next_retry_ts: null, first_seen: null, ...p,
});
const refused = (id: string): NodeState => fresh(id, {
  status: 'offline', next_retry_ts: now + 12,
  error: { message: `Agent unreachable on ${id}`, cause: 'Connection refused at 192.168.1.11:9750', fix: `Check \`systemctl status sparkline-agent\` on ${id}` },
});
const rejected = (id: string): NodeState => fresh(id, {
  status: 'error', url: 'http://192.168.1.12:9750', next_retry_ts: now + 30,
  error: { message: `Agent on ${id} rejected the console's token`, cause: 'HTTP 403 from 192.168.1.12:9750: agent token mismatch', fix: `agent_token in /etc/sparkline/console.toml must match token in /etc/sparkline/agent.toml on ${id}` },
});
const cluster = (nodes: NodeState[]): ClusterState => ({
  nodes, settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: false, version: 'test', server_time: now, onboarding: { started: now, finished: null, seen: [] },
});
const show = (nodes: NodeState[]) => {
  useCluster.getState().setHello(cluster(nodes));
  return render(<Overview />);
};
const ALARM = /\b(offline|critical|error|warning)\b/i;

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  HTMLCanvasElement.prototype.getContext = () => null;
});
beforeEach(() => {
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [] });
  for (const id of ['spark1', 'spark2', 'spark3']) liveStore.removeNode(id);
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => preloadSummary());

describe('a node that cannot be reached on a first run', () => {
  it('gets a setup card: what was tried, the likely cause and the whole fix, with its command to copy', () => {
    show([refused('spark1')]);
    const card = screen.getByRole('region', { name: 'Node spark1, not connected yet' });
    expect(within(card).getByText('Not connected yet')).toBeInTheDocument();
    expect(within(card).getByText('Tried 192.168.1.11:9750')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'The console tried spark1 at 192.168.1.11:9750 and nothing answered.' })).toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: 'Agent unreachable on spark1' })).toBeInTheDocument();
    expect(within(card).getByText('Likely cause').nextElementSibling).toHaveTextContent('Connection refused at 192.168.1.11:9750');
    expect(within(card).getByText('How to fix').nextElementSibling).toHaveTextContent('Check systemctl status sparkline-agent on spark1');
    expect(card.querySelector('.cmd__text')).toHaveTextContent('systemctl status sparkline-agent');
    expect(within(card).getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(within(card).getByText(/Trying again in/)).toHaveTextContent('Trying again in 12 s');
  });

  it('never calls it offline, critical or an error, anywhere on the page', () => {
    const { container } = show([refused('spark1'), rejected('spark2')]);
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Sparkline. spark1 and spark2 haven’t connected yet.' })).toBeInTheDocument();
    expect(container.querySelector('.tone-crit, .tone-warn')).toBeNull();
    for (const pill of container.querySelectorAll('.status')) expect(pill.textContent).not.toMatch(ALARM);
    // An agent that answered and said no is drawn as reached.
    expect(screen.getByRole('img', { name: 'The console reached the agent on spark2 at 192.168.1.12:9750, and the agent turned it away.' })).toBeInTheDocument();
    // A fix with no command has no copy button, and is still shown whole.
    const card = screen.getByRole('region', { name: 'Node spark2, not connected yet' });
    expect(within(card).getByText('agent_token in /etc/sparkline/console.toml must match token in /etc/sparkline/agent.toml on spark2')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Copy command' })).toBeNull();
  });

  it('retries on demand and says it is trying', async () => {
    show([refused('spark1')]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(fetch).toHaveBeenCalledWith('/api/v1/nodes/spark1/retry', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('Trying now…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeDisabled();
    // The console reports the outcome as a new wait.
    act(() => { dispatch({ type: 'node_status', node: { ...refused('spark1'), next_retry_ts: now + 2 } }); });
    expect(screen.getByText(/Trying again in/)).toHaveTextContent('Trying again in 2 s');
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();
  });

  it('puts one quiet line where totals, events and charts will be, until a node reports', () => {
    show([refused('spark1')]);
    expect(screen.getByText('Totals, events and charts start with the first reading')).toBeInTheDocument();
    expect(screen.getByText(/It fills in by itself the moment spark1 answers/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Cluster totals' })).toBeNull();
    expect(screen.queryByText('Recent events')).toBeNull();
  });

  it('says where it is looking while the first connection is being made', () => {
    show([fresh('spark1')]);
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Sparkline. Connecting to spark1…' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Node spark1' })).getByText('Reaching 192.168.1.11:9750')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the first reading. Nothing to do here.')).toBeInTheDocument();
  });

  it('becomes an ordinary live card, and the page fills in, when the node answers', () => {
    show([refused('spark1')]);
    act(() => {
      dispatch({ type: 'node_status', node: { ...refused('spark1'), status: 'online', error: null, next_retry_ts: null, first_seen: now } });
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'spark1', ts: now });
      liveStore.flush();
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Sparkline. spark1 is live.' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Node spark1, not connected yet' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Node spark1' })).getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cluster totals' })).toBeInTheDocument();
    expect(screen.queryByText('Totals, events and charts start with the first reading')).toBeNull();
  });

  it('keeps a live node normal beside a node that is still being set up', () => {
    useCluster.getState().setHello(cluster([fresh('spark1', { status: 'online', first_seen: now, last_sample_ts: now }), refused('spark2')]));
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'spark1', ts: now });
      liveStore.flush();
    });
    render(<Overview />);
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to Sparkline. spark1 is live, one more to connect.' })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 connected')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Node spark1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Node spark2, not connected yet' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cluster totals' })).toBeInTheDocument();
  });

  it('shows the same fix on the node’s own page, in place of tabs with nothing in them', () => {
    useCluster.getState().setHello(cluster([refused('spark1')]));
    render(<Router hook={memoryLocation({ path: '/node/spark1' }).hook}><Route path="/node/:id/:tab?" component={Node} /></Router>);
    const block = screen.getByRole('region', { name: 'spark1 is not connected yet' });
    expect(within(block).getByRole('heading', { level: 2, name: 'Agent unreachable on spark1' })).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText(/This page fills in by itself when spark1 answers/)).toBeInTheDocument();
  });
});
