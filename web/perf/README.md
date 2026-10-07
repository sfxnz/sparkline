# Frontend performance

The brief's budgets: 60 fps during live updates with no long tasks over 50 ms while streaming, initial load under
2 s on LAN with a lean, code-split bundle, and memory that stays flat over a 24-hour session. Each one has a script in
`web/scripts/`. They start a throwaway demo console (`sparkline --demo`, data in a temp dir that is deleted on exit)
serving the production build, and drive it with headless Chromium.

| What | Command | Output |
|---|---|---|
| Memory soak | `SOAK_MINUTES=1440 npm run soak` (default 60 min) | `perf/soak.csv`, `perf/soak.svg`, exit 1 on an upward trend |
| Frame budget | `npm run perf:frames` (`--seconds 60 --throttle 1,4`) | table: fps, frame-time percentiles, long tasks, main-thread % |
| Initial load | `npm run perf:load` (`--runs 5`) | table: first contentful paint, overview with live numbers |
| Startup bundle | `npm run perf:bundle` (`--budget-kb 200`) | gzip size of everything a cold load fetches before rendering |

Every script takes `--port` (default 9711-9713, so it never collides with a running console) and `--dist` (default
`web/dist`). `npm run e2e` includes `e2e/perf.spec.ts`: no long tasks over 20 s of streaming on the overview, and
startup JS under 200 KB gzip with the benchmark suite, alerts, settings, wall mode and sign-in out of the startup graph.
`src/store/soak24h.test.tsx` (part of `npm test`) replays 24 h of 1 Hz traffic from three nodes through the real
stores while mounting and unmounting the real views 200 times.

## Memory soak

`soak.mjs` loads the app once and then navigates inside it (overview, every tab of every node, alerts, benchmarks,
settings, wall mode, the command palette, 1 h / 24 h ranges) every 30 s, starting a short simulated benchmark every
10 minutes. The demo runs `--demo-speed 8`, so its failure schedule (stale and offline nodes, thermal episodes,
alerts) plays 8x faster. Samples still arrive at 1 Hz per node, as in production. Every 2 minutes the script returns to
the overview, forces a full GC over CDP and records the JS heap, DOM nodes, JS event listeners and uPlot instances. It
then fits a line through the samples after a 10-minute warm-up.

`soak.csv` and `soak.svg` hold the run described below.

75 minutes of wall time, which is 10 h of demo time: 143 in-app route changes, 39 samples, 34 of them after the
warm-up.

| Metric (post warm-up) | trend | min | max |
|---|---|---|---|
| JS heap after GC | +1.39 MB/h (+2.78 MB/h in minutes 10-40, +1.35 MB/h in minutes 40-75) | 9.9 MB | 12.5 MB |
| of which app data (objects, arrays, strings, closures), from heap snapshots at 11 and 75 min | +0.61 MB/h (2.94 → 3.60 MB) | | |
| of which V8 compiled code | +1.60 MB/h (5.77 → 7.50 MB) | | |
| DOM nodes | -33/h (flat; it alternates by which overview state is up) | 1965 | 2368 |
| JS event listeners | -2/h (flat) | 308 | 355 |
| uPlot instances on the overview | 0 | 6 | 6 |

Result: PASS. DOM nodes, listeners and charts are flat. App data grows by 0.61 MB/h, under the 1 MB/h limit, while
the event timeline (cap 500) and benchmark runs (cap 200) are still filling. The rest of the heap growth is V8
optimizing more of the app as it gets exercised, and that growth halves between the first and second half of the
run. Only a long run shows where it settles: `SOAK_MINUTES=1440 npm run soak`.

Found and fixed: the history cache (`store/history.ts`) kept up to 64 responses whether they had expired or not. A
24 h per-core response is hundreds of KB, and an expired one is never reused. Expired responses are now dropped on
every load. Heap snapshots 16 minutes apart, while switching ranges, compared before and after the fix:

| | arrays | heap numbers |
|---|---|---|
| before | +640 KB | +478 KB |
| after | -22 KB | -53 KB |

The same run before this pass gave a heap trend of +2.98 MB/h, and +2.91 MB/h with the frame-budget fixes alone. Its
snapshots put app data at +2.06 MB/h.

`src/store/soak24h.test.tsx` covers the stores without a browser. It replays 259,200 samples, an alert and a recovery
every minute, node status flaps, a benchmark run every 5 minutes and history loads with many key sets, while mounting
and unmounting the Overview, a GPU tab and a CPU tab 200 times. The real uPlot and heatmap code runs against a no-op
canvas. It asserts:

- the ring buffers are full at 3,600 ticks, and their bytes equal capacity x keys x 8, exactly as at the first sample;
- events stay at 500 or fewer, runs at 200 or fewer, and the history cache at 64 or fewer;
- after the last unmount, LiveStore subscriptions, zustand subscriptions, window and document listeners,
  Resize/IntersectionObservers, intervals and pending animation frames all return exactly to the baseline;
- the views really did subscribe while mounted.

A deliberately leaked `visibilitychange` listener in `TimeSeriesChart` fails it with 749 listeners against a baseline
of 6.

## Frame budget

Measured with `frames.mjs --seconds 60` on the production build. The page streams three demo nodes and is measured
at 1x and at 4x CPU throttling (CDP `Emulation.setCPUThrottlingRate`, roughly a mid-range laptop next to this fast ARM
desktop). The bench row is a running simulated thermal soak. Each cell shows before → after this pass.

| View | CPU | fps | p50 / p95 / p99 frame ms | frames > 25 ms | frames > 50 ms | long tasks (max ms) | main thread % |
|---|---|---|---|---|---|---|---|
| overview | 1x | 34.8 → 34.4 | 33.3 / 33.4 / 49.9 → 33.3 / 33.4 / 33.5 | 71.2% → 73.6% | 0.24% → 0.15% | 0 → 0 | 6.7 → 4.6 |
| node GPU | 1x | 46.5 → 51.3 | 16.7 / 33.4 / 33.4 → 16.7 / 33.4 / 49.9 | 28.3% → 15.8% | 0.07% → 0.13% | 0 → 0 | 3.9 → 2.8 |
| node CPU (heatmap) | 1x | 47.6 → 53.3 | 16.7 / 33.4 / 50 → 16.7 / 33.3 / 33.4 | 23.8% → 11.3% | 0.60% → 0.47% | 0 → 0 | 4.8 → 3.5 |
| wall mode | 1x | 60 → 60 | 16.7 / 16.8 / 16.8 → 16.7 / 16.7 / 16.8 | 0% → 0% | 0% → 0% | 0 → 0 | 4.4 → 3.7 |
| running benchmark | 1x | 45.1 → 46.9 | 16.7 / 33.4 / 50 → 16.7 / 33.4 / 33.4 | 31.0% → 27.4% | 0.55% → 0.18% | 0 → 0 | 3.7 → 3.7 |
| overview | 4x | 34.3 → 34.6 | 33.3 / 33.4 / 50 → 33.3 / 33.4 / 33.5 | 72.6% → 72.7% | 0.63% → 0.14% | 0 → 0 | 17.3 → 12.9 |
| node GPU | 4x | 44.9 → 50.3 | 16.7 / 33.4 / 50 → 16.7 / 33.4 / 49.9 | 32.1% → 17.8% | 0.37% → 0.50% | 0 → 0 | 12.0 → 8.2 |
| node CPU (heatmap) | 4x | 46.1 → 52.4 | 16.7 / 33.4 / 66.6 → 16.7 / 33.4 / 50 | 25.8% → 12.8% | 1.45% → 0.60% | 2 (88 ms) → 0 | 13.4 → 9.7 |
| wall mode | 4x | 60 → 60 | 16.7 / 16.7 / 16.8 → 16.7 / 16.8 / 16.8 | 0% → 0% | 0% → 0% | 0 → 0 | 21.8 → 9.6 |
| running benchmark | 4x | 57.7 → 58.1 | 16.7 / 16.8 / 33.4 → 16.7 / 16.8 / 33.4 | 2.0% → 1.9% | 0.95% → 0.43% | 1 (50 ms) → 0 | 6.3 → 6.0 |

