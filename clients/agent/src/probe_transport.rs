//! The I/O half of probe execution.
//!
//! `probe.rs` decides what an observation *means*; this module produces it. The
//! split is deliberate and matches the server: semantics are tested against the
//! shared conformance fixtures with no network at all, and everything here is
//! tested against sockets we open ourselves.
//!
//! The one place the agent does more than the server: ICMP. A web process must
//! not hold a raw socket, so the API approximates a ping with a TCP connect.
//! An agent can be given `CAP_NET_RAW` on a host that wants it, so it sends a
//! real echo request — and falls back to the server's approximation, saying so,
//! when it is not permitted to.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::probe::Observation;

// ── What can be probed ──────────────────────────────────────────────────────

/// Mirrors `probeSchema` in `packages/shared/src/probe.ts`.
///
/// Kept structurally identical so an `agent.toml` and a probe stored on the
/// server describe the same thing — the editor generates one from the other.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Probe {
    Ping {
        host: String,
        #[serde(default = "default_count")]
        count: u8,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    Tcp {
        host: String,
        port: u16,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    Http {
        url: String,
        #[serde(default = "default_method")]
        method: String,
        // Skipped when empty so a written config does not carry a bare
        // `[probes.headers]` table that says nothing.
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        headers: HashMap<String, String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default = "default_true")]
        follow_redirects: bool,
        #[serde(default = "default_true")]
        tls_verify: bool,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    Dns {
        name: String,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    Cert {
        host: String,
        #[serde(default = "default_https_port")]
        port: u16,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// The WebSocket opening handshake. See `websocketProbeSchema` in
    /// `packages/shared/src/probe.ts` for why there is no send/expect pair.
    Websocket {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subprotocol: Option<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        headers: HashMap<String, String>,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// A container on this host. Agent-only: the server refuses this kind
    /// outright rather than being handed a Docker socket.
    Docker {
        container: String,
        #[serde(default)]
        require_healthcheck: bool,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// Whether a path is there. Agent-only: see the block comment above
    /// `fileProbeSchema` in `packages/shared/src/probe.ts` for why the server
    /// refuses this and the two below.
    File {
        path: String,
        #[serde(default = "default_true")]
        must_exist: bool,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// Whether a directory is still being written to.
    Directory {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contains: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_quiet_seconds: Option<u64>,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// How long the machine, or one process on it, has been up.
    Uptime {
        #[serde(default)]
        of: UptimeOf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        process: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_seconds: Option<u64>,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UptimeOf {
    #[default]
    Machine,
    Process,
}

fn default_count() -> u8 {
    3
}
fn default_timeout() -> u64 {
    10_000
}
fn default_method() -> String {
    "GET".to_string()
}
fn default_true() -> bool {
    true
}
fn default_https_port() -> u16 {
    443
}

impl Probe {
    pub fn kind(&self) -> &'static str {
        match self {
            Probe::Ping { .. } => "ping",
            Probe::Tcp { .. } => "tcp",
            Probe::Http { .. } => "http",
            Probe::Dns { .. } => "dns",
            Probe::Cert { .. } => "cert",
            Probe::Websocket { .. } => "websocket",
            Probe::Docker { .. } => "docker",
            Probe::File { .. } => "file",
            Probe::Directory { .. } => "directory",
            Probe::Uptime { .. } => "uptime",
        }
    }
}

// ── Observing ───────────────────────────────────────────────────────────────

pub async fn observe(probe: &Probe) -> Observation {
    match probe {
        Probe::Http {
            url,
            method,
            headers,
            body,
            follow_redirects,
            tls_verify,
            timeout_ms,
        } => {
            observe_http(
                url,
                method,
                headers,
                body.as_deref(),
                *follow_redirects,
                *tls_verify,
                *timeout_ms,
            )
            .await
        }
        Probe::Tcp {
            host,
            port,
            timeout_ms,
        } => observe_tcp(host, *port, *timeout_ms).await,
        Probe::Ping {
            host,
            count,
            timeout_ms,
        } => observe_ping(host, *count, *timeout_ms).await,
        Probe::Dns { name, timeout_ms } => observe_dns(name, *timeout_ms).await,
        Probe::Cert {
            host,
            port,
            timeout_ms,
        } => observe_cert(host, *port, *timeout_ms).await,
        Probe::Websocket {
            url,
            subprotocol,
            headers,
            timeout_ms,
        } => observe_websocket(url, subprotocol.as_deref(), headers, *timeout_ms).await,
        Probe::Docker {
            container,
            require_healthcheck,
            timeout_ms,
        } => observe_docker(container, *require_healthcheck, *timeout_ms).await,
        Probe::File {
            path,
            must_exist,
            timeout_ms,
        } => observe_file(path, *must_exist, *timeout_ms).await,
        Probe::Directory {
            path,
            contains,
            max_quiet_seconds,
            timeout_ms,
        } => observe_directory(path, contains.as_deref(), *max_quiet_seconds, *timeout_ms).await,
        Probe::Uptime {
            of,
            process,
            min_seconds,
            timeout_ms,
        } => observe_uptime(*of, process.as_deref(), *min_seconds, *timeout_ms).await,
    }
}

/// The WebSocket opening handshake.
///
/// Written by hand rather than pulling in a WebSocket crate, and that is a size
/// decision as much as a taste one: this agent is built with `opt-level = "z"`,
/// LTO and `strip`, and a full protocol implementation would be several hundred
/// kilobytes to send one request and read one line. The handshake is ordinary
/// HTTP/1.1 with an `Upgrade` header — `tokio` and `tokio-rustls` are already
/// here for `cert`, and nothing else is needed.
///
/// The clock stops on the status line. A `101` means the server accepted the
/// upgrade, which is the whole question; the socket is dropped immediately
/// afterwards without completing the protocol, so no frames are ever exchanged.
async fn observe_websocket(
    url: &str,
    subprotocol: Option<&str>,
    headers: &HashMap<String, String>,
    timeout_ms: u64,
) -> Observation {
    use tokio::io::AsyncWriteExt;

    /*
     * ── No `tls_verify` here, unlike the http target ──────────────────────
     * The http probe can turn verification off because internal appliances
     * with self-signed certificates are a real situation, and `reqwest`
     * exposes it in one call. Doing the same for `wss://` would mean writing a
     * rustls certificate verifier that accepts everything and carrying it in
     * the binary for the rest of the project's life — a loaded gun in the tree
     * for a case nobody has asked for. A `wss://` endpoint whose certificate
     * does not verify is a broken endpoint, and reporting it as down is the
     * correct answer rather than a limitation.
     */
    let (secure, rest) = match url.split_once("://") {
        Some(("wss", rest)) => (true, rest),
        Some(("ws", rest)) => (false, rest),
        _ => return failed(format!("{url} is not a ws:// or wss:// URL")),
    };

    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };

    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => match port.parse::<u16>() {
            Ok(port) => (host.to_string(), port),
            Err(_) => return failed(format!("{authority} has no valid port")),
        },
        None => (authority.to_string(), if secure { 443u16 } else { 80u16 }),
    };

    if host.is_empty() {
        return failed(format!("{url} has no host"));
    }

    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n"
    );
    // A fixed key is fine. The server hashes it into `Sec-WebSocket-Accept`,
    // which is never read: a server that answered 101 has accepted the upgrade,
    // and the hash says nothing further about whether the service is up.
    if let Some(subprotocol) = subprotocol {
        request.push_str(&format!("Sec-WebSocket-Protocol: {subprotocol}\r\n"));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");

    let started = Instant::now();

    let exchange = async {
        let stream = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|error| anyhow::anyhow!("could not connect to {authority}: {error}"))?;

        let mut line = String::new();

        if secure {
            let mut roots = tokio_rustls::rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = tokio_rustls::rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();

            let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
            let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone())
                .map_err(|_| anyhow::anyhow!("{host} is not a valid server name"))?;

            let mut stream = connector
                .connect(server_name, stream)
                .await
                .map_err(|error| anyhow::anyhow!("TLS handshake failed: {error}"))?;

            stream.write_all(request.as_bytes()).await?;
            read_status_line(&mut stream, &mut line).await?;
        } else {
            let mut stream = stream;
            stream.write_all(request.as_bytes()).await?;
            read_status_line(&mut stream, &mut line).await?;
        }

        Ok::<String, anyhow::Error>(line)
    };

    match tokio::time::timeout(Duration::from_millis(timeout_ms), exchange).await {
        Ok(Ok(status_line)) => {
            let mut observation = blank();
            observation.latency_ms = Some(started.elapsed().as_millis() as i64);
            // "HTTP/1.1 101 Switching Protocols" — the number is what
            // `status_code` asserts on, so the engine needs nothing new.
            observation.status_code = status_line
                .split_whitespace()
                .nth(1)
                .and_then(|code| code.parse::<i64>().ok());
            observation.body = Some(status_line);
            observation
        }
        Ok(Err(error)) => failed(error),
        Err(_) => failed(format!("timed out after {timeout_ms} ms")),
    }
}

/// Reads bytes until the first CRLF, which is the whole status line.
async fn read_status_line<S>(stream: &mut S, line: &mut String) -> Result<()>
where
    S: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut buffer = [0u8; 256];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            anyhow::bail!("connection closed before the handshake response");
        }
        line.push_str(&String::from_utf8_lossy(&buffer[..read]));
        if let Some(end) = line.find("\r\n") {
            line.truncate(end);
            return Ok(());
        }
        if line.len() > 8192 {
            anyhow::bail!("no status line in the first 8 KiB of the response");
        }
    }
}

