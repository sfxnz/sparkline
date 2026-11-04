from __future__ import annotations

import json
from dataclasses import replace
from typing import ClassVar, get_args

import pytest
from platforms import GB10, gb10, gb10_without
from test_capabilities import assert_every_metric_is_reported_or_declared, warm

from sparkline.agent.collectors import GpuField
from sparkline.agent.collectors.gpu import CHAINS, GpuCollector
from sparkline.agent.collectors.gpu.backend import CannotOpen, Chain, Gap, NoDevice
from sparkline.agent.collectors.gpu.nvml import Nvml
from sparkline.agent.sources import NvmlReplay, Sources
from sparkline.common.metrics import flatten
from sparkline.common.schema import GpuInfo, GpuSample, NodeInfo, Unsupported


class Opens:
    name: ClassVar[str] = "opens"
    gpus: ClassVar[tuple[str, ...]] = ("Fake GPU",)
    gaps: ClassVar[dict[GpuField, Gap]] = {}
    labels: ClassVar[dict[str, str]] = {}
    mem: ClassVar[dict[int, dict[int, int]]] = {}
    util: ClassVar[dict[int, float] | None] = None

    def __init__(self, src: Sources) -> None:
        pass

    def open(self) -> list[GpuInfo]:
        return [GpuInfo(index=i, name=n, power_limit_w=300.0) for i, n in enumerate(self.gpus)]

    def caps(self) -> dict[int, dict[GpuField, Gap | None]]:
        return {i: {**dict.fromkeys(get_args(GpuField)), **self.gaps} for i in range(len(self.gpus))}

    def versions(self) -> dict[str, str]:
        return self.labels

    def sample(self) -> list[GpuSample]:
        return [
            GpuSample(
                index=i,
                util=50.0,
                sm_mhz=1500.0,
                temp_c=60.0,
                power_w=100.0,
                energy_j=1000.0,
                throttle_mask=0,
                power_capped_pct=0.0,
                thermal_capped_pct=0.0,
            )
            for i in range(len(self.gpus))
        ]

    def proc_mem(self) -> dict[int, dict[int, int]]:
        return self.mem

    def proc_util(self) -> dict[int, float] | None:
        return self.util

    def close(self) -> None:
        pass


class NvidiaFake(Opens):
    name = "nvidia-fake"
    labels = {"Driver": "999.0"}
    mem = {0: {100: 1000, 200: 5}}
    util = {100: 10.0}


class AmdFake(Opens):
    name = "amd-fake"
    gpus = ("AMD A", "AMD B")
    gaps = {"fan_pct": Gap("No fan on this card")}
    labels = {"Driver": "1.2.3"}
    mem = {0: {100: 24}, 1: {300: 7}}
    util = {100: 30.0}


def fails(backend: str, error: Exception) -> type[Opens]:
    def open_(self: Opens) -> list[GpuInfo]:
        raise error

    return type(backend, (Opens,), {"name": backend, "open": open_})


class KfdDenied(Opens):
    name = "kfd"

    def __init__(self, src: Sources) -> None:
        raise PermissionError(13, "Permission denied", "/dev/kfd")


def nvml_init_fails(text: str) -> Sources:
    calls = json.loads((GB10 / "nvml.json").read_text())
    return gb10(nvml=NvmlReplay({**calls, "nvmlInit": {"[]": {"__error__": 18, "str": text}}}))


