// Pure logic behind the Overview: health and activity sentences, cluster totals, memory split, energy counters and
// the interconnect topology. No React, no stores, so every rule here is unit-tested in model.test.ts.
import type { Status } from '../../design/components/StatusPill';
import type { LiveCondition } from '../../lib/condition';
import type { Event, NetIfInfo, NodeInfo, NodeStatus, ProcSample } from '../../lib/types';
import { linkRecoveries } from '../alerts/model';

// ------------------------------------------------------------------------------------------------ wording helpers

/** "spark1", "spark1 and spark2", "spark1, spark2 and spark3", "4 nodes". */
export function listNodes(ids: readonly string[]): string {
  if (ids.length > 3) return `${ids.length} nodes`;
  if (ids.length <= 1) return ids[0] ?? '';
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1] ?? ''}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isAre = (ids: readonly string[]) => (ids.length === 1 ? 'is' : 'are');

// ------------------------------------------------------------------------------------------------ health

export interface NodeHealthInput {
  id: string;
  status: NodeStatus | undefined;
  /** What the latest sample already flags (temperature at slowdown, hardware clock limits), if anything. */
  condition?: LiveCondition | null;
  /** The node has an open warning/critical alert (its rule has fired). */
  alerted?: boolean;
}

export interface AlertCounts {
  critical: number;
  warning: number;
  /** Severity of open alerts left out of the counts because a node-state clause already says it ("spark3 is
   *  offline" covers its node-offline alert). They still set the overall status. */
  explained?: 'warning' | 'critical' | null;
}

export interface Health {
  status: Status;
  /** Pill text. */
  label: string;
  sentence: string;
}

/** Alert rules whose event only restates a node state the sentence already names. */
const NODE_STATE_RULES = new Set(['node_offline']);

/**
 * Open (unresolved) warning/critical alerts by severity. Node-offline alerts for nodes in `notLiveIds` are counted
 * under `explained` instead, so "spark3 is offline · 1 critical alert" does not read as two problems.
 */
export function openAlertCounts(events: readonly Event[], notLiveIds: readonly string[] = []): AlertCounts {
  const out: AlertCounts = { critical: 0, warning: 0, explained: null };
  for (const e of events) {
    if (e.kind !== 'alert' || e.resolved_ts != null) continue;
    if (e.severity !== 'critical' && e.severity !== 'warning') continue;
    if (e.rule_id && NODE_STATE_RULES.has(e.rule_id) && e.node_id && notLiveIds.includes(e.node_id)) {
      out.explained = e.severity === 'critical' || out.explained === 'critical' ? 'critical' : 'warning';
      continue;
    }
    if (e.severity === 'critical') out.critical++;
    else out.warning++;
  }
  return out;
}

/**
 * One sentence that answers "is my cluster healthy?": which nodes are not reporting, which are flagged live (before
 * their alert rule fires) and how many alerts are open. `consoleLive` false means the browser lost the console.
 */
export function clusterHealth(nodes: readonly NodeHealthInput[], alerts: AlertCounts, consoleLive = true): Health {
  if (!nodes.length) return { status: 'unknown', label: 'No nodes', sentence: 'No nodes configured' };
  if (!consoleLive) {
    return { status: 'stale', label: 'Not live', sentence: 'Connection to Sparkline lost · showing the last known state' };
  }
  const by = (s: NodeStatus) => nodes.filter((n) => n.status === s).map((n) => n.id);
  const offline = by('offline');
  const error = by('error');
  const stale = by('stale');
  const connecting = nodes.filter((n) => n.status === 'connecting' || n.status === undefined).map((n) => n.id);
  // Live flags whose alert has not fired yet; once it has, the alert count says it.
  const flagged = nodes.filter((n) => n.status === 'online' && n.condition && !n.alerted);

  const parts: string[] = [];
  if (offline.length) parts.push(`${listNodes(offline)} ${isAre(offline)} offline`);
  if (error.length) parts.push(`${listNodes(error)} ${error.length === 1 ? 'has' : 'have'} a connection error`);
  if (stale.length) parts.push(`${listNodes(stale)} ${isAre(stale)} not reporting`);
  for (const n of flagged) parts.push(`${n.id} ${n.condition?.text ?? ''}`);
  if (connecting.length) parts.push(`Waiting for ${listNodes(connecting)}…`);
  const problems = parts.length > 0;

  const alertParts: string[] = [];
  if (alerts.critical) alertParts.push(plural(alerts.critical, 'critical alert', 'critical alerts'));
  if (alerts.warning) alertParts.push(plural(alerts.warning, 'warning', 'warnings'));

  if (!problems) {
    const who = nodes.length === 1 ? `${nodes[0]?.id ?? ''} is` : `All ${nodes.length} nodes`;
    parts.push(`${who} ${alertParts.length ? 'online' : 'healthy'}`);
  }
  const sentence = [...parts, ...alertParts].join(' · ');

  const flaggedCritical = flagged.some((n) => n.condition?.level === 'critical');
  let status: Status;
  if (connecting.length === nodes.length) status = 'connecting';
  else if (alerts.critical || alerts.explained === 'critical' || flaggedCritical) status = 'critical';
  // A node the console cannot use (token mismatch, protocol version): a setup fault, labelled as such, not "Critical".
  else if (error.length) status = 'error';
  else if (offline.length || stale.length || alerts.warning || alerts.explained || flagged.length) status = 'warning';
  else if (connecting.length) status = 'connecting';
  else status = 'healthy';

  const label =
    status === 'healthy' ? 'Healthy' : status === 'critical' ? 'Critical' : status === 'error' ? 'Error' : status === 'warning' ? 'Needs attention' : 'Connecting';
  return { status, label, sentence };
}

