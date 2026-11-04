import { describeGap, notReported, type NotReported } from './capabilities';
import { GPU_VENDORS, type GpuVendor, type NodeInfo } from './types';

const PLATFORM_LABEL = new Map([['linux', 'Linux'], ['darwin', 'macOS']]);
const VENDOR_LABEL: Record<GpuVendor, string> = { nvidia: 'NVIDIA', amd: 'AMD', apple: 'Apple' };

export interface BackendInUse {
  vendor: string;
  backend: string;
  gpus: string[];
}

/** A backend the agent tried and did not use. `backend` is null for a node-wide reason that names no backend. */
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
  /** With no backend in use: what the node lacks. Null while a backend is in use. */
  missing: 'No GPU backend opened' | 'No GPU found' | 'No GPUs reported' | null;
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
    const row = backends.find((b) => b.vendor === vendor && b.backend === backend);
    if (row) row.gpus.push(g.name);
    else backends.push({ vendor, backend, gpus: [g.name] });
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

  const noBackend = notReported(info, 'gpu.backend');
  const tried = skippedBackends(info);
  const skipped = tried.length || !noBackend ? tried : [{ backend: null, gap: noBackend }];
  let missing: PlatformSheet['missing'] = null;
  if (!backends.length) missing = noBackend ? 'No GPU backend opened' : tried.length ? 'No GPU found' : 'No GPUs reported';
  return { platform: platformLabel(info.platform ?? 'linux'), backends, missing, skipped, versions };
}
