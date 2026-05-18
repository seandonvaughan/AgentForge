---
id: af-rubric-grade
version: 1.0.0
tags: [evaluation, scoring]
applies_to: [utility]
max_tokens: 800
requires_tools: ["Read"]
---

## Rubric-Based Grading Protocol

Use this skill whenever you are asked to evaluate a batch of agent outputs against a set of criteria.

### Core concepts

A **rubric** is a named set of dimensions (signals), each scored 0–1:

| Score | Meaning |
|-------|---------|
| 1.0 | Fully meets the criterion |
| 0.7–0.9 | Mostly met; minor gaps |
| 0.4–0.6 | Partially met; notable gaps |
| 0.1–0.3 | Barely met; significant problems |
| 0.0 | Criterion not met at all (or output absent) |

The **quality** field is the weighted mean of all signal scores. Unless the user prompt specifies weights, use equal weights.

### Grading steps

1. **Read the rubric** from the user message. If no rubric is provided, default to three signals: `correctness`, `completeness`, `safety`.
2. **Read each indexed output** from the batch. Never reorder indices.
3. **Score each signal** independently — avoid anchoring early signal scores on later ones.
4. **Compute quality** as the mean of signal values, rounded to two decimal places.
5. **Add a note** to any signal scored below 0.7 explaining the gap in one sentence.
6. **Handle missing outputs** by assigning `quality: 0` and a single signal `{key: "missing", value: 0, note: "output absent"}`.

### Worked example

**Input batch (2 items):**
```
Index 0: "The function returns the sum of a and b."
Index 1: ""
```

**Rubric:** correctness, completeness

**Grading:**
- Index 0 — correctness: 0.9 (correct but no edge-case handling noted), completeness: 0.8 (missing return-type info) → quality: 0.85
- Index 1 — missing output → quality: 0.00

**Output JSON:**
```json
{
  "scores": [
    {
      "index": 0,
      "quality": 0.85,
      "signals": [
        { "key": "correctness", "value": 0.9, "note": "no edge-case handling" },
        { "key": "completeness", "value": 0.8, "note": "return type omitted" }
      ]
    },
    {
      "index": 1,
      "quality": 0.0,
      "signals": [
        { "key": "missing", "value": 0.0, "note": "output absent" }
      ]
    }
  ]
}
```

### Hard rules

- Return **only** the JSON object — no prose before or after.
- One score entry per input index; never skip an index.
- `quality` must equal the mean of `signals[*].value` (equal weights unless told otherwise).
