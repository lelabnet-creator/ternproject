/**
 * Runs before any module is imported, which is the only point where the
 * environment can still be changed — `config.ts` validates and freezes it at
 * import time.
 *
 * The auth rate limit is raised rather than disabled: a suite that shares one
 * source IP would otherwise trip a production-realistic limit within a few
 * tests. The limiter itself is still exercised, by a test that builds an app
 * with a deliberately tiny limit.
 */
process.env.NODE_ENV = 'test'
process.env.AUTH_RATE_LIMIT_MAX ??= '1000'
process.env.PAIR_RATE_LIMIT_MAX ??= '1000'
// The subscribe endpoint sends mail; MailHog catches it, but the suite would
// still trip its own signup limit within a handful of tests.
process.env.SUBSCRIBE_RATE_LIMIT_MAX ??= '1000'
process.env.LOG_LEVEL ??= 'silent'
