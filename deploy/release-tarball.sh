#!/usr/bin/env bash
# Build the release assets that `sparkline update` downloads: sparkline-X.Y.Z.tar.gz (the source at REF under
# sparkline-X.Y.Z/, plus the built web/dist) and SHA256SUMS. .github/workflows/image.yml runs it for a vX.Y.Z
# tag. Build web/dist from the same REF first. The same REF and web/dist give the same bytes.
#
#   deploy/release-tarball.sh X.Y.Z OUTDIR [REF]    # REF defaults to vX.Y.Z
set -euo pipefail
usage="usage: deploy/release-tarball.sh X.Y.Z OUTDIR [REF]"
version=${1:?$usage}
out=${2:?$usage}
ref=${3:-v$version}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release-tarball.sh: version must be X.Y.Z" >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
[[ -f $repo/web/dist/index.html ]] || { echo "release-tarball.sh: build web/dist first (cd web && npm ci && npm run build)" >&2; exit 1; }

name=sparkline-$version
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git -C "$repo" archive --prefix="$name/" "$ref" | tar -C "$stage" -xf -
cp -R "$repo/web/dist" "$stage/$name/web/dist"
mtime=$(git -C "$repo" log -1 --format=%ct "$ref")
mkdir -p "$out"
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" -cf - "$name" |
	gzip -n -9 >"$out/$name.tar.gz"
(cd "$out" && sha256sum "$name.tar.gz" >SHA256SUMS)
cat "$out/SHA256SUMS"
