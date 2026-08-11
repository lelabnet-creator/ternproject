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

/*
 * Whether the address is plain HTTP used to be decided here, and written into
 * the script as a constant. It is now decided by the script itself, at run
 * time, because `--server` lets an install point at a relay whose address this
 * instance has never heard of — and a permission granted for the wrong address
 * is either a refusal at the far end of an install, or an allowance nobody
 * asked for. The rule the scripts apply is the agent's own, in `transport.rs`:
 * https is fine, loopback is exempt, anything else in the clear is a decision.
 */

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
#   --pin <PIN>     pair straight away
#   --server <url>  install against this address instead of the one above —
#                   a relay, for a machine with no route to TERN itself
#   --dir <path>    where to put the binary
#   --no-service    install and pair, but do not register for boot
#   --force         replace an existing config instead of keeping its probes
#   --proxy         install tern-proxy instead
#   --interface <n> the interface a relay serves its zone on (with --proxy)
#   --port <n>      the port a relay serves its zone on (with --proxy)
set -eu

SERVER="${base()}"
PIN=""
DEST="\${TERN_INSTALL_DIR:-}"
BIN="tern-agent"
IFACE=""
ZPORT=""
SERVICE=1
FORCE=0
# Whether a supervisor took it, decided where that is known rather than
# inferred at the end from the shape of the machine.
STARTED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="\${2:-}"; shift 2 ;;
    # Everything downstream reads SERVER: the binary is fetched from it, the
    # config is written pointing at it, and the unit documents it. So one flag
    # moves the whole install onto a relay — which is the only way to install on
    # a machine that cannot reach TERN at all.
    --server) SERVER="\${2:-}"; shift 2 ;;
    --dir) DEST="\${2:-}"; shift 2 ;;
    --proxy) BIN="tern-proxy"; shift ;;
    # A relay with two cards - one facing the zone, one facing out - cannot be
    # guessed at. Without this flag the default is the interface that already
    # carries traffic to TERN, which is right for a single-homed machine and
    # wrong for the other shape.
    --interface) IFACE="\${2:-}"; shift 2 ;;
    # The port alone, for a machine where 8787 is taken. The address is still
    # worked out by the relay, so this is usually the whole of what changes.
    --port) ZPORT="\${2:-}"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SERVER="\${SERVER%/}"

# Plain HTTP has to be accepted on purpose: the API key crosses the network in
# clear at pairing and again on every report, so the agent refuses by default.
#
# Decided here, at run time, rather than baked in when this script was generated
# — because --server can point the install at a relay whose address this
# instance knows nothing about. An allowance chosen for the wrong address is
# either a refusal at the far end of an install, or a permission granted where
# nobody asked for one. Same rule as the agent applies to itself: https is fine,
# loopback is exempt, anything else in the clear is a decision.
PLAIN=0
case "$SERVER" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) ;;
  http://*) PLAIN=1 ;;
esac
if [ "$PLAIN" = 1 ]; then
  export TERN_ALLOW_PLAIN_HTTP=1
fi

# --- a list of steps that fills in -------------------------------------------
#
# Four lines, redrawn in place while the work happens. Deliberately small: this
# file is meant to be read before it is run, and a progress display is not worth
# trading that for. No cursor save/restore, no alternate screen, no eval.
#
# Whether to redraw at all is decided on stdout, not stdin. Piping this script
# into a shell hands stdin to the pipe, so the usual test says nothing here —
# and a log full of cursor movements is worse than no display at all. Without a
# terminal each step prints one plain line as it finishes, which is what a cron
# entry or a CI step wants anyway.
TTY=0
[ -t 1 ] && TTY=1

L1="Picking the binary for this machine"
L2="Downloading"
L3="Pairing"
L4="Registering to start at boot"
M1=" "; M2=" "; M3=" "; M4=" "
DRAWN=0
DONE=0
OK="✓"
GOING="›"

