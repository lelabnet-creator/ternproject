//! Draws what the installer looks like, without installing anything.
//!
//!   cargo run --example render                (a run that works)
//!   TERN_LANG=fr cargo run --example render
//!   cargo run --example render -- fail        (a run that stops)
//!   cargo run --example render -- prompts     (the questions, frame by frame)
//!   cargo run --example render -- states      (every state of a row at once)
//!
//! There is no safe way to run the real thing to check its appearance — it puts
//! packages on the machine and starts containers — and appearance is exactly
//! what changes most often. So the screens are reproduced here against sleeps
//! and fabricated failures: same catalog, same checklist, same theme, same
//! frame, nothing touched on the way through.
//!
//! The `prompts` mode exists because the questions cannot be reproduced that
//! way: a prompt reads a keyboard, and there is none here. It asks the theme
//! for the very fragments a prompt would draw — the header, the default on
//! offer, the two options of a confirmation — and prints them in each of their
//! states. That is enough to answer the question this was written for: run it
//! under `TERM=linux script -qec … /dev/null | cat -v` and look for `[2m`. A
//! Linux console does not render dim, so anything still emitted that way is
//! text nobody will ever read.
//!
//! `states` answers the second one. It drives a list into every state a row can
//! be in — skipped, done, failed, running, pending — and then holds there,
//! which no real install ever does: a real one shows the states one after the
//! other, and the defect was that they looked the same *side by side*. Two ways
//! to read it:
//!
//!   TERM=linux script -qec 'cargo run --example render -- states' /dev/null
//!
//! is the screen itself, redraws and all. And
//!
//!   CLICOLOR_FORCE=1 TERM=linux cargo run --example render -- states 2>&1 | cat -v
//!
//! is the same rows one per line with their escapes visible: `indicatif` draws
//! nothing when stderr is not a terminal, so the checklist falls back to one
//! plain line per state, and `CLICOLOR_FORCE` keeps the paint on. That is the
//! form to read when the question is *which* escape carries a state, and the
//! form to grep when the question is whether anything outside ASCII still
//! does.

use std::thread::sleep;
use std::time::Duration;

use cliclack::{StringCursor, Theme, ThemeState};
use console::style;
use tern_setup::checklist::{gutter_line, tail, Checklist, Failure, ELLIPSIS};
use tern_setup::i18n::{self, fill, Catalog};
use tern_setup::theme::TernTheme;

const COMPOSE_FILE: &str = "docker-compose.prod.yml";
const JOURNAL: &str = "/srv/tern/tern-setup.log";
const ADMIN: &str = "http://192.168.1.112:8080/app";
const PUBLIC: &str = "http://192.168.1.112:8080";

fn main() -> std::io::Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let c = i18n::detect_from_env().catalog();
    tern_setup::theme::install(c);

    match mode.as_str() {
        "prompts" => prompts(c),
        "states" => states(c),
        "docker" => docker(c),
        "fail" => run(c, true),
        _ => run(c, false),
    }
}

/// Every state a row can be in, on the screen at the same time.
///
/// A real install never shows this: the states arrive one after another, and a
/// list that looks right in sequence can still be unreadable as a whole, which
/// is precisely what was reported. So one of each is forced — a step there was
/// nothing to do about, one that succeeded, one that stopped, the one being
/// watched, and two nobody has reached — and the last of them is held long
/// enough to be looked at.
///
/// The labels are the installer's own, from the catalog. Nothing here is
/// written for the demonstration: a screen proved with strings that only exist
/// in the proof is a screen that has not been proved.
fn states(c: &'static Catalog) -> std::io::Result<()> {
    cliclack::intro(style(format!(" {} ", c.title)).on_cyan().black())?;

    let list = Checklist::new(
        c,
        c.head_install,
        vec![
            c.step_fetch_compose.to_string(),
            c.step_write_config.to_string(),
            c.step_pull.to_string(),
            c.step_start.to_string(),
            c.step_wait_api.to_string(),
            c.step_check_volume.to_string(),
        ],
    );

    list.skip(0, c.note_already);
    let _ = list.run(1, || Ok(Some(fill(c.env_written, &[".env"]))));
    let _ = list.run(2, || {
        sleep(Duration::from_millis(300));
        Ok(None)
    });
    let _ = list.run(3, || Err(Failure::new(c.start_failed, "")));

    // The one being watched, held for long enough that the frame above it can
    // be read whole rather than caught between two redraws.
    let _ = list.run(4, || {
        sleep(Duration::from_millis(4000));
        Ok(None)
    });
    list.finish();

    cliclack::log::info(c.secret_new)?;
    cliclack::log::warning(c.docker_missing)?;
    cliclack::log::error(c.start_failed)?;
    cliclack::log::success(c.volume_ok)?;
    cliclack::outro(fill(c.outro_ready, &[ADMIN]))?;
    Ok(())
}

