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

use anyhow::{bail, Context, Result};
use axum::extract::{ConnectInfo, Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
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
    /**
     * How long points wait before being carried upstream, in seconds.
     *
     * Ten by default, which is what it always was in hard-coded form. A zone on
     * a metered or intermittent link wants minutes; the queue is what makes that
     * safe, since an unreachable server delays history rather than losing it.
     */
    #[serde(default = "default_forward_interval")]
    pub forward_interval_s: u64,
    /// Whether to wait for that interval at all. See `Forward`.
    #[serde(default)]
    pub forward: Forward,

    /// The local page, when one is wanted. Absent means no page is served.
    ///
    /// Same shape and same default as an agent's, deliberately: a relay is a
    /// machine somebody checks on for the same reasons, and giving it a second
    /// vocabulary for the same idea would be one more thing to learn for
    /// nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<crate::config::UiSettings>,
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

/**
 * When a point leaves for upstream.
 *
 * `Batch` is the original behaviour and the default: points accumulate and go
 * out together on the interval. `Stream` sends as soon as one arrives.
 *
 * `Stream` is not a second path to the server — it wakes the same loop early.
 * Two ways out would be two behaviours to hold in mind the day the upstream is
 * down, and the queue is precisely what must not be bypassed then.
 */
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Forward {
    #[default]
    Batch,
    Stream,
}

fn default_forward_interval() -> u64 {
    10
}

/// The port a relay serves its zone on, unless told otherwise.
///
/// High and unusual on purpose. 8787 sits in the range things pick for
/// themselves — a second relay, a development server, anything already on the
/// host — and a default that collides is a failure at the far end of an
/// install. Five digits nobody else reaches for costs nothing and collides with
/// nothing.
pub const ZONE_PORT: u16 = 38787;

/// How a new relay will serve its zone.
///
/// Grouped rather than passed one by one: they answer a single question — what
/// this relay will look like from inside its zone — and threading five options
/// through a signature is how the wrong one ends up in the wrong position.
#[derive(Debug, Default)]
pub struct ZoneSetup {
    /// A whole `host:port`, when neither the address nor the port is to be
    /// worked out. Wins over everything else here.
    pub listen: Option<String>,
    pub interface: Option<String>,
    pub port: Option<u16>,
    pub forward_interval: Option<u64>,
    pub forward: Option<Forward>,
}

fn default_listen() -> String {
    // Only for a config file written before `listen` existed, or one that lost
    // the field. A relay being installed today gets a reachable address from
    // `listen_address`, because loopback here is the one value that cannot do
    // the job — see below.
    format!("127.0.0.1:{ZONE_PORT}")
}

/// The address to write into a new `proxy.toml`.
///
/// Loopback used to be the default, on the reasoning that binding every
/// interface is a decision an operator should take rather than inherit. That
/// reasoning was sound and the conclusion was wrong: nothing outside the
/// machine can reach `127.0.0.1`, so a relay installed with that default served
/// nobody, and the command `tern-proxy pin` printed could not work on the
/// machine it was written for. The failure arrived one step later, on somebody
/// else's terminal, as a connection refused.
///
/// `0.0.0.0` is the other easy answer and it is no better: it binds networks
/// nobody asked about, and it still leaves "which address do I give an agent"
/// unanswered — a config file that says `0.0.0.0` tells a reader nothing.
///
/// So one concrete address. By default the one on the interface that already
/// carries traffic to TERN, which is the interface a single-homed relay has.
/// `--interface` names another, for the ordinary two-legged case: one card
/// facing the zone, one facing out.
pub fn listen_address(interface: Option<&str>, upstream: &str, port: u16) -> Result<String> {
    if let Some(name) = interface {
        let address = interface_v4(name)?;
        return Ok(format!("{address}:{port}"));
    }

    // The interface facing upstream, found by asking the routing table rather
    // than by guessing at names — `eth0` is not a thing on most systems now.
    if let Some(address) = outbound_address(upstream) {
        if !address.is_loopback() {
            return Ok(format!("{address}:{port}"));
        }
    }

    // Upstream on this very machine, or unreachable while installing. Take the
    // first address that is not loopback: still better than a value that is
    // known not to work.
    if let Some(address) = first_routable_v4() {
        return Ok(format!("{address}:{port}"));
    }

    bail!(
        "could not find an address for the agents in this zone to reach. \
         Name one with --listen <host:port>, or an interface with --interface <name>."
    )
}

/// The IPv4 address of one named interface.
fn interface_v4(name: &str) -> Result<std::net::Ipv4Addr> {
    let interfaces =
        if_addrs::get_if_addrs().context("could not read this machine's interfaces")?;

    for interface in &interfaces {
        if interface.name != name {
            continue;
        }
        if let std::net::IpAddr::V4(address) = interface.ip() {
            return Ok(address);
        }
    }

    // The available names, because the failure is almost always a typo or a
    // guess at a name from another machine, and a bare refusal sends the reader
    // to `ip addr` in another window.
    let mut names: Vec<&str> = interfaces.iter().map(|i| i.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    bail!(
        "no IPv4 address on interface {name}. This machine has: {}",
        names.join(", ")
    )
}

/// Every address of this machine an agent could plausibly dial.
///
/// Loopback and link-local are left out: the first cannot be reached from
/// anywhere else, the second needs a scope nobody types. What remains is short
/// — one or two entries on an ordinary host — and it is a list of facts rather
/// than a guess, which is the whole point. The server had been inferring this
/// from where a connection arrived, and on a containerised TERN that is a
/// bridge gateway that exists nowhere else.
pub fn routable_addresses() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    // Virtual bridges are left out by name. A machine running containers has
    // one gateway per network — twenty-four addresses on the host this was
    // found on, of which two were reachable from anywhere else. Offering the
    // rest as somewhere to dial a relay is worse than offering nothing: it is
    // twenty wrong answers among two right ones, and the reader has no way to
    // tell which is which.
    //
    // By name and not by range, because 172.16/12 and 192.168/16 are ordinary
    // private networks that a real zone may well live on.
    let virtual_prefixes = [
        "docker",
        "br-",
        "virbr",
        "veth",
        "cni",
        "flannel",
        "tailscale",
    ];

    let mut out: Vec<String> = interfaces
        .iter()
        .filter(|interface| {
            !virtual_prefixes
                .iter()
                .any(|prefix| interface.name.starts_with(prefix))
        })
        .filter_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(address) if !address.is_loopback() && !address.is_link_local() => {
                Some(address.to_string())
            }
            _ => None,
        })
        .collect();

    out.sort();
    out.dedup();
    out
}

