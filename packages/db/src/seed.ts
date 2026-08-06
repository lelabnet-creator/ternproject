import { eq, inArray } from 'drizzle-orm'
import { generateMockSeries, generateToken, hashPassword, hashToken } from '@tern/shared'
import { createDatabase } from './client.js'
import { loadEnv } from './env.js'
import * as s from './schema/index.js'

loadEnv()

/**
 * Demo data for `pnpm db:seed`.
 *
 * Everything here is deterministic: the same seed produces the same 90 days on
 * every machine, so a screenshot, a bug report and a test all describe the same
 * history. The one exception is generated credentials, which must never be
 * predictable and are printed once at the end.
 */

const DAYS = 90
const INTERVAL_S = 300 // one sample per 5 minutes — 90 days × 12 controls ≈ 311k rows

const DEMO_PASSWORD = 'tern-demo-password'
const DEMO_ADMIN_EMAIL = 'admin@acme.example'
const DEMO_USER_EMAIL = 'user@acme.example'
const DEMO_EMAILS = [DEMO_ADMIN_EMAIL, DEMO_USER_EMAIL]

interface ControlSpec {
  key: string
  name: string
  description: string
  group: string
  isPublic?: boolean
  baseLatencyMs?: number
  targetUptime?: number
  incidents?: number
  slaTarget?: number
  value?: { base: number; amplitude: number; unit: string; label: string }
}

const GROUPS = [
  { key: 'edge', name: 'Edge & delivery', parent: null },
  { key: 'core', name: 'Core platform', parent: null },
  { key: 'eu-west', name: 'Europe (Paris)', parent: 'core' },
  { key: 'us-east', name: 'North America (Virginia)', parent: 'core' },
  { key: 'internal', name: 'Internal services', parent: null },
] as const

const CONTROLS: ControlSpec[] = [
  {
    key: 'website',
    name: 'Marketing website',
    description: 'Public website and documentation',
    group: 'edge',
    baseLatencyMs: 90,
    targetUptime: 0.9995,
    incidents: 1,
    slaTarget: 999,
  },
  {
    key: 'cdn',
    name: 'CDN',
    description: 'Static asset delivery',
    group: 'edge',
    baseLatencyMs: 40,
    targetUptime: 0.9999,
    incidents: 1,
    slaTarget: 9995,
  },
  {
    key: 'api-gateway',
    name: 'API gateway',
    description: 'Public REST and GraphQL entry point',
    group: 'edge',
    baseLatencyMs: 140,
    targetUptime: 0.998,
    incidents: 3,
    slaTarget: 999,
  },
  {
    key: 'auth',
    name: 'Authentication',
    description: 'Login, tokens and session issuance',
    group: 'core',
    baseLatencyMs: 180,
    targetUptime: 0.9985,
    incidents: 2,
    slaTarget: 9995,
  },
  {
    key: 'billing',
    name: 'Billing',
    description: 'Subscriptions, invoicing and payment capture',
    group: 'core',
    baseLatencyMs: 320,
    targetUptime: 0.997,
    incidents: 2,
    slaTarget: 999,
  },
  {
    key: 'db-eu-west',
    name: 'Database cluster (Paris)',
    description: 'Primary PostgreSQL cluster',
    group: 'eu-west',
    baseLatencyMs: 12,
    targetUptime: 0.9998,
    incidents: 1,
    slaTarget: 9999,
  },
  {
    key: 'cache-eu-west',
    name: 'Cache (Paris)',
    description: 'Redis cache tier',
    group: 'eu-west',
    baseLatencyMs: 3,
    targetUptime: 0.9995,
    incidents: 1,
  },
  {
    key: 'db-us-east',
    name: 'Database cluster (Virginia)',
    description: 'Read replica cluster',
    group: 'us-east',
    baseLatencyMs: 18,
    targetUptime: 0.999,
    incidents: 2,
    slaTarget: 999,
  },
  {
    key: 'object-storage',
    name: 'Object storage',
    description: 'Uploads and generated exports',
    group: 'us-east',
    baseLatencyMs: 220,
    targetUptime: 0.9992,
    incidents: 2,
  },
  {
    key: 'queue-depth',
    name: 'Job queue depth',
    description: 'Pending background jobs — a measurement, not an up/down state',
    group: 'internal',
    targetUptime: 0.999,
    incidents: 2,
    value: { base: 120, amplitude: 60, unit: 'jobs', label: 'Pending jobs' },
  },
  {
    key: 'backup',
    name: 'Nightly backup',
    description: 'Heartbeat from the backup job — internal only',
    group: 'internal',
    isPublic: false,
    baseLatencyMs: 2400,
    targetUptime: 0.99,
    incidents: 2,
  },
  {
    key: 'smtp-relay',
    name: 'Mail relay',
    description: 'Outbound transactional email',
    group: 'internal',
    isPublic: false,
    baseLatencyMs: 260,
    targetUptime: 0.996,
    incidents: 3,
  },
]

