//! The checklist — the only thing this installer puts on the screen while it
//! works.
//!
//! Every step is announced up front with a `○`, so that the length of what is
//! left is visible before it happens. The running one turns over, the finished
//! ones become a green `✓` with their duration pushed to the right when they
//! took long enough to be worth reporting. The list redraws in place; nothing
//! scrolls.
//!
//! It lives in a box, and the box is drawn once. Its width is settled from the
//! labels before the first step runs, so no line moves sideways while the list
//! fills in — a frame that shifts under the text is worse than no frame, and
//! the steps are watched for minutes at a time. The one exception is
//! `relabel`, where a step announced with a placeholder learns its real name;
//! that happens before any of the renamed steps starts, and the alternative is
//! cutting the answer off. The characters are the ones cliclack uses for its
//! own notes, and they fall back to ASCII together, so the checklist and the
//! closing panel are visibly the same object.
//!
//! The last row inside the box says where we are: *step 4 of 9*, and a bar that
//! fills as steps are crossed off. It measures steps and not seconds. An
//! installer cannot know how long a `docker pull` will take on this line, and a
//! bar that guesses is a bar that lies twice — once when it races to 90% and
//! again when it sits there.
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

use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use console::{measure_text_width, style, Emoji, Style, Term};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

use crate::i18n::{fill, Catalog};
use crate::theme::{rule, secondary};

/// The box, in the same characters cliclack draws its notes with — and with
/// the same ASCII fallbacks, so the two never disagree about which alphabet
/// this terminal reads.
const BAR: Emoji = Emoji("│", "|");
const RULE_H: Emoji = Emoji("─", "-");
const CORNER_TOP_RIGHT: Emoji = Emoji("╮", "+");
const CORNER_BOTTOM_RIGHT: Emoji = Emoji("╯", "+");
const CONNECT_LEFT: Emoji = Emoji("├", "+");
const STEP_SUBMIT: Emoji = Emoji("◇", "o");

/// The step markers, and the ellipsis of a label too long for the box.
const PENDING: Emoji = Emoji("○", "-");
const DONE: Emoji = Emoji("✓", "+");
const FAILED: Emoji = Emoji("■", "x");
const ELLIPSIS: Emoji = Emoji("…", "..");

/// The progress bar's own characters: filled, the leading edge, empty.
const PROGRESS_CHARS: Emoji = Emoji("■■□", "##-");

/// How many columns the right-hand column is allowed. `(12m34s)` is the
/// longest duration anyone will read here, and `.env, mode 600` the longest
/// note; the box is sized for both, and anything longer is cut to it rather
/// than allowed to push a border.
const NOTE_WIDTH: usize = 14;

/// The gap between the label and its note, and between the parts of the
/// progress row.
const GAP: usize = 2;

/// The progress bar's width in cells. Fixed, because the box is.
const BAR_CELLS: usize = 18;

/// Narrower than this and the box is no longer worth drawing; wider than the
/// terminal and it wraps, which is the one thing it must never do.
const MIN_INNER: usize = 30;
const CHROME: usize = 7;

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

/// What has become of one step, and what it wants said on its right.
///
/// Kept rather than drawn and forgotten, because the box can be laid out again
/// — once, when a step turns out to have a longer name than the placeholder it
/// was announced with — and every row has to be able to redraw itself at the
/// new width.
struct Row {
    mark: Mark,
    note: String,
}

enum Mark {
    Pending,
    Running,
    Done,
    Skipped,
    Failed,
}

pub struct Checklist {
    /// Declared first on purpose. Dropping a `MultiProgress` releases the drawn
    /// region without erasing it; dropping a bar that still belongs to a live
    /// one makes it redraw without that line. On the paths that leave through a
    /// `?` — every failure — this order is what leaves the box on the screen
    /// with the red step still in it.
    multi: MultiProgress,
    steps: Vec<ProgressBar>,
    /// The header, the blank row and the footer.
    header: ProgressBar,
    blank: ProgressBar,
    footer: ProgressBar,
    progress: ProgressBar,
    title: String,
    labels: Vec<String>,
    rows: RefCell<Vec<Row>>,
    inner: Cell<usize>,
    counter: &'static str,
    counter_width: usize,
    animated: bool,
    /// Steps behind us: run and succeeded, or skipped. A step that failed is
    /// not one of them — the bar says how much of the list is done, and a
    /// failure is precisely the case where the answer is "less than you
    /// think".
    done: Cell<usize>,
    /// The step being watched, counted from one. Kept apart from `done` so
    /// that a failure leaves the counter on the step that failed instead of
    /// advancing to one that will never start.
    at: Cell<usize>,
}

