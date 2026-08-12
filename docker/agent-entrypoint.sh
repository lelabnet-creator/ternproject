#!/bin/sh
#
# Runs the instance's own agent — `Agent-local-tern`.
#
# A separate service from the API rather than a child of it: the whole reason to
# run the agent as its own process is that it keeps measuring and buffering while
# the API is restarting, which a child process cannot do. Docker's
# `restart: unless-stopped` is the supervisor.
#
# POSIX sh, like the other scripts in this repository.

set -eu

BIN_DIR=/app/clients/agent/bin
DATA_DIR="${TERN_DATA_DIR:-/var/lib/tern}"

# The image is built for one architecture but the binaries for five, and the
# name is the Rust target triple rather than what `uname` reports. Chosen here
# rather than written into the compose file, so an arm64 build needs no
# different command.
case "$(uname -m)" in
  x86_64|amd64)  TARGET=x86_64-unknown-linux-musl ;;
  aarch64|arm64) TARGET=aarch64-unknown-linux-musl ;;
  *)
    echo "✗ no TERN agent binary for $(uname -m)." >&2
    echo "  The instance still probes for itself through its in-process job." >&2
    exit 1
    ;;
esac

AGENT="$BIN_DIR/tern-agent-$TARGET"

if [ ! -x "$AGENT" ]; then
  # A source build that never ran CI has an empty bin/. Said plainly, because
  # the alternative — a container restarting forever on "not found" — tells
  # whoever reads the logs nothing about why.
  echo "✗ $AGENT is missing." >&2
  echo "  clients/agent/bin is populated by CI on main; a local build may have none." >&2
  exit 1
fi

# `--wait-for-config` is what makes this service safe to start on a brand new
# instance: the API writes agent.toml only once a page exists, which is minutes
# or days after this container first runs. Without it the agent would exit on a
# missing file and Docker would restart it in a loop until somebody finished the
# setup wizard.
exec "$AGENT" run \
  --config "$DATA_DIR/agent.toml" \
  --queue "$DATA_DIR/agent-queue.json" \
  --wait-for-config
