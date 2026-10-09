#!/usr/bin/env bash
# Install Sparkline on a two-node DGX Spark cluster from this node, in one command:
#   agents on this node and on the peer (over ssh), the console here.
#
#   ./deploy/install-cluster.sh                 # peer = ssh host "spark2"; asks for sudo here and on the peer
#   ./deploy/install-cluster.sh --peer spark2 --no-benchmarks --dry-run
#
# Run it as your normal user (it calls sudo itself). Safe to re-run: install.sh never overwrites config.

# The node probe is meant to expand remotely (SC2016) and the paths locally (SC2029).
# shellcheck disable=SC2016,SC2029
set -euo pipefail

PEER=spark2
BENCH=1
DRY_RUN=0
YES=0

usage() {
	sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	cat <<'EOF'
Options:
  --peer HOST        ssh host of the other node (default spark2; must work with key auth)
  --no-benchmarks    install monitor-only agents (no docker group, CPU/memory caps kept)
  --dry-run          show what install.sh would do on each node, change nothing (still copies the
                     installer to ~/.cache/sparkline-install on the peer, so it can run there)
  -y, --yes          don't ask for confirmation
EOF
}

while [[ $# -gt 0 ]]; do
	case $1 in
	--peer) [[ -n ${2:-} ]] || { echo "--peer needs a value" >&2; exit 1; }; PEER=$2; shift ;;
	--no-benchmarks) BENCH=0 ;;
	--dry-run) DRY_RUN=1 ;;
	-y | --yes) YES=1 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
	esac
	shift
done

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REMOTE_DIR=.cache/sparkline-install # relative to the peer's home
say() { printf '==> %s\n' "$*"; }
die() { printf 'install-cluster.sh: error: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) != 0 ]] || die "run as your normal user; it uses sudo where needed"

# LAN IP (default route) and ConnectX-7 rail IPs (netdevs backing RDMA devices) of a node.
probe='lan=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n "s/.* src \([0-9.]*\).*/\1/p")
rails=""
for n in /sys/class/infiniband/*/device/net/*; do
	[ -e "$n" ] || continue
	ip=$(ip -4 -o addr show dev "$(basename "$n")" 2>/dev/null | awk "{print \$4}" | cut -d/ -f1 | head -n1)
	[ -n "$ip" ] && rails="$rails $ip"
done
echo "$(hostname -s) $lan$rails"'

say "Checking both nodes"
[[ -d $REPO/web/dist ]] || die "web/dist is missing: run 'cd web && npm ci && npm run build' first"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$PEER" true 2>/dev/null || die "ssh $PEER failed (needs key auth)"
read -r LOCAL_ID LOCAL_LAN LOCAL_RAILS <<<"$(bash -c "$probe")"
read -r PEER_ID PEER_LAN PEER_RAILS <<<"$(ssh "$PEER" "$probe")"
[[ -n $LOCAL_LAN && -n $PEER_LAN ]] || die "could not find the LAN IPs ($LOCAL_ID: '$LOCAL_LAN', $PEER_ID: '$PEER_LAN')"
peers_of() { local id=$1 out="" ip; shift; for ip in "$@"; do out+="${out:+,}$id=$ip"; done; printf '%s' "$out"; }
# shellcheck disable=SC2086 # word splitting of the rail lists is intended
LOCAL_PEERS=$(peers_of "$PEER_ID" $PEER_RAILS)
# shellcheck disable=SC2086
PEER_PEERS=$(peers_of "$LOCAL_ID" $LOCAL_RAILS)
NODES="$LOCAL_ID=http://$LOCAL_LAN:9750,$PEER_ID=http://$PEER_LAN:9750"
printf '    %-8s LAN %-15s rails %s\n' "$LOCAL_ID" "$LOCAL_LAN" "${LOCAL_RAILS:-none}" "$PEER_ID" "$PEER_LAN" "${PEER_RAILS:-none}"

flags=(--yes)
[[ $DRY_RUN == 1 ]] && flags=(--dry-run)
agent_flags=("${flags[@]}")
[[ $BENCH == 1 ]] && agent_flags+=(--enable-benchmarks)
SUDO=(sudo)
[[ $DRY_RUN == 1 ]] && SUDO=()

if [[ $DRY_RUN == 0 && $YES == 0 ]]; then
	echo
	echo "This installs sparkline-agent on $LOCAL_ID and $PEER_ID and the console on $LOCAL_ID (http://$LOCAL_LAN:9700)."
	[[ $BENCH == 1 ]] && echo "Benchmarks are enabled: the agents join the docker group, which is root-equivalent (--no-benchmarks to skip)."
	read -rp "Continue? [y/N] " answer
	[[ $answer == [yY]* ]] || die "cancelled"
fi

# One agent token for every node and the console: reuse this node's if already installed.
SPARKLINE_AGENT_TOKEN=""
if [[ $DRY_RUN == 0 ]] && sudo test -f /etc/sparkline/agent.toml; then
	SPARKLINE_AGENT_TOKEN=$(sudo sed -n 's/^token = "\(.*\)"$/\1/p' /etc/sparkline/agent.toml)
fi
[[ -n $SPARKLINE_AGENT_TOKEN ]] || SPARKLINE_AGENT_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
export SPARKLINE_AGENT_TOKEN

say "Agent on $LOCAL_ID"
"${SUDO[@]}" ${SUDO:+--preserve-env=SPARKLINE_AGENT_TOKEN} "$REPO/deploy/install.sh" agent "${agent_flags[@]}" \
	${LOCAL_PEERS:+--peers "$LOCAL_PEERS"}

say "Agent on $PEER_ID (copying the installer to ~/$REMOTE_DIR there)"
ssh "$PEER" "mkdir -p ~/$REMOTE_DIR"
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude node_modules --exclude var --exclude web \
	--exclude .git "$REPO/" "$PEER:$REMOTE_DIR/"
# The token goes over ssh stdin into a private file, never onto a command line.
ssh "$PEER" "umask 077; mkdir -p ~/$REMOTE_DIR/var && cat > ~/$REMOTE_DIR/var/.agent_token" <<<"$SPARKLINE_AGENT_TOKEN"
remote_sudo="sudo --preserve-env=SPARKLINE_AGENT_TOKEN"
[[ $DRY_RUN == 1 ]] && remote_sudo=""
# shellcheck disable=SC2029 # expanded locally on purpose
ssh -t "$PEER" "cd ~/$REMOTE_DIR && SPARKLINE_AGENT_TOKEN=\$(cat var/.agent_token) && rm -f var/.agent_token \
	&& export SPARKLINE_AGENT_TOKEN && $remote_sudo ./deploy/install.sh agent ${agent_flags[*]} \
	${PEER_PEERS:+--peers $PEER_PEERS}"

say "Console on $LOCAL_ID"
"${SUDO[@]}" ${SUDO:+--preserve-env=SPARKLINE_AGENT_TOKEN} "$REPO/deploy/install.sh" console "${flags[@]}" --nodes "$NODES"
