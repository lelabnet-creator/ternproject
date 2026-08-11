//! A small page an agent serves about itself.
//!
//! ## Why an agent needs a face
//!
//! Everything an agent knows travels upstream and is read on somebody else's
//! screen. That is the right default — the fleet view belongs in the admin —
//! but it leaves the one case where it matters most unanswered: the agent that
//! is *not* reaching the server. Its state is then visible nowhere at all, and
//! the person standing at that machine is reduced to reading a journal and
//! guessing which of "no route", "wrong key" and "not running" they have.
//!
//! This is the local answer to that. It says what the agent is, what it is
//! talking to, whether that is working, what it has queued, and what it has
//! measured — the five things somebody debugging one actually asks.
//!
//! ## Loopback, and a password anyway
//!
//! It binds `127.0.0.1` unless told otherwise. An agent's page names the
//! server, the tenant and every control the agent runs: that is a map of
//! somebody's estate, and it has no business being reachable from the network
//! by default.
//!
//! The password is there because the default will not hold. Somebody will bind
//! it to a LAN address to read it from their desk — that is a reasonable thing
//! to want — and the difference between "loopback only" and "loopback by
//! default" is exactly one config line. A page that was safe only through its
//! binding would become unsafe silently.
//!
//! Basic auth rather than a form: no session, no cookie, no CSRF surface, and
//! the browser remembers it. The hash is salted SHA-256, which is the right
//! strength for a credential that guards a read-only local page and is not
//! reused anywhere — and it is deliberately not the argon2 the server uses,
//! because that would put a password-hashing dependency in a binary built for
//! size to protect a page on the loopback interface.

use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::info;

/// What the page reports. Written by the runner, read by the handlers.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// `agent`, `proxy`, or `agent behind a relay` — what this process is.
    pub role: String,
    pub version: String,
    /// Where it sends. A relay's zone agent shows the relay, not TERN, which is
    /// the whole point: it is the address that machine can actually reach.
    pub server: String,
    pub tenant: Option<String>,
    pub probes: usize,
    /// Points waiting on disk because the far end was unreachable.
    pub queued: usize,
    /// Points thrown away because the queue reached its bound. Never zero
    /// quietly: this is data that no longer exists anywhere.
    pub dropped: usize,
    pub queue_bytes: u64,
    pub checks_ok: u64,
    pub checks_failed: u64,
    /// Seconds since this process started, and since each of the two
    /// conversations last succeeded. `None` means "not yet", which is a
    /// different answer from "a long time ago" and has to look different.
    pub uptime_s: u64,
    pub last_send_ok_s: Option<u64>,
    pub last_send_error: Option<String>,
    pub last_heartbeat_ok_s: Option<u64>,
    pub last_heartbeat_error: Option<String>,
}

pub struct UiState {
    pub snapshot: Mutex<Snapshot>,
    started: Instant,
    credential: Option<Credential>,
}

/// The stored form of the UI password: a salt and a hash, never the password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub salt: String,
    pub hash: String,
}

impl Credential {
    /// Hashes a fresh password, returning what belongs in the config.
    pub fn create(password: &str) -> Self {
        let salt = crate::transport::random_token(16);
        Credential {
            hash: digest(&salt, password),
            salt,
        }
    }

    fn matches(&self, password: &str) -> bool {
        /*
         * Constant-time, so a wrong password cannot be found one character at
         * a time. The page is local and the attack is unlikely; writing the
         * comparison the other way is a habit that eventually gets copied
         * somewhere it matters.
         */
        let expected = digest(&self.salt, password);
        let a = expected.as_bytes();
        let b = self.hash.as_bytes();
        if a.len() != b.len() {
            return false;
        }
        a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }
}

fn digest(salt: &str, password: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    format!("{:x}", hasher.finalize())
}

impl UiState {
    pub fn new(credential: Option<Credential>) -> Arc<Self> {
        Arc::new(UiState {
            snapshot: Mutex::new(Snapshot::default()),
            started: Instant::now(),
            credential,
        })
    }

