import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { issueApiKey } from './apikeys.js'
import { audit } from './audit.js'

/**
 * `Agent-local-tern` — the agent this instance runs for itself.
 *
 * A fresh install has no agent, so every `http`, `tcp`, `ping`, `dns` or `cert`
 * control it defines would sit at `unknown` until somebody deployed one. The
 * `local-probes` job already covers that from inside the API process; this puts
 * the real agent binary on the box instead, which buys three things that job
 * cannot: an offline queue that survives the API being down, probes running in
 * a process that a busy API cannot starve, and a fleet screen that shows what
 * is actually measuring.
 *
 * ## Not paired — provisioned
 *
 * There is no PIN and no `pairing_code_id`. Pairing exists so a machine the
 * server has never met can prove it was invited; here the server *is* the
 * machine. It writes the key into `agent.toml` directly, which removes an HTTP
 * round trip whose only possible failure was against itself, and a race between
 * the agent starting and the API accepting connections.
 *
 * ## The two runners do not collide
 *
 * This agent's key carries an empty control scope, which `local-probes` reads
 * as "the whole tenant" — see the `tenantsFullyCovered` set there. So while the
 * agent is live the in-process job stands down completely, and if the agent
 * stops reporting for longer than the staleness window the job picks the work
 * back up. Failover in both directions, out of a mechanism that already existed.
 */

export const LOCAL_AGENT_NAME = 'Agent-local-tern'

/**
 * The binary for this machine, or null.
 *
 * Null is an ordinary outcome, not a failure: `clients/agent/bin` is populated
 * by CI, so a source checkout that has never run it has nothing here, and the
 * production image does not currently carry the binaries at all. In every one
 * of those cases the instance still monitors — through `local-probes` — so this
 * is logged once and dropped rather than retried or escalated.
 */
export function resolveBinary(): string | null {
  // Typed as a partial record because `process.platform` spans every target
  // Node knows about, most of which the agent has never been built for. An
  // index into a plain object literal would make TypeScript ask about `aix:s390`.
  const targets: Partial<Record<string, string>> = {
    'linux:x64': 'tern-agent-x86_64-unknown-linux-musl',
    'linux:arm64': 'tern-agent-aarch64-unknown-linux-musl',
    'darwin:x64': 'tern-agent-x86_64-apple-darwin',
    'darwin:arm64': 'tern-agent-aarch64-apple-darwin',
    'win32:x64': 'tern-agent-x86_64-pc-windows-msvc.exe',
  }

  const target = targets[`${process.platform}:${process.arch}`]
  if (!target) return null

  // Same resolution as routes/download.ts, and for the same reason: the path
  // must not change depending on whether the API runs from source or a build.
  const candidate = resolve(process.cwd(), '..', '..', 'clients', 'agent', 'bin', target)
  return existsSync(candidate) ? candidate : null
}

/**
 * Where `agent.toml` and the offline queue live.
 *
 * An absolute `TERN_DATA_DIR` is taken as given — that is the production case,
 * `/var/lib/tern`. A relative one resolves against the repository root rather
 * than the working directory, because the API's working directory is
 * `apps/api`: the development default would otherwise put the agent's files
 * three levels down from where anyone would look for them.
 */
export function dataPaths() {
  const configured = config.TERN_DATA_DIR
  const dir = isAbsolute(configured) ? configured : resolve(process.cwd(), '..', '..', configured)

  return { dir, configPath: join(dir, 'agent.toml'), queuePath: join(dir, 'agent-queue.jsonl') }
}

/**
 * Where the agent should send its measurements.
 *
 * Deliberately *not* `PUBLIC_BASE_URL`. That address is for browsers and for
 * links in mail; it may point at a reverse proxy, at a hostname the agent
 * cannot resolve, or — in development — at the Vite dev server rather than the
 * API.
 *
 * The default suits an agent that shares this process's loopback, and both
 * deployments arrange exactly that: from source it is the same machine, and in
 * the production stack the agent container shares the API's network namespace.
 *
 * That is not an accident of convenience. `tern-agent` refuses to send an
 * ingest key over plain HTTP to anything but localhost, so an address like
 * `http://app:3011` on a compose network makes it exit on startup. Sharing the
 * namespace makes the exemption true rather than bypassing the guard.
 *
 * The override exists for the deployment neither of those covers: an agent on
 * another host, which needs `https://` anyway.
 */
function serverUrl(): string {
  return config.TERN_LOCAL_AGENT_SERVER || `http://127.0.0.1:${config.API_PORT}`
}

