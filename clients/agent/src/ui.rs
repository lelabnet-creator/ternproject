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
use tracing::{info, warn};

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

    /*
     * What only a relay has.
     *
     * Optional rather than folded into the fields above, because a relay does
     * not run probes and does not pass checks — mapping its zone onto `probes`
     * would make the page say a true number under a false label, which is worse
     * than saying nothing. `None` means "not a relay", and the page leaves the
     * rows out entirely rather than drawing a dash.
     */
    /// Machines this relay serves, as of its last inventory.
    pub zone_agents: Option<usize>,
    /// Where those machines connect, which is not where TERN is.
    pub zone_listen: Option<String>,
    /// Points carried upstream on their behalf since this process started.
    pub forwarded: Option<u64>,
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
    /**
     * The password, when there is one.
     *
     * Behind a lock because the console can mint a new one at any moment, and
     * this used to be a plain field read once at startup. So `ui-on` wrote a
     * fresh password into the config, the running process kept checking against
     * the one it had loaded, and every password the console handed out was
     * refused by the page it was minted for. The config said the page was on;
     * the process had never been told.
     */
    credential: Mutex<Option<Credential>>,
    /// Live session tokens. In memory only: a restart signs everyone out, and
    /// nothing about who was signed in survives on disk.
    sessions: Mutex<Vec<String>>,
    attempts: Mutex<Attempts>,
    /// The listener, when one is up. `None` is a page that is off — which is
    /// not the same as a page with no password, and the difference is why
    /// `ui-off` has to stop this rather than merely clear the credential.
    serving: Mutex<Option<Serving>>,
}

/// A listener that is up: where it is bound, and how to ask it to stop.
struct Serving {
    listen: String,
    stop: Arc<tokio::sync::Notify>,
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

    /// Whether this is the password. `pub` because the command that turns the
    /// page on hands one back, and the only honest check of that is that the
    /// stored hash accepts it.
    pub fn matches(&self, password: &str) -> bool {
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
            credential: Mutex::new(credential),
            sessions: Mutex::new(Vec::new()),
            attempts: Mutex::new(Attempts {
                failures: 0,
                locked_until: None,
            }),
            serving: Mutex::new(None),
        })
    }

    /// Whether this page is guarded at all.
    ///
    /// An agent nobody set a password on serves its page open, on loopback,
    /// which is what makes the feature findable. Setting a password turns the
    /// check on; `tern-agent ui --listen` warns when a wider binding has none.
    pub async fn guarded(&self) -> bool {
        self.credential.lock().await.is_some()
    }

    /// Where the page is bound right now, or `None` if it is off.
    pub async fn bound(&self) -> Option<String> {
        self.serving
            .lock()
            .await
            .as_ref()
            .map(|up| up.listen.clone())
    }

    /// Hands the runner a snapshot to mutate, stamping the uptime as it goes.
    pub async fn update(&self, edit: impl FnOnce(&mut Snapshot)) {
        let mut snapshot = self.snapshot.lock().await;
        edit(&mut snapshot);
        snapshot.uptime_s = self.started.elapsed().as_secs();
    }

    /// Forgets who is signed in, and reopens the door if guessing had shut it.
    ///
    /// Called whenever the password changes. A session opened with the old one
    /// has to end with it — otherwise "ask again for a new password" would
    /// rotate the credential and leave every door it had already opened ajar.
    /// The lockout goes with it because the operator standing at the console
    /// has just proved who they are; making them wait out somebody else's
    /// guesses would punish the wrong person.
    async fn forget_sessions(&self) {
        self.sessions.lock().await.clear();
        let mut attempts = self.attempts.lock().await;
        attempts.succeed();
    }
}

/**
 * Brings the live page into line with what the config now says.
 *
 * The one function that turns a page on, off, or moves it — used at startup and
 * by the console's `ui-on`, so the two cannot drift. They did: startup spawned
 * a listener from the config it had just read, and the console's instruction
 * only wrote the file. An agent whose page had never been on stayed off, an
 * agent whose page was on kept its old password, and both answered the console
 * with a password that opened nothing until somebody restarted the process.
 *
 * Binding happens before anything is let go, and the error comes back rather
 * than being logged: an address already in use should reach the person who
 * pressed the button, not a journal on a machine they are not standing at.
 */