# Everything else printed from here on is held back until the list has stopped
# moving, and shown in one go after it.
#
# Not a nicety. Pairing prints a block of its own, and registering a service
# prints several lines more; a list redrawn above them walks straight over what
# they said. That is how the line naming where the binary landed vanished from
# the one screen that needed it, leaving somebody with a command not found and
# nothing to connect it to.
#
# fd 3 is the terminal, kept aside for the list alone. The trap flushes whatever
# way this ends — a failure's reason is in there too, and losing it would be far
# worse than losing a progress display.
HELD="\${TMPDIR:-/tmp}/tern-install.$$"
exec 3>&1
exec > "$HELD" 2>&1
trap 'exec 1>&3 3>&-; if [ -s "$HELD" ]; then cat "$HELD"; fi; rm -f "$HELD"' EXIT

draw_list() {
  [ "$TTY" = 1 ] || return 0
  # Back over the eight lines drawn last time: title, four steps, a blank, the
  # counter, and the closing rule.
  if [ "$DRAWN" = 1 ]; then printf '\\033[8A' >&3; fi

  # The same frame tern-setup draws, in the same characters, because the two
  # are the same product seen a minute apart — one installs the instance, the
  # other installs what reports to it, and a reader should not have to notice
  # they were written by different tools.
  # Both binaries are ten characters, so one dash run closes the title for
  # either — checked rather than assumed, since a mismatched rule is the first
  # thing an eye catches in a box.
  printf '\\033[K\\n' >&3
  printf '◇  Installing %s ─────────────────────────╮\\033[K\\n' "$BIN" >&3
  printf '│  %s  %-44s│\\033[K\\n' "$M1" "$L1" >&3
  printf '│  %s  %-44s│\\033[K\\n' "$M2" "$L2" >&3
  printf '│  %s  %-44s│\\033[K\\n' "$M3" "$L3" >&3
  printf '│  %s  %-44s│\\033[K\\n' "$M4" "$L4" >&3

  # Filled cells out of sixteen, from the number of steps finished.
  bar=""
  i=0
  while [ "$i" -lt 16 ]; do
    if [ $((i * 4)) -lt $((DONE * 16)) ]; then bar="$bar■"; else bar="$bar□"; fi
    i=$((i + 1))
  done
  printf '│  Step %s of 4  %s  %3s%%            │\\033[K\\n' "$DONE" "$bar" "$((DONE * 25))" >&3
  printf '├─────────────────────────────────────────────────╯\\033[K\\n' >&3
  DRAWN=1
}

# mark <n> <glyph>: the step's new state, and the display that goes with it.
mark() {
  case "$1" in
    1) M1="$2" ;;
    2) M2="$2" ;;
    3) M3="$2" ;;
    4) M4="$2" ;;
  esac
  if [ "$2" = "$OK" ]; then DONE="$1"; fi
  if [ "$TTY" = 1 ]; then
    draw_list
  else
    # One line, and only when a step is finished: a "started" line for every
    # step doubles the length of a log nobody reads until something breaks.
    case "$2" in
      "$OK") eval "printf '  %s %s\\n' \\"$2\\" \\"\\$L$1\\"" >&3 ;;
    esac
  fi
}

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
  STATE_DIR="/var/lib/$BIN"
else
  CONF_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/tern"
  STATE_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/tern"
fi

# Everything below that differs between the two, decided once.
#
# The rest of this script — the download, the service unit, the linger dance —
# is the same work for both, and was written for the agent alone. Naming the
# four differences here is what lets a relay reuse it instead of growing a
# second copy that drifts.
if [ "$BIN" = "tern-proxy" ]; then
  CONF="$CONF_DIR/proxy.toml"
  QUEUE="$STATE_DIR/proxy-queue.jsonl"
  JOIN=init            # writes a config and its listen address, not just a key
  LABEL=net.tern.proxy
  DESC="TERN relay"
else
  CONF="$CONF_DIR/agent.toml"
  QUEUE="$STATE_DIR/queue.jsonl"
  JOIN=pair
  LABEL=net.tern.agent
  DESC="TERN agent"
