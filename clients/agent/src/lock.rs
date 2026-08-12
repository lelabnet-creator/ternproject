//! One agent per config, enforced rather than hoped for.
//!
//! Two processes sharing one `agent.toml` do real damage, and quietly. They
//! both write it — a refreshed assignment, a rotated key, the local page's
//! password — and the last writer wins with whatever it happened to be holding.
//! That is how an agent that had just been re-paired went back to pointing at
//! an old server: a copy left over from a run by hand kept rewriting the file
//! under the service, and every symptom pointed somewhere else. The version in
//! the fleet is whichever copy spoke last; the page is served by whichever
//! bound the port first; both are perfectly consistent with "the update did not
//! take".
//!
//! So starting takes a lock, and a second start refuses.
//!
//! ## Why `flock` and not a PID file
//!
//! A PID file records an intention; a lock records a fact. The kernel releases
//! an `flock` when the process holding it dies, however it dies — killed,
//! panicked, machine reset — so there is no stale lock to detect, no "is pid
//! 4213 still the same process" heuristic, and nothing to clean up by hand. A
//! PID file needs all three, and gets them wrong the day it matters.
//!
//! The file's *contents* are still written, but only as a courtesy: they let
//! the refusal name who holds it. Nothing depends on them being true.
//!
//! ## What it deliberately does not do
//!
//! It does not stop the other process. A new copy that reaped the running one
//! would be one restart loop away from a fight it always wins and never
//! resolves — and under a supervisor there is nobody to arbitrate. Refusing is
//! the safe half: the copy that is already working keeps working, and the one
//! that would have trampled it says why it stopped.
//!
//! An ordinary update never meets this. `systemctl restart` stops the old
//! process before starting the new, so the lock is free by the time it is
//! asked for.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Held for as long as this process runs. Dropping it releases the lock, so it
/// is kept alive deliberately rather than by accident.
pub struct Lock {
    _file: File,
    path: PathBuf,
}

impl Lock {
    /// Where the lock lives, for a message that has to name it.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Who is already running, as far as the lock file admits.
pub struct Held {
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub since: Option<String>,
}

pub enum Outcome {
    /// Nobody else holds it. Keep this for the life of the process.
    Taken(Lock),
    /// Somebody does, and here is what they said about themselves.
    Busy(Held),
    /// The lock could not be attempted at all — a read-only directory, say.
    ///
    /// Not fatal, and deliberately: an agent that refused to monitor because it
    /// could not create a lock file would trade a rare conflict for a certain
    /// outage. It says so and runs.
    Unavailable(String),
}

/// The lock beside a config, named after it.
pub fn path_for(config: &Path) -> PathBuf {
    config.with_extension("lock")
}

/// Takes the lock for this config, or reports who has it.
#[cfg(unix)]
pub fn take(config: &Path, version: &str) -> Outcome {
    use std::os::unix::io::AsRawFd;

    let path = path_for(config);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) => return Outcome::Unavailable(format!("{}: {error}", path.display())),
    };

    // Non-blocking: the answer wanted here is "is it free", not "wait until it
    // is". Waiting would turn a duplicate start into a process that hangs with
    // no explanation.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if !locked {
        return Outcome::Busy(read_holder(&path));
    }

    /*
     * Written after the lock is held, never before.
     *
     * The contents are a courtesy for the refusal message; writing them first
     * would mean a process that lost the race had already overwritten the
     * winner's name.
     */
    let mut file = file;
    let _ = file.set_len(0);
    let _ = writeln!(
        file,
        "pid={}\nversion={version}\nsince={}",
        std::process::id(),
        now_rfc3339()
    );
    let _ = file.flush();

    Outcome::Taken(Lock { _file: file, path })
}

#[cfg(not(unix))]
pub fn take(config: &Path, _version: &str) -> Outcome {
    // No `flock` here, and inventing a second mechanism for a platform where a
    // stray duplicate is far rarer would be more code than the problem is
    // worth. Said plainly rather than pretended.
    Outcome::Unavailable(format!(
        "no lock on this platform for {}",
        path_for(config).display()
    ))
}

fn read_holder(path: &Path) -> Held {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let field = |name: &str| {
        raw.lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .map(str::to_string)
    };
    Held {
        pid: field("pid").and_then(|v| v.parse().ok()),
        version: field("version"),
        since: field("since"),
    }
}

/// Seconds since the epoch as RFC 3339, without a date library.
fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::transport::epoch_to_rfc3339(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tern-lock-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("agent.toml")
    }

    #[test]
    fn the_first_one_takes_it() {
        let config = scratch("first");
        let Outcome::Taken(lock) = take(&config, "0.2.0") else {
            panic!("expected to take a free lock")
        };
        assert!(lock.path().exists());
        std::fs::remove_dir_all(config.parent().unwrap()).ok();
    }

    #[test]
    fn a_second_one_is_refused_and_told_who_has_it() {
        let config = scratch("second");
        let Outcome::Taken(_held) = take(&config, "0.2.0") else {
            panic!("expected to take a free lock")
        };

        /*
         * From another process, because `flock` is per open file description
         * and the same process re-locking its own would simply succeed. A
         * child running `sh` is the cheapest way to be genuinely somebody else.
         */
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "exec 9<>{} && flock -n 9 && echo free || echo busy",
                path_for(&config).display()
            ))
            .output()
            .expect("sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "busy");

        // And what it would have been told.
        let holder = read_holder(&path_for(&config));
        assert_eq!(holder.pid, Some(std::process::id()));
        assert_eq!(holder.version.as_deref(), Some("0.2.0"));

        std::fs::remove_dir_all(config.parent().unwrap()).ok();
    }

    /// The property a PID file cannot offer: nothing to clean up.
    #[test]
    fn dropping_it_frees_it() {
        let config = scratch("dropped");
        {
            let Outcome::Taken(_lock) = take(&config, "0.2.0") else {
                panic!("expected to take a free lock")
            };
        }

        /*
         * Same process, so this proves the release rather than the exclusion —
         * the cross-process case is covered above.
         *
         * Retried, for a reason worth writing down: an `flock` belongs to the
         * open file description, and a `fork` in another thread duplicates it.
         * Rust opens files close-on-exec, so the child loses it the instant it
         * execs — but between the fork and the exec it holds the lock, and a
         * release that lands in that window is briefly not a release. The test
         * above forks a shell, and these two run concurrently; one run in ten
         * of the whole suite landed exactly there.
         *
         * Bounded rather than blind: a lock that genuinely failed to release
         * still fails this, a second later.
         */
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let outcome = loop {
            match take(&config, "0.2.0") {
                Outcome::Taken(lock) => break Outcome::Taken(lock),
                other if std::time::Instant::now() >= deadline => break other,
                _ => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        };
        match outcome {
            Outcome::Taken(_) => {}
            Outcome::Busy(held) => panic!(
                "still held a second later, by pid={:?} version={:?}",
                held.pid, held.version
            ),
            Outcome::Unavailable(why) => panic!("could not be attempted: {why}"),
        }

        std::fs::remove_dir_all(config.parent().unwrap()).ok();
    }

    #[test]
    fn the_lock_is_named_after_the_config() {
        assert_eq!(
            path_for(Path::new("/etc/tern/agent.toml")),
            PathBuf::from("/etc/tern/agent.lock")
        );
    }
}
