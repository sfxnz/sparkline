// Telemetry overlaid on a run, one series per node, chosen for the subsystem under test: GPU utilisation,
// temperature, power and SM clock for GPU benchmarks; CPU utilisation and clock for the CPU benchmark; disk
// throughput and busy time for storage; ConnectX-7 receive/transmit for the interconnect. While the run is active the
// data comes from the LiveStore (refreshed at most once a second) and the x axis reaches to the expected finish;
// afterwards from the GPU telemetry the console saved with the run, else from the history API.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { formatBitrate, formatFreq, formatPercent, formatTemp, formatWatts } from '../../lib/format';
import type { BenchRun, BenchSpec, NodeInfo } from '../../lib/types';
import { serverNow, useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { formatBytesRate } from '../node/partsB/storage';
import { alignByNode, isActive, parseRunSeries, type NodeSeries, type SeriesKind } from './model';
import { RunChart, type Marker } from './RunChart';

const LEAD_S = 30;

export interface TelemetryChart {
  id: string;
  title: string;
  format: (n: number) => string;
  /** Flat metric keys on a node (summed, averaged or maxed into one line per node). */
  keys: (info: NodeInfo | undefined) => string[];
  agg: 'sum' | 'mean' | 'max';
  /** The kind under which the console saves this chart's series with the run (GPU telemetry only). */
  kind?: SeriesKind;
  yMin?: number;
  yMax?: number;
  ySpan?: number;
}

const one = (key: string) => () => [key];
const GPU: readonly TelemetryChart[] = [
  { id: 'gpu0.util', kind: 'util', title: 'GPU utilisation', keys: one('gpu0.util'), agg: 'max', format: (n) => formatPercent(n), yMin: 0, yMax: 100 },
  { id: 'gpu0.temp_c', kind: 'temp_c', title: 'GPU temperature', keys: one('gpu0.temp_c'), agg: 'max', format: formatTemp, ySpan: 8 },
  { id: 'gpu0.power_w', kind: 'power_w', title: 'GPU power', keys: one('gpu0.power_w'), agg: 'max', format: formatWatts, yMin: 0 },
  { id: 'gpu0.sm_mhz', kind: 'sm_mhz', title: 'SM clock', keys: one('gpu0.sm_mhz'), agg: 'max', format: formatFreq, yMin: 0 },
];
const CPU: readonly TelemetryChart[] = [
  { id: 'cpu.util', title: 'CPU utilisation', keys: one('cpu.util'), agg: 'max', format: (n) => formatPercent(n), yMin: 0, yMax: 100 },
  { id: 'cpu.mhz', title: 'CPU clock (mean of cores)', keys: (i) => (i?.cores ?? []).map((c) => `cpu.core${c.id}.mhz`), agg: 'mean', format: formatFreq, yMin: 0 },
];
const disks = (i: NodeInfo | undefined) => (i?.disks ?? []).map((d) => d.name);
const STORAGE: readonly TelemetryChart[] = [
  { id: 'disk.read', title: 'Disk read', keys: (i) => disks(i).map((d) => `disk.${d}.read_bps`), agg: 'sum', format: formatBytesRate, yMin: 0 },
  { id: 'disk.write', title: 'Disk write', keys: (i) => disks(i).map((d) => `disk.${d}.write_bps`), agg: 'sum', format: formatBytesRate, yMin: 0 },
  { id: 'disk.busy', title: 'Disk busy', keys: (i) => disks(i).map((d) => `disk.${d}.busy_pct`), agg: 'max', format: (n) => formatPercent(n), yMin: 0, yMax: 100 },
];
const rails = (i: NodeInfo | undefined) => (i?.net ?? []).filter((n) => n.role === 'interconnect').map((n) => n.name);
const LINK: readonly TelemetryChart[] = [
  { id: 'net.rx', title: 'ConnectX-7 receive (all rails)', keys: (i) => rails(i).map((n) => `net.${n}.rx_bps`), agg: 'sum', format: formatBitrate, yMin: 0 },
  { id: 'net.tx', title: 'ConnectX-7 transmit (all rails)', keys: (i) => rails(i).map((n) => `net.${n}.tx_bps`), agg: 'sum', format: formatBitrate, yMin: 0 },
];

/** The overlay for a benchmark's category (GPU charts for GPU-bound benchmarks and when the category is unknown). */
export function telemetryCharts(category: BenchSpec['category'] | undefined): readonly TelemetryChart[] {
  return category === 'cpu' ? CPU : category === 'storage' ? STORAGE : category === 'interconnect' ? LINK : GPU;
}

type Data = { ts: number[]; byKey: Record<string, (number | null)[][]> } | null;
type Infos = (node: string) => NodeInfo | undefined;

/** One value per tick for a chart from the per-key arrays of a node. */
function aggregate(chart: TelemetryChart, keys: readonly string[], cols: Record<string, readonly (number | null)[]>, n: number): (number | null)[] {
  const out = new Array<number | null>(n).fill(null);
  for (let j = 0; j < n; j++) {
    const xs = keys.map((k) => cols[k]?.[j]).filter((v): v is number => v != null && Number.isFinite(v));
    if (!xs.length) continue;
    out[j] = chart.agg === 'sum' ? xs.reduce((a, b) => a + b, 0) : chart.agg === 'mean' ? xs.reduce((a, b) => a + b, 0) / xs.length : Math.max(...xs);
  }
  return out;
}

function nodeSeries(node: string, charts: readonly TelemetryChart[], info: NodeInfo | undefined, ts: number[], cols: Record<string, readonly (number | null)[]>): NodeSeries {
  return { node, ts, values: Object.fromEntries(charts.map((c) => [c.id, aggregate(c, c.keys(info), cols, ts.length)])) };
}

const allKeys = (charts: readonly TelemetryChart[], info: NodeInfo | undefined) => [...new Set(charts.flatMap((c) => c.keys(info)))];

function fromLive(nodes: readonly string[], charts: readonly TelemetryChart[], infos: Infos, from: number): Data {
  const per = nodes.map((node) => {
    const keys = allKeys(charts, infos(node));
    const w = liveStore.window(node, keys, from);
    return nodeSeries(node, charts, infos(node), w.ts, Object.fromEntries(keys.map((k, i) => [k, w.values[i] ?? []])));
  });
  return alignByNode(per, charts.map((c) => c.id));
}

/** The GPU telemetry the console saved with the run (null when it has none for these charts). */
function fromSaved(run: BenchRun, charts: readonly TelemetryChart[]): Data {
  if (!charts.every((c) => c.kind)) return null;
  const p = parseRunSeries(run, 'telemetry');
  const per: NodeSeries[] = run.nodes
    .filter((n) => p.byNode[n] && charts.some((c) => c.kind && p.byNode[n]?.[c.kind]))
    .map((node) => ({ node, ts: p.ts[node] ?? [], values: Object.fromEntries(charts.map((c) => [c.id, (c.kind && p.byNode[node]?.[c.kind]) || []])) }));
  return per.length ? alignByNode(per, charts.map((c) => c.id)) : null;
}

/** Start/end rules for every chart of a run. */
export function runMarkers(run: BenchRun): Marker[] {
  const markers: Marker[] = [];
  if (run.started_ts != null) markers.push({ ts: run.started_ts, label: 'Start' });
  if (run.finished_ts != null && run.started_ts != null) markers.push({ ts: run.finished_ts, label: run.status === 'succeeded' ? 'Done' : run.status === 'cancelled' ? 'Cancelled' : 'Stopped' });
  return markers;
}

/** The x range every chart of a run shares. `saved`: the data covers only the run (no lead-in). */
export function runFrame(run: BenchRun, now: number, expected: number, saved: boolean): [number, number] {
  const start = run.started_ts ?? run.created_ts;
  const end = run.finished_ts ?? now;
  if (isActive(run.status)) return [start - LEAD_S, Math.ceil(Math.max(now + 5, start + expected * 1.05) / 10) * 10]; // 10 s steps: no creep
  // Saved series cover the run itself: a 10 % margin each side, so a 5 s run is not a sliver. Live or history data
  // has context around the run: up to LEAD_S each side, but no more than half the run's length (at least 5 s).
  if (saved) {
    const margin = Math.max(2, (end - start) * 0.1);
    return [start - margin, end + margin];
  }
  const lead = Math.min(LEAD_S, Math.max(5, (end - start) * 0.5));
  return [start - lead, end + lead];
}

/** Re-render at most once a second while any involved node streams samples. */
function useLiveTick(nodes: readonly string[], on: boolean): number {
  const [tick, setTick] = useState(0);
  const key = nodes.join('\u0000');
  useEffect(() => {
    if (!on) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      const wait = 1000 - (performance.now() - last);
      if (wait <= 0) {
        last = performance.now();
        setTick((t) => t + 1);
      } else timer ??= setTimeout(() => {
        timer = null;
        last = performance.now();
        setTick((t) => t + 1);
      }, wait);
    };
    const offs = key.split('\u0000').filter(Boolean).map((n) => liveStore.subscribeSample(n, bump));
    const clock = setInterval(bump, 1000); // the x axis keeps moving even when a node is quiet
    return () => {
      offs.forEach((o) => { o(); });
      clearInterval(clock);
      if (timer) clearTimeout(timer);
    };
  }, [key, on]);
  return tick;
}

