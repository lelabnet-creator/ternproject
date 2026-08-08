import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

/** Loads the repository-root `.env`, same rule as @tern/db. */
function loadEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true })
      return
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  loadDotenv({ quiet: true })
}

loadEnv()

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  /**
   * Encrypts TOTP secrets, probe auth headers and subscriber addresses.
   * Minimum length is enforced because a short APP_SECRET silently weakens
   * every one of those, and nothing else in the system would complain.
   */
  APP_SECRET: z
    .string()
    .min(32, 'APP_SECRET must be at least 32 characters — use: openssl rand -hex 32')
    .refine((v) => v !== 'change-me-openssl-rand-hex-32', {
      message: 'APP_SECRET is still the placeholder from .env.example',
    }),

  API_PORT: z.coerce.number().int().positive().default(3011),
  API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

  /**
   * Where the instance keeps state that is not in the database: today the local
   * agent's `agent.toml` and its offline queue.
   *
   * `/var/lib/tern` is the volume `docker-compose.prod.yml` already mounts. In
   * development that path is neither present nor writable, so it falls back to
   * a directory beside the checkout — which is also why the default is computed
   * rather than written as one string.
   */
  TERN_DATA_DIR: z
    .string()
    .default(process.env.NODE_ENV === 'production' ? '/var/lib/tern' : '.tern'),

  /**
   * Whether this instance runs its own agent.
   *
   * On by default: a fresh install that monitors nothing until somebody deploys
   * an agent is a fresh install that looks broken. Turned off, the server still
   * probes for itself through the `local-probes` job — what is lost is the
   * agent's offline queue and its appearance in the fleet, not the monitoring.
   */
  TERN_LOCAL_AGENT: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  /**
   * The address written into the local agent's `agent.toml`.
   *
   * Empty means "the API on this loopback", which is right for both shipped
   * deployments: from source the agent is on the same machine, and in the
   * production stack its container shares the API's network namespace.
   *
   * Set it only for an agent somewhere else — where it has to be `https://`,
   * since the agent refuses to carry an ingest key over plain HTTP to anything
   * but localhost.
   */
  TERN_LOCAL_AGENT_SERVER: z.string().default(''),

  /**
   * Which network the local agent watches from, reported to the fleet screen.
   *
   * Read, never acted on: the value is set on the container at creation and
   * this process could not change it if it wanted to — it has no Docker socket,
   * deliberately, since one is root on the host. What it buys is an answer to
   * "why is my check on localhost:5432 down", which is otherwise invisible.
   *
   * `service:app` is the compose default and what running from source amounts
   * to. `host` is the machine's own stack.
   */
  TERN_AGENT_NETWORK_MODE: z.string().default('service:app'),

  /**
   * Whether this process starts the agent binary itself.
   *
   * On by default, because the deployment that needs it is the one nobody
   * configures: run the API from source and there is no container to run the
   * agent, so without this the fleet shows an agent that was provisioned and
   * never once reported — a dead row on every development install.
   *
   * `docker-compose.prod.yml` turns it off. There the `agent` service runs the
   * binary and Docker supervises it, and two supervisors for one process is one
   * too many.
   */
  TERN_LOCAL_AGENT_SUPERVISE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  /**
   * Proxy CIDRs whose X-Forwarded-For is believed. Empty by default: IP
   * allowlists are only as trustworthy as this list, and trusting a header
   * nobody sets is how they get bypassed.
   */
  TRUSTED_PROXIES: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /**
   * Attempts per minute per IP on /auth/*. Ten is deliberately low: these are
   * the endpoints an attacker actually reaches for, and a correct Argon2 verify
   * is worth nothing if it can be attempted ten thousand times a minute.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /**
   * Reads of one's own session, per minute per IP.
   *
   * Separate from the number above, and much larger, because the two answer
   * different questions. Ten `/login` attempts a minute stops a password
   * guesser; ten `/auth/me` a minute stops an operator. The admin asks on every
   * mount, so a few navigations and a reload used to exhaust the login budget
   * and produce a sign-in form at somebody holding a valid session — and since
   * the counter is keyed by IP, one NAT shares it across a whole office.
   *
   * Still a limit. The endpoint is authenticated and runs two queries, so it is
   * worth bounding; two a second, sustained, is far past any human and far
   * short of anything this could be used for.
   */
  SESSION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /**
   * Redemption attempts per minute per IP. A pairing PIN carries about 40 bits
   * of entropy, which is only enough because guessing is this slow and the code
   * dies after a handful of wrong tries.
   */
  PAIR_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /**
   * Ingest requests per minute, per API key.
   *
   * The default suits a small fleet. The Capacity screen computes what this
   * deployment actually needs — a limit below the fleet's own rate turns a
   * routine retry into a self-inflicted outage of the one path that must not
   * fail.
   */
  INGEST_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  /** PostgreSQL connections per API instance. Each is a backend process. */
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(10),

  /** Signups per minute per IP. Writing a row and sending mail deserves a tight bound. */
  SUBSCRIBE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  // ── Mail ──────────────────────────────────────────────────────────────────
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('TERN Status <status@example.com>'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // `silent` is a real pino level, and the one tests want: an integration suite
  // that prints a request log per assertion buries the failure that matters.
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail at startup with the actual problem rather than at the first request
  // with a confusing symptom.
  console.error('✗ Invalid environment:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = parsed.data
export type Config = typeof config

export const isProduction = config.NODE_ENV === 'production'
