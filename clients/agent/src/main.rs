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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().command {
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

            Config {
                server: server.trim_end_matches('/').to_string(),
                api_key: response.api_key,
                interval_s: 60,
                probes: Vec::new(),
            }
            .save(&path)?;

            println!("Wrote {} (readable only by you).", path.display());
            println!(
                "Add a [[probes]] section, then: tern-agent run --config {}",
                path.display()
            );
            Ok(())
        }

        Command::Run {
            config,
            queue,
            once,
        } => {
            let path = config.unwrap_or_else(default_path);
            let config = Config::load(&path)?;

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
            tern_agent::runner::run(config, queue_path).await
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
