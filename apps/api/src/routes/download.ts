import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { config } from '../config.js'

/**
 * Shipping the agent with the server that needs it.
 *
 * The pairing panel used to hand out `tern-agent pair …`, which assumes a
 * binary the operator has never been told where to find. An instance already
 * knows which version it expects and can serve it, so it does — and the panel
 * can offer a line that installs and pairs in one go.
 *
 * The binaries come from `clients/agent/bin`, which CI populates on every push
 * to main. When they are absent — a source checkout that has never run CI — the
 * endpoints say so plainly rather than serving a 404 nobody can interpret.
 */

/** Only these names are servable. The path never comes from the request. */
const BINARIES = [
  'tern-agent-x86_64-unknown-linux-musl',
  'tern-agent-aarch64-unknown-linux-musl',
  'tern-agent-aarch64-apple-darwin',
  'tern-agent-x86_64-apple-darwin',
  'tern-agent-x86_64-pc-windows-msvc.exe',
  'tern-proxy-x86_64-unknown-linux-musl',
  'tern-proxy-aarch64-unknown-linux-musl',
  'tern-proxy-aarch64-apple-darwin',
  'tern-proxy-x86_64-apple-darwin',
  'tern-proxy-x86_64-pc-windows-msvc.exe',
  'SHA256SUMS',
] as const

function binDirectory(): string {
  // Resolved from the repository root rather than from `import.meta.url`, so it
  // is the same path whether the API runs from source or from a build.
  return join(process.cwd(), '..', '..', 'clients', 'agent', 'bin')
}

function available(): string[] {
  const dir = binDirectory()
  return BINARIES.filter((name) => existsSync(join(dir, name)))
}

const routes: FastifyPluginAsyncZod = async (app) => {
  /** What this instance can serve, so a client need not guess. */
  app.get(
    '/api/v1/agent/releases',
    {
      schema: {
        response: {
          200: z.object({
            available: z.array(z.string()),
            installUrl: z.string(),
            installPsUrl: z.string(),
          }),
        },
      },
    },
    async () => ({
      available: available(),
      installUrl: `${base()}/install.sh`,
      installPsUrl: `${base()}/install.ps1`,
    }),
  )

  app.get(
    '/api/v1/agent/bin/:file',
    {
      schema: { params: z.object({ file: z.string() }) },
    },
    async (req, reply) => {
      const name = BINARIES.find((candidate) => candidate === req.params.file)
      if (!name) throw app.httpErrors.notFound('Unknown binary')

      const path = join(binDirectory(), name)
      if (!existsSync(path)) {
        throw app.httpErrors.notFound(
          'This instance has no prebuilt binaries. Build the agent from clients/agent, or take one from the project’s releases.',
        )
      }

      return (
        reply
          .header('content-type', 'application/octet-stream')
          .header('content-disposition', `attachment; filename="${name}"`)
          .header('content-length', String(statSync(path).size))
          // Immutable: the file for a given name never changes within a release.
          .header('cache-control', 'public, max-age=3600')
          .send(createReadStream(path))
      )
    },
  )

  app.get('/install.sh', async (_req, reply) => {
    return reply.header('content-type', 'text/x-shellscript; charset=utf-8').send(shellScript())
  })

  app.get('/install.ps1', async (_req, reply) => {
    return reply.header('content-type', 'text/plain; charset=utf-8').send(powershellScript())
  })
}

function base(): string {
  return config.PUBLIC_BASE_URL.replace(/\/$/, '')
}

/**
 * The installer, generated with this instance's address baked in.
 *
 * Deliberately readable: it is piped into a shell, which is a thing to be
 * suspicious of, so anyone who opens the URL first should be able to see
 * exactly what it does in one screen. No compression, no eval, no base64.
 */
function shellScript(): string {
  return `#!/bin/sh
# TERN agent installer — ${base()}
#
# Reading this before running it is the correct instinct. It does three things:
# picks the binary for this machine, downloads it from the TERN instance above,
# and — if you passed --pin — pairs with it.
set -eu

SERVER="${base()}"
PIN=""
DEST="\${TERN_INSTALL_DIR:-}"
BIN="tern-agent"

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="\${2:-}"; shift 2 ;;
    --dir) DEST="\${2:-}"; shift 2 ;;
    --proxy) BIN="tern-proxy"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

os=$(uname -s)
arch=$(uname -m)

case "$os-$arch" in
  Linux-x86_64|Linux-amd64)   target="x86_64-unknown-linux-musl" ;;
  Linux-aarch64|Linux-arm64)  target="aarch64-unknown-linux-musl" ;;
  Darwin-arm64)               target="aarch64-apple-darwin" ;;
  Darwin-x86_64)              target="x86_64-apple-darwin" ;;
  *)
    echo "No prebuilt binary for $os $arch." >&2
    echo "Build it: git clone the project, then cargo build --release in clients/agent." >&2
    exit 1 ;;
esac

# Somewhere on PATH that does not need root when it does not have to. A curl
# piped to sh that silently asks for a password is a bad habit to teach.
if [ -z "$DEST" ]; then
  if [ -w /usr/local/bin ]; then DEST=/usr/local/bin; else DEST="$HOME/.local/bin"; fi
fi
mkdir -p "$DEST"

echo "Downloading $BIN for $target…"
if ! curl -fsSL "$SERVER/api/v1/agent/bin/$BIN-$target" -o "$DEST/$BIN.tmp"; then
  echo "This instance does not have that binary. Ask its operator, or build from source." >&2
  exit 1
fi

chmod +x "$DEST/$BIN.tmp"
mv "$DEST/$BIN.tmp" "$DEST/$BIN"
echo "Installed $DEST/$BIN"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH." ;;
esac

if [ -n "$PIN" ]; then
  echo
  "$DEST/$BIN" pair --server "$SERVER" --pin "$PIN"
else
  echo
  echo "Next: $DEST/$BIN pair --server $SERVER --pin <PIN>"
fi
`
}

function powershellScript(): string {
  return `# TERN agent installer — ${base()}
#
# Three things: pick the binary for this machine, download it from the TERN
# instance above, and — if -Pin was given — pair with it.
param(
  [string]$Pin = "",
  [string]$Dir = "$env:LOCALAPPDATA\\TERN",
  [switch]$Proxy
)

$ErrorActionPreference = "Stop"
$server = "${base()}"
$bin = if ($Proxy) { "tern-proxy" } else { "tern-agent" }
$target = "x86_64-pc-windows-msvc"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$exe = Join-Path $Dir "$bin.exe"

Write-Host "Downloading $bin for $target…"
try {
  Invoke-WebRequest -Uri "$server/api/v1/agent/bin/$bin-$target.exe" -OutFile $exe
} catch {
  Write-Error "This instance does not have that binary. Ask its operator, or build from source."
  exit 1
}

Write-Host "Installed $exe"
if ($env:Path -notlike "*$Dir*") { Write-Host "Note: $Dir is not on your PATH." }

if ($Pin -ne "") {
  & $exe pair --server $server --pin $Pin
} else {
  Write-Host "Next: $exe pair --server $server --pin <PIN>"
}
`
}

export default routes
