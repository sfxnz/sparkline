"""sparkline-capture: record this machine as a recorded platform that is safe to attach to a public issue.

It runs the agent's collectors once (startup, NodeInfo, one tick) with every reading traced, copies what they
read into a recorded-platform directory, and replaces every identifier with a placeholder. It refuses to
write anything when a reading is outside the reviewed read set (readset.py), when an identifier would
survive, or when replacing a name would change a reading. It then checks that the agent replays the result
as it ran live. Read only: it writes nothing outside its output directory.

usage: sparkline-capture [OUT]     (or: python -m sparkline.agent.capture [OUT])
"""

from __future__ import annotations

import argparse
import ctypes
import dataclasses
import datetime
import gzip
import io
import json
import logging
import os
import platform
import posixpath
import pwd
import re
import shutil
import signal
import socket
import stat
import sys
import tarfile
import time
import traceback
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, NoReturn, TypeVar

import psutil

from ..common.metrics import flatten
from ..common.schema import NodeInfo, Sample
from .capture_entry import STOP_SIGNALS, print_no_traceback_from_python, stopped
from .collectors.gpu import GpuCollector
from .config import AgentConfig
from .info import AGENT_VERSION, Collectors
from .readset import IDENTIFIER_FIELDS, matching
from .redact import (
    IN_A_READING,
    RENAME,
    CaptureRefused,
    Dir,
    Facts,
    File,
    Leak,
    Link,
    Node,
    Recording,
    Spellings,
    User,
    dumps,
    leaks,
    platform_doc,
    redact,
)
from .sampler import Sampler
from .sources import EthReader, NvmlReplay, RootFs, Sources, live, recorded

ISSUE_URL = "https://github.com/sfxnz/sparkline/issues/new"
ARCHIVE = "recording.tgz"
NODE_ID_NOT_THE_HOSTNAME = "capture"
DATA_DIR_NEVER_CREATED = "/nonexistent/sparkline-capture"
THIS_PROCESS = "/proc/self"
EAGAIN_TRIES = 10
EAGAIN_WAIT_S = 0.02
RECORDING = ("platform.json", "host.json", "nvml.json", "root")
NOT_SHOWN = "(a value that would name this machine is not shown)"
NOT_USABLE = 3

Need = Literal["content", "listing", "entry"]
T = TypeVar("T")

_PID = re.compile(r"/proc/(\d+)(?:/|$)")
_FAMILY = {socket.AF_INET: "AF_INET", socket.AF_INET6: "AF_INET6", psutil.AF_LINK: "AF_LINK"}


class OutputNotEmpty(Exception):
    pass


@dataclass
class Tape:
    needs: dict[str, set[Need]] = field(default_factory=dict)
    data: dict[str, bytes] = field(default_factory=dict)
    unreadable: list[str] = field(default_factory=list)
    nvml: dict[str, dict[str, Any]] = field(default_factory=dict)
    host: dict[str, Any] = field(
        default_factory=lambda: {"net_if_addrs": {}, "statvfs": {}, "ethtool": {}, "docker": {}, "which": {}}
    )

    def need(self, path: str, need: Need) -> None:
        self.needs.setdefault(path, set()).add(need)

    def content(self, path: str, host_path: str) -> None:
        self.need(path, "content")
        if path in self.data:
            return
        try:
            fd = os.open(host_path, os.O_RDONLY | os.O_CLOEXEC)
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            return
        except OSError:
            self.data[path] = b""
            self.unreadable.append(path)
            return
        try:
            self.data[path] = _read_all(fd)
        except IsADirectoryError:
            pass
        except OSError:
            self.data[path] = b""
            self.unreadable.append(path)
        finally:
            os.close(fd)


def _read_all(fd: int) -> bytes:
    for _ in range(EAGAIN_TRIES - 1):
        try:
            return _pread_all(fd)
        except BlockingIOError:  # an idle core's cpuinfo_avg_freq, until its next sample window
            time.sleep(EAGAIN_WAIT_S)
    return _pread_all(fd)


def _pread_all(fd: int) -> bytes:
    chunks: list[bytes] = []
    while chunk := os.pread(fd, 65536, sum(map(len, chunks))):
        chunks.append(chunk)
    return b"".join(chunks)


