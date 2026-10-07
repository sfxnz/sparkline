"""sparkline entry point."""

from __future__ import annotations

import argparse
import fcntl
import logging
import os
import sys
from pathlib import Path

import uvicorn

from ..common import logsafe
from .app import create_app, validate_settings
from .config import ConsoleConfig, default_data_dir, load_config


def lock_data_dir(data_dir: Path) -> int:
    """Take an exclusive lock on the data directory, so two consoles never share one console.sqlite
    (their alert engines would write duplicate events). Returns the open lock fd; raises OSError if
    another process holds it."""
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(data_dir / "console.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise OSError(
            f"{data_dir} is already in use by another sparkline console. Stop it, or give this one its own "
            "data_dir in the config."
        ) from None
    return fd


def proxy_options(cfg: ConsoleConfig) -> dict:
    """Forwarded headers are honoured only from the configured reverse proxies (never by default)."""
    if not cfg.trusted_proxies:
        return {"proxy_headers": False}
    return {"proxy_headers": True, "forwarded_allow_ips": ",".join(cfg.trusted_proxies)}


def container_hint(port: int, env: os._Environ[str] | dict[str, str]) -> str | None:
    """In the Docker image, uvicorn prints the container's own address (e.g. 172.17.0.2), which the host
    cannot open: say which address to use instead."""
    if not env.get("SPARKLINE_CONTAINER"):
        return None
    return (
        "Running in a container: the address below is the container's own. Open the host port you "
        f"published, e.g. http://127.0.0.1:9701 for `docker run -p 127.0.0.1:9701:{port} ...`"
    )


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="sparkline", description="Sparkline aggregator and web API")
    p.add_argument(
        "--config", type=Path, help="TOML config (default $SPARKLINE_CONFIG or /etc/sparkline/console.toml)"
    )
    p.add_argument("--bind", help='address to bind ("auto" = LAN IP of the default route)')
    p.add_argument("--port", type=int)
    p.add_argument("--data-dir", type=Path, help="events, settings and benchmark results (console.sqlite)")
    p.add_argument("--demo", action="store_true", help="simulate three nodes, including failures")
    p.add_argument("--demo-speed", type=float, default=1.0, help="compress the demo failure schedule")
    p.add_argument(
        "--demo-empty-bench",
        action="store_true",
        help="demo without seeded benchmark history (shows the empty state)",
    )
    p.add_argument(
        "--allow-public", action="store_true", help="allow binding a public / all-interfaces address"
    )
    p.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    p.add_argument("--web-dist", type=Path, help="built web app directory (default <repo>/web/dist)")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logsafe.install()  # no token or session cookie in the log, even at debug

    def fail(msg: str) -> None:
        print(f"sparkline: {msg}", file=sys.stderr)
        sys.exit(2)

    try:
        cfg = load_config(args.config, os.environ)
    except (OSError, ValueError) as e:  # missing file, TOML or validation error
        fail(f"cannot load config: {e}")
    if args.bind:
        cfg.bind = args.bind
    if args.port:
        cfg.port = args.port
    if args.data_dir:
        cfg.data_dir = args.data_dir
    if args.web_dist:
        cfg.web_dist = args.web_dist
    if not args.demo:
        if not cfg.token or not cfg.agent_token:
            fail(
                "token and agent_token must be set in the config or in SPARKLINE_TOKEN and "
                "SPARKLINE_AGENT_TOKEN (or run with --demo)"
            )
        if len(cfg.token) < 16 or len(cfg.agent_token) < 16:
            fail("token and agent_token must be at least 16 characters (install.sh generates them)")
        if not cfg.nodes:
            fail("no [[nodes]] configured (or run with --demo)")
    if args.demo_speed <= 0:
        fail("--demo-speed must be > 0")
    try:
        validate_settings(cfg.settings)
    except ValueError as e:
        fail(f"invalid [settings]: {e}")

    from ..common.netutil import resolve_bind

    try:
        host = resolve_bind(cfg.bind, args.allow_public)
    except ValueError as e:
        fail(str(e))
    data_dir = cfg.data_dir or default_data_dir()
    if args.demo:  # simulated events and settings must never land in the real console.sqlite
        data_dir = data_dir / "demo"
    try:
        lock = lock_data_dir(data_dir)  # held (open) for the life of the process
    except OSError as e:
        fail(str(e))
    app = create_app(
        cfg, data_dir, demo=args.demo, demo_speed=args.demo_speed, demo_empty_bench=args.demo_empty_bench
    )
    app.state.data_dir_lock = lock
    hint = container_hint(cfg.port, os.environ)
    if hint:
        logging.getLogger("sparkline").info("%s", hint)
    uvicorn.run(app, host=host, port=cfg.port, log_level=args.log_level, **proxy_options(cfg))


if __name__ == "__main__":
    main()
