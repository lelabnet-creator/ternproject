//! The agent's own recent output, kept so it can be asked for.
//!
//! An agent's log goes to journald, to launchd, or to a file — none of which it
//! owns, and none of which exists on every platform it runs on. Reading any of
//! them back means shelling out to a tool that is present on some machines,
//! permitted on fewer, and absent on Windows entirely. And the machine that
//! most needs its log read is the one behind a relay, where nobody can log in
//! to run that tool anyway.
//!
//! So the agent keeps its own copy. Every line it emits also lands here, in a
//! ring that forgets the oldest when it is full.
//!
//! What that honestly is, and is not:
//!
//! - It is **this process's** lines, since **this process started**. A restart
//!   empties it, which matters: the log of why something restarted is not in
//!   the buffer of the thing that came back.
//! - It is bounded. A busy agent overwrites its own history in minutes, and the
//!   bound is what keeps a monitoring agent from growing without limit on a
//!   machine it was put there to watch.
//! - It is not the system log. Anything the supervisor said — that the unit
//!   failed, that it was killed — was said about this process, not by it, and
//!   is not here.
//!
//! The alternative was a `journalctl` call, which would be more complete on the
//! machines where it works and nothing at all on the rest. This works the same
//! everywhere, which is what makes it worth reading.

use std::collections::VecDeque;
use std::io;
use std::sync::{Mutex, OnceLock};

/// How many lines are kept.
///
/// Two thousand is a few minutes of a chatty agent and hours of a quiet one, and
/// costs a few hundred kilobytes at the widths these lines actually reach. Small
/// enough to send in one request without thinking about it, which is the whole
/// point of having it.
const CAPACITY: usize = 2_000;

/// Cut long enough to keep a message and short enough that one line cannot fill
/// the ring by itself.
const MAX_LINE: usize = 2_000;

fn ring() -> &'static Mutex<VecDeque<String>> {
    static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
}

/// Everything currently held, oldest first, as one block of text.
pub fn snapshot() -> String {
    let Ok(lines) = ring().lock() else {
        // Poisoned means a thread panicked while writing a log line. Saying so
        // is more useful than an empty answer that reads as "nothing happened".
        return "the log buffer is unavailable (a writer panicked)\n".to_string();
    };
    let mut out = String::new();
    for line in lines.iter() {
        out.push_str(line);
    }
    out
}

/// How many lines are held right now. For the page, and for the tests.
pub fn len() -> usize {
    ring().lock().map(|lines| lines.len()).unwrap_or(0)
}

fn push(line: String) {
    let Ok(mut lines) = ring().lock() else { return };
    if lines.len() == CAPACITY {
        lines.pop_front();
    }
    lines.push_back(line);
}

/// The writer `tracing` hands formatted lines to.
///
/// Stateless, because `MakeWriter` builds one per event and the ring itself is
/// where everything lives.
#[derive(Clone, Copy, Default)]
pub struct RingWriter;

impl io::Write for RingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        /*
         * Lossy rather than a refusal.
         *
         * A log line that is not valid UTF-8 is still worth most of what it
         * says, and returning an error here would make the logging layer report
         * a failure about the failure it was in the middle of reporting.
         */
        let mut line = String::from_utf8_lossy(buf).into_owned();
        if line.len() > MAX_LINE {
            line.truncate(MAX_LINE);
            line.push_str(" …[cut]\n");
        }
        push(line);
        // The whole buffer, always: a short write would make the caller retry
        // the rest as though it had not been stored.
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RingWriter {
    type Writer = RingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        *self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn what_is_written_can_be_read_back() {
        let mut w = RingWriter;
        w.write_all(b"first line\n").unwrap();
        w.write_all(b"second line\n").unwrap();

        let out = snapshot();
        assert!(out.contains("first line"));
        assert!(out.contains("second line"));
        // Oldest first: a log read bottom-up is a log read wrong.
        assert!(out.find("first").unwrap() < out.find("second").unwrap());
    }

    #[test]
    fn one_line_cannot_fill_the_ring() {
        let mut w = RingWriter;
        let huge = "x".repeat(MAX_LINE * 3);
        w.write_all(huge.as_bytes()).unwrap();

        let out = snapshot();
        assert!(out.contains("…[cut]"), "said so rather than silently short");
        assert!(out.len() < MAX_LINE + 64);
    }

    #[test]
    fn the_oldest_lines_go_first() {
        // The bound doing its job. Written after the two tests above, which
        // share the ring, so this asserts the cap rather than an exact count.
        let mut w = RingWriter;
        for i in 0..CAPACITY + 50 {
            w.write_all(format!("line {i}\n").as_bytes()).unwrap();
        }
        assert_eq!(len(), CAPACITY);
        let out = snapshot();
        assert!(
            out.contains(&format!("line {}", CAPACITY + 49)),
            "keeps the newest"
        );
        assert!(!out.contains("line 0\n"), "drops the oldest");
    }

    /// Invalid UTF-8 must not take the logging layer down with it.
    #[test]
    fn a_line_that_is_not_utf8_is_kept_anyway() {
        let mut w = RingWriter;
        assert!(w.write_all(&[0xff, 0xfe, b'o', b'k', b'\n']).is_ok());
        assert!(snapshot().contains("ok"));
    }
}
