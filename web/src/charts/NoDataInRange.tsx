import { ChartLine, Radio } from 'lucide-react';
import { Button } from '../design/components/Button';
import { EmptyState } from '../design/components/EmptyState';
import { usePrefs } from '../store/prefs';

/** A chart with nothing in the chosen history range: says why, and offers the way back to Live (where data is). */
export function NoDataInRange({ node, what = 'Samples', offerLive = true }: { node: string; what?: string; offerLive?: boolean }) {
  const range = usePrefs((s) => s.timeRange);
  const set = usePrefs((s) => s.set);
  const showLive = offerLive && range !== 'live';
  return (
    <EmptyState
      icon={ChartLine}
      title="No data in this range"
      compact
      action={showLive ? <Button size="sm" variant="secondary" icon={<Radio />} onClick={() => { set({ timeRange: 'live' }); }}>Show live</Button> : undefined}
    >
      {showLive ? `${what} from ${node} start once it has reported for a while; Live shows what is arriving now.` : `${what} will appear here as soon as ${node} reports them.`}
    </EmptyState>
  );
}