fi

mark 1 "$OK"
mark 2 "$GOING"
if ! curl -fsSL "$SERVER/api/v1/agent/bin/$BIN-$target" -o "$DEST/$BIN.tmp"; then
  echo "This instance does not have that binary. Ask its operator, or build from source." >&2
  exit 1
fi

chmod +x "$DEST/$BIN.tmp"
mv "$DEST/$BIN.tmp" "$DEST/$BIN"
mark 2 "$OK"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH." ;;
esac

mkdir -p "$CONF_DIR" "$STATE_DIR"

# The relay used to stop here, on "it takes no config and no pairing" — which
# was never true. It pairs like an agent and writes a config holding the key and
# the address it will serve on, so it walks the same path from this line down.
if [ -n "$PIN" ]; then
  mark 3 "$GOING"
  echo
  # Its own block — what it paired with, where the config went, the command for
  # the next machine — lands in the held buffer with everything else, so the
  # list above can keep moving without walking over it.
  #
  # Only the relay has an interface and a port to choose; tern-agent would
  # refuse both flags. Built up rather than branched three ways, so the two can
  # be combined without a fourth arm.
  EXTRA=""
  # Passed through rather than reimplemented here: the binary is the thing that
  # knows what a config holds and what replacing one costs, and it names each
  # probe it is about to drop.
  [ "$FORCE" = 1 ] && [ "$BIN" = "tern-agent" ] && EXTRA="$EXTRA --force"
  if [ "$BIN" = "tern-proxy" ]; then
    [ -n "$IFACE" ] && EXTRA="$EXTRA --interface $IFACE"
    [ -n "$ZPORT" ] && EXTRA="$EXTRA --port $ZPORT"
  fi
  # Unquoted on purpose: EXTRA holds flags and their values, and quoting it
  # would hand the whole string to the binary as one argument.
  "$DEST/$BIN" $JOIN --server "$SERVER" --pin "$PIN" --config "$CONF" $EXTRA
  mark 3 "$OK"
else
  echo
  echo "Next: $DEST/$BIN $JOIN --server $SERVER --pin <PIN> --config $CONF"
  echo "Then re-run this installer to register it for boot."
  exit 0
fi

[ "$SERVICE" = 1 ] || exit 0

mark 4 "$GOING"

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
    PLIST="/Library/LaunchDaemons/$LABEL.plist"
  else
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
  fi

  # The same allowance the pairing needed. Without it in the service too, the
  # agent pairs once and then fails on every report — the shape of failure a
  # monitoring tool can least afford, because the server just shows it as quiet.
  PLIST_ENV=""
  if [ "$PLAIN" = 1 ]; then
    PLIST_ENV='
  <key>EnvironmentVariables</key>
  <dict><key>TERN_ALLOW_PLAIN_HTTP</key><string>1</string></dict>'
  fi

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/$BIN</string>
    <string>run</string>
    <string>--config</string><string>$CONF</string>
    <string>--queue</string><string>$QUEUE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>$PLIST_ENV
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
  STARTED=1
  echo "✓ Registered with launchd — starts at boot."
  echo "  Stop:   launchctl unload $PLIST"

elif [ -d /run/systemd/system ]; then
  if [ "$(id -u)" = 0 ]; then
    UNIT="/etc/systemd/system/$BIN.service"
    WANTED=multi-user.target
  else
    UNIT="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$BIN.service"
    WANTED=default.target
    mkdir -p "$(dirname "$UNIT")"
  fi

  UNIT_ENV=""
  if [ "$PLAIN" = 1 ]; then
    # Same allowance, same reason as at pairing: without it the agent starts,
    # measures, and fails every send — and looks merely quiet from the server.
    UNIT_ENV="Environment=TERN_ALLOW_PLAIN_HTTP=1"
  fi

  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=$DESC
