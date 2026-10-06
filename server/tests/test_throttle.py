from sparkline.common.throttle import decode, worst_severity

CANON = {
    0x1: ("gpu_idle", "Idle", "info"),
    0x2: ("app_clocks", "Application clock limit", "info"),
    0x4: ("sw_power_cap", "Power cap", "info"),
    0x8: ("hw_slowdown", "Hardware slowdown", "critical"),
    0x10: ("sync_boost", "Sync boost", "info"),
    0x20: ("sw_thermal", "Thermal limit", "warning"),
    0x40: ("hw_thermal", "Overheating", "critical"),
    0x80: ("hw_power_brake", "Power brake", "critical"),
    0x100: ("display_clocks", "Display clock setting", "info"),
}


def test_every_canonical_bit():
    for bit, (code, title, sev) in CANON.items():
        (r,) = decode(bit)
        assert (r["bit"], r["code"], r["title"], r["severity"]) == (bit, code, title, sev)
        assert r["explanation"]


def test_exact_explanations():
    assert decode(0x4)[0]["explanation"] == (
        "Holding clocks down to stay within the power budget. Normal under sustained heavy load."
    )
    assert (
        decode(0x40)[0]["explanation"] == "The GPU is too hot; hardware cut clocks sharply to protect itself."
    )


def test_combined_and_unknown():
    rs = decode(0x4 | 0x20 | 0x400)
    assert [r["code"] for r in rs] == ["sw_power_cap", "sw_thermal", "unknown_0x400"]
    assert rs[2]["title"] == "Unknown reason (bit 0x400)" and rs[2]["severity"] == "warning"
    assert decode(0) == []


def test_worst_severity():
    assert worst_severity(0) is None
    assert worst_severity(0x1) == "info"
    assert worst_severity(0x4 | 0x20) == "warning"
    assert worst_severity(0x4 | 0x40) == "critical"
    assert worst_severity(0x1000) == "warning"
