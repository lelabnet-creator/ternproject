import type { ComponentType } from 'react'
// Narrow imports, not the barrel: `@tern/shared` re-exports server-only crypto
// and would drag a native module into the browser bundle.
import { createRng, generateMockSeries, type MockPoint } from '@tern/shared/mock'
import type { CheckStatusValue } from '@tern/shared/status'
import { UptimeRibbon } from './UptimeRibbon'
import { StatusSwimlane } from './StatusSwimlane'
import { AvailabilityCalendar } from './AvailabilityCalendar'
import { LatencyBand } from './LatencyBand'
import { ValueBullet } from './ValueBullet'
import { LiveSparkline } from './LiveSparkline'
import { StatTile } from './StatTile'

/**
 * The widget catalogue.
 *
 * One registry, consumed by both the editor's gallery and the public page. Two
 * lists would drift: a widget would appear in the gallery, be chosen, and then
 * render as something else — or as nothing.
 *
 * Each entry carries everything either consumer needs, including the shape of
 * the payload it expects. That last part is what keeps the generated scripts and
 * the chosen widget from disagreeing: the script pushes what the widget reads.
 */

/** What kind of measurement a widget can represent. */
export type DataKind = 'status' | 'numeric'

/** What a script must POST for this widget to have anything to draw. */
export type PayloadShape = 'status' | 'value'

export interface WidgetOption {
  key: string
  label: string
  type: 'number' | 'select' | 'boolean' | 'text'
  default: string | number | boolean
  choices?: { value: string; label: string }[]
  min?: number
  max?: number
}

/** Everything a widget receives, whether from real data or from a mock. */
export interface WidgetProps {
  label: string
  locale: string
  timeZone: string
  options: Record<string, unknown>
  series: MockPoint[]
  unit?: string | null
  valueLabel?: string | null
  warnAt?: number | null
  limitAt?: number | null
}

/**
 * One field a widget reads, described well enough to act on.
 *
 * The payload panel used to show the same three-line example for every widget,
 * which answered "what does a point look like" and not the question anyone
 * actually has: *which* fields does this chart consume, what units, what values
 * are allowed, and what happens if I leave one out. A widget that draws a state
 * and one that draws a queue depth were indistinguishable.
 */
export interface FieldSpec {
  /** As it appears in the JSON body. */
  field: string
  kind: 'status' | 'number' | 'integer' | 'text' | 'timestamp'
  /** Whether the widget can draw anything without it. */
  required: boolean
  /** What the number is measured in, when it is fixed. */
  unit?: string
  /** The complete set of accepted values, when there is one. */
  values?: readonly string[]
  /** One line: what this widget does with it. */
  use: string
}

/** Every status a point may carry. Repeated in the contract, not just typed. */
export const CHECK_STATUSES = [
  'operational',
  'degraded',
  'partial',
  'down',
  'maintenance',
  'unknown',
] as const

/** The three fields nearly every widget shares, described once. */
const CONTROL_KEY: FieldSpec = {
  field: 'controlKey',
  kind: 'text',
  required: true,
  use: 'Which control this point belongs to. Must match the key on the server.',
}

const TIMESTAMP: FieldSpec = {
  field: 'ts',
  kind: 'timestamp',
  required: false,
  use: 'When it was measured, ISO 8601. Defaults to arrival; send it if the point was queued.',
}

const STATUS_FIELD = (use: string): FieldSpec => ({
  field: 'status',
  kind: 'status',
  required: true,
  values: CHECK_STATUSES,
  use,
})

const LATENCY_FIELD = (use: string, required = false): FieldSpec => ({
  field: 'latencyMs',
  kind: 'integer',
  required,
  unit: 'ms',
  use,
})

const METRIC_FIELD = (use: string): FieldSpec => ({
  field: 'metrics.<name>',
  kind: 'number',
  required: false,
  use,
})

