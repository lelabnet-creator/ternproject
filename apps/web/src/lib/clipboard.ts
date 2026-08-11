/**
 * Copy text to the clipboard, on the origins this product actually runs on.
 *
 * `navigator.clipboard` exists only in a secure context. That means HTTPS, or
 * `localhost` — and **not** `http://192.168.1.40:28999`, which is precisely how
 * a self-hosted instance is reached on a LAN before anyone has put a
 * certificate in front of it. On that origin the whole `clipboard` object is
 * `undefined`, so `navigator.clipboard.writeText(…)` throws a TypeError
 * synchronously inside the click handler, React swallows it, and the button
 * does nothing at all — no copy, no error, no clue. Every Copy button in the
 * admin behaved that way: the badge snippets, the pairing PIN, the install
 * command lines. The one thing they exist for.
 *
 * So: the modern API when it is there, and the deprecated `execCommand('copy')`
 * behind it when it is not. `execCommand` is deprecated but not removed, works
 * without a secure context, and is the only thing that does. It needs a real
 * selection in the document, hence the throwaway textarea.
 *
 * Returns whether the text actually landed on the clipboard, so the caller can
 * say "Copied" or admit it could not. Silence was the bug.
 */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Permission refused, or the document is not focused. Fall through — the
      // legacy path is driven by a user gesture and often works where this
      // did not.
    }
  }
  return legacyCopy(value)
}

/**
 * The pre-`navigator.clipboard` way, still the only one on a plain-HTTP origin.
 *
 * Off-screen rather than hidden: `display:none` and `visibility:hidden` are not
 * selectable, and a selection is the whole mechanism. `readOnly` keeps the
 * mobile keyboard from appearing for the instant it is focused.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false

  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-9999px'
  field.style.opacity = '0'
  document.body.appendChild(field)

  // Restore whatever the reader had selected: copying a URL should not also
  // wipe the paragraph they had highlighted.
  const previous = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : null

  try {
    field.select()
    field.setSelectionRange(0, value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(field)
    if (previous) {
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(previous)
    }
  }
}