impl Checklist {
    /// Draws the whole box at once, every step pending.
    pub fn new(c: &'static Catalog, title: &str, labels: Vec<String>) -> Checklist {
        let multi = MultiProgress::new();
        // `indicatif` hides its bars when stderr is not a terminal, which is
        // the right call for it and the wrong one for us: a CI log or a
        // `tee`-ed install would then show nothing at all between the intro and
        // the outro. We fall back to one plain line per step.
        let animated = Term::stderr().is_term();

        let total = labels.len();
        // The counter is measured at its longest — every number at its final
        // value — so that the bar beside it never shifts when a step is
        // crossed off.
        let counter_width = measure_text_width(&counter_text(c.step_counter, total, total));
        let inner = inner_width(title, &labels, counter_width);

        let header = multi.add(static_row());
        let steps: Vec<ProgressBar> = labels.iter().map(|_| multi.add(static_row())).collect();
        let blank = multi.add(static_row());
        let progress = multi.add(ProgressBar::new(total as u64));
        progress.set_style(progress_style());
        let footer = multi.add(static_row());

        let rows = labels
            .iter()
            .map(|_| Row {
                mark: Mark::Pending,
                note: String::new(),
            })
            .collect();

        let list = Checklist {
            multi,
            steps,
            header,
            blank,
            footer,
            progress,
            title: title.to_string(),
            labels,
            rows: RefCell::new(rows),
            inner: Cell::new(inner),
            counter: c.step_counter,
            counter_width,
            animated,
            done: Cell::new(0),
            at: Cell::new(1),
        };
        list.repaint();

        if !list.animated {
            plain_line(&header_line(inner, title));
        }
        list
    }

    /// Runs one step, turning it over until the work is done.
    ///
    /// The task runs on this thread; `indicatif`'s steady tick animates from
    /// its own. That is the whole reason the spinner does not need us to poll
    /// anything, and why a step can be a plain blocking call.
    pub fn run<F: FnOnce() -> StepResult>(&self, index: usize, task: F) -> StepResult {
        if self.steps.get(index).is_none() {
            return task();
        }
        self.at.set(index + 1);
        self.mark(index, Mark::Running, String::new());

        if !self.animated {
            plain_line(&framed(&self.paint_row(index, self.inner.get())));
        }

        let started = Instant::now();
        let result = task();
        let elapsed = started.elapsed();

        self.steps[index].disable_steady_tick();
        self.steps[index].set_style(line_style());

        match &result {
            Ok(note) => {
                let right = note.clone().unwrap_or_else(|| elapsed_note(elapsed));
                self.mark(index, Mark::Done, right);
                self.done.set((self.done.get() + 1).min(self.steps.len()));
            }
            Err(_) => self.mark(index, Mark::Failed, String::new()),
        }
        self.steps[index].finish();
        self.redraw_progress();

        if !self.animated {
            plain_line(&self.steps[index].message());
        }

        result
    }

    /// Renames a step that could only be named precisely once it started.
    ///
    /// Which Docker package this distribution actually has is not knowable
    /// before `apt-get update` has run, and the answer is worth showing — it is
    /// the one thing anybody will want from that line next month. The list
    /// never gains or loses a line this way; the box may gain a few columns,
    /// once, here, before any of the renamed steps has started. That is the
    /// only moment it is allowed to move, and it beats cutting the answer off.
    pub fn relabel(&mut self, index: usize, label: String) {
        if self.steps.get(index).is_none() {
            return;
        }
        self.labels[index] = label;

        let wanted = inner_width(&self.title, &self.labels, self.counter_width);
        if wanted > self.inner.get() {
            self.inner.set(wanted);
        }
        self.repaint();
    }

