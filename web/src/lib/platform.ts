import { describeGap, lostGpu, notReported, type NotReported } from './capabilities';
import { gpuAt } from './gpu';
import { GPU_VENDORS, type GpuVendor, type NodeInfo } from './types';

const PLATFORM_LABEL = new Map([['linux', 'Linux'], ['darwin', 'macOS']]);
const VENDOR_LABEL: Record<GpuVendor, string> = { nvidia: 'NVIDIA', amd: 'AMD', apple: 'Apple' };

export interface BackendInUse {
  vendor: string;
  backend: string;
  /** Names of the GPUs it reads. */
  gpus: string[];
  /** GPUs it sees but cannot read. */
  notResponding: { index: number; reason: string }[];
}

export interface SkippedBackend {
  backend: string | null;
  gap: NotReported;
}

export interface VersionGroup {
  vendor: string;
  rows: { label: string; value: string }[];
}

export interface PlatformSheet {
  platform: string;
  backends: BackendInUse[];
  missing: 'No GPU backend opened' | 'No GPU found' | 'No GPU data' | 'No GPUs reported' | null;
  skipped: SkippedBackend[];
  versions: VersionGroup[];
}

const platformLabel = (p: string) => PLATFORM_LABEL.get(p) ?? p;
const vendorLabel = (v: string) => (Object.hasOwn(VENDOR_LABEL, v) ? VENDOR_LABEL[v as GpuVendor] : v);
const vendorRank = (v: string) => {
  const i = (GPU_VENDORS as readonly string[]).indexOf(v);
  return i < 0 ? GPU_VENDORS.length : i;
};

const BACKEND_ENTRY = 'gpu.backend.';

export function skippedBackends(info: NodeInfo): SkippedBackend[] {
  return info.unsupported
    .filter((u) => u.metric.startsWith(BACKEND_ENTRY))
    .map((u) => ({ backend: u.metric.slice(BACKEND_ENTRY.length), gap: describeGap(u) }));
}

export function platformSheet(info: NodeInfo): PlatformSheet {
  const backends: BackendInUse[] = [];
  for (const g of info.gpus) {
    const vendor = vendorLabel(g.vendor ?? 'nvidia');
    const backend = g.backend ?? 'nvml';
    const row = backends.find((b) => b.vendor === vendor && b.backend === backend) ?? { vendor, backend, gpus: [], notResponding: [] };
    if (!backends.includes(row)) backends.push(row);
    const lost = lostGpu(info, g.index);
    if (lost) row.notResponding.push({ index: g.index, reason: lost.detail });
    else row.gpus.push(g.name);
  }

  const groups = new Map<string, VersionGroup>();
  for (const [key, value] of Object.entries(info.versions ?? {})) {
    const dot = key.indexOf('.');
    const prefix = dot < 0 ? 'Other' : key.slice(0, dot);
    const group = groups.get(prefix) ?? { vendor: vendorLabel(prefix), rows: [] };
    group.rows.push({ label: key.slice(dot + 1), value });
    groups.set(prefix, group);
  }
  const versions = [...groups.entries()].sort(([a], [b]) => vendorRank(a) - vendorRank(b)).map(([, g]) => g);

  const { missing, skipped } = whyNoBackend(info, backends.length > 0);
  return { platform: platformLabel(info.platform ?? 'linux'), backends, missing, skipped, versions };
}

function whyNoBackend(info: NodeInfo, inUse: boolean): Pick<PlatformSheet, 'missing' | 'skipped'> {
  const tried = skippedBackends(info);
  if (inUse) return { missing: null, skipped: tried };
  const noBackend = notReported(info, 'gpu.backend');
  if (tried.length) return { missing: noBackend ? 'No GPU backend opened' : 'No GPU found', skipped: tried };
  if (noBackend) return { missing: 'No GPU backend opened', skipped: [{ backend: null, gap: noBackend }] };
  const older = notReported(info, 'gpu0');
  return older ? { missing: 'No GPU data', skipped: [{ backend: null, gap: older }] } : { missing: 'No GPUs reported', skipped: [] };
}

export function noGpuLabel(info: NodeInfo): string | null {
  if (info.gpus.length) return null;
  const { missing } = whyNoBackend(info, false);
  return missing === 'No GPU backend opened' ? 'No GPU backend' : missing === 'No GPU found' ? 'No GPU' : null;
}

/** The node's headline GPU: GPU 0's name, "GPU not responding" when its backend sees it but cannot read it, or why
 *  the node has no GPU. */
export function gpuHeadline(info: NodeInfo): string | null {
  const g = gpuAt(info.gpus, 0);
  if (!g) return noGpuLabel(info);
  return lostGpu(info, 0) ? 'GPU not responding' : g.name;
}
