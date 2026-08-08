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
 * Is this instance reached over plain HTTP, somewhere the agent will refuse by
 * default?
 *
 * Localhost is not: the agent exempts it already, and an allowance written into
 * a script that does not need one teaches the wrong habit. Everything else that
 * is not `https://` is — a LAN address, a hostname on an internal network, a
 * public address someone has not put TLS in front of yet. All three are real,
 * and the first is the ordinary shape of a first deployment.
 */
function plainHttp(): boolean {
  const url = base()
  if (url.startsWith('https://')) return false
  return !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')
}

/**
 * The installer, generated with this instance's address baked in.
 *
 * Deliberately readable: it is piped into a shell, which is a thing to be
 * suspicious of, so anyone who opens the URL first should be able to see
 * exactly what it does in one screen. No compression, no eval, no base64.
 *
 * It ends by registering the agent with whatever supervises services on this
 * machine. An agent installed and paired but not registered works perfectly
 * until the first reboot and then stops — and it stops silently, which is the
 * failure a monitoring tool can least afford. The server would show it as
 * quiet, but only to somebody looking.
 */
function shellScript(): string {
  return `#!/bin/sh
# TERN agent installer — ${base()}
#
# Reading this before running it is the correct instinct. It does four things:
# picks the binary for this machine, downloads it from the TERN instance above,
# pairs with it if you passed --pin, and registers it to start at boot.
#
#   --pin <PIN>    pair straight away
#   --dir <path>   where to put the binary
#   --no-service   install and pair, but do not register for boot
#   --proxy        install tern-proxy instead
set -eu

SERVER="${base()}"
# This instance's own address is plain HTTP, so the agent has to be told that
# is acceptable — it refuses by default, because the API key it receives at
# pairing crosses the network in clear and then does so on every report.
#
# Written here rather than left to whoever runs this: the address in SERVER is
# the one this instance was configured with, so the choice was already made,
# and an installer that generates a command its own binary rejects is an
# installer that is wrong. Give the instance an https:// address and this line
# disappears from the script.
${plainHttp() ? 'export TERN_ALLOW_PLAIN_HTTP=1\n' : ''}PIN=""
DEST="\${TERN_INSTALL_DIR:-}"
BIN="tern-agent"
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="\${2:-}"; shift 2 ;;
    --dir) DEST="\${2:-}"; shift 2 ;;
    --proxy) BIN="tern-proxy"; shift ;;
    --no-service) SERVICE=0; shift ;;
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

# Where the config and the offline queue live.
#
# Chosen before pairing, and passed to it, so the service unit written further
# down can name an absolute path. The agent's own default is \`agent.toml\` in
# the working directory — right for running it by hand in a terminal, useless
# to a supervisor that starts it from /.
if [ "$(id -u)" = 0 ]; then
  CONF_DIR=/etc/tern
  STATE_DIR=/var/lib/tern-agent
else
  CONF_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/tern"
  STATE_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/tern"
fi
CONF="$CONF_DIR/agent.toml"
QUEUE="$STATE_DIR/queue.jsonl"

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

if [ "$BIN" != "tern-agent" ]; then
  echo
  echo "tern-proxy installed. It takes no config and no pairing."
  exit 0
fi

mkdir -p "$CONF_DIR" "$STATE_DIR"

if [ -n "$PIN" ]; then
  echo
  "$DEST/$BIN" pair --server "$SERVER" --pin "$PIN" --config "$CONF"
else
  echo
  echo "Next: $DEST/$BIN pair --server $SERVER --pin <PIN> --config $CONF"
  echo "Then re-run this installer to register it for boot."
  exit 0
fi

[ "$SERVICE" = 1 ] || exit 0

# --- starting again after a reboot -------------------------------------------
#
# The whole point of an agent is that it keeps reporting. One that has to be
# started by hand is one that stops the next time the machine restarts, and
# says nothing about it.
#
# Which supervisor, decided by what is actually present rather than by the
# distribution's name: /run/systemd/system exists only when systemd is the
# running init, which is the question that matters — a machine can carry
# systemctl and boot something else.
echo
if [ "$os" = "Darwin" ]; then
  if [ "$(id -u)" = 0 ]; then
    PLIST=/Library/LaunchDaemons/net.tern.agent.plist
  else
    PLIST="$HOME/Library/LaunchAgents/net.tern.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
  fi

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.tern.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/tern-agent</string>
    <string>run</string>
    <string>--config</string><string>$CONF</string>
    <string>--queue</string><string>$QUEUE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>${
    plainHttp()
      ? `
  <key>EnvironmentVariables</key>
  <dict><key>TERN_ALLOW_PLAIN_HTTP</key><string>1</string></dict>`
      : ''
  }
</dict>
</plist>
PLIST_EOF

  # bootstrap is the current verb and load the one that works everywhere. Try
  # the modern one, fall back rather than fail: an installer that leaves the
  # plist written but unloaded is the worst of both.
  launchctl unload "$PLIST" 2>/dev/null || true
  if ! launchctl load -w "$PLIST" 2>/dev/null; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  fi
  echo "✓ Registered with launchd — starts at boot."
  echo "  Stop:   launchctl unload $PLIST"

elif [ -d /run/systemd/system ]; then
  if [ "$(id -u)" = 0 ]; then
    UNIT=/etc/systemd/system/tern-agent.service
    WANTED=multi-user.target
  else
    UNIT="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/tern-agent.service"
    WANTED=default.target
    mkdir -p "$(dirname "$UNIT")"
  fi

  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=TERN agent
Documentation=$SERVER
# network-online, not network: a probe that runs before the interface has an
# address fails once at every boot and recovers, which reads as a real outage.
After=network-online.target
Wants=network-online.target

[Service]
${plainHttp() ? '# The same allowance the pairing needed. Without it here, the agent pairs\n# once and then fails on every report — the shape of failure a monitoring\n# tool can least afford, because the server just shows it as quiet.\nEnvironment=TERN_ALLOW_PLAIN_HTTP=1\n' : ''}ExecStart=$DEST/tern-agent run --config $CONF --queue $QUEUE
Restart=always
RestartSec=5
# The agent buffers to disk while the server is unreachable, so a restart loop
# here would lose nothing — but it would fill the journal. Five seconds is slow
# enough to read and fast enough not to matter.

[Install]
WantedBy=$WANTED
UNIT_EOF

  if [ "$(id -u)" = 0 ]; then
    systemctl daemon-reload
    systemctl enable --now tern-agent.service
    echo "✓ Registered with systemd — starts at boot."
    echo "  Status: systemctl status tern-agent"
    echo "  Logs:   journalctl -u tern-agent -f"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now tern-agent.service

    # Without lingering, a user unit stops when the last session closes and
    # does not come back until somebody logs in — which on a server is never.
    # So it is asked for twice and then verified, because whether it worked
    # decides which of two different sentences is true below.
    #
    # Twice, because polkit answers differently from one distribution to the
    # next: Ubuntu grants an active session its own linger, Arch refuses it
    # without a password and the unprivileged call fails silently. The -n on
    # sudo matters too: this script is often piped into a shell, and a
    # password prompt with no terminal behind it hangs instead of asking.
    LINGER=no
    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \\
        || sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \\
        || true
      loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes' && LINGER=yes
    fi

    # And the truth about it, rather than the sentence we would like to write.
    # This claimed "starts at boot" unconditionally — directly under its own
    # warning that lingering had failed — so the reader saw a ⚠ and a ✓ and
    # believed the ✓. On a server that is the worst kind of wrong: nothing is
    # noticed until a reboot, and then nothing reports, quietly.
    if [ "$LINGER" = yes ]; then
      echo "✓ Registered as a systemd user service — starts at boot."
    else
      echo "⚠ Registered as a systemd user service, but it will NOT start at boot."
      echo "  A user service needs lingering, and enabling it needs root:"
      echo "      sudo loginctl enable-linger $(id -un)"
      echo "  Until then it starts when $(id -un) logs in, and stops at the last logout."
    fi
    echo "  Status: systemctl --user status tern-agent"
    echo "  Logs:   journalctl --user -u tern-agent -f"
  fi

elif [ -x /sbin/openrc-run ] || [ -d /etc/init.d ] && command -v rc-update >/dev/null 2>&1; then
  if [ "$(id -u)" != 0 ]; then
    echo "⚠ OpenRC needs root to register a service. Re-run with sudo, or use --no-service."
  else
    cat > /etc/init.d/tern-agent <<'RC_EOF'
#!/sbin/openrc-run
description="TERN agent"
command=__BIN__
command_args="run --config __CONF__ --queue __QUEUE__"
command_background=true
${plainHttp() ? 'export TERN_ALLOW_PLAIN_HTTP=1\n' : ''}
pidfile="/run/tern-agent.pid"
depend() { need net; }
RC_EOF
    sed -i "s|__BIN__|$DEST/tern-agent|; s|__CONF__|$CONF|; s|__QUEUE__|$QUEUE|" /etc/init.d/tern-agent
    chmod +x /etc/init.d/tern-agent
    rc-update add tern-agent default
    rc-service tern-agent restart
    echo "✓ Registered with OpenRC — starts at boot."
  fi

else
  # Said plainly rather than guessed at. A wrong unit file that never runs is
  # worse than an honest sentence: it looks installed.
  echo "⚠ No supervisor recognised (no systemd, launchd or OpenRC)."
  echo "  The agent is installed and paired but will NOT restart after a reboot."
  echo "  Start it with:"
  echo "    $DEST/tern-agent run --config $CONF --queue $QUEUE"
fi

# ICMP without root, which is what \`ping\` controls need. Said only where it
# applies: root already has it, and macOS allows it unprivileged.
if [ "$os" = "Linux" ] && [ "$(id -u)" != 0 ]; then
  echo
  echo "Note: ping checks need raw sockets. If they fail, either:"
  echo "  sudo setcap cap_net_raw+ep $DEST/tern-agent"
  echo "  — or check that /proc/sys/net/ipv4/ping_group_range covers your group."
fi

echo
echo "Check it end to end: $DEST/tern-agent doctor --config $CONF"
`
}