    /// A step that had nothing to do, kept on the list with a word saying so.
    ///
    /// Dropping it from the list instead would be worse: the person watched it
    /// announced a moment ago, and a line that vanishes reads as a line that
    /// failed.
    pub fn skip(&self, index: usize, note: &str) {
        if self.steps.get(index).is_none() {
            return;
        }
        self.at.set(index + 1);
        self.mark(index, Mark::Skipped, note.to_string());
        self.steps[index].finish();
        self.done.set((self.done.get() + 1).min(self.steps.len()));
        self.redraw_progress();

        if !self.animated {
            plain_line(&self.steps[index].message());
        }
    }

    /// Leaves the finished box on screen and hands the terminal back.
    pub fn finish(self) {
        for bar in self
            .steps
            .iter()
            .chain([&self.header, &self.blank, &self.footer])
        {
            if !bar.is_finished() {
                bar.finish();
            }
        }
        // `abandon` and not `finish`: the latter fills the bar to its length on
        // the way out. A list that stopped on a failed step has not been
        // completed, and the last thing it should do is claim it was.
        self.progress.abandon();

        if !self.animated {
            plain_line(&framed(&self.progress_row()));
            plain_line(&footer_line(self.inner.get()));
        }

        // Dropping the `MultiProgress` releases the drawn region without
        // erasing it, so what follows — a cliclack log line, the outro —
        // appends underneath instead of fighting for the same rows.
        drop(self.multi);
        // cliclack ends each of its blocks on a bare gutter line; the list has
        // to do the same or the next log line lands flush against it.
        let _ = Term::stderr().write_line(&rule().apply_to(BAR).to_string());
    }

    /// Records what a step has become, and draws it.
    fn mark(&self, index: usize, mark: Mark, note: String) {
        {
            let mut rows = self.rows.borrow_mut();
            rows[index].mark = mark;
            rows[index].note = note;
        }
        self.paint(index);
        self.redraw_progress();
    }

    /// Draws every row again. Called when the box has changed width, which
    /// happens at most once and never while a step is turning.
    fn repaint(&self) {
        let inner = self.inner.get();
        self.header.set_style(line_style());
        self.header.set_message(header_line(inner, &self.title));
        self.blank.set_style(line_style());
        self.blank.set_message(framed(&" ".repeat(inner)));
        self.footer.set_style(line_style());
        self.footer.set_message(footer_line(inner));
        for index in 0..self.steps.len() {
            self.paint(index);
        }
        self.redraw_progress();
    }

    /// Draws one row, in whatever state it is in.
    fn paint(&self, index: usize) {
        let inner = self.inner.get();
        let bar = &self.steps[index];

        if matches!(self.rows.borrow()[index].mark, Mark::Running) {
            // The spinner takes the marker's column, so the row keeps its width
            // and the right-hand border stays put. It lives in the template
            // rather than in the message because that is what `indicatif`
            // animates.
            bar.set_style(running_style(&row_tail(
                inner,
                &self.labels[index],
                "",
                &Style::new(),
            )));
            bar.set_message("");
            bar.enable_steady_tick(Duration::from_millis(90));
            return;
        }
        bar.set_style(line_style());
        bar.set_message(framed(&self.paint_row(index, inner)));
    }

    /// One row's contents, marker included.
    fn paint_row(&self, index: usize, inner: usize) -> String {
        let rows = self.rows.borrow();
        let label = &self.labels[index];
        let (marker, marker_style, label_style) = match rows[index].mark {
            Mark::Done => (DONE, Style::new().green(), Style::new()),
            Mark::Failed => (FAILED, Style::new().red(), Style::new()),
            Mark::Skipped => (DONE, secondary(), secondary()),
            // A running step drawn as a plain row: the terminal-less fallback,
            // where there is no spinner to put in that column.
            Mark::Pending | Mark::Running => (PENDING, secondary(), secondary()),
        };
        row(
            inner,
            &marker.to_string(),
            &marker_style,
            label,
            &label_style,
            &rows[index].note,
        )
    }