pub async fn reconcile(
    state: &Arc<UiState>,
    settings: Option<&crate::config::UiSettings>,
) -> Result<(), String> {
    let mut serving = state.serving.lock().await;

    let Some(settings) = settings else {
        if let Some(previous) = serving.take() {
            previous.stop.notify_one();
            info!(address = %previous.listen, "the local page was turned off");
        }
        *state.credential.lock().await = None;
        state.forget_sessions().await;
        return Ok(());
    };

    // Already bound where it belongs: only the password changed, and rebinding
    // a working listener to swap it would drop whoever is reading the page.
    if serving
        .as_ref()
        .is_some_and(|up| up.listen == settings.listen)
    {
        *state.credential.lock().await = settings.credential.clone();
        state.forget_sessions().await;
        return Ok(());
    }

    /*
     * The new listener first, the old one after.
     *
     * A bind that fails must leave the page exactly as it was. Stopping first
     * would trade a page on the wrong port for no page at all, and the caller
     * would have written a new password into the config for a listener that
     * never came up.
     */
    let listener = tokio::net::TcpListener::bind(&settings.listen)
        .await
        .map_err(|error| format!("could not open the page on {}: {error}", settings.listen))?;

    if let Some(previous) = serving.take() {
        // `notify_one`, not `notify_waiters`: the task it is aimed at may not
        // have reached its `await` yet, and `notify_waiters` wakes only who is
        // already waiting — the signal would be dropped and the old listener
        // would stay up for the life of the process. `notify_one` keeps a
        // permit, so it lands whenever the task gets there.
        previous.stop.notify_one();
    }

    *state.credential.lock().await = settings.credential.clone();
    state.forget_sessions().await;

    let stop = Arc::new(tokio::sync::Notify::new());
    *serving = Some(Serving {
        listen: settings.listen.clone(),
        stop: stop.clone(),
    });

    let served = state.clone();
    let address = settings.listen.clone();
    tokio::spawn(async move {
        info!(%address, "serving the agent page");
        let served_on = address.clone();
        let shutdown = async move { stop.notified().await };
        if let Err(error) = axum::serve(listener, router(served))
            .with_graceful_shutdown(shutdown)
            .await
        {
            warn!(%error, address = %served_on, "the local page stopped");
        }
    });

    Ok(())
}

/// Turns the page on with a fresh password, and says so.
///
/// Shared by `tern-agent ui` and `tern-proxy ui` because it is one decision,
/// not two: the same address rule, the same generated password, the same
/// warning when the binding is wider than loopback. Two copies of this would
/// drift, and the half that drifts is the warning.
///
/// The caller owns loading and saving its own config — an agent's and a
/// relay's are different types — and this owns everything that is the same.
pub fn configure(
    existing: Option<&crate::config::UiSettings>,
    listen: Option<String>,
) -> (crate::config::UiSettings, String) {
    // Generated, never chosen. A password somebody types here is one they have
    // used elsewhere, and this one is written to a file on the machine it
    // guards.
    let password = crate::transport::random_token(12);
    let address = listen
        .or_else(|| existing.map(|u| u.listen.clone()))
        .unwrap_or_else(default_ui_listen);

    (
        crate::config::UiSettings {
            listen: address,
            credential: Some(Credential::create(&password)),
        },
        password,
    )
}

fn default_ui_listen() -> String {
    "127.0.0.1:38788".to_string()
}

/// Prints where the page is and the password, once.
pub fn announce(address: &str, password: &str) {
    let tty = std::io::IsTerminal::is_terminal(&std::io::stdout());
    let (green, red, reset) = if tty {
        ("\x1b[32m", "\x1b[31m", "\x1b[0m")
    } else {
        ("", "", "")
    };

    println!("The local page is on.");
    println!();
    println!("  Address   {green}http://{address}/{reset}");
    println!("  Password  {green}{password}{reset}");
    println!();
    println!("Shown once — it is stored salted and hashed, so it cannot be read");
    println!("back. Run this again to set a new one.");

    // Said only when it is true, and said in the colour of a warning: a page
    // bound off loopback names the server, the tenant and everything this
    // process is doing.
    if !address.starts_with("127.") && !address.starts_with("localhost") {
        println!();
        println!("{red}This is not loopback.{reset} Anyone who can reach {address} can");
        println!("read what this reports, and only this password is in the way.");
    }

    println!();
    println!("Restart it for this to take effect.");
}

