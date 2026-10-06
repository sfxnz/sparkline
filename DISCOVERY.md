# DISCOVERY — what the hardware actually reports

Probed 2026-10-06 on **spark1** (local) and **spark2** (via `ssh spark2`). Both nodes are identical.
Everything below was observed directly. Metrics not listed here are not shown as data in the UI.

## Cluster

| | spark1 | spark2 |
|---|---|---|
| Hostname | `spark1` | `spark2` |
| LAN (10 GbE, `enP7s7`) | 10.20.20.48 | 10.20.20.195 |
| CX7 rail A (`enp1s0f1np1`, RDMA `rocep1s0f1`) | 10.100.8.1 | 10.100.8.2 |
| CX7 rail B (`enP2p1s0f1np1`, RDMA `roceP2p1s0f1`) | 10.100.9.1 | 10.100.9.2 |
| Tailscale | 100.100.1.1 | 100.100.1.2 |
| OS | Ubuntu 24.04.4 (DGX OS), kernel 6.17.0-1032-nvidia, aarch64 | same |
| Driver / CUDA | 580.173.02 / CUDA 13.0 (NVML 13.580.173.02) | same |

Workload at probe time: a TP=2 inference job (`serve_stats.py`, container `c5-2B-r0`,
`nvcr.io/nvidia/pytorch:26.07-py3`) using ~86 GB of GPU-allocated memory and ~90% GPU utilisation **on both
nodes**. Heavy benchmarks would disrupt it, so the benchmark suite was verified in dry-run and demo mode only.

## GPU — NVIDIA GB10 (Blackwell, CC 12.1, 6144 CUDA cores)

NVML (`nvidia-ml-py`) results:

| Field | Result | Use |
|---|---|---|
| `nvmlDeviceGetUtilizationRates().gpu` | ✅ % | GPU utilisation |
| `.memory` (mem controller util) | ⚠️ always 0 | **Not shown** (not meaningful on UMA) |
| `GetMemoryInfo` (FB total/used/free) | ❌ Not Supported | Memory comes from `/proc/meminfo` instead |
| `GetTemperature(GPU)` | ✅ °C | |
| Temp thresholds slowdown / shutdown / gpu_max | ✅ 86 / 90 / 99 °C | Headroom display, alert defaults |
| `GetPowerUsage` | ✅ mW (~30–35 W under this load) | GPU power |
| Power limit / enforced / constraints | ❌ Not Supported | No "power vs limit"; show power vs observed peak instead |
| `GetTotalEnergyConsumption` | ✅ mJ counter | Energy totals (kWh, £) |
| Clocks SM / Graphics / Video (current + max) | ✅ (SM 2171 of max 3003 MHz) | |
| Memory clock | ❌ Not Supported | |
| `GetCurrentClocksEventReasons` | ✅ bitmask, supported mask `0x1ff` | Throttle reasons, decoded |
| `GetViolationStatus(POWER/THERMAL)` | ✅ cumulative ns | "% of time power capped" |
| Performance state | ✅ P0 | |
| Fan speed | ❌ Not Supported | No fan data |
| `GetComputeRunningProcesses` | ✅ pid + usedGpuMemory | Per-process GPU memory |
| `GetProcessUtilization` | ✅ (samples returned) | Per-process SM % (best effort) |
| Encoder / decoder util | ✅ (idle) | Not shown (noise) |
| PCIe throughput, ECC, BAR1, retired pages | ❌ N/A | Not shown |

**DCGM / dcgm-exporter: not installed** on either node (no `dcgmi`, no `datacenter-gpu-manager`
package). The agent uses NVML directly. It can add DCGM later, but it is not needed.

## Unified memory

- `MemTotal` 121.7 GiB. CPU and GPU share it. `free` reports ~96 GiB used, of which ~86 GB is GPU-allocated
  (NVML per-process `usedGpuMemory`). That GPU memory does **not** appear in `AnonPages` (5 GiB).
- Breakdown available from `/proc/meminfo` + NVML: GPU-allocated (sum of NVML per-process), process
  anonymous (`AnonPages`), page cache (`Cached`−`Shmem`), shared (`Shmem`), kernel (`Slab`, etc.), free.
  The remainder is reported as "other / driver".
- Swap: 16 GiB, ~4 GiB used. PSI (`/proc/pressure/{memory,cpu,io}`) is available and is the memory
  pressure signal.

## CPU — 20 cores, heterogeneous (not "Grace")

The brief says Grace. GB10's CPU is actually **10× Cortex-X925 (performance) + 10× Cortex-A725 (efficiency)**:

| Cores | Type | `CPU part` | Max freq |
|---|---|---|---|
| 0–4, 10–14 | Cortex-A725 (efficiency) | 0xd87 | 2.808 GHz |
| 5–9, 15–19 | Cortex-X925 (performance) | 0xd85 | 3.900 GHz |