    /// The counter and the bar, both read off the same number.
    fn redraw_progress(&self) {
        let done = self.done.get();
        let total = self.steps.len();

        self.progress.set_position(done as u64);
        self.progress.set_prefix(pad_to(
            &counter_text(self.counter, self.at.get().min(total.max(1)), total),
            self.counter_width,
        ));
        self.progress.set_message(progress_tail(
            self.inner.get(),
            self.counter_width,
            done,
            total,
        ));
    }

    /// The progress row as one plain string, for the terminal-less fallback
    /// where `indicatif` draws nothing.
    fn progress_row(&self) -> String {
        let done = self.done.get();
        let total = self.steps.len();
        pad_to(
            &format!(
                "{}{}{}",
                pad_to(
                    &counter_text(self.counter, self.at.get().min(total.max(1)), total),
                    self.counter_width
                ),
                " ".repeat(GAP + BAR_CELLS + GAP),
                percent(done, total)
            ),
            self.inner.get(),
        )
    }
}

/// `Step 4 of 9`, in the reader's language.
fn counter_text(template: &str, at: usize, total: usize) -> String {
    fill(template, &[&at.to_string(), &total.to_string()])
}

/// How wide the inside of the box has to be.
///
/// Settled once, from what the box will have to hold at its widest: the longest
/// label with room for its note beside it, the progress row, and the title. Then
/// clamped to the terminal, because a box wider than the screen wraps and a
/// wrapped box is not a box.
fn inner_width(title: &str, labels: &[String], counter_width: usize) -> usize {
    let widest_label = labels
        .iter()
        .map(|label| measure_text_width(label))
        .max()
        .unwrap_or(0);

    let needed = [
        3 + widest_label + GAP + NOTE_WIDTH,
        counter_width + GAP + BAR_CELLS + GAP + 4,
        measure_text_width(title).saturating_sub(2),
        MIN_INNER,
    ]
    .into_iter()
    .max()
    .unwrap_or(MIN_INNER);

    let room = (Term::stderr().size().1 as usize).saturating_sub(CHROME);
    needed.min(room.max(MIN_INNER))
}

/// `◇  Installing TERN ─────────╮`
fn header_line(inner: usize, title: &str) -> String {
    let dashes = (inner + 2).saturating_sub(measure_text_width(title));
    format!(
        "{symbol}  {title} {rule}{corner}",
        symbol = style(STEP_SUBMIT).green(),
        rule = rule().apply_to(RULE_H.to_string().repeat(dashes)),
        corner = rule().apply_to(CORNER_TOP_RIGHT),
    )
}

/// `├────────────────────────────╯`
fn footer_line(inner: usize) -> String {
    rule()
        .apply_to(format!(
            "{CONNECT_LEFT}{}{CORNER_BOTTOM_RIGHT}",
            RULE_H.to_string().repeat(inner + 5)
        ))
        .to_string()
}

/// Puts a row that is already exactly `inner` visible columns wide between the
/// two sides of the box.
fn framed(content: &str) -> String {
    let bar = rule().apply_to(BAR);
    format!("{bar}  {content}   {bar}")
}

/// One row: a marker, a label, and a note pushed to the right.
fn row(
    inner: usize,
    marker: &str,
    marker_style: &Style,
    label: &str,
    label_style: &Style,
    right: &str,
) -> String {
    format!(
        "{}{}",
        marker_style.apply_to(marker),
        row_tail(inner, label, right, label_style)
    )
}

/// Everything on a row after its first column, padded so the row ends exactly
/// where the box does.
///
/// Kept apart from the marker because the running row's first column belongs to
/// `indicatif`'s spinner, which draws itself.
fn row_tail(inner: usize, label: &str, right: &str, label_style: &Style) -> String {
    // The note is cut first, and to the column the box was sized for. It is
    // the afterthought of the row — a duration, a word — and letting an
    // unexpectedly long one eat into the label would trade the sentence that
    // says what is happening for the aside that comments on it.
    let right = clip(right, NOTE_WIDTH);
    let right_width = measure_text_width(&right);
    let reserved = 3 + right_width + if right_width == 0 { 0 } else { GAP };
    let label = clip(label, inner.saturating_sub(reserved));
    let pad = inner.saturating_sub(3 + measure_text_width(&label) + right_width);

    format!(
        "  {}{}{}",
        label_style.apply_to(&label),
        " ".repeat(pad),
        secondary().apply_to(&right)
    )
}

