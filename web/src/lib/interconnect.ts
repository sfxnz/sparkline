import type { NetIfInfo } from './types';

type Net = readonly NetIfInfo[] | null | undefined;

export type RdmaCounting =
  | { kind: 'included' }
  | { kind: 'missing'; ifaces: NetIfInfo[] }
  | { kind: 'none' };

export function ifaceLabel(n: Pick<NetIfInfo, 'label' | 'nic_model'>): string {
  const rest = /^Interconnect (.+)$/.exec(n.label)?.[1];
  if (!n.nic_model || rest === undefined) return n.label;
  return /^[A-Z]$/.test(rest) ? `${n.nic_model} rail ${rest}` : `${n.nic_model} ${rest}`;
}

export const railName = (n: Pick<NetIfInfo, 'name' | 'rail'>) => (n.rail ? `Rail ${n.rail}` : n.name);

export function nicModel(net: Net): string | null {
  const models = new Set((net ?? []).filter((n) => n.role === 'interconnect').map((n) => n.nic_model ?? null));
  const [only] = models;
  return models.size === 1 && only ? only : null;
}

export const nicHeading = (model: string | null) => model ?? 'Interconnect';

export const nicNoun = (model: string | null) => model ?? 'interconnect';

export function nicAbbr(model: string | null): string | null {
  const m = model ? /^ConnectX-(\d+)(.*)$/.exec(model) : null;
  return m ? `CX${m[1] ?? ''}${m[2] ?? ''}` : null;
}

export const noLinkReason = (model: string | null) => `No ${nicNoun(model)} rail on this node is cabled to another node.`;

const countsRdma = (n: NetIfInfo) => n.counter_source === 'netdev_rdma' || n.counter_source === 'ethtool_phy';

export function rdmaCounting(ifaces: readonly NetIfInfo[]): RdmaCounting {
  if (ifaces.length && ifaces.every(countsRdma)) return { kind: 'included' };
  const missing = ifaces.filter((n) => n.rdma_device && !countsRdma(n));
  return missing.length ? { kind: 'missing', ifaces: missing } : { kind: 'none' };
}
