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

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
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

/// Runs until the process is asked to stop.
pub async fn run(config: Config, queue_path: PathBuf) -> Result<()> {
    if config.probes.is_empty() {
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

    let mut schedule: Vec<(usize, tokio::time::Instant)> = config
        .probes
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            // Spread the first run across the interval. Without this every probe
            // in the file fires at second zero, which is the same spike inside
            // one agent that a fleet produces across many.
            let interval = config.interval_for(entry);
            let offset = stagger(index, config.probes.len(), interval);
            (index, tokio::time::Instant::now() + offset)
        })
        .collect();

    loop {
        let next_at = schedule.iter().map(|(_, at)| *at).min().unwrap();

        tokio::select! {
            _ = tokio::time::sleep_until(next_at) => {}
            _ = tokio::signal::ctrl_c() => {
                info!(pending = queue.len(), "stopping — the queue is on disk");
                queue.persist();
                return Ok(());
            }
        }

        let now = tokio::time::Instant::now();
        let mut batch: Vec<QueuedPoint> = Vec::new();

        for (index, at) in schedule.iter_mut() {
            if *at > now {
                continue;
            }
            let entry = &config.probes[*index];
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
            *at = now + Duration::from_secs(interval) + jitter(interval);
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
        };

        let point = run_once(&entry).await;
        assert_eq!(point.status, Status::Operational);
        assert!(point.latency_ms.is_some());
    }
}
