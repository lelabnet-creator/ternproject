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
   * Redemption attempts per minute per IP. A pairing PIN carries about 40 bits
   * of entropy, which is only enough because guessing is this slow and the code
   * dies after a handful of wrong tries.
   */
  PAIR_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

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
