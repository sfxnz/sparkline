"""Hardware checks; skipped unless run on a DGX Spark with a cabled CX7 port."""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from sparkline.agent.ethtool import EthtoolStats

IFACE = "enp1s0f1np1"
WANTED = ["rx_bytes_phy", "tx_bytes_phy", "rx_discards_phy", "tx_discards_phy", "rx_crc_errors_phy"]

pytestmark = pytest.mark.skipif(
    not (os.path.exists(f"/sys/class/net/{IFACE}") and shutil.which("ethtool")), reason="needs a CX7 port"
)


def test_ioctl_matches_ethtool_cli():
    e = EthtoolStats(IFACE, WANTED)
    before = e.read()
    out = subprocess.run(["ethtool", "-S", IFACE], capture_output=True, text=True, check=True).stdout
    after = e.read()
    cli = {
        k.strip(): int(v) for k, _, v in (line.partition(":") for line in out.splitlines()[1:]) if v.strip()
    }
    for k in WANTED:
        assert before[k] <= cli[k] <= after[k], k  # counters only grow; the CLI read lands in between
