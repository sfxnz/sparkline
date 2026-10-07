// The per-core Heatmap over the global time range: Live reads the shared LiveStore; 5m/1h/24h/7d load downsampled
// history into a private LiveStore so the same Heatmap draws it.
import { useEffect, useMemo, useState } from 'react';
import { medianStep } from '../../../charts/gaps';
import { Heatmap } from '../../../charts/Heatmap';
import { LIVE_WINDOW_S } from '../../../charts/TimeSeriesChart';
import { NoDataInRange } from '../../../charts/NoDataInRange';
import { HistoryUnavailable } from '../../../charts/HistoryUnavailable';
import { Skeleton } from '../../../design/components/Skeleton';
import { fontScale } from '../../../charts/theme';
import type { TimeRange } from '../../../lib/prefs';
import type { CoreInfo, Sample } from '../../../lib/types';
import { serverNow } from '../../../store/cluster';
import { historyCache, RANGE_SECONDS, historyRefreshMs, type HistoryRange } from '../../../store/history';
import { LiveStore } from '../../../store/live';
import { usePrefs } from '../../../store/prefs';

/** A LiveStore holding history: reports the bucket width as the sample interval so each cell spans its bucket. */
class HistoryStore extends LiveStore {
  constructor(private readonly stepMs: number) {
    super(4096);
  }
  override latest(): Sample | null {
    return { interval_ms: this.stepMs } as Sample;
  }
}

const AGO: Record<TimeRange, string> = { live: `${Math.round(LIVE_WINDOW_S / 60)} min ago`, '5m': '5 min ago', '1h': '1 h ago', '24h': '24 h ago', '7d': '7 d ago' };
const ROW_H = 13;
const GROUP_GAP = 10;

/** Height the Heatmap will take, so loading and error states keep the final layout. */
function heatmapHeight(cores: readonly CoreInfo[]): number {
  const kinds = new Set(cores.map((c) => c.kind)).size;
  return cores.length * Math.round(ROW_H * fontScale()) + Math.max(0, kinds - 1) * GROUP_GAP;
}

export function RangeHeatmap({ node, cores }: { node: string; cores: readonly CoreInfo[] }) {
  const range = usePrefs((s) => s.timeRange);
  return (
    <div className="nb-heatmap">
      {range === 'live' ? <Heatmap node={node} cores={cores} windowS={LIVE_WINDOW_S} rowHeight={ROW_H} /> : <HistoryHeatmap key={range} node={node} cores={cores} range={range} />}
      <div className="nb-heatmap__time" aria-hidden="true">
        <span>{AGO[range]}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

function HistoryHeatmap({ node, cores, range }: { node: string; cores: readonly CoreInfo[]; range: HistoryRange }) {
  const keys = useMemo(() => cores.map((c) => `cpu.core${c.id}.util`), [cores]);
  const [state, setState] = useState<{ store: LiveStore; empty: boolean } | { error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      historyCache
        .load(node, keys, range, serverNow())
        .then((resp) => {
          if (cancelled) return;
          // Each cell is one bucket wide. Older agents reported the source table's resolution instead of the
          // bucket width, so the spacing of the points is the floor.
          const store = new HistoryStore(Math.max(resp.resolution_s, medianStep(resp.ts)) * 1000);
          store.seed(resp);
          store.flush();
          setState({ store, empty: resp.ts.length === 0 });
        })
        .catch((e: unknown) => {
          if (!cancelled) setState({ error: e });
        });
    };
    load();
    const t = setInterval(load, historyRefreshMs(range));
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [node, keys, range, attempt]);

  const height = heatmapHeight(cores);
  if (!state) return <Skeleton height={height} radius={6} />;
  if ('error' in state) {
    return (
      <div className="nb-heatmap__problem" style={{ minHeight: height }}>
        <HistoryUnavailable node={node} error={state.error} onRetry={() => { historyCache.clear(); setState(null); setAttempt((a) => a + 1); }} />
      </div>
    );
  }
  if (state.empty) {
    return (
      <div className="nb-heatmap__problem" style={{ minHeight: height }}>
        <NoDataInRange node={node} what="Per-core history" />
      </div>
    );
  }
  return <Heatmap node={node} cores={cores} windowS={RANGE_SECONDS[range]} rowHeight={ROW_H} store={state.store} cellAlign="center" />;
}
