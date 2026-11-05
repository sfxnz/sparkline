from __future__ import annotations

from dataclasses import replace

import pytest
from platforms import gb10_without
from test_agent_bench_runner import RTX, amd_info, mac_info, node_info, workstation_info, ws_uuid
from test_capabilities import warm

from sparkline.agent.bench.probes import GpuTarget, gpu_options, gpu_problem, resolve_gpu
from sparkline.agent.collectors.gpu.nvml import NO_DRIVER
from sparkline.common.schema import GpuOption, Problem

NVIDIA_SMI = "Check `nvidia-smi` on ws1, then restart sparkline-agent"
NEED = "GPU benchmarks need an NVIDIA GPU"


def test_gb10_and_other_single_gpu_nodes_offer_no_choice():
    assert gpu_options("spark1", node_info()) == []
    assert gpu_options("ws2", amd_info()) == []
    assert gpu_options("mac1", mac_info()) == []


def test_a_workstation_offers_every_nvidia_gpu_by_index_and_says_why_a_lost_one_is_blocked():
    assert gpu_options("ws1", workstation_info()) == [
        GpuOption(index=i, name=RTX, uuid=ws_uuid(i)) for i in range(4)
    ]
    lost = gpu_options("ws1", workstation_info({2: "NVML: Unknown Error"}))
    assert [(o.index, o.problem is None) for o in lost] == [(0, True), (1, True), (2, False), (3, True)]
    assert lost[2].problem == Problem(
        message="GPU 2 on ws1 is not responding", cause="NVML: Unknown Error", fix=NVIDIA_SMI
    )


def test_options_follow_gpu_index_not_list_order():
    info = workstation_info()
    info.gpus.reverse()
    assert [o.index for o in gpu_options("ws1", info)] == [0, 1, 2, 3]


def test_gpu_benchmarks_run_wherever_an_nvidia_gpu_responds():
    assert gpu_problem("spark1", node_info()) is None
    assert gpu_problem("ws1", workstation_info()) is None
    assert gpu_problem("ws1", workstation_info({0: "lost", 1: "lost", 3: "lost"})) is None


def test_a_linux_node_without_gpus_keeps_todays_problem():
    assert gpu_problem("spark1", node_info().model_copy(update={"gpus": []})) == Problem(
        message="No NVIDIA GPU detected on spark1",
        cause="NVML reported no GPUs when the agent started",
        fix="Check `nvidia-smi` on spark1, then restart sparkline-agent",
    )


def test_a_linux_node_without_an_nvidia_driver_is_told_gpu_benchmarks_need_one_not_to_check_nvidia_smi(
    monkeypatch, tmp_path
):
    info, _, _ = warm(monkeypatch, replace(gb10_without(tmp_path, "/proc/driver/nvidia"), nvml=None))
    assert info.platform == "linux" and info.gpus == []
    p = gpu_problem("ws2", info)
    assert p is not None and p.message == NEED and NO_DRIVER in p.cause
    assert "nvidia-smi" not in p.fix and "ws2" in p.fix


def test_every_nvidia_gpu_lost_names_each_reason():
    p = gpu_problem("ws1", workstation_info({i: f"NVML: GPU is lost ({i})" for i in range(4)}))
    assert p is not None and p.message == "No NVIDIA GPU responds on ws1" and p.fix == NVIDIA_SMI
    assert all(f"GPU {i}: NVML: GPU is lost ({i})" in p.cause for i in range(4))


def test_an_amd_node_is_told_gpu_benchmarks_need_nvidia_and_why():
    p = gpu_problem("ws2", amd_info())
    assert p is not None and p.message == NEED
    assert "AMD Radeon 8060S" in p.cause and "an AMD GPU" in p.cause
    assert "CUDA in NVIDIA's PyTorch container" in p.cause
    assert "AMD GPUs (ROCm) yet" in p.fix


