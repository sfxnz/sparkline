import { nodeConditions } from '../../lib/condition';
import type { Event, NetIfInfo, NodeInfo, ProcSample, Sample } from '../../lib/types';
import {
  breathLevel,
  clusterHealth,
  clusterTotals,
  flowLevel,
  interconnectLinks,
  isServing,
  linkLoad,
  listNodes,
  memSplit,
  openAlertCounts,
  recentIncidents,
  topGpuProcess,
  workloadSentence,
} from './model';

const none = { critical: 0, warning: 0 };

describe('clusterHealth', () => {
  it('says all nodes are healthy', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'online' }, { id: 'spark2', status: 'online' }], none);
    expect(h).toEqual({ status: 'healthy', label: 'Healthy', sentence: 'All 2 nodes healthy' });
  });

  it('names a single node', () => {
    expect(clusterHealth([{ id: 'spark1', status: 'online' }], none).sentence).toBe('spark1 is healthy');
  });

  it('puts offline nodes and open alerts first', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'online' }, { id: 'spark2', status: 'offline' }], { critical: 1, warning: 0 });
    expect(h.sentence).toBe('spark2 is offline · 1 critical alert');
    expect(h.status).toBe('critical');
  });

  it('groups nodes with the same problem and pluralises', () => {
    const h = clusterHealth(
      [{ id: 'spark1', status: 'stale' }, { id: 'spark2', status: 'offline' }, { id: 'spark3', status: 'offline' }],
      { critical: 0, warning: 2 },
    );
    expect(h.sentence).toBe('spark2 and spark3 are offline · spark1 is not reporting · 2 warnings');
    expect(h.status).toBe('warning');
  });

  it('reports a connection error as an error, not as critical', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'error' }], none);
    expect(h.sentence).toBe('spark1 has a connection error');
    expect(h).toMatchObject({ status: 'error', label: 'Error' });
    // A critical alert elsewhere still wins.
    expect(clusterHealth([{ id: 'spark1', status: 'error' }, { id: 'spark2', status: 'online' }], { critical: 1, warning: 0 }).status).toBe('critical');
  });

  it('waits for nodes that have not connected yet', () => {
    expect(clusterHealth([{ id: 'spark3', status: 'connecting' }], none)).toMatchObject({ status: 'connecting', sentence: 'Waiting for spark3…' });
    const mixed = clusterHealth([{ id: 'spark1', status: 'online' }, { id: 'spark3', status: undefined }], none);
    expect(mixed.sentence).toBe('Waiting for spark3…');
    expect(mixed.status).toBe('connecting');
  });

  it('says online (not healthy) when alerts are open on online nodes', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'online' }, { id: 'spark2', status: 'online' }], { critical: 0, warning: 1 });
    expect(h.sentence).toBe('All 2 nodes online · 1 warning');
    expect(h.label).toBe('Needs attention');
  });

  it('marks everything as not live when the console connection is lost', () => {
    expect(clusterHealth([{ id: 'spark1', status: 'online' }], none, false).status).toBe('stale');
  });

  it('handles zero nodes', () => {
    expect(clusterHealth([], none).sentence).toBe('No nodes configured');
  });
});