Documentation=$SERVER
# network-online, not network: a probe that runs before the interface has an
# address fails once at every boot and recovers, which reads as a real outage.
After=network-online.target
Wants=network-online.target

[Service]
$UNIT_ENV
ExecStart=$DEST/$BIN run --config $CONF --queue $QUEUE
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
    # enable, then restart — not "enable --now".
    #
    # The --now flag starts a unit that is stopped and does nothing at all to
    # one that is already running. Re-running this installer then left the previous
    # process serving the previous config: the old port, the old keys. The
    # screen said the service was registered, which reads as "running what you
    # just wrote", and an agent paired against it was refused by a relay still
    # holding yesterday's inventory.
    systemctl enable "$BIN.service"
    # --no-block, and that is the difference between four seconds and four
    # minutes.
    #
    # \`systemctl restart\` waits for the job to finish, and starting this unit
    # pulls in network-online.target. On a machine with an interface that never
    # reports online — a second NIC with no carrier, a VM host-only adapter —
    # NetworkManager-wait-online blocks for its full two-minute timeout, and the
    # installer sits at "Registering to start at boot" the whole time. Nothing
    # is wrong, nothing is being waited *for*, and the person watching has no
    # way to know either. Queuing the job is all this step ever needed to do;
    # whether the agent then comes up is what \`doctor\` and the fleet screen are
    # for.
    systemctl restart --no-block "$BIN.service"
    STARTED=1
    echo "✓ Registered with systemd — starts at boot."
    echo "  Status: systemctl status $BIN"
    echo "  Logs:   journalctl -u $BIN -f"
  else
    systemctl --user daemon-reload
    # See the note above: restart, so a second install actually takes effect.
    systemctl --user enable "$BIN.service"
    # See the note above --no-block: waiting here is what made this step take
    # minutes on a machine whose network target never settles.
    systemctl --user restart --no-block "$BIN.service"

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
      STARTED=1
      echo "✓ Registered as a systemd user service — starts at boot."
    else
      echo "⚠ Registered as a systemd user service, but it will NOT start at boot."
      echo "  A user service needs lingering, and enabling it needs root:"
      echo "      sudo loginctl enable-linger $(id -un)"
      echo "  Until then it starts when $(id -un) logs in, and stops at the last logout."
    fi
    echo "  Status: systemctl --user status $BIN"
    echo "  Logs:   journalctl --user -u $BIN -f"
  fi

elif [ -x /sbin/openrc-run ] || [ -d /etc/init.d ] && command -v rc-update >/dev/null 2>&1; then
  if [ "$(id -u)" != 0 ]; then
    echo "⚠ OpenRC needs root to register a service. Re-run with sudo, or use --no-service."
  else
    cat > "/etc/init.d/$BIN" <<'RC_EOF'
#!/sbin/openrc-run
description="__DESC__"
command=__BIN__
command_args="run --config __CONF__ --queue __QUEUE__"
command_background=true
__PLAINENV__
pidfile="/run/__BIN__.pid"
depend() { need net; }
RC_EOF
    # A placeholder and not a variable: this heredoc is quoted, which is what
    # keeps the shell inside it from being run here instead of at boot.
    RC_ENV=""
    if [ "$PLAIN" = 1 ]; then
      RC_ENV="export TERN_ALLOW_PLAIN_HTTP=1"
    fi
    sed -i "s|__PLAINENV__|$RC_ENV|; s|__BIN__|$DEST/$BIN|; s|__CONF__|$CONF|; s|__QUEUE__|$QUEUE|; s|__DESC__|$DESC|" "/etc/init.d/$BIN"
    sed -i "s|/run/$DEST/$BIN.pid|/run/$BIN.pid|" "/etc/init.d/$BIN"
    chmod +x "/etc/init.d/$BIN"
    rc-update add "$BIN" default
    rc-service "$BIN" restart
    STARTED=1
    echo "✓ Registered with OpenRC — starts at boot."
  fi

