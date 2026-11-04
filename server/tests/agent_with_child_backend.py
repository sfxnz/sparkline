"""Run the real agent entry point with one GPU backend that owns a child process, as a macmon reader will.

usage: python agent_with_child_backend.py <agent.toml> <workdir>
open() starts `sleep` and writes its pid to <workdir>/child.pid; close() stops it and appends a line to
<workdir>/closed, so a test can see whether close() ran and how many times."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from platforms import gb10

from sparkline.agent import main as agent_main
from sparkline.agent.collectors import gpu
from sparkline.agent.collectors.gpu.backend import Chain
from sparkline.common.schema import GpuInfo, GpuSample

toml, work = sys.argv[1], Path(sys.argv[2])


class ChildBackend:
    name = "child"

    def __init__(self, src: object) -> None:
        self.child: subprocess.Popen[bytes] | None = None

    def open(self) -> list[GpuInfo]:
        self.child = subprocess.Popen(["sleep", "600"])
        (work / "child.pid").write_text(str(self.child.pid))
        return [GpuInfo(index=0, name="Child GPU")]

    def caps(self) -> dict:
        return {0: {}}

    def versions(self) -> dict:
        return {}

    def sample(self) -> list[GpuSample]:
        return [GpuSample(index=0, util=1.0)]

    def proc_mem(self) -> dict:
        return {}

    def proc_util(self) -> None:
        return None

    def close(self) -> None:
        with (work / "closed").open("a") as f:
            f.write(f"{self.name}\n")
        if self.child:
            self.child.terminate()
            self.child.wait(5)


gpu.CHAINS["linux"] = (Chain("amd", (ChildBackend,)),)
agent_main.live = gb10
sys.exit(agent_main.main(["--config", toml]))
