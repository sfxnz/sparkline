"""Parsers for payload JSON lines, perftest, fio and nccl-tests output; RoCE GID and LISTEN probes."""

from __future__ import annotations

from pathlib import Path

import pytest

from sparkline.agent.bench.parsers import (
    parse_fio_json,
    parse_json_line,
    parse_nccl_tests,
    parse_perftest_bw,
    parse_perftest_lat,
)
from sparkline.agent.bench.probes import port_listening, roce_v2_ipv4_gid

FIX = Path(__file__).parent / "fixtures" / "agent" / "bench"


def test_json_lines():
    assert parse_json_line('{"progress": 0.5, "phase": "x"}') == {"progress": 0.5, "phase": "x"}
    assert parse_json_line('  {"result": {"metric": "m"}}\n') == {"result": {"metric": "m"}}
    assert parse_json_line('{"ready": true}') == {"ready": True}
    assert parse_json_line('{"live": {"done": 1}}') == {"live": {"done": 1}}
    assert parse_json_line('{"detail": {"llm": {}}}') == {"detail": {"llm": {}}}
    assert parse_json_line("plain text") is None
    assert parse_json_line("{not json") is None
    assert parse_json_line('{"other": 1}') is None  # JSON, but not a protocol message
    assert parse_json_line("[1, 2]") is None
    assert parse_json_line("") is None


def test_perftest_bw_client_and_server():
    c = parse_perftest_bw((FIX / "perftest_write_bw_client.txt").read_text())
    assert c == {  # perftest 6.20 on GB10, rail B, -D 5: msg rate x bytes x 8 = 108.93 Gb/s
        "bytes": 65536,
        "iterations": 623311,
        "peak": 0.0,
        "average": 108.93,
        "msg_rate_mpps": 0.20777,
    }
    s = parse_perftest_bw((FIX / "perftest_write_bw_server.txt").read_text())
    assert s["average"] == 108.93


def test_perftest_bw_mib_units_converted():
    text = (
        " #bytes     #iterations    BW peak[MB/sec]    BW average[MB/sec]   MsgRate[Mpps]\n"
        " 65536      5000             22000.00            21000.00            0.336000\n"
    )
    r = parse_perftest_bw(text)
    assert r["average"] == pytest.approx(21000 * 2**20 * 8 / 1e9)


def test_perftest_missing_table():
    assert parse_perftest_bw("Couldn't connect to 10.100.8.2:18515\n") is None
    assert parse_perftest_lat("ethernet_read_keys: Couldn't read remote address\n") is None


def test_perftest_lat():
    r = parse_perftest_lat((FIX / "perftest_write_lat_client.txt").read_text())
    assert r == {
        "bytes": 2,
        "iterations": 5000,
        "min": 1.38,
        "max": 3.01,
        "typical": 1.46,
        "avg": 1.56,
        "stdev": 0.01,
        "p99": 1.96,
        "p999": 2.12,
    }


def test_fio_json():
    rows = {(r["name"], r["side"]): r for r in parse_fio_json((FIX / "fio_3.36.json").read_text())}
    assert set(rows) == {
        ("seq_write", "write"),
        ("seq_read", "read"),
        ("rand_read", "read"),
        ("rand_write", "write"),
    }
    rr = rows[("rand_read", "read")]
    assert rr["mb_s"] == pytest.approx(943.7184) and rr["iops"] == 230400.0
    assert rr["p99_us"] == pytest.approx(1335.296)
    assert rows[("seq_write", "write")]["mb_s"] == pytest.approx(3967.215616)
    with pytest.raises(ValueError):
        parse_fio_json("fio: no such option")


def test_nccl_tests_table():
    rows = parse_nccl_tests((FIX / "nccl_tests_all_reduce.txt").read_text())
    assert [r["size"] for r in rows] == [8, 16, 1048576, 1073741824]
    assert rows[-1] == {
        "size": 1073741824,
        "count": 268435456,
        "time_us": 48213.5,
        "algbw": 22.27,
        "busbw": 22.27,
    }


def test_nccl_tests_older_header_without_root():
    text = (
        "#   size   count  type redop   time  algbw  busbw error   time  algbw  busbw error\n"
        "#    (B) (elements)            (us) (GB/s) (GB/s)         (us) (GB/s) (GB/s)\n"
        " 1048576  262144 float   sum  120.1   8.73   8.73 0e+00  119.0   8.81   8.81 0e+00\n"
    )
    assert parse_nccl_tests(text) == [
        {"size": 1048576, "count": 262144, "time_us": 120.1, "algbw": 8.73, "busbw": 8.73}
    ]


def _gid(root: Path, dev: str, i: int, gid: str, kind: str | None) -> None:
    p = root / dev / "ports" / "1"
    (p / "gids").mkdir(parents=True, exist_ok=True)
    (p / "gid_attrs" / "types").mkdir(parents=True, exist_ok=True)
    (p / "gids" / str(i)).write_text(gid + "\n")
    if kind is not None:
        (p / "gid_attrs" / "types" / str(i)).write_text(kind + "\n")


def test_roce_v2_ipv4_gid(tmp_path):
    ll = "fe80:0000:0000:0000:4ebb:47ff:fe7e:8173"
    v4 = "0000:0000:0000:0000:0000:ffff:0a64:0801"
    _gid(tmp_path, "rocep1s0f1", 0, ll, "IB/RoCE v1")
    _gid(tmp_path, "rocep1s0f1", 1, ll, "RoCE v2")
    _gid(tmp_path, "rocep1s0f1", 2, v4, "IB/RoCE v1")
    _gid(tmp_path, "rocep1s0f1", 3, v4, "RoCE v2")
    _gid(tmp_path, "rocep1s0f1", 10, "0" * 32, None)  # unpopulated: reading the type raises EINVAL
    assert roce_v2_ipv4_gid("rocep1s0f1", str(tmp_path)) == 3
    _gid(tmp_path, "rocep1s0f0", 0, ll, "IB/RoCE v1")
    _gid(tmp_path, "rocep1s0f0", 1, ll, "RoCE v2")
    assert roce_v2_ipv4_gid("rocep1s0f0", str(tmp_path)) is None
    assert roce_v2_ipv4_gid("missing", str(tmp_path)) is None


def test_port_listening(tmp_path):
    (tmp_path / "net").mkdir()
    (tmp_path / "net" / "tcp").write_text(
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        "   0: 00000000:4853 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n"
        "   1: 0100007F:1F40 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1\n"
    )
    assert port_listening(18515, str(tmp_path))  # 0x4853, LISTEN
    assert not port_listening(8000, str(tmp_path))  # 0x1F40 is ESTABLISHED, not LISTEN
