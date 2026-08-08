import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

  it('gives pairing an absolute config path', () => {
    // The agent's own default is `agent.toml` in the working directory. A
    // service started from / would look for it in the wrong place, so the unit
    // and the pairing have to agree on one absolute path.
    expect(script).toMatch(/pair .*--config "\$CONF"/)
    expect(script).toMatch(/ExecStart=.*--config \$CONF --queue \$QUEUE/)
  })

  it('can be told not to touch the boot configuration', () => {
    expect(script).toContain('--no-service')
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

  it('does not let Windows stop the task for running too long', () => {
    // The default execution time limit is three days, after which monitoring
    // would simply end without anything reporting a fault.
    expect(script).toContain('-ExecutionTimeLimit (New-TimeSpan -Seconds 0)')
  })
})

/**
 * The installers generated for an instance that has no TLS in front of it.
 *
 * The agent refuses plain HTTP unless told otherwise, because the API key it
 * receives at pairing crosses the network in clear and does so again on every
 * report. That refusal is right, and it made the product contradict itself: the
 * installer accepts `http://192.168.1.30:8080` as a public URL — it suggests the
 * machine's own address — and the admin then handed you a pair command that the
 * agent rejected. Found on a LAN install with no TLS anywhere, which is the
 * ordinary shape of a first deployment.
 *
 * The address decides, so these load the module again under a different one.
 * The default in `config.ts` is a localhost URL, which is exactly the case that
 * must *not* carry the allowance.
 */
describe('an instance reached over plain HTTP', () => {
  async function scriptsFor(url: string) {
    vi.resetModules()
    const previous = process.env.PUBLIC_BASE_URL
    process.env.PUBLIC_BASE_URL = url
    try {
      const module = await import('./download.js')
      return {
        sh: module.__testables.shellScript(),
        ps1: module.__testables.powershellScript(),
      }
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL
      else process.env.PUBLIC_BASE_URL = previous
      vi.resetModules()
    }
  }

  it('lets the agent pair, and keeps letting it report', async () => {
    const { sh, ps1 } = await scriptsFor('http://192.168.1.30:8080')

    // Pairing is the visible half. The service is the half that matters: an
    // agent that pairs once and then fails on every report is the failure a
    // monitoring tool can least afford, because the server shows it as quiet.
    expect(sh).toContain('export TERN_ALLOW_PLAIN_HTTP=1')
    expect(sh).toContain('Environment=TERN_ALLOW_PLAIN_HTTP=1')
    expect(sh).toContain('<key>TERN_ALLOW_PLAIN_HTTP</key>')

    // Windows carries no environment into a scheduled task, so it has to be
    // persisted rather than exported.
    expect(ps1).toContain('$env:TERN_ALLOW_PLAIN_HTTP = "1"')
    expect(ps1).toContain('SetEnvironmentVariable("TERN_ALLOW_PLAIN_HTTP"')
  })

  it('still parses as POSIX sh with the allowance in it', async () => {
    const { sh } = await scriptsFor('http://192.168.1.30:8080')
    const dir = mkdtempSync(join(tmpdir(), 'tern-install-http-'))
    const path = join(dir, 'install.sh')
    writeFileSync(path, sh)
    expect(() => execFileSync('sh', ['-n', path], { stdio: 'pipe' })).not.toThrow()
  })

  it('says nothing of the kind when there is TLS, or when it is localhost', async () => {
    for (const url of ['https://status.example.com', 'http://localhost:5173']) {
      const { sh, ps1 } = await scriptsFor(url)
      // An allowance written into a script that does not need one teaches the
      // habit of writing it into scripts that do.
      expect(sh).not.toContain('TERN_ALLOW_PLAIN_HTTP')
      expect(ps1).not.toContain('TERN_ALLOW_PLAIN_HTTP')
    }
  })
})
