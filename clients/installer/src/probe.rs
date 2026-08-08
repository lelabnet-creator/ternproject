//! What this machine is, asked one narrow question at a time.
//!
//! Every answer here is a fact about the host: which package manager is
//! actually installed, which address the kernel would use to leave, who we are
//! running as. The parsing is separated from the asking so that the parts that
//! decide something can be tested without a machine to test them on.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::journal::Journal;
use crate::run;

/// The package managers this installer knows how to drive.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PackageManager {
    Apt,
    Dnf,
    Yum,
    Pacman,
}

impl PackageManager {
    pub fn name(self) -> &'static str {
        match self {
            PackageManager::Apt => "apt",
            PackageManager::Dnf => "dnf",
            PackageManager::Yum => "yum",
            PackageManager::Pacman => "pacman",
        }
    }

    /// The command that installs, without asking anything back.
    pub fn install_argv(self, packages: &[&str]) -> Vec<String> {
        let head: Vec<&str> = match self {
            PackageManager::Apt => vec!["apt-get", "install", "-y"],
            PackageManager::Dnf => vec!["dnf", "install", "-y"],
            PackageManager::Yum => vec!["yum", "install", "-y"],
            // No `-y` here on purpose. `pacman -Sy package` builds a partial
            // upgrade, which this distribution does not forgive. If the local
            // database is too old for the install to succeed, what is needed is
            // a `pacman -Syu`, and that is not a command anyone runs on someone
            // else's behalf.
            PackageManager::Pacman => vec!["pacman", "-S", "--needed", "--noconfirm"],
        };
        head.iter()
            .chain(packages.iter())
            .map(|part| (*part).to_string())
            .collect()
    }
}

/// Which package manager to use, decided by the command that is present rather
/// than by `/etc/os-release`.
///
/// A derivative rarely declares itself as its base, and what matters is the
/// tool we are actually going to call, not the name the distribution gives
/// itself. `apt-get` and not `apt`: `apt` says itself that it has no stable
/// interface for scripts.
///
/// The lookup is a parameter so the decision can be exercised against a made-up
/// machine.
pub fn detect_package_manager(present: impl Fn(&str) -> bool) -> Option<PackageManager> {
    if present("apt-get") {
        Some(PackageManager::Apt)
    } else if present("dnf") {
        Some(PackageManager::Dnf)
    } else if present("yum") {
        Some(PackageManager::Yum)
    } else if present("pacman") {
        Some(PackageManager::Pacman)
    } else {
        None
    }
}

/// Which of Docker's own repository files fits this machine, if any.
///
/// Only the RPM family, and only because there is nothing else to fall back on
/// there: Rocky, Alma and RHEL publish no Docker package at all, so an
/// installer that will not add a repository is an installer that cannot install
/// on them. Debian and Ubuntu ship `docker.io`, Arch ships `docker` — asking to
/// add a third-party repository where the distribution already has the software
/// would be trading a supported package for an unsupported one, and nobody
/// gains by that.
///
/// `ID` first and `ID_LIKE` after it, which is the order these two fields are
/// meant to be read in: a derivative that names itself gets its own answer, and
/// one that only declares its base falls back to the base. Anything that
/// declares neither gets `None` rather than a guess — a repository file aimed
/// at the wrong distribution installs packages built against another libc, and
/// that failure surfaces days later.
///
/// The reader is a parameter for the same reason it is one elsewhere in this
/// module: `/etc/os-release` is a fact about the machine running the tests, not
/// about the machine under test.
pub fn docker_repo_from(read_os_release: impl Fn() -> Option<String>) -> Option<&'static str> {
    let text = read_os_release()?;
    let field = |key: &str| -> Option<String> {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim_matches('"').to_ascii_lowercase())
    };

    let id = field("ID").unwrap_or_default();
    let like = field("ID_LIKE").unwrap_or_default();
    let names = std::iter::once(id.as_str()).chain(like.split_whitespace());

    for name in names {
        match name {
            "fedora" => return Some("https://download.docker.com/linux/fedora/docker-ce.repo"),
            "rhel" | "centos" | "rocky" | "almalinux" | "ol" => {
                return Some("https://download.docker.com/linux/centos/docker-ce.repo")
            }
            _ => {}
        }
    }
    None
}

/// The rule above, against this machine.
pub fn docker_repo() -> Option<&'static str> {
    docker_repo_from(|| std::fs::read_to_string("/etc/os-release").ok())
}

