"""sparkline entry point."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import uvicorn

from .app import create_app, validate_settings
from .config import default_data_dir, load_config


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="sparkline", description="Sparkline aggregator and web API")
    p.add_argument("--config", type=Path, help="TOML config (default /etc/sparkline/console.toml)")
    p.add_argument("--bind", help='address to bind ("auto" = LAN IP of the default route)')
    p.add_argument("--port", type=int)
    p.add_argument("--demo", action="store_true", help="simulate three nodes, including failures")
    p.add_argument("--demo-speed", type=float, default=1.0, help="compress the demo failure schedule")
    p.add_argument(
        "--allow-public", action="store_true", help="allow binding a public / all-interfaces address"
    )
    p.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    p.add_argument("--web-dist", type=Path, help="built web app directory (default <repo>/web/dist)")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    def fail(msg: str) -> None:
        print(f"sparkline: {msg}", file=sys.stderr)
        sys.exit(2)

    try:
        cfg = load_config(args.config)
    except (OSError, ValueError) as e:  # missing file, TOML or validation error
        fail(f"cannot load config: {e}")
    if args.bind:
        cfg.bind = args.bind
    if args.port:
        cfg.port = args.port
    if args.web_dist:
        cfg.web_dist = args.web_dist
    if not args.demo:
        if not cfg.token or not cfg.agent_token:
            fail("token and agent_token must be set in the config (or run with --demo)")
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
    app = create_app(cfg, data_dir, demo=args.demo, demo_speed=args.demo_speed)
    uvicorn.run(app, host=host, port=cfg.port, log_level=args.log_level, proxy_headers=False)


if __name__ == "__main__":
    main()
