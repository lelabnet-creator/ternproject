import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WIDGET,
  WIDGETS,
  dataKindOf,
  resolveOptions,
  seedFor,
  widgetById,
  widgetsFor,
} from './registry'

describe('the catalogue', () => {
  it('has unique ids and a stated purpose for each', () => {
    const ids = WIDGETS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const widget of WIDGETS) {
      // The gallery shows the purpose, not the id. A widget without one is a
      // widget nobody can choose deliberately.
      expect(widget.purpose.length).toBeGreaterThan(10)
      expect(widget.accepts.length).toBeGreaterThan(0)
    }
  })

  it('falls back rather than throwing on an unknown id', () => {
    // A widget removed in a future version must degrade to the one every
    // control already had, not blank a tenant's page.
    expect(widgetById('no-such-widget').id).toBe(DEFAULT_WIDGET)
    expect(widgetById(DEFAULT_WIDGET).id).toBe(DEFAULT_WIDGET)
  })
})

describe('compatibility', () => {
  it('hides numeric-only widgets from a status control', () => {
    const offered = widgetsFor('status', 'historical').map((o) => o.widget.id)
    expect(offered).not.toContain('value-bullet')
    expect(offered).toContain('uptime-ribbon')
  })

  it('explains rather than omits a widget the retention mode cannot feed', () => {
    // Both directions are marked, never dropped. Silently omitting leaves
    // someone wondering where the ribbon went and whether they imagined it.
    const ribbon = widgetsFor('status', 'live').find((o) => o.widget.id === 'uptime-ribbon')
    expect(ribbon?.unavailable).toMatch(/live mode/i)

    const live = widgetsFor('status', 'historical').find((o) => o.widget.id === 'live-sparkline')
    expect(live?.unavailable).toMatch(/live-mode/i)

    // And a compatible one carries no excuse.
    const ok = widgetsFor('status', 'historical').find((o) => o.widget.id === 'uptime-ribbon')
    expect(ok?.unavailable).toBeNull()
  })

  it('reads a control as numeric once it has a unit or a label', () => {
    expect(dataKindOf({})).toBe('status')
    expect(dataKindOf({ valueUnit: 'jobs' })).toBe('numeric')
    expect(dataKindOf({ valueLabel: 'Pending jobs' })).toBe('numeric')
  })
})

describe('payload shape', () => {
  it('gives every widget a payload it can actually be fed', () => {
    for (const widget of WIDGETS) {
      const payload = widget.mockPayload('api-gateway')
      expect(payload.controlKey).toBe('api-gateway')

      // This is the contract that keeps the generated script and the chosen
      // widget from disagreeing.
      if (widget.payloadShape === 'value') {
        expect(payload.value, widget.id).toBeTypeOf('number')
      } else {
        expect(payload.status, widget.id).toBeTypeOf('string')
      }
    }
  })

  it('gives numeric widgets a value payload', () => {
    const bullet = widgetById('value-bullet')
    expect(bullet.payloadShape).toBe('value')
    expect(bullet.mockPayload('queue-depth')).toEqual({ controlKey: 'queue-depth', value: 137 })
  })
})

describe('preview data', () => {
  it('produces a series for every widget without touching a database', () => {
    for (const widget of WIDGETS) {
      const series = widget.mockSeries(1234, resolveOptions(widget, {}))
      expect(series.length, widget.id).toBeGreaterThan(10)
    }
  })

  it('is deterministic, so a preview looks the same on every visit', () => {
    const widget = widgetById('uptime-ribbon')
    const options = resolveOptions(widget, {})
    const a = widget.mockSeries(99, options)
    const b = widget.mockSeries(99, options)
    expect(a.map((p) => p.status)).toEqual(b.map((p) => p.status))
  })

  it('derives a stable seed from the control key', () => {
    expect(seedFor('api-gateway')).toBe(seedFor('api-gateway'))
    expect(seedFor('api-gateway')).not.toBe(seedFor('cdn'))
  })
})

describe('options', () => {
  it('fills defaults for anything unset', () => {
    const widget = widgetById('value-bullet')
    expect(resolveOptions(widget, {})).toEqual({ warnAt: 200, limitAt: 400 })
    expect(resolveOptions(widget, { warnAt: 50 })).toEqual({ warnAt: 50, limitAt: 400 })
  })
})

describe('payload shape agrees with the generator', () => {
  it('matches what @tern/shared will produce for each widget', async () => {
    // The API generates scripts from the shared map; the gallery previews from
    // this registry. If they disagree, the editor shows one payload and the
    // script sends another — and nobody finds out until the chart stays empty.
    const { payloadShapeForWidget } = await import('@tern/shared/templates')

    for (const widget of WIDGETS) {
      expect(payloadShapeForWidget(widget.id), widget.id).toBe(widget.payloadShape)
    }
  })
})
