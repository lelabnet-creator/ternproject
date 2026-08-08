//! The checklist — the only thing this installer puts on the screen while it
//! works.
//!
//! Every step is announced up front, greyed out with a `○`, so that the length
//! of what is left is visible before it happens. The running one turns over,
//! the finished ones become a green `✓` with their duration pushed to the right
//! when they took long enough to be worth reporting. The list redraws in place;
//! nothing scrolls.
//!
//! The drawing is `indicatif`'s, not ours. It already handles the redraw, the
//! terminal width, the line wrapping, a resize happening mid-install and the
//! absence of a terminal — precisely the cases a hand-written redraw gets
//! wrong, and precisely the ones that only ever break on someone else's
//! machine. `cliclack` keeps the frame around it: intro, outro, logs and
//! prompts, so the whole thing stays one visual language.
//!
//! Each step's duration is measured here, at the moment it ends. `ProgressBar`
//! reports the time since the bar was created, which for bars all created at
//! the start means every line showing the same number.

use std::time::{Duration, Instant};

use console::{measure_text_width, style, Style, Term};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

/// Why a step stopped, and what the command had to say about it.
pub struct Failure {
    pub message: String,
    pub output: String,
}

impl Failure {
    pub fn new(message: impl Into<String>, output: impl Into<String>) -> Failure {
        Failure {
            message: message.into(),
            output: output.into(),
        }
    }

    /// A failure with nothing captured — a check we made ourselves rather than
    /// a command that spoke.
    pub fn bare(message: impl Into<String>) -> Failure {
        Failure {
            message: message.into(),
            output: String::new(),
        }
    }
}

/// What a step returns: an optional short note to show on the right instead of
/// a duration, or a failure.
pub type StepResult = Result<Option<String>, Failure>;

pub struct Checklist {
    multi: MultiProgress,
    bars: Vec<ProgressBar>,
    labels: Vec<String>,
    animated: bool,
}

impl Checklist {
    /// Draws the whole list at once, every step pending.
    pub fn new(labels: Vec<String>) -> Checklist {
        let multi = MultiProgress::new();
        // `indicatif` hides its bars when stderr is not a terminal, which is
        // the right call for it and the wrong one for us: a CI log or a
        // `tee`-ed install would then show nothing at all between the intro and
        // the outro. We fall back to one plain line per step.
        let animated = Term::stderr().is_term();

        let bars: Vec<ProgressBar> = labels
            .iter()
            .map(|label| {
                let bar = multi.add(ProgressBar::new_spinner());
                bar.set_style(plain_style());
                bar.set_message(pending_line(label));
                bar
            })
            .collect();

        Checklist {
            multi,
            bars,
            labels,
            animated,
        }
    }

    /// Runs one step, turning it over until the work is done.
    ///
    /// The task runs on this thread; `indicatif`'s steady tick animates from
    /// its own. That is the whole reason the spinner does not need us to poll
    /// anything, and why a step can be a plain blocking call.
    pub fn run<F: FnOnce() -> StepResult>(&self, index: usize, task: F) -> StepResult {
        let Some(bar) = self.bars.get(index) else {
            return task();
        };
        let label = &self.labels[index];

        if self.animated {
            bar.set_style(running_style());
            bar.set_message(label.clone());
            bar.enable_steady_tick(Duration::from_millis(90));
        } else {
            let _ = self
                .multi
                .println(gutter(&format!("{}  {label}", style("○").dim())));
        }

        let started = Instant::now();
        let result = task();
        let elapsed = started.elapsed();

        bar.disable_steady_tick();
        bar.set_style(plain_style());

        match &result {
            Ok(note) => {
                let right = note.clone().unwrap_or_else(|| elapsed_note(elapsed));
                bar.finish_with_message(done_line(&style("✓").green().to_string(), label, &right));
            }
            Err(_) => {
                bar.finish_with_message(done_line(&style("■").red().to_string(), label, ""));
            }
        }

        if !self.animated {
            let _ = self.multi.println(bar.message());
        }

        result
    }

    /// Renames a step that could only be named precisely once it started.
    ///
    /// Which Docker package this distribution actually has is not knowable
    /// before `apt-get update` has run, and the answer is worth showing. The
    /// list never gains or loses a line this way — one label simply becomes
    /// more specific.
    /// Only ever called on a step that has not started yet, so the line it
    /// rewrites is the pending one.
    pub fn relabel(&mut self, index: usize, label: String) {
        let Some(bar) = self.bars.get(index) else {
            return;
        };
        bar.set_message(pending_line(&label));
        self.labels[index] = label;
    }

