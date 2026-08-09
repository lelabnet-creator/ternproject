import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ImportParseResult } from '@tern/shared/control-import'
import { adminApi, ApiError, type ImportOutcome } from '../../lib/adminApi'
import { Banner, Button, Card, CopyButton, Field, Textarea } from '../../components/ui'
import { byteLength, formatBytes, fromLocal, issuesFromError, type IssueRow } from './issues'

/**
 * Controls, created from a file.
 *
 * The editor is the right way to build one control and the wrong way to build
 * forty. Somebody moving off another tool, or standing up a second environment,
 * already has the list — and until this screen existed the only way to hand it
 * over was `curl`, even though the format, the parser and the endpoint had all
 * been finished for a while.
 *
 * ## Why it is a screen and not a panel
 *
 * A rejected file of forty controls produces a list of problems, each with a
 * line and a path, and above them sits the twenty-line field they refer to. The
 * inline panels elsewhere in the admin hold three fields and one error; this
 * would be squeezed into a corner of a page whose other half — the control cards
 * — is of no use while reading it. There are no modals in this product for the
 * reason `StatusPage.tsx` gives, so the way to take the whole width is to take
 * the whole screen, as `New control` does.
 *
 * ## Why it validates here as well as there
 *
 * `parseControlsFile` is pure by design: it reads no database and resolves no
 * group, so the identical check can run in this tab. That turns a misspelt
 * `timeout_ms` from a round trip into a keystroke's delay, which matters because
 * the file is applied as a unit — a person fixing six problems one request at a
 * time gives up around the third. The server still validates, and stays the
 * authority; this is a faster mirror of it, never a substitute.
 *
 * ## Why the parser is fetched rather than imported
 *
 * It brings `zod` and `yaml` with it, and every other admin screen would be
 * paying for them on first paint. Loaded on mount of this screen only, in its
 * own chunk. Until it lands the field simply has no local opinion — the buttons
 * work, and the server answers as it always did.
 */

/** The part of the shared modules this screen uses, named so it can be awaited. */
interface Parser {
  parseControlsFile: (source: string) => ImportParseResult
  MAX_IMPORT_BYTES: number
  /**
   * The format as a document a tool can read, not as prose.
   *
   * JSON Schema written as YAML, in the ASDF dialect — `%YAML 1.1`, a `$schema`
   * naming the metaschema, draft 4 underneath. Generated from the same Zod
   * object the endpoint validates with, so what this button hands out cannot
   * describe a format the server would refuse.
   */
  controlsFileYamlSchema: () => string
}

const EXAMPLE = `controls:
  - key: api.gateway
    name: API gateway
    group: Production
    kind: http
    config:
      url: https://example.com/health
      assertions:
        - type: status_code
          eq: 200
`

