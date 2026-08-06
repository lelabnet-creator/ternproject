# TERN branding

TERN is AGPL-licensed, so people will fork it, host it and put the mark on
things. These are the rules that keep it recognisable, and the ones that keep a
fork honest about being a fork.

The source of truth is the logo system sheet:
[`apps/web/public/brand/sterne-monoligne-systeme.svg`](apps/web/public/brand/sterne-monoligne-systeme.svg).
It is a specification, not an asset — do not embed it. The working files are
derived from it.

## The mark

A monoline tern head: one continuous stroke from nape to beak, with the eye as a
separate dot.

| File                                | Use                                           |
| ----------------------------------- | --------------------------------------------- |
| `public/brand/tern-mark.svg`        | The glyph alone, `currentColor`               |
| `public/brand/tern-badge.svg`       | The glyph in its rounded container            |
| `public/brand/favicon.svg`          | Tab icon; theme handling embedded             |
| `src/components/brand/TernMark.tsx` | `<TernMark>`, `<TernBadge>`, `<TernWordmark>` |

**Prefer the component in the app.** It inherits `currentColor`, and it applies
the reduction rules below without the call site having to know they exist. An
`<img>` cannot be reached by the theme and gets none of that.

## Reduction — this is not optional

The system sheet specifies an optical correction, not just artwork. A monoline
mark scaled naively goes thin and muddy.

| Rendered size  | Stroke | Eye         |
| -------------- | ------ | ----------- |
| 40px and above | 9      | 4.5         |
| 28–39px        | 10     | 5           |
| 24–27px        | 12     | **removed** |

At 24px the eye is dropped, not shrunk — at that size a 4.5-unit dot is a smudge.

**24px is the floor.** Below it the head profile stops reading as a bird and
becomes a comma. The component clamps to 24 rather than rendering something that
makes the brand look broken rather than small. Where the logo genuinely has to
be smaller, use the badge — the container stays legible when the glyph does not.

## Colour

| Token            | Value     | Role                                    |
| ---------------- | --------- | --------------------------------------- |
| `--brand-ink`    | `#0D2A3F` | The mark, and the dark theme's surfaces |
| `--brand-paper`  | `#EDF2F5` | Light brand surfaces                    |
| `--brand-accent` | `#F2653C` | The beak, in the duotone variant        |

The mark itself carries no colour: it paints in `currentColor` and inherits
whatever it sits in.

**`--brand-accent` is deliberately not wired to `--color-accent`.** The coral
sits within a few ΔE of the `partial` status orange, and a brand colour that
reads as a service state is the one collision a status page cannot afford. Use it
for brand surfaces; never for anything a reader could mistake for a status.

The favicon is the one place colour is baked in, because a browser tab cannot
hand an icon a CSS variable.

## Wordmark

Lowercase `tern`, neutral grotesque, weight 500, tracking `-0.018em` — the
lockup as the sheet sets it. Not the interface's monospace, which belongs to
numbers and timestamps rather than to the name.

Live text rather than outlined paths, so it stays selectable, searchable and
readable to a screen reader.

## Rules

- **Clear space**: at least half the mark's height on every side.
- **Monochrome is fine.** Any single colour clearing 3:1 against its background.
- **Do not** stretch it, redraw it, add a gradient, or pair the wordmark with a
  different symbol.
- **Do not** reintroduce the eye below 28px, or thin the stroke to "match" an
  icon set. The correction exists because the naive version looks wrong.

## Forks

The AGPL lets you run and modify TERN freely. It does not let you imply your fork
is this project. If you ship a modified version publicly, use your own name and
mark — keeping ours on someone else's build sends your bug reports to us and your
reputation to us too.

Tenant branding is a separate thing: a tenant's logo and accent colour replace
the header of their own status page, and the TERN mark steps back to a quiet
footer credit.