How to read it:

- **Main thread.** The app uses 3-5% of the main thread at 1x and at most 13% at 4x. Since the fixes there are no
  long tasks anywhere, even at 4x.
- **fps is limited by this test machine.** Headless Chromium here has no GPU, so a software compositor redraws the
  whole 1440x900 frame. That compositor saturates at about 30 fps on the overview, and its cost scales with area:
  the overview runs at 51 fps at 1280x720 and at 60 fps at 1024x700, and hiding the sidebar or the page content also
  gives 60 fps. Wall mode, with fewer translucent layers, runs at 60.
  A laptop composites on its GPU, so read the fps column as a lower bound. The main-thread and long-task columns
  carry over to real hardware.

Fixed:

1. **Plots rebuilt on every sample.** The CPU, Network and Storage tabs destroyed and recreated their uPlot charts
   once a second (10-30 plots per 10 s). `TimeSeriesChart` keyed its plot effect on the `series` array's identity,
   and those tabs passed a fresh array literal on each render. It now keys on content, with a regression test.
2. **Whole tabs re-rendered on every sample.** `useHasData` (`views/node/partsB/hooks.ts`) used the latest
   timestamp as its snapshot, so the CPU, Network and Storage tabs re-rendered completely at 1 Hz. The snapshot is
   now the boolean.
3. **Heatmap colour per cell.** The heatmap built 3,600 colour strings per sample (regex, parse, format). It now uses
   a 101-step lookup table per palette (`heatLut`).
4. **AnimatedNumber text churn.** Every spring frame replaced the text node. That invalidated the `:has()` rules on
   the overview card, forcing a style recalc of the whole card (about 6,000 invalidations in 15 s). Writes now go
   into the existing text node, and only when the text changes.
5. **Live charts polled every frame.** Each chart kept a requestAnimationFrame loop running to check whether it had
   scrolled half a pixel, which made Chromium run a full main-thread frame at 60 Hz. The loop now sleeps until the
   next half-pixel step, on a grid shared by all charts. Wall-mode main thread at 4x dropped from 21.8% to 9.6%.

## Initial load

Measured with `load.mjs --runs 7`: cold cache, CDP network profile of 100 Mbps with 2 ms RTT, a fresh browser
context per run, and the console serving gzip.

| Build | CPU | first contentful paint (median) | overview with live numbers (median / worst) |
|---|---|---|---|
| before | 1x | 880 ms | 1146 / 1191 ms |
| after | 1x | 884 ms | 1150 / 1598 ms |
| before | 4x | 1096 ms | 1485 / 1646 ms |
| after | 4x | 1004 ms | 1436 / 1542 ms |

Every run, even at 4x, is under the 2 s budget. The load is dominated by fixed costs, not bytes: a context on a quiet
browser paints in 220-300 ms, and later contexts in the same run are slower, so treat the medians as conservative.

Startup bundle (`bundle.mjs`, gzip). It covers the entry script, its modulepreloads and their static imports:

| | before | after |
|---|---|---|
| startup JS | 181.0 KB | 151.9 KB |
| startup CSS | 18.4 KB | 14.0 KB |

Lazy now: alerts (6.9 KB), settings (5.3 KB), wall mode (5.6 KB) and sign-in each have their own chunk. Motion's
animation engine (`single-value`, 9.8 KB, plus `animate`, 4.9 KB) loads right after startup, and numbers change
instantly until it arrives. The benchmark suite (30.1 KB) and motion's layout features (18.6 KB) were already lazy.
React DOM (about 62 KB) and uPlot (about 22 KB, needed by the overview chart) remain the largest startup costs.
