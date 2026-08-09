#!/bin/sh
# TERN's updater.
#
# The one process in this stack that holds the Docker socket, and the reason it
# is a separate container: the socket is root on the host, and the server that
# answers HTTP must never be the thing that has it. So the API asks, in writing,
# and this decides.
#
# The channel is two files in the volume both already mount:
#
#   update.request   key=value, written by the API. What to update to.
#   update.status    JSON, written here. Where the update has got to.
#   updater.json     JSON, written here every tick. Proof this container exists,
#                    which is how the admin knows whether to offer the button.
#
# key=value going in and JSON coming out is not an inconsistency. A POSIX shell
# reads the first with `sed` and would need a JSON parser for anything else;
# the API reads the second and would need a key=value parser. Each side writes
# what the other can read without a dependency.
#
# It is also why the values coming in are checked against a pattern before they
# reach a command line. The API is trusted to decide *that* an update happens,
# which is not the same as trusting a file in a shared volume to be well formed.
set -eu

DATA_DIR="${TERN_DATA_DIR:-/var/lib/tern}"
DEPLOY_DIR="${TERN_DEPLOY_DIR:-/deploy}"
COMPOSE_FILE="${TERN_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.prod.yml}"
ENV_FILE="${TERN_ENV_FILE:-$DEPLOY_DIR/.env}"
REQUEST="$DATA_DIR/update.request"
STATUS="$DATA_DIR/update.status.json"
HEARTBEAT="$DATA_DIR/updater.json"
POLL_S="${TERN_UPDATER_POLL_S:-5}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Anything that reaches a JSON string, with the four characters that would end
# it early removed rather than escaped. These are error messages from docker and
# from this script; none of them needs a quote to be understood.
clean() { printf '%s' "$1" | tr -d '"\\\n\r' | cut -c1-400; }

field() { sed -n "s/^$1=//p" "$REQUEST" 2>/dev/null | head -n1; }

# state: running | succeeded | failed. step: pull | verify | restart.
write_status() {
  tmp="$STATUS.tmp"
  printf '{"id":"%s","target":"%s","image":"%s","state":"%s","step":"%s","percent":%s,"detail":"%s","startedAt":"%s","updatedAt":"%s"}\n' \
    "$(clean "$JOB_ID")" "$(clean "$JOB_TARGET")" "$(clean "$JOB_IMAGE")" \
    "$1" "$2" "$3" "$(clean "$4")" "$JOB_STARTED" "$(now)" > "$tmp"
  # Renamed into place rather than written in place: the API reads this file on
  # a timer, and a half-written one is a parse error on the screen someone is
  # watching precisely because they are anxious.
  mv "$tmp" "$STATUS"
}

fail() {
  write_status failed "$1" 0 "$2"
  echo "tern-updater: $1 failed: $2" >&2
}

# ── One update ──────────────────────────────────────────────────────────────

