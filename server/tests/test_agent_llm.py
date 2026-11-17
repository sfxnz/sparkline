"""The model-server collector, driven one poll round at a time against a fake HTTP source."""

from __future__ import annotations

import contextlib
import json
import logging
import re
import socket
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from platforms import gb10

from sparkline.agent import sources
from sparkline.agent.collectors.llm import ADAPTERS, FIND_EVERY_S, FORGET_AFTER_S, ModelServerCollector
from sparkline.agent.config import AgentConfig, Target, load_config
from sparkline.agent.info import Collectors
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import HttpReply, RootFs, live_http
from sparkline.common.metrics import flatten
from sparkline.common.schema import ProcSample

FIXTURES = Path(__file__).parent / "fixtures" / "agent" / "llm"
RECORDED = (FIXTURES / "acmeserve_metrics.txt").read_text()
VLLM = (FIXTURES / "vllm_metrics.txt").read_text()
KEY = "sk-local-0123456789abcdef"
BASE = "http://127.0.0.1:8000"

Route = HttpReply | Exception | Callable[[], HttpReply]


def models(owner: str, name: str = "example-model", **more: object) -> HttpReply:
    entry = {"id": name, "object": "model", "owned_by": owner, **more}
    return HttpReply(200, json.dumps({"object": "list", "data": [entry]}).encode())


def text(body: str, status: int = 200) -> HttpReply:
    return HttpReply(status, body.encode())


class FakeHttp:
    def __init__(self, routes: dict[str, Route]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: Mapping[str, str]) -> HttpReply:
        self.calls.append((url, dict(headers)))
        got = self.routes.get(url)
        if got is None:
            origin = url[: url.index("/", len("http://"))]
            if any(route.startswith(origin + "/") for route in self.routes):
                return HttpReply(404, b"Not Found")
            raise ConnectionRefusedError("refused")
        if isinstance(got, Exception):
            raise got
        return got if isinstance(got, HttpReply) else got()

    def asked(self, base: str = BASE) -> list[str]:
        return [url.removeprefix(base) for url, _ in self.calls if url.startswith(base + "/")]


def listen(root: Path, sockets: dict[int, int]) -> None:
    """Write a listen table: port -> inode, every socket bound to every IPv4 address."""
    rows = [
        f"   {i}: 00000000:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 {inode} 1"
        for i, (port, inode) in enumerate(sockets.items())
    ]
    (root / "proc/net").mkdir(parents=True, exist_ok=True)
    (root / "proc/net/tcp").write_text("\n".join(["  sl  local_address rem_address st", *rows]) + "\n")


def collector(
    root: Path,
    http: FakeHttp,
    targets: tuple[Target, ...] = (),
    discover: bool = True,
    procs: object | None = None,
    containers: list[dict] | None = None,
) -> ModelServerCollector:
    src = gb10(fs=RootFs(root), http=http, docker=lambda path: containers or [])
    return ModelServerCollector(src, procs, targets, discover)  # type: ignore[arg-type]


def acmeserve(**more: Route) -> FakeHttp:
    listed = models("acmeserve", context_length=1048576, max_model_len=1048576)
    return FakeHttp({f"{BASE}/v1/models": listed, f"{BASE}/metrics": text(RECORDED), **more})


def servers(c: ModelServerCollector) -> list:
    return c.collect()["llm"]


def test_the_web_empty_state_names_the_ports_the_agent_asks_unprompted():
    web = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "llm.ts"
    m = re.search(r"DEFAULT_PORTS = \[([^\]]*)\] as const", web.read_text())
    assert m, f"DEFAULT_PORTS not found in {web}"
    assert {int(p) for p in m.group(1).split(",")} == {p for a in ADAPTERS for p in a.default_ports}


