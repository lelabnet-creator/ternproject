import { describe, expect, it } from 'vitest'
import { SCRIPT_TEMPLATES, renderAllTemplates, renderTemplate } from './templates.js'

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
