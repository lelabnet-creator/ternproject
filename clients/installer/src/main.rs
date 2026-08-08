//! TERN — setting up an instance.
//!
//!   tern-setup            (from a checkout, or on its own in an empty directory)
//!
//! Asks what it needs, writes `.env`, pulls or builds the image, starts the
//! stack and waits for it to answer. Repeatable: values already in `.env`
//! become the defaults, and pressing Enter keeps them.
//!
//! This file is the narrative — the same order of events as the shell installer
//! it replaces, read top to bottom. Everything it decides on its own lives in
//! the modules next door, where it can be tested.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use console::style;

use tern_setup::checklist::{gutter_line, tail, Checklist, Failure};
use tern_setup::envfile::{self, Settings};
use tern_setup::i18n::{self, fill, Catalog};
use tern_setup::journal::Journal;
use tern_setup::probe::{self, PackageManager};
use tern_setup::run;

/// The compose file is the only other file an install needs, and this binary
/// fetches it when it is missing. Cloning the repository is only worth it in
/// order to build from source.
const COMPOSE_FILE: &str = "docker-compose.prod.yml";
const ENV_FILE: &str = ".env";

/// Where the compose file is fetched from when this runs on its own, and the
/// image served when there are no sources to build. The branch is pinned: a
/// binary downloaded today has to install the same thing in six months.
const RAW_BASE: &str = "https://raw.githubusercontent.com/lelabnet-creator/ternproject/main";
const PUBLISHED_IMAGE: &str = "ghcr.io/lelabnet-creator/ternproject:latest";

const DOCKER_SOCKET: &str = "/var/run/docker.sock";

/// `timescaledb-ha` puts `PGDATA` in `/home/postgres/pgdata`, not in
/// `/var/lib/postgresql/data` — that one belongs to the plain `postgres` image.
/// An earlier version of the compose file mounted the volume on the
/// conventional path: the image never wrote there, so the cluster lived in the
/// container's writable layer and every `docker compose up -d` that recreated
/// it took the database with it.
const DB_CONTAINER: &str = "tern-prod-db-1";
const LEGACY_MOUNT: &str = "/var/lib/postgresql/data";

/// Two minutes. The first migration of an empty database is the long case, and
/// a slow disk makes it longer.
const API_ATTEMPTS: u32 = 60;
const API_INTERVAL: Duration = Duration::from_secs(2);

/// `/health` only answers once the migrations are through and the page has been
/// created, which is exactly the moment the install is over.
const HEALTH_PROBE: &str = "fetch('http://127.0.0.1:'+(process.env.API_PORT||3011)+'/health')\
    .then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";

/// A cluster genuinely on the volume has both a `PG_VERSION` inside `PGDATA`
/// and a mount point underneath it.
const VOLUME_PROBE: &str =
    r#"test -s "$PGDATA/PG_VERSION" && grep -q " /home/postgres/pgdata " /proc/mounts"#;

fn main() -> std::process::ExitCode {
    let catalog = i18n::detect_from_env().catalog();

    match install(catalog) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(stop) => {
            report(&stop, catalog);
            std::process::ExitCode::FAILURE
        }
    }
}

/// Everything this installer can refuse to do, and what to say about it.
///
/// One type rather than an exit at each site: the failures all end the same
/// way — a red line, what can be done about it, the tail of whatever the
/// command said, and the path to the journal — and writing that ending once is
/// what makes every path carry all four. Nothing here panics; a stop is a
/// value, and the process leaves with a code.
struct Stop {
    message: String,
    hints: Vec<String>,
    output: Vec<String>,
    journal: Option<PathBuf>,
}

impl Stop {
    fn new(message: impl Into<String>) -> Stop {
        Stop {
            message: message.into(),
            hints: Vec::new(),
            output: Vec::new(),
            journal: None,
        }
    }

    fn hint(mut self, line: impl Into<String>) -> Stop {
        self.hints.push(line.into());
        self
    }

    /// The last lines of a failed command. The rest stays in the journal.
    fn saying(mut self, output: &str) -> Stop {
        self.output = tail(output, 20);
        self
    }

    fn logged(mut self, journal: &Journal) -> Stop {
        if journal.is_open() {
            self.journal = Some(journal.path().to_path_buf());
        }
        self
    }
}

/// Prompts fail this way when they are cancelled — Esc, or Ctrl-C.
impl From<std::io::Error> for Stop {
    fn from(error: std::io::Error) -> Stop {
        Stop::new(error.to_string())
    }
}

