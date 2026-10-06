// Dev-only harness (served by `npm run dev` at /gallery.html, not part of the production build): renders the
// design-system primitives and charts against synthetic LiveStore data so they can be checked and screenshotted
// before the live views exist.
import '../design/global.css'; // first, so component CSS overrides the material utilities (same order as main.tsx)
import { Cpu, Gauge } from 'lucide-react';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Heatmap } from '../charts/Heatmap';
import { TimeSeriesChart } from '../charts/TimeSeriesChart';
import { Button } from '../design/components/Button';
import { ConfirmDialog } from '../design/components/Dialog';
import { EmptyState } from '../design/components/EmptyState';
import { Panel } from '../design/components/Panel';
import { ProblemState } from '../design/components/ProblemState';
import { RingGauge } from '../design/components/RingGauge';
import { SegmentedControl } from '../design/components/SegmentedControl';
import { Sparkline } from '../design/components/Sparkline';
import { Stat } from '../design/components/Stat';
import { StatusPill } from '../design/components/StatusPill';
import { Table } from '../design/components/Table';
import { Tabs } from '../design/components/Tabs';
import { bitrateParts, bytesParts, formatPercent, formatTemp, formatWatts, percentParts, tempParts, wattsParts } from '../lib/format';
import type { CoreInfo, Sample } from '../lib/types';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { liveStore } from '../store/live';
import '../views/views.css';

const GiB = 1024 ** 3;
const cores: CoreInfo[] = Array.from({ length: 20 }, (_, id) => ({
  id,
  kind: id % 10 < 5 ? 'efficiency' : 'performance',
  model: id % 10 < 5 ? 'Cortex-A725' : 'Cortex-X925',
  max_mhz: id % 10 < 5 ? 2808 : 3900,
  cluster: null,
}));

function synth(ts: number): Sample {
  const t = ts / 10;
  const util = 88 + 6 * Math.sin(t) + 2 * Math.sin(t * 3.7);
  const perCore = cores.map((c) => Math.max(0, Math.min(100, (c.kind === 'performance' ? 35 : 10) + 30 * Math.sin(t * 0.7 + c.id) ** 2 + (c.id === 7 ? 50 : 0))));
  return {
    node_id: 'spark1', ts, seq: Math.round(ts), interval_ms: 1000,
    gpu: [{ index: 0, util, sm_mhz: 2171 + 40 * Math.sin(t), gr_mhz: 2171, video_mhz: null, temp_c: 70 + 3 * Math.sin(t / 3), power_w: 32 + 3 * Math.sin(t * 1.3), energy_j: ts * 32, pstate: 0, throttle_mask: 4, power_capped_pct: 10, thermal_capped_pct: null }],
    mem: { total: 121.7 * GiB, available: 26 * GiB, used: 95.7 * GiB, free: 1 * GiB, gpu: 86 * GiB, anon: 5 * GiB, cache: 8 * GiB, shmem: 1 * GiB, kernel: 2 * GiB, other: 1.7 * GiB, swap_total: 16 * GiB, swap_used: 4 * GiB, psi_some: 0.1, psi_full: null },
    cpu: { util: 20, perf_util: 30, eff_util: 10, per_core: perCore, freq_mhz: cores.map((c) => c.max_mhz), load1: 2, load5: 2, load15: 2, psi_some: null },
    net: [{ name: 'enp1s0f1np1', up: true, speed_mbps: 200000, rx_bps: 5.7e8 + 2e8 * Math.sin(t), tx_bps: 5.6e8 + 2e8 * Math.cos(t), errors: 0, drops: 0, rdma_state: 'ACTIVE', rdma_rate: '200 Gb/sec (4X HDR)' }],
    disk: [], fs: [], temps: [], procs: null, errors: {},
  };
}

function boot() {
  const now = Date.now() / 1000;
  for (let ts = Math.floor(now) - 400; ts < now; ts++) liveStore.pushSample(synth(ts));
  useCluster.getState().setHello({
    nodes: [
      { node_id: 'spark1', url: '', status: 'online', since: now, last_sample_ts: now, error: null, next_retry_ts: null, info: { unsupported: [{ metric: 'gpu0.power_limit_w', reason: 'Not reported by GB10 (NVML: Not Supported).' }], cores } as never },
      { node_id: 'spark2', url: '', status: 'stale', since: now, last_sample_ts: now - 12, error: null, info: null, next_retry_ts: null },
    ],
    settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
    demo: true, version: 'dev', server_time: now,
  });
  useConnection.setState({ status: 'live', everLive: true });
  setInterval(() => { liveStore.pushSample(synth(Date.now() / 1000)); }, 1000);
}

function LatestStat() {
  const [v, setV] = useState(() => liveStore.latest('spark1'));
  const [staleSince] = useState(() => Date.now() / 1000 - 12);
  useEffect(() => liveStore.subscribeSample('spark1', () => { setV(liveStore.latest('spark1')); }), []);
  return (
    <div className="ph-statrow">
      <Stat label="GPU utilisation" value={v?.gpu[0]?.util} format={percentParts} />
      <Stat label="GPU temperature" value={v?.gpu[0]?.temp_c} format={tempParts} />
      <Stat label="GPU power" value={v?.gpu[0]?.power_w} format={wattsParts} />
      <Stat label="Memory used" value={v?.mem.used} format={bytesParts} />
      <Stat label="CX7 rail A rx" value={v?.net[0]?.rx_bps} format={bitrateParts} stale updatedAt={staleSince} />
      <Stat label="Power limit" value={null} format={wattsParts} unsupported="Not reported by GB10 (NVML: Not Supported)." />
    </div>
  );
}

