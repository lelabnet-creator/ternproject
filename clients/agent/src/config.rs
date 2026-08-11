//! `agent.toml` — what an agent monitors, and how it reaches the server.
//!
//! A file rather than flags, because the thing that runs an agent is usually a
//! service unit written once and never read again. It has to be reviewable by
//! someone who did not write it, which means the probes are declarative and the
//! credential is the only secret in it.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::probe::Assertion;
use crate::probe_transport::Probe;
use crate::transport::Job;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    pub server: String,
    pub api_key: String,

    /**
     * What this install is, across re-pairings.
     *
     * Generated here on the first pair and kept in the file afterwards. Sent
     * back on every pair, so the server can tell "this machine again" from "a
     * new machine" — which it otherwise cannot: pairing only ever carried a
     * hostname, an OS and an architecture, so re-running an installer inserted
     * a second row and the fleet grew a twin of a machine that had not moved.
     *
     * Deliberately not derived from anything about the host. A machine id would
     * be wrong in both directions: two agents on one host are two installs and
     * would collapse into one, and two VMs cloned from an image share theirs
     * and would collapse a real fleet into a single row. What identifies an
     * install is its config file, so the identifier lives in the config file.
     *
     * Optional because a config written by an older version has none, and one
     * pairing without it must still work — it simply gets a row of its own,
     * which is what happened before this existed.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,

    /// Seconds between runs. Applies to every probe that does not override it.
    #[serde(default = "default_interval")]
    pub interval_s: u64,

    /// Skipped when empty, and this is not cosmetic: `toml` writes an empty
    /// vector as `probes = []`, after which appending the `[[probes]]` block the
    /// pair command tells you to add is a parse error. The file has to be
    /// extendable the way its own instructions say.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub probes: Vec<ProbeEntry>,

    /// The local page, when one is wanted. Absent means no page is served.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiSettings>,

    /**
     * Told to stop measuring, and how far that goes.
     *
     * Two states rather than one, and the difference is what stays listening.
     *
     * `Paused` runs no probes but keeps talking to the server, so the console
     * can undo it. `Stopped` talks to nothing at all, which is what makes it
     * final: nothing is left to hear a resume, and getting the machine back
     * needs a shell on it — `tern-agent resume`. The console says exactly that
     * before asking for it.
     *
     * Written to the config rather than held in memory because the supervisor
     * restarts this process on any exit. A state that lived only in the process
     * would be undone by the very thing that keeps the agent alive, five
     * seconds later, silently.
     */
    #[serde(default, skip_serializing_if = "Running::is_default")]
    pub state: Running,
}

/// Whether this agent is working, and if not, how far it was told to stop.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Running {
    #[default]
    Active,
    /// No probes, still reporting. Reversible from the console.
    Paused,
    /// Nothing at all. Reversible only from a shell on the machine.
    Stopped,
}

impl Running {
    fn is_default(&self) -> bool {
        *self == Running::Active
    }

    /// Whether probes run.
    pub fn measures(&self) -> bool {
        *self == Running::Active
    }

    /// Whether it still talks to the server — and so whether the console can
    /// still reach it. This is the whole difference between the two.
    pub fn reports(&self) -> bool {
        *self != Running::Stopped
    }
}

/// Settings for the page an agent serves about itself.
///
/// Opt-in: an agent that nobody asked for a page from opens no listener at all.
/// A monitoring agent binding a port by default is a port on every machine in
/// somebody's estate, decided by us rather than by them.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UiSettings {
    /// Defaults to loopback. See the module note on `ui` for why the page is
    /// not something to put on an interface without meaning to.
    #[serde(default = "default_ui_listen")]
    pub listen: String,
    /// Absent means the page is served without asking, which is only sensible
    /// on loopback — and `tern-agent ui` says so when it is not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<crate::ui::Credential>,
}

