# Record your machine for Sparkline

Sparkline is tested against recordings of real machines. The maintainer has a DGX Spark and nothing else, so
support for discrete NVIDIA cards, AMD GPUs and other boards depends on recordings from the people who own
them. `sparkline-capture` records what the Sparkline agent reads on your machine into a directory and an
archive that you can attach to a public GitHub issue. It records Linux machines today.

The command only reads. It needs no root, puts no load on the GPU, sends nothing anywhere, and writes only
inside the directory it creates. Before it writes anything, it replaces the values that identify you or your
network with placeholders. If it finds one that it cannot replace, it writes nothing.

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

At the end, the command prints how many values of each kind it replaced and what it left out. It never
prints a value.

## Look through the recording

The directory holds plain text and JSON, so you can read every file before you share it:

- `root/` holds the `/proc` and `/sys` files that the agent read, at their paths on your machine.
- `nvml.json` holds the answers of the NVIDIA driver library.
- `host.json` holds the network addresses, disk space, NIC counters, Docker image tags and the tools found.
- `platform.json` says how the recording was made and lists what was replaced and left out.

The recording keeps what Sparkline needs to read your hardware: the CPU, GPU and disk model names, the kernel
version and OS name, the network interface names, and the memory, load, temperature, clock, power and
counter readings. For a process that uses a GPU, it keeps the program name.

The recording replaces each of these values with a placeholder. One value gets the same placeholder in every
file, so the recording still reads as one machine.

| Value | Placeholder |
| --- | --- |
| Hostname | `host1` |
| User name, and the home directory | `user1`, `/home/<user1>` |
| IPv4 address, private ranges included | `198.51.100.1`, then `203.0.113.x` and `192.0.2.x` |
| IPv6 address | `2001:db8::1` |
| Link-local IPv6 address, which holds the MAC | `fe80::ff:fe00:1`, or `fe80::200:0:0:1` |
| MAC address, also inside an interface name such as `enx…` | `02:00:00:00:00:01` |
| NIC GUID and switch id | `0200:0000:0000:0001` |
| GPU UUID | `GPU-00000000-0000-0000-0000-000000000001` |
| Other UUID | `00000000-0000-0000-0000-000000000001` |
| Serial number | `serial1` |
| Machine id | `00000000000000000000000000000001` |
| Docker container id and name | `000000000001…`, `container1` |
| Private Hugging Face organization in a cache path | `<org1>` |

The recording leaves out the processes that use no GPU, every command-line argument, the mounts that are not
on a local disk, and the Docker details that the agent doesn't read.

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
| 2 | It found a value that it cannot replace, and wrote nothing. | Open an issue and paste the lines it printed. They name the file and the kind of value, not the value. |
| 3 | The output directory already holds files. | Give it another directory. |
| 4 | It failed unexpectedly. | Open an issue and paste the lines it printed. They hold no message text, only where it failed. |
