"""Benchmark registry: params validation, BenchParam derivation, estimates, availability."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sparkline.agent.bench import probes
from sparkline.agent.bench.specs import (
    REGISTRY,
    GpuMatmulParams,
    LlmInferenceParams,
    StorageParams,
    bench_params,
    check_base_url,
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
    assert b.estimate(b.validate({"minutes": 30})) == pytest.approx(20 + 1800)
    s = REGISTRY["storage-fio"]
    assert s.estimate(s.validate({"runtime_s": 20})) > s.estimate(s.validate({}))
    g = REGISTRY["gpu-matmul"]
    assert g.estimate(g.validate({"sizes": ["4096"], "dtypes": ["bf16"]})) < g.estimate(g.validate({}))
    assert nccl_sizes("16")[0] == 8 and nccl_sizes("16")[-1] == 16 * 2**20


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
    env = probes.Env(rdma=P("no rails"))
    assert probes.availability("nccl-allreduce", env)[0].message == "no rails"
