import { describe, expect, it } from 'vitest';
import type { BenchCompare, Sample } from '../../lib/types';
import { boundRuns, mergeRun } from '../../store/bench';
import { CATALOG, LLM, MATMUL, RDMA, SOAK, result, run } from './fixtures';
import {
  aboutDuration,
  baselineCoverage,
  baselineSummary,
  choiceLabel,
  compareMatrix,
  competition,
  defaultParams,
  deltaLook,
  differingParams,
  estimateDuration,
  eta,
  filterRuns,
  formatValue,
  groupCatalog,
  headlineResults,
  headlineText,
  isLanHost,
  nodesText,
  paramText,
  paramsSummary,
  parseCompareIds,
  parseRunSeries,
  resultDelta,
  resultText,
  runnableNodes,
  soakStats,
  splitDescription,
  toForm,
  unitText,
  validateParams,
  valueWithUnit,
} from './model';

describe('review fixes', () => {
  it('accepts only LAN or loopback LLM endpoints, like the agent', () => {
    for (const h of ['localhost', '127.0.0.1', '10.20.20.48', '172.16.0.1', '192.168.1.5', '[::1]', '[fd00::5]']) expect(isLanHost(h)).toBe(true);
    for (const h of ['api.openai.com', '8.8.8.8', '169.254.169.254', '100.100.100.100', '100.100.1.2', '[fe80::1]', '172.32.0.1', '[fc::1]']) expect(isLanHost(h)).toBe(false);
    expect(validateParams(LLM, { ...toForm(LLM), base_url: 'https://api.openai.com' }).errors.base_url).toMatch(/LAN or loopback/);
    expect(validateParams(LLM, { ...toForm(LLM), base_url: 'http://169.254.169.254' }).errors.base_url).toMatch(/LAN or loopback/);
  });
  it('labels choices and units as people read them', () => {
    const p = (name: string, unit: string | null = null) => ({ name, label: name, type: 'enum' as const, default: null, unit, min: null, max: null, choices: [], help: null });
    expect(['both', 'gpu', 'cpu'].map((c) => choiceLabel(c, p('side')))).toEqual(['Both', 'GPU', 'CPU']);
    expect(['tensor', 'row'].map((c) => choiceLabel(c))).toEqual(['Per-tensor', 'Per-row']);
    expect(['both', 'A', 'B'].map((c) => choiceLabel(c, p('rails')))).toEqual(['Both', 'Rail A', 'Rail B']);
    expect(['4096', '65536', '1048576'].map((c) => choiceLabel(c, p('msg_size', 'B')))).toEqual(['4 KiB', '64 KiB', '1 MiB']);
    expect(choiceLabel('1024', p('max_size_mib', 'MiB'))).toBe('1024 MiB');
    expect(paramText({ ...p('model'), type: 'string' }, '')).toBe('First served model');
    expect(paramText(p('side'), 'both')).toBe('Both');
    expect(unitText('us')).toBe('µs');
    expect(valueWithUnit(1.71, 'us')).toBe('1.71 µs');
    expect(formatValue(-29.5)).toBe('−29.5');
    expect(resultText(result({ metric: 'tflops_change_pct', value: 27.3, unit: '%' }))).toBe('+27.3%');
    expect(resultText(result({ metric: 'tflops_change_pct', value: -12, unit: '%' }))).toBe('−12.0%');
  });
  it('compares percentages in points, and never flags runs whose params differ', () => {
    expect(deltaLook(1.0, 0.5, 'lower', 5, undefined, '%')).toMatchObject({ text: '+0.5 pts', regression: false });
    expect(deltaLook(100, 0, 'lower', 5, undefined, '%')).toMatchObject({ text: '+100.0 pts', regression: true });
    const a = run({ id: 'a' });
    const c = run({ id: 'c', params: { ...a.params, size: '16384' }, params_key: 'other' });
    const cmp: BenchCompare = { runs: [a, c], metrics: [{ metric: 'bf16', label: 'BF16', unit: 'TFLOPS', better: 'higher', node_id: 'spark1', values: { a: 400, c: 300 } }] };
    expect(compareMatrix(cmp, 5)[0]?.cells[1]?.delta).toMatchObject({ tone: 'worse', regression: false });
    const mixed: BenchCompare = { ...cmp, runs: [a, run({ id: 'c', bench_id: 'nccl-allreduce' })] };
    expect(compareMatrix(mixed, 5)[0]?.cells[1]?.delta).toBeNull();
  });
  it('says which nodes had a baseline, names the served model once and reads pairs by direction', () => {
    const cov = baselineCoverage([result({ metric: 'm', value: 1, node_id: 'spark1', baseline: 1 }), result({ metric: 'm', value: 1, node_id: 'spark2' })]);
    expect(cov).toEqual({ with: ['spark1'], without: ['spark2'] });
    expect(nodesText('rdma-bw-lat', ['spark1', 'spark2'])).toBe('spark1 → spark2');
    expect(nodesText('nccl-allreduce', ['spark1', 'spark2'])).toBe('spark1, spark2');
    expect(splitDescription('How fast it is. Method: GEMMs, timed.')).toEqual({ summary: 'How fast it is.', method: 'Method: GEMMs, timed.' });
  });
  it('leaves first/last minute empty until two minutes of load exist', () => {
    const ts = Array.from({ length: 7 }, (_, i) => i);
    const s = soakStats(ts, { sm_mhz: ts.map(() => 2000), tflops: ts.map(() => 90) });
    expect(s.firstMinuteTflops).toBeNull();
    expect(s.tflopsChangePct).toBeNull();
    expect(s.hasTflops).toBe(true);
  });
  it('shows short remaining times in whole seconds', () => {
    expect(aboutDuration(1.9).replace(/\u00a0/g, ' ')).toBe('≈ 2 s');
  });
});

