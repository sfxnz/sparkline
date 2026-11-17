"""Will it fit: the estimate, node budgets, verdicts, the Hugging Face lookup (faked at the HTTP transport)
and the two routes."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sparkline.common.schema import NodeInfo, Sample
from sparkline.console import fit
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo import DemoModel
from sparkline.console.demo_workstation import WorkstationModel
from sparkline.console.fit import Estimate, ModelFacts, estimate, fetch_facts, node_budget, parse_repo_id
from sparkline.console.nodes import NodeSource

GIB = 2**30
T0 = 1_791_000_000.0
TOKEN = "s3cret-browser-token"
BEARER = {"Authorization": f"Bearer {TOKEN}"}
QWEN = ModelFacts(params_by_dtype={"BF16": 8_190_735_360}, num_layers=36, num_kv_heads=8, head_dim=128)
QWEN_INFO = {"id": "Qwen/Qwen3-8B", "safetensors": {"parameters": {"BF16": 8_190_735_360}}}
QWEN_CONFIG = {
    "hidden_size": 4096,
    "max_position_embeddings": 40960,
    "num_attention_heads": 32,
    "num_hidden_layers": 36,
    "num_key_value_heads": 8,
}


def test_the_worked_example_qwen3_8b_at_32k_context():
    est = estimate(QWEN, 32768, "bf16")
    assert est.kv_bytes_per_token == 144 * 1024
    assert est.kv_bytes == 4.5 * GIB
    assert round(est.weights_bytes / GIB, 1) == 15.3
    assert (est.total_low, est.total_high) == (23_334_639_820, 25_455_970_713)  # +10 % and +20 %


def test_weights_count_every_dtype_and_fp8_halves_the_kv_cache():
    facts = QWEN.model_copy(update={"params_by_dtype": {"F32": 10, "BF16": 100, "U8": 7, "F8_E4M3": 3}})
    assert estimate(facts, 1, "fp16").weights_bytes == 40 + 200 + 7 + 3
    assert estimate(QWEN, 1000, "fp8").kv_bytes * 2 == estimate(QWEN, 1000, "fp16").kv_bytes


def test_an_unknown_dtype_is_refused_not_guessed():
    with pytest.raises(ValidationError, match="unknown weight dtype Q4_K"):
        ModelFacts(params_by_dtype={"Q4_K": 1}, num_layers=1, num_kv_heads=1, head_dim=1)
    with pytest.raises(ValidationError, match="unknown KV cache dtype"):
        fit.FitRequest(facts=QWEN, context_tokens=1, kv_dtype="q8_0")


def test_the_web_form_offers_exactly_the_dtypes_the_console_sizes():
    web = (Path(__file__).parents[2] / "web/src/views/fit/model.ts").read_text()
    weights = re.search(r"WEIGHT_DTYPES = \[([^\]]*)\] as const", web)
    assert weights and set(re.findall(r"'([^']+)'", weights[1])) == set(fit.DTYPE_BYTES)
    assert set(re.findall(r"value: '([^']+)'", web)) == set(fit.KV_DTYPE_BYTES)


def gb10(available: int) -> tuple[NodeInfo, Sample]:
    m = DemoModel("spark1", T0)
    s = m.sample_at(T0, 1)
    return m.info, s.model_copy(update={"mem": s.mem.model_copy(update={"available": available})})


def workstation(used: list[int | None]) -> tuple[NodeInfo, Sample]:
    m = WorkstationModel("ws1", T0)
    s = m.sample_at(T0, 1)
    gpus = [g.model_copy(update={"vram_used": u}) for g, u in zip(s.gpu, used, strict=True)]
    return m.info, s.model_copy(update={"gpu": gpus})


def test_a_unified_memory_node_budgets_available_memory_minus_headroom():
    b = node_budget(*gb10(20 * GIB))
    assert (b.kind, b.bytes, b.available, b.gpu_vendor) == ("unified", 16 * GIB, 20 * GIB, "nvidia")
    assert node_budget(*gb10(1 * GIB)).bytes == 0


def test_a_dedicated_gpu_node_budgets_the_one_gpu_with_the_most_free_memory():
    info, sample = workstation([40 * GIB, 10 * GIB, 30 * GIB, None])
    total = info.gpus[1].vram_total
    b = node_budget(info, sample)
    assert (b.kind, b.gpu_index, b.bytes) == ("gpu", 1, total - 10 * GIB)


def test_no_budget_without_a_sample_or_without_reported_gpu_memory():
    info, sample = workstation([None] * 4)
    assert node_budget(info, None).kind == "unknown"
    assert node_budget(None, sample).kind == "unknown"
    assert "dedicated memory" in node_budget(info, sample).reason


def test_no_budget_when_the_memory_collector_has_no_reading():
    info, sample = gb10(0)
    empty = sample.model_copy(update={"mem": sample.mem.model_copy(update={"total": 0})})
    b = node_budget(info, empty)
    assert b.kind == "unknown" and "memory" in b.reason


@pytest.mark.parametrize(
    ("available_gib", "want"),
    [(34, "fits"), (30, "tight"), (26, "tight"), (25, "no")],
)
def test_verdict_compares_the_range_with_the_budget(available_gib, want):
    est = Estimate(weights_bytes=0, kv_bytes_per_token=0, kv_bytes=0, total_low=22 * GIB, total_high=30 * GIB)
    assert fit.verdict(est, node_budget(*gb10(available_gib * GIB))) == want  # 4 GiB of headroom


def test_verdict_is_unknown_without_a_budget():
    assert fit.verdict(estimate(QWEN, 1, "bf16"), node_budget(None, None)) == "unknown"


# -- Hugging Face lookup ------------------------------------------------------------------------------


class Hub:
    """A fake huggingface.co: ``routes`` maps a path to (status, body or headers)."""

    def __init__(self, routes: dict[str, httpx.Response | Exception]):
        self.routes = routes
        self.hosts: list[str] = []
        self.credentials: set[str] = set()

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.hosts.append(f"{request.url.scheme}://{request.url.host}")
        self.credentials |= {"authorization", "cookie"} & set(request.headers)
        answer = self.routes[request.url.path]
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def lookup(self, repo: str = "Qwen/Qwen3-8B"):
        repo_id = parse_repo_id(repo)
        assert repo_id is not None
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.handle)) as client:
            return await fetch_facts(client, repo_id)


INFO_PATH = "/api/models/Qwen/Qwen3-8B"
CONFIG_PATH = "/Qwen/Qwen3-8B/resolve/main/config.json"
CACHED_PATH = "/api/resolve-cache/models/Qwen/Qwen3-8B/abc/config.json"


def public_repo(info=QWEN_INFO, config=QWEN_CONFIG) -> dict[str, httpx.Response | Exception]:
    return {
        INFO_PATH: httpx.Response(200, json=info),
        # Hugging Face answers /resolve/ with a relative redirect to its own cache path.
        CONFIG_PATH: httpx.Response(307, headers={"location": f"{CACHED_PATH}?etag=x"}),
        CACHED_PATH: httpx.Response(200, json=config),
    }


async def test_lookup_reads_parameter_counts_and_the_model_shape():
    hub = Hub(public_repo())
    facts = await hub.lookup()
    assert facts == QWEN.model_copy(update={"repo": "Qwen/Qwen3-8B", "max_context": 40960})
    assert set(hub.hosts) == {"https://huggingface.co"}


async def test_lookup_falls_back_to_attention_heads_and_an_explicit_head_dim_wins():
    config = {"num_hidden_layers": 2, "num_attention_heads": 16, "hidden_size": 1024}
    facts = await Hub(public_repo(config=config)).lookup()
    assert (facts.num_kv_heads, facts.head_dim, facts.max_context) == (16, 64, None)
    facts = await Hub(public_repo(config={**config, "head_dim": 256})).lookup()
    assert facts.head_dim == 256


def refused(path: str, status: int) -> dict[str, httpx.Response | Exception]:
    return {**public_repo(), path: httpx.Response(status, json={"error": "Invalid username or password."})}


@pytest.mark.parametrize(
    ("routes", "message"),
    [
        (refused(INFO_PATH, 401), "no public model"),
        (refused(INFO_PATH, 404), "no public model"),
        (refused(CONFIG_PATH, 401), "is gated"),
        (refused(CONFIG_PATH, 404), "no config.json"),
        (refused(INFO_PATH, 500), "could not answer"),
        (public_repo(info={"id": "Qwen/Qwen3-8B"}), "no safetensors"),
        ({**refused(CONFIG_PATH, 404), INFO_PATH: httpx.Response(200, json={"id": "x"})}, "no safetensors"),
        (public_repo(info={"safetensors": {"parameters": {"Q4_K": 5}}}), "does not describe"),
        (public_repo(config={"num_hidden_layers": 36}), "does not describe"),
        (public_repo(config=["not", "an", "object"]), "not a JSON object"),
        ({INFO_PATH: httpx.ConnectError("Name or service not known")}, "Could not reach huggingface.co"),
        ({INFO_PATH: httpx.Response(200, content=b"<html>")}, "not JSON"),
        ({INFO_PATH: httpx.Response(200, content=b" " * (fit.MAX_RESPONSE_BYTES + 1))}, "more data"),
    ],
)
async def test_each_lookup_failure_is_a_problem_that_says_to_enter_the_facts_by_hand(routes, message):
    problem = await Hub(routes).lookup()
    assert message in problem.message
    assert "nter the model facts by hand" in problem.fix


@pytest.mark.parametrize(
    "location",
    ["https://cdn.example/config.json", "http://huggingface.co/x", "https://huggingface.co.example/x"],
)
async def test_lookup_never_follows_a_redirect_off_huggingface_co(location):
    hub = Hub({**public_repo(), CONFIG_PATH: httpx.Response(302, headers={"location": location})})
    problem = await hub.lookup()
    assert "another host" in problem.message
    assert set(hub.hosts) == {"https://huggingface.co"}


async def test_lookup_gives_up_on_a_redirect_loop():
    hub = Hub({INFO_PATH: httpx.Response(307, headers={"location": INFO_PATH})})
    assert "kept redirecting" in (await hub.lookup()).message
    assert len(hub.hosts) == fit.MAX_REDIRECTS + 1


@pytest.mark.parametrize(
    "raw", ["Qwen3-8B", "a/b/c", "../etc/passwd", "a/..", "a/b?x=1", "a/b#c", "-a/b", "a /b", "a/b%2F", ""]
)
def test_only_owner_slash_name_is_a_repo_id(raw):
    assert parse_repo_id(raw) is None


def test_a_repo_id_keeps_its_spelling():
    assert parse_repo_id(" google-bert/bert-base_uncased.v2 ") == "google-bert/bert-base_uncased.v2"


# -- routes ---------------------------------------------------------------------------------------------


def make(tmp_path, **cfg):
    return create_app(
        ConsoleConfig(token=TOKEN, agent_token="a", web_dist=tmp_path / "no-dist", **cfg), tmp_path / "data"
    )


@pytest.fixture
def hub(monkeypatch):
    """The console's outbound HTTP client talks to a fake huggingface.co."""
    fake = Hub(public_repo())
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(fake.handle), **kw)
    )
    return fake