fn default_ui_listen() -> String {
    "127.0.0.1:38788".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProbeEntry {
    /// The control this feeds. Must match a control key on the server, or the
    /// server rejects the point by name and keeps the rest of the batch.
    pub control_key: String,

    #[serde(flatten)]
    pub probe: Probe,

    #[serde(default)]
    pub assertions: Vec<Assertion>,

    /// Overrides the file-level interval for one probe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_s: Option<u64>,

    /// True when the server assigned this probe.
    ///
    /// The distinction is what lets the agent adopt a changed assignment without
    /// deleting a probe someone added by hand on the host. Absent in a
    /// hand-written file, which is exactly right: what an operator wrote is
    /// theirs, and the agent does not take it over.
    #[serde(default, skip_serializing_if = "is_false")]
    pub managed: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_interval() -> u64 {
    60
}

/// Appended to a freshly paired config, commented out.
///
/// A config with no probes does nothing, and the shape of a probe is the one
/// thing someone cannot guess. Showing it in place beats sending them to a page.
const EXAMPLE_PROBE: &str = r#"
# Each probe feeds one control. `control_key` must match a control on the
# server — an unknown key is reported back by name rather than guessed at.
#
# [[probes]]
# control_key = "api-gateway"
# type = "http"
# url = "https://example.com/health"
# timeout_ms = 5000
#
#   [[probes.assertions]]
#   type = "status_code"
#   eq = 200
#
#   [[probes.assertions]]
#   type = "latency"
#   ms = 800
#   severity = "degraded"
"#;

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("could not read {}", path.display()))?;
        let config: Config = toml::from_str(&raw)
            .with_context(|| format!("{} is not a valid agent config", path.display()))?;

        if config.api_key.trim().is_empty() {
            bail!("api_key is empty — run `tern-agent pair` to obtain one");
        }
        if config.interval_s < 5 {
            // Below this an agent is a load generator, not a monitor.
            bail!("interval_s must be at least 5 seconds");
        }
        Ok(config)
    }

    /// Writes the file with owner-only permissions.
    ///
    /// The key inside is a live ingest credential. Writing it 0644 into a
    /// directory somebody later tars up is the ordinary way these leak, so the
    /// permissions are set before the content is written, not after.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("could not create {}", parent.display()))?;
            }
        }

        let mut body = toml::to_string_pretty(self).context("could not serialise the config")?;
        if self.probes.is_empty() {
            body.push_str(EXAMPLE_PROBE);
        }
        write_private(path, &body)
            .with_context(|| format!("could not write {}", path.display()))?;
        Ok(())
    }

    pub fn interval_for(&self, entry: &ProbeEntry) -> u64 {
        entry.interval_s.unwrap_or(self.interval_s).max(5)
    }

    /// Turns the server's assignment into probes this file can hold.
    ///
    /// A job the agent cannot represent — a probe type from a newer server — is
    /// skipped by name rather than aborting the whole set. Pairing that fails
    /// entirely because one of nine probes is unfamiliar would be a poor trade.
    pub fn apply_jobs(&mut self, jobs: &[Job]) -> Vec<String> {
        let mut skipped = Vec::new();

        // Only the server's own probes are replaced. A probe an operator added
        // to the file stays: the server never assigned it, so it is not the
        // server's to remove.
        self.probes.retain(|entry| !entry.managed);

        for job in jobs {
            let probe: Probe = match serde_json::from_value(job.probe.clone()) {
                Ok(probe) => probe,
                Err(error) => {
                    skipped.push(format!("{} ({error})", job.control_key));
                    continue;
                }
            };

            let assertions: Vec<Assertion> = job
                .assertions
                .iter()
                .filter_map(|value| serde_json::from_value(value.clone()).ok())
                .collect();

            self.probes.push(ProbeEntry {
                control_key: job.control_key.clone(),
                probe,
                assertions,
                interval_s: job.interval_s,
                managed: true,
            });
        }

        skipped
    }

    /// What the server assigns that this file does not already run.
    ///
    /// Compared by control key rather than by deep equality: the question at
    /// startup is "is there something new for me", and re-reporting a probe
    /// whose timeout changed by a millisecond as "new" would make the message
    /// noise an operator learns to ignore.
    pub fn new_control_keys(&self, jobs: &[Job]) -> Vec<String> {
        jobs.iter()
            .filter(|job| !self.probes.iter().any(|p| p.control_key == job.control_key))
            .map(|job| job.control_key.clone())
            .collect()
    }

    /// Controls the server draws as a measurement but whose probe captures none.
    ///
    /// This is the failure where everything reports success: the script runs,
    /// the push is accepted, and the chart stays empty because no assertion ever
    /// produced a value. Worth a warning at pairing, when it is cheap to fix.
    pub fn measurement_gaps(jobs: &[Job]) -> Vec<String> {
        jobs.iter()
            .filter(|job| job.payload_shape.as_deref() == Some("value"))
            .filter(|job| {
                !job.assertions.iter().any(|assertion| {
                    assertion
                        .get("capture")
                        .and_then(|c| c.as_bool())
                        .unwrap_or(false)
                })
            })
            .map(|job| job.control_key.clone())
            .collect()
    }
}