export interface WidgetDefinition {
  id: string
  label: string
  /**
   * A Lucide icon name, so a card can say which chart it uses at a glance.
   *
   * Shape carries the distinction, not hue: a set of coloured chips for widget
   * types would be a second categorical palette on a page that already has the
   * status one, and two palettes on one screen is how a violet "sparkline" chip
   * starts being read as a state.
   */
  icon: string
  /** Which chip colour the editor and the controls list draw it in. */
  chip: 'rose' | 'amber' | 'mint' | 'blue' | 'deep'
  /** One sentence: the question this widget answers. Shown in the gallery. */
  purpose: string
  accepts: DataKind[]
  /** Some widgets are meaningless without history, others only make sense live. */
  requires: 'history' | 'live' | 'any'
  payloadShape: PayloadShape
  /** Exactly which fields this widget consumes. Shown as its contract. */
  reads: FieldSpec[]
  options: WidgetOption[]
  /** Deterministic sample data, so a preview never touches the database. */
  mockSeries(seed: number, options: Record<string, unknown>): MockPoint[]
  /** The exact JSON a generated script would POST for this widget. */
  mockPayload(controlKey: string): Record<string, unknown>
  Component: ComponentType<WidgetProps>
}

// ── Shared mock generators ──────────────────────────────────────────────────

const DAY_MS = 86_400_000

function statusSeries(seed: number, days: number, intervalS: number): MockPoint[] {
  const to = new Date()
  return generateMockSeries({
    seed,
    from: new Date(to.getTime() - days * DAY_MS),
    to,
    intervalS,
    targetUptime: 0.997,
    baseLatencyMs: 140,
    incidents: Math.max(1, Math.round(days / 20)),
  })
}

function valueSeries(seed: number, days: number, intervalS: number): MockPoint[] {
  const to = new Date()
  return generateMockSeries({
    seed,
    from: new Date(to.getTime() - days * DAY_MS),
    to,
    intervalS,
    targetUptime: 0.999,
    incidents: 1,
    valueMode: { base: 140, amplitude: 60 },
  })
}

// ── Adapters ────────────────────────────────────────────────────────────────
//
// Each widget takes the props that suit it; these thin wrappers translate the
// common WidgetProps into that shape. Keeping the charts free of the registry's
// vocabulary means they stay usable on their own.

const RibbonAdapter: ComponentType<WidgetProps> = ({
  series,
  label,
  locale,
  timeZone,
  options,
}) => {
  const windowDays = Number(options.windowDays ?? 90)
  return UptimeRibbon({ days: toDays(series), windowDays, locale, timeZone, label })
}

const SwimlaneAdapter: ComponentType<WidgetProps> = ({ series, label, locale, timeZone }) =>
  StatusSwimlane({
    points: series.map((p) => ({ ts: p.ts.toISOString(), status: p.status })),
    locale,
    timeZone,
    label,
  })

const CalendarAdapter: ComponentType<WidgetProps> = ({ series, label, locale, timeZone }) =>
  AvailabilityCalendar({ days: toDays(series), locale, timeZone, label })

const LatencyAdapter: ComponentType<WidgetProps> = ({ series, label }) =>
  LatencyBand({ points: toLatencyBands(series), label })

const BulletAdapter: ComponentType<WidgetProps> = ({
  series,
  valueLabel,
  unit,
  warnAt,
  limitAt,
  options,
}) => {
  const read = numberReader(options)
  const latest = series[series.length - 1]
  const peak = Math.max(...series.map((p) => read(p) ?? 0))
  return ValueBullet({
    value: latest ? read(latest) : null,
    unit,
    label: valueLabel,
    warnAt,
    limitAt,
    peak,
  })
}

const SparklineAdapter: ComponentType<WidgetProps> = ({ series, label, options }) => {
  const read = numberReader(options)
  const points = series.slice(-Number(options.samples ?? 60))
  return LiveSparkline({
    points: points.map((p) => ({
      ts: p.ts.toISOString(),
      value: read(p) ?? p.latencyMs ?? 0,
      status: p.status,
    })),
    label,
  })
}

