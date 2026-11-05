import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import type { ConsoleSettings, NodeInfo } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { run } from './fixtures';
import type { ChartSeries } from './RunChart';
import { RunTelemetry } from './RunTelemetry';

interface Shown {
  title: string;
  series: readonly ChartSeries[];
  loading?: boolean;
}
const shown = new Map<string, Shown>();
vi.mock('./RunChart', () => ({
  RunChart: (p: Shown) => {
    shown.set(p.title, p);
    return null;
  },
}));

const SPARK1 = gb10Info as unknown as NodeInfo;
const T0 = 1_759_750_000;
const READ = [1e9, 2e9, 1e9];
const asked: string[][] = [];

beforeEach(() => {
  shown.clear();
  asked.length = 0;
  useCluster.setState({ cluster: null, order: [], nodes: {}, clockOffset: 0 });
  liveStore.removeNode('spark1');
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const keys = (new URLSearchParams(url.split('?')[1]).get('keys') ?? '').split(',').filter(Boolean);
      asked.push(keys);
      const body = { node_id: 'spark1', resolution_s: 30, ts: [T0, T0 + 30, T0 + 60], series: Object.fromEntries(keys.map((k) => [k, READ])), min: {}, max: {} };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const hello = () => {
  act(() => {
    useCluster.getState().setHello({
      nodes: [{ node_id: 'spark1', url: '', status: 'online', since: 0, last_sample_ts: null, error: null, info: SPARK1, next_retry_ts: null }],
      settings: {} as ConsoleSettings,
      demo: true,
      version: '',
      server_time: Date.now() / 1000,
    });
  });
};

describe('telemetry of a finished run opened before the console has sent its nodes', () => {
  const fio = run({ id: 'fio', bench_id: 'storage-fio', nodes: ['spark1'], started_ts: T0, finished_ts: T0 + 60 });
  const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  it('shows the charts loading, not empty, until the node is known', async () => {
    render(<RunTelemetry run={fio} category="storage" expected={60} />);
    await settled();
    expect([...shown.values()].map((c) => [c.title, c.loading])).toEqual([['Disk read', true], ['Disk write', true], ['Disk busy', true]]);
  });

  it("asks the history for the node's disks once it is known, and charts them", async () => {
    render(<RunTelemetry run={fio} category="storage" expected={60} />);
    await settled();
    hello();
    await waitFor(() => { expect(shown.get('Disk read')?.series[0]?.values).toEqual(READ); });
    expect([...shown.values()].map((c) => c.loading)).toEqual([false, false, false]);
    expect(asked.at(-1)).toEqual(['disk.nvme0n1.read_bps', 'disk.nvme0n1.write_bps', 'disk.nvme0n1.busy_pct']);
  });
});