else
  # Said plainly rather than guessed at. A wrong unit file that never runs is
  # worse than an honest sentence: it looks installed.
  echo "⚠ No supervisor recognised (no systemd, launchd or OpenRC)."
  echo "  $DESC is installed and paired but will NOT restart after a reboot."
  echo "  Start it with:"
  echo "    $DEST/$BIN run --config $CONF --queue $QUEUE"
fi

mark 4 "$OK"

# ICMP without root, which is what \`ping\` controls need. Said only where it
# applies: root already has it, and macOS allows it unprivileged.
# A relay never probes — it serves the agents that do — so raw sockets are not
# its problem, and saying so would be advice about a capability it does not use.
if [ "$BIN" = "tern-agent" ] && [ "$os" = "Linux" ] && [ "$(id -u)" != 0 ]; then
  echo
  echo "Note: ping checks need raw sockets. If they fail, either:"
  echo "  sudo setcap cap_net_raw+ep $DEST/tern-agent"
  echo "  — or check that /proc/sys/net/ipv4/ping_group_range covers your group."
fi

echo
if [ "$BIN" = "tern-proxy" ]; then
  # doctor is the agent's word; the relay reports on itself with status.
  echo "Check it: $DEST/$BIN status --config $CONF"
  echo
  # What used to be here was "add agents to this zone from this machine",
  # followed by a pin command naming this machine's own config path. Both halves
  # misled whoever was looking at the machine they wanted to monitor: that path
  # exists only on the relay, and the binary to put over there is tern-agent. It
  # also described the first of two steps as if it were the whole thing.
  #
  # The init step above prints the real one-liner, with the relay's own address
  # in it, so this points at what it just said rather than repeating it wrongly.
  echo "The command to run on a machine in this zone was printed above."
else
  # The allowance travels with the command, because the service already has it.
  #
  # Without it this printed a line that fails — "Refusing to use plain HTTP" —
  # next to a service that is running perfectly well with
  # Environment=TERN_ALLOW_PLAIN_HTTP=1 in its unit. Somebody following the
  # instruction the installer just gave them reads a [FAIL] about their own
  # setup and starts debugging a problem that does not exist.
  if [ "$PLAIN" = 1 ]; then
    echo "Check it end to end: TERN_ALLOW_PLAIN_HTTP=1 $DEST/$BIN doctor --config $CONF"
  else
    echo "Check it end to end: $DEST/$BIN doctor --config $CONF"
  fi
fi

# ── The last thing on screen ────────────────────────────────────────────────
#
# Whether it is running, and whether it comes back after a reboot, said once at
# the end rather than left to be assembled from three lines scattered through
# the output.
#
# The supervisor block above already prints "Registered ... starts at boot" —
# but it prints it before the pairing block, the PATH note and the raw-socket
# note, which is four screens earlier on a narrow terminal. Somebody installing
# an agent behind a relay read the end of that output and could not tell
# whether anything was running at all, which is a fair conclusion to draw from
# a screen that ends with "check it end to end" and never says "it is on".
if [ "$SERVICE" = 1 ]; then
  echo
  echo "  ─────────────────────────────────────────────────────────"
  if [ "$STARTED" = 1 ]; then
    echo "  $OK Running now, and again after a reboot."
  else
    # Named as the exception it is, with the one command that fixes it. A
    # process nobody restarts is a monitor that stops at the first power cut
    # and reports nothing, silently, from then on.
    echo "  ! Installed, but NOT set to start after a reboot."
    echo "    Start it now:  $DEST/$BIN run --config $CONF --queue $QUEUE"
  fi
  echo "  ─────────────────────────────────────────────────────────"
fi
`
}

function powershellScript(): string {
  return `# TERN agent installer — ${base()}