class TracingFs(RootFs):
    def __init__(self, inner: RootFs, tape: Tape) -> None:
        super().__init__(inner.root or "/")
        self._inner = inner
        self._tape = tape

    def host_path(self, p: str) -> str:
        host = self._inner.host_path(p)
        if os.path.isdir(host):
            self._tape.need(p, "entry")
        else:
            self._tape.content(p, host)
        return host

    def read(self, p: str) -> str:
        return self._agent_reads_first(self._inner.read, p)

    def read_once(self, p: str) -> str | None:
        return self._agent_reads_first(self._inner.read_once, p)

    def _agent_reads_first(self, read: Callable[[str], T], p: str) -> T:
        try:
            return read(p)
        finally:
            self._tape.content(p, self._inner.host_path(p))

    def exists(self, p: str) -> bool:
        self._tape.need(p, "entry")
        return self._inner.exists(p)

    def listdir(self, p: str) -> list[str]:
        self._tape.need(p, "listing")
        return self._inner.listdir(p)

    def glob(self, pattern: str) -> list[str]:
        found = self._inner.glob(pattern)
        for p in found:
            self._tape.need(p, "entry")
        return found

    def realpath(self, p: str) -> str:
        self._tape.need(p, "entry")
        return self._inner.realpath(p)


def _serial(v: Any) -> Any:
    if isinstance(v, bytes):
        return v.decode(errors="replace")
    if v is None or isinstance(v, bool | int | float | str):
        return v
    if isinstance(v, list | tuple | ctypes.Array):
        return [_serial(x) for x in v]
    if isinstance(v, ctypes.Structure):
        return {"__fields__": {f[0]: _serial(getattr(v, f[0])) for f in v._fields_}}
    if isinstance(v, ctypes._SimpleCData):
        return _serial(v.value)
    if hasattr(v, "__dict__"):
        return {"__fields__": {k: _serial(x) for k, x in vars(v).items()}}
    raise TypeError(f"cannot record an NVML {type(v).__name__}")


class RecordingNvml:
    def __init__(self, real: Any, table: dict[str, dict[str, Any]]) -> None:
        self._real = real
        self._table = table
        self._handles: list[tuple[Any, str]] = []

    def _arg(self, a: Any) -> Any:
        return next((name for h, name in self._handles if a is h), None) or _serial(a)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._real, name)
        if not name.startswith("nvml") or name == "nvmlShutdown":
            return attr

        def call(*args: Any) -> Any:
            key = json.dumps([self._arg(a) for a in args])
            calls = self._table.setdefault(name, {})
            try:
                result = attr(*args)
            except self._real.NVMLError as e:
                calls.setdefault(key, {"__error__": e.value, "str": str(e)})
                raise
            if name == "nvmlDeviceGetHandleByIndex":
                self._handles.append((result, f"gpu{args[0]}"))
                calls.setdefault(key, f"gpu{args[0]}")
            else:
                calls.setdefault(key, _serial(result))
            return result

        return call


class _RecordingReader:
    def __init__(self, reader: EthReader, record: Callable[[dict[str, Any]], None]) -> None:
        self._reader = reader
        self._record = record

    def read(self) -> dict[str, int]:
        try:
            stats = self._reader.read()
        except OSError as e:
            self._record({"error": str(e)})
            raise
        self._record({"stats": dict(stats)})
        return stats