def test_a_server_on_a_default_port_is_found_with_no_configuration(tmp_path):
    listen(tmp_path, {8000: 41, 22: 7})
    http = acmeserve()
    c = collector(tmp_path, http)
    assert servers(c) == []
    c.poll_round(0.0)
    c.poll_round(2.0)
    [s] = servers(c)
    assert (s.port, s.adapter, s.software, s.version, s.prefix) == (
        8000,
        "prometheus",
        "acmeserve",
        "1.2.5",
        "acmeserve:",
    )
    assert (s.state, s.problem, s.mem_source, s.started_ts) == ("ready", None, "server", 1794251153)
    assert [(m.name, m.context_len) for m in s.models] == [("example-model", 1048576)]
    assert s.values == {
        "up": 1,
        "running": 0,
        "waiting": 0,
        "kv_cache_pct": 0,
        "mem_bytes": 108943095160,
        "gen_tps": 0,
        "prompt_tps": 0,
        "preempt_per_s": 0,
    }
    assert set(s.reports) - set(s.values) == {"ttft_p50_s", "ttft_p95_s"}  # idle: nothing to say, not 0
    assert http.asked()[0] == "/v1/models"
    assert all(url.startswith(BASE + "/") for url, _ in http.calls), "port 22 is named by nothing"


def test_a_listening_socket_is_identified_once_and_only_with_safe_requests(tmp_path):
    listen(tmp_path, {8000: 41, 8080: 52})
    web_app = "http://127.0.0.1:8080"
    http = acmeserve(**{f"{web_app}/v1/models": text("Not Found", 404)})
    c = collector(tmp_path, http)
    for i in range(10):
        c.poll_round(i * FIND_EVERY_S)
    assert http.asked(web_app) == ["/v1/models"]
    assert http.asked().count("/v1/models") == 1
    assert set(http.asked()) == {"/v1/models", "/metrics"}
    assert [s.port for s in servers(c)] == [8000]


def test_a_new_socket_on_the_port_is_identified_again(tmp_path):
    listen(tmp_path, {8080: 52})
    web_app = "http://127.0.0.1:8080"
    http = FakeHttp({f"{web_app}/v1/models": text("Not Found", 404)})
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    listen(tmp_path, {8080: 53})
    c.poll_round(FIND_EVERY_S)
    c.poll_round(2 * FIND_EVERY_S)
    assert http.asked(web_app) == ["/v1/models", "/v1/models"]


@pytest.mark.parametrize("by", ["owner", "arguments"])
def test_tensorrt_llm_is_never_asked_for_the_metrics_path_that_drains(tmp_path, by):
    listen(tmp_path, {8000: 41})
    owner = "tensorrt_llm" if by == "owner" else "acme"
    http = FakeHttp(
        {
            f"{BASE}/v1/models": models(owner),
            f"{BASE}/metrics": text('{"gpuMemUsage": 12}'),
            f"{BASE}/prometheus/metrics": text(
                "trtllm_num_requests_running 2\ntrtllm_kv_cache_utilization 0.5\n"
            ),
        }
    )
    row = ProcSample(pid=9, name="trtllm-serve", cmdline="trtllm-serve Qwen/Qwen3-8B --port 8000", rss=1)
    procs = SimpleNamespace(rows=[row], cmdlines={9: row.cmdline}) if by == "arguments" else None
    c = collector(tmp_path, http, procs=procs)
    c.collect()
    for i in range(6):
        c.poll_round(i * FIND_EVERY_S)
    assert "/metrics" not in http.asked()
    assert set(http.asked()) == {"/v1/models", "/prometheus/metrics"}
    [s] = servers(c)
    assert (s.software, s.prefix, s.values["running"], s.values["kv_cache_pct"]) == (
        "TensorRT-LLM",
        "trtllm_",
        2,
        50,
    )


def test_tensorrt_llm_without_prometheus_metrics_is_listed_and_still_never_drained(tmp_path):
    listen(tmp_path, {8000: 41})
    http = FakeHttp(
        {
            f"{BASE}/v1/models": models("tensorrt_llm"),
            f"{BASE}/metrics": text("{}"),
            f"{BASE}/health": text("ok"),
        }
    )
    c = collector(tmp_path, http)
    for i in range(4):
        c.poll_round(i * FIND_EVERY_S)
    assert set(http.asked()) == {"/v1/models", "/prometheus/metrics", "/health"}
    [s] = servers(c)
    assert (s.state, s.values, s.reports) == ("ready", {"up": 1}, [])
    assert "return_perf_metrics" in s.problem