def test_two_vendor_chains_concatenate_their_gpus_under_node_wide_indexes(monkeypatch):
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (NvidiaFake,)), Chain("amd", (AmdFake,))))
    info, sample, collectors = warm(monkeypatch, gb10())

    assert [(g.index, g.name, g.vendor, g.backend) for g in info.gpus] == [
        (0, "Fake GPU", "nvidia", "nvidia-fake"),
        (1, "AMD A", "amd", "amd-fake"),
        (2, "AMD B", "amd", "amd-fake"),
    ]
    assert [s.index for s in sample.gpu] == [0, 1, 2]
    assert {k for k in flatten(sample) if k.endswith(".util") and k.startswith("gpu")} == {
        "gpu0.util",
        "gpu1.util",
        "gpu2.util",
    }
    assert [u for u in info.unsupported if u.metric.startswith("gpu")] == [
        Unsupported(metric="gpu1.fan_pct", reason="No fan on this card"),
        Unsupported(metric="gpu2.fan_pct", reason="No fan on this card"),
    ]
    assert info.versions == {"nvidia.Driver": "999.0", "amd.Driver": "1.2.3"}
    assert (info.driver, info.cuda) == ("999.0", None)
    assert sample.mem.gpu == 1000 + 5 + 24 + 7
    assert collectors.gpu is not None
    assert collectors.gpu.proc_mem == {100: 1024, 200: 5, 300: 7}
    assert collectors.gpu.process_util() == {100: 20.0}
    assert_every_metric_is_reported_or_declared(info, sample)


def test_a_backend_that_cannot_open_is_named_in_gpu_backend_and_hides_no_gpu_that_opened(monkeypatch):
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (Nvml,)), Chain("amd", (AmdFake,))))
    info, sample, _ = warm(monkeypatch, nvml_init_fails("Driver/library version mismatch"))

    gaps = {u.metric: u for u in info.unsupported}
    assert gaps["gpu.backend.nvml"] == Unsupported(
        metric="gpu.backend.nvml",
        reason="NVML unavailable (NVML: Driver/library version mismatch)",
        kind="hardware",
    )
    assert "gpu*" not in gaps and "mem.gpu" not in gaps and "gpu.backend" not in gaps
    assert [(g.index, g.vendor) for g in info.gpus] == [(0, "amd"), (1, "amd")]
    assert {"gpu0.util", "gpu0.power_w", "gpu0.temp_c"} <= set(flatten(sample))
    assert info.versions == {"amd.Driver": "1.2.3"} and info.driver is None
    assert_every_metric_is_reported_or_declared(info, sample)


HW = fails("amd-hw", RuntimeError("ioctl failed"))
AGENT = fails("amd-agent", CannotOpen("Reads GFX9+ only; GFX8 is a follow-up", "agent"))
DEP = fails("amd-dep", CannotOpen("Install amdsmi", "dependency"))


def skipped(info: NodeInfo) -> list[tuple[str, str]]:
    return [(u.metric, u.kind) for u in info.unsupported if u.metric.startswith("gpu.backend")]


def test_each_skipped_backend_gets_its_own_entry_with_its_own_kind_and_reason_kept_whole(monkeypatch):
    monkeypatch.setitem(
        CHAINS,
        "linux",
        (
            Chain("nvidia", (fails("nvidia-absent", NoDevice("No NVIDIA GPU here")),)),
            Chain("amd", (HW, AGENT, DEP, KfdDenied, AmdFake)),
        ),
    )
    info, sample, _ = warm(monkeypatch, gb10())

    assert skipped(info) == [
        ("gpu.backend.amd-hw", "hardware"),
        ("gpu.backend.amd-agent", "agent"),
        ("gpu.backend.amd-dep", "dependency"),
        ("gpu.backend.kfd", "access"),
    ]
    gaps = {u.metric: u.reason for u in info.unsupported}
    assert gaps["gpu.backend.amd-agent"] == "Reads GFX9+ only; GFX8 is a follow-up"
    assert gaps["gpu.backend.amd-dep"] == "Install amdsmi"
    assert [g.backend for g in info.gpus] == ["amd-fake", "amd-fake"]
    assert_every_metric_is_reported_or_declared(info, sample)