fn report(stop: &Stop, catalog: &Catalog) {
    let _ = cliclack::log::error(&stop.message);
    for hint in &stop.hints {
        gutter_line(hint);
    }
    for line in &stop.output {
        gutter_line(line);
    }
    // The last thing on the screen is where to look next, which after a failure
    // is the journal and not the message that has just been read.
    let closing = match &stop.journal {
        Some(path) => fill(catalog.journal_hint_fail, &[&path.display().to_string()]),
        None => catalog.docker_docs.to_string(),
    };
    let _ = cliclack::outro_cancel(closing);
}

/// Is there somebody there?
///
/// The shell version tested `[ -t 0 ]` and nothing else. Both ends are tested
/// here because the prompts use both: the answers are read from standard input,
/// and everything drawn — the gutter, the checklist, the questions themselves —
/// goes to standard error. A run with one of the two redirected can neither ask
/// nor show.
fn attended() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// What every stage needs to know.
struct Ctx {
    c: &'static Catalog,
    journal: Journal,
    uid: u32,
    user: String,
}

impl Ctx {
    fn compose(&self, args: &[&str]) -> run::Outcome {
        run::run(&self.journal, run::compose(COMPOSE_FILE, args))
    }
}

fn install(c: &'static Catalog) -> Result<(), Stop> {
    cliclack::intro(style(format!(" {} ", c.title)).on_cyan().black())?;

    // Two provenances, so where the install happens is settled before anything
    // is written. See `probe::install_root`.
    let root = probe::install_root(COMPOSE_FILE);
    let _ = std::env::set_current_dir(&root);

    let journal = Journal::open(&root);
    journal.line(&format!("working directory: {}", root.display()));
    journal.line(&format!("kernel: {}", probe::kernel()));

    // The questions are read from a keyboard. If standard input is not a
    // terminal — `curl … | sh`, a cron job, a CI step — there is nobody to
    // answer, and asking anyway would produce an instance configured with empty
    // replies. Checked before Docker, because the absence of Docker leads to a
    // question too.
    if !attended() {
        journal.line("refused: standard input is not a terminal");
        return Err(Stop::new(c.no_tty).logged(&journal));
    }

    let ctx = Ctx {
        c,
        journal,
        uid: probe::uid(),
        user: probe::username(),
    };
    ctx.journal
        .line(&format!("running as {} (uid {})", ctx.user, ctx.uid));

    // --- Docker ------------------------------------------------------------
    if !probe::has_command("docker") {
        install_docker(&ctx)?;
    }

    // Socket access is checked whichever way Docker got here. This block used
    // to live inside the install, so it only ran when this installer had just
    // put Docker on the machine. On a machine where Docker was already there —
    // by far the common case — an account without access to the socket fell
    // twenty lines further down onto "the Docker daemon is not answering",
    // which is false: the daemon answers perfectly well, it is that account
    // that cannot talk to it. The remedy was known and not offered.
    ensure_docker_access(&ctx)?;

    if !run::succeeds(&ctx.journal, "docker", &["compose", "version"]) {
        return Err(Stop::new(c.compose_required).logged(&ctx.journal));
    }

    // Telling the two apart, because the remedy is not the same.
    // `ensure_docker_access` has already offered the group if that was it;
    // arriving here with a socket present means the offer was declined, and
    // saying so plainly beats a diagnosis that blames the daemon.
    if !run::succeeds(&ctx.journal, "docker", &["info"]) {
        return Err(if Path::new(DOCKER_SOCKET).exists() {
            Stop::new(c.daemon_no_access).logged(&ctx.journal)
        } else {
            Stop::new(c.daemon_down).logged(&ctx.journal)
        });
    }

    // The compose file is fetched as the first step of the list below, once the
    // person has answered. Its one prerequisite is checked now, though: finding
    // out that `curl` is missing after four questions would be an insult to the
    // four answers.
    if !Path::new(COMPOSE_FILE).is_file() && !probe::has_command("curl") {
        return Err(Stop::new(fill(c.curl_required, &[COMPOSE_FILE])).logged(&ctx.journal));
    }

    // --- the questions -----------------------------------------------------
    let previous = std::fs::read_to_string(ENV_FILE).ok();
    let answers = ask(&ctx, previous.as_deref())?;

    // --- the storage -------------------------------------------------------
    // Refused before anything is written, and before `.env` is rewritten: this
    // check needs nothing the answers provide, and an install we are about to
    // turn away should be left exactly as it was found.
    check_legacy_storage(&ctx)?;

    // --- the work ----------------------------------------------------------
    let settings = settings_from(&ctx, &answers, previous.as_deref())?;
    let fresh_secret = previous
        .as_deref()
        .and_then(|text| envfile::get(text, "APP_SECRET"))
        .filter(|secret| usable_secret(secret))
        .is_none();

    build_and_start(&ctx, &settings, previous.as_deref())?;

    // --- the panel ---------------------------------------------------------
    // The address in plain sight, and the warning with it. Until the
    // administrator account exists, that page creates it for whoever opens it.
    // It is a window, it closes on the first account created, and it is the one
    // thing on this screen that cannot wait until tomorrow — hence the box.
    if fresh_secret {
        cliclack::log::info(c.secret_new)?;
    }
    cliclack::log::success(c.volume_ok)?;

    let admin = format!("{}/app", answers.public_base_url.trim_end_matches('/'));
    let mut body = format!(
        "{}   {}\n\n{}\n\n",
        c.done_admin,
        style(&admin).cyan(),
        c.done_body
    );
    body.push_str(&fill(c.stop_label, &[COMPOSE_FILE]));
    body.push('\n');
    body.push_str(&fill(c.logs_label, &[COMPOSE_FILE]));
    if ctx.journal.is_open() {
        body.push('\n');
        body.push_str(&fill(
            c.journal_hint,
            &[&ctx.journal.path().display().to_string()],
        ));
    }

    cliclack::note(c.done_panel_title, body)?;
    cliclack::outro(fill(c.outro_ready, &[&admin]))?;
    ctx.journal.line("run finished: success");
    Ok(())
}

