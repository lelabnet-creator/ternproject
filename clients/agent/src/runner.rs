//! The scheduled loop.
//!
//! Runs each probe on its own interval, evaluates it with the shared assertion
//! engine, and pushes the result. What makes it more than a `while true` are the
//! two things a monitoring agent is judged on when the network is bad:
//!
//! * **Jitter.** A fleet paired from the same script would otherwise wake in
//!   lockstep and hit the API in a spike every interval.
//! * **A queue on disk.** A server that is unreachable is exactly when its
//!   status page most needs the history, so points are kept and replayed rather
//!   than dropped. It is bounded and drops the *oldest* first: during a long
//!   outage the recent minutes matter more than the first ones, and an unbounded
//!   queue turns a network problem into a full disk.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tracing::{info, warn};

use crate::config::{Config, ProbeEntry};
use crate::probe::{evaluate, Status};
use crate::probe_transport::observe;
use crate::transport::{Backoff, Client, Point};

/// How many points survive an outage. At one minute per probe this is about a
/// day for a single probe, less for many — bounded on purpose.
const QUEUE_LIMIT: usize = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueuedPoint {
    control_key: String,
    status: Status,
    latency_ms: Option<i64>,
    value: Option<f64>,
    message: Option<String>,
    /// When it was measured — the fact the queue exists to preserve. Defaulted
    /// so a queue written by an older build still replays, just undated.
    #[serde(default)]
    ts: Option<String>,
}

impl From<&QueuedPoint> for Point {
    fn from(queued: &QueuedPoint) -> Self {
        Point {
            control_key: queued.control_key.clone(),
            status: queued.status,
            latency_ms: queued.latency_ms,
            value: queued.value,
            message: queued.message.clone(),
            ts: queued.ts.clone(),
        }
    }
}

impl From<&Point> for QueuedPoint {
    fn from(point: &Point) -> Self {
        QueuedPoint {
            control_key: point.control_key.clone(),
            status: point.status,
            latency_ms: point.latency_ms,
            value: point.value,
            message: point.message.clone(),
            ts: point.ts.clone(),
        }
    }
}

/// A bounded FIFO that survives a restart.
pub struct Queue {
    path: PathBuf,
    points: VecDeque<QueuedPoint>,
    dropped: usize,
}

impl Queue {
    pub fn open(path: &Path) -> Self {
        let mut points = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<VecDeque<QueuedPoint>>(&raw).ok())
            .unwrap_or_default();

        /*
         * A buffer left by the misnamed era, absorbed once.
         *
         * The queue used to be handed paths ending in `.jsonl` — by the Docker
         * entrypoint and the local-agent supervisor — while what it wrote was
         * a single JSON array. The name now says what the file is, but a
         * machine upgrading mid-outage may hold unsent points under the old
         * name, and a rename that lost them would betray the queue's one job.
         */
        let legacy = path.with_extension("jsonl");
        if legacy != path {
            if let Some(mut old) = std::fs::read_to_string(&legacy)
                .ok()
                .and_then(|raw| serde_json::from_str::<VecDeque<QueuedPoint>>(&raw).ok())
            {
                // The legacy buffer is the older half, so it goes first: the
                // queue is a FIFO and eviction eats the front.
                old.extend(points.drain(..));
                points = old;
                let _ = std::fs::remove_file(&legacy);
            }
        }

