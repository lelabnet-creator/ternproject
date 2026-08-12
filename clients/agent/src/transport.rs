//! Talking to the TERN API.
//!
//! Pairing, pushing measurements, and the small amount of state an agent keeps
//! on disk.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::probe::Status;

/// The protocol version this build speaks, asserted on every exchange.
///
/// Sent as `X-Tern-Protocol` and echoed by the server. No negotiation: the
/// fleet and the server ship together, and a mismatch must be a loud, named
/// refusal rather than a field-by-field guess. Mirrors `PROTOCOL_VERSION` in
/// `packages/shared/src/agent-protocol.ts`.
pub const PROTOCOL_VERSION: u32 = 1;
pub const PROTOCOL_HEADER: &str = "x-tern-protocol";

/// One agent of a proxy's zone, as the server is told about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneAgent {
    pub name: String,
    /// RFC 3339 like every protocol timestamp, or null for one that has
    /// paired and never come back. Formatted by `epoch_to_rfc3339` — the
    /// twenty-line helper that keeps a date library out of the binary.
    pub last_seen_at: Option<String>,
    /// As the proxy sees it, inside the zone.
    pub ip: Option<String>,
}

/// Unix seconds → `1970-01-01T00:00:00Z`-style RFC 3339, always UTC.
///
/// Written out rather than pulled in: `chrono` is a large dependency for one
/// direction of one format, and this binary's whole point is being small
/// enough to drop anywhere. The day arithmetic is the standard civil-from-days
/// algorithm; the tests pin it against known dates including leap years.
pub fn epoch_to_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Howard Hinnant's civil_from_days, shifted so the era starts on a
    // 400-year boundary (era day 0 = 0000-03-01).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    // All the optionals are omitted rather than sent as null: the server's
    // schema says `optional`, and in Zod an optional string refuses an
    // explicit null. It never bit because the binary always fills these —
    // the conformance round-trip is what said it would bite a minimal client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    /**
     * Instructions for the machines behind this relay.
     *
     * Only a relay ever sees these filled. Named rather than keyed by id
     * because a relay knows its zone by name: it issued those keys itself, and
     * the server never saw them.
     */
    #[serde(default)]
    pub zone_commands: Vec<ZoneCommand>,
}

/// One instruction for a machine inside a zone, as the relay receives it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneCommand {
    pub id: String,
    pub kind: String,
    /// The name the relay knows that machine by.
    pub agent: String,
}

/// One instruction, as it arrives.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub kind: CommandKind,
}

/// What the console can ask — the Rust side of `AGENT_COMMAND_KINDS`.
///
/// `Unknown` is what keeps a new kind from breaking an old agent: an
/// instruction this build does not know still parses — taking the whole poll
/// down with it would cut the agent off from its jobs too — and is answered
/// as unknown, naming what it did not understand.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "String")]
pub enum CommandKind {
    Pause,
    Resume,
    Stop,
    Restart,
    Logs,
    UiOn,
    UiOff,
    /// Replace this binary with the one the server ships, then restart.
    Upgrade,
    Unknown(String),
}

impl From<String> for CommandKind {
    fn from(kind: String) -> Self {
        match kind.as_str() {
            "pause" => Self::Pause,
            "resume" => Self::Resume,
            "stop" => Self::Stop,
            "restart" => Self::Restart,
            "logs" => Self::Logs,
            "ui-on" => Self::UiOn,
            "ui-off" => Self::UiOff,
            "upgrade" => Self::Upgrade,
            _ => Self::Unknown(kind),
        }
    }
}

impl From<&str> for CommandKind {
    fn from(kind: &str) -> Self {
        Self::from(kind.to_string())
    }
}