def traced(src: Sources) -> tuple[Sources, Tape]:
    tape = Tape()
    host = tape.host

    def if_addrs() -> dict[str, list[Any]]:
        got = src.if_addrs()
        host["net_if_addrs"] = {
            name: [
                {"family": _FAMILY[a.family], "address": a.address, "netmask": a.netmask}
                for a in entries
                if a.family in _FAMILY
            ]
            for name, entries in got.items()
        }
        return got

    def statvfs(path: str) -> os.statvfs_result:
        st = src.statvfs(path)
        host["statvfs"].setdefault(path, list(st))
        return st

    def ethtool(ifname: str, wanted: list[str]) -> EthReader:
        def record(entry: dict[str, Any]) -> None:
            host["ethtool"].setdefault(ifname, entry)

        try:
            reader = src.ethtool(ifname, wanted)
        except OSError as e:
            record({"error": str(e)})
            raise
        return _RecordingReader(reader, record)

    def docker(path: str) -> Any:
        try:
            result = src.docker(path)
        except (OSError, ValueError) as e:
            host["docker"].setdefault(path, {"error": str(e)})
            raise
        host["docker"].setdefault(path, {"result": result})
        return result

    def which(name: str) -> str | None:
        found = src.which(name)
        host["which"].setdefault(name, found)
        return found

    readings: dict[str, Any] = {
        "platform": src.platform,
        "fs": TracingFs(src.fs, tape),
        "nvml": None if src.nvml is None else RecordingNvml(src.nvml, tape.nvml),
        "if_addrs": if_addrs,
        "statvfs": statvfs,
        "ethtool": ethtool,
        "docker": docker,
        "which": which,
    }
    untraced = sorted({f.name for f in dataclasses.fields(src)} - set(readings))
    if untraced:
        raise TypeError(f"traced() does not trace Sources.{', Sources.'.join(untraced)}")
    return Sources(**readings), tape


def exercise(src: Sources) -> tuple[NodeInfo, Sample, set[int]]:
    cfg = AgentConfig(node_id=NODE_ID_NOT_THE_HOSTNAME, data_dir=DATA_DIR_NEVER_CREATED)
    collectors = Collectors(cfg, src)
    try:
        info = collectors.node_info(cfg)
        sample = Sampler(cfg.node_id, collectors.ordered(), cfg.interval_ms, ring_seconds=10).tick()
        gpu_pids: set[int] = set()
        if collectors.gpu:
            ask_what_a_second_tick_asks(collectors.gpu)
            gpu_pids = set(collectors.gpu.proc_mem)
    finally:
        collectors.close()
    return info, sample, gpu_pids


def ask_what_a_second_tick_asks(gpu: GpuCollector) -> None:
    gpu.process_util()


def materialize(tape: Tape, inner: RootFs, gpu_pids: set[int]) -> tuple[dict[str, Node], set[int]]:
    tree: dict[str, Node] = {"/": Dir()}
    dropped: set[int] = set()
    seen: dict[str, Node | None] = {}

    def kept(path: str) -> bool:
        if path == "/proc/thread-self" or path.startswith("/proc/thread-self/"):
            return False
        if (m := _PID.match(path)) and int(m[1]) not in gpu_pids:
            dropped.add(int(m[1]))
            return False
        return True

    def node_at(path: str) -> Node | None:
        if path not in seen:
            seen[path] = _node_at(inner, path)
        return seen[path]

    def resolve(path: str, depth: int = 0) -> tuple[str, list[tuple[str, Node]]] | None:
        cur = "/"
        nodes: list[tuple[str, Node]] = []
        for part in [p for p in path.split("/") if p]:
            nxt = posixpath.join(cur, part)
            node = node_at(nxt) if kept(nxt) and depth < 40 else None
            if node is None:
                return None
            nodes.append((nxt, node))
            if isinstance(node, Link):
                target = resolve(posixpath.normpath(posixpath.join(cur, node.target)), depth + 1)
                if target is None:
                    return None
                cur, more = target
                nodes += more
            else:
                cur = nxt
        return cur, nodes

    def record(path: str) -> str | None:
        found = resolve(posixpath.normpath(path))
        if found is None:
            return None
        for p, node in found[1]:
            tree.setdefault(p, node)
        return found[0]

    at = {path: record(path) for path in tape.needs}
    for path, data in tape.data.items():
        r = at[path]
        if r is not None and isinstance(tree.get(r), File):
            tree[r] = File(data)
    listed: set[str] = set()
    for path, needs in tape.needs.items():
        r = at[path]
        if r is None or "listing" not in needs or not isinstance(tree.get(r), Dir):
            continue
        listed.add(r)
        try:
            names = os.listdir(inner.host_path(r))
        except OSError:
            continue
        for name in names:
            child = posixpath.join(r, name)
            if child not in tree and kept(child) and matching(child):
                tree[child] = File(b"")
    parents = {posixpath.dirname(p) for p in tree if p != "/"}
    for p, node in list(tree.items()):
        if isinstance(node, Dir) and p not in parents and p not in listed:
            tree[posixpath.join(p, ".keep")] = File(b"")
    return tree, dropped