/// A step nobody has reached yet. Only the tests build one directly; the list
/// itself goes through `paint_row`, which knows what state each step is in.
#[cfg(test)]
fn pending_row(inner: usize, label: &str) -> String {
    row(
        inner,
        &PENDING.to_string(),
        &secondary(),
        label,
        &secondary(),
        "",
    )
}

/// A label that does not fit, cut where the box ends rather than allowed to
/// push the border off the screen.
fn clip(text: &str, room: usize) -> String {
    if measure_text_width(text) <= room {
        return text.to_string();
    }
    let mark = ELLIPSIS.to_string();
    let room = room.saturating_sub(measure_text_width(&mark));

    let mut kept = String::new();
    for ch in text.chars() {
        if measure_text_width(&kept) + measure_text_width(&ch.to_string()) > room {
            break;
        }
        kept.push(ch);
    }
    kept + &mark
}

fn pad_to(text: &str, width: usize) -> String {
    let pad = width.saturating_sub(measure_text_width(text));
    format!("{text}{}", " ".repeat(pad))
}

/// How much of the list is behind us. A list with no steps in it is finished
/// by definition rather than stuck at nothing.
fn percent(done: usize, total: usize) -> String {
    let value = (done * 100).checked_div(total).unwrap_or(100);
    pad_to(&format!("{value}%"), 4)
}