fn first_routable_v4() -> Option<std::net::Ipv4Addr> {
    let interfaces = if_addrs::get_if_addrs().ok()?;
    interfaces
        .iter()
        .find_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(address) if !address.is_loopback() && !address.is_link_local() => {
                Some(address)
            }
            _ => None,
        })
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
    /// Rung by `ingest` in stream mode, waited on by the flush loop.
    flush: Arc<tokio::sync::Notify>,
    /// What the local page reports, when one is being served.
    ui: Arc<crate::ui::UiState>,
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
        flush: Arc::new(tokio::sync::Notify::new()),
        ui: crate::ui::UiState::new(config.ui.as_ref().and_then(|u| u.credential.clone())),
    };

    /*
     * The page, on its own listener.
     *
     * Not a route on the zone's server, which would be the shorter way to write
     * it: that port is the one every machine in the zone can reach, and the
     * page says where TERN is, which tenant this is and what is queued. A
     * compromised host in the zone reading all of that is exactly what the zone
     * boundary exists to prevent. Its own listener means the page can stay on
     * loopback while the zone stays open, which is the arrangement that makes
     * sense on a relay.
     */
    if let Some(settings) = config.ui.clone() {
        let ui_state = state.ui.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::ui::serve(ui_state, &settings.listen).await {
                warn!(%error, "the local page stopped");
            }
        });
    }

    let app = Router::new()
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/ingest", post(ingest))
        .route("/api/v1/agent/jobs", get(jobs_route))
        .route("/api/v1/agent/heartbeat", post(heartbeat))
        // The installation of the zone, relayed. Without these four, a machine
        // with no route to TERN can be paired but not installed, and the one
        // command an operator wants to run does not exist.
        .route("/install.sh", get(install_sh))
        .route("/install.ps1", get(install_ps1))
        .route("/api/v1/agent/releases", get(releases))
        .route("/api/v1/agent/bin/{file}", get(binary))
        .route("/health", get(health))
        .with_state(state.clone());

    /*
     * The page, filled before anything is served on it.
     *
     * The refresh loop is what keeps it current, and that loop deliberately
     * skips its first tick — the work was already done at startup — so without
     * this the page said nothing at all for a full refresh interval, five
     * minutes by default. Worse than nothing, in fact: with no zone figures it
     * has no way to tell it is looking at a relay, and would have drawn the
     * probe and check rows of an agent. Somebody checking on a relay that has
     * just restarted is exactly the reader this page is for.
     */
    {
        let inner = state.inner.lock().await;
        state
            .ui
            .update(|snapshot| {
                snapshot.role = "tern-proxy".to_string();
                snapshot.version = env!("CARGO_PKG_VERSION").to_string();
                snapshot.server = inner.config.server.clone();
                snapshot.tenant =
                    (!inner.tenant_slug.is_empty()).then(|| inner.tenant_slug.clone());
                snapshot.zone_agents = Some(inner.config.local_keys.len());
                snapshot.zone_listen = Some(inner.config.listen.clone());
                snapshot.forwarded = Some(0);
                snapshot.queued = inner.queue.len();
                snapshot.queue_bytes = inner.queue.bytes();
            })
            .await;
    }

    // Two background loops: one to refresh the assignment, one to drain the
    // queue. Separate because a full queue must not stop the assignment
    // refreshing, and vice versa.
    spawn_refresh(state.clone(), config.refresh_s);
    spawn_flush(state.clone(), config.forward_interval_s);

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

            /*
             * A heartbeat of its own, not a side effect of asking for jobs.
             *
             * The relay looked alive because `/agent/jobs` happens to refresh
             * `last_seen_at` server-side. That holds only while the refresh
             * interval is short: set `refresh_s` to an hour — which the config
             * allows and a quiet zone invites — and a perfectly healthy relay
             * goes amber, then red, while it is doing exactly what it was
             * configured to do.
             *
             * The three roles now say the same verb for the same thing, which
             * is the point: an agent, a relay and an agent behind a relay are
             * all "is this thing still there", and a fleet screen that answered
             * that question differently depending on the role was answering a
             * different question.
             */
            let (ui_address, zone_agents, zone_listen, upstream, tenant, queued, queue_bytes) = {
                let inner = state.inner.lock().await;
                (
                    inner
                        .config
                        .ui
                        .as_ref()
                        .and_then(|settings| settings.reachable_address(&inner.config.server)),
                    inner.config.local_keys.len(),
                    inner.config.listen.clone(),
                    inner.config.server.clone(),
                    inner.tenant_slug.clone(),
                    inner.queue.len(),
                    inner.queue.bytes(),
                )
            };

            let outcome = state.client.heartbeat(&key, ui_address.as_deref()).await;

            // The page is refreshed here rather than on a loop of its own: this
            // is the moment the two facts it most needs — whether upstream
            // answered, and how deep the queue is — are both known.
            state
                .ui
                .update(|snapshot| {
                    snapshot.role = "tern-proxy".to_string();
                    snapshot.version = env!("CARGO_PKG_VERSION").to_string();
                    snapshot.server = upstream;
                    snapshot.tenant = (!tenant.is_empty()).then_some(tenant);
                    snapshot.zone_agents = Some(zone_agents);
                    snapshot.zone_listen = Some(zone_listen);
                    snapshot.queued = queued;
                    snapshot.queue_bytes = queue_bytes;
                    match &outcome {
                        Ok(()) => {
                            snapshot.last_heartbeat_ok_s = Some(0);
                            snapshot.last_heartbeat_error = None;
                        }
                        Err(error) => {
                            snapshot.last_heartbeat_error = Some(error.to_string());
                        }
                    }
                })
                .await;

            if let Err(error) = outcome {
                // A warning and nothing more. A relay whose upstream is down
                // must keep serving its zone, which is the entire reason it
                // exists — and the next tick will say so again.
                warn!(%error, "heartbeat failed");
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

    // Sent even with nobody behind it yet: the address is how an operator adds
    // the first machine, so it has to be known before there is one.
    let listen = config.listen.clone();

    if let Err(error) = state
        .client
        .zone(key, &agents, &listen, &routable_addresses())
        .await
    {
        warn!(%error, "could not declare the zone — the fleet view will be a poll behind");
        return;
    }

    if let Err(error) = config.save(&path) {
        warn!(%error, "could not persist the zone inventory");
    }
}