// --- Docker, when it is missing ----------------------------------------------
// Without Docker there is nothing to install. Rather than stopping at that
// observation and leaving the person to go looking, we offer to install it —
// on three conditions.
//
// We ask first. Putting system packages on a machine and enabling a service at
// boot is not a decision an installer takes on behalf of whoever ran it, even
// when it looks obvious.
//
// We go through the distribution's package manager, not through
// `curl … get.docker.com | sh`. This installer wants to be auditable before it
// is run; piping in a remote script, absent from this repository and changeable
// after the fact, would take all the meaning out of that. The price is a
// version sometimes older than Docker's own — acceptable here, Compose v2 being
// the only real prerequisite.
//
// We refuse rather than guess. Unrecognised distribution, package absent from
// the configured repositories, unusual init: we point at the official
// documentation. A Docker installation cobbled together is not paid for now but
// months later and elsewhere.
fn install_docker(ctx: &Ctx) -> Result<(), Stop> {
    let c = ctx.c;

    // macOS first: there is no system package manager to query, and the engine
    // arrives there with Docker Desktop, which is not a package.
    let kernel = probe::kernel();
    match kernel.as_str() {
        "Linux" => {}
        "Darwin" => {
            return Err(refusal(ctx, c.docker_required, c.docker_macos));
        }
        other => {
            return Err(refusal(
                ctx,
                c.docker_required,
                &fill(c.docker_os_unknown, &[other]),
            ));
        }
    }

    let manager = probe::detect_package_manager(probe::has_command)
        .ok_or_else(|| refusal(ctx, c.docker_required, c.docker_no_pkgmgr))?;

    // Administrator rights, and only when they are missing: on a fresh VM or in
    // a container one is often root already, and sudo is not always installed
    // there.
    if ctx.uid != 0 && !probe::has_command("sudo") {
        return Err(refusal(ctx, c.docker_required, c.docker_no_root));
    }

    ctx.journal
        .section(&format!("installing docker with {}", manager.name()));

    cliclack::log::warning(c.docker_missing)?;
    let mut heads_up = format!(
        "{}\n{}",
        fill(c.pkgmgr_detected, &[manager.name()]),
        c.pkg_from_distro
    );
    if ctx.uid != 0 {
        // Said before it happens: a password demanded without warning in the
        // middle of an install looks like an incident.
        heads_up.push('\n');
        heads_up.push_str(c.sudo_heads_up);
    }
    cliclack::log::info(heads_up)?;

    if !cliclack::confirm(c.docker_install_q)
        .initial_value(true)
        .interact()?
    {
        return Err(refusal(ctx, c.docker_declined, c.docker_docs));
    }

    run::prime_sudo(&ctx.journal, ctx.uid);

    // The list, settled before the first line of it runs. Refreshing the
    // package lists is an apt-only step: the others query their metadata live.
    let refresh = manager == PackageManager::Apt;
    let mut labels = Vec::new();
    if refresh {
        labels.push(c.step_apt_update.to_string());
    }
    // The exact package names are not knowable yet — on apt, nothing can be
    // queried before the lists have been refreshed. The two steps are announced
    // with a placeholder and renamed the moment the answer exists; the list
    // never gains or loses a line.
    labels.push(fill(c.step_install_engine, &["…"]));
    labels.push(fill(c.step_install_compose, &["…"]));
    labels.push(c.step_enable_service.to_string());

    let base = usize::from(refresh);
    let mut list = Checklist::new(labels);

    // The package lists first, on apt: without them there is nothing to query,
    // and the install would fail on a package this machine does in fact know.
    if refresh {
        list.run(0, || {
            let outcome = run::run(&ctx.journal, run::as_root(ctx.uid, "apt-get", &["update"]));
            match outcome.ok {
                true => Ok(None),
                false => Err(Failure::new(c.apt_update_failed, outcome.output())),
            }
        })
        .map_err(|failure| stop_from(failure, ctx))?;
    }

    // The engine, then the Compose plugin, under each distribution's names.
    // `docker-ce` only shows up when Docker's own repository has already been
    // added on this machine — in which case we may as well use it, being newer
    // than the distribution's.
    let (engine_names, compose_names, compose_hint) = match manager {
        PackageManager::Apt => (
            vec!["docker-ce", "docker.io"],
            vec!["docker-compose-plugin", "docker-compose-v2"],
            c.hint_compose_apt,
        ),
        PackageManager::Dnf | PackageManager::Yum => (
            vec!["docker-ce", "moby-engine"],
            vec!["docker-compose-plugin", "docker-compose"],
            c.hint_compose_dnf,
        ),
        PackageManager::Pacman => (
            vec!["docker"],
            vec!["docker-compose"],
            c.hint_compose_pacman,
        ),
    };

    let engine = probe::first_available(&ctx.journal, manager, &engine_names);
    let compose = probe::first_available(&ctx.journal, manager, &compose_names);

    // The typical case is RHEL, Rocky or Alma: their base repositories do not
    // publish Docker at all. Adding Docker's own in their place would be
    // exactly the kind of decision ruled out above.
    let Some(engine) = engine else {
        list.finish();
        return Err(Stop::new(c.docker_no_pkg)
            .hint(c.docker_no_pkg_2)
            .hint(c.docker_docs)
            .hint(c.then_rerun)
            .logged(&ctx.journal));
    };

    list.relabel(base, fill(c.step_install_engine, &[&engine]));
    if let Some(compose) = &compose {
        list.relabel(base + 1, fill(c.step_install_compose, &[compose]));
    }

    install_package(&list, ctx, base, manager, &engine)?;

    // Compose is a separate package everywhere, and it is the one people
    // forget. Absent from the repositories it is not fatal here: the check
    // below names what to install, which is more use than stopping now.
    match &compose {
        Some(compose) => install_package(&list, ctx, base + 1, manager, compose)?,
        None => list.skip(base + 1, compose_hint),
    }

    // The service, if there is a systemd to carry it.
    if probe::systemd_is_init() {
        list.run(base + 2, || {
            let outcome = run::run(
                &ctx.journal,
                run::as_root(ctx.uid, "systemctl", &["enable", "--now", "docker"]),
            );
            match outcome.ok {
                true => Ok(None),
                false => Err(Failure::new(c.service_failed, outcome.output())),
            }
        })
        .map_err(|failure| stop_from(failure, ctx).hint(c.service_hint))?;
    } else {
        list.skip(base + 2, c.no_systemd);
    }

    list.finish();

    // Compose v2 checked here, while we still know which distribution this is.
    // Further down, the generic check would fail without being able to name the
    // package to install, and that is precisely the only useful thing to know
    // at that point.
    if !run::succeeds(&ctx.journal, "docker", &["compose", "version"]) {
        return Err(Stop::new(c.compose_missing)
            .hint(fill(c.compose_expected, &[compose_hint]))
            .hint(c.docker_docs)
            .logged(&ctx.journal));
    }

    cliclack::log::success(c.docker_ready)?;
    Ok(())
}

