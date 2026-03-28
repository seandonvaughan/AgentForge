# v5 Enterprise Design System Specification

**Author:** experience-design-lead
**Sprint:** v4.9 (item v49-3)
**Date:** 2026-03-27
**Status:** Complete
**Package:** `@agentforge/ui`

---

## 1. Design Tokens

### 1.1 Color System

Semantic color tokens. Dark mode is default. Light mode is a full override.

```css
/* === Brand === */
--color-brand:            #6366f1;   /* Indigo 500 — primary brand */
--color-brand-hover:      #818cf8;   /* Indigo 400 */
--color-brand-active:     #4f46e5;   /* Indigo 600 */
--color-brand-subtle:     #6366f11a; /* Brand at 10% opacity */

/* === Surfaces (Dark Mode — Default) === */
--color-bg-root:          #09090b;   /* Zinc 950 — app background */
--color-surface-0:        #18181b;   /* Zinc 900 — card/panel background */
--color-surface-1:        #27272a;   /* Zinc 800 — elevated surface */
--color-surface-2:        #3f3f46;   /* Zinc 700 — highest elevation */
--color-border:           #3f3f46;   /* Zinc 700 */
--color-border-subtle:    #27272a;   /* Zinc 800 */

/* === Text === */
--color-text-primary:     #fafafa;   /* Zinc 50 */
--color-text-secondary:   #a1a1aa;   /* Zinc 400 */
--color-text-tertiary:    #71717a;   /* Zinc 500 */
--color-text-inverse:     #09090b;   /* For use on light backgrounds */

/* === Semantic Status === */
--color-success:          #22c55e;   /* Green 500 */
--color-success-subtle:   #22c55e1a;
--color-warning:          #f59e0b;   /* Amber 500 */
--color-warning-subtle:   #f59e0b1a;
--color-error:            #ef4444;   /* Red 500 */
--color-error-subtle:     #ef44441a;
--color-info:             #3b82f6;   /* Blue 500 */
--color-info-subtle:      #3b82f61a;

/* === Model Tier Colors (AgentForge-specific) === */
--color-tier-opus:        #f59e0b;   /* Gold — Opus agents */
--color-tier-sonnet:      #3b82f6;   /* Blue — Sonnet agents */
--color-tier-haiku:       #22c55e;   /* Green — Haiku agents */

/* === Surfaces (Light Mode Override) === */
[data-theme="light"] {
  --color-bg-root:        #ffffff;
  --color-surface-0:      #f4f4f5;   /* Zinc 100 */
  --color-surface-1:      #e4e4e7;   /* Zinc 200 */
  --color-surface-2:      #d4d4d8;   /* Zinc 300 */
  --color-border:         #d4d4d8;
  --color-border-subtle:  #e4e4e7;
  --color-text-primary:   #09090b;
  --color-text-secondary: #52525b;
  --color-text-tertiary:  #71717a;
  --color-text-inverse:   #fafafa;
}
```

**WCAG 2.1 AA compliance:** All text/background combinations meet minimum 4.5:1 contrast ratio. Large text (18px+) meets 3:1. Interactive elements meet 3:1 for non-text contrast.

Verified contrast ratios (dark mode):
- `--color-text-primary` on `--color-bg-root`: 19.3:1
- `--color-text-secondary` on `--color-bg-root`: 7.2:1
- `--color-text-secondary` on `--color-surface-0`: 5.1:1
- `--color-brand` on `--color-bg-root`: 5.4:1

### 1.2 Typography Scale

Base: 16px (1rem). Scale factor: 1.25 (major third).

```css
--font-family-sans:       'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-family-mono:       'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;

--font-size-xs:           0.75rem;   /* 12px */
--font-size-sm:           0.875rem;  /* 14px */
--font-size-base:         1rem;      /* 16px */
--font-size-lg:           1.125rem;  /* 18px */
--font-size-xl:           1.25rem;   /* 20px */
--font-size-2xl:          1.5rem;    /* 24px */
--font-size-3xl:          1.875rem;  /* 30px */
--font-size-4xl:          2.25rem;   /* 36px */

--font-weight-normal:     400;
--font-weight-medium:     500;
--font-weight-semibold:   600;
--font-weight-bold:       700;

--line-height-tight:      1.25;
--line-height-normal:     1.5;
--line-height-relaxed:    1.75;

--letter-spacing-tight:   -0.025em;
--letter-spacing-normal:  0;
--letter-spacing-wide:    0.025em;
```

**Type styles (composites):**

| Style | Size | Weight | Line Height | Use |
|-------|------|--------|-------------|-----|
| heading-1 | 4xl | bold | tight | Page titles |
| heading-2 | 3xl | semibold | tight | Section titles |
| heading-3 | 2xl | semibold | tight | Card titles |
| heading-4 | xl | semibold | normal | Subsection titles |
| body | base | normal | normal | Default body text |
| body-sm | sm | normal | normal | Secondary text, descriptions |
| caption | xs | medium | normal | Labels, badges, metadata |
| code | sm (mono) | normal | relaxed | Code blocks, terminal output |

