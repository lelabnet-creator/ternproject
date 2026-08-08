/**
 * Reading a check's target the way the person typing it means it.
 *
 * Its own module rather than two helpers inside the editor, for the reason
 * `matching.ts` beside it is one: the judgement is a rule, rules are worth
 * pinning, and pinning one inside a screen means mounting the screen to test it.
 */

/**
 * The host a check will actually dial, whatever field it was typed into.
 *
 * Empty when there is nothing to judge yet — a blank field, or a URL too
 * incomplete to parse. Half-typed input is not a mistake to warn about.
 *
 * `dns` is excluded rather than forgotten: that probe *resolves* a name, it
 * never opens a connection to it. Asking a resolver about `localhost` works and
 * means what it says, so warning there would be wrong.
 */
export function targetHost(form: { kind: string; url: string; host: string }): string {
  if (form.kind === 'http') {
    try {
      return new URL(form.url).hostname
    } catch {
      return ''
    }
  }
  if (form.kind === 'dns') return ''
  return form.host
}

/**
 * Whether an address means "this machine" to the person who typed it.
 *
 * The question is intent, not IP semantics. `0.0.0.0` is not a loopback address
 * and dialling it is not the same thing — but somebody who puts it in a
 * monitoring target means their own machine, and is about to hit the same wall.
 *
 * IPv6 arrives from a URL hostname wrapped in brackets, which is why they come
 * off before the comparison.
 */
export function meansThisMachine(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    bare.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  )
}
