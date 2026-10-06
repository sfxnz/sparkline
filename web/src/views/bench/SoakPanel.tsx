// Thermal soak analysis from the series saved with the run: throughput and throttle reasons over time, plus summary
// statistics (clock CV, peak temperature, time throttled, first vs last minute TFLOPS). Clock and temperature are
// charted once, in the run's telemetry panel; these charts share its time range and start/end rules.
import { useMemo } from 'react';
import { Panel } from '../../design/components/Panel';
import { formatFreq, formatPercent, formatTemp } from '../../lib/format';
import { decodeThrottle } from '../../lib/throttle';
import type { BenchRun } from '../../lib/types';
import { serverNow } from '../../store/cluster';
import { alignByNode, formatValue, parseRunSeries, SOAK_MIN_SPAN_S, soakStats, TELEMETRY_PREFIX, type NodeSeries, type SoakStats } from './model';
import { RunChart } from './RunChart';
import { runFrame, runMarkers } from './RunTelemetry';

const CHARTS = [{ kind: 'tflops', title: 'Throughput', format: (n: number) => `${formatValue(n)} TFLOPS` }] as const;

/** While a run is active the console keeps each node's series in node_states; it copies them into run.series
 * ("<node>.<key>") when the run finishes. */
function withLiveSeries(run: BenchRun): BenchRun {
  const live = Object.entries(run.node_states ?? {}).flatMap(([n, st]) => Object.entries(st.series).map(([k, v]) => [`${n}.${k}`, v] as const));
  return live.length ? { ...run, series: { ...Object.fromEntries(live), ...run.series } } : run;
}

export function SoakPanel({ run, expected }: { run: BenchRun; expected: number }) {
  const parsed = useMemo(() => parseRunSeries(withLiveSeries(run)), [run]);
  const nodes = run.nodes.filter((n) => parsed.byNode[n]);
  const aligned = useMemo(() => {
    const per: NodeSeries[] = nodes.map((node) => ({ node, ts: parsed.ts[node] ?? [], values: Object.fromEntries(CHARTS.map((c) => [c.kind, parsed.byNode[node]?.[c.kind] ?? []])) }));
    return alignByNode(per, CHARTS.map((c) => c.kind));
  }, [nodes, parsed]);

  if (!nodes.length) {
    return (
      <Panel title="Soak analysis">
        <p className="bench-soak__empty">Clock, temperature and throttling series appear here as the soak records them.</p>
      </Panel>
    );
  }
  const saved = Object.keys(run.series).some((k) => k.startsWith(TELEMETRY_PREFIX));
  const xRange = runFrame(run, serverNow(), expected, saved); // the same frame as the telemetry charts above
  const markers = runMarkers(run);

  return (
    <Panel title="Soak analysis" subtitle="From the series recorded during the run">
      <div className="bench-soak">
        {nodes.map((n) => (
          <SoakStatsRow key={n} node={n} multi={nodes.length > 1} stats={soakStats(parsed.ts[n] ?? [], parsed.byNode[n] ?? {})} />
        ))}
        <div className="bench-telemetry">
          {CHARTS.filter((c) => nodes.some((n) => parsed.byNode[n]?.[c.kind]?.length)).map((c) => (
            <RunChart
              key={c.kind}
              title={c.title}
              ts={aligned.ts}
              series={nodes.map((n, i) => ({ label: n, values: aligned.byKey[c.kind]?.[i] ?? [] }))}
              format={c.format}
              xRange={xRange}
              markers={markers}
              height={150}
            />
          ))}
        </div>
        {nodes.map((n) => {
          const masks = parsed.byNode[n]?.throttle_mask;
          return masks?.length ? <ThrottleTimeline key={n} node={n} ts={parsed.ts[n] ?? []} masks={masks} range={xRange} /> : null;
        })}
      </div>
    </Panel>
  );
}

/** "29.5% faster at the end", "12.0% slower at the end", "About the same at the end". */
function changeWords(pct: number): string {
  if (Math.abs(pct) < 0.5) return 'About the same at the end';
  return `${Math.abs(pct).toFixed(1)}% ${pct > 0 ? 'faster' : 'slower'} at the end`;
}