def test_a_default_mac_names_the_helper_to_install_and_the_root_need_on_separate_rows(monkeypatch):
    macmon = fails("apple", CannotOpen("Install macmon (0.9.0 or later) for power and clocks", "dependency"))
    root = fails("powermetrics", CannotOpen("Needs root", "access"))

    class Ioreg(Opens):
        name = "ioreg"
        gpus = ("Test Apple GPU",)
        mem = {0: {100: 1}}

    monkeypatch.setitem(CHAINS, "darwin", (Chain("apple", (macmon, root, Ioreg)),))
    info, sample, _ = warm(monkeypatch, replace(gb10(), platform="darwin"))

    assert [(g.vendor, g.backend) for g in info.gpus] == [("apple", "ioreg")]
    assert skipped(info) == [("gpu.backend.apple", "dependency"), ("gpu.backend.powermetrics", "access")]
    assert_every_metric_is_reported_or_declared(info, sample)


def test_a_vendor_that_is_absent_leaves_no_gpu_backend_entry_once_a_gpu_opened(monkeypatch, tmp_path):
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (Nvml,)), Chain("amd", (AmdFake,))))
    info, _, _ = warm(monkeypatch, replace(gb10_without(tmp_path, "/proc/driver/nvidia"), nvml=None))

    assert [u.metric for u in info.unsupported if u.metric.startswith("gpu")] == [
        "gpu0.fan_pct",
        "gpu1.fan_pct",
    ]


NO_DRIVER = "No NVIDIA driver is loaded (/proc/driver/nvidia is missing)"


@pytest.mark.parametrize(
    ("src", "chains", "reason", "kind", "backend_gap", "entries"),
    [
        (
            lambda tmp: gb10(nvml=None),
            None,
            "nvml: Install nvidia-ml-py to read NVIDIA GPU metrics",
            "dependency",
            True,
            [("gpu.backend.nvml", "Install nvidia-ml-py to read NVIDIA GPU metrics", "dependency")],
        ),
        (
            lambda tmp: replace(gb10_without(tmp, "/proc/driver/nvidia"), nvml=None),
            None,
            f"nvml: {NO_DRIVER}",
            "hardware",
            False,
            [("gpu.backend.nvml", NO_DRIVER, "hardware")],
        ),
        (
            lambda tmp: replace(gb10_without(tmp, "/proc/driver/nvidia"), nvml=None),
            (Chain("nvidia", (Nvml,)), Chain("amd", (fails("amdgpu", NoDevice("No AMD GPU")),))),
            f"nvml: {NO_DRIVER}; amdgpu: No AMD GPU",
            "hardware",
            False,
            [("gpu.backend.nvml", NO_DRIVER, "hardware"), ("gpu.backend.amdgpu", "No AMD GPU", "hardware")],
        ),
        (
            lambda tmp: replace(gb10(), platform="darwin"),
            None,
            "No GPU backend reads darwin yet",
            "agent",
            True,
            [],
        ),
    ],
    ids=["nvidia-ml-py missing", "no NVIDIA driver", "neither vendor present", "darwin"],
)
def test_with_no_gpu_opened_the_gpu_gaps_agree_and_every_backend_tried_is_listed(
    src, chains, reason, kind, backend_gap, entries, monkeypatch, tmp_path
):
    if chains is not None:
        monkeypatch.setitem(CHAINS, "linux", chains)
    info, sample, _ = warm(monkeypatch, src(tmp_path))

    gaps = {u.metric: (u.reason, u.kind) for u in info.unsupported}
    assert gaps["gpu*"] == gaps["mem.gpu"] == (reason, kind)
    assert gaps.get("gpu.backend") == ((reason, kind) if backend_gap else None), (
        "gpu.backend says no backend is in use only when a GPU may be here"
    )
    listed = [(u.metric, u.reason, u.kind) for u in info.unsupported if u.metric.startswith("gpu.backend.")]
    assert listed == entries
    assert info.gpus == [] and sample.gpu == [] and info.versions == {}
    assert_every_metric_is_reported_or_declared(info, sample)


def test_an_agent_on_darwin_says_so_in_node_info(monkeypatch):
    info, _, _ = warm(monkeypatch, replace(gb10(), platform="darwin"))
    assert info.platform == "darwin"


class LeavesOutEcc(Opens):
    name = "partial"

    def caps(self) -> dict[int, dict[GpuField, Gap | None]]:
        return {0: {f: None for f in get_args(GpuField) if f != "ecc"}}