/**
 * Which number a widget draws.
 *
 * `value` is the default because it is what every existing control sends. A
 * widget configured with a metric name reads `metrics.<name>` instead — that is
 * what lets one control report a queue depth *and* a latency and have each
 * charted, rather than forcing a choice between the two fields the schema
 * happened to name first.
 *
 * A named metric that is absent from a point falls back to `value` rather than
 * to zero: an empty chart says "no data", a chart of zeroes says "the queue is
 * empty", and only one of those is true.
 */
function numberReader(options: Record<string, unknown>): (point: MockPoint) => number | null {
  const name = String(options.metric ?? '').trim()
  if (!name) return (point) => point.value

  return (point) => point.metrics?.[name] ?? point.value
}

const TileAdapter: ComponentType<WidgetProps> = ({ series, options, unit, valueLabel }) => {
  const metric = String(options.metric ?? 'uptime')
  const latest = series[series.length - 1]

  if (metric === 'value') {
    return StatTile({
      value: formatNumber(latest?.value ?? latest?.latencyMs ?? 0),
      unit,
      caption: valueLabel ?? 'Latest reading',
      status: latest?.status,
      trend: series.slice(-24).map((p) => p.value ?? p.latencyMs ?? 0),
    })
  }

  const withData = series.filter((p) => p.status !== 'unknown')
  const ok = withData.filter((p) => p.status === 'operational').length
  const uptime = withData.length ? (ok / withData.length) * 100 : 0

  return StatTile({
    value: uptime.toFixed(2),
    unit: '%',
    caption: `Uptime over ${Math.round(series.length / 288)} days`,
    status: latest?.status,
  })
}

// ── The catalogue ───────────────────────────────────────────────────────────

