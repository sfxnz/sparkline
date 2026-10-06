# Sparkline — plan

Self-approved per the user's instruction ("no waiting for my decisions"). It is grounded in [DISCOVERY.md](DISCOVERY.md).

## Architecture

```
 spark1                        spark2
 ┌───────────────┐             ┌───────────────┐
 │ sparkline-agent   │ :9750       │ sparkline-agent   │ :9750      Python 3.12, FastAPI/uvicorn,
 │  collectors   │             │  collectors   │            nvidia-ml-py, psutil. 1 Hz default
 │  ring buffer  │             │  ring buffer  │            (250 ms–5 s). In-memory ring of 15 min,
 │  SQLite rollup│             │  SQLite rollup│            SQLite 10 s rollups (7 d) + 1 min (30 d).
 │  bench runner │             │  bench runner │            Whitelisted benchmark jobs only.
 └──────┬────────┘             └──────┬────────┘
        │ WS /api/v1/stream + REST (Bearer agent token, LAN/CX7 only)
        └──────────────┬──────────────┘
               ┌───────▼────────┐
               │ sparkline  │ :9700  aggregator: merges nodes, stale/offline detection, backoff
               │  alerts+events │        reconnect, alert engine, event timeline, benchmark
               │  bench results │        orchestration + results/baselines (SQLite), serves web/dist,
               │  --demo        │        token auth. --demo simulates nodes incl. failures.
               └───────┬────────┘
                       │ WS /api/v1/stream + REST (Bearer console token / cookie)
               ┌───────▼────────┐
               │  web (React)   │ Vite + React 18 + TS strict, uPlot, motion, zustand, wouter,
               └────────────────┘ lucide-react. Live buffers live outside React (typed arrays).
```

One Python project, `server/` (package `sparkline`), provides two entry points: `sparkline-agent` and `sparkline`.
The wire contract is `server/sparkline/common/schema.py`. The frontend mirrors it in `web/src/lib/types.ts`.

### Repository layout
```
server/  pyproject.toml, sparkline/{common,agent,console,bench}, tests/
web/     Vite app (src/{app,design,charts,store,lib,views}), tests (vitest), e2e (playwright)
bench/   whitelisted benchmark payload scripts (run on nodes, inside docker where GPU needed)
deploy/  install.sh, sparkline-agent.service, sparkline.service, docker-compose.yml, Dockerfile
```

### Ports, auth, binding
- Agent `:9750`, console `:9700`.
- Config: `/etc/sparkline/{agent,console}.toml` (or `--config`); env overrides `SPARKLINE_*`.
- **Binding:** the default `bind = "auto"` resolves to the node's private LAN IP. The server refuses to bind a public
  (non-RFC1918/CGNAT/loopback/link-local) address unless `--allow-public` is passed. `0.0.0.0` is refused unless it is explicit.
- **Auth:** the console uses `console_token`. The browser exchanges it at `/api/v1/auth/login` for an HttpOnly
  SameSite=Strict cookie. The API also accepts `Authorization: Bearer`. Agents use `agent_token`, sent by the
  console only. Tokens are compared with `hmac.compare_digest`. `install.sh` generates tokens.
- **No arbitrary execution:** benchmarks are a fixed registry. Parameters are validated by pydantic (enums, bounded ints).
  Commands are built as argv lists (never `shell=True`). Each job runs in its own process group, so cancel →
  SIGTERM, then SIGKILL after 5 s, plus `docker rm -f` of the named container.

## Wire protocol (console ↔ browser)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/login` `{token}` → cookie; `POST /api/v1/auth/logout`; `GET /api/v1/auth/me` | auth |
| `GET /api/v1/cluster` → `ClusterState` | nodes, status, NodeInfo, console config |
| `WS /api/v1/stream` | `hello` (ClusterState) → `sample` / `node_status` / `event` / `bench` / `ping` messages |
| `GET /api/v1/history?node=&keys=a,b&from=&to=&points=600` → `HistoryResponse` | downsampled series (proxied to the agent) |
| `GET /api/v1/live?node=&seconds=900` → `HistoryResponse` | the console's in-memory recent buffer (fast bootstrap) |
| `GET/PUT /api/v1/alerts/rules`; `GET /api/v1/events?since=&limit=`; `POST /api/v1/events/{id}/ack` | alerts |
| `GET /api/v1/settings`, `PUT /api/v1/settings` (energy £/kWh rate, sample interval) | settings |
| `DELETE /api/v1/history?node=` (body `{confirm:"DELETE"}`) | clear history |
| `GET /api/v1/bench/catalog`; `GET/POST /api/v1/bench/runs`; `GET /api/v1/bench/runs/{id}`; `POST …/{id}/cancel`; `DELETE …/{id}`; `GET …/{id}/export?format=json\|csv`; `PUT /api/v1/bench/baselines/{bench_id}` `{run_id}`; `GET /api/v1/bench/compare?ids=` | benchmarks |
| `GET /healthz` (no auth) | liveness |

The agent exposes the same shapes for a single node: `GET /api/v1/info`, `WS /api/v1/stream`, `GET /api/v1/history`,
`DELETE /api/v1/history`, `GET/POST /api/v1/bench/...`, and `GET /healthz`.

Live samples are full `Sample` objects (~3–5 kB) per node per tick. Processes are refreshed every 5 s (they are the
most expensive collector), and `procs` is `null` on the ticks in between.