#[cfg(unix)]
pub(crate) fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body.as_bytes())
}

#[cfg(not(unix))]
pub(crate) fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    // Windows inherits the directory ACL. The agent is normally installed under
    // ProgramData or a service account's profile, where that is the intended
    // answer; there is no portable equivalent of 0600 to apply here.
    std::fs::write(path, body)
}

/// Where the config lives when nobody says.
///
/// The standard XDG location, the same path the installer writes to and points
/// the service at — not a bare `agent.toml` relative to the current directory.
///
/// The relative form was a quiet trap. The service runs with an explicit
/// `--config`, so it always read the right file; but a `pair`, `doctor` or
/// `run` typed by hand, without the flag, resolved `agent.toml` against the
/// shell's working directory instead. Pairing from a home directory then wrote
/// a perfectly valid key into `~/agent.toml` while the service went on reading
/// `~/.config/tern/agent.toml` with its old, now-revoked key — and reported a
/// 401 on every call, from a config the person had every reason to believe they
/// had just refreshed. Measured on a real machine before it was believed.
///
/// Root gets `/etc/tern`, everyone else `$XDG_CONFIG_HOME/tern` (or
/// `~/.config/tern`), mirroring `CONF_DIR` in `apps/api/src/routes/download.ts`
/// exactly. The two must agree, because the whole point is that the hand-typed
/// command and the installed service name the same file.
pub fn default_path() -> PathBuf {
    config_dir().join("agent.toml")
}

/// The directory the config lives in, by the same rule the installer follows.
pub fn config_dir() -> PathBuf {
    // Effective UID 0 is root, and root's config is `/etc/tern` — a system
    // service is not installed under some user's home.
    if is_root() {
        return PathBuf::from("/etc/tern");
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("tern");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".config").join("tern");
        }
    }
    // No HOME and not root is close to impossible for an interactive command,
    // but falling back to the working directory keeps the old behaviour rather
    // than panicking — a bad config path is a better error than no start.
    PathBuf::from(".")
}

