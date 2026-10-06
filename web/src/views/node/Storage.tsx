// Storage tab: how much space is left, how hard each disk is working, and how warm the NVMe runs.
import { ChevronRight, HardDrive, OctagonAlert, TriangleAlert } from 'lucide-react';
import { Link } from 'wouter';
import { paths } from '../../app/routes';
import { useCallback } from 'react';
import { TimeSeriesChart } from '../../charts/TimeSeriesChart';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { Skeleton } from '../../design/components/Skeleton';
import { formatBytes, formatTemp, percentParts, tempParts } from '../../lib/format';
import { mountKey } from '../../lib/metrics';
import type { DiskInfo, NodeInfo, SensorInfo } from '../../lib/types';
import { liveStore, useLatest } from '../../store/live';
import { ChartSkeleton, StatSkeleton } from '../placeholders';
import { lastKnown, useNodeStale } from '../shared/live';
import { useAlertRules, useDerived, useHasData, useLastKnown, useNodeInfo, type KeyGetter } from './partsB/hooks';
import { LiveStat } from './partsB/LiveStat';
import { NowLabel } from './parts/NowLabel';
import { StaleSince } from './partsB/StaleSince';
import { bytesRateParts, CAPACITY_LABEL, capacityLevel, capacityPolicy, capacityRules, formatBytesRate, fsFigures, fsUsedPct, iopsParts, type CapacityRule } from './partsB/storage';
import './partsB/partsB.css';

export default function Storage({ nodeId }: { nodeId: string }) {
  const info = useNodeInfo(nodeId);
  const hasData = useHasData(nodeId);
  if (!info || !hasData) return <StorageSkeleton />;
  return <StorageView node={nodeId} info={info} />;
}

function StorageView({ node, info }: { node: string; info: NodeInfo }) {
  const collectorError = useLatest(node, (s) => s?.errors.storage ?? null);
  const nvme = info.sensors.filter((x) => x.group === 'nvme');
  return (
    <div className="view view--flush nb">
      {collectorError ? <CollectorProblem node={node} info={info} error={collectorError} /> : null}
      <StorageStats node={node} info={info} failing={!!collectorError} />
      <CapacityPanel node={node} info={info} />
      {info.disks.length ? (
        info.disks.map((d) => <DiskPanel key={d.name} node={node} disk={d} failing={!!collectorError} />)
      ) : (
        <Panel title="Disks">
          <EmptyState icon={HardDrive} title="No disks reported" compact>
            The agent on {node} did not find any block devices to monitor.
          </EmptyState>
        </Panel>
      )}
      {nvme.length ? <NvmeTemps node={node} sensors={nvme} /> : null}
    </div>
  );
}

