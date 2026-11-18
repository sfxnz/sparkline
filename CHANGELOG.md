# Changelog

This file lists the notable changes in each Sparkline release. It follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Sparkline uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The console, the agent and the web app share one
version. [docs/RELEASING.md](docs/RELEASING.md) says how to cut a release.

## [Unreleased]

### Added

- **One Spark is two commands.** `sudo ./install.sh console` with no `--nodes` shows the agent installed on
  the same host. It reads the node id, the address and the agent token from that agent's config, so there
  is nothing to edit.
- **A sign-in link.** The console installer prints `http://<console>:9700/login#token=…` next to the token,
  on an interactive terminal only. Opening it signs you in, and the app takes the token out of the address
  bar before anything else reads the address. The token is in the part of the link that a browser never
  sends, so it is in no query string and reaches no server log. The browser may keep the link you opened in
  its own history, so the link is as secret as the token.
- **A first-run sign-in.** A console that nobody has signed in to says so, and shows the command that prints
  its token with a copy button. Afterwards the same help is under "Where is the token?". After too many wrong
  tokens the page shows the console's own explanation and fix, where it used to show raw JSON.
- **Nodes that have not answered yet.** A node the console has never heard from reads "Not connected yet" on
  its card, its page, the sidebar, the wall, the benchmark cards and in Settings, in a neutral tone, and
  Settings > Data offers no "Clear history" for it. Its card shows what the console tried, the likely cause
  and the fix a step at a time, each command once, in a box under its step with a copy button, the time to
  the next try and **Retry now**. A command box wraps at its spaces, also on a phone. When the agent
  answered and turned the console away (a wrong token), the card says that only the fix will connect it,
  where it would count down to the next try. While the browser cannot reach the console, the card says
  nothing about tries. The node's first reading arrives on the card in place.
- **Getting started.** The overview of a new install carries a short guide: connect your nodes, get told
  when something breaks, model servers, Prometheus and benchmarks. Each row opens the real page and shows
  what the cluster already has. A row is ticked once you have opened it, or when the cluster already has
  the thing. "Connect your nodes" is ticked when every node has answered. Once you open a row the guide
  becomes one line, and **Dismiss** puts it away for every browser, because the console remembers it and not
  the browser. It ends by itself when every row is done. **Settings > About** and "Open getting started" in
  Search bring it back, and a guide brought back stays, in full with its rows ticked, in every browser,
  until you dismiss it. An install that existed before this release never sees it.
- **Settings > Prometheus** shows the scrape address and a `scrape_configs` job with your console's address
  filled in, each with a copy button.
- `GET /api/v1/auth/me` has `first_run`, the cluster state has `onboarding` and each node has `first_seen`.
  `PUT /api/v1/onboarding` records an opened guide row, a dismissal or a reopening, and every open tab
  follows through an `onboarding` message.
- `--demo-first-run` runs the demo as a new install: no benchmark history and no events, two nodes connect
  within seconds and the last one refuses connections at first and is live about 45 s in. The demo's
  scripted failures start five minutes in.

### Changed

- A node that has never answered raises no "node offline" alert and sends no notification. It has never been
  online, so there is nothing to recover from. After its first reading it is an ordinary node, and going
  offline alerts as before.
- Each installer ends with the one next step: the agent installer with the console command for that host,
  and the console installer with the nodes it will show and the sign-in link. Re-running the console
  installer ends with the console's address and how to sign in. That line, and a token line where the
  output is not a terminal, put the command that reads the token on a line of its own.
- The console tries a node that has never answered every 5 s at most, so starting its agent shows on the
  page within seconds. While that node's agent turns the console away (a wrong token), it is tried every
  10 s at most. A node that has answered before is tried up to 30 s apart, as before.
- An agent that has had 10 wrong tokens from one address in a minute refuses the next token unread, right
  or wrong. The console now never sends the tenth: its own tries and **Retry now** together stop at nine in
  a minute, and the next one waits until there is room, which the card's countdown shows. So a corrected
  token is accepted on the first try, however often **Retry now** was pressed. **Retry now** is one try. It
  no longer restarts the retry schedule, and a try that is already under way is that try.
- The fix for "Agent unreachable" on a refused connection says what to run: the command that starts the
  agent, the command that shows why it did not stay up and, for a node that has never answered, the install
  command. The fix for a rejected agent token says how to compare the two tokens and which service to
  restart. A fix that edits `console.toml` now ends with the console restart, because the console reads its
  config only when it starts. Every fix is now written as steps: each is a sentence, and a step with
  something to run ends in that command after a colon. The fix for a timeout or a dropped connection names
  the command that reads the agent's log.
