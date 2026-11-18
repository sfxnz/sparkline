"""GET /metrics: the console's live state as Prometheus text format 0.0.4."""

from __future__ import annotations

import fnmatch
import math
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from platforms import AMD_THREADRIPPER, GB10, INTEL_HYBRID
from starlette.websockets import WebSocketDisconnect

from sparkline.agent.collectors.prom import parse_exposition
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import Collectors
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import recorded
from sparkline.common.metrics import flatten
from sparkline.common.schema import (
    LLM_FIELDS,
    CpuSample,
    DiskSample,
    FsSample,
    GpuSample,
    LoadedModel,
    MemSample,
    ModelServerSample,
    NetSample,
    NodeState,
    Sample,
    TempSample,
)
from sparkline.console import main as console_main
from sparkline.console.app import LOGIN_LIMIT, create_app
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo_fleets import FLEETS
from sparkline.console.nodes import NodeSource
from sparkline.console.prometheus import (
    EXPORTED,
    MODEL_SERVER_INFO,
    NODE_LAST_SAMPLE,
    NODE_UP,
    NOT_EXPORTED,
    family_for,
    render,
)

REPO = Path(__file__).parents[2]
T0 = 1_791_000_000.0
GIB = 1 << 30


def node(node_id: str = "spark1", status: str = "online", last: float | None = T0) -> NodeState:
    return NodeState.model_validate(
        {
            "node_id": node_id,
            "url": "http://agent:9750",
            "status": status,
            "since": T0,
            "last_sample_ts": last,
        }
    )


def one_of_each(node_id: str = "spark1", **changes: object) -> Sample:
    s = Sample(
        node_id=node_id,
        ts=T0,
        seq=1,
        interval_ms=1000,
        gpu=[
            GpuSample(
                index=0,
                util=81.1,
                sm_mhz=2205,
                temp_c=65,
                power_w=30.5,
                energy_j=7305871.7,
                throttle_mask=4,
                power_capped_pct=12.5,
                thermal_capped_pct=0,
                shared_used=80 * GIB,
            ),
            GpuSample(index=1, vram_used=24 * GIB),
        ],
        mem=MemSample(
            total=128 * GIB,
            available=32 * GIB,
            used=96 * GIB,
            free=GIB,
            gpu=80 * GIB,
            anon=5 * GIB,
            cache=18 * GIB,
            shmem=2 * GIB,
            kernel=3 * GIB,
            other=6 * GIB,
            swap_total=16 * GIB,
            swap_used=4 * GIB,
            psi_some=8.5,
            psi_full=2.5,
        ),
        cpu=CpuSample(
            util=28.5,
            perf_util=48,
            eff_util=8.5,
            per_core=[5.5, 93.5],
            freq_mhz=[2106, None],
            load1=5.91,
            load5=3.97,
            load15=5.57,
            psi_some=1.5,
        ),
        net=[NetSample(name="enp1s0f1np1", up=True, rx_bps=1.5e9, tx_bps=2.5e8, errors=3, drops=1)],
        disk=[
            DiskSample(
                name="nvme0n1", read_bps=1e6, write_bps=2e7, read_iops=38, write_iops=1238, busy_pct=2.5
            )
        ],
        fs=[FsSample(mount="/", key="root", device="/dev/nvme0n1p2", total=4000, used=3000, free=600)],
        temps=[TempSample(id="nvme.composite", c=47.5), TempSample(id="acpitz.0", c=None)],
        cpu_temp_c=59.5,
        llm=[
            ModelServerSample(
                port=8001,
                adapter="prometheus",
                software="vLLM",
                version="0.9.2",
                models=[LoadedModel(name="Qwen/Qwen3-32B")],
                values={
                    "up": 1,
                    "running": 2,
                    "waiting": 1,
                    "kv_cache_pct": 18.5,
                    "gen_tps": 73.3,
                    "prompt_tps": 538.2,
                    "preempt_per_s": 0.5,
                    "ttft_p50_s": 0.235,
                    "ttft_p95_s": 0.729,
                    "mem_bytes": 61 * GIB,
                },
            )
        ],
    )
    return s.model_copy(update=changes)


def series(text: str) -> dict[tuple[str, tuple[tuple[str, str], ...]], float]:
    out = {}
    for name, rows in parse_exposition(text).items():
        for row in rows:
            assert (name, row.labels) not in out, f"{name}{dict(row.labels)} is exported twice"
            out[name, row.labels] = row.value
    return out


