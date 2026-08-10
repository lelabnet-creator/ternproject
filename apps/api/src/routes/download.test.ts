import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { __testables } from './download.js'

const { shellScript, powershellScript } = __testables

/**
 * The two installers, which are shell and PowerShell written inside TypeScript
 * template literals.
 *
 * That nesting is the whole reason this file exists. `\${` and a backtick belong
 * to the outer language, so an escaping mistake compiles, type-checks, passes
 * review and then produces a script that dies on somebody else's machine — the
 * one place nobody here can look. Parsing the output is the only check that
 * actually reads it as a shell would.
 */

describe('the shell installer', () => {
  const script = shellScript()

  it('parses as POSIX sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-install-'))
    const path = join(dir, 'install.sh')
    writeFileSync(path, script)

    // -n parses without running: it reads every heredoc, quote and case
    // statement, and reports the ones that do not close.
    expect(() => execFileSync('sh', ['-n', path], { stdio: 'pipe' })).not.toThrow()
  })

  it('left no template-literal escape behind', () => {
    // The failure this catches: `\\${VAR}` written where `\${VAR}` was meant, so
    // the backslash reaches the shell. It parses fine and expands to nothing.
    expect(script).not.toMatch(/\\\$\{/)
    expect(script).not.toContain('\\`')
  })

  it('registers with each supervisor it claims to support', () => {
    expect(script).toContain('launchctl')
    expect(script).toContain('systemctl')
    expect(script).toContain('rc-update')
    // Present as init, not merely installed: a machine can carry systemctl and
    // boot something else entirely.
    expect(script).toContain('/run/systemd/system')
  })

  it('says so rather than pretending when nothing is recognised', () => {
    // The alternative — writing a unit for a supervisor that is not there —
    // looks like success and reports nothing at the next reboot.
    expect(script).toMatch(/will NOT restart after a reboot/)
  })

  it('gives joining an absolute config path', () => {
    // The agent's own default is `agent.toml` in the working directory. A
    // service started from / would look for it in the wrong place, so the unit
    // and the joining step have to agree on one absolute path.
    //
    // `$JOIN` rather than a literal verb since the relay joins with `init`:
    // it writes a config and a listen address, not just a key.
    expect(script).toMatch(/\$JOIN .*--config "\$CONF"/)
    expect(script).toMatch(/ExecStart=.*--config \$CONF --queue \$QUEUE/)
  })

  it('installs a relay the whole way, instead of stopping at the download', () => {
    /*
     * It used to print "tern-proxy installed. It takes no config and no
     * pairing." and exit — which was never true. The relay pairs and writes a
     * config holding the key and the address it serves on, so an installer that
     * stopped there left a binary nobody could use, and said the opposite.
     *
     * That sentence was the only proxy affordance in the whole product, which
     * is why no install path was findable.
     */
    expect(script).not.toContain('It takes no config and no pairing')

    // Both roles resolve their own identity, and everything below is shared.
    expect(script).toMatch(/JOIN=init/)
    expect(script).toMatch(/JOIN=pair/)
    expect(script).toMatch(/CONF="\$CONF_DIR\/proxy\.toml"/)
    expect(script).toMatch(/LABEL=net\.tern\.proxy/)
  })

  it('never names one binary where the other could be running', () => {
    // The service unit, the launchd label and the OpenRC script are written
    // from `$BIN`. A hardcoded `tern-agent` there would register a relay under
    // a unit that starts an agent that is not installed.
    expect(script).toMatch(/ExecStart=\$DEST\/\$BIN run/)
    expect(script).toMatch(/UNIT="?\/etc\/systemd\/system\/\$BIN\.service/)
    expect(script).toContain('<string>$DEST/$BIN</string>')
  })

  it('offers raw sockets only to the thing that probes', () => {
    // A relay never probes — it serves the agents that do — so advice about
    // CAP_NET_RAW would be about a capability it does not use.
    expect(script).toMatch(/\[ "\$BIN" = "tern-agent" \].*\n?.*/)
    expect(script).toContain('setcap cap_net_raw+ep')
  })

  it('tells a relay how its own zone is joined', () => {
    // The one thing this installer cannot do: TERN issues no zone PIN, the
    // relay issues its own. Said on the machine where it has to be run.
    expect(script).toContain('pin --config')
  })

  it('can be told not to touch the boot configuration', () => {
    expect(script).toContain('--no-service')
  })

  it('can be pointed at a relay instead of the instance that served it', () => {
    // The one flag that makes an isolated machine installable at all: it has no
    // route to TERN, so both halves — where the binary comes from and what the
    // config ends up saying — have to move together. They do, because every
    // step downstream reads $SERVER.
    expect(script).toMatch(/--server\) SERVER=/)
    expect(script).toContain('curl -fsSL "$SERVER/api/v1/agent/bin/$BIN-$target"')
    expect(script).toContain('$JOIN --server "$SERVER" --pin "$PIN"')
  })

  it('does not promise a user service starts at boot until lingering is verified', () => {
    // Measured on Arch: `loginctl enable-linger` failed — polkit refuses it
    // without a password there, where Ubuntu grants it to an active session —
    // and the script printed its own warning and then "starts at boot" anyway.
    // The reader sees a ⚠ and a ✓ and believes the ✓; the agent then does not
    // come back from the next reboot, quietly.
    expect(script).toContain('sudo -n loginctl enable-linger')
    expect(script).toContain('-p Linger')
    expect(script).toContain('will NOT start at boot')

    // The claim exists, but only on the branch where lingering was confirmed.
    const claim = script.indexOf('✓ Registered as a systemd user service')
    const check = script.indexOf('$LINGER" = yes')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(claim)
  })
})