def test_a_field_a_backend_does_not_mention_is_declared_not_reported_by_that_backend(monkeypatch):
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (LeavesOutEcc,)),))
    gaps = {k: u for k, u in GpuCollector(gb10()).caps().items() if u}
    assert gaps == {
        "gpu0.ecc": Unsupported(metric="gpu0.ecc", reason="Not reported by the partial backend", kind="agent")
    }


class OpensNothing(Opens):
    name = "empty"
    gpus = ()


def test_a_backend_that_opens_with_no_gpu_counts_as_absent_and_the_chain_moves_on(monkeypatch):
    monkeypatch.setitem(CHAINS, "linux", (Chain("amd", (OpensNothing, AmdFake)),))
    g = GpuCollector(gb10())
    assert [(i.index, i.backend) for i in g.info] == [(0, "amd-fake"), (1, "amd-fake")]
    assert g.caps()["gpu.backend"] is None

    monkeypatch.setitem(CHAINS, "linux", (Chain("amd", (OpensNothing,)),))
    gap = GpuCollector(gb10()).caps()["gpu*"]
    assert (gap.reason, gap.kind) == ("empty: Opened, but found no GPU", "hardware")


def nvml_handles(count: int, **failing: str) -> Sources:
    """The GB10 recording as `count` GPUs sharing its one handle; `i<n>="text"` makes handle n fail."""
    calls = json.loads((GB10 / "nvml.json").read_text())
    handles = {f"[{i}]": calls["nvmlDeviceGetHandleByIndex"]["[0]"] for i in range(count)}
    handles |= {f"[{i[1:]}]": {"__error__": 15, "str": text} for i, text in failing.items()}
    return gb10(
        nvml=NvmlReplay({**calls, "nvmlDeviceGetCount": {"[]": count}, "nvmlDeviceGetHandleByIndex": handles})
    )


def test_nvml_that_sees_a_gpu_but_opens_none_keeps_the_versions_and_says_it_could_not_open_it(monkeypatch):
    info, sample, _ = warm(monkeypatch, nvml_handles(1, i0="GPU is lost"))

    assert (info.driver, info.cuda) == ("580.178.04", "13.0")
    assert info.versions == {
        "nvidia.Driver": "580.178.04",
        "nvidia.CUDA": "13.0",
        "nvidia.NVML": "13.580.178.04",
    }
    gaps = {u.metric: u for u in info.unsupported}
    assert gaps["gpu.backend.nvml"].kind == "hardware"
    assert (
        "could not open" in gaps["gpu.backend.nvml"].reason
        and "GPU is lost" in gaps["gpu.backend.nvml"].reason
    )
    assert gaps["gpu.backend"].reason == gaps["gpu*"].reason, "a GPU is here, so no backend in use is a gap"
    assert_every_metric_is_reported_or_declared(info, sample)


def test_a_lost_nvidia_gpu_stays_named_once_another_vendor_opens(monkeypatch):
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (Nvml,)), Chain("amd", (AmdFake,))))
    info, sample, _ = warm(monkeypatch, nvml_handles(1, i0="GPU is lost"))

    assert [g.vendor for g in info.gpus] == ["amd", "amd"]
    nvml = next(u for u in info.unsupported if u.metric == "gpu.backend.nvml")
    assert nvml.kind == "hardware" and "GPU is lost" in nvml.reason
    assert info.versions["nvidia.Driver"] == "580.178.04"
    assert_every_metric_is_reported_or_declared(info, sample)