        // A corrupt or half-written queue starts empty rather than aborting the
        // agent: losing buffered history is bad, monitoring nothing is worse.
        Self {
            path: path.to_path_buf(),
            points,
            dropped: 0,
        }
    }

    fn push(&mut self, point: QueuedPoint) {
        self.points.push_back(point);
        while self.points.len() > QUEUE_LIMIT {
            self.points.pop_front();
            self.dropped += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// What the buffer costs on disk. Estimated from the points rather than
    /// stat-ed: the file is rewritten on every persist, so its size on disk and
    /// its size in memory differ only between two writes, and a syscall per
    /// page refresh is a poor trade for that.
    pub fn bytes(&self) -> u64 {
        self.points
            .iter()
            .map(|point| {
                serde_json::to_string(point)
                    .map(|s| s.len() + 1)
                    .unwrap_or(0) as u64
            })
            .sum()
    }

    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// The next `count` points, without removing them.
    ///
    /// Peek-then-drop rather than pop-then-send: a point removed before the
    /// upstream accepted it is a point lost to a connection reset.
    pub fn peek(&self, count: usize) -> Vec<Point> {
        self.points.iter().take(count).map(Point::from).collect()
    }

    /// Removes what upstream has confirmed.
    pub fn drop_front(&mut self, count: usize) {
        self.points.drain(..count.min(self.points.len()));
        self.persist();
    }

    /// Buffers points received from somewhere else — a proxy's local agents.
    pub fn push_points(&mut self, points: &[Point]) {
        for point in points {
            self.push(QueuedPoint::from(point));
        }
        self.persist();
    }

    /// Throws away what is buffered, and says how much.
    ///
    /// Offered because the alternative an operator reaches for is deleting the
    /// file, which races with a running agent that is about to rewrite it.
    pub fn discard(&mut self) -> usize {
        let count = self.points.len();
        self.points.clear();
        self.persist();
        count
    }

    fn persist(&self) {
        if let Ok(body) = serde_json::to_string(&self.points) {
            // Best effort: a read-only disk must not stop the agent measuring.
            if let Err(error) = std::fs::write(&self.path, body) {
                warn!(%error, "could not persist the queue");
            }
        }
    }
}

/// One probe, measured and evaluated. No I/O to the server.
pub async fn run_once(entry: &ProbeEntry) -> Point {
    let observation = observe(&entry.probe).await;
    let result = evaluate(&entry.assertions, &observation);

    Point {
        control_key: entry.control_key.clone(),
        status: result.status,
        latency_ms: result.latency_ms,
        value: result.value,
        message: result.message,
        // Stamped here, at measurement, precisely so a replay from the queue
        // is dated when it was measured and not when the link came back.
        ts: Some(crate::transport::epoch_to_rfc3339(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        )),
    }
}

/// Resolves when the process is asked to stop.
///
/// SIGTERM as well as SIGINT, because those are two different callers and only
/// one of them is a person at a terminal. `docker stop`, compose and systemd
/// all send SIGTERM; an agent that only watched for Ctrl-C was killed outright
/// by every one of them, losing whatever it had buffered since the last flush.
#[cfg(unix)]
pub async fn stop_requested() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(error) => {
            // Not fatal: without the handler the default action still stops the
            // process, which is what was asked for — just less tidily.
            warn!(%error, "could not listen for SIGTERM");
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
pub async fn stop_requested() {
    let _ = tokio::signal::ctrl_c().await;
}

/// How often the assignment is re-read from the server.
///
/// Five minutes. Until this existed the assignment was fetched once, at
/// startup, and the schedule built from it never changed — so a control added
/// in the admin was not measured until somebody restarted the agent. Worse on
/// the instance's own agent, where the server stands its in-process prober down
/// as soon as an agent reports: the new control was measured by nobody at all.
const REFRESH_EVERY: Duration = Duration::from_secs(300);

/// How often the agent says it is alive.
///
/// Five minutes, and unconditional — it runs whether or not there is anything
/// to probe, and whether or not refreshing is switched off. Everything else the
/// agent sends is a side effect of having work: a push proves it is alive, and
/// so does asking for an assignment. An agent with an empty assignment does
/// neither, so it looked dead to the fleet while being perfectly healthy.
///
/// Well inside the ten-minute window the server calls stale, so one lost
/// heartbeat is not enough to turn the dot amber.
/**
 * Every minute, not every five.
 *
 * A beat is the smallest thing an agent sends, and it is what carries "there is
 * something waiting for you" back from the server — so its period is the worst
 * case for anything the console asks. Five minutes made a Restart button feel
 * broken. One minute is also exactly what the server's own write rate limit on
 * `last_seen_at` was already tuned for.
 */
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);

/// Re-reads the assignment, returning whether anything about it changed.
///
/// A failure is a warning, never fatal — an agent that stops because the server
/// is briefly unreachable is exactly backwards, which is the same reasoning the
/// startup refresh in `main.rs` already applies.
async fn refresh_assignment(client: &Client, config: &mut Config, path: &Path) -> bool {
    let response = match client.jobs(&config.api_key).await {
        Ok(response) => response,
        Err(error) => {
            warn!(%error, "could not refresh the assignment — keeping the current one");
            return false;
        }
    };

    /*
     * Instructions first, and the assignment after.
     *
     * A pause or a stop changes whether the probes below should run at all, and
     * applying them in the other order would run one more cycle of exactly what
     * was just asked to stop.
     */
    if !response.commands.is_empty() {
        let key = config.api_key.clone();
        let restart = crate::commands::apply(client, &key, &response.commands, config, path).await;
        if restart {
            crate::commands::leave_for_restart();
        }
    }

    // Asked before `apply_jobs`, which is what mutates the list out from under it.
    let added = config.new_control_keys(&response.jobs);
    let skipped = config.apply_jobs(&response.jobs);

    for key in &added {
        info!(control = %key, "new from the server");
    }
    for skip in &skipped {
        warn!("skipped {skip}");
    }

    // Written back so the file keeps showing what actually runs. A failure here
    // is not fatal either: the agent holds the assignment in memory and will
    // fetch it again, where refusing to run would lose the measurements too.
    if let Err(error) = config.save(path) {
        warn!(%error, "could not write the refreshed config back");
    }

    !added.is_empty() || !skipped.is_empty()
}

/// Builds the next-run time for every probe, keeping the deadlines already set.
///
/// Keyed by control key rather than by position, because a refresh reorders the
/// list: an index-keyed schedule would silently attach one probe's deadline to
/// another after the server adds a control. Probes that survive keep their
/// place in the cycle, so a refresh does not restart every timer.
fn reschedule(
    config: &Config,
    previous: &HashMap<String, Instant>,
    now: Instant,
) -> HashMap<String, Instant> {
    config
        .probes
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let at = previous
                .get(&entry.control_key)
                .copied()
                .unwrap_or_else(|| {
                    // Spread the first run across the interval. Without this every
                    // probe in the file fires at second zero, which is the same
                    // spike inside one agent that a fleet produces across many.
                    let interval = config.interval_for(entry);
                    now + stagger(index, config.probes.len(), interval)
                });
            (entry.control_key.clone(), at)
        })
        .collect()
}