def test_every_reading_is_exported_under_its_base_unit_with_the_labels_its_key_carries():
    n, gpu0, gpu1 = ("node", "spark1"), ("gpu", "0"), ("gpu", "1")
    iface, disk, fs, port = ("iface", "enp1s0f1np1"), ("disk", "nvme0n1"), ("fs", "root"), ("port", "8001")
    assert series(render([node()], [one_of_each()])) == pytest.approx(
        {
            ("sparkline_node_up", (n,)): 1,
            ("sparkline_node_last_sample_timestamp_seconds", (n,)): T0,
            ("sparkline_gpu_utilization_ratio", (n, gpu0)): 0.811,
            ("sparkline_gpu_sm_clock_hertz", (n, gpu0)): 2.205e9,
            ("sparkline_gpu_temperature_celsius", (n, gpu0)): 65,
            ("sparkline_gpu_power_watts", (n, gpu0)): 30.5,
            ("sparkline_gpu_energy_joules_total", (n, gpu0)): 7305871.7,
            ("sparkline_gpu_throttle_mask", (n, gpu0)): 4,
            ("sparkline_gpu_power_capped_ratio", (n, gpu0)): 0.125,
            ("sparkline_gpu_thermal_capped_ratio", (n, gpu0)): 0,
            ("sparkline_gpu_shared_memory_used_bytes", (n, gpu0)): 80 * GIB,
            ("sparkline_gpu_vram_used_bytes", (n, gpu1)): 24 * GIB,
            ("sparkline_memory_used_bytes", (n,)): 96 * GIB,
            ("sparkline_memory_available_bytes", (n,)): 32 * GIB,
            ("sparkline_memory_gpu_bytes", (n,)): 80 * GIB,
            ("sparkline_memory_anon_bytes", (n,)): 5 * GIB,
            ("sparkline_memory_cache_bytes", (n,)): 18 * GIB,
            ("sparkline_memory_shmem_bytes", (n,)): 2 * GIB,
            ("sparkline_memory_kernel_bytes", (n,)): 3 * GIB,
            ("sparkline_memory_other_bytes", (n,)): 6 * GIB,
            ("sparkline_memory_swap_used_bytes", (n,)): 4 * GIB,
            ("sparkline_memory_pressure_some_ratio", (n,)): 0.085,
            ("sparkline_memory_pressure_full_ratio", (n,)): 0.025,
            ("sparkline_memory_used_ratio", (n,)): 0.75,
            ("sparkline_cpu_utilization_ratio", (n,)): 0.285,
            ("sparkline_cpu_performance_cores_utilization_ratio", (n,)): 0.48,
            ("sparkline_cpu_efficiency_cores_utilization_ratio", (n,)): 0.085,
            ("sparkline_load1", (n,)): 5.91,
            ("sparkline_load5", (n,)): 3.97,
            ("sparkline_load15", (n,)): 5.57,
            ("sparkline_cpu_pressure_some_ratio", (n,)): 0.015,
            ("sparkline_cpu_temperature_celsius", (n,)): 59.5,
            ("sparkline_cpu_core_utilization_ratio", (n, ("core", "0"))): 0.055,
            ("sparkline_cpu_core_utilization_ratio", (n, ("core", "1"))): 0.935,
            ("sparkline_cpu_core_frequency_hertz", (n, ("core", "0"))): 2.106e9,
            ("sparkline_network_receive_bytes_per_second", (n, iface)): 1.5e9,
            ("sparkline_network_transmit_bytes_per_second", (n, iface)): 2.5e8,
            ("sparkline_network_up", (n, iface)): 1,
            ("sparkline_disk_read_bytes_per_second", (n, disk)): 1e6,
            ("sparkline_disk_write_bytes_per_second", (n, disk)): 2e7,
            ("sparkline_disk_reads_per_second", (n, disk)): 38,
            ("sparkline_disk_writes_per_second", (n, disk)): 1238,
            ("sparkline_disk_busy_ratio", (n, disk)): 0.025,
            ("sparkline_filesystem_used_bytes", (n, fs)): 3000,
            ("sparkline_filesystem_size_bytes", (n, fs)): 4000,
            ("sparkline_filesystem_free_bytes", (n, fs)): 600,
            ("sparkline_filesystem_used_ratio", (n, fs)): 3000 / 3600,
            ("sparkline_sensor_temperature_celsius", (n, ("sensor", "nvme.composite"))): 47.5,
            ("sparkline_model_server_up", (n, port)): 1,
            ("sparkline_model_server_requests_running", (n, port)): 2,
            ("sparkline_model_server_requests_waiting", (n, port)): 1,
            ("sparkline_model_server_kv_cache_usage_ratio", (n, port)): 0.185,
            ("sparkline_model_server_generation_tokens_per_second", (n, port)): 73.3,
            ("sparkline_model_server_prompt_tokens_per_second", (n, port)): 538.2,
            ("sparkline_model_server_preemptions_per_second", (n, port)): 0.5,
            ("sparkline_model_server_time_to_first_token_p50_seconds", (n, port)): 0.235,
            ("sparkline_model_server_time_to_first_token_p95_seconds", (n, port)): 0.729,
            ("sparkline_model_server_memory_bytes", (n, port)): 61 * GIB,
            (
                "sparkline_model_server_info",
                (n, port, ("software", "vLLM"), ("version", "0.9.2"), ("model", "Qwen/Qwen3-32B")),
            ): 1,
        }
    )


