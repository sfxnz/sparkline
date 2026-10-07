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
nodes**. Heavy benchmarks would disrupt it, so at first the benchmark suite was verified in dry-run and demo mode
only. Every benchmark was later run on both idle nodes: see "Measured on hardware (2026-10-07)" below.

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

- Two clusters/L3 domains: cpu0–9 (8 MiB L3) and cpu10–19 (16 MiB L3), each with 5 A725 + 5 X925 cores
  (`topology/cluster_id`, `cache/index3/shared_cpu_list`). Governor `performance`.
- Per-core `scaling_cur_freq` is readable but reports the *requested* clock (always 3900 / 2808 MHz, even idle).
  The real average clock is `cpufreq/cpuinfo_avg_freq` (user-readable; EAGAIN on an idle core). Per-core
  utilisation comes from `/proc/stat`. Load average is available.
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
| nccl-tests (`all_reduce_perf`) | ❌ | ❌ | Not used: it needs an MPI launcher across nodes. The NCCL benchmark uses `torch.distributed` (NCCL backend) in the PyTorch container and reports the same algbw/busbw |
| `fio` | ❌ | ❌ | Uses fio if installed. Otherwise a built-in O_DIRECT runner, clearly labelled |
| LLM engine | vLLM images present, custom servers | same | Engine-agnostic: an OpenAI-compatible endpoint with streaming TTFT/decode timing |
| `sudo` without a password | ❌ | — | `install.sh` must be run with sudo (`--dry-run` and `--destdir` work without). Dev runs use user-space processes |

## Measured on hardware (2026-10-07)

Every benchmark run through the console API on spark1 and spark2 with no other GPU workload or container (idle
check before each run, Docker events checked during). Image `nvcr.io/nvidia/pytorch:26.07-py3` (PyTorch
2.13.0a0, CUDA 13.3 in forward-compatibility mode over driver 580.173.02). Values are the spread over repeated
runs; both nodes agree within the figures given.

| Benchmark | Result | Cross-check |
|---|---|---|
| GPU matmul, 16384³ (TFLOPS) | BF16 98.4–99.5, FP16 97.3–99.4, FP8 per-tensor 195–200, **FP4 (NVFP4) 343–350** | CUDA events = wall clock; profiler kernels: `cutlass_80_tensorop` (BF16/FP16), `nvjet_sm121` (FP8), `cutlass3x_sm120_bstensorop…ue4m3xe2m1` (FP4). FP8/BF16 2.0×, FP4/FP8 1.75×. 1 PFLOP sparse FP4 ⇒ ~125 dense BF16: ~79 % |
| GPU matmul, smaller sizes | 4096: 82–90 % of the 16384 figure; 8192: 95–100 % | FP8 per-row scaling falls to 56 at 16384 (PyTorch's row-wise CUTLASS kernel) |
| Memory bandwidth, GPU (GB/s) | copy 221–224, triad 221–227 (1 and 8 GiB arrays) | own CUDA program: cudaMemcpy D2D 222.9, read-only 235. 81–86 % of 273 GB/s |
| Memory bandwidth, CPU (GB/s) | copy / triad: all 20 cores 117–127 / 117–122; 10 X925 117–122 / 112–116; 10 A725 125–129 / 120–123 | C STREAM copy (pthreads, pinned): all 122, X925 117, A725 123. Cluster 0 alone ~68, cluster 1 ~98; one core ~48 |
| CPU throughput, SHA-256 + zlib-1 (MB/s) | X925 core 245–246, A725 core 125; 10 X925 2450–2461; 10 A725 1248–1255; all 20 3632–3693 | standalone script pinned with `taskset`: 245.7 / 125.1. Scaling 10.0×; real clocks 3.89 / 2.80 GHz |
| NVMe, built-in O_DIRECT runner, 4 GiB, 4 workers | seq write 1 MiB 5.2–7.8 GB/s; seq read 1 MiB 7.7–9.5 GB/s; 4 KiB random 12–18 k IOPS read and write, p99 0.6–1.0 ms | `/proc/diskstats` byte counts match; page cache flat. 32 workers: 185 k IOPS (spark1), 111–123 k (spark2); own C program 139–165 k / 102 k |
| RDMA write, one rail, spark1 → spark2 | 108.9–109.0 Gb/s at 64 KiB (104.2 at 4 KiB, 109.1 at 1 MiB); latency typical 1.40–1.46 µs, p99 1.5 (rail A) / 1.95 (rail B) | hand `ib_write_bw` 108.94; NIC counters 115.1 Gb/s on the wire (RoCE MTU 1024 headers ×1.057). Each rail is a PCIe Gen5 x4 function. Both rails at once: 92.6 + 92.6 |
| NCCL all-reduce, 2 ranks, both rails (GB/s) | peak bus bandwidth 22.54–22.55 at 1 GiB; 8 B in 12.6–14.1 µs | NCCL log: NET/IB on `rocep1s0f1` + `roceP2p1s0f1`, GPU Direct RDMA off; NIC counters 29.6 GB per rail per direction as predicted. 180 Gb/s = 97.5 % of the two-rail perftest figure |
| LLM inference, vLLM v0.30.0, Qwen2.5-0.5B-Instruct, spark1 | decode 160 tok/s per request (163 at c=8), output 155 tok/s (c=1) / 1076 (c=8), TTFT p50 21 ms, serving memory 18.17 GiB | vLLM `/metrics`: 6.25 ms per token = 159.9 tok/s; `nvidia-smi` 18,609 MiB |
| Thermal soak, 10 min, 8192 BF16 | 94.6 → 93.7 TFLOPS (spark1), 95.5 → 95.0 (spark2); SM clock mean 2149 / 2181 MHz, CV 0.53 / 0.21 %; peak 81 °C; 0 % throttled; GPU power 85–87 W | 90 spot checks against `nvidia-smi`: equal utilisation and throttle mask, temperature within 2 °C, power within 1.4 W |

Observed behaviour worth knowing:

- Under load the GPU runs at 2.1–2.2 GHz (of a 3.0 GHz maximum) at 83–92 W with no throttle reason set. As it
  heats to ~80 °C the clock eases by 1–2 % without any reason bit; NVML utilisation tops out at 96 %.
- GB10 shows a ~1.2 % throughput dip once a second at a fixed point in each second, with or without the agent.
- Each CX7 rail carries ~109 Gb/s of payload; the two rails share one 200 Gb/s physical port, so both together
  carry ~185 Gb/s of payload (~195 on the wire). Interfaces are at MTU 1500, so RoCE uses 1024-byte packets.
- The NVMe answers a single 4 KiB request in ~200 µs (kernel average 231 µs), so few-worker random I/O is
  latency-bound; checking interrupt coalescing needs root (`nvme get-feature -f 8`).
- One RDMA latency run of 10 (rail B) read 3.89 µs (min 2.15) right after its bandwidth test; repeats read
  1.44–1.46 µs. Not reproduced.

## Permissions

- The agent runs unprivileged. Everything above is readable as a normal user (NVML, sysfs, `/proc`, ethtool ioctl).
  `/dev/nvidia*`, `/dev/infiniband/uverbs*` and `rdma_cm` are mode 0666 on DGX OS, so the installed `sparkline`
  user needs no device groups (`install.sh` adds a device's group only if it is not world-accessible).
- Container names: `/proc/<pid>/cgroup` gives `docker-<id>.scope`, which the agent resolves through
  `/var/run/docker.sock`. In development the user is in the `docker` group. The installed agent gets Docker
  access only with `install.sh agent --enable-benchmarks`. Otherwise it shows the short container id.
