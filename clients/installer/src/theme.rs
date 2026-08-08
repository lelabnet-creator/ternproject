//! The look — and what it takes for it to survive a server console.
//!
//! cliclack's default theme says "secondary" with `\033[2m`, the SGR *dim*
//! attribute. It uses it for everything that carries a choice: the default
//! value an input offers, the option not currently selected in a yes/no prompt,
//! the separator between the two, the answer once it has been given, and the
//! whole body of a note.
//!
//! On a graphical terminal dim reads as a lighter grey. On the Linux console of
//! a virtual machine — `TERM=linux`, which is the screen anyone installing on a
//! bare server is actually looking at — the kernel's terminal emulator has no
//! dim attribute and drops it. The text is emitted and it is written in
//! invisible ink. A real install showed `● Yes` with no `No` beside it, and
//! inputs offering no default at all; both were there, neither could be read.
//! The wiring was never the problem.
//!
//! So dim is replaced, everywhere it carries information, by a colour that
//! exists. Grey 7 — plain `\033[37m`, the light grey of the sixteen-colour
//! palette — rather than a 256-colour shade: sixteen colours is what a Linux
//! console has, and every terminal since renders that code the same way.
//! Applied unconditionally, not only on the terminals we suspect: a default
//! nobody can see is a default that does not exist, and one honest grey costs a
//! modern terminal nothing.
//!
//! The submitted answer and the body of a note come back to the terminal's own
//! foreground instead. cliclack styles both through the same method, and
//! neither is a footnote: one is what the person chose, the other is the panel
//! that says where the instance now lives.
//!
//! The same console then took a second thing away, and it was not a colour.
//! `TERM=linux` is a terminal whose font is a table of 256 or 512 cells loaded
//! into the video adapter, not a font file with a Unicode map behind it. It has
//! the box-drawing block — that is what those cells were spent on — and it does
//! not have `✓`, `○`, `◐` or `●`. It draws all four as the same substitution
//! glyph. A checklist whose states differ only by that glyph then reads as nine
//! identical lines, and a yes/no whose selection is a `●` beside a `○` says
//! nothing at all. The states were distinct in the code the whole time; they
//! were being drawn through a channel this screen does not have.
//!
//! So the marks move to ASCII where the terminal is one of those, and the state
//! is carried by colour and weight, which that console does have: green for
//! done, bold for running, grey for what has not started. The symbol is left as
//! reinforcement rather than as the signal. See [`charset`] for how a terminal is
//! taken to be one of those, and `checklist` for the marks themselves.

use std::sync::OnceLock;

use cliclack::{Theme, ThemeState};
use console::{style, Emoji, Style};

use crate::i18n::Catalog;

/// The frame characters, with the same fallbacks cliclack uses when the
/// terminal cannot be trusted with Unicode.
///
/// Left as `Emoji`, and deliberately: the box-drawing block is the one thing a
/// Linux console is certain to have, and its own rule — does the locale declare
/// UTF-8 — is the right one for characters that only fail when nothing outside
/// ASCII can be encoded at all.
const BAR: Emoji = Emoji("│", "|");

/// What this terminal can be asked to draw.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Charset {
    /// Anything: there is a font behind this screen.
    Unicode,
    /// ASCII, plus the box-drawing block. Whatever a character was carrying has
    /// to be carried by colour and weight instead.
    Ascii,
}

/// What this terminal has said about itself.
///
/// Two declarations, read in order, and nothing guessed from a list of terminal
/// names:
///
/// * the charset the locale declares. Anything but UTF-8 and nothing outside
///   ASCII can be written down at all, let alone drawn.
/// * the terminal type. `linux` is the one type that declares a screen whose
///   glyphs are a table loaded into the video adapter rather than a font — the
///   console of every VM and of every server without X, and the screen this was
///   reported from. It is matched wherever it appears, so `linux-16color` and
///   `screen.linux` are that console too. `dumb`, and no `TERM` at all, declare
///   even less.
///
/// Every other terminal is taken at its word and given the characters. When
/// that is wrong — a serial line answering to `vt220`, a console font stripped
/// down to Latin-1 — `TERN_ASCII=1` settles it, and `TERN_ASCII=0` forces the
/// characters back on. Having that escape hatch is what makes it honest to stop
/// at one name: a list of terminal types is always one terminal out of date,
/// and it is wrong in the direction nobody can fix from the outside.
pub fn charset() -> Charset {
    static DECIDED: OnceLock<Charset> = OnceLock::new();
    *DECIDED.get_or_init(|| charset_from(|name| std::env::var(name).ok()))
}