def demo_samples() -> list[Sample]:
    models = [make(T0, 1.0) for nodes in FLEETS.values() for make in nodes.values()]
    return [m.sample_at(T0 + dt, seq=dt) for m in models for dt in range(0, 900, 7)]


def recorded_samples() -> list[Sample]:
    out = []
    for platform in (GB10, AMD_THREADRIPPER, INTEL_HYBRID):
        cfg = AgentConfig(node_id=platform.name)
        sampler = Sampler(cfg.node_id, Collectors(cfg, recorded(platform)).ordered(), ring_seconds=10)
        sampler.tick()
        out.append(sampler.tick())
    return out


def fixture_samples() -> list[Sample]:
    paths = ("server/tests/fixtures/console/sample.json", "web/src/test/fixtures/sample.json")
    return [Sample.model_validate_json((REPO / p).read_text()) for p in paths]


def test_every_flattened_key_is_exported_or_listed_as_not_exported_with_a_reason():
    keys = {k for s in demo_samples() + recorded_samples() + fixture_samples() for k in flatten(s)}
    assert len(keys) > 300
    silent = [
        k for k in keys if family_for(k) is None and not any(fnmatch.fnmatchcase(k, p) for p in NOT_EXPORTED)
    ]
    assert sorted(silent) == [], "add each key to EXPORTED, or to NOT_EXPORTED with the reason"
    assert all(reason.strip() for reason in NOT_EXPORTED.values())
    # NOT_EXPORTED's llm.*.* is for a field this console predates. A field it knows must have a family.
    assert [f for f in LLM_FIELDS if family_for(f"llm.8000.{f}") is None] == []


def test_exported_values_match_the_flattened_sample_on_every_demo_node():
    """Parsed back with the agent's own parser. The unit in a family's name says how its value relates to
    the flattened one."""
    for s in demo_samples()[::9]:
        flat = flatten(s)
        want: dict[str, list[float]] = {}
        for key, value in flat.items():
            family = family_for(key)
            if family is None:
                continue
            scale = 0.01 if family.endswith("_ratio") else 1e6 if family.endswith("_hertz") else 1.0
            want.setdefault(family, []).append(value * scale)
        got: dict[str, list[float]] = {}
        for (name, labels), value in series(render([node(s.node_id)], [s])).items():
            assert ("node", s.node_id) in labels
            if name in want:
                got.setdefault(name, []).append(value)
        assert {k: sorted(v) for k, v in got.items()} == {
            k: pytest.approx(sorted(v)) for k, v in want.items()
        }, s.node_id


_SAMPLE_LINE = re.compile(r'([a-z_0-9]+)\{(?:[a-z]+="(?:[^"\\\n]|\\[\\"n])*",?)+\} \S+')


def test_each_family_has_one_help_and_one_type_line_followed_by_all_of_its_samples():
    samples = [make(T0, 1.0).sample_at(T0 + 30) for make in FLEETS["mixed"].values()]
    text = render([node(s.node_id) for s in samples], samples)
    assert text.endswith("\n") and "\n\n" not in text
    lines = text.splitlines()
    seen: list[str] = []
    types = {}
    for i, line in enumerate(lines):
        if line.startswith("# HELP "):
            name, _, help_text = line.removeprefix("# HELP ").partition(" ")
            assert name not in seen and help_text, line
            seen.append(name)
            kind = lines[i + 1].removeprefix(f"# TYPE {name} ")
            assert kind in ("gauge", "counter"), lines[i + 1]
            types[name] = kind
        elif not line.startswith("# TYPE "):
            m = _SAMPLE_LINE.fullmatch(line)
            assert m and m[1] == seen[-1], line
    assert len(seen) > 50 and len(lines) > 3 * len(seen)
    assert {name for name, kind in types.items() if kind == "counter"} == {
        "sparkline_gpu_energy_joules_total"
    }
    assert text == render([node(s.node_id) for s in samples], samples)


