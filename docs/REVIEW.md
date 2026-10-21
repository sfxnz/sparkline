> Historical record: the self-review written while Sparkline was built. For using Sparkline, see the [README](../README.md).

# Sparkline — final self-review

The brief asks for a final self-review: go screen by screen, list anything that feels generic, clunky, misaligned or
unexplained, then fix it. This file holds that review for the web UI.

## UI self-review: findings

**Method.** I captured Playwright screenshots of every screen against the `--demo` console: overview, the node tabs
(summary, GPU, memory, CPU, network, storage, thermals & power, processes), a node that is stale or offline, alerts,
settings and benchmarks. For benchmarks that meant the catalog, the configure and confirm dialogs, a live run, a
completed run, a soak run, a failed run, history, compare and the share card. I also captured wall mode at 1920 and 3840,
login, the no-backend error state, not-found, the command palette and the shortcuts sheet. Each was shot in dark and
light at 1280×800, 1440×900 (full page) and 1920×1080, with a 390×844 phone pass. I looked at every image. Then I ran
three more passes: axe at all impacts (WCAG 2.0/2.1/2.2 A and AA plus best-practice) on 28 routes and dialogs in each
theme, a scripted Tab walk through every route to check focus visibility and order, and repeat captures at a 200% root
font size and with reduced transparency on overview, GPU, alerts and benchmarks.

Findings, grouped by kind. **[fixed]** = changed in this phase (see the next section). **[kept]** = reviewed and left as
it is, with the reason.

### Layout and rhythm
1. **[fixed]** On long pages the light-theme ambient background stopped at the first viewport height, and so did the
   sidebar material. Below that line the page showed a flat grey band, and the sidebar ended in mid-air.
2. **[fixed]** At 1440×900 the overview cut the Interconnect panel at the fold. The first screen showed only half of the
   cluster story.
3. **[fixed]** The Interconnect panel stretched to the height of Recent events beside it. That turned its two node "end"
   boxes into tall empty slabs (about 300 px), with the rails spread far apart between them.
4. **[fixed]** GPU tab: the "Clock limits" panel and the "Time clock-limited" panel had different heights. That left a
   large empty block under the shorter one, and on wide screens a lot of empty space on the left.
5. **[fixed]** Paired chart panels whose legends did not line up: "Utilisation" had no subtitle while "SM clock" beside
   it had one, and the same held for summary GPU utilisation vs GPU power, summary unified memory vs CPU, CPU's
   utilisation by core type, and memory's swap panel.
6. **[fixed]** A long chart legend (the GPU temperature legend with its two threshold keys) wrapped the chart's action
   buttons onto a second line. That pushed the plot down, out of line with the other charts in its row.