export const WIDGETS: readonly WidgetDefinition[] = [
  {
    id: 'uptime-ribbon',
    icon: 'AlignJustify',
    chip: 'blue',
    label: 'Uptime ribbon',
    purpose: 'Which days were bad, at a glance.',
    accepts: ['status'],
    requires: 'history',
    payloadShape: 'status',
    reads: [
      CONTROL_KEY,
      STATUS_FIELD('One bar per day, coloured by the worst status seen that day.'),
      LATENCY_FIELD('Not drawn, but stored — switch to the latency band to see it.'),
      TIMESTAMP,
    ],
    options: [
      {
        key: 'windowDays',
        label: 'Days shown',
        type: 'select',
        default: 90,
        choices: [
          { value: '30', label: '30 days' },
          { value: '60', label: '60 days' },
          { value: '90', label: '90 days' },
        ],
      },
    ],
    mockSeries: (seed, options) => statusSeries(seed, Number(options.windowDays ?? 90), 3600),
    mockPayload: (controlKey) => ({ controlKey, status: 'operational', latencyMs: 142 }),
    Component: RibbonAdapter,
  },
  {
    id: 'status-swimlane',
    icon: 'GanttChart',
    chip: 'deep',
    label: 'Status timeline',
    purpose: 'When exactly it was down, to the minute.',
    accepts: ['status'],
    requires: 'history',
    payloadShape: 'status',
    reads: [
      CONTROL_KEY,
      STATUS_FIELD('Consecutive points of the same status merge into one band.'),
      TIMESTAMP,
    ],
    options: [
      {
        key: 'windowDays',
        label: 'Window',
        type: 'select',
        default: 7,
        choices: [
          { value: '1', label: '24 hours' },
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
        ],
      },
    ],
    mockSeries: (seed, options) => statusSeries(seed, Number(options.windowDays ?? 7), 900),
    mockPayload: (controlKey) => ({ controlKey, status: 'degraded', latencyMs: 812 }),
    Component: SwimlaneAdapter,
  },
  {
    id: 'availability-calendar',
    icon: 'CalendarDays',
    chip: 'rose',
    label: 'Availability calendar',
    purpose: 'Whether there is a pattern — a bad weekday, a bad week of the month.',
    accepts: ['status'],
    requires: 'history',
    payloadShape: 'status',
    reads: [
      CONTROL_KEY,
      STATUS_FIELD('One cell per day; the worst status of the day wins.'),
      TIMESTAMP,
    ],
    options: [],
    mockSeries: (seed) => statusSeries(seed, 180, 3600),
    mockPayload: (controlKey) => ({ controlKey, status: 'operational', latencyMs: 96 }),
    Component: CalendarAdapter,
  },
  {
    id: 'latency-band',
    icon: 'AreaChart',
    chip: 'blue',
    label: 'Response time band',
    purpose: 'Whether it is slow, and for how many people.',
    accepts: ['status', 'numeric'],
    requires: 'history',
    payloadShape: 'status',
    reads: [
      CONTROL_KEY,
      LATENCY_FIELD('The series itself: p50, p95 and p99 are computed from it.', true),
      STATUS_FIELD('Points that are down are excluded, so an outage does not inflate p99.'),
      TIMESTAMP,
    ],
    options: [
      {
        key: 'windowDays',
        label: 'Window',
        type: 'select',
        default: 7,
        choices: [
          { value: '1', label: '24 hours' },
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
        ],
      },
    ],
    mockSeries: (seed, options) => statusSeries(seed, Number(options.windowDays ?? 7), 900),
    mockPayload: (controlKey) => ({ controlKey, status: 'operational', latencyMs: 142 }),
    Component: LatencyAdapter,
  },
  {
    id: 'value-bullet',
    icon: 'Gauge',
    chip: 'mint',
    label: 'Value against limits',
    purpose: 'A measurement, and how close it is to the line that matters.',
    accepts: ['numeric'],
    requires: 'any',
    payloadShape: 'value',
    reads: [
      CONTROL_KEY,
      {
        field: 'value',
        kind: 'number',
        required: true,
        use: 'The measurement, drawn against the warn and limit thresholds below.',
      },
      METRIC_FIELD('An alternative source: set “Metric” below to read metrics.<name> instead.'),
      TIMESTAMP,
    ],
    options: [
      { key: 'metric', label: 'Metric (blank = value)', type: 'text', default: '' },
      { key: 'warnAt', label: 'Warn above', type: 'number', default: 200 },
      { key: 'limitAt', label: 'Critical above', type: 'number', default: 400 },
    ],
    mockSeries: (seed) => valueSeries(seed, 1, 900),
    mockPayload: (controlKey) => ({ controlKey, value: 137 }),
    Component: BulletAdapter,
  },
  {
    id: 'live-sparkline',
    icon: 'Activity',
    chip: 'amber',
    label: 'Live stream',
    purpose: 'What is happening right now, for a tenant keeping no history.',
    accepts: ['status', 'numeric'],
    requires: 'live',
    payloadShape: 'value',
    reads: [
      CONTROL_KEY,
      {
        field: 'value',
        kind: 'number',
        required: true,
        use: 'Plotted as it arrives, over the recent window.',
      },
      METRIC_FIELD('An alternative source: set “Metric” below to read metrics.<name> instead.'),
      TIMESTAMP,
    ],
    options: [
      { key: 'metric', label: 'Metric (blank = value)', type: 'text', default: '' },
      { key: 'samples', label: 'Samples shown', type: 'number', default: 60, min: 10, max: 300 },
    ],
    mockSeries: (seed) => valueSeries(seed, 1, 300),
    mockPayload: (controlKey) => ({ controlKey, value: 137 }),
    Component: SparklineAdapter,
  },
  {
    id: 'stat-tile',
    icon: 'Hash',
    chip: 'mint',
    label: 'Single number',
    purpose: 'One figure, large. Sometimes the right answer is not a chart.',
    accepts: ['status', 'numeric'],
    requires: 'any',
    payloadShape: 'status',
    reads: [
      CONTROL_KEY,
      STATUS_FIELD('The headline word and its colour.'),
      LATENCY_FIELD('Shown beneath the status when present.'),
      {
        field: 'value',
        kind: 'number',
        required: false,
        use: 'Shown instead of the latency when the control has a value label.',
      },
    ],
    options: [
      {
        key: 'metric',
        label: 'Show',
        type: 'select',
        default: 'uptime',
        choices: [
          { value: 'uptime', label: 'Uptime percentage' },
          { value: 'value', label: 'Latest reading' },
        ],
      },
    ],
    mockSeries: (seed, options) =>
      options.metric === 'value' ? valueSeries(seed, 7, 3600) : statusSeries(seed, 30, 3600),
    mockPayload: (controlKey) => ({ controlKey, status: 'operational', latencyMs: 142 }),
    Component: TileAdapter,
  },
]