/// What the page answers on.
fn router(state: Arc<UiState>) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/state.json", get(state_json))
        .route("/login", axum::routing::post(login))
        .route("/logout", axum::routing::post(logout))
        .with_state(state)
}

const COOKIE: &str = "tern_ui";

/// Whether this request carries a live session, or the page needs no one.
async fn authorised(state: &UiState, headers: &header::HeaderMap) -> bool {
    if state.credential.lock().await.is_none() {
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
    // Cloned out of the lock rather than held across the checks below, which
    // take two more locks: a credential is two short strings, and holding this
    // one while `attempts` is taken would be the shape a deadlock grows in.
    let Some(credential) = state.credential.lock().await.clone() else {
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
        guarded: state.guarded().await,
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

    fn settings(listen: &str, password: &str) -> crate::config::UiSettings {
        crate::config::UiSettings {
            listen: listen.to_string(),
            credential: Some(Credential::create(password)),
        }
    }

    /// The defect this whole mechanism exists for.
    ///
    /// The console mints a password and says the page is on. Before this, the
    /// running process learned neither fact — it had read its credential once at
    /// startup and never bound a listener it had not been started with — so the
    /// password was refused and the page was not there to refuse it.
    #[tokio::test]
    async fn a_page_that_was_off_comes_up_without_a_restart() {
        let state = UiState::new(None);
        assert_eq!(state.bound().await, None, "nothing is listening yet");

        reconcile(&state, Some(&settings("127.0.0.1:0", "minted")))
            .await
            .expect("it binds");

        assert_eq!(state.bound().await.as_deref(), Some("127.0.0.1:0"));
        assert!(
            state
                .credential
                .lock()
                .await
                .as_ref()
                .expect("guarded now")
                .matches("minted"),
            "and the password the console handed out is the one it checks",
        );
    }

    /// Asked twice, the second answer is the one that works.
    #[tokio::test]
    async fn a_fresh_password_replaces_the_one_the_process_started_with() {
        let state = UiState::new(Some(Credential::create("first")));
        reconcile(&state, Some(&settings("127.0.0.1:0", "second")))
            .await
            .expect("it binds");

        let credential = state.credential.lock().await;
        let credential = credential.as_ref().expect("still guarded");
        assert!(credential.matches("second"));
        assert!(!credential.matches("first"), "the old one is void");
    }

    /// Rotating the password closes what it had already opened.
    #[tokio::test]
    async fn a_new_password_ends_the_sessions_the_old_one_opened() {
        let state = UiState::new(Some(Credential::create("first")));
        state.sessions.lock().await.push("token-abc".to_string());

        reconcile(&state, Some(&settings("127.0.0.1:0", "second")))
            .await
            .expect("it binds");

        assert!(!authorised(&state, &with_cookie("tern_ui=token-abc")).await);
    }

    /// Off means off — not "open to anybody", which is what clearing the
    /// credential alone would have meant on a page bound past loopback.
    #[tokio::test]
    async fn turning_it_off_stops_the_listener_rather_than_unguarding_it() {
        let state = UiState::new(None);
        reconcile(&state, Some(&settings("127.0.0.1:0", "minted")))
            .await
            .expect("it binds");

        reconcile(&state, None).await.expect("it stops");

        assert_eq!(state.bound().await, None);
        assert!(!state.guarded().await);
    }

    /// A port somebody else holds is the caller's news, not the log's.
    #[tokio::test]
    async fn a_port_that_cannot_be_bound_is_reported_and_changes_nothing() {
        let held = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let taken = held.local_addr().unwrap().to_string();

        let state = UiState::new(Some(Credential::create("original")));
        let why = reconcile(&state, Some(&settings(&taken, "wasted")))
            .await
            .expect_err("the port is taken");

        assert!(why.contains(&taken), "it names the address: {why}");
        assert_eq!(state.bound().await, None, "nothing came up");
        assert!(
            state
                .credential
                .lock()
                .await
                .as_ref()
                .expect("untouched")
                .matches("original"),
            "and the password that already worked still does",
        );
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