def _node_at(inner: RootFs, path: str) -> Node | None:
    if path == THIS_PROCESS:
        return Dir()
    host = inner.host_path(path)
    try:
        st = os.lstat(host)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode):
        parent = posixpath.dirname(path)
        return Link(posixpath.relpath(posixpath.normpath(posixpath.join(parent, os.readlink(host))), parent))
    return Dir() if stat.S_ISDIR(st.st_mode) else File(b"")


def _users(passwd: str) -> list[User]:
    users = []
    for line in passwd.splitlines():
        f = line.split(":")
        if len(f) < 6 or not f[2].isdigit():
            continue
        if 1000 <= int(f[2]) < 60000 or f[5].startswith(("/home/", "/Users/")):  # login.defs UID_MIN..UID_MAX
            users.append(User(f[0], f[5], f[4].split(",")[0]))
    return users


def facts_of(src: Sources) -> Facts:
    fs = src.fs

    def read_text(p: str) -> str:
        try:
            return fs.read_once(p) or ""
        except UnicodeDecodeError:
            return ""

    def read(*paths: str) -> list[str]:
        return [v for p in paths if (v := read_text(p).strip("\0 \n"))]

    dmi = "/sys/class/dmi/id/"
    return Facts(
        hostnames=tuple(read("/proc/sys/kernel/hostname")),
        users=tuple(_users(read_text("/etc/passwd"))),
        machine_ids=tuple(read("/etc/machine-id", "/var/lib/dbus/machine-id")),
        serials=tuple(
            read(
                dmi + "product_serial",
                dmi + "board_serial",
                dmi + "chassis_serial",
                "/sys/firmware/devicetree/base/serial-number",
                *fs.glob("/sys/class/nvme/*/serial"),
                *fs.glob("/sys/block/*/device/serial"),
            )
        ),
        uuids=tuple(read(dmi + "product_uuid")),
        guids=tuple(
            read(
                *fs.glob("/sys/class/infiniband/*/node_guid"),
                *fs.glob("/sys/class/infiniband/*/sys_image_guid"),
            )
        ),
        macs=tuple(read(*fs.glob("/sys/class/net/*/address"))),
    )


def _session_facts(facts: Facts) -> Facts:
    me = pwd.getpwuid(os.getuid())
    full_name = me.pw_gecos.split(",")[0]
    return replace(
        facts,
        hostnames=(*facts.hostnames, socket.gethostname()),
        users=(
            *facts.users,
            User(me.pw_name, me.pw_dir, full_name),
            User(me.pw_name, str(Path.home()), full_name),
        ),
    )


def _meta(info: NodeInfo, tape: Tape, dropped: set[int]) -> dict[str, Any]:
    device = info.gpus[0].name if info.gpus else info.cpu_model or "unknown"
    unreadable = [p for p in tape.unreadable if not ((m := _PID.match(p)) and int(m[1]) in dropped)]
    return {
        "captured": f"{datetime.date.today().isoformat()}, read only, with sparkline-capture {AGENT_VERSION}",
        "device": device,
        "synthesized": False,
        "left_out": {"processes not using a GPU": len(dropped)} if dropped else {},
        "unreadable": sorted(unreadable),
    }


def write(rec: Recording, out: Path) -> None:
    root = out / "root"
    root.mkdir()
    for path in sorted(rec.tree):
        node = rec.tree[path]
        dest = root / path.lstrip("/")
        if isinstance(node, Dir):
            dest.mkdir(exist_ok=True)
        elif isinstance(node, File):
            dest.write_bytes(node.data)
        else:
            os.symlink(node.target, dest)
    (out / "nvml.json").write_text(dumps(rec.nvml))
    (out / "host.json").write_text(dumps(rec.host))
    (out / "platform.json").write_text(dumps(platform_doc(rec)))