    /// A step that had nothing to do, kept on the list with a word saying so.
    ///
    /// Dropping it from the list instead would be worse: the person watched it
    /// announced a moment ago, and a line that vanishes reads as a line that
    /// failed.
    pub fn skip(&self, index: usize, note: &str) {
        let Some(bar) = self.bars.get(index) else {
            return;
        };
        bar.set_style(plain_style());
        bar.finish_with_message(done_line(
            &style("✓").green().dim().to_string(),
            &self.labels[index],
            note,
        ));
        if !self.animated {
            let _ = self.multi.println(bar.message());
        }
    }

    /// Leaves the finished list on screen and hands the terminal back.
    pub fn finish(self) {
        for bar in &self.bars {
            if !bar.is_finished() {
                bar.finish();
            }
        }
        // Dropping the `MultiProgress` releases the drawn region without
        // erasing it, so what follows — a cliclack log line, the outro —
        // appends underneath instead of fighting for the same rows.
        drop(self.multi);
        // cliclack ends each of its blocks on a bare gutter line; the list has
        // to do the same or the next log line lands flush against it.
        let _ = Term::stderr().write_line(&bar_style().apply_to("│").to_string());
    }
}

/// The last few lines of a failed command, for the screen.
///
/// Twenty is the number that fits under a checklist without pushing it off the
/// top, and the end of the output is where the reason lives: a package manager
/// or a compose run says what went wrong on its way out. The rest stays in the
/// journal, which is where anyone diagnosing this seriously will be looking.
pub fn tail(output: &str, lines: usize) -> Vec<String> {
    let kept: Vec<&str> = output
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| !line.is_empty())
        .collect();

    let start = kept.len().saturating_sub(lines);
    kept[start..]
        .iter()
        .map(|line| (*line).to_string())
        .collect()
}

/// Prints one dim line inside the gutter, the way cliclack does.
pub fn gutter_line(text: &str) {
    let _ = Term::stderr().write_line(&gutter(&style(text).dim().to_string()));
}

fn gutter(body: &str) -> String {
    format!("{}  {body}", bar_style().apply_to("│"))
}

fn bar_style() -> Style {
    // cliclack paints its gutter bright black once a step is submitted; the
    // checklist lives inside that same gutter and has to match it exactly.
    Style::new().black().bright()
}

fn plain_style() -> ProgressStyle {
    ProgressStyle::with_template(&format!("{}  {{msg}}", bar_style().apply_to("│")))
        .expect("static template")
}

fn running_style() -> ProgressStyle {
    ProgressStyle::with_template(&format!(
        "{}  {{spinner:.magenta}}  {{msg}}",
        bar_style().apply_to("│")
    ))
    .expect("static template")
    // The last character is the one indicatif leaves behind when the bar stops;
    // repeating the first keeps the cycle even.
    .tick_chars("◒◐◓◑◒")
}

fn pending_line(label: &str) -> String {
    format!("{}  {}", style("○").dim(), style(label).dim())
}

/// `✓  Pulling the images                                   (12s)`
fn done_line(symbol: &str, label: &str, right: &str) -> String {
    let left = format!("{symbol}  {label}");
    if right.is_empty() {
        return left;
    }

    // Six columns of chrome ahead of the label: the gutter and its two spaces,
    // then the symbol and its two.
    let width = Term::stderr().size().1 as usize;
    let used = 6 + measure_text_width(label) + measure_text_width(right);
    let pad = width.saturating_sub(used + 1).max(1);

    format!("{left}{}{}", " ".repeat(pad), style(right).dim())
}

/// A duration, and only when it is worth saying.
///
/// Two seconds is the threshold under which `(1s)` teaches nothing — we watched
/// it go by. Past that, it is the one thing anyone will look for next time to
/// tell an install that is progressing from one that is stuck.
fn elapsed_note(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds <= 2 {
        String::new()
    } else if seconds < 60 {
        format!("({seconds}s)")
    } else {
        format!("({}m{:02}s)", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_steps_say_nothing_about_their_duration() {
        assert_eq!(elapsed_note(Duration::from_millis(400)), "");
        assert_eq!(elapsed_note(Duration::from_secs(2)), "");
    }

    #[test]
    fn longer_steps_report_seconds_then_minutes() {
        assert_eq!(elapsed_note(Duration::from_secs(12)), "(12s)");
        assert_eq!(elapsed_note(Duration::from_secs(59)), "(59s)");
        assert_eq!(elapsed_note(Duration::from_secs(60)), "(1m00s)");
        assert_eq!(elapsed_note(Duration::from_secs(185)), "(3m05s)");
    }

    #[test]
    fn the_tail_keeps_the_end_and_drops_the_blanks() {
        let output = "one\n\ntwo\nthree\n\n";
        assert_eq!(tail(output, 2), vec!["two", "three"]);
        assert_eq!(tail(output, 20), vec!["one", "two", "three"]);
        assert!(tail("", 20).is_empty());
    }
}
