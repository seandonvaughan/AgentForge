# Spec: Harden `ProposalToBacklog` fence tracking against nested/mismatched fences

**Date:** 2026-04-11
**Author:** Architect agent (v10.3.0 cycle)
**Status:** Draft — ready for Coder assignment (next cycle)
**Priority:** P2 (chore, correctness)
**Estimated cost:** $6–$10 (one pass, small surface area, test-driven)

## Context

The autonomous cycle's `PLAN` phase calls `ProposalToBacklog.scanTodoMarkers()` (at
`packages/core/src/autonomous/proposal-to-backlog.ts`) to surface `TODO(autonomous):`
and `FIXME(autonomous):` markers from the codebase. The scanner walks every
`.ts/.tsx/.js/.jsx/.mjs/.cjs/.md` file, skips test fixtures and common build
directories, and for each matching line, strips the surrounding comment prefix
and captures the remaining text as a backlog item title.

For `.md` files the scanner attempts to skip fenced code blocks, because code
fences in documentation typically contain *examples* of markers, not real work
items. The current implementation uses a simple boolean toggle:

```ts
let inCodeFence = false;
for (let i = 0; i < lines.length; i++) {
  if (ext === '.md' && /^\s*(`{3,}|~{3,})/.test(lines[i]!)) {
    inCodeFence = !inCodeFence;
    continue;
  }
  if (inCodeFence) continue;
  // ... match markerLine and push BacklogItem
}
```

## Problem

The toggle has no memory of the opening fence's backtick/tilde *count*, so it
cannot distinguish a nested inner fence from a closing fence. In CommonMark the
rules are:

1. A fenced code block opens with ≥3 of the same fence character (`` ` `` or `~`).
2. Only a line with the **same character** and **≥ the opener's length** can
   close it.
3. Inside the block, any other fence-looking line is *literal content*, not a
   structural fence.

The v10.3.0 cycle hit this live: `docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md`
opened a `` ```markdown `` block (3 backticks) containing an embedded example
whose own contents included multiple 3-backtick inner fences. Per CommonMark the
first inner fence actually *closed* the outer block, making the document
structurally invalid markdown even though most renderers tolerate it.

The scanner, using a naive toggle, walked all the nested fences equally and
drifted out of parity by the time it reached a literal marker line 50 lines
deep in the example. It scraped
`<!-- TODO(autonomous): The autonomous loop automatically plans, executes, tests, ... -->`
as a real backlog item and injected it into sprint v10.3.0 as item
`todo-docs-superpowers-plans-2026-04-06-autonomous-loop-part2-md-2541`. The
item's description was aspirational system behavior, not a concrete deliverable,
and got tagged `needs-clarification`.

The document-level symptom has been resolved in this cycle by replacing the
embedded example with a link to the real spec at
`../specs/2026-04-06-autonomous-smoke-test.md`. This spec addresses the
**underlying scanner weakness** so future false positives of the same class
cannot appear.

## Goal

Replace the boolean toggle with a fence-aware state machine that correctly
tracks CommonMark-style fenced code blocks, including:

- Distinguishing fence **character** (`` ` `` vs `~`) — an opener of one kind is
  not closed by a fence of the other kind.
- Tracking the opener's **length** — only a fence line with the same character
  and ≥ the opener's length can close the block.
- Ignoring all fence-looking lines *inside* an open block (they are literal content).

## Non-goals

- **Do not** bring in a full markdown parser (e.g. `remark`, `unified`). The
  scanner is performance-sensitive — it walks the entire repo on every cycle —
  and a full AST pass is overkill. A small stateful parser is sufficient and
  keeps the scanner dependency-free.
- **Do not** extend fence detection to `.ts/.js` files. Those files do not have
  markdown fences; the current regex-prefix guard is the correct mechanism there.
- **Do not** broaden the set of scanned extensions. Scope is strictly the
  correctness of `.md` fence tracking.

## Contract

Add a private method (or inline state) in `scanTodoMarkers` with the following
shape:

```ts
interface FenceState {
  open: boolean;
  char: '`' | '~' | null;   // which fence character opened the block
  len: number;              // number of fence chars in the opener (≥3)
}

