import { notReported, type NotReported } from './capabilities';
import { GPU_VENDORS, type GpuVendor, type NodeInfo } from './types';

const PLATFORM_LABEL = new Map([['linux', 'Linux'], ['darwin', 'macOS']]);
const VENDOR_LABEL: Record<GpuVendor, string> = { nvidia: 'NVIDIA', amd: 'AMD', apple: 'Apple' };

export interface BackendInUse {
  vendor: string;
  backend: string;
  gpus: string[];
}

export interface SkippedBackend {
  backend: string | null;
  reason: string;
}

export interface VersionGroup {
  vendor: string;
  rows: { label: string; value: string }[];
}

export interface PlatformSheet {
  platform: string;
  backends: BackendInUse[];
  backendGap: NotReported | null;
  skipped: SkippedBackend[];
  versions: VersionGroup[];
}

const platformLabel = (p: string) => PLATFORM_LABEL.get(p) ?? p;
const vendorLabel = (v: string) => (Object.hasOwn(VENDOR_LABEL, v) ? VENDOR_LABEL[v as GpuVendor] : v);
const vendorRank = (v: string) => {
  const i = (GPU_VENDORS as readonly string[]).indexOf(v);
  return i < 0 ? GPU_VENDORS.length : i;
};

function parseSkipped(reason: string): SkippedBackend[] {
  return reason.split('; ').map((item) => {
    const at = item.indexOf(': ');
    const backend = item.slice(0, at);
    return at > 0 && /^[\w-]+$/.test(backend) ? { backend, reason: item.slice(at + 2) } : { backend: null, reason: item };
  });
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

  const backendGap = notReported(info, 'gpu.backend');
  return {
    platform: platformLabel(info.platform ?? 'linux'),
    backends,
    backendGap,
    skipped: backendGap ? parseSkipped(backendGap.detail) : [],
    versions,
  };
}
