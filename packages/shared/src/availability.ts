import type { CheckStatusValue } from './status.js'

/**
 * The availability rate, computed on duration rather than on a count of checks.
 *
 * ## Why this module exists
 *
 * The published figure used to be `ok_samples / samples` — a ratio of points.
 * Two things follow from that, and neither is visible to somebody reading the
 * page:
 *
 * - A ten-minute outage costs a control probed every 10 s six hundred failed
 *   points, and a control probed every 5 min two. Same outage, same service,
 *   two very different percentages.
 * - Changing a control's interval rewrites the meaning of its whole history,
 *   retroactively and silently.
 *
 * Time-weighting removes both: an outage costs the time it lasted, and the
 * interval decides only how precisely that time is known.
 *
 * ## No I/O here, deliberately
 *
 * This module takes a series and returns a number. Every rule below — the
 * debounce, the maintenance exclusion, the OR across agents, what counts as a
 * gap — is a decision somebody will one day disagree with, and each is testable
 * here without a database, a clock or a fixture server. The SQL that feeds it
 * lives in the route; the judgement lives here.
 */

/** One measurement, as the aggregates and the raw table both carry it. */
export type AvailabilitySample = {
  /** Epoch milliseconds. */
  ts: number
  status: CheckStatusValue
  /**
   * Which agent reported it, when several cover the same control.
   *
   * `null` and `undefined` are one agent — "the server, or whoever" — rather
   * than a distinct one each, so a control that has never been assigned reads
   * as a single series instead of as a fleet of anonymous probes.
   */
  agentId?: string | null
}

/**
 * One bucket of a continuous aggregate, as `checks_1m`/`_5m`/`_1h` store it.
 *
 * The second way into this module, and the reason it takes intervals rather
 * than points. A year of raw checks is exactly what the aggregates exist to
 * avoid reading, but an aggregate has no timestamps left — only counts. So a
 * bucket arrives as an interval with a mixture in it, and the duration is
 * apportioned by that mixture.
 *
 * ── What the aggregate cannot answer ──────────────────────────────────────
 * Two things are gone by the time a bucket exists, and both are named here
 * rather than quietly approximated:
 *
 * - **Which agent.** `checks_1m` groups by `control_id` alone, so several
 *   agents covering one control are already merged. The OR rule therefore
 *   applies only to the raw path. In practice the merge is close to an OR —
 *   a failure from any agent lands in `down_samples` — but it is a count, not
 *   a timeline, so it cannot say the control was down *for* that time.
 * - **When, inside the bucket.** Nine checks passed and one failed; where in
 *   the hour is information the aggregation threw away. A tenth of the hour is
 *   the estimator that neither invents an outage nor hides one, and the
 *   endpoint says which resolution it used so the reader knows how sharp the
 *   answer is.
 */
export type AvailabilityBucket = {
  /** Bucket start, epoch milliseconds. */
  from: number
  /** Bucket end, epoch milliseconds. */
  to: number
  samples: number
  /** `ok_samples`. */
  ok: number
  degraded: number
  /** `down_samples`, which already folds `partial` in. */
  down: number
  maintenance: number
  unknown: number
}

export type TimeWindow = {
  /** Epoch milliseconds, inclusive. */
  from: number
  /** Epoch milliseconds, exclusive. */
  to: number
}

