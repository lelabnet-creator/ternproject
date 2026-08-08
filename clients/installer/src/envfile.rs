//! Reading and rewriting `.env`.
//!
//! The file is regenerated from a fixed template on every run, which is what
//! makes the installer repeatable — and what makes carrying settings over
//! mandatory. Without it, running the installer again to change a port used to
//! wipe `SMTP_HOST`, `INGEST_RATE_LIMIT_MAX` and everything else somebody had
//! added by hand. They were recoverable from the `.bak`, but nothing said so,
//! and a rate limit that silently returns to its default is not something you
//! notice.
//!
//! So: the values this installer knows are asked for, defaulted to whatever the
//! previous file said, and rewritten in their section; every other assignment
//! found in the previous file is copied to the end under a heading that says
//! where it came from.

use std::io;
use std::path::Path;

use crate::i18n::Catalog;

/// The keys this installer owns and rewrites itself. Everything else in a
/// previous `.env` is somebody's own setting and gets carried over untouched.
pub const MANAGED: &[&str] = &[
    "POSTGRES_PASSWORD",
    "APP_SECRET",
    "TERN_HTTP_PORT",
    "PUBLIC_BASE_URL",
    "TRUSTED_PROXIES",
    "LOG_LEVEL",
    "TERN_IMAGE",
    "TERN_AGENT_NETWORK_MODE",
    "TERN_LOCAL_AGENT_SERVER",
];

/// The value of a key in an existing `.env`, if it has one.
///
/// The last assignment wins, the way a shell sourcing the file would resolve
/// it, and surrounding double quotes are dropped: people write both forms and
/// both mean the same thing here.
pub fn get(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    text.lines()
        .rfind(|line| line.starts_with(&prefix))
        .map(|line| unquote(&line[prefix.len()..]).to_string())
}

fn unquote(value: &str) -> &str {
    let value = value.trim_end_matches(['\r']);
    match value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        Some(inner) => inner,
        None => value,
    }
}

