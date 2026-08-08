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

pub mod checklist;
pub mod envfile;
pub mod i18n;
pub mod journal;
pub mod probe;
pub mod run;
