import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
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
  const root = resolve(process.cwd(), '..', '..')
  const published = join(root, 'clients', 'agent', 'bin', target)

  /*
   * `cargo build --release` in `clients/agent`, if anyone has run one.
   *
   * `bin/` is written by CI and must not be edited by hand — its own README
   * says so, and `SHA256SUMS` beside it would stop matching. But that leaves a
   * source checkout running whatever CI last published, which is how this
   * instance ended up supervising an agent older than the server it was talking
   * to: the binary predated the heartbeat, refused to start without probes, and
   * the supervisor gave up after three attempts.
   *
   * So the freshest of the two wins. Nothing to configure, it self-corrects the
   * moment CI publishes something newer, and it is inert in the production
   * image, where `target/` does not exist.
   */
  const built = join(root, 'clients', 'agent', 'target', 'release', 'tern-agent')

  const mtime = (path: string): number => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return -1
    }
  }

  const candidates = [built, published].filter((path) => mtime(path) >= 0)
  if (candidates.length === 0) return null

  return candidates.reduce((newest, path) => (mtime(path) > mtime(newest) ? path : newest))
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
 * Keeps the binary running, where this process is the one that has to.
 *
 * Only used when `TERN_LOCAL_AGENT_SUPERVISE` is on — that is, running from
 * source, where there is no container to do it. The production stack turns it
 * off and lets Docker's `restart: unless-stopped` be the supervisor.
 *
 * The restart backoff is not about crashes any more: since the agent idles on
 * an empty assignment rather than exiting, an exit means something genuinely
 * went wrong, and hammering it several times a second would only make the log
 * unreadable at the moment somebody needs to read it.
 */
/** An exit sooner than this is a refusal, not a crash worth riding out. */
const IMMEDIATE_EXIT_MS = 5_000
/** How many refusals before saying so once and stopping. */
const MAX_REFUSALS = 3

class Supervisor {
  private child: ChildProcess | null = null
  private stopping = false
  private failures = 0
  private refusals = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly app: FastifyInstance,
    private readonly binary: string,
  ) {}

  start(): void {
    if (this.stopping) return
    const { configPath, queuePath } = dataPaths()
    const startedAt = Date.now()

    // No `--wait-for-config`: this starts only after `ensureLocalAgent` has
    // written the file, so there is nothing to wait for. That flag is for the
    // container, which starts on its own schedule and may well beat the wizard.
    // Leaving it off also means this works with an older agent binary, which
    // matters because `clients/agent/bin` is refreshed by CI rather than here.
    this.child = spawn(
      this.binary,
      ['run', '--config', configPath, '--queue', queuePath],
      // Its logs go to this process's stderr, where the API's collector already
      // looks. A file would be a second place to know about.
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )

    this.child.on('spawn', () => {
      this.failures = 0
      this.app.log.info({ agent: LOCAL_AGENT_NAME, pid: this.child?.pid }, 'local agent started')
    })

    this.child.on('error', (error) => {
      this.app.log.error({ err: error, agent: LOCAL_AGENT_NAME }, 'local agent failed to start')
    })

    this.child.on('exit', (code, signal) => {
      const ranFor = Date.now() - startedAt
      this.child = null
      if (this.stopping) return

      // An exit within a few seconds of starting is not a crash to ride out, it
      // is a refusal — a binary too old for the arguments it was given, or one
      // that will not run without an assignment. Retrying that forever produces
      // a loop that says the same thing every second and drowns the reason.
      if (ranFor < IMMEDIATE_EXIT_MS) this.refusals += 1
      else this.refusals = 0

      if (this.refusals >= MAX_REFUSALS) {
        this.stopping = true
        this.app.log.error(
          { agent: LOCAL_AGENT_NAME, code, attempts: this.refusals },
          'local agent keeps exiting immediately — not retrying. ' +
            'Its own error is above; a binary older than this server is the usual cause. ' +
            'Restart the API once clients/agent/bin has been refreshed.',
        )
        return
      }

      this.failures += 1
      const delay = Math.min(1000 * 2 ** (this.failures - 1), 60_000)
      this.app.log.warn(
        { agent: LOCAL_AGENT_NAME, code, signal, delayMs: delay },
        'local agent exited — restarting',
      )
      this.timer = setTimeout(() => this.start(), delay)
    })
  }

  stop(): void {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    // SIGTERM, not SIGKILL: the agent writes its queue to disk on the way out,
    // and killing it outright loses whatever it has not sent.
    this.child?.kill('SIGTERM')
  }
}

let supervisor: Supervisor | null = null

export function stopLocalAgent(): void {
  supervisor?.stop()
  supervisor = null
}

/**
 * Brings the local agent into line with what the instance is.
 *
 * Called from three places for one reason: the precondition is a page, and a
 * page is created by a person minutes or days after the process booted. The
 * wizard calls it on the way out (`routes/setup.ts`), the plugin calls it once
 * the server is listening, and the job runner calls it on a tick
 * (`plugins/jobs.ts`) so an instance provisioned any other way converges too.
 *
 * Idempotent. Safe to call while the agent is running: it writes nothing unless
 * the row or the config file is missing, and starts nothing twice.
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

  if (!config.TERN_LOCAL_AGENT_SUPERVISE || supervisor) return

  const binary = resolveBinary()
  if (!binary) {
    app.log.info(
      { platform: process.platform, arch: process.arch },
      'no agent binary for this platform — the in-process prober keeps measuring',
    )
    return
  }

  supervisor = new Supervisor(app, binary)
  supervisor.start()
}
