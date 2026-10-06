// Stable selectors for useLatest (module scope, so subscriptions keep their identity across renders).
import type { NodeInfo, Sample } from '../../../lib/types';

export const gpuUtil = (s: Sample | null) => s?.gpu[0]?.util ?? null;
export const gpuTemp = (s: Sample | null) => s?.gpu[0]?.temp_c ?? null;
export const gpuPower = (s: Sample | null) => s?.gpu[0]?.power_w ?? null;
export const gpuSm = (s: Sample | null) => s?.gpu[0]?.sm_mhz ?? null;
export const gpuPstate = (s: Sample | null) => s?.gpu[0]?.pstate ?? null;
export const gpuEnergy = (s: Sample | null) => s?.gpu[0]?.energy_j ?? null;
export const memAvailable = (s: Sample | null) => s?.mem.available ?? null;
export const memSwapUsed = (s: Sample | null) => s?.mem.swap_used ?? null;
export const memPsiSome = (s: Sample | null) => s?.mem.psi_some ?? null;
export const memPsiFull = (s: Sample | null) => s?.mem.psi_full ?? null;
export const cpuUtil = (s: Sample | null) => s?.cpu.util ?? null;
export const procs = (s: Sample | null) => s?.procs ?? null;
export const mem = (s: Sample | null) => s?.mem ?? null;

export function rootUsedPct(s: Sample | null): number | null {
  const f = s?.fs.find((x) => x.mount === '/');
  return f && f.used + f.free > 0 ? (100 * f.used) / (f.used + f.free) : null; // like df
}

/** ConnectX-7 rails cabled to a peer node: the same rule as the Overview card and Wall mode, so every screen agrees
 *  on "No direct link". A port with a negotiated speed but no peer is not a link to another node. */
export function cx7Rails(info: NodeInfo | null | undefined): { name: string; label: string }[] {
  return (info?.net ?? []).filter((n) => n.role === 'interconnect' && n.peer).map((n) => ({ name: n.name, label: n.label }));
}

/** Why a node has no ConnectX-7 figures (shown with "No direct link"). */
export const NO_LINK_REASON = 'No ConnectX-7 rail on this node is cabled to another node.';

/** Short rail name for legends: "ConnectX-7 rail A" -> "Rail A". */
export const railShort = (label: string) => label.replace(/^ConnectX-7\s+/i, '').replace(/^rail/, 'Rail');

/** Sum of one direction over the given interfaces (null when none reports). */
export function sumNet(s: Sample | null, names: readonly string[], dir: 'rx_bps' | 'tx_bps'): number | null {
  if (!s) return null;
  let total = 0;
  let any = false;
  for (const n of s.net) {
    if (!names.includes(n.name)) continue;
    total += n[dir];
    any = true;
  }
  return any ? total : null;
}