export type AvailabilityInput = {
  window: TimeWindow
  /**
   * The control's expected spacing between checks, in milliseconds.
   *
   * Not cosmetic: it bounds how far a single measurement may speak for. A
   * series that stops has to stop meaning something, or a control that was
   * deleted would go on reporting the state it was last seen in for as long as
   * the window is wide.
   */
  intervalMs: number
  /**
   * Raw checks. Exactly one of `samples` and `buckets` is given.
   *
   * This is the sharp path: every rule applies, including the debounce and the
   * OR across agents, because the timestamps are still there.
   */
  samples?: readonly AvailabilitySample[]
  /**
   * Aggregate buckets, for windows too wide to read raw.
   *
   * `intervalMs` is ignored on this path — a bucket already states its own
   * span, and there is no staleness to infer when the aggregate has a row for
   * every period it covers. A period the aggregate has no row for is unknown,
   * which is what a gap between buckets means.
   */
  buckets?: readonly AvailabilityBucket[]
  /**
   * Periods removed from the calculation entirely — planned maintenance.
   *
   * Removed from the denominator, not counted as up. Counting planned work as
   * available would let a page reach 100% by scheduling enough of it, and
   * counting it as unavailable would punish operators for announcing what they
   * were about to do.
   */
  exclusions?: readonly TimeWindow[]
  /**
   * How many consecutive failures confirm an outage. Default 2.
   *
   * Anti-flapping. One failed check is as often a dropped packet as a dead
   * service, and a status page that opens an incident for each is one nobody
   * reads by the second week.
   *
   * The subtlety is where the outage is deemed to have *started*: at the first
   * failure of the run, not at the one that confirmed it. The service was
   * already broken while the check was being repeated, and dating the outage
   * from the confirmation would hide one interval of every real outage — a
   * systematic bias, always in the flattering direction.
   */
  debounce?: number
  /**
   * How long one sample may speak for before the time becomes unknown.
   *
   * Defaults to twice `intervalMs`: one missed check is a hiccup the next
   * sample resolves, and a gap wider than that is a period nobody observed.
   * Unknown time leaves the denominator rather than being guessed either way —
   * inventing uptime and inventing downtime are both worse than admitting the
   * agent was not reporting.
   */
  maxGapMs?: number
  /**
   * What a silence means for this control.
   *
   * ── Why this is a parameter and not a rule ────────────────────────────────
   * For a probe control, silence means nobody was measuring: the agent was
   * restarting, the scheduler was down, the machine was rebooting. Counting it
   * as an outage would publish the monitoring system's own downtime as the
   * service's, so it is `'unknown'` and leaves the denominator.
   *
   * For a `push` control the heartbeat **is** the measurement. There is no
   * failed check to observe, because nothing was checking — the nightly job
   * simply did not run. Silence is the only signal there is, and treating it as
   * unknown would publish 100% for a backup that has not run in a month, which
   * is the exact figure somebody would rely on to not notice.
   *
   * ── This does not contradict the staleness sweep ──────────────────────────
   * `sweepStaleControls` marks a quiet push control `unknown`, never `down`,
   * and says why: "silence means we stopped hearing, which is not the same
   * claim as the service being broken". That is right, and it answers a
   * different question — what the badge should say *right now*, where declaring
   * a public outage on one missed heartbeat turns every agent restart into an
   * incident. This answers what the period *was*, after the fact, where an hour
   * of unexplained silence from a job that was supposed to report every five
   * minutes is not time to leave out of the arithmetic.
   *
   * Both readings live together on purpose: the badge stays cautious, the
   * percentage stays honest.
   */
  silence?: 'unknown' | 'down'
  /**
   * How long past the expected interval a heartbeat may be late. Push only.
   *
   * Defaults to one full interval, so the effective threshold is twice the
   * declared interval — deliberately the same number as
   * `sweepStaleControls`, which marks a control quiet after
   * `expected_interval_s * 2`. Two thresholds for one question is how a badge
   * and a percentage end up disagreeing about the same minute.
   */
  graceMs?: number
}

export type AvailabilityResult = {
  /**
   * Percentage of observed time the control was available, or `null` when
   * nothing was observed. Unrounded — the display rounding is a separate
   * decision, made where the number is published.
   */
  uptimePct: number | null
  upMs: number
  downMs: number
  /** `upMs + downMs`. The denominator, and the honest one. */
  observedMs: number
  /** Planned maintenance, and samples whose status was `maintenance`. */
  excludedMs: number
  /** Time inside the window that no sample covered. */
  unknownMs: number
}

