import { Panel } from '../design/components/Panel';
import { Skeleton } from '../design/components/Skeleton';
import { RowsSkeleton } from './placeholders';
import './views.css';

const CATALOG = ['Compute', 'Memory bandwidth', 'CPU', 'NCCL all-reduce', 'RDMA', 'Storage', 'LLM inference', 'Thermal soak'];

/** Lazy chunk: the benchmark suite. */
export default function Benchmarks() {
  return (
    <div className="view" aria-busy="true">
      <div className="grid grid--catalog">
        {CATALOG.map((name) => (
          <Panel key={name} title={name} busy>
            <div className="ph-bench">
              <Skeleton height={12} />
              <Skeleton width="70%" height={12} />
              <div className="ph-bench__foot">
                <Skeleton width={64} height={20} radius={10} />
                <Skeleton width={72} height={26} radius={8} />
              </div>
            </div>
          </Panel>
        ))}
      </div>
      <Panel title="History" busy>
        <RowsSkeleton rows={5} />
      </Panel>
    </div>
  );
}