def _normalized(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.mode = 0o755 if info.isdir() else 0o777 if info.issym() else 0o644
    return info


def write_archive(out: Path) -> Path:
    archive = out / ARCHIVE
    members = [out / name for name in RECORDING]
    members += sorted(p for p in (out / "root").rglob("*"))
    buf = io.BytesIO()
    with (
        gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz,
        tarfile.open(fileobj=gz, mode="w") as tar,
    ):
        for p in members:
            tar.add(p, arcname=p.relative_to(out).as_posix(), recursive=False, filter=_normalized)
    archive.write_bytes(buf.getvalue())
    return archive


def _in_an_order_no_rename_moves(items: list[Any]) -> list[Any]:
    return sorted(items, key=lambda v: json.dumps(v, sort_keys=True))


def _masked(doc: Any, where: str) -> Any:
    if where in IDENTIFIER_FIELDS:
        return "an identifier"
    if isinstance(doc, dict):
        return {k: _masked(v, f"{where}.{k}") for k, v in doc.items()}
    if isinstance(doc, list):
        return _in_an_order_no_rename_moves([_masked(v, f"{where}[*]") for v in doc])
    return doc


def _proc_texts(sample: Sample, pids: set[int]) -> list[dict[str, Any]]:
    return [
        {
            k: v
            for k, v in p.model_dump(mode="json").items()
            if isinstance(v, str) and f"procs[*].{k}" not in IDENTIFIER_FIELDS
        }
        for p in sorted(sample.procs or [], key=lambda p: p.pid)
        if p.pid in pids
    ]


def _differences(live: Any, replay: Any, where: str) -> list[tuple[str, Any]]:
    if isinstance(live, dict) and isinstance(replay, dict):
        return [
            d
            for k in sorted(set(live) | set(replay))
            for d in _differences(live.get(k), replay.get(k), f"{where}.{k}")
        ]
    if isinstance(live, list) and isinstance(replay, list) and len(live) == len(replay):
        return [d for x, y in zip(live, replay, strict=True) for d in _differences(x, y, f"{where}[*]")]
    return [] if live == replay else [(where, live)]


def _instance_masked(key: str) -> str:
    family, _, rest = key.partition(".")
    return f"{family}.*.{rest.rpartition('.')[2]}" if family in ("net", "fs") and "." in rest else key


def _family(key: str) -> str:
    parts = key.split(".")
    if parts[0] == "temp":
        return "temp.*"
    return f"{parts[0]}.*.{parts[-1]}" if len(parts) > 2 else key


def replay_check(info: NodeInfo, sample: Sample, out: Path, names: Spellings) -> tuple[list[str], list[Leak]]:
    src = recorded(out)
    try:
        rinfo, rsample, _ = exercise(src)
    except Exception as e:
        failed = Leak("the replay of the recording", f"failed with {type(e).__name__}")
        raise CaptureRefused(
            [failed], "\n".join(["Where it failed:", *where_it_failed_without_the_message(e)])
        ) from e
    found = _differences(
        _masked(info.model_dump(mode="json"), "node_info"),
        _masked(rinfo.model_dump(mode="json"), "node_info"),
        "node_info",
    )
    both = {p.pid for p in sample.procs or []} & {p.pid for p in rsample.procs or []}
    found += _differences(_proc_texts(sample, both), _proc_texts(rsample, both), "procs")
    flat = flatten(sample)
    replayed = Counter(_instance_masked(k) for k in flatten(rsample))
    wanted = Counter(_instance_masked(k) for k in flat)
    lost = {k for k, n in wanted.items() if replayed[k] < n}
    found += [(f"sample key {_family(k)}", k) for k in sorted(flat) if _instance_masked(k) in lost]
    collided = {
        c for _, live in found for c in names.names_in(live if isinstance(live, str) else json.dumps(live))
    }
    differences = list(dict.fromkeys(where for where, _ in found))
    if isinstance(src.nvml, NvmlReplay):
        differences += [
            f"NVML call {m.split('[')[0]} is not in the recording" for m in dict.fromkeys(src.nvml.misses)
        ]
    return differences, [Leak(IN_A_READING, c) for c in sorted(collided)]


@dataclass(frozen=True)
class Report:
    out: Path
    archive: Path
    counts: dict[str, int]
    left_out: dict[str, int]
    unreadable: int
    differences: list[str]
    printable: Callable[[str], str | None] = field(repr=False)


@contextmanager
def _stop_signals_held() -> Iterator[None]:
    previous = {s: signal.signal(s, signal.SIG_IGN) for s in STOP_SIGNALS}
    try:
        yield
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)


