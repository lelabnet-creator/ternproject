//! Talking to the TERN API.
//!
//! Pairing, pushing measurements, and the small amount of state an agent keeps
//! on disk.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::probe::Status;

/// One agent of a proxy's zone, as the server is told about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneAgent {
    pub name: String,
    /// Unix seconds, or null for one that has paired and never come back.
    pub last_seen_unix: Option<u64>,
    /// As the proxy sees it, inside the zone.
    pub ip: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub agent_version: Option<String>,
    /// What this install is, so re-pairing replaces a row instead of adding
    /// one. See `config::Config::install_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
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
    /**
     * What the console has asked this agent to do.
     *
     * Carried on the poll rather than on a channel of its own, because there is
     * no other channel: nothing reaches an agent, and one behind a relay has no
     * route back at all. `default` so a server too old to send the field is
     * read as "nothing asked", which is what it means.
     */
    #[serde(default)]
    pub commands: Vec<Command>,
}

/// One instruction, as it arrives.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    /// Left as a string on purpose: an instruction this build does not know is
    /// reported back as unknown rather than failing to parse the whole poll,
    /// which would take the jobs down with it.
    pub kind: String,
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

/// Has somebody said, in so many words, that plain HTTP is acceptable here?
///
/// One spelling and nothing clever: `1` and nothing else. `true`, `yes`, `on`
/// and the rest would each have to be right in the installer, in the service
/// unit and in whatever anyone types by hand, and a security control that turns
/// itself off on a misspelling is worse than one that never existed — it reads
/// as enabled.
fn plain_http_allowed() -> bool {
    std::env::var("TERN_ALLOW_PLAIN_HTTP").is_ok_and(|value| value == "1")
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
        //
        // The refusal stands, and it stays the default. What it lacked was a way
        // out, and the product contradicted itself for want of one: `tern-setup`
        // asks for a public URL and accepts `http://192.168.1.30:8080` — it even
        // suggests the machine's own address — the admin then hands you a pair
        // command built from it, and this line refused the command the product
        // had just written for you. Found on a LAN install with no TLS
        // anywhere, which is the ordinary shape of a first deployment.
        //
        // So there is an opt-in, and it is an environment variable rather than a
        // flag on `pair`: the credential crosses the wire once at pairing and
        // then on every report for the life of the agent, so an allowance that
        // covered only the first would be a false one. The generated installer
        // sets it in the service unit for exactly that reason.
        if !base_url.starts_with("https://")
            && !base_url.starts_with("http://localhost")
            && !base_url.starts_with("http://127.0.0.1")
            && !plain_http_allowed()
        {
            bail!(
                "Refusing to use plain HTTP for {base_url} — the API key would cross \
                 the network in clear. Use https://, or set TERN_ALLOW_PLAIN_HTTP=1 \
                 to accept that on a network you trust (localhost is exempt)."
            );
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

    /// Asks the server whether a code it issued is good for this zone.
    ///
    /// For the relay alone, over the relay's own key. What comes back is a
    /// yes and a tenant name — never a key: the agent that presented the code
    /// receives one minted here, valid here, worth nothing upstream. That is
    /// the property that makes a zone safe, and it is why redeeming a code
    /// this way changes nothing about it.
    ///
    /// The alternative was what the product shipped: a code that could only be
    /// minted on the relay itself, which meant the admin could never print a
    /// command that worked as pasted — the one value it needed was the one
    /// value it could not know.
    pub async fn redeem_zone_code(&self, api_key: &str, code: &str) -> Result<String> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/zone/redeem", self.base_url))
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "code": code }))
            .send()
            .await
            .context("could not reach the server")?;

        // A refusal and an unreachable server are different facts, and the
        // caller has to be able to tell them apart. Reported as one, they sent
        // somebody looking at their PIN while their instance was restarting.
        if !response.status().is_success() {
            bail!("refused:{}", response.status().as_u16());
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Redeemed {
            tenant_slug: String,
        }

        let body: Redeemed = response
            .json()
            .await
            .context("unexpected response to a zone redemption")?;
        Ok(body.tenant_slug)
    }

    /// Fetches one of the server's public files, verbatim.
    ///
    /// For the relay, and for one purpose: a machine inside a zone has no route
    /// to TERN, so the installer script and the prebuilt binaries can only
    /// reach it through the relay — which does have one. Without this, an
    /// isolated host cannot be installed at all without somebody copying a
    /// binary onto it by hand.
    ///
    /// `path` is chosen by the caller from a fixed set and never taken from a
    /// request. A relay that forwards whatever path it is handed is an open
    /// proxy into whatever the relay itself can reach, which on a machine
    /// chosen for having a route out is the worst place to put one.
    ///
    /// No credentials: these routes are public on the server, and sending the
    /// relay's key would let a zone agent borrow it by asking for a file.
    pub async fn fetch_public(&self, path: &str) -> Result<(String, Vec<u8>)> {
        let response = self
            .http
            .get(format!("{}{path}", self.base_url))
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            bail!("the server refused {path} ({})", response.status());
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();

        let body = response
            .bytes()
            .await
            .with_context(|| format!("could not read {path} from the server"))?;

        Ok((content_type, body.to_vec()))
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
    ///
    /// It carries one optional thing: where this agent's own page can be
    /// reached, when it has one and it is reachable. The server cannot work
    /// that out — the address it sees a connection arrive from is a source
    /// address, and with TERN in a container that is a bridge gateway on the
    /// host, meaningless anywhere else. The machine is the only thing that
    /// knows which of its interfaces faces the server, so the machine is what
    /// says it.
    pub async fn heartbeat(&self, api_key: &str, ui_address: Option<&str>) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/heartbeat", self.base_url))
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "uiAddress": ui_address }))
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            bail!("heartbeat refused ({status})");
        }

        Ok(())
    }

    /// Says what became of an instruction.
    ///
    /// Best effort, and deliberately: an agent that has just been told to
    /// restart will report on its way out and may not get the chance. A missing
    /// answer is a different thing from a refusal, and the console shows the
    /// difference rather than inventing one.
    pub async fn command_result(
        &self,
        api_key: &str,
        command_id: &str,
        result: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let response = self
            .http
            .post(format!(
                "{}/api/v1/agent/commands/{command_id}/result",
                self.base_url
            ))
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "result": result, "error": error }))
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            bail!("the server refused the result ({status})");
        }
        Ok(())
    }

    /// Declares the agents a proxy relays for.
    ///
    /// Only `tern-proxy` calls this, and the server refuses it from anything
    /// that did not pair as one. It carries a name, a last contact and the
    /// address seen inside the zone — not an OS or a version, which the proxy
    /// has no way to know and would have to invent.
    pub async fn zone(
        &self,
        api_key: &str,
        agents: &[ZoneAgent],
        listen: &str,
        addresses: &[String],
    ) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/zone", self.base_url))
            .bearer_auth(api_key)
            // The address this relay serves its zone on, said by the only thing
            // that knows it. The server used to infer it from where the pairing
            // arrived from, which on a containerised TERN is a Docker bridge
            // gateway — an address that means nothing outside that one host, and
            // that the admin then offered as the one to reach the relay on.
            // `listen` is where it binds; `addresses` is everywhere it could be
            // dialled. Both, because a relay bound to every interface has a
            // listen line that names no address anybody can type.
            .json(&serde_json::json!({
                "agents": agents,
                "listen": listen,
                "addresses": addresses,
            }))
            .send()
            .await
            .context("could not reach the server")?;

        if !response.status().is_success() {
            let status = response.status();
            bail!("the zone declaration was refused ({status})");
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
