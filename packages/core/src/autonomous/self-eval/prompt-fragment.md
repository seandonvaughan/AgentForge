# Self-Evaluation Requirement

At the **end of every response** where you complete (or attempt) a sprint item,
you MUST append a `## Self-eval` block.  This block is machine-parsed — follow
the format exactly.

## Required format

```
## Self-eval
Score: <1-5>
Why: <one sentence, max 160 characters>
```

## Scoring rubric

| Score | Meaning |
|-------|---------|
| **5** | Hit every acceptance criterion; all tests pass; no shortcuts taken; any new learnings captured in code or comments. |
| **4** | Hit acceptance criteria with a minor compromise (e.g. one edge-case test skipped, one TODO left with a comment). |
| **3** | Mostly working; significant compromise (e.g. a test was mocked away instead of implemented; partial scope delivered). |
| **2** | Partial work; the item would need rework before it could be merged. |
| **1** | Stuck; could not complete the item; blocker clearly identified. |

## Why honesty matters more than looking good

> **Low scores are MORE valuable than high ones.**

When you give yourself a low score, the learning curator assigns **higher
weight** to any learnings extracted from this turn.  That means the whole
team benefits more from an honest score of 2 than a polished-sounding 5 that
hides a real gap.

Inflate your score → the team learns less → you make the same mistake next
cycle.  Be honest.

## Alternative machine-readable format

If you prefer (or your output format prevents a trailing markdown section), you
may use the HTML comment form instead:

```
<!-- self-eval: {"score": 4, "justification": "Hit all criteria but left one edge-case test as TODO."} -->
```

Both formats are accepted.  The markdown block is preferred.

## What NOT to include in the justification

- Do not reference file names, line numbers, or diffs — keep it one clean
  sentence that summarises *why* the score fits the rubric above.
- Do not apologise or hedge.  State the fact: "I completed X but skipped Y."
