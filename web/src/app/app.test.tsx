import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import sampleJson from '../test/fixtures/sample.json';
import { ApiError } from '../lib/api';
import type { ClusterState, Event, NodeState, Sample } from '../lib/types';
import { announcer } from '../design/components/LiveAnnouncer';
import { useCluster } from '../store/cluster';
import { useEvents } from '../store/events';
import { liveStore } from '../store/live';
import { dispatch } from '../store/session';
import { useUi } from '../store/ui';
import { CommandPalette } from './CommandPalette';
import { connectionLabel } from './ConnectionIndicator';
import { problemCopy } from './ConnectionProblem';
import { loginErrorCopy } from './Login';
import { documentTitle, pageTitle } from './routes';

const cluster: ClusterState = {
  nodes: ['spark1', 'spark2'].map((id) => ({ node_id: id, url: `http://${id}:9750`, status: 'online', since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null })),
  settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: true,
  version: '0.1.0',
  server_time: Date.now() / 1000,
};

describe('connection copy', () => {
  it('labels each connection state with text', () => {
    expect(connectionLabel({ status: 'live', retryAt: null }, 0).text).toBe('Live');
    expect(connectionLabel({ status: 'reconnecting', retryAt: 4000 }, 0).text).toBe('Reconnecting in 4 s');
    expect(connectionLabel({ status: 'reconnecting', retryAt: 100 }, 200).text).toBe('Reconnecting…');
    expect(connectionLabel({ status: 'offline', retryAt: null }, 0).text).toBe('Offline');
  });
  it('explains the no-backend state with a concrete fix', () => {
    expect(problemCopy({ status: 'reconnecting', lastError: 'unreachable' })).toMatchObject({ title: 'Can’t reach Sparkline' });
    expect(problemCopy({ status: 'reconnecting', lastError: 'unreachable' }).fix).toContain('`sparkline --demo`');
    expect(problemCopy({ status: 'offline', lastError: null }).title).toMatch(/offline/);
  });
  it('explains a wrong token', () => {
    expect(loginErrorCopy(new ApiError('unauthorized', 401, '')).title).toMatch(/wasn’t accepted/);
    expect(loginErrorCopy(new ApiError('unreachable', 0, '')).title).toMatch(/Can’t reach/);
  });
  it('titles pages', () => {
    expect(pageTitle('/')).toBe('Overview');
    expect(pageTitle('/node/spark2/gpu')).toBe('spark2');
    expect(pageTitle('/benchmarks/compare')).toBe('Benchmarks');
    expect(documentTitle('/alerts')).toBe('Alerts · Sparkline');
    expect(documentTitle('/node/spark2/gpu')).toBe('spark2 · Sparkline');
    expect(documentTitle('/wall')).toBe('Wall mode · Sparkline');
    expect(documentTitle('/login')).toBe('Sign in · Sparkline');
    expect(documentTitle('/nowhere')).toBe('Sparkline');
  });
});

describe('message dispatch', () => {
  it('routes hello, samples, node status and events into the stores; announces only warning/critical', () => {
    const spy = vi.spyOn(announcer, 'announce');
    dispatch({ type: 'hello', cluster });
    expect(useCluster.getState().order).toEqual(['spark1', 'spark2']);
    dispatch({ type: 'sample', node_id: 'spark1', sample: { ...(sampleJson as unknown as Sample), ts: 123 } });
    expect(liveStore.lastTs('spark1')).toBe(123);
    dispatch({ type: 'node_status', node: { ...(cluster.nodes[1] as NodeState), status: 'offline' } });
    expect(useCluster.getState().nodes.spark2?.status).toBe('offline');
    const ev = (id: number, severity: Event['severity']): Event => ({ id, ts: id, node_id: 'spark2', severity, kind: 'node', rule_id: null, title: `t${id}`, detail: '', metric: null, value: null, resolved_ts: null, acked: false });
    dispatch({ type: 'event', event: ev(1, 'info') });
    dispatch({ type: 'event', event: ev(2, 'critical') });
    expect(useEvents.getState().events.map((e) => e.id)).toEqual([2, 1]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Critical: t2', 'critical');
    spy.mockRestore();
  });
});

describe('CommandPalette', () => {
  it('is a combobox over a grouped listbox; filters fuzzily and runs with Enter', async () => {
    const user = userEvent.setup();
    useCluster.getState().setHello(cluster);
    const loc = memoryLocation({ path: '/', record: true });
    render(
      <Router hook={loc.hook}>
        <CommandPalette />
      </Router>,
    );
    act(() => { useUi.getState().setPalette(true); });
    const input = screen.getByRole('combobox', { name: /Search views/ });
    expect(input).toHaveFocus();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby') && g.textContent ? true : false)).not.toContain(false);
    for (const name of ['Go to', 'Nodes', 'Actions']) expect(screen.getByRole('group', { name })).toBeInTheDocument();
    await user.type(input, 'sp2 gpu');
    const active = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');
    expect(active).toHaveTextContent('spark2 › GPU');
    expect(input).toHaveAttribute('aria-activedescendant', active?.id);
    await user.keyboard('{Enter}');
    expect(loc.history).toContain('/node/spark2/gpu');
    expect(useUi.getState().paletteOpen).toBe(false);
  });
});