describe('catalog', () => {
  it('groups by category in the fixed order and drops empty groups', () => {
    expect(groupCatalog(CATALOG).map((g) => g.label)).toEqual(['Compute', 'Interconnect', 'Inference', 'Soak']);
  });
  it('lists runnable nodes only', () => {
    expect(runnableNodes(MATMUL, ['spark1', 'spark2', 'spark3', 'spark4'])).toEqual(['spark1', 'spark2']);
  });
  it('rounds estimates so they never look precise', () => {
    const sp = (t: string) => t.replace(/\u00a0/g, ' ');
    expect(sp(aboutDuration(42))).toBe('≈ 42 s');
    expect(sp(aboutDuration(1.9))).toBe('≈ 2 s'); // whole seconds: elapsed + remaining adds up to the total
    expect(sp(aboutDuration(95))).toBe('≈ 2 min');
    expect(sp(aboutDuration(4000))).toBe('≈ 1 h 05 min');
    expect(aboutDuration(null)).toBe('—');
  });
});

describe('params form', () => {
  it('starts from the catalog defaults', () => {
    expect(defaultParams(MATMUL)).toEqual({ dtypes: ['bf16', 'fp16', 'fp8'], size: '8192', iterations: 50 });
    expect(toForm(MATMUL)).toEqual({ dtypes: ['bf16', 'fp16', 'fp8'], size: '8192', iterations: '50' });
  });

  it('accepts valid values and parses numbers', () => {
    const { values, errors } = validateParams(MATMUL, { dtypes: ['fp8', 'bf16'], size: '16384', iterations: ' 120 ' });
    expect(errors).toEqual({});
    expect(values).toEqual({ dtypes: ['bf16', 'fp8'], size: '16384', iterations: 120 }); // catalog order kept
  });

  it('rejects out-of-range, fractional, empty and non-numeric ints with a reason', () => {
    expect(validateParams(MATMUL, { ...toForm(MATMUL), iterations: '501' }).errors.iterations).toBe('Must be between 5 and 500');
    expect(validateParams(MATMUL, { ...toForm(MATMUL), iterations: '7.5' }).errors.iterations).toBe('Enter a whole number');
    expect(validateParams(MATMUL, { ...toForm(MATMUL), iterations: '' }).errors.iterations).toBe('Enter a whole number');
    expect(validateParams(MATMUL, { ...toForm(MATMUL), iterations: '1e9' }).errors.iterations).toBe('Must be between 5 and 500');
    expect(validateParams(RDMA, { ...toForm(RDMA), duration_s: '1' }).errors.duration_s).toBe('Must be between 2 and 60 s');
  });

  it('rejects enum values outside the choices and an empty multi-select', () => {
    const r = validateParams(MATMUL, { dtypes: [], size: '1234', iterations: '50' });
    expect(r.values).toBeNull();
    expect(r.errors).toEqual({ dtypes: 'Choose at least one', size: 'Choose one of the options' });
  });

  it('validates floats with a decimal comma and bools', () => {
    const r = validateParams(LLM, { ...toForm(LLM), temperature: '0,7', stream: false });
    expect(r.values?.temperature).toBe(0.7);
    expect(r.values?.stream).toBe(false);
    expect(validateParams(LLM, { ...toForm(LLM), temperature: '2.5' }).errors.temperature).toBe('Must be between 0 and 2');
  });

  it('only accepts http(s) endpoints and safe model names', () => {
    expect(validateParams(LLM, { ...toForm(LLM), base_url: 'file:///etc/passwd' }).errors.base_url).toMatch(/http/);
    expect(validateParams(LLM, { ...toForm(LLM), base_url: 'not a url' }).errors.base_url).toMatch(/http/);
    expect(validateParams(LLM, { ...toForm(LLM), base_url: 'http://10.20.20.48:8000/v1' }).errors).toEqual({});
    expect(validateParams(LLM, { ...toForm(LLM), model: 'x; rm -rf /' }).errors.model).toBeDefined();
    expect(validateParams(LLM, { ...toForm(LLM), model: 'deepseek-ai/DeepSeek-V4.1:flash' }).errors).toEqual({});
    expect(validateParams(LLM, { ...toForm(LLM), model: '' }).errors).toEqual({}); // the agent picks the first served model
  });
});

