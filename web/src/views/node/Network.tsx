// Network tab: the ConnectX-7 interconnect first (one card per rail), then the LAN; virtual and wireless interfaces
// stay behind a disclosure.
import { Cable, ChevronRight, CircleCheck, Info, Network as NetworkIcon, TriangleAlert } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { TimeSeriesChart } from '../../charts/TimeSeriesChart';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { StatusPill } from '../../design/components/StatusPill';
import { Tooltip } from '../../design/components/Tooltip';
import { bitrateParts, formatBitrate, type Formatter } from '../../lib/format';
import type { NetIfInfo, NetSample, NodeInfo, Sample } from '../../lib/types';
import { useLatest } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { ChartSkeleton, StatSkeleton } from '../placeholders';
import { spanPhrase, useNodeStale } from '../shared/live';
import { serverNow } from '../../store/cluster';
import { useCounterTotals, useDerived, useHasData, useLastKnown, useNodeInfo } from './partsB/hooks';
import { LiveStat } from './partsB/LiveStat';
import { classifyInterfaces, errorSummary, lineRateUtil, rdmaRateLabel, rdmaStateLabel, speedLabel } from './partsB/net';
import { Skeleton } from '../../design/components/Skeleton';
import './partsB/partsB.css';

const utilParts: Formatter = (v) => ({ value: v < 9.95 ? v.toFixed(1) : v.toFixed(0), unit: '%' });

export default function Network({ nodeId }: { nodeId: string }) {
  const info = useNodeInfo(nodeId);
  const hasData = useHasData(nodeId);
  if (!info || !hasData) return <NetworkSkeleton />;
  return <NetworkView node={nodeId} info={info} />;
}

function NetworkView({ node, info }: { node: string; info: NodeInfo }) {
  // Re-render only when which interfaces are up changes.
  const upKey = useDerived(node, (get) => info.net.filter((n) => get(`net.${n.name}.up`) === 1).map((n) => n.name).join('|'));
  const up = new Set(upKey.split('|'));
  const groups = classifyInterfaces(info.net, (name) => up.has(name));

  return (
    <div className="view view--flush nb">
      <section className="nb-section" aria-labelledby="nb-ic-title">
        <header className="nb-section__head">
          <h2 id="nb-ic-title" className="nb-section__title">Interconnect</h2>
          <span className="nb-section__note">Includes RDMA traffic</span>
          <Tooltip content="RDMA traffic (NCCL, RoCE) bypasses the kernel, so the operating system's interface counters miss almost all of it. Sparkline adds each ConnectX-7 function's RDMA port counters, so these numbers include it.">
            <button type="button" className="nb-info" aria-label="About interconnect counters">
              <Info aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        {groups.links.length ? (
          <div className="grid nb-grid-rails">
            {groups.links.map((n) => <IfaceCard key={n.name} node={node} iface={n} />)}
          </div>
        ) : (
          <Panel label="No interconnect links">
            <EmptyState icon={Cable} title="No interconnect links" compact>
              {groups.notConnected.length
                ? `This node has ${groups.notConnected.length} ConnectX-7 ${groups.notConnected.length === 1 ? 'port' : 'ports'}, but none has a link. Connect a cable to a peer node to use the direct interconnect.`
                : 'No ConnectX-7 ports were found on this node.'}
            </EmptyState>
          </Panel>
        )}
        {groups.notConnected.length ? <NotConnected ifaces={groups.notConnected} /> : null}
      </section>

      {groups.lan.length ? (
        <section className="nb-section" aria-labelledby="nb-lan-title">
          <header className="nb-section__head">
            <h2 id="nb-lan-title" className="nb-section__title">Local network</h2>
          </header>
          <div className="grid nb-grid-rails">
            {groups.lan.map((n) => <IfaceCard key={n.name} node={node} iface={n} />)}
          </div>
        </section>
      ) : null}

      {groups.hidden.length ? <VirtualInterfaces node={node} ifaces={groups.hidden} /> : null}
    </div>
  );
}

function useIfSample<T>(node: string, name: string, pick: (n: NetSample) => T, fallback: T): T {
  return useLatest(node, (s) => {
    const n = findIf(s, name);
    return n ? pick(n) : fallback;
  });
}
const findIf = (s: Sample | null, name: string): NetSample | null => s?.net.find((n) => n.name === name) ?? null;