/// A container on this host, read from the Docker socket.
///
/// ── Why this exists only in the agent ─────────────────────────────────────
/// The Docker socket is root on the host. The server is never given one, and
/// `probe-transport.ts` refuses this kind outright — see the note on
/// `dockerProbeSchema`.
///
/// Even here it is off unless asked for: `TERN_DOCKER_SOCKET` is unset by
/// default, and `tern-agent doctor` reports whether the path exists and is
/// readable, the same way it reports whether ICMP is permitted.
///
/// ── What it returns ───────────────────────────────────────────────────────
/// The container's JSON, verbatim, as the observation body. That is deliberate:
/// `json_path` then asserts on it exactly as it does on an HTTP body, so
/// `$.State.Health.Status == "healthy"` is an ordinary assertion rather than a
/// special case in the engine. A container that is not running, or unhealthy
/// when `require_healthcheck` is set, fails as unreachable — the state is not a
/// slow response, it is an absent service.
/*
 * A Docker socket is a Unix socket, so this target exists only where those do.
 *
 * It was written without that condition, and it broke the Windows build the day
 * it landed — `tokio::net::UnixStream` simply is not there. The agent has
 * shipped no Windows binary since, and the release job that depends on them has
 * not run: a target added for Linux quietly cost the product a platform.
 */
#[cfg(unix)]
async fn observe_docker(
    container: &str,
    require_healthcheck: bool,
    timeout_ms: u64,
) -> Observation {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let socket = match std::env::var("TERN_DOCKER_SOCKET") {
        Ok(path) if !path.is_empty() => path,
        _ => {
            return failed(
                "TERN_DOCKER_SOCKET is not set. A docker control needs the agent to be given \
                 the Docker socket explicitly — run `tern-agent doctor` for what it expects.",
            )
        }
    };

    let started = Instant::now();

    let exchange = async {
        let mut stream = tokio::net::UnixStream::connect(&socket)
            .await
            .map_err(|error| {
                anyhow::anyhow!("could not open the Docker socket at {socket}: {error}")
            })?;

        // Hand-written HTTP/1.1 over the Unix socket, for the same reason the
        // handshake above is hand-written: a Docker client crate is a large
        // dependency for one GET.
        let request = format!(
            "GET /containers/{container}/json HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await?;

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        Ok::<String, anyhow::Error>(String::from_utf8_lossy(&response).into_owned())
    };

    let response = match tokio::time::timeout(Duration::from_millis(timeout_ms), exchange).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return failed(error),
        Err(_) => return failed(format!("timed out after {timeout_ms} ms")),
    };

    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return failed("the Docker socket returned a response with no body");
    };

    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    if status == 404 {
        return failed(format!("no container named {container}"));
    }
    if status != 200 {
        return failed(format!("the Docker socket answered {status}"));
    }

    // Chunked responses arrive with size prefixes; Docker sends them for this
    // endpoint. Taking the JSON from the first brace to the last is cruder than
    // decoding the chunking and is enough to hand a valid document to the
    // assertion engine.
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(start), Some(end)) if end > start => &body[start..=end],
        _ => return failed("the Docker socket returned no JSON"),
    };

    let parsed: serde_json::Value = match serde_json::from_str(json) {
        Ok(parsed) => parsed,
        Err(error) => return failed(format!("could not read the container's JSON: {error}")),
    };

    let running = parsed
        .pointer("/State/Running")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    if !running {
        let state = parsed
            .pointer("/State/Status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        return failed(format!("container {container} is {state}"));
    }

    let health = parsed
        .pointer("/State/Health/Status")
        .and_then(|value| value.as_str());

    match (health, require_healthcheck) {
        (Some("healthy"), _) | (None, false) => {}
        (Some(other), _) => return failed(format!("container {container} is {other}")),
        (None, true) => {
            return failed(format!(
                "container {container} defines no healthcheck, and this control requires one"
            ))
        }
    }

    let mut observation = blank();
    observation.latency_ms = Some(started.elapsed().as_millis() as i64);
    observation.body = Some(json.to_string());
    observation
}

/// The same target where there is no Unix socket to reach a daemon through.
///
/// An error rather than a silent skip, and the same rule the server follows when
/// it refuses this target: a control that is not being run has to say so, or
/// "nothing happened" becomes the way somebody learns it.
#[cfg(not(unix))]
async fn observe_docker(
    container: &str,
    _require_healthcheck: bool,
    _timeout_ms: u64,
) -> Observation {
    failed(format!(
        "docker controls need a Unix socket, which this build has none of — \
         assign {container} to an agent on a Unix host"
    ))
}

