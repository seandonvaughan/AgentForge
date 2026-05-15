# V2 Layout Shell

Four Svelte 5 runes-mode components that wrap every page and provide the visual
chrome for the enterprise dashboard.

---

## Components

### `Topbar.svelte` — 44px, full width

Logo mark + wordmark at left, search input in the centre, running-cycle widget
+ avatar at right. Polls `/api/v5/cycles?limit=1&status=running` every 5 s;
pauses when `document.visibilityState === 'hidden'`.

**Usage**
```svelte
<script lang="ts">
  import { Topbar } from '$lib/components/v2/layout';
</script>

<Topbar />
```

---

### `StatusLine.svelte` — 22px, full width

Three coloured service dots (api / ws / sse), operator counters, and a
JetBrains Mono clock at the far right.

- Polls `/api/v5/health/services` every 7.5 s for dot colours.
- Polls `/api/v5/counters` every 10 s. Falls back to derived counts from
  `/api/v5/cycles` + `/api/v5/agents` if the counters endpoint returns non-200.
  **`/api/v5/counters` does not yet exist** — see missing-endpoints note below.

**Usage**
```svelte
<script lang="ts">
  import { StatusLine } from '$lib/components/v2/layout';
</script>

<StatusLine />
```

---

### `Sidebar.svelte` — 48 px collapsed / 220 px expanded, left edge

20+ nav items grouped into Operations / Insights / System / Settings. Icon-only
when collapsed; icon + label when expanded.

- Pin button toggles collapsed/expanded; state persists in `localStorage` under
  `af2-sidebar-pinned`.
- When collapsed, hover expands as an absolute-positioned overlay — main content
  does NOT shift.
- Active route gets accent left border + `--af-purple` text colour.
- Icons sourced from `lucide-svelte`.

**Usage**
```svelte
<script lang="ts">
  import { Sidebar } from '$lib/components/v2/layout';
</script>

<Sidebar />
```

---

### `Layout.svelte` — CSS Grid wrapper

Composes the three components above into a 2-column × 3-row grid:

```
grid-template-areas:
  "topbar  topbar"   /* 44px */
  "status  status"   /* 22px */
  "sidebar main"     /* 1fr  */
```

Column widths track `af2-sidebar-pinned` via a `storage` event listener so the
grid re-collapses when the user pins/unpins from the Sidebar without a page
reload.

**Usage**
```svelte
<script lang="ts">
  import Layout from '$lib/components/v2/layout/Layout.svelte';
</script>

<Layout>
  <p>Page content here</p>
</Layout>
```

---

## Reduced motion

All animation durations collapse to `0ms` when
`prefers-reduced-motion: reduce` is active — pulse dot, stage-brick glow, and
sidebar width transition are all gated on a `reducedMotion` derived rune.

---

## Missing endpoints (flag for wire-up wave)

| Endpoint | Status | Notes |
|---|---|---|
| `/api/v5/counters` | **MISSING** | StatusLine falls back to `/api/v5/cycles` + `/api/v5/agents` for partial counts |
| `/api/v5/health/services` | Unknown | Health endpoint at `/api/v5/health` exists; `/services` sub-path needs confirmation |
| `/api/v5/cycles?status=running` | Likely exists | Topbar polls this; `status` filter may not be implemented |

---

## Wire-up wave notes

The current root layout (`packages/dashboard/src/routes/+layout.svelte`) uses
the V1 `Topbar` and `Sidebar` from `$lib/components/`. To activate V2:

1. Replace the imports in `+layout.svelte` with `Layout` from `$lib/components/v2/layout`.
2. Move the `wsStore`, `approvalsStore`, `loadAgents` etc. initialisation into
   a `+layout.ts` load function or keep it in the Layout component.
3. Remove the old `.app-layout` CSS grid from `app.css` (or namespace it as
   `.v1-layout`) to avoid conflicts.