describe('listNodes', () => {
  it('joins names in plain English and counts long lists', () => {
    expect(listNodes(['a'])).toBe('a');
    expect(listNodes(['a', 'b'])).toBe('a and b');
    expect(listNodes(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listNodes(['a', 'b', 'c', 'd'])).toBe('4 nodes');
  });
});

const ev = (p: Partial<Event>): Event => ({
  id: 1, ts: 0, node_id: 'spark1', severity: 'warning', kind: 'alert', rule_id: null, title: '', detail: '', metric: null, value: null, resolved_ts: null, acked: false, ...p,
});

describe('recentIncidents', () => {
  it('folds an alert and its recovery into one resolved row, ordered by latest activity', () => {
    const alert = ev({ id: 1, ts: 100, severity: 'critical', rule_id: 'node_offline', node_id: 'spark3', resolved_ts: 145 });
    const recovery = ev({ id: 2, ts: 145, severity: 'info', kind: 'recovered', rule_id: 'node_offline', node_id: 'spark3' });
    const warn = ev({ id: 3, ts: 120, severity: 'warning', rule_id: 'gpu_temp_high' });
    const rows = recentIncidents([recovery, warn, alert], 5);
    expect(rows.map((r) => r.event.id)).toEqual([1, 3]);
    expect(rows[0]).toMatchObject({ recovery: { id: 2 }, at: 145 });
  });

  it('keeps a recovery whose alert is not loaded', () => {
    const orphan = ev({ id: 9, ts: 50, kind: 'recovered', severity: 'info', rule_id: 'x' });
    expect(recentIncidents([orphan], 5).map((r) => r.event.id)).toEqual([9]);
  });
});

describe('openAlertCounts', () => {
  it('counts unresolved warning/critical alerts only', () => {
    expect(
      openAlertCounts([
        ev({ severity: 'critical' }),
        ev({ severity: 'warning' }),
        ev({ severity: 'warning', resolved_ts: 5 }),
        ev({ severity: 'info', kind: 'recovered' }),
        ev({ severity: 'info' }),
      ]),
    ).toEqual({ critical: 1, warning: 1, explained: null });
  });

  it('leaves out a node-offline alert the node-state clause already explains, but keeps its severity', () => {
    const events = [ev({ severity: 'critical', rule_id: 'node_offline', node_id: 'spark3' }), ev({ severity: 'warning', node_id: 'spark1' })];
    expect(openAlertCounts(events, ['spark3'])).toEqual({ critical: 0, warning: 1, explained: 'critical' });
    expect(openAlertCounts(events, [])).toEqual({ critical: 1, warning: 1, explained: null });
  });
});

const gb10At = (temp_c: number) =>
  nodeConditions({ gpus: [{ index: 0, temp_slowdown_c: 86 }], unsupported: [] } as unknown as NodeInfo, { gpu: [{ index: 0, temp_c, throttle_mask: 0 }] } as unknown as Sample);

describe('clusterHealth with live conditions and explained alerts', () => {
  const hot = gb10At(90);

  it('never says healthy while a node is flagged live, before its alert rule fires', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'online', conditions: hot }, { id: 'spark2', status: 'online' }], none);
    expect(h).toEqual({ status: 'critical', label: 'Critical', sentence: 'spark1 is at its GPU slowdown temperature' });
    const warm = clusterHealth([{ id: 'spark1', status: 'online', conditions: gb10At(81) }], none);
    expect(warm).toMatchObject({ status: 'warning', label: 'Needs attention', sentence: 'spark1 is heating up' });
  });

  it('lets the alert count speak once the rule has fired', () => {
    const fired = ev({ severity: 'critical', rule_id: 'gpu_temp_critical', metric: 'gpu0.temp_c' });
    const h = clusterHealth([{ id: 'spark1', status: 'online', conditions: hot, alerts: [fired] }, { id: 'spark2', status: 'online' }], { critical: 1, warning: 0 });
    expect(h.sentence).toBe('All 2 nodes online · 1 critical alert');
  });

  it('reads an offline node as one problem, at the severity of its alert', () => {
    const h = clusterHealth([{ id: 'spark1', status: 'online' }, { id: 'spark3', status: 'offline' }], { critical: 0, warning: 0, explained: 'critical' });
    expect(h).toEqual({ status: 'critical', label: 'Critical', sentence: 'spark3 is offline' });
  });

  it('ignores conditions on nodes that are not online (stale values never raise a node)', () => {
    expect(clusterHealth([{ id: 'spark1', status: 'stale', conditions: hot }], none).sentence).toBe('spark1 is not reporting');
  });
});

const proc = (p: Partial<ProcSample>): ProcSample => ({
  pid: 1, name: 'python', cmdline: 'python x.py', user: 'root', cpu_pct: 0, rss: 0, gpu_mem: null, gpu_util: null, container: null, model: null, ...p,
});
const deepseek = proc({ gpu_mem: 86e9, gpu_util: 90, model: 'DeepSeek-V4.1-Flash-EXL3', container: 'c5-2B-r0', cmdline: 'python serve_stats.py --tp 2' });
const qwen = proc({ gpu_mem: 40e9, model: 'Qwen3-32B', cmdline: 'python3 -m vllm.entrypoints.openai.api_server' });
const trainer = proc({ gpu_mem: 20e9, name: 'python', container: 'ft-lora', cmdline: 'python train.py' });