fn spawn_flush(state: AppState, every_s: u64) {
    tokio::spawn(async move {
        // At least a second: an interval of zero would spin, and a relay that
        // burns a core is worse than one that is a second behind.
        let period = std::time::Duration::from_secs(every_s.max(1));
        loop {
            /*
             * Whichever comes first: the interval, or a point arriving in
             * stream mode. One loop either way — the alternative was a second
             * sender, and two ways to the server means two behaviours to reason
             * about on the day it is unreachable.
             */
            tokio::select! {
                _ = tokio::time::sleep(period) => {}
                _ = state.flush.notified() => {}
            }

            let (key, batch) = {
                let inner = state.inner.lock().await;
                (inner.config.api_key.clone(), inner.queue.peek(200))
            };
            if batch.is_empty() {
                continue;
            }

            match state.client.ingest(&key, &batch).await {
                Ok(response) => {
                    let remaining = {
                        let mut inner = state.inner.lock().await;
                        inner.queue.drop_front(batch.len());
                        for rejected in &response.rejected {
                            warn!(control = %rejected.control_key, reason = %rejected.reason, "upstream rejected a point");
                        }
                        (inner.queue.len(), inner.queue.bytes())
                    };
                    let carried = batch.len() as u64;
                    state
                        .ui
                        .update(|snapshot| {
                            // Since this process started, not since the zone
                            // began: the relay keeps no such history, and a
                            // number that looked like a total would be a claim
                            // it cannot support.
                            snapshot.forwarded = Some(snapshot.forwarded.unwrap_or(0) + carried);
                            snapshot.queued = remaining.0;
                            snapshot.queue_bytes = remaining.1;
                            snapshot.last_send_ok_s = Some(0);
                            snapshot.last_send_error = None;
                        })
                        .await;
                }
                Err(error) => {
                    warn!(%error, pending = batch.len(), "upstream unreachable — points kept");
                    let message = error.to_string();
                    state
                        .ui
                        .update(|snapshot| snapshot.last_send_error = Some(message))
                        .await;
                }
            }
        }
    });
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "role": "proxy" }))
}