run_update() {
  ref="$JOB_IMAGE:$JOB_TARGET"
  # In the volume rather than in /tmp: the status file carries the last three
  # lines of a failure, and the whole log is what an operator actually needs
  # when those three are "unexpected EOF". Kept where they can read it without
  # a shell in this container.
  log="$DATA_DIR/update.pull.log"
  : > "$log"

  # ── Pull ──────────────────────────────────────────────────────────────────
  write_status running pull 0 "Contacting the registry"

  docker pull "$ref" > "$log" 2>&1 &
  pull_pid=$!

  # Progress by counting layers rather than by parsing byte counters. Docker
  # announces each layer before it starts and again when it lands, and with no
  # TTY every state change is its own line — so two greps give a figure that
  # only ever moves forwards. It jumps early, while layers are still being
  # announced, and that is honest: at that point nobody knows how many there
  # are, including docker.
  while kill -0 "$pull_pid" 2>/dev/null; do
    announced=$(grep -c -e 'Pulling fs layer' -e 'Already exists' "$log" || true)
    landed=$(grep -c -e 'Pull complete' -e 'Already exists' "$log" || true)
    if [ "$announced" -gt 0 ]; then
      percent=$((landed * 100 / announced))
      [ "$percent" -gt 99 ] && percent=99
      write_status running pull "$percent" "$landed of $announced layers"
    fi
    sleep 2
  done

  if ! wait "$pull_pid"; then
    fail pull "$(tail -n 3 "$log" | tr '\n' ' ')"
    return 1
  fi

  # ── Verify ────────────────────────────────────────────────────────────────
  # What arrived is what was asked for. A registry tag is mutable, and an image
  # whose own label disagrees with the tag that fetched it is the one case where
  # carrying on would install something nobody chose.
  write_status running verify 0 "Reading the image's labels"

  labelled=$(docker image inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ref" 2>/dev/null || true)
  stripped=${labelled#v}

  if [ -z "$labelled" ]; then
    fail verify "$ref carries no version label — it was not built by TERN's CI"
    return 1
  fi
  if [ "$stripped" != "$JOB_TARGET" ]; then
    fail verify "$ref says it is $labelled, not $JOB_TARGET"
    return 1
  fi

  # ── Restart ───────────────────────────────────────────────────────────────
  # The tag is written into .env before anything is recreated. Without that the
  # instance runs the new image until the next `docker compose up -d` typed by
  # hand, which reads .env, finds the old tag and quietly rolls the upgrade
  # back — the worst kind of failure, because it happens weeks later.
  write_status running restart 0 "Recording $ref in .env"

  if [ ! -w "$ENV_FILE" ]; then
    fail restart "$ENV_FILE is not writable — mount the deployment directory read-write"
    return 1
  fi

  tmp="$ENV_FILE.tern-tmp"
  if grep -q '^TERN_IMAGE=' "$ENV_FILE"; then
    sed "s|^TERN_IMAGE=.*|TERN_IMAGE=$ref|" "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    echo "TERN_IMAGE=$ref" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"

  write_status running restart 50 "Recreating the instance"

  # Only app and agent. Recreating this container mid-update would leave the
  # status file frozen at whatever it last said, and the database has no reason
  # to be restarted by an application upgrade.
  if ! out=$(docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" \
    up -d app agent 2>&1); then
    fail restart "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi

  write_status succeeded restart 100 "Now running $JOB_TARGET"
  echo "tern-updater: updated to $ref"
}

# ── The loop ────────────────────────────────────────────────────────────────

echo "tern-updater: watching $REQUEST"

# A status left `running` by a container that died mid-update. Nothing is going
# to finish it, and leaving it there shows a progress bar that never moves.
if [ -f "$STATUS" ] && grep -q '"state":"running"' "$STATUS"; then
  JOB_ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$STATUS")
  JOB_TARGET=$(sed -n 's/.*"target":"\([^"]*\)".*/\1/p' "$STATUS")
  JOB_IMAGE=$(sed -n 's/.*"image":"\([^"]*\)".*/\1/p' "$STATUS")
  JOB_STARTED=$(now)
  fail restart "The updater restarted while this was running; nothing further happened"
fi

while true; do
  printf '{"seenAt":"%s","protocol":1}\n' "$(now)" > "$HEARTBEAT.tmp"
  mv "$HEARTBEAT.tmp" "$HEARTBEAT"

  if [ -f "$REQUEST" ]; then
    JOB_ID=$(field id)
    JOB_TARGET=$(field target)
    JOB_IMAGE=$(field image)
    JOB_STARTED=$(now)

    seen=""
    [ -f "$STATUS" ] && seen=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$STATUS")

    if [ -n "$JOB_ID" ] && [ "$JOB_ID" != "$seen" ]; then
      # Checked before either value is allowed near a command line. A tag is
      # three numbers; an image is the small alphabet a registry reference is
      # made of. Anything else is not a request this will act on.
      if ! echo "$JOB_ID" | grep -qE '^[A-Za-z0-9_-]{8,64}$'; then
        echo "tern-updater: ignoring a request with an unusable id" >&2
      elif ! echo "$JOB_TARGET" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        fail pull "\"$JOB_TARGET\" is not a release version"
      elif ! echo "$JOB_IMAGE" | grep -qE '^[a-z0-9][a-z0-9._/-]*(:[0-9]+)?(/[a-z0-9._/-]+)*$'; then
        fail pull "\"$JOB_IMAGE\" is not a usable image name"
      else
        echo "tern-updater: request $JOB_ID — $JOB_IMAGE:$JOB_TARGET"
        run_update || true
      fi
    fi
  fi

  sleep "$POLL_S"
done