#
# Four things: pick the binary for this machine, download it from the TERN
# instance above, pair with it if -Pin was given, and register it to start at
# boot. An agent that has to be started by hand stops at the first restart, and
# stops quietly.
#
# -Server <url> installs against that address instead — a relay, for a machine
# with no route to TERN itself.
param(
  [string]$Pin = "",
  # Everything downstream reads $server: the download, the config that gets
  # written, and the task. One parameter therefore moves the whole install onto
  # a relay, which is the only way onto a machine that cannot reach TERN.
  [string]$Server = "",
  [string]$Dir = "",
  [switch]$Proxy,
  [switch]$NoService
)

$ErrorActionPreference = "Stop"
$server = if ($Server -ne "") { $Server.TrimEnd("/") } else { "${base()}" }

# Decided at run time rather than baked in when this script was generated: with
# -Server the address is one this instance knows nothing about, and an allowance
# chosen for the wrong address is either a refusal at the far end of an install
# or a permission nobody asked for. Same rule the agent applies to itself.
$plain = $server.StartsWith("http://") -and
         -not ($server.StartsWith("http://localhost") -or $server.StartsWith("http://127.0.0.1"))
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

# The four things that differ between the two, decided once — everything below
# is the same work, and was written for the agent alone.
if ($Proxy) {
  $conf  = Join-Path $Dir "proxy.toml"
  $queue = Join-Path $Dir "proxy-queue.jsonl"
  $join  = "init"          # writes a config and a listen address, not just a key
  $task  = "TERN relay"
} else {
  $conf  = Join-Path $Dir "agent.toml"
  $queue = Join-Path $Dir "queue.jsonl"
  $join  = "pair"
  $task  = "TERN agent"
}

Write-Host "Downloading $bin for $target…"
try {
  Invoke-WebRequest -Uri "$server/api/v1/agent/bin/$bin-$target.exe" -OutFile $exe
} catch {
  Write-Error "This instance does not have that binary. Ask its operator, or build from source."
  exit 1
}

Write-Host "Installed $exe"
if ($env:Path -notlike "*$Dir*") { Write-Host "Note: $Dir is not on your PATH." }

# The relay used to stop here, on "it takes no config and no pairing" — which
# was never true. It pairs and writes a config, so it walks the same path.

if ($plain) {
  # The address is plain HTTP, which the agent refuses unless told otherwise —
  # the API key crosses the network in clear at pairing and on every report
  # after it. Set for this process so the pairing below works, and persisted so
  # the scheduled task inherits it: a scheduled task carries no environment of
  # its own, and pairing once then failing on every report is the failure a
  # monitoring tool can least afford.
  $env:TERN_ALLOW_PLAIN_HTTP = "1"
  [Environment]::SetEnvironmentVariable("TERN_ALLOW_PLAIN_HTTP", "1",
    $(if ($admin) { "Machine" } else { "User" }))
}

if ($Pin -ne "") {
  & $exe $join --server $server --pin $Pin --config $conf
} else {
  Write-Host "Next: $exe $join --server $server --pin <PIN> --config $conf"
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
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger \`
      -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "OK Registered as a scheduled task — starts at boot, as SYSTEM."
  } else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger \`
      -Settings $settings -Force | Out-Null
    Write-Host "OK Registered as a scheduled task — starts when you log in."
    Write-Host "   Run this as Administrator to have it start at boot instead,"
    Write-Host "   without waiting for anyone to sign in."
  }
  Start-ScheduledTask -TaskName $task
  Write-Host "   Status: Get-ScheduledTask -TaskName '$task'"
  Write-Host "   Remove: Unregister-ScheduledTask -TaskName '$task'"
} catch {
  Write-Warning "Could not register the scheduled task: $_"
  Write-Warning "The agent is installed and paired but will NOT restart after a reboot."
  Write-Host "Start it with: $exe run --config $conf --queue $queue"
}

Write-Host ""
if ($Proxy) {
  # doctor is the agent's word; the relay reports on itself with status.
  Write-Host "Check it: $exe status --config $conf"
  Write-Host ""
  Write-Host "Add agents to this zone from this machine:"
  Write-Host "  $exe pin --config $conf"
} else {
  Write-Host "Check it end to end: $exe doctor --config $conf"
}
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
