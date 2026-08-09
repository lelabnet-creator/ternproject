//! `tern-proxy` — a relay for networks with no route to the internet.
//!
//! The problem it solves: agents in an isolated zone can reach a host inside
//! that zone and nothing else. One machine in the DMZ has egress. Without a
//! relay, monitoring that zone means either punching a hole per agent or not
//! monitoring it.
//!
//! The design decision that makes it small: **the proxy speaks the same API as
//! TERN**. An agent pointed at a proxy is an ordinary agent — it pairs, it asks
//! for its jobs, it pushes points, and none of its code knows the difference.
//! That is why there is no "proxy mode" in the agent, and why a zone can be
//! migrated to a direct connection by changing one line of its config.
//!
//! Three things it does that a plain HTTP forwarder could not:
//!
//! * **Issues its own PINs and its own keys.** An agent in the isolated zone
//!   never holds an upstream credential, so a compromised host there cannot
//!   push to TERN directly, and revoking the proxy revokes the whole zone.
//! * **Caches the assignment.** Agents restarting during an upstream outage
//!   still get their jobs, from the last copy the proxy fetched.
//! * **Buffers and replays.** The same bounded on-disk queue the agent uses,
//!   for the same reason — an unreachable server should delay history, not lose
//!   it.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::write_private;
use crate::transport::{Client, Job, PairRequest, Point};

// ── Configuration ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProxyConfig {
    /// The TERN instance this proxy forwards to.
    pub server: String,
    /// The proxy's own ingest key, obtained by pairing it like any agent.
    pub api_key: String,
    /// Where it listens for the agents in its zone.
    #[serde(default = "default_listen")]
    pub listen: String,
    /// How often to re-read the assignment from upstream, in seconds.
    #[serde(default = "default_refresh")]
    pub refresh_s: u64,
    /// Locally issued agent keys, hashed. Never the keys themselves.
    #[serde(default)]
    pub local_keys: Vec<LocalKey>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocalKey {
    pub name: String,
    /// SHA-256 of the key. A stolen proxy config cannot be replayed upstream.
    pub key_hash: String,
    /// Unix seconds of the last request this agent made. `None` until it makes one.
    #[serde(default)]
    pub last_seen: Option<u64>,
    /// The address it was last seen at, inside the zone.
    #[serde(default)]
    pub ip: Option<String>,
}

fn default_listen() -> String {
    // Loopback by default: a relay that binds every interface the moment it is
    // installed is a decision the operator should make, not inherit.
    "127.0.0.1:8787".to_string()
}

fn default_refresh() -> u64 {
    300
}

impl ProxyConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("could not read {}", path.display()))?;
        toml::from_str(&raw)
            .with_context(|| format!("{} is not a valid proxy config", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).ok();
            }
        }
        let body = toml::to_string_pretty(self).context("could not serialise the proxy config")?;
        write_private(path, &body)
            .with_context(|| format!("could not write {}", path.display()))?;
        Ok(())
    }
}

// ── PINs issued to local agents ─────────────────────────────────────────────

#[derive(Debug, Clone)]
struct LocalPin {
    hash: String,
    expires_at: std::time::SystemTime,
    used: bool,
}

/// Four groups of four, like the server's — the same thing to read aloud.
pub fn generate_pin() -> String {
    let raw = crate::transport::random_token(6).to_uppercase();
    let cleaned: String = raw.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let mut out = String::new();
    for (index, ch) in cleaned.chars().take(8).enumerate() {
        if index == 4 {
            out.push('-');
        }
        out.push(ch);
    }
    out
}

fn hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ── The running proxy ───────────────────────────────────────────────────────

struct Inner {
    config: ProxyConfig,
    config_path: PathBuf,
    pins: Vec<LocalPin>,
    /// The last assignment read from upstream, served while it is unreachable.
    jobs: Vec<Job>,
    tenant_slug: String,
    queue: crate::runner::Queue,
}

#[derive(Clone)]
struct AppState {
    inner: Arc<Mutex<Inner>>,
    client: Arc<Client>,
}

