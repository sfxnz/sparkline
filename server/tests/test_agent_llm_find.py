from __future__ import annotations

from pathlib import Path

from sparkline.agent.collectors.llm_find import (
    Listener,
    candidates,
    hints_from_procs,
    parse_proc_net_tcp,
    published_ports,
)
from sparkline.common.schema import ProcSample

FIXTURES = Path(__file__).parent / "fixtures" / "agent"
TAIL = "00000000:00000000 00:00000000 00000000"
TCP4 = f"""  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F40 00000000:0000 0A {TAIL}     0        0 4100 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2713 00000000:0000 0A {TAIL}  1000        0 4200 1 0000000000000000 100 0 0 10 0
   2: 0100007F:C350 0100007F:1F40 01 {TAIL}  1000        0 4300 1 0000000000000000 20 4 30 10 -1
   3: 076433C6:1F90 00000000:0000 0A {TAIL}     0        0 4400 1 0000000000000000 100 0 0 10 0
   4: not-an-address 00000000:0000 0A {TAIL}     0        0 4500
"""
ANY6, LOOP6, MAPPED = "0" * 32, "0" * 24 + "01000000", "0" * 16 + "FFFF0000" + "0100007F"
TCP6 = f"""  sl  local_address                         remote_address                        st tx_queue
   0: {ANY6}:1F40 {ANY6}:0000 0A {TAIL}     0        0 6100 1 0000000000000000 100 0 0 10 0
   1: {LOOP6}:26CB {ANY6}:0000 0A {TAIL}  1000        0 6200 1 0000000000000000 100 0 0 10 0
   2: {MAPPED}:7530 {ANY6}:0000 0A {TAIL}  1000        0 6300 1 0000000000000000 100 0 0 10 0
"""
DEFAULTS = frozenset({8000, 8080, 9931, 30000})
NONE: frozenset[int] = frozenset()


def proc(pid: int, cmdline: str, gpu_mem: int | None = None, container: str | None = None) -> ProcSample:
    return ProcSample(
        pid=pid, name="python", cmdline=cmdline[:300], rss=1, gpu_mem=gpu_mem, container=container
    )


def test_the_listen_table_gives_each_listening_socket_an_address_to_connect_to():
    assert parse_proc_net_tcp(TCP4) == [
        Listener("127.0.0.1", 8000, 4100),  # bound to every address: reached over loopback
        Listener("127.0.0.1", 10003, 4200),
        Listener("198.51.100.7", 8080, 4400),  # bound to one address of this node
    ]
    assert parse_proc_net_tcp(TCP6) == [
        Listener("::1", 8000, 6100),
        Listener("::1", 9931, 6200),
        Listener("127.0.0.1", 30000, 6300),
    ]
    assert parse_proc_net_tcp("") == []


def test_a_port_is_a_candidate_only_when_something_names_it_and_it_listens():
    listeners = parse_proc_net_tcp(TCP4) + parse_proc_net_tcp(TCP6)
    assert candidates(listeners, DEFAULTS, NONE, NONE, NONE, discover=True) == [
        Listener("127.0.0.1", 8000, 4100),  # one per port, IPv4 loopback first
        Listener("198.51.100.7", 8080, 4400),
        Listener("::1", 9931, 6200),
        Listener("127.0.0.1", 30000, 6300),
    ]
    assert candidates(listeners, NONE, NONE, NONE, NONE, discover=True) == []
    named = candidates(listeners, NONE, frozenset({10003}), frozenset({8080, 5432}), NONE, discover=True)
    assert [c.port for c in named] == [8080, 10003]  # 5432 is published and not listening


def test_with_discovery_off_only_the_configured_ports_are_candidates():
    listeners = parse_proc_net_tcp(TCP4)
    got = candidates(listeners, DEFAULTS, frozenset({10003}), NONE, frozenset({8080, 7777}), discover=False)
    assert got == [Listener("198.51.100.7", 8080, 4400)]


def test_without_a_listen_table_the_named_ports_are_tried_on_loopback():
    got = candidates(None, frozenset({8000}), frozenset({10003}), frozenset({5432}), frozenset({7777}), True)
    assert got == [Listener("127.0.0.1", p, None) for p in (7777, 8000, 10003)]
    assert candidates(None, DEFAULTS, NONE, NONE, frozenset({7777}), False) == [
        Listener("127.0.0.1", 7777, None)
    ]


def test_a_server_port_is_read_from_the_whole_command_line_not_the_cut_one():
    whole = (FIXTURES / "cmdline_exl3").read_text().replace("\0", " ").strip()
    row = proc(41, whole, gpu_mem=90 << 30, container="c5-3B-r0")
    assert "--port 8080" in whole and "--port 8080" not in row.cmdline
    hints = hints_from_procs([row], {41: whole})
    assert set(hints.by_port) == {8080}  # --master-port 29873 is another flag
    assert hints.by_port[8080] == (41, "c5-3B-r0", 90 << 30, False)
    assert hints_from_procs([proc(7, "llama-server --port=9931 -m q.gguf")], {}).by_port[9931].pid == 7
    assert hints_from_procs([proc(8, "tool --port 99999999 --portable")], {}).by_port == {}


def test_a_servers_memory_is_what_every_process_in_its_container_holds():
    rows = [
        proc(1, "python serve.py --port 8000", gpu_mem=60 << 30, container="rank0"),
        proc(2, "python worker.py", gpu_mem=40 << 30, container="rank0"),
        proc(3, "python serve.py --port 8000", gpu_mem=10 << 30, container="rank1"),
        proc(4, "vllm serve Qwen/Qwen3-8B --port 8001", gpu_mem=None),
        proc(5, "trtllm-serve Qwen/Qwen3-8B --port 8002", gpu_mem=7 << 30),
    ]
    hints = hints_from_procs(rows, {})
    assert hints.by_port[8000] == (1, "rank0", 100 << 30, False)  # of two ranks, the one holding more
    assert hints.by_port[8001] == (4, None, None, False)
    assert hints.by_port[8002] == (5, None, 7 << 30, True)
    assert hints.by_container == {
        "rank0": (1, "rank0", 100 << 30, False),
        "rank1": (3, "rank1", 10 << 30, False),
    }


def test_docker_names_the_container_behind_each_published_tcp_port():
    containers = [
        {
            "Id": "a" * 64,
            "Names": ["/vllm-qwen3"],
            "Ports": [
                {"IP": "0.0.0.0", "PrivatePort": 8000, "PublicPort": 8001, "Type": "tcp"},
                {"IP": "::", "PrivatePort": 8000, "PublicPort": 8001, "Type": "tcp"},
                {"PrivatePort": 9000, "Type": "tcp"},
                {"IP": "0.0.0.0", "PrivatePort": 53, "PublicPort": 5353, "Type": "udp"},
            ],
        },
        {"Id": "b" * 64, "Names": ["/host-networked"], "Ports": []},
        {"Id": "c" * 64, "Names": ["/no-ports-key"]},
    ]
    assert published_ports(containers) == {8001: "vllm-qwen3"}