/// The way out of every case where we do not install: one address, Docker's own,
/// rather than an approximate command to be copied out wrong.
fn refusal(ctx: &Ctx, message: &str, reason: &str) -> Stop {
    Stop::new(message)
        .hint(reason)
        .hint(ctx.c.docker_docs)
        .hint(ctx.c.then_rerun)
        .logged(&ctx.journal)
}

fn install_package(
    list: &Checklist,
    ctx: &Ctx,
    index: usize,
    manager: PackageManager,
    package: &str,
) -> Result<(), Stop> {
    let argv = manager.install_argv(&[package]);
    let (program, args) = argv
        .split_first()
        .expect("an install command names a program");
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    list.run(index, || {
        let outcome = run::run(&ctx.journal, run::as_root(ctx.uid, program, &args));
        match outcome.ok {
            true => Ok(None),
            false => Err(Failure::new(
                fill(ctx.c.pkg_failed, &[package]),
                outcome.output(),
            )),
        }
    })
    .map(|_| ())
    .map_err(|failure| stop_from(failure, ctx))
}

// --- access to the socket ----------------------------------------------------
/// The first wall after a successful install: the socket belongs to the
/// `docker` group, the current account is not in it, and `docker` answers
/// "permission denied".
///
/// The shell version stopped here, with the command to type and instructions to
/// log back in and start over. That was handing back half of the work that had
/// just been asked for in one command — and the more disorienting half, since
/// "open a new terminal" is not enough.
///
/// Belonging to the `docker` group amounts to being root on this machine: it is
/// asked for, not picked up along the way. But the person has just allowed
/// Docker to be installed, which has exactly the same reach, and sudo is
/// already granted. So we ask, and if the answer is yes we go all the way.
fn ensure_docker_access(ctx: &Ctx) -> Result<(), Stop> {
    let c = ctx.c;

    // The socket has to exist for the diagnosis to hold: without it, it really
    // is the daemon that is missing, and the check further down says so better.
    let needs_group = ctx.uid != 0
        && Path::new(DOCKER_SOCKET).exists()
        && !run::succeeds(&ctx.journal, "docker", &["info"]);
    if !needs_group {
        return Ok(());
    }

    ctx.journal.section("docker socket access");
    cliclack::log::warning(c.sock_title)?;
    cliclack::log::info(format!("{}\n{}", c.sock_1, c.sock_2))?;

    let agreed = cliclack::confirm(fill(c.sock_add_q, &[&ctx.user]))
        .initial_value(true)
        .interact()?;
    if !agreed {
        return Err(Stop::new(c.sock_no_access)
            .hint(fill(c.sock_manual, &[&ctx.user]))
            .logged(&ctx.journal));
    }

    run::prime_sudo(&ctx.journal, ctx.uid);

    let list = Checklist::new(vec![fill(c.step_join_group, &[&ctx.user])]);
    let joined = list.run(0, || {
        let outcome = run::run(
            &ctx.journal,
            run::as_root(ctx.uid, "usermod", &["-aG", "docker", &ctx.user]),
        );
        match outcome.ok {
            true => Ok(None),
            false => Err(Failure::new(
                fill(c.sock_usermod_failed, &[&ctx.user]),
                outcome.output(),
            )),
        }
    });
    list.finish();
    joined.map_err(|failure| stop_from(failure, ctx))?;

    cliclack::log::info(c.sock_added)?;

    // And we finish now, in this session.
    //
    // Group membership is only read at login: the current process does not have
    // it and never will. `sg` opens a group session for one command, which lets
    // us restart with the access rather than send somebody off to log out in
    // the middle of an install.
    //
    // `TERN_REEXEC` stops the loop: if access is still missing after this, the
    // problem is not the membership, and it needs saying rather than repeating
    // for ever.
    if std::env::var_os("TERN_REEXEC").is_none() && probe::has_command("sg") {
        if let Ok(exe) = std::env::current_exe() {
            cliclack::log::info(c.sock_reexec)?;
            let command = probe::shell_quote(&exe.display().to_string());
            ctx.journal
                .line(&format!("re-executing under: sg docker -c {command}"));

            use std::os::unix::process::CommandExt;
            // A real `exec`, as the shell had: this process becomes the new
            // one, so there is no parent left holding a terminal it no longer
            // drives. It only returns if the exec itself failed.
            let error = Command::new("sg")
                .args(["docker", "-c", &command])
                .env("TERN_REEXEC", "1")
                .exec();
            ctx.journal.line(&format!("re-exec failed: {error}"));
        }
    }

    Err(Stop::new(c.sock_just_added)
        .hint(c.sock_relogin)
        .logged(&ctx.journal))
}

