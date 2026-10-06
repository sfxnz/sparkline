// Layout-matching loading placeholders shared by the screens until their live content lands.
import { Panel } from '../design/components/Panel';
import { Skeleton } from '../design/components/Skeleton';

export function StatSkeleton({ wide }: { wide?: boolean }) {
  return (
    <div className="ph-stat">
      <Skeleton width={72} height={12} />
      <Skeleton width={wide ? 120 : 88} height={26} radius={8} />
    </div>
  );
}

export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="ph-chart" style={{ height }}>
      <Skeleton width={160} height={12} />
      <Skeleton height={height - 28} radius={10} />
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ph-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ph-row">
          <Skeleton width={16} height={16} radius={8} />
          <Skeleton width={`${30 + ((i * 17) % 35)}%`} height={13} />
          <Skeleton width={56} height={12} style={{ marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

export function ChartPanelSkeleton({ title, height }: { title: string; height?: number }) {
  return (
    <Panel title={title} busy>
      <ChartSkeleton height={height} />
    </Panel>
  );
}