def test_llamacpp_without_metrics_is_listed_with_the_flag_that_turns_them_on(tmp_path):
    listen(tmp_path, {9931: 41})
    base = "http://127.0.0.1:9931"
    listed = models("llamacpp", "/models/Qwen3-8B-Q4_K_M.gguf", meta={"n_ctx_train": 40960})
    http = FakeHttp(
        {
            f"{base}/v1/models": listed,
            f"{base}/metrics": text("no metrics", 501),
            f"{base}/health": text("{}"),
        }
    )
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    c.poll_round(2.0)
    [s] = servers(c)
    assert (s.software, s.state, s.values, s.reports) == ("llama.cpp", "ready", {"up": 1}, [])
    assert [(m.name, m.context_len) for m in s.models] == [("Qwen3-8B-Q4_K_M.gguf", 40960)]
    assert "--metrics" in s.problem
    assert not {"/props", "/slots", "/models"} & set(http.asked(base))
    http.routes[f"{base}/health"] = text("loading", 503)
    c.poll_round(4.0)
    assert (servers(c)[0].state, servers(c)[0].values) == ("loading", {"up": 0})


def test_a_server_that_lists_models_and_has_no_metrics_or_known_owner_is_left_out(tmp_path):
    listen(tmp_path, {8080: 41})
    base = "http://127.0.0.1:8080"
    http = FakeHttp({f"{base}/v1/models": models("library", "qwen3:8b")})
    c = collector(tmp_path, http)
    for i in range(3):
        c.poll_round(i * FIND_EVERY_S)
    assert servers(c) == []
    assert http.asked(base) == ["/v1/models", "/metrics", "/v1/metrics"]


def test_a_server_still_loading_is_asked_again_until_it_answers(tmp_path):
    listen(tmp_path, {8000: 41})
    http = acmeserve(**{f"{BASE}/v1/models": text("Loading model", 503)})
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    http.routes[f"{BASE}/v1/models"] = TimeoutError("no answer in time")
    c.poll_round(FIND_EVERY_S)
    assert servers(c) == []
    http.routes[f"{BASE}/v1/models"] = models("acmeserve")
    c.poll_round(2 * FIND_EVERY_S)
    assert [s.state for s in servers(c)] == ["ready"]


def test_a_server_that_vanishes_reads_down_with_up_zero_then_leaves_the_list(tmp_path):
    listen(tmp_path, {8000: 41})
    c = collector(tmp_path, acmeserve())
    c.poll_round(0.0)
    c.poll_round(2.0)
    listen(tmp_path, {})
    c.poll_round(2.0 + FIND_EVERY_S)
    [s] = servers(c)
    assert (s.state, s.values) == ("down", {"up": 0})
    assert [m.name for m in s.models] == ["example-model"] and "stopped listening" in s.problem
    sample = Sampler("n", [c]).tick()
    assert {k: v for k, v in flatten(sample).items() if k.startswith("llm.")} == {"llm.8000.up": 0.0}
    c.poll_round(2.0 + FIND_EVERY_S + FORGET_AFTER_S)
    assert [s.state for s in servers(c)] == ["down"]
    c.poll_round(4.0 + FIND_EVERY_S + FORGET_AFTER_S)
    assert servers(c) == []


def test_a_server_that_stops_answering_reads_down_before_the_next_look(tmp_path):
    listen(tmp_path, {8000: 41})
    http = acmeserve()
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    http.routes[f"{BASE}/metrics"] = ConnectionRefusedError("refused")
    c.poll_round(2.0)
    assert (servers(c)[0].state, servers(c)[0].values) == ("down", {"up": 0})
    http.routes[f"{BASE}/metrics"] = TimeoutError("no answer in time")
    c.poll_round(4.0)
    assert "No answer within" in servers(c)[0].problem
    http.routes[f"{BASE}/metrics"] = text(RECORDED)
    c.poll_round(6.0)
    assert (servers(c)[0].state, servers(c)[0].problem) == ("ready", None)


