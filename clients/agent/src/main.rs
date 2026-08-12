//! `tern-agent` — pair, probe, push.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tern_agent::config::{default_path, Config};
use tern_agent::probe::{evaluate, Assertion, Observation};
use tern_agent::transport::{Client, PairRequest};

#[derive(Parser)]
#[command(name = "tern-agent", version, about = "TERN status agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// error, warn, info, debug, trace. Overrides RUST_LOG.
    #[arg(long, global = true, env = "TERN_LOG")]
    log_level: Option<String>,

    /// One JSON object per line, for a log collector rather than a person.
    #[arg(long, global = true, env = "TERN_LOG_JSON")]
    log_json: bool,

    /// Append logs here as well as to stderr.
    #[arg(long, global = true, env = "TERN_LOG_FILE")]
    log_file: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Exchange a pairing PIN for an ingest key, and write the config file.
    Pair {
        #[arg(long, env = "TERN_SERVER")]
        server: String,
        #[arg(long)]
        pin: String,
        /// Where to write the config. Created with owner-only permissions.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Print the key instead of writing it anywhere.
        #[arg(long)]
        print_only: bool,
        /*
         * Replace the file rather than update it.
         *
         * Pairing normally keeps what it finds and writes only the key, because
         * probes written on the host belong to whoever wrote them. That is the
         * right default and the wrong one for the case it cannot tell apart: a
         * config left behind by a previous tenant, a different server, or an
         * experiment nobody wants back. `--force` is how somebody says which of
         * the two this is.
         *
         * A flag and not a prompt: this runs inside `install.sh`, piped into
         * `sh`, with no terminal to answer from.
         */
        /// Overwrite the existing config instead of keeping its probes.
        #[arg(long)]
        force: bool,
    },

    /// Run the configured probes on a schedule, pushing each result.
    Run {
        /// Path to the config file. Defaults to the standard location for this
        /// user; `tern-agent status` prints the one in use.
        #[arg(long)]
        config: Option<PathBuf>,
        /*
         * `tern-agent run ~/.config/tern/agent.toml` is what a person writes,
         * and clap answered it with "unexpected argument found" — naming what
         * is wrong rather than what would be right, on the one command somebody
         * runs while something is already broken. A path after `run` can only
         * mean one thing, so it means it.
         *
         * Not a second concept: it resolves into `config` immediately and
         * nothing downstream knows which way it arrived. The doc line below is
         * deliberately short — the reasoning belongs here, not in `--help`.
         */
        /// The same path as `--config`, typed without the flag.
        #[arg(value_name = "CONFIG")]
        config_positional: Option<PathBuf>,
        /// Where unsent points are kept while the server is unreachable.
        #[arg(long)]
        queue: Option<PathBuf>,
        /// Run every probe once and exit. Useful in cron, and for checking a
        /// config before installing it as a service.
        #[arg(long)]
        once: bool,
        /// Do not ask the server for the assignment; run the file as written.
        #[arg(long)]
        no_refresh: bool,
        /// Wait for the config file to appear instead of failing when it is
        /// absent.
        ///
        /// For an agent the server starts alongside itself: the process is up
        /// before the instance has a page, and so before anything has written
        /// its config. Deliberately not the default — for an agent somebody
        /// installed on a host, a missing config is a typo in the path, and
        /// waiting silently for a file that will never appear is the least
        /// helpful thing it could do.
        #[arg(long)]
        wait_for_config: bool,
    },
    /// Check everything that stops an agent reporting: config, server, key,
    /// DNS, clock, ICMP permission, and the offline queue.
    Doctor {
        /// Path to the config file. Defaults to the standard location for this
        /// user; `tern-agent status` prints the one in use.
        #[arg(long)]
        config: Option<PathBuf>,
        /// The same path as `--config`, typed without the flag.
        #[arg(value_name = "CONFIG")]
        config_positional: Option<PathBuf>,
        /// Where unsent points are kept while the far end is unreachable.
        /// Defaults to the config path with a `.queue.json` extension.
        #[arg(long)]
        queue: Option<PathBuf>,
    },

    /// What this agent is: its probes, and what is waiting to be sent.
    Status {
        /// Path to the config file. Defaults to the standard location for this
        /// user; `tern-agent status` prints the one in use.
        #[arg(long)]
        config: Option<PathBuf>,
        /// The same path as `--config`, typed without the flag.
        #[arg(value_name = "CONFIG")]
        config_positional: Option<PathBuf>,
        /// Where unsent points are kept while the far end is unreachable.
        /// Defaults to the config path with a `.queue.json` extension.
        #[arg(long)]
        queue: Option<PathBuf>,
    },

    /// Turn the local page on, and set or reset the password that guards it.
    ///
    /// Prints the password once. It is stored salted and hashed, so it cannot
    /// be read back — losing it means running this again, which is the point:
    /// a page whose password can be recovered from the machine it runs on is
    /// guarding nothing from anybody who already has the machine.
    Ui {
        /// Path to the config file. Defaults to the standard location for this
        /// user; `tern-agent status` prints the one in use.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Where to serve. Loopback unless you mean otherwise — see the note
        /// this prints when you do.
        #[arg(long)]
        listen: Option<String>,
        /// Turn the page off again and forget the password.
        #[arg(long)]
        off: bool,
    },

    /// Undo a pause or a stop asked for from the console.
    ///
    /// The way back from `stop`, and the only one: a stopped agent talks to
    /// nothing, so nothing from the console can reach it. That is what the
    /// console said before asking, and this is the shell command it named.
    Resume {
        /// Path to the config file. Defaults to the standard location for this
        /// user; `tern-agent status` prints the one in use.
        #[arg(long)]
        config: Option<PathBuf>,
    },

    /// Discard the buffered points. They are lost, not sent.
    QueueClear {
        /// Where unsent points are kept while the far end is unreachable.
        /// Defaults to the config path with a `.queue.json` extension.
        #[arg(long)]
        queue: Option<PathBuf>,
    },

    /// Evaluate a probe file against a recorded observation, printing the verdict.
    Test {
        /// JSON file holding `{ "assertions": [...], "observation": {...} }`.
        #[arg(long)]
        probe: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli)?;

    match cli.command {
        Command::Pair {
            server,
            pin,
            config,
            print_only,
            force,
        } => {
            // Resolved before pairing, not after: the file already there is what
            // says whether this is a new install or the same one again, and the
            // server needs that answer in the request rather than after it.
            let path = config.unwrap_or_else(default_path);
            let install_id = tern_agent::config::install_id_at(&path);

            let client = Client::new(&server)?;
            let response = client
                .pair(&PairRequest {
                    code: pin,
                    hostname: hostname(),
                    os: Some(std::env::consts::OS.to_string()),
                    arch: Some(std::env::consts::ARCH.to_string()),
                    agent_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                    install_id: Some(install_id.clone()),
                })
                .await?;

            println!(
                "✓ Paired as \"{}\" on tenant {}",
                response.agent_name, response.tenant_slug
            );
            println!();

            if print_only {
                println!("Store this key — it is shown once:");
                println!("  export TERN_API_KEY={}", response.api_key);
                return Ok(());
            }

            // Written, not printed. The key is shown once by design, and asking
            // someone to copy it out of a terminal is how it ends up in a shell
            // history file. (`path` was resolved above, before pairing.)

            /*
             * An existing config keeps its probes and takes the new key.
             *
             * This used to refuse the file outright and print the key for
             * somebody to place by hand — protecting probes written on the
             * host, which is a real thing to protect. But the effect was that
             * pairing *succeeded*, burned a single-use PIN, minted a key, and
             * then threw it away: the agent went on presenting the previous
             * key, which the far end had already replaced, and every call came
             * back 401. On a zone agent that reads as "the relay is refusing
             * me", which sends the reader to the relay, where nothing is wrong.
             *
             * Measured on a real machine: `agent.toml already exists — not
             * overwriting it`, then `heartbeat refused (401 Unauthorized)`
             * forever, with nothing connecting the two lines.
             *
             * So the credential is written and everything else is left alone.
             * That is the narrowest change that keeps the original concern: a
             * key is what pairing produces and is worthless to anyone anywhere
             * else, while probes are the operator's and are not ours to
             * discard.
             */
            if path.exists() && !force {
                match Config::load(&path) {
                    Ok(mut existing) => {
                        existing.api_key = response.api_key;
                        existing.server = server.trim_end_matches('/').to_string();

                        let kept = existing.probes.len();
                        let skipped = existing.apply_jobs(&response.jobs);
                        existing.save(&path)?;

                        println!("Updated {} with the new key.", path.display());
                        if kept > 0 {
                            println!("  {kept} probe(s) already in the file were kept.");
                        }
                        for gap in skipped {
                            println!("  ! {gap}");
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        /*
                         * Unreadable is the one case where the old behaviour is
                         * still right: rewriting a file this cannot parse would
                         * destroy whatever is in it, and it may be a typo away
                         * from working.
                         */
                        println!("{} exists but could not be read: {error}", path.display());
                        println!("Leaving it alone. Store this key — it is shown once:");
                        println!("  export TERN_API_KEY={}", response.api_key);
                        return Ok(());
                    }
                }
            }

            // Said, because it is destructive and silence would be the worst
            // way to find out. Named rather than counted: "3 probes removed"
            // does not tell somebody whether the one they wrote is among them.
            if force && path.exists() {
                if let Ok(previous) = Config::load(&path) {
                    println!("Replacing {} (--force).", path.display());
                    for entry in &previous.probes {
                        println!("  - dropping probe {}", entry.control_key);
                    }
                } else {
                    println!("Replacing {} (--force).", path.display());
                }
            }

            let mut config = Config {
                server: server.trim_end_matches('/').to_string(),
                api_key: response.api_key,
                install_id: Some(install_id),
                state: Default::default(),
                interval_s: 60,
                probes: Vec::new(),
                // Off until asked for: see `UiSettings`. Pairing is not the
                // moment to decide somebody wants a port open.
                ui: None,
            };

            // The server already knows what this agent is for. Handing the
            // probes over here is the difference between a paired agent and a
            // configured one.
            let skipped = config.apply_jobs(&response.jobs);
            config.save(&path)?;

            println!("Wrote {} (readable only by you).", path.display());
            if config.probes.is_empty() {
                println!("The server assigned no probes — add a [[probes]] section yourself.");
            } else {
                println!("{} probe(s) assigned by the server:", config.probes.len());
                for entry in &config.probes {
                    println!("  {}  ({})", entry.control_key, entry.probe.kind());
                }
            }
            for skip in &skipped {
                println!("  ! skipped {skip}");
            }
            for gap in Config::measurement_gaps(&response.jobs) {
                // Naming it now beats discovering it as an empty chart later.
                println!(
                    "  ! {gap} is drawn as a measurement but its probe captures no value — add a json_path assertion with capture = true"
                );
            }

            /*
             * Its own path, not its own name.
             *
             * The installer puts this binary in `~/.local/bin`, which is on
             * nobody's PATH by default on a server — it says so, two lines
             * above. Printing a bare `tern-agent run` right underneath that
             * warning is how somebody ends up at `command not found` with
             * nothing to connect it to, and it happened.
             *
             * `current_exe` and not the argv name: a relative invocation would
             * otherwise be echoed back as a relative path, which stops working
             * the moment the reader is in a different directory — which they
             * will be, since this line is meant to be run later.
             */
            let me = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "tern-agent".to_string());
            println!("Then: {me} run --config {}", path.display());
            Ok(())
        }

        Command::Run {
            config,
            config_positional,
            queue,
            once,
            no_refresh,
            wait_for_config,
        } => {
            let path = config.or(config_positional).unwrap_or_else(default_path);

            if wait_for_config && !path.exists() {
                println!("Waiting for {} to appear…", path.display());
                // Polled rather than watched: this waits minutes at most, on a
                // file written once, and an inotify dependency to save a few
                // seconds of latency is not a trade worth making.
                while !path.exists() {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                println!("{} appeared — starting", path.display());
            }

            let mut config = Config::load(&path)?;

            // An agent paired last month otherwise runs last month's probes.
            // Asking at startup is the cheapest moment: it costs one request,
            // and a control added in the admin starts being measured on the
            // next restart rather than after someone edits a file on the host.
            /*
             * A stopped agent asks for nothing, including at startup.
             *
             * Without this it is not stopped at all: the loop below stays
             * silent, but the startup poll runs first and would take a resume
             * off the queue on the way up — so restarting a stopped agent
             * undid the stop, which is precisely what the console promised
             * could not happen from there. Measured by asking a stopped agent
             * to resume and watching it obey.
             *
             * The way back is the one the console named: `tern-agent resume`,
             * on the machine, and then a restart.
             */
            if !config.state.reports() {
                println!("This agent was stopped from the console. It reports nothing.");
                println!(
                    "Undo it here with: tern-agent resume --config {}",
                    path.display()
                );
            } else if !no_refresh {
                let client = Client::new(&config.server)?;
                match client.jobs(&config.api_key).await {
                    Ok(response) => {
                        /*
                         * Instructions carried out here too, and this is not a
                         * nicety.
                         *
                         * The server marks one as handed over the moment it
                         * hands it over — it has no way to tell this poll from
                         * the loop's — so a startup that read the field and
                         * dropped it would swallow the instruction for good.
                         * And that is the likely path: somebody restarts the
                         * agent precisely to make it pick the thing up sooner,
                         * and the restart is what would eat it. Found by asking
                         * a real agent to turn its page on and watching the
                         * answer never come.
                         */
                        if !response.commands.is_empty() {
                            let key = config.api_key.clone();
                            let restart = tern_agent::commands::apply(
                                &client,
                                &key,
                                &response.commands,
                                &mut config,
                                &path,
                            )
                            .await;
                            if restart {
                                tern_agent::commands::leave_for_restart();
                            }
                        }

                        let added = config.new_control_keys(&response.jobs);
                        let skipped = config.apply_jobs(&response.jobs);

                        if !added.is_empty() {
                            println!("New from the server: {}", added.join(", "));
                        }
                        for skip in &skipped {
                            println!("! skipped {skip}");
                        }
                        // Written back so the file keeps showing what runs; the
                        // operator's own probes were preserved by apply_jobs.
                        config.save(&path)?;
                    }
                    Err(error) => {
                        // Not fatal. An agent that refuses to start because the
                        // server is unreachable is exactly backwards: that is
                        // when its measurements matter most.
                        eprintln!(
                            "Could not refresh the assignment ({error}) — using {} as it stands",
                            path.display()
                        );
                    }
                }
            }

            let queue_path = queue.unwrap_or_else(|| path.with_extension("queue.json"));

            if once {
                /*
                 * `--once` honours the state like the loop does.
                 *
                 * It ran regardless: a stopped agent invoked from cron measured
                 * and pushed anyway, which contradicted the one promise `stop`
                 * makes — a stopped agent talks to nothing. Same words as the
                 * loop's refusal, same way back.
                 */
                if !config.state.reports() {
                    println!("This agent was stopped from the console. It reports nothing.");
                    println!(
                        "Undo it here with: tern-agent resume --config {}",
                        path.display()
                    );
                    return Ok(());
                }

                let client = Client::new(&config.server)?;
                // Paused: reporting is allowed — that is what lets a queued
                // backlog drain — but nothing new is measured.
                let mut points = Vec::with_capacity(config.probes.len());
                if config.state.measures() {
                    for entry in &config.probes {
                        let point = tern_agent::runner::run_once(entry).await;
                        println!(
                            "{:<24} {:?}{}",
                            point.control_key,
                            point.status,
                            point
                                .latency_ms
                                .map(|ms| format!("  {ms} ms"))
                                .unwrap_or_default()
                        );
                        points.push(point);
                    }
                } else {
                    println!("Paused from the console — measuring nothing, sending what waits.");
                }

                /*
                 * Through the queue, not past it.
                 *
                 * This is the cron path, and it used to push directly: one
                 * failed request and the measurements were gone — the very
                 * loss the queue exists to prevent, on the schedule least
                 * likely to retry soon. Now a failure leaves the points on
                 * disk, dated at measurement, and the next run drains them.
                 */
                let mut queue = tern_agent::runner::Queue::open(&queue_path);
                queue.push_points(&points);
                match tern_agent::runner::drain(&client, &config.api_key, &mut queue).await {
                    Ok(accepted) => println!("pushed {accepted} point(s)"),
                    Err(error) => {
                        eprintln!("could not push ({error}) — {} point(s) kept for the next run", queue.len());
                    }
                }
                return Ok(());
            }

            // The runner keeps asking after this first fetch, so a control
            // added in the admin starts being measured without a restart.
            tern_agent::runner::run(config, path, queue_path, !no_refresh).await
        }

        Command::Doctor {
            config,
            config_positional,
            queue,
        } => {
            let config = config.or(config_positional);
            let config_path = config.unwrap_or_else(default_path);
            let queue_path = queue.unwrap_or_else(|| config_path.with_extension("queue.json"));

            let report = tern_agent::doctor::run(&config_path, &queue_path).await;
            report.print();

            // Non-zero when something is actually broken, so this drops into a
            // monitoring check or a post-install step unchanged.
            if report.has_failure() {
                std::process::exit(1)
            }
            Ok(())
        }

        Command::Status {
            config,
            config_positional,
            queue,
        } => {
            let config = config.or(config_positional);
            let config_path = config.unwrap_or_else(default_path);
            let queue_path = queue.unwrap_or_else(|| config_path.with_extension("queue.json"));
            let config = Config::load(&config_path)?;
            let pending = tern_agent::runner::Queue::open(&queue_path);

            println!("server      {}", config.server);
            println!("config      {}", config_path.display());
            println!("interval    {}s", config.interval_s);
            println!("queued      {} point(s)", pending.len());
            println!("probes      {}", config.probes.len());
            for entry in &config.probes {
                println!(
                    "  {:<24} {:<6} every {}s{}",
                    entry.control_key,
                    entry.probe.kind(),
                    config.interval_for(entry),
                    if entry.managed { "" } else { "  (local)" }
                );
            }
            Ok(())
        }

        Command::Ui {
            config,
            listen,
            off,
        } => {
            let path = config.unwrap_or_else(default_path);
            let mut cfg = Config::load(&path)?;

            if off {
                cfg.ui = None;
                cfg.save(&path)?;
                println!("The local page is off. Nothing is listening.");
                return Ok(());
            }

            let (settings, password) = tern_agent::ui::configure(cfg.ui.as_ref(), listen);
            let address = settings.listen.clone();
            cfg.ui = Some(settings);
            cfg.save(&path)?;

            tern_agent::ui::announce(&address, &password);
            Ok(())
        }

        Command::Resume { config } => {
            let path = config.unwrap_or_else(default_path);
            let mut cfg = Config::load(&path)?;

            match cfg.state {
                tern_agent::config::Running::Active => {
                    println!("Already running. Nothing to undo.");
                }
                previous => {
                    cfg.state = tern_agent::config::Running::Active;
                    cfg.save(&path)?;
                    let was = match previous {
                        tern_agent::config::Running::Paused => "paused",
                        _ => "stopped",
                    };
                    println!("Was {was}. Now active.");
                    // Said because it is the step somebody forgets: the state is
                    // read at startup, and the process still running is the one
                    // that was told to stop.
                    println!("Restart it for this to take effect.");
                }
            }
            Ok(())
        }

        Command::QueueClear { queue } => {
            let queue_path = queue.unwrap_or_else(|| default_path().with_extension("queue.json"));
            let discarded = tern_agent::runner::Queue::open(&queue_path).discard();
            println!(
                "Discarded {discarded} buffered point(s) from {}",
                queue_path.display()
            );
            Ok(())
        }

        Command::Test { probe } => {
            #[derive(serde::Deserialize)]
            struct Input {
                assertions: Vec<Assertion>,
                observation: Observation,
            }

            let raw = std::fs::read_to_string(&probe)
                .with_context(|| format!("could not read {probe}"))?;
            let input: Input = serde_json::from_str(&raw).context("probe file did not parse")?;

            let result = evaluate(&input.assertions, &input.observation);
            println!("{}", serde_json::to_string_pretty(&result)?);

            // Non-zero when the probe says the target is unhealthy, so this is
            // usable directly in a CI step or a shell condition.
            if matches!(result.status, tern_agent::probe::Status::Operational) {
                Ok(())
            } else {
                std::process::exit(1)
            }
        }
    }
}

