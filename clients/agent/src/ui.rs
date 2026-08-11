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
//! A form on the page, not Basic auth. Basic was chosen first for what it
//! avoids — no session, no cookie, no CSRF surface — and those are real, but it
//! pays for them with a browser dialog that cannot be styled, cannot say what
//! this page is, cannot explain that the username is ignored, and is cleared
//! only by closing the browser. For a page whose whole job is to be legible to
//! somebody checking on a machine, that is the wrong trade.
//!
//! So the costs come back and are paid explicitly:
//!
//! - **Session**: a random token held in memory, so every restart signs
//!   everyone out. Nothing about it is written to disk.
//! - **Cookie**: `HttpOnly`, `SameSite=Strict`, and `Path=/`. Strict is what
//!   removes most of what CSRF would mean here.
//! - **CSRF**: what is left is very little, because there is nothing to forge.
//!   The page is read-only — no endpoint changes anything about the agent — and
//!   the only writes are signing in and out. `SameSite=Strict` stops a foreign
//!   page from carrying the cookie at all.
//! - **Guessing**: a form invites a script where a browser dialog discouraged
//!   one, so failures are counted and the door shuts for a while. See
//!   `Attempts`.
//!
//! The hash is salted SHA-256, which is the right strength for a credential
//! that guards a read-only local page and is not reused anywhere — and it is
//! deliberately not the argon2 the server uses, because that would put a
//! password-hashing dependency in a binary built for size to protect a page on
//! the loopback interface.

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
    /// Live session tokens. In memory only: a restart signs everyone out, and
    /// nothing about who was signed in survives on disk.
    sessions: Mutex<Vec<String>>,
    attempts: Mutex<Attempts>,
}

/// How many passwords have been got wrong lately, and whether to keep listening.
///
/// A browser dialog discouraged scripted guessing simply by being awkward. A
/// form does not, so the counting has to be explicit. Five wrong answers and the
/// door stays shut for a minute — long enough that guessing a generated
/// twelve-character password stops being a plan, short enough that somebody who
/// mistyped theirs is not locked out of their own machine for the afternoon.
///
/// Counted per process, not per caller: distinguishing callers would mean
/// trusting an address, and the whole point is that this may be exposed.
#[derive(Debug)]
struct Attempts {
    failures: u32,
    locked_until: Option<Instant>,
}

const MAX_FAILURES: u32 = 5;
const LOCKOUT: std::time::Duration = std::time::Duration::from_secs(60);

impl Attempts {
    fn locked(&self) -> bool {
        self.locked_until
            .is_some_and(|until| Instant::now() < until)
    }

    fn fail(&mut self) {
        self.failures += 1;
        if self.failures >= MAX_FAILURES {
            self.failures = 0;
            self.locked_until = Some(Instant::now() + LOCKOUT);
        }
    }

    fn succeed(&mut self) {
        self.failures = 0;
        self.locked_until = None;
    }
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
            sessions: Mutex::new(Vec::new()),
            attempts: Mutex::new(Attempts {
                failures: 0,
                locked_until: None,
            }),
        })
    }

    /// Whether this page is guarded at all.
    ///
    /// An agent nobody set a password on serves its page open, on loopback,
    /// which is what makes the feature findable. Setting a password turns the
    /// check on; `tern-agent ui --listen` warns when a wider binding has none.
    pub fn guarded(&self) -> bool {
        self.credential.is_some()
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
        .route("/login", axum::routing::post(login))
        .route("/logout", axum::routing::post(logout))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!(address = %listen, "serving the agent page");
    axum::serve(listener, app).await?;
    Ok(())
}

const COOKIE: &str = "tern_ui";

/// Whether this request carries a live session, or the page needs no one.
async fn authorised(state: &UiState, headers: &header::HeaderMap) -> bool {
    if state.credential.is_none() {
        return true;
    }
    let Some(token) = session_cookie(headers) else {
        return false;
    };
    let sessions = state.sessions.lock().await;
    // Constant-time per candidate, for the same reason the password comparison
    // is: a token found one character at a time is a token found.
    sessions.iter().any(|known| constant_eq(known, &token))
}

/// The session token from the request's cookies, if there is one.
///
/// Hand-parsed because the alternative is a cookie crate in a binary built for
/// size, to read one name. Splitting on `;` then on the first `=` is the whole
/// of the format that matters here.
fn session_cookie(headers: &header::HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| name.trim() == COOKIE)
        .map(|(_, value)| value.trim().to_string())
}

fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

