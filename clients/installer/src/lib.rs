//! TERN's installer, as a binary.
//!
//! It is a port of `scripts/setup.sh`, keeping that script's decisions and its
//! reasons, and changing only what a shell could not do well: the screen. The
//! shell drew its own gutter, its own spinner and its own right-aligned
//! durations with `printf` and `tput`, and it let `apt-get` and `docker` write
//! over all of it. Here the frame is `cliclack` — the clack look, prompts
//! included — the checklist is `indicatif`, and nothing a child process says
//! ever reaches the terminal.
//!
//! The modules are split so that everything which decides something can be
//! tested without a machine to decide about: language detection, `.env` parsing
//! and rewriting, the default public URL, package-manager detection. What is
//! left in `main` is the narrative — the same order of events as the script,
//! readable top to bottom.
//!
//! Unix only, as the shell version was. It looks at `/var/run/docker.sock`, at
//! `/run/systemd/system` and at file modes; there is nothing here that would
//! mean anything on Windows.

// Unix only, and deliberately so rather than by accident.
//
// This installer puts Docker down with `apt-get`, `dnf`, `yum` or `pacman`,
// enables a systemd service, adds an account to the `docker` group and re-execs
// itself under `sg`. None of that exists on Windows, and `scripts/setup.sh` —
// which picks the binary — offers no Windows target either, a `.sh` being no
// more runnable there.
//
// Said here rather than left to the first platform-specific call to fail: the
// error was `cannot find function is_executable in this scope`, which sends a
// reader looking for a missing import instead of telling them the truth.
// There is no `unsafe` in this crate, and this is what keeps it that way.
//
// Said as a lint rather than left as a fact about today's code: this program
// runs as root on somebody else's machine, through sudo, to install packages
// and enable services. The one thing that makes it reviewable is that every
// line of it is checked by the compiler — and that property is worth one line
// to enforce instead of a habit to remember. `CommandExt::exec`, the only
// call here that looks like it should need an escape hatch, is safe in std.
#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!(
    "tern-setup targets Unix. It installs Docker through a distribution's \
     package manager and supervises it with systemd; Windows and the rest have \
     no path through this program."
);

pub mod checklist;
pub mod envfile;
pub mod i18n;
pub mod journal;
pub mod probe;
pub mod run;
pub mod theme;
pub mod upgrade;
