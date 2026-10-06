// Mirror of server/sparkline/common/schema.py (SCHEMA_VERSION 1). Keep field names identical.
// Timestamps are Unix epoch seconds (float). Bytes are ints. Rates are per second.
// A metric the hardware does not report is `null` in samples AND listed in NodeInfo.unsupported.

export const SCHEMA_VERSION = 1;

// --- Static node description -------------------------------------------------------------------

export interface Unsupported {
  metric: string;
  reason: string;
}

export interface CoreInfo {
  id: number;
  kind: 'performance' | 'efficiency' | 'unknown';
  model: string | null;
  max_mhz: number | null;
  cluster: number | null;
}

export interface GpuInfo {
  index: number;
  name: string;
  uuid: string | null;
  arch: string | null;
  compute_capability: string | null;
  cuda_cores: number | null;
  sm_mhz_max: number | null;
  temp_slowdown_c: number | null;
  temp_shutdown_c: number | null;
  temp_max_c: number | null;
  power_limit_w: number | null;
}

export interface NetIfInfo {
  name: string;
  role: 'interconnect' | 'lan' | 'virtual' | 'wireless' | 'other';
  label: string;
  mac: string | null;
  ipv4: string[];
  speed_mbps: number | null;
  rdma_device: string | null;
  counter_source: 'netdev_rdma' | 'ethtool_phy' | 'netdev';
  peer: string | null;
}

export interface DiskInfo {
  name: string;
  model: string | null;
  size_bytes: number | null;
  mounts: string[];
}

export interface SensorInfo {
  id: string;
  label: string;
  group: 'soc' | 'gpu' | 'nvme' | 'nic' | 'wireless' | 'other';
  crit_c: number | null;
}

export interface NodeInfo {
  schema_version: number;
  node_id: string;
  hostname: string;
  agent_version: string;
  os: string;
  kernel: string;
  driver: string | null;
  cuda: string | null;
  nvml: string | null;
  cpu_model: string;
  cores: CoreInfo[];
  mem_total: number;
  swap_total: number;
  gpus: GpuInfo[];
  net: NetIfInfo[];
  disks: DiskInfo[];
  sensors: SensorInfo[];
  unsupported: Unsupported[];
  tools: Record<string, boolean>;
  sample_interval_ms: number;
  boot_time: number;
}

// --- Live sample -------------------------------------------------------------------------------

export interface GpuSample {
  index: number;
  util: number | null;
  sm_mhz: number | null;
  gr_mhz: number | null;
  video_mhz: number | null;
  temp_c: number | null;
  power_w: number | null;
  energy_j: number | null;
  pstate: number | null;
  throttle_mask: number | null;
  power_capped_pct: number | null;
  thermal_capped_pct: number | null;
}

export interface MemSample {
  total: number;
  available: number;
  used: number;
  free: number;
  gpu: number | null;
  anon: number;
  cache: number;
  shmem: number;
  kernel: number;
  other: number;
  swap_total: number;
  swap_used: number;
  psi_some: number | null;
  psi_full: number | null;
}

export interface CpuSample {
  util: number;
  perf_util: number | null;
  eff_util: number | null;
  per_core: number[];
  freq_mhz: (number | null)[];
  load1: number;
  load5: number;
  load15: number;
  psi_some: number | null;
}

export interface NetSample {
  name: string;
  up: boolean;
  speed_mbps: number | null;
  rx_bps: number; // bytes/s
  tx_bps: number;
  errors: number;
  drops: number;
  rdma_state: string | null;
  rdma_rate: string | null;
}

export interface DiskSample {
  name: string;
  read_bps: number;
  write_bps: number;
  read_iops: number;
  write_iops: number;
  busy_pct: number;
}

export interface FsSample {
  mount: string;
  key: string;
  device: string;
  total: number;
  used: number;
  free: number;
}

export interface TempSample {
  id: string;
  c: number | null;
}

export interface ProcSample {
  pid: number;
  name: string;
  cmdline: string;
  user: string | null;
  cpu_pct: number;
  rss: number;
  gpu_mem: number | null;
  gpu_util: number | null;
  container: string | null;
  model: string | null;
}