def test_a_node_that_is_not_online_exports_only_that_it_is_down_and_when_it_last_sent_a_sample():
    nodes = [
        node("spark1", "online", T0),
        node("spark2", "stale", T0 - 6),
        node("spark3", "offline", T0 - 60),
        node("spark4", "connecting", None),
    ]
    got = series(render(nodes, [one_of_each(n.node_id) for n in nodes[:3]]))
    assert {labels[0][1]: v for (name, labels), v in got.items() if name == "sparkline_node_up"} == {
        "spark1": 1,
        "spark2": 0,
        "spark3": 0,
        "spark4": 0,
    }
    last = "sparkline_node_last_sample_timestamp_seconds"
    assert {labels[0][1]: v for (name, labels), v in got.items() if name == last} == {
        "spark1": T0,
        "spark2": T0 - 6,
        "spark3": T0 - 60,
    }
    others = {labels[0][1] for (name, labels) in got if not name.startswith("sparkline_node_")}
    assert others == {"spark1"}


def test_label_values_are_escaped():
    odd = 'a\\b"c\nd'
    s = one_of_each(
        odd,
        net=[NetSample(name=odd, up=True, rx_bps=0, tx_bps=0)],
        llm=[ModelServerSample(port=8000, adapter="prometheus", models=[LoadedModel(name=odd)])],
    )
    text = render([node(odd)], [s])
    escaped = r"a\\b\"c\nd"
    assert f'sparkline_network_up{{node="{escaped}",iface="{escaped}"}} 1' in text.splitlines()
    assert f'sparkline_model_server_info{{node="{escaped}",port="8000",model="{escaped}"}} 1' in text
    got = series(text)
    assert got["sparkline_network_up", (("node", odd), ("iface", odd))] == 1
    assert all(_SAMPLE_LINE.fullmatch(line) for line in text.splitlines() if line[0] != "#")


def test_values_that_are_not_finite_are_spelled_as_the_format_spells_them():
    gpu = GpuSample(index=0, temp_c=math.nan, power_w=math.inf, util=-math.inf)
    lines = render([node()], [one_of_each(gpu=[gpu])]).splitlines()
    for line in (
        'sparkline_gpu_temperature_celsius{node="spark1",gpu="0"} NaN',
        'sparkline_gpu_power_watts{node="spark1",gpu="0"} +Inf',
        'sparkline_gpu_utilization_ratio{node="spark1",gpu="0"} -Inf',
    ):
        assert line in lines


def test_a_model_server_gets_one_info_series_per_loaded_model_and_one_when_it_names_none():
    def server(port: int, **kw: object) -> ModelServerSample:
        return ModelServerSample.model_validate({"port": port, "adapter": "prometheus", **kw})

    llm = [
        server(8000, software="llama.cpp", models=[{"name": "a"}, {"name": "b"}]),
        server(8001, state="down", values={"up": 0}),
    ]
    got = series(render([node()], [one_of_each(llm=llm)]))
    n = ("node", "spark1")
    assert {labels for (name, labels) in got if name == "sparkline_model_server_info"} == {
        (n, ("port", "8000"), ("software", "llama.cpp"), ("model", "a")),
        (n, ("port", "8000"), ("software", "llama.cpp"), ("model", "b")),
        (n, ("port", "8001")),
    }
    assert got["sparkline_model_server_up", (n, ("port", "8001"))] == 0


def test_the_readme_lists_exactly_the_families_the_console_exports():
    exported = {f.name for f in (NODE_UP, NODE_LAST_SAMPLE, MODEL_SERVER_INFO, *EXPORTED.values())}
    documented = set(re.findall(r"`(sparkline_[a-z0-9_]+)`", (REPO / "README.md").read_text()))
    assert documented == exported


TOKEN = "s3cret-browser-token"
SCRAPE = "scrape-only-token-0123"


class _Src(NodeSource):
    async def session(self) -> None:
        raise NotImplementedError


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def app(tmp_path, metrics_token: str = SCRAPE):
    cfg = ConsoleConfig(
        token=TOKEN, agent_token="a", metrics_token=metrics_token, web_dist=tmp_path / "missing-dist"
    )
    return create_app(cfg, tmp_path / "data")