function CollectorProblem({ node, info, error }: { node: string; info: NodeInfo; error: string }) {
  const first = info.disks[0]?.name;
  const since = first ? lastKnown(liveStore, node, `disk.${first}.busy_pct`)?.ts : null;
  return (
    <Panel label="Storage collector status">
      <ProblemState
        compact
        message="Disk activity is not updating"
        cause={`The storage collector on ${node} failed: ${error}`}
        fix={`The agent retries every sample. If this persists, check \`dmesg\` on ${node} for NVMe or I/O errors. Values below are the last ones read.`}
        footnote={<StaleSince node={node} ts={since} label="Last good reading" />}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- stat row (every node tab opens with one)

function StorageStats({ node, info, failing }: { node: string; info: NodeInfo; failing: boolean }) {
  const disks = info.disks.map((d) => d.name);
  const sum = (m: string) => (get: KeyGetter) => {
    let total: number | null = null;
    for (const d of disks) {
      const v = get(`disk.${d}.${m}`);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  const busiest = (get: KeyGetter) => {
    let max: number | null = null;
    for (const d of disks) {
      const v = get(`disk.${d}.busy_pct`);
      if (v !== null && (max === null || v > max)) max = v;
    }
    return max;
  };
  const rootPct = (get: KeyGetter) => {
    const used = get('fs.root.used');
    const free = get('fs.root.free');
    return used !== null && free !== null ? fsUsedPct({ used, free }) : null;
  };
  const since = failing && disks[0] ? (lastKnown(liveStore, node, `disk.${disks[0]}.busy_pct`)?.ts ?? null) : null;
  const many = disks.length > 1;
  return (
    <Panel label="Storage now">
      <NowLabel />
      <div className="nstats">
        <LiveStat node={node} label="Root disk used" format={percentParts} derive={rootPct} footer="Filesystem /" />
        <LiveStat node={node} label="Read" format={bytesRateParts} derive={sum('read_bps')} stale={failing} updatedAt={since} footer={many ? `All ${disks.length} drives` : disks[0]} />
        <LiveStat node={node} label="Write" format={bytesRateParts} derive={sum('write_bps')} stale={failing} updatedAt={since} footer={many ? `All ${disks.length} drives` : disks[0]} />
        <LiveStat node={node} label="Busy" format={percentParts} derive={busiest} stale={failing} updatedAt={since} footer={many ? 'Busiest drive' : 'Time with I/O in flight'} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- capacity

function CapacityPanel({ node, info }: { node: string; info: NodeInfo }) {
  // The mount list changes rarely: the panel re-renders only when it does; each row follows its own numbers.
  // From the latest sample when there is one, else from the keys held for the node (an offline node opened fresh).
  const mounts = useLatest(node, (s) => (s ? s.fs.map((f) => `${f.key}\u0000${f.mount}\u0000${f.device}`).join('\u0001') : ''));
  const seededKeys = useDerived(node, () => (mounts ? '' : fsKeysInStore(node).join('|')));
  const stale = useNodeStale(node);
  const rules = useAlertRules();
  const ruleList = Array.isArray(rules) ? rules : [];
  const rows: [string, string, string][] = mounts
    ? mounts.split('\u0001').map((r) => r.split('\u0000') as [string, string, string])
    : seededKeys ? seededKeys.split('|').map((k): [string, string, string] => [k, mountForKey(info, k), '']).sort((a, b) => a[1].localeCompare(b[1])) : [];
  return (
    <Panel
      title="Capacity"
      subtitle={rules === null ? 'Checking the disk-space alert rules…' : rules === 'error' ? 'Alert rules unavailable: bars are not coloured' : capacityPolicy(capacityRules(ruleList, node, 'root'), rows.length > 1 ? '/' : '')}
      actions={
        <>
          {stale ? <StaleSince node={node} /> : null}
          <Link href={paths.alerts} className="ntablink">Alert rules<ChevronRight aria-hidden="true" /></Link>
        </>
      }
    >
      {rows.length ? (
        <ul className={`nb-fs${stale ? ' is-stale' : ''}`}>
          {rows.map(([key, mount, device]) => <FsRow key={key} node={node} fsKey={key} mount={mount} device={device} rules={capacityRules(ruleList, node, key)} />)}
        </ul>
      ) : (
        <EmptyState icon={HardDrive} title="No filesystems reported" compact>
          No mounted filesystems were reported by {node}.
        </EmptyState>
      )}
    </Panel>
  );
}

function fsKeysInStore(node: string): string[] {
  return liveStore.keys(node).flatMap((k) => /^fs\.(.+)\.used$/.exec(k)?.slice(1, 2) ?? []);
}

function mountForKey(info: NodeInfo, key: string): string {
  return info.disks.flatMap((d) => d.mounts).find((m) => mountKey(m) === key) ?? key;
}

function FsRow({ node, fsKey, mount, device, rules }: { node: string; fsKey: string; mount: string; device: string; rules: CapacityRule[] }) {
  // Last known values (live, or the seeded history of an offline node): exact df-style numbers either way.
  const used = useLastKnown(node, `fs.${fsKey}.used`);
  const free = useLastKnown(node, `fs.${fsKey}.free`);
  const total = useLastKnown(node, `fs.${fsKey}.total`);
  const nums = used !== null && free !== null && total !== null ? { used, free, total } : null;
  // One denominator everywhere (bar, label, screen-reader text): usable = used + free, as df and the alert rule use.
  const fig = nums ? fsFigures(nums) : null;
  const pct = fig?.pct ?? null;
  const level = capacityLevel(pct, rules);
  const Icon = level === 'crit' ? OctagonAlert : TriangleAlert;
  const label = pct === null ? 'Size unknown' : `${pct.toFixed(0)}% used`;
  const reserved = fig && nums && fig.reserved > 0.005 * nums.total ? fig.reserved : null;
  return (
    <li className={`nb-fs__row tone-${level}`}>
      <div className="nb-fs__head">
        <span className="nb-fs__mount">{mount}</span>
        {device ? <span className="nb-meta num">{device}</span> : null}
        {level === 'ok' ? null : (
          <span className="nb-fs__status">
            <Icon aria-hidden="true" />
            <span>{CAPACITY_LABEL[level]}</span>
          </span>
        )}
      </div>
      <div
        className="nb-fs__bar"
        role="meter"
        aria-label={`${mount} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={nums && fig ? `${label}: ${formatBytes(nums.used)} of ${formatBytes(fig.usable)} usable, ${formatBytes(nums.free)} free${level === 'ok' ? '' : `. ${CAPACITY_LABEL[level]}`}` : label}
      >
        <span className="nb-fs__fill" style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} />
        {rules.map((r) => (
          <span key={r.pct} className="nb-fs__tick" style={{ left: `${r.pct}%` }} aria-hidden="true" />
        ))}
      </div>
      <div className="nb-fs__foot num">
        <span><strong>{label}</strong>{nums && fig ? ` · ${formatBytes(nums.used)} of ${formatBytes(fig.usable)} usable` : null}</span>
        <span>
          {nums ? `${formatBytes(nums.free)} free` : null}
          {reserved !== null ? <span className="nb-meta"> · {formatBytes(reserved)} reserved for root</span> : null}
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- disks

function DiskPanel({ node, disk, failing }: { node: string; disk: DiskInfo; failing: boolean }) {
  const rate = useCallback((v: number) => formatBytesRate(v), []);
  const pct = useCallback((v: number) => `${v.toFixed(0)}%`, []);
  const k = (m: string) => `disk.${disk.name}.${m}`;
  const subtitle = [disk.name, disk.size_bytes ? formatBytes(disk.size_bytes) : null, disk.mounts.length ? `mounted at ${disk.mounts.join(', ')}` : null].filter(Boolean).join(' · ');
  const since = failing ? (lastKnown(liveStore, node, k('busy_pct'))?.ts ?? null) : null;
  return (
    <Panel title={disk.model ?? disk.name} subtitle={<span className="num">{subtitle}</span>} actions={failing ? <StaleSince node={node} ts={since} label="Last good reading" /> : undefined}>
      <div className="nb-card">
        <div className="nb-stats nb-stats--disk">
          <LiveStat node={node} label="Read" format={bytesRateParts} metric={k('read_bps')} stale={failing} updatedAt={since} />
          <LiveStat node={node} label="Write" format={bytesRateParts} metric={k('write_bps')} stale={failing} updatedAt={since} />
          <LiveStat node={node} label="Read IOPS" format={iopsParts} metric={k('read_iops')} stale={failing} updatedAt={since} />
          <LiveStat node={node} label="Write IOPS" format={iopsParts} metric={k('write_iops')} stale={failing} updatedAt={since} />
          <LiveStat node={node} label="Busy" format={percentParts} metric={k('busy_pct')} stale={failing} updatedAt={since} footer="Time with I/O in flight" />
        </div>
        <div className={`grid nb-grid-disk${failing ? ' is-stale' : ''}`}>
          <TimeSeriesChart node={node} title={`${disk.name} throughput`} series={[{ key: k('read_bps'), label: 'Read' }, { key: k('write_bps'), label: 'Write' }]} format={rate} yMin={0} height={200} />
          <TimeSeriesChart node={node} title={`${disk.name} busy`} series={[{ key: k('busy_pct'), label: 'Busy' }]} format={pct} yMin={0} yMax={100} height={200} />
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- temperatures

function NvmeTemps({ node, sensors }: { node: string; sensors: SensorInfo[] }) {
  const crit = sensors.find((s) => s.crit_c != null)?.crit_c ?? null;
  const fmt = useCallback((v: number) => formatTemp(v), []);
  return (
    <Panel title="NVMe temperature" subtitle={crit != null ? `Drive reports critical at ${formatTemp(crit)}` : 'The drive does not report a critical temperature'}>
      <div className="nb-card">
        <div className="nb-stats nb-stats--temps">
          {sensors.map((s) => (
            <LiveStat
              key={s.id}
              node={node}
              label={s.label.replace(/^NVMe\s+/i, '')}
              format={tempParts}
              metric={`temp.${s.id}`}
              footer={s.crit_c != null ? `Critical at ${formatTemp(s.crit_c)}` : undefined}
            />
          ))}
        </div>
        <TimeSeriesChart
          node={node}
          title="NVMe temperature"
          series={sensors.slice(0, 4).map((s) => ({ key: `temp.${s.id}`, label: s.label.replace(/^NVMe\s+/i, '') }))}
          format={fmt}
          height={200}
          thresholds={crit != null ? [{ value: crit, label: `Critical ${formatTemp(crit)}`, tone: 'crit' }] : undefined}
        />
      </div>
    </Panel>
  );
}

function StorageSkeleton() {
  return (
    <div className="view view--flush nb" aria-busy="true">
      <Panel label="Storage now" busy>
        <div className="nstats"><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /></div>
      </Panel>
      <Panel title="Capacity" busy>
        <div className="nb-fs">
          {[0, 1].map((i) => (
            <div key={i} className="nb-fs__row">
              <Skeleton width={160} height={14} />
              <Skeleton height={8} radius={4} />
              <Skeleton width={240} height={12} />
            </div>
          ))}
        </div>
      </Panel>
      <Panel title={<Skeleton width={220} height={16} />} busy>
        <div className="nb-card">
          <div className="nb-stats nb-stats--disk"><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /></div>
          <div className="grid nb-grid-disk"><ChartSkeleton height={234} /><ChartSkeleton height={234} /></div>
        </div>
      </Panel>
    </div>
  );
}
