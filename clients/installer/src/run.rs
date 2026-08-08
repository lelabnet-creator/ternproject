//! Running other programs, and keeping what they said.
//!
//! Everything this installer does to the machine, it does by calling the tools
//! that already know how — `apt-get`, `systemctl`, `docker`, `curl`. There is
//! no HTTP client in this binary and no async runtime: the one download it
//! needs is a `curl` away, exactly as it was in the shell version, and pulling
//! in a TLS stack to save that one subprocess would cost more than it buys.
//!
//! Nothing a child process writes reaches the screen. It is captured, handed to
//! the journal, and shown only as the tail of a failure. That is what lets the
//! checklist redraw a fixed set of lines instead of being cut in half by an
//! `apt-get` progress bar.

use std::process::{Command, Stdio};

use crate::journal::Journal;

pub struct Outcome {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    /// What to show when this failed: the error stream first, since that is
    /// where a Unix tool puts the reason, and the standard output behind it for
    /// the tools that do not.
    pub fn output(&self) -> String {
        let mut joined = self.stderr.clone();
        if !self.stdout.trim().is_empty() {
            if !joined.is_empty() && !joined.ends_with('\n') {
                joined.push('\n');
            }
            joined.push_str(&self.stdout);
        }
        joined
    }

    pub fn trimmed_stdout(&self) -> &str {
        self.stdout.trim()
    }
}

/// Runs a command to completion, captures both streams, journals all of it.
///
/// `Command::output` drains stdout and stderr at the same time, so a child that
/// fills one pipe while we read the other cannot deadlock us. It also gives the
/// child a closed stdin, which is what we want: a tool that decides to ask a
/// question mid-install has to fail rather than hang forever behind a spinner
/// that keeps turning.
pub fn run(journal: &Journal, mut cmd: Command) -> Outcome {
    let printed = argv(&cmd);

    match cmd.stdin(Stdio::null()).output() {
        Ok(output) => {
            let outcome = Outcome {
                ok: output.status.success(),
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            };
            journal.command(&printed, outcome.code, &outcome.stdout, &outcome.stderr);
            outcome
        }
        // The program is not there, or could not be started at all. That is an
        // answer too, and the journal is the only place it would otherwise be
        // lost.
        Err(error) => {
            let message = error.to_string();
            journal.command(&printed, None, "", &message);
            Outcome {
                ok: false,
                code: None,
                stdout: String::new(),
                stderr: message,
            }
        }
    }
}

/// The same, for the checks whose only interesting part is whether they worked.
pub fn succeeds(journal: &Journal, program: &str, args: &[&str]) -> bool {
    let mut cmd = Command::new(program);
    cmd.args(args);
    run(journal, cmd).ok
}

/// A command, built in one expression so it can be handed straight to `run`.
pub fn command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

/// A `docker compose` call against this install's compose file.
pub fn compose(compose_file: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("docker");
    cmd.args(["compose", "-f", compose_file]).args(args);
    cmd
}

/// Builds a command, escalating only when the current account is not already
/// root.
///
/// On a fresh VM or inside a container one is often root already, and `sudo` is
/// not always installed there — prefixing it unconditionally would break the
/// case that needs the least help.
pub fn as_root(uid: u32, program: &str, args: &[&str]) -> Command {
    if uid == 0 {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    } else {
        let mut cmd = Command::new("sudo");
        cmd.arg(program).args(args);
        cmd
    }
}

/// Asks sudo for its password now, in the open, before any spinner starts.
///
/// A password prompt drawn underneath a turning spinner is invisible, and an
/// install that sits there waiting for a line nobody knows it wants looks
/// exactly like an install that has frozen. This is the one place a child
/// process is allowed the terminal.
pub fn prime_sudo(journal: &Journal, uid: u32) {
    if uid == 0 {
        return;
    }
    journal.line("$ sudo -v  (password prompt, shown on the terminal)");
    let status = Command::new("sudo")
        .arg("-v")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    journal.line(&format!("→ sudo -v: {status:?}"));
}

/// The command line as it would be typed, for the journal.
pub fn argv(cmd: &Command) -> String {
    let mut parts = vec![cmd.get_program().to_string_lossy().into_owned()];
    parts.extend(cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()));
    parts.join(" ")
}