describe('workloads', () => {
  it('picks the process with the most GPU memory', () => {
    expect(topGpuProcess([proc({ name: 'dockerd' }), trainer, deepseek])).toBe(deepseek);
    expect(topGpuProcess([proc({ name: 'dockerd' })])).toBeNull();
    expect(topGpuProcess(null)).toBeNull();
  });

  it('detects inference servers from the command line', () => {
    expect(isServing(deepseek)).toBe(true);
    expect(isServing(qwen)).toBe(true);
    expect(isServing(trainer)).toBe(false);
  });

  it('groups nodes running the same model', () => {
    expect(workloadSentence([{ id: 'spark1', procs: [deepseek] }, { id: 'spark2', procs: [deepseek] }])).toBe(
      'Serving DeepSeek-V4.1-Flash-EXL3 across 2 nodes',
    );
  });

  it('lists a second workload with its own verb', () => {
    expect(workloadSentence([{ id: 'spark1', procs: [deepseek] }, { id: 'spark2', procs: [deepseek] }, { id: 'spark3', procs: [qwen] }])).toBe(
      'Serving DeepSeek-V4.1-Flash-EXL3 across 2 nodes and Qwen3-32B on spark3',
    );
    expect(workloadSentence([{ id: 'spark1', procs: [deepseek] }, { id: 'spark3', procs: [trainer] }])).toBe(
      'Serving DeepSeek-V4.1-Flash-EXL3 on spark1, running ft-lora on spark3',
    );
  });

  it('summarises more than two workloads', () => {
    const p = (model: string) => [proc({ gpu_mem: 1, model })];
    expect(workloadSentence([{ id: 'a', procs: p('A') }, { id: 'b', procs: p('B') }, { id: 'c', procs: p('C') }])).toBe(
      'Running A on a, B on b and 1 more workload',
    );
  });

  it('distinguishes "no GPU work" from "not reported yet"', () => {
    expect(workloadSentence([{ id: 'spark1', procs: [proc({})] }])).toBe('No GPU workloads');
    expect(workloadSentence([{ id: 'spark1', procs: null }])).toBeNull();
  });
});

describe('clusterTotals', () => {
  it('averages utilisation, sums power and memory, takes the worst pressure', () => {
    const t = clusterTotals([
      { util: 90, power: 30, memUsed: 96, memTotal: 120, psi: 0.5 },
      { util: 70, power: 28, memUsed: 24, memTotal: 120, psi: 2 },
    ]);
    expect(t).toMatchObject({ util: 80, power: 58, memUsed: 120, memTotal: 240, memPct: 50, psiMax: 2, reporting: 2 });
  });

  it('ignores missing values instead of treating them as 0', () => {
    const t = clusterTotals([
      { util: 90, power: null, memUsed: null, memTotal: 120, psi: null },
      { util: null, power: null, memUsed: null, memTotal: null, psi: null },
    ]);
    expect(t).toMatchObject({ util: 90, power: null, memPct: null, psiMax: null, reporting: 1 });
  });
});

describe('memSplit', () => {
  it('splits in-use memory into GPU and other; the parts sum to total', () => {
    const m = memSplit(120, 24, 86);
    expect(m).toMatchObject({ gpu: 86, other: 10, available: 24, total: 120, gpuKnown: true });
    expect((m?.gpu ?? 0) + (m?.other ?? 0) + (m?.available ?? 0)).toBe(120);
  });

  it('clamps inconsistent inputs', () => {
    expect(memSplit(100, 150, 10)).toMatchObject({ gpu: 0, other: 0, available: 100 });
    expect(memSplit(100, 20, 95)).toMatchObject({ gpu: 80, other: 0 });
  });

  it('reports all of used as other when the GPU share is unknown', () => {
    expect(memSplit(100, 40, null)).toMatchObject({ gpu: 0, other: 60, gpuKnown: false });
    expect(memSplit(null, 40, 1)).toBeNull();
  });
});

const nif = (p: Partial<NetIfInfo>): NetIfInfo => ({
  name: 'x', role: 'interconnect', label: 'ConnectX-7 rail A', mac: null, ipv4: [], speed_mbps: 200000, rdma_device: null, counter_source: 'netdev_rdma', peer: null, ...p,
});
const info = (net: NetIfInfo[]) => ({ net }) as unknown as NodeInfo;