/// Whether this process is root, read from `/proc` rather than linked.
///
/// The agent carries no `libc` dependency, and this is the one place it needs
/// the effective uid. Anything it cannot read answers "not root", which errs
/// towards the user path — the safe direction, since it never claims `/etc`.
fn is_root() -> bool {
    #[cfg(unix)]
    {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("Uid:"))
                    .and_then(|line| line.split_whitespace().nth(2))
                    .and_then(|euid| euid.parse::<u32>().ok())
            })
            .map(|euid| euid == 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
server = "https://status.example.com"
api_key = "tern_abc123"
interval_s = 30

[[probes]]
control_key = "api-gateway"
type = "http"
url = "https://example.com/health"

  [[probes.assertions]]
  type = "status_code"
  eq = 200

[[probes]]
control_key = "db"
type = "tcp"
host = "db.internal"
port = 5432
interval_s = 120
"#;

    #[test]
    fn reads_probes_and_their_assertions() {
        let dir = std::env::temp_dir().join(format!("tern-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(&path, SAMPLE).unwrap();

        let config = Config::load(&path).unwrap();
        assert_eq!(config.probes.len(), 2);
        assert_eq!(config.probes[0].control_key, "api-gateway");
        assert_eq!(config.probes[0].assertions.len(), 1);
        assert_eq!(config.probes[0].probe.kind(), "http");

        // Per-probe overrides, so one slow check does not set the pace for all.
        assert_eq!(config.interval_for(&config.probes[0]), 30);
        assert_eq!(config.interval_for(&config.probes[1]), 120);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_config_with_no_key_rather_than_pushing_anonymously() {
        let dir = std::env::temp_dir().join(format!("tern-cfg-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(&path, "server = \"https://x.example\"\napi_key = \"\"\n").unwrap();

        let error = Config::load(&path).unwrap_err().to_string();
        assert!(error.contains("pair"), "{error}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_an_interval_that_would_make_it_a_load_generator() {
        let dir = std::env::temp_dir().join(format!("tern-cfg-fast-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(
            &path,
            "server = \"https://x.example\"\napi_key = \"k\"\ninterval_s = 1\n",
        )
        .unwrap();

        assert!(Config::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_commented_example_in_a_fresh_config_actually_parses() {
        // It is the first thing an operator uncomments. An example that does not
        // load teaches them the format is wrong when in fact only the example
        // was — and this one really did ship with `lt` where it wanted `ms`.
        // Uncomment the TOML, leaving the prose above it where it is.
        let uncommented: String = EXAMPLE_PROBE
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim_start().strip_prefix('#')?.trim();
                (trimmed.starts_with('[') || trimmed.contains(" = "))
                    .then(|| format!("{trimmed}\n"))
            })
            .collect();

        let config: Config = toml::from_str(&format!(
            "server = \"https://x.example\"\napi_key = \"k\"\n{uncommented}"
        ))
        .expect("the example a fresh config ships with must load");
        assert_eq!(config.probes.len(), 1);
        assert_eq!(config.probes[0].assertions.len(), 2);
    }

    #[test]
    fn a_freshly_written_config_can_be_extended_the_way_it_says_to() {
        // The pair command tells the operator to add a [[probes]] section. If
        // the file it just wrote contains `probes = []`, doing exactly that is a
        // parse error — and the first thing they try fails.
        let dir = std::env::temp_dir().join(format!("tern-cfg-ext-{}", std::process::id()));
        let path = dir.join("agent.toml");

        Config {
            server: "https://status.example.com".into(),
            api_key: "tern_secret".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        }
        .save(&path)
        .unwrap();

        let mut written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("probes = []"), "{written}");

        written.push_str(
            "\n[[probes]]\ncontrol_key = \"api\"\ntype = \"tcp\"\nhost = \"h\"\nport = 443\n",
        );
        std::fs::write(&path, written).unwrap();

        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.probes.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    /// The config path is absolute and matches where the installer writes.
    ///
    /// The bug this pins: a relative `agent.toml` meant a hand-typed `pair`
    /// wrote to the working directory while the service read
    /// `~/.config/tern/agent.toml`, and every call after that was a 401 from a
    /// stale key. The two must name the same file.
    #[test]
    fn the_default_path_is_the_xdg_location_not_the_cwd() {
        // Not root, with a known HOME: the ordinary case for a hand-typed
        // command. `XDG_CONFIG_HOME` unset falls through to `~/.config`.
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::set_var("HOME", "/home/someone");
        // Only meaningful off root; the CI and dev machines run as a user.
        if !is_root() {
            assert_eq!(
                default_path(),
                PathBuf::from("/home/someone/.config/tern/agent.toml")
            );
            assert!(
                default_path().is_absolute(),
                "a relative path is the trap this fixes"
            );
        }

        std::env::set_var("XDG_CONFIG_HOME", "/custom/xdg");
        if !is_root() {
            assert_eq!(config_dir(), PathBuf::from("/custom/xdg/tern"));
        }
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn saves_the_credential_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tern-cfg-perm-{}", std::process::id()));
        let path = dir.join("agent.toml");

        let config = Config {
            server: "https://status.example.com".into(),
            api_key: "tern_secret".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };
        config.save(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "the config holds a live ingest key");

        // And it must round-trip: a file we write has to be one we can read.
        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.api_key, "tern_secret");

        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;
    use crate::transport::Job;

    fn job(control_key: &str, probe: serde_json::Value) -> Job {
        Job {
            control_key: control_key.to_string(),
            interval_s: Some(45),
            probe,
            assertions: vec![serde_json::json!({ "type": "status_code", "eq": 200 })],
            payload_shape: Some("status".into()),
        }
    }

    #[test]
    fn turns_the_servers_assignment_into_probes() {
        let mut config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };

        let skipped = config.apply_jobs(&[job(
            "api",
            serde_json::json!({ "type": "http", "url": "https://example.com/health" }),
        )]);

        assert!(skipped.is_empty());
        assert_eq!(config.probes.len(), 1);
        assert_eq!(config.probes[0].control_key, "api");
        assert_eq!(config.probes[0].assertions.len(), 1);
        // The per-job interval survives, or every agent would run everything at
        // the file's pace regardless of what the control asked for.
        assert_eq!(config.interval_for(&config.probes[0]), 45);
    }

    #[test]
    fn keeps_a_hand_written_probe_when_the_assignment_changes() {
        // The server owns what it assigned. A probe an operator added on the
        // host is not the server's to delete, and silently losing it would make
        // the refresh something people disable.
        let mut config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: vec![ProbeEntry {
                control_key: "local-thing".into(),
                probe: Probe::Tcp {
                    host: "127.0.0.1".into(),
                    port: 9000,
                    timeout_ms: 1000,
                },
                assertions: Vec::new(),
                interval_s: None,
                managed: false,
            }],
            ui: None,
        };

        config.apply_jobs(&[job(
            "api",
            serde_json::json!({ "type": "http", "url": "https://example.com/health" }),
        )]);

        let keys: Vec<&str> = config
            .probes
            .iter()
            .map(|p| p.control_key.as_str())
            .collect();
        assert!(keys.contains(&"local-thing"), "{keys:?}");
        assert!(keys.contains(&"api"), "{keys:?}");
    }

    #[test]
    fn replaces_its_own_previous_assignment_rather_than_accumulating_it() {
        let mut config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };

        let first = job(
            "api",
            serde_json::json!({ "type": "tcp", "host": "h", "port": 1 }),
        );
        config.apply_jobs(&[first]);
        config.apply_jobs(&[job(
            "api",
            serde_json::json!({ "type": "tcp", "host": "h", "port": 2 }),
        )]);

        // Otherwise a restart a day doubles the probe list.
        assert_eq!(config.probes.len(), 1);
    }

    #[test]
    fn reports_only_what_is_actually_new() {
        let mut config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };
        let existing = job(
            "api",
            serde_json::json!({ "type": "tcp", "host": "h", "port": 1 }),
        );
        config.apply_jobs(std::slice::from_ref(&existing));

        let added = config.new_control_keys(&[
            existing,
            job(
                "new-one",
                serde_json::json!({ "type": "tcp", "host": "h", "port": 2 }),
            ),
        ]);

        // A probe whose timeout moved by a millisecond is not news; a control
        // that was not there before is.
        assert_eq!(added, vec!["new-one".to_string()]);
    }

    #[test]
    fn skips_a_probe_it_cannot_represent_rather_than_refusing_them_all() {
        // A newer server may assign a probe type this binary predates. Failing
        // the whole pairing over one of nine would be a poor trade.
        let mut config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };

        let skipped = config.apply_jobs(&[
            job(
                "known",
                serde_json::json!({ "type": "tcp", "host": "h", "port": 443 }),
            ),
            job(
                "future",
                serde_json::json!({ "type": "quantum", "spooky": true }),
            ),
        ]);

        assert_eq!(config.probes.len(), 1);
        assert_eq!(config.probes[0].control_key, "known");
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].starts_with("future"), "{skipped:?}");
    }

    #[test]
    fn names_a_control_drawn_as_a_measurement_whose_probe_captures_nothing() {
        // The failure where every part reports success and the chart stays
        // empty. Saying it at pairing is the cheapest moment to fix it.
        let mut silent = job(
            "queue-depth",
            serde_json::json!({ "type": "http", "url": "https://e.example" }),
        );
        silent.payload_shape = Some("value".into());

        let mut capturing = silent.clone();
        capturing.control_key = "sessions".into();
        capturing.assertions = vec![serde_json::json!({
            "type": "json_path", "path": "$.sessions", "capture": true
        })];

        let gaps = Config::measurement_gaps(&[silent, capturing]);
        assert_eq!(gaps, vec!["queue-depth".to_string()]);
    }
}

