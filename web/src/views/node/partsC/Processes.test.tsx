import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import sampleJson from '../../../test/fixtures/sample.json';
import type { NodeState, ProcSample, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import Processes from '../Processes';
import { VIEW_KEY } from './procs';

const GiB = 1024 ** 3;
const base = sampleJson as unknown as Sample;
const proc = (pid: number, over: Partial<ProcSample>): ProcSample => ({
  pid, name: `p${pid}`, cmdline: `/usr/bin/p${pid} --flag`, user: 'root', cpu_pct: 1, rss: 10 << 20, gpu_mem: null, gpu_util: null, container: null, model: null, ...over,
});
const PROCS = [
  proc(10, { name: 'dockerd', rss: 112 << 20 }),
  proc(20, { name: 'python', cmdline: 'python serve_stats.py --model /models/DeepSeek --tp 2', gpu_mem: 80 * GiB, gpu_util: 91, container: 'c5-2B-r0', model: 'DeepSeek-V4.1-Flash-EXL3', cpu_pct: 160 }),
  proc(30, { name: 'trainer', gpu_mem: 4 * GiB, gpu_util: null }),
];
const NODE = 'ptest';
let ts = 1_800_000_000;
const push = (procs: ProcSample[] | null) => {
  ts += 1;
  act(() => {
    liveStore.pushSample({ ...base, node_id: NODE, ts, procs });
    liveStore.flush();
  });
};
const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: ts, last_sample_ts: ts, error: null, info: null, next_retry_ts: null };
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1] as HTMLElement).getAllByRole('row');

describe('Processes tab', () => {
  beforeEach(() => {
    sessionStorage.clear();
    liveStore.removeNode(NODE);
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
    useConnection.setState({ status: 'live', everLive: true });
  });

  it('sorts by GPU memory by default, keeps the list on ticks without processes, and re-sorts on header click', async () => {
    push(PROCS);
    render(<Processes nodeId={NODE} />);
    expect(bodyRows().map((r) => r.textContent)).toEqual([expect.stringContaining('python'), expect.stringContaining('trainer'), expect.stringContaining('dockerd')]);
    expect(screen.getByRole('columnheader', { name: /GPU memory/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByText('The 3 biggest consumers · 2 on the GPU using 84.0 GiB')).toBeInTheDocument();

    push(null); // a tick between process refreshes
    expect(bodyRows()).toHaveLength(3);

    await userEvent.click(screen.getByRole('button', { name: /Memory \(RSS\)/ }));
    expect(screen.getByRole('columnheader', { name: /Memory \(RSS\)/ })).toHaveAttribute('aria-sort', 'descending');
    expect(bodyRows()[0]).toHaveTextContent('dockerd');
    expect(JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '{}')).toMatchObject({ sort: { id: 'rss', dir: 'desc' } });
  });

  it('filters, offers to clear an empty result, and expands a row to show the full command line', async () => {
    push(PROCS);
    render(<Processes nodeId={NODE} />);
    const input = screen.getByRole('searchbox', { name: 'Filter processes' });
    await userEvent.type(input, 'deepseek');
    expect(bodyRows()).toHaveLength(1);
    await userEvent.clear(input);
    await userEvent.type(input, 'nothing-matches');
    expect(screen.getByText('No processes match “nothing-matches”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all processes' }));
    expect(bodyRows()).toHaveLength(3);

    const toggle = screen.getByRole('button', { name: 'Show details for python (PID 20)' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('python serve_stats.py --model /models/DeepSeek --tp 2', { selector: 'code' })).toBeInTheDocument();
  });

  it('explains a missing GPU utilisation only for processes on the GPU', () => {
    push(PROCS);
    render(<Processes nodeId={NODE} />);
    expect(screen.getAllByRole('button', { name: 'GPU utilisation not reported for this process' })).toHaveLength(1);
  });

  it('shows an empty state for an empty list and a loading state before the first list', () => {
    push(null);
    const { unmount } = render(<Processes nodeId={NODE} />);
    expect(screen.getByText('Waiting for the first process list…')).toBeInTheDocument();
    unmount();
    push([]);
    render(<Processes nodeId={NODE} />);
    expect(screen.getByText('No processes reported')).toBeInTheDocument();
  });
});
