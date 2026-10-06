"""Fake benchmark payload speaking the JSON-line protocol, for runner tests. Usage: fake_payload.py MODE."""

import json
import os
import signal
import subprocess
import sys
import time


def emit(**m):
    print(json.dumps(m), flush=True)


mode = sys.argv[1]
if mode == "ok":
    emit(progress=0.5, phase="Half way")
    print("plain output line", flush=True)
    emit(series={"x": [1, 2]})
    emit(series={"x": [3]})
    emit(log="a log message")
    emit(result={"metric": "m", "label": "M", "value": 42.0, "unit": "u", "extras": {"k": 1}})
    emit(result={"metric": "bad"})  # invalid: ignored and logged
    emit(progress=1.0)
elif mode == "hang":
    # Parent and child both ignore SIGTERM, so only the SIGKILL escalation can stop them.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)",
        ]
    )
    with open("pids", "w") as f:
        f.write(f"{os.getpid()} {child.pid}")
    with open("scratch.tmp", "w") as f:
        f.write("x")
    emit(ready=True)
    emit(progress=0.1, phase="Hanging")
    time.sleep(600)
elif mode == "fail":
    emit(error={"message": "Payload says no", "cause": "because", "fix": "do this"})
    sys.exit(3)
elif mode == "crash":
    print("something went wrong: details", flush=True)
    sys.exit(2)
elif mode == "noresult":
    emit(progress=1.0)
elif mode == "soak":  # like thermal_soak.py: a TFLOPS gauge about every sample, results at the end
    time.sleep(0.4)
    for i in range(8):
        emit(gauge={"tflops": 91.0 if i % 2 else 92.5})
        emit(progress=i / 8, phase="Sustained load")
        time.sleep(0.2)
    emit(
        result={
            "metric": "tflops_first",
            "label": "BF16 TFLOPS, first window",
            "value": 92.5,
            "unit": "TFLOPS",
        }
    )
elif mode == "chatty":
    for i in range(200):
        emit(progress=i / 200)
        time.sleep(0.005)
    emit(result={"metric": "m", "label": "M", "value": 1.0, "unit": "u"})