/// The other two checklists: the one that puts Docker on the machine, and the
/// one-step list that adds an account to the docker group.
///
/// Worth drawing on its own because it holds the longest labels the installer
/// can produce — a step named after a package whose name is only known once
/// the step above it has run — and because the box is sized before that name
/// exists.
fn docker(c: &'static Catalog) -> std::io::Result<()> {
    cliclack::intro(style(format!(" {} ", c.title)).on_cyan().black())?;
    cliclack::log::warning(c.docker_missing)?;

    let mut list = Checklist::new(
        c,
        c.head_docker,
        vec![
            c.step_apt_update.to_string(),
            fill(c.step_install_engine, &[ELLIPSIS.pick()]),
            fill(c.step_install_compose, &[ELLIPSIS.pick()]),
            c.step_enable_service.to_string(),
        ],
    );

    let _ = list.run(0, || {
        sleep(Duration::from_millis(1400));
        Ok(None)
    });

    list.relabel(1, fill(c.step_install_engine, &["docker.io"]));
    list.relabel(2, fill(c.step_install_compose, &["docker-compose-plugin"]));

    let _ = list.run(1, || {
        sleep(Duration::from_millis(3400));
        Ok(None)
    });
    let _ = list.run(2, || {
        sleep(Duration::from_millis(1200));
        Ok(None)
    });
    list.skip(3, c.no_systemd);
    list.finish();

    cliclack::log::success(c.docker_ready)?;
    cliclack::log::warning(c.sock_title)?;
    cliclack::log::info(format!("{}\n{}", c.sock_1, c.sock_2))?;

    let group = Checklist::new(c, c.sock_title, vec![fill(c.step_join_group, &["ann"])]);
    let _ = group.run(0, || {
        sleep(Duration::from_millis(800));
        Ok(None)
    });
    group.finish();

    cliclack::log::info(c.sock_added)?;
    cliclack::outro(c.sock_reexec)?;
    Ok(())
}

/// The install, from the intro to the closing panel.
fn run(c: &'static Catalog, failing: bool) -> std::io::Result<()> {
    cliclack::intro(style(format!(" {} ", c.title)).on_cyan().black())?;

    cliclack::log::warning(c.docker_missing)?;
    cliclack::log::info(format!(
        "{}\n{}\n{}",
        fill(c.pkgmgr_detected, &["apt"]),
        c.pkg_from_distro,
        c.sudo_heads_up
    ))?;
    cliclack::log::success(c.docker_ready)?;

    cliclack::log::step(c.head_access)?;
    cliclack::log::info(c.proxy_hint)?;
    cliclack::log::step(c.head_agent)?;
    cliclack::log::info(c.agent_container)?;

    cliclack::log::info(fill(
        c.no_sources,
        &["ghcr.io/lelabnet-creator/ternproject:latest"],
    ))?;

    let list = Checklist::new(
        c,
        c.head_install,
        vec![
            c.step_fetch_compose.to_string(),
            c.step_write_config.to_string(),
            c.step_pull.to_string(),
            c.step_start.to_string(),
            c.step_wait_api.to_string(),
            c.step_check_volume.to_string(),
        ],
    );

    list.skip(0, c.note_already);

    let _ = list.run(1, || {
        sleep(Duration::from_millis(600));
        Ok(Some(fill(c.env_written, &[".env"])))
    });

    // Long enough to be worth a duration, which is the point of the threshold.
    let _ = list.run(2, || {
        sleep(Duration::from_millis(3200));
        Ok(None)
    });

    let _ = list.run(3, || {
        sleep(Duration::from_millis(900));
        Ok(None)
    });

    if failing {
        let output = "Error response from daemon: pull access denied for ternproject,\n\
             repository does not exist or may require 'docker login'.\n\
             See 'docker run --help'.";
        let failure = list
            .run(4, || {
                sleep(Duration::from_millis(1500));
                Err(Failure::new(c.api_timeout, output))
            })
            .unwrap_err();
        list.finish();

        cliclack::log::error(&failure.message)?;
        gutter_line(c.api_migrating);
        for line in tail(&failure.output, 20) {
            gutter_line(&line);
        }
        cliclack::outro_cancel(fill(c.journal_hint_fail, &[JOURNAL]))?;
        return Ok(());
    }

    let _ = list.run(4, || {
        sleep(Duration::from_millis(2500));
        Ok(None)
    });
    let _ = list.run(5, || {
        sleep(Duration::from_millis(500));
        Ok(None)
    });
    list.finish();

    cliclack::log::info(c.secret_new)?;
    cliclack::log::success(c.volume_ok)?;

    cliclack::note(c.done_panel_title, closing_panel(c))?;
    cliclack::outro(fill(c.outro_ready, &[ADMIN]))?;
    Ok(())
}