// --- the questions -----------------------------------------------------------
struct Answers {
    http_port: String,
    public_base_url: String,
    trusted_proxies: String,
    agent_network_mode: String,
    local_agent_server: String,
}

fn ask(ctx: &Ctx, previous: Option<&str>) -> Result<Answers, Stop> {
    let c = ctx.c;
    let existing = |key: &str| previous.and_then(|text| envfile::get(text, key));

    cliclack::log::step(c.head_access)?;

    let http_port: String = cliclack::input(c.q_port)
        .default_input(&existing("TERN_HTTP_PORT").unwrap_or_else(|| "8080".into()))
        .validate(|value: &String| match value.trim().parse::<u16>() {
            Ok(port) if port > 0 => Ok(()),
            _ => Err(c.bad_port),
        })
        .interact()?;
    let http_port = http_port.trim().to_string();
    ctx.journal.answer("TERN_HTTP_PORT", &http_port);

    let default_url = existing("PUBLIC_BASE_URL")
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| {
            let address = probe::primary_address(&ctx.journal);
            probe::default_public_url(address.as_deref(), &http_port)
        });

    let public_base_url: String = cliclack::input(c.q_public_url)
        .default_input(&default_url)
        .interact()?;
    let public_base_url = public_base_url.trim().to_string();
    ctx.journal.answer("PUBLIC_BASE_URL", &public_base_url);

    // Said now rather than discovered at the first agent that refuses to pair,
    // or at the first email whose link leads nowhere.
    if probe::is_loopback_url(&public_base_url) {
        cliclack::log::warning(c.localhost_warn)?;
    } else {
        cliclack::log::info(c.proxy_hint)?;
    }

    let trusted_proxies: String = cliclack::input(c.q_trusted_proxies)
        .default_input(&existing("TRUSTED_PROXIES").unwrap_or_default())
        .required(false)
        .interact()?;
    let trusted_proxies = trusted_proxies.trim().to_string();
    ctx.journal.answer("TRUSTED_PROXIES", &trusted_proxies);

    // --- what the agent can measure ---
    // This instance's agent shares the API container's network stack by
    // default. Its way out to the internet is complete, but `127.0.0.1` there
    // means the container and not this machine: a service listening only on the
    // host's loopback then has no address the agent can name. And "localhost"
    // is exactly what one writes when meaning to watch one's own machine, so
    // the check fails without the address looking wrong.
    //
    // Hence the question, put in terms of what is to be watched. The default
    // stays the current behaviour: a wider network setting is asked for, it is
    // not inherited.
    cliclack::log::step(c.head_agent)?;
    cliclack::log::info(c.agent_intro)?;

    let from_host = cliclack::confirm(c.agent_q)
        .initial_value(existing("TERN_AGENT_NETWORK_MODE").as_deref() == Some("host"))
        .interact()?;

    let (agent_network_mode, local_agent_server) = if from_host {
        // The second value is what makes the switch work at all: in the
        // machine's stack the API is no longer at 127.0.0.1:3011 but on the
        // published port. The agent's own guard rail — no key over plain HTTP
        // anywhere but to localhost — is still satisfied, the address being a
        // loopback one.
        cliclack::log::info(c.agent_host)?;
        let kernel = probe::kernel();
        if kernel != "Linux" {
            cliclack::log::warning(fill(c.agent_host_warn, &[&kernel]))?;
        }
        ("host".to_string(), format!("http://127.0.0.1:{http_port}"))
    } else {
        cliclack::log::info(c.agent_container)?;
        ("service:app".to_string(), String::new())
    };
    ctx.journal
        .answer("TERN_AGENT_NETWORK_MODE", &agent_network_mode);

    Ok(Answers {
        http_port,
        public_base_url,
        trusted_proxies,
        agent_network_mode,
        local_agent_server,
    })
}