function Gallery() {
  const [range, setRange] = useState<'live' | '5m' | '1h'>('live');
  const [tab, setTab] = useState<'gpu' | 'cpu'>('gpu');
  const [confirm, setConfirm] = useState(false);
  const pct = useCallback((n: number) => formatPercent(n), []);
  return (
    <div style={{ padding: 32, display: 'grid', gap: 20, maxWidth: 1400 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['healthy', 'warning', 'critical', 'stale', 'offline', 'connecting', 'unknown'] as const).map((s) => <StatusPill key={s} status={s} />)}
        <SegmentedControl label="Range" value={range} onChange={setRange} options={[{ value: 'live', label: 'Live' }, { value: '5m', label: '5m' }, { value: '1h', label: '1h' }]} />
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive" onClick={() => { setConfirm(true); }}>Clear history…</Button>
      </div>
      <Panel title="Stats" subtitle="AnimatedNumber, stale and unsupported states"><LatestStat /></Panel>
      <div className="grid grid--2">
        <Panel title="GPU temperature" subtitle="Live, slowdown threshold at 86 °C">
          <TimeSeriesChart node="spark1" title="GPU temperature" series={[{ key: 'gpu0.temp_c', label: 'GPU' }]} format={formatTemp} range="live" yMin={40} thresholds={[{ value: 86, label: 'Slowdown 86 °C', tone: 'warn' }]} />
        </Panel>
        <Panel title="GPU utilisation and power">
          <TimeSeriesChart node="spark1" title="GPU utilisation" series={[{ key: 'gpu0.util', label: 'Utilisation' }, { key: 'cpu.core7.util', label: 'Core 7' }]} format={pct} range="live" yMin={0} yMax={100} />
        </Panel>
        <Panel title="Stale node" subtitle="spark2 has no recent samples">
          <TimeSeriesChart node="spark2" title="spark2 GPU" series={[{ key: 'gpu0.util', label: 'GPU' }]} format={pct} range="live" />
        </Panel>
        <Panel title="Unsupported">
          <TimeSeriesChart node="spark1" title="Power limit" series={[{ key: 'gpu0.power_limit_w', label: 'Limit' }]} format={formatWatts} range="live" />
        </Panel>
      </div>
      <div className="grid grid--2">
        <Panel title="Per-core CPU" subtitle="Performance (X925) above efficiency (A725)">
          <Heatmap node="spark1" cores={cores} />
        </Panel>
        <Panel title="Sparklines and gauge">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'center' }}>
            <div style={{ display: 'grid', gap: 16 }}>
              <Sparkline label="GPU utilisation" format={pct} source={{ node: 'spark1', metric: 'gpu0.util' }} min={0} max={100} />
              <Sparkline label="GPU power" format={formatWatts} source={{ node: 'spark1', metric: 'gpu0.power_w' }} />
            </div>
            <RingGauge value={0.79} label="Memory 79% used"><span>79%</span></RingGauge>
          </div>
        </Panel>
      </div>
      <Tabs label="Node sections" items={[{ id: 'gpu', label: 'GPU' }, { id: 'cpu', label: 'CPU' }]} value={tab} onChange={setTab}>
        <div className="grid grid--2">
          <Panel title="Processes" flush>
            <Table
              caption="Top processes"
              rowKey={(r) => r.pid}
              rows={[{ pid: 4211, name: 'python serve_stats.py', gpu: 86 * GiB, cpu: 104.2 }, { pid: 991, name: 'dockerd', gpu: null, cpu: 0.4 }, { pid: 1502, name: 'sparkline-agent', gpu: null, cpu: 0.6 }]}
              initialSort={{ id: 'gpu', dir: 'desc' }}
              columns={[
                { id: 'name', header: 'Process', sortValue: (r) => r.name },
                { id: 'gpu', header: 'GPU memory', align: 'end', sortValue: (r) => r.gpu, render: (r) => (r.gpu == null ? '—' : `${(r.gpu / GiB).toFixed(1)} GiB`) },
                { id: 'cpu', header: 'CPU', align: 'end', sortValue: (r) => r.cpu, render: (r) => `${r.cpu.toFixed(1)}%` },
              ]}
            />
          </Panel>
          <Panel title="States">
            <div className="grid grid--2">
              <EmptyState compact icon={Gauge} title="No benchmark runs yet" action={<Button size="sm" variant="primary">Run your first baseline</Button>}>Baselines make regressions visible.</EmptyState>
              <ProblemState compact message="Agent unreachable on spark2" cause="Connection refused on 10.20.20.195:9750" fix="Check `systemctl status sparkline-agent` on spark2" onRetry={() => undefined} icon={Cpu} />
            </div>
          </Panel>
        </div>
      </Tabs>
      <ConfirmDialog open={confirm} onCancel={() => { setConfirm(false); }} onConfirm={() => { setConfirm(false); }} title="Clear history on spark1?" consequences={['Deletes 7 days of stored telemetry', 'Live data keeps streaming', 'This cannot be undone']} confirmLabel="Clear history" destructive confirmPhrase="DELETE" />
    </div>
  );
}

boot();
const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><MotionConfig reducedMotion="user"><LazyMotion features={domAnimation}><Gallery /></LazyMotion></MotionConfig></StrictMode>);