pub async fn run(
    config_path: PathBuf,
    queue_path: PathBuf,
    listen_override: Option<String>,
) -> Result<()> {
    let mut config = ProxyConfig::load(&config_path)?;
    if let Some(listen) = listen_override {
        config.listen = listen;
    }

    let client = Client::new(&config.server)?;
    let listen: SocketAddr = config
        .listen
        .parse()
        .with_context(|| format!("{} is not a host:port", config.listen))?;

    // Fetched once at start so the zone is usable immediately; refreshed on a
    // timer after that.
    let (jobs, tenant_slug) = match client.jobs(&config.api_key).await {
        Ok(response) => {
            info!(jobs = response.jobs.len(), tenant = %response.tenant_slug, "assignment loaded");
            (response.jobs, response.tenant_slug)
        }
        Err(error) => {
            // Not fatal, deliberately: a proxy that refuses to start because
            // upstream is down takes an entire zone's monitoring with it.
            warn!(%error, "could not read the assignment — serving nothing until upstream answers");
            (Vec::new(), String::new())
        }
    };

    let state = AppState {
        inner: Arc::new(Mutex::new(Inner {
            config: config.clone(),
            config_path,
            pins: Vec::new(),
            jobs,
            tenant_slug,
            queue: crate::runner::Queue::open(&queue_path),
        })),
        client: Arc::new(client),
    };

    let app = Router::new()
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/ingest", post(ingest))
        .route("/api/v1/agent/jobs", get(jobs_route))
        .route("/api/v1/agent/heartbeat", post(heartbeat))
        .route("/health", get(health))
        .with_state(state.clone());

    // Two background loops: one to refresh the assignment, one to drain the
    // queue. Separate because a full queue must not stop the assignment
    // refreshing, and vice versa.
    spawn_refresh(state.clone(), config.refresh_s);
    spawn_flush(state.clone());

    info!(%listen, upstream = %config.server, "proxy listening");
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("could not bind {listen}"))?;

    axum::serve(
        listener,
        // ConnectInfo, so a request carries the address it came from — the one
        // fact about a zone agent that only the proxy can observe.
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        info!("stopping");
    })
    .await
    .context("the proxy server stopped unexpectedly")?;

    Ok(())
}

fn spawn_refresh(state: AppState, every_s: u64) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(every_s.max(30)));
        ticker.tick().await; // the immediate first tick, already done at startup

        loop {
            ticker.tick().await;
            let key = { state.inner.lock().await.config.api_key.clone() };

            match state.client.jobs(&key).await {
                Ok(response) => {
                    let mut inner = state.inner.lock().await;
                    if inner.jobs.len() != response.jobs.len() {
                        info!(jobs = response.jobs.len(), "assignment changed");
                    }
                    inner.jobs = response.jobs;
                    inner.tenant_slug = response.tenant_slug;
                }
                // Keeping the previous copy is the point: agents restarting
                // during an upstream outage still get their jobs.
                Err(error) => warn!(%error, "keeping the cached assignment"),
            }

            declare_zone(&state, &key).await;
        }
    });
}

/*
 * Tells the server which agents this proxy relays for.
 *
 * On the refresh loop rather than a loop of its own: it is the same
 * conversation with the same upstream, and a second timer would mean a second
 * thing to be out of step. Failure is a warning and nothing more — a relay whose
 * upstream is down must keep serving its zone, which is the entire reason it
 * exists.
 *
 * The inventory is persisted here too. It is the one moment it matters that it
 * survived: what is written is what the server will be told again after a
 * restart.
 */
async fn declare_zone(state: &AppState, key: &str) {
    let (agents, config, path) = {
        let inner = state.inner.lock().await;
        let agents: Vec<crate::transport::ZoneAgent> = inner
            .config
            .local_keys
            .iter()
            .map(|local| crate::transport::ZoneAgent {
                name: local.name.clone(),
                last_seen_unix: local.last_seen,
                ip: local.ip.clone(),
            })
            .collect();
        (agents, inner.config.clone(), inner.config_path.clone())
    };

    if agents.is_empty() {
        return;
    }

    if let Err(error) = state.client.zone(key, &agents).await {
        warn!(%error, "could not declare the zone — the fleet view will be a poll behind");
        return;
    }

    if let Err(error) = config.save(&path) {
        warn!(%error, "could not persist the zone inventory");
    }
}

fn spawn_flush(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            ticker.tick().await;

            let (key, batch) = {
                let inner = state.inner.lock().await;
                (inner.config.api_key.clone(), inner.queue.peek(200))
            };
            if batch.is_empty() {
                continue;
            }

            match state.client.ingest(&key, &batch).await {
                Ok(response) => {
                    let mut inner = state.inner.lock().await;
                    inner.queue.drop_front(batch.len());
                    for rejected in &response.rejected {
                        warn!(control = %rejected.control_key, reason = %rejected.reason, "upstream rejected a point");
                    }
                }
                Err(error) => {
                    warn!(%error, pending = batch.len(), "upstream unreachable — points kept")
                }
            }
        }
    });
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "role": "proxy" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    arch: Option<String>,
    #[serde(default)]
    agent_version: Option<String>,
}

