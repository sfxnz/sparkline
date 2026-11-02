// GPU utilisation and GPU (rail) power per node over the global time range. One chart per node and metric, all
// on the shared crosshair, so the rows line up in time.
import { lazy, Suspense } from 'react';
import { Panel } from '../../design/components/Panel';
import { formatPercent, formatWatts } from '../../lib/format';
import type { TimeRange } from '../../lib/prefs';
import { usePrefs } from '../../store/prefs';
import { ChartSkeleton } from '../placeholders';

const TimeSeriesChart = lazy(() => import('../../charts/TimeSeriesChart').then((m) => ({ default: m.TimeSeriesChart })));

const RANGE_TEXT: Record<TimeRange, string> = {
  live: 'Live · last 3 minutes',
  '5m': 'Last 5 minutes',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

const CHART_H = 128;
const pct = (n: number) => formatPercent(n);

export function ClusterChart({ nodes }: { nodes: readonly string[] }) {
  const range = usePrefs((s) => s.timeRange);
  return (
    <Panel title="GPU activity" subtitle={`Utilisation and GPU power per node, on shared scales · ${RANGE_TEXT[range]}`}>
      <div className="ov-chart">
        <span className="ov-chart__col t-eyebrow" aria-hidden="true">Utilisation</span>
        <span className="ov-chart__col t-eyebrow" aria-hidden="true">GPU power</span>
        <Suspense fallback={<SkeletonRows rows={nodes.length} />}>
          {nodes.map((id) => (
            <div key={id} className="ov-chart__row">
              <TimeSeriesChart node={id} title={`${id} GPU utilisation`} series={[{ key: 'gpu0.util', label: id }]} format={pct} yMin={0} yMax={100} height={CHART_H} />
              <TimeSeriesChart node={id} title={`${id} GPU power`} series={[{ key: 'gpu0.power_w', label: id }]} format={formatWatts} yMin={0} yGroup="overview-gpu-power" height={CHART_H} />
            </div>
          ))}
        </Suspense>
      </div>
    </Panel>
  );
}

export function ClusterChartSkeleton({ rows }: { rows: number }) {
  return (
    <Panel title="GPU activity" subtitle="Utilisation and GPU power per node" busy>
      <div className="ov-chart">
        <span className="ov-chart__col t-eyebrow">Utilisation</span>
        <span className="ov-chart__col t-eyebrow">GPU power</span>
        <SkeletonRows rows={rows} />
      </div>
    </Panel>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, i) => (
    <div key={i} className="ov-chart__row">
      <ChartSkeleton height={CHART_H + 34} />
      <ChartSkeleton height={CHART_H + 34} />
    </div>
  ));
}
