# CONTEXT

## Current Task

All requested work is delivered: widget catalogue and payload contract, page
layout, the Rust agent (jobs at pairing, diagnostics, offline cache), the fleet
screen with the galaxy view, the isolated-network proxy, notifications and
capacity screens, and the docs/ reference.

## Key Decisions

- The proxy speaks the *same* API as TERN, so an agent cannot tell which end it
  is talking to and there is no proxy mode in the agent.
- Assignment comes from the pairing code's `scopeControlIds` — the mechanism the
  schema already had, rather than a second one.
- Server-assigned probes carry `managed`, so a refresh never deletes a probe an
  operator added by hand on the host.

## Next Steps

- Revoke the GitHub PAT that transited in cleartext earlier in this project.
- `List-Unsubscribe` still does not reach the wire (BACKLOG.md) — resolve before
  sending real volume.
- Named metrics reach the editor but not the public page; see BACKLOG.md for the
  two ways to finish it.
