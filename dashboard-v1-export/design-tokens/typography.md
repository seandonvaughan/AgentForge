# Typography Tokens

## Font families

| Token | Value | Usage |
|---|---|---|
| `--font-sans` | `'Inter', system-ui, -apple-system, sans-serif` | All body and UI text |
| `--font-mono` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace` | Numbers, IDs, code, log output |

Monospace is used extensively for stat values (cost, counts, durations) to prevent layout reflow during live updates.

## Font size scale

| Token | Value | Usage |
|---|---|---|
| `--text-xs` | `10px` | Nav section labels (uppercase), table headers, badge text, card titles |
| `--text-sm` | `12px` | Body text in tables and nav items, buttons, log text |
| `--text-base` | `13px` | Default body (`<body>` font-size) |
| `--text-md` | `14px` | Medium emphasis body text |
| `--text-lg` | `16px` | Sub-section headers |
| `--text-xl` | `20px` | Page titles (`.page-title`) |
| `--text-2xl` | `24px` | Stat card values |
| `--text-3xl` | `32px` | Large hero numbers |

## Text rendering

- `-webkit-font-smoothing: antialiased` on `<body>` for crisp rendering on macOS/iOS
- `line-height: 1.5` default

## Key typographic patterns

### Nav section labels
```css
font-size: var(--text-xs);   /* 10px */
font-weight: 600;
letter-spacing: 0.08em;
text-transform: uppercase;
color: var(--color-text-faint);
```

### Card titles
```css
font-size: var(--text-xs);   /* 10px */
font-weight: 600;
letter-spacing: 0.08em;
text-transform: uppercase;
color: var(--color-text-muted);
```

### Stat values (big numbers)
```css
font-family: var(--font-mono);
font-size: var(--text-2xl);  /* 24px */
font-weight: 700;
color: var(--color-text);
line-height: 1.2;
```

### Stat labels
```css
font-size: var(--text-xs);   /* 10px */
color: var(--color-text-muted);
text-transform: uppercase;
letter-spacing: 0.06em;
```

### Page title
```css
font-size: var(--text-xl);   /* 20px */
font-weight: 700;
color: var(--color-text);
```

### Table headers
```css
font-size: var(--text-xs);   /* 10px */
font-weight: 600;
letter-spacing: 0.06em;
text-transform: uppercase;
color: var(--color-text-muted);
```

## Motion tokens

| Token | Value | Usage |
|---|---|---|
| `--duration-fast` | `150ms` | Hover transitions, nav active states |
| `--duration-normal` | `250ms` | Panel transitions |
| `--easing-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | Material-style ease-in-out |

## Animations

**Shimmer** (skeleton loading): 1.5s infinite horizontal gradient sweep.

**Pulse** (active stage indicator): 1.6s infinite box-shadow ring expanding from 0 to 6px radius, color `rgba(74,158,255,0.45)` (brand blue).
