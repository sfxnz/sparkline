# Releasing Sparkline

## One version for the console, the agent and the web app

The console, the agent and the web app ship together under one version number. Sparkline follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.y.z:

- Raise the minor number (0.1.0 to 0.2.0) for a new feature or a breaking change.
- Raise the patch number (0.1.0 to 0.1.1) for a release that holds only fixes.

A breaking change is one that an operator has to act on. Examples are a config edit, a wire change that an
older console or agent cannot read, and a removed API route or command-line flag. From 1.0.0 on, a breaking
change raises the major number.

## Where the version lives

| File | Field |
| --- | --- |
| `server/pyproject.toml` | `version` under `[project]`, for the console and the agent |
| `web/package.json` | `version`, for the web app |
| `web/package-lock.json` | `version` and `packages[""].version`, which `npm version` keeps equal to `web/package.json` |

The agent reports its installed version as `agent_version` in its node info. The console reports its own
version as `version` in `GET /api/v1/cluster`. **Settings > About** shows both.
`server/tests/test_release_version.py` fails when these files disagree, or when `CHANGELOG.md` has no section
for the version.

Each pull request that changes what a user sees adds one line under `## [Unreleased]` in `CHANGELOG.md`.

## Cut a release

1. On a new branch, set `version = "X.Y.Z"` in `server/pyproject.toml`, where `X.Y.Z` is the new version.
   Then set the web app's version.

   ```sh
   (cd web && npm version X.Y.Z --no-git-tag-version)
   ```

2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` with today's date. Add an empty
   `## [Unreleased]` above it. At the bottom, point `[Unreleased]` at `vX.Y.Z...HEAD`, and add an `[X.Y.Z]`
   link to the release.
3. Run the checks in [DEV.md](../DEV.md#checks), open a pull request, and merge it.
4. Tag the merge commit on `main` and push the tag.

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Sparkline X.Y.Z"
   git push origin vX.Y.Z
   ```

   The tag starts `.github/workflows/image.yml`, which publishes the console image as
   `ghcr.io/<owner>/sparkline:X.Y.Z` and `:X.Y`.

5. Create the GitHub release from the changelog section.

   ```sh
   awk -v v=X.Y.Z '$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[|^\[[^]]*\]: / {f=0} f' CHANGELOG.md \
   	| gh release create vX.Y.Z --verify-tag --title "Sparkline X.Y.Z" --notes-file -
   ```

For 0.1.0, the version and its section already exist. Replace `unreleased` on the `## [0.1.0]` line with the
release date before you merge the release pull request, then do steps 4 and 5.

## Upgrade the console before the agents

Each release keeps the console able to read older agents. An older console can misread a newer agent, and
the **Upgrading** part of each `CHANGELOG.md` section says how. Upgrade the console first, then each agent.

On the console host, from a checkout of the new tag:

```sh
git fetch --tags && git checkout vX.Y.Z
(cd web && npm ci && npm run build)
sudo ./install.sh console
```

With Docker Compose, run `docker compose -f deploy/docker-compose.yml up -d --build` in place of
`install.sh console`.

Then, on each node, from a checkout of the same tag:

```sh
git fetch --tags && git checkout vX.Y.Z
sudo ./install.sh agent
```

`install.sh` replaces the code and the systemd units, and keeps the config and the data. If the node runs
benchmarks, add `--enable-benchmarks`, because without it the agent becomes monitor-only.
`deploy/install-cluster.sh` installs the agents before the console, so run `install.sh` on each host to
upgrade.