impl UiSettings {
    /// Where this page can be reached from elsewhere, if it can be at all.
    ///
    /// Two questions, and the first one settles most cases. A page bound to
    /// loopback is reachable from exactly one machine — the one serving it — so
    /// there is no address to give the admin and saying nothing is the honest
    /// answer. It is also the default, which is deliberate: a monitoring agent
    /// should not put a port on an interface because somebody forgot to say
    /// otherwise.
    ///
    /// When it is bound wider, the port is known but the host is not: `0.0.0.0`
    /// means every interface, and which one an operator's browser can use is
    /// not something the agent can decide. What it *can* say is which of its
    /// interfaces reaches TERN — the routing table is asked, no packet is sent
    /// — and that one is a good answer, because the console asking the question
    /// is served from the machine at the other end of exactly that path.
    ///
    /// An explicit host is taken as given: somebody who wrote an address meant
    /// it, and second-guessing them would be worse than trusting them.
    pub fn reachable_address(&self, upstream: &str) -> Option<String> {
        let (host, port) = self.listen.rsplit_once(':')?;
        let host = host.trim_start_matches('[').trim_end_matches(']');

        if is_loopback_host(host) {
            return None;
        }

        if host.is_empty() || host == "0.0.0.0" || host == "*" || host == "::" {
            let outbound = crate::proxy::outbound_address(upstream)?;
            if outbound.is_loopback() {
                return None;
            }
            return Some(format!("{outbound}:{port}"));
        }

        Some(self.listen.clone())
    }
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

#[cfg(test)]
mod ui_address_tests {
    use super::*;

