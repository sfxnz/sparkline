"""The settings the Recommendations tab offers. One entry per setting, shipped in the release: nothing here
is fetched. Each id is also the key of its probe (agent/recommend.py) and, when one_click, of its root
action (tune.py).

An entry is shown as a community claim until it carries a measurement made on a real DGX Spark, with its
evidence in docs/recommendations/<id>.md. Benefits and costs below are what owners report, with the numbers
attributed. Sources are pages that were opened and read in full.
"""

from __future__ import annotations

from .schema import Recommendation, RecSource

GPU_CLOCK_CAP_MHZ = 2200
CPU_PCORE_CAP_MHZ = 3000

FORUM = "https://forums.developer.nvidia.com/t"
OPTIMIZE_THREAD = RecSource(
    title="NVIDIA forum: Let's optimize DGX Spark", url=f"{FORUM}/lets-optimize-dgx-spark/387929"
)
STABILITY_THREAD = f"{FORUM}/dgx-spark-stability-out-of-ram-overheating/368536"
FAN_THREAD = (
    f"{FORUM}/new-dgx-spark-fans-barely-speed-up-at-high-temps-and-cant-be-adjusted-critical-please-open-"
    "fan-control/386805"
)
RELEASE_NOTES = "https://docs.nvidia.com/dgx/dgx-spark/release-notes.html"
DISPLAY_REQUEST = (
    "/sys/firmware/efi/efivars/NvidiaDispFrmSizeRequest-284e19b9-235f-4aab-ae4c-190456d1bd76"  # NVIDIA's name
)


def boot_unit(name: str, description: str, after: str, start: str, stop: str) -> list[str]:
    """The commands that install a oneshot unit which applies a setting at every boot."""
    return [
        f"""sudo tee /etc/systemd/system/{name}.service >/dev/null <<'EOF'
[Unit]
Description={description}
Wants={after}
After={after}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={start}
ExecStop={stop}

[Install]
WantedBy=multi-user.target
EOF""",
        "sudo systemctl daemon-reload",
        f"sudo systemctl enable --now {name}.service",
    ]


def remove_boot_unit(name: str) -> list[str]:
    return [
        f"sudo systemctl disable --now {name}.service",
        f"sudo rm /etc/systemd/system/{name}.service",
        "sudo systemctl daemon-reload",
    ]