function powershellScript(): string {
  return `# TERN agent installer — ${base()}
#
# Four things: pick the binary for this machine, download it from the TERN
# instance above, pair with it if -Pin was given, and register it to start at
# boot. An agent that has to be started by hand stops at the first restart, and
# stops quietly.
param(
  [string]$Pin = "",
  [string]$Dir = "",
  [switch]$Proxy,
  [switch]$NoService
)

$ErrorActionPreference = "Stop"
$server = "${base()}"
$bin = if ($Proxy) { "tern-proxy" } else { "tern-agent" }
$target = "x86_64-pc-windows-msvc"

# Administrator decides everything downstream: where the files belong, whether
# the task can run at startup rather than at logon, and whether it can run as
# SYSTEM. Asked once, here.
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Dir -eq "") {
  $Dir = if ($admin) { Join-Path $env:ProgramData "TERN" } else { Join-Path $env:LOCALAPPDATA "TERN" }
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$exe = Join-Path $Dir "$bin.exe"
$conf = Join-Path $Dir "agent.toml"
$queue = Join-Path $Dir "queue.jsonl"

Write-Host "Downloading $bin for $target…"
try {
  Invoke-WebRequest -Uri "$server/api/v1/agent/bin/$bin-$target.exe" -OutFile $exe
} catch {
  Write-Error "This instance does not have that binary. Ask its operator, or build from source."
  exit 1
}

Write-Host "Installed $exe"
if ($env:Path -notlike "*$Dir*") { Write-Host "Note: $Dir is not on your PATH." }

if ($Proxy) {
  Write-Host "tern-proxy installed. It takes no config and no pairing."
  exit 0
}

${
  plainHttp()
    ? `# This instance's address is plain HTTP, which the agent refuses unless told
# otherwise — the API key crosses the network in clear at pairing and on every
# report after it. Set for this process so the pairing below works, and
# persisted so the scheduled task inherits it: a scheduled task carries no
# environment of its own, and pairing once then failing on every report is the
# failure a monitoring tool can least afford.
$env:TERN_ALLOW_PLAIN_HTTP = "1"
[Environment]::SetEnvironmentVariable("TERN_ALLOW_PLAIN_HTTP", "1",
  $(if ($admin) { "Machine" } else { "User" }))

`
    : ''
}if ($Pin -ne "") {
  & $exe pair --server $server --pin $Pin --config $conf
} else {
  Write-Host "Next: $exe pair --server $server --pin <PIN> --config $conf"
  Write-Host "Then re-run this installer to register it for boot."
  exit 0
}

if ($NoService) { exit 0 }

# --- starting again after a reboot -------------------------------------------
#
# A scheduled task rather than a Windows service, and not for convenience:
# tern-agent is an ordinary console program. A real service has to answer the
# Service Control Manager within its timeout, and one that does not is killed
# shortly after starting — New-Service here would produce something that looks
# installed and dies every time.
#
# Administrator gets a task at system startup running as SYSTEM, which needs
# nobody to log in. Without it, the best available is at logon, for this user.
$action = New-ScheduledTaskAction -Execute $exe \`
  -Argument "run --config \`"$conf\`" --queue \`"$queue\`"" -WorkingDirectory $Dir

# Restart the task if it ever exits, and never stop it for running too long —
# the default is three days, after which monitoring would simply end.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries \`
  -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) \`
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable

try {
  if ($admin) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount \`
      -RunLevel Highest
    Register-ScheduledTask -TaskName "TERN agent" -Action $action -Trigger $trigger \`
      -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "OK Registered as a scheduled task — starts at boot, as SYSTEM."
  } else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "TERN agent" -Action $action -Trigger $trigger \`
      -Settings $settings -Force | Out-Null
    Write-Host "OK Registered as a scheduled task — starts when you log in."
    Write-Host "   Run this as Administrator to have it start at boot instead,"
    Write-Host "   without waiting for anyone to sign in."
  }
  Start-ScheduledTask -TaskName "TERN agent"
  Write-Host "   Status: Get-ScheduledTask -TaskName 'TERN agent'"
  Write-Host "   Remove: Unregister-ScheduledTask -TaskName 'TERN agent'"
} catch {
  Write-Warning "Could not register the scheduled task: $_"
  Write-Warning "The agent is installed and paired but will NOT restart after a reboot."
  Write-Host "Start it with: $exe run --config $conf --queue $queue"
}

Write-Host ""
Write-Host "Check it end to end: $exe doctor --config $conf"
`
}

/**
 * Exposed for the tests beside this file.
 *
 * Both scripts are shell embedded in a TypeScript template literal, where `\${`
 * and a backtick mean something to the *outer* language. A mistake there does
 * not fail the build — it ships a script that fails on the machine it was meant
 * to set up, which is a machine nobody here can see.
 */
export const __testables = { shellScript, powershellScript }

export default routes