export const DEFAULT_DEBOUNCE = 2

/**
 * The figure as it should be published, rather than as it was computed.
 *
 * Two separate corrections, and they are not the same one.
 *
 * ── Rounding ──────────────────────────────────────────────────────────────
 * Three decimals. That is where the "nines" people quote stop being
 * distinguishable — 99.999% is five nines, and a fourth decimal invites a
 * reader to compare two numbers that no sampling rate could tell apart.
 *
 * ── The uncertainty floor ─────────────────────────────────────────────────
 * A control checked once a minute over ninety days cannot resolve an outage
 * shorter than a minute; one checked every five minutes cannot resolve one
 * shorter than five. Publishing `99.997%` from a single failed check inside a
 * ninety-day window states a precision the measurement does not have, and the
 * reader has no way to know that. Below one sample's worth of time, the answer
 * is `100`.
 *
 * The threshold is derived from the series — observed time divided by the
 * number of measurements in it — and not from a constant. A constant would be
 * right for one probing rate and wrong for every other, which is the same
 * mistake the check-weighted figure made.
 *
 * This rounds *up* to 100 and never down to 0: an outage shorter than the
 * sampling can resolve is a measurement artefact, whereas an outage longer than
 * it is real and must survive to be published.
 */
export function publishedUptime(
  result: AvailabilityResult,
  /** How many measurements the window contained. */
  samples: number,
): number | null {
  if (result.uptimePct === null) return null
  if (result.downMs <= 0) return 100

  const resolvableMs = samples > 0 ? result.observedMs / samples : 0
  if (result.downMs < resolvableMs) return 100

  return Math.round(result.uptimePct * 1000) / 1000
}

/**
 * `degraded` counts as available, and this is a change.
 *
 * The aggregates count only `operational` as `ok_samples`, so a service that
 * was up and slow lowered the published uptime. That conflates two questions a
 * status page keeps apart everywhere else: the ribbon says whether it worked,
 * the latency band says how well. It also disagrees with every tool a reader
 * might compare against — statuspage, UptimeRobot and Better Uptime all count a
 * degraded service as up.
 *
 * `partial` counts as down, with `down`: it is the state where some of what the
 * control covers is not working, and the reader of an availability figure is
 * asking about that.
 */
function isFailing(status: CheckStatusValue): boolean {
  return status === 'down' || status === 'partial'
}

function isExcluded(status: CheckStatusValue): boolean {
  return status === 'maintenance'
}

function isUnknown(status: CheckStatusValue): boolean {
  return status === 'unknown'
}