    fn ui(listen: &str) -> UiSettings {
        UiSettings {
            listen: listen.to_string(),
            credential: None,
        }
    }

    /// The default, and the one that matters most.
    ///
    /// A page on loopback is reachable from the machine serving it and nowhere
    /// else, so there is no address to hand the console. Saying nothing is what
    /// stops it offering a link that cannot work — which is exactly what it did
    /// when it guessed from the address a connection arrived from.
    #[test]
    fn loopback_has_no_address_to_give() {
        assert_eq!(
            ui("127.0.0.1:38788").reachable_address("http://x:3000"),
            None
        );
        assert_eq!(
            ui("localhost:38788").reachable_address("http://x:3000"),
            None
        );
        assert_eq!(ui("[::1]:38788").reachable_address("http://x:3000"), None);
    }

    /// An address somebody wrote down is taken as written.
    #[test]
    fn an_explicit_host_is_trusted() {
        assert_eq!(
            ui("192.168.10.4:38788").reachable_address("http://x:3000"),
            Some("192.168.10.4:38788".to_string())
        );
    }

    /// Bound everywhere, the port is known and the host is not — so the
    /// interface that faces the server is asked for, and the port kept.
    #[test]
    fn every_interface_resolves_to_the_one_facing_the_server() {
        // The upstream is unreachable and deliberately so: a connected UDP
        // socket asks the routing table, it does not send anything, so this
        // still yields whichever address would carry the traffic.
        let resolved = ui("0.0.0.0:39999").reachable_address("http://192.0.2.1:3000");
        if let Some(address) = resolved {
            assert!(address.ends_with(":39999"), "kept the port: {address}");
            assert!(
                !address.starts_with("0.0.0.0"),
                "resolved the host: {address}"
            );
            assert!(!address.starts_with("127."), "never loopback: {address}");
        }
        // None is legitimate on a host with no route at all — an isolated
        // machine has no address that reaches a server it cannot see.
    }

