import { Panel } from '../design/components/Panel';
import { Skeleton } from '../design/components/Skeleton';
import { RowsSkeleton } from './placeholders';
import './views.css';

export default function Alerts() {
  return (
    <div className="view" aria-busy="true">
      <div className="grid grid--2-1">
        <Panel title="Timeline" subtitle="Alerts and node events, newest first" busy actions={<Skeleton width={180} height={28} radius={10} />}>
          <RowsSkeleton rows={8} />
        </Panel>
        <Panel title="Rules" subtitle="Thresholds that raise alerts" busy>
          <RowsSkeleton rows={6} />
        </Panel>
      </div>
    </div>
  );
}