/// Is this package in the repositories *already* configured on this machine?
///
/// We do not look anywhere else on our own. Adding Docker's own repository
/// means importing a key and writing a repo file, and that is a question put to
/// whoever is at the keyboard rather than a step taken behind them — see
/// `docker_repo_from` for the one family where the question is worth asking.
pub fn package_available(journal: &Journal, manager: PackageManager, package: &str) -> bool {
    match manager {
        PackageManager::Apt => {
            let outcome = run::run(journal, run::command("apt-cache", &["show", package]));
            outcome.ok
                && outcome
                    .stdout
                    .lines()
                    .any(|line| line.starts_with("Package:"))
        }
        PackageManager::Dnf => run::succeeds(journal, "dnf", &["-q", "info", package]),
        PackageManager::Yum => run::succeeds(journal, "yum", &["-q", "info", package]),
        PackageManager::Pacman => run::succeeds(journal, "pacman", &["-Si", package]),
    }
}

/// The first of these names that exists here.
///
/// The same software goes by different names from one distribution to the next,
/// and some publish two variants depending on which repositories are enabled.
pub fn first_available(
    journal: &Journal,
    manager: PackageManager,
    candidates: &[&str],
) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| package_available(journal, manager, candidate))
        .map(|found| (*found).to_string())
}

/// Is this program on the `PATH`?
///
/// Walking `PATH` ourselves rather than spawning `command -v`: it is the same
/// answer, and this gets asked a dozen times before anything has happened.
pub fn has_command(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_executable(&dir.join(program)))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The numeric user id, straight from `id -u`.
///
/// Through the tool rather than through `libc`: this binary has no C
/// dependency of its own, and the two places that need the id — deciding
/// whether to reach for sudo, and deciding whether the docker group question
/// even applies — are not hot paths.
pub fn uid() -> u32 {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

/// The login name. Not `$USER`, which says the wrong thing under sudo.
pub fn username() -> String {
    Command::new("id")
        .arg("-un")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| text.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "root".to_string())
}

/// `uname -s`, the name this kernel gives itself.
pub fn kernel() -> String {
    Command::new("uname")
        .arg("-s")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| text.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Is systemd the init here, rather than merely installed?
///
/// `systemctl` can exist without systemd running the machine — containers, WSL
/// without systemd, systems that keep the tool for compatibility.
/// `/run/systemd/system` only appears when systemd is genuinely up.
pub fn systemd_is_init() -> bool {
    Path::new("/run/systemd/system").is_dir() && has_command("systemctl")
}

/// The address this machine is reached on — never `localhost`.
///
/// `PUBLIC_BASE_URL` is not decorative: it signs cookies, builds the agent
/// pairing URLs, ends up in generated install scripts and in the links of
/// outgoing mail. Leaving `localhost` in it produces an instance that works
/// perfectly for the person sitting at the server and for nobody else — agents
/// pair against an address that, on their side, means their own machine, and
/// the links in the mail lead nowhere.
///
/// So the default offered is the source address the kernel picks to go out:
/// the one this machine is reached on, in the overwhelming majority of cases.
/// A domain name is still better when there is one, and the question asks for
/// it — this is a default, not a decision.
pub fn primary_address(journal: &Journal) -> Option<String> {
    // Linux. No packet is sent; `route get` consults the table.
    if has_command("ip") {
        let outcome = run::run(
            journal,
            run::command("ip", &["-4", "route", "get", "1.1.1.1"]),
        );
        if let Some(address) = parse_route_src(&outcome.stdout) {
            return Some(address);
        }
    }

    // macOS and the BSDs: same question, other tools.
    if has_command("route") && has_command("ipconfig") {
        let outcome = run::run(journal, run::command("route", &["-n", "get", "1.1.1.1"]));
        if let Some(interface) = parse_route_interface(&outcome.stdout) {
            let outcome = run::run(
                journal,
                run::command("ipconfig", &["getifaddr", &interface]),
            );
            let address = outcome.trimmed_stdout().to_string();
            if !address.is_empty() {
                return Some(address);
            }
        }
    }

    None
}

/// Pulls the `src …` address out of `ip route get`.
pub fn parse_route_src(output: &str) -> Option<String> {
    let mut words = output.split_whitespace();
    while let Some(word) = words.next() {
        if word == "src" {
            return words.next().map(|address| address.to_string());
        }
    }
    None
}

/// Pulls the interface name out of `route -n get` on macOS.
pub fn parse_route_interface(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (head, tail) = line.split_once(':')?;
        (head.trim() == "interface").then(|| tail.trim().to_string())
    })
}

