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
}
