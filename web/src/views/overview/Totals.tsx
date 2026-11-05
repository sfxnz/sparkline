// Cluster totals: compute, GPU power + energy today, memory in use and pressure, active GPU work.
import { Panel } from '../../design/components/Panel';
import { Skeleton } from '../../design/components/Skeleton';
import { Stat } from '../../design/components/Stat';
import { gapAcross, notReported, type NotReported } from '../../lib/capabilities';
import { formatBytes, formatPercent, percentParts, wattsParts, type Formatter } from '../../lib/format';
import { memoryLayout } from '../../lib/memoryLayout';
import { gpuList, gpuProcessesGap, gpuSetGap, gpusWithUnknownProcesses, nodeGpuKey, nodeTotalGap } from '../../lib/gpu';
import type { NodeTotal } from '../../lib/metrics';
import type { NodeState } from '../../lib/types';
import { quietGpusOf, silentForOf } from '../../store/attention';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { formatEnergyCost, formatHm, formatKwh, stopsText, untilText } from '../shared/energy';
import { excl } from '../shared/totalGap';
import { nodeUtil, shallowEqual, useAcross, useEnergyToday, useOnlineIds, utilGpusRead } from './hooks';
import { clusterTotals, gpuProcesses } from './model';

const countParts: Formatter = (n) => ({ value: n.toFixed(0), unit: '' });

function leftOut(ids: readonly string[], gapOf: (id: string) => NotReported | null): { excl: string[]; gap: NotReported | null } {
  const gaps = ids.flatMap((id) => {
    const gap = gapOf(id);
    return gap ? [[id, gap] as const] : [];
  });
  return { excl: gaps.map(([id]) => id), gap: gaps.length && gaps.length === ids.length ? gapAcross(gaps) : null };
}

const droppedOut = (ids: readonly string[], nodes: Record<string, NodeState>, field: NodeTotal) =>
  ids.filter((id) => nodeTotalGap(nodes[id]?.info, liveStore.latest(id), field)).join('\n');
const exclText = (ids: readonly string[]) => (ids.length ? ` · ${excl(ids)}` : '');