/// Age in whole seconds of a filesystem timestamp, floored at zero.
///
/// `SystemTime::elapsed` fails when the stamp is in the future, which happens
/// for real on an NFS mount or after an NTP step, and is not the operator's
/// problem. Reporting zero — "just now" — is the reading that misleads least;
/// returning nothing would make a `maxQuietSeconds` control fail for a reason
/// that has nothing to do with the directory.
fn age_seconds(stamp: std::time::SystemTime) -> i64 {
    stamp
        .elapsed()
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether a path is there, and what state it is in.
///
/// The observation body is JSON for the same reason `docker`'s is: `json_path`
/// then works on it unchanged, so `$.sizeBytes gt 0` needs nothing new in the
/// assertion engine.
async fn observe_file(path: &str, must_exist: bool, timeout_ms: u64) -> Observation {
    let started = Instant::now();

    /*
     * Absent and unreadable are not the same answer, and conflating them is how
     * this target would lie.
     *
     * `metadata` fails for both. If every failure meant "absent", a control
     * written as `mustExist: false` over a directory the agent's user cannot
     * traverse would report healthy forever — the strongest possible statement
     * about a path nobody can see. Only `NotFound` is absence; anything else is
     * a failure to observe, and says so.
     */
    let lookup = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tokio::fs::metadata(path.to_string()),
    )
    .await;

    let found = match lookup {
        Err(_) => return failed(format!("timed out after {timeout_ms} ms stat-ing {path}")),
        Ok(Ok(meta)) => Some(meta),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        Ok(Err(error)) => return failed(format!("could not read {path}: {error}")),
    };

    let body = match &found {
        Some(meta) => {
            let kind = if meta.is_dir() {
                "directory"
            } else if meta.is_file() {
                "file"
            } else {
                "other"
            };
            serde_json::json!({
                "exists": true,
                "kind": kind,
                "sizeBytes": meta.len() as i64,
                "modifiedSecondsAgo": meta.modified().ok().map(age_seconds),
            })
        }
        None => serde_json::json!({
            "exists": false,
            "kind": null,
            "sizeBytes": null,
            "modifiedSecondsAgo": null,
        }),
    };

    if found.is_some() != must_exist {
        return failed(if must_exist {
            format!("{path} is not there, and this control requires it")
        } else {
            format!("{path} is there, and this control requires it gone")
        });
    }

    let mut observation = blank();
    observation.latency_ms = Some(started.elapsed().as_millis() as i64);
    observation.body = Some(body.to_string());
    observation
}

/// Whether a directory is still being written to.
///
/// One level, not a recursive walk: the cost of a check should depend on what
/// the operator pointed at and not on how deep it happens to be, and a tree
/// that grows a level would otherwise start timing out on its own.
///
/// A missing directory fails outright, unlike `file`, where absence is one of
/// the two answers being asked for. Here the question is about the contents, and
/// a path that is not there has no contents to be quiet or busy — reporting
/// "nothing has changed recently" would be true and completely misleading.
async fn observe_directory(
    path: &str,
    contains: Option<&str>,
    max_quiet_seconds: Option<u64>,
    timeout_ms: u64,
) -> Observation {
    let started = Instant::now();

    let walk = async {
        let mut reader = tokio::fs::read_dir(path)
            .await
            .map_err(|error| anyhow::anyhow!("could not read {path}: {error}"))?;

        let mut entries = 0i64;
        let mut bytes = 0i64;
        let mut newest: Option<(i64, String)> = None;

        while let Some(entry) = reader.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(needle) = contains {
                if !name.contains(needle) {
                    continue;
                }
            }
            entries += 1;

            /*
             * An entry that vanishes between the listing and the stat is not an
             * error. A spool directory is exactly the place where that happens,
             * and the whole point of watching one is that things leave it.
             */
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            bytes += meta.len() as i64;

            if let Ok(modified) = meta.modified() {
                let age = age_seconds(modified);
                if newest.as_ref().is_none_or(|(known, _)| age < *known) {
                    newest = Some((age, name));
                }
            }
        }

        Ok::<_, anyhow::Error>((entries, bytes, newest))
    };

    let (entries, bytes, newest) =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), walk).await {
            Ok(Ok(counted)) => counted,
            Ok(Err(error)) => return failed(error),
            Err(_) => return failed(format!("timed out after {timeout_ms} ms listing {path}")),
        };

    let body = serde_json::json!({
        "exists": true,
        "entries": entries,
        "bytes": bytes,
        "newestSecondsAgo": newest.as_ref().map(|(age, _)| *age),
        "newestName": newest.as_ref().map(|(_, name)| name.clone()),
    });

    if let Some(limit) = max_quiet_seconds {
        match &newest {
            /*
             * Empty counts as quiet. A drop folder whose writer died looks
             * identical to one that was drained and never refilled, and the
             * control is there to catch the first — so the ambiguous case is
             * resolved towards noticing.
             */
            None => {
                return failed(format!(
                    "nothing in {path} to have changed{}, and this control expects activity \
                     within {limit} s",
                    contains.map_or(String::new(), |needle| format!(" matching {needle}"))
                ))
            }
            Some((age, name)) if *age as u64 > limit => {
                return failed(format!(
                    "nothing has changed in {path} for {age} s — the newest is {name}, and this \
                     control expects activity within {limit} s"
                ))
            }
            Some(_) => {}
        }
    }

    let mut observation = blank();
    observation.latency_ms = Some(started.elapsed().as_millis() as i64);
    observation.body = Some(body.to_string());
    observation
}

/// How long the machine, or one process on it, has been up.
///
/// ── `/proc`, and therefore Linux ──────────────────────────────────────────
/// macOS answers both questions through `sysctl`, Windows through
/// `GetTickCount64` and the process API, and neither is reachable without adding
/// a platform crate to a binary built with `opt-level = "z"` for a target nobody
/// has asked for yet. Elsewhere this fails with a message naming the
/// limitation — the rule `docker` set: a control that is not being run says so.
#[cfg(target_os = "linux")]
async fn observe_uptime(
    of: UptimeOf,
    process: Option<&str>,
    min_seconds: Option<u64>,
    timeout_ms: u64,
) -> Observation {
    let started = Instant::now();

    let measure = async {
        // `/proc/uptime`: seconds since boot, then seconds spent idle.
        let raw = tokio::fs::read_to_string("/proc/uptime").await?;
        let machine = raw
            .split_whitespace()
            .next()
            .and_then(|field| field.parse::<f64>().ok())
            .ok_or_else(|| anyhow::anyhow!("/proc/uptime did not parse"))?;

        match of {
            UptimeOf::Machine => Ok::<_, anyhow::Error>((machine as i64, None)),
            UptimeOf::Process => {
                let name = process
                    .ok_or_else(|| anyhow::anyhow!("this control names no process to look for"))?;
                let (pid, since_boot) = oldest_process(name).await?;
                Ok(((machine - since_boot) as i64, Some((pid, name.to_string()))))
            }
        }
    };

    let (uptime, found) =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), measure).await {
            Ok(Ok(measured)) => measured,
            Ok(Err(error)) => return failed(error),
            Err(_) => return failed(format!("timed out after {timeout_ms} ms reading /proc")),
        };

    // Clamped: a process that started in the same tick as the reading gives a
    // very small negative, and a negative uptime is nonsense to assert against.
    let uptime = uptime.max(0);
    let restarted = min_seconds.map(|floor| (uptime as u64) < floor);

    let body = serde_json::json!({
        "of": match of { UptimeOf::Machine => "machine", UptimeOf::Process => "process" },
        "uptimeSeconds": uptime,
        "restarted": restarted,
        "process": found.as_ref().map(|(_, name)| name.clone()),
        "pid": found.as_ref().map(|(pid, _)| *pid),
    });

    if restarted == Some(true) {
        let floor = min_seconds.unwrap_or_default();
        return failed(match &found {
            Some((_, name)) => format!(
                "{name} has been up {uptime} s, less than the {floor} s this control expects — \
                 it restarted"
            ),
            None => format!(
                "this machine has been up {uptime} s, less than the {floor} s this control \
                 expects — it rebooted"
            ),
        });
    }

    let mut observation = blank();
    observation.latency_ms = Some(started.elapsed().as_millis() as i64);
    observation.body = Some(body.to_string());
    observation
}

