# Sparkline

[![CI](https://github.com/sfxnz/sparkline/actions/workflows/ci.yml/badge.svg)](https://github.com/sfxnz/sparkline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sparkline is a self-hosted dashboard for a small NVIDIA DGX Spark cluster. A lightweight agent on each
Spark samples the GPU, unified memory, CPU cores, ConnectX-7 links, NVMe and thermals once a second. A
console merges the nodes, keeps an alert timeline, runs whitelisted benchmarks and serves a web app that
answers one question at a glance: is the cluster healthy, and what is it doing? Sparkline shows only what
the hardware actually reports. Anything GB10 doesn't expose is labelled "not reported by this hardware",
never shown as zero.

![Cluster overview, dark theme](docs/screenshots/overview-dark.png)

## Try it in one minute, no Spark needed

The demo runs three simulated nodes on any x86_64 or arm64 machine with Docker:

```sh
docker run --rm -p 127.0.0.1:9701:9700 ghcr.io/sfxnz/sparkline --demo
```

Open http://127.0.0.1:9701. There is no sign-in. The first minute is calm. Over the next two minutes,
spark1 has a thermal episode, spark2's stream stalls, and spark3 goes offline and comes back. Stop it with
Ctrl+C. The log's `Uvicorn running on http://172.17.0.x:9700` is the
container's own address, so use the port you published.

To build the image yourself instead:

```sh
git clone https://github.com/sfxnz/sparkline.git && cd sparkline
docker build -f deploy/Dockerfile -t sparkline .
docker run --rm -p 127.0.0.1:9701:9700 sparkline --demo
```

Without Docker, follow the "Demo" section of [DEV.md](DEV.md). It runs the same demo from a Python venv and
a web build.

## How it fits together

- **Agent** (`sparkline-agent`, port 9750). One per DGX Spark, running on the host under systemd. It samples
  the hardware, keeps 30 days of history in SQLite and runs benchmarks, but only if you enable them.
- **Console** (`sparkline`, port 9700). One per cluster, running on one of the Sparks or on any Linux box on
  the same LAN. It merges the agents, keeps alerts and benchmark results, and serves the web app. Browsers
  talk only to the console.

The console reaches each agent with a shared agent token. You sign in to the console with a separate
console token. The [Architecture](#architecture) section has the diagram.

## Requirements

| For | You need |
|---|---|
| Each node | A DGX Spark (GB10) on DGX OS or Ubuntu 24.04, with systemd and sudo. Python 3.12 or newer with `python3-venv` (or `uv` on root's PATH, since the installer runs under sudo). Internet access to PyPI at install time: dependencies are installed hash-pinned from `server/requirements.lock` |
| The console | The same as a node (any Linux box with systemd works), plus Node.js 22.12 or newer to build the web app once. Or only Docker with Compose: the image builds everything itself |
| Two nodes, one command | SSH key login from the first node to the second, `rsync`, and Docker on both nodes unless you pass `--no-benchmarks` |
| Benchmarks (optional) | Docker, the NVIDIA Container Toolkit and `docker pull nvcr.io/nvidia/pytorch:26.07-py3` on each node for the GPU benchmarks. `sudo apt install perftest fio` for the RDMA benchmark and fio storage numbers |

Other Linux machines, with or without an NVIDIA GPU, run the agent too, but Sparkline is built and tested for GB10. See
[Limitations](#limitations).

## Ports

| Port | From → to | Used for |
|---|---|---|
| 9700/tcp | browser → console | The web app and its API |
| 9750/tcp | console → each agent | Telemetry and benchmark control |
| 29620/tcp | node ↔ node | The NCCL all-reduce benchmark only |
| 18515/tcp | node ↔ node | The RDMA benchmark only |

Both services listen only on a private LAN address and refuse 0.0.0.0 and public IPs. There is no built-in
TLS: to reach the console from elsewhere, use Tailscale or a reverse proxy (see [Security model](#security-model)).
The installers don't change your firewall. If you firewall traffic between the nodes, note that the NCCL
benchmark also opens ephemeral TCP ports between the ConnectX-7 rail addresses, so allow all TCP between them.

## Install on your Sparks

Clone the repo and build the web app once, on the node that will run the console:

```sh
git clone https://github.com/sfxnz/sparkline.git && cd sparkline
(cd web && npm ci && npm run build)
```

**Two Sparks, one command.** Run this on the first node, as your normal user. It calls sudo itself, and
asks for your password on each node.

```sh
./deploy/install-cluster.sh --peer <ssh-host-of-the-second-node> --dry-run   # preview (copies the installer to the peer)
./deploy/install-cluster.sh --peer <ssh-host-of-the-second-node>
```

It installs `sparkline-agent` on both nodes with one shared agent token, and fills in the ConnectX-7 `peers`
from each node's RDMA interfaces. It then installs the console on the first node and prints its URL
(`http://<LAN IP>:9700`) and the sign-in token. `--peer` defaults to `spark2`. Benchmarks are enabled by
default, so both nodes need Docker (DGX OS ships it). Add `--no-benchmarks` for monitor-only agents.

**One Spark.**

```sh
sudo ./install.sh agent                       # add --enable-benchmarks to allow benchmarks
sudo ./install.sh console --nodes "$(hostname -s)=<the Agent URL printed by the line above>"
```

The console picks up the agent token from the agent's config on the same host.

**Then** open the URL the installer printed and type the console token. If you lose it, run
`sudo grep ^token /etc/sparkline/console.toml`.

> **What the installer changes.** It creates the system user `sparkline`, the code and venv in
> `/opt/sparkline`, config in `/etc/sparkline/*.toml` (mode 0640), history in `/var/lib/sparkline*`, and
> sandboxed systemd units. With benchmarks enabled, the agent joins the **docker group, which is
> root-equivalent**. Every installer takes `--dry-run`. `sudo ./install.sh uninstall --purge` removes
> everything from the node it runs on. Run it on each node; on a second node set up by `install-cluster.sh`,
> also delete `~/.cache/sparkline-install`. The sections below cover each step, Docker Compose, Tailscale and the security model.

## Screenshots

| | |
|---|---|
| ![Overview, light theme](docs/screenshots/overview-light.png) | ![GPU tab during a thermal episode: clock limits decoded into plain English](docs/screenshots/node-gpu-dark.png) |
| ![Unified memory breakdown on spark1, light theme](docs/screenshots/node-memory-light.png) | ![Per-core heatmap of spark1's performance and efficiency cores](docs/screenshots/node-cpu-dark.png) |
| ![ConnectX-7 rails on spark1](docs/screenshots/network-dark.png) | ![Alerts: open alerts and the event timeline](docs/screenshots/alerts-dark.png) |
| ![A GPU matmul benchmark running, with live telemetry](docs/screenshots/bench-run-dark.png) | ![Two benchmark runs side by side, light theme](docs/screenshots/bench-compare-light.png) |
| ![An LLM inference sweep at 8 concurrent streams: every stream's text, state and tokens/s, live](docs/screenshots/bench-streams-dark.png) | ![A finished concurrency sweep from 1 to 32 streams: output, decode speed and time to first token per level, light theme](docs/screenshots/bench-sweep-light.png) |
| ![A tool-calling evaluation running: the score so far, the scenario board and the latest verdicts](docs/screenshots/bench-tool-eval-dark.png) | ![A finished tool-calling evaluation: score, rating, safety gate and share graded, light theme](docs/screenshots/bench-tool-eval-score-light.png) |
| ![A node whose agent is unreachable: cause, fix and retry](docs/screenshots/offline-state-dark.png) | ![Wall mode at 1920×1080](docs/screenshots/wall-dark.png) |

The memory, CPU, network and offline screenshots come from a real two-node cluster (taken while spark2's agent
was stopped). The others come from `--demo`, which can show load, a thermal episode and benchmark runs on demand.
The concurrency-stream and tool-calling screenshots show its simulated runs: no model was involved.

## Features

- **Cluster overview.** Health of every node in one sentence, living node cards, total GPU utilisation, GPU
  power and today's energy, aggregate memory pressure, ConnectX-7 throughput between the nodes, recent events.
- **Node detail.** Tabs for GPU, unified memory, CPU, network, storage, thermals and power, and processes.
  Charts share a crosshair, support drag to zoom and double-click to reset, and have a time-range picker
  (Live, 5 m, 1 h, 24 h, 7 d). Every chart also has a text summary and a data-table view.
- **GPU (GB10).** Utilisation, SM and graphics clocks against their maximum, temperature against the
  slowdown and shutdown thresholds, power, energy, P-state, throttle reasons in plain English, the share of
  time spent power or thermal capped, and GPU memory per process.
- **Unified memory.** The headline memory story, because the CPU and GPU share it: used, available,
  GPU-allocated, process memory, page cache, shared, kernel, swap and PSI pressure.
- **CPU.** A per-core heatmap with the 10 Cortex-X925 performance cores and the 10 Cortex-A725 efficiency
  cores grouped apart, per-core frequency, and load averages.
- **Interconnect.** Link and RDMA state, rate, throughput both ways (including RDMA traffic, which bypasses
  the normal interface counters), and errors and drops for both ConnectX-7 rails, plus LAN throughput.
- **Alerts.** Editable thresholds (GPU temperature, throttling, memory, node offline, link down, disk full,
  NVMe temperature) and an event timeline with acknowledgement.
- **Benchmarks.** Nine whitelisted, parameter-validated jobs, from GEMM TFLOPS to a 30-minute thermal soak
  and a tool-calling evaluation of your served model. Each one states its duration and impact up front, asks
  for confirmation, shows live telemetry while it runs, cancels cleanly, and saves results with full
  metadata. The LLM benchmark shows every concurrent stream as it generates and can sweep concurrency levels;
  the tool-calling evaluation shows each scenario's verdict as it finishes. Baselines, regression flags,
  side-by-side comparison, JSON/CSV export and a shareable summary card are included.
- **Wall mode, command palette and keyboard shortcuts.** Dark and light themes that follow the system, with
  reduced-motion and reduced-transparency support.
- **Demo mode** (`--demo`): three simulated nodes, including a thermal episode, a stalled stream and a node
  that goes offline and comes back. No hardware or token needed.


## Install on the nodes (agent)

Run this on every DGX Spark. You need sudo, Python 3.12 or newer with `python3-venv` (or `uv` on root's PATH), and internet
access to PyPI for the Python dependencies.

```sh
git clone https://github.com/sfxnz/sparkline.git && cd sparkline
sudo ./install.sh agent                       # monitor-only
sudo ./install.sh agent --enable-benchmarks   # also allow benchmarks (see Security model)
```

The installer:

1. Checks the OS, architecture, Python version and NVIDIA driver. A missing driver is only a warning.
2. Creates the system user `sparkline`. It adds device groups only when `/dev/nvidia*` or the RDMA devices
   are not world-accessible (on DGX OS they are, so usually none).
3. Copies the code to `/opt/sparkline` and installs it into `/opt/sparkline/venv`.
4. Writes `/etc/sparkline/agent.toml` (mode 0640, root:sparkline) with a freshly generated token, but only if
   the file doesn't exist yet. It never overwrites config.
5. Creates `/var/lib/sparkline-agent` (0750) for history.
6. Installs, enables and starts `sparkline-agent.service`, then prints the agent's URL and token. The token
   is printed only on an interactive terminal; when the output goes to a file or a pipe, the installer prints
   where to read it (`sudo grep ^token /etc/sparkline/agent.toml`) instead.

All nodes and the console must share **one agent token**. Install the first node, then pass its token to the
others. To keep the token out of the process list, use the environment:

```sh
read -rs SPARKLINE_AGENT_TOKEN && export SPARKLINE_AGENT_TOKEN       # paste the token from the first node
sudo --preserve-env=SPARKLINE_AGENT_TOKEN ./install.sh agent
```

Re-running the installer is safe. It refreshes the code and units and restarts the service, and keeps the
config and data. The flags describe the state you want: running it again without `--enable-benchmarks`
turns benchmarks back off.

| Option | Meaning |
|---|---|
| `--enable-benchmarks` | Allow benchmarks: Docker access for the agent and lifted CPU/memory caps. Asks for confirmation. |
| `--nodes LIST` | Console: the agents to poll, as `id=url` pairs, e.g. `spark1=http://192.168.1.11:9750,spark2=http://192.168.1.12:9750`. |
| `--peers LIST` | Agent: the far ends of the ConnectX-7 rails as `id=ip` pairs, e.g. `spark2=10.100.8.2,spark2=10.100.9.2`. Written to `peers` in a new config. |
| `--agent-token TOKEN` | Use this token instead of generating one (or set `SPARKLINE_AGENT_TOKEN`). |
| `--bind ADDR`, `--port N` | Written into a new config. Defaults are `auto` and 9750 (agent) or 9700 (console). |
| `--prefix DIR` | Code and venv location (default `/opt/sparkline`). |
| `--dry-run` | Print every action and change nothing. Works without root. |
| `--destdir DIR` | Lay the files out under DIR, without users, ownership or systemd. For testing; works without root. |
| `-y`, `--yes` | Don't ask for confirmation. |

## Install the console

The console can run on one of the Sparks (spark1, say) or on any Linux box on the same LAN.

### With systemd

```sh
(cd web && npm ci && npm run build)    # the installer tries this itself if web/dist is missing
sudo ./install.sh console --nodes spark1=http://192.168.1.11:9750,spark2=http://192.168.1.12:9750
```

The console's `agent_token` comes from `--agent-token` or `SPARKLINE_AGENT_TOKEN`. If neither is set and an
agent is installed on the same host, it is read from `/etc/sparkline/agent.toml`. Otherwise a new one is
generated, and the installer tells you to put it in each node's `agent.toml`. The installer prints the URL
to open and the console token you type on the sign-in screen.

### With Docker Compose

```sh
sudo install -d -m 0755 /etc/sparkline
sudo install -m 0640 -g 10001 deploy/console.example.toml /etc/sparkline/console.toml
sudoedit /etc/sparkline/console.toml           # tokens and [[nodes]]
docker compose -f deploy/docker-compose.yml up -d --build
```

The container runs as uid/gid 10001 with a read-only root filesystem, no capabilities and
`no-new-privileges`. It uses host networking, so `bind = "auto"` resolves to the host's LAN address just as
it does under systemd. Data lives in the `sparkline-data` volume. Tokens can come from `SPARKLINE_TOKEN` and
`SPARKLINE_AGENT_TOKEN` (exported, or in `deploy/.env` with mode 600) instead of the file.

### Open it over Tailscale

The console binds only to the LAN address. To reach it from other devices on your tailnet, let tailscaled
proxy a tailnet port to it. This needs no change to Sparkline and no root if your user is a Tailscale operator:

```sh
tailscale serve --bg --http=9700 http://192.168.1.11:9700   # the console's LAN address; persists across reboots
```

Then open `http://spark1.<your-tailnet>.ts.net:9700` (or `http://spark1:9700` with MagicDNS). Use the name,
not the 100.x address: `tailscale serve` routes by hostname. Tailscale forwards the Host header, so the
console's Origin check passes. Tailnet traffic is already encrypted by WireGuard. Remove the proxy with
`tailscale serve --http=9700 off`.

### Uninstall

```sh
sudo ./install.sh uninstall           # stops and removes the services and /opt/sparkline
sudo ./install.sh uninstall --purge   # also deletes /etc/sparkline, all history and results, and the user
```

## Configuration

Config files are TOML. The agent reads `/etc/sparkline/agent.toml` and the console reads
`/etc/sparkline/console.toml`, unless `--config` or `SPARKLINE_CONFIG` names another file. Precedence is:
command-line flag, then `SPARKLINE_*` environment variable, then the file, then the built-in default.
Restart the service after editing: `sudo systemctl restart sparkline-agent` (or `sparkline`). Unknown keys in
`agent.toml` are rejected at start-up, so typos don't pass silently.

### agent.toml

| Key | Default | Meaning |
|---|---|---|
| `node_id` | short hostname | The node's own name (benchmark labels, logs). The console displays its `[[nodes]]` id, so keep the two the same. |
| `bind` | `"auto"` | IP to listen on. `auto` is the IPv4 address of the default-route interface. See [Security model](#security-model). |
| `port` | `9750` | |
| `token` | `""` | Shared agent token, at least 16 characters. Required unless `bind` is loopback. |
| `interval_ms` | `1000` | Sample interval, 250 to 5000 ms. |
| `data_dir` | `/var/lib/sparkline-agent` if writable, else `~/.local/share/sparkline-agent` | SQLite history. |
| `ring_seconds` | `900` | In-memory recent history at full resolution. |
| `retention_10s_days` | `7` | Days of 10-second rollups. |
| `retention_60s_days` | `30` | Days of 1-minute rollups. |
| `procs_interval_s` | `5` | Process table refresh. It is the most expensive collector. |
| `peers` | `{}` | Far ends of the ConnectX-7 rails, so the link can be named. Example: `{ spark2 = ["10.100.8.2", "10.100.9.2"] }` |
| `include_virtual` | `false` | Also show virtual and Wi-Fi interfaces (docker0, tailscale0, ...). |
| `allow_public` | `false` | Allow binding a public address or 0.0.0.0. Avoid. |
| `bench_image` | `nvcr.io/nvidia/pytorch:26.07-py3` | Container image for GPU benchmarks. It must already be pulled. |
| `bench_work_dir` | `<data_dir>/bench-work` | Scratch for benchmark files. Keep it on the NVMe drive. Outside the data dir, it also needs a `ReadWritePaths=` drop-in. |
| `bench_payload_device` | `"cuda"` | `"cpu"` runs the GPU payloads on the CPU at tiny sizes: a code-path smoke test whose results are flagged and never compared. |

Agent flags: `--config`, `--bind`, `--port`, `--interval-ms`, `--data-dir`, `--token`, `--node-id`,
`--allow-public`, `--log-level`. Prefer the config file or the environment to `--token`, because the
process list shows command-line arguments to every user.

### console.toml

| Key | Default | Meaning |
|---|---|---|
| `bind` | `"auto"` | As for the agent. |
| `port` | `9700` | |
| `token` | `""` | What you type on the sign-in screen, at least 16 characters. Required except in `--demo` (and with no token, the demo has no sign-in). Changing it and restarting signs every browser out. |
| `agent_token` | `""` | Must equal `token` in every node's `agent.toml` (at least 16 characters). |
| `data_dir` | `/var/lib/sparkline` if writable, else `~/.local/share/sparkline` | `console.sqlite`: events, settings, benchmark results, sessions. `--demo` uses a `demo/` subdirectory, so simulated data never mixes with real data. |
| `web_dist` | `<repo>/web/dist` | The built web app. The installer sets `/opt/sparkline/web/dist`. |
| `[[nodes]]` | none | One table per agent: `id = "spark1"`, `url = "http://192.168.1.11:9750"`. |
| `[settings]` | see below | Initial values. Once you save in the app (Settings), the saved values in `console.sqlite` win. |
| `trusted_proxies` | `[]` | IPs or networks of reverse proxies whose `X-Forwarded-For` / `X-Forwarded-Proto` headers are believed, e.g. `["127.0.0.1"]` for a proxy on the same host. See [Security model](#security-model). |

`[settings]` keys: `energy_rate_per_kwh` (0.28), `currency` ("£"), `stale_after_s` (5.0: a node with no
sample for this long is shown as stale), `offline_after_s` (30.0) and `regression_pct` (5.0: a benchmark
result worse than its baseline by more than this is flagged).

Console flags: `--config`, `--bind`, `--port`, `--data-dir`, `--web-dist`, `--allow-public`, `--log-level`,
`--demo`, `--demo-speed` (compress the demo's failure schedule) and `--demo-empty-bench` (demo without seeded
benchmark history).

### Environment variables

| Variable | Agent | Console |
|---|---|---|
| `SPARKLINE_CONFIG` | config file path | config file path |
| `SPARKLINE_AGENT_TOKEN` | `token` | `agent_token` |
| `SPARKLINE_TOKEN` | `token`, if `SPARKLINE_AGENT_TOKEN` is unset | `token` |
| `SPARKLINE_BIND` | `bind` | `bind` |
| `SPARKLINE_PORT` | `port` | `port` |
| `SPARKLINE_DATA_DIR` | `data_dir` | `data_dir` |

Empty values count as unset. `install.sh` also reads `SPARKLINE_AGENT_TOKEN`.

## Security model

Sparkline is built for a trusted LAN. It has no TLS of its own.

- **LAN-only binding.** `bind = "auto"` picks the private address of the default-route interface. Both
  services refuse to listen on 0.0.0.0, `::` or any public address unless you pass `--allow-public` (or set
  `allow_public` for the agent). Private means RFC 1918, 100.64.0.0/10 (CGNAT, which includes Tailscale),
  loopback, link-local and IPv6 ULA.
- **Tokens.** The browser signs in with the console token and receives an HttpOnly, SameSite=Strict session
  cookie, valid for 30 days (Secure when served over HTTPS). Scripts can send `Authorization: Bearer <token>`
  instead. The console talks to agents with the separate agent token; browsers never see it. Tokens are
  compared in constant time and must be at least 16 characters. Sign-in attempts and wrong bearer tokens
  are limited to 10 per minute per client IP, on the console and on each agent. State-changing requests
  whose `Origin` doesn't match the console are rejected. Sessions belong to the token that issued them:
  change `token` and restart the console, and every existing session is signed out.
- **Browser hardening.** Every console response carries a Content-Security-Policy (scripts, styles,
  connections and images from the console only; no framing), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.
- **Secrets stay out of samples and logs.** The agent masks secret-looking command-line arguments before a
  process leaves the node (`--api-key`, `--hf-token`, `--password`, `--secret…`, `NAME_TOKEN=`/`NAME_KEY=`,
  `sk-…` and `hf_…` keys, URL passwords all become `***`). Both services mask `Authorization` and `Cookie`
  header values in their logs, even at `--log-level debug`. The LLM benchmark never copies an endpoint's
  response body into a run error (only an OpenAI-style error message). It and the tool-calling evaluation
  refuse SSH, Docker API and Sparkline ports as endpoints.
- **Model output is stored with the run.** For its stream view, the LLM benchmark keeps the last 280
  characters of each stream's answer and 160 of its reasoning, and a timeline of its requests (times and token
  counts). The tool-calling evaluation keeps each scenario's trace (prompts, tool calls and the model's
  replies, cut to 4,000 characters) and its result in tool-eval-bench's own format. The traces are
  tool-eval-bench's logs: they, its scenario summaries and its lines in the run's log can include up to about
  200 characters of an error response from your server, stored like the rest of the trace. All of it is saved
  with the run in `console.sqlite`, included in its JSON export and visible to anyone signed in to the
  console. The web app shows it as plain text, never as HTML or Markdown. tool-eval-bench's tools are mocks:
  nothing the model asks for is executed.
- **An agent without a token** starts only on a loopback address, and then answers only local, non-browser
  requests.
- **No shell execution.** No endpoint runs commands. Benchmarks are a fixed registry, and every parameter is
  validated (enums, bounded numbers, pattern-checked strings, LAN-only endpoint URLs). Commands are built
  as argument lists, never through a shell. Each job runs in its own process group. Cancelling it sends
  SIGTERM, then SIGKILL after 5 s, removes its container and deletes its scratch files.
- **The docker group is root-equivalent.** GPU benchmarks start containers through the Docker socket, so
  `--enable-benchmarks` adds the agent to the `docker` group. Its unit gets a drop-in,
  `/etc/systemd/system/sparkline-agent.service.d/10-benchmarks.conf`. Anyone who controls a process in the
  docker group can control the host. Enable benchmarks only on machines where that trade-off is acceptable.
  Without the flag the agent is monitor-only: GPU benchmarks report Docker as unavailable, the host-side
  benchmarks (CPU, storage, RDMA, LLM inference, tool-calling evaluation) report the agent as CPU-capped, and
  container names in the process table fall back to short container ids.
- **systemd sandboxing.** Both services run as the unprivileged `sparkline` user, with no capabilities,
  `NoNewPrivileges`, a read-only filesystem except their state directory (`ProtectSystem=strict`), a private
  /tmp, a system-call filter, and network access limited to IPv4, IPv6, Unix and netlink sockets. The agent
  keeps device access for NVML and RDMA, and keeps full process visibility for the process table. The
  console has neither. The unit files explain each setting; run `systemd-analyze security sparkline-agent`
  to see the result.
- **Over the internet**, put the console behind a TLS reverse proxy or a VPN (Tailscale addresses count as
  private). Don't use `--allow-public`. Behind a proxy, set `trusted_proxies` to the proxy's address, so the
  session cookie is marked Secure and sign-in limits count each real client rather than the proxy. The proxy
  must pass the original `Host` header (the Origin check compares against it), set `X-Forwarded-For` and
  `X-Forwarded-Proto`, and forward WebSocket upgrades for `/api/v1/stream`. nginx: `proxy_set_header Host
  $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto
  $scheme; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection
  "upgrade";`. Caddy's `reverse_proxy` does all of this by default.

## What is measured, and what GB10 doesn't report

Everything shown was confirmed on the hardware: see [DISCOVERY.md](DISCOVERY.md) for the probe results and
where each value comes from (NVML, `/proc`, sysfs, ethtool, hwmon). The UI labels these as not reported by
this hardware:

- GPU power limit (so power is shown against its observed peak), memory clock, framebuffer memory, ECC, PCIe
  throughput and fan speed. NVML returns "Not Supported" for each on GB10.
- Per-core CPU temperature (there is no such sensor) and fans (none are exposed).
- Whole-system power. The only power sensor is the GPU rail, labelled "GPU power", and energy and cost are
  computed from it.

On ConnectX-7, inter-node traffic is RDMA and bypasses the kernel interface counters. Each rail's throughput
is therefore its netdev bytes plus its RDMA port counters (`port_rcv_data` / `port_xmit_data`).

## Benchmarks

Benchmarks run only when you confirm them in the console. One job runs per node at a time.

| Benchmark | What it measures | Default duration | Impact | Needs |
|---|---|---|---|---|
| GPU matmul (`gpu-matmul`) | Dense GEMM TFLOPS for BF16, FP16, FP8 and FP4 (NVFP4 on GB10; reported as unsupported elsewhere) | about 20 s | High: saturates the GPU | Docker + PyTorch image |
| Unified memory bandwidth (`mem-bandwidth`) | Copy/triad GB/s from the GPU and from the CPU (all, performance and efficiency cores) | about 10 s | Medium: slows running inference | Docker + PyTorch image |
| CPU throughput (`cpu-throughput`) | Single- and multi-core MB/s, per core type | about 25 s | Medium CPU, GPU barely affected | nothing extra |
| NCCL all-reduce (`nccl-allreduce`) | All-reduce bus bandwidth between the two nodes over the CX7 rails | about 10 s | Medium: stalls a TP=2 job | Docker + PyTorch image, 2 nodes |
| RDMA bandwidth and latency (`rdma-bw-lat`) | `ib_write_bw` / `ib_write_lat` over one CX7 rail | about 10 s | Low: saturates that rail | `perftest`, 2 nodes |
| NVMe storage (`storage-fio`) | Sequential 1 MiB and random 4 KiB read/write: MB/s, IOPS, p99 latency | about 35 s | Low, but heavy disk I/O | `fio` (optional) |
| LLM inference (`llm-inference`) | TTFT, prefill and decode tokens/s, memory footprint, with a live view of every concurrent stream and an optional sweep over concurrency levels | seconds to minutes, depending on the model | Medium: real requests to your server | An OpenAI-compatible endpoint on the LAN |
| LLM showcase (`llm-showcase`) | A view to watch rather than a measurement: up to 32 short real prompts (prose, structured output or both) streamed at once, one request each, all started together and by default all writing the full output length, so they decode side by side and end together; each stream's text and tokens/s live next to the server's own generation rate from `/metrics`, and the full answers kept with the run | under a minute at the defaults (4 streams, 512 tokens), depending on the model | Medium: real requests to your server | An OpenAI-compatible endpoint on the LAN |
| Tool-call eval (`tool-eval`) | How well the served model uses tools: tool-eval-bench's multi-turn scenarios with mock tools, graded pass, partial or fail into a 0–100 score, with category scores and a trace per scenario; optionally several trials for the score's spread, Pass@k and Pass^k | Core (15 scenarios) a few minutes, Standard (69, the default) 20–30 min, Hard Mode (28) about 15 min, all 97 30–45 min, depending on the model; times the number of trials | Medium: real requests to your server, for minutes | An OpenAI-compatible endpoint on the LAN with tool calling enabled (vLLM: `--enable-auto-tool-choice --tool-call-parser …`) |
| Thermal soak (`thermal-soak`) | Clock stability, throttling, temperature and TFLOPS drift under sustained load | 10 to 30 min | High: holds the GPU at full load | Docker + PyTorch image |

Notes:

- The PyTorch image (`bench_image`, default `nvcr.io/nvidia/pytorch:26.07-py3`) must already be pulled on
  each node. Until it is, the catalog marks the GPU benchmarks unavailable and shows the `docker pull`
  command. GPU containers need the NVIDIA Container Toolkit.
- NCCL uses `torch.distributed` with the NCCL backend inside the PyTorch container, because nccl-tests'
  `all_reduce_perf` needs an MPI launcher across nodes. It reports the same algorithm and bus bandwidth.
- Without `fio`, the storage benchmark uses a built-in O_DIRECT runner. The method is recorded with the
  results, and results from different methods are never compared. Install fio with `sudo apt install fio`.
- `sudo apt install perftest` enables the RDMA benchmark.
- The LLM benchmark keeps Concurrency streams busy: each one sends its next request as soon as its last one
  ends, and a level runs the larger of Requests and its number of streams. With **Sweep concurrency** it
  runs 1, 2, 4 … streams up to Concurrency, one level after another (24 gives 1, 2, 4, 8, 16, 24), and
  reports output tokens/s, decode tokens/s per request and TTFT for each level, plus the peak. While it
  runs, every stream shows its state (waiting for the first token, decoding, done), its tokens, recent
  tokens/s and the end of its text; afterwards the run keeps a timeline of every request. On vLLM it asks for
  usage in every streamed chunk (`continuous_usage_stats`), so live token counts stay exact when one chunk
  carries several tokens (MTP or speculative decoding).
- The LLM showcase sends one request per stream, all released at once. With **Fill to output length** (on by
  default) each prompt asks the model to keep writing and the request adds `ignore_eos`, `min_tokens` and an
  empty `stop` list, so every stream writes the full length; a server that rejects those fields (HTTP 400)
  gets the request again without them, and the run says so. A stream's tokens/s is its decode rate so far, the
  total is the sum over the streams still decoding, and "Server tok/s" is the server's own generation counter
  (`vllm:generation_tokens_total` or `sglang:generation_tokens_total` in `/metrics`, polled every 0.4 s), which
  also counts other users' requests. To see every stream decode together, keep Streams at or below the
  server's concurrent-sequence limit (vLLM `--max-num-seqs`). Its results (output and per-stream decode
  tokens/s, TTFT) describe this one wave of short prompts; use LLM inference to measure.
- The tool-calling evaluation runs [tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench)
  2.8.0 (SeraphimSerapis, MIT) in a host process under the agent, with tool-eval-bench's defaults
  (temperature 0, 120 s per request, 8 turns, one scenario at a time). The agent installs it hash-pinned from
  `server/requirements.lock`; an agent installed before it was added says "tool-eval-bench isn't installed"
  until you re-run `install.sh agent --enable-benchmarks`. Before the scenarios, one tool-calling request
  checks the server: if it rejects tool calls (vLLM without `--enable-auto-tool-choice`), the run stops with
  the fix instead of scoring the few scenarios that got through. Thinking models also need a reasoning parser
  (vLLM `--reasoning-parser …`); without one the run warns that reasoning text arrives in the answer, which
  lowers the score. Scenarios that time out or hit server errors are excluded and the share graded is shown
  with the score; a run in which nothing could be graded fails. The run page offers tool-eval-bench's own
  JSON result for comparing with its CLI, sparkrun or Spark Arena.
- The evaluation's settings map onto tool-eval-bench's CLI: Scenarios "All 97" is `--hardmode` (the
  standard 69 plus the 28 Hard Mode scenarios) and "Hard 28" is `--hardmode-only`; Seed is `--seed`
  (sent to the server with every request) and Trials is `--trials`. So
  `tool-eval-bench --seed 42 --trials 8 --hardmode --base-url http://localhost:8888` is All 97, Seed 42,
  Trials 8 and Endpoint `http://localhost:8888`. Several trials run the same scenarios one after another, as
  the CLI does, and use its own statistics: the headline score is the mean, with its spread (σ), median, range
  and 95 % interval, plus Pass@k (passed in at least one trial) and Pass^k (passed in every trial), the
  scenarios that passed only sometimes, and each category's mean and spread. The verdicts and traces shown
  are the last trial's; the downloaded JSON is the CLI's `--json --trials` output.
- Each result records driver, CUDA and NVML versions, GPU name and UUID, clocks and temperatures at start and
  end, agent version, the suite's git hash (when run from a checkout) and SHA-256, hostnames, parameters and
  timestamps.

### Typical results on a DGX Spark (GB10)

Measured on two idle DGX Sparks with the default parameters unless noted (2026-10-07). Use them to tell whether
your own run is in the right range; [DISCOVERY.md](DISCOVERY.md) has the spread, the cross-checks and the
caveats.

| Benchmark | Typical result |
|---|---|
| GPU matmul at 16384³ | BF16 ~99, FP16 ~98, FP8 (per-tensor scale) ~197, FP4 (NVFP4) ~347 TFLOPS. FP8 with per-row scales is much slower (~56) |
| Memory bandwidth | GPU copy / triad ~222 / ~224 GB/s (about 82 % of 273 GB/s). CPU ~120 GB/s for every core set; the efficiency set is level with or slightly ahead of the performance set |
| CPU throughput | ~246 MB/s per Cortex-X925 core, ~125 per Cortex-A725 core, ~2450 / ~1250 for each set of 10, ~3660 for all 20 |
| NVMe (built-in runner, 4 GiB) | sequential write ~5–8 GB/s, read ~8–9.5 GB/s; 4 KiB random ~12–18 k IOPS with 4 workers, ~110–185 k with 32 |
| RDMA, one rail | ~109 Gb/s write bandwidth at 64 KiB, ~1.45 µs latency |
| NCCL all-reduce, both rails | ~22.5 GB/s bus bandwidth at 1 GiB, ~13 µs for 8 B |
| Thermal soak, 10 min at 8192 | ~95 TFLOPS BF16, under 1 % drop first to last minute, ~81 °C peak, SM clock ~2.15–2.18 GHz, no throttle reasons |
| LLM inference | depends on your model and server; Qwen2.5-0.5B on vLLM decodes ~160 tokens/s per request |
| Tool-call eval | not measured on these nodes yet. The score depends on the model and how it is served (chat template, tool-call and reasoning parsers, thinking on or off), not on the Spark, which mostly sets how long a run takes |

Each CX7 rail is its own PCIe Gen5 x4 link (~109 Gb/s of payload), but both rails share one 200 Gb/s port: run
together they carry ~185 Gb/s, which is the ceiling NCCL reaches.

## Keyboard shortcuts

Press `?` in the app to see this list. Single-key shortcuts pause while you type, and can be turned off in
the same dialog.

| Keys | Action |
|---|---|
| ⌘K / Ctrl+K | Command palette: jump to nodes, metrics, benchmarks and actions |
| `?` | Show keyboard shortcuts |
| `g` then `o` / `a` / `b` / `s` | Go to Overview / Alerts / Benchmarks / Settings |
| `1` to `9` | Jump to node 1 to 9 |
| `w` | Wall mode |
| `t` | Cycle the theme |
| `Esc` | Close a dialog, leave wall mode |

## Troubleshooting

**"Agent unreachable on spark2".** On that node, run `systemctl status sparkline-agent` and
`journalctl -u sparkline-agent -n 50`. Check that the URL in `console.toml` uses the address the agent
listens on: the agent logs `listening on <ip>:9750` at start-up, and `curl http://<ip>:9750/healthz`
needs no token. A firewall must allow port 9750 from the console host.

**"Agent on spark2 rejected the console's token".** The console's `agent_token` doesn't match the agent's
`token`. Compare them with `sudo grep token /etc/sparkline/*.toml`, then restart whichever service you
changed.

**The service exits straight away.** A config problem exits with status 2, and systemd doesn't retry it.
`journalctl -u sparkline-agent` shows the reason: invalid TOML, an unknown key, a refused public bind, or a
missing token.

**GPU panels say "not reported" or show an NVML error.** Run `nvidia-smi` on the node. If the driver was
updated, reboot or reload it, then `sudo systemctl restart sparkline-agent`. If `/dev/nvidia*` isn't
world-readable on your system, re-run `install.sh agent` so it adds the owning group.

**No ConnectX-7 throughput or RDMA state.** Check `ibv_devinfo` and `ip -br link`. A rail is listed only when
its interface exists. Throughput needs `/sys/class/infiniband/<dev>/ports/1/counters/port_{rcv,xmit}_data`.
Port-wide discard and CRC counters come from ethtool and are shown once per physical port.

**Storage benchmark says fio is not installed.** That is informational: the built-in runner is used. Install
`fio` if you want fio's numbers.

**GPU benchmarks say Docker is unreachable or the image is missing.** Re-run
`install.sh agent --enable-benchmarks`, and `docker pull nvcr.io/nvidia/pytorch:26.07-py3` on the node.

**The page says "Frontend not built".** The console can't find `web_dist`. Build it with
`cd web && npm ci && npm run build`, or check `web_dist` in `console.toml`.

## Development

See [DEV.md](DEV.md) for running everything from the repo, the web dev server with hot reload, the demo,
and the checks (ruff, mypy, pytest, TypeScript, ESLint, Vitest, Playwright with axe). The design and wire
contract are in [PLAN.md](PLAN.md). The hardware findings are in [DISCOVERY.md](DISCOVERY.md).
Issues and pull requests are welcome. Please run the checks in DEV.md before opening a pull request, and
report security problems privately as described in [SECURITY.md](SECURITY.md).

## Architecture

```
  spark1                                  spark2
 ┌───────────────────────────┐           ┌───────────────────────────┐
 │ sparkline-agent  :9750    │           │ sparkline-agent  :9750    │
 │  collectors (NVML, /proc, │           │  collectors               │
 │   sysfs, ethtool, hwmon)  │           │  15 min ring buffer       │
 │  15 min ring buffer       │◄─ CX7 ──► │  SQLite 10 s / 1 min      │
 │  SQLite 10 s / 1 min      │  2×200G   │  benchmark runner         │
 │  benchmark runner         │           │                           │
 └─────────────┬─────────────┘           └─────────────┬─────────────┘
               │   REST + WebSocket, Bearer agent token (LAN)
               └───────────────────┬───────────────────┘
                     ┌─────────────▼──────────────┐
                     │ sparkline (console) :9700  │  merges nodes, stale/offline detection,
                     │  alerts + event timeline   │  reconnect with backoff, benchmark
                     │  benchmark orchestration   │  orchestration, results and baselines
                     │  console.sqlite, web app   │  (SQLite), serves the web app
                     └─────────────┬──────────────┘
                                   │  REST + WebSocket, session cookie or Bearer token
                     ┌─────────────▼──────────────┐
                     │ browser: React + TypeScript│  uPlot charts fed from typed-array
                     │  (Vite build, code-split)  │  buffers outside React; Zustand state
                     └────────────────────────────┘
```

One Python package (`server/`, package `sparkline`) provides both commands, `sparkline-agent` and
`sparkline`. The wire contract is `server/sparkline/common/schema.py`, mirrored in `web/src/lib/types.ts`.

## Limitations

- There is no built-in TLS. Use a reverse proxy or VPN if traffic leaves the LAN.
- One shared agent token covers all nodes. Rotating it means editing every `agent.toml` and the console's
  `agent_token`.
- Only GPU 0 is charted (a DGX Spark has one GPU). The cross-node benchmarks assume two nodes.
- GPU benchmarks need the PyTorch image already pulled, and the docker group (root-equivalent).
- Host-side benchmarks (CPU, storage, RDMA, LLM inference, tool-calling evaluation) run inside the agent's
  cgroup. Without `--enable-benchmarks` the agent is capped at half a core, so the catalog marks them unavailable
  ("CPU-capped", read from the cgroup's `cpu.max`) rather than letting a throttled run produce wrong numbers.
- Tool-calling scores compare only between runs of the same tool-eval-bench version and settings (scenarios,
  thinking on or off, seed, trials); each run records the version and tool-eval-bench's config fingerprint. Sparkline pins
  2.8.0. In 2.8.0 a thinking model can lose TC-45: its `tool_choice: "required"` check allows 256 tokens, and
  a model that spends them thinking or answers in prose gets the scenario excluded, so the share graded drops
  below 100 % (tool-eval-bench issue #299). A score with exclusions isn't comparable with a complete run.
- Since 2026-10-21 the LLM benchmark runs at least one request per stream: each level runs the larger of
  Requests and its number of streams, with or without the sweep. Runs with Requests below Concurrency
  therefore aren't compared with runs made before that, which sent fewer requests at once; set a new baseline
  for such a configuration.
- Agents run on the host, not in containers: they need NVML, `/proc` and sysfs of the machine they measure.
- `install.sh` targets systemd-based Linux (DGX OS / Ubuntu 24.04) and needs PyPI access at install time.
- Sparkline is built and tested on DGX Spark (GB10, aarch64). The agent also runs on other Linux machines, with or
  without an NVIDIA GPU, but some views assume GB10. The memory view assumes CPU and GPU share memory, so
  discrete-GPU memory is not shown correctly. On x86, core names read "Arm core", and the split into performance
  and efficiency cores relies on per-core maximum frequency. Interconnect views label any RDMA link as ConnectX-7.

## License

[MIT](LICENSE). The tool-calling evaluation uses
[tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench) by SeraphimSerapis (MIT), installed from
PyPI. Sparkline is an independent project, not affiliated with or endorsed by NVIDIA. NVIDIA, DGX and ConnectX
are trademarks of NVIDIA Corporation.