describe('duration estimate', () => {
  it('is the catalog estimate for the defaults', () => {
    expect(estimateDuration(MATMUL, defaultParams(MATMUL))).toBe(90);
  });
  it('scales with counts and multi-selects', () => {
    expect(estimateDuration(MATMUL, { ...defaultParams(MATMUL), iterations: 100 })).toBe(180);
    expect(estimateDuration(MATMUL, { ...defaultParams(MATMUL), dtypes: ['bf16'] })).toBe(30);
  });
  it('adds the difference of a duration parameter, in its unit', () => {
    expect(estimateDuration(RDMA, { rail: 'A', duration_s: 30 })).toBe(60);
    expect(estimateDuration(SOAK, { minutes: 30 })).toBe(1800);
  });
});

describe('progress', () => {
  const r = { created_ts: 100, started_ts: 100, finished_ts: null };
  it('uses the estimate before progress is meaningful', () => {
    expect(eta({ ...r, progress: 0 }, 130, 90)).toBe(60);
  });
  it('extrapolates from progress once it is reported', () => {
    expect(eta({ ...r, progress: 0.5 }, 160, 90)).toBeCloseTo(60);
  });
  it('is zero when finished', () => {
    expect(eta({ ...r, finished_ts: 150, progress: 1 }, 200, 90)).toBe(0);
  });
});

