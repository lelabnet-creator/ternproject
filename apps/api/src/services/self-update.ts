import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'

/**
 * Asking for an upgrade to be applied.
 *
 * This file writes a request and reads a report. It does not pull anything, it
 * does not restart anything, and it cannot: the Docker socket is root on the
 * host, and the process answering HTTP is the last one that should hold it. The
 * `updater` service in `docker-compose.prod.yml` holds it instead, watches the
 * shared volume, and is free to refuse.
 *
 * That split is also the only shape that can finish the job. The final step
 * replaces the container this code runs in, so whatever performs it has to
 * outlive it — and whatever reports on it has to be readable by the process
 * that comes back. Hence files rather than memory: the answer to "did it work"
 * is written down by someone else, and still there afterwards.
 *
 * Three files, all in `TERN_DATA_DIR`:
 *
 * - `updater.json`   the updater's heartbeat. Its absence is what makes the
 *                    admin offer two commands to type instead of a button.
 * - `update.request` what to update to. `key=value`, because the reader is a
 *                    POSIX shell with no JSON parser and no way to install one.
 * - `update.status.json` where it got to. JSON, because the reader is this.
 */

/** How long after its last tick an updater is presumed gone. */
const HEARTBEAT_TTL_MS = 90_000

/**
 * The steps, in the order the updater performs them, with what to call them.
 *
 * Named here rather than in the shell script: the script reports which step it
 * is on, and everything about how that reads to a person belongs on this side,
 * where it can be changed without touching the file that runs as root.
 */
export const UPDATE_STEPS = [
  { id: 'pull', label: 'Fetching the new image' },
  { id: 'verify', label: 'Checking it is what was asked for' },
  { id: 'restart', label: 'Restarting the instance' },
] as const

export type UpdateStepId = (typeof UPDATE_STEPS)[number]['id']
export type UpdateStepState = 'pending' | 'running' | 'done' | 'failed'

export interface UpdateStep {
  id: UpdateStepId
  label: string
  state: UpdateStepState
  /** 0–100, and only meaningful on the running step. */
  percent: number
  /** What is happening, or what went wrong. Empty on a step not reached yet. */
  detail: string
}

export interface UpdateProgress {
  /**
   * `unavailable` — no updater is deployed, so nothing can be applied here.
   * `idle` — one is watching and nothing has been asked of it.
   */
  state: 'unavailable' | 'idle' | 'running' | 'succeeded' | 'failed'
  /** Which release is being applied, on anything but `idle`/`unavailable`. */
  target: string | null
  steps: UpdateStep[]
  /** ISO, from the updater's own clock. Null before anything has been asked. */
  startedAt: string | null
  updatedAt: string | null
  /** The sentence to show when there is nothing to show a progress bar for. */
  detail: string
}

/** What the updater writes. Every field is treated as untrusted. */
interface RawStatus {
  id?: unknown
  target?: unknown
  image?: unknown
  state?: unknown
  step?: unknown
  percent?: unknown
  detail?: unknown
  startedAt?: unknown
  updatedAt?: unknown
}

function paths() {
  const dir = config.TERN_DATA_DIR
  return {
    heartbeat: join(dir, 'updater.json'),
    request: join(dir, 'update.request'),
    status: join(dir, 'update.status.json'),
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    // Absent, unreadable, or half-written. All three mean the same thing to a
    // caller — there is no answer here — and none of them is worth a 500 on a
    // screen someone is watching because they are already anxious.
    return null
  }
}

/** Whether an updater has ticked recently enough to be believed. */
export async function updaterPresent(): Promise<boolean> {
  const beat = await readJson(paths().heartbeat)
  const seenAt = typeof beat?.seenAt === 'string' ? Date.parse(beat.seenAt) : NaN
  if (Number.isNaN(seenAt)) return false
  // A clock in the future is a clock that disagrees, not a fresh heartbeat.
  return Date.now() - seenAt < HEARTBEAT_TTL_MS && seenAt - Date.now() < HEARTBEAT_TTL_MS
}

