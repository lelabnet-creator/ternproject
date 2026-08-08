//! The journal — everything that no longer scrolls past.
//!
//! The screen shows a checklist and nothing else: no `apt-get`, no
//! `docker pull`, no `curl`. That is a deliberate trade, and it is only a good
//! one if the output is kept somewhere. So all of it goes here — the exact
//! command line, its exit code, its whole standard output and standard error,
//! the answers given to the questions, and a timestamp on every entry.
//!
//! The file has to read on its own, by someone who was not there. It is what we
//! will ask people to attach to a bug report, so it is written for that reader
//! rather than for us.
//!
//! It appends rather than truncates. A run can restart itself once — the
//! re-exec under `sg docker` after joining the group — and a fresh file per
//! process would throw away the half of the story that explains why the restart
//! happened.
//!
//! Secrets never reach it. `APP_SECRET` and the database password are generated
//! here and written to a file the whole point of which is mode 0600; copying
//! them into a log we ask people to email would undo that in one line.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Journal {
    path: PathBuf,
    sink: Mutex<Option<std::fs::File>>,
}

impl Journal {
    /// Opens the journal next to the configuration it documents, falling back
    /// to the temporary directory when that one cannot be written.
    ///
    /// Next to `.env` is the useful place: it is the directory the person chose
    /// for this instance, the one they will look in. A read-only working
    /// directory is rare but real — someone running the installer from a
    /// mounted image — and losing the journal is not a reason to fail the
    /// install, so the fallback is silent and the path is announced either way.
    #[must_use]
    pub fn open(dir: &Path) -> Journal {
        let candidates = [
            dir.join("tern-setup.log"),
            std::env::temp_dir().join("tern-setup.log"),
        ];

        for path in candidates {
            if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
                let journal = Journal {
                    path,
                    sink: Mutex::new(Some(file)),
                };
                journal.rule();
                journal.line(&format!(
                    "tern-setup {} - run started",
                    env!("CARGO_PKG_VERSION")
                ));
                return journal;
            }
        }

        // Nowhere to write: the installer still works, it just cannot keep a
        // record. Better than refusing to install over a log file.
        Journal {
            path: PathBuf::from("(none)"),
            sink: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True when there is a file behind this journal.
    pub fn is_open(&self) -> bool {
        self.sink.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    /// One timestamped line.
    pub fn line(&self, text: &str) {
        self.write_raw(&format!("{}  {}\n", stamp(now()), text));
    }

    /// A section heading, so the file can be skimmed.
    pub fn section(&self, title: &str) {
        self.write_raw(&format!("\n{}  ── {} ──\n", stamp(now()), title));
    }

    /// An answer to one of the questions, with secrets held back.
    pub fn answer(&self, key: &str, value: &str) {
        self.line(&format!("answer  {key}={}", redact(key, value)));
    }

    /// A command, in full: what was run, what it returned, what it said.
    pub fn command(&self, argv: &str, code: Option<i32>, stdout: &str, stderr: &str) {
        let status = match code {
            Some(code) => code.to_string(),
            None => "killed by signal".to_string(),
        };
        let mut entry = format!("{}  $ {argv}\n", stamp(now()));
        entry.push_str(&format!("{}  → exit {status}\n", stamp(now())));
        for (name, body) in [("stdout", stdout), ("stderr", stderr)] {
            if body.trim().is_empty() {
                continue;
            }
            entry.push_str(&format!("--- {name} ---\n"));
            entry.push_str(body);
            if !body.ends_with('\n') {
                entry.push('\n');
            }
        }
        self.write_raw(&entry);
    }

    fn rule(&self) {
        self.write_raw(&format!("\n{}\n", "=".repeat(78)));
    }

    fn write_raw(&self, text: &str) {
        let Ok(mut guard) = self.sink.lock() else {
            return;
        };
        let Some(file) = guard.as_mut() else { return };
        // A journal that fails to write must not take the install down with it.
        let _ = file.write_all(text.as_bytes());
        let _ = file.flush();
    }
}

/// Values whose name says they are secret never appear in the journal.
///
/// Matching on the name rather than on a list of exact keys: this file will
/// outlive the current set of variables, and the next secret someone adds will
/// be called `…_SECRET`, `…_PASSWORD` or `…_TOKEN` like all the others.
#[must_use]
pub fn redact(key: &str, value: &str) -> String {
    let key = key.to_ascii_uppercase();
    let secret = ["SECRET", "PASSWORD", "TOKEN", "KEY"]
        .iter()
        .any(|marker| key.contains(marker));

    if secret && !value.is_empty() {
        format!("«{} characters, withheld»", value.chars().count())
    } else {
        value.to_string()
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A UTC timestamp, `YYYY-MM-DD HH:MM:SSZ`.
///
/// Written out rather than pulled from `chrono` or `time`: the installer has to
/// stay a small self-contained binary, and a date crate is a lot of dependency
/// for the one format string this file needs. The civil-date arithmetic is the
/// standard days-from-epoch conversion, and it is covered by a test.
#[must_use]
pub fn stamp(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let secs_of_day = unix_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    )
}

/// Days since 1970-01-01 back to a calendar date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_utc_calendar_dates() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00Z");
        assert_eq!(stamp(1_700_000_000), "2023-11-14 22:13:20Z");
        // A leap day, the case the arithmetic exists for.
        assert_eq!(stamp(1_709_164_800), "2024-02-29 00:00:00Z");
    }

    #[test]
    fn secrets_never_reach_the_journal() {
        assert_eq!(redact("APP_SECRET", "abcd"), "«4 characters, withheld»");
        assert_eq!(
            redact("POSTGRES_PASSWORD", "hunter2"),
            "«7 characters, withheld»"
        );
        assert_eq!(redact("SMTP_TOKEN", "x"), "«1 characters, withheld»");
        // An empty value has nothing to hide, and saying so is useful.
        assert_eq!(redact("APP_SECRET", ""), "");
    }

    #[test]
    fn ordinary_settings_are_written_as_they_are() {
        assert_eq!(redact("TERN_HTTP_PORT", "8080"), "8080");
        assert_eq!(
            redact("PUBLIC_BASE_URL", "http://10.0.0.4:8080"),
            "http://10.0.0.4:8080"
        );
    }
}
