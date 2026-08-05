# TERN branding

TERN is AGPL-licensed, so people will fork it, host it and put the mark on
things. These are the rules that keep it recognisable, and the ones that keep a
fork honest about being a fork.

## The mark

A tern in flight: swept wings and the forked tail that identifies the species.
Drawn on a 24×24 grid with a 1.5 stroke so it sits correctly beside Lucide
icons, which the rest of the interface uses.

- `apps/web/public/brand/tern-mark.svg` — the symbol
- `apps/web/public/brand/favicon.svg` — tab icon, theme handling embedded
- `apps/web/src/components/brand/TernMark.tsx` — `<TernMark>` and `<TernWordmark>`

Prefer the component in the app. It inherits `currentColor` and the sizing
scale; an `<img>` cannot be reached by the theme.

## Colour

The mark carries no colour of its own. It paints in `currentColor` and inherits
whatever it sits in — TERN green on a surface, white on the accent, a tenant's
own colour where a tenant has one.

The one exception is the favicon, which embeds `prefers-color-scheme` directly.
A browser tab cannot hand an icon a CSS variable, and without that rule the mark
vanishes against one of the two tab-bar colours.

## Wordmark

Fira Code SemiBold, letter-spaced `0.08em`, set as live text rather than
outlined paths — it stays selectable, searchable and readable to a screen
reader.

## Rules

- **Clear space**: at least half the mark's height on every side.
- **Minimum size**: 20px. Below that the tail fork closes up and it reads as a
  smudge.
- **Monochrome is fine.** Any single colour, as long as it clears 3:1 against
  its background.
- **Do not** stretch it, re-draw it, add a gradient, put it in a badge it was
  not designed for, or pair the wordmark with a different symbol.

## Forks

The AGPL lets you run and modify TERN freely. It does not let you imply that
your fork is this project. If you ship a modified version publicly, use your own
name and mark — keeping ours on someone else's build sends your bug reports to
us and our reputation to you.

Tenant branding is a separate thing entirely: a tenant's logo and accent colour
replace the header of their own status page, and the TERN mark steps back to a
quiet footer credit.