/// stderr always; a file as well when asked; JSON when a collector is reading.
fn init_logging(cli: &Cli) -> Result<()> {
    use tracing_subscriber::prelude::*;

    let filter = match &cli.log_level {
        Some(level) => tracing_subscriber::EnvFilter::new(level.clone()),
        None => tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    };

    let file_layer = match &cli.log_file {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).ok();
                }
            }
            // Appended, never truncated: a restart that erased the log of why it
            // restarted would be its own kind of defect.
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("could not open {}", path.display()))?;
            Some(file)
        }
        None => None,
    };

    /*
     * Every line also lands in a ring the agent can be asked for later.
     *
     * Added to the registry rather than replacing a writer, so what goes to
     * stderr and to the file is unchanged: the buffer is a second reader of the
     * same events, not a redirection of them. See `logbuf` for what it honestly
     * holds — this process's lines, since this process started.
     */
    let registry = tracing_subscriber::registry().with(filter).with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(tern_agent::logbuf::RingWriter),
    );

    match (cli.log_json, file_layer) {
        (true, Some(file)) => registry
            .with(tracing_subscriber::fmt::layer().json())
            .with(tracing_subscriber::fmt::layer().json().with_writer(file))
            .init(),
        (true, None) => registry
            .with(tracing_subscriber::fmt::layer().json())
            .init(),
        (false, Some(file)) => registry
            .with(tracing_subscriber::fmt::layer())
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(file),
            )
            .init(),
        (false, None) => registry.with(tracing_subscriber::fmt::layer()).init(),
    }

    Ok(())
}

fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// The path, typed the way a person types it.
    ///
    /// `tern-agent run ~/.config/tern/agent.toml` used to answer "unexpected
    /// argument found" — naming what was wrong and not what would have been
    /// right, on the one command somebody runs while something is already
    /// broken. Pinned here so the courtesy is not tidied away later.
    #[test]
    fn a_config_path_needs_no_flag() {
        for argv in [
            vec!["tern-agent", "run", "/etc/tern/agent.toml"],
            vec!["tern-agent", "doctor", "/etc/tern/agent.toml"],
            vec!["tern-agent", "status", "/etc/tern/agent.toml"],
        ] {
            let cli = Cli::try_parse_from(&argv).unwrap_or_else(|e| panic!("{argv:?}: {e}"));
            let found = match cli.command {
                Command::Run {
                    config,
                    config_positional,
                    ..
                }
                | Command::Doctor {
                    config,
                    config_positional,
                    ..
                }
                | Command::Status {
                    config,
                    config_positional,
                    ..
                } => config.or(config_positional),
                _ => None,
            };
            assert_eq!(
                found.as_deref(),
                Some(std::path::Path::new("/etc/tern/agent.toml")),
                "{argv:?}"
            );
        }
    }

    /// Pairing onto an existing config keeps the probes and takes the key.
    ///
    /// The old behaviour refused the file and printed the key for somebody to
    /// place by hand — so pairing succeeded, burned a single-use PIN, minted a
    /// key and threw it away. The agent went on presenting the previous key,
    /// which the far end had already replaced, and every call came back 401.
    /// Measured on a real machine, with nothing connecting the two lines.
    #[test]
    fn pairing_over_an_existing_config_replaces_only_the_credential() {
        let dir = std::env::temp_dir().join(format!("tern-pair-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(
            &path,
            r#"server = "http://old:1"
api_key = "ternp_STALE"
interval_s = 90

[[probes]]
control_key = "hand-written"
type = "tcp"
host = "127.0.0.1"
port = 9000
"#,
        )
        .unwrap();

        let mut existing = Config::load(&path).unwrap();
        existing.api_key = "ternp_FRESH".to_string();
        existing.server = "http://relay:38787".to_string();
        existing.save(&path).unwrap();

        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.api_key, "ternp_FRESH", "the new key must land");
        assert_eq!(reloaded.server, "http://relay:38787");
        // The reason the file was spared in the first place, still true.
        assert_eq!(reloaded.interval_s, 90, "settings are the operator's");
        assert_eq!(
            reloaded.probes.first().map(|p| p.control_key.as_str()),
            Some("hand-written"),
            "a probe written on the host is not ours to discard"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `--force` is a flag and not a prompt, and that is not a shortcut.
    ///
    /// This runs inside `install.sh`, piped into `sh`, with no terminal to
    /// answer a question from. A confirmation there hangs forever, which is how
    /// an installer stops being pipeable.
    #[test]
    fn forcing_is_expressible_without_a_terminal() {
        let cli = Cli::try_parse_from([
            "tern-agent",
            "pair",
            "--server",
            "http://relay:38787",
            "--pin",
            "AAAA-BBBB",
            "--force",
        ])
        .unwrap();
        match cli.command {
            Command::Pair { force, .. } => assert!(force),
            _ => panic!("wrong command"),
        }
    }

    /// And the flag still works, because every message this product prints
    /// spells it that way.
    #[test]
    fn the_flag_still_works_and_wins() {
        let cli = Cli::try_parse_from([
            "tern-agent",
            "run",
            "--config",
            "/from/flag.toml",
            "/from/positional.toml",
        ])
        .unwrap();
        match cli.command {
            Command::Run {
                config,
                config_positional,
                ..
            } => {
                // Both given is a contradiction nobody means; the flag is the
                // one every printed instruction uses, so it decides.
                assert_eq!(
                    config.or(config_positional).unwrap().to_str().unwrap(),
                    "/from/flag.toml"
                );
            }
            _ => panic!("wrong command"),
        }
    }
}
