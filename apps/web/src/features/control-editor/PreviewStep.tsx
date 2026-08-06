import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  WIDGETS,
  dataKindOf,
  resolveOptions,
  seedFor,
  widgetById,
  widgetsFor,
  type WidgetDefinition,
} from '../../charts/registry'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, Field } from '../../components/ui'

/**
 * Step 2 of the editor: choose how this control is drawn, and see what a script
 * has to send for that drawing to have anything in it.
 *
 * Three panels rather than one, because they answer three different questions:
 * *which* widget, *how* it is configured, and *what data* it consumes. The third
 * is the one that was missing — the editor could promise a visualisation the
 * script it later generates would never feed.
 */
export function PreviewStep({
  slug,
  control,
  retentionMode,
  onSaved,
}: {
  slug: string
  control: Control
  retentionMode: 'live' | 'historical'
  onSaved: (widget: string, options: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()

  const dataKind = dataKindOf(control)
  const offered = useMemo(() => widgetsFor(dataKind, retentionMode), [dataKind, retentionMode])

  const [selectedId, setSelectedId] = useState(control.widget)
  const [options, setOptions] = useState<Record<string, unknown>>(() =>
    resolveOptions(widgetById(control.widget), control.widgetOptions),
  )
  const [error, setError] = useState<string | null>(null)

  const widget = widgetById(selectedId)
  const seed = seedFor(control.key)

  const save = useMutation({
    mutationFn: () =>
      adminApi.updateControl(slug, control.id, { widget: selectedId, widgetOptions: options }),
    onSuccess: () => {
      setError(null)
      onSaved(selectedId, options)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const choose = (definition: WidgetDefinition) => {
    setSelectedId(definition.id)
    // Options belong to the widget, not to the control: carrying a ribbon's
    // window count over to a bullet chart would silently apply a setting the
    // new widget does not have.
    setOptions(resolveOptions(definition, {}))
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {error && <Banner tone="down">{error}</Banner>}

      {dataKind === 'status' && (
        <Banner tone="maintenance">
          This control reports a state. Give it a value label and unit in step 1 to unlock the
          widgets that draw a measurement.
        </Banner>
      )}

      {/* ── Gallery ─────────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>
          Choose a visualisation
        </h2>

        <div
          style={{
            display: 'grid',
            gap: 'var(--space-3)',
            gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))',
          }}
        >
          {offered.map(({ widget: definition, unavailable }) => {
            const selected = definition.id === selectedId
            const preview = definition.mockSeries(seed, resolveOptions(definition, {}))

            return (
              <button
                key={definition.id}
                type="button"
                onClick={() => !unavailable && choose(definition)}
                disabled={Boolean(unavailable)}
                aria-pressed={selected}
                style={{
                  textAlign: 'left',
                  display: 'block',
                  width: '100%',
                  height: 'auto',
                  padding: 'var(--space-3)',
                  background: selected ? 'var(--color-surface-raised)' : 'var(--color-surface)',
                  border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  cursor: unavailable ? 'not-allowed' : 'pointer',
                  opacity: unavailable ? 0.55 : 1,
                  fontFamily: 'inherit',
                  color: 'var(--color-fg)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                  {definition.label}
                </div>
                <div
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--color-fg-subtle)',
                    margin: 'var(--space-1) 0 var(--space-3)',
                  }}
                >
                  {definition.purpose}
                </div>

                {/* Rendered with its own sample data. One chooses on what one
                    sees, not on a name. */}
                <div style={{ pointerEvents: 'none' }}>
                  <definition.Component
                    label={control.name}
                    locale="en"
                    timeZone="UTC"
                    options={resolveOptions(definition, {})}
                    series={preview}
                    unit={control.valueUnit}
                    valueLabel={control.valueLabel}
                    warnAt={Number(resolveOptions(definition, {}).warnAt ?? 0) || null}
                    limitAt={Number(resolveOptions(definition, {}).limitAt ?? 0) || null}
                  />
                </div>

                {unavailable && (
                  <div
                    style={{
                      marginTop: 'var(--space-2)',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--status-degraded)',
                      fontWeight: 600,
                    }}
                  >
                    {unavailable}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Options ─────────────────────────────────────────────────────── */}
      {widget.options.length > 0 && (
        <Card>
          <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Options</h2>
          <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: '1fr 1fr' }}>
            {widget.options.map((option) => (
              <Field key={option.key} label={option.label}>
                {option.type === 'select' ? (
                  <select
                    value={String(options[option.key] ?? option.default)}
                    onChange={(e) => setOptions({ ...options, [option.key]: e.target.value })}
                    style={selectStyle}
                  >
                    {option.choices?.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                ) : option.type === 'text' ? (
                  <input
                    type="text"
                    value={String(options[option.key] ?? option.default)}
                    onChange={(e) => setOptions({ ...options, [option.key]: e.target.value })}
                    style={selectStyle}
                  />
                ) : (
                  <input
                    type="number"
                    value={Number(options[option.key] ?? option.default)}
                    min={option.min}
                    max={option.max}
                    onChange={(e) =>
                      setOptions({ ...options, [option.key]: Number(e.target.value) })
                    }
                    style={selectStyle}
                  />
                )}
              </Field>
            ))}
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
              {t('chart.widgetPreview')}
            </h3>
            <widget.Component
              label={control.name}
              locale="en"
              timeZone="UTC"
              options={options}
              series={widget.mockSeries(seed, options)}
              unit={control.valueUnit}
              valueLabel={control.valueLabel}
              warnAt={Number(options.warnAt ?? 0) || null}
              limitAt={Number(options.limitAt ?? 0) || null}
            />
          </div>
        </Card>
      )}

      {/* ── Payload ─────────────────────────────────────────────────────── */}
      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          What this widget is fed
        </h2>
        <p
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          Every script generated in the next step pushes exactly this shape. Choosing a widget
          chooses the payload — they cannot disagree.
        </p>

        <CodeBlock label="POST /api/v1/ingest">
          {JSON.stringify(widget.mockPayload(control.key), null, 2)}
        </CodeBlock>

        <FieldContract widget={widget} unit={control.valueUnit} />
      </Card>

      <div>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          Save visualisation
        </Button>
      </div>
    </div>
  )
}

/**
 * What this widget actually consumes, field by field.
 *
 * The example above shows one valid point; this says which parts of it matter,
 * what the units are, which values are accepted, and what is optional. Those are
 * the questions someone writing the push has, and an example answers none of
 * them — every widget's example looked alike, so the panel appeared identical
 * whichever chart was chosen.
 */
function FieldContract({ widget, unit }: { widget: WidgetDefinition; unit: string | null }) {
  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>Fields it reads</h3>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 'var(--text-sm)',
            minWidth: '34rem',
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--color-fg-subtle)' }}>
              <th style={cell}>Field</th>
              <th style={cell}>Type</th>
              <th style={cell}>Accepts</th>
              <th style={cell}>What it does with it</th>
            </tr>
          </thead>
          <tbody>
            {widget.reads.map((spec) => (
              <tr key={spec.field} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={cell}>
                  <code>{spec.field}</code>
                  {/* Required is stated, not implied by omission: a chart that
                      silently draws nothing is the failure this prevents. */}
                  {spec.required ? (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 'var(--text-xs)',
                        fontWeight: 700,
                        color: 'var(--status-down)',
                      }}
                    >
                      required
                    </span>
                  ) : (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg-subtle)',
                      }}
                    >
                      optional
                    </span>
                  )}
                </td>
                <td style={cell}>{spec.kind}</td>
                <td style={cell}>
                  {spec.values ? (
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                      {spec.values.map((value) => (
                        <code key={value} style={{ fontSize: 'var(--text-xs)' }}>
                          {value}
                        </code>
                      ))}
                    </span>
                  ) : spec.unit ? (
                    `any number, in ${spec.unit}`
                  ) : spec.kind === 'number' || spec.kind === 'integer' ? (
                    unit ? (
                      `any number, in ${unit}`
                    ) : (
                      'any number'
                    )
                  ) : spec.kind === 'timestamp' ? (
                    'ISO 8601'
                  ) : (
                    'text'
                  )}
                </td>
                <td style={{ ...cell, color: 'var(--color-fg-muted)' }}>{spec.use}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p
        style={{
          margin: 'var(--space-3) 0 0',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        Any point may also carry <code>metrics</code>, a map of named numbers — send a queue depth
        beside a latency rather than choosing one. Names must start with a letter; at most 25 per
        point.
      </p>
    </div>
  )
}

const cell: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  verticalAlign: 'top',
  fontWeight: 'inherit',
}

const selectStyle: React.CSSProperties = {
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  minHeight: 44,
  width: '100%',
}

export { WIDGETS }