def test_a_gpu_whose_handle_fails_keeps_its_nvml_index_and_says_so_instead_of_renumbering(monkeypatch):
    info, sample, _ = warm(monkeypatch, nvml_handles(3, i1="GPU is lost"))

    assert [(g.index, g.name) for g in info.gpus] == [(0, "NVIDIA GB10"), (1, "GPU 1"), (2, "NVIDIA GB10")]
    gaps = {u.metric: u for u in info.unsupported}
    lost = [u for k, u in gaps.items() if k.startswith("gpu1.")]
    assert len(lost) == len(get_args(GpuField))
    assert {(u.reason, u.kind) for u in lost} == {
        ("NVML could not open GPU 1 (NVML: GPU is lost)", "hardware")
    }
    assert not any(k.startswith(("gpu0.", "gpu2.")) and "could not open" in u.reason for k, u in gaps.items())
    flat = flatten(sample)
    assert "gpu0.util" in flat and "gpu2.util" in flat and not any(k.startswith("gpu1.") for k in flat)
    assert [s.index for s in sample.gpu] == [0, 1, 2]
    assert_every_metric_is_reported_or_declared(info, sample)


class Closes(Opens):
    """Records close(), as a backend that owns a child process (macmon) must be closed."""

    name = "closes"
    closed: ClassVar[list[str]] = []

    def close(self) -> None:
        self.closed.append(self.name)


def closes(name: str, **broken: Exception) -> type[Closes]:
    def raiser(e: Exception):
        def fn(self: Closes) -> object:
            raise e

        return fn

    return type(name, (Closes,), {"name": name, **{m: raiser(e) for m, e in broken.items()}})


def test_a_backend_abandoned_after_it_was_constructed_is_closed_and_one_in_use_is_not(monkeypatch):
    Closes.closed.clear()
    chain = (
        closes("caps-fails", caps=RuntimeError("bad caps")),
        closes("versions-fails", versions=RuntimeError("bad versions")),
        closes("open-fails", open=CannotOpen("Install macmon (0.9.0 or later)", "dependency")),
        type("empty", (Closes,), {"name": "empty", "gpus": ()}),
        Closes,
    )
    monkeypatch.setitem(CHAINS, "darwin", (Chain("apple", chain),))
    g = GpuCollector(replace(gb10(), platform="darwin"))

    assert [i.backend for i in g.info] == ["closes"]
    assert Closes.closed == ["caps-fails", "versions-fails", "open-fails", "empty"]


def test_closing_the_agent_closes_every_backend_in_use_once(monkeypatch):
    Closes.closed.clear()
    other = type("other", (Closes,), {"name": "other"})
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (Closes,)), Chain("amd", (other,))))
    _, _, collectors = warm(monkeypatch, gb10())

    collectors.close()
    collectors.close()
    assert Closes.closed == ["closes", "other"]


class Flaky(AmdFake):
    name = "flaky"
    broken: ClassVar[set[str]] = set()

    def sample(self) -> list[GpuSample]:
        if "sample" in self.broken:
            raise OSError(5, "Input/output error", "/sys/class/drm/card1/device/gpu_metrics")
        return super().sample()

    def proc_mem(self) -> dict[int, dict[int, int]]:
        if "proc_mem" in self.broken:
            raise RuntimeError("process list failed")
        return super().proc_mem()

    def proc_util(self) -> dict[int, float] | None:
        if "proc_util" in self.broken:
            raise RuntimeError("process utilisation failed")
        return super().proc_util()


@pytest.mark.parametrize("broken", [{"sample"}, {"proc_mem"}, {"sample", "proc_mem", "proc_util"}])
def test_one_backend_failing_a_tick_leaves_its_gpus_empty_and_the_other_vendor_reporting(broken, monkeypatch):
    monkeypatch.setattr(Flaky, "broken", broken)
    monkeypatch.setitem(CHAINS, "linux", (Chain("nvidia", (NvidiaFake,)), Chain("amd", (Flaky,))))
    _, sample, collectors = warm(monkeypatch, gb10())

    assert [(s.index, s.util) for s in sample.gpu] == [(0, 50.0)]
    assert not any(k.startswith(("gpu1.", "gpu2.")) for k in flatten(sample))
    assert "flaky" in sample.errors["gpu"] and "nvidia-fake" not in sample.errors["gpu"]
    assert sample.mem.gpu == 1000 + 5, "the backend that failed adds no process memory this tick"
    assert collectors.gpu is not None
    assert collectors.gpu.process_util() == ({100: 10.0} if "proc_util" in broken else {100: 20.0})
