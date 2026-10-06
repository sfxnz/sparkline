"""Decode NVML clocks-event-reasons bitmasks into plain English.

Canonical table, mirrored exactly by web/src/lib/throttle.ts.
"""

from __future__ import annotations

# bit -> (code, title, severity, explanation)
REASONS: dict[int, tuple[str, str, str, str]] = {
    0x1: ("gpu_idle", "Idle", "info", "Clocks are lowered because the GPU has nothing to do."),
    0x2: (
        "app_clocks",
        "Application clock limit",
        "info",
        "An application or administrator has set a clock limit.",
    ),
    0x4: (
        "sw_power_cap",
        "Power cap",
        "info",
        "Holding clocks down to stay within the power budget. Normal under sustained heavy load.",
    ),
    0x8: (
        "hw_slowdown",
        "Hardware slowdown",
        "critical",
        "Hardware forced clocks down to protect the chip (thermal or power-brake protection).",
    ),
    0x10: ("sync_boost", "Sync boost", "info", "Clocks matched to other GPUs in a sync-boost group."),
    0x20: (
        "sw_thermal",
        "Thermal limit",
        "warning",
        "Clocks reduced in software to keep temperature below the target.",
    ),
    0x40: (
        "hw_thermal",
        "Overheating",
        "critical",
        "The GPU is too hot; hardware cut clocks sharply to protect itself.",
    ),
    0x80: (
        "hw_power_brake",
        "Power brake",
        "critical",
        "An external power-brake signal forced clocks down (power supply limit).",
    ),
    0x100: ("display_clocks", "Display clock setting", "info", "Clocks limited by display clock settings."),
}

_RANK = {"info": 0, "warning": 1, "critical": 2}


def decode(mask: int) -> list[dict]:
    out = []
    bit = 1
    while bit <= mask:
        if mask & bit:
            if bit in REASONS:
                code, title, severity, explanation = REASONS[bit]
            else:
                code, title, severity = f"unknown_{bit:#x}", f"Unknown reason (bit {bit:#x})", "warning"
                explanation = "The driver reported a clock-event reason this console does not recognise."
            out.append(
                {"bit": bit, "code": code, "title": title, "severity": severity, "explanation": explanation}
            )
        bit <<= 1
    return out


def worst_severity(mask: int) -> str | None:
    """Highest severity among set bits, or None when no bit is set."""
    reasons = decode(mask)
    if not reasons:
        return None
    return max((r["severity"] for r in reasons), key=_RANK.__getitem__)
