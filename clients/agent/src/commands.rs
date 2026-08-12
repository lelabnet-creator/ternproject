//! Carrying out what the console asked.
//!
//! The console cannot reach an agent. Agents poll; nothing here listens, and an
//! agent behind a relay has no route back at all. So an instruction rides in on
//! the reply to a poll the agent was already making, is carried out, and is
//! answered on its own route back.
//!
//! Two consequences, both worth saying plainly rather than designing around:
//!
//! - **Nothing here is immediate.** An instruction waits for the next refresh,
//!   which is minutes away by default. The console shows the wait; a button
//!   that looked instant and was not is how somebody presses it four times.
//! - **An answer may never come.** A restart is carried out by a process that
//!   then stops existing. It reports on its way out and may not get there. The
//!   server marks an instruction as handed over when it hands it over, so that
//!   one is never given twice — "asked and unanswered" is a state the console
//!   can show, and it is not the same as "refused".

use tracing::{info, warn};

use crate::config::{Running, UiSettings};
use crate::transport::{Client, Command, CommandKind};

/**
 * What an instruction can act on.
 *
 * An agent's config and a relay's are different types with the same three
 * things an instruction touches: a page, a running state, and a file to write
 * them to. A trait rather than two copies of this logic, because the copy that
 * drifts is the one that stops honouring `stop` — and the whole point of that
 * state is a promise the console makes on its behalf.
 */
pub trait Controllable {
    fn ui(&self) -> Option<&UiSettings>;
    fn set_ui(&mut self, ui: Option<UiSettings>);
    fn state(&self) -> Running;
    fn set_state(&mut self, state: Running);
    /**
     * Persist the change.
     *
     * A no-op is legitimate: a caller that holds the live config behind a lock
     * cannot hand it here, so it hands a small view of the two fields an
     * instruction may touch and writes the real thing itself afterwards. See
     * the relay, where writing a copy taken before a network call destroyed the
     * keys a zone agent had paired for in the meantime.
     */
    fn write(&self, path: &std::path::Path) -> anyhow::Result<()>;

    /**
     * What pausing this thing actually stops.
     *
     * On the trait rather than a fixed sentence, because the two answers are
     * genuinely different: an agent stops measuring, and a relay has nothing to
     * measure — it stops sending, and its zone's points pile up in the queue
     * instead. The console repeats this back, so a single wording would tell
     * one of the two something untrue.
     */
    fn paused_means(&self) -> &'static str;

    /// Where this thing sends. Needed to work out which of its own interfaces
    /// faces the console, so `ui-on` can hand back an address worth clicking
    /// rather than the `0.0.0.0` it may have bound.
    fn upstream(&self) -> String;
}

/// What carrying out an instruction did, and what to do next.
pub enum Outcome {
    /// Done. The text, if any, is the answer — log lines, a password.
    Done(Option<String>),
    /// Could not be done, and why.
    Failed(String),
    /// Done, and this process must now end so the supervisor starts it again.
    ///
    /// Separate from `Done` because the answer has to be sent *before* leaving,
    /// and only the caller knows it has been.
    Restart,
}