// ------------------------------------------------------------------------------------------------ recent events

export interface Incident {
  event: Event;
  /** The recovery that closed this alert, when both are loaded. */
  recovery: Event | null;
  /** Latest activity: the recovery time for a resolved alert, else the event time (sort key). */
  at: number;
}

/**
 * Recent events as incidents: an alert and its recovery fold into one row (the recovery's own row is dropped), so a
 * resolved incident never reads as still critical next to a separate "cleared" line. Newest activity first.
 */
export function recentIncidents(events: readonly Event[], count: number): Incident[] {
  const { recoveryOf, alertOf } = linkRecoveries(events);
  const out: Incident[] = [];
  for (const e of events) {
    if (e.kind === 'recovered' && alertOf.has(e.id)) continue;
    const recovery = recoveryOf.get(e.id) ?? null;
    out.push({ event: e, recovery, at: Math.max(e.ts, e.resolved_ts ?? 0) });
  }
  return out.sort((a, b) => b.at - a.at || b.event.id - a.event.id).slice(0, count);
}

// ------------------------------------------------------------------------------------------------ workloads

/** GPU processes: anything holding GPU memory or showing GPU utilisation. */
export function gpuProcesses(procs: readonly ProcSample[] | null | undefined): ProcSample[] {
  return (procs ?? []).filter((p) => (p.gpu_mem ?? 0) > 0 || (p.gpu_util ?? 0) > 0);
}

/** The process that best describes what a node is doing: most GPU memory, then most GPU utilisation. */
export function topGpuProcess(procs: readonly ProcSample[] | null | undefined): ProcSample | null {
  let best: ProcSample | null = null;
  for (const p of gpuProcesses(procs)) {
    if (!best || (p.gpu_mem ?? 0) > (best.gpu_mem ?? 0) || ((p.gpu_mem ?? 0) === (best.gpu_mem ?? 0) && (p.gpu_util ?? 0) > (best.gpu_util ?? 0))) {
      best = p;
    }
  }
  return best;
}

/** Name for a workload: detected model, else container, else process name. */
export const workloadName = (p: ProcSample) => p.model ?? p.container ?? p.name;

const SERVING = /serv(e|er|ing)|vllm|sglang|text-generation|llama-server|trtllm|triton|ollama/i;
/** Inference servers say so in their command line (vLLM, `serve_*.py`, `api_server`, llama-server…). */
export const isServing = (p: ProcSample) => SERVING.test(`${p.name} ${p.cmdline} ${p.container ?? ''}`);

export interface NodeActivityInput {
  id: string;
  /** Latest process list (null until the first process refresh). */
  procs: readonly ProcSample[] | null;
}

/**
 * What the cluster is running, grouped by workload: "Serving DeepSeek-V4.1-Flash-EXL3 across 2 nodes",
 * "Serving X across 2 nodes and Y on spark3", "Running train.py on spark1". Null when no GPU process is known;
 * "No GPU workloads" when every node reported its processes and none uses the GPU.
 */
export function workloadSentence(nodes: readonly NodeActivityInput[]): string | null {
  const groups = new Map<string, { nodes: string[]; serving: boolean }>();
  let reported = 0;
  for (const n of nodes) {
    if (n.procs) reported++;
    const top = topGpuProcess(n.procs);
    if (!top) continue;
    const name = workloadName(top);
    const g = groups.get(name) ?? { nodes: [], serving: false };
    g.nodes.push(n.id);
    g.serving ||= isServing(top);
    groups.set(name, g);
  }
  if (!groups.size) return reported && reported === nodes.length ? 'No GPU workloads' : null;
  const sorted = [...groups.entries()].sort((a, b) => b[1].nodes.length - a[1].nodes.length);
  const phrase = ([name, g]: [string, { nodes: string[] }]) => `${name} ${g.nodes.length > 1 ? `across ${g.nodes.length} nodes` : `on ${g.nodes[0] ?? ''}`}`;
  const verb = (serving: boolean) => (serving ? 'Serving' : 'Running');
  const [first, second] = sorted;
  if (!first) return null;
  let text = `${verb(first[1].serving)} ${phrase(first)}`;
  const more = sorted.length > 2 ? ` and ${plural(sorted.length - 2, 'more workload', 'more workloads')}` : '';
  if (second) {
    const sameVerb = second[1].serving === first[1].serving;
    text += `${sameVerb && !more ? ' and' : ','} ${sameVerb ? '' : `${verb(second[1].serving).toLowerCase()} `}${phrase(second)}`;
  }
  text += more;
  return text;
}

