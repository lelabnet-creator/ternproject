import type { ImportIssue } from '@tern/shared/control-import'
import { ApiError } from '../../lib/api'
import type { ImportIssueWire } from '../../lib/adminApi'

/**
 * One shape for a problem with an import file, whichever side found it.
 *
 * The same file is checked twice — once in the browser the moment it is pasted,
 * once by the server that is about to write it — and the two report the same
 * things in slightly different dialects: the parser omits a field it has nothing
 * to say about, JSON sends `null` instead. A screen that had to remember which
 * one it was looking at would grow a branch per field, so both are narrowed here
 * and the list renders one way.
 *
 * Kept in a module of its own, without React, so the narrowing can be tested
 * without rendering anything — the same reason `matching()` lives apart from the
 * screen that uses it.
 */
export interface IssueRow {
  /** 1-based, in the pasted source. Null when nothing in the file locates it. */
  line: number | null
  /** Where in the document, as the file reads: `controls[3].config.url`. */
  path: string
  /** The control's `key`, when the file got far enough to have one. */
  key: string | null
  message: string
  received?: string
  expected?: string
}

/** From the shared parser, running in this tab. */
export function fromLocal(issues: readonly ImportIssue[]): IssueRow[] {
  return issues.map((issue) => ({
    line: issue.line,
    path: issue.path,
    key: issue.key,
    message: issue.message,
    ...(issue.received === undefined ? {} : { received: issue.received }),
    ...(issue.expected === undefined ? {} : { expected: issue.expected }),
  }))
}

/** From the API's 400, where absent was written as null. */
export function fromWire(issues: readonly ImportIssueWire[]): IssueRow[] {
  return issues.map((issue) => ({
    line: issue.line,
    path: issue.path,
    key: issue.key,
    message: issue.message,
    ...(issue.received === null ? {} : { received: issue.received }),
    ...(issue.expected === null ? {} : { expected: issue.expected }),
  }))
}

/**
 * The issue list inside a failed request, or null if there was not one.
 *
 * Only the 400 from the import endpoint carries a list. Its other refusals are
 * a sentence and mean something the file cannot show: a group named twice in
 * this tenant, a `groupId` belonging to another one, a body over the limit. Null
 * is the signal to fall back to `err.message` in a banner, which is how every
 * other screen reports a refusal.
 */
export function issuesFromError(err: unknown): IssueRow[] | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null
  const body = err.body
  if (typeof body !== 'object' || body === null) return null
  const issues = (body as { issues?: unknown }).issues
  if (!Array.isArray(issues) || issues.length === 0) return null
  return fromWire(issues as ImportIssueWire[])
}

/**
 * The size the server will measure, measured here first.
 *
 * The limit is in bytes of UTF-8, and `String.length` counts UTF-16 code units:
 * a file of accented names is bigger than it looks, and a file of emoji is
 * smaller. Getting this wrong in the lenient direction would mean uploading
 * 256 KB to be told it was too big.
 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** `12.4 KB`, for the line under the field. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}
