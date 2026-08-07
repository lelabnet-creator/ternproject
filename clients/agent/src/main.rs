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
    },

    /// Run the configured probes on a schedule, pushing each result.
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
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
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        queue: Option<PathBuf>,
    },

    /// What this agent is: its probes, and what is waiting to be sent.
    Status {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        queue: Option<PathBuf>,
    },

    /// Discard the buffered points. They are lost, not sent.
    QueueClear {
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
        } => {
            let client = Client::new(&server)?;
            let response = client
                .pair(&PairRequest {
                    code: pin,
                    hostname: hostname(),
                    os: Some(std::env::consts::OS.to_string()),
                    arch: Some(std::env::consts::ARCH.to_string()),
                    agent_version: Some(env!("CARGO_PKG_VERSION").to_string()),
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
            // history file. An existing config is never overwritten: it may hold
            // probes nobody has anywhere else.
            let path = config.unwrap_or_else(default_path);
            if path.exists() {
                println!("{} already exists — not overwriting it.", path.display());
                println!("Store this key — it is shown once:");
                println!("  export TERN_API_KEY={}", response.api_key);
                return Ok(());
            }

            let mut config = Config {
                server: server.trim_end_matches('/').to_string(),
                api_key: response.api_key,
                interval_s: 60,
                probes: Vec::new(),
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

            println!("Then: tern-agent run --config {}", path.display());
            Ok(())
        }

        Command::Run {
            config,
            queue,
            once,
            no_refresh,
            wait_for_config,
        } => {
            let path = config.unwrap_or_else(default_path);

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
            if !no_refresh {
                match Client::new(&config.server)?.jobs(&config.api_key).await {
                    Ok(response) => {
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

            if once {
                let client = Client::new(&config.server)?;
                let mut points = Vec::with_capacity(config.probes.len());
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
                let response = client.ingest(&config.api_key, &points).await?;
                println!("pushed {} point(s)", response.accepted);
                return Ok(());
            }

            let queue_path = queue.unwrap_or_else(|| path.with_extension("queue.json"));
            // The runner keeps asking after this first fetch, so a control
            // added in the admin starts being measured without a restart.
            tern_agent::runner::run(config, path, queue_path, !no_refresh).await
        }

        Command::Doctor { config, queue } => {
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

        Command::Status { config, queue } => {
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

    let registry = tracing_subscriber::registry().with(filter);

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