/// The earliest thing worth waking for: the next probe, the next heartbeat,
/// and — only when refreshing is on — the next assignment refresh.
///
/// That last condition is the whole point of this function existing.
/// `next_refresh` is set once at startup and advanced only inside the branch
/// that actually refreshes, so under `--no-refresh` it stays five minutes past
/// the start for the life of the process. Leaving it in the minimum therefore
/// made every `sleep_until` return immediately once those five minutes had
/// passed, and the loop then ran as fast as the CPU allowed — for ever, since
/// nothing in it can move that deadline.
///
/// Silent while the server answers, because a failed send is the only thing
/// that logs per iteration. When the server is unreachable — the moment
/// monitoring matters most — every agent in the fleet burns a core and writes a
/// warning per turn: measured here at 1 134 698 lines and 233 MB in 104
/// seconds, and found as a 7 GB log that had filled the disk of the machine it
/// was monitoring from.
fn next_wake(
    refresh: bool,
    next_refresh: Instant,
    next_heartbeat: Instant,
    schedule: &HashMap<String, Instant>,
) -> Instant {
    let mut at = next_heartbeat;
    if refresh {
        at = at.min(next_refresh);
    }
    if let Some(earliest) = schedule.values().min().copied() {
        at = at.min(earliest);
    }
    at
}