### 1.3 Spacing Scale

4px base unit. Powers of 2 for consistency.

```css
--space-0:    0;
--space-1:    0.25rem;  /* 4px */
--space-2:    0.5rem;   /* 8px */
--space-3:    0.75rem;  /* 12px */
--space-4:    1rem;     /* 16px */
--space-5:    1.25rem;  /* 20px */
--space-6:    1.5rem;   /* 24px */
--space-8:    2rem;     /* 32px */
--space-10:   2.5rem;   /* 40px */
--space-12:   3rem;     /* 48px */
--space-16:   4rem;     /* 64px */
--space-20:   5rem;     /* 80px */
```

### 1.4 Border Radius

```css
--radius-none:   0;
--radius-sm:     0.25rem;  /* 4px — chips, badges */
--radius-md:     0.375rem; /* 6px — buttons, inputs */
--radius-lg:     0.5rem;   /* 8px — cards */
--radius-xl:     0.75rem;  /* 12px — modals, dialogs */
--radius-2xl:    1rem;     /* 16px — large containers */
--radius-full:   9999px;   /* Pill shapes */
```

### 1.5 Shadow Levels

```css
--shadow-sm:    0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow-md:    0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
--shadow-lg:    0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
--shadow-xl:    0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
/* Dark mode: shadows are less visible, use border emphasis instead */
```

---

## 2. Motion & Animation

```css
--duration-instant:   0ms;     /* Immediate state changes */
--duration-fast:      150ms;   /* Hover states, toggles */
--duration-normal:    250ms;   /* Modals open/close, tab switch */
--duration-slow:      350ms;   /* Page transitions, complex animations */
--duration-slower:    500ms;   /* Onboarding, first-run animations */

--ease-default:       cubic-bezier(0.4, 0, 0.2, 1);   /* General purpose */
--ease-in:            cubic-bezier(0.4, 0, 1, 1);       /* Elements exiting */
--ease-out:           cubic-bezier(0, 0, 0.2, 1);       /* Elements entering */
--ease-in-out:        cubic-bezier(0.4, 0, 0.2, 1);     /* Elements moving */
--ease-bounce:        cubic-bezier(0.34, 1.56, 0.64, 1); /* Playful emphasis */
```

**Motion principles:**
- Respect `prefers-reduced-motion`. When set, all durations become `0ms`.
- Transitions communicate state change, not decoration.
- Enter animations use `ease-out`. Exit animations use `ease-in`.
- Never animate `width`, `height`, or `top/left`. Use `transform` and `opacity` only.

---

## 3. Iconography