export function ImportScreen({
  slug,
  onCancel,
  onImported,
}: {
  slug: string
  onCancel: () => void
  onImported: (outcome: ImportOutcome) => void
}) {
  const [parser, setParser] = useState<Parser | null>(null)
  const [source, setSource] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [checked, setChecked] = useState<ImportParseResult | null>(null)
  const [serverIssues, setServerIssues] = useState<IssueRow[] | null>(null)
  const [preview, setPreview] = useState<ImportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // A failure here is not worth a message: it costs the local check, and the
    // server performs the same one on submit.
    void Promise.all([
      import('@tern/shared/control-import'),
      import('@tern/shared/yaml-schema'),
    ]).then(([parse, schema]) => {
      if (live) setParser({ ...parse, ...schema })
    })
    return () => {
      live = false
    }
  }, [])

  /*
   * Checked a beat after typing stops.
   *
   * Parsing a few hundred controls on every keystroke is work nobody sees the
   * result of, and a list of problems that rewrites itself mid-word is harder to
   * read than one that waits. The delay is short enough that it reads as
   * instant, and long enough that a line being typed is not judged half-written.
   */
  useEffect(() => {
    if (!parser) return
    if (source.trim() === '') {
      setChecked(null)
      return
    }
    const timer = setTimeout(() => setChecked(parser.parseControlsFile(source)), 250)
    return () => clearTimeout(timer)
  }, [parser, source])

  const size = useMemo(() => byteLength(source), [source])

  /** Anything the file says is now about text that is no longer there. */
  const replace = (next: string, name: string | null) => {
    setSource(next)
    setFileName(name)
    setServerIssues(null)
    setPreview(null)
    setError(null)
  }

  const run = useMutation({
    mutationFn: (dryRun: boolean) => adminApi.importControls(slug, source, dryRun),
    onMutate: () => {
      setServerIssues(null)
      setPreview(null)
      setError(null)
    },
    onSuccess: (outcome) => {
      if (outcome.dryRun) setPreview(outcome)
      else onImported(outcome)
    },
    onError: (err) => {
      // A list when the file is at fault, a sentence when the tenant is: an
      // ambiguous group name or a foreign groupId is nothing the file can show.
      const issues = issuesFromError(err)
      if (issues) setServerIssues(issues)
      else setError(err instanceof ApiError ? err.message : String(err))
    },
  })

  const localIssues = checked && !checked.ok ? fromLocal(checked.issues) : null
  const issues = serverIssues ?? localIssues
  const count = checked?.ok ? checked.controls.length : null
  const empty = source.trim() === ''
  const blocked = empty || run.isPending || localIssues !== null

  const openFile = async (file: File) => {
    if (parser && file.size > parser.MAX_IMPORT_BYTES) {
      replace('', null)
      setError(
        `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(parser.MAX_IMPORT_BYTES)} limit. Split it into several imports.`,
      )
      return
    }
    replace(await file.text(), file.name)
  }

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Import controls from YAML</h1>
        <Button onClick={onCancel}>Back to controls</Button>
      </div>

      <p
        style={{
          margin: 0,
          maxWidth: '46rem',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-fg-muted)',
        }}
      >
        A file of controls is applied as a unit and keyed by <code>key</code>: a control the file
        names is created or updated, one it does not name is left alone, and so is any field it
        leaves out. Importing the same file twice changes nothing the second time. The format is
        written out in <code>docs/import.md</code>.
      </p>

      <Field
        label="From a file"
        hint="Reads it into the box below, where you can still change it before importing."
      >
        <input
          type="file"
          accept=".yaml,.yml,text/yaml,application/yaml"
          style={{ fontSize: 'var(--text-sm)' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void openFile(file)
            // Cleared so that picking the same file again, after editing the
            // box, still fires a change and reloads it.
            e.target.value = ''
          }}
        />
      </Field>

      {/* Above the box rather than inside the Field, which is a <label>: a
          button in there would compete with the textarea for the click. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        {/* Absent for the instant before the module lands, rather than present
            and copying nothing — a copy button that silently yields an empty
            clipboard is discovered at the paste, somewhere else. */}
        {parser && <CopyButton value={parser.controlsFileYamlSchema()} label="Copy the schema" />}
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
          JSON Schema, written as YAML, for an editor or a CI job. Generated from the same
          definition this page validates with.
        </span>
      </div>

      <Field label="YAML" hint="Paste the file, or load one above.">
        <Textarea
          value={source}
          rows={20}
          spellCheck={false}
          placeholder={EXAMPLE}
          onChange={(e) => replace(e.target.value, null)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        />
      </Field>

      <p
        className="tabular"
        style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
      >
        {[
          fileName,
          count === null ? null : `${count} control${count === 1 ? '' : 's'}`,
          empty ? null : formatBytes(size),
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing to import yet.'}
      </p>

      {error && <Banner tone="down">{error}</Banner>}

      {issues && <IssueList rows={issues} fromServer={serverIssues !== null} />}

      {preview && <Preview outcome={preview} />}

      <div className="form-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          onClick={() => run.mutate(true)}
          disabled={blocked}
          busy={run.isPending && run.variables === true}
        >
          Preview
        </Button>
        <Button
          variant="primary"
          onClick={() => run.mutate(false)}
          disabled={blocked}
          busy={run.isPending && run.variables === false}
        >
          {preview ? `Import these ${preview.controls.length}` : 'Import'}
        </Button>
      </div>
    </section>
  )
}

/**
 * The problems, one per entry, laid out rather than run together.
 *
 * `formatImportIssue` would give each of these as a single line, which is the
 * right shape for a log. On a screen the four parts have different jobs — where
 * it is, what is wrong, what was found, what was expected — and stacking them
 * lets the eye go down the column of line numbers first, which is the order the
 * fixing actually happens in.
 */
export function IssueList({ rows, fromServer }: { rows: IssueRow[]; fromServer: boolean }) {
  return (
    <Card style={{ borderLeft: '3px solid var(--status-down)' }}>
      <p role="alert" style={{ margin: 0, fontWeight: 600, fontSize: 'var(--text-sm)' }}>
        {rows.length === 1 ? 'One problem in the file.' : `${rows.length} problems in the file.`}{' '}
        {/* Two different facts: one is a refusal that already happened, the
            other is a warning about a request not yet made. */}
        {fromServer
          ? 'Nothing was imported.'
          : rows.length === 1
            ? 'Fix it before importing.'
            : 'Fix these before importing.'}
      </p>
      <ol
        style={{
          display: 'grid',
          gap: 'var(--space-3)',
          listStyle: 'none',
          padding: 0,
          margin: 'var(--space-3) 0 0',
        }}
      >
        {rows.map((row, index) => (
          <li key={`${row.path}:${row.line ?? '?'}:${index}`}>
            <div
              className="tabular"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              {[row.line === null ? null : `line ${row.line}`, row.path || null]
                .filter(Boolean)
                .join(' · ') || 'in the file'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)' }}>{row.message}</div>
            {(row.received !== undefined || row.expected !== undefined) && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-muted)' }}>
                {[
                  row.received === undefined ? null : `found ${row.received}`,
                  row.expected === undefined ? null : `expected ${row.expected}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}

/**
 * What the file would do, obtained by asking the server to do it and stop.
 *
 * The counts alone would answer "is this the right file"; the list answers "is
 * this the right *change*", which is the question somebody re-importing a file
 * they have edited is actually asking. `updated` is the row worth reading twice:
 * it is the one that changes something that already exists.
 */
export function Preview({ outcome }: { outcome: ImportOutcome }) {
  return (
    <Card>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--text-sm)' }}>
        Preview — nothing was written
      </p>
      <p
        className="tabular"
        style={{
          margin: 'var(--space-1) 0 var(--space-3)',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-fg-muted)',
        }}
      >
        {outcome.created} created · {outcome.updated} updated ·{' '}
        {outcome.groupsCreated === 1 ? '1 folder' : `${outcome.groupsCreated} folders`} created
      </p>
      <ul
        style={{
          display: 'grid',
          gap: 'var(--space-1)',
          listStyle: 'none',
          padding: 0,
          margin: 0,
          // A long list scrolls in its own box rather than pushing the buttons
          // off the bottom of the screen.
          maxHeight: '20rem',
          overflowY: 'auto',
          fontSize: 'var(--text-sm)',
        }}
      >
        {outcome.controls.map((control) => (
          <li key={control.key} style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <span
              style={{
                width: '5rem',
                flexShrink: 0,
                color:
                  control.action === 'created'
                    ? 'var(--status-operational)'
                    : 'var(--color-fg-subtle)',
              }}
            >
              {control.action}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
              {control.key}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