/// An `APP_SECRET` worth keeping, as opposed to an empty one or the placeholder
/// the documentation used to ship.
fn usable_secret(secret: &str) -> bool {
    !secret.is_empty() && secret != "change-me-openssl-rand-hex-32"
}

/// The values that are generated rather than asked for, and the image choice.
fn settings_from(ctx: &Ctx, answers: &Answers, previous: Option<&str>) -> Result<Settings, Stop> {
    let existing = |key: &str| previous.and_then(|text| envfile::get(text, key));

    // `APP_SECRET` is generated once and once only. Regenerating it would make
    // the TOTP secrets, the probes' authentication headers and the already
    // encrypted subscriber addresses unreadable.
    let app_secret = existing("APP_SECRET")
        .filter(|secret| usable_secret(secret))
        .map_or_else(probe::random_hex, Ok)
        .map_err(|error| Stop::new(error.to_string()).logged(&ctx.journal))?;

    let postgres_password = existing("POSTGRES_PASSWORD")
        .filter(|password| !password.is_empty())
        .map_or_else(probe::random_hex, Ok)
        .map_err(|error| Stop::new(error.to_string()).logged(&ctx.journal))?;

    // Two paths: pull a published image, or build from this repository. The
    // first is what an install does; the second is a developer's, or a modified
    // version's. With no Dockerfile at hand there is nothing to build — this is
    // running on its own, outside a checkout — and choosing the published image
    // here avoids sending Docker off to fail on an empty build context three
    // screens further down.
    let image = match std::env::var("TERN_IMAGE") {
        Ok(image) if !image.is_empty() => Some(image),
        _ if !Path::new("Dockerfile").is_file() => Some(PUBLISHED_IMAGE.to_string()),
        _ => None,
    };

    Ok(Settings {
        postgres_password,
        app_secret,
        http_port: answers.http_port.clone(),
        public_base_url: answers.public_base_url.clone(),
        trusted_proxies: answers.trusted_proxies.clone(),
        agent_network_mode: answers.agent_network_mode.clone(),
        local_agent_server: answers.local_agent_server.clone(),
        image,
    })
}