// ------------------------------------------------------------------------------------------------ totals

export interface NodeNumbers {
  util: number | null;
  power: number | null;
  memUsed: number | null;
  memTotal: number | null;
  psi: number | null;
}

export interface Totals {
  /** Mean GPU utilisation over the nodes that report it. */
  util: number | null;
  /** Sum of GPU (rail) power. */
  power: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memPct: number | null;
  psiMax: number | null;
  reporting: number;
}

export function clusterTotals(nodes: readonly NodeNumbers[]): Totals {
  let utilSum = 0;
  let utilN = 0;
  let power: number | null = null;
  let used: number | null = null;
  let total: number | null = null;
  let psi: number | null = null;
  let reporting = 0;
  for (const n of nodes) {
    if (n.util != null) {
      utilSum += n.util;
      utilN++;
    }
    if (n.power != null) power = (power ?? 0) + n.power;
    if (n.memUsed != null && n.memTotal) {
      used = (used ?? 0) + n.memUsed;
      total = (total ?? 0) + n.memTotal;
    }
    if (n.psi != null) psi = Math.max(psi ?? 0, n.psi);
    if (n.util != null || n.power != null || n.memUsed != null) reporting++;
  }
  return {
    util: utilN ? utilSum / utilN : null,
    power,
    memUsed: used,
    memTotal: total,
    memPct: used != null && total ? (100 * used) / total : null,
    psiMax: psi,
    reporting,
  };
}

// ------------------------------------------------------------------------------------------------ unified memory

export interface MemSplit {
  /** Bytes, summing to `total`. */
  gpu: number;
  other: number;
  available: number;
  total: number;
  /** Fractions of total, for the bar. */
  gpuFrac: number;
  otherFrac: number;
  /** False when the GPU share is not reported (then `other` is all of used). */
  gpuKnown: boolean;
}

/** In use = total − available (as the agent reports `used`), split into GPU-allocated and everything else. */
export function memSplit(total: number | null | undefined, available: number | null | undefined, gpu: number | null | undefined): MemSplit | null {
  if (!total || total <= 0 || available == null) return null;
  const avail = Math.min(total, Math.max(0, available));
  const used = total - avail;
  const g = gpu == null ? 0 : Math.min(used, Math.max(0, gpu));
  return { gpu: g, other: used - g, available: avail, total, gpuFrac: g / total, otherFrac: (used - g) / total, gpuKnown: gpu != null };
}

// ------------------------------------------------------------------------------------------------ energy

// ------------------------------------------------------------------------------------------------ interconnect

export interface Rail {
  /** Interface name on node `a`. */
  name: string;
  /** Interface name on node `b` at the same position, when b's info is known. */
  peerName: string | null;
  /** "Rail A". */
  label: string;
  speedMbps: number | null;
}

export interface Link {
  a: string;
  b: string;
  rails: Rail[];
}

const peerRails = (info: NodeInfo | null | undefined, peer: string): NetIfInfo[] =>
  (info?.net ?? []).filter((n) => n.role === 'interconnect' && n.peer === peer);

/** "ConnectX-7 rail A" -> "Rail A". */
export function railLabel(label: string, index: number): string {
  const short = label.replace(/^connectx-?7\s*/i, '').trim();
  if (!short) return `Rail ${String.fromCharCode(65 + index)}`;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Direct links between nodes, one per node pair, from the interconnect interfaces that name a peer. */
export function interconnectLinks(order: readonly string[], infos: Readonly<Record<string, NodeInfo | null | undefined>>): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const a of order) {
    const peers = new Set((infos[a]?.net ?? []).filter((n) => n.role === 'interconnect' && n.peer).map((n) => n.peer as string));
    for (const b of peers) {
      const key = [a, b].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      const theirs = peerRails(infos[b], a);
      links.push({
        a,
        b,
        rails: peerRails(infos[a], b).map((n, i) => ({
          name: n.name,
          peerName: theirs[i]?.name ?? null,
          label: railLabel(n.label, i),
          speedMbps: n.speed_mbps,
        })),
      });
    }
  }
  return links;
}

/** Share of a link's line rate in use (0..1), from bytes/s and Mb/s. */
export function linkLoad(bytesPerSec: number | null | undefined, speedMbps: number | null | undefined): number {
  if (bytesPerSec == null || !speedMbps) return 0;
  return Math.min(1, Math.max(0, (bytesPerSec * 8) / (speedMbps * 1e6)));
}

/** Flow animation speed bucket 0..5 for a load fraction: 0 = still; quantised so the CSS animation rarely restarts. */
export function flowLevel(load: number): number {
  if (!(load > 0.001)) return 0;
  if (load < 0.02) return 1;
  if (load < 0.1) return 2;
  if (load < 0.3) return 3;
  if (load < 0.6) return 4;
  return 5;
}

/** Breathing bucket 0..3 for a GPU utilisation percentage (0 = calm/static). */
export function breathLevel(util: number | null | undefined): number {
  if (util == null || util < 5) return 0;
  if (util < 40) return 1;
  if (util < 75) return 2;
  return 3;
}