class _Src(NodeSource):
    async def session(self) -> None:
        raise NotImplementedError


def body(**over):
    return {"facts": json.loads(QWEN.model_dump_json()), "context_tokens": 32768, "kv_dtype": "bf16"} | over


def test_the_fit_routes_need_a_signed_in_user(tmp_path, hub):
    with TestClient(make(tmp_path)) as c:
        assert c.get("/api/v1/fit/lookup?repo=Qwen/Qwen3-8B").status_code == 401
        assert c.post("/api/v1/fit/estimate", json=body()).status_code == 401
        wrong = {"Authorization": "Bearer wrong"}
        assert c.post("/api/v1/fit/estimate", json=body(), headers=wrong).status_code == 401
        cross_site = {**BEARER, "Origin": "http://elsewhere.example"}
        assert c.post("/api/v1/fit/estimate", json=body(), headers=cross_site).status_code == 403
    assert hub.hosts == []


def test_estimate_route_gives_the_range_and_a_verdict_per_node(tmp_path):
    with TestClient(make(tmp_path)) as c:
        cluster = c.app.state.cluster
        for node_id, available in (("roomy", 60 * GIB), ("snug", 27 * GIB), ("full", 8 * GIB)):
            info, sample = gb10(available)
            src = _Src(node_id, "http://127.0.0.1:1", cluster)
            cluster.add_source(src)
            src.got_hello(info)
            src.got_sample(sample.model_copy(update={"ts": time.time()}))
        cluster.add_source(_Src("silent", "http://127.0.0.1:2", cluster))
        r = c.post("/api/v1/fit/estimate", json=body(), headers=BEARER)
    assert r.status_code == 200
    got = r.json()
    assert got["estimate"] == json.loads(estimate(QWEN, 32768, "bf16").model_dump_json())
    assert [(n["node_id"], n["verdict"]) for n in got["nodes"]] == [
        ("roomy", "fits"),
        ("snug", "tight"),
        ("full", "no"),
        ("silent", "unknown"),
    ]
    assert got["nodes"][0]["budget"] == {
        "kind": "unified",
        "bytes": 56 * GIB,
        "available": 60 * GIB,
        "headroom": 4 * GIB,
        "gpu_vendor": "nvidia",
    }
    assert got["nodes"][3]["budget"] == {
        "kind": "unknown",
        "reason": "The node is connecting, so its free memory is not known",
    }