async function main() {
  const { db, sql } = createDatabase(undefined, { max: 5 })

  try {
    console.warn('→ resetting demo tenant')
    // Deleting the tenant cascades to controls, checks, incidents and
    // memberships — but users are global and survive it. Removing them too is
    // what actually makes re-seeding repeatable: otherwise the second run hits
    // the unique email constraint, and the demo admin is left with no
    // membership at all, which fails much later and much less obviously.
    await db.delete(s.tenants).where(eq(s.tenants.slug, 'acme'))
    await db.delete(s.users).where(inArray(s.users.email, DEMO_EMAILS))

    console.warn('→ creating tenant')
    const [tenant] = await db
      .insert(s.tenants)
      .values({
        slug: 'acme',
        name: 'Acme Corp',
        visibility: 'public',
        retentionMode: 'historical',
        retentionDays: 90,
        rawRetentionHours: 168,
        defaultLocale: 'en',
        defaultTimezone: 'Europe/Paris',
        branding: { accent: '#22C55E', footer: 'Acme Corp — status.acme.example' },
        subscriberDisclaimer:
          'We use your address only to send status notifications. Unsubscribe at any time.',
      })
      .returning()
    if (!tenant) throw new Error('tenant insert returned no row')

    console.warn('→ creating users')
    const passwordHash = await hashPassword(DEMO_PASSWORD)
    const [admin] = await db
      .insert(s.users)
      .values({
        email: DEMO_ADMIN_EMAIL,
        name: 'Ada Admin',
        passwordHash,
        locale: 'en',
        timezone: 'Europe/Paris',
      })
      .returning()
    const [member] = await db
      .insert(s.users)
      .values({
        email: DEMO_USER_EMAIL,
        name: 'Uma User',
        passwordHash,
        locale: 'fr',
        timezone: 'Europe/Paris',
      })
      .returning()
    if (!admin || !member) throw new Error('user insert returned no row')

    // MFA is left disabled on the demo admin on purpose: enrolling a TOTP
    // secret is part of the flow we want a first-time user to walk through,
    // and a pre-enrolled secret nobody has in an authenticator app is a
    // locked door, not a convenience.
    await db.insert(s.memberships).values([
      { userId: admin.id, tenantId: tenant.id, role: 'admin' },
      { userId: member.id, tenantId: tenant.id, role: 'user' },
    ])

    console.warn('→ creating groups and controls')
    const groupIds = new Map<string, string>()
    for (const group of GROUPS) {
      const [row] = await db
        .insert(s.controlGroups)
        .values({
          tenantId: tenant.id,
          parentId: group.parent ? (groupIds.get(group.parent) ?? null) : null,
          name: group.name,
          position: GROUPS.indexOf(group),
          statusRollup: group.key === 'internal' ? 'majority' : 'worst',
        })
        .returning()
      if (!row) throw new Error(`group insert failed: ${group.key}`)
      groupIds.set(group.key, row.id)
    }

    const controlIds = new Map<string, string>()
    for (const [index, spec] of CONTROLS.entries()) {
      const [row] = await db
        .insert(s.controls)
        .values({
          tenantId: tenant.id,
          groupId: groupIds.get(spec.group) ?? null,
          key: spec.key,
          name: spec.name,
          description: spec.description,
          kind: 'push',
          expectedIntervalS: INTERVAL_S,
          degradedThresholdMs: spec.baseLatencyMs ? spec.baseLatencyMs * 3 : null,
          downThresholdMs: spec.baseLatencyMs ? spec.baseLatencyMs * 10 : null,
          valueUnit: spec.value?.unit ?? null,
          valueLabel: spec.value?.label ?? null,
          slaTarget: spec.slaTarget ?? null,
          isPublic: spec.isPublic ?? true,
          position: index,
        })
        .returning()
      if (!row) throw new Error(`control insert failed: ${spec.key}`)
      controlIds.set(spec.key, row.id)
    }

    console.warn(`→ generating ${DAYS} days of history`)
    const to = new Date()
    const from = new Date(to.getTime() - DAYS * 24 * 3600 * 1000)
    let totalPoints = 0

    for (const [index, spec] of CONTROLS.entries()) {
      const controlId = controlIds.get(spec.key)
      if (!controlId) continue

      const series = generateMockSeries({
        // Seed derived from position, so adding a control does not reshuffle
        // the history of the ones before it.
        seed: 1000 + index * 17,
        from,
        to,
        intervalS: INTERVAL_S,
        targetUptime: spec.targetUptime,
        baseLatencyMs: spec.baseLatencyMs,
        incidents: spec.incidents,
        valueMode: spec.value
          ? { base: spec.value.base, amplitude: spec.value.amplitude }
          : undefined,
      })

      // Batched inserts inside one transaction. Batching because a statement
      // per point would take minutes and a single statement for 26k points
      // exceeds the parameter limit; the transaction because a backfill writes
      // oldest-first, so while it is in flight the newest visible row is still
      // days old — and the stale-control sweeper, running every 30 seconds,
      // reads that as a control that has gone silent and marks it unknown at
      // now(). That marker then outranks the history being written and the
      // control looks dead permanently.
      //
      // Committing the whole series at once means the newest row jumps straight
      // to the present and there is no window to observe.
      await db.transaction(async (tx) => {
        const BATCH = 2000
        for (let i = 0; i < series.length; i += BATCH) {
          const batch = series.slice(i, i + BATCH).map((point) => ({
            ts: point.ts,
            tenantId: tenant.id,
            controlId,
            status: point.status,
            latencyMs: point.latencyMs,
            value: point.value,
            message: point.message,
            synthetic: false,
          }))
          await tx.insert(s.checks).values(batch)
        }
      })
      totalPoints += series.length
      console.warn(`  · ${spec.key}: ${series.length} points`)
    }

    console.warn('→ creating incidents and maintenance')
    const dayMs = 24 * 3600 * 1000
    const [incident] = await db
      .insert(s.incidents)
      .values({
        tenantId: tenant.id,
        title: 'Elevated API latency in eu-west',
        severity: 'major',
        status: 'resolved',
        startedAt: new Date(to.getTime() - 12 * dayMs),
        resolvedAt: new Date(to.getTime() - 12 * dayMs + 4 * 3600 * 1000),
        postmortemBody: [
          '## Summary',
          '',
          'A connection pool exhaustion in the eu-west cluster caused API requests to',
          'queue behind saturated database connections for roughly four hours.',
          '',
          '## Timeline',
          '',
          '- **09:12** — p95 latency crosses the alerting threshold.',
          '- **09:40** — the pool is identified as the bottleneck.',
          '- **11:05** — pool size raised and the queue drains.',
          '- **13:20** — metrics stable; incident resolved.',
          '',
          '## What we changed',
          '',
          'Pool sizing is now derived from instance capacity rather than a fixed value,',
          'and saturation is alerted on directly instead of being inferred from latency.',
        ].join('\n'),
        postmortemPublishedAt: new Date(to.getTime() - 10 * dayMs),
        createdBy: admin.id,
      })
      .returning()
    if (!incident) throw new Error('incident insert failed')

    // Impact recorded per component: the gateway went down, the database was
    // merely degraded. One severity for the whole incident would lose that.
    await db.insert(s.incidentImpacts).values([
      { incidentId: incident.id, controlId: controlIds.get('api-gateway')!, impact: 'major' },
      { incidentId: incident.id, controlId: controlIds.get('db-eu-west')!, impact: 'degraded' },
    ])

    await db.insert(s.incidentUpdates).values([
      {
        incidentId: incident.id,
        authorId: admin.id,
        status: 'investigating',
        body: 'We are investigating elevated response times on the API gateway in eu-west.',
        createdAt: new Date(to.getTime() - 12 * dayMs),
      },
      {
        incidentId: incident.id,
        authorId: admin.id,
        status: 'identified',
        body: 'Database connection pool exhaustion identified as the cause. Applying a fix.',
        createdAt: new Date(to.getTime() - 12 * dayMs + 1800 * 1000),
      },
      {
        incidentId: incident.id,
        authorId: admin.id,
        status: 'resolved',
        body: 'Latency is back to normal levels. A postmortem will follow.',
        createdAt: new Date(to.getTime() - 12 * dayMs + 4 * 3600 * 1000),
      },
    ])

    const [maintenance] = await db
      .insert(s.maintenances)
      .values({
        tenantId: tenant.id,
        title: 'PostgreSQL minor version upgrade',
        body: 'Rolling upgrade of the eu-west cluster. Brief failovers are expected.',
        status: 'scheduled',
        scheduledStart: new Date(to.getTime() + 3 * dayMs),
        scheduledEnd: new Date(to.getTime() + 3 * dayMs + 2 * 3600 * 1000),
        createdBy: admin.id,
      })
      .returning()
    if (!maintenance) throw new Error('maintenance insert failed')
    await db.insert(s.maintenanceControls).values([
      { maintenanceId: maintenance.id, controlId: controlIds.get('db-eu-west')! },
      { maintenanceId: maintenance.id, controlId: controlIds.get('cache-eu-west')! },
    ])

    console.warn('→ creating an ingest API key')
    const apiKey = `tern_${generateToken(24)}`
    await db.insert(s.apiKeys).values({
      tenantId: tenant.id,
      name: 'Demo ingest key',
      keyHash: hashToken(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      scopes: ['ingest'],
      createdBy: admin.id,
    })

    console.warn('→ refreshing continuous aggregates')
    // Without this the aggregates stay empty until the background policy runs,
    // and a freshly seeded page would show 90 days of nothing.
    for (const view of ['checks_1m', 'checks_5m', 'checks_1h']) {
      await sql.unsafe(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`)
    }

    console.warn('')
    console.warn('✓ seed complete')
    console.warn(
      `  tenant       acme (public) — ${CONTROLS.length} controls, ${totalPoints} points`,
    )
    console.warn(`  admin        ${DEMO_ADMIN_EMAIL} / ${DEMO_PASSWORD}`)
    console.warn(`  user         ${DEMO_USER_EMAIL} / ${DEMO_PASSWORD}`)
    console.warn(`  ingest key   ${apiKey}`)
    console.warn('')
    console.warn('  This key is shown once — it is stored only as a hash.')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('✗ seed failed:', error)
  process.exit(1)
})
