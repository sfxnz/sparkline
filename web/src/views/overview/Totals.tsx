// Cluster totals: compute, GPU power + energy today, unified memory pressure, active GPU work.
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { Stat } from '../../design/components/Stat';
import { formatBytes, formatPercent, percentParts, wattsParts, type Formatter } from '../../lib/format';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { formatEnergyCost, formatKwh } from '../shared/energy';
import { shallowEqual, useAcross, useEnergyToday, useOnlineIds } from './hooks';
import { clusterTotals, gpuProcesses, listNodes } from './model';

/** "16:13": the local time of a reading. */
const formatHm = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const countParts: Formatter = (n) => ({ value: n.toFixed(0), unit: '' });

export function Totals() {
  const online = useOnlineIds();
  const order = useCluster((s) => s.order);
  const infos = useCluster((s) => s.nodes);
  // Nothing live: keep showing the last known totals, dimmed with their age (Stat's stale state).
  const stale = !online.length;
  const ids = stale ? order : online;
  const totals = useAcross(
    ids,
    () => {
      const t = clusterTotals(
        ids.map((id) => ({
          util: liveStore.latestValue(id, 'gpu0.util'),
          power: liveStore.latestValue(id, 'gpu0.power_w'),
          memUsed: liveStore.latestValue(id, 'mem.used'),
          memTotal: infos[id]?.info?.mem_total ?? null,
          psi: liveStore.latestValue(id, 'mem.psi_some'),
        })),
      );
      const procs = ids.flatMap((id) => gpuProcesses(liveStore.latest(id)?.procs).map((p) => ({ id, p })));
      // A container is per node: the same name on two nodes (a TP=2 job) is two containers.
      const containers = new Set(procs.filter(({ p }) => p.container).map(({ id, p }) => `${id}/${p.container ?? ''}`)).size;
      const known = ids.some((id) => liveStore.latest(id)?.procs);
      const lastTs = Math.max(0, ...ids.map((id) => liveStore.lastTs(id) ?? 0));
      const r = (v: number | null, q: number) => (v === null ? null : Math.round(v / q) * q);
      return {
        util: r(t.util, 1),
        power: r(t.power, 0.1),
        memPct: r(t.memPct, 1),
        memUsed: r(t.memUsed, 1024 ** 3 / 10),
        memTotal: t.memTotal,
        psi: r(t.psiMax, 0.01),
        reporting: t.reporting,
        procs: known ? procs.length : null,
        containers,
        updatedAt: lastTs ? Math.floor(lastTs) : null,
      };
    },
    shallowEqual,
    `${Object.keys(infos).join()}|${String(stale)}`,
  );
  const staleProps = { stale, updatedAt: totals.updatedAt };
  const energy = useEnergyToday(order);
  const rate = useCluster((s) => s.cluster?.settings);
  const of = stale ? 'No node is reporting live data' : `${online.length === order.length ? 'All' : `${online.length} of`} ${order.length} ${order.length === 1 ? 'node' : 'nodes'} reporting`;

  return (
    <Panel label="Cluster totals" className="ov-totals">
      <div className="ov-totals__row">
        <Stat label="Cluster compute" size="lg" value={totals.util} format={percentParts} footer={`Mean GPU utilisation · ${of}`} {...staleProps} />
        <Stat
          label="GPU power"
          size="lg"
          value={totals.power}
          format={wattsParts}
          {...staleProps}
          footer={
            energy.loading ? (
              <Skeleton width={150} height={12} />
            ) : energy.joules === null ? (
              'Energy today unavailable'
            ) : (
              <span className="num">
                Today {formatKwh(energy.joules)}
                {rate ? ` · ${formatEnergyCost(energy.joules, rate.energy_rate_per_kwh, rate.currency)}` : ''}
                {Object.entries(energy.until).map(([id, ts]) => ` · ${id} until ${formatHm(ts)}`).join('')}
                {energy.missing.length ? ` · excl. ${listNodes(energy.missing)}` : ''}
              </span>
            )
          }
        />
        <Stat
          label="Unified memory in use"
          size="lg"
          value={totals.memPct}
          format={percentParts}
          {...staleProps}
          footer={
            totals.memUsed !== null && totals.memTotal ? (
              <span className="num">
                {formatBytes(totals.memUsed).replace(/\s?GiB$/, '')} of {formatBytes(totals.memTotal)}
                {totals.psi !== null ? (totals.psi < 0.05 ? ' · no memory pressure' : ` · waiting on memory ${formatPercent(totals.psi, totals.psi < 10 ? 1 : 0)} of the time`) : ''}
              </span>
            ) : (
              of
            )
          }
        />
        <Stat
          label="Active GPU processes"
          size="lg"
          value={totals.procs}
          format={countParts}
          {...staleProps}
          footer={totals.procs === null ? of : totals.containers ? `In ${totals.containers} ${totals.containers === 1 ? 'container' : 'containers'}` : 'No containers'}
        />
      </div>
    </Panel>
  );
}

export function TotalsSkeleton() {
  return (
    <Panel label="Cluster totals" className="ov-totals" busy>
      <div className="ov-totals__row">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat stat--lg">
            <Skeleton width={110} height={12} style={{ margin: '2px 0' }} />
            <Skeleton width={96} height={30} radius={8} style={{ margin: '2px 0' }} />
            <Skeleton width={160} height={12} style={{ margin: '2px 0' }} />
          </div>
        ))}
      </div>
    </Panel>
  );
}