describe('values and deltas', () => {
  it('formats with three significant figures and groups large numbers', () => {
    expect(formatValue(412.4)).toBe('412');
    expect(formatValue(41.23)).toBe('41.2');
    expect(formatValue(4.123)).toBe('4.12');
    expect(formatValue(0.0123)).toBe('0.0123');
    expect(formatValue(12480)).toBe('12,480');
    expect(formatValue(null)).toBe('—');
  });

  it('reads deltas in the metric’s better direction', () => {
    expect(deltaLook(110, 100, 'higher', 5)).toEqual({ pct: 10, text: '+10.0%', tone: 'better', regression: false });
    expect(deltaLook(90, 100, 'higher', 5)).toMatchObject({ text: '−10.0%', tone: 'worse', regression: true });
    expect(deltaLook(96, 100, 'higher', 5)).toMatchObject({ tone: 'worse', regression: false });
    expect(deltaLook(1.2, 1.0, 'lower', 5)).toMatchObject({ tone: 'worse', regression: true }); // latency went up
    expect(deltaLook(100.2, 100, 'higher', 5)).toMatchObject({ tone: 'same' });
    expect(deltaLook(5, null, 'higher', 5)).toBeNull();
    expect(deltaLook(5, 0, 'higher', 5)).toBeNull();
  });

  it('trusts the console’s regression flag when a baseline exists', () => {
    expect(resultDelta(result({ metric: 'a', value: 97, baseline: 100, regression: true }), 5)?.regression).toBe(true);
    expect(resultDelta(result({ metric: 'a', value: 80, baseline: 100, regression: false }), 5)?.regression).toBe(false);
    expect(resultDelta(result({ metric: 'a', value: 80 }), 5)).toBeNull();
  });

  it('summarises the worst delta for the history table', () => {
    const rs = [result({ metric: 'a', value: 110, baseline: 100 }), result({ metric: 'b', value: 80, baseline: 100, regression: true })];
    expect(baselineSummary(rs, 5)).toMatchObject({ text: '−20.0%', regression: true });
    expect(baselineSummary([result({ metric: 'a', value: 1 })], 5)).toBeNull();
  });

  it('picks headline results: flagged ones, else the first metric across nodes', () => {
    const a = result({ metric: 'bf16', value: 400, node_id: 'spark1' });
    const b = result({ metric: 'bf16', value: 398, node_id: 'spark2' });
    const c = result({ metric: 'fp8', value: 800, node_id: 'spark1', extras: { headline: true } });
    expect(headlineResults([a, b])).toEqual([a, b]);
    expect(headlineResults([a, b, c])).toEqual([c]);
    expect(headlineText([a, b])).toBe('400 / 398 TFLOPS');
    expect(headlineText([a, c])).toBe('800 TFLOPS'); // flagged headline first
    expect(headlineText([a])).toBe('400 TFLOPS');
    expect(headlineText([])).toBe('—');
  });

  it('never shows an unsupported precision as a number', () => {
    const fp4 = result({ metric: 'fp4', value: 0, extras: { unsupported: true, reason: 'no FP4' } });
    const bf16 = result({ metric: 'bf16', value: 95 });
    expect(resultText(fp4)).toBe('Unsupported');
    expect(resultText(bf16)).toBe('95.0 TFLOPS');
    expect(headlineResults([fp4, bf16])).toEqual([bf16]);
    expect(headlineText([fp4, bf16])).toBe('95.0 TFLOPS');
  });
});

