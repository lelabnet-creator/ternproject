//! Redeploying an instance that already exists, and saying whether it needs it.
//!
//! Two modes that share everything except what they do at the end:
//!
//! * `--check` reads the two versions and reports. It starts nothing and
//!   restarts nothing.
//! * `--upgrade-only` deploys the published image over the configuration that
//!   is already there. It asks nothing — which is the point. The ordinary run
//!   is a conversation, and a conversation cannot happen over `ssh host
//!   'sh setup.sh …'`, from a cron entry, or from an orchestrator.
//!
//! `.env` is not rewritten in either. "The same configuration as the initial
//! deployment" is a promise, and the cheapest way to keep it is to not touch
//! the file at all rather than to rewrite it from values read back out of it.
//!
//! What lives here is what can be decided without a machine: which mode was
//! asked for, and what two version strings mean when put side by side. The
//! calls to `docker` are in `main`, next to the rest of the narrative.

use std::cmp::Ordering;

/// What this run was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The ordinary interactive install.
    Install,
    /// Deploy the current image over the existing configuration.
    UpgradeOnly,
    /// Report the two versions and stop.
    Check,
    /// Print the options.
    Help,
}

/// Reads the mode out of the command line.
///
/// Hand-rolled rather than a parser crate, to keep this binary's dependency
/// list short enough to read — it is downloaded and run on somebody else's
/// machine, and every crate in it is one more thing they are trusting.
///
/// An unknown option is refused rather than ignored. The failure it prevents is
/// specific: a mistyped `--upgrade` silently becomes an ordinary interactive
/// install, which on a live instance means being asked to re-answer every
/// question about a configuration that was already correct.
pub fn parse_mode(args: &[String]) -> Result<Mode, String> {
    let mut mode = Mode::Install;

    for arg in args {
        let next = match arg.as_str() {
            "--upgrade-only" => Mode::UpgradeOnly,
            "--check" => Mode::Check,
            "--help" | "-h" => Mode::Help,
            other => return Err(other.to_string()),
        };

        // Two modes on one line is a mistake with two plausible readings, and
        // guessing which was meant is how a check turns into a deployment.
        if mode != Mode::Install && mode != next {
            return Err(arg.to_string());
        }
        mode = next;
    }

    Ok(mode)
}

/// The same image, at whatever tag is newest.
///
/// `--check` has to answer "is there a newer version", and comparing the
/// configured reference against itself cannot: an instance pinned to
/// `…:0.1.13` would pull `0.1.13`, find `0.1.13`, and report itself current
/// for ever. The question is about the newest published image, so the newest
/// published image is what gets fetched — while `--upgrade-only` keeps
/// deploying whatever `.env` names, because pinning a tag is a deliberate act
/// and an upgrade that quietly ignored it would be worse than one that does
/// nothing.
///
/// The tag is what follows the last `:`, and only when no `/` follows it —
/// otherwise `registry.example:5000/tern` loses its port instead of its tag. A
/// reference by digest has no tag to replace, so it gains one.
pub fn latest_ref(image: &str) -> String {
    let name = image.split_once('@').map_or(image, |(name, _)| name);

    match name.rfind(':') {
        Some(at) if !name[at..].contains('/') => format!("{}:latest", &name[..at]),
        _ => format!("{name}:latest"),
    }
}

/// What the two versions mean when read together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Running the newest image that has been published.
    Current,
    /// A newer one exists.
    Update,
    /// One of the two could not be read. Not the same as being current, and
    /// never to be reported as such: an instance that cannot say which version
    /// it runs is the case this product has already shipped once, and it looked
    /// exactly like being up to date.
    Unknown,
}

pub fn verdict(current: Option<&str>, target: Option<&str>) -> Verdict {
    let (Some(current), Some(target)) = (current, target) else {
        return Verdict::Unknown;
    };

    match compare(current, target) {
        Some(Ordering::Less) => Verdict::Update,
        Some(_) => Verdict::Current,
        None => Verdict::Unknown,
    }
}

/// Orders two `X.Y.Z` strings, or says it cannot.
///
/// Numeric field by field, because `0.1.9` sorts after `0.1.10` as text and an
/// upgrade check that reads them as text tells an operator to downgrade. A
/// leading `v` is accepted on either side: the tags carry one and the labels do
/// not, and having them disagree about that would be a bug nobody would look
/// for in a comparison function.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let left = numbers(a)?;
    let right = numbers(b)?;
    Some(left.cmp(&right))
}