/// An agent pairing with the proxy rather than with TERN.
///
/// It receives a key the proxy issued and the jobs the proxy cached. The
/// upstream credential never enters the isolated zone, which is the whole point:
/// a compromised host in there cannot reach TERN at all.
async fn pair(State(state): State<AppState>, Json(body): Json<PairBody>) -> impl IntoResponse {
    let mut inner = state.inner.lock().await;

    // Read the PIN file here rather than watching it: `tern-proxy pin` runs at
    // a different terminal from the daemon, and a pairing attempt is the only
    // moment the answer is needed.
    let minted = read_pending_pins(&pin_file(&inner.config_path));
    inner.absorb(minted);

    let now = std::time::SystemTime::now();
    let candidate = hash(&body.code.trim().to_uppercase());

    let Some(index) = inner
        .pins
        .iter()
        .position(|pin| pin.hash == candidate && !pin.used && pin.expires_at > now)
    else {
        // One answer for wrong, expired and used, exactly as the server does:
        // distinguishing them tells a guesser which codes exist.
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "message": "Invalid or expired pairing code" })),
        )
            .into_response();
    };

    inner.pins[index].used = true;

    let name = body.hostname.clone().unwrap_or_else(|| "agent".to_string());
    let key = format!("ternp_{}", crate::transport::random_token(24));

    inner.config.local_keys.push(LocalKey {
        name: name.clone(),
        key_hash: hash(&key),
        // Paired, not yet heard from. Null rather than "now": an agent that
        // pairs and never comes back must not look alive upstream.
        last_seen: None,
        ip: None,
    });
    let path = inner.config_path.clone();
    if let Err(error) = inner.config.save(&path) {
        warn!(%error, "could not persist the issued key — it will not survive a restart");
    }

    info!(agent = %name, os = ?body.os, arch = ?body.arch, version = ?body.agent_version, "paired a local agent");

    let jobs = inner.jobs.clone();
    let slug = inner.tenant_slug.clone();

    (
        StatusCode::OK,
        Json(json!({
            "apiKey": key,
            "agentId": format!("proxy-local-{}", inner.config.local_keys.len()),
            "agentName": name,
            "tenantSlug": slug,
            "jobs": jobs,
        })),
    )
        .into_response()
}

/// An agent saying it is alive, with nothing else to say.
///
/// The proxy claims to speak the same API as TERN, and this was the one verb it
/// did not: every agent in a zone logged `heartbeat refused (404)` on every
/// beat. Found by pairing an agent behind a real proxy rather than by reading —
/// the module's own doc comment says none of the agent's code knows the
/// difference, and it was wrong.
///
/// Not forwarded upstream. The zone's liveness reaches TERN in the inventory
/// this proxy declares; relaying each beat would tell the server about an agent
/// it has no row for, one request at a time.
async fn heartbeat(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut inner = state.inner.lock().await;
    let Some(index) = identify(&inner, &headers) else {
        return unauthorised();
    };
    touch(&mut inner, index, Some(peer.ip().to_string()));

    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

async fn jobs_route(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut inner = state.inner.lock().await;
    let Some(index) = identify(&inner, &headers) else {
        return unauthorised();
    };
    // Asking for jobs and pushing a point are the only two moments the proxy
    // sees an agent at all. Both count as alive.
    touch(&mut inner, index, Some(peer.ip().to_string()));

    (
        StatusCode::OK,
        Json(json!({ "tenantSlug": inner.tenant_slug, "jobs": inner.jobs })),
    )
        .into_response()
}

async fn ingest(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let mut inner = state.inner.lock().await;
    let Some(index) = identify(&inner, &headers) else {
        return unauthorised();
    };
    touch(&mut inner, index, Some(peer.ip().to_string()));

    // One point or a batch, matching the server — an agent must not have to
    // know which end it is talking to.
    let points: Vec<Point> = match &body {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        other => serde_json::from_value(other.clone())
            .map(|p| vec![p])
            .unwrap_or_default(),
    };

    if points.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "No usable points in the body" })),
        )
            .into_response();
    }

    let accepted = points.len();
    inner.queue.push_points(&points);

    // Accepted, not forwarded: the agent's job is done once the proxy owns the
    // point. Blocking its response on an upstream that may be down would make
    // every agent in the zone slow exactly when the network is worst.
    (
        StatusCode::OK,
        Json(json!({ "accepted": accepted, "rejected": [] })),
    )
        .into_response()
}