function LinkPills({ node, iface }: { node: string; iface: NetIfInfo }) {
  const up = useLastKnown(node, `net.${iface.name}.up`) === 1;
  const rdma = useIfSample(node, iface.name, (n) => n.rdma_state, null);
  const rate = useIfSample(node, iface.name, (n) => n.rdma_rate, null);
  const speed = useIfSample(node, iface.name, (n) => n.speed_mbps, null) ?? iface.speed_mbps;
  const stale = useNodeStale(node);
  const rdmaLabel = rdmaStateLabel(rdma);
  const rdmaOk = rdma ? /active/i.test(rdma) : null;
  const status = stale ? 'stale' : up ? 'healthy' : 'critical';
  return (
    <div className="nb-pills">
      <StatusPill size="sm" status={status} label={up ? 'Link up' : 'Link down'} />
      {iface.rdma_device && rdmaLabel ? (
        <StatusPill size="sm" status={stale ? 'stale' : rdmaOk ? 'healthy' : 'warning'} label={`RDMA ${rdmaLabel.toLowerCase()}`} />
      ) : null}
      <span className="nb-pills__rate num">{rdmaRateLabel(rate) ?? speedLabel(speed) ?? 'Speed unknown'}</span>
    </div>
  );
}

/** One interface: link state, live rx/tx, share of line rate, both directions over time and errors in range. */
function IfaceCard({ node, iface }: { node: string; iface: NetIfInfo }) {
  const range = usePrefs((s) => s.timeRange);
  const bits = useCallback((v: number) => formatBitrate(v), []);
  const speed = useIfSample(node, iface.name, (n) => n.speed_mbps, null) ?? iface.speed_mbps;
  const title = (
    <span className="nb-card__title">
      <span>{iface.label}</span>
      {iface.peer ? <span className="nb-card__peer">to {iface.peer}</span> : null}
    </span>
  );
  return (
    <Panel
      title={title}
      label={`${iface.label}${iface.peer ? ` to ${iface.peer}` : ''}`}
      subtitle={<IfaceMeta iface={iface} />}
    >
      <div className="nb-card">
        <LinkPills node={node} iface={iface} />
        <div className="nb-stats nb-stats--rail">
          <LiveStat node={node} label="Receive" format={bitrateParts} metric={`net.${iface.name}.rx_bps`} />
          <LiveStat node={node} label="Transmit" format={bitrateParts} metric={`net.${iface.name}.tx_bps`} />
          <LiveStat
            node={node}
            label="Line rate used"
            format={utilParts}
            derive={(get) => {
              const rx = get(`net.${iface.name}.rx_bps`);
              const tx = get(`net.${iface.name}.tx_bps`);
              return rx === null && tx === null ? null : lineRateUtil(rx, tx, speed);
            }}
            footer={speed ? `of ${speedLabel(speed) ?? ''} each way` : 'Line rate unknown'}
          />
        </div>
        <TimeSeriesChart
          node={node}
          title={`${iface.label} throughput`}
          series={[
            { key: `net.${iface.name}.rx_bps`, label: 'Receive' },
            { key: `net.${iface.name}.tx_bps`, label: 'Transmit' },
          ]}
          format={bits}
          yMin={0}
          height={180}
          legendValues="hover"
        />
        <ErrorLine node={node} name={iface.name} range={range} />
      </div>
    </Panel>
  );
}

function IfaceMeta({ iface }: { iface: NetIfInfo }) {
  const parts = [iface.name, iface.rdma_device, iface.ipv4[0]].filter(Boolean);
  return <span className="nb-meta num">{parts.join(' · ')}</span>;
}

function ErrorLine({ node, name, range }: { node: string; name: string; range: Parameters<typeof useCounterTotals>[2] }) {
  const { totals, oldest } = useCounterTotals(node, [`net.${name}.errors`, `net.${name}.drops`], range);
  const [errors = null, drops = null] = totals;
  const s = errorSummary(errors, drops);
  const Icon = s.tone === 'ok' ? CircleCheck : TriangleAlert;
  return (
    <p className={`nb-errline${s.tone === 'warn' ? ' tone-warn' : s.tone === 'ok' ? ' tone-ok' : ''}`}>
      {s.tone === 'unknown' ? null : <Icon aria-hidden="true" className="nb-errline__icon" />}
      <span className="nb-errline__text">{s.text}</span>
      <span className="nb-errline__range">in the {spanPhrase(range, oldest, serverNow())}</span>
    </p>
  );
}