def _remove(out: Path, created: bool) -> None:
    if created:
        shutil.rmtree(out, ignore_errors=True)
        return
    for child in out.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def capture(src: Sources, out: Path, facts: Facts) -> Report:
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise OutputNotEmpty("the output directory already exists and is not empty")
    tsrc, tape = traced(src)
    info, sample, gpu_pids = exercise(tsrc)
    tree, dropped = materialize(tape, src.fs, gpu_pids)
    raw = Recording(src.platform, _meta(info, tape, dropped), tree, tape.nvml, tape.host)
    red = redact(raw, facts)
    if red.collisions:
        raise CaptureRefused(red.collisions, RENAME)
    found = leaks(red)
    if found:
        raise CaptureRefused(found)
    created = not out.exists()
    try:
        out.mkdir(exist_ok=True)
        write(red.recording, out)
        differences, collided = replay_check(info, sample, out, red.originals)
        if collided:
            raise CaptureRefused(collided, RENAME)
        archive = write_archive(out)
    except BaseException:
        with _stop_signals_held():
            _remove(out, created)
        raise
    return Report(
        out,
        archive,
        red.counts,
        red.left_out,
        len(red.recording.meta["unreadable"]),
        differences,
        red.printable,
    )


def _summary(report: Report, default_name: str | None) -> str:
    def listed(counts: dict[str, int]) -> str:
        return "\n".join(f"  {name}: {n}" for name, n in counts.items()) or "  nothing"

    def shown(value: str) -> str:
        return NOT_SHOWN if (text := report.printable(value)) is None else text

    lines = [
        f"Recorded this machine into {default_name or 'the output directory you gave'}.",
        "Replaced with placeholders (counts only):",
        listed(report.counts),
        "Left out:",
        listed(report.left_out),
    ]
    if report.unreadable:
        noun = "file" if report.unreadable == 1 else "files"
        lines.append(
            f"Could not read {report.unreadable} {noun}, recorded empty and listed in platform.json."
        )
    if report.differences:
        lines += [
            "Replay check: the recording does not replay as this machine ran. Please paste these lines into",
            "the issue (they hold no values):",
            *[f"  {shown(d)}" for d in report.differences],
        ]
    else:
        lines.append("Replay check: the recording replays as this machine ran.")
    lines += [f"Attach {ARCHIVE} from {default_name or 'that directory'} to a new issue: {ISSUE_URL}"]
    return "\n".join(lines)


def silence_logs_that_name_unredacted_paths() -> None:
    logging.disable(logging.CRITICAL)


def where_it_failed_without_the_message(e: BaseException) -> list[str]:
    return [
        f"  {Path(f.filename).name}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__)
    ]


class _Arguments(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        print("sparkline-capture takes at most one argument, the output directory.", file=sys.stderr)
        raise SystemExit(NOT_USABLE)


def main(argv: list[str] | None = None) -> int:
    print_no_traceback_from_python()
    try:
        return _run(argv)
    except KeyboardInterrupt as e:
        return stopped(e)


def _run(argv: list[str] | None) -> int:
    parser = _Arguments(
        prog="sparkline-capture",
        description="Record this machine as a redacted recorded platform to attach to a Sparkline issue.",
    )
    default = f"sparkline-{sys.platform}-{platform.machine()}"
    parser.add_argument(
        "out",
        nargs="?",
        default=default,
        help="output directory, which must not exist or be empty (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    silence_logs_that_name_unredacted_paths()
    try:
        src = live()
        report = capture(src, Path(os.path.expanduser(args.out)), _session_facts(facts_of(src)))
        print(_summary(report, default if args.out == default else None))
    except OutputNotEmpty:
        print(
            "The output directory already exists and is not empty. Choose another directory.", file=sys.stderr
        )
        return NOT_USABLE
    except CaptureRefused as e:
        print(e, file=sys.stderr)
        print(f"Please open an issue saying so (paste the lines above): {ISSUE_URL}", file=sys.stderr)
        return 2
    except Exception as e:
        frames = where_it_failed_without_the_message(e)
        print(f"sparkline-capture failed with {type(e).__name__} (message not shown):", file=sys.stderr)
        print("\n".join(frames), file=sys.stderr)
        print(f"Please open an issue with these lines: {ISSUE_URL}", file=sys.stderr)
        return 4
    return 1 if report.differences else 0


if __name__ == "__main__":
    sys.exit(main())