/// Refuses to start when an existing install still keeps its database in the
/// container's writable layer.
///
/// Remounting the volume would hand it an empty database without saying
/// anything, so this stops the run instead. The way out is a dump taken while
/// the old container is still the one holding the data.
fn check_legacy_storage(ctx: &Ctx) -> Result<(), Stop> {
    let c = ctx.c;
    if !run::succeeds(
        &ctx.journal,
        "docker",
        &["container", "inspect", DB_CONTAINER],
    ) {
        return Ok(());
    }

    let mut inspect = Command::new("docker");
    inspect.args([
        "container",
        "inspect",
        "-f",
        "{{range .Mounts}}{{println .Destination}}{{end}}",
        DB_CONTAINER,
    ]);
    let outcome = run::run(&ctx.journal, inspect);

    // Whole-line equality rather than a substring test: a mount at
    // `/var/lib/postgresql/data-backup` is not this bug, and refusing to
    // install over one would be a refusal nobody could argue with.
    if !outcome
        .stdout
        .lines()
        .any(|line| line.trim() == LEGACY_MOUNT)
    {
        return Ok(());
    }

    Err(Stop::new(c.legacy_1)
        .hint(fill(c.legacy_2, &[LEGACY_MOUNT]))
        .hint(c.legacy_3)
        .hint("")
        .hint(c.legacy_4)
        .hint(format!(
            "  docker exec {DB_CONTAINER} pg_dump -U tern -Fc tern > {}",
            c.dump_file
        ))
        .hint(format!("  docker compose -f {COMPOSE_FILE} down"))
        .hint("  tern-setup")
        .hint("")
        .hint(c.legacy_5)
        .logged(&ctx.journal))
}