/// What follows the progress bar on its row: the percentage, then the padding
/// that carries the eye to the border.
fn progress_tail(inner: usize, counter_width: usize, done: usize, total: usize) -> String {
    let used = counter_width + GAP + BAR_CELLS + GAP + 4;
    format!(
        "{}{}   {}",
        percent(done, total),
        " ".repeat(inner.saturating_sub(used)),
        rule().apply_to(BAR)
    )
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

/// Prints one line inside the gutter, the way cliclack does.
///
/// In the terminal's own foreground and not in the secondary colour: the only
/// things that come through here are a remedy and the last words of a command
/// that failed, and both are read closely or not at all.
pub fn gutter_line(text: &str) {
    let _ = Term::stderr().write_line(&format!("{}  {text}", rule().apply_to(BAR)));
}

/// One line straight to the terminal, for the fallback where `indicatif` draws
/// nothing.
///
/// Not through `MultiProgress::println`: that one goes through the draw target,
/// and a draw target with no terminal behind it discards everything handed to
/// it. Which is exactly the case this path exists for.
fn plain_line(text: &str) {
    let _ = Term::stderr().write_line(text);
}

/// An empty row, waiting to be told what it says.
fn static_row() -> ProgressBar {
    let bar = ProgressBar::new_spinner();
    bar.set_style(line_style());
    bar
}

fn line_style() -> ProgressStyle {
    ProgressStyle::with_template("{msg}").expect("static template")
}

/// The row of the step currently running: the spinner sits where the marker
/// would be, and everything after it is already laid out.
fn running_style(tail: &str) -> ProgressStyle {
    ProgressStyle::with_template(&format!(
        "{bar}  {{spinner:.magenta}}{tail}   {bar}",
        bar = rule().apply_to(BAR),
        tail = escape_braces(tail),
    ))
    .expect("static template")
    // The last character is the one indicatif leaves behind when the bar stops;
    // repeating the first keeps the cycle even.
    .tick_chars("◒◐◓◑◒")
}

/// The progress row, drawn by `indicatif` from a position we set ourselves.
fn progress_style() -> ProgressStyle {
    ProgressStyle::with_template(&format!(
        "{bar}  {{prefix}}  {{bar:{BAR_CELLS}.cyan/white}}  {{msg}}",
        bar = rule().apply_to(BAR),
    ))
    .expect("static template")
    .progress_chars(&PROGRESS_CHARS.to_string())
}

/// A label is data, and a template is not. One brace in a package name would
/// otherwise turn into a placeholder `indicatif` cannot resolve.
fn escape_braces(text: &str) -> String {
    text.replace('{', "{{").replace('}', "}}")
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
    use crate::i18n::{EN, FR};

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

    /// The whole point of the box: every row is the same number of columns
    /// wide, so no border moves while the list fills in.
    #[test]
    fn every_row_of_the_box_is_the_same_width() {
        console::set_colors_enabled(false);
        let inner = 44;
        let width = measure_text_width(&header_line(inner, "Installing TERN"));

        let rows = [
            framed(&pending_row(inner, "Pulling the images")),
            framed(&row(
                inner,
                &DONE.to_string(),
                &Style::new(),
                "Writing the configuration",
                &Style::new(),
                "(3m05s)",
            )),
            framed(&" ".repeat(inner)),
            footer_line(inner),
        ];

        for line in rows {
            assert_eq!(measure_text_width(&line), width, "{line:?}");
        }
    }

    /// Renaming a step to the package it turned out to install widens the box
    /// rather than swallowing the name — but only up to the terminal, past
    /// which a box is no longer a box.
    #[test]
    fn a_renamed_step_gets_the_room_its_name_needs() {
        console::set_colors_enabled(false);
        let announced = vec![
            "Refreshing the package lists".to_string(),
            "Installing Docker Compose (…)".to_string(),
        ];
        let narrow = inner_width("Installing Docker", &announced, 12);

        let named = vec![
            announced[0].clone(),
            "Installing Docker Compose (docker-compose-plugin)".to_string(),
        ];
        let wider = inner_width("Installing Docker", &named, 12);

        assert!(wider > narrow, "{wider} is no wider than {narrow}");
        assert!(framed(&pending_row(wider, &named[1])).contains("docker-compose-plugin"));
        assert!(wider + CHROME <= 80, "wider than a console: {wider}");
    }

    /// A label nobody could have predicted — a package name substituted into a
    /// step once it is known — is cut to the box rather than allowed to move it.
    #[test]
    fn a_label_too_long_for_the_box_is_cut_and_not_wrapped() {
        console::set_colors_enabled(false);
        let inner = 40;
        let long = "Installing Docker Compose (docker-compose-plugin-with-a-very-long-name)";
        let line = framed(&pending_row(inner, long));

        assert_eq!(measure_text_width(&line), inner + CHROME);
        assert!(line.contains(&ELLIPSIS.to_string()));
    }

    /// Room for the longest note the right-hand column can ever hold, so that
    /// `already there` and `(12m34s)` both land inside the frame.
    #[test]
    fn the_box_is_sized_for_the_notes_it_will_have_to_hold() {
        console::set_colors_enabled(false);
        let labels = vec!["Waiting for the API".to_string()];
        let inner = inner_width("Installing TERN", &labels, 12);
        let line = framed(&row(
            inner,
            &DONE.to_string(),
            &Style::new(),
            "Waiting for the API",
            &Style::new(),
            EN.note_already,
        ));
        assert_eq!(measure_text_width(&line), inner + CHROME);
        assert!(line.contains(EN.note_already));
    }

    #[test]
    fn the_counter_counts_steps_in_both_languages() {
        assert_eq!(counter_text(EN.step_counter, 4, 9), "Step 4 of 9");
        assert_eq!(counter_text(FR.step_counter, 4, 9), "Étape 4 sur 9");
    }

    #[test]
    fn the_bar_reads_the_steps_and_nothing_else() {
        assert_eq!(percent(0, 6).trim(), "0%");
        assert_eq!(percent(3, 6).trim(), "50%");
        assert_eq!(percent(6, 6).trim(), "100%");
        // A list with no steps is finished by definition, not stuck at zero.
        assert_eq!(percent(0, 0).trim(), "100%");
    }

    /// `indicatif` reads `{}` as a placeholder; a package name is not one.
    #[test]
    fn a_brace_in_a_label_never_reaches_the_template() {
        assert_eq!(escape_braces("gcc-{13}"), "gcc-{{13}}");
    }
}
