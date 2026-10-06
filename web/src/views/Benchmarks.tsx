// Lazy chunk: the benchmark suite. One entry for /benchmarks (catalog + history), /benchmarks/runs/:id (a run) and
// /benchmarks/compare?ids= (side-by-side); everything it renders lives in ./bench and stays out of the main bundle.
import { useRoute } from 'wouter';
import { Compare } from './bench/Compare';
import { Home } from './bench/Home';
import { RunView } from './bench/RunView';
import './bench/bench.css';

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default function Benchmarks() {
  const [isRun, params] = useRoute<{ id: string }>('/benchmarks/runs/:id');
  const [isCompare] = useRoute('/benchmarks/compare');
  if (isRun) return <RunView id={decode(params.id)} />;
  if (isCompare) return <Compare />;
  return <Home />;
}
