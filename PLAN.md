# Sparkline — plan

The design is grounded in [DISCOVERY.md](DISCOVERY.md).

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
               │  web (React)   │ Vite + React 19 + TS strict, uPlot, motion, zustand, wouter,
               └────────────────┘ lucide-react. Live buffers live outside React (typed arrays).
```

One Python project, `server/` (package `sparkline`), provides two entry points: `sparkline-agent` and `sparkline`.
The wire contract is `server/sparkline/common/schema.py`. The frontend mirrors it in `web/src/lib/types.ts`.

### Repository layout
```
server/  pyproject.toml, sparkline/{common,agent,console,bench}, tests/
         sparkline/agent/bench/: registry, runner, probes; sparkline/bench/payloads/: the whitelisted payload
         scripts (run on the nodes, inside the PyTorch container where a GPU is needed)
web/     Vite app (src/{app,design,charts,store,lib,views}), tests (vitest), e2e (playwright)
deploy/  install.sh, systemd/{sparkline-agent.service, sparkline.service, sparkline-agent-benchmarks.conf},
         Dockerfile (console image), docker-compose.yml, console.example.toml
```
(As built: the payloads live inside the Python package rather than a top-level `bench/`, so an installed
agent carries them. `README.md` documents installation.)

### Ports, auth, binding
- Agent `:9750`, console `:9700`.
- Config: `/etc/sparkline/{agent,console}.toml` (or `--config` / `SPARKLINE_CONFIG`). Environment overrides:
  `SPARKLINE_TOKEN`, `SPARKLINE_AGENT_TOKEN`, `SPARKLINE_BIND`, `SPARKLINE_PORT`, `SPARKLINE_DATA_DIR`.
  Precedence: flag > environment > file > default.
- **Binding:** the default `bind = "auto"` resolves to the node's private LAN IP. The server refuses to bind a public
  (non-RFC1918/CGNAT/loopback/link-local) address unless `--allow-public` is passed. `0.0.0.0` is refused unless it is explicit.
- **Auth:** the console uses `console_token`. The browser exchanges it at `/api/v1/auth/login` for an HttpOnly
  SameSite=Strict cookie. The API also accepts `Authorization: Bearer`. Agents use `agent_token`, sent by the
  console only. Tokens are compared with `hmac.compare_digest`. `install.sh` generates tokens. An agent with
  no token starts only on loopback.
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
| `GET /api/v1/settings`, `PUT /api/v1/settings` (energy rate and currency, stale/offline thresholds, regression %) | settings |
| `DELETE /api/v1/history?node=` (body `{confirm:"DELETE"}`) | clear history |
| `GET /api/v1/bench/catalog`; `GET/POST /api/v1/bench/runs`; `GET /api/v1/bench/runs/{id}`; `POST …/{id}/cancel`; `DELETE …/{id}`; `GET …/{id}/export?format=json\|csv`; `PUT /api/v1/bench/baselines/{bench_id}` `{run_id}`; `GET /api/v1/bench/compare?ids=` | benchmarks |
| `GET /healthz` (no auth) | liveness |

The agent exposes the same shapes for a single node: `GET /api/v1/info`, `GET /api/v1/snapshot`, `WS /api/v1/stream`,
`GET /api/v1/history`, `DELETE /api/v1/history`, `GET/POST /api/v1/bench/...`, and `GET /healthz`.

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
| Network | CX7 rails A/B: link state, RDMA state/rate, rx/tx throughput (netdev bytes + RDMA port counters per rail; the port-wide PHY counters would count both rails), errors/discards (port-wide PHY counters attributed once, to rail A); LAN rx/tx | — |
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
5. **Settings** `/settings`: theme (system/dark/light), reduced transparency, energy rate and currency, stale/offline
   thresholds, regression threshold, clear history per node (confirm), about/help. The sample interval is
   `interval_ms` in each node's `agent.toml`, not a UI setting.
6. **Wall mode** `/wall`: full-screen, large type, no chrome, auto cycles nothing (stable), big status per node.
- Global: sidebar nav, connection indicator, time-range picker (Live/5m/1h/24h/7d), ⌘K palette, `?` shortcuts.

## Benchmarks (registry)

| id | What | Tooling | Notes |
|---|---|---|---|
| `gpu-matmul` | dense GEMM TFLOPS for BF16/FP16/FP8/FP4 (where supported) | PyTorch container (`torch.matmul`, `torch._scaled_mm`, FP4 via `torch._scaled_mm` with `float4_e2m1fn_x2` if available) | sizes 4096–16384 |
| `mem-bandwidth` | UMA bandwidth from GPU (copy/triad via torch on device) and CPU (pinned threads per core type, torch CPU ops) | PyTorch container (both sides) | |
| `cpu-throughput` | single- and multi-core throughput, pinned to X925 vs A725 sets | host Python + `taskset` style affinity (`os.sched_setaffinity`) | |
| `nccl-allreduce` | NCCL all-reduce bandwidth sweep across nodes (algbw/busbw like nccl-tests) | `torch.distributed` (NCCL backend) in the PyTorch container, one rank per node; `all_reduce_perf` is not used because it needs an MPI launcher across nodes | 2 nodes |
| `rdma-bw-lat` | `ib_write_bw` / `ib_write_lat` over the CX7 rail | perftest (installed) | 2 nodes, server/client orchestration |
| `storage-fio` | seq/rand read/write profiles | `fio` if present, else built-in O_DIRECT runner (labelled) | test file in data dir, removed after |
| `llm-inference` | TTFT, prefill tok/s, decode tok/s, memory footprint | OpenAI-compatible endpoint (vLLM/TRT-LLM/llama.cpp server), streaming | engine-agnostic |
| `llm-showcase` | N concurrent prompt streams to watch (one request each, started together, filled to the output length); output and per-stream decode tok/s, TTFT, the server's generation tok/s from `/metrics` | host payload reusing `llm_inference`'s requests and stream slots, OpenAI-compatible endpoint | a view, not a sweep |
| `tool-eval` | tool-calling score (pass/partial/fail per multi-turn scenario with mock tools) | tool-eval-bench 2.8.0 as a library in a host payload, OpenAI-compatible endpoint | needs the server's tool-call parser |
| `thermal-soak` | 10–30 min sustained GEMM; clocks, throttling, temps over time | PyTorch container | heavy |

Each run records driver/CUDA/NVML versions, GPU name/UUID, clocks and temps at start and end, agent version, suite git hash,
hostnames, params, and timestamps. Regression = a result worse than the baseline by more than `regression_pct` (default 5%).

## Phases
(a) agent + console + streaming + demo · (b) web shell + design system · (c) live views · (d) benchmarks ·
(e) polish / a11y / perf / tests / 24 h soak. Each phase is committed separately.

## 2026-10-21: concurrency streams and tool-call eval

- **live/detail on NodeBenchState.** `live` is a bounded snapshot of what the payload is doing, replaced by each
  `{"live": …}` line; `detail` holds per-run records, and each `{"detail": …}` line replaces only its top-level
  keys. The agent drops a snapshot over 256 KiB, a detail update that would pass 1 MiB in all, values nested over
  64 levels and non-objects (logged once per job). Both are saved with the run (and its JSON export) and stripped
  from `list()`; their defaults keep older runs and agents valid (SCHEMA_VERSION stays 1).
- **Streams.** A level runs L stream slots in a closed loop (a slot sends its next request when its last one
  ends). `sweep` runs 1, 2, 4 … streams up to `concurrency`; every level runs max(`requests`, L) requests, also
  without the sweep. Snapshots every 0.25 s; `detail.llm` gets each finished level's summary and request
  timeline. On vLLM, `stream_options.continuous_usage_stats` keeps live token counts exact when one chunk holds
  several tokens (MTP, speculative decoding).
- **Baselines.** `params_key` leaves out params added after release while they hold their neutral default
  (`KEY_NEUTRAL`, so far `sweep: false`), so existing llm-inference baselines still match.
- **Clean SIGTERM.** The LLM payload stops its workers and shuts their sockets so blocked reads return, sends a
  last snapshot and exits within about a second instead of waiting for SIGKILL; tool-eval cancels its task and
  exits 143 after a last snapshot.
- **Tool-call eval.** tool-eval-bench runs as a library in a host payload (`tool_eval.py`, the agent venv's
  Python) through `api.run_benchmark(persist=False)`, with callbacks that never raise. `tool-eval-bench==2.8.0`
  comes from PyPI, hash-pinned in `requirements.lock`, and runs with upstream's defaults, so scores match its CLI
  and sparkrun. A preflight tool call fails the run when the server rejects tool calls; a run with nothing graded
  fails, and exclusions are reported as the share graded. Scores compare only within one version and config
  fingerprint (both in the score's extras).
- **Demo.** LLM runs play at 2× real time with every level 4–60 s on screen, so the streams can be watched;
  tool-eval uses upstream's scenario registry and scoring. The seeded history has a finished 32-stream sweep and
  a finished evaluation.

## 2026-10-27: tool-eval seed and trials

- **Params.** `trials` (1–10, default 1) and `seed` (a string of digits, "" for none: the params model has no
  optional int) map onto tool-eval-bench's `--trials` and `--seed`; Scenarios "All 97" was already its
  `--hardmode`. Both are in `KEY_NEUTRAL`, so earlier runs keep matching baselines; the estimate (and so the job
  timeout) scales with the trials.
- **Payload.** The trials run one after another in one task (SIGTERM still cancels at once), each the same
  `run_benchmark` request, as the CLI's loop. Statistics come from upstream: each trial's envelope is rescored
  with `score_results` (as the CLI's `_score_stored_trial`) and aggregated with `cli.run_io.aggregate_trials`;
  the envelope is the last trial's with `trial_statistics`, the safety union and `metadata.trials`, like
  `--json --trials`. A trial with nothing graded fails the run. Live: `trial`, `trials`, `seed`, `trial_scores`,
  a `history` of points per trial on each tile and record (records are replaced per trial, so they end as the
  last trial's). Summary: `trials`, `seed`, `trial_stats` (null for one trial). With several trials the
  results are means: score (the headline, with σ, CI and range in its extras), categories, deployability,
  responsiveness, median turn latency; plus `score_stddev`, `pass_at_k`, `pass_hat_k`. One trial reports
  exactly as before.

## 2026-10-27: LLM showcase

- **Why.** `llm-inference` (synthetic "summarise this text" prompts, closed-loop rounds, EOS allowed, rates over
  a window) is a measurement; watched on a real server its streams start staggered, end apart and show jumpy
  tok/s. `llm-showcase` is the view for watching, modelled on sparkDash's Prompt Showcase (no code or prompts
  taken from it); `llm-inference` is unchanged apart from an optional `extra` dict on `one_request`.
- **Payload.** `llm_showcase.py` imports `llm_inference`'s request, `Slot` and SIGTERM handling. N threads wait
  on one event, then each sends one request: our own short prompts (8 prose, 8 structural, mixed alternates),
  `temperature`, `chat_template_kwargs` `enable_thinking`/`thinking`, and with `fill_to_max` a keep-going
  sentence plus `ignore_eos`, `min_tokens` = `max_tokens`, `stop: []`; an HTTP 400 resends that stream once
  without the three fields (logged once). /metrics is polled every 0.4 s for the generation counter's rate;
  without it polling stops and `server_tok_s` stays null.
- **Live and detail.** The snapshot is `llm-streams` v1 with one level of N, so the web's parser takes it as is,
  plus `showcase: true`, `server_tok_s` and a per-stream `label`. A stream's `tok_s` is cumulative (tokens since
  the first over the time to the latest token, from 0.5 s on); the top `tok_s` sums the decoding streams.
  `detail.showcase` holds every stream's prompt and whole answer and reasoning (each at most `max_tokens` × 16
  characters, the whole under 900,000 bytes by cutting the longest texts first), the /metrics summary and
  whether fill was applied; it is also sent on cancel, with unfinished streams "stopped".
- **Results.** Output tok/s over all streams, median per-stream decode tok/s and TTFT p50 (headlines), and the
  median server generation tok/s when /metrics answered. Every stream failing fails the run.
- **Demo.** Planned streams at LlmDemo's GB10 rates, played at 2× real time (4–60 s), cancel included; the
  seeded history has a finished 8-stream mixed run.
