---
description: Manage code/document review lifecycle via V4 bus events
argument-hint: Subcommand — submit | status | list | approve <reviewId>
---

# AgentForge Review

Route and manage reviews through the V4 review lifecycle state machine. All state changes emit bus events — no file-system polling.

## Subcommands

- `submit --doc <path> --reviewer <agent>` — Submit a document for review
- `status <reviewId>` — Show current review state and history
- `list` — List all reviews (filterable: `--pending`, `--active`, `--completed`)
- `approve <reviewId>` — Final approval (requires resolved status)

## What to Do

1. Import `ReviewRouter` from `src/communication/review-router.ts`
2. For `submit`: call `router.submitForReview()` with document details and optional reviewer assignment
3. For `status`: call `router.getReview()` and display the 6-state lifecycle: pending → assigned → in_review → responded → resolved → approved
4. For `list`: call `router.getPendingReviews()` or iterate all reviews, display as table
5. For `approve`: call `router.approve()` — emits `review.lifecycle.approved` on the bus

## Review States

```
pending → assigned → in_review → responded → resolved → approved
```

Each transition publishes a bus event under `review.lifecycle.*`. The `ReviewSessionSerializer` in `src/communication/review-session-serializer.ts` can persist review state to `/.forge/reviews/`.
