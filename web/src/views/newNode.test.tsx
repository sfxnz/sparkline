// A node that has never answered the console is "Not connected yet" on every surface that names a node's status:
// the sidebar, the wall tile, the node page and Settings > About. Never Offline, Error or Critical.
import { render, screen, within } from '@testing-library/react';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Shell } from '../app/Shell';
import type { NodeState } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useEvents } from '../store/events';
import Node from './Node';
import { AboutSection } from './settings/AboutSection';
import { WallTile } from './wall/WallTile';

// Tab bodies are lazy chunks with charts; the header is what this test reads.
vi.mock('./node/tabs', () => ({ TAB_COMPONENTS: new Proxy({}, { get: () => () => null }) }));

const now = Date.now() / 1000;
const refused: NodeState = {
  node_id: 'spark1', url: 'http://192.168.1.11:9750', status: 'offline', since: now, last_sample_ts: null, info: null, next_retry_ts: now + 20, first_seen: null,
  error: { message: 'Agent unreachable on spark1', cause: 'Connection refused at 192.168.1.11:9750', fix: 'Check `systemctl status sparkline-agent` on spark1' },
};
const rejected: NodeState = {
  ...refused, node_id: 'spark2', url: 'http://192.168.1.12:9750', status: 'error',
  error: { message: 'Agent on spark2 rejected the console’s token', cause: 'HTTP 403 from 192.168.1.12:9750: agent token mismatch', fix: '`agent_token` in `/etc/sparkline/console.toml` must equal `token` in `/etc/sparkline/agent.toml` on spark2.' },
};
const BAD = /\b(offline|error|critical)\b/i;

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLCanvasElement.prototype.getContext = () => null;
});

beforeEach(() => {
  useConnection.setState({ status: 'live', everLive: true });
  useEvents.setState({ events: [], load: { status: 'ready' } });
  useCluster.setState({
    cluster: { nodes: [refused, rejected], settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 }, demo: false, version: '0.3.0', server_time: now },
    clockOffset: 0, order: ['spark1', 'spark2'], nodes: { spark1: refused, spark2: rejected }, onboarding: { started: now, finished: null, reopened: false, seen: [] },
  });
});

describe('a node that has never answered', () => {
  it('reads "Not connected" in the sidebar', () => {
    render(<Router hook={memoryLocation({ path: '/settings' }).hook}><Shell /></Router>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const id of ['spark1', 'spark2']) {
      const link = within(nav).getByRole('link', { name: new RegExp(`^${id}`) });
      expect(link).toHaveTextContent('Not connected');
      expect(link.textContent).not.toMatch(BAD);
    }
  });

  it('reads "Not connected yet" on its wall tile', () => {
    render(<WallTile id="spark2" />);
    const tile = screen.getByRole('region', { name: 'Node spark2' });
    expect(within(tile).getByText('Not connected yet')).toBeInTheDocument();
    expect(tile.querySelector('.status')?.textContent).not.toMatch(BAD);
    // The line under it says what the console met, without the slash that marks a node gone offline.
    expect(within(tile).getByText('Agent on spark2 rejected the console’s token').closest('p')?.querySelector('svg')).toBeNull();
  });

  it('states nothing about its links on the wall: a dash, like its other figures', () => {
    render(<WallTile id="spark2" />);
    const stats = [...screen.getByRole('region', { name: 'Node spark2' }).querySelectorAll('.wall-tile__stats > div')];
    expect(stats.map((s) => s.textContent)).toEqual(['GPU temperature—', 'GPU power—', 'Memory available—', 'Interconnect in + out—']);
  });

  it('keeps the slash on the wall tile of a node that has answered before and is down', () => {
    useCluster.setState({ nodes: { spark1: { ...refused, first_seen: now - 60 } } });
    render(<WallTile id="spark1" />);
    const tile = screen.getByRole('region', { name: 'Node spark1' });
    expect(within(tile).getByText('Offline')).toBeInTheDocument();
    expect(within(tile).getByText('Agent unreachable on spark1').closest('p')?.querySelector('svg')).not.toBeNull();
  });

  it('reads "Not connected yet" in the header of its own page', () => {
    render(<Router hook={memoryLocation({ path: '/node/spark2' }).hook}><Route path="/node/:id/:tab?" component={Node} /></Router>);
    expect(document.querySelector('.nhead .status')).toHaveTextContent('Not connected yet');
  });

  it('reads "Not connected yet" in Settings > About', () => {
    render(<AboutSection />);
    for (const id of ['spark1', 'spark2']) {
      const row = screen.getByRole('row', { name: new RegExp(`^${id} `) });
      expect(within(row).getByText('Not connected yet')).toBeInTheDocument();
      expect(row.textContent).not.toMatch(BAD);
    }
  });

  it('is an ordinary offline node once it has answered', () => {
    useCluster.setState({ nodes: { spark1: { ...refused, first_seen: now - 60 }, spark2: rejected } });
    render(<AboutSection />);
    expect(within(screen.getByRole('row', { name: /^spark1 / })).getByText('Offline')).toBeInTheDocument();
  });
});