    #[test]
    fn a_listen_string_without_a_port_says_nothing() {
        assert_eq!(ui("0.0.0.0").reachable_address("http://x:3000"), None);
    }
}

/// The install identifier already at this path, or a fresh one.
///
/// Read from whatever config is there — an agent's or a relay's, since both
/// carry the same key at the top level — so that re-pairing an install keeps
/// the identity it already had. A path with nothing at it, or a file too old to
/// carry one, gets a new identifier: that is a new install as far as anything
/// here can tell, and inventing continuity would be worse than admitting none.
pub fn install_id_at(path: &Path) -> String {
    #[derive(serde::Deserialize)]
    struct JustTheId {
        install_id: Option<String>,
    }

    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| toml::from_str::<JustTheId>(&raw).ok())
        .and_then(|parsed| parsed.install_id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| crate::transport::random_token(16))
}

#[cfg(test)]
mod install_id_tests {
    use super::*;

    /// A path with nothing at it is a new install, and gets a new identifier.
    #[test]
    fn a_missing_file_makes_a_fresh_one() {
        let dir =
            std::env::temp_dir().join(format!("tern-iid-{}", crate::transport::random_token(8)));
        let a = install_id_at(&dir.join("agent.toml"));
        let b = install_id_at(&dir.join("agent.toml"));
        assert!(!a.is_empty());
        // Two reads of nothing are two new installs, not one: nothing on disk
        // links them, and pretending otherwise would merge unrelated machines.
        assert_ne!(a, b);
    }

    /// The whole point: the same file keeps the same identity.
    #[test]
    fn an_existing_file_keeps_its_identity() {
        let dir =
            std::env::temp_dir().join(format!("tern-iid-{}", crate::transport::random_token(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(
            &path,
            "server = \"https://x\"\napi_key = \"k\"\ninstall_id = \"kept-across-pairings\"\n",
        )
        .unwrap();

        assert_eq!(install_id_at(&path), "kept-across-pairings");
        assert_eq!(install_id_at(&path), "kept-across-pairings");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A config written before this existed carries none, and gets one.
    #[test]
    fn a_config_from_before_this_gets_one() {
        let dir =
            std::env::temp_dir().join(format!("tern-iid-{}", crate::transport::random_token(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        std::fs::write(&path, "server = \"https://x\"\napi_key = \"k\"\n").unwrap();

        assert!(!install_id_at(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A relay's config is read by the same function — both carry it at the top
    /// level, so one reader serves both binaries.
    #[test]
    fn a_relay_config_is_read_the_same_way() {
        let dir =
            std::env::temp_dir().join(format!("tern-iid-{}", crate::transport::random_token(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proxy.toml");
        std::fs::write(
            &path,
            "server = \"https://x\"\napi_key = \"k\"\ninstall_id = \"relay-identity\"\nlisten = \"0.0.0.0:38787\"\n",
        )
        .unwrap();

        assert_eq!(install_id_at(&path), "relay-identity");
        std::fs::remove_dir_all(&dir).ok();
    }
}