/// Is this the name of a binary the server publishes, and nothing else?
///
/// A whitelist by shape rather than a copy of the server's list, which would
/// have to be edited here every time a target is added and would be wrong in
/// between. What it has to exclude is the whole point: anything with a slash or
/// a dot-dot turns this route into a way of reading the upstream through the
/// relay, and the relay was chosen for the job because it can reach things the
/// zone cannot.
fn is_publishable_binary(name: &str) -> bool {
    if name == "SHA256SUMS" {
        return true;
    }

    let known_prefix = ["tern-agent-", "tern-proxy-", "tern-setup-"]
        .iter()
        .any(|prefix| name.starts_with(prefix));

    known_prefix
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.contains("..")
}

/// The installer and the binaries, relayed from upstream.
///
/// The reason this exists at all: a machine in the zone has no route to TERN,
/// so `curl … /install.sh` and the binary download both have to come from
/// somewhere it *can* reach. Passed through rather than rewritten — it is the
/// installer's own `--server` flag that points the install back here, so the
/// script needs no editing on its way past.
///
/// Not cached, on purpose. An install is rare, a cache is an invalidation to
/// keep right, and a stale binary served by a relay is precisely the failure
/// this product spent a release learning about.
async fn relay_file(state: &AppState, path: &str) -> Response {
    match state.client.fetch_public(path).await {
        Ok((content_type, body)) => {
            ([(axum::http::header::CONTENT_TYPE, content_type)], body).into_response()
        }
        Err(error) => {
            // 502 and not 404: the file is not missing here, the relay could not
            // get it. Said plainly, because the machine reading this message is
            // the one that cannot check for itself.
            warn!(%error, path, "could not relay a file from upstream");
            (
                StatusCode::BAD_GATEWAY,
                format!("The relay could not fetch {path} from TERN: {error}\n"),
            )
                .into_response()
        }
    }
}

async fn install_sh(State(state): State<AppState>) -> Response {
    relay_file(&state, "/install.sh").await
}

async fn install_ps1(State(state): State<AppState>) -> Response {
    relay_file(&state, "/install.ps1").await
}

async fn releases(State(state): State<AppState>) -> Response {
    relay_file(&state, "/api/v1/agent/releases").await
}

