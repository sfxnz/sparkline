#!/usr/bin/env bash
# Print the notes of the GitHub release for version X.Y.Z, which are its CHANGELOG.md section without the
# heading. .github/workflows/image.yml runs it when a vX.Y.Z tag is pushed.
#
#   deploy/release-notes.sh X.Y.Z [CHANGELOG.md]
set -euo pipefail
version=${1:?usage: deploy/release-notes.sh X.Y.Z [CHANGELOG.md]}
changelog=${2:-$(dirname "$0")/../CHANGELOG.md}

awk -v v="$version" '
  index($0, "## [" v "]") == 1 { found = 1; heading = $0; on = 1; next }
  on && (/^## \[/ || /^\[[^]]*\]: /) { on = 0 }
  on { notes = notes $0 "\n" }
  END {
    if (!found) { print "CHANGELOG.md has no \"## [" v "]\" section" > "/dev/stderr"; exit 1 }
    if (heading ~ /unreleased$/) { print "CHANGELOG.md still dates " v " as unreleased: date its heading first (docs/RELEASING.md)" > "/dev/stderr"; exit 1 }
    sub(/^\n+/, "", notes); sub(/\n+$/, "\n", notes)
    if (notes !~ /[^[:space:]]/) { print "CHANGELOG.md has no notes under \"## [" v "]\"" > "/dev/stderr"; exit 1 }
    printf "%s", notes
  }' "$changelog"