function writeConfig(configPath: string, apiKey: string): void {
  mkdirSync(dirname(configPath), { recursive: true })

  // No probes listed. The agent asks the server what to run on startup and on
  // every refresh, so writing them here would only create a second copy free to
  // go stale — and the assignment is the server's to decide.
  const body = [
    '# Written by TERN for its own agent. Managed file: it is rewritten when the',
    '# instance re-provisions the agent, so local edits will not survive.',
    `server = "${serverUrl()}"`,
    `api_key = "${apiKey}"`,
    'interval_s = 60',
    '',
  ].join('\n')

  writeFileSync(configPath, body, { mode: 0o600 })
  // Set explicitly as well as passed to `writeFileSync`: the mode argument is
  // only applied when the file is created, so a rewrite of an existing file
  // would otherwise keep whatever permissions it had.
  chmodSync(configPath, 0o600)
}

/**
 * Makes the local agent exist for a tenant, exactly once.
 *
 * Idempotent, and it has to be: it runs at every boot as well as at first run.
 * The awkward case is a row that exists while the config file does not — a
 * wiped volume, a restored database. The key cannot be recovered from the row
 * because only its hash was kept, so the honest repair is a new key and a
 * rewritten file, which is what happens.
 */
export async function ensureLocalAgent(app: FastifyInstance, tenantId: string): Promise<void> {
  const { configPath } = dataPaths()

  const [existing] = await app.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.tenantId, tenantId), eq(schema.agents.isLocal, true)))
    .limit(1)

  if (existing && existsSync(configPath)) return

  const issued = await issueApiKey(app, {
    tenantId,
    name: `Agent: ${LOCAL_AGENT_NAME}`,
    scopes: ['ingest'],
    // Empty on purpose — the whole tenant. This is what makes `local-probes`
    // stand down while the agent is live.
    scopeControlIds: [],
    autoRegister: true,
  })

  if (existing) {
    // The row outlived its config. Point it at the new key rather than making a
    // second agent, so the fleet does not grow a duplicate on every restore.
    await app.db
      .update(schema.agents)
      .set({ apiKeyId: issued.id, status: 'active', revokedAt: null })
      .where(eq(schema.agents.id, existing.id))

    app.log.warn({ agent: LOCAL_AGENT_NAME }, 'local agent config was missing — re-provisioned')
  } else {
    await app.db.insert(schema.agents).values({
      tenantId,
      name: LOCAL_AGENT_NAME,
      hostname: process.env.HOSTNAME ?? null,
      os: process.platform,
      arch: process.arch,
      site: 'This instance',
      apiKeyId: issued.id,
      isLocal: true,
    })

    await audit(app, {
      action: 'agent.local.provisioned',
      tenantId,
      actorLabel: LOCAL_AGENT_NAME,
    })
  }

  writeConfig(configPath, issued.key)
}

/** So the "no page yet" line is logged once, not on every reconcile. */
let idleReported = false

/**
 * Brings the local agent's *record* into line with what the instance is.
 *
 * Nothing here starts a process. The agent runs as its own service —
 * `docker-compose.prod.yml` — and Docker's `restart: unless-stopped` is the
 * supervisor. An earlier version spawned the binary from this process and
 * restarted it with a backoff, which was a supervisor written by hand to
 * achieve what the container runtime already does, and which also killed the
 * agent every time the API restarted — the opposite of the reason to run it in
 * a separate process at all.
 *
 * What is left is provisioning, and it is called from three places for one
 * reason: the precondition is a page, and a page is created by a person minutes
 * or days after the process booted. The wizard calls it on the way out
 * (`routes/setup.ts`), and the job runner calls it on a tick
 * (`plugins/jobs.ts`) so an instance provisioned any other way converges too.
 *
 * Idempotent. Safe to call while the agent is running: it writes nothing unless
 * the row or the config file is missing.
 */
export async function startLocalAgent(app: FastifyInstance): Promise<void> {
  if (!config.TERN_LOCAL_AGENT) {
    if (!idleReported) {
      app.log.info('local agent disabled by TERN_LOCAL_AGENT')
      idleReported = true
    }
    return
  }

  // The instance's own supervision scope is not a place to run a fleet agent —
  // the page this instance serves is the non-system tenant, same query the
  // first-run endpoint uses.
  const [tenant] = await app.db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.isSystem, false))
    .limit(1)

  // No page yet means the wizard has not been through. Nothing to do, and
  // nothing wrong — the tick asks again. This is what "as soon as the
  // conditions are met" amounts to in practice.
  if (!tenant) {
    if (!idleReported) {
      app.log.info('local agent waiting: no page configured yet')
      idleReported = true
    }
    return
  }

  idleReported = false
  await ensureLocalAgent(app, tenant.id)
}
