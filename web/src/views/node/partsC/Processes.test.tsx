import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import sampleJson from '../../../test/fixtures/sample.json';
import { gpuAt } from '../../../lib/gpu';
import type { MemoryModel, NodeInfo, NodeState, ProcSample, Sample } from '../../../lib/types';
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

  it("draws a process's GPU memory as a share of system memory only where the GPU keeps its memory there", () => {
    const withModel = (memory: MemoryModel) => {
      const info = { gpus: [{ index: 0, name: 'GPU', memory }], mem_total: 128 * GiB, unsupported: [] } as unknown as NodeInfo;
      useCluster.setState({ nodes: { [NODE]: { ...node, info } } });
      return render(<Processes nodeId={NODE} />);
    };
    push(PROCS);
    const { container, unmount } = withModel('unified');
    expect(container.querySelectorAll('.procs__bar')).toHaveLength(2);
    unmount();
    expect(withModel('dedicated').container.querySelectorAll('.procs__bar')).toHaveLength(0);
    expect(bodyRows()[0]).toHaveTextContent('80.0 GiB');
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

describe('Processes tab on a node that cannot tell its GPU processes', () => {
  const NO_NVML = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
  const idle = [proc(10, { name: 'dockerd' }), proc(11, { name: 'bash' })];
  const gb10 = { gpus: [{ index: 0, name: 'NVIDIA GB10', vendor: 'nvidia', backend: 'nvml', memory: 'unified' }], mem_total: 128 * GiB, unsupported: [] } as unknown as NodeInfo;
  const show = (info: NodeInfo, sample: Partial<Sample>, ticks = 1) => {
    sessionStorage.clear();
    liveStore.removeNode(NODE);
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...node, info } } });
    act(() => {
      for (let i = 0; i < ticks; i++) {
        ts += 1;
        liveStore.pushSample({ ...base, node_id: NODE, ts, procs: idle, ...sample });
      }
      liveStore.flush();
    });
    return render(<Processes nodeId={NODE} />);
  };
  const subtitle = () => screen.getByText(/^The \d+ biggest/);
  const why = () => within(subtitle()).getByRole('button', { name: 'Why is this not reported?' });

  it('says a node without NVML cannot tell which processes use its GPUs, and why', () => {
    const noNvml = { gpus: [], mem_total: 128 * GiB, unsupported: [{ metric: 'gpu*', reason: NO_NVML, kind: 'dependency' }, { metric: 'mem.gpu', reason: NO_NVML, kind: 'dependency' }] } as unknown as NodeInfo;
    show(noNvml, { gpu: [] });
    expect(subtitle()).toHaveTextContent(/^The 2 biggest consumers · ptest cannot tell which processes use its GPUs Helper tool missing/);
    expect(why()).toHaveAccessibleDescription(NO_NVML);
  });

  it('says a GB10 whose GPU has sent no reading for 5 s cannot tell which processes use its GPU, and why', () => {
    show(gb10, { gpu: [], errors: { gpu: 'nvml: RuntimeError: NVML read failed' } }, 6);
    expect(subtitle()).toHaveTextContent(/^The 2 biggest consumers · ptest cannot tell which processes use its GPU Not responding/);
    expect(why()).toHaveAccessibleDescription('GPU 0 not responding (RuntimeError: NVML read failed).');
  });

  it('still counts none on the GPU on a GB10 that reports and runs none', () => {
    show(gb10, {});
    expect(subtitle()).toHaveTextContent(/^The 2 biggest consumers · 0 on the GPU$/);
  });
});