describe('history', () => {
  const runs = [
    run({ id: 'a', created_ts: 1, nodes: ['spark1'], status: 'succeeded' }),
    run({ id: 'b', created_ts: 3, nodes: ['spark1', 'spark2'], bench_id: 'rdma-bw-lat', status: 'failed' }),
    run({ id: 'c', created_ts: 2, nodes: ['spark2'], status: 'succeeded' }),
  ];
  it('filters by bench, node and status, newest first', () => {
    expect(filterRuns(runs, { bench: '', node: '', status: '' }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(filterRuns(runs, { bench: '', node: 'spark2', status: '' }).map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterRuns(runs, { bench: 'gpu-matmul', node: '', status: 'succeeded' }).map((r) => r.id)).toEqual(['c', 'a']);
  });
  it('summarises params that differ from the defaults', () => {
    expect(paramsSummary(MATMUL, defaultParams(MATMUL))).toBe('Default parameters');
    expect(paramsSummary(MATMUL, { ...defaultParams(MATMUL), size: '16384', dtypes: ['fp8'] })).toBe('Precisions FP8 · Matrix size 16384');
  });
});

describe('store', () => {
  it('never moves a run backwards and keeps node states from fuller copies', () => {
    const done = run({ id: 'x', status: 'succeeded', node_states: { spark1: {} as never } });
    const stale = run({ id: 'x', status: 'running', progress: 0.5 });
    expect(mergeRun(done, stale)).toBe(done);
    const listCopy = run({ id: 'x', status: 'succeeded', phase: 'later' });
    delete listCopy.node_states;
    expect(mergeRun(done, listCopy)).toMatchObject({ phase: 'later', node_states: { spark1: {} } });
  });
  it('keeps at most N runs, evicting the oldest finished ones but never an active run', () => {
    const runs = Object.fromEntries(
      [run({ id: 'old-active', created_ts: 0, status: 'running' }), ...Array.from({ length: 5 }, (_, i) => run({ id: `r${i}`, created_ts: i + 1 }))].map((r) => [r.id, r]),
    );
    expect(Object.keys(boundRuns(runs, 3)).sort()).toEqual(['old-active', 'r3', 'r4']);
  });
});

describe('compare', () => {
  const a = run({ id: 'a' });
  const b = run({ id: 'b' });
  const c = run({ id: 'c', params: { ...a.params, size: '16384' }, params_key: 'other' });
  const cmp: BenchCompare = {
    runs: [a, b],
    metrics: [
      { metric: 'bf16', label: 'BF16', unit: 'TFLOPS', better: 'higher', node_id: 'spark1', values: { a: 400, b: 360 } },
      { metric: 'lat', label: 'Latency', unit: 'µs', better: 'lower', node_id: null, values: { a: 2, b: 1.5 } },
      { metric: 'fp4', label: 'FP4', unit: 'TFLOPS', better: 'higher', node_id: 'spark1', values: { a: null, b: 900 } },
    ],
  };
  it('builds metric rows with deltas against the first run', () => {
    const rows = compareMatrix(cmp, 5);
    expect(rows[0]?.cells.map((x) => x.delta?.text ?? null)).toEqual([null, '−10.0%']);
    expect(rows[0]?.cells[1]?.delta).toMatchObject({ tone: 'worse', regression: true });
    expect(rows[1]?.cells[1]?.delta).toMatchObject({ tone: 'better', text: '−25.0%' });
    expect(rows[2]?.cells[1]?.delta).toBeNull(); // no reference value
  });
  it('says which parameters differ', () => {
    expect(differingParams([a, b])).toEqual([]);
    expect(differingParams([a, c])).toEqual(['size']);
    expect(differingParams([a, run({ id: 'd', bench_id: 'cpu-throughput' })])).toEqual(['benchmark']);
  });
  it('parses ?ids= into at most four unique ids', () => {
    expect(parseCompareIds('?ids=a,b,,a,c,d,e')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseCompareIds('')).toEqual([]);
  });
});

describe('run series and soak stats', () => {
  it('reads node-prefixed keys and relative time', () => {
    const p = parseRunSeries(run({ id: 's', nodes: ['spark1', 'spark2'], started_ts: 1000, series: { 't': [0, 1, 2], 'spark1.gpu0.sm_mhz': [2000, 2100, 2050], 'spark2:temp_c': [60, 61, 62], 'junk': [1] } }));
    expect(p.ts.spark1).toEqual([1000, 1001, 1002]);
    expect(p.byNode.spark1?.sm_mhz).toEqual([2000, 2100, 2050]);
    expect(p.byNode.spark2?.temp_c).toEqual([60, 61, 62]);
  });
  it('spreads samples over the run when there is no time key', () => {
    const p = parseRunSeries(run({ id: 's', started_ts: 0, finished_ts: 10, series: { sm_mhz: [1, 2, 3] } }));
    expect(p.ts.spark1).toEqual([0, 5, 10]);
  });
  it('computes clock stability, peak temperature, throttling by reason and first vs last minute', () => {
    const ts = Array.from({ length: 180 }, (_, i) => i);
    const stats = soakStats(ts, {
      sm_mhz: ts.map((i) => (i % 2 ? 2000 : 2200)),
      temp_c: ts.map((i) => 60 + i / 10),
      throttle_mask: ts.map((i) => (i < 90 ? 0 : i < 135 ? 0x4 : 0x24)),
      tflops: ts.map((i) => (i < 60 ? 100 : 90)),
    });
    expect(stats.clockCvPct).toBeCloseTo(4.76, 1);
    expect(stats.maxTemp).toBeCloseTo(77.9);
    expect(stats.throttledAnyPct).toBe(25); // thermal only: the power cap is routine and reported apart
    expect(stats.powerCappedPct).toBe(50);
    expect(stats.throttled).toEqual([
      { title: 'Power cap', severity: 'info', pct: 50 },
      { title: 'Thermal limit', severity: 'warning', pct: 25 },
    ]);
    expect(stats.firstMinuteTflops).toBeCloseTo(100 - 10 / 61);
    expect(stats.lastMinuteTflops).toBe(90);
  });
});

describe('competition', () => {
  const sample = (over: Partial<Sample> = {}): Sample =>
    ({
      node_id: 'spark1',
      ts: 0,
      seq: 0,
      interval_ms: 1000,
      gpu: [{ index: 0, util: 96 }],
      cpu: { util: 12 },
      disk: [{ name: 'nvme0n1', busy_pct: 3 }],
      net: [{ name: 'enp1s0f1np1', rx_bps: 2e9, tx_bps: 1e9 }],
      procs: [{ pid: 1, name: 'python', cmdline: 'python serve_stats.py', gpu_mem: 8e10, model: 'DeepSeek-V4.1-Flash-EXL3', container: 'c5-2B-r0' }],
      ...over,
    }) as unknown as Sample;

  it('names the workload a GPU bench will compete with', () => {
    const [c] = competition(MATMUL, ['spark1'], () => sample());
    expect(c?.busy).toBe(true);
    expect(c?.text).toBe('spark1 is currently serving DeepSeek-V4.1-Flash-EXL3 at 96% GPU; results will be lower and the workload will slow down.');
  });
  it('says when a node is idle or has no data', () => {
    const idle = sample({ gpu: [{ index: 0, util: 0 }] as Sample['gpu'], procs: [] });
    expect(competition(MATMUL, ['spark1'], () => idle)[0]).toMatchObject({ busy: false, text: 'spark1 GPU is idle (0%).' });
    expect(competition(MATMUL, ['spark9'], () => null)[0]?.text).toMatch(/has not reported/);
  });
  it('looks at the CX7 link for interconnect benches', () => {
    const rails = () => [{ name: 'enp1s0f1np1' }] as never;
    expect(competition(RDMA, ['spark1'], () => sample(), rails)[0]?.text).toBe(
      'spark1 ConnectX-7 traffic (serving DeepSeek-V4.1-Flash-EXL3): enp1s0f1np1 16.0 Gb/s in / 8.0 Gb/s out; results will be lower and the workload will slow down.',
    );
  });
  it('stays busy for a GPU workload on a quiet link, and reports each rail from the recent window', () => {
    const railsInfo = () => [{ name: 'enp1s0f1np1', label: 'ConnectX-7 rail A' }, { name: 'enP2p1s0f1np1', label: 'ConnectX-7 rail B' }] as never;
    const quiet = sample({ net: [{ name: 'enp1s0f1np1', rx_bps: 0, tx_bps: 0 }] as Sample['net'] });
    // Between bursts of a TP=2 model: the instantaneous sample is quiet, the workload is still there.
    const between = competition(RDMA, ['spark1'], () => quiet, railsInfo)[0];
    expect(between?.busy).toBe(true);
    expect(between?.text).toMatch(/serving DeepSeek.*ConnectX-7 link/);
    const window = () => [
      { name: 'enp1s0f1np1', label: 'rail A', rx: 9.6e9, tx: 9.5e9 },
      { name: 'enP2p1s0f1np1', label: 'rail B', rx: 0, tx: 0 },
    ];
    const idleGpu = sample({ procs: [], net: [] as Sample['net'] });
    expect(competition(RDMA, ['spark1'], () => idleGpu, railsInfo, window)[0]?.text).toBe(
      'spark1 ConnectX-7 traffic: rail A 76.8 Gb/s in / 76.0 Gb/s out; results will be lower and the workload will slow down.',
    );
    expect(competition(RDMA, ['spark1'], () => idleGpu, railsInfo)[0]).toMatchObject({ busy: false, text: 'spark1 ConnectX-7 link is quiet.' });
  });
});

describe('telemetry alignment', () => {
  it('merges nodes onto one rounded time axis with gaps where a node has no sample', async () => {
    const { alignByNode } = await import('./model');
    const out = alignByNode(
      [
        { node: 'spark1', ts: [10.1, 11.0, 12.2], values: { u: [1, 2, 3] } },
        { node: 'spark2', ts: [10.4, 12.9], values: { u: [5, 6] } },
      ],
      ['u', 'missing'],
    );
    expect(out.ts).toEqual([10, 11, 12, 13]);
    expect(out.byKey.u).toEqual([[1, 2, 3, null], [5, null, null, 6]]);
    expect(out.byKey.missing).toEqual([[null, null, null, null], [null, null, null, null]]);
  });
});

describe('small formatters', () => {
  it('formats stopwatch times and metadata labels', async () => {
    const { stopwatch, metaLabel, orderedMeta } = await import('./model');
    expect(stopwatch(42)).toBe('0:42');
    expect(stopwatch(725)).toBe('12:05');
    expect(stopwatch(3723)).toBe('1:02:03');
    expect(metaLabel('sm_mhz_start')).toBe('SM MHz start');
    expect(metaLabel('cuda')).toBe('CUDA');
    expect(orderedMeta({ zeta: 1, cuda: '13.0', driver: '580' }).map(([k]) => k)).toEqual(['driver', 'cuda', 'zeta']);
  });
});

describe('run metadata', () => {
  it('reads per-node metadata from the console shape, agents or a flat dict', async () => {
    const { nodeMeta, runFacts, metaText } = await import('./model');
    const consoleShape = run({ id: 'm', nodes: ['spark1', 'spark2'], metadata: { bench_name: 'GPU matmul', nodes: { spark1: { driver: '580.173.02', cuda: '13.0', gpu: 'NVIDIA GB10' }, spark2: { driver: '580.173.02' } } } });
    expect(Object.keys(nodeMeta(consoleShape))).toEqual(['spark1', 'spark2']);
    expect(runFacts(consoleShape)).toEqual({ driver: '580.173.02', cuda: '13.0', gpu: 'NVIDIA GB10' });
    expect(nodeMeta(run({ id: 'f', metadata: { driver: '1' } }))).toEqual({ spark1: { driver: '1' } });
    expect(metaText('clocks_start', { sm_mhz: 2171 }).replace(/\u00a0/g, ' ')).toBe('2.17 GHz');
    expect(metaText('temps_end', { gpu_c: 71.4 }).replace(/\u00a0/g, ' ')).toBe('71 °C');
    expect(metaText('simulated', true)).toBe('Yes');
  });
  it('keeps recorded telemetry when a list copy without it arrives, and parses it separately', () => {
    const full = run({ id: 't', series: { 'telemetry.spark1.ts': [1], 'telemetry.spark1.util': [90], 'spark1.tflops': [100] } });
    const merged = mergeRun(full, run({ id: 't', series: { 'spark1.tflops': [100] } }));
    expect(Object.keys(merged.series).sort()).toEqual(['spark1.tflops', 'telemetry.spark1.ts', 'telemetry.spark1.util']);
    expect(parseRunSeries(merged, 'telemetry').byNode.spark1).toEqual({ util: [90] });
    expect(parseRunSeries(merged).byNode.spark1).toEqual({ tflops: [100] });
  });
});

describe('metadata snapshots', () => {
  it('formats the start/end telemetry snapshot with units', async () => {
    const { metaText } = await import('./model');
    const t = metaText('start', { mem_used: 2 ** 30 * 92, sm_mhz: 2160, temp_c: 62, power_w: 36.2, throttle_mask: 4 }).replace(/\u00a0/g, ' ');
    expect(t).toBe('Memory used 92.0 GiB · SM clock 2.16 GHz · GPU temp 62 °C · GPU power 36.2 W · Throttling Power cap');
  });

  it('keeps counts whole and spots smoke runs', async () => {
    const { metaText, isSmoke } = await import('./model');
    expect(metaText('cpu_cores', { total: 20, performance: 10 })).toBe('Total 20 · Performance 10');
    expect(metaText('est_duration_s', 48.6).replace(/\s/g, ' ')).toBe('49 s'); // seconds read as a duration
    expect(isSmoke([result({ metric: 'bf16', value: 0.005, extras: { smoke: true } })])).toBe(true);
    expect(isSmoke([result({ metric: 'bf16', value: 95 })])).toBe(false);
  });
});