describe('interconnect', () => {
  const rails = (peer: string | null) => [
    nif({ name: 'enp1s0f1np1', label: 'ConnectX-7 rail A', peer }),
    nif({ name: 'enP2p1s0f1np1', label: 'ConnectX-7 rail B', peer }),
    nif({ name: 'enp1s0f0np0', label: 'ConnectX-7 port (no cable)' }),
    nif({ name: 'enP7s7', role: 'lan', label: 'LAN' }),
  ];

  it('builds one link per node pair from peered interconnect interfaces', () => {
    const links = interconnectLinks(['spark1', 'spark2', 'spark3'], { spark1: info(rails('spark2')), spark2: info(rails('spark1')), spark3: info(rails(null)) });
    expect(links).toEqual([
      {
        a: 'spark1',
        b: 'spark2',
        rails: [
          { name: 'enp1s0f1np1', peerName: 'enp1s0f1np1', label: 'Rail A', speedMbps: 200000 },
          { name: 'enP2p1s0f1np1', peerName: 'enP2p1s0f1np1', label: 'Rail B', speedMbps: 200000 },
        ],
      },
    ]);
  });

  it('returns nothing without peers or info', () => {
    expect(interconnectLinks(['spark3'], { spark3: info(rails(null)) })).toEqual([]);
    expect(interconnectLinks(['spark1'], { spark1: null })).toEqual([]);
  });

  it('keeps a link whose far end is not monitored', () => {
    const links = interconnectLinks(['spark1'], { spark1: info(rails('spark9')) });
    expect(links[0]).toMatchObject({ a: 'spark1', b: 'spark9' });
    expect(links[0]?.rails[0]?.peerName).toBeNull();
  });

  it('names rails by position, whatever the interfaces are labelled', () => {
    const relabelled = (peer: string) => [
      nif({ name: 'ens1f0', label: 'Interconnect A', nic_model: 'ConnectX-7', peer }),
      nif({ name: 'ens1f1', label: 'storage fabric', nic_model: 'Intel E810-C', peer }),
    ];
    const links = interconnectLinks(['n1', 'n2'], { n1: info(relabelled('n2')), n2: info(relabelled('n1')) });
    expect(links[0]?.rails.map((r) => r.label)).toEqual(['Rail A', 'Rail B']);
  });

  it('computes load and quantises flow speed', () => {
    expect(linkLoad(12.5e9, 200000)).toBeCloseTo(0.5);
    expect(linkLoad(null, 200000)).toBe(0);
    expect(linkLoad(1, null)).toBe(0);
    expect([0, 0.01, 0.05, 0.2, 0.5, 0.9].map(flowLevel)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('breathLevel', () => {
  it('maps utilisation to a few calm buckets', () => {
    expect([null, 2, 20, 60, 95].map(breathLevel)).toEqual([0, 0, 1, 2, 3]);
  });
});

describe('workloads on nodes that cannot tell their GPU processes', () => {
  const idle = [proc({ name: 'dockerd' })];

  it('names the nodes that ran no GPU workload when the others cannot tell', () => {
    expect(workloadSentence([{ id: 'spark1', procs: idle }, { id: 'amd1', procs: idle, cannotTell: true }])).toBe('No GPU workloads on spark1');
    expect(workloadSentence([{ id: 'spark1', procs: idle }, { id: 'spark2', procs: idle }, { id: 'amd1', procs: idle, cannotTell: true }])).toBe(
      'No GPU workloads on spark1 and spark2',
    );
  });

  it('says GPU workloads are not reported when no node can tell, even before their first process list', () => {
    expect(workloadSentence([{ id: 'amd1', procs: idle, cannotTell: true }])).toBe('GPU workloads not reported');
    expect(workloadSentence([{ id: 'amd1', procs: null, cannotTell: true }, { id: 'amd2', procs: idle, cannotTell: true }])).toBe('GPU workloads not reported');
  });

  it('builds the positive sentence from the nodes that can tell', () => {
    expect(workloadSentence([{ id: 'spark1', procs: [deepseek] }, { id: 'spark2', procs: [trainer], cannotTell: true }])).toBe('Serving DeepSeek-V4.1-Flash-EXL3 on spark1');
  });

  it('still waits for a node that can tell but has not sent its process list', () => {
    expect(workloadSentence([{ id: 'spark1', procs: null }, { id: 'amd1', procs: idle, cannotTell: true }])).toBeNull();
  });
});

describe('clusterHealth: an open alert hides only the GPU condition it fired on', () => {
  const ws1 = (over: Record<number, { temp_c?: number; throttle_mask?: number }>, lost: number[] = []) =>
    nodeConditions(
      { gpus: [0, 1, 2, 3].map((index) => ({ index, temp_slowdown_c: 93 })), unsupported: lost.map((i) => ({ metric: `gpu${String(i)}`, reason: 'GPU is lost', kind: 'hardware' })) } as unknown as NodeInfo,
      { gpu: [0, 1, 2, 3].filter((i) => !lost.includes(i)).map((index) => ({ index, temp_c: 60, throttle_mask: 0, ...over[index] })) } as unknown as Sample,
    );
  const sentence = (conditions: ReturnType<typeof ws1>, alert: Partial<Event>) =>
    clusterHealth([{ id: 'ws1', status: 'online', conditions, alerts: [ev({ node_id: 'ws1', ...alert })] }], openAlertCounts([ev(alert)])).sentence;

  it.each<[string, ReturnType<typeof ws1>, Partial<Event>, string]>([
    ["the node's hottest-GPU temperature, which is not GPU 3's own reading", ws1({ 3: { temp_c: 89 } }), { metric: 'gpu.temp_c' }, 'ws1 has GPU 3 heating up · 1 warning'],
    ["GPU 3's clock limit", ws1({ 3: { throttle_mask: 0x20 } }), { metric: 'gpu3.throttle_mask' }, 'ws1 is online · 1 warning'],
    ["GPU 3's temperature, beside its clock limit", ws1({ 3: { throttle_mask: 0x20 } }), { metric: 'gpu3.temp_c' }, 'ws1 has GPU 3 clocks limited by thermal limit · 1 warning'],
    ["GPU 3's temperature, below its slowdown level", ws1({ 3: { temp_c: 94 } }), { metric: 'gpu3.temp_c' }, 'ws1 has GPU 3 at its slowdown temperature · 1 warning'],
    ["GPU 0's temperature, which never hides GPU 0 not responding", ws1({}, [0]), { severity: 'critical', metric: 'gpu0.temp_c' }, 'ws1 has GPU 0 not responding · 1 critical alert'],
    ["GPU 3's temperature, leaving GPU 0 not responding", ws1({ 3: { temp_c: 89 } }, [0]), { metric: 'gpu3.temp_c' }, 'ws1 has GPU 0 not responding · 1 warning'],
  ])('with an alert open on %s', (_, conditions, alert, expected) => {
    expect(sentence(conditions, alert)).toBe(expected);
  });
});

describe("clusterHealth: the node's hottest-GPU alert hides a condition only on a node with one GPU", () => {
  const hottest = (node_id: string) => ev({ node_id, rule_id: 'gpu_temp_high', metric: 'gpu.temp_c' });
  const sentence = (id: string, conditions: ReturnType<typeof nodeConditions>) =>
    clusterHealth([{ id, status: 'online', conditions, alerts: [hottest(id)] }], openAlertCounts([hottest(id)])).sentence;

  it('lets the warning say a one-GPU node is heating up, and still counts it', () => {
    expect(sentence('spark1', gb10At(81))).toBe('spark1 is online · 1 warning');
  });

  it('still says a four-GPU node has GPUs 1 and 2 heating up, and counts the warning', () => {
    const ws1 = nodeConditions(
      { gpus: [0, 1, 2, 3].map((index) => ({ index, temp_slowdown_c: 93 })), unsupported: [] } as unknown as NodeInfo,
      { gpu: [0, 1, 2, 3].map((index) => ({ index, temp_c: index === 1 || index === 2 ? 89 : 60, throttle_mask: 0 })) } as unknown as Sample,
    );
    expect(sentence('ws1', ws1)).toBe('ws1 has GPUs 1 and 2 heating up · 1 warning');
  });
});

describe('the workload sentence on a phone', () => {
  it('keeps its GPU count on one line', () => {
    expect(workloadSentence([{ id: 'ws4', procs: [qwen], gpusRead: { from: 3, of: 4 } }])).toBe('Serving Qwen3-32B on ws4 (3 of 4 GPUs)');
  });
});