/// The rule above, against a made-up environment.
///
/// The reader is a parameter for the same reason it is one in `i18n`: the
/// process environment is global, and a test that sets it decides the answer
/// for every other test running beside it.
pub fn charset_from(read: impl Fn(&str) -> Option<String>) -> Charset {
    match read("TERN_ASCII").as_deref() {
        Some("1") => return Charset::Ascii,
        Some("0") => return Charset::Unicode,
        _ => {}
    }

    // The same order POSIX gives these, and the same order `i18n` reads them
    // in: the first non-empty one decides.
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .filter_map(|name| read(name))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_ascii_uppercase();
    if !(locale.contains("UTF-8") || locale.contains("UTF8")) {
        return Charset::Ascii;
    }

    let term = read("TERM").unwrap_or_default();
    if term.is_empty()
        || term
            .split(['-', '.'])
            .any(|part| part == "linux" || part == "dumb")
    {
        return Charset::Ascii;
    }
    Charset::Unicode
}

/// A character, and what to draw instead where the screen has no font behind
/// it.
///
/// The shape of `console::Emoji`, on purpose — the two sit side by side in this
/// crate — but the question is a different one. `Emoji` asks whether the locale
/// can encode the character; this asks whether the screen can draw it, which on
/// a Linux console under a UTF-8 locale is not the same question at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Glyph(pub &'static str, pub &'static str);

impl Glyph {
    /// The one this terminal can draw.
    pub fn pick(self) -> &'static str {
        match charset() {
            Charset::Unicode => self.0,
            Charset::Ascii => self.1,
        }
    }
}

/// The colour that replaces `dim` throughout.
///
/// Everything the installer draws goes through this one function, the checklist
/// included, so that "secondary" means one thing and can be changed in one
/// place.
pub fn secondary() -> Style {
    Style::new().white()
}

/// A step that is over, and the mark beside it.
///
/// Green, and on the label as well as on the mark. The terminal's own
/// foreground would have been the obvious choice for a line that is simply
/// finished — but on a sixteen-colour console the default foreground and the
/// grey of [`secondary`] are the same light grey, so a finished step and one
/// that has not started would differ by their symbol alone, which is the whole
/// defect this module is answering.
pub fn done() -> Style {
    Style::new().green()
}

/// The step being watched right now.
///
/// Bold. Not a colour: the two that mean something here are already spoken for,
/// and weight is a second channel rather than a third shade — it survives a
/// screen with no colour at all, and it is what the Linux console renders as
/// bright white, which no other row on the list is.
pub fn running() -> Style {
    Style::new().bold()
}

/// The colour of the gutter and of the box rules — structure, not information.
///
/// Bright black on a terminal that has a bright black: it is what cliclack
/// paints its own gutter once a step is submitted, and the checklist has to sit
/// inside that gutter without a seam. Nothing readable is ever drawn in it.
///
/// On the console it is blue, and this is the same defect as the dim ink this
/// module was written for, one shade further along. Colour 8 is the console's
/// idea of a grey that recedes; it renders as the background itself, so the
/// gutter and the box around the checklist were not faint but absent —
/// photographed on a real console, the marks floated at the left margin with
/// nothing joining them, and the closing panel had no frame at all. A frame
/// that was asked for and is not drawn is worse than no frame, because
/// everything inside it is positioned as though it were there.
///
/// Blue rather than the grey of [`secondary`]: at a sixteen-colour console's
/// brightness, grey 7 puts the rules at the weight of the words beside them,
/// and structure that competes with the text is the other way to lose it. Blue
/// is dark, never carries a word body anywhere in this installer, and leaves
/// the gutter reading as one thing with the `i` that already sits in it.
pub fn rule() -> Style {
    rule_for(charset())
}

