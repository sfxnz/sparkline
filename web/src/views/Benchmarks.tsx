// Lazy chunk: the benchmark suite. Until the runner ships, a designed "not available yet" page that says what the
// suite will measure, instead of skeletons that look like a page stuck loading.
import { Gauge } from 'lucide-react';
import { EmptyState } from '../design/components/EmptyState';
import { Panel } from '../design/components/Panel';
import './views.css';

const CATALOG: readonly { name: string; what: string }[] = [
  { name: 'Compute', what: 'Dense matrix-multiply throughput in BF16, FP16, FP8 and FP4, as achieved TFLOPS.' },
  { name: 'Memory bandwidth', what: 'Unified-memory bandwidth, measured from both the GPU and the CPU side.' },
  { name: 'CPU', what: 'Single- and multi-core throughput, separately for performance and efficiency cores.' },
  { name: 'NCCL all-reduce', what: 'Cross-node all_reduce_perf over the ConnectX-7 link.' },
  { name: 'RDMA', what: 'Bandwidth and latency over a ConnectX-7 rail with perftest.' },
  { name: 'Storage', what: 'Sequential and random read/write profiles on the NVMe drive.' },
  { name: 'LLM inference', what: 'Time to first token, prefill and decode tokens per second, memory footprint.' },
  { name: 'Thermal soak', what: '10–30 minutes of sustained load, graphing clocks, throttling and temperature.' },
];

export default function Benchmarks() {
  return (
    <div className="view">
      <Panel label="Benchmarks status">
        <EmptyState icon={Gauge} title="Benchmarks aren’t available yet">
          The benchmark runner is not part of this release, so nothing can be run from here yet. These are the
          suites it will offer, each with a confirmation step, live telemetry and saved results.
        </EmptyState>
      </Panel>
      <ul className="grid grid--catalog bench-soon" aria-label="Planned benchmark suites">
        {CATALOG.map((b) => (
          <li key={b.name}>
            <Panel title={b.name}>
              <p className="bench-soon__what">{b.what}</p>
            </Panel>
          </li>
        ))}
      </ul>
    </div>
  );
}
