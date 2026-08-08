# CONTEXT

## Current Task

All five GitHub tickets (#2–#6) are built and merged into `main`, along with the
unsubscribe fix and the mobile shell. 468 tests pass; typecheck, lint and format
are clean. Nothing is pushed — `main` is 13 commits ahead of `origin/main`.

## Key Decisions

- Incidents, maintenances, badges, monitoring and the tour each landed on their
  own branch, then merged into `main` in that order. All conflicts were
  additive.
- Monitoring counters live in-process: a tenant admin sees their own agents, the
  instance-wide figures need a system-tenant admin.
- The `List-Unsubscribe` defect in BACKLOG.md was a misreading — the header was
  fine, the URL it pointed at matched no route. Corrected there.

## Next Steps

- Push `main` and close #2–#6 (the commit messages carry `Closes #N`).
- Revoke the GitHub PAT that transited in cleartext earlier in this project.
- Named metrics still reach the editor but not the public page; BACKLOG.md has
  the two ways to finish it.
