# Changelog

This file lists the notable changes in each Sparkline release. It follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Sparkline uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The console, the agent and the web app share one
version. [docs/RELEASING.md](docs/RELEASING.md) says how to cut a release.

## [Unreleased]

### Added

- **Will it fit?** A new page estimates what a model needs at a context length (weights, KV cache, and 10 to
  20 % on top for activations, so the total is a range) and compares it with what each node has free in its
  latest sample: available memory minus 4 GiB on a unified-memory node, or the free memory of the emptiest
  GPU on a node with dedicated GPU memory. Each node gets a verdict: Fits, Tight, Does not fit or Unknown.
  Look up reads a public repo from huggingface.co and fills in the size of that repo's safetensors files.
  The page says so where the number is, on the form and above the verdicts, and names what is not counted:
  a second model the repo loads, a draft model's target, the base model under an adapter. A lookup cannot
  see those, so they are added by hand.

  A size is filled in only when nothing the lookup read is a sign that the model reaches outside the repo:
  the `config.json` can be read and holds no string naming another Hugging Face repo (under any key, except
  `_name_or_path` and an `auto_map` code pointer) and none of the keys a draft model keeps about its
  target; there is no `adapter_config.json`; every `.safetensors` file is one the lookup sized and none is
  listed twice; and every weight file in another format (`.bin`, `.pt`, `.pth`, `.ckpt`, `.gguf`, `.npz`)
  is named as a copy of the same weights or as training state. The
  weights are then the files that `model.safetensors.index.json` names, or `model.safetensors` where there
  is no index, so a 4-bit AWQ, GPTQ, bitsandbytes or MLX repo counts as it is stored. The model's shape
  is worked out from the top-level keys of that same `config.json`, and no size is filled in without it.
  Where the config has no `head_dim`, the head size is `hidden_size` divided by `num_attention_heads`, and
  the form and the result say it was worked out, not read. A
  `num_key_value_heads` of `null` beside a config class the config names under `auto_map` is refused,
  because the lookup reads no code and cannot tell how many KV heads a layer has. A config that gives its
  layers one by one and not all alike (a top-level list with as many entries as `num_hidden_layers`, or
  an object keyed by layer number, whose entries are numbers or objects) is refused too, because the
  lookup sizes every layer alike and cannot tell whether an entry changes a layer's KV cache. A key whose
  name ends in `token_id` or `token_ids` holds vocabulary ids and is skipped. An index over
  1 MiB is not read; when the repo's safetensors files are then one set of shards, the weights are their
  total, which a server never exceeds, and the page says so beside the number. Every other repo gets no
  size and a refusal in two parts: what the lookup read, then one of two instructions that are the same
  words for every repo. One asks for the size, the total of every weight file the server loads in every
  folder of the repo and in any other repo. The other asks for the size and for the shape of the language
  model that answers. A refusal never says what a server loads, what kind of model the repo is, or where a
  number can be read. A refusal fills in the shape alone, or nothing: nothing after a sign of a second
  model (a config string naming another repo, an `adapter_config.json`, a draft model's keys), and nothing
  when no shape was read.

  The same facts can be typed instead, as the total of every weight file the server loads, in GiB or GB and
  never as a parameter count. A result says where the size and the shape each came from, read from the repo
  or typed by hand. A lookup replaces the model on the form and takes an earlier result off the page. The
  KV cache is an estimate that counts every layer as an attention layer of one width. It is too high,
  sometimes several times, for a model that windows its attention, shares a latent cache (MLA, 25 times less for DeepSeek-V3), mixes in layers
  that keep no keys (Mamba, convolution, linear attention), or keeps its KV head count under a key the
  lookup does not read, which the page says. New endpoints `GET /api/v1/fit/lookup?repo=` and `POST /api/v1/fit/estimate`. The new
  `console.toml` key `hf_lookup` (default `true`) turns the lookup off.

## [0.1.2] - 2026-11-11

### Upgrading

Hosts on 0.1.1 have no remote update yet, so this upgrade is the last one done host by host. Run
`sudo sparkline update` once on the console host and once on each other 0.1.1 node. On older nodes, run the
installer from a checkout. From then on, one `sudo sparkline update` on the console host updates every node.

### Added

- `sudo sparkline update` on the console host updates the whole cluster: this host first, including its own
  agent when `console.toml` lists it as a node, then every other node in `console.toml` that is behind, all
  at once, with one result line per node. `--check` and `--dry-run` list every node; `--this-host` updates
  only the host it runs on. Each agent gets `POST /api/v1/update`, which only asks the new root helper units
  `sparkline-update.path` and `sparkline-update.service` to install the latest release (#89).

## [0.1.1] - 2026-11-10

### Upgrading

Sparkline 0.1.0 has no `sparkline update`, so upgrade a 0.1.0 host to 0.1.1 from a checkout of `v0.1.1`, as
[docs/RELEASING.md](https://github.com/sfxnz/sparkline/blob/main/docs/RELEASING.md#upgrade-the-console-before-the-agents)
says. After that, `sudo sparkline update` installs each later release.

### Added

- `sudo sparkline update` updates the console and the agent on a host to the latest release. It keeps the
  config, the data and the benchmark setting. `sparkline update --check` compares the host with the latest
  release (#86).
- The installer links `sparkline`, `sparkline-agent` and `sparkline-capture` in `/usr/local/bin` (#86).
- Each GitHub release carries `sparkline-X.Y.Z.tar.gz`, the source with the built web app, and
  `SHA256SUMS` (#86).

### Fixed

- A browser tab left open across an update reloads onto the new web app when it opens a page it had not
  loaded yet, instead of showing "Settings couldn't be displayed" (#87).

## [0.1.0] - 2026-11-09

The first tagged release. It includes all earlier work on `main`, which had no version tags. The lists
below name the changes merged last before the release.

Sparkline 0.1.0 has run only on a DGX Spark. Its paths for Intel and AMD x86 CPUs and for discrete NVIDIA GPUs
are tested against recordings built from vendor and kernel documentation, against fake GPU backends and against
simulated demo nodes. It does not read AMD or Apple GPUs yet. On those machines, and on any Mac, the GPU
benchmarks say why they cannot run. Reports from real hardware are welcome, and `sparkline-capture` records a
Linux machine for one.

### Upgrading

If you run Sparkline from a checkout older than 0.1.0, upgrade the console first and the agents after it,
or upgrade them all at once. A 0.1.0 console reads older agents correctly, except that their interconnect
headings say "Interconnect" without the NIC model, which older agents do not report. An older console misreads
a 0.1.0 agent in two ways:

- When the memory collector of a 0.1.0 agent cannot start, the agent keeps running and sends an empty memory
  reading. An older console reads that as no free memory and raises a false "Memory running low" alert.
- An older console refuses an RDMA benchmark on rail B of a 0.1.0 agent when rail A has no address.

The agent's history database upgrades itself on first start, and an older agent can still write to it after a
rollback. If you go back to an older console, its two GPU throttle alerts watch GPU 0 only, and an alert rule
on a node-wide GPU total (`gpu.util`, `gpu.temp_c` or `gpu.power_w`) never fires there. If that older console
saves its own default alert rules, the two GPU temperature defaults stay on GPU 0 after you upgrade again. To
make them watch every GPU, pick **Any GPU temperature** for both rules in the rule editor.
[docs/RELEASING.md](https://github.com/sfxnz/sparkline/blob/main/docs/RELEASING.md#upgrade-the-console-before-the-agents)
gives the upgrade commands.

### Added

- Each metric that a node does not report says why: the hardware lacks it, the agent's user lacks a
  permission, or a helper tool is missing (#66).
- A metric that the machine exposes but Sparkline does not read yet says "Not collected yet" (#71).
- `sparkline --demo-mixed` adds a simulated 4-GPU x86 workstation to the demo, and the GPU tab shows one
  section per GPU (#70).
- Node details show which GPU backend the agent uses, and why it passed over the others (#75).
- `sparkline-capture` records a Linux machine into a redacted directory and archive, so that Sparkline can
  learn hardware the maintainers do not have. You read the recording before you attach the archive to an
  issue, as `docs/record-your-machine.md` says (#76).
- On x86 Linux hosts, the agent names the CPU, splits cores by the kernel's core types and reads CPU
  temperature from k10temp and coretemp (#77).
- On a node with several NVIDIA GPUs, a GPU benchmark runs on the GPU that you pick. On a node without a
  usable NVIDIA GPU, the GPU benchmarks say why they cannot run (#79).
- On discrete NVIDIA GPUs, the agent reads VRAM and the Memory tab shows a VRAM bar per GPU. System memory no
  longer counts VRAM as GPU memory in RAM (#80).

### Changed

- Charts of the last 15 minutes load faster. The agent keeps its recent samples as ready rows instead of
  parsing each one again for every history request (#60).
- Interconnects are named by role ("Interconnect A") with the NIC model beside the name, and the RDMA and
  NCCL benchmarks find their rails from data instead of the label. NCCL on both rails refuses to start when
  a rail is down or has no address, where it used to run on one rail. NCCL on rail B alone meets on rail B's
  address, where it used rail A's (#64).
- The agent reads the machine through one replaceable source, so its collectors are tested against recorded
  machines. A recorded DGX Spark comes with the tests (#67).
- An idle Memory tab no longer redraws 43 times a second after its numbers settle (#68).
- The agent keeps running when one collector cannot start. The tabs of that collector say why they are
  empty, and the node stays online (#69).
- Node totals, the status pill, the overview and the default GPU alerts cover every GPU, not GPU 0 alone. A
  total read from some of a node's GPUs says so, and an alert rule that you point at one GPU stays on that
  GPU (#78).

### Fixed

- `sparkline --demo` starts for a normal user on a machine with Sparkline installed. It used to exit with
  "Permission denied" on the installed console config (#56).
- An end-to-end test no longer fails on slow runs when two "Reconnecting" messages are on the page (#57).
- After a reconnect, power average and peak, sensor minimum and maximum, and live energy include the gap that
  the console filled in (#58).
- An alert threshold reads in the same unit in the rule editor and in the alert it raises. An alert on CPU
  temperature gives it in °C (#59).
- After an agent restart, history counts the partial minute of the restart by the seconds it covers, not as
  a full minute (#61).
- When one history refresh fails, a loaded chart keeps its data with a note that the refresh failed. It used
  to become a Retry box until the next refresh. Range figures such as power average and peak keep their last
  values too (#62).
- Two benchmark runner tests no longer fail on a busy machine (#63).
- The console rejects agent history that holds strings, booleans, NaN or infinity in numeric fields, instead
  of passing it on to the charts (#65).
- A panel whose metric a node lacks says why, instead of a skeleton that never ends or a blank chart (#71).
- A node whose GPUs stop sending readings says so in its stats, its status pill and the overview, and every
  figure that leaves a node out names that node (#81).
- The console starts when a stored settings or alert rules row is unreadable. It keeps a copy of the row and
  uses the defaults, and the Alerts page says when it reset the rules (#81).

### Security

- CI pins every GitHub Action to a commit and gives each workflow only the token permissions it needs, so
  moving an action's tag cannot change the code that CI runs (#72).
- The docs, demo, test data and screenshots use placeholders instead of real machine and network identifiers.
  CI fails when a real-looking identifier, a tool cache or a build output is committed (#74).
- The web tests' copy of undici, which jsdom pulls in, moves from 8.11.2 to 8.12.3 and gets the security fixes
  of undici 8.12.2. The built web app does not include undici (#73).

[Unreleased]: https://github.com/sfxnz/sparkline/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.2
[0.1.1]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.1
[0.1.0]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.0
