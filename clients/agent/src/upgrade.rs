//! Replacing this binary with the one the server ships.
//!
//! ## Why the machine does it to itself
//!
//! Nothing can reach an agent. They poll, and one behind a relay has no route
//! back at all — so there is no push, no orchestrator, no ssh. The only party
//! that can replace the file is the process running from it, which means the
//! whole of an upgrade happens here: fetch, verify, try, swap, leave.
//!
//! It downloads from the server it already reports to. A zone agent therefore
//! downloads from its relay, which serves the same four routes precisely so
//! that a machine with no route out can still be installed and updated.
//!
//! ## The three things that have to be true before the file moves
//!
//! Replacing a working agent with a broken one is the failure that cannot be
//! undone from here — the thing that would fix it is the thing that just
//! stopped working. So none of this is optimistic:
//!
//! 1. **It is the file the server published.** SHA-256, against the
//!    `SHA256SUMS` the release ships. A truncated download and a tampered one
//!    fail the same check.
//! 2. **It runs on this machine.** The staged copy is executed once, with
//!    `--version`. A binary for the wrong libc or the wrong CPU fails here,
//!    while the working one is still in place — which is the whole reason this
//!    step exists rather than trusting the platform triple.
//! 3. **It is newer.** A server rolled back, or a relay serving a stale mirror,
//!    would otherwise walk an estate backwards one agent at a time.
//!
//! Only then does the file move, and the move itself is a rename within the
//! same directory: atomic, so there is no instant at which the path exists but
//! holds half a binary.

use anyhow::{bail, Context, Result};
use tracing::info;

use crate::transport::Client;

/// The published name of the build this process should be replaced by.
///
/// Worked out here rather than sent by the server, because the machine is the
/// authority on what it can execute — and because the answer has to be the same
/// whether the file comes from TERN or from a relay standing in for it.
///
/// Only musl is built for Linux, and deliberately: a static binary runs on a
/// distribution nobody thought about, which is the entire premise of dropping
/// an agent onto someone else's estate.
pub fn published_name(binary: &str) -> Option<String> {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
        // Everything else is a platform this project does not publish for. Null
        // rather than a guess: a name that does not exist would come back as a
        // 404 the operator has to interpret.
        _ => return None,
    };
    Some(format!("{binary}-{target}"))
}