/** Clamp to the window, drop the empty, sort, and merge what overlaps. */
function normaliseWindows(windows: readonly TimeWindow[], within: TimeWindow): TimeWindow[] {
  const clamped = windows
    .map((w) => ({ from: Math.max(w.from, within.from), to: Math.min(w.to, within.to) }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from)

  const merged: TimeWindow[] = []
  for (const window of clamped) {
    const last = merged[merged.length - 1]
    // Touching counts as overlapping: two maintenance windows that meet exactly
    // are one period of planned work, and leaving a zero-width seam between
    // them would only make the arithmetic below harder to follow.
    if (last && window.from <= last.to) last.to = Math.max(last.to, window.to)
    else merged.push({ ...window })
  }
  return merged
}

/** How much of `[from, to)` falls outside every excluded window. */
function durationOutside(from: number, to: number, exclusions: readonly TimeWindow[]): number {
  let total = to - from
  for (const window of exclusions) {
    const overlap = Math.min(to, window.to) - Math.max(from, window.from)
    if (overlap > 0) total -= overlap
  }
  return Math.max(0, total)
}

/**
 * One segment of the control's timeline: a state, and the span it holds for.
 *
 * Built before any of the counting happens, because the debounce needs to see
 * runs of consecutive failures and the time-weighting needs durations, and
 * doing both in one pass over the samples produced the kind of loop nobody can
 * change six months later.
 */
type Segment = {
  from: number
  to: number
  /** Share of this interval that was failing, 0 to 1. */
  downFraction: number
  maintenanceFraction: number
  unknownFraction: number
  /**
   * The interval carries one state rather than a mixture.
   *
   * True for anything built from raw checks, false for an aggregate bucket in
   * which some checks passed and others failed. Only a definite interval can
   * take part in the debounce, because only a definite interval still knows
   * that its failures were consecutive.
   */
  definite: boolean
  /**
   * This segment is a missing heartbeat rather than an observed failure.
   *
   * It skips the debounce, and that is not an oversight. The debounce exists to
   * require several consecutive *checks* before believing a failure; a silence
   * produces one long segment, so a debounce of two would discard every one of
   * them and the rule would never fire at all. The tolerance for a late
   * heartbeat is `graceMs`, which is the same idea expressed in the unit that
   * suits it — time, not a count of checks that did not happen.
   */
  fromSilence: boolean
}

/**
 * Aggregate buckets, turned into intervals with a mixture in each.
 *
 * Straightforward next to the sample path, and that asymmetry is the point: a
 * bucket already *is* an interval, whereas a point sample has to be given one
 * by guessing how long it speaks for. Everything downstream sees the same
 * shape, so the four rules live in one place rather than being reimplemented
 * per resolution — which is exactly how a percentage ends up meaning one thing
 * for a day and another for a year.
 */
function segmentsFromBuckets(
  buckets: readonly AvailabilityBucket[],
  window: TimeWindow,
): Segment[] {
  const segments: Segment[] = []

  for (const bucket of buckets) {
    const from = Math.max(bucket.from, window.from)
    const to = Math.min(bucket.to, window.to)
    if (to <= from || bucket.samples <= 0) continue

    const total = bucket.samples
    const downFraction = bucket.down / total
    const maintenanceFraction = bucket.maintenance / total
    const unknownFraction = bucket.unknown / total

    segments.push({
      from,
      to,
      downFraction,
      maintenanceFraction,
      unknownFraction,
      // A bucket whose checks all said the same thing has lost nothing to the
      // aggregation, so it may still take part in the debounce. A mixed one
      // has, and says so.
      definite: downFraction === 1 || downFraction === 0,
      fromSilence: false,
    })
  }

  return segments.sort((a, b) => a.from - b.from)
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { window, intervalMs } = input
  const samples = input.samples ?? []
  const debounce = Math.max(1, input.debounce ?? DEFAULT_DEBOUNCE)
  const silenceIsDown = input.silence === 'down'
  const graceMs = input.graceMs ?? intervalMs
  /*
   * Both defaults land on twice the interval, from two directions: a probe
   * sample speaks for one missed check before the time becomes unknown, and a
   * heartbeat is allowed one full interval of lateness before it counts as
   * missed. The second is the number `sweepStaleControls` already uses.
   */
  const maxGapMs = input.maxGapMs ?? (silenceIsDown ? intervalMs + graceMs : intervalMs * 2)
  /** What a stretch with no live sample is, for this control. */
  const silent = {
    downFraction: silenceIsDown ? 1 : 0,
    maintenanceFraction: 0,
    unknownFraction: silenceIsDown ? 0 : 1,
    definite: true,
    fromSilence: silenceIsDown,
  }
  const exclusions = normaliseWindows(input.exclusions ?? [], window)

  const windowMs = Math.max(0, window.to - window.from)
  const excludedByWindows = exclusions.reduce((sum, w) => sum + (w.to - w.from), 0)

  const empty: AvailabilityResult = {
    uptimePct: null,
    upMs: 0,
    downMs: 0,
    observedMs: 0,
    excludedMs: excludedByWindows,
    unknownMs: Math.max(0, windowMs - excludedByWindows),
  }
  if (windowMs <= 0) return { ...empty, unknownMs: 0, excludedMs: 0 }

  /*
   * Samples from before the window are kept, up to one gap's worth.
   *
   * The state at `window.from` is whatever the last check before it said.
   * Dropping those would make every window begin with a stretch of unknown as
   * long as the interval, which for a daily figure on a five-minute control is
   * a rounding error and for an hourly one on the same control is 8%.
   */
  const relevant = samples
    .filter((s) => s.ts < window.to && s.ts >= window.from - maxGapMs)
    .sort((a, b) => a.ts - b.ts)

  if (input.buckets) {
    return count(segmentsFromBuckets(input.buckets, window))
  }

  if (relevant.length === 0) return empty

  /*
   * ── OR across the agents covering one control ─────────────────────────────
   *
   * A control can be assigned to several agents (`control_agents`), and they
   * check from different places. If one of them cannot reach the service, the
   * service is unreachable from somewhere — that is what the reader wants to
   * know, and it is the reading that cannot be wrong in the dangerous
   * direction. Averaging would let a healthy vantage point cancel a broken one.
   *
   * Each agent's last sample is carried forward until it is older than
   * `maxGapMs`, at which point that agent stops having an opinion rather than
   * holding its last one forever.
   */
  const lastByAgent = new Map<string, AvailabilitySample>()
  const boundaries: number[] = []
  for (const sample of relevant) {
    const at = Math.max(sample.ts, window.from)
    if (boundaries[boundaries.length - 1] !== at) boundaries.push(at)
  }

  const segments: Segment[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const at = boundaries[i]!

    for (const sample of relevant) {
      if (sample.ts > at) break
      lastByAgent.set(sample.agentId ?? '', sample)
    }

    // Exclusive: a sample speaks *for* `maxGapMs` and then stops, so one taken
    // exactly a gap ago no longer has an opinion. Inclusive here would give a
    // sample one boundary more than the rule it is named after promises.
    const live = [...lastByAgent.values()].filter((s) => at - s.ts < maxGapMs)

    const next = boundaries[i + 1] ?? window.to
    // Each sample speaks until the next one, or until it goes stale.
    const freshest = live.reduce((max, s) => Math.max(max, s.ts), Number.NEGATIVE_INFINITY)
    const to = Math.min(
      next,
      window.to,
      freshest === Number.NEGATIVE_INFINITY ? next : freshest + maxGapMs,
    )
    if (to <= at) continue

    if (live.length === 0) {
      segments.push({ from: at, to, ...silent })
      continue
    }

    /*
     * An `unknown` sample on a push control is the staleness sweep's own
     * marker: it is written precisely when a control stopped reporting. Leaving
     * it in the unknown bucket would cancel the thing being counted — the
     * evidence of the silence would remove the silence from the arithmetic.
     */
    const allUnknown = live.every((s) => isUnknown(s.status))

    const failing = live.some((s) => isFailing(s.status)) || (allUnknown && silenceIsDown)
    // Every live agent has to agree it is planned work; one that is measuring
    // a real outage during a maintenance window is still measuring one.
    const excluded = !failing && live.every((s) => isExcluded(s.status))

    segments.push({
      from: at,
      to,
      downFraction: failing ? 1 : 0,
      maintenanceFraction: excluded ? 1 : 0,
      unknownFraction: !failing && !excluded && allUnknown ? 1 : 0,
      definite: true,
      fromSilence: allUnknown && silenceIsDown,
    })

    if (to < next) {
      segments.push({ from: to, to: next, ...silent })
    }
  }

  /**
   * The counting, shared by both paths.
   *
   * Defined once and called from each, because the four rules are the whole
   * point of this module: a resolution that carried its own copy of them is
   * how a percentage comes to mean one thing for a day and another for a
   * year.
   */
  function count(segments: Segment[]): AvailabilityResult {
    /*
     * ── The debounce, applied to runs rather than to points ───────────────────
     *
     * A maximal run of consecutive failing segments counts as an outage only if
     * it holds for `debounce` checks. Shorter runs are flapping and are credited
     * as available — which is the whole point of the setting, and also why the
     * run has to be identified before any duration is added up.
     */
    const failingRuns: { start: number; end: number; length: number }[] = []
    let run: { start: number; end: number; length: number } | null = null
    for (const segment of segments) {
      if (segment.unknownFraction === 1 || segment.maintenanceFraction === 1) {
        // Neither confirms nor breaks a run: nothing was observed, so nothing is
        // known about whether the failure continued.
        continue
      }
      /*
       * Only a *wholly* failing interval can join a run.
       *
       * An interval that is part failing and part not is an aggregate bucket —
       * an hour in which some checks failed and others did not. The flapping the
       * debounce exists to absorb has already been absorbed by the aggregation,
       * and the bucket no longer carries the timestamps that would say whether
       * the failures were consecutive. Putting it through a count of consecutive
       * checks would be applying a rule to information that is no longer there.
       */
      if (segment.definite && segment.downFraction === 1) {
        if (run) {
          run.end = segment.to
          run.length += 1
        } else {
          run = { start: segment.from, end: segment.to, length: 1 }
        }
      } else if (run) {
        failingRuns.push(run)
        run = null
      }
    }
    if (run) failingRuns.push(run)

    const confirmed = failingRuns.filter((r) => r.length >= debounce)

    let upMs = 0
    let downMs = 0
    /*
     * Samples whose *status* was `maintenance`, as opposed to time inside a
     * declared window. Two ways of saying the same thing — one scheduled ahead,
     * one observed — and both leave the denominator.
     */
    let maintenanceMs = 0

    for (const segment of segments) {
      // What is left of this segment once the declared windows are removed.
      const span = durationOutside(segment.from, segment.to, exclusions)
      if (span <= 0) continue

      maintenanceMs += span * segment.maintenanceFraction

      /*
       * The interval's duration, apportioned by what was seen in it.
       *
       * For a raw check the fractions are 0 or 1 and this is the same arithmetic
       * as before. For an aggregate bucket it is the only honest estimator
       * available: the bucket says nine checks passed and one failed, and where
       * inside the hour the failure fell is information the aggregation threw
       * away. Ten per cent of the hour is the answer that neither invents an
       * outage nor hides one.
       */
      const failing =
        // A missing heartbeat is already time-bounded by `graceMs`; putting it
        // through a count of consecutive checks that never happened would discard
        // every silence there is. A fractional interval never had a run to be in.
        segment.fromSilence ||
        !segment.definite ||
        confirmed.some((r) => segment.from >= r.start && segment.to <= r.end)

      const measured = span * (1 - segment.maintenanceFraction - segment.unknownFraction)
      const down = span * segment.downFraction

      if (failing) {
        downMs += down
        upMs += measured - down
      } else {
        // The debounce credited it: flapping, and the time counts as available.
        upMs += measured
      }
    }

    /*
     * The three totals are derived from the window rather than accumulated
     * segment by segment, so they add up to it by construction.
     *
     * Accumulating them separately is how a rounding of nothing turns into a
     * denominator that is not the window — and the one thing a reader is entitled
     * to assume about these four numbers is that they account for the period.
     */
    const outsideExclusions = durationOutside(window.from, window.to, exclusions)
    const observedMs = upMs + downMs
    const excludedMs = windowMs - outsideExclusions + maintenanceMs
    const unknownMs = Math.max(0, outsideExclusions - observedMs - maintenanceMs)

    return {
      uptimePct: observedMs > 0 ? (100 * upMs) / observedMs : null,
      upMs,
      downMs,
      observedMs,
      excludedMs,
      unknownMs,
    }
  }

  return count(segments)
}