/// The rule above, for a charset chosen by the caller.
///
/// Split out for the same reason `charset_from` is: `charset()` reads a process
/// environment that a test cannot change without deciding the answer for every
/// other test running beside it.
pub fn rule_for(charset: Charset) -> Style {
    match charset {
        Charset::Unicode => Style::new().black().bright(),
        Charset::Ascii => Style::new().blue(),
    }
}

/// cliclack's theme, with the invisible ink taken out.
pub struct TernTheme {
    c: &'static Catalog,
}

impl TernTheme {
    /// The theme as an ordinary value.
    ///
    /// A prompt reads a keyboard, so the only way to look at one without
    /// answering it is to ask the theme for the fragments it would draw. That
    /// is what `examples/render.rs` does, and it is the only way this fix could
    /// be checked without starting containers on the machine doing the
    /// checking.
    pub fn new(c: &'static Catalog) -> TernTheme {
        TernTheme { c }
    }
}

/// Puts this theme in place for every prompt, log line and note that follows.
///
/// Called once, before the first thing is drawn. The catalog comes with it so
/// that the two words the theme writes on its own — yes and no, which cliclack
/// hard-codes in English — are in the language of the rest of the screen.
pub fn install(c: &'static Catalog) {
    cliclack::set_theme(TernTheme::new(c));
}

impl Theme for TernTheme {
    /// The gutter, in the four states cliclack draws it in.
    ///
    /// Three of them are already visible anywhere — cyan while a question is
    /// open, red on a cancel, yellow on an error. The fourth is the one that
    /// covers most of a finished screen, and cliclack paints it bright black:
    /// invisible on a console. It goes through [`rule`] so that the gutter and
    /// the checklist's own frame stay the same colour whichever terminal is
    /// reading them — they meet, and a seam there would be the one place the
    /// eye is drawn to.
    fn bar_color(&self, state: &ThemeState) -> Style {
        match state {
            ThemeState::Submit => rule(),
            ThemeState::Active => Style::new().cyan(),
            ThemeState::Cancel => Style::new().red(),
            ThemeState::Error(_) => Style::new().yellow(),
        }
    }

    /// The text of an answer, and the body of every note: cliclack routes both
    /// through here. Left at the terminal's own foreground.
    fn input_style(&self, state: &ThemeState) -> Style {
        match state {
            // A cancelled answer is struck through, which says it on its own
            // without needing to be faint as well.
            ThemeState::Cancel => secondary().strikethrough(),
            _ => Style::new(),
        }
    }

    /// The default an input offers, the option not chosen, the separator.
    ///
    /// This is the method the reported defect came down to.
    fn placeholder_style(&self, state: &ThemeState) -> Style {
        match state {
            // Still hidden on cancel: there is no value any more, and showing
            // one would be a lie rather than a faint truth.
            ThemeState::Cancel => Style::new().hidden(),
            _ => secondary(),
        }
    }

    /// The mark cliclack puts in front of a prompt, a note or a log line.
    ///
    /// `◆ ◇ ▲ ■` on a terminal that has them. On the console they are four
    /// names for one substitution glyph, so they become four characters that
    /// differ: a question that is open, a step that is done, something to look
    /// at, something that stopped.
    fn state_symbol(&self, state: &ThemeState) -> String {
        let color = self.state_symbol_color(state);
        match state {
            ThemeState::Active => color.apply_to(Glyph("◆", "?").pick()),
            ThemeState::Submit => color.apply_to(Glyph("◇", "o").pick()),
            ThemeState::Cancel => color.apply_to(Glyph("■", "x").pick()),
            ThemeState::Error(_) => color.apply_to(Glyph("▲", "!").pick()),
        }
        .to_string()
    }

    /// `log::info`, `log::warning`, `log::error` — three states of one gutter,
    /// and on the console they arrived as one shape in three colours.
    fn info_symbol(&self) -> String {
        style(Glyph("●", "i").pick()).blue().to_string()
    }

    fn warning_symbol(&self) -> String {
        style(Glyph("▲", "!").pick()).yellow().to_string()
    }

    fn error_symbol(&self) -> String {
        style(Glyph("■", "x").pick()).red().to_string()
    }

    /// `log::success` — the same `+` the checklist crosses a step off with.
    fn active_symbol(&self) -> String {
        style(Glyph("◆", "+").pick()).green().to_string()
    }

