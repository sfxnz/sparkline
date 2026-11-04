# Record your machine for Sparkline

Sparkline is tested against recordings of real machines. The maintainer has a DGX Spark and nothing else, so
support for discrete NVIDIA cards, AMD GPUs and other boards depends on recordings from the people who own
them. `sparkline-capture` records what the Sparkline agent reads on your machine into a directory and an
archive that you can attach to a public GitHub issue. It records Linux machines today.

The command only reads. It needs no root, puts no load on the GPU, sends nothing anywhere, and writes only
inside the directory it creates. It records only the files, NVIDIA driver answers and host readings on a list
that the maintainer reviewed for privacy. Before it writes anything, it replaces the values that identify you
or your network with placeholders. If it meets something that it cannot make safe, it writes nothing and says
where.

## Record

You need [uv](https://docs.astral.sh/uv/) and your normal user account. Don't use `sudo`. Run:

```sh
uvx --from 'git+https://github.com/sfxnz/sparkline#subdirectory=server' sparkline-capture
```

If you don't use uv, install Sparkline into a virtual environment first. It needs Python 3.12 or newer.

```sh
python3 -m venv sparkline-venv
sparkline-venv/bin/pip install 'git+https://github.com/sfxnz/sparkline#subdirectory=server'
sparkline-venv/bin/sparkline-capture
```

From a checkout of this repository, run `server/.venv/bin/sparkline-capture`.

The command takes a few seconds. It creates a directory named after your platform, such as
`sparkline-linux-x86_64`, in the current directory. To choose another name, pass it as the only argument,
for example `sparkline-capture rtx4090-box`. The directory must not exist yet, or must be empty.

At the end, the command prints how many values of each kind it replaced and what it left out. Every value
that it prints gets the same placeholders as the recording, so the output directory prints as, for example,
`/home/<user1>/rtx4090-box`. You can paste the lines into an issue.

## Look through the recording

The directory holds plain text and JSON, so you can read every file before you share it:

- `root/` holds the `/proc` and `/sys` files that the agent read, at their paths on your machine.
- `nvml.json` holds the answers of the NVIDIA driver library.
- `host.json` holds the network addresses, disk space, NIC counters, Docker image tags and the tools found.
  A tool found outside the system directories, such as `/usr/bin`, is recorded as `<elsewhere>/<tool>`.
- `platform.json` says how the recording was made and lists what was replaced and left out.

The recording keeps what Sparkline needs to read your hardware: the CPU, GPU and disk model names, the kernel
version and OS name, the network interface names, and the memory, load, temperature, clock, power and
counter readings. For a process that uses a GPU, it keeps the program name, which is the last part of the
first word of the command line.

The recording replaces each of these values with a placeholder. One value gets the same placeholder in every
file, so the recording still reads as one machine.

| Value | Placeholder |
| --- | --- |
| Hostname, with any domain after it | `host1` |
| Domain of the hostname, on its own | `domain1` |
| User name, the home directory, and a disk mounted under `/media/<user>` | `user1`, `/home/<user1>`, `/media/<user1>` |
| IPv4 address, private ranges included | `198.51.100.1`, then `203.0.113.x` and `192.0.2.x` |
| IPv6 address | `2001:db8::1` |
| Link-local IPv6 address, which holds the MAC | `fe80::ff:fe00:1`, or `fe80::200:0:0:1` |
| IPv6 address or other id written as 32 hex digits, as in `/proc/net/if_inet6` | `20010db8000000000000000000000001` |
| MAC address, also inside an interface name such as `enx…` | `02:00:00:00:00:01` |
| NIC GUID and switch id | `0200:0000:0000:0001` |
| GPU UUID | `GPU-00000000-0000-0000-0000-000000000001` |
| Other UUID | `00000000-0000-0000-0000-000000000001` |
| Serial number | `serial1` |
| Machine id | `00000000000000000000000000000001` |
| Docker container id, and any other id of 64 hex digits | `000000000001…` |
| Docker container name | `container1` |
| Docker network and virtual interface names | `br-000000000001`, `veth0000001` |
| FAT volume id | `0000-0001` |
| Private Hugging Face organization and model in a cache path or a `huggingface.co` address | `<org1>`, `<model1>` |
| Mount source that is not a disk, such as an LVM or ZFS name | `<source1>` |

The recording leaves out the processes that use no GPU, the rest of each command line, the mounts that are not
on a local disk, the mount options, the os-release lines other than `PRETTY_NAME`, the names in a directory
listing that the agent doesn't use, and the Docker details that the agent doesn't read.

### Read these places before you attach

The command replaces the values that it recognizes. A name that you or your company chose can still say
something about you or your work, and the command cannot tell it from any other word. These are the places in
the recording that can hold such a name, so read each one:

- The mount points, in `root/proc/self/mounts` and as the keys under `statvfs` in `host.json`, for example a USB
  disk mounted at `/media/<user1>/Family-Photos`.
- The name of each GPU process: the program name in `root/proc/<pid>/cmdline`, and the process name in
  parentheses after the process id in `root/proc/<pid>/stat`. A program can set its own name.
- The network interface names, in `root/proc/self/net/dev`, `root/proc/self/net/route`, `root/sys/class/net/`
  and the `net` directories under `root/sys/devices/`, and under `net_if_addrs` and `ethtool` in `host.json`. The
  RDMA device names in `root/sys/class/infiniband/` follow them. A VPN or bridge can carry a name that you gave
  it.
- The kernel release, in `root/proc/sys/kernel/osrelease`. A kernel that you built can carry your own suffix.
- The OS name, `PRETTY_NAME` in `root/usr/lib/os-release`. A company's own image can carry its name.
- The names that firmware sets: the sensor names and labels in the `name` and `temp*_label` files under
  `root/sys/devices/`, and the CPU description in `root/proc/cpuinfo`. A custom board can carry its maker's
  name.
- The CUDA directory names, under `root/usr/local/` and as the links in `root/etc/alternatives/`.

The command checks its own work, but you are the last check. If you see something you don't want to share,
don't attach the recording. Open an issue that names the file and the kind of value instead, without the
value.

## Attach the recording to an issue

1. Open a [new issue](https://github.com/sfxnz/sparkline/issues/new).
2. Name the machine in the title, for example "Recording: workstation with 4x RTX 6000 Ada".
3. Drag `recording.tgz` from the recording directory into the issue text. GitHub accepts `.tgz` files up
   to 25 MB.
4. Paste the lines that the command printed.

Attach the `recording.tgz` that the command made, not an archive you make yourself. `tar` writes your user
name into every entry of an archive. `recording.tgz` holds no user names and no file times.

## If the command stops

| Exit code | What happened | What to do |
| --- | --- | --- |
| 0 | The recording is ready. | Attach `recording.tgz`. |
| 1 | The recording is ready, but the agent reads it differently from your machine. | Attach `recording.tgz` and paste the lines it printed. |
| 2 | It met something that it cannot make safe, and wrote nothing. | Read the lines it printed. If they say that a name is also a word in what the agent reads, see the next section. Otherwise open an issue and paste the lines. They name the place and the kind of value, never the value. |
| 3 | The output directory already holds files, or the command got more than one argument. | Give it one new or empty directory. |
| 4 | It failed unexpectedly, and kept nothing. | Open an issue and paste the lines it printed. They hold no message text, only where it failed. |
| 130 | You stopped it with Ctrl-C. | Nothing to do. It keeps no partial recording. |

Exit code 2 has these causes:

- The agent read a file, an NVIDIA driver answer or a host reading that is not on the reviewed list.
- A file is not text, and no reviewed entry allows binary data there.
- A value looks like an identifier that the command cannot replace. An example is a bare 12-digit hex value
  that could be another machine's MAC address.
- Your hostname, its domain, your user name, a Docker container name or a serial number is also an ordinary word
  in what the agent reads.
- The agent could not read the recording back, which is a bug in Sparkline.

### If a name is also a word in what the agent reads

Your hostname may appear only in the hostname file, your user name only in a home directory, and a Docker
container name only in Docker's list of containers. If one of them appears anywhere else as a word, the command
cannot tell your name from an ordinary word, and replacing it would show your name by its place. A hostname
`GB10` would turn the GPU name into `NVIDIA host1`, a user name `max` would rename `cpuinfo_max_freq`, and a
container named `vllm` would turn the program name `vllm` into `container1`. So the command writes nothing.
Give that name another value for the run, and capture again:

- For the hostname, run `sudo hostname sparkline-capture` before the capture, and set your hostname back after.
- For a Docker container, run `docker rename <old name> <new name>`.
- For a user name, run the capture from another account.

The command no longer knows the old name. Before you attach, search the recording for it, for example with
`grep -ri <old name> <recording directory>`. It can still appear as the ordinary word, but also read the mount
points in `root/proc/self/mounts` and the `statvfs` keys in `host.json`. If you can't rename, or the line names
a serial number, open an issue and paste the lines that the command printed.
