# syntax=docker/dockerfile:1
# Sparkline console (aggregator, API and web app) as a container. Agents are not containerised: they need
# the host's GPU, /proc, sysfs and RDMA counters, so they run under systemd (deploy/install.sh agent).
#
# Build from the repo root:   docker build -f deploy/Dockerfile -t sparkline .
# Or use deploy/docker-compose.yml. Multi-arch: both base images ship linux/arm64 and linux/amd64.
# Base images are pinned by digest (the multi-arch index); Python dependencies come from the hash-checked
# server/requirements.lock. To update an image: docker buildx imagetools inspect <tag>, copy the Digest.

# --- 1. web app ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- 2. Python package --------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
COPY server/pyproject.toml server/requirements.lock /src/server/
COPY server/sparkline /src/server/sparkline
RUN python -m venv /opt/sparkline/venv \
 && /opt/sparkline/venv/bin/pip install --require-hashes -r /src/server/requirements.lock \
 && /opt/sparkline/venv/bin/pip install --no-deps --no-build-isolation /src/server \
 && /opt/sparkline/venv/bin/python -m compileall -q /opt/sparkline/venv/lib

# --- 3. runtime ---------------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
LABEL org.opencontainers.image.title="Sparkline console" \
      org.opencontainers.image.description="Live telemetry and benchmarking for NVIDIA DGX Spark clusters"
ENV PATH=/opt/sparkline/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SPARKLINE_CONTAINER=1
# Fixed uid/gid, so a host-mounted config can be made readable with `chgrp 10001`.
RUN groupadd --system --gid 10001 sparkline \
 && useradd --system --uid 10001 --gid sparkline --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin sparkline \
 && install -d -m 0750 -o sparkline -g sparkline /var/lib/sparkline \
 && install -d -m 0755 /etc/sparkline
COPY --from=build /opt/sparkline/venv /opt/sparkline/venv
COPY --from=web /src/web/dist /opt/sparkline/web/dist
USER sparkline:sparkline
# Data lives in /var/lib/sparkline: mount a volume there to keep it (docker-compose.yml does).
EXPOSE 9700
# The config is mounted at /etc/sparkline/console.toml (or named by SPARKLINE_CONFIG). Tokens can come from
# SPARKLINE_TOKEN / SPARKLINE_AGENT_TOKEN instead of the file. `docker run IMAGE --demo` needs no config.
ENTRYPOINT ["sparkline", "--web-dist", "/opt/sparkline/web/dist", "--data-dir", "/var/lib/sparkline"]
