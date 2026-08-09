import { describe, expect, it } from 'vitest'
import {
  SCRIPT_TEMPLATES,
  renderAgentConfig,
  renderAgentPairCommand,
  renderAllTemplates,
  renderProxyInitCommand,
  renderTemplate,
} from './templates.js'

const CTX = {
  baseUrl: 'https://status.example.com/',
  controlKey: 'api-gateway',
  apiKey: 'tern_TESTKEY123',
  degradedMs: 400,
  downMs: 2500,
}

describe('the set of templates', () => {
  it('offers ten languages', () => {
    // All ten are generated at once, not on demand: someone who works in Perl
    // should not have to discover that Perl is an option.
    expect(SCRIPT_TEMPLATES).toHaveLength(10)
  })

  it('has unique ids and a syntax hint for each', () => {
    const ids = SCRIPT_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of SCRIPT_TEMPLATES) {
      expect(template.syntax).toBeTruthy()
      expect(template.extension).toBeTruthy()
    }
  })

  it('throws on an unknown id rather than returning nothing', () => {
    expect(() => renderTemplate('cobol', CTX)).toThrow(/Unknown template/)
  })
})

const VALUE_CTX = {
  ...CTX,
  controlKey: 'queue-depth',
  payloadShape: 'value' as const,
  valueUnit: 'jobs',
  valueLabel: 'Pending jobs',
}