/// Is this an assignment line, and to which key?
fn assignment(line: &str) -> Option<&str> {
    let key = line.split('=').next()?;
    if key.is_empty() || line.len() == key.len() {
        return None;
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    let valid = (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid.then_some(key)
}

/// The lines of a previous `.env` that this installer does not write itself.
pub fn carried_over(previous: &str) -> Vec<String> {
    previous
        .lines()
        .filter(|line| match assignment(line) {
            Some(key) => !MANAGED.contains(&key),
            None => false,
        })
        .map(|line| line.to_string())
        .collect()
}

/// Everything that ends up in the file.
pub struct Settings {
    pub postgres_password: String,
    pub app_secret: String,
    pub http_port: String,
    pub public_base_url: String,
    pub trusted_proxies: String,
    pub agent_network_mode: String,
    pub local_agent_server: String,
    /// Set when the stack runs a published image rather than a local build.
    pub image: Option<String>,
}

/// The whole file, comments included, in the reader's language.
///
/// The shell version left these comments in French because translating them
/// would have meant two copies of an already unwieldy heredoc. There is no such
/// constraint here, and an English-speaking server has no business receiving a
/// configuration file commented in French.
pub fn render(settings: &Settings, previous: Option<&str>, catalog: &Catalog) -> String {
    let mut out = String::new();

    out.push_str(catalog.env_head);
    out.push_str("\n\n");

    out.push_str(catalog.env_db);
    out.push('\n');
    out.push_str(&format!(
        "POSTGRES_PASSWORD={}\n\n",
        settings.postgres_password
    ));

    out.push_str(catalog.env_secret);
    out.push('\n');
    out.push_str(&format!("APP_SECRET={}\n\n", settings.app_secret));

    out.push_str(catalog.env_access);
    out.push('\n');
    out.push_str(&format!("TERN_HTTP_PORT={}\n", settings.http_port));
    out.push_str(&format!("PUBLIC_BASE_URL={}\n", settings.public_base_url));
    out.push_str(&format!("TRUSTED_PROXIES={}\n", settings.trusted_proxies));
    out.push_str("LOG_LEVEL=info\n");
    // Written here rather than appended after the pull, so that the file never
    // holds two `TERN_IMAGE` lines and so that the `docker compose` calls that
    // follow — and the ones run by hand next month — all name the same image
    // this run started.
    if let Some(image) = &settings.image {
        out.push_str(&format!("TERN_IMAGE={image}\n"));
    }
    out.push('\n');

    out.push_str(catalog.env_agent);
    out.push('\n');
    out.push_str(&format!(
        "TERN_AGENT_NETWORK_MODE={}\n",
        settings.agent_network_mode
    ));
    out.push_str(&format!(
        "TERN_LOCAL_AGENT_SERVER={}\n\n",
        settings.local_agent_server
    ));

    out.push_str(catalog.env_product);
    out.push('\n');

    if let Some(previous) = previous {
        let kept = carried_over(previous);
        if !kept.is_empty() {
            out.push('\n');
            out.push_str(catalog.env_carried);
            out.push('\n');
            for line in kept {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }

    out
}

/// Writes the file so that it is never readable by anyone else, not even for
/// the instant between creation and `chmod`.
///
/// The mode goes on the `open` call rather than after it: this file holds
/// `APP_SECRET`, and a window during which it exists world-readable is a window
/// during which it can be read.
#[cfg(unix)]
pub fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())?;
    // An existing file keeps its old mode through `open`, so it is set again.
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::EN;

    const PREVIOUS: &str = "\
# Written by a previous run
POSTGRES_PASSWORD=old-password
APP_SECRET=old-secret
TERN_HTTP_PORT=8080
PUBLIC_BASE_URL=\"https://status.example.org\"
TRUSTED_PROXIES=10.0.0.0/8
LOG_LEVEL=info
TERN_AGENT_NETWORK_MODE=service:app
TERN_LOCAL_AGENT_SERVER=
SMTP_HOST=mail.example.org
SMTP_PORT=587
INGEST_RATE_LIMIT_MAX=120
# a comment
not an assignment
";

    #[test]
    fn existing_values_become_the_defaults() {
        assert_eq!(get(PREVIOUS, "TERN_HTTP_PORT"), Some("8080".to_string()));
        assert_eq!(get(PREVIOUS, "APP_SECRET"), Some("old-secret".to_string()));
        assert_eq!(get(PREVIOUS, "NOT_THERE"), None);
    }

    #[test]
    fn surrounding_quotes_are_not_part_of_the_value() {
        assert_eq!(
            get(PREVIOUS, "PUBLIC_BASE_URL"),
            Some("https://status.example.org".to_string())
        );
    }

    #[test]
    fn an_empty_value_reads_as_empty_and_not_as_missing() {
        assert_eq!(
            get(PREVIOUS, "TERN_LOCAL_AGENT_SERVER"),
            Some(String::new())
        );
    }

    #[test]
    fn the_last_assignment_wins() {
        let text = "TERN_HTTP_PORT=8080\nTERN_HTTP_PORT=9090\n";
        assert_eq!(get(text, "TERN_HTTP_PORT"), Some("9090".to_string()));
    }

    #[test]
    fn hand_added_settings_are_carried_over() {
        let kept = carried_over(PREVIOUS);
        assert_eq!(
            kept,
            [
                "SMTP_HOST=mail.example.org",
                "SMTP_PORT=587",
                "INGEST_RATE_LIMIT_MAX=120",
            ]
        );
    }

    #[test]
    fn what_the_installer_writes_itself_is_not_carried_over_twice() {
        let kept = carried_over(PREVIOUS);
        for key in MANAGED {
            assert!(
                !kept.iter().any(|line| line.starts_with(&format!("{key}="))),
                "{key} was carried over on top of the value the installer writes"
            );
        }
    }

    #[test]
    fn comments_and_prose_are_not_mistaken_for_settings() {
        let kept = carried_over("# SMTP_HOST=commented\nnot an assignment\n 1BAD=x\n=empty\n");
        assert!(kept.is_empty());
    }

    fn settings() -> Settings {
        Settings {
            postgres_password: "pg".into(),
            app_secret: "secret".into(),
            http_port: "8080".into(),
            public_base_url: "http://10.0.0.4:8080".into(),
            trusted_proxies: String::new(),
            agent_network_mode: "service:app".into(),
            local_agent_server: String::new(),
            image: None,
        }
    }

    #[test]
    fn a_rewrite_keeps_the_smtp_settings_it_never_asked_about() {
        let written = render(&settings(), Some(PREVIOUS), &EN);
        assert!(written.contains("SMTP_HOST=mail.example.org"));
        assert!(written.contains("INGEST_RATE_LIMIT_MAX=120"));
        assert!(written.contains(EN.env_carried));
        // And the values it does own are the new ones, once each.
        assert_eq!(written.matches("TERN_HTTP_PORT=").count(), 1);
        assert_eq!(
            get(&written, "PUBLIC_BASE_URL"),
            Some("http://10.0.0.4:8080".into())
        );
    }

    #[test]
    fn a_first_install_gets_no_carry_over_heading() {
        let written = render(&settings(), None, &EN);
        assert!(!written.contains(EN.env_carried));
        assert_eq!(get(&written, "TERN_IMAGE"), None);
    }

    /// Every line of the generated file is a comment, a setting, or nothing.
    ///
    /// The comment blocks are multi-line literals stitched with backslash
    /// continuations, and one missing `#` turns a sentence of prose into a line
    /// the container's env parser will choke on. Cheap to check, invisible
    /// otherwise until an install fails to start.
    #[test]
    fn the_generated_file_is_a_valid_env_file_in_both_languages() {
        for catalog in [&EN, &crate::i18n::FR] {
            let written = render(&settings(), Some(PREVIOUS), catalog);
            for line in written.lines() {
                assert!(
                    line.is_empty() || line.starts_with('#') || assignment(line).is_some(),
                    "not a comment and not a setting: {line:?}"
                );
            }
        }
    }

    #[test]
    fn the_file_is_never_readable_by_anyone_else() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tern-env-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");

        // Written twice on purpose: an existing file keeps its old mode through
        // `open`, which is the case a first-run-only test would miss.
        std::fs::write(&path, "APP_SECRET=world-readable\n").unwrap();
        std::fs::set_permissions(&path, PermissionsExt::from_mode(0o644)).unwrap();
        write_private(&path, &render(&settings(), None, &EN)).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode was {mode:o}");
        assert_eq!(
            get(&std::fs::read_to_string(&path).unwrap(), "APP_SECRET"),
            Some("secret".into())
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_image_is_named_once_when_there_is_one() {
        let mut settings = settings();
        settings.image = Some("ghcr.io/lelabnet-creator/ternproject:latest".into());
        let written = render(&settings, Some(PREVIOUS), &EN);
        assert_eq!(written.matches("TERN_IMAGE=").count(), 1);
    }
}
