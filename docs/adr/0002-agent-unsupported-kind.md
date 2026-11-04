# A fourth `Unsupported` kind, `agent`, for metrics Sparkline does not read yet

Every metric in the agent's vocabulary is reported, or `NodeInfo.unsupported` declares it with a reason and a kind. The kind picks the label the web shows, and it tells the user who can close the gap. `hardware` ("Not reported by this hardware") means nobody can. `access` ("No access") means the agent's user needs a privilege. `dependency` ("Helper tool missing") means a package needs installing.

Issue #11 made the list exhaustive, and that exposed a fourth case. The machine exposes the metric, but Sparkline has no code that reads it. On a DGX Spark, hwmon exposes two ACPI fans and Sparkline reads neither. Declaring `fan` as `hardware` would put "Not reported by this hardware" on a box whose hardware does report it. So `agent` ("Not collected yet") covers that case, and the reason names what the machine exposes.

## When `agent` applies

Use `agent` only when the machine exposes the metric and the agent does not read it. The reason names the source, so a user can check it:

- `fan` on a box whose hwmon has fan inputs: "Fan speed is not collected yet (hwmon exposes 2 fan sensors)".
- `system.power_w` on a box whose hwmon has power inputs.
- `disk` on a box whose only disks are ones `WHOLE_DISK` does not match, such as eMMC (`mmcblk0`). The reason lists those disks.
- `net` on a box with only Wi-Fi or virtual interfaces, which the agent skips unless `include_virtual = true`. The reason lists them.
- A vocabulary key that no collector declares. `Collectors.unsupported()` declares it as "Not reported by the <owner> collector", so a new key is never silent.

## When `agent` must not apply

Do not use `agent` when the machine exposes nothing. A collector that starts and finds zero instances declares its own prefix as `hardware`, with what is missing: "No temperature sensors exposed (hwmon)", "No physical disks exposed in /proc/diskstats", or "No network interfaces exposed besides loopback". It does not leave the prefix to the catch-all, because the catch-all says "Not collected yet" about something the box does not have. `test_capabilities.py` checks that no started collector leaves a prefix to the catch-all on any recorded platform.

A collector that cannot start declares its prefix through the fault-isolation path from #10, with that path's kinds.

## Considered options

- **`hardware` for all four cases.** The label is false wherever the machine exposes the metric, and the fan on every DGX Spark is one such place.
- **Leave the metric out of `unsupported`.** The web then shows "No data" with "This node is reporting, but has sent no value for this metric", which hides that Sparkline chose not to read it.

## Older consoles

The kind is additive on the wire, and `SCHEMA_VERSION` stays 1. An older console's `Unsupported` model maps a kind it does not know to `hardware` (`_unknown_kind_reads_as_hardware`), so the hello still parses. An older web reads the kind the same way. It shows "Not reported by this hardware", and the tooltip carries the true reason.