function NotConnected({ ifaces }: { ifaces: NetIfInfo[] }) {
  return (
    <div className="nb-notconn" role="group" aria-label="Ports without a link">
      <span className="nb-notconn__label">Not connected</span>
      <ul className="nb-notconn__list">
        {ifaces.map((n) => (
          <li key={n.name} className="nb-notconn__item">
            <Cable aria-hidden="true" />
            <span className="nb-notconn__name num">{n.name}</span>
            <span className="nb-notconn__desc">{n.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VirtualInterfaces({ node, ifaces }: { node: string; ifaces: NetIfInfo[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="nb-section">
      <button type="button" className="nb-disclosure" aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); }}>
        <ChevronRight aria-hidden="true" className="nb-disclosure__chevron" />
        <span>{open ? 'Hide' : 'Show'} virtual interfaces</span>
        <span className="nb-disclosure__count num">{ifaces.length}</span>
      </button>
      <div id={id} hidden={!open}>
        {open ? (
          <Panel label="Virtual and wireless interfaces" flush>
            <ul className="nb-vlist">
              {ifaces.map((n) => <VirtualRow key={n.name} node={node} iface={n} />)}
            </ul>
            <p className="nb-vnote">
              The agent lists these but does not sample them by default. To see their traffic, set{' '}
              <code>include_virtual = true</code> in the node’s agent.toml and restart the agent.
            </p>
          </Panel>
        ) : null}
      </div>
    </section>
  );
}

function VirtualRow({ node, iface }: { node: string; iface: NetIfInfo }) {
  const upValue = useLastKnown(node, `net.${iface.name}.up`);
  const rx = formatBitrate(useLastKnown(node, `net.${iface.name}.rx_bps`));
  const tx = formatBitrate(useLastKnown(node, `net.${iface.name}.tx_bps`));
  const kind = iface.role === 'wireless' ? 'Wi-Fi' : 'virtual';
  // The agent lists these interfaces but only samples them with include_virtual: no data is "not sampled", not down.
  const sampled = upValue !== null;
  return (
    <li className="nb-vrow">
      <NetworkIcon aria-hidden="true" className="nb-vrow__icon" />
      <span className="nb-vrow__name">
        <span>{iface.label}</span>
        <span className="nb-meta num">{[iface.label === iface.name ? null : iface.name, kind, iface.ipv4[0]].filter(Boolean).join(' · ')}</span>
      </span>
      {sampled ? (
        <>
          <StatusPill size="sm" variant="inline" status={upValue === 1 ? 'healthy' : 'offline'} label={upValue === 1 ? 'Up' : 'Down'} />
          <span className="nb-vrow__rate num"><span className="nb-vrow__dir">Rx</span> {rx}</span>
          <span className="nb-vrow__rate num"><span className="nb-vrow__dir">Tx</span> {tx}</span>
        </>
      ) : (
        <span className="nb-vrow__unsampled">Not sampled</span>
      )}
    </li>
  );
}

function NetworkSkeleton() {
  return (
    <div className="view view--flush nb" aria-busy="true">
      <section className="nb-section">
        <header className="nb-section__head"><Skeleton width={104} height={20} /></header>
        <div className="grid nb-grid-rails">
          <IfaceCardSkeleton />
          <IfaceCardSkeleton />
        </div>
      </section>
      <section className="nb-section">
        <header className="nb-section__head"><Skeleton width={40} height={20} /></header>
        <div className="grid nb-grid-rails">
          <IfaceCardSkeleton />
        </div>
      </section>
    </div>
  );
}

function IfaceCardSkeleton() {
  return (
    <Panel title={<Skeleton width={150} height={16} />} subtitle={<Skeleton width={220} height={12} />} busy>
      <div className="nb-card">
        <div className="nb-pills"><Skeleton width={72} height={20} radius={10} /><Skeleton width={96} height={20} radius={10} /></div>
        <div className="nb-stats nb-stats--rail"><StatSkeleton /><StatSkeleton /><StatSkeleton /></div>
        <ChartSkeleton height={214} />
        <Skeleton width={180} height={14} />
      </div>
    </Panel>
  );
}
