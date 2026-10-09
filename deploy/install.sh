#!/usr/bin/env bash
# Sparkline installer. One command per node:
#
#   sudo ./deploy/install.sh agent [--enable-benchmarks]                 # every DGX Spark
#   sudo ./deploy/install.sh console --nodes spark1=http://192.168.1.11:9750,spark2=http://192.168.1.12:9750
#   sudo ./deploy/install.sh uninstall [--purge]
#
# Safe to re-run: code and units are refreshed, existing config and data are never overwritten.
# Try it first with --dry-run (prints every action, changes nothing) or --destdir DIR (lays the files out
# under DIR, without users, ownership or systemd). Run ./deploy/install.sh --help for all options.

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: install.sh [agent|console|uninstall] [options]

Modes:
  agent                 Install sparkline-agent on this node (default).
  console               Install the console (aggregator, API, web app) on this host.
  uninstall             Stop and remove services and code. Config and data stay unless --purge.

Options:
  --nodes LIST          console: id=url pairs, e.g. spark1=http://192.168.1.11:9750,spark2=http://192.168.1.12:9750
  --agent-token TOKEN   Use this agent token instead of generating one (or set SPARKLINE_AGENT_TOKEN, which keeps
                        it out of the process list). Every agent and the console must share one agent token.
  --peers LIST          agent: far ends of the ConnectX-7 rails as id=ip pairs, one per rail, so the UI can
                        name the links, e.g. spark2=10.100.8.2,spark2=10.100.9.2
  --enable-benchmarks   agent: allow benchmarks. Adds the agent to the docker group (root-equivalent) and lifts
                        the agent's CPU/memory caps for benchmark payloads. Without it the agent is monitor-only.
  --bind ADDR           Address written to a new config (default "auto": the private LAN IP of the default route).
  --port N              Port written to a new config (default 9750 agent, 9700 console).
  --prefix DIR          Install location for code and venv (default /opt/sparkline).
  --destdir DIR         Stage everything under DIR (for testing or packaging). Skips users, ownership, systemd.
  --dry-run             Print every action, change nothing.
  --purge               uninstall: also delete /etc/sparkline, the data directories and the sparkline user.
  -y, --yes             Don't ask for confirmation.
  -h, --help            Show this help.
EOF
}

# --- arguments ----------------------------------------------------------------------------------------
MODE=agent
NODES=""
AGENT_TOKEN=${SPARKLINE_AGENT_TOKEN:-}
ENABLE_BENCH=0
PEERS=""
BIND=""
PORT=""
PREFIX=/opt/sparkline
DESTDIR=""
DRY_RUN=0
PURGE=0
YES=0

die() {
	printf 'install.sh: error: %s\n' "$*" >&2
	exit 1
}
need_arg() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

if [[ $# -gt 0 && $1 != -* ]]; then
	MODE=$1
	shift
fi
while [[ $# -gt 0 ]]; do
	case $1 in
	--nodes) need_arg "$@"; NODES=$2; shift ;;
	--agent-token) need_arg "$@"; AGENT_TOKEN=$2; shift ;;
	--peers) need_arg "$@"; PEERS=$2; shift ;;
	--enable-benchmarks) ENABLE_BENCH=1 ;;
	--bind) need_arg "$@"; BIND=$2; shift ;;
	--port) need_arg "$@"; PORT=$2; shift ;;
	--prefix) need_arg "$@"; PREFIX=$2; shift ;;
	--destdir) need_arg "$@"; DESTDIR=$2; shift ;;
	--dry-run) DRY_RUN=1 ;;
	--purge) PURGE=1 ;;
	-y | --yes) YES=1 ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