/// Runs until the process is asked to stop.
///
/// `refresh` is false under `--no-refresh`, where the operator has said to run
/// the file as written.
pub async fn run(
    mut config: Config,
    config_path: PathBuf,
    queue_path: PathBuf,
    refresh: bool,
) -> Result<()> {
    // Only refused when nothing could ever arrive to fill it. With refreshing
    // on, an empty assignment is an ordinary state — it is what the instance's
    // own agent starts in, before anyone has defined a control — and waiting is
    // the useful behaviour where exiting would just be a restart loop.
    if config.probes.is_empty() && !refresh {
        anyhow::bail!("no probes configured — add a [[probes]] section to the config");
    }

    let client = Client::new(&config.server)?;
    let mut queue = Queue::open(&queue_path);
    if !queue.is_empty() {
        info!(
            pending = queue.len(),
            "replaying points from a previous run"
        );
    }

    info!(
        probes = config.probes.len(),
        server = %config.server,
        "agent started"
    );
    if config.probes.is_empty() {
        info!("nothing assigned yet — waiting for the server to hand something over");
    }

    /*
     * The page, when the config asks for one.
     *
     * Spawned rather than awaited: it serves for as long as the agent runs and
     * has nothing to hand back. A failure to bind is a warning and not a
     * refusal to start — an agent whose port is taken must keep measuring,
     * because measuring is its job and the page is a convenience.
     */
    let ui = crate::ui::UiState::new(config.ui.as_ref().and_then(|u| u.credential.clone()));
    if let Some(settings) = config.ui.clone() {
        let state = ui.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::ui::serve(state, &settings.listen).await {
                warn!(%error, address = %settings.listen, "could not serve the agent page");
            }
        });
    }

    ui.update(|snapshot| {
        snapshot.role = "tern-agent".to_string();
        snapshot.version = env!("CARGO_PKG_VERSION").to_string();
        snapshot.server = config.server.clone();
        snapshot.probes = config.probes.len();
    })
    .await;

    // Counted since this process started, not since the beginning of time: the
    // page reports what this run has done, and a total that survived restarts
    // would need somewhere to survive in.
    let mut checks_ok: u64 = 0;
    let mut checks_failed: u64 = 0;

    let mut schedule = reschedule(&config, &HashMap::new(), Instant::now());
    let mut next_refresh = Instant::now() + REFRESH_EVERY;
    // Immediately, not in five minutes: the first thing a freshly started agent
    // owes the fleet is that it exists. Without this an idle agent is invisible
    // for its first interval, which is the interval somebody is watching.
    let mut next_heartbeat = Instant::now();
    let mut heartbeat_backoff = Backoff::new();
    let mut flush_backoff = Backoff::new();
    let mut flush_hold: Option<Instant> = None;

    loop {
        let wake_at = next_wake(refresh, next_refresh, next_heartbeat, &schedule);

        tokio::select! {
            _ = tokio::time::sleep_until(wake_at) => {}
            _ = stop_requested() => {
                info!(pending = queue.len(), "stopping — the queue is on disk");
                queue.persist();
                return Ok(());
            }
        }

        let mut now = Instant::now();

        /*
         * Stopped means silent, and that includes not asking for instructions.
         *
         * It is what makes the state final in the way the console promised: an
         * agent that kept polling could be resumed from there, and the button
         * that set it said it could not be. Getting it back needs a shell —
         * `tern-agent resume` — which is exactly what was said before asking.
         */
        if !config.state.reports() {
            // Nothing is happening, so there is nothing to wake for often.
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            continue;
        }

        if now >= next_heartbeat {
            // A failure is a warning and nothing more. The server being briefly
            // unreachable is the moment an agent must keep going, not the
            // moment it should start treating its own liveness as an error.
            // Recomputed each beat rather than cached: an address can change
            // under an agent — DHCP, a new interface, a machine that moved —
            // and a stale one is a link the console offers to nowhere.
            let ui_address = config
                .ui
                .as_ref()
                .and_then(|settings| settings.reachable_address(&config.server));

            match client
                .heartbeat(&config.api_key, ui_address.as_deref())
                .await
            {
                Ok(waiting) => {
                    heartbeat_backoff.succeeded();
                    // Told there is something to fetch, so fetch it now rather
                    // than at the next refresh — which is what the wait was.
                    if waiting {
                        info!("the server has an instruction waiting");
                        next_refresh = Instant::now();
                    }
                    ui.update(|snapshot| {
                        snapshot.last_heartbeat_ok_s = Some(0);
                        snapshot.last_heartbeat_error = None;
                    })
                    .await;
                    next_heartbeat = Instant::now() + HEARTBEAT_EVERY;
                }
                Err(error) => {
                    /*
                     * Backed off, doubling to a quarter of an hour. A
                     * permanent 401 used to be one warn per minute forever —
                     * noise exactly where somebody needs to read — and
                     * hammering an unreachable server helps nobody. The first
                     * success resets the cadence.
                     */
                    let delay = heartbeat_backoff.failed();
                    warn!(%error, retry_in_s = delay.as_secs(), "heartbeat failed");
                    // The message, not a boolean. "heartbeat refused (401)" and
                    // "could not reach the server" send somebody to two
                    // different places, and a red light that says neither sends
                    // them to the journal to find out.
                    let text = error.to_string();
                    ui.update(|snapshot| snapshot.last_heartbeat_error = Some(text))
                        .await;
                    next_heartbeat = Instant::now() + delay;
                }
            }
        }

        if refresh && now >= next_refresh {
            if refresh_assignment(&client, &mut config, &config_path).await {
                now = Instant::now();
                schedule = reschedule(&config, &schedule, now);
            }
            next_refresh = Instant::now() + REFRESH_EVERY;
        }

        let mut batch: Vec<QueuedPoint> = Vec::new();

        // Paused: still reporting, so the console can undo it, but measuring
        // nothing. The heartbeat above is what keeps it reachable.
        let probes: &[ProbeEntry] = if config.state.measures() {
            &config.probes
        } else {
            &[]
        };

        for entry in probes {
            let Some(at) = schedule.get(&entry.control_key).copied() else {
                continue;
            };
            if at > now {
                continue;
            }

            let point = run_once(entry).await;

            info!(
                control = %point.control_key,
                kind = entry.probe.kind(),
                status = ?point.status,
                latency_ms = ?point.latency_ms,
                "probed"
            );

            if matches!(point.status, Status::Operational | Status::Degraded) {
                checks_ok += 1;
            } else {
                checks_failed += 1;
            }

            batch.push(QueuedPoint::from(&point));

            let interval = config.interval_for(entry);
            schedule.insert(
                entry.control_key.clone(),
                now + Duration::from_secs(interval) + jitter(interval),
            );
        }

        for point in batch {
            queue.push(point);
        }

        /*
         * The same pacing as the heartbeat, for the same reason: an upstream
         * that refuses every push does not deserve a retry on every wake.
         * Points keep queueing (and persisting) while the hold lasts, so
         * backing off costs freshness, never history.
         */
        if flush_hold.is_none_or(|until| Instant::now() >= until) {
            match flush(&client, &config.api_key, &mut queue, &ui).await {
                FlushOutcome::Sent => {
                    flush_backoff.succeeded();
                    flush_hold = None;
                }
                FlushOutcome::Failed => {
                    let delay = flush_backoff.failed();
                    warn!(retry_in_s = delay.as_secs(), "holding off the next push");
                    flush_hold = Some(Instant::now() + delay);
                }
                FlushOutcome::Nothing => {}
            }
        }

        ui.update(|snapshot| {
            snapshot.probes = config.probes.len();
            snapshot.queued = queue.len();
            snapshot.dropped = queue.dropped();
            snapshot.checks_ok = checks_ok;
            snapshot.checks_failed = checks_failed;
            // What the buffer is costing on disk, not how many rows it holds.
            // "412 points" says nothing about whether a machine with a small
            // root filesystem is in trouble; kilobytes do.
            snapshot.queue_bytes = queue.bytes();
        })
        .await;
    }
}

