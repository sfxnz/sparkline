"""Built-in storage benchmark (host Python), used when fio is not installed.

O_DIRECT with page-aligned mmap buffers (os.preadv / os.pwrite), falling back to buffered I/O with
extras.direct=false only if the filesystem refuses O_DIRECT. Profiles: sequential write 1 MiB (writes the
whole file once, fsync included), sequential read 1 MiB, random read/write 4 KiB from N forked worker
processes at queue depth 1 each (random write ends with fsync). The test file is always removed (finally, also
on SIGTERM).
"""

from __future__ import annotations

import argparse
import contextlib
import errno
import mmap
import multiprocessing as mp
import os
import queue
import random
import time
from array import array

from benchlib import fail, log, on_sigterm, progress, result

SEQ_BS = 2**20
RAND_BS = 4096
LABEL = {
    "seq_write": "Sequential write 1 MiB",
    "seq_read": "Sequential read 1 MiB",
    "rand_read": "Random read 4 KiB",
    "rand_write": "Random write 4 KiB",
}


def open_file(path: str, flags: int) -> tuple[int, bool]:
    try:
        return os.open(path, flags | os.O_DIRECT, 0o600), True
    except OSError as e:
        if e.errno != errno.EINVAL:
            raise
        return os.open(path, flags, 0o600), False


def p99(lat: array) -> float:
    s = sorted(lat)
    return s[min(len(s) - 1, int(len(s) * 0.99))] if s else 0.0


def seq_write(path: str, size: int) -> tuple[float, float, int, array, bool]:
    fd, direct = open_file(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    buf = mmap.mmap(-1, SEQ_BS)
    buf.write(os.urandom(SEQ_BS))
    lat = array("f")
    try:
        t0 = time.perf_counter()
        for off in range(0, size, SEQ_BS):
            t = time.perf_counter()
            os.pwrite(fd, buf, off)
            lat.append((time.perf_counter() - t) * 1e6)
        os.fsync(fd)
        elapsed = time.perf_counter() - t0
    finally:
        os.close(fd)
    return size, elapsed, size // SEQ_BS, lat, direct


def seq_read(path: str, size: int, runtime: float) -> tuple[float, float, int, array, bool]:
    fd, direct = open_file(path, os.O_RDONLY)
    buf = mmap.mmap(-1, SEQ_BS)
    lat = array("f")
    done = ops = off = 0
    try:
        t0 = time.perf_counter()
        deadline = t0 + runtime
        while True:
            t = time.perf_counter()
            n = os.preadv(fd, [buf], off)
            lat.append((time.perf_counter() - t) * 1e6)
            done, ops = done + n, ops + 1
            off = off + SEQ_BS if off + SEQ_BS < size else 0
            if t >= deadline:
                break
        elapsed = time.perf_counter() - t0
    finally:
        os.close(fd)
    return done, elapsed, ops, lat, direct


def _rand_worker(path: str, size: int, write: bool, i: int, go, stop_at, q) -> None:
    on_sigterm()
    try:
        fd, direct = open_file(path, os.O_RDWR if write else os.O_RDONLY)
    except OSError as e:
        q.put((i, str(e)))
        return
    rng = random.Random(1000 + i)
    blocks = size // RAND_BS
    buf = mmap.mmap(-1, RAND_BS)
    if write:
        buf.write(os.urandom(RAND_BS))
    lat, n = array("f"), 0
    try:
        go.wait()
        stop = stop_at.value
        while True:
            off = rng.randrange(blocks) * RAND_BS
            t = time.perf_counter()
            if write:
                os.pwrite(fd, buf, off)
            else:
                os.preadv(fd, [buf], off)
            lat.append((time.perf_counter() - t) * 1e6)
            n += 1
            if t >= stop:
                break
        q.put((i, (n, time.perf_counter(), direct, lat.tobytes())))
    except OSError as e:
        q.put((i, str(e)))
    finally:
        os.close(fd)


def rand_io(path: str, size: int, runtime: float, threads: int, write: bool):
    """QD1 4 KiB I/O from ``threads`` forked workers (one GIL each, so the GIL never queues the I/O
    or inflates its latency); the clock runs from the start signal to the last worker's last I/O."""
    ctx = mp.get_context("fork")
    go, stop_at, q = ctx.Event(), ctx.Value("d", 0.0), ctx.Queue()
    procs = [
        ctx.Process(target=_rand_worker, args=(path, size, write, i, go, stop_at, q), daemon=True)
        for i in range(threads)
    ]
    for p in procs:
        p.start()
    t0 = time.perf_counter()
    stop_at.value = t0 + runtime  # CLOCK_MONOTONIC: one clock for every process
    go.set()
    outs = []
    try:
        for _ in procs:
            i, out = q.get(timeout=runtime + 30)
            if isinstance(out, str):
                raise OSError(f"worker {i}: {out}")
            outs.append(out)
    except queue.Empty:
        raise OSError("a random I/O worker exited without reporting") from None
    finally:
        for p in procs:
            p.join(5)
    elapsed = max(o[1] for o in outs) - t0
    if write:
        t = time.perf_counter()
        fd = os.open(path, os.O_RDWR)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        elapsed += time.perf_counter() - t
    ops = sum(o[0] for o in outs)
    merged = array("f")
    for o in outs:
        merged.frombytes(o[3])
    return ops * RAND_BS, elapsed, ops, merged, all(o[2] for o in outs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--file", required=True)
    ap.add_argument("--size-mib", type=int, required=True)
    ap.add_argument("--runtime", type=float, default=10.0)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--profiles", default="seq_write,seq_read,rand_read,rand_write")
    a = ap.parse_args()
    on_sigterm()
    size = a.size_mib * 2**20
    profiles = a.profiles.split(",")
    order = [p for p in ("seq_write", "seq_read", "rand_read", "rand_write") if p in profiles]
    try:
        if "seq_write" not in order:
            order.insert(0, "fill")  # the read profiles need a written file
        for i, prof in enumerate(order):
            progress(i / len(order), "Writing test file" if prof == "fill" else LABEL[prof])
            if prof in ("fill", "seq_write"):
                nbytes, el, ops, lat, direct = seq_write(a.file, size)
            elif prof == "seq_read":
                nbytes, el, ops, lat, direct = seq_read(a.file, size, a.runtime)
            else:
                nbytes, el, ops, lat, direct = rand_io(
                    a.file, size, a.runtime, a.threads, prof == "rand_write"
                )
            if prof == "fill":
                continue
            if not direct:
                log("O_DIRECT refused by this filesystem: buffered I/O used (page cache may inflate reads)")
            ex = {
                "method": "builtin",
                "direct": direct,
                "size_mib": a.size_mib,
                "seconds": round(el, 3),
                "threads": a.threads if prof.startswith("rand") else 1,
                "ops": ops,
            }
            result(f"{prof}_mbps", LABEL[prof], round(nbytes / el / 1e6, 1), "MB/s", **ex)
            if prof.startswith("rand"):
                result(f"{prof}_iops", f"{LABEL[prof]} IOPS", round(ops / el, 1), "IOPS", **ex)
            result(f"{prof}_p99_us", f"{LABEL[prof]} p99 latency", round(p99(lat), 1), "us", "lower", **ex)
    except OSError as e:
        fail("Storage benchmark I/O error", f"{a.file}: {e}", "Check free space and the bench work directory")
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(a.file)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
