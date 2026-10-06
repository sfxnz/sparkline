// Wall-mode logic: tile grid shape, ConnectX-7 throughput per node, the alert ticker. Pure, unit-tested.
import { bitrateParts, type Formatter } from '../../lib/format';
import type { Event, NetIfInfo } from '../../lib/types';
import { openAlerts } from '../alerts/model';

/** Columns for N node tiles: one row up to 3 nodes, then a balanced grid (4 -> 2x2, 5-6 -> 3x2, 7-9 -> 3x3). */
export function wallColumns(n: number): number {
  if (n <= 3) return Math.max(1, n);
  if (n === 4) return 2;
  return n <= 9 ? 3 : 4;
}

/** CX7 rails cabled to another node (as on the overview); spare ports, LAN, virtual and wireless are not part of
 *  the wall story. Empty: the node has no direct link. */
export function interconnectNames(net: readonly NetIfInfo[] | null | undefined): string[] {
  return (net ?? []).filter((n) => n.role === 'interconnect' && n.peer).map((n) => n.name);
}

/**
 * rx + tx bytes/s summed over the interconnect interfaces, or null when none report. Reads flattened keys (the
 * LiveStore rings also hold history seeded on connect, so a node that is already stale still shows its last value).
 */
export function cx7Throughput(get: (key: string) => number | null, names: readonly string[]): number | null {
  let sum: number | null = null;
  for (const n of names) {
    for (const dir of ['rx_bps', 'tx_bps']) {
      const v = get(`net.${n}.${dir}`);
      if (v !== null) sum = (sum ?? 0) + v;
    }
  }
  return sum;
}

/** Alerts worth showing across a room: open warning/critical, worst first, newest first. */
export function tickerAlerts(events: readonly Event[]): Event[] {
  return openAlerts(events).filter((e) => e.severity !== 'info');
}

/** Fixed Gb/s, so the width never hops through b/s, kb/s and Mb/s; a trickle that rounds to zero (control traffic,
 *  an NCCL bootstrap) reads "<0.01 Gb/s", never the "0.00" of a dead link. Input is bytes/s. */
export const gbpsParts: Formatter = (n) => (n > 0 && n * 8 < 5e6 ? { value: '<0.01', unit: 'Gb/s' } : bitrateParts(n, 'Gb/s'));