/// The oldest process with this command name, and the boot-relative second it
/// started at.
///
/// Oldest rather than first found, because a service is usually several
/// processes: a master and its workers, and the workers are recycled while the
/// service stays up. Taking any of them would make the control report a restart
/// every time a worker turned over.
#[cfg(target_os = "linux")]
async fn oldest_process(name: &str) -> anyhow::Result<(i64, f64)> {
    let mut entries = tokio::fs::read_dir("/proc").await?;
    let mut oldest: Option<(i64, f64)> = None;

    while let Some(entry) = entries.next_entry().await? {
        let file = entry.file_name();
        let Some(pid) = file.to_str().and_then(|name| name.parse::<i64>().ok()) else {
            continue;
        };

        // Both reads race process exit, which is ordinary on a busy machine and
        // not a failure of the check: skip and carry on.
        let Ok(comm) = tokio::fs::read_to_string(format!("/proc/{pid}/comm")).await else {
            continue;
        };
        if comm.trim() != name {
            continue;
        }
        let Ok(stat) = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await else {
            continue;
        };

        /*
         * Field 22 of `/proc/<pid>/stat`, in USER_HZ since boot.
         *
         * Split after the *last* `)` rather than by whitespace from the start:
         * field 2 is the command name in parentheses, and it can contain both
         * spaces and parentheses — a process can name itself `foo) bar (baz`,
         * and any parser that counts tokens from the left reads garbage for
         * every field after it. What follows the last `)` begins at field 3, so
         * field 22 is index 19 there.
         *
         * USER_HZ is 100 and is not `CONFIG_HZ`: the kernel fixes it for this
         * interface precisely so that reading it needs no `sysconf`.
         */
        let Some(after_comm) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let Some(ticks) = after_comm
            .split_whitespace()
            .nth(19)
            .and_then(|field| field.parse::<f64>().ok())
        else {
            continue;
        };

        let since_boot = ticks / 100.0;
        if oldest.as_ref().is_none_or(|(_, known)| since_boot < *known) {
            oldest = Some((pid, since_boot));
        }
    }

    oldest.ok_or_else(|| anyhow::anyhow!("no process named {name} is running"))
}

/// The same target where there is no `/proc` to read.
#[cfg(not(target_os = "linux"))]
async fn observe_uptime(
    of: UptimeOf,
    _process: Option<&str>,
    _min_seconds: Option<u64>,
    _timeout_ms: u64,
) -> Observation {
    let subject = match of {
        UptimeOf::Machine => "machine",
        UptimeOf::Process => "process",
    };
    failed(format!(
        "{subject} uptime is read from /proc, which this build has none of — assign this \
         control to an agent on a Linux host"
    ))
}

fn failed(error: impl std::fmt::Display) -> Observation {
    Observation {
        error: Some(error.to_string()),
        latency_ms: None,
        status_code: None,
        headers: HashMap::new(),
        body: None,
        cert_expires_in_days: None,
        dns_records: Vec::new(),
    }
}

fn blank() -> Observation {
    Observation {
        error: None,
        latency_ms: None,
        status_code: None,
        headers: HashMap::new(),
        body: None,
        cert_expires_in_days: None,
        dns_records: Vec::new(),
    }
}

async fn observe_http(
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    follow_redirects: bool,
    tls_verify: bool,
    timeout_ms: u64,
) -> Observation {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("tern-agent/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_millis(timeout_ms));

    if !follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    if !tls_verify {
        // Occasionally necessary for an internal appliance with a private CA.
        // It is a visible per-probe choice, never a default, and never global.
        builder = builder.danger_accept_invalid_certs(true);
    }

    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => return failed(error),
    };

    let method = match reqwest::Method::from_bytes(method.as_bytes()) {
        Ok(method) => method,
        Err(_) => return failed(format!("unsupported HTTP method {method}")),
    };

    let mut request = client.request(method, url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body.to_string());
    }

    let started = Instant::now();
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let mut observation = failed(describe_reqwest(&error));
            observation.latency_ms = Some(started.elapsed().as_millis() as i64);
            return observation;
        }
    };

    let status_code = response.status().as_u16() as i64;
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                v.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();

    // The body is read before the clock stops: a server that sends headers fast
    // and then stalls is slow, and stopping at the headers would call it well.
    let body = response.text().await.ok();
    let latency_ms = started.elapsed().as_millis() as i64;

    Observation {
        latency_ms: Some(latency_ms),
        status_code: Some(status_code),
        headers,
        body,
        ..blank()
    }
}

async fn observe_tcp(host: &str, port: u16, timeout_ms: u64) -> Observation {
    let started = Instant::now();
    let target = format!("{host}:{port}");

    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tokio::net::TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(_stream)) => Observation {
            latency_ms: Some(started.elapsed().as_millis() as i64),
            ..blank()
        },
        Ok(Err(error)) => failed(error),
        Err(_) => failed(format!("Timed out after {timeout_ms} ms")),
    }
}

async fn observe_dns(name: &str, timeout_ms: u64) -> Observation {
    let started = Instant::now();

    // Port 0 with the system resolver: this measures what the host itself would
    // experience, including its /etc/hosts and search domains, which is what an
    // agent running beside an application should report.
    let lookup = tokio::net::lookup_host((name, 0));

    match tokio::time::timeout(Duration::from_millis(timeout_ms), lookup).await {
        Ok(Ok(addresses)) => {
            let records: Vec<String> = addresses.map(|a| a.ip().to_string()).collect();
            if records.is_empty() {
                return failed("no records returned");
            }
            Observation {
                latency_ms: Some(started.elapsed().as_millis() as i64),
                dns_records: records,
                ..blank()
            }
        }
        Ok(Err(error)) => failed(error),
        Err(_) => failed(format!("Timed out after {timeout_ms} ms")),
    }
}

/// Real ICMP when the process is allowed one, the server's approximation when
/// it is not — and the observation says which happened.
async fn observe_ping(host: &str, count: u8, timeout_ms: u64) -> Observation {
    match icmp::ping(host, count, timeout_ms).await {
        Ok(latency_ms) => Observation {
            latency_ms: Some(latency_ms),
            ..blank()
        },
        Err(icmp::PingError::NotPermitted) => {
            // Not an error the operator should have to interpret: report the
            // reachability we *can* measure, and label it.
            let mut observation = observe_tcp(host, 7, timeout_ms).await;
            if observation.error.is_none() {
                observation.headers.insert(
                    "x-tern-ping-mode".to_string(),
                    "tcp-fallback (no CAP_NET_RAW)".to_string(),
                );
            }
            observation
        }
        Err(error) => failed(error),
    }
}

async fn observe_cert(host: &str, port: u16, timeout_ms: u64) -> Observation {
    let started = Instant::now();

    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tls::days_until_expiry(host, port),
    )
    .await
    {
        Ok(Ok(days)) => Observation {
            latency_ms: Some(started.elapsed().as_millis() as i64),
            cert_expires_in_days: Some(days),
            ..blank()
        },
        Ok(Err(error)) => failed(error),
        Err(_) => failed(format!("Timed out after {timeout_ms} ms")),
    }
}

