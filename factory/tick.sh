#!/bin/sh
# One factory run, for a scheduled job. It brings this checkout up to date
# with main first, so the runner is always the reviewed version. A dry run
# leaves the checkout as it is. docs/factory.md has the setup.
set -eu
cd "$(dirname "$0")/.."
case " $* " in
  *" --dry-run "*) ;;
  *) git pull --quiet --ff-only origin main ;;
esac
exec node factory/tick.js "$@"