// --- the work ----------------------------------------------------------------
fn build_and_start(ctx: &Ctx, settings: &Settings, previous: Option<&str>) -> Result<(), Stop> {
    let c = ctx.c;
    ctx.journal.section("installing");

    let building = settings.image.is_none();
    match &settings.image {
        Some(image) if std::env::var_os("TERN_IMAGE").is_none() => {
            cliclack::log::info(fill(c.no_sources, &[image]))?;
        }
        Some(_) => {}
        None => cliclack::log::info(c.build_hint)?,
    }

    cliclack::log::step(c.head_install)?;

    let list = Checklist::new(vec![
        c.step_fetch_compose.to_string(),
        c.step_write_config.to_string(),
        if building {
            c.step_build.to_string()
        } else {
            c.step_pull.to_string()
        },
        c.step_start.to_string(),
        c.step_wait_api.to_string(),
        c.step_check_volume.to_string(),
    ]);

    // 1. The compose file, when it is not here. It is the only file this binary
    //    does not carry, and fetching it saves cloning 40 MB of sources for an
    //    install that would read exactly one of them.
    if Path::new(COMPOSE_FILE).is_file() {
        list.skip(0, c.note_already);
    } else {
        let url = format!("{RAW_BASE}/{COMPOSE_FILE}");
        list.run(0, || {
            let mut curl = Command::new("curl");
            curl.args(["-fsSL", "-o", COMPOSE_FILE, &url]);
            let outcome = run::run(&ctx.journal, curl);
            match outcome.ok {
                true => Ok(None),
                false => Err(Failure::new(
                    fill(c.download_failed, &[&url]),
                    outcome.output(),
                )),
            }
        })
        .map_err(|failure| stop_from(failure, ctx))?;
    }

    // 2. The configuration, with the previous file kept beside it.
    list.run(1, || {
        if Path::new(ENV_FILE).exists() {
            std::fs::copy(ENV_FILE, format!("{ENV_FILE}.bak"))
                .map_err(|error| Failure::bare(error.to_string()))?;
        }
        let contents = envfile::render(settings, previous, c);
        envfile::write_private(Path::new(ENV_FILE), &contents)
            .map_err(|error| Failure::bare(error.to_string()))?;
        ctx.journal.line(&format!("wrote {ENV_FILE} (mode 600)"));
        Ok(Some(fill(c.env_written, &[ENV_FILE])))
    })
    .map_err(|failure| stop_from(failure, ctx))?;

    // 3. The image. Pulling every service rather than just `app`: the database
    //    image has to come down too, and doing it here means the minutes it
    //    takes are spent under a step that says "pulling" instead of under the
    //    one that says "starting".
    list.run(2, || {
        let outcome = ctx.compose(if building { &["build"] } else { &["pull"] });
        match outcome.ok {
            true => Ok(None),
            false => {
                let message = match &settings.image {
                    Some(image) => fill(c.image_not_found, &[image]),
                    None => c.build_failed.to_string(),
                };
                Err(Failure::new(message, outcome.output()))
            }
        }
    })
    .map_err(|failure| stop_from(failure, ctx))?;

    // 4. Up, without `--wait`. See the next step for why.
    list.run(3, || {
        let outcome = ctx.compose(&["up", "-d"]);
        match outcome.ok {
            true => Ok(None),
            false => Err(Failure::new(c.start_failed, outcome.output())),
        }
    })
    .map_err(|failure| stop_from(failure, ctx).hint(fill(c.logs_hint, &[COMPOSE_FILE])))?;

    // 5. And then we wait for the API ourselves.
    //
    //    `--wait` did this, and did it better: it returned on the healthcheck,
    //    so after the migrations and the creation of the page. It was dropped
    //    because it makes the install depend on the version of Compose.
    //
    //    The `agent` service deliberately has no healthcheck — its own would
    //    curl the API and report the API's health as its own, which is worse
    //    than no check at all. Docker Compose 29 refuses to wait on a container
    //    in that state: "container tern-prod-agent-1 has no healthcheck
    //    configured", non-zero exit, and the installer announced "startup
    //    failed" on a perfectly successful install. Compose 5.4 did not blink,
    //    which is the worst form of the fault: invisible to whoever writes it,
    //    systematic for whoever installs it. It was found in real acceptance
    //    testing, not here.
    //
    //    Waiting on the API directly says the same thing while assuming nothing
    //    about Compose. It is also the one stretch that can stay silent for two
    //    minutes, which is why it is a step of its own and not a pause inside
    //    another.
    list.run(4, || {
        for attempt in 1..=API_ATTEMPTS {
            if ctx
                .compose(&["exec", "-T", "app", "node", "-e", HEALTH_PROBE])
                .ok
            {
                ctx.journal
                    .line(&format!("the API answered on attempt {attempt}"));
                return Ok(None);
            }
            std::thread::sleep(API_INTERVAL);
        }
        Err(Failure::bare(c.api_timeout))
    })
    .map_err(|failure| {
        stop_from(failure, ctx)
            .hint(c.api_migrating)
            .hint(fill(c.logs_hint, &[COMPOSE_FILE]))
    })?;

    // 6. The mount is right in the file, but it is the running container that
    //    counts. Checked rather than assumed: a database that is not on a
    //    volume survives everything until the day it does not, and that day is
    //    a routine `docker compose up -d`.
    list.run(5, || {
        let outcome = ctx.compose(&["exec", "-T", "db", "sh", "-lc", VOLUME_PROBE]);
        match outcome.ok {
            true => Ok(None),
            false => Err(Failure::new(
                fill(c.no_volume, &[COMPOSE_FILE]),
                outcome.output(),
            )),
        }
    })
    .map_err(|failure| stop_from(failure, ctx))?;

    list.finish();
    Ok(())
}

fn stop_from(failure: Failure, ctx: &Ctx) -> Stop {
    Stop::new(failure.message)
        .saying(&failure.output)
        .logged(&ctx.journal)
}
