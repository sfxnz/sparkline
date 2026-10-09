# Running Sparkline for development

Everything runs as your user from the repo. For installing on the nodes (`deploy/install.sh`, systemd, Docker
Compose), see [README.md](README.md).
Runtime files go in `var/`, which git ignores.

## One-time setup

You need Python 3.12 or newer (with `uv`, or `python3-venv`) and Node.js 22.22.2 or newer on 22.x, 24.15 or newer on 24.x, or
26 and later, for the web tests. Building the web app alone works from Node.js 22.12.

```sh
cd server && uv venv && uv pip install -e '.[dev]'    # or: python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
cd ../web && npm ci
cd .. && mkdir -p var && chmod 700 var                 # back at the repo root, where every command below runs
```

## Demo: no hardware, no token

From the repo root:

```sh
(cd web && npm run build)                                   # the console serves web/dist
cat > var/demo.toml <<'EOF'
bind = "127.0.0.1"
port = 9701
data_dir = "var/demo-data"
EOF
server/.venv/bin/sparkline --demo --config var/demo.toml      # http://127.0.0.1:9701 (serves web/dist)
```

The demo runs three nodes: spark1, spark2 and spark3. The first minute is calm; then spark1 has a thermal episode (about 60 s), spark2's stream stalls briefly (about 120 s), and spark3 goes stale at about 150 s, goes offline at about 170 s and reconnects on its own. Alerts fire and then recover. Benchmark runs are time-compressed.
With no `token` in the config, auth is off.

## Real agents + console

Generate one agent token, shared by every node, and one console token for the browser:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

**Agent:** one per node. `var/agent.toml` on spark1 looks like this; on spark2 use its LAN IP and swap the peer:

```toml
node_id = "spark1"
bind = "192.168.1.11"       # LAN IP. 0.0.0.0 and public addresses are refused.
port = 9750
token = "<agent token>"
data_dir = "var/agent-data"
peers = { spark2 = ["10.100.8.2", "10.100.9.2"] }   # far ends of CX7 rails A and B
```

```sh
chmod 600 var/agent.toml
server/.venv/bin/sparkline-agent --config var/agent.toml
```

Benchmarks: GPU payloads run in `bench_image` (default `nvcr.io/nvidia/pytorch:26.07-py3`), test files go in
`bench_work_dir` (default `<data_dir>/bench-work`). `bench_payload_device = "cpu"` runs the gpu-matmul, mem-bandwidth and
thermal-soak payloads on the CPU at tiny sizes without `--gpus`: a code-path smoke test whose results are flagged smoke
and never compared with GPU baselines. The catalog says so while it is on.

To run the agent on spark2, copy the code over and start it the same way:

```sh
rsync -a --delete --exclude .venv --exclude __pycache__ server/ spark2:~/sparkline/server/
ssh spark2 'cd ~/sparkline/server && python3 -m venv .venv && .venv/bin/pip install -q -e .'
```

**Console:** `var/console.toml`:

```toml
bind = "127.0.0.1"          # or the LAN IP to reach it from other machines
port = 9700
token = "<console token>"   # what you type on the login screen
agent_token = "<agent token>"
data_dir = "var/console-data"

[[nodes]]
id = "spark1"
url = "http://192.168.1.11:9750"

[[nodes]]
id = "spark2"
url = "http://192.168.1.12:9750"
```

```sh
chmod 600 var/console.toml
(cd web && npm run build)                                   # the console serves web/dist
server/.venv/bin/sparkline --config var/console.toml    # http://127.0.0.1:9700
```

## Web dev server, with hot reload

```sh
cd web
SPARKLINE_URL=http://127.0.0.1:9700 npm run dev      # http://127.0.0.1:5180, proxies /api (REST + WS)
SPARKLINE_URL=http://127.0.0.1:9701 npm run dev      # the same, against the demo
```

`npm run dev` also serves `/gallery.html`, a page of the components and charts fed with synthetic live data.

## Checks

```sh
(cd server && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest -q)
(cd web && npm run typecheck && npm run lint && npm test && npm run build && npm run e2e)
```

Before the first `npm run e2e`, install its browser once: `(cd web && npx playwright install chromium)`.

`npm run e2e` starts its own demo console (port `E2E_DEMO_PORT`, default 9702, data in the git-ignored `web/.e2e-demo/`)
and a `vite preview` of the build proxying to it (port `E2E_PORT`, default 5180). Flow tests and axe checks run against
that demo; a few chrome tests stub `/api` per test instead.

### Deployment files

None of these need root, and none of them touch the system:

```sh
shellcheck deploy/install.sh
./deploy/install.sh agent --dry-run                  # also: console --nodes a=http://x:9750, uninstall --purge
./deploy/install.sh agent --destdir /tmp/sl-stage    # real layout under /tmp/sl-stage, no users or systemd
systemd-analyze verify deploy/systemd/*.service      # only complains that /opt/sparkline/venv is absent
docker compose -f deploy/docker-compose.yml config
```

A `--destdir` run creates a working venv inside the stage, so its `sparkline`/`sparkline-agent` and the
generated TOML can be tried directly (pass `--bind 127.0.0.1 --port ...` and `--data-dir`).
