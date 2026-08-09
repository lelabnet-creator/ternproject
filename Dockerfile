# TERN — one image serving the API and the built web app.
#
# One image and not two, because the SPA talks to the API on its own origin:
# `apps/web/vite.config.ts` only ever uses VITE_API_URL as a dev-proxy target
# and never bakes a host into the bundle. Splitting them would put the session
# cookie across an origin boundary, which is the problem the dev proxy exists
# to avoid.
#
# Debian slim rather than Alpine: `@node-rs/argon2` ships prebuilt glibc
# binaries, and on musl it falls back to building from source — a toolchain in
# the runtime image for no gain.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests before sources: this layer is what makes an edit to a `.ts` file
# reuse the install rather than repeat it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Materialise the pnpm version pinned in `packageManager`. Without this,
# corepack fetches it from the registry the first time it is used.
RUN corepack prepare --activate
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY packages/db/package.json   packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .

# Declared in this stage too, not only in the runtime one: the version printed
# in the admin is baked into the bundle by Vite, so it has to be known *here*.
# Without these the published image would show "dev".
ARG TERN_VERSION=""
ARG TERN_REVISION=""
ENV TERN_VERSION=$TERN_VERSION
ENV TERN_REVISION=$TERN_REVISION

# Only the web app has a build. The API is TypeScript run through tsx, which is
# the project's existing choice — `apps/api` declares no build script.
RUN pnpm -F @tern/web build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# Passed by CI so a pulled image can be traced back to a commit. They default to
# empty rather than to a lie: an image labelled `latest` that is actually three
# months old is worse than one that admits it does not know.
ARG TERN_VERSION=""
ARG TERN_REVISION=""

LABEL org.opencontainers.image.title="TERN" \
      org.opencontainers.image.description="IT service status pages, live or historized." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/lelabnet-creator/ternproject" \
      org.opencontainers.image.version="${TERN_VERSION}" \
      org.opencontainers.image.revision="${TERN_REVISION}"

# The version the server reads, and not only the one on the label.
#
# These two lines were missing, and their absence disabled the whole update
# notice on every real deployment. The build stage above turns the same ARGs
# into ENV because vite bakes them into the bundle — which is why the footer
# showed a version and looked right — but a build argument does not survive into
# the runtime stage's environment on its own. Without them `config.TERN_VERSION`
# is empty, `parseVersion` returns null, and the check answers "this build does
# not say which version it is" without ever reading the registry.
#
# The label carries the same value for anyone inspecting the image; this is for
# the process inside it.
ENV TERN_VERSION=$TERN_VERSION
ENV TERN_REVISION=$TERN_REVISION

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# `docker compose down` sends SIGTERM to PID 1. Without an init, a shell script
# as PID 1 does not forward it, and the API never gets to drain its requests or
# return its database connections — it just dies at the 10 s timeout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY packages/db/package.json   packages/db/
COPY packages/shared/package.json packages/shared/

# Same reason as in the build stage — and here it also means the container needs
# nothing from the npm registry at boot, only a database.
RUN corepack prepare --activate

# --prod drops vite, eslint, drizzle-kit and the rest of the build-time tree.
# It only works because `dotenv` and `tsx` are declared as real dependencies:
# `apps/api/src/config.ts` imports dotenv at module scope, and tsx is the thing
# that runs the server at all.
# No BuildKit cache mount here or above: cache mounts would make the build
# faster but would also make it fail outright on a daemon using the classic
# builder, which is not a trade an install script should impose.
RUN pnpm install --frozen-lockfile --prod

# The API and the two workspace packages ship as TypeScript source, since tsx
# is what executes them.
COPY apps/api/src        apps/api/src
COPY apps/api/tsconfig.json apps/api/
COPY packages/db/src     packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/db/sql     packages/db/sql
COPY packages/shared/src packages/shared/src
COPY tsconfig.base.json  ./

COPY --from=build /app/apps/web/dist apps/web/dist

# The Linux agent and proxy binaries — see `.dockerignore`, which is what
# selects them and explains why the other targets stay out.
#
# Two things need them and neither worked without this. The `agent` service in
# docker-compose.prod.yml executes one, and `routes/download.ts` resolves
# exactly this path to serve `/install.sh` — so on a published image that
# endpoint answered with the SPA's catch-all HTML, which is a web page piped
# into a shell.
#
# CI populates `clients/agent/bin` on every push to main (the `collect` job).
# The trailing slash and the directory form keep this working when a checkout
# that has never run CI has nothing to copy.
COPY clients/agent/bin/ clients/agent/bin/

COPY docker/entrypoint.sh /usr/local/bin/tern-entrypoint
COPY docker/agent-entrypoint.sh /usr/local/bin/tern-agent-entrypoint
RUN chmod +x /usr/local/bin/tern-entrypoint /usr/local/bin/tern-agent-entrypoint

# Somewhere durable for the generated APP_SECRET, so a restart does not make
# every encrypted value unreadable. Owned by node: the process does not run as
# root.
RUN mkdir -p /var/lib/tern && chown -R node:node /var/lib/tern /app
USER node

EXPOSE 3011
VOLUME ["/var/lib/tern"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tern-entrypoint"]
# Relative to /app/apps/api, which the entrypoint changes into — see the note
# there about why this is not `pnpm start`.
CMD ["node", "--import", "tsx", "src/server.ts"]