CATALOG: list[Recommendation] = [
    Recommendation(
        id="gpu-clock-cap",
        title=f"Cap the GPU clock at {GPU_CLOCK_CAP_MHZ} MHz",
        summary=(
            "Sets a ceiling on the GPU clock, which otherwise boosts to about 2400 to 2510 MHz under load. "
            "It is the setting DGX Spark owners recommend most often on NVIDIA's forum. It takes effect at "
            "once and is forgotten at a reboot, so it has to be applied again at every boot."
        ),
        goal="cooler",
        benefit=(
            "Owners report a cooler GPU that draws less power under sustained load. With a 2200 MHz cap, "
            "maxeffort saw GPU power fall from 84 W to 51 W, and peter.h177 saw the wall power of two nodes "
            "fall from 330 W to 274 W. Several owners report that a cap stopped their units from powering "
            "off under sustained load."
        ),
        cost=(
            "Owners report little or no loss in LLM decode speed, which is limited by memory bandwidth: "
            "peter.h177 measured 51.43 tokens/s at 2200 MHz against 51.34 at 2400 MHz. Work that is limited "
            "by GPU compute slows with the clock: at 2000 MHz, paxren2020 reports prefill about 10 % slower "
            "and azampatti reports 10 % fewer tokens/s on one model."
        ),
        sources=[
            RecSource(
                title="NVIDIA forum: NVIDIA staff suggest capping GPU clocks as an experiment (post 23)",
                url=STABILITY_THREAD,
            ),
            RecSource(
                title="NVIDIA forum: Cooler GB10 temps, almost no performance lost",
                url=f"{FORUM}/cooler-gb10-temps-almost-no-performance-lost/372662",
            ),
            RecSource(
                title="NVIDIA forum: peter.h177's sweep of GPU clocks from 1400 to 2400 MHz",
                url=(
                    f"{FORUM}/it-makes-no-sense-to-me-anymore-to-run-my-sparks-above-a-1400-1700-mhz-gpu-"
                    "clock/379389"
                ),
            ),
            RecSource(
                title="NVIDIA forum: maxeffort's power readings with and without a cap", url=FAN_THREAD
            ),
        ],
        measurement=None,
        apply=[
            f"sudo nvidia-smi -lgc 0,{GPU_CLOCK_CAP_MHZ}",
            *boot_unit(
                "gpu-clock-cap",
                f"Cap the GPU clock at {GPU_CLOCK_CAP_MHZ} MHz",
                "nvidia-persistenced.service",
                f"/usr/bin/nvidia-smi -lgc 0,{GPU_CLOCK_CAP_MHZ}",
                "/usr/bin/nvidia-smi -rgc",
            ),
        ],
        undo=["sudo nvidia-smi -rgc", *remove_boot_unit("gpu-clock-cap")],
        one_click=True,
        persists="until-reboot",
        risks=[
            "The cap is forgotten at a reboot. Sparkline applies it again at boot when Sparkline applied it; "
            "by hand it needs the unit above.",
            "It does not cool the CPU cores, which are often the hottest part: peter.h177 saw the SoC zone "
            "at 90 to 96 °C at every GPU clock.",
            f"{GPU_CLOCK_CAP_MHZ} MHz may not be low enough for every unit: azampatti's still throttled at "
            "2200 MHz and never at 2000 MHz.",
            "One owner reported that a cooler GPU made the fans respond less and left the CPU hotter. "
            "Another owner in the same thread did not see that.",
            "The driver has no field that shows the cap. Check it by reading the GPU clock under load.",
        ],
    ),
    Recommendation(
        id="cpu-pcore-cap",
        title=f"Cap the performance cores at {CPU_PCORE_CAP_MHZ} MHz",
        summary=(
            f"Lowers the top frequency of the ten performance cores from 3900 to {CPU_PCORE_CAP_MHZ} MHz. "
            "Inference engines keep two or three of these cores spinning while they wait on the GPU, and a "
            "spinning core at a lower clock makes much less heat. It takes effect at once and is forgotten "
            "at a reboot."
        ),
        goal="cooler",
        benefit=(
            "Owners report a much cooler CPU at the same inference speed. On two units at 3000 MHz, jetspark "
            "measured the same throughput with 8 to 12 % less energy and the hottest thermal zone 17 to "
            "18 °C lower. see_spot_ruminate measured 57.4 °C during decode at 2600 MHz against 80.5 °C at "
            "3600 MHz."
        ),
        cost=(
            "jetspark measured no loss at 3000 MHz. Work that is limited by the CPU, such as compiling, "
            "tokenising and data loading, slows with the clock. Below 2808 MHz, the top speed of the "
            "efficiency cores, jetspark lost 4.5 % in one run."
        ),
        sources=[
            OPTIMIZE_THREAD,
            RecSource(
                title="NVIDIA forum: 7.0.0-1019-nvidia CPU overheating",
                url=f"{FORUM}/7-0-0-1019-nvidia-cpu-overheating/383939",
            ),
            RecSource(title="NVIDIA forum: james.meadlock's 20-minute run with capped cores", url=FAN_THREAD),
            RecSource(
                title="NVIDIA forum: tsarihan's all-core test, where a cap did not help (post 52)",
                url=STABILITY_THREAD,
            ),
        ],
        measurement=None,
        apply=[
            f"sudo cpupower -c 5-9,15-19 frequency-set -u {CPU_PCORE_CAP_MHZ}MHz",
            *boot_unit(
                "cpu-pcore-cap",
                f"Cap the performance cores at {CPU_PCORE_CAP_MHZ} MHz",
                "nv-cpu-governor.service",
                f"/usr/bin/cpupower -c 5-9,15-19 frequency-set -u {CPU_PCORE_CAP_MHZ}MHz",
                "/usr/bin/cpupower -c 5-9,15-19 frequency-set -u 3900MHz",
            ),
        ],
        undo=["sudo cpupower -c 5-9,15-19 frequency-set -u 3900MHz", *remove_boot_unit("cpu-pcore-cap")],
        one_click=True,
        persists="until-reboot",
        risks=[
            "The cap is forgotten at a reboot. Sparkline applies it again at boot when Sparkline applied it; "
            "by hand it needs the unit above.",
            "It lowers the heat of spinning cores without stopping them from spinning. see_spot_ruminate: "
            '"My "fix" doesn\'t really fix it, rather mask it".',
            "tsarihan loaded all 20 cores and saw the same 92 °C peak with and without a cap. The reports "
            "of a cooler CPU are for inference, where two or three cores are busy.",
            "On this CPU driver the limit is a request to the firmware. Check the real frequency under load.",
        ],
    ),
    Recommendation(
        id="headless-boot",
        title="Boot without the desktop",
        summary=(
            "Makes the machine boot to text mode (multi-user.target), so the login screen and the GNOME "
            "desktop never start. It takes effect at the next boot and stays until it is undone."
        ),
        goal="roomier",
        benefit=(
            'Owners report 2 to 3 GB of memory back. Three owners give that figure (eugr: "2-3GB tops") '
            "and none of them posted a measurement. It also takes the desktop's processes out of the way "
            "when memory runs out."
        ),
        cost=(
            "There is no local desktop: tools that need a display session, such as a browser with a window, "
            "stop working. eugr reports that the DGX Dashboard stops working and that NCCL was slower "
            "without the desktop when he tested it in November 2025."
        ),
        sources=[
            RecSource(
                title="NVIDIA DGX Spark release notes: the fix for fans that stopped on a headless system",
                url=RELEASE_NOTES,
            ),
            RecSource(
                title="NVIDIA forum: Is there a way to reduce baseline memory usage on DGX Spark systems?",
                url=f"{FORUM}/is-there-a-way-to-reduce-baseline-memory-usage-on-dgx-spark-systems/359479",
            ),
            RecSource(
                title="NVIDIA forum: Memory creep on DGX Spark",
                url=(
                    f"{FORUM}/memory-creep-on-dgx-spark-where-your-128-gb-actually-goes-and-how-to-stop-it/"
                    "364886"
                ),
            ),
            OPTIMIZE_THREAD,
        ],
        measurement=None,
        apply=["sudo systemctl set-default multi-user.target"],
        undo=["sudo systemctl set-default graphical.target"],
        one_click=True,
        persists="persistent",
        risks=[
            "On firmware older than October 2026 (embedded controller 3.13.7), a unit idling without a "
            "display could stop its fans and overheat. NVIDIA's release notes list the fix: update the "
            "firmware first.",
            "Do not remove the desktop packages to save more. jetspark's dry run wanted to remove 1078 "
            "packages, DGX Spark platform packages among them.",
        ],
    ),
    Recommendation(
        id="display-reserved-memory",
        title="Set Display Reserved Memory to Auto",
        summary=(
            "The firmware keeps memory aside for display output before Linux starts: 2 GB by default. Auto "
            "keeps 0.5 GB when no display is connected at boot. This is a firmware setting: it needs the "
            "October 2026 firmware (OTA2610) or later, and a reboot."
        ),
        goal="roomier",
        benefit=(
            "NVIDIA documents up to 1.5 GB more memory for the operating system. kan11 measured it on "
            "machines without a display: total memory rose from 121.7 to 123.2 GiB."
        ),
        cost=(
            "None reported on a machine without a display. With displays, NVIDIA warns that a reservation "
            "that is too small can cause display errors or out-of-memory errors in the display driver."
        ),
        sources=[
            RecSource(
                title="NVIDIA DGX Spark porting guide: Optimization (Display Reserved Memory)",
                url="https://docs.nvidia.com/dgx/dgx-spark-porting-guide/latest/optimization.html",
            ),
            RecSource(
                title="NVIDIA DGX Spark UEFI manual: Advanced tab",
                url="https://docs.nvidia.com/dgx/dgx-spark-uefi/advanced-tab.html",
            ),
            RecSource(title="NVIDIA DGX Spark release notes (October 2026)", url=RELEASE_NOTES),
            OPTIMIZE_THREAD,
        ],
        measurement=None,
        apply=[
            f"sudo chattr -i {DISPLAY_REQUEST} 2>/dev/null",
            rf"printf '\x07\x00\x00\x00\x00' | sudo tee {DISPLAY_REQUEST} > /dev/null",
            "sudo reboot",
        ],
        undo=[
            f"sudo chattr -i {DISPLAY_REQUEST} 2>/dev/null",
            rf"printf '\x07\x00\x00\x00\x03' | sudo tee {DISPLAY_REQUEST} > /dev/null",
            "sudo reboot",
        ],
        one_click=False,
        persists="persistent",
        risks=[
            "Auto looks for displays only at boot. A display plugged in later keeps the small reservation "
            "until the next restart.",
            "The commands write a firmware (EFI) variable. NVIDIA states that an invalid value is ignored.",
            "Some other makers' firmware lacks the option or its small settings: owners report this on MSI "
            "and Gigabyte machines.",
            "The undo command sets the 2 GB default from NVIDIA's table of values. NVIDIA's page prints "
            "only the command for Auto.",
        ],
    ),
]

BY_ID: dict[str, Recommendation] = {r.id: r for r in CATALOG}