function SoakStatsRow({ node, multi, stats }: { node: string; multi: boolean; stats: SoakStats }) {
  const change = stats.tflopsChangePct;
  return (
    <section className="bench-soak__stats" aria-label={`${node} soak summary`}>
      {multi ? <h3 className="t-eyebrow bench-soak__node">{node}</h3> : null}
      <dl className="bench-soak__grid">
        <div>
          <dt>Clock variation</dt>
          <dd className="num">{stats.clockCvPct === null ? '—' : `${stats.clockCvPct.toFixed(1)}%`}</dd>
          <dd className="bench-soak__foot">CV around a mean of {formatFreq(stats.clockMean)}</dd>
        </div>
        <div>
          <dt>Peak temperature</dt>
          <dd className="num">{formatTemp(stats.maxTemp)}</dd>
        </div>
        <div>
          <dt>Time throttled</dt>
          <dd className="num">{stats.throttledAnyPct === null ? '—' : formatPercent(stats.throttledAnyPct)}</dd>
          <dd className="bench-soak__foot">
            Thermal or hardware limits.{stats.powerCappedPct ? ` At the power cap ${formatPercent(stats.powerCappedPct)} of the time (normal under load).` : ''}
          </dd>
        </div>
        <div>
          <dt>First → last minute</dt>
          {stats.firstMinuteTflops === null || stats.lastMinuteTflops === null ? (
            <>
              <dd className="num">—</dd>
              <dd className="bench-soak__foot">{stats.hasTflops ? `Needs at least ${SOAK_MIN_SPAN_S / 60} minutes of load` : 'Throughput not recorded'}</dd>
            </>
          ) : (
            <>
              <dd className="num">
                {formatValue(stats.firstMinuteTflops)} → {formatValue(stats.lastMinuteTflops)} <span className="bench-soak__unit">TFLOPS</span>
              </dd>
              <dd className="bench-soak__foot">{change === null ? '' : changeWords(change)}</dd>
            </>
          )}
        </div>
      </dl>
    </section>
  );
}

/** One row per throttle reason seen, with bars where it was active (icon-free, but every bar row is labelled). */
function ThrottleTimeline({ node, ts, masks, range }: { node: string; ts: readonly number[]; masks: readonly number[]; range: [number, number] }) {
  const rows = useMemo(() => {
    const byCode = new Map<string, { title: string; severity: string; spans: [number, number][] }>();
    for (let i = 0; i < masks.length; i++) {
      const t = ts[i];
      if (t === undefined) continue;
      const next = ts[i + 1] ?? t + 1;
      for (const r of decodeThrottle(masks[i])) {
        if (r.code === 'gpu_idle') continue;
        const row = byCode.get(r.code) ?? { title: r.title, severity: r.severity, spans: [] };
        const last = row.spans.at(-1);
        if (last && Math.abs(last[1] - t) < 1e-6) last[1] = next;
        else row.spans.push([t, next]);
        byCode.set(r.code, row);
      }
    }
    return [...byCode.entries()];
  }, [ts, masks]);
  const span = Math.max(1, range[1] - range[0]);
  const x = (t: number) => `${(((t - range[0]) / span) * 100).toFixed(3)}%`;
  const w = (a: number, b: number) => `${Math.max(0.2, ((b - a) / span) * 100).toFixed(3)}%`;
  return (
    <figure className="bench-throttle" aria-label={`${node} throttle reasons over the run`}>
      <figcaption className="bench-chart__title">Throttle reasons{ts.length ? ` · ${node}` : ''}</figcaption>
      {rows.length ? (
        <ul className="bench-throttle__rows">
          {rows.map(([code, r]) => (
            <li key={code} className={`bench-throttle__row tone-${r.severity === 'critical' ? 'crit' : r.severity === 'warning' ? 'warn' : 'stale'}`}>
              <span className="bench-throttle__label">{r.title}</span>
              <svg className="bench-throttle__track" role="img" aria-label={`${r.title}: active ${formatPercent((r.spans.reduce((a, s) => a + s[1] - s[0], 0) / span) * 100)} of the run`} preserveAspectRatio="none">
                {r.spans.map(([a, b]) => <rect key={a} x={x(a)} width={w(a, b)} y="0" height="100%" rx="2" />)}
              </svg>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bench-soak__foot">The GPU was never throttled during the run.</p>
      )}
    </figure>
  );
}