fn numbers(version: &str) -> Option<[u64; 3]> {
    let trimmed = version.trim().trim_start_matches('v');
    // Anything after the patch number — a pre-release, build metadata — makes
    // this a version this function has no opinion about, rather than one it
    // quietly rounds down to its first three fields.
    let mut parts = trimmed.split('.');
    let mut out = [0u64; 3];
    for slot in out.iter_mut() {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_argument_is_the_ordinary_install() {
        assert_eq!(parse_mode(&[]), Ok(Mode::Install));
    }

    #[test]
    fn each_mode_is_named_exactly() {
        assert_eq!(
            parse_mode(&args(&["--upgrade-only"])),
            Ok(Mode::UpgradeOnly)
        );
        assert_eq!(parse_mode(&args(&["--check"])), Ok(Mode::Check));
        assert_eq!(parse_mode(&args(&["--help"])), Ok(Mode::Help));
        assert_eq!(parse_mode(&args(&["-h"])), Ok(Mode::Help));
    }

    #[test]
    fn a_mistyped_option_stops_rather_than_installing() {
        // The whole reason this returns a Result. Ignoring an unknown flag
        // would turn `--upgrade` into a full interactive install on a live
        // instance, re-asking every question about a configuration that was
        // already right.
        assert_eq!(parse_mode(&args(&["--upgrade"])), Err("--upgrade".into()));
        assert_eq!(parse_mode(&args(&["--Check"])), Err("--Check".into()));
    }

    #[test]
    fn two_modes_at_once_is_refused() {
        // "Check, and also deploy" has two readings and no safe default.
        assert!(parse_mode(&args(&["--check", "--upgrade-only"])).is_err());
        // The same one twice is not ambiguous, so it is not an error.
        assert_eq!(parse_mode(&args(&["--check", "--check"])), Ok(Mode::Check));
    }

    #[test]
    fn the_newest_image_is_asked_for_by_name() {
        // The case that makes this exist: pinned to a version, an instance
        // would otherwise compare that version against itself and call itself
        // current for ever.
        assert_eq!(
            latest_ref("ghcr.io/lelabnet-creator/ternproject:0.1.13"),
            "ghcr.io/lelabnet-creator/ternproject:latest"
        );
        assert_eq!(latest_ref("tern:local"), "tern:latest");
        assert_eq!(
            latest_ref("ghcr.io/owner/name"),
            "ghcr.io/owner/name:latest"
        );

        // A registry with a port. Splitting on the last colon without looking
        // for the slash after it would take the port off instead of the tag,
        // and produce a reference to a host that does not exist.
        assert_eq!(
            latest_ref("registry.example:5000/tern"),
            "registry.example:5000/tern:latest"
        );
        assert_eq!(
            latest_ref("registry.example:5000/tern:0.1.13"),
            "registry.example:5000/tern:latest"
        );

        // Pinned by digest: there is no tag to replace, so one is added.
        assert_eq!(
            latest_ref("ghcr.io/owner/name@sha256:abc123"),
            "ghcr.io/owner/name:latest"
        );
    }

    #[test]
    fn versions_are_compared_as_numbers_not_as_text() {
        // The case that makes this function exist: as text, `0.1.9` sorts after
        // `0.1.10`, and the check would announce an upgrade as a downgrade.
        assert_eq!(compare("0.1.9", "0.1.10"), Some(Ordering::Less));
        assert_eq!(compare("0.1.10", "0.1.9"), Some(Ordering::Greater));
        assert_eq!(compare("0.1.14", "0.1.14"), Some(Ordering::Equal));

        // A `v` on one side only, which is exactly how the tags and the labels
        // differ.
        assert_eq!(compare("v0.1.14", "0.1.14"), Some(Ordering::Equal));
    }

    #[test]
    fn a_version_this_cannot_read_is_not_an_answer() {
        for odd in ["latest", "", "0.1", "0.1.14-rc1", "0.1.x"] {
            assert_eq!(compare(odd, "0.1.14"), None, "{odd}");
        }
    }

    #[test]
    fn an_unreadable_version_is_never_reported_as_up_to_date() {
        // The failure this guards is the one this product shipped: an instance
        // that could not say which version it ran looked identical to one that
        // was current, and the update notice stayed silent for five releases.
        assert_eq!(verdict(None, Some("0.1.14")), Verdict::Unknown);
        assert_eq!(verdict(Some("0.1.13"), None), Verdict::Unknown);
        assert_eq!(verdict(Some("latest"), Some("0.1.14")), Verdict::Unknown);
    }

    #[test]
    fn the_verdict_is_the_comparison() {
        assert_eq!(verdict(Some("0.1.13"), Some("0.1.14")), Verdict::Update);
        assert_eq!(verdict(Some("0.1.14"), Some("0.1.14")), Verdict::Current);
        // Ahead of what is published — a build from sources, or a tag pulled
        // back. Not an update, and not a lie about being behind.
        assert_eq!(verdict(Some("0.2.0"), Some("0.1.14")), Verdict::Current);
    }
}