// Given the current state and a line, returns the next state and whether
// this line should be treated as "inside a fence" for marker-scraping purposes.
function stepFence(state: FenceState, line: string): {
  next: FenceState;
  isFenceLine: boolean;    // true → this line is a structural fence, caller should `continue`
  insideFence: boolean;    // true → this line is inside an open block (and not itself a fence)
}
```

Replace the existing toggle block in `scanTodoMarkers` with a call to
`stepFence` per line; if `isFenceLine || insideFence`, `continue` without
attempting marker extraction.

### Detection rules

A line is a **fence opener candidate** iff it matches `/^\s{0,3}(`{3,}|~{3,})\s*([^`~\s][^`~\n]*)?\s*$/`.
(CommonMark allows up to 3 spaces of indentation for a top-level fence, an
info string after the fence characters, and forbids additional backticks/tildes
in the info string for the matching character.)

For the scanner's purposes, we can relax "top-level vs indented code block" —
treat *any* leading-whitespace fence as structural, because indented fences
inside list items are common in this repo's documentation.

**Opening:** when `state.open === false` and the line matches the fence-opener
pattern, set `state.open = true`, `state.char = '`' | '~'`, `state.len = count`.

**Closing:** when `state.open === true`, the line closes iff it matches
`/^\s{0,3}(\1{N,})\s*$/` where `\1` is `state.char` and `N` is `state.len`.
A line containing only fence chars of the other kind, or fewer than `state.len`
chars, is **literal content** — `insideFence = true`.

**Content lines inside an open block:** `insideFence = true`, `isFenceLine = false`.

### Acceptance tests

Add to `tests/autonomous/unit/proposal-to-backlog.test.ts`.

> **Marker placeholder in this spec:** to avoid this spec itself being scraped
> by the scanner (the exact bug it describes), the examples below substitute
> `TODO(REDACTED-MARKER)` where the real test fixtures must use
> `TODO` + `(` + `autonomous` + `):`. When writing the fixture files under
> `tests/autonomous/fixtures/` the Coder agent must use the real marker string,
> because those fixtures live inside `tests/` which the scanner already
> excludes via `SKIP_DIRS`, so they cannot pollute the live backlog.

1. **Nested same-kind fences are literal content.**
   Given a markdown file whose content is:
   - a ` ```` ` (4-backtick) opener with info string `markdown`,
   - followed by prose "Here is an example:",
   - followed by a ` ``` ` (3-backtick) `bash` inner block containing a shell
     command, closed with a 3-backtick line,
   - followed by `<!-- TODO(REDACTED-MARKER) this is documentation, not a real marker -->`,
   - followed by two ` ```` ` (4-backtick) lines (the outer closer and a
     trailing blank-fence guard),

   the scanner must produce `items.length === 0` when the fixture uses the
   real marker text.

2. **Fence of the wrong kind does not close.**
   A `~~~`-fenced block that contains literal 3-backtick lines must treat the
   backticks as content. An embedded marker line inside must be skipped.

3. **Shorter closer does not close.**
   A 4-backtick opener followed by a 3-backtick line must remain inside the
   block. An embedded marker line between the 4-backtick open and the
   4-backtick close must be skipped.

4. **Properly matching close exits the block.**
   A 4-backtick opener closed by a 4-backtick (or longer) close must exit the
   block. A marker line *after* the close must be scraped.

5. **Real-world regression:**
   Add a fixture file mirroring the original v10.3.0 drift scenario at
   `tests/autonomous/fixtures/nested-markdown-fence.md`.
   Confirm the scanner produces zero items from it when run against that
   fixture's parent dir.

6. **Genuine top-level marker still scraped.**
   A plain `.md` file with a top-level marker (`<!-- TODO(REDACTED-MARKER) real work -->`
   in this spec; real marker text in the fixture) outside any fence must still
   be scraped. This guards against the fix over-shooting and suppressing
   legitimate markers.

### Budget

- `scanTodoMarkers` is called once per cycle and walks a few hundred files.
  The state machine must be O(lines) with no backtracking and no per-line
  regex compilation. Compile the opener/closer patterns once at module load.

### Out of scope for this item

- Fixing the markdown validity of other planning docs that may have similar
  nested-fence issues. If discovered, those should be logged as separate
  documentation cleanup items. This spec fixes the *scanner*, not the *docs*.

## Rollout

1. Land the scanner change + tests in a single PR.
2. Run the autonomous cycle end-to-end against a dirty-working-tree checkout
   of `docs/` that *intentionally* contains a nested-fence example. Confirm
   the backlog does not include any items from that file.
3. No config migration required; the `todoMarkerPattern` in `autonomous.yaml`
   stays as the capability gate and is unchanged.

## References

- Current implementation:
  `packages/core/src/autonomous/proposal-to-backlog.ts` (`scanTodoMarkers`,
  ~lines 154–256)
- CommonMark fenced code block spec: https://spec.commonmark.org/0.30/#fenced-code-blocks
- Triggering document (now fixed):
  `docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md`
- v10.3.0 sprint item that surfaced this:
  `todo-docs-superpowers-plans-2026-04-06-autonomous-loop-part2-md-2541`
  ("The autonomous loop automatically plans, executes, tests, and commits...")