export const DEFAULT_WIDGET = 'uptime-ribbon'

export function widgetById(id: string): WidgetDefinition {
  // Falls back rather than throwing: a widget removed in a future version must
  // not blank a tenant's page, it must degrade to the one every control had.
  return WIDGETS.find((w) => w.id === id) ?? WIDGETS[0]!
}

/**
 * The widgets offered for a given control, in gallery order.
 *
 * Incompatible ones are filtered out entirely; ones that need history the tenant
 * does not keep are returned marked, so the gallery can explain rather than
 * silently omit them.
 */
export function widgetsFor(
  dataKind: DataKind,
  retentionMode: 'live' | 'historical',
): { widget: WidgetDefinition; unavailable: string | null }[] {
  return WIDGETS.filter((w) => w.accepts.includes(dataKind)).map((widget) => {
    if (widget.requires === 'history' && retentionMode === 'live') {
      return { widget, unavailable: 'Needs history — this page is in live mode.' }
    }
    if (widget.requires === 'live' && retentionMode === 'historical') {
      return { widget, unavailable: 'For live-mode pages only.' }
    }
    return { widget, unavailable: null }
  })
}

/** A control reports a measurement when it has been given a unit or a label. */
export function dataKindOf(control: {
  valueUnit?: string | null
  valueLabel?: string | null
}): DataKind {
  return control.valueUnit || control.valueLabel ? 'numeric' : 'status'
}

export function resolveOptions(
  widget: WidgetDefinition,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const option of widget.options) {
    resolved[option.key] = stored[option.key] ?? option.default
  }
  return resolved
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toDays(series: MockPoint[]) {
  const byDay = new Map<string, { ok: number; total: number; worst: CheckStatusValue }>()

  for (const point of series) {
    const key = point.ts.toISOString().slice(0, 10)
    const entry = byDay.get(key) ?? { ok: 0, total: 0, worst: 'operational' as CheckStatusValue }
    entry.total++
    if (point.status === 'operational') entry.ok++
    // A day takes its worst moment, matching how the API aggregates it — the
    // preview must not flatter what the real page will show.
    if (rank(point.status) > rank(entry.worst)) entry.worst = point.status
    byDay.set(key, entry)
  }

  return [...byDay.entries()].map(([day, entry]) => ({
    day,
    uptimePct: entry.total ? (entry.ok / entry.total) * 100 : null,
    samples: entry.total,
    worstStatus: entry.worst,
  }))
}

function rank(status: CheckStatusValue): number {
  return ['operational', 'maintenance', 'unknown', 'degraded', 'partial', 'down'].indexOf(status)
}

/**
 * Percentiles for the preview, derived from the mock rather than from the
 * aggregates. The real chart reads rolled-up sketches; a preview only has to be
 * shaped like the truth.
 */
function toLatencyBands(series: MockPoint[]) {
  const buckets = new Map<string, number[]>()

  for (const point of series) {
    if (point.latencyMs === null) continue
    const key = point.ts.toISOString().slice(0, 13)
    const list = buckets.get(key) ?? []
    list.push(point.latencyMs)
    buckets.set(key, list)
  }

  return [...buckets.entries()].map(([hour, values]) => {
    const sorted = values.sort((a, b) => a - b)
    return {
      ts: `${hour}:00:00Z`,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    }
  })
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q))
  return sorted[index] ?? 0
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** Stable seed per control, so a preview looks the same on every visit. */
export function seedFor(controlKey: string): number {
  const rng = createRng(
    [...controlKey].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7),
  )
  return Math.floor(rng() * 100_000)
}
