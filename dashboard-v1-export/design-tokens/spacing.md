# Spacing Tokens

Spacing uses an 8px base unit scale. All values are CSS custom properties.

## Space scale

| Token | Value | Equivalent |
|---|---|---|
| `--space-1` | `4px` | 0.5× base |
| `--space-2` | `8px` | 1× base |
| `--space-3` | `12px` | 1.5× base |
| `--space-4` | `16px` | 2× base |
| `--space-5` | `20px` | 2.5× base |
| `--space-6` | `24px` | 3× base |
| `--space-8` | `32px` | 4× base |
| `--space-10` | `40px` | 5× base |
| `--space-12` | `48px` | 6× base |

Note: Steps 7, 9, 11 are intentionally absent — the scale jumps at these points.

## Border radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `4px` | Badge corners |
| `--radius-md` | `6px` | Buttons |
| `--radius-lg` | `8px` | Cards, stat cards, tables |
| `--radius-xl` | `12px` | Larger panel containers |
| `--radius-full` | `9999px` | Pills, fully rounded elements |

## Shadows

| Token | Value | Usage |
|---|---|---|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.3)` | Subtle depth |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | Card hover elevation |
| `--shadow-lg` | `0 8px 32px rgba(0,0,0,0.5)` | Modals, overlays |

## Layout dimensions

| Token | Value | Usage |
|---|---|---|
| `--sidebar-width` | `220px` | Left navigation sidebar |
| `--topbar-height` | `48px` | Global top bar |

## Common component spacing patterns

| Component | Internal padding |
|---|---|
| Card | `--space-6` (24px) all sides |
| Stat card | `--space-4` (16px) vertical / `--space-5` (20px) horizontal |
| Nav item | `--space-2` (8px) vertical / `--space-4` (16px) horizontal |
| Topbar | `0` vertical / `--space-6` (24px) horizontal |
| Main content area | `--space-6` (24px) all sides |
| Table cell | `--space-2` (8px) vertical / `--space-3` (12px) horizontal |
| Button (default) | `--space-2` (8px) vertical / `--space-4` (16px) horizontal |
| Button (small) | `--space-1` (4px) vertical / `--space-3` (12px) horizontal |