export function Totals() {
  const online = useOnlineIds();
  const order = useCluster((s) => s.order);
  const infos = useCluster((s) => s.nodes);
  // Nothing live: keep showing the last known totals, dimmed with their age (Stat's stale state).
  const stale = !online.length;
  const ids = stale ? order : online;
  const procsGap = (id: string) => gpuProcessesGap(infos[id]?.info, liveStore.latest(id), quietGpusOf(id, infos[id]?.info), silentForOf(id, infos[id]?.info));
  const totals = useAcross(
    ids,
    () => {
      const t = clusterTotals(
        ids.map((id) => ({
          ...nodeUtil(id, infos[id]?.info),
          power: liveStore.latestValue(id, nodeGpuKey(infos[id]?.info, 'power_w')),
          memUsed: liveStore.latestValue(id, 'mem.used'),
          memTotal: infos[id]?.info?.mem_total ?? null,
          psi: liveStore.latestValue(id, 'mem.psi_some'),
        })),
      );
      const procsOut = ids.filter((id) => procsGap(id));
      const counted = ids.filter((id) => !procsOut.includes(id));
      const procsPartly = counted.flatMap((id) => {
        const unknown = gpusWithUnknownProcesses(infos[id]?.info, liveStore.latest(id), quietGpusOf(id, infos[id]?.info));
        return unknown.length ? [`${id}: ${gpuList(unknown)}`] : [];
      });
      const procs = counted.flatMap((id) => gpuProcesses(liveStore.latest(id)?.procs).map((p) => ({ id, p })));
      // A container is per node: the same name on two nodes (a TP=2 job) is two containers.
      const containers = new Set(procs.filter(({ p }) => p.container).map(({ id, p }) => `${id}/${p.container ?? ''}`)).size;
      const known = counted.some((id) => liveStore.latest(id)?.procs);
      const lastTs = Math.max(0, ...ids.map((id) => liveStore.lastTs(id) ?? 0));
      const r = (v: number | null, q: number) => (v === null ? null : Math.round(v / q) * q);
      const memMissing = ids.filter((id) => liveStore.latestValue(id, 'mem.used') === null || !infos[id]?.info?.mem_total);
      return {
        util: r(t.util, 1),
        power: r(t.power, 0.1),
        memPct: r(t.memPct, 1),
        memUsed: r(t.memUsed, 1024 ** 3 / 10),
        memTotal: t.memTotal,
        psi: r(t.psiMax, 0.01),
        reporting: t.reporting,
        memMissing: memMissing.join('\n'),
        procs: known ? procs.length : null,
        containers,
        procsOut: procsOut.join('\n'),
        procsPartly: procsPartly.join('\n'),
        utilDropped: droppedOut(ids, infos, 'util'),
        utilFrom: utilGpusRead(ids, infos),
        powerDropped: droppedOut(ids, infos, 'power_w'),
        updatedAt: lastTs ? Math.floor(lastTs) : null,
      };
    },
    shallowEqual,
    `${Object.keys(infos).join()}|${String(stale)}`,
  );
  const staleProps = { stale, updatedAt: totals.updatedAt };
  const energy = useEnergyToday(order);
  const rate = useCluster((s) => s.cluster?.settings);
  const allOnline = !stale && online.length === order.length;
  const of = stale ? 'No node is reporting live data' : `${allOnline ? 'All' : `${online.length} of`} ${order.length} ${order.length === 1 ? 'node' : 'nodes'} reporting`;
  const memMissing = totals.memMissing ? totals.memMissing.split('\n') : [];
  const memGap = !stale && ids.length === 1 && memMissing.length === 1 ? notReported(infos[ids[0] ?? '']?.info, 'mem') : null;
  const totalOut = (field: NodeTotal, dropped: string) => (id: string) =>
    dropped.split('\n').includes(id) ? nodeTotalGap(infos[id]?.info, liveStore.latest(id), field, silentForOf(id, infos[id]?.info)) : null;
  const util = leftOut(ids, totalOut('util', totals.utilDropped));
  const power = leftOut(ids, totalOut('power_w', totals.powerDropped));
  const gpuProcs = leftOut(ids, (id) => (totals.procsOut.split('\n').includes(id) ? procsGap(id) : null));
  const gpuProcsExcl = [...gpuProcs.excl, ...(totals.procsPartly ? totals.procsPartly.split('\n') : [])];
  const energyGaps = leftOut(ids, (id) => gpuSetGap(infos[id]?.info, 'energy_j', 'every'));
  const energyExcl = [...new Set([...energyGaps.excl, ...energy.missing])];
  const powerOnly = power.excl.filter((id) => !energyExcl.includes(id));
  const nowExcl = powerOnly.length ? `Now ${excl(powerOnly)} · ` : '';
  const today = (prefix: string) =>
    energy.joules === null ? null : (
      <span className="num">
        {prefix}Today {formatKwh(energy.joules)}
        {exclText(energyExcl)}
        {energy.empty.length ? ` · ${excl(energy.empty)} (no energy reading today)` : ''}
        {rate ? ` · ${formatEnergyCost(energy.joules, rate.energy_rate_per_kwh, rate.currency)}` : ''}
        {Object.entries(energy.until).map(([id, ts]) => ` · ${id} until ${formatHm(ts)}`).join('')}
        {Object.entries(energy.stops).map(([id, stops]) => ` · ${id} ${(infos[id]?.info?.gpus.length ?? 0) > 1 ? stopsText(stops) : untilText(stops[0]?.at ?? null)}`).join('')}
      </span>
    );
  const unified = ids.every((id) => memoryLayout(infos[id]?.info).name === 'Unified memory');

  return (
    <Panel label="Cluster totals" className="ov-totals">
      <div className="ov-totals__row">
        <Stat label="Cluster compute" size="lg" value={totals.util} format={percentParts} unsupported={util.gap} footer={`Mean GPU utilisation${totals.utilFrom ? ` (${totals.utilFrom})` : ''}${exclText(util.excl)}${util.excl.length && allOnline ? '' : ` · ${of}`}`} {...staleProps} />
        <Stat
          label="GPU power"
          size="lg"
          value={totals.power}
          format={wattsParts}
          {...staleProps}
          unsupported={power.gap}
          footer={energy.loading ? <Skeleton width={150} height={12} /> : (today(nowExcl) ?? `${nowExcl}Energy today unavailable${exclText(energyGaps.excl)}`)}
          gapFooter={today('')}
        />
        <Stat
          label={unified ? 'Unified memory in use' : 'System memory in use'}
          size="lg"
          value={totals.memPct}
          format={percentParts}
          {...staleProps}
          unsupported={memGap}
          footer={
            totals.memUsed !== null && totals.memTotal ? (
              <span className="num">
                {formatBytes(totals.memUsed).replace(/\s?GiB$/, '')} of {formatBytes(totals.memTotal)}
                {exclText(memMissing)}
                {totals.psi !== null ? (totals.psi < 0.05 ? ' · no memory pressure' : ` · waiting on memory ${formatPercent(totals.psi, totals.psi < 10 ? 1 : 0)} of the time`) : ''}
              </span>
            ) : stale ? (
              of
            ) : memGap ? null : (
              'No node is reporting memory'
            )
          }
        />
        <Stat
          label="Active GPU processes"
          size="lg"
          value={totals.procs}
          format={countParts}
          {...staleProps}
          unsupported={gpuProcs.gap}
          footer={`${totals.procs === null ? of : totals.containers ? `In ${totals.containers} ${totals.containers === 1 ? 'container' : 'containers'}` : 'No containers'}${exclText(gpuProcsExcl)}`}
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