- A config example with a copy button (an empty Notifications panel, the Prometheus scrape job) wraps on a
  phone, so every character is on screen without scrolling. Copy still takes the exact text.
- The toolbar's connection pill reads "Connected", in a neutral tone, until a node has answered the console
  for the first time. It read "Live" in green over a page with no readings. From the first reading on it
  is "Live", as before.
- On the benchmark cards, a node on its first connection attempt reads "Connecting".
- A dialog that closes no longer pulls focus back to the control that opened it when focus has already
  moved on, as it has after a Search command that opens a panel.
- The web app uses one apostrophe style, the typographic one (’), in everything it says.

### Fixed

- **Small screens.** The sign-in token field no longer makes iOS Safari zoom the page: its text is 16 px on
  a small screen. A device with only a touch screen is not shown the "Ctrl K" hint beside Search.
- **Alerts > Notifications on a phone.** With no channel configured, the card's text and its `[[notify]]`
  example were cut off on both sides on a narrow screen. Both now wrap, and the example has a copy button.

## [0.2.0] - 2026-11-17

### Upgrading

Run `sudo sparkline update` on the console host. It updates the console first and then every node, which is
the order this release needs: a 0.1.2 console shows a 0.2.0 agent's node without its model servers, and a
0.2.0 console says "Update the agent" in that panel for an older agent. No config edit is required.

Two things start on their own after the update:

- Each agent asks the usual model server ports on its own node (8000, 8080, 9931, 30000, and any port that a
  process holding GPU memory was started with) for a model server, and reads the ones it finds every
  2 seconds. `model_server_discovery = false` in `agent.toml` stops that.
- `GET /metrics` on the console answers the console token. Set `metrics_token` in `console.toml` to give
  Prometheus a token that opens nothing else.

Notifications stay off until `console.toml` has a `[[notify]]` table.

To go back to 0.1.2, remove every `[[notify]]` table and the `metrics_token` key from `console.toml` first,
and `[[model_servers]]` and `model_server_discovery` from `agent.toml`. 0.1.2 refuses to start on a config
key it does not know.

### Added

- Alert notifications. Each `[[notify]]` table in `console.toml` is a channel (`ntfy`, `discord`, `slack` or a
  generic JSON `webhook`) that receives alerts and their recoveries when no browser is open, filtered by
  `min_severity` and `send_resolved`. Alerts that fire at the same moment arrive as one message. The Alerts
  view lists the channels with their last delivery and a **Send test** button, through `GET /api/v1/notify/channels`
  and `POST /api/v1/notify/channels/{name}/test`. The console sends to the hosts in those
  tables, which can be outside the LAN: see "Security model" in the README and `docs/adr/0003-outbound-notifications.md`.
- **Model servers.** Each agent finds the model servers running on its own node, with no setup, and the node
  summary shows for each one whether it is up, which model is loaded, the requests running and waiting, tokens
  per second, time to first token, KV cache use and memory held. The overview card carries one line per
  server. It reads vLLM, SGLang, llama.cpp, NIM, TensorRT-LLM and any server that uses the same Prometheus
  metric names under its own prefix. A value a server does not export reads "Not reported by this server",
  never 0. The readings are also history and alert keys, `llm.<port>.<field>`. `[[model_servers]]` in
  `agent.toml` names a server on another port or one that needs an API key, and
  `model_server_discovery = false` stops the agent asking any port you did not list. See
  [Model servers](README.md#model-servers).
- **Prometheus export.** `GET /metrics` on the console serves every node's latest readings in Prometheus
  text format: GPU, memory, CPU, network, disk, filesystem, temperature and model-server series named
  `sparkline_*`, in base units, with a `node` label. A node that is not online exports only
  `sparkline_node_up` 0 and the time of its last sample. The new `metrics_token` key in `console.toml` opens
  `/metrics` and nothing else, so Prometheus does not need the console token. See
  [Prometheus](README.md#prometheus).

### Changed

- Editing, disabling or deleting an alert rule while its alert is open now adds a "Resolved" event that says
  the rule was changed or removed, in the timeline and on every notification channel. Before, the alert was
  closed with no recovery. If the edited rule still matches, its alert fires again.
- An alert that is open when the console restarts stays open until a reading from its node decides it, then
  ends with a "Resolved" event or fires again. Before, every open alert was closed at the start with no recovery.

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

[Unreleased]: https://github.com/sfxnz/sparkline/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sfxnz/sparkline/releases/tag/v0.2.0
[0.1.2]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.2
[0.1.1]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.1
[0.1.0]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.0
