"""Benchmark registry: params validation, BenchParam derivation, estimates, availability."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sparkline.agent.bench import probes
from sparkline.agent.bench.specs import (
    REGISTRY,
    GpuMatmulParams,
    LlmInferenceParams,
    LlmShowcaseParams,
    StorageParams,
    bench_params,
    check_base_url,
    levels,
    nccl_sizes,
    validation_message,
)
from sparkline.common.schema import Problem

IDS = [
    "gpu-matmul",
    "mem-bandwidth",
    "cpu-throughput",
    "nccl-allreduce",
    "rdma-bw-lat",
    "storage-fio",
    "llm-inference",
    "llm-showcase",
    "tool-eval",
    "thermal-soak",
]


def test_registry_ids_and_specs():
    assert list(REGISTRY) == IDS
    for b in REGISTRY.values():
        spec = b.spec({"n1": None})
        assert spec.est_duration_s > 0 and spec.description and spec.impact.note
        assert spec.params, b.id
        for prm in spec.params:  # defaults validate and every param is labelled
            assert prm.label and prm.help
        b.validate({})
        assert b.timeout_s(b.params()) == b.estimate(b.params()) * 3 + 120
    assert REGISTRY["nccl-allreduce"].min_nodes == REGISTRY["nccl-allreduce"].max_nodes == 2
    assert REGISTRY["rdma-bw-lat"].min_nodes == REGISTRY["rdma-bw-lat"].max_nodes == 2
    gm = REGISTRY["gpu-matmul"].impact
    assert (gm.thermal, gm.power, gm.disruptive) == ("high", "high", True)
    assert REGISTRY["gpu-matmul"].requires == ("docker", "pytorch_image")


def test_bench_params_derivation():
    ps = {p.name: p for p in bench_params(StorageParams)}
    assert ps["size_mib"].type == "int" and (ps["size_mib"].min, ps["size_mib"].max) == (64, 65536)
    assert ps["size_mib"].default == 4096 and ps["size_mib"].unit == "MiB"
    assert ps["runtime_s"].type == "float"
    assert ps["profiles"].type == "multi" and ps["profiles"].choices == [
        "seq_write",
        "seq_read",
        "rand_read",
        "rand_write",
    ]
    gm = {p.name: p for p in bench_params(GpuMatmulParams)}
    assert gm["fp8_scaling"].type == "enum" and gm["fp8_scaling"].choices == ["tensor", "row"]
    llm = {p.name: p for p in bench_params(LlmInferenceParams)}
    assert llm["base_url"].type == "string" and llm["concurrency"].max == 32


@pytest.mark.parametrize(
    "bench,params",
    [
        ("gpu-matmul", {"iterations": 5}),  # below min
        ("gpu-matmul", {"iterations": 1001}),
        ("gpu-matmul", {"sizes": ["1234"]}),  # not a choice
        ("gpu-matmul", {"sizes": []}),
        ("gpu-matmul", {"dtypes": ["bf16", "bf16"]}),
        ("gpu-matmul", {"evil": "; rm -rf /"}),  # unknown key
        ("storage-fio", {"size_mib": 32}),
        ("storage-fio", {"size_mib": 65537}),
        ("storage-fio", {"profiles": ["seq_read", "trim"]}),
        ("llm-inference", {"concurrency": 33}),
        ("llm-inference", {"model": "a b"}),
        ("llm-inference", {"model": "$(whoami)"}),
        ("llm-inference", {"model": "x" * 201}),
        ("llm-showcase", {"streams": 33}),
        ("llm-showcase", {"max_tokens": 63}),
        ("llm-showcase", {"max_tokens": 2049}),
        ("llm-showcase", {"temperature": 2.5}),
        ("llm-showcase", {"prompt_type": "poem"}),
        ("llm-showcase", {"model": "$(whoami)"}),
        ("llm-showcase", {"base_url": "http://8.8.8.8:8000"}),
        ("thermal-soak", {"minutes": 0}),
        ("thermal-soak", {"minutes": 61}),
        ("rdma-bw-lat", {"rail": "C"}),
        ("nccl-allreduce", {"max_size_mib": "2048"}),
        ("cpu-throughput", {"seconds_per_test": 0.1}),
        ("mem-bandwidth", {"side": "disk"}),
    ],
)
def test_invalid_params_rejected(bench, params):
    with pytest.raises(ValidationError) as e:
        REGISTRY[bench].validate(params)
    assert validation_message(e.value)


def test_unknown_key_message():
    with pytest.raises(ValidationError) as e:
        REGISTRY["cpu-throughput"].validate({"cmd": "ls"})
    assert validation_message(e.value) == "cmd: unknown parameter"


def test_valid_params_coerced():
    p = REGISTRY["llm-inference"].validate(
        {"base_url": "http://10.20.20.48:8000/v1/", "model": "Qwen/Qwen3-8B:fp8", "concurrency": 4}
    )
    assert p.base_url == "http://10.20.20.48:8000" and p.model == "Qwen/Qwen3-8B:fp8"


@pytest.mark.parametrize(
    "url,ok",
    [
        ("http://127.0.0.1:8000", "http://127.0.0.1:8000"),
        ("http://localhost:8000/v1", "http://localhost:8000"),
        ("https://192.168.1.5", "https://192.168.1.5"),
        ("http://10.20.20.195:30000/", "http://10.20.20.195:30000"),
        ("http://[::1]:8000", "http://[::1]:8000"),
        ("http://[fd00::5]:8000", "http://[fd00::5]:8000"),  # ULA
        ("http://169.254.169.254", None),  # link-local (cloud metadata)
        ("http://[fe80::1]:80", None),
        ("http://100.100.100.100", None),  # CGNAT (Tailscale's local service)
        ("http://100.100.1.2:30000", None),
        ("http://8.8.8.8:8000", None),  # public
        ("http://api.openai.com", None),  # hostname, could resolve anywhere
        ("ftp://10.0.0.1", None),
        ("file:///etc/passwd", None),
        ("http://user:pw@10.0.0.1", None),
        ("http://10.0.0.1/?x=1", None),
        ("http://10.0.0.1:99999", None),
        ("http://10.0.0.1/a b", None),
        ("10.0.0.1:8000", None),
        ("http://127.0.0.1:9750", None),  # the agent itself
        ("http://127.0.0.1:22/x", None),  # SSH
        ("http://10.20.20.48:9700/api", None),  # the console
        ("http://127.0.0.1:2375", None),  # Docker API
    ],
)
def test_base_url_privacy(url, ok):
    if ok is None:
        with pytest.raises(ValueError):
            check_base_url(url)
    else:
        assert check_base_url(url) == ok


def test_estimates_scale_with_params():
    b = REGISTRY["thermal-soak"]
    assert b.estimate(b.validate({"minutes": 30})) == pytest.approx(8 + 1800)
    s = REGISTRY["storage-fio"]
    assert s.estimate(s.validate({"runtime_s": 20})) > s.estimate(s.validate({}))
    g = REGISTRY["gpu-matmul"]
    assert g.estimate(g.validate({"sizes": ["4096"], "dtypes": ["bf16"]})) < g.estimate(g.validate({}))
    assert nccl_sizes("16")[0] == 8 and nccl_sizes("16")[-1] == 16 * 2**20


def test_llm_sweep_levels_and_their_estimate():
    assert levels(32, True) == [1, 2, 4, 8, 16, 32] and levels(24, True) == [1, 2, 4, 8, 16, 24]
    assert levels(1, True) == [1] and levels(3, True) == [1, 2, 3] and levels(32, False) == [32]
    b = REGISTRY["llm-inference"]
    wave = 0.5 + 512 / 2000 + 128 / 20
    assert b.estimate(b.validate({})) == pytest.approx(5 + 8 * wave)  # as before sweeps
    assert b.estimate(b.validate({"concurrency": 32})) == pytest.approx(5 + wave)  # one request per stream
    # 8 requests at 1, 2, 4 and 8 streams, then one per stream at 16 and 32: 8 + 4 + 2 + 1 + 1 + 1 waves
    assert b.estimate(b.validate({"concurrency": 32, "sweep": True})) == pytest.approx(5 + 17 * wave)
    sweep = {p.name: p for p in bench_params(LlmInferenceParams)}["sweep"]
    assert (sweep.type, sweep.default, sweep.label) == ("bool", False, "Sweep concurrency")
    with pytest.raises(ValidationError):
        b.validate({"sweep": "sometimes"})


def test_llm_showcase_params_and_estimate():
    b = REGISTRY["llm-showcase"]
    assert (b.category, b.impact.note) == ("inference", REGISTRY["llm-inference"].impact.note)
    ps = {p.name: p for p in bench_params(LlmShowcaseParams)}
    assert list(ps) == [
        "base_url",
        "model",
        "streams",
        "prompt_type",
        "max_tokens",
        "fill_to_max",
        "temperature",
        "thinking",
    ]
    assert (ps["streams"].default, ps["streams"].min, ps["streams"].max) == (4, 1, 32)
    assert ps["prompt_type"].choices == ["text", "structural", "mixed"]
    assert (ps["max_tokens"].min, ps["max_tokens"].max, ps["max_tokens"].unit) == (64, 2048, "tokens")
    assert (ps["temperature"].type, ps["temperature"].default, ps["temperature"].max) == ("float", 0.7, 2)
    assert (ps["fill_to_max"].default, ps["thinking"].default) == (True, False)
    assert b.estimate(b.validate({})) == pytest.approx(5 + 512 / 20)
    assert b.estimate(b.validate({"streams": 9, "max_tokens": 2048})) == pytest.approx(5 + 2048 / 20 * 3)
    p = b.validate({"base_url": "http://10.20.20.48:8000/v1", "temperature": 0})
    assert p.base_url == "http://10.20.20.48:8000" and p.temperature == 0


def P(msg: str) -> Problem:
    return Problem(message=msg, cause="c", fix="f")


def test_availability_mapping():
    env = probes.Env()
    assert all(probes.availability(i, env)[0] is None for i in IDS)
    assert "fio is not installed" in probes.availability("storage-fio", env)[1]
    assert "torch.distributed" in probes.availability("nccl-allreduce", env)[1]
    env = probes.Env(image=P("image"), perftest=P("perftest"), fio="/usr/bin/fio")
    assert probes.availability("gpu-matmul", env)[0].message == "image"
    assert probes.availability("thermal-soak", env)[0].message == "image"
    assert probes.availability("rdma-bw-lat", env)[0].message == "perftest"
    assert probes.availability("storage-fio", env) == (None, "")
    assert probes.availability("cpu-throughput", env)[0] is None
    assert probes.availability("llm-inference", env)[0] is None
    assert probes.availability("llm-showcase", env)[0] is None
    assert probes.availability("tool-eval", env)[0] is None
    assert probes.availability("tool-eval", probes.Env(tool_eval=P("no package")))[0].message == "no package"
    env = probes.Env(rdma=P("no rails"))
    assert probes.availability("nccl-allreduce", env)[0].message == "no rails"
    env = probes.Env(cpu_cap=P("capped"))
    for i in ("cpu-throughput", "llm-inference", "llm-showcase", "tool-eval", "storage-fio", "rdma-bw-lat"):
        assert probes.availability(i, env)[0].message == "capped"
    for i in ("gpu-matmul", "thermal-soak", "mem-bandwidth", "nccl-allreduce"):  # in containers
        assert probes.availability(i, env)[0] is None


def test_cpu_quota_reads_own_cgroup(tmp_path):
    (tmp_path / "self").mkdir()
    (tmp_path / "self" / "cgroup").write_text("0::/system.slice/sparkline-agent.service\n")
    cg = tmp_path / "cg" / "system.slice" / "sparkline-agent.service"
    cg.mkdir(parents=True)
    (cg / "cpu.max").write_text("50000 100000\n")
    assert probes.cpu_quota(str(tmp_path), str(tmp_path / "cg")) == 0.5
    (cg / "cpu.max").write_text("max 100000\n")
    assert probes.cpu_quota(str(tmp_path), str(tmp_path / "cg")) is None
    assert probes.cpu_quota(str(tmp_path / "nope"), str(tmp_path / "cg")) is None
