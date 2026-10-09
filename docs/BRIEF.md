> Historical record: the brief Sparkline was built from. For using Sparkline, see the [README](../README.md).

# Project: "Sparkline" — live telemetry & benchmarking dashboard for my NVIDIA DGX Spark cluster

> Original brief from the owner (verbatim, except the product was renamed from "Spark Console" to "Sparkline" at the owner's request). Setup placeholders resolved in DISCOVERY.md: 2× DGX Spark
> (spark1, spark2), ConnectX-7 direct links (two 200G rails), viewed from a LAN browser, workloads = custom
> PyTorch/EXL3 inference servers, vLLM, fine-tuning. The owner said: "get it all done fully, no waiting for my decisions."

## Your role
You are a senior product engineer and designer with Apple Human Interface Guidelines-level taste. Build a production-quality, self-hosted web dashboard that monitors my DGX Spark cluster with live telemetry and includes a benchmarking suite. The bar: someone opening it for the first time should be impressed by how calm, precise and alive it feels. Every state (loading, empty, error, stale, offline) is designed, not defaulted.

## Architecture
- **Node agent** (one per Spark): lightweight Python (FastAPI + pynvml/DCGM bindings + psutil) or Go. Samples at 1 Hz by default (configurable 250 ms–5 s), keeps a ring buffer of recent history in memory, and persists downsampled history to SQLite (or DuckDB) for 7–30 days. Must use under 1% CPU and minimal memory. Runs as a systemd service.
- **Aggregator/API**: merges all nodes, exposes REST for history and WebSocket (or SSE) for live streams. Handles node disconnects without crashing and marks data as stale rather than silently freezing.
- **Frontend**: React + TypeScript + Vite. Charts with uPlot (or a canvas-based equivalent) for high-frequency series; never re-render the whole page per tick. Motion via Framer Motion / Motion with spring physics. Zustand or similar for state.
- **Security**: bind to LAN only, simple token or passkey auth, no endpoint that executes arbitrary shell input. Benchmarks are whitelisted, parameter-validated jobs.
- One-command setup: `./install.sh` per node plus a `docker compose` or systemd option for the aggregator. Clear README.

## Telemetry to show (only what discovery confirms is available)
- **Cluster overview**: health of each node at a glance, total cluster compute utilisation, power draw, aggregate memory pressure, active jobs/processes.
- **GPU (GB10 Blackwell)**: utilisation, SM clocks, power vs limit, temperature, throttle reasons (decoded into plain English), per-process GPU usage.
- **Unified memory**: total/used/available system memory treated as the primary memory story (since CPU and GPU share it), with a clear breakdown of what is consuming it.
- **CPU (Grace ARM cores)**: per-core utilisation as a heatmap distinguishing performance vs efficiency cores, frequency, load averages.
- **Interconnect & network**: ConnectX-7 link status, throughput both directions, errors/drops; LAN throughput.
- **Storage**: NVMe read/write throughput, IOPS, capacity, temperature.
- **Thermals & power**: per-sensor temps, fan state if exposed, power over time with energy totals (kWh, and optional cost at a configurable £/kWh rate).
- **Processes**: sortable table of top consumers (GPU, memory, CPU), with container/model names where detectable.
- **Alerts**: configurable thresholds (temp, throttling, memory pressure, node offline) with an in-app timeline of events.

## Benchmarking suite
Each benchmark has: description, estimated duration, expected thermal/power impact, a confirmation step before running, live progress with telemetry overlaid during the run, cancellation that cleans up properly, and results saved with full metadata (driver/CUDA versions, clocks, temps, timestamp, git hash of the suite).
- **Compute**: dense matmul throughput across BF16/FP16/FP8 and FP4 where supported, reported as achieved TFLOPS.
- **Memory bandwidth**: unified-memory bandwidth from both CPU and GPU sides.
- **CPU**: multi-core and single-core throughput, separated by core type.
- **Interconnect**: NCCL `all_reduce_perf` across nodes and RDMA bandwidth/latency over the ConnectX-7 link (if perftest is available).
- **Storage**: fio sequential/random read/write profiles.
- **LLM inference**: tokens/sec (prefill and decode), time-to-first-token and memory footprint for a configurable model on whichever engine is installed; single node and cross-node if supported.
- **Sustained load / thermal soak**: 10–30 min run graphing clock stability, throttling and temperature.
- **Results**: history, side-by-side comparison of runs, regression detection (flag if a result drops >X% from baseline), export to JSON/CSV, and a shareable summary card.

## Design language: Apple HIG, executed on the web
- **Typography**: system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif`); tabular figures for every live number so digits don't jitter; a clear type scale (large title → title → headline → body → caption) used consistently.
- **Materials**: translucent layered surfaces with `backdrop-filter` blur and subtle vibrancy, hairline separators, generous continuous-corner radii. Dark mode first and flawless; light mode equally considered; follow system preference with a manual override.
- **Colour**: restrained neutral base, one accent colour, semantic colours (green/yellow/red) reserved strictly for status. Respect contrast ratios in both themes.
- **Iconography**: a clean consistent icon set (e.g. Lucide or custom SVG). Do not use Apple's SF Symbols, logos or trademarks, as they're not licensed for this use.
- **Layout**: clear visual hierarchy. The single most important question ("is my cluster healthy and what is it doing?") is answered within one second of looking. Progressive disclosure: overview → node → subsystem → raw detail. Responsive from laptop to large display, plus a dedicated full-screen "wall mode".
- **Motion**: spring-based, short and purposeful (150–400 ms). Numbers interpolate smoothly between values; charts scroll continuously rather than jumping; panels transition with shared-element continuity. Nothing moves without reason. Fully honour `prefers-reduced-motion`.
- **Delight, used with restraint**: e.g. a living cluster visual where each node subtly "breathes" with load, a satisfying benchmark completion moment, sparklines that feel tactile on hover. Delight must never cost clarity or performance.

## States: every one designed
- **Loading**: skeletons that match the final layout exactly (no layout shift), shimmer respecting reduced motion, and progressive rendering: show whatever data has arrived.
- **Empty**: helpful copy and a next action (e.g. "No benchmark runs yet. Run your first baseline").
- **Stale data**: if a stream stalls, values dim and show "last updated Xs ago" rather than displaying frozen numbers as if live.
- **Errors**: human-readable message, likely cause, and a concrete fix (e.g. "Agent unreachable on spark-02. Check `systemctl status sparkline-agent`"), plus retry. Automatic reconnection with exponential backoff and a visible connection indicator. One failing node or metric never breaks the rest of the dashboard. Error boundaries around every panel.
- **Unsupported metrics**: shown as "not reported by this hardware" with an info tooltip, never as 0 or a broken chart.

## Interaction quality
- Instant feedback on every input (under 100 ms). Optimistic UI where safe.
- Command palette (⌘K / Ctrl+K) for jumping to nodes, metrics, benchmarks and actions.
- Keyboard shortcuts for main views, discoverable via `?`.
- Chart interactions: hover crosshair synced across all charts on screen, drag to zoom a time range, double-click to reset, time-range picker (live, 5 m, 1 h, 24 h, 7 d).
- Destructive or heavy actions (benchmarks, clearing history) require clear confirmation with consequences stated.
- Remember user preferences (theme, layout, time range) locally.

## Accessibility (non-negotiable)
- WCAG 2.2 AA: contrast, focus visibility, full keyboard operability, logical tab order.
- Semantic HTML and ARIA where needed; charts have text summaries and an accessible data-table alternative.
- Status is never conveyed by colour alone (icons + labels too).
- Live regions announce alerts politely without spamming screen readers on every tick.
- Respects reduced motion, reduced transparency and user font scaling.

## Performance budgets
- 60 fps during live updates on a mid-range laptop; no long tasks over 50 ms during streaming.
- Initial load under 2 s on LAN; JS bundle kept lean with code-splitting for the benchmark suite.
- Frontend memory stable over a 24-hour session (bounded buffers, no leaks). Test this.

## Quality gates before you call it done
- TypeScript strict, ESLint clean, unit tests for metric parsing/throttle decoding, integration tests for agent disconnect/reconnect, Playwright tests for key flows, axe accessibility checks passing.
- A mock data mode (`--demo`) that simulates realistic telemetry, including failures and stale nodes, so the UI can be developed and demoed without hardware.
- Final self-review: go screen by screen and list anything that feels generic, clunky, misaligned or unexplained, then fix it. Report what you changed and any known limitations.
