# Color Tokens

All colors are CSS custom properties defined in `:root` in `app.css`.

## Dark Theme (default)

### Background / Surface

| Token | Value | Usage |
|---|---|---|
| `--color-bg` | `#0d0d0f` | Page background |
| `--color-bg-elevated` | `#141416` | Topbar, sidebar |
| `--color-bg-card` | `#1a1a1f` | Card backgrounds |
| `--color-bg-card-hover` | `#1f1f25` | Card hover state, table row hover |
| `--color-surface-1` | `#1a1a1f` | Stat card surfaces |
| `--color-surface-2` | `#222228` | Hover fills, skeleton shimmer base |
| `--color-surface-3` | `#2a2a32` | Skeleton shimmer peak |

### Borders

| Token | Value | Usage |
|---|---|---|
| `--color-border` | `#2e2e38` | Default card/table borders, dividers |
| `--color-border-strong` | `#404050` | Emphasized borders, scrollbar hover |

### Text

| Token | Value | Usage |
|---|---|---|
| `--color-text` | `#e8e8f0` | Primary body text |
| `--color-text-muted` | `#7a7a90` | Secondary text, labels, nav items |
| `--color-text-faint` | `#4a4a60` | Nav section labels, disabled states |

### Brand

| Token | Value | Usage |
|---|---|---|
| `--color-brand` | `#5b8af5` | Active nav, primary buttons, links |
| `--color-brand-hover` | `#7aa0f7` | Button hover |

### Model Tiers (AI model color coding)

| Token | Value | Usage |
|---|---|---|
| `--color-opus` | `#f5c842` | Opus model badges and indicators |
| `--color-sonnet` | `#4a9eff` | Sonnet model badges and indicators |
| `--color-haiku` | `#4caf82` | Haiku model badges and indicators |

### Semantic

| Token | Value | Usage |
|---|---|---|
| `--color-success` | `#4caf82` | Success states, completed badges |
| `--color-warning` | `#f5a623` | Warning states, in-progress indicators |
| `--color-danger` | `#e05a5a` | Error states, failed cycle indicators |
| `--color-info` | `#4a9eff` | Informational states (same as Sonnet) |

## Light Theme (`[data-theme="light"]`)

| Token | Dark value | Light value |
|---|---|---|
| `--color-bg` | `#0d0d0f` | `#f5f5f7` |
| `--color-bg-elevated` | `#141416` | `#ffffff` |
| `--color-bg-card` | `#1a1a1f` | `#ffffff` |
| `--color-bg-card-hover` | `#1f1f25` | `#f0f0f5` |
| `--color-surface-1` | `#1a1a1f` | `#ffffff` |
| `--color-surface-2` | `#222228` | `#f5f5f7` |
| `--color-surface-3` | `#2a2a32` | `#ebebef` |
| `--color-border` | `#2e2e38` | `#d8d8e0` |
| `--color-border-strong` | `#404050` | `#b8b8c8` |
| `--color-text` | `#e8e8f0` | `#1a1a2e` |
| `--color-text-muted` | `#7a7a90` | `#606080` |
| `--color-text-faint` | `#4a4a60` | `#a0a0b0` |

> Note: Brand, model tier, and semantic colors do not change between themes.

## Badge color patterns

Badges use `currentColor` for border, with tinted backgrounds:

| Variant | Foreground | Background alpha | Border alpha |
|---|---|---|---|
| `.badge.opus` | `--color-opus` | 8% | 30% |
| `.badge.sonnet` | `--color-sonnet` | 8% | 30% |
| `.badge.haiku` | `--color-haiku` | 8% | 30% |
| `.badge.success` | `--color-success` | 8% | 30% |
| `.badge.warning` | `--color-warning` | 8% | 30% |
| `.badge.danger` | `--color-danger` | 8% | 30% |
| `.badge.muted` | `--color-text-muted` | 0% | `--color-border` |
