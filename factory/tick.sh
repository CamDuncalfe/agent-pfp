#!/bin/sh
# One factory run, for a scheduled job. It brings this checkout up to date
# with main first, so the runner is always the reviewed version.
# docs/factory.md has the setup.
set -eu
cd "$(dirname "$0")/.."
git pull --quiet --ff-only origin main
exec node factory/tick.js "$@"
