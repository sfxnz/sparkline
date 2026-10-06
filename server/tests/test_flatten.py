import pytest

from sparkline.common.metrics import flatten, mount_key
from sparkline.common.schema import (
    CpuSample,
    DiskSample,
    FsSample,
    GpuSample,
    MemSample,
    NetSample,
    Sample,
    TempSample,
)


def make_sample() -> Sample:
    return Sample(
        node_id="spark1",
        ts=1.0,
        seq=1,
        interval_ms=1000,
        gpu=[
            GpuSample(index=0, util=90, sm_mhz=2171, temp_c=68, power_w=33.5, energy_j=1e6, throttle_mask=4)
        ],
        mem=MemSample(
            total=100,
            available=40,
            used=60,
            free=10,
            gpu=None,
            anon=20,
            cache=25,
            shmem=5,
            kernel=5,
            other=30,
            swap_total=16,
            swap_used=4,
            psi_some=0.5,
        ),
        cpu=CpuSample(
            util=10, perf_util=15, per_core=[5, 15], freq_mhz=[2808, None], load1=1, load5=1, load15=1
        ),
        net=[NetSample(name="enp1s0f1np1", up=False, rx_bps=0, tx_bps=0)],
        disk=[DiskSample(name="nvme0n1", read_bps=1, write_bps=2, read_iops=3, write_iops=4, busy_pct=5)],
        fs=[FsSample(mount="/", key="root", device="/dev/nvme0n1p2", total=200, used=50, free=100)],
        temps=[TempSample(id="acpitz.0", c=70.0), TempSample(id="nvme.composite", c=None)],
    )


def test_flatten_keys_and_values():
    f = flatten(make_sample())
    assert f["gpu0.util"] == 90 and f["gpu0.throttle_mask"] == 4 and f["gpu0.energy_j"] == 1e6
    assert f["mem.used_pct"] == 60 and f["mem.psi_some"] == 0.5
    assert f["cpu.core1.util"] == 15 and f["cpu.core0.mhz"] == 2808
    assert f["net.enp1s0f1np1.up"] == 0.0
    assert f["disk.nvme0n1.busy_pct"] == 5
    assert f["fs.root.used_pct"] == pytest.approx(100 * 50 / 150)  # df-style: reserved blocks count as used
    assert f["temp.acpitz.0"] == 70.0


def test_flatten_omits_none():
    f = flatten(make_sample())
    for k in (
        "mem.gpu",
        "gpu0.pstate",
        "gpu0.power_capped_pct",
        "cpu.eff_util",
        "cpu.core1.mhz",
        "temp.nvme.composite",
        "mem.psi_full",
    ):
        assert k not in f


def test_mount_key():
    assert mount_key("/") == "root" and mount_key("/data/models") == "data_models"
