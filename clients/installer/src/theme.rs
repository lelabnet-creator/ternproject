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

use cliclack::{Theme, ThemeState};
use console::{style, Emoji, Style};

use crate::i18n::Catalog;

/// The frame characters, with the same fallbacks cliclack uses when the
/// terminal cannot be trusted with Unicode.
const BAR: Emoji = Emoji("│", "|");
const RADIO_ON: Emoji = Emoji("●", ">");
const RADIO_OFF: Emoji = Emoji("○", " ");

/// The colour that replaces `dim` throughout.
///
/// Everything the installer draws goes through this one function, the checklist
/// included, so that "secondary" means one thing and can be changed in one
/// place.
pub fn secondary() -> Style {
    Style::new().white()
}

/// The colour of the gutter and of the box rules — structure, not information.
///
/// Bright black, because that is what cliclack paints its own gutter once a
/// step is submitted, and the checklist has to sit inside that gutter without a
/// seam. Nothing readable is ever drawn in it.
pub fn rule() -> Style {
    Style::new().black().bright()
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

    /// The `●` and `○` of a yes/no prompt.
    fn radio_symbol(&self, state: &ThemeState, selected: bool) -> String {
        match state {
            ThemeState::Active if selected => style(RADIO_ON).green(),
            ThemeState::Active if !selected => secondary().apply_to(RADIO_OFF),
            _ => style(Emoji("", "")),
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

    /// The two options of a confirmation, in the reader's language.
    ///
    /// The default implementation is this one with `"Yes"` and `"No"` written
    /// into it. An installer that has just asked its question in French should
    /// not answer it in English, and the override costs the same six lines.
    fn format_confirm(&self, state: &ThemeState, confirm: bool) -> String {
        let yes = self.radio_item(state, confirm, self.c.yes, "");
        let no = self.radio_item(state, !confirm, self.c.no, "");

        let divider = match state {
            ThemeState::Active => self.placeholder_style(state).apply_to(" / ").to_string(),
            _ => String::new(),
        };

        format!(
            "{bar}  {yes}{divider}{no}\n",
            bar = self.bar_color(state).apply_to(BAR)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{EN, FR};

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
}
