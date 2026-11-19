#!/bin/sh
# One factory run, for a scheduled job. tick.js takes the lock, pulls main
# while it holds it and then starts again from the pulled code, so the runner
# is always the reviewed version. A dry run takes no lock and doesn't pull.
# docs/factory.md has the setup.
set -eu
cd "$(dirname "$0")/.."
exec node factory/tick.js "$@"