def test_metrics_needs_the_console_token_or_the_metrics_token(tmp_path):
    with TestClient(app(tmp_path)) as c:
        cluster = c.app.state.cluster
        src = _Src("spark1", "http://127.0.0.1:1", cluster)
        cluster.add_source(src)
        src.got_sample(one_of_each())
        for headers in ({}, bearer("wrong"), bearer(""), {"Authorization": SCRAPE}):
            r = c.get("/metrics", headers=headers)
            assert r.status_code == 401 and r.json()["problem"]["message"] == "Sign in required", headers
        for token in (TOKEN, SCRAPE):
            r = c.get("/metrics", headers=bearer(token))
            assert r.status_code == 200, token
            assert r.headers["content-type"] == "text/plain; version=0.0.4; charset=utf-8"
            got = series(r.text)
            assert got["sparkline_node_up", (("node", "spark1"),)] == 1
            assert got["sparkline_gpu_temperature_celsius", (("node", "spark1"), ("gpu", "0"))] == 65
        assert c.post("/api/v1/auth/login", json={"token": TOKEN}).status_code == 200
        assert c.get("/metrics").status_code == 200, "a signed-in browser"


def test_the_metrics_token_opens_nothing_but_metrics(tmp_path):
    with TestClient(app(tmp_path)) as c:
        assert c.get("/metrics", headers=bearer(SCRAPE)).status_code == 200
        for path in ("/api/v1/cluster", "/api/v1/bench/runs"):
            assert c.get(path, headers=bearer(SCRAPE)).status_code == 401, path
            assert c.get(path, headers=bearer(TOKEN)).status_code == 200, path
        assert c.get("/api/v1/auth/me", headers=bearer(SCRAPE)).json()["authenticated"] is False
        assert c.post("/api/v1/auth/login", json={"token": SCRAPE}).status_code == 401
        with (
            pytest.raises(WebSocketDisconnect),
            c.websocket_connect("/api/v1/stream", headers=bearer(SCRAPE)) as ws,
        ):
            ws.receive_text()


def test_without_a_metrics_token_only_the_console_token_opens_metrics(tmp_path):
    with TestClient(app(tmp_path, metrics_token="")) as c:
        assert c.get("/metrics", headers=bearer("")).status_code == 401
        assert c.get("/metrics", headers=bearer(SCRAPE)).status_code == 401
        assert c.get("/metrics", headers=bearer(TOKEN)).status_code == 200


def test_wrong_tokens_on_metrics_count_toward_the_attempt_limit_which_then_holds_for_both_tokens(tmp_path):
    with TestClient(app(tmp_path)) as c:
        for _ in range(LOGIN_LIMIT):
            assert c.get("/metrics", headers=bearer("wrong")).status_code == 401
        for token in ("wrong", SCRAPE, TOKEN):
            assert c.get("/metrics", headers=bearer(token)).status_code == 429, token


def test_metrics_token_is_a_console_toml_key_of_at_least_16_characters(tmp_path, capsys, monkeypatch):
    served: list[ConsoleConfig] = []
    monkeypatch.setattr(
        console_main, "create_app", lambda cfg, *_a, **_kw: SimpleNamespace(state=SimpleNamespace(cfg=cfg))
    )
    monkeypatch.setattr(console_main, "lock_data_dir", lambda d: -1)
    monkeypatch.setattr(console_main.uvicorn, "run", lambda app, **_kw: served.append(app.state.cfg))
    for name in ("CONFIG", "TOKEN", "AGENT_TOKEN", "BIND", "PORT", "DATA_DIR"):
        monkeypatch.delenv(f"SPARKLINE_{name}", raising=False)
    p = tmp_path / "console.toml"
    rest = (
        f'bind = "127.0.0.1"\ndata_dir = "{tmp_path}"\ntoken = "c-0123456789abcdef"\n'
        'agent_token = "a-0123456789abcdef"\n[[nodes]]\nid = "a"\nurl = "http://a:9750"\n'
    )
    assert ConsoleConfig().metrics_token == ""
    p.write_text(f'metrics_token = "{SCRAPE}"\n{rest}')
    console_main.main(["--config", str(p)])
    assert [cfg.metrics_token for cfg in served] == [SCRAPE]
    p.write_text(f'metrics_token = "short"\n{rest}')
    with pytest.raises(SystemExit, match="2"):
        console_main.main(["--config", str(p)])
    assert "metrics_token must be at least 16 characters" in capsys.readouterr().err
    assert len(served) == 1