/// Runs one instruction against this agent's config, saving it if it changed.
///
/// Takes the config rather than reading it: the caller is holding the live copy
/// the loop runs from, and a second read would let the two disagree about what
/// this agent is doing.
pub fn run<C: Controllable>(command: &Command, config: &mut C, path: &std::path::Path) -> Outcome {
    match &command.kind {
        CommandKind::Pause => {
            let said = format!("paused — {}", config.paused_means());
            set_state(config, path, Running::Paused, &said)
        }
        CommandKind::Resume => set_state(config, path, Running::Active, "resumed"),

        /*
         * Stopped, not killed.
         *
         * The process stays up and stops talking to the server entirely. Ending
         * it instead would achieve nothing: every supervisor this installs
         * under restarts on any exit — `Restart=always`, `KeepAlive` — so an
         * agent that exited would be back in five seconds, and one that exited
         * again on the way up would do that forever.
         *
         * Staying up and silent is what makes this final in the way it claims:
         * nothing is listening for a resume, so the fleet sees it go quiet and
         * getting it back needs a shell on the machine.
         */
        CommandKind::Stop => set_state(
            config,
            path,
            Running::Stopped,
            "stopped — reporting nothing until `resume` is run on the machine",
        ),

        CommandKind::Restart => Outcome::Restart,

        CommandKind::Logs => Outcome::Done(Some(crate::logbuf::snapshot())),

        /*
         * The page turned on, and the password handed back once.
         *
         * The only moment it can be: it is salted and hashed as it is stored, so
         * this process is the one place it exists in the clear and this reply is
         * the one time it travels. Asking again mints another — the same promise
         * `tern-agent ui` makes at a terminal.
         */
        CommandKind::UiOn => {
            /*
             * Bound where the console can reach it, when nothing was chosen.
             *
             * `tern-agent ui` at a terminal defaults to loopback, and rightly:
             * somebody typing it is standing on the machine, and a monitoring
             * agent should not open a port on an estate because it was
             * installed. Asked from the console the intent is the opposite and
             * unambiguous — the person clicking is somewhere else and wants to
             * look — and loopback would make the button decorative.
             *
             * An address already in the config wins: that is an operator who
             * chose, and choosing again for them would be worse than either
             * default. The password is what guards it, and the console says so
             * as it hands it over.
             */
            let listen = config
                .ui()
                .map(|u| u.listen.clone())
                .unwrap_or_else(|| "0.0.0.0:38788".to_string());
            let upstream = config.upstream();
            let (settings, password) = crate::ui::configure(config.ui(), Some(listen));
            let bound = settings.listen.clone();
            /*
             * The address to click, not the one it bound.
             *
             * A page on `0.0.0.0:38788` is served on every interface and is not
             * an address anybody can open; the console would have shown a link
             * to nowhere. The machine resolves which of its interfaces faces
             * the server — the console is served from the far end of exactly
             * that path — and null when there is none, which is the honest
             * answer for a page on loopback.
             */
            let reachable = settings.reachable_address(&upstream);
            config.set_ui(Some(settings));
            match config.write(path) {
                Ok(()) => {
                    info!(%bound, "the local page was turned on from the console");
                    // Two facts in one answer, so the console can show the
                    // password and offer the link in the same breath. Shaped in
                    // `@tern/shared/agent-commands`, where the console reads it.
                    Outcome::Done(Some(
                        serde_json::json!({ "password": password, "address": reachable })
                            .to_string(),
                    ))
                }
                Err(error) => Outcome::Failed(format!("could not write the config: {error}")),
            }
        }

        CommandKind::UiOff => {
            config.set_ui(None);
            match config.write(path) {
                Ok(()) => {
                    info!("the local page was turned off from the console");
                    Outcome::Done(None)
                }
                Err(error) => Outcome::Failed(format!("could not write the config: {error}")),
            }
        }

        /*
         * An instruction this build has never heard of.
         *
         * Answered rather than ignored, and answered as unknown rather than as
         * failed: a console newer than the agent is an ordinary state during a
         * rollout, and "this agent is too old for that" is what somebody needs
         * to read. Silence would look like an agent that is not listening.
         */
        CommandKind::Unknown(other) => Outcome::Failed(format!(
            "this agent does not know the instruction `{other}`"
        )),
    }
}

fn set_state<C: Controllable>(
    config: &mut C,
    path: &std::path::Path,
    state: Running,
    said: &str,
) -> Outcome {
    config.set_state(state);
    match config.write(path) {
        Ok(()) => {
            info!(%said, "told by the console");
            Outcome::Done(Some(said.to_string()))
        }
        // Not applied in memory only: the supervisor restarts this process on
        // any exit, and a state that never reached the file would be undone by
        // the restart without anybody being told.
        Err(error) => Outcome::Failed(format!("could not write the config: {error}")),
    }
}

/// Carries out everything that arrived, answering each one.
///
/// Returns whether this process should now end — a restart, and nothing else.
pub async fn apply<C: Controllable>(
    client: &Client,
    api_key: &str,
    commands: &[Command],
    config: &mut C,
    path: &std::path::Path,
) -> bool {
    let mut restart = false;

    for command in commands {
        info!(kind = %command.kind, "carrying out an instruction from the console");
        let (result, error) = match run(command, config, path) {
            Outcome::Done(text) => (text, None),
            Outcome::Failed(why) => {
                warn!(kind = %command.kind, %why, "could not carry it out");
                (None, Some(why))
            }
            Outcome::Restart => {
                restart = true;
                (Some("restarting".to_string()), None)
            }
        };

        // Answered before leaving, when leaving is what was asked. Reversed,
        // the console would never learn that the thing it asked for happened.
        if let Err(report) = client
            .command_result(api_key, &command.id, result.as_deref(), error.as_deref())
            .await
        {
            warn!(%report, "carried it out but could not say so");
        }
    }

    restart
}

/// Ends this process so the supervisor starts it again.
///
/// Zero, not a failure code: nothing went wrong, and a unit that logs a failure
/// every time somebody presses Restart teaches its operator to ignore the log.
pub fn leave_for_restart() -> ! {
    info!("restarting at the console's request");
    std::process::exit(0)
}

/**
 * The two things an instruction may change, apart from the config holding them.
 *
 * For a caller whose config is shared — the relay's is, behind a mutex, and a
 * zone agent pairing mutates it at any moment. Cloning the whole config, going
 * to the network, and writing the clone back destroyed whatever had been added
 * in between: the keys of agents that had just paired, in memory and on disk,
 * so their next heartbeat was refused. This carries only what an instruction
 * touches, and the caller merges it under its own lock.
 */
pub struct Settings {
    pub ui: Option<UiSettings>,
    pub state: Running,
    pub paused_means: &'static str,
    /// Carried along, because resolving a clickable address needs it.
    pub upstream: String,
}