/// The public URL to offer, given whatever address we managed to find.
pub fn default_public_url(address: Option<&str>, port: &str) -> String {
    format!("http://{}:{port}", address.unwrap_or("localhost"))
}

/// Does this URL only mean anything from this machine?
pub fn is_loopback_url(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    url.contains("localhost") || url.contains("127.0.0.1") || url.contains("[::1]")
}

/// Quotes a string so a shell reading it sees exactly one word.
///
/// Needed in one place — handing our own path to `sg docker -c` — and that one
/// place is enough to matter: an installer downloaded into `~/Mes documents/`
/// would otherwise re-exec a command cut in two.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 32 bytes of kernel randomness, as hex.
///
/// Straight from `/dev/urandom` rather than through a crate or through
/// `openssl`: it is the source all of them end up reading anyway, and a secret
/// that encrypts TOTP seeds is not something to generate from a fallback. If it
/// cannot be read, nothing is written — an installer that quietly downgrades
/// the quality of a key is worse than one that stops.
pub fn random_hex() -> std::io::Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Where the install happens.
///
/// Two provenances. From a checkout, this binary sits under `clients/` or is
/// run from the repository root, and everything happens where the compose file
/// is. Downloaded on its own, it is already in the directory the person made
/// for it — climbing a level would install the instance in the parent
/// directory, which is not the one they created for this. Hence the test: we
/// only climb when the compose file is genuinely up there.
pub fn install_root(compose_file: &str) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join(compose_file).is_file() {
        return cwd;
    }
    if let Some(parent) = cwd.parent() {
        if parent.join(compose_file).is_file() {
            return parent.to_path_buf();
        }
    }
    cwd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rocky is the machine this was written for: it names itself, and it names
    /// the two bases it derives from.
    #[test]
    fn a_rhel_derivative_gets_the_centos_repository() {
        let rocky = || {
            Some(
                "NAME=\"Rocky Linux\"\nID=\"rocky\"\nVERSION=\"9.8\"\n\
                 ID_LIKE=\"rhel centos fedora\"\n"
                    .to_string(),
            )
        };
        assert_eq!(
            docker_repo_from(rocky),
            Some("https://download.docker.com/linux/centos/docker-ce.repo")
        );
    }

    /// `ID` before `ID_LIKE`, which is what decides this one: Fedora has its own
    /// repository, and reading the fields in the other order would hand Rocky
    /// the Fedora one on the strength of its `ID_LIKE`.
    #[test]
    fn fedora_gets_its_own_repository_and_id_wins_over_id_like() {
        let fedora = || Some("ID=fedora\nVERSION_ID=41\n".to_string());
        assert_eq!(
            docker_repo_from(fedora),
            Some("https://download.docker.com/linux/fedora/docker-ce.repo")
        );

        // Declares itself Fedora-like but is a RHEL derivative: `ID` is the one
        // that answers, and it answers centos.
        let alma = || Some("ID=almalinux\nID_LIKE=\"rhel centos fedora\"\n".to_string());
        assert_eq!(
            docker_repo_from(alma),
            Some("https://download.docker.com/linux/centos/docker-ce.repo")
        );
    }

    /// No answer rather than a guess. A repository file aimed at the wrong
    /// distribution installs packages built against another libc, and that
    /// failure surfaces days later on somebody else's machine.
    #[test]
    fn a_distribution_docker_does_not_publish_for_gets_nothing() {
        assert_eq!(docker_repo_from(|| Some("ID=arch\n".to_string())), None);
        assert_eq!(
            docker_repo_from(|| Some("ID=debian\nID_LIKE=\n".to_string())),
            None
        );
        assert_eq!(docker_repo_from(|| None), None);
        assert_eq!(docker_repo_from(|| Some(String::new())), None);
    }

    /// `VERSION_ID` starts with `ID`, and a prefix match on the key alone would
    /// read the version as the distribution.
    #[test]
    fn a_field_is_matched_whole_and_not_by_its_prefix() {
        let ordered = || Some("VERSION_ID=\"9.8\"\nID=rocky\n".to_string());
        assert_eq!(
            docker_repo_from(ordered),
            Some("https://download.docker.com/linux/centos/docker-ce.repo")
        );
    }

    #[test]
    fn the_package_manager_is_the_one_that_is_installed() {
        let debian = |cmd: &str| cmd == "apt-get";
        assert_eq!(detect_package_manager(debian), Some(PackageManager::Apt));

        let fedora = |cmd: &str| matches!(cmd, "dnf" | "yum");
        assert_eq!(detect_package_manager(fedora), Some(PackageManager::Dnf));

        let centos7 = |cmd: &str| cmd == "yum";
        assert_eq!(detect_package_manager(centos7), Some(PackageManager::Yum));

        let arch = |cmd: &str| cmd == "pacman";
        assert_eq!(detect_package_manager(arch), Some(PackageManager::Pacman));

        let alpine = |_: &str| false;
        assert_eq!(detect_package_manager(alpine), None);
    }

    #[test]
    fn apt_wins_when_a_machine_carries_several() {
        // Some machines have both, usually through a compatibility package.
        // apt-get is the one we drive, so it decides.
        let mixed = |cmd: &str| matches!(cmd, "apt-get" | "dnf" | "pacman");
        assert_eq!(detect_package_manager(mixed), Some(PackageManager::Apt));
    }

    #[test]
    fn pacman_never_gets_a_partial_upgrade() {
        let argv = PackageManager::Pacman.install_argv(&["docker"]);
        assert_eq!(argv, ["pacman", "-S", "--needed", "--noconfirm", "docker"]);
        assert!(!argv.iter().any(|part| part == "-Sy"));
    }

    #[test]
    fn install_commands_never_ask_a_question() {
        assert_eq!(
            PackageManager::Apt.install_argv(&["docker.io", "docker-compose-v2"]),
            ["apt-get", "install", "-y", "docker.io", "docker-compose-v2"]
        );
        assert_eq!(PackageManager::Dnf.install_argv(&["moby-engine"])[2], "-y");
        assert_eq!(PackageManager::Yum.install_argv(&["moby-engine"])[2], "-y");
    }

    #[test]
    fn the_source_address_comes_out_of_ip_route() {
        let output = "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.112 uid 1000 \ncache";
        assert_eq!(parse_route_src(output), Some("192.168.1.112".to_string()));
        assert_eq!(
            parse_route_src("RTNETLINK answers: Network unreachable"),
            None
        );
        assert_eq!(parse_route_src(""), None);
    }

    #[test]
    fn the_interface_comes_out_of_bsd_route() {
        let output = "   route to: 1.1.1.1\ndestination: default\n  interface: en0\n";
        assert_eq!(parse_route_interface(output), Some("en0".to_string()));
        assert_eq!(parse_route_interface("no route to host"), None);
    }

    #[test]
    fn the_default_url_is_the_address_we_found() {
        assert_eq!(
            default_public_url(Some("192.168.1.112"), "8080"),
            "http://192.168.1.112:8080"
        );
    }

    #[test]
    fn localhost_is_only_ever_the_last_resort() {
        // Nothing found: we still have to propose something, and it is flagged
        // by the warning the moment it is accepted.
        assert_eq!(default_public_url(None, "8080"), "http://localhost:8080");
        assert!(is_loopback_url(&default_public_url(None, "8080")));
        assert!(!is_loopback_url(&default_public_url(
            Some("10.0.0.4"),
            "8080"
        )));
    }

    #[test]
    fn loopback_is_recognised_in_every_form_it_gets_typed() {
        assert!(is_loopback_url("http://LOCALHOST:8080"));
        assert!(is_loopback_url("http://127.0.0.1:8080"));
        assert!(is_loopback_url("http://[::1]:8080"));
        assert!(!is_loopback_url("https://status.example.org"));
    }

    #[test]
    fn a_path_with_a_space_survives_the_re_exec() {
        assert_eq!(
            shell_quote("/home/ann/Mes documents/tern-setup"),
            "'/home/ann/Mes documents/tern-setup'"
        );
        assert_eq!(shell_quote("/tmp/it's here"), r"'/tmp/it'\''s here'");
    }

    #[test]
    fn the_secret_is_sixty_four_hex_characters() {
        let hex = random_hex().expect("/dev/urandom");
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hex, random_hex().unwrap());
    }
}