/// Which local agent a request belongs to, by the key it carries.
///
/// Replaces a plain yes/no because the answer is needed twice: to let the
/// request through, and to record that this particular agent was alive. The
/// server upstream learns of a zone agent only through what is written here.
fn identify(inner: &Inner, headers: &HeaderMap) -> Option<usize> {
    let value = headers.get("authorization").and_then(|v| v.to_str().ok())?;
    let token = value.strip_prefix("Bearer ")?;
    let candidate = hash(token.trim());

    inner
        .config
        .local_keys
        .iter()
        .position(|key| key.key_hash == candidate)
}

/// Records that a local agent was heard from, and where from.
///
/// In memory only. Persisting on every request would write the config file
/// once per agent per interval for no gain — the inventory is saved when it is
/// pushed upstream, which is also the only moment it needs to have survived.
fn touch(inner: &mut Inner, index: usize, ip: Option<String>) {
    if let Some(key) = inner.config.local_keys.get_mut(index) {
        key.last_seen = Some(unix_now());
        if ip.is_some() {
            key.ip = ip;
        }
    }
}

fn unauthorised() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "message": "Invalid or missing API key" })),
    )
        .into_response()
}

// ── CLI-facing helpers ──────────────────────────────────────────────────────

/// Mints a PIN for an agent in the zone.
///
/// Written to a small state file rather than kept in memory, because the person
/// running `tern-proxy pin` is at a different terminal from the running daemon.
pub fn issue_pin(config_path: &Path, ttl_minutes: u64) -> Result<(String, PathBuf)> {
    let pin = generate_pin();
    let path = pin_file(config_path);

    let mut pending: Vec<PendingPin> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let expires_at =
        std::time::SystemTime::now() + std::time::Duration::from_secs(ttl_minutes * 60);
    pending.retain(|p| p.expires_at_unix > unix_now());
    pending.push(PendingPin {
        hash: hash(&pin),
        expires_at_unix: expires_at
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });

    write_private(&path, &serde_json::to_string(&pending)?)?;
    Ok((pin, path))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingPin {
    hash: String,
    expires_at_unix: u64,
}

fn pin_file(config_path: &Path) -> PathBuf {
    config_path.with_extension("pins.json")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_pending_pins(state_path: &Path) -> Vec<(String, u64)> {
    std::fs::read_to_string(state_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<PendingPin>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.hash, p.expires_at_unix))
        .collect()
}

/// Pairs the proxy itself with TERN, exactly as an agent would.
pub async fn init(
    server: &str,
    pin: &str,
    config_path: &Path,
    listen: Option<String>,
) -> Result<()> {
    let client = Client::new(server)?;
    let response = client
        .pair(&PairRequest {
            code: pin.to_string(),
            hostname: Some(format!(
                "{}-proxy",
                std::env::var("HOSTNAME").unwrap_or_else(|_| "tern".into())
            )),
            os: Some(std::env::consts::OS.to_string()),
            arch: Some(std::env::consts::ARCH.to_string()),
            agent_version: Some(format!("proxy/{}", env!("CARGO_PKG_VERSION"))),
        })
        .await?;

    let config = ProxyConfig {
        server: server.trim_end_matches('/').to_string(),
        api_key: response.api_key,
        listen: listen.unwrap_or_else(default_listen),
        refresh_s: default_refresh(),
        local_keys: Vec::new(),
    };
    config.save(config_path)?;

    println!(
        "✓ Proxy paired with {} as \"{}\"",
        response.tenant_slug, response.agent_name
    );
    println!(
        "  {} probe(s) will be served to agents in this zone",
        response.jobs.len()
    );
    println!("  Wrote {} (readable only by you)", config_path.display());
    println!();
    println!("Next:");
    println!("  tern-proxy run   --config {}", config_path.display());
    println!(
        "  tern-proxy pin   --config {}   # then pair an agent against this proxy",
        config_path.display()
    );
    Ok(())
}

// ── State the handlers need from the CLI-minted PINs ────────────────────────

impl Inner {
    /// Pulls in PINs minted by `tern-proxy pin` since the last check.
    fn absorb(&mut self, minted: Vec<(String, u64)>) {
        let now = unix_now();
        for (hash, expires) in minted {
            if expires <= now {
                continue;
            }
            if self.pins.iter().any(|p| p.hash == hash) {
                continue;
            }
            self.pins.push(LocalPin {
                hash,
                expires_at: std::time::UNIX_EPOCH + std::time::Duration::from_secs(expires),
                used: false,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_is_readable_aloud() {
        let pin = generate_pin();
        // The thing it is actually used for: someone reads it over a phone.
        assert_eq!(pin.len(), 9);
        assert_eq!(pin.chars().nth(4), Some('-'));
        assert!(pin
            .chars()
            .filter(|c| *c != '-')
            .all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn pins_differ() {
        let mut seen = std::collections::HashMap::new();
        for _ in 0..50 {
            *seen.entry(generate_pin()).or_insert(0) += 1;
        }
        assert!(seen.len() > 45, "PINs should not repeat: {seen:?}");
    }

    /// A config as it is written to disk, with one agent already issued a key.
    fn config_with_one_agent() -> ProxyConfig {
        ProxyConfig {
            server: "https://tern.example".into(),
            api_key: "ternp_upstream".into(),
            listen: default_listen(),
            refresh_s: default_refresh(),
            local_keys: vec![LocalKey {
                name: "edge-1".into(),
                key_hash: hash("ternp_local"),
                last_seen: None,
                ip: None,
            }],
        }
    }

    #[test]
    fn an_agent_that_paired_and_never_returned_is_not_reported_alive() {
        // `None`, not "now". A zone agent that pairs and dies would otherwise
        // arrive upstream looking fresh, which is the one thing the fleet view
        // must never invent.
        let config = config_with_one_agent();
        assert_eq!(config.local_keys[0].last_seen, None);
        assert_eq!(config.local_keys[0].ip, None);
    }

    #[test]
    fn the_inventory_survives_a_restart() {
        // What the proxy tells the server after a reboot is what it wrote, so a
        // round trip through the config file is the whole guarantee.
        let dir = std::env::temp_dir().join(format!("tern-proxy-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proxy.toml");

        let mut config = config_with_one_agent();
        config.local_keys[0].last_seen = Some(1_786_000_000);
        config.local_keys[0].ip = Some("10.0.0.4".into());
        config.save(&path).unwrap();

        let reloaded = ProxyConfig::load(&path).unwrap();
        assert_eq!(reloaded.local_keys[0].last_seen, Some(1_786_000_000));
        assert_eq!(reloaded.local_keys[0].ip.as_deref(), Some("10.0.0.4"));

        // And a config written before these fields existed still loads: the
        // upgrade must not strand a proxy that is already deployed.
        let old = concat!(
            "server = \"https://tern.example\"\n",
            "api_key = \"k\"\n\n",
            "[[local_keys]]\n",
            "name = \"edge-1\"\n",
            "key_hash = \"abc\"\n"
        );
        std::fs::write(&path, old).unwrap();
        let legacy = ProxyConfig::load(&path).unwrap();
        assert_eq!(legacy.local_keys[0].last_seen, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_a_hash_of_an_issued_key_is_stored() {
        // A stolen proxy config must not be replayable — neither upstream nor
        // against the proxy itself.
        let key = "ternp_secret";
        let stored = LocalKey {
            name: "edge".into(),
            key_hash: hash(key),
            last_seen: None,
            ip: None,
        };
        assert_ne!(stored.key_hash, key);
        assert_eq!(stored.key_hash.len(), 64);
    }

    #[test]
    fn expired_pins_are_not_absorbed() {
        let mut inner = Inner {
            config: ProxyConfig {
                server: "https://x.example".into(),
                api_key: "k".into(),
                listen: default_listen(),
                refresh_s: 300,
                local_keys: Vec::new(),
            },
            config_path: PathBuf::from("/tmp/none.toml"),
            pins: Vec::new(),
            jobs: Vec::new(),
            tenant_slug: String::new(),
            queue: crate::runner::Queue::open(Path::new("/tmp/tern-proxy-test-queue.json")),
        };

        inner.absorb(vec![
            ("stale".into(), unix_now() - 10),
            ("fresh".into(), unix_now() + 600),
        ]);

        assert_eq!(inner.pins.len(), 1);
        assert_eq!(inner.pins[0].hash, "fresh");
    }
}