/**
 * The flat record the updater writes, expanded into the step list a screen
 * draws.
 *
 * Kept out of the shell deliberately. Deciding that `verify` is done because
 * `restart` is running is presentation, it changes when the screen changes, and
 * it is one more thing that would otherwise live in the file running as root.
 */
export function toProgress(status: RawStatus | null, present: boolean): UpdateProgress {
  const blank = (detail: string, state: UpdateProgress['state']): UpdateProgress => ({
    state,
    target: null,
    steps: UPDATE_STEPS.map((step) => ({ ...step, state: 'pending', percent: 0, detail: '' })),
    startedAt: null,
    updatedAt: null,
    detail,
  })

  if (!present) {
    return blank(
      'No updater is running beside this instance, so an upgrade has to be applied by hand.',
      'unavailable',
    )
  }
  if (!status || typeof status.state !== 'string') {
    return blank('Ready. Nothing has been asked of the updater.', 'idle')
  }

  const state =
    status.state === 'running' || status.state === 'succeeded' || status.state === 'failed'
      ? status.state
      : 'idle'
  if (state === 'idle') return blank('Ready. Nothing has been asked of the updater.', 'idle')

  const current = UPDATE_STEPS.findIndex((step) => step.id === status.step)
  const percent = clampPercent(status.percent)
  const detail = typeof status.detail === 'string' ? status.detail : ''

  const steps = UPDATE_STEPS.map((step, index): UpdateStep => {
    if (state === 'succeeded') return { ...step, state: 'done', percent: 100, detail: '' }
    // A step the updater never named cannot be placed, so nothing is claimed
    // about any of them rather than guessing an order it did not report.
    if (current < 0) return { ...step, state: 'pending', percent: 0, detail: '' }
    if (index < current) return { ...step, state: 'done', percent: 100, detail: '' }
    if (index > current) return { ...step, state: 'pending', percent: 0, detail: '' }
    return {
      ...step,
      state: state === 'failed' ? 'failed' : 'running',
      percent: state === 'failed' ? 0 : percent,
      detail,
    }
  })

  return {
    state,
    target: typeof status.target === 'string' ? status.target : null,
    steps,
    startedAt: typeof status.startedAt === 'string' ? status.startedAt : null,
    updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt : null,
    detail,
  }
}

function clampPercent(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.round(number)))
}

/** Where the update has got to, or why there is no update to get anywhere. */
export async function updateProgress(): Promise<UpdateProgress> {
  const [present, status] = await Promise.all([updaterPresent(), readJson(paths().status)])
  return toProgress(status, present)
}

export type RequestOutcome =
  { ok: true; id: string } | { ok: false; reason: 'unavailable' | 'busy'; detail: string }

/**
 * Asks the updater to apply a release.
 *
 * Refused while one is already running: two `docker compose up -d` racing over
 * the same containers is not a state anything here could report honestly, and
 * the second one is always a double-click.
 */
export async function requestUpdate(target: string, image: string): Promise<RequestOutcome> {
  const progress = await updateProgress()

  if (progress.state === 'unavailable') {
    return {
      ok: false,
      reason: 'unavailable',
      detail:
        'No updater is running beside this instance. Start it with the `updater` profile, or upgrade by hand.',
    }
  }
  if (progress.state === 'running') {
    return { ok: false, reason: 'busy', detail: 'An update is already under way.' }
  }

  const id = randomBytes(12).toString('hex')

  // `key=value`, and no value that is not already known to be well formed: the
  // reader is a shell, and the version and image are validated again on that
  // side. Two checks for the same thing, because this one can be bypassed by
  // anything that can write to the volume and that one cannot.
  await writeFile(
    paths().request,
    [
      `id=${id}`,
      `target=${target}`,
      `image=${image}`,
      `requestedAt=${new Date().toISOString()}`,
      '',
    ].join('\n'),
    'utf8',
  )

  return { ok: true, id }
}
