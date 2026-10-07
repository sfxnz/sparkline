"""sparkline-agent CLI entry point."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import sys

import uvicorn

from ..common import logsafe
from ..common.netutil import resolve_bind
from .app import create_app
from .bench.runner import BenchRunner
from .config import load_config
from .info import Collectors
from .sampler import Sampler
from .store import Store

log = logging.getLogger("sparkline-agent")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="sparkline-agent", description="Sparkline node agent")
    p.add_argument(
        "--config", help="TOML config (default $SPARKLINE_CONFIG, else /etc/sparkline/agent.toml if present)"
    )
    p.add_argument("--bind", help='IP to listen on, or "auto" (default-route interface IP)')
    p.add_argument("--port", type=int)
    p.add_argument("--interval-ms", type=int, help="sample interval, 250..5000")
    p.add_argument("--data-dir")
    p.add_argument("--token", help="bearer token (prefer the config file: argv is visible to other users)")
    p.add_argument("--node-id")
    p.add_argument(
        "--allow-public", action="store_true", default=None, help="allow binding public addresses or 0.0.0.0"
    )
    p.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logsafe.install()  # no bearer token in the log, even at debug
    try:
        cfg = load_config(
            a.config,
            {
                "bind": a.bind,
                "port": a.port,
                "interval_ms": a.interval_ms,
                "data_dir": a.data_dir,
                "token": a.token,
                "node_id": a.node_id,
                "allow_public": a.allow_public,
            },
            env=os.environ,
        )
        host = resolve_bind(cfg.bind, cfg.allow_public)
    except (OSError, ValueError) as e:
        log.error("%s", e)
        return 2
    if not cfg.token:
        if not ipaddress.ip_address(host).is_loopback:
            log.error(
                "Refusing to start on %s without a token. Set `token` in the config or SPARKLINE_AGENT_TOKEN",
                host,
            )
            return 2
        log.warning("No token configured: API is unauthenticated (allowed only because bind is loopback)")

    collectors = Collectors(cfg)
    info = collectors.node_info(cfg)
    sampler = Sampler(
        cfg.node_id,
        collectors.ordered(),
        cfg.interval_ms,
        cfg.ring_seconds,
        Store(cfg.data_dir),
        cfg.retention_10s_days,
        cfg.retention_60s_days,
    )
    bench = BenchRunner(
        cfg.node_id,
        lambda: info,
        lambda: sampler.latest,
        sampler.publish,
        cfg.bench_image,
        cfg.bench_dir,
        payload_device=cfg.bench_payload_device,
    )
    app = create_app(sampler, lambda: info, cfg.token, bench=bench)
    log.info(
        "sparkline-agent %s node=%s listening on %s:%d, interval %d ms, data %s",
        info.agent_version,
        cfg.node_id,
        host,
        cfg.port,
        cfg.interval_ms,
        cfg.data_dir,
    )
    uvicorn.run(app, host=host, port=cfg.port, log_level=a.log_level, access_log=False, ws_ping_interval=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