def test_a_restart_clears_rates_for_one_poll(tmp_path):
    listen(tmp_path, {8000: 41})
    http = acmeserve()
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    c.poll_round(2.0)
    assert servers(c)[0].values["gen_tps"] == 0
    listen(tmp_path, {8000: 99})
    c.poll_round(2.0 + FIND_EVERY_S)
    after = servers(c)[0]
    assert after.state == "ready" and "gen_tps" not in after.values and "gen_tps" in after.reports
    c.poll_round(4.0 + FIND_EVERY_S)
    assert servers(c)[0].values["gen_tps"] == 0
    assert http.asked().count("/v1/models") == 2


def test_a_configured_server_is_polled_with_its_key_and_the_key_never_leaves_the_collector(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    listen(tmp_path, {8000: 41, 9000: 42})
    keyed = "http://127.0.0.1:9000"
    leak = OSError(f"Illegal header value b'Bearer {KEY}'")
    http = acmeserve(**{f"{keyed}/v1/models": models("vllm", "Qwen3-32B"), f"{keyed}/metrics": text(VLLM)})
    c = collector(tmp_path, http, targets=(Target(9000, KEY),))
    c.poll_round(0.0)
    http.routes[f"{keyed}/metrics"] = leak
    c.poll_round(2.0)
    http.routes[f"{keyed}/metrics"] = RuntimeError(f"header {KEY}")
    c.start()
    try:
        deadline = time.monotonic() + 5
        while "errors" not in c.collect() and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        c.close()
    assert c.collect()["errors"] == {"llm": "RuntimeError while polling model servers"}
    assert {h.get("Authorization") for url, h in http.calls if url.startswith(keyed)} == {f"Bearer {KEY}"}
    assert {h.get("Authorization") for url, h in http.calls if url.startswith(BASE)} == {None}
    sample = Sampler("n", [c]).tick()
    assert [s.port for s in sample.llm] == [8000, 9000]
    assert KEY not in sample.model_dump_json() and KEY not in caplog.text
    assert KEY not in repr(Target(9000, KEY)) and KEY not in repr(c.__dict__["_tracked"])


def test_a_server_behind_a_key_shows_its_metrics_and_asks_for_the_key(tmp_path):
    listen(tmp_path, {8000: 41})
    http = FakeHttp({f"{BASE}/v1/models": text("Unauthorized", 401), f"{BASE}/metrics": text(VLLM)})
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    [s] = servers(c)
    assert (s.software, s.models, s.values["running"]) == ("vLLM", [], 3)
    assert "api_key" in s.problem
    refused = FakeHttp(
        {f"{BASE}/v1/models": text("Forbidden", 403), f"{BASE}/metrics": text("Forbidden", 403)}
    )
    c = collector(tmp_path, refused)
    c.poll_round(0.0)
    assert servers(c) == []


def test_with_discovery_off_only_the_listed_ports_are_asked(tmp_path):
    listen(tmp_path, {8000: 41, 9000: 42})
    keyed = "http://127.0.0.1:9000"
    http = acmeserve(**{f"{keyed}/v1/models": models("vllm"), f"{keyed}/metrics": text(VLLM)})
    c = collector(tmp_path, http, targets=(Target(9000), Target(9001)), discover=False)
    assert c.caps() == {"llm": None}
    c.poll_round(0.0)
    assert http.asked() == []
    assert [(s.port, s.state, s.values["up"]) for s in servers(c)] == [(9000, "ready", 1), (9001, "down", 0)]
    assert servers(c)[1].problem == "Port 9001 is not listening"
    for i in range(1, 4):
        c.poll_round(i * FORGET_AFTER_S)
    assert [s.port for s in servers(c)] == [9000, 9001], "a listed server is never forgotten"


def test_with_discovery_off_and_no_server_listed_the_collector_looks_at_nothing(tmp_path):
    listen(tmp_path, {8000: 41})
    http = acmeserve()
    c = collector(tmp_path, http, discover=False)
    c.start()
    c.close()
    assert c.collect() == {"llm": None}
    assert c.caps()["llm"].kind == "agent" and "discovery is off" in c.caps()["llm"].reason
    assert http.calls == [] and "llm-poller" not in {t.name for t in threading.enumerate()}


def test_without_a_listen_table_the_default_ports_are_tried_on_loopback(tmp_path):
    http = acmeserve()
    c = collector(tmp_path, http)
    c.poll_round(0.0)
    assert [s.port for s in servers(c)] == [8000]
    assert {url.split("/")[2] for url, _ in http.calls} == {
        f"127.0.0.1:{p}" for p in (8000, 8080, 9931, 30000)
    }


def test_the_process_behind_the_port_gives_the_pid_the_container_and_memory_the_server_does_not_report(
    tmp_path,
):
    listen(tmp_path, {8000: 41, 8001: 42})
    other = "http://127.0.0.1:8001"
    http = acmeserve(**{f"{other}/v1/models": models("vllm", "Qwen3-32B"), f"{other}/metrics": text(VLLM)})
    rows = [
        ProcSample(
            pid=11, name="python", cmdline="serve.py --port 8000", rss=1, gpu_mem=9 << 30, container="tf"
        ),
        ProcSample(
            pid=12, name="python", cmdline="vllm worker", rss=1, gpu_mem=20 << 30, container="vllm-qwen3"
        ),
        ProcSample(
            pid=13, name="python", cmdline="vllm worker", rss=1, gpu_mem=4 << 30, container="vllm-qwen3"
        ),
    ]
    procs = SimpleNamespace(rows=rows, cmdlines={})
    published = [{"Id": "a" * 64, "Names": ["/vllm-qwen3"], "Ports": [{"PublicPort": 8001, "Type": "tcp"}]}]
    c = collector(tmp_path, http, procs=procs, containers=published)
    c.collect()
    c.poll_round(0.0)
    reported, joined = servers(c)
    assert (reported.pid, reported.container, reported.mem_source) == (11, "tf", "server")
    assert reported.values["mem_bytes"] == 108943095160
    assert (joined.pid, joined.container, joined.mem_source) == (12, "vllm-qwen3", "process")
    assert joined.values["mem_bytes"] == 24 << 30 and "mem_bytes" not in joined.reports
    procs.rows = []
    assert [(s.pid, s.mem_source) for s in servers(c)] == [(None, "server"), (None, None)]
    assert "mem_bytes" not in servers(c)[1].values


def test_a_hung_server_does_not_delay_the_sampling_tick(tmp_path):
    listen(tmp_path, {8000: 41})
    asked, release = threading.Event(), threading.Event()

    def hang() -> HttpReply:
        asked.set()
        release.wait(10)
        return text(RECORDED)

    c = collector(tmp_path, acmeserve(**{f"{BASE}/metrics": hang}))
    c.start()
    try:
        assert asked.wait(5), "the poller never reached the server"
        started = time.perf_counter()
        for _ in range(100):
            assert c.collect() == {"llm": []}
        per_call = (time.perf_counter() - started) / 100
    finally:
        release.set()
        c.close()
    assert per_call < 0.005


def test_building_the_collectors_starts_no_poller_and_reports_no_server(tmp_path):
    cfg = AgentConfig(node_id="gb10", data_dir=str(tmp_path))
    collectors = Collectors(cfg, gb10())
    sample = Sampler(cfg.node_id, collectors.ordered()).tick()
    assert sample.llm == [] and "llm" not in sample.errors
    assert "llm" not in {u.metric for u in collectors.node_info(cfg).unsupported}
    assert "llm-poller" not in {t.name for t in threading.enumerate()}


def test_model_servers_are_read_from_agent_toml(tmp_path):
    path = tmp_path / "agent.toml"
    path.write_text(
        f'model_server_discovery = false\n[[model_servers]]\nport = 9931\napi_key = "{KEY}"\n'
        "[[model_servers]]\nport = 8001\n"
    )
    cfg = load_config(str(path))
    assert cfg.model_server_discovery is False
    assert cfg.targets() == [Target(9931, KEY), Target(8001)]
    assert AgentConfig().targets() == [] and AgentConfig().model_server_discovery is True


@pytest.mark.parametrize(
    ("toml", "message"),
    [
        (
            f'[[model_servers]]\nport = 9931\napi_key = "{KEY}"\nmetrics = "/m"',
            "unknown keys in [[model_servers]]: metrics",
        ),
        (f'[[model_servers]]\napi_key = "{KEY}"', "needs a port between 1 and 65535"),
        (f'[[model_servers]]\nport = 70000\napi_key = "{KEY}"', "needs a port between 1 and 65535"),
        ('[[model_servers]]\nport = 9931\napi_key = ""', "api_key must be printable ASCII text"),
        ('[[model_servers]]\nport = 9931\napi_key = "a\\nb"', "api_key must be printable ASCII text"),
        ("[[model_servers]]\nport = 9931\n[[model_servers]]\nport = 9931", "lists port 9931 twice"),
        ("model_servers = [9931]", "must be a list of tables"),
        ('model_server_discovery = "no"', "must be true or false"),
    ],
)
def test_a_bad_model_server_table_fails_the_load_without_quoting_the_key(tmp_path, toml, message):
    path = tmp_path / "agent.toml"
    path.write_text(toml)
    with pytest.raises(ValueError) as e:
        load_config(str(path))
    assert message in str(e.value) and KEY not in str(e.value)


@pytest.fixture
def local_server() -> Iterator[tuple[str, list[dict[str, str]]]]:
    """A throwaway HTTP server on loopback and the headers of each request it got."""
    seen: list[dict[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.append({k.lower(): v for k, v in self.headers.items()})
            if self.path == "/hang":
                time.sleep(0.5)
            status = 302 if self.path == "/moved" else 200
            body = b"x" * 5000 if self.path == "/big" else b"acmeserve:num_requests_running 2\n"
            self.send_response(status)
            if status == 302:
                self.send_header("Location", "/metrics")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            with contextlib.suppress(OSError):  # the client of /hang has left by now
                self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()


def test_the_live_request_stays_on_this_node_and_keeps_the_key_out_of_the_log(
    local_server, monkeypatch, caplog
):
    base, seen = local_server
    caplog.set_level(logging.DEBUG)
    for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")  # a proxy that refuses every connection
    reply = live_http(f"{base}/metrics", {"Authorization": f"Bearer {KEY}"})
    assert (reply.status, reply.body) == (200, b"acmeserve:num_requests_running 2\n")
    assert seen[0]["authorization"] == f"Bearer {KEY}"
    assert live_http(f"{base}/moved", {}).status == 302 and len(seen) == 2, "a redirect is not followed"
    monkeypatch.setattr(sources, "HTTP_MAX_BYTES", 1000)
    assert len(live_http(f"{base}/big", {}).body) == 1000
    with pytest.raises(ConnectionError) as refused:
        live_http("http://127.0.0.1:9/metrics", {"Authorization": f"Bearer {KEY}"})
    with pytest.raises(ConnectionError) as illegal:
        live_http(f"{base}/metrics", {"Authorization": f"Bearer {KEY}\r\nX: y"})
    monkeypatch.setattr(sources, "HTTP_TIMEOUT_S", 0.2)
    with pytest.raises(TimeoutError) as hung:
        live_http(f"{base}/hang", {"Authorization": f"Bearer {KEY}"})
    assert KEY not in caplog.text + str(refused.value) + str(illegal.value) + str(hung.value)


@pytest.mark.parametrize(
    ("sent", "raised"),
    [(b"\x4a\x00\x00\x00\x0a8.0.36\x00", sources.NotHttp), (b"", ConnectionError)],
    ids=["a database greeting", "closed without a byte"],
)
def test_the_live_request_tells_an_answer_that_is_not_http_from_no_answer(sent, raised):
    with socket.create_server(("127.0.0.1", 0)) as server:

        def answer() -> None:
            conn, _ = server.accept()
            with conn:
                conn.sendall(sent)
                conn.recv(65536)

        threading.Thread(target=answer, daemon=True).start()
        port = server.getsockname()[1]
        with pytest.raises(ConnectionError) as e:
            live_http(f"http://127.0.0.1:{port}/v1/models", {"Authorization": f"Bearer {KEY}"})
    assert type(e.value) is raised and KEY not in str(e.value)
