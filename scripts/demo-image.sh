#!/usr/bin/env bash
#
# Rebuild the demonstration image — the one with its database inside it.
#
#   scripts/demo-image.sh                    build it
#   scripts/demo-image.sh --run              build it, then serve it on :8088
#   scripts/demo-image.sh --days 30          a smaller history, for a small host
#   scripts/demo-image.sh --push             build it and push it to the registry
#   scripts/demo-image.sh --app-image X      demo a specific application image
#
# Why this is a script and not a CI job
# -------------------------------------
# The demo has to be regenerated for reasons that have nothing to do with a
# commit: the ninety days it shows are ninety days *before the build*, so an
# image left alone for a season starts presenting a page whose most recent
# incident is from last spring. That is a decision somebody makes by looking at
# it, not something a push should trigger. So: on demand, one command, and the
# same command whether it runs here or in a pipeline.
#
# It builds *on top of* the published application image rather than rebuilding
# the sources. What a demo is for is showing the artefact people install.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

APP_IMAGE="${TERN_IMAGE:-ghcr.io/lelabnet-creator/ternproject:latest}"
DEMO_IMAGE="${TERN_DEMO_IMAGE:-ghcr.io/lelabnet-creator/ternproject-demo:latest}"
SEED_DAYS="${TERN_SEED_DAYS:-90}"
PORT="${TERN_DEMO_PORT:-8088}"
do_run=0
do_push=0
do_pull=1

while [ $# -gt 0 ]; do
  case "$1" in
    --run) do_run=1 ;;
    --push) do_push=1 ;;
    --no-pull) do_pull=0 ;;
    --days) SEED_DAYS="${2:?--days needs a number}"; shift ;;
    --app-image) APP_IMAGE="${2:?--app-image needs a reference}"; shift ;;
    --tag) DEMO_IMAGE="${2:?--tag needs a reference}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }

# The revision is stamped into the image so a demo that is behaving oddly can be
# traced back to the sources that produced it. Unknown rather than wrong when
# this is not a checkout.
revision="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
version="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"

if [ "$do_pull" = 1 ]; then
  say "fetching the application image ($APP_IMAGE)"
  # Not fatal: a local build tagged by hand is a perfectly good thing to demo,
  # and refusing to proceed because a registry is unreachable would make this
  # script useless in exactly the situation where it is most wanted.
  docker pull "$APP_IMAGE" || echo "    could not pull — using whatever is local"
fi

say "building $DEMO_IMAGE"
echo "    application : $APP_IMAGE"
echo "    history     : $SEED_DAYS days"
echo "    revision    : $revision"
echo
echo "    This runs the migrations and the seed inside the build, so it takes"
echo "    a few minutes. What it produces needs no database beside it."

docker build \
  -f docker/demo/Dockerfile \
  --build-arg "TERN_IMAGE=$APP_IMAGE" \
  --build-arg "TERN_SEED_DAYS=$SEED_DAYS" \
  --build-arg "TERN_VERSION=$version" \
  --build-arg "TERN_REVISION=$revision" \
  -t "$DEMO_IMAGE" \
  .

size="$(docker image inspect "$DEMO_IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}')"
say "built $DEMO_IMAGE ($size)"

if [ "$do_push" = 1 ]; then
  say "pushing $DEMO_IMAGE"
  docker push "$DEMO_IMAGE"
fi

if [ "$do_run" = 1 ]; then
  say "starting it on http://127.0.0.1:$PORT"
  docker rm -f tern-demo-local >/dev/null 2>&1 || true
  # The same locks the deployment uses, so what is tried here is what ships:
  # a read-only filesystem, the cluster on a tmpfs, no capabilities.
  docker run -d --name tern-demo-local \
    --read-only \
    --tmpfs /home/postgres/pgdata:size=2g,mode=0700,uid=1000,gid=1000 \
    --tmpfs /run:size=64m,mode=0755,uid=1000,gid=1000 \
    --tmpfs /tmp:size=64m,mode=1777 \
    --tmpfs /var/lib/tern:size=32m,mode=0700,uid=1000,gid=1000 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -e "PUBLIC_BASE_URL=http://127.0.0.1:$PORT" \
    -p "127.0.0.1:$PORT:3011" \
    "$DEMO_IMAGE" >/dev/null

  printf '    waiting for it to answer'
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
      printf '\n'
      say "the demo is up: http://127.0.0.1:$PORT"
      echo "    logs : docker logs -f tern-demo-local"
      echo "    reset: docker restart tern-demo-local"
      echo "    stop : docker rm -f tern-demo-local"
      exit 0
    fi
    printf '.'
    sleep 2
  done
  printf '\n'
  echo "✗ it did not answer in three minutes. Its log:" >&2
  docker logs --tail 40 tern-demo-local >&2
  exit 1
fi

cat <<EOF

  Run it locally      : $0 --run
  Deploy it           : docker compose -f docker/demo/compose.demo.yml up -d
  Reset a running one : docker restart tern-demo

EOF
