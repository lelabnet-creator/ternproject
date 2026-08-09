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
}
