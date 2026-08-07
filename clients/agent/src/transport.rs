//! Talking to the TERN API.
//!
//! Pairing, pushing measurements, and the small amount of state an agent keeps
//! on disk.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::probe::Status;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub agent_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub api_key: String,
    pub agent_id: String,
    pub agent_name: String,
    pub tenant_slug: String,
    /// What the server says this agent is to run.
    ///
    /// Defaulted rather than required so a newer agent still pairs with an older
    /// server: it simply receives nothing to do, which is the pre-existing
    /// behaviour, instead of failing to pair at all.
    #[serde(default)]
    pub jobs: Vec<Job>,
}

/// One probe the server has assigned.
///
/// The probe and its assertions arrive in exactly the shape `agent.toml` holds,
/// so what is written to disk is what was received — no translation layer to
/// disagree with the server about what `timeout_ms` means.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub control_key: String,
    #[serde(default)]
    pub interval_s: Option<u64>,
    pub probe: serde_json::Value,
    #[serde(default)]
    pub assertions: Vec<serde_json::Value>,
    /// `status` or `value` — what the control's widget will draw.
    #[serde(default)]
    pub payload_shape: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResponse {
    pub tenant_slug: String,
    #[serde(default)]
    pub jobs: Vec<Job>,
}

// Deserialize as well: the proxy reads points its local agents send before
// forwarding them, and must not need a second definition of the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub control_key: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResponse {
    pub accepted: usize,
    #[serde(default)]
    pub rejected: Vec<RejectedPoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedPoint {
    pub control_key: String,
    pub reason: String,
}

/// A URL-safe random token. Used for locally issued keys and PINs.
pub fn random_token(bytes: usize) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    // The agent has no RNG dependency and needs one in exactly two places. A
    // hash of the clock's nanoseconds mixed with the process id and a counter
    // is unpredictable enough for a credential that is checked against a stored
    // hash and can be revoked — and it avoids pulling `rand` in for it.
    use sha2::{Digest, Sha256};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    let mut out = String::new();
    while out.len() < bytes * 2 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(seq.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        let digest = hasher.finalize();

        for byte in digest.iter() {
            out.push(char::from_digit((byte % 36) as u32, 36).unwrap_or('x'));
        }
    }
    out.truncate(bytes * 2);
    out
}

pub struct Client {
    http: reqwest::Client,
    base_url: String,
}

impl Client {
    pub fn new(base_url: &str) -> Result<Self> {
        let base_url = base_url.trim_end_matches('/').to_string();

        // Pairing hands over a long-lived credential. Refusing plain HTTP
        // outside localhost stops that happening over the wire in clear, which
        // is exactly the mistake a quick-start guide invites.
        if !base_url.starts_with("https://")
            && !base_url.starts_with("http://localhost")
            && !base_url.starts_with("http://127.0.0.1")
        {
            bail!("Refusing to use plain HTTP for {base_url} — use https:// (localhost is exempt)");
        }

        let http = reqwest::Client::builder()
            .user_agent(concat!("tern-agent/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("failed to build HTTP client")?;

        Ok(Self { http, base_url })
    }

    /// Exchanges a PIN for an ingest-scoped API key. The key is returned once.
    pub async fn pair(&self, request: &PairRequest) -> Result<PairResponse> {
        let response = self
            .http
            .post(format!("{}/api/v1/pair", self.base_url))
            .json(request)
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // The server answers identically for wrong, expired and used-up
            // codes; repeating its message verbatim keeps it that way.
            bail!("pairing failed ({status}): {body}");
        }

        response.json().await.context("unexpected pairing response")
    }

    /// Re-reads the assignment with the ingest key.
    ///
    /// Pairing happens once; what is monitored changes. An agent that never
    /// asks again runs the probes it was given the day it was installed.
    pub async fn jobs(&self, api_key: &str) -> Result<JobsResponse> {
        let response = self
            .http
            .get(format!("{}/api/v1/agent/jobs", self.base_url))
            .bearer_auth(api_key)
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("could not read jobs ({status}): {body}");
        }

        response.json().await.context("unexpected jobs response")
    }

    /// "I am here", and nothing else.
    ///
    /// An agent that is measuring says so with every push, and one that is
    /// refreshing says so by asking. An agent whose assignment is empty does
    /// neither — it has nothing to send and, under `--no-refresh`, nothing to
    /// ask — so it went silent and the fleet drew it as dead. It was not dead;
    /// it had nothing to do, which is a different thing and worth being able to
    /// tell apart.
    ///
    /// Deliberately its own endpoint rather than a reuse of `jobs`: liveness
    /// should not cost an assignment download, and it has to keep working when
    /// the operator has asked for no refreshing at all.
    pub async fn heartbeat(&self, api_key: &str) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/heartbeat", self.base_url))
            .bearer_auth(api_key)
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            bail!("heartbeat refused ({status})");
        }

        Ok(())
    }

    pub async fn ingest(&self, api_key: &str, points: &[Point]) -> Result<IngestResponse> {
        let response = self
            .http
            .post(format!("{}/api/v1/ingest", self.base_url))
            .bearer_auth(api_key)
            .json(points)
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("ingest rejected ({status}): {body}");
        }

        response.json().await.context("unexpected ingest response")
    }
}