export interface Sample {
  node_id: string;
  ts: number;
  seq: number;
  interval_ms: number;
  gpu: GpuSample[];
  mem: MemSample;
  cpu: CpuSample;
  net: NetSample[];
  disk: DiskSample[];
  fs: FsSample[];
  temps: TempSample[];
  procs: ProcSample[] | null;
  errors: Record<string, string>;
}

// --- History -----------------------------------------------------------------------------------

export interface HistoryResponse {
  node_id: string;
  resolution_s: number;
  ts: number[];
  series: Record<string, (number | null)[]>;
  min: Record<string, (number | null)[]>;
  max: Record<string, (number | null)[]>;
}

// --- Console: cluster state, alerts, events ----------------------------------------------------

export type NodeStatus = 'connecting' | 'online' | 'stale' | 'offline' | 'error';

export interface Problem {
  message: string;
  cause: string;
  fix: string;
}

export interface NodeState {
  node_id: string;
  url: string;
  status: NodeStatus;
  since: number;
  last_sample_ts: number | null;
  error: Problem | null;
  info: NodeInfo | null;
  next_retry_ts: number | null;
}

export interface ConsoleSettings {
  energy_rate_per_kwh: number;
  currency: string;
  stale_after_s: number;
  offline_after_s: number;
  regression_pct: number;
}

export interface ClusterState {
  nodes: NodeState[];
  settings: ConsoleSettings;
  demo: boolean;
  version: string;
  server_time: number;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'threshold' | 'throttle' | 'node_offline' | 'link_down';
  metric: string | null;
  op: '>' | '<';
  threshold: number | null;
  for_s: number;
  severity: Severity;
  nodes: string[] | null;
}

export interface Event {
  id: number;
  ts: number;
  node_id: string | null;
  severity: Severity;
  kind: 'alert' | 'recovered' | 'node' | 'bench' | 'system';
  rule_id: string | null;
  title: string;
  detail: string;
  metric: string | null;
  value: number | null;
  resolved_ts: number | null;
  acked: boolean;
}

// --- Benchmarks --------------------------------------------------------------------------------

export interface BenchParam {
  name: string;
  label: string;
  type: 'int' | 'float' | 'enum' | 'bool' | 'string' | 'multi';
  default: unknown;
  min: number | null;
  max: number | null;
  choices: string[] | null;
  unit: string | null;
  help: string | null;
}

export interface BenchImpact {
  thermal: 'low' | 'medium' | 'high';
  power: 'low' | 'medium' | 'high';
  disruptive: boolean;
  note: string;
}

export interface BenchSpec {
  id: string;
  name: string;
  category: 'compute' | 'memory' | 'cpu' | 'interconnect' | 'storage' | 'inference' | 'soak';
  description: string;
  est_duration_s: number;
  impact: BenchImpact;
  params: BenchParam[];
  min_nodes: number;
  max_nodes: number | null;
  requires: string[];
  availability: Record<string, Problem | null>;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BenchResult {
  metric: string;
  label: string;
  value: number;
  unit: string;
  better: 'higher' | 'lower';
  node_id: string | null;
  extras: Record<string, unknown>;
  baseline: number | null;
  regression: boolean;
}

export interface BenchRun {
  id: string;
  bench_id: string;
  params: Record<string, unknown>;
  nodes: string[];
  status: RunStatus;
  created_ts: number;
  started_ts: number | null;
  finished_ts: number | null;
  progress: number;
  phase: string;
  results: BenchResult[];
  series: Record<string, number[]>;
  metadata: Record<string, unknown>;
  error: Problem | null;
  log_tail: string[];
  baseline_for: boolean;
}

// --- WebSocket messages (console -> browser) ---------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  cluster: ClusterState;
}
export interface SampleMessage {
  type: 'sample';
  node_id: string;
  sample: Sample;
}
export interface NodeStatusMessage {
  type: 'node_status';
  node: NodeState;
}
export interface EventMessage {
  type: 'event';
  event: Event;
}
export interface BenchMessage {
  type: 'bench';
  run: BenchRun;
}
export interface PingMessage {
  type: 'ping';
  ts: number;
}

export type WsMessage =
  | HelloMessage
  | SampleMessage
  | NodeStatusMessage
  | EventMessage
  | BenchMessage
  | PingMessage;