    /// Hands the runner a snapshot to mutate, stamping the uptime as it goes.
    pub async fn update(&self, edit: impl FnOnce(&mut Snapshot)) {
        let mut snapshot = self.snapshot.lock().await;
        edit(&mut snapshot);
        snapshot.uptime_s = self.started.elapsed().as_secs();
    }
}

/// Serves the page until the process ends.
pub async fn serve(state: Arc<UiState>, listen: &str) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/", get(page))
        .route("/state.json", get(state_json))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!(address = %listen, "serving the agent page");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Basic auth, or nothing when no password is set.
///
/// Returning `None` for "no credential configured" rather than refusing: an
/// agent that has never been given a password serves its page on loopback, and
/// demanding one nobody has set would make the feature undiscoverable. Setting
/// a password is what turns the check on, and `--listen` on anything but
/// loopback warns when there is none.
fn authorised(state: &UiState, headers: &header::HeaderMap) -> bool {
    let Some(credential) = &state.credential else {
        return true;
    };

    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
    else {
        return false;
    };

    let Some(decoded) = decode_base64(value) else {
        return false;
    };
    // `user:password`; the user part is ignored, because there is one account.
    let Some((_, password)) = decoded.split_once(':') else {
        return false;
    };
    credential.matches(password)
}

fn unauthorised() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Basic realm=\"tern-agent\"")],
        "Authentication required.\n",
    )
        .into_response()
}

async fn state_json(State(state): State<Arc<UiState>>, headers: header::HeaderMap) -> Response {
    if !authorised(&state, &headers) {
        return unauthorised();
    }
    let snapshot = state.snapshot.lock().await.clone();
    Json(snapshot).into_response()
}

async fn page(State(state): State<Arc<UiState>>, headers: header::HeaderMap) -> Response {
    if !authorised(&state, &headers) {
        return unauthorised();
    }

    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response()
}

/// Minimal base64, because one decode does not justify a dependency in a
/// binary built with `opt-level = "z"`.
fn decode_base64(input: &str) -> Option<String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::new();
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|c| *c == byte)? as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    String::from_utf8(out).ok()
}

/// The page itself.
///
/// One file, no build step, no framework. It fetches `state.json` every five
/// seconds and rewrites a handful of nodes — an agent's own page is read for a
/// minute while something is wrong, and shipping a bundler to render eleven
/// numbers would be the wrong trade twice over.
const PAGE: &str = include_str!("ui.html");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_matches_itself_and_nothing_else() {
        let credential = Credential::create("correct horse");
        assert!(credential.matches("correct horse"));
        assert!(!credential.matches("correct horse "));
        assert!(!credential.matches(""));
    }

    #[test]
    fn two_agents_given_the_same_password_store_different_hashes() {
        // The salt doing its job: a stolen config from one machine says
        // nothing about another, and a table of common passwords is useless
        // against either.
        let a = Credential::create("same");
        let b = Credential::create("same");
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn basic_auth_is_read_the_way_a_browser_writes_it() {
        // "tern:hunter2", as a browser encodes it.
        assert_eq!(
            decode_base64("dGVybjpodW50ZXIy").as_deref(),
            Some("tern:hunter2")
        );
        // A password containing a colon still works: only the first one splits.
        let decoded = decode_base64("dGVybjphOmI=").unwrap();
        assert_eq!(decoded.split_once(':').unwrap().1, "a:b");
    }

    #[test]
    fn no_password_configured_serves_the_page() {
        /*
         * Deliberate, and the comment on `authorised` says why: an agent that
         * has never been given one serves on loopback, because demanding a
         * password nobody set would make the page undiscoverable. Pinned here
         * so that turning it into a refusal is a decision somebody makes on
         * purpose rather than a tidy-looking edit.
         */
        let state = UiState::new(None);
        assert!(authorised(&state, &header::HeaderMap::new()));
    }

    #[test]
    fn a_configured_password_refuses_an_empty_request() {
        let state = UiState::new(Some(Credential::create("secret")));
        assert!(!authorised(&state, &header::HeaderMap::new()));
    }
}
