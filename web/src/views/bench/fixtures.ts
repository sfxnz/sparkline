// Test and preview fixtures for the benchmark screens: a catalog and runs shaped exactly like the console's.
import type { BenchResult, BenchRun, BenchSpec } from '../../lib/types';

const impact = (thermal: 'low' | 'medium' | 'high', power: 'low' | 'medium' | 'high', disruptive: boolean, note = '') => ({ thermal, power, disruptive, note });
const param = (p: Partial<BenchSpec['params'][number]> & Pick<BenchSpec['params'][number], 'name' | 'label' | 'type' | 'default'>): BenchSpec['params'][number] => ({
  min: null,
  max: null,
  choices: null,
  unit: null,
  help: null,
  ...p,
});

export const MATMUL: BenchSpec = {
  id: 'gpu-matmul',
  name: 'GPU matmul',
  category: 'compute',
  description: 'Dense GEMM throughput (achieved TFLOPS) in BF16, FP16, FP8 and FP4.',
  est_duration_s: 90,
  impact: impact('medium', 'high', true, 'Saturates the GPU for about a minute.'),
  params: [
    param({ name: 'dtypes', label: 'Precisions', type: 'multi', default: ['bf16', 'fp16', 'fp8'], choices: ['bf16', 'fp16', 'fp8', 'fp4'] }),
    param({ name: 'size', label: 'Matrix size', type: 'enum', default: '8192', choices: ['4096', '8192', '16384'] }),
    param({ name: 'iterations', label: 'Iterations', type: 'int', default: 50, min: 5, max: 500 }),
  ],
  min_nodes: 1,
  max_nodes: 2,
  requires: ['docker', 'pytorch_image'],
  availability: { spark1: null, spark2: null, spark3: { message: 'spark3 is offline', cause: 'No samples for 2 min', fix: 'Check `systemctl status sparkline-agent` on spark3' } },
};

export const RDMA: BenchSpec = {
  id: 'rdma-bw-lat',
  name: 'RDMA bandwidth & latency',
  category: 'interconnect',
  description: 'ib_write_bw and ib_write_lat over a ConnectX-7 rail.',
  est_duration_s: 40,
  impact: impact('low', 'low', true),
  params: [
    param({ name: 'rail', label: 'Rail', type: 'enum', default: 'A', choices: ['A', 'B'] }),
    param({ name: 'duration_s', label: 'Duration', type: 'int', default: 10, min: 2, max: 60, unit: 's' }),
  ],
  min_nodes: 2,
  max_nodes: 2,
  requires: ['perftest'],
  availability: { spark1: null, spark2: null },
};

export const SOAK: BenchSpec = {
  id: 'thermal-soak',
  name: 'Thermal soak',
  category: 'soak',
  description: 'Sustained GEMM for 10–30 minutes.',
  est_duration_s: 600,
  impact: impact('high', 'high', true),
  params: [param({ name: 'minutes', label: 'Duration', type: 'int', default: 10, min: 10, max: 30, unit: 'min' })],
  min_nodes: 1,
  max_nodes: 1,
  requires: [],
  availability: { spark1: null },
};

export const LLM: BenchSpec = {
  id: 'llm-inference',
  name: 'LLM inference',
  category: 'inference',
  description: 'TTFT, prefill and decode tokens/s against an OpenAI-compatible endpoint.',
  est_duration_s: 60,
  impact: impact('medium', 'medium', true),
  params: [
    param({ name: 'base_url', label: 'Endpoint', type: 'string', default: 'http://127.0.0.1:8000/v1' }),
    param({ name: 'model', label: 'Model', type: 'string', default: 'default' }),
    param({ name: 'stream', label: 'Stream', type: 'bool', default: true }),
    param({ name: 'temperature', label: 'Temperature', type: 'float', default: 0, min: 0, max: 2 }),
  ],
  min_nodes: 1,
  max_nodes: 1,
  requires: [],
  availability: { spark1: null, spark2: null },
};

export const CATALOG: BenchSpec[] = [MATMUL, RDMA, SOAK, LLM];

export const result = (p: Partial<BenchResult> & Pick<BenchResult, 'metric' | 'value'>): BenchResult => ({
  label: p.metric,
  unit: 'TFLOPS',
  better: 'higher',
  node_id: 'spark1',
  extras: {},
  baseline: null,
  regression: false,
  ...p,
});

export const run = (p: Partial<BenchRun> & Pick<BenchRun, 'id'>): BenchRun => ({
  bench_id: 'gpu-matmul',
  params: { dtypes: ['bf16', 'fp16', 'fp8'], size: '8192', iterations: 50 },
  nodes: ['spark1'],
  status: 'succeeded',
  created_ts: 1_759_750_000,
  started_ts: 1_759_750_002,
  finished_ts: 1_759_750_092,
  progress: 1,
  phase: 'Done',
  results: [],
  series: {},
  metadata: {},
  error: null,
  log_tail: [],
  baseline_for: false,
  params_key: '{"dtypes":["bf16","fp16","fp8"],"iterations":50,"size":"8192"}',
  baseline_run_id: null,
  ...p,
});