def test_a_mac_is_told_gpu_benchmarks_need_nvidia_in_its_agents_own_words():
    p = gpu_problem("mac1", mac_info())
    assert p is not None and p.message == NEED
    assert "mac1 is a Mac" in p.cause and '"No GPU backend reads darwin yet"' in p.cause
    assert "Apple GPUs yet" in p.fix


def test_gb10_runs_on_all_its_gpus_whatever_was_asked():
    gb10 = node_info()
    assert resolve_gpu("spark1", gb10, None) == GpuTarget(gb10.gpus[0], pinned=False)
    assert resolve_gpu("spark1", gb10, 0) == GpuTarget(gb10.gpus[0], pinned=False)
    assert GpuTarget(gb10.gpus[0], pinned=False).docker_gpus == "all"


def test_a_workstation_pins_the_asked_gpu_or_the_first_that_responds():
    ws1 = workstation_info({0: "NVML: Unknown Error"})
    asked = resolve_gpu("ws1", ws1, 2)
    assert isinstance(asked, GpuTarget) and (asked.gpu.index, asked.docker_gpus) == (
        2,
        f"device={ws_uuid(2)}",
    )
    first = resolve_gpu("ws1", ws1, None)
    assert isinstance(first, GpuTarget) and (first.gpu.index, first.docker_gpus) == (
        1,
        f"device={ws_uuid(1)}",
    )


def without_uuid(info, *indices: int):
    gpus = [g.model_copy(update={"uuid": None}) if g.index in indices else g for g in info.gpus]
    return info.model_copy(update={"gpus": gpus})


def test_a_workstation_gpu_without_a_uuid_cannot_be_pinned_so_is_blocked_and_refused():
    ws1 = without_uuid(workstation_info({0: "NVML: Unknown Error"}), 1)
    opts = {o.index: o for o in gpu_options("ws1", ws1)}
    assert opts[1].uuid is None and opts[1].problem is not None and opts[1].problem.fix == NVIDIA_SMI
    assert [i for i, o in opts.items() if o.problem is None] == [2, 3]
    refused = resolve_gpu("ws1", ws1, 1)
    assert isinstance(refused, Problem) and refused == opts[1].problem
    first = resolve_gpu("ws1", ws1, None)
    assert isinstance(first, GpuTarget) and first.docker_gpus == f"device={ws_uuid(2)}"


def test_a_workstation_where_no_gpu_can_be_pinned_cannot_run_gpu_benchmarks():
    ws1 = without_uuid(workstation_info({0: "NVML: Unknown Error"}), 1, 2, 3)
    p = gpu_problem("ws1", ws1)
    assert p is not None and p.fix == NVIDIA_SMI and "GPU 0: NVML: Unknown Error" in p.cause
    assert resolve_gpu("ws1", ws1, None) == p


def test_gb10_without_a_uuid_still_runs_on_all_its_gpus():
    gb10 = without_uuid(node_info(), 0)
    assert gpu_problem("spark1", gb10) is None and gpu_options("spark1", gb10) == []
    target = resolve_gpu("spark1", gb10, None)
    assert isinstance(target, GpuTarget) and target.docker_gpus == "all"


@pytest.mark.parametrize(
    ("info", "node", "asked", "message"),
    [
        (workstation_info(), "ws1", 9, "GPU 9 is not a GPU of ws1"),
        (workstation_info({2: "NVML: Unknown Error"}), "ws1", 2, "GPU 2 on ws1 is not responding"),
        (node_info(), "spark1", 1, "GPU 1 is not a GPU of spark1"),
        (amd_info(), "ws2", 0, NEED),
        (amd_info(), "ws2", None, NEED),
        (mac_info(), "mac1", None, NEED),
    ],
)
def test_a_gpu_that_cannot_run_the_benchmark_is_refused_with_why(info, node, asked, message):
    p = resolve_gpu(node, info, asked)
    assert isinstance(p, Problem) and p.message == message


def test_a_refused_index_lists_the_gpus_there_are():
    p = resolve_gpu("ws1", workstation_info(), 9)
    assert isinstance(p, Problem) and p.cause == "ws1's NVIDIA GPUs are 0, 1, 2, 3"