- Two clusters/L3 domains (`topology/cluster_id`: cpu1–10 vs cpu0,11–19). Governor `performance`.
- Per-core `scaling_cur_freq` is readable. Per-core utilisation comes from `/proc/stat`. Load average is available.
- The core type is classified at runtime from `cpuinfo_max_freq` (with `CPU part` as a cross-check), not hard-coded.

## Network

| Interface | Kind | Speed | State |
|---|---|---|---|
| `enP7s7` | 10 GbE LAN | 10 Gb/s | up |
| `enp1s0f1np1` / `rocep1s0f1` | CX7 rail A, RoCE | 200 Gb/s (4X HDR) | up / ACTIVE |
| `enP2p1s0f1np1` / `roceP2p1s0f1` | CX7 rail B, RoCE | 200 Gb/s | up / ACTIVE |
| `enp1s0f0np0`, `enP2p1s0f0np0` | CX7 second port | — | no carrier (no cable) |
| `tailscale0`, `docker0`, `wlP9s9` | virtual / Wi-Fi | — | ignored by default |

**Key finding:** inter-node traffic is RDMA. It bypasses the kernel netdev counters. In a 2 s sample,
`/sys/class/net/enp1s0f1np1/statistics/tx_bytes` grew by **648 B**, while the ethtool PHY counter
`tx_bytes_phy` grew by **573 MB**. The two rails are two PCI functions of **one physical port**
(same `phys_switch_id`, `phys_port_name` `p1`, same `sys_image_guid`), so the `*_phy` counters are port-wide and
read identically on both. Per-rail CX7 throughput is therefore **netdev bytes + RDMA
`counters/port_{rcv,xmit}_data` (4-byte words) of that function** (`counter_source = "netdev_rdma"`); the two
rails sum to the PHY total. The port-wide `rx/tx_discards_phy` and `rx_crc_errors_phy` come from the
`SIOCETHTOOL` ioctl (works without root) and are attributed once per physical port (to rail A). RDMA port
state and rate come from `/sys/class/infiniband/*/ports/1/{state,rate}`. Error
counters come from `.../counters/` and `.../hw_counters/` (e.g. `symbol_error`, `link_downed`,
`out_of_sequence`, `packet_seq_err`, `local_ack_timeout_err`). LAN throughput comes from netdev statistics.

## Storage

- One Samsung `MZALC4T0HBL1-00B07` 3.7 TB NVMe (`nvme0n1`) per node. Root is 82% full on spark1 and 84% on spark2.
- Throughput and IOPS come from `/proc/diskstats`. Capacity comes from `statvfs`. Temperatures come from hwmon `nvme`:
  Composite / Sensor 1 / Sensor 2.

## Thermals & power

- hwmon: `acpitz` ×7 zones (unlabelled, 63–72 °C), `nvme` ×3, `mlx5` ASIC ×4 (66 °C), `mt7925_phy0`
  (Wi-Fi). The four `mlx5` entries are the four PCI functions of one ConnectX-7 chip and read the same value;
  they are shown as one "ConnectX-7 ASIC" sensor (max of the four).
- No per-core CPU temperature (no coretemp-style chip): reported as unsupported (`cpu.temp`).
- The ACPI zones have no labels, so they are shown as "ACPI zone N". Their roles are not guessed.
- **Fans: not exposed** (no hwmon fan inputs. The thermal cooling devices are CPU "Processor" throttles).
- **Whole-system power: not exposed.** The only power sensor is the NVML GPU rail. The UI labels it
  "GPU power". It never presents it as wall power.

## Tooling for benchmarks

| Tool | spark1 | spark2 | Plan |
|---|---|---|---|
| `nvcc` 13.0 | ✅ | ✅ | — |
| Docker (user in `docker` group) | ✅ | ✅ | Runs GPU benchmarks in `nvcr.io/nvidia/pytorch:26.07-py3` (present on both) |
| `perftest` (`ib_write_bw`, `ib_write_lat`) | ✅ 24.01 | ✅ | RDMA bandwidth/latency |
| nccl-tests (`all_reduce_perf`) | ❌ | ❌ | Built on demand inside the PyTorch container, or uses a binary if found |
| `fio` | ❌ | ❌ | Uses fio if installed. Otherwise a built-in O_DIRECT runner, clearly labelled |
| LLM engine | vLLM images present, custom servers | same | Engine-agnostic: an OpenAI-compatible endpoint with streaming TTFT/decode timing |
| `sudo` without a password | ❌ | — | `install.sh` asks for sudo. Dev runs use user-space processes |

## Permissions

- The agent runs unprivileged. Everything above is readable as a normal user (NVML, sysfs, `/proc`, ethtool ioctl).
- Container names: `/proc/<pid>/cgroup` gives `docker-<id>.scope`, which the agent resolves through
  `/var/run/docker.sock` (the user is in the `docker` group).
