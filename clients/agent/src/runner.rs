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
use crate::transport::{Client, Point};

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
}

impl From<&QueuedPoint> for Point {
    fn from(queued: &QueuedPoint) -> Self {
        Point {
            control_key: queued.control_key.clone(),
            status: queued.status,
            latency_ms: queued.latency_ms,
            value: queued.value,
            message: queued.message.clone(),
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
        let points = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<VecDeque<QueuedPoint>>(&raw).ok())
            .unwrap_or_default();

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
            self.push(QueuedPoint {
                control_key: point.control_key.clone(),
                status: point.status,
                latency_ms: point.latency_ms,
                value: point.value,
                message: point.message.clone(),
            });
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
    }
}

/// Resolves when the process is asked to stop.
///
/// SIGTERM as well as SIGINT, because those are two different callers and only
/// one of them is a person at a terminal. `docker stop`, compose and systemd
/// all send SIGTERM; an agent that only watched for Ctrl-C was killed outright
/// by every one of them, losing whatever it had buffered since the last flush.
#[cfg(unix)]
async fn stop_requested() {
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
async fn stop_requested() {
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
const HEARTBEAT_EVERY: Duration = Duration::from_secs(300);

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

    let mut schedule = reschedule(&config, &HashMap::new(), Instant::now());
    let mut next_refresh = Instant::now() + REFRESH_EVERY;
    // Immediately, not in five minutes: the first thing a freshly started agent
    // owes the fleet is that it exists. Without this an idle agent is invisible
    // for its first interval, which is the interval somebody is watching.
    let mut next_heartbeat = Instant::now();

    loop {
        // The earliest of the three: the next probe, the next refresh, the next
        // heartbeat. With an empty assignment there is no probe, and the other
        // two are the only things that can end the wait — which is why they
        // belong in this select rather than in timers of their own.
        let mut wake_at = next_refresh.min(next_heartbeat);
        if let Some(at) = schedule.values().min().copied() {
            wake_at = wake_at.min(at);
        }

        tokio::select! {
            _ = tokio::time::sleep_until(wake_at) => {}
            _ = stop_requested() => {
                info!(pending = queue.len(), "stopping — the queue is on disk");
                queue.persist();
                return Ok(());
            }
        }

        let mut now = Instant::now();

        if now >= next_heartbeat {
            // A failure is a warning and nothing more. The server being briefly
            // unreachable is the moment an agent must keep going, not the
            // moment it should start treating its own liveness as an error.
            if let Err(error) = client.heartbeat(&config.api_key).await {
                warn!(%error, "heartbeat failed");
            }
            next_heartbeat = Instant::now() + HEARTBEAT_EVERY;
        }

        if refresh && now >= next_refresh {
            if refresh_assignment(&client, &mut config, &config_path).await {
                now = Instant::now();
                schedule = reschedule(&config, &schedule, now);
            }
            next_refresh = Instant::now() + REFRESH_EVERY;
        }

        let mut batch: Vec<QueuedPoint> = Vec::new();

        for entry in &config.probes {
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

            batch.push(QueuedPoint {
                control_key: point.control_key,
                status: point.status,
                latency_ms: point.latency_ms,
                value: point.value,
                message: point.message,
            });

            let interval = config.interval_for(entry);
            schedule.insert(
                entry.control_key.clone(),
                now + Duration::from_secs(interval) + jitter(interval),
            );
        }

        for point in batch {
            queue.push(point);
        }

        flush(&client, &config.api_key, &mut queue).await;
    }
}

/// Sends everything queued, keeping it if the server cannot be reached.
async fn flush(client: &Client, api_key: &str, queue: &mut Queue) {
    if queue.is_empty() {
        return;
    }

    // Chunked, because a long outage can leave thousands queued and a single
    // request of all of them would be refused for its size — and then never
    // shrink, which is the failure mode where an agent never recovers.
    const CHUNK: usize = 200;
    let chunk: Vec<Point> = queue.points.iter().take(CHUNK).map(Point::from).collect();

    match client.ingest(api_key, &chunk).await {
        Ok(response) => {
            queue.points.drain(..chunk.len());
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
        }
        Err(error) => {
            warn!(%error, pending = queue.len(), "could not reach the server — points kept");
            queue.persist();
        }
    }
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
            interval_s: 60,
            probes: keys.iter().map(|key| probe_entry(key)).collect(),
        }
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
}