/// Exchanges the password for a session.
///
/// One field, because there is one account. The username Basic auth insisted on
/// was always ignored, and asking for something that is not read is how a form
/// teaches somebody the wrong thing about what guards their machine.
async fn login(State(state): State<Arc<UiState>>, Json(body): Json<LoginBody>) -> Response {
    let Some(credential) = &state.credential else {
        // Nothing is set, so nothing can be signed into. Said plainly rather
        // than answering "ok" to any password, which would be a lie the caller
        // could reasonably act on.
        return (StatusCode::NO_CONTENT, "").into_response();
    };

    {
        let attempts = state.attempts.lock().await;
        if attempts.locked() {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many attempts. Try again in a minute.\n",
            )
                .into_response();
        }
    }

    if !credential.matches(&body.password) {
        state.attempts.lock().await.fail();
        // The same answer whether the password was wrong or the page has no
        // password at all is not needed here — but the *delay* matters more
        // than the wording, and the lockout above is what provides it.
        return (StatusCode::UNAUTHORIZED, "Wrong password.\n").into_response();
    }

    state.attempts.lock().await.succeed();
    let token = crate::transport::random_token(24);
    state.sessions.lock().await.push(token.clone());

    (
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            // No `Secure`: this page is plain HTTP by design — it is served by
            // an agent that has no certificate and no name to put one on — and
            // marking the cookie Secure would stop the browser sending it at
            // all. `HttpOnly` keeps it away from scripts; `Strict` keeps it
            // away from other origins, which is what stands in for CSRF tokens
            // on a page that changes nothing.
            format!("{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/"),
        )],
    )
        .into_response()
}

/// Ends this session, and only this one.
async fn logout(State(state): State<Arc<UiState>>, headers: header::HeaderMap) -> Response {
    if let Some(token) = session_cookie(&headers) {
        state.sessions.lock().await.retain(|known| *known != token);
    }
    (
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            format!("{COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
        )],
    )
        .into_response()
}

async fn state_json(State(state): State<Arc<UiState>>, headers: header::HeaderMap) -> Response {
    if !authorised(&state, &headers).await {
        // No `WWW-Authenticate`: that header is what summons the browser dialog
        // this page exists to replace. A bare 401 is what the page reads to
        // know it should show its own form.
        return (StatusCode::UNAUTHORIZED, "Sign in.\n").into_response();
    }
    let snapshot = state.snapshot.lock().await.clone();

    /// The figures, plus the one thing about the page itself the page needs.
    ///
    /// Whether there is a password at all is not part of an agent's state, but
    /// it decides whether "Sign out" means anything — and without it the page
    /// offered to end a session that was never begun.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        #[serde(flatten)]
        snapshot: Snapshot,
        guarded: bool,
    }

    Json(Body {
        snapshot,
        guarded: state.guarded(),
    })
    .into_response()
}

/// The page itself, served to anyone who asks.
///
/// It carries no data — every figure arrives from `state.json`, which is
/// guarded — so there is nothing here to protect, and serving it unguarded is
/// what lets it show its own sign-in form instead of a browser dialog.
async fn page(State(_state): State<Arc<UiState>>) -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response()
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

    fn with_cookie(raw: &str) -> header::HeaderMap {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::COOKIE, raw.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn no_password_configured_serves_the_page() {
        /*
         * Deliberate, and the comment on `guarded` says why: an agent that has
         * never been given one serves on loopback, because demanding a password
         * nobody set would make the page undiscoverable. Pinned here so that
         * turning it into a refusal is a decision somebody makes on purpose
         * rather than a tidy-looking edit.
         */
        let state = UiState::new(None);
        assert!(authorised(&state, &header::HeaderMap::new()).await);
    }

    #[tokio::test]
    async fn a_configured_password_refuses_a_request_with_no_session() {
        let state = UiState::new(Some(Credential::create("secret")));
        assert!(!authorised(&state, &header::HeaderMap::new()).await);
        assert!(!authorised(&state, &with_cookie("tern_ui=made-up")).await);
    }

    #[tokio::test]
    async fn a_session_token_is_accepted_until_it_is_dropped() {
        let state = UiState::new(Some(Credential::create("secret")));
        state.sessions.lock().await.push("token-abc".to_string());

        assert!(authorised(&state, &with_cookie("tern_ui=token-abc")).await);
        // Beside other cookies, which is how it will actually arrive.
        assert!(authorised(&state, &with_cookie("theme=dark; tern_ui=token-abc; x=1")).await);

        state.sessions.lock().await.clear();
        assert!(!authorised(&state, &with_cookie("tern_ui=token-abc")).await);
    }

    #[test]
    fn a_cookie_header_is_read_the_way_a_browser_writes_it() {
        assert_eq!(
            session_cookie(&with_cookie("tern_ui=abc")).as_deref(),
            Some("abc")
        );
        // Spaces after the separator, and a name that merely starts the same.
        assert_eq!(
            session_cookie(&with_cookie("a=1; tern_ui_other=no; tern_ui=yes")).as_deref(),
            Some("yes")
        );
        assert_eq!(session_cookie(&with_cookie("a=1; b=2")), None);
    }

    /// The reason a form needs something a browser dialog did not.
    #[test]
    fn guessing_shuts_the_door() {
        let mut attempts = Attempts {
            failures: 0,
            locked_until: None,
        };
        for _ in 0..MAX_FAILURES - 1 {
            attempts.fail();
            assert!(!attempts.locked(), "still open below the limit");
        }
        attempts.fail();
        assert!(attempts.locked(), "shut once the limit is reached");

        // And a correct password reopens it, so somebody who mistyped theirs
        // four times is not made to wait once they get it right.
        attempts.succeed();
        assert!(!attempts.locked());
    }
}