impl std::fmt::Display for CommandKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Logs => "logs",
            Self::UiOn => "ui-on",
            Self::UiOff => "ui-off",
            Self::Upgrade => "upgrade",
            Self::Unknown(kind) => kind,
        })
    }
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
    /// When this was measured, RFC 3339, stamped by the prober.
    ///
    /// The reason the offline queue is honest: a point replayed hours after a
    /// network cut lands at the time it was measured, not the time the link
    /// came back — which is what the queue existed to preserve and silently
    /// did not. The server clamps anything out of its window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
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

/// DEV mode: one debug line per protocol request and reply, bodies included.
///
/// The server half is the API's own `TERN_PROTOCOL_TRACE`; turned on together
/// they show both ends of the same exchange. The lines ride `tracing` under
/// the `protocol` target, so they land in the ring buffer too — the `logs`
/// instruction and the local page can read a trace from a machine nobody can
/// shell into. Same strict spelling as the HTTP opt-in, for the same reason.
fn protocol_trace() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TERN_PROTOCOL_TRACE").is_ok_and(|value| value == "1"))
}

/// A refusal the server actually sent, as opposed to a network that ate the
/// request. Parsed from the RFC 9457 problem document every error body is.
///
/// Typed so callers can branch on facts instead of grepping a message: the
/// relay turns "the server refused the code" into a 401 for its zone and "the
/// server is unreachable" into a 503, and the runner tells a dead key from a
/// bad night on the network.
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    /// The machine-readable `code` — `unauthorized`, `key-has-no-agent`,
    /// `protocol-mismatch`… Empty when the body was not a problem document.
    pub code: String,
    pub detail: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the server refused it ({}", self.status)?;
        if !self.code.is_empty() {
            write!(f, " {}", self.code)?;
        }
        write!(f, ")")?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        // The one status worth a prescription: a 401 does not heal, and the
        // log line is read on a machine where the fix is one command away.
        if self.status == 401 {
            write!(
                f,
                " — this key is no longer accepted; re-pair with `tern-agent pair`"
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for ApiError {}

/// Exponential backoff for a request that keeps failing.
///
/**
 * What a beat answers.
 *
 * Two facts, and the second exists because the first was not enough: the agent
 * has to know whether to ask again at once or to keep its minute, and it used
 * to infer that from how long the reply took. See `holding`.
 */
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    /// Something is queued for this machine — or, for a relay, for its zone.
    #[serde(default)]
    pub commands_waiting: bool,
    /**
     * Whether this server honours `waitSeconds`.
     *
     * Absent from anything older, which is exactly the `false` it defaults to.
     * Said rather than measured: a relay lets go of the beats it holds as it
     * shuts down, so a timing guess read "this one does not hold" at the very
     * moment the relay was coming back, and the zone went quiet for a minute.
     */
    #[serde(default)]
    pub holding: bool,
}

/// Without it a permanent 401 was one warn per minute, forever — noise exactly
/// where somebody would need to read. Doubles from one minute to a quarter of
/// an hour and resets on the first success.
///
/// The exception is the very first failure, which gets two seconds rather than
/// a minute. Most first failures are not outages: they are a peer restarting.
/// Since the beat became a held connection this stopped being a nicety — a
/// relay's restart hands its zone a clean answer, each machine asks again a
/// fraction of a second later, the port is not back yet, and one minute of
/// silence follows a one-second restart. Measured: 52 s for an instruction
/// posted just after a relay restart, against 0.3 s otherwise. A real outage
/// pays for this once, in one extra request.
#[derive(Debug)]
pub struct Backoff {
    failures: u32,
}

/// What a first failure costs. See `Backoff`.
const BACKOFF_FIRST_S: u64 = 2;
const BACKOFF_FLOOR_S: u64 = 60;
const BACKOFF_CEILING_S: u64 = 900;

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self { failures: 0 }
    }

    /// Records a failure and says how long to hold off.
    pub fn failed(&mut self) -> std::time::Duration {
        self.failures = self.failures.saturating_add(1);
        if self.failures == 1 {
            return std::time::Duration::from_secs(BACKOFF_FIRST_S);
        }
        let secs = BACKOFF_FLOOR_S
            .saturating_mul(2u64.saturating_pow(self.failures.saturating_sub(2)))
            .min(BACKOFF_CEILING_S);
        std::time::Duration::from_secs(secs)
    }

    pub fn succeeded(&mut self) {
        self.failures = 0;
    }

    pub fn failing(&self) -> bool {
        self.failures > 0
    }
}

