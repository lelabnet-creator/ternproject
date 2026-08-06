//! `tern-agent` — pair, probe, push.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
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
    /// Exchange a pairing PIN for an ingest key.
    Pair {
        #[arg(long, env = "TERN_SERVER")]
        server: String,
        #[arg(long)]
        pin: String,
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
        Command::Pair { server, pin } => {
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
            // Printed rather than written for now: writing it belongs with the
            // config file work, and silently persisting a credential the user
            // has not been shown is worse than asking them to place it.
            println!("Store this key — it is shown once:");
            println!("  export TERN_API_KEY={}", response.api_key);
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
