// The one-second answer: cluster health (sentence + pill) and what the cluster is doing right now.
import { AnimatedNumber } from '../../design/components/AnimatedNumber';
import { Skeleton } from '../../design/components/Skeleton';
import { StatusPill } from '../../design/components/StatusPill';
import { wattsParts } from '../../lib/format';
import { gpuProcessesGap, gpusWithUnknownProcesses } from '../../lib/gpu';
import { quietGpusOf } from '../../store/attention';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { excl } from '../shared/totalGap';
import { clusterGpuNow, shallowEqual, useAcross, useClusterHealth, useOnlineIds } from './hooks';
import { workloadSentence } from './model';

const intText = (n: number) => n.toFixed(0);
const wattsText = (n: number) => wattsParts(n, 'W').value;

export function Hero() {
  const health = useClusterHealth();

  return (
    <header className="ov-hero">
      <div className="ov-hero__line">
        <h2 className="ov-hero__sentence">{health.sentence}</h2>
        <StatusPill status={health.status} label={health.label} />
      </div>
      <Activity />
    </header>
  );
}

/** "Serving X across 2 nodes · GPU 91% at 58 W". Re-renders when the words change; numbers animate in place. */
function Activity() {
  const online = useOnlineIds();
  const nodes = useCluster((s) => s.nodes);
  const a = useAcross(
    online,
    () => {
      const now = clusterGpuNow(online, nodes);
      return {
        workload: workloadSentence(online.map((id) => {
          const s = liveStore.latest(id);
          const info = nodes[id]?.info;
          const quiet = quietGpusOf(id, info);
          const of = info?.gpus.length ?? 0;
          return { id, procs: s?.procs ?? null, cannotTell: gpuProcessesGap(info, s, quiet) !== null, gpusRead: { from: of - gpusWithUnknownProcesses(info, s, quiet).length, of } };
        })),
        util: now.util === null ? null : Math.round(now.util),
        power: now.power === null ? null : Math.round(now.power * 10) / 10,
        dropped: now.dropped,
        utilFrom: now.utilFrom,
      };
    },
    shallowEqual,
    Object.keys(nodes).join(),
  );

  if (!online.length) return <p className="ov-hero__activity ov-dim">No node is reporting live data.</p>;
  if (a.util === null && a.workload === null) {
    return (
      <p className="ov-hero__activity" aria-hidden="true">
        <Skeleton width={360} height={14} />
      </p>
    );
  }
  return (
    <p className="ov-hero__activity">
      {a.workload ? <span className="ov-hero__workload">{a.workload}</span> : null}
      {a.util !== null ? (
        <span className="ov-hero__numbers">
          {a.workload ? <span className="ov-hero__sep" aria-hidden="true">· </span> : null}
          GPU <AnimatedNumber value={a.util} format={intText} />%
          {a.utilFrom ? ` (${a.utilFrom})` : null}
          {a.power !== null ? (
            <>
              {' '}at <AnimatedNumber value={a.power} format={wattsText} />{' '}W
              {a.dropped ? ` · ${excl(a.dropped.split('\n'))}` : null}
            </>
          ) : null}
        </span>
      ) : null}
    </p>
  );
}

export function HeroSkeleton() {
  return (
    <header className="ov-hero" aria-hidden="true">
      <div className="ov-hero__line">
        <Skeleton width={300} height={24} radius={7} />
        <Skeleton width={78} height={24} radius={12} />
      </div>
      <p className="ov-hero__activity">
        <Skeleton width={360} height={14} />
      </p>
    </header>
  );
}