/// What one flush attempt amounted to, so the loop can pace the next one.
enum FlushOutcome {
    /// The server took the chunk (rejections included — it answered).
    Sent,
    /// The server could not be reached; the points are kept.
    Failed,
    /// Nothing queued, nothing tried. Says nothing about the server.
    Nothing,
}

/// Sends everything queued, keeping it if the server cannot be reached.
async fn flush(
    client: &Client,
    api_key: &str,
    queue: &mut Queue,
    ui: &std::sync::Arc<crate::ui::UiState>,
) -> FlushOutcome {
    if queue.is_empty() {
        return FlushOutcome::Nothing;
    }

    // Chunked, because a long outage can leave thousands queued and a single
    // request of all of them would be refused for its size — and then never
    // shrink, which is the failure mode where an agent never recovers.
    const CHUNK: usize = 200;
    let chunk: Vec<Point> = queue.points.iter().take(CHUNK).map(Point::from).collect();

    match client.ingest(api_key, &chunk).await {
        Ok(response) => {
            queue.points.drain(..chunk.len());
            ui.update(|snapshot| {
                snapshot.last_send_ok_s = Some(0);
                snapshot.last_send_error = None;
            })
            .await;
            for rejected in &response.rejected {
                // Named rather than retried: an unknown control key is a
                // configuration mistake, and replaying it forever would hide it.
                warn!(control = %rejected.control_key, reason = %rejected.reason, "point rejected");
            }
            if queue.dropped() > 0 {
                warn!(
                    dropped = queue.dropped(),
                    "the queue overflowed during the outage — oldest points were discarded"
                );
            }
            queue.persist();
            FlushOutcome::Sent
        }
        Err(error) => {
            warn!(%error, pending = queue.len(), "could not reach the server — points kept");
            let text = error.to_string();
            ui.update(|snapshot| snapshot.last_send_error = Some(text))
                .await;
            queue.persist();
            FlushOutcome::Failed
        }
    }
}

