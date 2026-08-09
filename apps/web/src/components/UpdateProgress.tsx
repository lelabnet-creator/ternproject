import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type UpdateProgress as Progress } from '../lib/adminApi'
import { Button } from './ui'

/**
 * Applying an upgrade, and watching it happen.
 *
 * The unusual thing about this screen is that the server it is talking to is
 * the thing being replaced. Halfway through the last step the API stops
 * answering, and a few seconds later a different build of it starts. So a
 * failed poll during `restart` is not an error — it is the step working — and
 * everything here is arranged around not lying about that moment.
 *
 * That is also why the progress lives in a file rather than in a request: the
 * process that reports the ending is not the process that began.
 */

/** How often to ask while something is moving. */
const LIVE_MS = 2000

export function useUpdateProgress(enabled: boolean) {
  return useQuery({
    queryKey: ['system', 'update'],
    queryFn: adminApi.updateProgress,
    enabled,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? LIVE_MS : false),
    // Kept through the restart. Without this the panel empties the moment the
    // API goes away — at exactly the second the reader most wants to see that
    // something is still in hand.
    placeholderData: (previous) => previous,
    retry: false,
  })
}

/**
 * The full stepper.
 *
 * Every step is listed from the start, including the ones not reached, because
 * "what is left" is most of the question being asked. A bar only appears on the
 * step that has one — a percentage on a step that is waiting is a number made
 * up to fill a column.
 */
export function UpdatePanel({
  progress,
  unreachable,
}: {
  progress: Progress | undefined
  /** The API stopped answering. During `restart` that is the good outcome. */
  unreachable: boolean
}) {
  if (!progress) return null

  const restarting = unreachable && progress.state === 'running'

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 'var(--space-3)',
        }}
      >
        {progress.steps.map((step) => (
          <li key={step.id} style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <StepMark state={step.state} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: step.state === 'running' ? 600 : 400,
                  color: step.state === 'pending' ? 'var(--color-fg-subtle)' : 'var(--color-fg)',
                }}
              >
                {step.label}
              </div>

              {step.state === 'running' && (
                <ProgressBar
                  percent={step.percent}
                  // The pull knows how many layers it has; the other two do not
                  // know anything they could turn into a fraction, and a bar
                  // creeping to 50% on a step with two states is decoration.
                  indeterminate={step.id !== 'pull'}
                />
              )}

              {step.detail && (step.state === 'running' || step.state === 'failed') && (
                <div
                  className="measure"
                  style={{
                    marginTop: 'var(--space-1)',
                    fontSize: 'var(--text-xs)',
                    color: step.state === 'failed' ? 'var(--status-down)' : 'var(--color-fg-muted)',
                  }}
                >
                  {step.detail}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p
        className="measure"
        style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
      >
        {restarting
          ? 'This instance is being replaced, so it has stopped answering. That is the step working. This page will reconnect on its own.'
          : progress.state === 'succeeded'
            ? `Done. This instance now runs ${progress.target ?? 'the new release'}. Reload to be sure you are looking at it.`
            : progress.detail}
      </p>
    </div>
  )
}

/** The button, with everything that stops it being one. */
export function ApplyUpdateButton({
  progress,
  onStarted,
}: {
  progress: Progress | undefined
  onStarted?: () => void
}) {
  const client = useQueryClient()

  const apply = useMutation({
    mutationFn: adminApi.applyUpdate,
    onSuccess: () => {
      // Asked for immediately rather than on the next tick: the updater picks
      // the request up within a few seconds, and a button that goes quiet until
      // then reads as a button that did nothing.
      void client.invalidateQueries({ queryKey: ['system', 'update'] })
      onStarted?.()
    },
  })

  if (!progress || progress.state === 'unavailable') return null
  if (progress.state === 'running') return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <Button variant="primary" busy={apply.isPending} onClick={() => apply.mutate()}>
        Update this instance
      </Button>
      {apply.error && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-down)' }}>
          {apply.error instanceof ApiError ? apply.error.message : 'Could not ask for the update.'}
        </span>
      )}
    </span>
  )
}

function ProgressBar({ percent, indeterminate }: { percent: number; indeterminate: boolean }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted while indeterminate, which is what tells a screen reader the
      // difference between "no progress" and "progress not known".
      aria-valuenow={indeterminate ? undefined : percent}
      style={{
        marginTop: 'var(--space-2)',
        height: 6,
        borderRadius: 3,
        background: 'var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: indeterminate ? '35%' : `${percent}%`,
          borderRadius: 3,
          background: 'var(--color-accent)',
          transition: 'width 400ms ease',
          animation: indeterminate ? 'tern-indeterminate 1.4s ease-in-out infinite' : undefined,
        }}
      />
    </div>
  )
}

function StepMark({ state }: { state: Progress['steps'][number]['state'] }) {
  // A shape as well as a colour, so the three states are not one hue apart.
  const mark = state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'running' ? '•' : '○'
  const colour =
    state === 'done'
      ? 'var(--status-operational)'
      : state === 'failed'
        ? 'var(--status-down)'
        : state === 'running'
          ? 'var(--color-accent)'
          : 'var(--color-fg-subtle)'

  return (
    <span
      aria-hidden="true"
      style={{
        width: 16,
        flexShrink: 0,
        textAlign: 'center',
        color: colour,
        fontSize: 'var(--text-sm)',
        lineHeight: 1.5,
      }}
    >
      {mark}
    </span>
  )
}