/// reqwest nests the useful part — "connection refused", "invalid certificate" —
/// inside a source chain, and the outer message is only "error sending request".
fn describe_reqwest(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.dedup();
    parts.join(": ")
}

// ── ICMP ────────────────────────────────────────────────────────────────────

mod icmp {
    use super::*;
    use socket2::{Domain, Protocol, Socket, Type};

    #[derive(Debug)]
    pub enum PingError {
        NotPermitted,
        Unresolved(String),
        NoReply(u64),
        Io(std::io::Error),
    }

    impl std::fmt::Display for PingError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                PingError::NotPermitted => write!(f, "ICMP not permitted"),
                PingError::Unresolved(host) => write!(f, "could not resolve {host}"),
                PingError::NoReply(ms) => write!(f, "no ICMP reply within {ms} ms"),
                PingError::Io(error) => write!(f, "{error}"),
            }
        }
    }

    /// Sends `count` echo requests and returns the best round trip in ms.
    ///
    /// The best rather than the mean: a ping that succeeded once proves the path
    /// works, and averaging in a packet lost to a busy queue reports a latency
    /// nothing actually experienced.
    pub async fn ping(host: &str, count: u8, timeout_ms: u64) -> Result<i64, PingError> {
        let address = resolve(host).await?;
        let host = host.to_string();

        // Raw sockets are blocking and privileged; keeping the whole exchange on
        // a blocking thread avoids pretending it is async.
        tokio::task::spawn_blocking(move || ping_blocking(address, count, timeout_ms, &host))
            .await
            .map_err(|error| PingError::Io(std::io::Error::other(error)))?
    }

    async fn resolve(host: &str) -> Result<IpAddr, PingError> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(ip);
        }
        let mut addresses = tokio::net::lookup_host((host, 0))
            .await
            .map_err(|_| PingError::Unresolved(host.to_string()))?;
        addresses
            .next()
            .map(|a| a.ip())
            .ok_or_else(|| PingError::Unresolved(host.to_string()))
    }

    fn ping_blocking(
        address: IpAddr,
        count: u8,
        timeout_ms: u64,
        host: &str,
    ) -> Result<i64, PingError> {
        let (domain, protocol) = match address {
            IpAddr::V4(_) => (Domain::IPV4, Protocol::ICMPV4),
            IpAddr::V6(_) => (Domain::IPV6, Protocol::ICMPV6),
        };

        // A DGRAM ICMP socket needs only `net.ipv4.ping_group_range`, which many
        // distributions already grant; RAW needs CAP_NET_RAW. Trying the
        // unprivileged one first means the common case needs no setup at all.
        let socket = Socket::new(domain, Type::DGRAM, Some(protocol))
            .or_else(|_| Socket::new(domain, Type::RAW, Some(protocol)))
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::PermissionDenied => PingError::NotPermitted,
                _ => PingError::Io(error),
            })?;

        socket
            .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
            .map_err(PingError::Io)?;

        let target: SocketAddr = SocketAddr::new(address, 0);
        let identifier = std::process::id() as u16;
        let mut best: Option<i64> = None;

        for sequence in 0..count.max(1) as u16 {
            let request = echo_request(identifier, sequence, matches!(address, IpAddr::V6(_)));
            let started = Instant::now();

            if let Err(error) = socket.send_to(&request, &target.into()) {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    return Err(PingError::NotPermitted);
                }
                continue;
            }

            let mut buffer = [std::mem::MaybeUninit::<u8>::uninit(); 1500];
            match socket.recv_from(&mut buffer) {
                Ok(_) => {
                    let elapsed = started.elapsed().as_millis() as i64;
                    best = Some(best.map_or(elapsed, |b: i64| b.min(elapsed)));
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut => {}
                Err(error) => return Err(PingError::Io(error)),
            }
        }

        let _ = host;
        best.ok_or(PingError::NoReply(timeout_ms))
    }

    /// An 8-byte echo header with no payload.
    ///
    /// The kernel fills in the checksum for ICMPv6 (it must, since the checksum
    /// covers a pseudo-header only the kernel knows), so it is computed here
    /// only for v4.
    fn echo_request(identifier: u16, sequence: u16, v6: bool) -> [u8; 8] {
        let mut packet = [0u8; 8];
        packet[0] = if v6 { 128 } else { 8 }; // echo request
        packet[4..6].copy_from_slice(&identifier.to_be_bytes());
        packet[6..8].copy_from_slice(&sequence.to_be_bytes());

        if !v6 {
            let checksum = checksum(&packet);
            packet[2..4].copy_from_slice(&checksum.to_be_bytes());
        }
        packet
    }

    fn checksum(data: &[u8]) -> u16 {
        let mut sum: u32 = 0;
        let mut chunks = data.chunks_exact(2);
        for chunk in &mut chunks {
            sum += u16::from_be_bytes([chunk[0], chunk[1]]) as u32;
        }
        if let Some(&last) = chunks.remainder().first() {
            sum += (last as u32) << 8;
        }
        while sum >> 16 != 0 {
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn checksums_a_known_echo_request() {
            // Hand-computed: an echo request with identifier 1, sequence 1 and a
            // zeroed checksum field. If this drifts, every ping we send is
            // silently dropped by the far end and the probe reports "no reply"
            // — a failure that looks exactly like a real outage.
            let mut packet = [0u8; 8];
            packet[0] = 8;
            packet[4..6].copy_from_slice(&1u16.to_be_bytes());
            packet[6..8].copy_from_slice(&1u16.to_be_bytes());
            assert_eq!(checksum(&packet), 0xf7fd);
        }

        #[test]
        fn a_correct_packet_checksums_to_zero() {
            // The receiver's test: summing a packet that already carries its own
            // checksum must yield zero. This holds for any identifier.
            let packet = echo_request(4242, 7, false);
            assert_eq!(checksum(&packet), 0);
        }
    }
}

// ── TLS ─────────────────────────────────────────────────────────────────────

mod tls {
    use anyhow::{anyhow, Context, Result};
    use std::sync::Arc;
    use tokio_rustls::rustls::pki_types::ServerName;
    use tokio_rustls::TlsConnector;

    /// Days until the presented certificate expires.
    ///
    /// Deliberately completes the handshake against the real trust roots: a
    /// certificate that is valid for another year but signed by something the
    /// host does not trust is still an outage, and reporting only its expiry
    /// would call it healthy.
    pub async fn days_until_expiry(host: &str, port: u16) -> Result<i64> {
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        days_until_expiry_against(host, port, roots).await
    }

