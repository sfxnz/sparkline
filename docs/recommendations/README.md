# Recommendations: the evidence behind each one

The Recommendations tab lists settings that DGX Spark owners recommend to each other. The list ships in the
release, in `server/sparkline/common/recommendations.py`. This directory holds the evidence for each entry
and the script that produces it.

## What "measured" means

Every entry has sources that you can open. A source shows that owners recommend the setting. A source does
not show that the setting works on your machine.

An entry counts as measured only when its `measurement` field is filled in from a run of
[`measure.py`](measure.py) on a real DGX Spark, and the run is written up in `<id>.md` in this directory.
The tab shows the before and after numbers of a measured entry and links to that file. The tab shows every
other entry as "Not measured by Sparkline yet". A test fails when an entry has a measurement and no evidence
file.

In 0.3.0 no entry is measured. All four are community claims with their sources.

| Entry | State |
|---|---|
| `gpu-clock-cap` | Not measured |
| `cpu-pcore-cap` | Not measured |
| `headless-boot` | Not measured |
| `display-reserved-memory` | Not measured. A measurement needs a reboot |

## Measure a recommendation

`measure.py` needs root, because it switches the setting. Read it before you run it. It uses only the Python
standard library.

1. Stop other work on the model server. The script sends its own load, and other requests change the result.
2. Find out whether the setting is on or off now. The GPU driver does not report a clock cap, so the script
   cannot find that out by itself.
3. Run the script on the node:

	```sh
	sudo python3 docs/recommendations/measure.py gpu-clock-cap --found off \
		--base-url http://127.0.0.1:8000 --model MODEL_NAME
	```

4. If two Sparks serve the model, start the script on both at the same `--start-at` time. Give the second
   node `--no-load`. A cap on one node only hides the cost, because the other node sets the pace.

The script runs four arms of eight minutes: control, candidate, control, candidate. In each arm it measures
single-stream decode speed six times, one cold prefill, and then keeps four streams busy until the arm ends.
It samples every thermal zone, the GPU clock, the GPU power, and the fan speed every two seconds. When the
script ends, is interrupted, or fails, it puts the setting back to the `--found` state.

Read the result against these questions before you call an entry measured:

- **Did both candidate arms differ from both control arms?** A gap smaller than the gap between the two
  control arms is no difference.
- **Did requests fail?** The script prints the count. A failed request is fast and makes speed look better.
- **Did the setting take effect?** For the GPU cap, `gpu_clock_mhz_peak` must be under the cap in the capped
  arms and over it in the others.
- **Was the machine otherwise idle?** `load1_mean` should be alike in every arm.
- **Which temperature?** Use `zone_max_c_tail_mean`, the hottest thermal zone. `nvidia-smi` reads lower than
  the hottest zone on this hardware.

## Add a recommendation

1. Add a `Recommendation` to `CATALOG` with at least one source that you opened and read.
2. Add a probe for its id to `PROBES` in `server/sparkline/agent/recommend.py`. The probe runs without root
   and changes nothing.
3. If one click can apply the setting, add a row to `TUNES` in `server/sparkline/tune.py`. Both functions
   must set a target state, so that a second run changes nothing.
4. Measure it, write `<id>.md` here, and fill in `measurement`. Until then the entry ships as a community
   claim.

## Candidates that are not in 0.3.0

| Candidate | Why not |
|---|---|
| Drop the page cache before a model load | It is an action with no applied state to detect. NVIDIA documents it as a debugging workaround |
| earlyoom | It needs a package install. Only a forced out-of-memory event on a working machine can show the benefit |
| `kho=off` on kernel 7.0 | An NVIDIA hotfix for one kernel, with mixed owner results |
| Low `vm.swappiness` | No owner posted data, and one reasoned objection |
| ConnectX-7 power-down when unused | Owners do not agree on a method that survives a reboot |
| Fan control | It needs a kernel module or an embedded-controller downgrade, and current firmware ignores the writes |
| CPU governor change | One of the few reports was retracted |
| 64 KiB-page kernel | Too invasive for one click |
