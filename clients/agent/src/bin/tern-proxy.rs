//! `tern-proxy` — the relay for isolated networks.
//!
//! Configured entirely from the command line, because the machine it runs on is
//! usually a hardened jump host reached over SSH, where editing TOML by hand is
//! the awkward part rather than the safe one.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tern_agent::proxy;

#[derive(Parser)]
#[command(
    name = "tern-proxy",
    version,
    about = "TERN relay for networks with no egress"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    #[arg(long, global = true, env = "TERN_LOG")]
    log_level: Option<String>,

    #[arg(long, global = true, env = "TERN_LOG_JSON")]
    log_json: bool,
}

/// The port out of a `host:port`, for suggesting a listen address that keeps
/// the one already chosen.
fn port_of(listen: &str) -> &str {
    listen
        .rsplit_once(':')
        .map(|(_, port)| port)
        .unwrap_or("8787")
}

/// `batch` or `stream`, named rather than derived — the enum is serde's, and a
/// wrong word here should be a refusal with the two options in it.
fn parse_forward(raw: &str) -> Result<proxy::Forward, String> {
    match raw {
        "batch" => Ok(proxy::Forward::Batch),
        "stream" => Ok(proxy::Forward::Stream),
        other => Err(format!("expected `batch` or `stream`, got `{other}`")),
    }
}

#[derive(Subcommand)]
enum Command {
    /// Pair this proxy with TERN, using a PIN from the admin. Writes the config.
    Init {
        #[arg(long, env = "TERN_SERVER")]
        server: String,
        #[arg(long)]
        pin: String,
        #[arg(long)]
        config: Option<PathBuf>,
        /// host:port to listen on for the agents in this zone.
        #[arg(long)]
        listen: Option<String>,
        /// Seconds points wait before being carried upstream. Default 10.
        #[arg(long)]
        forward_interval: Option<u64>,
        /// `batch` (default) waits for that interval; `stream` sends as points
        /// arrive. Either way the on-disk queue is what survives an outage.
        #[arg(long, value_parser = parse_forward)]
        forward: Option<proxy::Forward>,
    },

    /// Serve the zone: accept its agents, buffer their points, forward upstream.
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        queue: Option<PathBuf>,
        #[arg(long)]
        listen: Option<String>,
    },

    /// Mint a PIN for one agent in this zone. Single use, short-lived.
    Pin {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long, default_value = "15")]
        ttl_minutes: u64,
    },

    /// What this proxy is: upstream, listener, issued keys, queue depth.
    Status {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        queue: Option<PathBuf>,
    },
}

fn default_config() -> PathBuf {
    PathBuf::from("proxy.toml")
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let filter = match &cli.log_level {
        Some(level) => tracing_subscriber::EnvFilter::new(level.clone()),
        None => tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    };
    if cli.log_json {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    match cli.command {
        Command::Init {
            server,
            pin,
            config,
            listen,
            forward_interval,
            forward,
        } => {
            let path = config.unwrap_or_else(default_config);
            proxy::init(&server, &pin, &path, listen, forward_interval, forward).await
        }

        Command::Run {
            config,
            queue,
            listen,
        } => {
            let path = config.unwrap_or_else(default_config);
            let queue_path = queue.unwrap_or_else(|| path.with_extension("queue.json"));
            proxy::run(path, queue_path, listen).await
        }

        Command::Pin {
            config,
            ttl_minutes,
        } => {
            let path = config.unwrap_or_else(default_config);
            let (pin, file) = proxy::issue_pin(&path, ttl_minutes)?;

            println!("PIN: {pin}");
            println!("Valid for {ttl_minutes} minutes, once.");
            println!();

            let config = proxy::ProxyConfig::load(&path)?;
            let zone = proxy::zone_address(&config.listen, proxy::outbound_address(&config.server));
            let origin = format!("http://{}", zone.authority);

            // Said before the commands, not after: it decides whether they can
            // work at all, and a warning printed under something that looks
            // ready to copy is a warning nobody reads.
            match zone.caveat {
                Some(proxy::ZoneCaveat::LoopbackOnly) => {
                    println!(
                        "⚠ This relay listens on {} — loopback only, so no",
                        config.listen
                    );
                    println!("  other machine can reach it. The commands below will fail with a");
                    println!("  connection refused until it serves an address the zone can see:");
                    println!(
                        "      tern-proxy run --config {} --listen 0.0.0.0:{}",
                        path.display(),
                        port_of(&config.listen)
                    );
                    println!("  (or set listen in the config, which the service already reads)");
                    println!();
                }
                Some(proxy::ZoneCaveat::Guessed) => {
                    println!("Note: this relay binds every interface, so there is no single");
                    println!("address to give. Below is the one it reaches TERN from — use");
                    println!("whichever address the zone can actually see.");
                    println!();
                }
                None => {}
            }

            // Two commands, because there are two situations and only one of
            // them used to be answered. A machine in an isolated zone cannot
            // fetch anything from TERN — including the installer — so the
            // relay serves it, and this is where that becomes findable.
            println!("On a machine in this zone, with nothing installed on it yet:");
            println!("  curl -fsSL {origin}/install.sh | sh -s -- --server {origin} --pin {pin}");
            println!();
            println!("Or, if tern-agent is already on it:");
            println!("  tern-agent pair --server {origin} --pin {pin}");
            println!();
            println!("(pending PINs are in {})", file.display());
            Ok(())
        }

        Command::Status { config, queue } => {
            let path = config.unwrap_or_else(default_config);
            let queue_path = queue.unwrap_or_else(|| path.with_extension("queue.json"));
            let config = proxy::ProxyConfig::load(&path)?;
            let pending = tern_agent::runner::Queue::open(&queue_path);

            println!("upstream    {}", config.server);
            println!("listening   {}", config.listen);
            println!("refresh     every {}s", config.refresh_s);
            println!(
                "forwarding  {}",
                match config.forward {
                    proxy::Forward::Stream => "as points arrive".to_string(),
                    proxy::Forward::Batch => format!("every {}s", config.forward_interval_s),
                }
            );
            println!(
                "agents      {} key(s) issued in this zone",
                config.local_keys.len()
            );
            for key in &config.local_keys {
                println!("  {}", key.name);
            }
            println!(
                "queued      {} point(s) waiting for upstream",
                pending.len()
            );
            Ok(())
        }
    }
}