export function RunTelemetry({ run, category, expected }: { run: BenchRun; category: BenchSpec['category'] | undefined; expected: number }) {
  const active = isActive(run.status);
  const start = run.started_ts ?? run.created_ts;
  const charts = telemetryCharts(category);
  const nodeInfos = useCluster((s) => s.nodes);
  const infos: Infos = (n) => nodeInfos[n]?.info ?? undefined;
  const tick = useLiveTick(run.nodes, active);
  const saved = useMemo(() => (active ? null : fromSaved(run, charts)), [active, run, charts]);
  // A run that finished moments ago is still in the live buffer, which is complete at 1 s where history may lag.
  const recent = !active && !saved ? fromLive(run.nodes, charts, infos, start - LEAD_S) : null;
  const inLive = !!recent && recent.ts.length > 0 && (recent.ts[0] ?? Infinity) <= start;
  const [history, setHistory] = useState<{ id: string; data: Data }>({ id: '', data: null });

  // Finished without saved telemetry for these charts: the console's history for the run's span.
  const needHistory = !active && !saved && !inLive;
  const span = `${run.id}|${start}|${run.finished_ts ?? ''}|${charts.map((c) => c.id).join(',')}`;
  useEffect(() => {
    if (!needHistory) return;
    let cancelled = false;
    const to = (run.finished_ts ?? serverNow()) + LEAD_S;
    Promise.all(
      run.nodes.map((node) => {
        const info = useCluster.getState().nodes[node]?.info ?? undefined;
        const keys = allKeys(charts, info);
        return api.history(node, keys, start - LEAD_S, to, 600).then(
          (r) => nodeSeries(node, charts, info, r.ts, r.series),
          (): NodeSeries => ({ node, ts: [], values: {} }),
        );
      }),
    ).then((per) => {
      if (!cancelled) setHistory({ id: span, data: alignByNode(per, charts.map((c) => c.id), 1) });
    }, () => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needHistory, span]);

  const now = serverNow();
  const data: Data = active ? fromLive(run.nodes, charts, infos, start - LEAD_S) : (saved ?? (inLive ? recent : history.id === span ? history.data : null));
  const loading = !active && !saved && !inLive && history.id !== span;
  const xRange = runFrame(run, now, expected, !!saved);
  const markers = runMarkers(run);

  return (
    <div className="bench-telemetry" data-tick={tick}>
      {charts.map((t) => (
        <RunChart
          key={t.id}
          title={t.title}
          ts={data?.ts ?? []}
          series={run.nodes.map((n, i) => ({ label: n, values: data?.byKey[t.id]?.[i] ?? [] }))}
          format={t.format}
          xRange={xRange}
          markers={markers}
          yMin={t.yMin}
          yMax={t.yMax}
          ySpan={t.ySpan}
          loading={loading}
          emptyText={active ? 'Waiting for samples…' : 'No telemetry was recorded for this run'}
        />
      ))}
    </div>
  );
}
