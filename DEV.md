# Running Sparkline for development

Everything runs as your user from the repo. Packaged deployment (`install.sh`, systemd) comes in a later phase.
Runtime files go in `var/`, which git ignores.

## One-time setup

```sh
cd server && uv venv && uv pip install -e '.[dev]'    # or: python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
cd ../web && npm ci
mkdir -p ../var && chmod 700 ../var
```

## Demo: no hardware, no token

```sh
cat > var/demo.toml <<'EOF'
bind = "127.0.0.1"
port = 9701
data_dir = "var/demo-data"
EOF
server/.venv/bin/sparkline --demo --config var/demo.toml      # http://127.0.0.1:9701 (serves web/dist)
```

The demo runs three nodes: spark1, spark2 and spark3. spark3 goes stale at about 30 s, goes offline at about 48 s and reconnects on its own. Alerts fire and then recover.
With no `token` in the config, auth is off.

## Real agents + console

Generate one agent token, shared by every node, and one console token for the browser:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

**Agent:** one per node. `var/agent.toml` on spark1 looks like this; on spark2 use its LAN IP and swap the peer:

```toml
node_id = "spark1"
bind = "10.20.20.48"        # LAN IP. 0.0.0.0 and public addresses are refused.
port = 9750
token = "<agent token>"
data_dir = "var/agent-data"
peers = { spark2 = ["10.100.8.2", "10.100.9.2"] }   # far ends of CX7 rails A and B
```

```sh
chmod 600 var/agent.toml
server/.venv/bin/sparkline-agent --config var/agent.toml
```

To run the agent on spark2, copy the code over and start it the same way:

```sh
rsync -a --delete --exclude .venv --exclude __pycache__ server/ spark2:~/projects/ai-lab/sparkline/server/
ssh spark2 'cd ~/projects/ai-lab/sparkline/server && python3 -m venv .venv && .venv/bin/pip install -q -e .'
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
url = "http://10.20.20.48:9750"

[[nodes]]
id = "spark2"
url = "http://10.20.20.195:9750"
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
cd server && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/pytest -q
cd web && npm run typecheck && npm run lint && npm test && npm run build && npm run e2e
```
