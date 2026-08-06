//! `tern-agent doctor` — why is this agent not reporting?
//!
//! The question is nearly always answered by one of a handful of facts, and
//! each of them is awkward to check by hand on a locked-down host: is the
//! config readable, is the server reachable, does DNS work, is the clock right,
//! may this process open a raw socket, does the key still work.
//!
//! Every check reports what it found rather than a bare pass/fail, because the
//! person running this is already stuck and "DNS: FAIL" tells them nothing they
//! did not know.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::runner::Queue;
use crate::transport::Client;

pub enum Verdict {
    Ok(String),
    Warn(String),
    Fail(String),
}

impl Verdict {
    fn mark(&self) -> &'static str {
        match self {
            Verdict::Ok(_) => "ok  ",
            Verdict::Warn(_) => "warn",
            Verdict::Fail(_) => "FAIL",
        }
    }

    fn detail(&self) -> &str {
        match self {
            Verdict::Ok(d) | Verdict::Warn(d) | Verdict::Fail(d) => d,
        }
    }
}

pub struct Report {
    pub checks: Vec<(String, Verdict)>,
}

impl Report {
    pub fn print(&self) {
        for (name, verdict) in &self.checks {
            println!("[{}] {name}: {}", verdict.mark(), verdict.detail());
        }
    }

    /// True when something is actually broken, so this is usable in a script.
    pub fn has_failure(&self) -> bool {
        self.checks
            .iter()
            .any(|(_, v)| matches!(v, Verdict::Fail(_)))
    }
}

pub async fn run(config_path: &Path, queue_path: &Path) -> Report {
    let mut checks = Vec::new();

    // ── The config ──────────────────────────────────────────────────────────
    let config = match Config::load(config_path) {
        Ok(config) => {
            checks.push((
                "config".into(),
                Verdict::Ok(format!(
                    "{} — {} probe(s), interval {}s",
                    config_path.display(),
                    config.probes.len(),
                    config.interval_s
                )),
            ));
            Some(config)
        }
        Err(error) => {
            checks.push((
                "config".into(),
                Verdict::Fail(format!("{} — {error:#}", config_path.display())),
            ));
            None
        }
    };

    checks.push(("permissions".into(), config_permissions(config_path)));

    // ── The queue ───────────────────────────────────────────────────────────
    let queue = Queue::open(queue_path);
    checks.push((
        "queue".into(),
        if queue.is_empty() {
            Verdict::Ok(format!("{} — empty, nothing waiting", queue_path.display()))
        } else {
            // Not a failure: a full queue during an outage is the feature
            // working. It is worth saying out loud all the same.
            Verdict::Warn(format!(
                "{} point(s) buffered — they will be sent when the server answers",
                queue.len()
            ))
        },
    ));

    let Some(config) = config else {
        return Report { checks };
    };

    // ── Reaching the server ─────────────────────────────────────────────────
    match Client::new(&config.server) {
        Ok(client) => {
            let started = Instant::now();
            match client.jobs(&config.api_key).await {
                Ok(response) => {
                    checks.push((
                        "server".into(),
                        Verdict::Ok(format!(
                            "{} answered in {} ms",
                            config.server,
                            started.elapsed().as_millis()
                        )),
                    ));
                    checks.push((
                        "credential".into(),
                        Verdict::Ok(format!(
                            "accepted for tenant {} — {} job(s) assigned",
                            response.tenant_slug,
                            response.jobs.len()
                        )),
                    ));

                    let assigned: Vec<&str> = response
                        .jobs
                        .iter()
                        .map(|j| j.control_key.as_str())
                        .collect();
                    let local: Vec<&str> = config
                        .probes
                        .iter()
                        .map(|p| p.control_key.as_str())
                        .collect();
                    let missing: Vec<&&str> =
                        assigned.iter().filter(|k| !local.contains(k)).collect();

                    checks.push((
                        "assignment".into(),
                        if missing.is_empty() {
                            Verdict::Ok("the config matches what the server assigns".into())
                        } else {
                            Verdict::Warn(format!(
                                "the server assigns {} not in this config — restart to pick them up",
                                missing
                                    .iter()
                                    .map(|k| k.to_string())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ))
                        },
                    ));
                }
                Err(error) => {
                    // The two causes look identical from here — an unreachable
                    // host and a revoked key both mean "no jobs" — so the
                    // message must not guess.
                    checks.push((
                        "server".into(),
                        Verdict::Fail(format!(
                            "{} — {error:#} (unreachable, or the key was revoked)",
                            config.server
                        )),
                    ));
                }
            }
        }
        Err(error) => {
            checks.push(("server".into(), Verdict::Fail(format!("{error:#}"))));
        }
    }

    // ── The host ────────────────────────────────────────────────────────────
    checks.push(("dns".into(), dns_check(&config.server).await));
    checks.push(("clock".into(), clock_check()));
    checks.push(("icmp".into(), icmp_check()));

    Report { checks }
}

