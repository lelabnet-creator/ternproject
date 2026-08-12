import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { compareVersions, parseVersion } from './release.js'

/**
 * Which agent build this instance ships, and who in the fleet is behind it.
 *
 * ## Why the server's own version is the answer
 *
 * There is no separate version for the agent. CI builds the binaries from the
 * same commit as the server and publishes both under one tag, so the copy in
 * `clients/agent/bin` is, by construction, this release's agent. Asking the
 * files themselves would mean running one to see what it says — on a platform
 * this machine may not even be able to execute.
 *
 * That is also why a build with no tag says nothing at all rather than
 * guessing: an instance built by hand has binaries of an unknown vintage, and
 * "you are behind" is not something to tell an operator on a hunch.
 *
 * ## Why the check is here and not in the browser
 *
 * Three questions have to agree before an upgrade button means anything: is the
 * agent behind, is there a binary here for its platform, and is it the kind of
 * agent that can replace its own file. The console would have to know the
 * shipping list and the platform naming to answer the middle one, so all three
 * are answered once, per row, and the screen only renders what comes back.
 */

/** Only these names are servable. The path never comes from a request. */
export const AGENT_BINARIES = [
  'tern-agent-x86_64-unknown-linux-musl',
  'tern-agent-aarch64-unknown-linux-musl',
  'tern-agent-aarch64-apple-darwin',
  'tern-agent-x86_64-apple-darwin',
  'tern-agent-x86_64-pc-windows-msvc.exe',
  'tern-proxy-x86_64-unknown-linux-musl',
  'tern-proxy-aarch64-unknown-linux-musl',
  'tern-proxy-aarch64-apple-darwin',
  'tern-proxy-x86_64-apple-darwin',
  'tern-proxy-x86_64-pc-windows-msvc.exe',
  'SHA256SUMS',
] as const

export function binDirectory(): string {
  // Resolved from the repository root rather than from `import.meta.url`, so it
  // is the same path whether the API runs from source or from a build.
  return join(process.cwd(), '..', '..', 'clients', 'agent', 'bin')
}

export function availableBinaries(): string[] {
  const dir = binDirectory()
  return AGENT_BINARIES.filter((name) => existsSync(join(dir, name)))
}

/**
 * The file that would replace this agent, or null if there is none here.
 *
 * Two vocabularies meet in the `os` and `arch` columns and neither is Rust's.
 * The agent binary reports what `std::env::consts` calls things — `linux`,
 * `x86_64` — and the instance's own agent is registered by Node, which says
 * `linux` and `x64`, or `win32` for Windows. Both are accepted, because the
 * column holds whatever the machine said about itself and rewriting history to
 * one spelling would only move the translation somewhere less visible.
 */
export function binaryNameFor(role: string, os: string | null, arch: string | null): string | null {
  if (!os || !arch) return null
  const prefix = role === 'proxy' ? 'tern-proxy' : 'tern-agent'

  const platform = {
    linux: 'linux',
    darwin: 'darwin',
    macos: 'darwin',
    win32: 'windows',
    windows: 'windows',
  }[os.toLowerCase()]
  const cpu = {
    x86_64: 'x86_64',
    x64: 'x86_64',
    amd64: 'x86_64',
    aarch64: 'aarch64',
    arm64: 'aarch64',
  }[arch.toLowerCase()]
  if (!platform || !cpu) return null

  const name = {
    linux: `${prefix}-${cpu}-unknown-linux-musl`,
    darwin: `${prefix}-${cpu}-apple-darwin`,
    // Only x86_64 is built for Windows. An arm64 Windows agent gets null, which
    // is the honest answer: there is nothing here it could run.
    windows: cpu === 'x86_64' ? `${prefix}-x86_64-pc-windows-msvc.exe` : null,
  }[platform]

  if (!name) return null
  return existsSync(join(binDirectory(), name)) ? name : null
}

/** The agent version this instance ships, or null for a build with no tag. */
export function shippedAgentVersion(): string | null {
  return parseVersion(config.TERN_VERSION)?.raw.replace(/^v/, '') ?? null
}

/**
 * The version this agent should be moved to, or null if there is nothing to do.
 *
 * Null covers every reason not to offer the button, and they are not the same
 * reason: already current, a version neither side can parse, no binary here for
 * that platform, a revoked row, or the instance's own agent — which is started
 * by this process from the very files an upgrade would download, so it is
 * already running what an upgrade would install. Telling those apart on screen
 * would be five sentences about a button that is not there.
 */
export function upgradeFor(agent: {
  role: string
  os: string | null
  arch: string | null
  agentVersion: string | null
  status: string
  isLocal: boolean
}): string | null {
  if (agent.isLocal || agent.status === 'revoked') return null

  const shipped = shippedAgentVersion()
  if (!shipped) return null

  const running = agent.agentVersion ? parseVersion(agent.agentVersion) : null
  const target = parseVersion(shipped)
  if (!running || !target) return null
  if (compareVersions(target, running) <= 0) return null

  return binaryNameFor(agent.role, agent.os, agent.arch) ? shipped : null
}
