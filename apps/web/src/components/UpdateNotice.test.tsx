import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UpdateProgress as Progress } from '../lib/adminApi'
import { announcement, UpdateBanner } from './UpdateNotice'

/**
 * When the notice appears, and — mostly — when it does not.
 *
 * The failures worth guarding against are both silent. One is a banner that
 * cannot be got rid of, which trains an operator to ignore the strip where every
 * other warning also appears. The other is a banner raised by *unknown*, which
 * would turn "the registry could not be reached" into "upgrade now".
 */

const release = {
  state: 'update' as const,
  current: '0.1.6',
  latest: '0.1.7',
  revision: '9f2a1c0',
  image: 'ghcr.io/lelabnet-creator/ternproject',
  checkedAt: '2026-08-09T09:00:00.000Z',
  detail: '0.1.7 has been published. This instance runs 0.1.6.',
}

describe('announcement', () => {
  it('announces a published release this instance is behind', () => {
    expect(announcement(release, null)).toEqual({
      latest: '0.1.7',
      current: '0.1.6',
      image: 'ghcr.io/lelabnet-creator/ternproject',
    })
  })

  it('says nothing while the answer is still being fetched', () => {
    expect(announcement(undefined, null)).toBeNull()
  })

  it('says nothing when this build is the newest one', () => {
    expect(announcement({ ...release, state: 'current' }, null)).toBeNull()
  })

  it('says nothing when nothing is known', () => {
    // An unreachable registry and an unstamped build both land here. Reporting
    // either as an available upgrade would be inventing one.
    expect(announcement({ ...release, state: 'unknown', latest: null }, null)).toBeNull()
  })

  it('stays dismissed for the version it was dismissed at', () => {
    expect(announcement(release, '0.1.7')).toBeNull()
  })

  it('comes back for the next release after that', () => {
    // The dismissal is about one version, not about update notices in general.
    expect(announcement({ ...release, latest: '0.1.8' }, '0.1.7')).not.toBeNull()
  })
})

const announced = { latest: '0.1.7', current: '0.1.6', image: 'ghcr.io/owner/tern' }

/** A progress record in whatever state a test needs. */
function progress(over: Partial<Progress> = {}): Progress {
  return {
    state: 'unavailable',
    target: null,
    steps: [
      { id: 'pull', label: 'Fetching the new image', state: 'pending', percent: 0, detail: '' },
      {
        id: 'verify',
        label: 'Checking it is what was asked for',
        state: 'pending',
        percent: 0,
        detail: '',
      },
      { id: 'restart', label: 'Restarting the instance', state: 'pending', percent: 0, detail: '' },
    ],
    startedAt: null,
    updatedAt: null,
    detail: 'No updater is running beside this instance.',
    ...over,
  }
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  // The button and the panel both read react-query, and a static render of a
  // hook-using child needs a client. Nothing here fetches: the state is passed
  // in as a prop, which is why these components take one.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('UpdateBanner, before anything is applied', () => {
  const html = render(
    <UpdateBanner
      release={announced}
      progress={progress()}
      unreachable={false}
      onDismiss={() => {}}
    />,
  )

  it('names both versions, so the reader knows what the jump is', () => {
    expect(html).toContain('0.1.7')
    expect(html).toContain('0.1.6')
  })

  it('carries the exact image to pull', () => {
    expect(html).toContain('ghcr.io/owner/tern:0.1.7')
  })

  it('links the release notes under the tag GitHub actually publishes', () => {
    // The registry drops the `v`; the release page keeps it, and a link to
    // `/releases/tag/0.1.7` is a 404.
    expect(html).toContain('/releases/tag/v0.1.7')
  })

  it('opens that link without handing the tab away', () => {
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('offers no button when there is no updater to press it', () => {
    // Offering one that answers 412 is worse than not offering one, so the
    // sentence tells them what to type instead.
    expect(html).not.toContain('Update this instance')
    expect(html).toContain('and restart to apply it')
  })

  it('offers the button once an updater is watching', () => {
    const withUpdater = render(
      <UpdateBanner
        release={announced}
        progress={progress({ state: 'idle' })}
        unreachable={false}
        onDismiss={() => {}}
      />,
    )
    expect(withUpdater).toContain('Update this instance')
    // And still says what the button will do, for anyone who would rather do
    // it from a shell.
    expect(withUpdater).toContain('ghcr.io/owner/tern:0.1.7')
  })
})

describe('UpdateBanner, while an update runs', () => {
  const running = progress({
    state: 'running',
    target: '0.1.7',
    steps: [
      {
        id: 'pull',
        label: 'Fetching the new image',
        state: 'running',
        percent: 42,
        detail: '3 of 7 layers',
      },
      {
        id: 'verify',
        label: 'Checking it is what was asked for',
        state: 'pending',
        percent: 0,
        detail: '',
      },
      { id: 'restart', label: 'Restarting the instance', state: 'pending', percent: 0, detail: '' },
    ],
    detail: '3 of 7 layers',
  })

  it('replaces the offer with the progress', () => {
    const html = render(<UpdateBanner release={announced} progress={running} unreachable={false} />)
    expect(html).toContain('Updating this instance to 0.1.7')
    expect(html).toContain('3 of 7 layers')
    expect(html).toContain('aria-valuenow="42"')
    // Pressing it twice is the double-click this guards against.
    expect(html).not.toContain('Update this instance')
  })

  it('reads a dead API during the restart as the restart, not a fault', () => {
    const restarting = progress({
      state: 'running',
      target: '0.1.7',
      steps: running.steps.map((step) =>
        step.id === 'restart'
          ? { ...step, state: 'running' as const, detail: 'Recreating the instance' }
          : { ...step, state: 'done' as const, percent: 100, detail: '' },
      ),
    })
    const html = render(
      <UpdateBanner release={announced} progress={restarting} unreachable={true} />,
    )
    expect(html).toContain('That is the step working')
    // The restart step has no fraction to report, so it must not claim one.
    expect(html).not.toContain('aria-valuenow')
  })

  it('says which step failed and keeps the reason', () => {
    const failed = progress({
      state: 'failed',
      target: '0.1.7',
      steps: running.steps.map((step) =>
        step.id === 'pull'
          ? { ...step, state: 'failed' as const, percent: 0, detail: 'no space left on device' }
          : step,
      ),
    })
    const html = render(<UpdateBanner release={announced} progress={failed} unreachable={false} />)
    expect(html).toContain('did not finish')
    expect(html).toContain('no space left on device')
  })

  it('still says something once the release verdict has caught up', () => {
    // The new build reports itself as current, so `release` goes null while the
    // panel is still showing the result. Losing the banner there would hide the
    // ending from whoever pressed the button.
    const html = render(
      <UpdateBanner
        release={null}
        progress={progress({ state: 'failed', target: '0.1.7' })}
        unreachable={false}
      />,
    )
    expect(html).toContain('did not finish')
  })
})