impl Controllable for Settings {
    fn ui(&self) -> Option<&UiSettings> {
        self.ui.as_ref()
    }
    fn set_ui(&mut self, ui: Option<UiSettings>) {
        self.ui = ui;
    }
    fn state(&self) -> Running {
        self.state
    }
    fn set_state(&mut self, state: Running) {
        self.state = state;
    }
    /// Nothing: the caller owns the file and writes it once, afterwards.
    fn write(&self, _path: &std::path::Path) -> anyhow::Result<()> {
        Ok(())
    }
    fn paused_means(&self) -> &'static str {
        self.paused_means
    }
    fn upstream(&self) -> String {
        self.upstream.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Running};

    fn scratch() -> (Config, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("tern-cmd-{}", crate::transport::random_token(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.toml");
        let config = Config {
            server: "https://x.example".into(),
            api_key: "k".into(),
            install_id: None,
            state: Default::default(),
            interval_s: 60,
            probes: Vec::new(),
            ui: None,
        };
        config.save(&path).unwrap();
        (config, path)
    }

    fn cmd(kind: &str) -> Command {
        Command {
            id: "c1".into(),
            kind: kind.into(),
        }
    }

    /// The difference between the two states, which is the whole design.
    #[test]
    fn paused_stops_measuring_but_keeps_listening() {
        let (mut config, path) = scratch();
        run(&cmd("pause"), &mut config, &path);

        assert_eq!(config.state, Running::Paused);
        assert!(!config.state.measures(), "no probes");
        assert!(
            config.state.reports(),
            "still reachable, so it can be resumed"
        );
    }

    #[test]
    fn stopped_stops_listening_too() {
        // What makes it final: nothing is left to hear a resume, which is
        // exactly what the console says before asking for it.
        let (mut config, path) = scratch();
        run(&cmd("stop"), &mut config, &path);

        assert_eq!(config.state, Running::Stopped);
        assert!(!config.state.measures());
        assert!(!config.state.reports());
    }

    /// The state has to survive the restart the supervisor performs on any exit.
    #[test]
    fn the_state_is_written_to_the_file() {
        let (mut config, path) = scratch();
        run(&cmd("stop"), &mut config, &path);

        let reread = Config::load(&path).unwrap();
        assert_eq!(reread.state, Running::Stopped);
    }

    #[test]
    fn resume_undoes_either_of_them() {
        let (mut config, path) = scratch();
        run(&cmd("stop"), &mut config, &path);
        run(&cmd("resume"), &mut config, &path);
        assert_eq!(config.state, Running::Active);
        assert!(config.state.measures() && config.state.reports());
    }

    /// The password is the answer, because this is the one moment it exists in
    /// the clear anywhere but on this machine.
    #[test]
    fn turning_the_page_on_hands_back_a_password_once() {
        let (mut config, path) = scratch();
        let Outcome::Done(Some(answer)) = run(&cmd("ui-on"), &mut config, &path) else {
            panic!("expected an answer back")
        };

        // Two facts now, so the console can show the password and offer the
        // link together — see `UiOnResult` in @tern/shared/agent-commands.
        let parsed: serde_json::Value = serde_json::from_str(&answer).expect("json");
        let password = parsed["password"].as_str().expect("a password").to_string();
        assert!(parsed.get("address").is_some(), "and where to open it");
        assert!(password.len() >= 12);
        assert!(config.ui.is_some(), "the page is on");
        // Stored hashed, never in the clear: the reply above is the only copy.
        let stored = Config::load(&path).unwrap();
        let credential = stored.ui.unwrap().credential.unwrap();
        assert_ne!(credential.hash, password);
        assert!(credential.matches(&password), "and it is the right one");

        // Asked again, another one — the same promise `tern-agent ui` makes.
        let Outcome::Done(Some(again)) = run(&cmd("ui-on"), &mut config, &path) else {
            panic!("expected an answer back")
        };
        let second: serde_json::Value = serde_json::from_str(&again).expect("json");
        assert_ne!(second["password"].as_str().unwrap(), password);
    }

    #[test]
    fn turning_it_off_leaves_nothing_listening() {
        let (mut config, path) = scratch();
        run(&cmd("ui-on"), &mut config, &path);
        run(&cmd("ui-off"), &mut config, &path);
        assert!(config.ui.is_none());
        assert!(Config::load(&path).unwrap().ui.is_none());
    }

    #[test]
    fn a_restart_is_not_a_config_change() {
        let (mut config, path) = scratch();
        assert!(matches!(
            run(&cmd("restart"), &mut config, &path),
            Outcome::Restart
        ));
        assert_eq!(config.state, Running::Active, "restarting is not pausing");
    }

    /// A console newer than the agent is ordinary during a rollout. Saying so
    /// is what stops it looking like an agent that is not listening.
    #[test]
    fn an_unknown_instruction_is_answered_rather_than_ignored() {
        let (mut config, path) = scratch();
        let Outcome::Failed(why) = run(&cmd("teleport"), &mut config, &path) else {
            panic!("expected a refusal")
        };
        assert!(
            why.contains("teleport"),
            "names what it did not understand: {why}"
        );
    }
}
