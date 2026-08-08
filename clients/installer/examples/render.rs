//! Draws what the installer looks like, without installing anything.
//!
//!   TERN_LANG=fr cargo run --example render
//!   cargo run --example render -- fail
//!
//! There is no safe way to run the real thing to check its appearance — it puts
//! packages on the machine and starts containers — and appearance is exactly
//! what changes most often. So the screens are reproduced here against sleeps
//! and fabricated failures: same catalog, same checklist, same frame, nothing
//! touched on the way through.

use std::thread::sleep;
use std::time::Duration;

use console::style;
use tern_setup::checklist::{gutter_line, tail, Checklist, Failure};
use tern_setup::i18n::{self, fill};

fn main() -> std::io::Result<()> {
    let failing = std::env::args().any(|arg| arg == "fail");
    let c = i18n::detect_from_env().catalog();

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
    cliclack::log::step(c.head_install)?;

    let list = Checklist::new(vec![
        c.step_fetch_compose.to_string(),
        c.step_write_config.to_string(),
        c.step_pull.to_string(),
        c.step_start.to_string(),
        c.step_wait_api.to_string(),
        c.step_check_volume.to_string(),
    ]);

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
        cliclack::outro_cancel(fill(c.journal_hint_fail, &["/srv/tern/tern-setup.log"]))?;
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

    let admin = "http://192.168.1.112:8080/app";
    let mut body = format!(
        "{}   {}\n\n{}\n\n",
        c.done_admin,
        style(admin).cyan(),
        c.done_body
    );
    body.push_str(&fill(c.stop_label, &["docker-compose.prod.yml"]));
    body.push('\n');
    body.push_str(&fill(c.logs_label, &["docker-compose.prod.yml"]));
    body.push('\n');
    body.push_str(&fill(c.journal_hint, &["/srv/tern/tern-setup.log"]));

    cliclack::note(c.done_panel_title, body)?;
    cliclack::outro(fill(c.outro_ready, &[admin]))?;
    Ok(())
}
