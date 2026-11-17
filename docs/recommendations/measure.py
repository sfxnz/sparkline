#!/usr/bin/env python3
"""Measure what one Sparkline recommendation does on a real DGX Spark. Standard library only.

The evidence files in this directory were produced with this script. It switches one setting on and off in
alternating arms (control, candidate, control, candidate), runs the same load in every arm, samples
temperature, power and clocks every two seconds, and puts the machine back as it found it when it ends,
is interrupted or fails. It needs root only to switch the setting, so read it before you run it:

  sudo python3 measure.py gpu-clock-cap --found on  --base-url http://127.0.0.1:8000 --model NAME
  sudo python3 measure.py cpu-pcore-cap --found off --base-url http://127.0.0.1:8000 --model NAME
  sudo python3 measure.py headless-boot --found on  --arm-s 120        # memory only, no model server

--found says whether the setting is on or off right now. The GPU driver has no field that reports a clock
cap, so the script cannot find that out by itself. The first arm runs in that state and the last thing the
script does is return to it.

A model served by two Sparks: start the same command at the same --start-at time on both. Give the second
node --no-load, so it switches and samples on the same timetable while the first node drives the requests.

Per arm, on the node that drives the load: --reps single-stream decode requests (decode tok/s from the
server's own token count, timed from the first to the last streamed token), one cold prefill of about
--prefill-tokens tokens on a prompt never seen before, then --streams concurrent streams until the arm
ends. Temperatures are the hottest thermal zone over the last --tail-s seconds of the arm.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import random
import signal
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

GPU_CAP_MHZ = 2200
CPU_CAP_KHZ = 3_000_000
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
PROMPTS = [
    "Write a Python implementation of an LRU cache with O(1) get and put, with docstrings and tests.",
    "Explain, step by step, how TCP congestion control works, including slow start and fast recovery.",
    "Write a short story of about 600 words about a lighthouse keeper who finds a message in a bottle.",
    "Compare B-trees and LSM-trees for a write-heavy database workload, and give a recommendation.",
    "Write a bash script that backs up a directory to a timestamped tar.gz and keeps the last 7 backups.",
    "Summarise the causes and consequences of the 1929 stock market crash in five paragraphs.",
]
WORDS = "river stone paper cloud engine garden silver market winter orange signal harbor violet candle".split()


def run(argv: list[str]) -> str:
    return subprocess.run(argv, env=ENV, check=True, capture_output=True, text=True, timeout=60).stdout


def read(path: str) -> str:
    with open(path) as f:
        return f.read().strip()


def pcore_policies() -> list[str]:
    """cpufreq policies of the cores that can run faster than the cap (the performance cores)."""
    return [
        p
        for p in sorted(glob.glob("/sys/devices/system/cpu/cpufreq/policy*"))
        if int(read(f"{p}/cpuinfo_max_freq")) > CPU_CAP_KHZ
    ]


def set_pcores(khz: int | None) -> None:
    for p in pcore_policies():
        with open(f"{p}/scaling_max_freq", "w") as f:
            f.write(str(khz if khz is not None else int(read(f"{p}/cpuinfo_max_freq"))))


@dataclass(frozen=True)
class Setting:
    on: Callable[[], object]
    off: Callable[[], object]
    load: bool  # False: nothing to load, the measurement is memory


SETTINGS = {
    "gpu-clock-cap": Setting(
        on=lambda: run(["/usr/bin/nvidia-smi", "-lgc", f"0,{GPU_CAP_MHZ}"]),
        off=lambda: run(["/usr/bin/nvidia-smi", "-rgc"]),
        load=True,
    ),
    "cpu-pcore-cap": Setting(on=lambda: set_pcores(CPU_CAP_KHZ), off=lambda: set_pcores(None), load=True),
    # "on" is the recommended state: no desktop running.
    "headless-boot": Setting(
        on=lambda: run(["/usr/bin/systemctl", "stop", "gdm"]),
        off=lambda: run(["/usr/bin/systemctl", "start", "gdm"]),
        load=False,
    ),
}


def cgroup_bytes(pattern: str) -> int:
    return sum(int(read(p)) for p in glob.glob(pattern))


def sample() -> dict:
    zones = {}
    for z in glob.glob("/sys/class/thermal/thermal_zone*"):
        try:
            zones[os.path.basename(z)] = int(read(f"{z}/temp")) / 1000
        except (OSError, ValueError):
            continue
    q = "clocks.current.sm,power.draw,temperature.gpu,utilization.gpu"
    try:
        out = run(["/usr/bin/nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"])
        gpu = [float(x) for x in out.split(",")]
    except (subprocess.SubprocessError, ValueError):
        gpu = [float("nan")] * 4
    mem = {k: int(v.split()[0]) for k, v in (line.split(":") for line in read("/proc/meminfo").splitlines())}
    fans = []
    for f in glob.glob("/sys/class/hwmon/hwmon*/fan*_input"):
        try:
            fans.append(int(read(f)))
        except (OSError, ValueError):
            continue
    cur = [int(read(f"{p}/scaling_cur_freq")) for p in pcore_policies()]
    return {
        "ts": time.time(),
        "zone_max_c": max(zones.values(), default=float("nan")),
        "zones_c": zones,
        "gpu_clock_mhz": gpu[0],
        "gpu_power_w": gpu[1],
        "gpu_temp_c": gpu[2],
        "gpu_util_pct": gpu[3],
        "pcore_max_khz": max(cur, default=0),
        "fan_rpm": fans,
        "mem_available_kb": mem["MemAvailable"],
        "desktop_bytes": cgroup_bytes("/sys/fs/cgroup/system.slice/gdm.service/memory.current")
        + cgroup_bytes("/sys/fs/cgroup/user.slice/user-*.slice/session-c*.scope/memory.current"),
        "load1": os.getloadavg()[0],
    }


class Client:
    def __init__(self, base_url: str, model: str, key: str | None):
        self.url, self.model, self.key = base_url.rstrip("/") + "/v1/chat/completions", model, key
        self.failed = 0

    def stream(self, prompt: str, max_tokens: int) -> dict | None:
        """One request. Returns prompt and completion token counts from the server, time to first token and
        the first-to-last-token time, or None (counted) when it failed or produced nothing."""
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        req = urllib.request.Request(self.url, json.dumps(body).encode(), headers)
        t0, first, last, usage, chars = time.monotonic(), None, None, None, 0
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if not line.startswith("data:") or line == "data: [DONE]":
                        continue
                    msg = json.loads(line[5:])
                    usage = msg.get("usage") or usage
                    delta = (msg.get("choices") or [{}])[0].get("delta") or {}
                    text = (delta.get("content") or "") + (delta.get("reasoning_content") or "")
                    if text:
                        last = time.monotonic()
                        first = first or last
                        chars += len(text)
        except (OSError, ValueError):
            self.failed += 1
            return None
        if not usage or first is None or last is None or not chars:
            self.failed += 1
            return None
        return {
            "prompt_tokens": usage["prompt_tokens"],
            "completion_tokens": usage["completion_tokens"],
            "ttft_s": first - t0,
            "decode_s": last - first,
        }


def arm_load(c: Client, a: argparse.Namespace, end: float, tag: str) -> dict:
    decode = []
    for i in range(a.reps):
        r = c.stream(PROMPTS[i % len(PROMPTS)], a.max_tokens)
        if r and r["decode_s"] > 0:
            decode.append((r["completion_tokens"] - 1) / r["decode_s"])
    rng = random.Random(tag)  # a prompt no earlier arm sent, so no prefix cache can answer it
    cold = f"[{tag}] " + " ".join(rng.choice(WORDS) for _ in range(a.prefill_tokens)) + "\nReply with OK."
    p = c.stream(cold, 4)
    prefill = p["prompt_tokens"] / p["ttft_s"] if p else None

    def soak(i: int) -> int:
        n = 0
        while time.time() < end:
            r = c.stream(PROMPTS[(i + n) % len(PROMPTS)], a.max_tokens)
            n += 1
            if r is None:
                time.sleep(1)
                continue
            soak_tokens.append(r["completion_tokens"])
        return n

    soak_tokens: list[int] = []
    t0 = time.time()
    with ThreadPoolExecutor(a.streams) as ex:
        list(ex.map(soak, range(a.streams)))
    return {
        "c1_decode_tok_s": decode,
        "c1_decode_median": statistics.median(decode) if decode else None,
        "prefill_tok_s": prefill,
        "prefill_prompt_tokens": p["prompt_tokens"] if p else None,
        "soak_tok_s": sum(soak_tokens) / max(1e-9, time.time() - t0),
        "soak_requests": len(soak_tokens),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("setting", choices=sorted(SETTINGS))
    ap.add_argument("--found", choices=["on", "off"], required=True, help="the setting's state right now")
    ap.add_argument("--arms", type=int, default=4)
    ap.add_argument("--arm-s", type=int, default=480)
    ap.add_argument("--tail-s", type=int, default=120)
    ap.add_argument("--start-at", help="HH:MM:SS local time, to run two nodes on one timetable")
    ap.add_argument("--no-load", action="store_true", help="switch and sample only (second node)")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--model")
    ap.add_argument("--reps", type=int, default=6)
    ap.add_argument("--streams", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=400)
    ap.add_argument("--prefill-tokens", type=int, default=6000)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    s = SETTINGS[a.setting]
    drive = s.load and not a.no_load
    if drive and not a.model:
        ap.error("--model is required on the node that drives the load")
    if os.geteuid() != 0:
        ap.error("run with sudo: switching the setting needs root")

    def switch(state: str) -> None:
        (s.on if state == "on" else s.off)()

    def restore(*_: object) -> None:
        switch(a.found)
        print(f"restored: {a.setting} is {a.found} again", flush=True)

    def stop(signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    if a.start_at:
        h, m, sec = (int(x) for x in a.start_at.split(":"))
        now = time.localtime()
        wait = (h - now.tm_hour) * 3600 + (m - now.tm_min) * 60 + (sec - now.tm_sec)
        if wait < 0:
            ap.error("--start-at is in the past")
        print(f"waiting {wait} s for {a.start_at}", flush=True)
        time.sleep(wait)

    client = Client(a.base_url, a.model or "", os.environ.get("MEASURE_API_KEY"))
    other = "off" if a.found == "on" else "on"
    samples: list[dict] = []
    arms: list[dict] = []
    done = threading.Event()

    def sampler() -> None:
        while not done.wait(2):
            samples.append(sample())

    threading.Thread(target=sampler, daemon=True).start()
    start = time.time()
    try:
        for i in range(a.arms):
            state = a.found if i % 2 == 0 else other
            t0 = start + i * a.arm_s
            end = t0 + a.arm_s
            switch(state)
            print(f"arm {i + 1}/{a.arms}: {a.setting} {state}", flush=True)
            arm = {"arm": i + 1, "state": state, "t0": t0, "t1": end}
            if drive:
                arm.update(arm_load(client, a, end, f"{int(start)}-{i}"))
            time.sleep(max(0.0, end - time.time()))
            tail = [x for x in samples if end - a.tail_s <= x["ts"] <= end]
            whole = [x for x in samples if t0 <= x["ts"] <= end]
            arm.update(
                zone_max_c_tail_mean=statistics.fmean(x["zone_max_c"] for x in tail),
                zone_max_c_peak=max(x["zone_max_c"] for x in whole),
                gpu_temp_c_tail_mean=statistics.fmean(x["gpu_temp_c"] for x in tail),
                gpu_power_w_tail_mean=statistics.fmean(x["gpu_power_w"] for x in tail),
                gpu_clock_mhz_peak=max(x["gpu_clock_mhz"] for x in whole),
                gpu_util_pct_tail_mean=statistics.fmean(x["gpu_util_pct"] for x in tail),
                pcore_max_khz_peak=max(x["pcore_max_khz"] for x in whole),
                mem_available_kb_tail_mean=statistics.fmean(x["mem_available_kb"] for x in tail),
                desktop_bytes_tail_mean=statistics.fmean(x["desktop_bytes"] for x in tail),
                load1_mean=statistics.fmean(x["load1"] for x in whole),
            )
            arms.append(arm)
            print(json.dumps({k: v for k, v in arm.items() if k != "c1_decode_tok_s"}), flush=True)
    finally:
        done.set()
        restore()
    out = a.out or f"measure-{a.setting}-{time.strftime('%Y%m%dT%H%M%S', time.localtime(start))}.json"
    result = {
        "setting": a.setting,
        "found": a.found,
        "args": {k: v for k, v in vars(a).items() if k != "out"},
        "kernel": os.uname().release,
        "driver": run(["/usr/bin/nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"]).strip(),
        "failed_requests": client.failed,
        "arms": arms,
        "samples": samples,
    }
    with open(out, "w") as f:
        json.dump(result, f)
    if os.environ.get("SUDO_UID"):
        os.chown(out, int(os.environ["SUDO_UID"]), int(os.environ.get("SUDO_GID", "-1")))
    print(f"wrote {out}. failed requests: {client.failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
