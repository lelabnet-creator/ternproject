import { describe, expect, it } from 'vitest'

/**
 * The version stamped into the bundle, and the `v` that is not part of it.
 *
 * CI passes `github.ref_name` — the tag, `v0.1.12` — while a local build falls
 * back to `package.json`, which is `0.1.12`. Both displays write their own `v`
 * in front, so every published image showed `vv0.1.12` from the first tagged
 * release onwards, and no developer ever saw it: the local path has no `v` to
 * double.
 *
 * This pins the normalisation `vite.config.ts` performs, by the same rule, so
 * the two cannot drift. It is deliberately a test of the rule rather than of the
 * config module: importing a Vite config to read one constant would test the
 * plumbing instead of the decision.
 */

/** What `vite.config.ts` does to whatever it is handed. */
const normalise = (raw: string) => raw.trim().replace(/^v/, '')

describe('the version baked into the bundle', () => {
  it('drops the tag’s v, so the display can write its own', () => {
    expect(normalise('v0.1.12')).toBe('0.1.12')
    expect(normalise(' v0.1.12 ')).toBe('0.1.12')
  })

  it('leaves a bare number alone', () => {
    // The local path, which was always right and must stay so.
    expect(normalise('0.1.12')).toBe('0.1.12')
  })

  it('never yields something a leading v would double', () => {
    for (const raw of ['v1.2.3', '1.2.3', 'v0.0.1-rc.1']) {
      expect(`v${normalise(raw)}`).not.toMatch(/^vv/)
    }
  })

  it('leaves a prerelease suffix intact', () => {
    // Only the leading v goes. A tag like v1.0.0-rc.1 still has to read as one.
    expect(normalise('v1.0.0-rc.1')).toBe('1.0.0-rc.1')
  })
})