7. **[fixed]** Processes tab at 1280: the Process column was squeezed to about 120 px. Names wrapped ("sparkline-
   / agent"), and "containerd 1622" ran into the Container column.
8. **[fixed]** Phone (390): alert timeline rows wrapped their titles one word per line, and the node chip sat on top of
   the title. The process filter field ran off the right edge of its panel.
9. **[fixed]** At a 200% font size the "GPU throttling" rule's checkbox labels overlapped each other ("Hardware
   sl/Sync boost"). The timeline rows also collapsed as they did on a phone.
10. **[fixed]** Settings: "Appearance" and "Keyboard" had no subtitle, so their first row sat further below the title than
    in every other settings panel.
11. **[fixed]** Panels showing "Not reported by this hardware" (CPU temperature, power limit, fans) put their ⓘ button on
    a line of its own in narrow columns.

### Clarity and copy
12. **[fixed]** GPU "Time clock-limited": the chart legend showed the latest sample ("Power-capped 0%") right next to
    stats that said 36% over the last minute, with nothing to tell them apart.
13. **[fixed]** Chart legends in general never said which moment they showed while live. When a node was stale they
    still read as current, next to a badge saying "Last updated 6 s ago".
14. **[fixed]** A node in console status `error` (token mismatch, protocol mismatch, refused stream) was labelled
    **Critical** with the hardware-emergency icon, and the overview hero said Critical too.
15. **[fixed]** The per-core heatmap ramp was the accent colour at varying opacity. In light mode, idle and lightly
    loaded efficiency cores were nearly invisible against the panel (under 1.3:1), and the caption "brighter is busier"
    was wrong in light mode, where busier is darker.
16. **[fixed]** Inconsistent terms. The node summary said "CX7 in/out" where every other screen says "ConnectX-7".
    Cluster totals said "no stalls" (PSI jargon) where the memory tab says "No memory pressure". Settings said "Mark stale
    after", but the pill users actually see says "Not reporting".
17. **[fixed]** Benchmark results showed clocks as "1884 MHz" and temperatures as "88.0 °C". The analysis tiles above,
    and every live screen, write "1.88 GHz" and "88 °C".
18. **[fixed]** Stat values that change unit mid-animation (ConnectX-7 throughput falling from about 48 Gb/s to a few
    Mb/s) briefly read "48273 Mb/s".
19. **[fixed]** Run telemetry: a near-flat GPU temperature (57.6–58.4 °C) gave the axis a single tick label ("58 °C"),
    which looked like a broken chart.
20. **[fixed]** The Memory tab's "Top memory consumers" table looked different from the same rows on the Processes and
    GPU tabs. It used plain grey chips with no icons, a sans-serif command line, and the Model column before Container.
21. **[kept]** The node header meta line wraps with a leading "·" on a phone. It is still readable, and fixing it needs a
    different layout for the meta list.
22. **[kept]** "Clocks-event mask 0x20" under the throttle headline is driver jargon. It is the exact driver value,
    shown small and secondary under the plain-English decode, and it is useful when reporting a problem.

### States and empty states
23. **[fixed]** "No data in this range" on charts, the stacked memory chart and the per-core history offered no next
    action.
24. **[fixed]** Overview "No alerts. Everything's quiet." and Alerts "No events yet" offered no next action.
25. **[kept]** "No interconnect links", "No disks reported", "No readings yet" and "No process list" have no button. Their
    copy is the next action (connect a cable, or wait for the first sample), and the waiting states clear themselves.

### Motion
26. **[fixed]** The load glow behind node cards and wall tiles eased its strength over 1.2 s, outside the 150–400 ms
    window. The wall alert ticker used a 0.4 s tween instead of a spring.
27. **[kept]** The continuous ambient loops stay: the node-card breathing (4–7 s), the interconnect flow dots, the
    connection "Live" pulse, the skeleton shimmer and the spinner. They are status, not transitions, and they explain
    themselves (load, traffic, liveness, loading). Under `prefers-reduced-motion` all of them stop or become instant:
    there is a global CSS rule, per-component `animation: none`, and `MotionConfig reducedMotion="user"`.

### Accessibility audit results
28. axe at all impacts, every route and dialog, both themes: **0 violations** across 56 scans, run on the production
    build. The repo's e2e axe tests also pass.
29. Tab walk on every route in dark, plus overview, alerts and benchmarks in light: **every stop shows a visible focus
    indicator** (a 2 px ring, or the card ring for node cards), and none jumps backwards in reading order.
30. At a 200% root font size, the sidebar and status icons stayed at their pixel size while their labels doubled.
    **[fixed]**
31. Reduced transparency (the in-app setting): every material is opaque in both themes on overview, GPU, alerts and
    benchmarks. **[kept]**: no changes were needed.

## Changes made

Coherence first: where a fix belonged in a token or a shared component, it went there rather than into a one-off
override.

| # | Change | Where |
|---|---|---|
| 1 | The ambient gradients are now the root (`html`) background, anchored to the top and bottom of the document, so they cover the whole scroll height. The fixed `body::before` layer is gone. The sidebar material spans the whole grid row, and its contents sit in a sticky, viewport-height `.sidebar__inner`. | `design/global.css`, `app/Shell.css`, `app/Shell.tsx`, `e2e/chrome.spec.ts` (the sticky assertion now targets the inner element and checks that the material reaches the bottom) |
| 2, 3 | Overview re-flowed to: hero, then node cards, then **cluster totals (2×2) beside the interconnect**, then recent events, then GPU activity. The interconnect is now a compact table, with a row per rail (name, link state, rate) and a column per direction, headed "spark1 → spark2" and "spark1 ← spark2". The summary line stays. At 1440×900 and 1280×800 the whole interconnect panel now fits above the fold. Totals fall back to the 4-across strip when there are no links, or below 1100 px. | `views/Overview.tsx`, `views/overview/InterconnectPanel.tsx`, `views/overview/overview.css` |
| 4, 12 | GPU "Clock limits" is now one panel. On the left: the current decode, then "Time power-capped / Time thermal-capped · Average over the last N min". On the right: "Time clock-limited · share of each sample interval", with its chart. Columns are split 2:3 and stack below 1100 px. | `views/node/Gpu.tsx`, `views/node/parts/node.css` |
| 13 | Every chart now says which moment its legend shows. It reads "now" while live and idle; under the cursor, or for history, it reads "at 22:01". When the node is stale or the console is lost it gives the sample time, never "now". The label sits in the chart header's action row, so it never wraps the legend. | `charts/TimeSeriesChart.tsx`, `charts/chart.css` |
| 6 | The chart header keeps its actions on the first line; only the legend wraps, inside its own box. | `charts/chart.css` |
| 5, 10 | Subtitles added so paired panels align: GPU Utilisation, Summary GPU utilisation and Unified memory, CPU Utilisation by core type, Memory Swap, Settings Appearance and Keyboard. | `views/node/*.tsx`, `views/Settings.tsx` |
| 14 | New display status `error`, labelled **"Error"** with a ⊗ icon (`CircleX`). It keeps the red tone because it needs action, but it is no longer called Critical. The overview hero and the wall hero use Error when the only problem is a misconfigured node; a critical alert still wins. Tests updated and added. | `design/components/StatusPill.tsx`, `views/overview/model.ts` (+ tests) |
| 15 | New sequential **`--heat-0…4`** tokens per theme: one hue, lightness rising monotonically, with stops at 0/20/45/70/100 %. In light the ramp runs from a pale tint to deep indigo; in dark it runs from deep indigo to near-white. From the 20 % stop onward every cell is at least 3:1 against every surface. `contrast.test.ts` checks that, and also checks that the stops are ordered (each one at least 1.4× further from the panel than the last). `heatColor()` interpolates between stops (unit-tested). The heatmap, its legend ramp and its caption ("coloured by utilisation (scale below)") all use it. | `design/tokens.css`, `design/contrast.test.ts`, `charts/theme.ts` (+ test), `charts/Heatmap.tsx`, `charts/chart.css`, `views/node/Cpu.tsx` |
| 16 | Copy: "CX7 in/out" became "ConnectX-7 in/out". "no stalls" became "no memory pressure", and the non-zero case reads "waiting on memory N% of the time". Settings now says "Mark “Not reporting” after" and "Mark “Offline” after", in the same words as the pills. | `views/node/Summary.tsx`, `views/node/parts/SummarySkeleton.tsx`, `views/overview/Totals.tsx`, `views/settings/ServerSections.tsx` |
| 17 | Benchmark values in MHz ≥ 1000 show as GHz with two decimals, and °C shows as whole degrees, as on the live screens (unit-tested). | `views/bench/model.ts` (+ test) |
| 18 | `AnimatedNumber` takes a `scale` (the unit). When the unit changes, the number jumps instead of interpolating. Stat, node-card and wall values pass it. A unit test covers this; it fails without the fix. | `design/components/AnimatedNumber.tsx`, `Stat.tsx`, `views/overview/NodeCard.tsx`, `views/wall/WallTile.tsx` |
| 19 | `RunChart` takes a `ySpan` (the smallest visible y span). Run GPU temperature uses 8 °C. | `views/bench/RunChart.tsx`, `views/bench/RunTelemetry.tsx` |
| 20 | Memory-tab process rows now use the Processes tab's name cell, mono command and Container/Model chips (the `Badge` component is now exported), in the same column order. The orphaned `.nproc__*` styles were removed. | `views/node/parts/ProcTable.tsx`, `views/node/partsC/ProcTable.tsx`, `views/node/parts/node.css` |
| 7 | The process column keeps 30 % of the table, names ellipsize instead of wrapping, and chips cap at 16 rem. | `views/node/partsC/partsC.css` |
| 8 | Below 34 rem of container width (phone, or large text), timeline rows put the time above the title and the node chip below it. The process tools wrap under the title, and the filter field shrinks to fit. | `views/alerts/alerts.css`, `views/node/partsC/partsC.css` |
| 9 | The throttle-reason checkbox grid uses `auto-fill, minmax(11rem, 1fr)`, so at large text sizes it drops to fewer columns instead of overlapping. | `views/alerts/alerts.css` |
| 11, 30 | The `Unsupported` ⓘ button stays beside its label (no wrap) and is sized in rem. Nav, status-pill and toolbar search icons are sized in rem, so they scale with the user's font size like their labels. | `design/components/Unsupported.css`, `StatusPill.css`, `app/Shell.css` |
| 23 | New `NoDataInRange` empty state: it explains why there is no data and offers **Show live** when the range is a history range the user can change. Used by the time-series chart, the stacked memory chart and the per-core history. | `charts/NoDataInRange.tsx`, `charts/TimeSeriesChart.tsx`, `views/node/parts/StackedAreaChart.tsx`, `views/node/partsB/RangeHeatmap.tsx` |
| 24 | Overview "No alerts" now has a **Review alert rules** link. Alerts "No events yet" has a **Review alert rules** button, which scrolls to the rules editor and focuses its first control. | `views/overview/RecentEvents.tsx`, `views/alerts/Timeline.tsx`, `views/alerts/RulesEditor.tsx` |
| 26 | The glow transitions now use `--dur-slow` (400 ms) with `--ease-out`, and the wall ticker uses `springs.gentle`. | `views/overview/overview.css`, `views/wall/wall.css`, `views/Wall.tsx` |

### Evidence
- `npm test`: 43 files, 532 tests pass. That includes the new contrast and ordering checks for the heat ramp, the
  `heatColor` tests, the AnimatedNumber unit-jump test, the bench unit-formatting test and the error-status tests.
- `npm run e2e` against a fresh demo (`E2E_PORT=5215 E2E_DEMO_PORT=30050`): **34/34 pass**. That includes axe on every
  route and on interactive and degraded states, the benchmark flows, and the 200% font test.
- My own axe sweep at all impacts, on the production build: **0 violations** across 56 scans.
- Tab walk: no stop without a visible focus indicator, and no backwards jumps.
- Server checks: `ruff check`, `ruff format --check` and `pytest` (258 passed).
- Screenshots: `web/screenshots/phase-e/polish/`. It holds every route at 1440×900 full page in both themes, plus
  1280×800 and 1920×1080 (overview, GPU, CPU), 390×844 (overview, alerts, processes, GPU), wall at 1920 and 3840, the
  benchmark flow (configure, confirm, run, completed, share, soak, failed, compare), login, no-backend, not-found,
  palette, shortcuts, and `font200-*` and `reduced-transparency-*` for overview, GPU, alerts and benchmarks.

### Known limitations
- On a 1440×900 laptop, Recent events now starts just below the fold. Its header shows, as a cue that there is more.
  The hero sentence and the sidebar badge already carry any open problem.
- The live per-sample chart legends say "now" in all charts. That is consistent, but it is one more word in every
  chart header.
- Wide tables (processes, alert rules) scroll sideways on a phone and at 200% text instead of reflowing. WCAG 1.4.10
  allows this for two-dimensional data.
- (Resolved before the gate pass: `typecheck`, `lint` and `build` had failed on a then-unfinished
  `src/store/soak24h.test.tsx`. All three are clean now; see "Quality gate results".)

## Quality gate results

Run on 2026-10-07 by the gate pass, on spark1 (aarch64, DGX OS), against the working tree that follows this
review. Every gate in the brief's "Quality gates before you call it done", plus the deployment checks.

| Gate | Command | Result |
|---|---|---|
| TypeScript strict | `npm run typecheck` (`tsc -b`, `strict: true`) | Pass, 0 errors |
| ESLint, 0 warnings | `npm run lint` (`--max-warnings 0`, jsx-a11y and react-hooks) | Pass |
| Web unit tests | `npm test` (vitest) | 43 files, 534 tests pass. Including throttle decoding (`lib/throttle.test.ts`, `views/node/parts/gpu.test.ts`), metric keys and formatting (`lib/metrics.test.ts`, `lib/format.test.ts`), stream reconnect (`lib/ws.test.ts`) and the simulated 24 h store soak (`store/soak24h.test.tsx`) |
| Web build | `npm run build` | Pass. Startup JS 145.7 kB gzip (`index-*.js`); the benchmark suite, Alerts, Settings, Wall and Login are separate chunks |
| Server unit + integration tests | `.venv/bin/pytest -q` | 259 pass. Run 4 times in this pass (3 times before the gate's fixes, once after): 258, 258, 258, 259 pass, no flakes |
| Metric parsing and throttle decoding | `tests/test_agent_parsers.py`, `tests/test_throttle.py`, `tests/test_flatten.py` | Pass (in the runs above): meminfo, PSI, /proc/stat, core classification, diskstats, mounts, net/dev, sysfs roles, RDMA, PHY counters, ethtool, hwmon, container ids, model detection; every NVML clocks-event bit, combinations, unknown bits and severity |
| Agent disconnect / reconnect integration | `tests/test_console_integration.py` | Pass: `test_disconnect_stale_offline_reconnect`, the silent-agent watchdog, hello-but-no-samples, hung agent, console-clock watchdog, slow browser client bounded |
| Agent resilience | `tests/test_agent_resilience.py` | Pass: NVML errors and init failure, collectors that keep failing, Docker socket gone or garbage, hwmon sensor vanishing |
| mypy | `.venv/bin/mypy` | "Success: no issues found in 51 source files" |
| ruff | `ruff check .` and `ruff format --check .` | Pass, 77 files formatted |
| Playwright key flows | `E2E_PORT=5220 E2E_DEMO_PORT=30060 npm run e2e` | 34/34 pass, run 3 times (twice before the gate's web fixes, once after), no retries needed |
| axe, all routes, both themes | the e2e axe tests (every route, interactive and degraded states, every benchmark screen, wall, login, no-backend) | 0 violations. Also run against the **real** console (spark1 agent, spark2 offline): 21 routes × 2 themes = 42 scans, 0 violations (WCAG 2.0/2.1/2.2 A and AA) |
| Perf guard | `e2e/perf.spec.ts` | Pass: no long task over 50 ms in 20 s of streaming; startup JS under the 200 kB gzip budget |
| Agent CPU budget (< 1 %) | `/proc/<pid>/stat` over 120 s, real agent on spark1 at 1 Hz with the console connected | 0.78 % of one core, RSS 80 MB |
| shellcheck | `shellcheck deploy/install.sh` (0.11.0) | Clean |
| install.sh dry runs | `deploy/install.sh {agent, agent --enable-benchmarks, console --nodes …, uninstall, uninstall --purge} --dry-run --yes` | All 5 modes exit 0 and print every action; nothing changed |
| systemd units | `systemd-analyze verify deploy/systemd/*.service` | Only complains that `/opt/sparkline/venv/bin/*` does not exist (expected off-target) |
| Docker Compose | `docker compose -f deploy/docker-compose.yml config` | Valid |

### Real cluster, end to end

- **Setup.** `sparkline-agent` on spark1 (10.20.20.48:9750) and the real console (127.0.0.1:9700, token auth)
  serving the production build, with spark1 and spark2 configured. **spark2's agent could not be redeployed or
  started in this pass** (writing to spark2 was not permitted in the gate's session), so spark2 appears as a
  genuinely unreachable node: "Agent unreachable on spark2 · Connection refused at 10.20.20.195:9750".
- **Every screen walked in Playwright**, signing in through the login form, in dark and light: overview, all 8
  tabs for both nodes, alerts, benchmarks, settings, wall. No page errors. The only failed request is
  `/api/v1/history` for spark2's energy total (503 while it is offline), which the overview handles ("excl.
  spark2").
- **Values vs `nvidia-smi` on spark1**, read side by side: driver 580.173.02, GPU 0 %, 9.48 W, 44 °C, SM
  2190 MHz all equal; power limit is `[N/A]` in nvidia-smi and "Not reported by this hardware" in the UI;
  energy 23,085,652 J = 6.41 kWh as shown; unified memory used 112.30 GB vs `free` 112.32 GB.
- **Stale → offline → online** (spark1's agent, since spark2's could not run): SIGSTOP of the agent gave
  "Not reporting" with dimmed values and "Showing the last values · updated N s ago" after 5 s, "Offline"
  ("No data from spark1", journalctl fix, Retry) at 30 s, and "Healthy" 4 s after SIGCONT. Killing the agent
  outright goes straight to Offline (connection refused, no stale phase, as designed) and back to Healthy on
  the first retry after restart.
- **Storage benchmark through the UI** on spark1, 64 MiB, 1 s per profile: configure → confirm → live run →
  completed in 3 s. Seq write 4567 MB/s, seq read 6593 MB/s, 4 KiB random read 16.9 k IOPS, random write
  17.4 k IOPS. Afterwards the bench work directory was empty and no fio/payload process was left.

### Fixes made by the gate pass

| Fix | Where |
|---|---|
| Host-side benchmarks (CPU, storage, RDMA, LLM) run inside the agent's cgroup. When that cgroup has a CPU quota (the monitor-only systemd unit: half a core), the catalog now marks them unavailable, "sparkline-agent is CPU-capped on <node>", with the `--enable-benchmarks` fix, instead of letting a throttled run produce wrong numbers. Read from cgroup v2 `cpu.max`. Tests added. README updated | `server/sparkline/agent/bench/probes.py`, `server/tests/test_agent_bench_specs.py`, `README.md` |
| The login screen told users to copy `console_token`; the key is `token` in `/etc/sparkline/console.toml` | `web/src/app/Login.tsx` |
| Protocol-mismatch fix text said "run ./install.sh"; the script is `deploy/install.sh` | `server/sparkline/console/nodes.py` |
| Offline node card read "Last values no data received" for a node that never connected; now "No data received yet" | `web/src/views/overview/NodeCard.tsx` |
| A node that never connected kept a shimmering skeleton in its header forever (read as "loading"); once offline or in error it now shows the agent's address | `web/src/views/Node.tsx` |
| GPU tab "Time clock-limited": with three active clock limits the left column grew and the right column's grid spread its title, subtitle and chart apart | `web/src/views/node/parts/node.css` |
| README screenshots curated (11 files, 2.0 MB, each under 240 kB) and the gallery pointed at them | `docs/screenshots/`, `README.md` |

## Final review fixes

A last review, run as a first-time user (the Docker demo, the DEV.md path, a phone) and as a security auditor,
raised 25 findings. Each was confirmed against the code before it was changed; all 25 were real, and all 25 were
fixed. Highest severity first.

| # | Finding | Fix | Where | Test |
|---|---|---|---|---|
| 1 | History charts of an unreachable node showed the raw JSON error body as the "likely cause", and the error panels spilled out of their cards (over each other on a phone). | New `HistoryUnavailable`, shared by the time-series chart, the stacked memory chart and the per-core history. When the node is offline or in error it says, in one plain line, "spark3 is unreachable. History is stored on spark3's agent…" with **Show live**; the node banner above already carries the cause, the fix and Retry. Otherwise it shows the console's Problem (message, cause, fix) parsed with `problemOf`, never the body. In-plot states are clamped and fit their plot: `overflow: hidden` and a size container on the overlay; plots under 240 px drop the glyph, under 200 px the detail labels, under 130 px the fix line. | `charts/HistoryUnavailable.tsx`, `charts/TimeSeriesChart.tsx`, `charts/chart.css`, `views/node/parts/StackedAreaChart.tsx`, `views/node/partsB/RangeHeatmap.tsx` | `charts/HistoryUnavailable.test.tsx`; checked in a browser at 1440 and 390 with spark3 offline and with a stubbed 503: no JSON, every Retry inside its plot, 0 px overflow |
| 2 | Stale and offline legends printed over "at HH:MM · Last updated N s ago" in narrow chart cells. | While the "Last updated" badge shows, the idle legend no longer repeats "at HH:MM" (the cursor still dates hovered values). Legend items never break inside; when a cell is too narrow for the legend (12 rem) plus the actions, the actions wrap below instead of overlapping. | `charts/TimeSeriesChart.tsx`, `charts/chart.css` | Browser check of spark3's Summary while offline |
| 3 | The RDMA run read "Rail Rail B" in history. | `paramsSummary` leaves the label out when the value already starts with it. | `views/bench/model.ts` | `model.test.ts` |
| 4 | The palette could not find metrics or single benchmarks, and loose matching returned the theme toggle for "nccl". | One entry per benchmark (opens its Configure dialog, via `?configure=`), fetched from the catalog when the palette first opens. Metric entries per node (GPU temperature, Throttle reasons, Swap, ConnectX-7 errors and 14 more) jump to the right tab; both appear once you type. The matcher is word-based: every query word must match one word as a prefix, a substring (3+ letters) or letters in order from its first letter, so "nccl" no longer matches "Switch to dark appearance". | `app/CommandPalette.tsx`, `lib/fuzzy.ts` | `fuzzy.test.ts`, `app.test.tsx`; demo probe: nccl, fio, storage benchmark, matmul, swap, temp, throttling, clock all find the right thing, and nothing unrelated |
| 5 | Headlines like "201 / 198 MB/s" said neither which nodes nor which metric. | Benchmark cards and history now show a caption under the number, "Single core (Cortex-X925) · spark1 / spark2" (the same order as the values), and a hover title with each node's value and, when the payload names one, the work unit ("MB/s = input bytes processed per second by sha256 + zlib…"). | `views/bench/model.ts`, `Catalog.tsx`, `History.tsx`, `bench.css` | `model.test.ts` |
| 6 | "Running at full speed" above "0.21 / 3.00 GHz · 7% of maximum". | The headline uses the clock against its maximum: "Running at full speed" only at 80 % of the maximum or more; "No clock limits active — clocks are low because the GPU is idle" when idle; "…the driver is running the clocks below maximum" when busy but lower; "No clock limits active" when the clock is unknown. | `views/node/parts/Notices.tsx`, `views/node/Gpu.tsx` | `gpu.test.ts` (an idle GB10 at 208 of 3000 MHz with mask 0) |
| 7 | DEV.md's demo path failed when followed literally (wrong directory, no web build). | Setup ends back at the repo root; the Demo section says "From the repo root" and builds `web/dist` first. | `DEV.md` | Read through step by step |
| 8 | The overview card wrapped "6 °C headroom" over two lines. | No-break space between value and unit; the warning flag doesn't wrap. | `views/overview/NodeCard.tsx`, `overview.css` | — |
| 9 | The wall said "No alert has fired yet" after alerts had fired and resolved. | "No open alerts yet". | `views/Wall.tsx` | — |
| 10 | "88 °C · 2 °C over slowdown · 3 °C to shutdown" (shutdown is 90 °C); Thermals said "At the slowdown limit" for the same state. | Headroom is computed from the displayed, rounded temperature; exactly at the threshold it reads "At slowdown (86 °C) · 4 °C to shutdown". The Thermals tab uses the same footer as Summary and GPU. | `views/node/parts/gpu.ts`, `views/node/Thermals.tsx` | `gpu.test.ts` |
| 11 | The demo storage run: "≈ 34 s" finished in 0:04, telemetry showed an idle disk next to 4.5 GB/s, MiB/s next to MB/s, and a 4 s run was a sliver of a 60 s axis. | Demo catalog descriptions say "Demo: runs are time-compressed…". A demo storage run now loads the simulated NVMe phase by phase (write 4.65 GB/s, then reads), also for seeded and restored runs. Run telemetry uses MB/s like the results and the Storage tab. A finished run's axis spans the run plus half its length each side (5 s minimum, 30 s maximum). | `server/sparkline/console/demo_bench.py`, `demo.py`, `views/bench/RunTelemetry.tsx` | `test_console_bench_demo.py`, `RunTelemetry.test.ts` |
| 12 | Overview "GPU activity" gave each node its own power scale. | `TimeSeriesChart` takes a `yGroup`: charts in a group share one ceiling (the highest visible value among them). The overview power charts use it; the subtitle says "on shared scales". | `charts/TimeSeriesChart.tsx`, `views/overview/ClusterChart.tsx` | `TimeSeriesChart.test.tsx`; browser: all three rows read 0/20/40 W |
| 13 | The demo opened in a crisis (Critical within seconds, three alerts, a node offline in the first minute), and the Summary banner strung three explanations under "Critical". | The first minute is calm. Then spark1's thermal episode (60 s), spark2's stall (120 s), spark3 stale then offline (150 s and 170 s), and spark2's storage error (240 s), one at a time. The Summary banner gives only the worst reason's explanation and says the GPU tab explains the others. | `server/sparkline/console/demo.py`, `views/node/parts/Notices.tsx`, `DEV.md`, `README.md` | `test_console_demo.py` (schedule, and the stale → offline → online run), `Notices.test.tsx` |
| 14 | "Last 3 min" sparklines stretched 40 s of data across the full width. | Live sparklines place points by time on a fixed [now − window, now] axis, so a partly filled window looks partial (node cards, thermal tables, wall). | `design/components/Sparkline.tsx` | `Sparkline.test.ts` |
| 15 | The Docker log showed a bridge IP the user cannot open. | The image sets `SPARKLINE_CONTAINER=1`; the console then logs which host address to open. The README explains the bridge-IP line. | `deploy/Dockerfile`, `server/sparkline/console/main.py`, `README.md` | `test_logsafe.py::test_container_hint_only_in_the_image` |
| 16 | The brief asks for `./install.sh` per node; it lived at `deploy/install.sh`. | Root `install.sh` execs `deploy/install.sh`; the README uses `sudo ./install.sh agent`. | `install.sh`, `README.md` | shellcheck; `./install.sh --help` and every dry-run mode through it |
| 17 | Process command lines (vLLM `--api-key …`) went unredacted to every console session. | The agent redacts argv before a `ProcSample` is built: values after `--api-key`, `--token`, `--hf-token`, `--password`, `--secret…` (both `--flag value` and `--flag=value`), `NAME_TOKEN=`/`NAME_KEY=` style variables, `sk-…`/`hf_…` keys and URL passwords become `***`. Titles rewritten into one string are split first. | `server/sparkline/agent/collectors/procs.py`, `README.md` | `test_agent_parsers.py::test_cmdline_secrets_are_redacted` |
| 18 | At `--log-level debug`, both services logged the agent token and session cookies. | `common/logsafe.py`: a filter on `uvicorn.error` and the websockets loggers masks `Authorization`, `Cookie`, `Set-Cookie` and `X-API-Key` values, installed by both mains. | `server/sparkline/common/logsafe.py`, both `main.py` | `test_logsafe.py` (a real websockets handshake at DEBUG, and uvicorn's handshake lines). Real agent at `--log-level debug` on 127.0.0.1:30082: the log shows `< authorization: ***`, the token 0 times |
| 19 | Changing the console token left existing sessions valid for 30 days. | Sessions are bound to a fingerprint of the token (`kv.session_token_fp`); at startup a different token deletes every session and logs it. Documented. | `server/sparkline/console/store.py`, `app.py`, `README.md` | `test_console_api.py::test_changing_the_token_signs_out_every_session` |
| 20 | The LLM benchmark reflected up to 300 bytes of any loopback/LAN service's response into the run error. | Response bodies are never echoed, only an OpenAI-style (or vLLM) error message; SSH (22), the Docker API (2375/2376) and Sparkline's ports (9700/9750) are refused as endpoints. | `server/sparkline/bench/payloads/llm_inference.py`, `agent/bench/specs.py` | `test_agent_bench_runner.py::test_llm_errors_never_echo_the_endpoints_body`, `test_agent_bench_specs.py` |
| 21 | Behind a TLS proxy the cookie lost `Secure`, and the sign-in limit locked everyone out at once. | New `trusted_proxies` option: forwarded headers are honoured (uvicorn `proxy_headers` + `forwarded_allow_ips`) only from those addresses, so the scheme and client IP are the real ones. README documents the nginx/Caddy settings, including Host preservation and WebSocket upgrades. | `server/sparkline/console/config.py`, `main.py`, `README.md` | `test_console_api.py::test_behind_a_trusted_tls_proxy_…` |
| 22 | install.sh printed tokens into any log and recommended putting the token in argv. | The summary prints tokens only on an interactive terminal, otherwise where to read them; next-node instructions use `read -rs` + `sudo --preserve-env`; dry-run output masks passed-in tokens as `<hidden>`. | `deploy/install.sh`, `README.md` | shellcheck; `SPARKLINE_AGENT_TOKEN=DRYRUN-… install.sh {agent,console} --dry-run` prints the token 0 times |
| 23 | The agent had no throttle on wrong bearer tokens and accepted 1-character tokens. | 10 wrong tokens per minute per client IP, then 429 (HTTP and stream). Tokens under 16 characters are refused by the agent's config and by the console's startup (outside `--demo`). | `server/sparkline/agent/app.py`, `agent/config.py`, `console/main.py` | `test_agent_api.py::test_wrong_tokens_are_throttled_…`; real agent: 10 × 401 then 429 |
| 24 | Python dependencies were unpinned and resolved at install time as root; base images were tag-pinned. | `server/requirements.lock`: the 31 dependencies (plus the hatchling build backend) at the tested versions, with sha256 hashes for every platform. install.sh (uv and pip paths) and the Dockerfile install it with `--require-hashes`, then the package with `--no-deps --no-build-isolation`. Both base images are pinned by digest. | `server/requirements.lock`, `deploy/install.sh`, `deploy/Dockerfile`, `deploy/Dockerfile.dockerignore` | Staged installs via uv (1.3 s) and via pip with no uv on PATH, both producing a working venv; the staged agent served `/healthz`. The Dockerfile's Python stage built from the lock (`--target build`) and imports cleanly |
| 25 | No CSP, frame-ancestors, nosniff or Referrer-Policy. | An ASGI middleware adds `Content-Security-Policy` (`default-src 'self'`, `script-src 'self'`, inline styles only, `frame-ancestors 'none'`…), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` to every HTTP response. The pre-paint theme script moved out of `index.html` into `public/theme-init.js`, so no inline script is needed. | `server/sparkline/console/app.py`, `web/index.html`, `web/public/theme-init.js` | `test_console_api.py::test_security_headers_on_pages_and_api`; browser walk of 13 routes × 2 themes against the real console: 0 CSP violations, 0 page errors, theme applied before paint |

### Final gate output (after the fixes)

| Gate | Result |
|---|---|
| `ruff check .`, `ruff format --check .` | All checks passed; 79 files already formatted |
| `mypy` | Success: no issues found in 52 source files |
| `pytest -q` | 273 passed |
| `npm run typecheck`, `npm run lint` | Pass, 0 errors, 0 warnings |
| `npm test` | 47 files, 546 tests pass |
| `npm run build` | Pass; startup JS 146.9 kB gzip (budget 200 kB) |
| `E2E_PORT=5230 E2E_DEMO_PORT=30080 npm run e2e` | 34/34 pass, run twice (incl. axe on every route and state in both themes, the benchmark flows and the perf guard) |
| `shellcheck deploy/install.sh install.sh` | Clean |
| `install.sh {agent, agent --enable-benchmarks, console --nodes …, uninstall, uninstall --purge} --dry-run --yes` | All 5 exit 0 |
| `systemd-analyze verify deploy/systemd/*.service` | Only the expected missing `/opt/sparkline/venv` |
| `docker compose -f deploy/docker-compose.yml config` | Valid |

## Known limitations

- **Hardware benchmarks: run for real on 2026-10-07, with these gaps.** Every benchmark has now run on both idle
  nodes through the console API and been cross-checked against independent tools (own CUDA, C STREAM, C pread
  and pwrite, hand perftest, vLLM `/metrics`, NIC and disk counters, `nvidia-smi`). The numbers are in
  DISCOVERY.md "Measured on hardware (2026-10-07)". FP4 is supported on GB10 (NVFP4, ~347 TFLOPS). Bugs that
  the fakes could not catch were fixed then, among them: CPU memory bandwidth inflated up to 47 % (clock started
  after the workers were released), CPU throughput ~17 % low (glibc heap trimming made zlib page-fault),
  random 4 KiB I/O GIL-bound at high thread counts, NCCL small-message latency 3–4× high (rank skew timed),
  LLM decode rate high when the model stops by itself, vLLM `serve <model>` not detected (and its engine
  process's memory not attributed), the LLM memory figure missing from most runs, console telemetry dropping
  samples, and the results table showing "2149 GHz". NCCL now also records and checks its transport (RDMA vs
  TCP fallback). What is still unverified or open:
  - The **fio path** never ran (fio is not installed on either node); only the built-in runner did. The two
    use different queue depths and are never compared.
  - **LLM inference** ran only against vLLM with Qwen2.5-0.5B on spark1. Other engines (TRT-LLM, SGLang) and
    large models are untested. "Prefill tokens/s" is per request (prompt ÷ TTFT), so at concurrency > 1 it
    is well below the server's aggregate prefill rate.
  - **Concurrency streams and the tool-call eval** (added 2026-10-21) have run only against local fake servers
    and in `--demo`, never against a real model endpoint: both nodes were busy with measured workloads. The
    live stream view, the concurrency sweep, tool-eval-bench's scores and timings, and the tool-calling check
    are unverified on real hardware.
  - The **thermal soak** ran for 10 minutes, not 30. "Time throttled 0 %" does not mean the clocks held:
    GB10 eases the SM clock 1–2 % as it heats without setting a reason bit, which only clock CV and the
    lowest clock show.
  - **RDMA** tests one rail in one direction. A rail runs at ~109 Gb/s; both together are capped at ~185 by the
    shared 200 Gb/s port and the 1024-byte RoCE packets of MTU 1500. One latency run of 10 read 3.89 µs instead
    of ~1.45 and did not reproduce.
  - **Single samples:** each GEMM size is timed once, so a transient goes straight into the result (one
    spark2 BF16 run read 77.5 instead of ~99 TFLOPS and never reproduced). FP8 with per-row scales runs at
    56 TFLOPS at 16384 (PyTorch's row-wise kernel on sm_121), not a Sparkline fault.
  - **Metadata gaps:** the CPU clock shown in monitoring and the CPU benchmark's chart comes from
    `scaling_cur_freq`, which on GB10 is the requested clock (flat 3900 / 2808 MHz); the real one is
    `cpuinfo_avg_freq`. Run metadata snapshots only GPU readings, also for CPU, storage and RDMA runs, and
    RDMA/NCCL runs save no network series. "CUDA" in node metadata is the host driver's 13.0; the container runs
    13.3 in forward compatibility (in `extras.cuda` and the log). `suite_git` is empty on a node deployed
    without `.git`; `suite_sha256` still identifies the code.
  - **NVMe** answers one 4 KiB request in ~200 µs on both nodes, so the default 4-worker random result is
    12–18 k IOPS; checking interrupt coalescing needs root. The free-space margin (file × 1.1 + 1 GiB) is thin
    on a nearly full shared disk.
  - Runs saved before the fixes keep their old numbers (and the soak's telemetry its 2 s holes).
- **spark2 verified after the gate (2026-10-07).** The lead redeployed the final code to spark2 and ran both agents
  with the real console: both nodes online, GPU util/temp/power/SM clock identical to `nvidia-smi` on each node,
  both CX7 rails active, the served model detected on both, no browser console errors. Killing the spark2 agent
  showed "Agent unreachable on spark2 · Connection refused at 10.20.20.195:9750 · Check `systemctl status
  sparkline-agent` on spark2"; restarting it brought the node back online without intervention.
- **No whole-system power.** GB10 exposes only the NVML GPU rail; the UI labels power "GPU rail only" and energy
  totals and cost cover the GPU only. The GPU power limit is not reported either.
- **Fans and CPU temperature are not exposed** on these nodes; both show "Not reported by this hardware".
- **24-hour memory stability was tested accelerated and simulated, not for 24 real hours.** Evidence: a 75-minute
  real-browser soak (10 h of demo time, 143 route changes) where app data grew 0.61 MB/h, DOM nodes, listeners and
  chart count stayed flat, but V8 compiled code was still growing (+1.6 MB/h, halving over the run); a vitest
  replay of 259,200 samples with 200 mounts/unmounts where every buffer and subscription returns to baseline; and a
  47-minute agent/console soak with flat RSS. To run the real thing: `cd web && SOAK_MINUTES=1440 npm run soak`
  (writes `perf/soak.csv` and `perf/soak.svg`, exits 1 on an upward trend).
- **Frame rate is a lower bound.** Headless Chromium here has no GPU; the overview reached about 30 fps at 1440×900
  in a software compositor (51 fps at 1280×720). Long tasks (0 over 50 ms) and main-thread share are the numbers
  that carry over to a laptop.
- **No real root install.** `install.sh` was checked with shellcheck, every dry-run mode, `--destdir` staged
  installs (uv and pip paths, from the hash-checked lock) and transient user units, but never as root against
  `/`, and no unit was installed with systemd. The root `install.sh` is a thin wrapper around
  `deploy/install.sh`, so messages name the latter.
- **The Docker image was built only up to its Python stage** in the final pass (`--target build`, to check the
  lock install); the web stage and runtime stage are unchanged apart from the digest-pinned base images.
- **`requirements.lock` must be regenerated** when `pyproject.toml` dependencies change (the command is in its
  header). Its hashes cover every platform's wheels, but only aarch64 Linux was installed from it here.
- **Tokens under 16 characters are now refused** by the agent and the console. install.sh has always generated
  43-character tokens, so only hand-written configs with short tokens are affected.
- **The confirm dialog's duration is a client-side guess.** It scales the catalog estimate per parameter, so for
  the storage benchmark with a shorter runtime per profile it said "≈ 25 s" where the agent estimated 4 s (the run
  view switches to the agent's estimate). Harmless but imprecise. In `--demo`, runs are also compressed to about a
  tenth of the estimate (LLM inference plays at double speed, 4–60 s per level); the catalog descriptions say so,
  but the confirm dialog still shows the real estimate.
- **No built-in TLS; one agent token shared by all nodes.** Use a reverse proxy (with `trusted_proxies`) or a
  VPN beyond the LAN. The CSP is sent by the console only: `npm run e2e` runs behind `vite preview`, which does
  not send it, so the CSP was verified with a separate browser walk against the real console.
- **Offline-node history charts each say "spark3 is unreachable"** (one short line per chart, under the node
  banner that carries the cause and fix) rather than collapsing the page into a single message.
- **"Running at full speed" needs the clock at 80 % of its maximum.** A busy GB10 runs near 2.2 of 3.0 GHz with no
  limit reasons, so under load the GPU tab reads "No clock limits active — the driver is running the clocks below
  maximum", which is accurate but less reassuring.
- **Only live sparklines use a fixed time window.** History-range sparklines (Thermals tables at 1 h/24 h/7 d)
  still span the data they have, which is normally the whole range.
- **Log redaction covers HTTP headers only.** Request URLs are logged as before; the agent stream also accepts
  `?token=` (used by no Sparkline client), which uvicorn's access log would record.
- **Monitor-only nodes cannot run host-side benchmarks** (they are marked CPU-capped). Enabling benchmarks puts the
  agent in the `docker` group, which is root-equivalent.
- Offscreen charts do not redraw (by design, to save the main thread). Anything that captures the whole page
  without scrolling, such as a full-page screenshot, shows their last drawn legend.
- The hwmon sensor list is fixed when the agent starts; a sensor that reappears under a new hwmon index needs an
  agent restart. The console keeps its live ring as Python objects (about 100 MB at 250 ms sampling).
- The demo is fixed at 1 Hz; `--demo-speed` speeds up only the failure schedule.
- Wide tables scroll sideways on a phone and at 200 % text rather than reflowing.
- The review screenshots cited above (`web/screenshots/phase-e/polish/`) are git-ignored; only the README set in
  `docs/screenshots/` is meant to be committed.