describe('the PowerShell installer', () => {
  const script = powershellScript()

  it('left no template-literal escape behind', () => {
    expect(script).not.toMatch(/\\\$\{/)
  })

  it('uses a scheduled task, not a service', () => {
    // tern-agent is a console program. A Windows service has to answer the
    // Service Control Manager, and one that does not is killed seconds after
    // starting — New-Service would install something that dies every boot.
    expect(script).toContain('Register-ScheduledTask')
    // An invocation, not the word: the comment above it in the script explains
    // why New-Service is the wrong tool, and should be allowed to say so.
    expect(script).not.toMatch(/^\s*(&\s*)?New-Service\s/m)
  })

  it('starts at boot with administrator and at logon without', () => {
    expect(script).toContain('-AtStartup')
    expect(script).toContain('-AtLogOn')
    expect(script).toContain('IsInRole')
  })

  it('installs a relay the whole way, instead of stopping at the download', () => {
    // Same sentence, same lie, on the other platform.
    expect(script).not.toContain('It takes no config and no pairing')
    expect(script).toContain('$join  = "init"')
    expect(script).toContain('$task  = "TERN relay"')
    // The scheduled task is registered under whichever of the two was
    // installed: a relay registered as "TERN agent" would be a task nobody
    // finds and a name that lies about what it starts.
    expect(script).toContain('Register-ScheduledTask -TaskName $task')
  })

  it('does not let Windows stop the task for running too long', () => {
    // The default execution time limit is three days, after which monitoring
    // would simply end without anything reporting a fault.
    expect(script).toContain('-ExecutionTimeLimit (New-TimeSpan -Seconds 0)')
  })
})

/**
 * The plain-HTTP allowance.
 *
 * The agent refuses plain HTTP unless told otherwise, because the API key it
 * receives at pairing crosses the network in clear and does so again on every
 * report. That refusal is right, and it made the product contradict itself: the
 * installer accepts `http://192.168.1.30:8080` as a public URL — it suggests the
 * machine's own address — and the admin then handed you a pair command that the
 * agent rejected. Found on a LAN install with no TLS anywhere, which is the
 * ordinary shape of a first deployment.
 *
 * It used to be decided here, at generation, from `PUBLIC_BASE_URL`. It cannot
 * be any more: `--server` points an install at a relay whose address this
 * instance has never heard of, and the answer for TERN's address is not the
 * answer for the relay's. So the script decides, and these run the script's own
 * decision rather than looking for a constant in it.
 */
describe('the plain-HTTP allowance', () => {
  /** Runs the shipped decision, for one address. */
  function allowedFor(server: string): boolean {
    const decision = shellScript().match(/PLAIN=0\n(?:.|\n)*?\nesac/)
    expect(decision, 'the decision should be findable in the script').not.toBeNull()

    const out = execFileSync('sh', ['-c', `SERVER="${server}"\n${decision?.[0]}\necho $PLAIN`], {
      encoding: 'utf8',
    })
    return out.trim() === '1'
  }

  it('is granted in the clear, and refused where it would be noise', () => {
    // A LAN address and a relay by name: both need it, and the second is the
    // case that could not exist before --server did.
    expect(allowedFor('http://192.168.1.30:8080')).toBe(true)
    expect(allowedFor('http://relay.lan:8787')).toBe(true)

    // An allowance written where it is not needed teaches the habit of writing
    // it where it is.
    expect(allowedFor('https://status.example.com')).toBe(false)
    expect(allowedFor('http://localhost:5173')).toBe(false)
    expect(allowedFor('http://127.0.0.1:8787')).toBe(false)
  })

  it('reaches the service as well as the pairing', () => {
    const script = shellScript()

    // Pairing is the visible half. The service is the half that matters: an
    // agent that pairs once and then fails on every report is the failure a
    // monitoring tool can least afford, because the server shows it as quiet.
    // All three supervisors take it from the same decision, so none of them can
    // disagree with the pairing that just succeeded.
    expect(script).toContain('UNIT_ENV="Environment=TERN_ALLOW_PLAIN_HTTP=1"')
    expect(script).toContain('<key>TERN_ALLOW_PLAIN_HTTP</key>')
    expect(script).toContain('RC_ENV="export TERN_ALLOW_PLAIN_HTTP=1"')

    const gates = script.match(/\[ "\$PLAIN" = 1 \]/g) ?? []
    expect(gates.length, 'the export and the three supervisors').toBeGreaterThanOrEqual(4)
  })

  it('decides the same way on Windows, where a task carries no environment', () => {
    const ps1 = powershellScript()
    expect(ps1).toContain('[string]$Server = ""')
    expect(ps1).toMatch(/\$plain = \$server\.StartsWith\("http:\/\/"\)/)
    expect(ps1).toContain('if ($plain) {')

    // Persisted, not merely exported: a scheduled task starts with none of it.
    expect(ps1).toContain('$env:TERN_ALLOW_PLAIN_HTTP = "1"')
    expect(ps1).toContain('SetEnvironmentVariable("TERN_ALLOW_PLAIN_HTTP"')
  })

  it('still parses as POSIX sh, decision and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-install-http-'))
    const path = join(dir, 'install.sh')
    writeFileSync(path, shellScript())
    expect(() => execFileSync('sh', ['-n', path], { stdio: 'pipe' })).not.toThrow()
  })
})