async fn binary(State(state): State<AppState>, AxumPath(file): AxumPath<String>) -> Response {
    if !is_publishable_binary(&file) {
        return (StatusCode::NOT_FOUND, "Unknown binary\n").into_response();
    }
    relay_file(&state, &format!("/api/v1/agent/bin/{file}")).await
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

    match inner
        .pins
        .iter()
        .position(|pin| pin.hash == candidate && !pin.used && pin.expires_at > now)
    {
        Some(index) => inner.pins[index].used = true,
        None => {
            /*
             * Not one of ours — so ask the server whether it is one of its own,
             * minted for this zone.
             *
             * This is what lets the admin print a command that works as pasted.
             * A code used to have to be minted on this machine, by
             * `tern-proxy pin`, which meant one ssh session more than anybody
             * expects and a value the admin could never know.
             *
             * It gives the zone nothing: what comes back is a yes, never a key.
             * The agent still receives a key minted below, valid here and worth
             * nothing upstream, which is the property that makes a zone safe.
             *
             * Upstream being unreachable falls through to the same refusal as a
             * wrong code. A relay whose server is down cannot tell a good code
             * from a bad one, and inventing an answer either way is worse than
             * saying no.
             */
            let key = inner.config.api_key.clone();
            let raw = body.code.trim().to_string();
            drop(inner);

            match state.client.redeem_zone_code(&key, &raw).await {
                Ok(tenant) => {
                    info!(%tenant, "the server accepted a code for this zone");
                }
                Err(error) => {
                    let text = error.to_string();
                    // Two different facts, and the one that matters is which.
                    // Told as one, they send somebody looking at their PIN
                    // while the truth is that this relay cannot ask anybody —
                    // which is what happened during an upgrade of the server.
                    if text.starts_with("refused:") {
                        info!("no local PIN matched and the server refused the code");
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({ "message": "Invalid or expired pairing code" })),
                        )
                            .into_response();
                    }

                    warn!(%error, "cannot check the code — the server is unreachable");
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({
                            "message":
                                "This relay cannot reach TERN, so it cannot check that code. \
                                 Try again once the server is back, or mint a PIN on the relay \
                                 itself with: tern-proxy pin"
                        })),
                    )
                        .into_response();
                }
            }

            inner = state.inner.lock().await;
        }
    }

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
    let agent_id = format!("proxy-local-{}", inner.config.local_keys.len());
    let upstream = inner.config.api_key.clone();

    /*
     * Tell the server about the new member now, rather than at the next tick.
     *
     * The zone was only ever declared on the refresh loop, which defaults to
     * five minutes. So an agent installed behind a relay paired successfully,
     * printed its success, and then did not appear in the admin for up to five
     * minutes — during which the relay's card said "Empty zone" and the only
     * reasonable conclusion was that the install had failed. Watching that
     * happen is how it was found; nothing was broken, and everything looked
     * broken.
     *
     * The lock is dropped first and the call is spawned, so the agent waiting
     * on this response is not made to wait for a round trip to TERN — and so a
     * relay whose upstream is down still finishes pairing, which is the entire
     * reason a zone exists.
     */
    drop(inner);
    let announce = state.clone();
    tokio::spawn(async move { declare_zone(&announce, &upstream).await });

    (
        StatusCode::OK,
        Json(json!({
            "apiKey": key,
            "agentId": agent_id,
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

    // Queued first, then woken. The order is the guarantee: if the send that
    // follows fails, the points are already where an outage cannot lose them.
    if inner.config.forward == Forward::Stream {
        state.flush.notify_one();
    }

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

/// How a machine in the zone should address this relay — and what is uncertain
/// about that answer.
///
/// `listen` answers "what do I bind to", which is a different question from
/// "what should an agent be told to connect to", and the default answers the
/// second one wrongly on purpose: binding loopback is the right default, and
/// `127.0.0.1` is the one address that cannot work in a command meant to be run
/// on another machine. Printing it without a word would hand somebody a command
/// that fails with a connection refused and no explanation of why.
#[derive(Debug, PartialEq, Eq)]
pub struct ZoneAddress {
    /// The `host:port` to print in the commands.
    pub authority: String,
    pub caveat: Option<ZoneCaveat>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ZoneCaveat {
    /// Bound to loopback: nothing off this machine can reach it at all.
    LoopbackOnly,
    /// Bound to every interface, so no single address is *the* address. What is
    /// offered is the one this machine uses to reach TERN, which is a guess
    /// about the zone and has to be named as one.
    Guessed,
}

pub fn zone_address(listen: &str, outbound: Option<std::net::IpAddr>) -> ZoneAddress {
    let (host, port) = match listen.rsplit_once(':') {
        Some((host, port)) => (host.trim_matches(['[', ']']), port),
        // Not a host:port at all: say back exactly what was configured rather
        // than invent something that looks authoritative.
        None => {
            return ZoneAddress {
                authority: listen.to_string(),
                caveat: None,
            }
        }
    };

    match host {
        "0.0.0.0" | "::" | "" => ZoneAddress {
            authority: match outbound {
                Some(ip) => format!("{ip}:{port}"),
                None => format!("<this-machine>:{port}"),
            },
            caveat: Some(ZoneCaveat::Guessed),
        },
        "127.0.0.1" | "localhost" | "::1" => ZoneAddress {
            authority: listen.to_string(),
            caveat: Some(ZoneCaveat::LoopbackOnly),
        },
        _ => ZoneAddress {
            authority: listen.to_string(),
            caveat: None,
        },
    }
}

/// Which of this machine's addresses faces the upstream server.
///
/// A connected UDP socket sends nothing; it only asks the routing table which
/// interface would be used to reach that destination. That is exactly the
/// question — and it needs no privileges, no probing, and no network round
/// trip. Best guess only: the interface that reaches TERN is not necessarily
/// the one the zone arrives on, which is why the caller says so.
pub fn outbound_address(upstream: &str) -> Option<std::net::IpAddr> {
    let url = reqwest::Url::parse(upstream).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default().unwrap_or(443);

    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect((host, port)).ok()?;
    socket.local_addr().ok().map(|address| address.ip())
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
pub async fn init(server: &str, pin: &str, config_path: &Path, setup: ZoneSetup) -> Result<()> {
    // Resolved before pairing, so a machine whose address cannot be worked out
    // fails without having consumed a single-use PIN.
    let listen = match setup.listen {
        Some(explicit) => explicit,
        // The port alone, when the address is fine and 8787 is taken — which is
        // the ordinary shape of a second relay on one machine, or of a host
        // where something else already answers there. Naming a whole host:port
        // for that would mean working out the address by hand, which is exactly
        // what this stopped requiring.
        None => listen_address(
            setup.interface.as_deref(),
            server,
            setup.port.unwrap_or(ZONE_PORT),
        )?,
    };

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
        listen,
        refresh_s: default_refresh(),
        forward_interval_s: setup
            .forward_interval
            .unwrap_or_else(default_forward_interval),
        forward: setup.forward.unwrap_or_default(),
        local_keys: Vec::new(),
        // Off until asked for, exactly as an agent's is: a relay binding a
        // second port because it was installed would be a port on somebody's
        // machine that they never chose.
        ui: None,
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
    println!(
        "  Forwarding {}",
        match config.forward {
            Forward::Stream => "as points arrive".to_string(),
            Forward::Batch => format!("every {}s", config.forward_interval_s),
        }
    );
    println!("  Wrote {} (readable only by you)", config_path.display());
    println!();
    // Its own path, not its own name: the installer puts this in ~/.local/bin,
    // which is on nobody's PATH by default on a server — and a bare name
    // printed under that warning is a `command not found` waiting to happen.
    let me = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "tern-proxy".to_string());

    println!("Next:");
    println!("  {me} run --config {}", config_path.display());
    println!();

    /*
     * The command for the *other* machine, spelled out here.
     *
     * What used to be printed was `tern-proxy pin --config <path>` under "add
     * agents to this zone from this machine" — two things wrong at once for
     * anybody reading it while looking at the machine they wanted to monitor:
     * that path exists only here, and the binary to put over there is
     * `tern-agent`, not this one. It described the first of two steps as though
     * it were the whole thing.
     *
     * A PIN from the admin now works in a zone — the relay redeems it upstream
     * — so the whole thing really is one line, and it can be printed with the
     * PIN left as the only blank.
     */
    // The outbound address is passed so that a relay deliberately bound to
    // every interface prints a usable address rather than a placeholder: the
    // command is the point, and `<this-machine>:8787` cannot be pasted.
    let origin = format!(
        "http://{}",
        zone_address(&config.listen, outbound_address(server)).authority
    );
    /*
     * A frame, a green command, and the placeholder said out loud.
     *
     * This printed the line with a literal `<PIN>` in it, under the heading
     * "To add an agent" — which reads as a command that is ready, and is not.
     * Somebody pastes it and the far machine answers "invalid or expired",
     * about a PIN that was never a PIN. So the two halves are now separated:
     * the frame holds the shape of the command, the placeholder is coloured
     * like the missing thing it is, and where to get it comes first.
     *
     * Colour only on a terminal, for the reason the `pin` command already
     * carries: a line captured into a file must not arrive wrapped in bytes
     * the reader then has to strip.
     */
    let tty = std::io::IsTerminal::is_terminal(&std::io::stdout());
    let (green, red, dim, reset) = if tty {
        ("\x1b[32m", "\x1b[31m", "\x1b[2m", "\x1b[0m")
    } else {
        ("", "", "", "")
    };

    println!();
    println!("{dim}┌─ To add an agent on a machine in this zone ─────────────{reset}");
    println!("{dim}│{reset}");
    println!(
        "{dim}│{reset}  1. Open the admin, go to {red}Agents → Add an agent{reset}, and choose"
    );
    println!(
        "{dim}│{reset}     {red}An agent behind a relay{reset}. It shows a PIN, good for five"
    );
    println!("{dim}│{reset}     minutes, and renews it on its own when it runs out.");
    println!("{dim}│{reset}");
    println!("{dim}│{reset}  2. Run this on the isolated machine, with that PIN in place");
    println!("{dim}│{reset}     of {red}PIN{reset}:");
    println!("{dim}│{reset}");
    println!("{dim}│{reset}     {green}curl -fsSL {origin}/install.sh | sh -s -- \\{reset}");
    println!("{dim}│{reset}       {green}--server {origin} --pin {reset}{red}PIN{reset}");
    println!("{dim}│{reset}");
    println!("{dim}└────────────────────────────────────────────────────────{reset}");
    println!();
    println!("If this relay cannot reach TERN at that moment, the admin cannot mint");
    println!("one either — the code is redeemed through this relay. Mint it here:");
    println!(
        "      {green}{me} pin --config {}{reset}",
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
            forward_interval_s: default_forward_interval(),
            forward: Forward::default(),
            ui: None,
            local_keys: vec![LocalKey {
                name: "edge-1".into(),
                key_hash: hash("ternp_local"),
                last_seen: None,
                ip: None,
            }],
        }
    }

    #[test]
    fn forwarding_defaults_to_what_it_always_was() {
        // Ten seconds in batches, which is what the hard-coded loop did. A
        // default that changed behaviour on upgrade would be a surprise nobody
        // asked for on a relay that was working.
        let config = config_with_one_agent();
        assert_eq!(config.forward_interval_s, 10);
        assert_eq!(config.forward, Forward::Batch);
    }

    #[test]
    fn a_config_written_before_these_settings_still_loads() {
        // A proxy already deployed must not be stranded by an upgrade. The two
        // fields are `#[serde(default)]` for exactly this, and the assertion is
        // that the file — not the struct — survives.
        let dir = std::env::temp_dir().join(format!("tern-forward-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proxy.toml");

        let old = concat!(
            "server = \"https://tern.example\"\n",
            "api_key = \"k\"\n",
            "listen = \"127.0.0.1:8787\"\n",
            "refresh_s = 300\n"
        );
        std::fs::write(&path, old).unwrap();

        let loaded = ProxyConfig::load(&path).unwrap();
        assert_eq!(loaded.forward_interval_s, 10);
        assert_eq!(loaded.forward, Forward::Batch);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_chosen_cadence_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("tern-forward-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proxy.toml");

        let mut config = config_with_one_agent();
        config.forward_interval_s = 300;
        config.forward = Forward::Stream;
        config.save(&path).unwrap();

        let reloaded = ProxyConfig::load(&path).unwrap();
        assert_eq!(reloaded.forward_interval_s, 300);
        // Serialised lowercase, because that is what somebody types on the
        // command line and then reads back in the file.
        assert!(std::fs::read_to_string(&path).unwrap().contains("stream"));
        assert_eq!(reloaded.forward, Forward::Stream);

        std::fs::remove_dir_all(&dir).ok();
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
                forward_interval_s: default_forward_interval(),
                forward: Forward::default(),
                local_keys: Vec::new(),
                ui: None,
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

    /// The guard on the one route that takes a name from the request.
    ///
    /// The relay is put where it is *because* it can reach things the zone
    /// cannot, so a route that forwards whatever path it is handed would be an
    /// open door into exactly the network worth protecting.
    #[test]
    fn only_the_published_binaries_are_relayed() {
        for name in [
            "tern-agent-x86_64-unknown-linux-musl",
            "tern-proxy-aarch64-apple-darwin",
            "tern-agent-x86_64-pc-windows-msvc.exe",
            "tern-setup-x86_64-unknown-linux-musl",
            "SHA256SUMS",
        ] {
            assert!(is_publishable_binary(name), "{name} should be served");
        }

        for name in [
            "../../etc/passwd",
            "tern-agent-../../../etc/shadow",
            "tern-agent-x/../../secret",
            "internal/metrics",
            "curl-x86_64",
            "",
            // The one that carries a right-looking prefix and no slash, so it
            // passes every check but the last. Without it this test went on
            // passing with the dot-dot guard deleted, which is the only reason
            // it is written out here rather than assumed.
            "tern-agent-..",
        ] {
            assert!(!is_publishable_binary(name), "{name} should be refused");
        }
    }

    /// What an agent is told to connect to, which is not what the relay binds.
    ///
    /// The default binds loopback, and that is the right default — but a
    /// command built from it works only on the relay itself, and the machine it
    /// is meant for is by definition a different one. Printing `127.0.0.1:8787`
    /// without a word hands somebody a connection refused and no reason for it.
    #[test]
    fn the_printed_address_says_when_it_cannot_work() {
        let loopback = zone_address("127.0.0.1:8787", None);
        assert_eq!(loopback.authority, "127.0.0.1:8787");
        assert_eq!(loopback.caveat, Some(ZoneCaveat::LoopbackOnly));
        assert_eq!(
            zone_address("localhost:8787", None).caveat,
            Some(ZoneCaveat::LoopbackOnly)
        );

        // Bound to everything: no single address is the address, so the one
        // offered is a guess and has to be marked as one.
        let every = zone_address("0.0.0.0:8787", Some("192.168.1.112".parse().unwrap()));
        assert_eq!(every.authority, "192.168.1.112:8787");
        assert_eq!(every.caveat, Some(ZoneCaveat::Guessed));

        // Nothing to guess from: better a placeholder that cannot be mistaken
        // for an address than an address that is wrong.
        let unknown = zone_address("0.0.0.0:9000", None);
        assert_eq!(unknown.authority, "<this-machine>:9000");
        assert_eq!(unknown.caveat, Some(ZoneCaveat::Guessed));

        // Configured deliberately: use it as written, say nothing.
        let chosen = zone_address("192.168.64.1:8787", None);
        assert_eq!(chosen.authority, "192.168.64.1:8787");
        assert_eq!(chosen.caveat, None);
    }

    /// The address written into a fresh `proxy.toml` has to be one an agent on
    /// another machine can dial.
    ///
    /// This is the defect the change exists for: the old default was
    /// `127.0.0.1:8787`, so a relay installed from the one-liner served nobody
    /// and the command it printed could not work anywhere it was meant to be
    /// run. It failed one step later, on a different terminal, as a connection
    /// refused with nothing to connect it back to this decision.
    #[test]
    fn a_new_relay_is_given_an_address_its_zone_can_reach() {
        // Any upstream will do: what is being asked of the routing table is
        // which of this machine's addresses faces outward, and every non-local
        // destination gives the same answer.
        let listen = listen_address(None, "https://example.com", ZONE_PORT)
            .expect("this machine has a network");

        let (host, port) = listen.rsplit_once(':').expect("host:port");
        assert_eq!(port, ZONE_PORT.to_string());

        let address: std::net::Ipv4Addr = host.parse().expect("a bare IPv4 address");
        assert!(!address.is_loopback(), "{listen} would serve nobody");
        assert!(
            !address.is_unspecified(),
            "{listen} names every interface, which tells a reader nothing"
        );
    }

    /// A named interface wins, and an unknown one says what does exist.
    #[test]
    fn an_interface_can_be_named_and_a_wrong_name_is_helpful() {
        // Loopback is the one interface every machine has under the same name,
        // which is what makes it usable in a test — and it is deliberately the
        // one case the default refuses, so naming it proves the option is
        // honoured rather than second-guessed.
        let listen =
            listen_address(Some("lo"), "https://example.com", 9999).expect("lo exists everywhere");
        assert_eq!(listen, "127.0.0.1:9999");

        let error = listen_address(Some("nexistepas0"), "https://example.com", 8787)
            .expect_err("an interface that is not there");
        let message = error.to_string();
        assert!(message.contains("nexistepas0"), "{message}");
        // The names it does have: the mistake is nearly always a name borrowed
        // from another machine, and a bare refusal sends the reader elsewhere.
        assert!(message.contains("lo"), "{message}");
    }

    /// The passthrough, against a server that actually answers.
    ///
    /// Worth the machinery: what this proves is that the bytes and the content
    /// type arrive unchanged, and the installer is a shell script piped into a
    /// shell — a body that is subtly rewritten on the way through would be
    /// found by whoever runs it, on the machine nobody here can look at.
    #[tokio::test]
    async fn a_file_is_relayed_from_upstream_unchanged() {
        const SCRIPT: &str = "#!/bin/sh\necho installer\n";

        let app = Router::new().route(
            "/install.sh",
            get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/x-shellscript; charset=utf-8",
                    )],
                    SCRIPT,
                )
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });

        let client = crate::transport::Client::new(&format!("http://{address}")).unwrap();

        let (content_type, body) = client.fetch_public("/install.sh").await.unwrap();
        assert_eq!(body, SCRIPT.as_bytes());
        assert!(content_type.starts_with("text/x-shellscript"));

        // A refusal upstream must not be reported as an empty file: the machine
        // reading it has no way of checking for itself.
        let missing = client.fetch_public("/install.ps1").await;
        assert!(
            missing.is_err(),
            "a 404 upstream should surface as an error"
        );
    }
}