    /// `log::step`, and the head of every box: one shape for "this is behind
    /// us", shared with the checklist's own header.
    fn submit_symbol(&self) -> String {
        style(Glyph("◇", "o").pick()).green().to_string()
    }

    /// Nothing here reads a password yet; the day something does, it should not
    /// be masked with a character the screen cannot draw.
    fn password_mask(&self) -> char {
        Glyph("▪", "*")
            .pick()
            .chars()
            .next()
            .expect("a mask is one char")
    }

    /// The mark in front of an option in a list.
    ///
    /// Not what a yes/no draws any more — see `format_confirm` — but a select
    /// prompt would still come through here.
    fn radio_symbol(&self, state: &ThemeState, selected: bool) -> String {
        match state {
            ThemeState::Active if selected => style(Glyph("●", ">").pick()).green(),
            ThemeState::Active if !selected => secondary().apply_to(Glyph("○", " ").pick()),
            _ => style(""),
        }
        .to_string()
    }

    /// The `◼`/`◻` of a multi-select. Nothing in this installer uses one yet;
    /// the day something does, it should not arrive faint.
    fn checkbox_style(&self, state: &ThemeState, selected: bool, active: bool) -> Style {
        match state {
            ThemeState::Cancel if selected => secondary().strikethrough(),
            ThemeState::Submit if selected => Style::new(),
            _ if !active => secondary(),
            _ => Style::new(),
        }
    }

    /// The two options of a confirmation, in the reader's language, with the
    /// chosen one impossible to mistake.
    ///
    /// cliclack draws this as `● Yes / ○ No`, and both circles come out of a
    /// Linux console as the same lozenge: `◆ Yes / ◆ No`, a question with two
    /// identical answers. The report was the plainest kind — "we cannot tell
    /// whether the green circle or the lozenge is the one that validates".
    ///
    /// So the choice is no longer a symbol. It is the option itself, in reverse
    /// video and between brackets, against the other one in grey. Three things
    /// say it at once and they are independent: the bracket survives a screen
    /// with no attributes at all — a redirected run, a `NO_COLOR` — reverse
    /// video is the one attribute every terminal ever built renders, and the
    /// grey is the same grey the rest of this installer uses for what is not
    /// the point. None of it needs a legend, which was the requirement: the
    /// person reading it has never seen this program before.
    ///
    /// The two options keep the same total width whichever is chosen, so
    /// nothing shifts sideways under the arrow keys.
    fn format_confirm(&self, state: &ThemeState, confirm: bool) -> String {
        let line = match state {
            // The question is open: both answers, one of them held.
            ThemeState::Active | ThemeState::Error(_) => {
                format!(
                    "{}  {}",
                    option(self.c.yes, confirm),
                    option(self.c.no, !confirm)
                )
            }
            // Answered: what is left on the screen is the answer, plainly, the
            // way an answered input leaves the text that was typed.
            _ => {
                let answer = if confirm { self.c.yes } else { self.c.no };
                self.input_style(state).apply_to(answer).to_string()
            }
        };

        format!("{bar}  {line}\n", bar = self.bar_color(state).apply_to(BAR))
    }
}

