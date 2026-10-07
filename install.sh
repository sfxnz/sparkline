#!/usr/bin/env bash
# One-command setup per node, from the repo root:
#   sudo ./install.sh agent [--enable-benchmarks]      sudo ./install.sh console --nodes ...
# The installer itself lives in deploy/install.sh (with the systemd units it installs); see --help.
exec "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/deploy/install.sh" "$@"
