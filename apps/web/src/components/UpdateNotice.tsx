import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi, type UpdateProgress as Progress } from '../lib/adminApi'
import { Banner } from './ui'
import { REPO_URL } from './SiteFooter'
import { ApplyUpdateButton, UpdatePanel, useUpdateProgress } from './UpdateProgress'

/**
 * "A newer image than this one has been published."
 *
 * Shown across the admin rather than on the Platform screen alone, because the
 * operator who can act on it does not go looking — the release they need is the
 * one they never heard about. It is also the quietest possible banner: a fact, a
 * link to what changed, and a way to stop being told.
 *
 * Deliberately absent in three cases. A tenant admin never sees it: they cannot
 * pull an image, and telling somebody about work they cannot do is noise. Nor
 * does an `unknown` verdict raise anything — an unreachable registry is not news
 * for a banner, and the Platform screen carries the reason where somebody is
 * already looking for it. And a dismissal sticks until the *next* release, not
 * forever: it is stored against the version it was about.
 */
export function UpdateNotice() {
  const release = useQuery({
    queryKey: ['system', 'release'],
    queryFn: adminApi.systemRelease,
    // The server reads the registry a few times a day at most and hands back a
    // cached answer in between, so asking hourly costs nothing and keeps an
    // admin left open overnight from showing yesterday's verdict.
    refetchInterval: 3_600_000,
    staleTime: 3_600_000,
    // One failure is enough. Nothing here is worth three round trips, and the
    // API answers 404 to anybody who is not a platform admin.
    retry: false,
  })

  const [dismissed, setDismissed] = useState(readDismissed)

  const announced = announcement(release.data, dismissed)

  /*
   * Asked for as soon as there is something to apply, and kept asked for while
   * one is running.
   *
   * The second half is why this is not simply `enabled: Boolean(announced)`: an
   * update that has started is the one thing that must stay on screen after the
   * banner's own reason to exist has gone. Once the new build is up, the
   * release verdict flips to `current` — and the reader would lose the panel at
   * the moment it was about to say "done".
   */
  const progress = useUpdateProgress(Boolean(announced))
  const running = progress.data?.state === 'running' || progress.data?.state === 'failed'

  if (!announced && !running) return null

  return (
    <UpdateBanner
      release={announced}
      progress={progress.data}
      // A poll that failed while a restart was in flight is the restart, not a
      // fault. Distinguishing them is the whole trick of this screen.
      unreachable={progress.isError}
      onDismiss={
        announced
          ? () => {
              writeDismissed(announced.latest)
              setDismissed(announced.latest)
            }
          : undefined
      }
    />
  )
}

/** What is worth announcing, or null. Every rule in the note above lives here. */
export function announcement(
  release: Release | undefined,
  dismissed: string | null,
): AnnouncedRelease | null {
  // `current` and `unknown` both stay silent, for different reasons: one is
  // nothing to say, the other is nothing known. Neither is a banner.
  if (release?.state !== 'update') return null
  // A verdict of `update` without the tag it is about would announce a version
  // nobody could pull.
  if (!release.latest) return null
  if (dismissed === release.latest) return null

  return { latest: release.latest, current: release.current, image: release.image }
}

type Release = Awaited<ReturnType<typeof adminApi.systemRelease>>
export interface AnnouncedRelease {
  latest: string
  current: string | null
  image: string
}

/**
 * The banner itself, separated from where the verdict comes from so it can be
 * rendered alone.
 *
 * It has two faces. Before anything is asked for it is a sentence and two
 * links. Once an update is under way it becomes the progress, in place, because
 * the operator who pressed the button may be on any screen and the one thing
 * they must not have to do is go and find out what happened.
 */
export function UpdateBanner({
  release,
  progress,
  unreachable,
  onDismiss,
}: {
  /** Null once the update has landed and the release verdict has caught up. */
  release: AnnouncedRelease | null
  progress: Progress | undefined
  unreachable: boolean
  /** Absent while an update is running: there is nothing to dismiss mid-flight. */
  onDismiss?: () => void
}) {
  const active = progress?.state === 'running' || progress?.state === 'failed'

  return (
    <Banner tone={progress?.state === 'failed' ? 'down' : 'maintenance'}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: 'var(--space-2) var(--space-4)',
        }}
      >
        <span style={{ flex: '1 1 20rem' }}>
          {active ? (
            <strong>
              {progress?.state === 'failed'
                ? `The update to ${progress.target ?? 'the new release'} did not finish.`
                : `Updating this instance to ${progress?.target ?? 'the new release'}…`}
            </strong>
          ) : release ? (
            <>
              <strong>TERN {release.latest} is available.</strong> This instance runs{' '}
              {release.current ?? 'an older build'}.{' '}
              {/* The commands stay in the sentence even where the button exists.
                  A one-click upgrade is a convenience, not the only way in, and
                  an operator who would rather do it from a shell should not
                  have to go and look up how. */}
              {progress?.state === 'unavailable' ? (
                <>
                  Pull{' '}
                  <code>
                    {release.image}:{release.latest}
                  </code>{' '}
                  and restart to apply it.
                </>
              ) : (
                <>
                  Applying it pulls{' '}
                  <code>
                    {release.image}:{release.latest}
                  </code>{' '}
                  and restarts this instance.
                </>
              )}
            </>
          ) : (
            <strong>This instance has been updated.</strong>
          )}
        </span>

        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            whiteSpace: 'nowrap',
          }}
        >
          <ApplyUpdateButton progress={progress} />
          {release && (
            <a
              // The tag as GitHub spells its releases, which is `v` and then the
              // version — the registry drops that `v` and this has to put it back.
              href={`${REPO_URL}/releases/tag/v${release.latest}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent-ink)', fontWeight: 600 }}
            >
              What changed
            </a>
          )}
          {onDismiss && !active && (
            <button
              type="button"
              onClick={onDismiss}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                font: 'inherit',
                color: 'var(--color-fg-subtle)',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Dismiss
            </button>
          )}
        </span>

        {active && (
          <div style={{ flex: '1 1 100%' }}>
            <UpdatePanel progress={progress} unreachable={unreachable} />
          </div>
        )}
      </div>
    </Banner>
  )
}

/**
 * The version a reader has already been told about.
 *
 * On this browser and not on the account: the notice is about the image running
 * on this machine, and an operator who dismissed it here has not decided
 * anything on behalf of their colleagues.
 */
const KEY = 'tern.update-dismissed'

function readDismissed(): string | null {
  try {
    // Storage throws rather than returning null in Safari's private mode and
    // wherever site data is blocked. A banner is not worth a blank admin.
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(KEY, version)
  } catch {
    // Blocked or full: the notice comes back on the next load, which is the
    // state the reader was already in.
  }
}