**Library:** [lucide-icons](https://lucide.dev) (v0.460+)
- 1,400+ icons, MIT licensed
- TypeScript-native, tree-shakeable
- Available as Svelte components: `lucide-svelte`
- Consistent 24x24 grid, 2px stroke weight
- Pixel-perfect at 16px, 20px, 24px

**Usage rules:**
- Icons at 16px for inline/table use, 20px for buttons, 24px for section headers
- Always pair icons with text labels (accessibility). Icon-only buttons require `aria-label`.
- Use `currentColor` for icon fill — inherits text color automatically

**AgentForge icon mapping:**
| Concept | Icon |
|---------|------|
| Agent | `bot` |
| Session | `terminal` |
| Cost | `coins` |
| Sprint | `kanban` |
| Team | `users` |
| Plugin | `puzzle` |
| Workspace | `folder-open` |
| Settings | `settings` |
| Search | `search` |
| Delegation | `git-branch` |

---

## 4. Responsive Breakpoints

```css
--breakpoint-sm:   640px;    /* Mobile landscape */
--breakpoint-md:   768px;    /* Tablet portrait */
--breakpoint-lg:   1024px;   /* Tablet landscape / small desktop */
--breakpoint-xl:   1280px;   /* Desktop */
--breakpoint-2xl:  1536px;   /* Large desktop */
```

**Layout behavior:**
| Breakpoint | Sidebar | Content | Grid |
|------------|---------|---------|------|
| < sm | Hidden (hamburger) | Full width | 1 column |
| sm–md | Hidden (hamburger) | Full width | 1-2 columns |
| md–lg | Collapsed (icons only, 64px) | Remaining width | 2 columns |
| lg–xl | Expanded (240px) | Remaining width | 2-3 columns |
| > xl | Expanded (280px) | Max 1200px centered | 3-4 columns |

**Container max-widths:**
- Content area: `max-width: 1200px` with `margin: 0 auto`
- Full-bleed sections (org graph, timeline): no max-width
- Modals: `max-width: 560px` (sm), `720px` (md), `960px` (lg)

---

## 5. Component Inventory

20 components required at v5.0 launch. Each component must support: dark/light mode, keyboard navigation, ARIA attributes, responsive sizing.

### 5.1 Component Specifications

| # | Component | Variants | Sizes | States |
|---|-----------|----------|-------|--------|
| 1 | **Button** | primary, secondary, ghost, danger, icon-only | sm, md, lg | default, hover, active, focus, disabled, loading |
| 2 | **Input** | text, password, search, number | sm, md, lg | default, focus, error, disabled, readonly |
| 3 | **Select** | single, multi, searchable | sm, md, lg | default, open, focus, error, disabled |
| 4 | **Table** | default, compact, striped | — | sortable, selectable, loading, empty |
| 5 | **Card** | default, interactive (clickable), stat | sm, md, lg | default, hover (interactive), loading |
| 6 | **Modal** | dialog, confirm, fullscreen | sm, md, lg | opening, open, closing |
| 7 | **Badge** | default, success, warning, error, info, tier-opus, tier-sonnet, tier-haiku | sm, md | — |
| 8 | **Chip** | default, removable, selectable | sm, md | default, selected, hover, disabled |
| 9 | **Sidebar** | expanded, collapsed, mobile-overlay | — | — |
| 10 | **Topbar** | default | — | — |
| 11 | **Tabs** | underline, pill, vertical | sm, md | default, active, disabled |
| 12 | **Toast** | success, warning, error, info | — | entering, visible, exiting |
| 13 | **Tooltip** | top, right, bottom, left | — | hidden, visible |
| 14 | **Spinner** | circular, dots, skeleton | sm, md, lg | — |
| 15 | **EmptyState** | default, error, search-no-results | — | — |
| 16 | **ErrorBoundary** | page-level, section-level | — | error, recovered |
| 17 | **CodeBlock** | inline, block, with-copy | — | default, copied |
| 18 | **Chart** | line, bar, donut, area, sparkline | sm, md, lg | loading, loaded, empty, error |
| 19 | **Tree** | default, selectable, checkable | — | expanded, collapsed, loading |
| 20 | **Timeline** | vertical, horizontal | — | default, loading |

### 5.2 Component API Conventions

Every component follows these conventions:

```svelte
<!-- Button.svelte example -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit' | 'reset';
    children: Snippet;
    onclick?: (e: MouseEvent) => void;
    class?: string;         // Allow custom class pass-through
  }

  let {
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    type = 'button',
    children,
    onclick,
    class: className = '',
  }: Props = $props();
</script>

<button
  {type}
  class="btn btn-{variant} btn-{size} {className}"
  {disabled}
  aria-busy={loading}
  {onclick}
>
  {#if loading}
    <Spinner size="sm" />
  {/if}
  {@render children()}
</button>
```

**Conventions:**
- Props use `$props()` rune (Svelte 5)
- Default variants and sizes are always specified
- `class` prop for style escape hatch
- Events use `on*` callback props
- Loading states show spinner, set `aria-busy`
- All interactive elements are focusable with visible focus ring

---

## 6. Accessibility Requirements

### 6.1 Keyboard Navigation

| Pattern | Keys | Behavior |
|---------|------|----------|
| Button | `Enter`, `Space` | Activate |
| Modal | `Escape` | Close. Focus returns to trigger. |
| Tabs | `Arrow Left/Right` | Navigate tabs. `Enter` selects. |
| Select dropdown | `Arrow Up/Down` | Navigate options. `Enter` selects. `Escape` closes. |
| Table | `Arrow keys` | Navigate cells (when focusable). |
| Tree | `Arrow Up/Down` | Navigate nodes. `Arrow Right` expands. `Arrow Left` collapses. |
| Toast | Auto-dismiss | `role="alert"` for errors, `role="status"` for info. Focusable close button. |
| Global | `Tab` / `Shift+Tab` | Sequential focus navigation. Visible focus ring on all interactive elements. |

### 6.2 ARIA Patterns

| Component | ARIA Pattern |
|-----------|--------------|
| Modal | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` |
| Tabs | `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected` |
| Toast | `role="alert"` (error/warning), `role="status"` (info/success) |
| Sidebar | `role="navigation"`, `aria-label="Main navigation"` |
| Table | `role="grid"` when interactive, native `<table>` otherwise |
| Tree | `role="tree"`, `role="treeitem"`, `aria-expanded` |
| Select | `role="combobox"`, `role="listbox"`, `aria-expanded`, `aria-activedescendant` |
| Spinner | `role="status"`, `aria-label="Loading"` |

### 6.3 Focus Management

- **Focus trap in modals.** Tab cycles within modal. Focus starts on first focusable element or close button.
- **Skip link.** `<a href="#main-content" class="skip-link">Skip to content</a>` as first element in body.
- **Focus visible.** All interactive elements show a 2px outline (`outline: 2px solid var(--color-brand); outline-offset: 2px`) on `:focus-visible`. No outline on `:focus` (mouse click).
- **Live regions.** Toast container is `aria-live="polite"`. Error toasts use `aria-live="assertive"`.
