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
}

#[derive(Debug, Serialize)]
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
