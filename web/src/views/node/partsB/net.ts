// Network helpers: interface classification, line-rate utilisation and error copy.
import type { NetIfInfo } from '../../../lib/types';

/**
 * Busiest direction as a share of line rate, in percent. Links are full duplex, so each direction has the whole
 * line rate to itself. Inputs are bytes/s (wire contract); speed is Mb/s. Null when the line rate is unknown.
 */
export function lineRateUtil(rxBps: number | null | undefined, txBps: number | null | undefined, speedMbps: number | null | undefined): number | null {
  if (!speedMbps || speedMbps <= 0) return null;
  const busiest = Math.max(rxBps ?? 0, txBps ?? 0);
  if (!Number.isFinite(busiest)) return null;
  return Math.min(100, Math.max(0, (busiest * 8 * 100) / (speedMbps * 1e6)));
}

export interface InterfaceGroups {
  /** Interconnect ports that are up, or that are wired to a known peer (shown as a full card, even when down). */
  links: NetIfInfo[];
  /** Interconnect ports with no link and no peer: listed compactly as "Not connected". */
  notConnected: NetIfInfo[];
  /** LAN and other physical interfaces. */
  lan: NetIfInfo[];
  /** Virtual and wireless interfaces, hidden by default. */
  hidden: NetIfInfo[];
}

export function classifyInterfaces(net: readonly NetIfInfo[], isUp: (name: string) => boolean | null): InterfaceGroups {
  const g: InterfaceGroups = { links: [], notConnected: [], lan: [], hidden: [] };
  for (const n of net) {
    if (n.role === 'virtual' || n.role === 'wireless') g.hidden.push(n);
    else if (n.role === 'interconnect') (isUp(n.name) || n.peer ? g.links : g.notConnected).push(n);
    else g.lan.push(n);
  }
  return g;
}

/** "200 Gb/s", "10 Gb/s", "100 Mb/s" (no-break space, so it never wraps apart). */
export function speedLabel(mbps: number | null | undefined): string | null {
  if (!mbps || mbps <= 0) return null;
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}\u00a0Gb/s` : `${mbps}\u00a0Mb/s`;
}

/** Kernel RDMA rate "200 Gb/sec (4X HDR)" -> "200 Gb/s (4X HDR)". */
export function rdmaRateLabel(rate: string | null | undefined): string | null {
  if (!rate) return null;
  return rate.replace(/Gb\/sec/i, 'Gb/s').trim();
}

/** RDMA port state in sentence case ("ACTIVE" -> "Active"; "4: ACTIVE" -> "Active"). */
export function rdmaStateLabel(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.replace(/^\d+:\s*/, '').trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/** Total of a per-interval counter (net.X.errors / .drops): live samples and history rollups both hold counts per
 *  point (rollups sum them per bucket), so the total is the rounded sum. */
export function counterTotal(values: readonly (number | null)[]): number {
  let sum = 0;
  for (const v of values) if (v != null && Number.isFinite(v)) sum += v;
  return Math.round(sum);
}

/** Plain-English error status: "No errors or drops", "3 errors", "1 error · 12 drops". */
export function errorSummary(errors: number | null, drops: number | null): { tone: 'ok' | 'warn' | 'unknown'; text: string } {
  if (errors == null || drops == null) return { tone: 'unknown', text: 'Counting…' };
  if (errors === 0 && drops === 0) return { tone: 'ok', text: 'No errors or drops' };
  const parts: string[] = [];
  if (errors) parts.push(`${errors.toLocaleString('en-GB')} ${errors === 1 ? 'error' : 'errors'}`);
  if (drops) parts.push(`${drops.toLocaleString('en-GB')} ${drops === 1 ? 'drop' : 'drops'}`);
  return { tone: 'warn', text: parts.join(' · ') };
}