/// Sends everything queued, in chunks, and says how many were accepted.
///
/// The one-shot path (`run --once`): the loop uses `flush`, which also feeds
/// the local page. Stops at the first failure with the remainder still on
/// disk — `push_points` persisted before the first request went out, so a
/// failure here loses nothing.
pub async fn drain(client: &Client, api_key: &str, queue: &mut Queue) -> anyhow::Result<usize> {
    const CHUNK: usize = 200;
    let mut accepted = 0;

    while !queue.is_empty() {
        let chunk = queue.peek(CHUNK);
        let response = client.ingest(api_key, &chunk).await?;
        queue.drop_front(chunk.len());
        accepted += response.accepted;
        for rejected in &response.rejected {
            // Named rather than retried, like the loop: an unknown control key
            // is a configuration mistake, and replaying it forever hides it.
            warn!(control = %rejected.control_key, reason = %rejected.reason, "point rejected");
        }
    }

    Ok(accepted)
}

/// A deterministic spread of first runs across the interval.
fn stagger(index: usize, total: usize, interval_s: u64) -> Duration {
    if total <= 1 {
        return Duration::ZERO;
    }
    Duration::from_millis((interval_s * 1000 * index as u64) / total as u64)
}

/// Up to 10% of the interval, so a fleet paired from one script drifts apart
/// instead of arriving together every minute.
///
/// Derived from the clock rather than a random number generator: the agent has
/// no need of one elsewhere, and a nanosecond count is as unpredictable as this
/// needs to be.
fn jitter(interval_s: u64) -> Duration {
    let span = (interval_s * 1000) / 10;
    if span == 0 {
        return Duration::ZERO;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(nanos % span)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe_transport::Probe;

    fn point(key: &str) -> QueuedPoint {
        QueuedPoint {
            control_key: key.to_string(),
            status: Status::Operational,
            latency_ms: Some(1),
            value: None,
            message: None,
            ts: Some("2026-08-12T09:15:07Z".to_string()),
        }
    }

    fn probe_entry(key: &str) -> ProbeEntry {
        ProbeEntry {
            control_key: key.to_string(),
            probe: Probe::Tcp {
                host: "127.0.0.1".into(),
                port: 1,
                timeout_ms: 1_000,
            },
            assertions: Vec::new(),
            interval_s: Some(60),
            managed: true,
        }
    }

    fn config_with(keys: &[&str]) -> Config {
        Config {
            server: "http://127.0.0.1:3011".into(),
            api_key: "tern_test".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: keys.iter().map(|key| probe_entry(key)).collect(),
            ui: None,
        }
    }

    /// The rename must not cost a single buffered point: a machine upgrading
    /// mid-outage holds unsent history under the old `.jsonl` name.
    #[test]
    fn opening_absorbs_a_legacy_jsonl_buffer_oldest_first() {
        let dir = std::env::temp_dir().join(format!(
            "tern-queue-{}",
            crate::transport::random_token(8)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let new_path = dir.join("agent-queue.json");
        let old_path = dir.join("agent-queue.jsonl");

        std::fs::write(
            &old_path,
            serde_json::to_string(&vec![point("from-before")]).unwrap(),
        )
        .unwrap();
        std::fs::write(
            &new_path,
            serde_json::to_string(&vec![point("from-now")]).unwrap(),
        )
        .unwrap();

        let queue = Queue::open(&new_path);
        let keys: Vec<String> = queue.peek(10).iter().map(|p| p.control_key.clone()).collect();
        // Older half first: the queue is a FIFO and eviction eats the front.
        assert_eq!(keys, ["from-before", "from-now"]);
        assert!(!old_path.exists(), "absorbed once, not on every start");
    }

    #[test]
    fn a_refresh_keeps_the_deadlines_of_probes_that_survived() {
        // The subtle half of periodic refreshing. The schedule used to be keyed
        // by position in `config.probes`; after the server adds a control the
        // list reorders, and an index-keyed schedule would hand one probe's
        // deadline to another. Worse, every surviving probe would restart its
        // timer on each refresh — with a five-minute refresh and a ten-minute
        // interval, a probe would never run at all.
        let now = Instant::now();
        let before = reschedule(&config_with(&["a", "b"]), &HashMap::new(), now);

        // The server hands over a third control, and reorders the list.
        let after = reschedule(&config_with(&["c", "b", "a"]), &before, now);

        assert_eq!(after.get("a"), before.get("a"));
        assert_eq!(after.get("b"), before.get("b"));
        // The newcomer gets a deadline of its own rather than inheriting one.
        assert!(after.contains_key("c"));
    }

    #[test]
    fn a_probe_the_server_withdrew_leaves_the_schedule() {
        let now = Instant::now();
        let before = reschedule(&config_with(&["a", "b"]), &HashMap::new(), now);
        let after = reschedule(&config_with(&["a"]), &before, now);

        assert!(after.contains_key("a"));
        // Otherwise the loop would keep waking for a probe it no longer has.
        assert!(!after.contains_key("b"));
    }

    #[test]
    fn an_empty_assignment_schedules_nothing_without_panicking() {
        // The state the instance's own agent starts in, before anybody has
        // defined a control. The old loop called `.min().unwrap()` on this.
        let schedule = reschedule(&config_with(&[]), &HashMap::new(), Instant::now());
        assert!(schedule.is_empty());
        assert_eq!(schedule.values().min().copied(), None);
    }

    #[test]
    fn the_queue_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("tern-q-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.json");

        let mut queue = Queue::open(&path);
        queue.push(point("a"));
        queue.push(point("b"));
        queue.persist();

        let reopened = Queue::open(&path);
        assert_eq!(reopened.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_queue_drops_the_oldest_rather_than_growing_without_bound() {
        let dir = std::env::temp_dir().join(format!("tern-q-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.json");

        let mut queue = Queue::open(&path);
        for i in 0..QUEUE_LIMIT + 10 {
            queue.push(point(&format!("c{i}")));
        }

        assert_eq!(queue.len(), QUEUE_LIMIT);
        assert_eq!(queue.dropped(), 10);
        // During a long outage the recent minutes are the ones worth keeping.
        assert_eq!(queue.points.front().unwrap().control_key, "c10");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_queue_file_starts_empty_instead_of_stopping_the_agent() {
        let dir = std::env::temp_dir().join(format!("tern-q-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        assert!(Queue::open(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn first_runs_are_spread_across_the_interval() {
        // All four firing at once is the spike this exists to avoid.
        let offsets: Vec<u128> = (0..4).map(|i| stagger(i, 4, 60).as_millis()).collect();
        assert_eq!(offsets, vec![0, 15_000, 30_000, 45_000]);
        assert_eq!(stagger(0, 1, 60), Duration::ZERO);
    }

    #[test]
    fn jitter_stays_within_a_tenth_of_the_interval() {
        for _ in 0..50 {
            assert!(jitter(60) < Duration::from_secs(6));
        }
        assert_eq!(jitter(0), Duration::ZERO);
    }

    #[tokio::test]
    async fn a_probe_that_cannot_connect_produces_a_down_point_rather_than_nothing() {
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };

        let entry = ProbeEntry {
            control_key: "gone".into(),
            probe: Probe::Tcp {
                host: "127.0.0.1".into(),
                port,
                timeout_ms: 1_000,
            },
            assertions: Vec::new(),
            interval_s: None,
            managed: true,
        };

        let point = run_once(&entry).await;
        // Silence would leave the page showing the last good reading forever.
        assert_eq!(point.status, Status::Down);
        assert!(point.message.is_some());
    }

    #[tokio::test]
    async fn a_reachable_target_produces_an_operational_point() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let entry = ProbeEntry {
            control_key: "up".into(),
            probe: Probe::Tcp {
                host: "127.0.0.1".into(),
                port,
                timeout_ms: 1_000,
            },
            assertions: Vec::new(),
            interval_s: None,
            managed: true,
        };

        let point = run_once(&entry).await;
        assert_eq!(point.status, Status::Operational);
        assert!(point.latency_ms.is_some());
    }

    /// A deadline nothing can move must never be able to end the wait.
    ///
    /// Measured on the machine that found it: with the refresh deadline left in
    /// the minimum, `--no-refresh` turned into 1 134 698 log lines and 233 MB in
    /// 104 seconds, at a full core. The five minutes before that look perfectly
    /// healthy, which is why it survived this long.
    #[tokio::test]
    async fn the_refresh_deadline_cannot_wake_an_agent_that_never_refreshes() {
        let now = Instant::now();
        let stuck = now - Duration::from_secs(60); // as it is five minutes in
        let heartbeat = now + Duration::from_secs(120);

        let at = next_wake(false, stuck, heartbeat, &HashMap::new());
        assert_eq!(at, heartbeat, "a stuck deadline must not end the wait");
        assert!(at > now, "waking in the past is the spin itself");

        // And it still governs when refreshing is on, which is the whole reason
        // it is in the minimum at all.
        assert_eq!(next_wake(true, stuck, heartbeat, &HashMap::new()), stuck);
    }

    /// The soonest probe still wins, in both modes.
    #[tokio::test]
    async fn the_next_probe_is_what_usually_ends_the_wait() {
        let now = Instant::now();
        let heartbeat = now + Duration::from_secs(300);
        let soon = now + Duration::from_secs(30);
        let schedule = HashMap::from([
            ("a".to_string(), soon),
            ("b".to_string(), now + Duration::from_secs(90)),
        ]);

        assert_eq!(next_wake(false, now, heartbeat, &schedule), soon);
        assert_eq!(
            next_wake(true, now + Duration::from_secs(300), heartbeat, &schedule),
            soon
        );
    }
}