#[cfg(unix)]
fn config_permissions(path: &Path) -> Verdict {
    use std::os::unix::fs::PermissionsExt;

    match std::fs::metadata(path) {
        Ok(meta) => {
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 == 0 {
                Verdict::Ok(format!("{mode:o} — the key is readable only by its owner"))
            } else {
                // Worth flagging loudly: the file holds a live ingest key, and
                // this is how it ends up in a backup somebody else can read.
                Verdict::Warn(format!(
                    "{mode:o} — others can read this file, and it holds the key"
                ))
            }
        }
        Err(error) => Verdict::Fail(format!("{error}")),
    }
}

#[cfg(not(unix))]
fn config_permissions(_path: &Path) -> Verdict {
    Verdict::Ok("not checked on this platform — the directory ACL applies".into())
}

async fn dns_check(server: &str) -> Verdict {
    let host = server
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");

    if host.is_empty() {
        return Verdict::Fail(format!("could not read a hostname out of {server}"));
    }

    let started = Instant::now();
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 0))).await {
        Ok(Ok(mut addresses)) => match addresses.next() {
            Some(address) => Verdict::Ok(format!(
                "{host} → {} in {} ms",
                address.ip(),
                started.elapsed().as_millis()
            )),
            None => Verdict::Fail(format!("{host} resolved to nothing")),
        },
        Ok(Err(error)) => Verdict::Fail(format!("{host} — {error}")),
        Err(_) => Verdict::Fail(format!("{host} — no answer within 5 s")),
    }
}

/// A clock far enough out that points land in a chunk nobody queries.
///
/// The server clamps what it receives, so the symptom is not an error but a
/// measurement that silently never appears on the page.
fn clock_check() -> Verdict {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(since) => {
            let year = 1970 + since.as_secs() / 31_557_600;
            if year < 2024 {
                Verdict::Fail(format!(
                    "the system clock says {year} — measurements will be clamped and may never appear"
                ))
            } else {
                Verdict::Ok(format!("system clock reads {year}, plausible"))
            }
        }
        Err(_) => Verdict::Fail("the system clock is before 1970".into()),
    }
}

/// Whether a ping probe will be a real ping.
fn icmp_check() -> Verdict {
    use socket2::{Domain, Protocol, Socket, Type};

    match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))
        .or_else(|_| Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4)))
    {
        Ok(_) => Verdict::Ok("real ICMP is available".into()),
        Err(_) => Verdict::Warn(
            "no permission for ICMP — ping probes fall back to a TCP connect. Grant CAP_NET_RAW, or widen net.ipv4.ping_group_range"
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_check_accepts_a_plausible_year() {
        assert!(matches!(clock_check(), Verdict::Ok(_)));
    }

    #[tokio::test]
    async fn dns_reads_the_host_out_of_a_url_with_a_port_and_a_path() {
        // The parsing is the part that breaks: a check that reports FAIL because
        // it tried to resolve "localhost:3011/api" would send someone hunting a
        // DNS problem that does not exist.
        let verdict = dns_check("http://localhost:3011/api/v1").await;
        assert!(matches!(verdict, Verdict::Ok(_)), "{}", verdict.detail());
    }

    #[tokio::test]
    async fn a_missing_config_is_a_failure_that_names_the_path() {
        let report = run(
            Path::new("/nonexistent/agent.toml"),
            Path::new("/nonexistent/q.json"),
        )
        .await;
        assert!(report.has_failure());
        let (_, verdict) = &report.checks[0];
        assert!(verdict.detail().contains("/nonexistent/agent.toml"));
    }
}
