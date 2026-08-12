/**
 * What the console can ask a running agent to do.
 *
 * One list, in a package the database, the API and the browser all already
 * depend on — because it was three lists before, and three lists drift. The
 * database learned `ui-on`, the route's schema did not, and the console asked
 * for something the column allowed and got a 400 naming five kinds it had never
 * heard of. Adding a kind is now one edit.
 *
 * Nothing here reaches an agent: they poll, and one behind a relay has no route
 * back at all. Each of these waits for the next check-in — about a minute — is
 * carried out, and answers on its own way back.
 */
export const AGENT_COMMAND_KINDS = [
  /** Stop measuring, keep reporting. Undone from the console. */
  'pause',
  'resume',
  /**
   * Stop entirely, including asking for instructions.
   *
   * That is what makes it final: nothing is left to hear a resume, so it is
   * undone only from a shell on the machine — `tern-agent resume`. The console
   * says exactly that before asking for it.
   */
  'stop',
  /** Leave, and let the supervisor start it again. */
  'restart',
  /** Its own recent lines, from the ring it keeps. Not the system log. */
  'logs',
  /**
   * Turn its page on and hand back the password it generated.
   *
   * The one moment that password can travel: it is salted and hashed as it is
   * stored, so the machine is the only place it exists in the clear. Asked
   * again, it mints another.
   */
  'ui-on',
  'ui-off',
  /**
   * Replace its own binary with the one this instance ships, then restart.
   *
   * The machine does the work, because it is the only one that can: nothing
   * here can reach it, and an agent behind a relay has no route back at all. It
   * downloads from the server it already reports to — a zone agent from its
   * relay, which serves the same files — checks the published SHA-256, runs the
   * new binary once to see that it starts on that machine, and only then puts
   * it in place. Then it exits, and whatever supervises it brings it back.
   *
   * Offered only where `upgradeTo` on the row says it is worth offering.
   */
  'upgrade',
] as const

export type AgentCommandKind = (typeof AGENT_COMMAND_KINDS)[number]

/** What each one is called on screen. */
export const AGENT_COMMAND_LABEL: Record<AgentCommandKind, string> = {
  pause: 'Pause measuring',
  resume: 'Resume',
  stop: 'Stop it for good',
  restart: 'Restart it',
  logs: 'Fetch recent logs',
  'ui-on': 'Turn its page on',
  'ui-off': 'Turn its page off',
  upgrade: 'Update it',
}

/**
 * What `ui-on` answers with.
 *
 * Three facts rather than one, so the console can show the password and offer
 * the link in the same breath — and say something useful when it cannot.
 *
 * - `password` is the one moment it exists anywhere but on the machine.
 * - `address` is what the machine worked out to be *reachable*, not what it
 *   bound: a page on `0.0.0.0:38788` is served on every interface and is an
 *   address nobody can open, so the agent resolves one and answers null when
 *   there genuinely is none — a page on loopback.
 * - `listen` is what it bound, verbatim. It exists because null was the whole
 *   answer for a while, and "no link" then had to stand in for both "on
 *   loopback" and "on a port this screen cannot name" — leaving the operator
 *   with a password and no port to use it on.
 *
 * Written by the agent as JSON in the command's result, read here. Anything
 * that fails to parse is shown as the plain text it is — an agent older than
 * this shape answers with the bare password, and that is still worth showing.
 */
export interface UiOnResult {
  password: string
  address: string | null
  /** Null from an agent too old to say. */
  listen: string | null
}

export function readUiOnResult(result: string): UiOnResult {
  try {
    const parsed: unknown = JSON.parse(result)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'password' in parsed &&
      typeof (parsed as UiOnResult).password === 'string'
    ) {
      const shaped = parsed as UiOnResult
      return {
        password: shaped.password,
        address: shaped.address ?? null,
        listen: shaped.listen ?? null,
      }
    }
  } catch {
    // Not JSON: an older agent, which answered with the password alone.
  }
  return { password: result, address: null, listen: null }
}