describe('every rendered script', () => {
  const rendered = renderAllTemplates(CTX)

  for (const template of SCRIPT_TEMPLATES) {
    describe(template.label, () => {
      const script = rendered[template.id]!

      it('targets the ingest endpoint without a doubled slash', () => {
        // The base URL is user-entered and often pasted with a trailing slash.
        expect(script).toContain('https://status.example.com/api/v1/ingest')
        expect(script).not.toContain('.com//api')
      })

      it('carries the control key and the thresholds', () => {
        expect(script).toContain('api-gateway')
        expect(script).toContain('400')
        expect(script).toContain('2500')
      })

      it('prefers the environment over the inlined key', () => {
        // The inlined key makes the script work on paste; reading the
        // environment first is what makes the same file safe to commit.
        expect(script).toContain('TERN_API_KEY')
        expect(script).toContain('tern_TESTKEY123')
      })

      it('sends a bearer token and JSON', () => {
        expect(script.toLowerCase()).toContain('bearer')
        expect(script.toLowerCase()).toContain('application/json')
      })

      it('exits non-zero when the push is rejected', () => {
        // Without this the script "succeeds" while the measurement never
        // arrives, and nobody finds out until someone looks at the page.
        expect(script).toMatch(/exit\W*1|Exit\(|SystemExit\(1\)|os\.Exit\(1\)|process\.exit\(1\)/)
      })

      it('leaves a clearly marked place for the real check', () => {
        expect(script.toLowerCase()).toContain('replace with the real check')
      })
    })
  }
})

describe('the value payload shape', () => {
  const rendered = renderAllTemplates(VALUE_CTX)

  for (const template of SCRIPT_TEMPLATES) {
    it(`${template.label} sends a measurement, not a status`, () => {
      const script = rendered[template.id]!

      // The whole point of the shape: choosing a numeric widget must produce a
      // script that feeds it. A script that pushes only a status leaves the
      // chart empty while reporting success.
      expect(script, template.id).toMatch(/value/)
      expect(script, template.id).toContain('queue-depth')

      // The failure path still reports a status — a measurement that could not
      // be taken is a control that is down, and saying nothing would leave the
      // page showing the last good reading forever.
      expect(script.toLowerCase(), template.id).toContain('down')
    })

    it(`${template.label} names the unit it is measuring`, () => {
      // Otherwise the person editing `measure()` has to guess whether the
      // number is jobs, seconds or bytes.
      expect(rendered[template.id]!, template.id).toContain('Pending jobs')
    })
  }
})

describe('threshold defaults', () => {
  it('falls back to 500ms and 3000ms when a control sets none', () => {
    const script = renderTemplate('python', {
      baseUrl: 'https://s.example',
      controlKey: 'k',
      apiKey: 'tern_x',
    })
    expect(script).toContain('500')
    expect(script).toContain('3000')
  })
})

describe('syntactic validity', () => {
  /**
   * The substring assertions above passed while the Node template emitted
   * over-escaped backticks that would not parse. Checking the text says nothing
   * about whether the script runs — so the interpreters that are present are
   * asked to parse their own output.
   *
   * Skipped rather than failed when an interpreter is missing: contributors
   * should not need ten runtimes installed, and CI has them.
   */
  const CHECKS = [
    { id: 'node', command: 'node', args: ['--check'], ext: 'mjs' },
    { id: 'python', command: 'python3', args: ['-m', 'py_compile'], ext: 'py' },
    { id: 'bash', command: 'bash', args: ['-n'], ext: 'sh' },
    { id: 'php', command: 'php', args: ['-l'], ext: 'php' },
    { id: 'ruby', command: 'ruby', args: ['-c'], ext: 'rb' },
    { id: 'perl', command: 'perl', args: ['-c'], ext: 'pl' },
    { id: 'lua', command: 'luac', args: ['-p'], ext: 'lua' },
  ]

  for (const check of CHECKS) {
    it(`${check.id} parses`, async () => {
      const { spawnSync } = await import('node:child_process')
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')

      if (spawnSync(check.command, ['--version']).error) {
        // Interpreter absent on this machine.
        return
      }

      const dir = mkdtempSync(join(tmpdir(), 'tern-tpl-'))
      const file = join(dir, `check.${check.ext}`)

      try {
        writeFileSync(file, renderTemplate(check.id, CTX))
        const result = spawnSync(check.command, [...check.args, file], { encoding: 'utf8' })
        expect(result.status, `${check.id}: ${result.stderr || result.stdout}`.slice(0, 800)).toBe(
          0,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('generated scripts declare only what they read', () => {
  it('omits the latency thresholds from a value-shape script', () => {
    // A degraded threshold sitting in a script that never classifies latency is
    // an invitation to tune a number nothing consults.
    const rendered = renderAllTemplates(VALUE_CTX)

    for (const template of SCRIPT_TEMPLATES) {
      expect(rendered[template.id]!.toLowerCase(), template.id).not.toMatch(/degraded[_ ]?ms/)
    }
  })

  it('keeps them in a status-shape script, which classifies against them', () => {
    const rendered = renderAllTemplates(CTX)

    for (const template of SCRIPT_TEMPLATES) {
      expect(rendered[template.id]!.toLowerCase(), template.id).toMatch(/degraded[_ ]?ms/)
    }
  })
})

describe('the agent config', () => {
  it('carries the control probe, not a generic example', () => {
    const config = renderAgentConfig({
      baseUrl: 'https://status.example.com/',
      controlKey: 'api-gateway',
      apiKey: 'tern_key',
      probe: { type: 'http', url: 'https://example.com/health', followRedirects: true },
      downMs: 4000,
      degradedMs: 750,
    })

    expect(config).toContain('server = "https://status.example.com"')
    expect(config).toContain('[[probes]]')
    expect(config).toContain('control_key = "api-gateway"')
    // camelCase on the wire, snake_case in the file the agent parses.
    expect(config).toContain('follow_redirects = true')

    // A probe with no assertions calls a 500 healthy, so the thresholds the
    // operator already set are used rather than left out.
    // Not just the assertion's presence: an assertion whose bounds were dropped
    // constrains nothing while looking like it does.
    expect(config).toContain('type = "status_code"')
    expect(config).toContain('range = [200, 299]')
    expect(config).toContain('ms = 4000')
    expect(config).toContain('ms = 750')
  })

  it('comments the example for a push control instead of writing a probe it cannot run', () => {
    const config = renderAgentConfig({
      baseUrl: 'https://status.example.com',
      controlKey: 'backup',
      apiKey: 'tern_key',
    })

    // Uncommenting is a decision; a live probe nobody asked for is not.
    expect(config).not.toMatch(/^\[\[probes\]\]/m)
    expect(config).toContain('# [[probes]]')
  })

  it('gives a relay its own verb, from the same PIN', () => {
    /*
     * `init`, not `pair`. The proxy does more than exchange a code for a key: it
     * writes a config holding that key and the address it will listen on.
     *
     * The PIN is the same one, deliberately — the server decides which of the
     * two it is looking at from the version the binary announces — so an admin
     * who changes their mind after minting needs the other line, not another
     * code.
     */
    const pin = '4K7Q-92XB'
    expect(renderProxyInitCommand('https://status.example.com/', pin)).toBe(
      `tern-proxy init --server https://status.example.com --pin ${pin}`,
    )
    // The trailing slash goes, as it does for the agent: a doubled slash in a
    // command somebody pastes reads as a mistake even where it is harmless.
    expect(renderProxyInitCommand('https://status.example.com/', pin)).not.toContain('.com//')
    expect(renderProxyInitCommand('https://status.example.com')).toContain('--pin <PIN>')
  })

  it('keeps the PIN out of the pair command until one is minted', () => {
    expect(renderAgentPairCommand('https://status.example.com/')).toContain('--pin <PIN>')
    expect(renderAgentPairCommand('https://status.example.com', '4K7Q-92XB')).toContain(
      '--pin 4K7Q-92XB',
    )
  })
})