/// The same panel `main` builds, against fixed values.
///
/// Kept in step with it by hand, which is the price of not making the installer
/// depend on its own preview. It is twenty lines and it is read side by side
/// with the original whenever either moves.
fn closing_panel(c: &'static Catalog) -> String {
    let mut body = String::new();
    body.push_str(c.done_state);
    body.push_str("\n\n");
    body.push_str(&fill(c.done_admin, &[&style(ADMIN).cyan().to_string()]));
    body.push('\n');
    body.push_str(&fill(c.done_public, &[&style(PUBLIC).cyan().to_string()]));
    body.push('\n');
    body.push_str(&fill(c.stop_label, &[COMPOSE_FILE]));
    body.push('\n');
    body.push_str(&fill(c.logs_label, &[COMPOSE_FILE]));
    body.push('\n');
    body.push_str(&fill(c.journal_hint, &[JOURNAL]));
    body.push_str("\n\n");
    body.push_str(c.done_body);
    body.push_str("\n\n");
    body.push_str(
        &c.done_first_admin
            .lines()
            .map(|line| style(line).yellow().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    body
}

/// Every question, in every state it can be seen in, with nobody typing.
fn prompts(c: &'static Catalog) -> std::io::Result<()> {
    let theme = TernTheme::new(c);

    cliclack::intro(style(format!(" {} ", c.title)).on_cyan().black())?;
    cliclack::log::step(c.head_access)?;

    // An input while it is open, with the default it offers, and the same
    // input once it has been answered. The second is what stays on the screen.
    input_frames(&theme, c.q_port, &fill(c.default_hint, &["8080"]), "8080");
    input_frames(
        &theme,
        c.q_public_url,
        &fill(c.default_hint, &[PUBLIC]),
        PUBLIC,
    );
    input_frames(&theme, c.q_trusted_proxies, c.q_proxies_none, "");

    cliclack::log::step(c.head_agent)?;

    // All three of them, and each with the choice on either side. Which one is
    // held has to be legible without knowing the question, and the only way to
    // see that is to look at the two frames next to each other — the defect
    // reported was not "the wrong one is highlighted" but "we cannot tell which
    // one is".
    for question in [c.docker_install_q, &fill(c.sock_add_q, &["ann"]), c.agent_q] {
        confirm_frames(&theme, question, true);
        confirm_frames(&theme, question, false);
    }

    cliclack::outro(fill(c.outro_ready, &[ADMIN]))?;
    Ok(())
}

fn input_frames(theme: &TernTheme, question: &str, offered: &str, answered: &str) {
    let mut placeholder = StringCursor::default();
    placeholder.extend(offered);
    let mut answer = StringCursor::default();
    answer.extend(answered);

    print(&theme.format_header(&ThemeState::Active, question));
    print(&theme.format_placeholder(&ThemeState::Active, &placeholder));
    print(&theme.format_footer(&ThemeState::Active));

    print(&theme.format_header(&ThemeState::Submit, question));
    if answered.is_empty() {
        print(&theme.format_placeholder(&ThemeState::Submit, &placeholder));
    } else {
        print(&theme.format_input(&ThemeState::Submit, &answer));
    }
    print(&theme.format_footer(&ThemeState::Submit));
}

fn confirm_frames(theme: &TernTheme, question: &str, default: bool) {
    print(&theme.format_header(&ThemeState::Active, question));
    print(&theme.format_confirm(&ThemeState::Active, default));
    print(&theme.format_footer(&ThemeState::Active));

    print(&theme.format_header(&ThemeState::Submit, question));
    print(&theme.format_confirm(&ThemeState::Submit, default));
    print(&theme.format_footer(&ThemeState::Submit));
}

/// The prompts write to standard error, as cliclack does, so a redirection
/// captures the two together in the order they were drawn.
fn print(frame: &str) {
    eprint!("{frame}");
}