describe('Processes tab with an empty process list', () => {
  const NO_NVML = 'Install nvidia-ml-py to read NVIDIA GPU metrics';
  const refreshes = `${NODE} sent an empty process list. It refreshes every 5 seconds.`;
  beforeEach(() => {
    sessionStorage.clear();
    liveStore.removeNode(NODE);
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  });

  it('gives no count of consumers, and says when the list refreshes', () => {
    push([]);
    render(<Processes nodeId={NODE} />);
    expect(screen.queryByText(/biggest/)).not.toBeInTheDocument();
    expect(screen.getByText(refreshes)).toBeInTheDocument();
  });

  it('still says a node without NVML cannot tell which processes use its GPUs, and why', () => {
    const noNvml = { gpus: [], mem_total: 128 * GiB, unsupported: [{ metric: 'gpu*', reason: NO_NVML, kind: 'dependency' }] } as unknown as NodeInfo;
    useCluster.setState({ nodes: { [NODE]: { ...node, info: noNvml } } });
    push([]);
    render(<Processes nodeId={NODE} />);
    const said = screen.getByText(/cannot tell which processes use its GPUs/);
    expect(said).toHaveTextContent(/^ptest cannot tell which processes use its GPUs Helper tool missing/);
    expect(within(said).getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription(NO_NVML);
    expect(screen.queryByText(/biggest/)).not.toBeInTheDocument();
    expect(screen.getByText(refreshes)).toBeInTheDocument();
  });
});

describe('Processes tab while some of the GPUs send nothing', () => {
  const gpu = (index: number, name: string, vendor: string, backend: string) => ({ index, name, vendor, backend, memory: 'dedicated' });
  const reading = (index: number) => ({ ...gpuAt(base.gpu, 0), index }) as Sample['gpu'][number];
  const show = (info: NodeInfo, sample: Partial<Sample>, ticks: number) => {
    sessionStorage.clear();
    liveStore.removeNode(NODE);
    useCluster.setState({ clockOffset: 0, nodes: { [NODE]: { ...node, info } } });
    act(() => {
      for (let i = 0; i < ticks; i++) {
        ts += 1;
        liveStore.pushSample({ ...base, node_id: NODE, ts, procs: PROCS, ...sample });
      }
      liveStore.flush();
    });
    render(<Processes nodeId={NODE} />);
  };
  const subtitle = () => screen.getByText(/^The \d+ biggest/);
  const quad = { gpus: [0, 1, 2, 3].map((i) => gpu(i, 'NVIDIA RTX PRO 6000', 'nvidia', 'nvml')), mem_total: 128 * GiB, unsupported: [] } as unknown as NodeInfo;
  const hybrid = { gpus: [gpu(0, 'NVIDIA RTX 4090', 'nvidia', 'nvml'), gpu(1, 'Radeon RX 7900 XTX', 'amd', 'amdgpu-sysfs')], mem_total: 128 * GiB, unsupported: [] } as unknown as NodeInfo;

  it('counts the processes on the GPU from 3 of 4 GPUs while GPU 0 is lost', () => {
    const lost = { ...quad, unsupported: [{ metric: 'gpu0', reason: 'NVML could not open GPU 0 (NVML: GPU is lost)', kind: 'hardware' }] } as NodeInfo;
    show(lost, { gpu: [{ index: 0 } as Sample['gpu'][number], ...[1, 2, 3].map(reading)] }, 1);
    expect(subtitle()).toHaveTextContent(/^The 3 biggest consumers · 2 on the GPU using 84\.0 GiB \(3 of 4 GPUs\)$/);
  });

  it('counts the processes on the GPU from 1 of 2 GPUs once the NVIDIA GPU of a hybrid node has sent nothing for 5 s', () => {
    show(hybrid, { gpu: [reading(1)], errors: { gpu: 'nvml: NVMLError_Unknown: Unknown Error' } }, 6);
    expect(subtitle()).toHaveTextContent(/^The 3 biggest consumers · 2 on the GPU using 84\.0 GiB \(1 of 2 GPUs\)$/);
  });

  it('marks nothing while all four GPUs report', () => {
    show(quad, { gpu: [0, 1, 2, 3].map(reading) }, 1);
    expect(subtitle()).toHaveTextContent(/^The 3 biggest consumers · 2 on the GPU using 84\.0 GiB$/);
  });
});