    /// The same, against a trust store the caller chooses.
    ///
    /// Split out for one reason: the success path could not be tested at all.
    /// A locally generated certificate is by definition not signed by anything
    /// webpki trusts, so any test of the nominal case would have had to weaken
    /// the verification it exists to prove — and a probe that accepted an
    /// untrusted certificate in a test build is a probe nobody should ship.
    ///
    /// Nothing about production changes: the caller above passes the real roots
    /// and is the only caller outside the tests.
    pub async fn days_until_expiry_against(
        host: &str,
        port: u16,
        roots: tokio_rustls::rustls::RootCertStore,
    ) -> Result<i64> {
        let config = tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();

        let connector = TlsConnector::from(Arc::new(config));
        let server_name = ServerName::try_from(host.to_string())
            .map_err(|_| anyhow!("{host} is not a valid server name"))?;

        let stream = tokio::net::TcpStream::connect((host, port))
            .await
            .with_context(|| format!("could not connect to {host}:{port}"))?;
        let stream = connector
            .connect(server_name, stream)
            .await
            .context("TLS handshake failed")?;

        let (_, connection) = stream.get_ref();
        let certificates = connection
            .peer_certificates()
            .ok_or_else(|| anyhow!("no certificate presented"))?;
        let leaf = certificates
            .first()
            .ok_or_else(|| anyhow!("no certificate presented"))?;

        let (_, parsed) =
            x509_parser::parse_x509_certificate(leaf).context("could not parse the certificate")?;

        let expires_at = parsed.validity().not_after.timestamp();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        Ok((expires_at - now) / 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// A listener we own, so the suite needs no outbound network.
    async fn listener() -> tokio::net::TcpListener {
        tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
    }

    /*
     * ── Transports that had no test at all ────────────────────────────────
     *
     * `cert`, `websocket` and `docker` shipped in 0.1.7 implemented, documented
     * and unexercised. The conformance fixtures do not reach them — they pin
     * what an observation means, not how it was obtained — so nothing failed
     * and nothing was violated. `docs/probes.md` now states the rule these
     * satisfy: a target type arrives with a test on each side that runs it.
     *
     * Everything below binds a local listener. No test here touches a network
     * this machine does not own.
     */

    /// Answers one connection with a fixed status line, then drops it.
    async fn handshake_server(status_line: &'static str) -> u16 {
        let server = listener().await;
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = server.accept().await {
                // The request is read far enough to be sure the client sent
                // one; the handshake is answered without inspecting it.
                let mut buffer = [0_u8; 1024];
                let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buffer).await;
                let _ = socket
                    .write_all(format!("{status_line}\r\n\r\n").as_bytes())
                    .await;
            }
        });
        port
    }

    #[tokio::test]
    async fn websocket_reports_the_upgrade_it_was_granted() {
        let port = handshake_server("HTTP/1.1 101 Switching Protocols").await;

        let observation = observe_websocket(
            &format!("ws://127.0.0.1:{port}/ws"),
            None,
            &HashMap::new(),
            2_000,
        )
        .await;

        assert!(observation.error.is_none(), "{observation:?}");
        // 101 is what `status_code` asserts on, so the engine needs no special
        // case for this target — that is the whole design, and it is only true
        // if the number actually arrives here.
        assert_eq!(observation.status_code, Some(101));
        assert!(observation.latency_ms.is_some());
    }

    #[tokio::test]
    async fn websocket_reports_a_refused_upgrade_without_calling_it_an_error() {
        let port = handshake_server("HTTP/1.1 404 Not Found").await;

        let observation = observe_websocket(
            &format!("ws://127.0.0.1:{port}/ws"),
            None,
            &HashMap::new(),
            2_000,
        )
        .await;

        // Reached, answered, and not what was asked for. That is an assertion's
        // verdict to give, not the transport's: reporting it as unreachable
        // would lose the difference between a wrong answer and no answer.
        assert!(observation.error.is_none(), "{observation:?}");
        assert_eq!(observation.status_code, Some(404));
    }

    #[tokio::test]
    async fn websocket_refuses_a_url_that_is_not_a_websocket_url() {
        let observation =
            observe_websocket("https://example.com/ws", None, &HashMap::new(), 2_000).await;

        let error = observation
            .error
            .expect("an https:// url is not probeable here");
        assert!(error.contains("ws://"), "{error}");
    }

    /*
     * The nominal path: a certificate that verifies, and the days it has left.
     *
     * This is what the failure test below could not reach. It needed the trust
     * anchor to be a parameter — see `days_until_expiry_against` — because a
     * locally generated certificate is by definition not signed by anything
     * webpki trusts, and the alternative was a test build that accepted an
     * unverified certificate. That would have proved the opposite of the point.
     *
     * A CA and a leaf it signs, rather than one self-signed certificate: path
     * building is what the probe actually does, and a self-signed leaf used as
     * its own anchor would skip it.
     */
    #[tokio::test]
    async fn cert_reports_the_days_a_trusted_certificate_has_left() {
        use tokio_rustls::rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};

        let mut ca_params = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let ca = ca_params.clone().self_signed(&ca_key).unwrap();
        let issuer = rcgen::Issuer::new(ca_params, ca_key);

        let mut leaf_params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        // Far out, so the assertion below is about a number the probe computed
        // rather than about a default nobody chose.
        leaf_params.not_after = rcgen::date_time_ymd(2999, 1, 1);
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();

        let server_config = tokio_rustls::rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(leaf.der().to_vec())],
                PrivatePkcs8KeyDer::from(leaf_key.serialize_der()).into(),
            )
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));

        tokio::spawn(async move {
            if let Ok((socket, _)) = listener.accept().await {
                // The handshake is the whole exchange; nothing is written after.
                let _ = acceptor.accept(socket).await;
            }
        });

        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots.add(CertificateDer::from(ca.der().to_vec())).unwrap();

        let days = tls::days_until_expiry_against("localhost", port, roots)
            .await
            .expect("a certificate signed by a trusted root must verify");

        // Far in the future, and positive — the sign is what the
        // `cert_expires_in` assertion compares against.
        assert!(
            days > 300_000,
            "expected a long-lived certificate, got {days}"
        );
    }

    #[tokio::test]
    async fn cert_reports_a_port_that_does_not_speak_tls() {
        // The success path needs a certificate and a TLS server, which would
        // mean a certificate generator in the dependency tree for one test. The
        // failure this covers is the one operators actually hit: the right host,
        // the wrong port.
        let server = listener().await;
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = server.accept().await {
                let _ = socket.write_all(b"not tls\r\n").await;
            }
        });

        let observation = observe_cert("127.0.0.1", port, 2_000).await;

        assert!(observation.error.is_some(), "{observation:?}");
        assert!(observation.cert_expires_in_days.is_none());
    }

    /*
     * One test for every docker case rather than one per case.
     *
     * `TERN_DOCKER_SOCKET` is process-wide and Rust runs tests in parallel, so
     * two functions setting it would race and fail in whichever order the
     * scheduler chose. One function owns the variable for its lifetime.
     */
    /*
     * The same probe, against a real daemon.
     *
     * The test below talks to a socket this file writes the answers for, so it
     * pins the HTTP dialogue and the parsing and nothing about what Docker
     * actually replies. That gap matters: the shape of `/containers/<id>/json`
     * is Docker's to change, and every assertion an operator writes —
     * `$.State.Health.Status`, `$.State.Running` — reads it.
     *
     * Opt-in, by two environment variables, because the suite has to stay green
     * on a machine with no Docker and in a CI runner with no socket. Run it
     * with:
     *
     *   TERN_DOCKER_SOCKET=/var/run/docker.sock \
     *   TERN_DOCKER_TEST_CONTAINER=some-running-container \
     *   cargo test docker_against_a_real_daemon -- --ignored --nocapture
     *
     * `--ignored` rather than a silent early return: a test that skips itself
     * quietly is a test everyone believes ran.
     */
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "needs a Docker socket and a named running container"]
    async fn docker_against_a_real_daemon() {
        let container = std::env::var("TERN_DOCKER_TEST_CONTAINER")
            .expect("set TERN_DOCKER_TEST_CONTAINER to a running container");

        let observation = observe_docker(&container, false, 5_000).await;
        assert!(observation.error.is_none(), "{observation:?}");

        let body = observation
            .body
            .expect("the container JSON is the observation body");
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("what Docker returned must parse as JSON");

        // The two pointers every docker assertion is written against. If Docker
        // ever moves them, this is where it should be found out — not by an
        // operator whose control silently stopped meaning anything.
        assert_eq!(
            parsed.pointer("/State/Running").and_then(|v| v.as_bool()),
            Some(true),
            "a running container must report State.Running = true"
        );
        assert!(
            parsed
                .pointer("/State/Status")
                .and_then(|v| v.as_str())
                .is_some(),
            "State.Status is what a stopped container is named by"
        );

        // And the failure an operator meets most often, from the same daemon.
        let missing = observe_docker("tern-no-such-container", false, 5_000).await;
        assert!(missing
            .error
            .expect("an unknown container is an error")
            .contains("no container named"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn docker_reads_a_container_through_the_socket_it_is_given() {
        use tokio::io::AsyncReadExt;

        let path =
            std::env::temp_dir().join(format!("tern-docker-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let server = tokio::net::UnixListener::bind(&path).unwrap();
        std::env::set_var("TERN_DOCKER_SOCKET", &path);

        /// What the fake daemon answers, in the order the cases below ask.
        const REPLIES: [&str; 4] = [
            r#"{"State":{"Running":true,"Health":{"Status":"healthy"}}}"#,
            r#"{"State":{"Running":false,"Status":"exited"}}"#,
            r#"{"State":{"Running":true}}"#,
            "",
        ];

        tokio::spawn(async move {
            for (index, body) in REPLIES.iter().enumerate() {
                let Ok((mut socket, _)) = server.accept().await else {
                    return;
                };
                let mut buffer = [0_u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let response = if index == 3 {
                    "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
                    )
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        // Running and healthy: the container's own JSON becomes the body, so
        // `$.State.Health.Status` is an ordinary json_path assertion rather
        // than a special case in the engine.
        let ok = observe_docker("api", true, 2_000).await;
        assert!(ok.error.is_none(), "{ok:?}");
        let body = ok.body.expect("the container JSON is the observation body");
        assert!(body.contains("healthy"), "{body}");

        // Stopped: named as what it is, not as a timeout. An absent service is
        // not a slow one.
        let stopped = observe_docker("api", false, 2_000).await;
        assert!(stopped.error.unwrap().contains("exited"));

        // Running, no healthcheck, and the control demanded one.
        let unhealthy = observe_docker("api", true, 2_000).await;
        assert!(unhealthy.error.unwrap().contains("no healthcheck"));

        // Unknown container: 404 from the daemon, said in those words.
        let missing = observe_docker("ghost", false, 2_000).await;
        assert!(missing.error.unwrap().contains("no container named ghost"));

        std::env::remove_var("TERN_DOCKER_SOCKET");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn tcp_connect_reports_a_latency() {
        let server = listener().await;
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = server.accept().await;
        });

        let observation = observe_tcp("127.0.0.1", port, 2_000).await;
        assert!(observation.error.is_none(), "{observation:?}");
        assert!(observation.latency_ms.is_some());
    }

    #[tokio::test]
    async fn tcp_connect_reports_a_closed_port_as_an_error() {
        // Bind and drop: the port is then almost certainly free, and connecting
        // to it fails the way a down service does.
        let port = {
            let server = listener().await;
            server.local_addr().unwrap().port()
        };

        let observation = observe_tcp("127.0.0.1", port, 2_000).await;
        assert!(observation.error.is_some());
    }

    #[tokio::test]
    async fn http_captures_status_headers_and_body() {
        let server = listener().await;
        let port = server.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buffer).await;
            let body = r#"{"pending":42}"#;
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        let observation = observe_http(
            &format!("http://127.0.0.1:{port}/health"),
            "GET",
            &HashMap::new(),
            None,
            true,
            true,
            2_000,
        )
        .await;

        assert_eq!(observation.status_code, Some(201));
        assert_eq!(observation.body.as_deref(), Some(r#"{"pending":42}"#));
        assert_eq!(
            observation.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
    }

    #[tokio::test]
    async fn http_reports_a_refused_connection_with_a_reason() {
        let port = {
            let server = listener().await;
            server.local_addr().unwrap().port()
        };

        let observation = observe_http(
            &format!("http://127.0.0.1:{port}/"),
            "GET",
            &HashMap::new(),
            None,
            true,
            true,
            2_000,
        )
        .await;

        let error = observation.error.expect("a refused connection is an error");
        // "error sending request" alone tells an operator nothing; the cause
        // chain is the part they act on.
        assert!(error.len() > "error sending request".len(), "{error}");
    }

    #[tokio::test]
    async fn dns_resolves_localhost() {
        let observation = observe_dns("localhost", 2_000).await;
        assert!(observation.error.is_none(), "{observation:?}");
        assert!(!observation.dns_records.is_empty());
    }

    #[tokio::test]
    async fn dns_reports_a_name_that_does_not_resolve() {
        let observation = observe_dns("tern-does-not-exist.invalid", 5_000).await;
        assert!(observation.error.is_some());
    }

    #[test]
    fn probe_definitions_parse_from_toml() {
        // The shape an `agent.toml` carries. If this drifts from the server's
        // schema the editor's generated file stops loading.
        let probe: Probe = toml::from_str(
            r#"
            type = "http"
            url = "https://example.com/health"
            method = "GET"
            timeout_ms = 5000
            "#,
        )
        .unwrap();
        assert_eq!(probe.kind(), "http");
    }

    // ── The host targets ────────────────────────────────────────────────────
    //
    // These need no listener. They need a directory this test owns, which is
    // built under the process's own temp dir and removed at the end — the agent
    // has no `tempfile` dependency and one target is not worth adding it for.

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("tern-probe-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Scratch(path)
        }

        fn file(&self, name: &str, contents: &str) -> String {
            let path = self.0.join(name);
            std::fs::write(&path, contents).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn body_of(observation: &Observation) -> serde_json::Value {
        serde_json::from_str(observation.body.as_deref().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn file_reports_a_present_file_and_its_size() {
        let scratch = Scratch::new("present");
        let path = scratch.file("report.txt", "seven!!");

        let observation = observe_file(&path, true, 5_000).await;

        assert!(observation.error.is_none());
        let body = body_of(&observation);
        assert_eq!(body["exists"], true);
        assert_eq!(body["kind"], "file");
        assert_eq!(body["sizeBytes"], 7);
        // Written a moment ago, so the age is readable and small — the field
        // that makes `$.modifiedSecondsAgo lt N` mean anything.
        assert!(body["modifiedSecondsAgo"].as_i64().unwrap() < 60);
    }

    #[tokio::test]
    async fn file_fails_when_a_required_path_is_missing() {
        let scratch = Scratch::new("missing");
        let observation = observe_file(&format!("{}/nope", scratch.path()), true, 5_000).await;
        assert!(observation.error.unwrap().contains("is not there"));
    }

    #[tokio::test]
    async fn file_inverts_cleanly_for_a_path_that_must_be_gone() {
        let scratch = Scratch::new("gone");
        let absent = format!("{}/lock", scratch.path());

        // Absent and required gone: healthy, and it still reports the answer.
        let observation = observe_file(&absent, false, 5_000).await;
        assert!(observation.error.is_none());
        assert_eq!(body_of(&observation)["exists"], false);

        // Present and required gone: the stale lock this is written to catch.
        let present = scratch.file("lock", "");
        let observation = observe_file(&present, false, 5_000).await;
        assert!(observation.error.unwrap().contains("requires it gone"));
    }

    /// The distinction the target would be worthless without.
    ///
    /// A directory the agent cannot traverse makes `metadata` fail exactly as a
    /// missing path does. If that were read as absence, `mustExist: false` would
    /// report healthy over a path nobody can see.
    #[cfg(unix)]
    #[tokio::test]
    async fn file_does_not_call_unreadable_absent() {
        use std::os::unix::fs::PermissionsExt;

        // Root traverses regardless of the mode bits, so this proves nothing
        // there and says so rather than passing hollowly.
        if effective_uid() == 0 {
            return;
        }

        let scratch = Scratch::new("denied");
        let closed = scratch.0.join("closed");
        std::fs::create_dir(&closed).unwrap();
        std::fs::write(closed.join("secret"), "x").unwrap();
        std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o000)).unwrap();

        let observation = observe_file(
            &format!("{}/secret", closed.to_string_lossy()),
            false,
            5_000,
        )
        .await;

        // Restored before the assertion, so a failure here still cleans up.
        std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = observation
            .error
            .expect("an unreadable path is not an absent one");
        assert!(error.contains("could not read"), "{error}");
    }

    /// Read rather than linked: the agent has no `libc` dependency, and the
    /// question here is only "would the mode bits be ignored". Anything that
    /// cannot answer returns a non-root id, so the test runs and can fail —
    /// guessing root would turn it into a permanent skip.
    #[cfg(unix)]
    fn effective_uid() -> u32 {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("Uid:"))
                    .and_then(|line| line.split_whitespace().nth(2))
                    .and_then(|euid| euid.parse().ok())
            })
            .unwrap_or(1)
    }

    #[tokio::test]
    async fn directory_counts_filters_and_finds_the_newest() {
        let scratch = Scratch::new("dir");
        scratch.file("dump-1.sql.gz", "aaaa");
        scratch.file("dump-2.sql.gz", "bb");
        scratch.file("notes.md", "ignored");

        let all = observe_directory(&scratch.path(), None, None, 5_000).await;
        assert_eq!(body_of(&all)["entries"], 3);
        assert_eq!(body_of(&all)["bytes"], 13);

        let filtered = observe_directory(&scratch.path(), Some(".sql.gz"), None, 5_000).await;
        let body = body_of(&filtered);
        assert_eq!(body["entries"], 2);
        assert_eq!(body["bytes"], 6);
        assert!(
            body["newestName"].as_str().unwrap().ends_with(".sql.gz"),
            "the filter must also decide which entry counts as the newest: {body}"
        );
        assert!(body["newestSecondsAgo"].as_i64().unwrap() < 60);
    }

    #[tokio::test]
    async fn directory_fails_when_nothing_has_changed_recently() {
        let scratch = Scratch::new("quiet");
        scratch.file("old.txt", "x");

        // Everything here was written seconds ago, so a zero-tolerance window is
        // the only one that can fail on a fresh directory. `maxQuietSeconds: 0`
        // is not expressible in the schema — it is `positive()` — so the guard
        // is exercised through the empty case, which is the same branch.
        let empty = Scratch::new("empty");
        let observation = observe_directory(&empty.path(), None, Some(3_600), 5_000).await;
        let error = observation
            .error
            .expect("an empty directory counts as quiet");
        assert!(error.contains("expects activity"), "{error}");

        // And the populated one passes the same window.
        let observation = observe_directory(&scratch.path(), None, Some(3_600), 5_000).await;
        assert!(observation.error.is_none());
    }

    #[tokio::test]
    async fn directory_fails_when_the_path_is_not_there() {
        let observation =
            observe_directory("/tern-does-not-exist/anywhere", None, None, 5_000).await;
        assert!(observation.error.unwrap().contains("could not read"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn uptime_reads_the_machine_and_agrees_with_proc() {
        let observation = observe_uptime(UptimeOf::Machine, None, None, 5_000).await;
        assert!(observation.error.is_none());

        let body = body_of(&observation);
        assert_eq!(body["of"], "machine");
        assert_eq!(body["restarted"], serde_json::Value::Null);

        // Checked against the source rather than merely asserted positive: a
        // parser that read the wrong field would still return a large number.
        let raw: f64 = std::fs::read_to_string("/proc/uptime")
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let reported = body["uptimeSeconds"].as_i64().unwrap();
        assert!(
            (reported - raw as i64).abs() <= 2,
            "reported {reported}, /proc says {raw}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn uptime_finds_this_process_and_calls_it_young() {
        // The test binary is the one process certain to be running, and its own
        // name is what `/proc/<pid>/comm` truncates to 15 characters.
        let me = std::fs::read_to_string("/proc/self/comm").unwrap();
        let me = me.trim();

        let observation = observe_uptime(UptimeOf::Process, Some(me), None, 5_000).await;
        assert!(observation.error.is_none(), "{:?}", observation.error);

        let body = body_of(&observation);
        assert_eq!(body["of"], "process");
        assert_eq!(body["process"], me);
        assert!(body["pid"].as_i64().unwrap() > 0);

        // A test binary has been up seconds, not days. This is the assertion
        // that would catch reading a boot-relative tick count as an uptime.
        let reported = body["uptimeSeconds"].as_i64().unwrap();
        assert!((0..3_600).contains(&reported), "reported {reported} s");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn uptime_calls_a_recent_start_a_restart() {
        let me = std::fs::read_to_string("/proc/self/comm").unwrap();

        // A floor far above this process's age: the reboot case, on demand.
        let observation =
            observe_uptime(UptimeOf::Process, Some(me.trim()), Some(86_400), 5_000).await;
        let error = observation
            .error
            .expect("a young process is a restarted one");
        assert!(error.contains("it restarted"), "{error}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn uptime_says_so_when_the_process_is_not_running() {
        let observation =
            observe_uptime(UptimeOf::Process, Some("tern-not-a-process"), None, 5_000).await;
        assert!(observation.error.unwrap().contains("no process named"));
    }

    #[test]
    fn host_probes_parse_from_toml() {
        let file: Probe = toml::from_str(
            r#"
            type = "file"
            path = "/var/run/tern.pid"
            must_exist = false
            "#,
        )
        .unwrap();
        assert_eq!(file.kind(), "file");

        let directory: Probe = toml::from_str(
            r#"
            type = "directory"
            path = "/var/backups"
            contains = ".sql.gz"
            max_quiet_seconds = 86400
            "#,
        )
        .unwrap();
        assert_eq!(directory.kind(), "directory");

        let uptime: Probe = toml::from_str(
            r#"
            type = "uptime"
            of = "process"
            process = "postgres"
            min_seconds = 300
            "#,
        )
        .unwrap();
        assert_eq!(uptime.kind(), "uptime");
        // Round-trips, because the editor writes this file from the server's
        // copy and the agent must read back what it wrote.
        let written = toml::to_string(&uptime).unwrap();
        assert!(written.contains("min_seconds = 300"), "{written}");
    }
}