### Flattened metric keys (history, alerts, charts)
`gpu0.util gpu0.sm_mhz gpu0.temp_c gpu0.power_w gpu0.energy_j gpu0.throttle_mask gpu0.power_capped_pct`
`mem.used mem.available mem.gpu mem.anon mem.cache mem.shmem mem.kernel mem.swap_used mem.psi_some mem.psi_full`
`cpu.util cpu.perf_util cpu.eff_util cpu.load1 cpu.psi_some cpu.core{N}.util cpu.core{N}.mhz`
`net.{ifname}.rx_bps net.{ifname}.tx_bps net.{ifname}.errors net.{ifname}.drops`
`disk.{dev}.read_bps disk.{dev}.write_bps disk.{dev}.read_iops disk.{dev}.write_iops disk.{dev}.busy_pct`
`fs.{mountkey}.used` (`/` → `root`, `/data` → `data`), `temp.{sensor_id}`

Rollups store avg/min/max per key per bucket. `energy_j` stores the last value, so kWh over a range is last − first
(counter resets are handled).

## Metric list (only what is confirmed in DISCOVERY)

| Area | Shown | Explicitly "not reported by this hardware" |
|---|---|---|
| GPU | util, SM/graphics clock vs max, temp vs slowdown/shutdown, power, energy, P-state, throttle reasons (decoded), % time power/thermal capped, per-process GPU memory | power limit, memory clock, fan, FB memory, ECC, PCIe throughput |
| Unified memory | used/available/total, breakdown GPU-allocated / process anon / page cache / shared / kernel / other, swap, PSI pressure | — |
| CPU | per-core util heatmap grouped X925 (performance) vs A725 (efficiency), per-core freq, util by type, load avg, PSI | per-core temp |
| Network | CX7 rails A/B: link state, RDMA state/rate, rx/tx throughput (PHY counters), errors/discards; LAN rx/tx | — |
| Storage | NVMe read/write B/s, IOPS, busy %, capacity per mount, NVMe temps | — |
| Thermals/power | all hwmon sensors grouped (SoC ACPI zones, NVMe, NIC ASIC), GPU temp, GPU power + energy kWh/£ | fans, whole-system power |
| Processes | top by GPU mem / RSS / CPU; container name (docker cgroup → name), model name (HF path / `--model` heuristics) | per-process GPU util when NVML returns no samples |
| Alerts | thresholds (GPU temp, throttling, memory pressure/available, node offline, disk full, CX7 link down, NVMe temp) + timeline | — |

## Screens

1. **Overview** `/`: hero "Cluster health" sentence (e.g. "All 2 nodes healthy · serving at 91% GPU"). Living node
   cards (a soft glow breathes with GPU load; status pill with icon+label; GPU %, temp, power, memory ring,
   sparklines). Cluster totals: compute util, GPU power + today's energy, aggregate memory pressure, active
   processes/jobs. CX7 link strip showing throughput between nodes. Recent events.
2. **Node** `/node/:id` (tabs, shared-element transition from the overview card): Summary · GPU · Memory · CPU · Network ·
   Storage · Thermals & Power · Processes. Each tab: stat header + synced uPlot charts + detail tables.
3. **Alerts** `/alerts`: event timeline (filter by node/severity, ack), rules editor (thresholds, durations).
4. **Benchmarks** `/benchmarks` (lazy chunk): catalog cards with availability per node → configure → confirm
   dialog (duration, thermal/power impact, effect on running workloads) → live run view (progress, phase, telemetry
   overlay) → results. History table, compare `/benchmarks/compare?ids=`, baselines + regression flags, export
   JSON/CSV, shareable summary card (PNG via canvas).
5. **Settings** `/settings`: theme (system/dark/light), reduced transparency, energy rate £/kWh, sample interval, clear
   history (confirm), tokens/help.
6. **Wall mode** `/wall`: full-screen, large type, no chrome, auto cycles nothing (stable), big status per node.
- Global: sidebar nav, connection indicator, time-range picker (Live/5m/1h/24h/7d), ⌘K palette, `?` shortcuts.

## Benchmarks (registry)

| id | What | Tooling | Notes |
|---|---|---|---|
| `gpu-matmul` | dense GEMM TFLOPS for BF16/FP16/FP8/FP4 (where supported) | PyTorch container (`torch.matmul`, `torch._scaled_mm`, FP4 via `torch._scaled_mm` with `float4_e2m1fn_x2` if available) | sizes 4096–16384 |
| `mem-bandwidth` | UMA bandwidth from GPU (copy/triad kernel via torch) and CPU (numpy/STREAM-style, threads per core type) | container + host python | |
| `cpu-throughput` | single- and multi-core throughput, pinned to X925 vs A725 sets | host Python + `taskset` style affinity (`os.sched_setaffinity`) | |
| `nccl-allreduce` | NCCL `all_reduce_perf` across nodes | binary if present, else built inside the PyTorch container | 2 nodes |
| `rdma-bw-lat` | `ib_write_bw` / `ib_write_lat` over the CX7 rail | perftest (installed) | 2 nodes, server/client orchestration |
| `storage-fio` | seq/rand read/write profiles | `fio` if present, else built-in O_DIRECT runner (labelled) | test file in data dir, removed after |
| `llm-inference` | TTFT, prefill tok/s, decode tok/s, memory footprint | OpenAI-compatible endpoint (vLLM/TRT-LLM/llama.cpp server), streaming | engine-agnostic |
| `thermal-soak` | 10–30 min sustained GEMM; clocks, throttling, temps over time | PyTorch container | heavy |

Each run records driver/CUDA/NVML versions, GPU name/UUID, clocks and temps at start and end, agent version, suite git hash,
hostnames, params, and timestamps. Regression = a result worse than the baseline by more than `regression_pct` (default 5%).

## Phases
(a) agent + console + streaming + demo · (b) web shell + design system · (c) live views · (d) benchmarks ·
(e) polish / a11y / perf / tests / 24 h soak. Each phase is committed separately.