/// The host of `scheme://host[:port]/...`, brackets and port stripped.
///
/// Hand-rolled because the alternative was testing by string prefix, and a
/// prefix is not a host: `http://localhost.evil.example` begins with
/// `http://localhost` and is nobody's loopback, while `http://[::1]` is
/// loopback and began with neither exemption.
fn host_of(base_url: &str) -> &str {
    let rest = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);

    if let Some(v6) = authority.strip_prefix('[') {
        // Bracketed IPv6: the port sits outside the brackets.
        return v6.split(']').next().unwrap_or(v6);
    }
    authority
        .rsplit_once(':')
        .map_or(authority, |(host, port)| {
            // Only strip something that is actually a port; a bare IPv6 with no
            // brackets has colons that are not one.
            if port.chars().all(|c| c.is_ascii_digit()) {
                host
            } else {
                authority
            }
        })
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
        //
        // Judged on the parsed host, not a string prefix: the prefix let
        // `http://localhost.evil.example` through and refused `http://[::1]`,
        // which is loopback by any other name. Same `is_loopback_host` as the
        // rest of the binary, so "loopback" means one thing here.
        let scheme_is_https = base_url
            .split_once("://")
            .map(|(scheme, _)| scheme.eq_ignore_ascii_case("https"))
            .unwrap_or(false);
        if !scheme_is_https
            && !crate::config::is_loopback_host(host_of(&base_url))
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

    /// Sends one protocol request: version header on, trace if asked, and a
    /// refusal parsed into `ApiError` so callers branch on facts.
    ///
    /// Every protocol call goes through here — it is what makes "the agent
    /// announces its version on every exchange" true by construction rather
    /// than per call site.
    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<reqwest::Response> {
        if protocol_trace() {
            tracing::debug!(
                target: "protocol",
                %method, %path,
                body = %body.map(ToString::to_string).unwrap_or_default(),
                "-> request"
            );
        }

        let mut request = request.header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request.send().await.context("could not reach the server")?;
        let status = response.status();

        // The echoed version. Absent is fine — a reply that got this far came
        // from something that accepted ours — but a *different* one present
        // means the ends disagree, and that must never pass silently.
        if let Some(theirs) = response.headers().get(PROTOCOL_HEADER) {
            let theirs = theirs.to_str().unwrap_or("?");
            if theirs != PROTOCOL_VERSION.to_string() {
                bail!(
                    "protocol mismatch: this agent speaks {PROTOCOL_VERSION}, \
                     the server answered {theirs} — upgrade the older side"
                );
            }
        }

        if status.is_success() {
            if protocol_trace() {
                tracing::debug!(target: "protocol", %method, %path, status = status.as_u16(), "<- ok");
            }
            return Ok(response);
        }

        let text = response.text().await.unwrap_or_default();
        if protocol_trace() {
            tracing::debug!(target: "protocol", %method, %path, status = status.as_u16(), body = %text, "<- refused");
        }

        // Every error body is an RFC 9457 problem document; anything else
        // (a proxy in the way, an older server) degrades to the raw text.
        #[derive(Deserialize, Default)]
        struct Problem {
            #[serde(default)]
            code: String,
            #[serde(default)]
            detail: String,
            #[serde(default)]
            title: String,
        }
        let problem: Problem = serde_json::from_str(&text).unwrap_or_default();

        Err(anyhow::Error::new(ApiError {
            status: status.as_u16(),
            code: problem.code,
            detail: if problem.detail.is_empty() {
                if problem.title.is_empty() {
                    text
                } else {
                    problem.title
                }
            } else {
                problem.detail
            },
        }))
    }

    /// Exchanges a PIN for an ingest-scoped API key. The key is returned once.
    pub async fn pair(&self, request: &PairRequest) -> Result<PairResponse> {
        let path = "/api/v1/pair";
        let body = serde_json::to_value(request).context("unencodable pairing request")?;
        let response = self
            .send(
                self.http.post(format!("{}{path}", self.base_url)),
                "POST",
                path,
                Some(&body),
            )
            .await
            .context("pairing failed")?;

        response.json().await.context("unexpected pairing response")
    }

    /// Re-reads the assignment with the ingest key.
    ///
    /// Pairing happens once; what is monitored changes. An agent that never
    /// asks again runs the probes it was given the day it was installed.
    pub async fn jobs(&self, api_key: &str) -> Result<JobsResponse> {
        let path = "/api/v1/agent/jobs";
        let response = self
            .send(
                self.http
                    .get(format!("{}{path}", self.base_url))
                    .bearer_auth(api_key),
                "GET",
                path,
                None,
            )
            .await
            .context("could not read jobs")?;

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
        let path = "/api/v1/agent/zone/redeem";
        // A refusal and an unreachable server are different facts, and the
        // caller has to be able to tell them apart — reported as one, they
        // sent somebody looking at their PIN while their instance was
        // restarting. The caller downcasts to `ApiError` for the difference.
        let response = self
            .send(
                self.http
                    .post(format!("{}{path}", self.base_url))
                    .bearer_auth(api_key),
                "POST",
                path,
                Some(&serde_json::json!({ "code": code })),
            )
            .await?;

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
    /// Returns whether the server says something is waiting to be fetched.
    /// `wait_seconds` asks the server to hold the reply until there is
    /// something to say, up to its own bound. Zero answers at once, which is
    /// what a server too old to hold it does anyway.
    pub async fn heartbeat(
        &self,
        api_key: &str,
        ui_address: Option<&str>,
        wait_seconds: u32,
    ) -> Result<Beat> {
        let path = "/api/v1/agent/heartbeat";
        let response = self
            .send(
                self.http
                    .post(format!("{}{path}", self.base_url))
                    .bearer_auth(api_key),
                "POST",
                path,
                // Always the explicit field: null clears the stored address,
                // absent would leave it alone, and the agent is the authority
                // on whether its page exists.
                Some(&serde_json::json!({
                    "uiAddress": ui_address,
                    "waitSeconds": wait_seconds,
                })),
            )
            .await
            .context("heartbeat refused")?;

        let beat: Beat = response
            .json()
            .await
            .context("unexpected heartbeat response")?;
        Ok(beat)
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
        let path = format!("/api/v1/agent/commands/{command_id}/result");
        self.send(
            self.http
                .post(format!("{}{path}", self.base_url))
                .bearer_auth(api_key),
            "POST",
            &path,
            Some(&serde_json::json!({ "result": result, "error": error })),
        )
        .await
        .context("could not report the result")?;
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
        let path = "/api/v1/agent/zone";
        // The address this relay serves its zone on, said by the only thing
        // that knows it. The server used to infer it from where the pairing
        // arrived from, which on a containerised TERN is a Docker bridge
        // gateway — an address that means nothing outside that one host, and
        // that the admin then offered as the one to reach the relay on.
        // `listen` is where it binds; `addresses` is everywhere it could be
        // dialled. Both, because a relay bound to every interface has a
        // listen line that names no address anybody can type.
        self.send(
            self.http
                .post(format!("{}{path}", self.base_url))
                .bearer_auth(api_key),
            "POST",
            path,
            Some(&serde_json::json!({
                "agents": agents,
                "listen": listen,
                "addresses": addresses,
            })),
        )
        .await
        .context("the zone declaration was refused")?;

        Ok(())
    }

    pub async fn ingest(&self, api_key: &str, points: &[Point]) -> Result<IngestResponse> {
        let path = "/api/v1/ingest";
        let body = serde_json::to_value(points).context("unencodable points")?;
        let response = self
            .send(
                self.http
                    .post(format!("{}{path}", self.base_url))
                    .bearer_auth(api_key),
                "POST",
                path,
                Some(&body),
            )
            .await
            .context("ingest rejected")?;

        response.json().await.context("unexpected ingest response")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epochs_become_rfc3339() {
        assert_eq!(epoch_to_rfc3339(0), "1970-01-01T00:00:00Z");
        // A leap day, because the day arithmetic is the part worth pinning.
        assert_eq!(epoch_to_rfc3339(1_582_934_400), "2020-02-29T00:00:00Z");
        assert_eq!(epoch_to_rfc3339(1_786_000_000), "2026-08-06T07:06:40Z");
        assert_eq!(epoch_to_rfc3339(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn hosts_are_parsed_not_prefixed() {
        assert_eq!(host_of("http://localhost:3011"), "localhost");
        assert_eq!(host_of("http://127.0.0.1"), "127.0.0.1");
        assert_eq!(host_of("http://[::1]:8080/api"), "::1");
        assert_eq!(host_of("https://api.example.com/v1"), "api.example.com");
        // The attack the prefix test let through.
        assert_eq!(
            host_of("http://localhost.evil.example/x"),
            "localhost.evil.example"
        );
    }

    /// The two mistakes the old prefix guard made, both directions.
    #[test]
    fn the_plain_http_guard_judges_the_host() {
        // Loopback by any name is exempt…
        assert!(Client::new("http://[::1]:3011").is_ok());
        assert!(Client::new("http://localhost:3011").is_ok());
        assert!(Client::new("http://127.0.0.1:3011").is_ok());
        // …and a hostname that merely *starts* like one is not.
        assert!(Client::new("http://localhost.evil.example").is_err());
        // Scheme case does not defeat it either way.
        assert!(Client::new("HTTPS://api.example.com").is_ok());
    }

    #[test]
    fn backoff_doubles_to_a_ceiling_and_resets() {
        let mut backoff = Backoff::new();
        assert!(!backoff.failing());
        // The first one is a peer restarting until proven otherwise.
        assert_eq!(backoff.failed().as_secs(), 2);
        assert_eq!(backoff.failed().as_secs(), 60);
        assert_eq!(backoff.failed().as_secs(), 120);
        assert_eq!(backoff.failed().as_secs(), 240);
        assert_eq!(backoff.failed().as_secs(), 480);
        assert_eq!(backoff.failed().as_secs(), 900);
        assert_eq!(backoff.failed().as_secs(), 900, "capped, not unbounded");
        backoff.succeeded();
        assert!(!backoff.failing());
        assert_eq!(backoff.failed().as_secs(), 2, "a success starts over");
    }

    /// The property the two-second step exists for: a restart is not an outage.
    #[test]
    fn a_peer_that_comes_straight_back_costs_two_seconds_not_a_minute() {
        let mut backoff = Backoff::new();
        let restart = backoff.failed();
        backoff.succeeded();
        assert_eq!(restart.as_secs(), 2);

        // And an outage still reaches the quiet cadence quickly.
        let mut outage = Backoff::new();
        let total: u64 = (0..6).map(|_| outage.failed().as_secs()).sum();
        assert_eq!(total, 2 + 60 + 120 + 240 + 480 + 900);
    }

    #[test]
    fn an_unknown_kind_still_parses() {
        let command: Command =
            serde_json::from_str(r#"{"id":"c1","kind":"defragment-the-hyperdrive"}"#).unwrap();
        assert_eq!(
            command.kind,
            CommandKind::Unknown("defragment-the-hyperdrive".into())
        );
        // And the known ones land where they should.
        let command: Command = serde_json::from_str(r#"{"id":"c2","kind":"ui-on"}"#).unwrap();
        assert_eq!(command.kind, CommandKind::UiOn);
    }
}