def test_estimate_route_refuses_facts_it_cannot_size(tmp_path):
    with TestClient(make(tmp_path)) as c:
        for bad in (
            body(kv_dtype="q4_0"),
            body(context_tokens=0),
            body(facts={**body()["facts"], "params_by_dtype": {"Q4_K": 1}}),
            body(facts={**body()["facts"], "num_layers": 0}),
        ):
            r = c.post("/api/v1/fit/estimate", json=bad, headers=BEARER)
            assert r.status_code == 422, bad
            assert r.json()["problem"]["message"] == "Invalid request"


def test_lookup_route_returns_the_facts(tmp_path, hub):
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 200
    assert ModelFacts.model_validate(r.json()) == QWEN.model_copy(
        update={"repo": "Qwen/Qwen3-8B", "max_context": 40960}
    )
    assert len(hub.hosts) == 3 and hub.credentials == set()


def test_lookup_route_reports_a_missing_repo_as_a_problem(tmp_path, hub):
    hub.routes = refused(INFO_PATH, 401)
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 502
    assert "by hand" in r.json()["problem"]["fix"]


def test_lookup_route_makes_no_outbound_call_for_a_bad_repo_id_or_when_turned_off(tmp_path, hub):
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "../../etc/passwd"}, headers=BEARER)
        assert r.status_code == 422 and "by hand" in r.json()["problem"]["fix"]
    with TestClient(make(tmp_path / "off", hf_lookup=False)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
        assert r.status_code == 403 and "by hand" in r.json()["problem"]["fix"]
        assert c.post("/api/v1/fit/estimate", json=body(), headers=BEARER).status_code == 200
    assert hub.hosts == []