/// One of the two answers, held or not.
///
/// The brackets are part of the word's box rather than decoration around it:
/// `[ Yes ]` and `  Yes  ` are the same width, so the pair does not move when
/// the choice does.
fn option(label: &str, picked: bool) -> String {
    if picked {
        Style::new()
            .reverse()
            .bold()
            .apply_to(format!("[ {label} ]"))
            .to_string()
    } else {
        secondary().apply_to(format!("  {label}  ")).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{EN, FR};
    use console::measure_text_width;

    const DIM: &str = "\u{1b}[2m";

    /// The escape codes only reach the string when `console` believes it is
    /// writing to a terminal, which under `cargo test` it is not. Forcing it on
    /// is what makes these assertions look at what a real screen receives.
    /// Every test here sets the same value, so the shared global is not a race.
    fn on_a_terminal() {
        console::set_colors_enabled(true);
    }

    #[test]
    fn nothing_a_prompt_draws_is_dim() {
        on_a_terminal();
        let theme = TernTheme { c: &EN };
        let mut drawn = String::new();

        for state in [
            ThemeState::Active,
            ThemeState::Submit,
            ThemeState::Error("nope".into()),
        ] {
            drawn.push_str(&theme.format_confirm(&state, true));
            drawn.push_str(&theme.format_confirm(&state, false));
            drawn.push_str(&theme.placeholder_style(&state).apply_to("8080").to_string());
            drawn.push_str(&theme.input_style(&state).apply_to("8080").to_string());
            drawn.push_str(&theme.radio_symbol(&state, false));
            drawn.push_str(&theme.format_note("Done", "Admin console : http://x/app"));
        }

        assert!(!drawn.contains(DIM), "dim survives in: {drawn:?}");
    }

    /// A frame drawn in the background colour is not a faint frame, it is no
    /// frame — and everything inside it is still laid out as though it were
    /// there. Colour 8 is exactly that on a console.
    #[test]
    fn the_frame_is_not_painted_in_the_console_background() {
        on_a_terminal();

        let console = rule_for(Charset::Ascii).apply_to("|").to_string();
        assert!(
            !console.contains("\u{1b}[90m") && !console.contains("38;5;8"),
            "the console frame is bright black: {console:?}"
        );
        assert!(console.contains("\u{1b}["), "unpainted: {console:?}");

        // And unchanged where bright black is a grey rather than the ground:
        // there the seam with cliclack's own gutter is what matters.
        let terminal = rule_for(Charset::Unicode).apply_to("|").to_string();
        assert!(terminal.contains("38;5;8"), "{terminal:?}");
    }

    /// The gutter cliclack paints and the frame the checklist paints meet on
    /// the screen. They have to be one colour, or the seam is the first thing
    /// the eye lands on.
    #[test]
    fn the_gutter_of_a_finished_prompt_is_the_colour_of_the_frame() {
        on_a_terminal();
        let theme = TernTheme { c: &EN };

        let gutter = theme
            .bar_color(&ThemeState::Submit)
            .apply_to("|")
            .to_string();
        assert_eq!(gutter, rule().apply_to("|").to_string());

        // The three states that were already visible everywhere keep the
        // colours that say which one they are.
        for (name, state, code) in [
            ("active", ThemeState::Active, "\u{1b}[36m"),
            ("cancel", ThemeState::Cancel, "\u{1b}[31m"),
            ("error", ThemeState::Error(String::new()), "\u{1b}[33m"),
        ] {
            let bar = theme.bar_color(&state).apply_to("|").to_string();
            assert!(bar.contains(code), "{name}: {bar:?}");
        }
    }

    /// The default value an input offers is the one thing this whole module
    /// exists for: it has to arrive painted, not merely present.
    #[test]
    fn the_default_value_is_painted_in_the_secondary_colour() {
        on_a_terminal();
        let theme = TernTheme { c: &EN };
        let offered = theme
            .placeholder_style(&ThemeState::Active)
            .apply_to("8080 (default)")
            .to_string();

        assert!(offered.contains("8080 (default)"));
        assert!(offered.contains("\u{1b}[37m"), "{offered:?}");
    }

    #[test]
    fn a_confirmation_speaks_the_language_of_the_question() {
        on_a_terminal();
        let english = TernTheme { c: &EN }.format_confirm(&ThemeState::Active, true);
        assert!(english.contains("Yes") && english.contains("No"));

        let french = TernTheme { c: &FR }.format_confirm(&ThemeState::Active, true);
        assert!(french.contains("Oui") && french.contains("Non"));
    }

    /// Both options are on the screen while the question is open — that is the
    /// whole point of the prompt, and it is what was missing.
    #[test]
    fn both_answers_are_offered_whichever_one_is_the_default() {
        on_a_terminal();
        let theme = TernTheme { c: &EN };
        for default in [true, false] {
            let line = theme.format_confirm(&ThemeState::Active, default);
            assert!(line.contains("Yes"), "{line:?}");
            assert!(line.contains("No"), "{line:?}");
        }
    }

    /// The one that validates, said three ways at once: brackets, reverse
    /// video, and the other one greyed.
    #[test]
    fn the_held_answer_is_bracketed_reversed_and_the_other_greyed() {
        on_a_terminal();
        let theme = TernTheme { c: &EN };

        let yes = theme.format_confirm(&ThemeState::Active, true);
        assert!(yes.contains("[ Yes ]"), "{yes:?}");
        assert!(yes.contains("  No  "), "{yes:?}");
        assert!(yes.contains("\u{1b}[7m"), "no reverse video: {yes:?}");

        let no = theme.format_confirm(&ThemeState::Active, false);
        assert!(no.contains("[ No ]"), "{no:?}");
        assert!(no.contains("  Yes  "), "{no:?}");
    }

    /// Stripped of every attribute — a redirected run, `NO_COLOR`, a terminal
    /// that ignores reverse video — the brackets are still there, and they
    /// still say which one it is.
    #[test]
    fn the_choice_is_readable_with_no_attributes_at_all() {
        on_a_terminal();
        let line = TernTheme { c: &FR }.format_confirm(&ThemeState::Active, false);
        let bare = console::strip_ansi_codes(&line);
        assert!(bare.contains("[ Non ]"), "{bare:?}");
        assert!(bare.contains("  Oui  "), "{bare:?}");
    }

    /// Neither option moves sideways when the choice moves.
    #[test]
    fn the_pair_of_options_keeps_its_width() {
        on_a_terminal();
        let theme = TernTheme { c: &FR };
        assert_eq!(
            measure_text_width(&theme.format_confirm(&ThemeState::Active, true)),
            measure_text_width(&theme.format_confirm(&ThemeState::Active, false))
        );
    }

    /// Once answered, the line says the answer and nothing else — no leftover
    /// option, no bracket around a question that is over.
    #[test]
    fn an_answered_confirmation_shows_only_the_answer() {
        on_a_terminal();
        let line = TernTheme { c: &EN }.format_confirm(&ThemeState::Submit, false);
        let bare = console::strip_ansi_codes(&line);
        assert!(bare.contains("No"), "{bare:?}");
        assert!(!bare.contains("Yes"), "{bare:?}");
        assert!(!bare.contains('['), "{bare:?}");
    }

    /// The two declarations the decision rests on, and the escape hatch.
    #[test]
    fn a_terminal_is_taken_at_its_word() {
        let env = |pairs: &[(&str, &str)]| {
            let owned: Vec<(String, String)> = pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            move |name: &str| {
                owned
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            }
        };

        // The console of a VM: UTF-8 everywhere, and a font that is a table.
        for term in ["linux", "linux-16color", "linux.something"] {
            assert_eq!(
                charset_from(env(&[("LANG", "en_US.UTF-8"), ("TERM", term)])),
                Charset::Ascii,
                "{term}"
            );
        }
        // No TERM at all, and the terminal that declares it can do nothing.
        assert_eq!(charset_from(env(&[("LANG", "C.UTF-8")])), Charset::Ascii);
        assert_eq!(
            charset_from(env(&[("LANG", "C.UTF-8"), ("TERM", "dumb")])),
            Charset::Ascii
        );
        // A locale that cannot even encode the characters.
        assert_eq!(
            charset_from(env(&[
                ("LANG", "en_US.ISO-8859-1"),
                ("TERM", "xterm-256color")
            ])),
            Charset::Ascii
        );
        assert_eq!(
            charset_from(env(&[("TERM", "xterm-256color")])),
            Charset::Ascii
        );

        // Anything else is believed.
        for term in ["xterm-256color", "screen-256color", "tmux-256color", "st"] {
            assert_eq!(
                charset_from(env(&[("LANG", "fr_FR.UTF-8"), ("TERM", term)])),
                Charset::Unicode,
                "{term}"
            );
        }
        // LC_ALL outranks LANG here as it does everywhere else.
        assert_eq!(
            charset_from(env(&[
                ("LC_ALL", "fr_FR.utf8"),
                ("LANG", "fr_FR.ISO-8859-1"),
                ("TERM", "xterm")
            ])),
            Charset::Unicode
        );

        // And the last word belongs to whoever is in front of the screen.
        assert_eq!(
            charset_from(env(&[
                ("TERN_ASCII", "1"),
                ("LANG", "fr_FR.UTF-8"),
                ("TERM", "xterm-256color")
            ])),
            Charset::Ascii
        );
        assert_eq!(
            charset_from(env(&[
                ("TERN_ASCII", "0"),
                ("LANG", "POSIX"),
                ("TERM", "linux")
            ])),
            Charset::Unicode
        );
    }
}