/// The hash `SHA256SUMS` gives for one file, if it names it at all.
///
/// The format is coreutils': a hex digest, two spaces, the name. Parsed by hand
/// because that is the whole of it, and a dependency to split two fields would
/// weigh more than the format it reads.
fn published_hash(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once("  ")?;
        (file.trim() == name).then(|| hash.trim().to_lowercase())
    })
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// A version as three numbers, for the one comparison this needs.
///
/// Not a semver crate: the only question asked is "is that one further along
/// than this one", the versions being compared are both produced by this
/// project's own CI, and anything unparseable is treated as "cannot tell" and
/// refused rather than guessed at.
fn ordinal(version: &str) -> Option<(u64, u64, u64)> {
    // `0.2.1-rc.1` and `0.2.1 (abcdef)` both reduce to their release part. A
    // prerelease compares equal to its release here, which is the safe way
    // round: it means an upgrade from `0.2.1-rc.1` to `0.2.1` is refused as
    // "already current" rather than performed on a hunch.
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+', ' '])
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// What `tern-agent --version` prints, reduced to the version.
///
/// Clap writes `<name> <version>`. Taking the last whitespace-separated word
/// rather than splitting on the name keeps this working for both binaries.
fn version_printed(stdout: &str) -> Option<String> {
    stdout.split_whitespace().next_back().map(str::to_string)
}

/// What an upgrade did.
pub enum Upgraded {
    /// In place. This process must now end so its supervisor starts the new one.
    Installed { from: String, to: String },
    /// Nothing to do, and why. Not a failure: an operator pressing the button
    /// twice, or a fleet already up to date, should read a sentence rather than
    /// a red box.
    AlreadyCurrent(String),
}

/**
 * Fetches, checks and installs the build the server publishes for this machine.
 *
 * `binary` is `tern-agent` or `tern-proxy` — which of the two this process is.
 * `running` is the version it reports, so the comparison is against what is
 * actually executing rather than what some config claims.
 */
pub async fn install(client: &Client, binary: &str, running: &str) -> Result<Upgraded> {
    let name = published_name(binary).with_context(|| {
        format!(
            "this project publishes no build for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;

    let (_, sums) = client
        .fetch_public("/api/v1/agent/bin/SHA256SUMS")
        .await
        .context("could not fetch the published checksums")?;
    let sums = String::from_utf8_lossy(&sums).into_owned();
    let expected = published_hash(&sums, &name)
        .with_context(|| format!("the server publishes no checksum for {name}"))?;

    let (_, bytes) = client
        .fetch_public(&format!("/api/v1/agent/bin/{name}"))
        .await
        .with_context(|| format!("could not download {name}"))?;

    let actual = digest(&bytes);
    if actual != expected {
        // Named in full on purpose: a mismatch is either a truncated transfer
        // or a file that is not what the release says it is, and which of those
        // it was matters to whoever reads this afterwards.
        bail!("{name} does not match its published checksum (got {actual}, expected {expected})");
    }

    let current = std::env::current_exe().context("could not find this binary on disk")?;
    // Staged beside the running file rather than in a temporary directory: a
    // rename is only atomic within one filesystem, and `/tmp` is very often a
    // different one. It also fails early and honestly when the directory is
    // read-only, which is a legitimate way to deploy an agent.
    let staged = current.with_file_name(format!(
        ".{}.tern-upgrade",
        current
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| binary.to_string())
    ));

    std::fs::write(&staged, &bytes)
        .with_context(|| format!("could not write {}", staged.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("could not make {} executable", staged.display()))?;
    }

    // Run once before trusting it. Everything above proves the bytes are the
    // published ones; only this proves they are bytes this machine can run.
    let proof = match std::process::Command::new(&staged)
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => output,
        other => {
            let _ = std::fs::remove_file(&staged);
            let why = match other {
                Ok(output) => format!(
                    "it exited {} — {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                Err(error) => error.to_string(),
            };
            bail!("the downloaded {binary} does not run on this machine: {why}");
        }
    };

    let installed = version_printed(&String::from_utf8_lossy(&proof.stdout))
        .unwrap_or_else(|| "an unknown version".to_string());

    match (ordinal(running), ordinal(&installed)) {
        (Some(here), Some(there)) if there > here => {}
        (Some(_), Some(_)) => {
            let _ = std::fs::remove_file(&staged);
            return Ok(Upgraded::AlreadyCurrent(format!(
                "this server publishes {installed}, and this agent runs {running} — nothing to do",
            )));
        }
        // Neither side parseable is not a licence to swap. The version is how
        // "did it work" is answered afterwards, and an upgrade nobody can check
        // is one nobody can undo either.
        _ => {
            let _ = std::fs::remove_file(&staged);
            bail!("cannot compare {running} with {installed}, so nothing was replaced");
        }
    }

    replace(&current, &staged)?;
    info!(%binary, from = %running, to = %installed, "replaced this binary with the published build");

    Ok(Upgraded::Installed {
        from: running.to_string(),
        to: installed,
    })
}

/// Puts the staged file where the running one is.
///
/// On Unix a rename over a running executable is fine: the kernel keeps the old
/// inode alive for the process still executing it, which is exactly the process
/// doing the renaming. Windows will not have that — an executable in use cannot
/// be replaced — but it *will* let the running file be renamed out of the way,
/// which comes to the same thing with one more step.
fn replace(current: &std::path::Path, staged: &std::path::Path) -> Result<()> {
    if cfg!(windows) {
        let parked = current.with_extension("tern-old");
        // Left over from a previous upgrade, if the delete below never got to
        // run. Removed first so the rename does not fail on it.
        let _ = std::fs::remove_file(&parked);
        std::fs::rename(current, &parked)
            .with_context(|| format!("could not move {} aside", current.display()))?;

        if let Err(error) = std::fs::rename(staged, current) {
            // Put it back. A machine left with no binary at that path would not
            // come up again, and nothing here could fix it.
            let _ = std::fs::rename(&parked, current);
            return Err(error).with_context(|| format!("could not install {}", current.display()));
        }

        // Best effort: it is still open by this process, so it will refuse
        // until the restart. The next upgrade removes it.
        let _ = std::fs::remove_file(&parked);
        return Ok(());
    }

    std::fs::rename(staged, current)
        .with_context(|| format!("could not install {}", current.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_name_is_the_one_ci_writes() {
        // Whatever this test runs on, the name is one the release actually
        // contains — the same list `services/agent-release.ts` serves from.
        let published = [
            "tern-agent-x86_64-unknown-linux-musl",
            "tern-agent-aarch64-unknown-linux-musl",
            "tern-agent-x86_64-apple-darwin",
            "tern-agent-aarch64-apple-darwin",
            "tern-agent-x86_64-pc-windows-msvc.exe",
        ];
        if let Some(name) = published_name("tern-agent") {
            assert!(published.contains(&name.as_str()), "unpublished: {name}");
        }
        // A relay asks for its own name, never the agent's.
        if let Some(name) = published_name("tern-proxy") {
            assert!(name.starts_with("tern-proxy-"));
        }
    }

    #[test]
    fn a_checksum_is_read_the_way_coreutils_writes_one() {
        let sums = "aaa  tern-agent-x86_64-unknown-linux-musl\nbbb  tern-proxy-x86_64-unknown-linux-musl\n";
        assert_eq!(
            published_hash(sums, "tern-proxy-x86_64-unknown-linux-musl").as_deref(),
            Some("bbb")
        );
        // A name that merely appears inside another is not a match.
        assert_eq!(published_hash(sums, "tern-agent-x86_64"), None);
        assert_eq!(published_hash("", "anything"), None);
    }

    #[test]
    fn versions_compare_as_numbers_rather_than_text() {
        // The comparison text would get wrong, and the reason a tuple is worth
        // the twelve lines: "0.10.0" sorts before "0.9.0" as a string.
        assert!(ordinal("0.10.0") > ordinal("0.9.0"));
        assert!(ordinal("1.0.0") > ordinal("0.99.99"));
        assert_eq!(ordinal("v0.2.1"), ordinal("0.2.1"));
        // A prerelease reduces to its release, so it never reads as newer.
        assert_eq!(ordinal("0.2.1-rc.1"), ordinal("0.2.1"));
        assert_eq!(ordinal("not a version"), None);
    }

    #[test]
    fn the_version_is_taken_off_what_clap_prints() {
        assert_eq!(
            version_printed("tern-agent 0.2.1").as_deref(),
            Some("0.2.1")
        );
        assert_eq!(
            version_printed("tern-proxy 0.2.1\n").as_deref(),
            Some("0.2.1")
        );
        assert_eq!(version_printed("   ").as_deref(), None);
    }
}