case $MODE in agent | console | uninstall) ;; *) die "unknown mode: $MODE (agent, console or uninstall)" ;; esac
[[ $PREFIX == /* ]] || die "--prefix must be an absolute path"
if [[ -n $DESTDIR ]]; then
	[[ $DESTDIR == /* ]] || DESTDIR="$PWD/$DESTDIR"
	DESTDIR=${DESTDIR%/}
fi
[[ -z $PORT || $PORT =~ ^[0-9]+$ && $PORT -ge 1 && $PORT -le 65535 ]] || die "--port must be 1-65535"
[[ -z $BIND || $BIND =~ ^[A-Za-z0-9.:_-]+$ ]] || die "--bind must be an IP address, a hostname or \"auto\""
[[ -z $AGENT_TOKEN || $AGENT_TOKEN =~ ^[A-Za-z0-9_-]{16,256}$ ]] ||
	die "agent token must be 16-256 characters of A-Z a-z 0-9 _ -"
[[ $MODE == console || -z $NODES ]] || die "--nodes only applies to console"
[[ $MODE == agent || $ENABLE_BENCH == 0 ]] || die "--enable-benchmarks only applies to agent"
[[ $MODE == agent || -z $PEERS ]] || die "--peers only applies to agent"
PEER_RE='[A-Za-z0-9_-]+=([0-9]{1,3}[.]){3}[0-9]{1,3}'
[[ -z $PEERS || $PEERS =~ ^$PEER_RE(,$PEER_RE)*$ ]] || die "--peers must look like spark2=10.100.8.2,spark2=10.100.9.2"
[[ $MODE == uninstall || $PURGE == 0 ]] || die "--purge only applies to uninstall"

# --- paths --------------------------------------------------------------------------------------------
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC_USER=sparkline
ETC=/etc/sparkline
UNIT_DIR=/etc/systemd/system
AGENT_DATA=/var/lib/sparkline-agent
CONSOLE_DATA=/var/lib/sparkline
VENV=$PREFIX/venv
DROPIN_DIR=$UNIT_DIR/sparkline-agent.service.d
DROPIN=$DROPIN_DIR/10-benchmarks.conf
PY=${PYTHON:-python3}

# Real system changes (users, ownership, systemd) only as root and without --destdir. --dry-run shows
# them as if run by root.
IS_ROOT=0
[[ $(id -u) == 0 ]] && IS_ROOT=1
SYSTEM=0
[[ -z $DESTDIR && ($IS_ROOT == 1 || $DRY_RUN == 1) ]] && SYSTEM=1
if [[ $DRY_RUN == 0 && -z $DESTDIR && $IS_ROOT == 0 ]]; then
	die "run as root (sudo $0 $MODE ...), or try it with --dry-run or --destdir DIR"
fi

# --- helpers ------------------------------------------------------------------------------------------
say() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }
skip() { printf '    skipped (%s): %s\n' "$1" "$2"; }
# A dry run as a normal user can't see a root-only config, so it would preview a fresh install.
if [[ $DRY_RUN == 1 && $IS_ROOT == 0 && -d $ETC && ! -r $ETC ]]; then
	warn "can't read $ETC as $(id -un): existing configs look absent below; use sudo for an exact preview"
fi

# Run a command, or print it under --dry-run.
run() {
	if [[ $DRY_RUN == 1 ]]; then
		printf '    +'
		printf ' %q' "$@"
		printf '\n'
	else
		"$@"
	fi
}

# Staged path: the final path under --destdir.
p() { printf '%s%s' "$DESTDIR" "$1"; }

why_no_system() {
	if [[ -n $DESTDIR ]]; then echo "--destdir"; else echo "not root"; fi
}

confirm() {
	[[ $YES == 1 || $DRY_RUN == 1 ]] && return 0
	[[ -t 0 ]] || die "$1 Re-run with --yes to confirm non-interactively."
	local answer
	read -r -p "$1 [y/N] " answer
	[[ $answer == [yY] || $answer == [yY][eE][sS] ]] || die "cancelled"
}

new_token() { "$PY" -c 'import secrets; print(secrets.token_urlsafe(32))'; }

# Read one top-level string key from a TOML file (prints nothing if absent). Uses the stdlib parser.
toml_get() {
	"$PY" - "$1" "$2" <<'PYEOF'
import sys, tomllib
try:
    with open(sys.argv[1], "rb") as f:
        v = tomllib.load(f).get(sys.argv[2], "")
except OSError:
    v = ""
print(v if isinstance(v, (str, int)) else "")
PYEOF
}

# A token for the final summary: shown on an interactive terminal only, so it never lands in a `| tee` log or a
# CI transcript; otherwise where to read it.
TTY_OUT=0
[[ -t 1 ]] && TTY_OUT=1 # tested here: show_secret runs inside $(...), where stdout is a pipe
show_secret() {
	local value=$1 file=$2 key=$3
	if [[ $TTY_OUT == 1 ]]; then
		printf '%s' "$value"
	else
		printf '(not printed: stdout is not a terminal) sudo grep ^%s %s' "$key" "$file"
	fi
}

# Write a file from stdin with mode/owner. Owner root:sparkline only when making system changes.
write_file() {
	local dst=$1 mode=$2 tmp
	if [[ $DRY_RUN == 1 ]]; then
		printf '    + write %s (mode %s%s):\n' "$dst" "$mode" "$([[ $SYSTEM == 1 ]] && echo ", root:$SVC_USER")"
		# A token passed in (--agent-token, SPARKLINE_AGENT_TOKEN, an existing agent.toml) is never printed.
		sed -E 's/^((agent_)?token = ")[^<"][^"]*"/\1<hidden>"/; s/^/        | /'
		return
	fi
	tmp=$(mktemp "$(dirname "$dst")/.install.XXXXXX")
	cat >"$tmp"
	chmod "$mode" "$tmp"
	[[ $SYSTEM == 1 ]] && chown "root:$SVC_USER" "$tmp"
	mv -f "$tmp" "$dst"
}

# Copy a unit file, pointing it at --prefix.
install_unit() {
	local src=$1 dst=$2
	if [[ $DRY_RUN == 1 ]]; then
		info "+ install $src -> $dst (mode 0644$([[ $PREFIX != /opt/sparkline ]] && echo ", /opt/sparkline -> $PREFIX"))"
		return
	fi
	sed "s#/opt/sparkline#$PREFIX#g" "$src" >"$dst.tmp"
	chmod 0644 "$dst.tmp"
	mv -f "$dst.tmp" "$dst"
}

# Replace a directory tree atomically enough for a re-run: build NAME.new, then swap.
copy_tree() {
	local src=$1 dst=$2
	shift 2
	rm -rf "$dst.new"
	mkdir -p "$dst.new"
	tar -C "$src" --exclude=__pycache__ --exclude='*.pyc' -cf - "$@" | tar -C "$dst.new" -xf -
	rm -rf "$dst"
	mv "$dst.new" "$dst"
}

# --- checks -------------------------------------------------------------------------------------------
check_platform() {
	say "Checking this machine"
	[[ $(uname -s) == Linux ]] || die "Sparkline runs on Linux only"
	local arch os=""
	arch=$(uname -m)
	case $arch in
	aarch64 | arm64 | x86_64) ;;
	*) warn "untested architecture $arch" ;;
	esac
	# shellcheck disable=SC1091
	[[ -r /etc/os-release ]] && os=$(. /etc/os-release && echo "${PRETTY_NAME:-}")
	info "OS: ${os:-unknown}, kernel $(uname -r), $arch"

	command -v "$PY" >/dev/null || die "python3 not found (Ubuntu: sudo apt install python3)"
	"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 12))' ||
		die "Python 3.12 or newer is required (found $("$PY" -V 2>&1))"
	info "Python: $("$PY" -V 2>&1) ($(command -v "$PY"))"
	if ! command -v uv >/dev/null && ! "$PY" -c 'import ensurepip, venv' 2>/dev/null; then
		die "python3 can't create virtual environments (Ubuntu: sudo apt install python3-venv), or install uv"
	fi

	if [[ $MODE == agent ]]; then
		if command -v nvidia-smi >/dev/null; then
			info "NVIDIA driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1 || echo unknown)"
		else
			warn "nvidia-smi not found: the agent will run, but GPU metrics will show as not reported"
		fi
		command -v ib_write_bw >/dev/null || info "perftest not installed: the RDMA benchmark will be unavailable (sudo apt install perftest)"
		command -v fio >/dev/null || info "fio not installed: the storage benchmark will use its built-in runner (sudo apt install fio)"
	fi
	if [[ $SYSTEM == 1 && $DRY_RUN == 0 ]] && ! command -v systemctl >/dev/null; then
		die "systemd is required (systemctl not found). For the console, deploy/docker-compose.yml is an alternative."
	fi
}

# --- user and groups ----------------------------------------------------------------------------------
# Supplementary groups for device nodes the agent must open but cannot: only those that are not already
# world read/write. On DGX OS /dev/nvidia* and /dev/infiniband/uverbs* are 0666, so this is usually empty.
device_groups() {
	local f mode grp groups=()
	for f in /dev/nvidia* /dev/infiniband/uverbs* /dev/infiniband/rdma_cm; do
		[[ -c $f ]] || continue
		mode=$(stat -c %a "$f")
		[[ ${mode: -1} == 6 || ${mode: -1} == 7 ]] && continue
		grp=$(stat -c %G "$f")
		[[ $grp == root ]] && { warn "$f is $mode root:root: the agent cannot open it"; continue; }
		[[ " ${groups[*]} " == *" $grp "* ]] || groups+=("$grp")
	done
	echo "${groups[*]}"
}

ensure_user() {
	say "Service user"
	if [[ $SYSTEM == 0 ]]; then
		skip "$(why_no_system)" "create system user $SVC_USER"
		return
	fi
	if getent passwd "$SVC_USER" >/dev/null; then
		info "user $SVC_USER exists"
	else
		run useradd --system --user-group --no-create-home --home-dir /nonexistent \
			--shell /usr/sbin/nologin --comment "Sparkline monitoring" "$SVC_USER"
	fi
	[[ $MODE == agent ]] || return 0
	local groups g
	groups=$(device_groups)
	for g in $groups; do
		if id -nG "$SVC_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$g"; then
			info "$SVC_USER is already in $g"
		else
			run usermod -aG "$g" "$SVC_USER"
		fi
	done
	[[ -n $groups ]] || info "no extra device groups needed (/dev/nvidia* and RDMA devices are world-accessible)"
}

# --- code ---------------------------------------------------------------------------------------------
build_web() {
	[[ -f $REPO/web/dist/index.html ]] && return 0
	say "Building the web app (web/dist is missing)"
	if [[ $DRY_RUN == 1 ]]; then
		info "+ (cd $REPO/web && npm ci && npm run build)"
		return
	fi
	if [[ $IS_ROOT == 1 && -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then
		# Build as the repo's owner (a login shell finds their npm), never as root inside their checkout.
		sudo -u "$SUDO_USER" -H bash -lc 'cd "$1" && npm ci --no-audit --no-fund && npm run build' _ "$REPO/web" ||
			die "web build failed. Build it yourself: cd web && npm ci && npm run build, then re-run."
	elif command -v npm >/dev/null; then
		(cd "$REPO/web" && npm ci --no-audit --no-fund && npm run build) || die "web build failed"
	else
		die "web/dist is missing and npm is not available. Run: cd web && npm ci && npm run build, then re-run."
	fi
	[[ -f $REPO/web/dist/index.html ]] || die "web build did not produce web/dist/index.html"
}

install_code() {
	local root
	root=$(p "$PREFIX")
	say "Installing code to $root"
	run mkdir -p "$root"
	run copy_tree "$REPO/server" "$root/server" pyproject.toml requirements.lock sparkline
	if [[ $MODE == console ]]; then
		run copy_tree "$REPO/web" "$root/web" dist
	fi

	local venv
	venv=$(p "$VENV")
	if [[ -x $venv/bin/python ]] && ! "$venv/bin/python" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; then
		info "existing venv is broken or too old: recreating"
		run rm -rf "$venv"
	fi
	if command -v uv >/dev/null; then
		[[ -x $venv/bin/python ]] || run env UV_PYTHON_DOWNLOADS=never uv venv --quiet --python "$(command -v "$PY")" "$venv"
		# Dependencies only at the pinned, hash-checked versions; then the package itself, built offline.
		run env UV_PYTHON_DOWNLOADS=never uv pip install --quiet --python "$venv/bin/python" \
			--require-hashes -r "$root/server/requirements.lock"
		run env UV_PYTHON_DOWNLOADS=never uv pip install --quiet --python "$venv/bin/python" \
			--no-deps --no-build-isolation --reinstall-package sparkline "$root/server"
	else
		# Also covers a venv made earlier by uv, which has no pip: venv adds it and keeps site-packages.
		[[ -x $venv/bin/pip ]] || run "$PY" -m venv "$venv"
		run "$venv/bin/pip" install --quiet --disable-pip-version-check --require-hashes -r "$root/server/requirements.lock"
		run "$venv/bin/pip" install --quiet --disable-pip-version-check --no-deps --no-build-isolation --upgrade "$root/server"
	fi
	# Compile now: at runtime /opt is read-only to the service.
	run "$venv/bin/python" -m compileall -q "$venv/lib"
	if [[ $SYSTEM == 1 ]]; then
		run chown -R root:root "$root"
		run chmod -R u=rwX,go=rX "$root"
	fi
}

# --- config -------------------------------------------------------------------------------------------
config_dir() {
	local dir
	dir=$(p "$ETC")
	say "Config directory $dir"
	run mkdir -p "$dir"
	if [[ $SYSTEM == 1 ]]; then
		run chown "root:$SVC_USER" "$dir"
		run chmod 0750 "$dir"
	fi
}

write_agent_config() {
	local file token
	file=$(p "$ETC/agent.toml")
	say "Agent config $file"
	if [[ -f $file ]]; then
		info "kept existing config (never overwritten)"
		[[ -z $BIND && -z $PORT ]] || warn "--bind/--port ignored: edit $ETC/agent.toml instead"
		[[ -z $AGENT_TOKEN ]] || warn "--agent-token ignored: $ETC/agent.toml already has a token"
		return
	fi
	if [[ -n $AGENT_TOKEN ]]; then token=$AGENT_TOKEN; elif [[ $DRY_RUN == 1 ]]; then token="<generated>"; else token=$(new_token); fi
	local peers_line='# peers = { spark2 = ["10.100.8.2", "10.100.9.2"] }'
	[[ -z $PEERS ]] || peers_line="peers = $(peers_toml "$PEERS")"
	write_file "$file" 0640 <<EOF
# Sparkline agent. Generated by install.sh on $(date -u +%Y-%m-%d). Never overwritten by install.sh.
# Reference: README.md, "Configuration". Restart after editing: sudo systemctl restart sparkline-agent

node_id = "$(hostname -s)"
# "auto" = the private LAN IP of the default route. 0.0.0.0 and public addresses are refused.
bind = "${BIND:-auto}"
port = ${PORT:-9750}
# Shared agent token: the console's agent_token must match it on every node.
token = "$token"
data_dir = "$AGENT_DATA"

# interval_ms = 1000          # 250..5000
# retention_10s_days = 7
# retention_60s_days = 30
# Far ends of the ConnectX-7 rails, so the UI can name the link:
$peers_line
EOF
}

# --peers "spark2=10.100.8.2,spark2=10.100.9.2" -> { spark2 = ["10.100.8.2", "10.100.9.2"] }
peers_toml() {
	"$PY" -c '
import sys
groups = {}
for pair in sys.argv[1].split(","):
    node, ip = pair.split("=", 1)
    groups.setdefault(node, []).append(ip)
items = ", ".join("%s = [%s]" % (n, ", ".join("\"%s\"" % ip for ip in ips)) for n, ips in groups.items())
print("{ " + items + " }")' "$1"
}

# --nodes "a=http://x:9750,b=http://y:9750" -> TOML [[nodes]] blocks.
nodes_toml() {
	local pair id url out="" url_re='^https?://[][A-Za-z0-9.:_-]+(/.*)?$'
	IFS=',' read -r -a pairs <<<"$NODES"
	for pair in "${pairs[@]}"; do
		id=${pair%%=*}
		url=${pair#*=}
		[[ $pair == *=* && $id =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || die "bad --nodes entry '$pair' (want id=http://host:9750)"
		[[ $url =~ $url_re ]] || die "bad URL in --nodes entry '$pair'"
		out+=$'\n[[nodes]]\n'"id = \"$id\""$'\n'"url = \"$url\""$'\n'
	done
	printf '%s' "$out"
}

write_console_config() {
	local file token agent_token nodes local_agent
	file=$(p "$ETC/console.toml")
	say "Console config $file"
	if [[ -f $file ]]; then
		info "kept existing config (never overwritten)"
		[[ -z $BIND && -z $PORT && -z $NODES ]] || warn "--bind/--port/--nodes ignored: edit $ETC/console.toml instead"
		return
	fi
	[[ -n $NODES ]] || die "--nodes is required for a new console, e.g. --nodes spark1=http://192.168.1.11:9750,spark2=http://192.168.1.12:9750"
	nodes=$(nodes_toml)
	local_agent=$(p "$ETC/agent.toml")
	if [[ -n $AGENT_TOKEN ]]; then
		agent_token=$AGENT_TOKEN
	elif [[ -f $local_agent ]] && agent_token=$(toml_get "$local_agent" token) && [[ -n $agent_token ]]; then
		info "agent_token taken from $ETC/agent.toml on this host"
	elif [[ $DRY_RUN == 1 ]]; then
		agent_token="<generated>"
	else
		agent_token=$(new_token)
		GENERATED_AGENT_TOKEN=1
	fi
	if [[ $DRY_RUN == 1 ]]; then token="<generated>"; else token=$(new_token); fi
	write_file "$file" 0640 <<EOF
# Sparkline console. Generated by install.sh on $(date -u +%Y-%m-%d). Never overwritten by install.sh.
# Reference: README.md, "Configuration". Restart after editing: sudo systemctl restart sparkline

# "auto" = the private LAN IP of the default route. 0.0.0.0 and public addresses are refused.
bind = "${BIND:-auto}"
port = ${PORT:-9700}
# What you type on the sign-in screen.
token = "$token"
# Must equal token in /etc/sparkline/agent.toml on every node.
agent_token = "$agent_token"
data_dir = "$CONSOLE_DATA"
web_dist = "$PREFIX/web/dist"

# [settings]                  # also editable in the app (Settings)
# energy_rate_per_kwh = 0.28
# currency = "£"
# stale_after_s = 5.0
# offline_after_s = 30.0
# regression_pct = 5.0
$nodes
EOF
}

data_dir() {
	local dir
	dir=$(p "$1")
	say "Data directory $dir"
	if [[ $SYSTEM == 1 ]]; then
		run install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$dir"
	else
		run install -d -m 0750 "$dir"
	fi
}

# --- systemd ------------------------------------------------------------------------------------------
install_units() {
	local unit=$1 units
	units=$(p "$UNIT_DIR")
	say "systemd unit $unit"
	run mkdir -p "$units"
	install_unit "$REPO/deploy/systemd/$unit" "$units/$unit"
	[[ $unit == sparkline-agent.service ]] || return 0
	local dropin
	dropin=$(p "$DROPIN")
	if [[ $ENABLE_BENCH == 1 ]]; then
		info "benchmarks enabled: docker group and lifted caps via $DROPIN"
		run mkdir -p "$(p "$DROPIN_DIR")"
		install_unit "$REPO/deploy/systemd/sparkline-agent-benchmarks.conf" "$dropin"
	elif [[ -e $dropin ]]; then
		info "benchmarks not requested: removing $DROPIN (agent becomes monitor-only)"
		run rm -f "$dropin"
		run rmdir --ignore-fail-on-non-empty "$(p "$DROPIN_DIR")"
	else
		info "monitor-only (no --enable-benchmarks)"
	fi
}

start_unit() {
	local unit=$1
	say "Starting $unit"
	if [[ $SYSTEM == 0 ]]; then
		skip "$(why_no_system)" "systemctl daemon-reload, enable and (re)start $unit"
		return
	fi
	run systemctl daemon-reload
	run systemctl enable "$unit"
	run systemctl restart "$unit" # starts it if stopped, picks up new code if running
}

# The URL the service listens on, resolved with the service's own bind logic.
service_url() {
	local file=$1 default_port=$2 bind port host
	bind=$(toml_get "$file" bind)
	port=$(toml_get "$file" port)
	host=$("$(p "$VENV")/bin/python" -c 'import sys
from sparkline.common.netutil import resolve_bind
try:
    print(resolve_bind(sys.argv[1] or "auto"))
except ValueError:
    print("<bind address>")' "$bind" 2>/dev/null || echo "<bind address>")
	[[ $host == *:* ]] && host="[$host]"
	printf 'http://%s:%s' "$host" "${port:-$default_port}"
}

wait_healthy() {
	local unit=$1 url=$2
	[[ $SYSTEM == 1 && $DRY_RUN == 0 ]] || return 0
	if "$(p "$VENV")/bin/python" - "$url/healthz" <<'PYEOF'; then
import sys, time, urllib.request
for _ in range(30):
    try:
        with urllib.request.urlopen(sys.argv[1], timeout=2) as r:
            if r.status == 200:
                sys.exit(0)
    except OSError:
        pass
    time.sleep(0.5)
sys.exit(1)
PYEOF
		info "$unit is up: $url/healthz answers"
	else
		warn "$unit did not answer on $url/healthz within 15 s. Check: systemctl status $unit; journalctl -u $unit -n 50"
	fi
}

# --- modes --------------------------------------------------------------------------------------------
benchmark_warning() {
	[[ $ENABLE_BENCH == 1 ]] || return 0
	cat >&2 <<'EOF'

  --enable-benchmarks gives the sparkline service user access to the Docker socket (the docker group).
  Docker group membership is equivalent to root on this machine: whoever controls the agent process could
  start a privileged container. The agent itself only runs a fixed set of benchmark containers with
  validated parameters, and its API needs the agent token. It also lifts the agent's CPU and memory caps
  so benchmark payloads aren't throttled.

EOF
	if ! getent group docker >/dev/null; then
		die "--enable-benchmarks needs Docker (no docker group on this machine). Install Docker and the NVIDIA Container Toolkit first."
	fi
	confirm "Give sparkline-agent the docker group and enable benchmarks?"
}

install_agent() {
	benchmark_warning
	check_platform
	ensure_user
	install_code
	config_dir
	write_agent_config
	data_dir "$AGENT_DATA"
	install_units sparkline-agent.service
	start_unit sparkline-agent.service

	local file url token
	file=$(p "$ETC/agent.toml")
	echo
	say "sparkline-agent installed$([[ $DRY_RUN == 1 ]] && echo " (dry run: nothing was changed)")"
	[[ $DRY_RUN == 1 ]] && return 0
	url=$(service_url "$file" 9750)
	wait_healthy sparkline-agent.service "$url"
	token=$(toml_get "$file" token)
	info "Agent URL:    $url"
	info "Agent token:  $(show_secret "$token" "$file" token)"
	info "Put this URL in the console's --nodes list, and the same token in the console's agent_token."
	info "On every other node, pass the token through the environment (never on the command line, which sudo logs):"
	info "  read -rs SPARKLINE_AGENT_TOKEN && export SPARKLINE_AGENT_TOKEN"
	info "  sudo --preserve-env=SPARKLINE_AGENT_TOKEN $0 agent"
	if [[ $ENABLE_BENCH == 1 ]]; then
		info "Benchmarks:   enabled (docker group, caps lifted)"
	else
		info "Benchmarks:   off (monitor-only). Re-run with --enable-benchmarks to allow them."
	fi
}

install_console() {
	check_platform
	build_web
	ensure_user
	install_code
	config_dir
	GENERATED_AGENT_TOKEN=0
	write_console_config
	data_dir "$CONSOLE_DATA"
	install_units sparkline.service
	start_unit sparkline.service

	local file url
	file=$(p "$ETC/console.toml")
	echo
	say "Sparkline console installed$([[ $DRY_RUN == 1 ]] && echo " (dry run: nothing was changed)")"
	[[ $DRY_RUN == 1 ]] && return 0
	url=$(service_url "$file" 9700)
	wait_healthy sparkline.service "$url"
	info "Open:           $url"
	info "Console token:  $(show_secret "$(toml_get "$file" token)" "$file" token)   (type this on the sign-in screen)"
	info "Agent token:    $(show_secret "$(toml_get "$file" agent_token)" "$file" agent_token)"
	if [[ $GENERATED_AGENT_TOKEN == 1 ]]; then
		warn "a new agent token was generated: set it as token in /etc/sparkline/agent.toml on every node and restart"
		warn "sparkline-agent there, or delete $ETC/console.toml and re-run this with the agents' token in the environment:"
		warn "  read -rs SPARKLINE_AGENT_TOKEN && export SPARKLINE_AGENT_TOKEN && sudo --preserve-env=SPARKLINE_AGENT_TOKEN $0 console ..."
	fi
}

uninstall() {
	say "Uninstalling Sparkline$([[ $PURGE == 1 ]] && echo " (purge: config, history and benchmark results too)")"
	if [[ $PURGE == 1 ]]; then
		confirm "Delete $ETC (tokens), $AGENT_DATA and $CONSOLE_DATA (all history and benchmark results)?"
	fi
	local unit
	for unit in sparkline-agent.service sparkline.service; do
		if [[ $SYSTEM == 0 ]]; then
			skip "$(why_no_system)" "systemctl disable --now $unit"
		elif [[ $DRY_RUN == 1 ]] || systemctl cat "$unit" >/dev/null 2>&1; then
			run systemctl disable --now "$unit"
		fi
		run rm -f "$(p "$UNIT_DIR/$unit")"
	done
	run rm -rf "$(p "$DROPIN_DIR")"
	[[ $SYSTEM == 1 ]] && run systemctl daemon-reload
	run rm -rf "$(p "$PREFIX")"
	if [[ $PURGE == 0 ]]; then
		info "kept $ETC, $AGENT_DATA, $CONSOLE_DATA and the $SVC_USER user (use --purge to delete them)"
		return
	fi
	run rm -rf "$(p "$ETC")" "$(p "$AGENT_DATA")" "$(p "$CONSOLE_DATA")"
	if [[ $SYSTEM == 0 ]]; then
		skip "$(why_no_system)" "userdel $SVC_USER"
	elif [[ $DRY_RUN == 1 ]] || getent passwd "$SVC_USER" >/dev/null; then
		run userdel "$SVC_USER"
	fi
}

if [[ $DRY_RUN == 1 ]]; then
	say "Dry run: printing every action, changing nothing"
fi
[[ -n $DESTDIR ]] && say "Staging under $DESTDIR (no users, ownership or systemd)"
case $MODE in
agent) install_agent ;;
console) install_console ;;
uninstall) uninstall ;;
esac
