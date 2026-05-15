# V2 Component Library

Svelte 5 runes-mode translations of the `design/v2-handoff/prototype/shared.jsx` atoms and
`page-rest.jsx` KpiTile. All tokens resolve via `--af-*` CSS custom properties defined in
`src/app.css`. Import from `$lib/components/v2`.

---

## Btn

Primary / purple / ghost / danger button at three sizes.

| Prop | Type | Default | Description |
|---|---|---|---|
| `variant` | `'primary' \| 'purple' \| 'ghost' \| 'danger'` | `'ghost'` | Visual style |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Height and font size |
| `disabled` | `boolean` | `false` | Applies `not-allowed` cursor and 50% opacity |
| `href` | `string` | — | Renders an `<a>` instead of `<button>` |
| `onclick` | `(e: MouseEvent) => void` | — | Click handler |
| `leading` | `Snippet` | — | Content before label |
| `trailing` | `Snippet` | — | Content after label |

```svelte
<Btn variant="primary" size="sm" onclick={launch}>Launch</Btn>
<Btn variant="danger" href="/delete">Delete</Btn>
```

---

## Badge

Status/severity chip with uppercase text.

| Prop | Type | Default | Description |
|---|---|---|---|
| `variant` | `'success' \| 'warning' \| 'danger' \| 'info' \| 'purple' \| 'muted'` | `'muted'` | Colour theme |
| `style` | `string` | `''` | Extra inline CSS appended to the element |

```svelte
<Badge variant="success">done</Badge>
<Badge variant="danger">failed</Badge>
```

---

## Card

Standard dark-surface container.

| Prop | Type | Default | Description |
|---|---|---|---|
| `hover` | `boolean` | `false` | Adds pointer cursor and hover border/bg transition |
| `accent` | `boolean` | `false` | Uses accent-tinted border instead of default |
| `noPad` | `boolean` | `false` | Removes internal padding and sets `overflow:hidden` |
| `onclick` | `(e: MouseEvent) => void` | — | Click handler |
| `style` | `string` | `''` | Extra inline CSS |

```svelte
<Card hover accent>
  <p>Content here</p>
</Card>
```

---

## ModelChip

Opus / Sonnet / Haiku tier chip with tier-specific colour.

| Prop | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | `''` | `'opus'`, `'sonnet'`, or `'haiku'`; renders `—` when empty |
| `size` | `'sm' \| 'md'` | `'sm'` | Controls font size (9px vs 10px) |

```svelte
<ModelChip model="opus" />
<ModelChip model="haiku" size="md" />
```

---

## Tabs

Tab strip with a sliding animated underline.

| Prop | Type | Description |
|---|---|---|
| `tabs` | `{ id: string; label: string; count?: number }[]` | Tab definitions |
| `active` | `string` | ID of the currently active tab |
| `onselect` | `(id: string) => void` | Called when the user clicks a tab |

```svelte
<script>
  let active = $state('overview');
  const tabs = [{ id: 'overview', label: 'Overview' }, { id: 'pipeline', label: 'Pipeline', count: 6 }];
</script>
<Tabs {tabs} {active} onselect={(id) => active = id} />
```

---

## StageRail

Horizontal 6-step pipeline rail (PLAN › STAGE › RUN › VERIFY › COMMIT › REVIEW).

| Prop | Type | Default | Description |
|---|---|---|---|
| `stages` | `('pending' \| 'active' \| 'done' \| 'failed')[]` | `[]` | Status of each of the 6 stages |
| `phases` | `{ durMs?: number; agent?: string }[]` | `[]` | Optional metadata per stage |
| `compact` | `boolean` | `false` | Hides labels; shows track + node only |
| `showAgent` | `boolean` | `false` | Shows agent name below each label |

```svelte
<StageRail stages={['done','done','active','pending','pending','pending']} />
```

---

## StageDots

Compact 6-brick stage indicator for table rows.

| Prop | Type | Default | Description |
|---|---|---|---|
| `stages` | `('pending' \| 'active' \| 'done' \| 'failed')[]` | `[]` | Status of each brick |
| `size` | `'sm' \| 'md'` | `'sm'` | Brick height (12px vs 16px) |

```svelte
<StageDots stages={['done','done','active','pending','pending','pending']} />
```

---

## Sparkline

SVG sparkline with optional gradient fill and terminal dot.

| Prop | Type | Default | Description |
|---|---|---|---|
| `data` | `number[]` | `[]` | Data series to plot |
| `color` | `string` | `'var(--af-purple)'` | Stroke and fill colour |
| `w` | `number` | `80` | SVG width in pixels |
| `h` | `number` | `24` | SVG height in pixels |
| `gradient` | `boolean` | `false` | Render gradient fill + terminal dot |
| `strokeWidth` | `number` | `1.4` | Stroke width |

```svelte
<Sparkline data={[4,8,3,10,6,9]} gradient color="var(--af-success)" />
```

---

## Ring

Progress ring with animated stroke-dashoffset fill (700ms cubic-bezier).

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `number` | `0` | Current value |
| `max` | `number` | `100` | Maximum value |
| `size` | `number` | `44` | Diameter in pixels |
| `stroke` | `number` | `3` | Stroke width |
| `color` | `string` | `'var(--af-accent)'` | Arc colour |
| `track` | `string` | `'var(--af-border)'` | Background ring colour |
| `label` | `string` | — | Centre label text |
| `sub` | `string` | — | Centre sub-label text |

```svelte
<Ring value={73} label="73%" size={60} color="var(--af-success)" />
```

---

## MiniBars

Tiny SVG bar chart.

| Prop | Type | Default | Description |
|---|---|---|---|
| `data` | `number[]` | `[]` | Bar values |
| `color` | `string` | `'var(--af-purple)'` | Fill colour |
| `w` | `number` | `80` | SVG width |
| `h` | `number` | `24` | SVG height |
| `gap` | `number` | `1.5` | Gap between bars in pixels |

```svelte
<MiniBars data={[3,7,2,8,5]} color="var(--af-accent)" w={60} h={20} />
```

---

## DistBar

Segmented distribution bar (e.g. model mix).

| Prop | Type | Default | Description |
|---|---|---|---|
| `segments` | `{ value: number; color: string; label?: string }[]` | `[]` | Segments; widths are proportional to `value` |
| `h` | `number` | `6` | Bar height in pixels |
| `label` | `string` | — | Optional text label above the bar |

```svelte
<DistBar segments={[
  { value: 40, color: 'var(--af-opus)',   label: 'Opus' },
  { value: 35, color: 'var(--af-sonnet)', label: 'Sonnet' },
  { value: 25, color: 'var(--af-haiku)',  label: 'Haiku' },
]} />
```

---

## PulseDot

Animated dot with expanding ring for "live" indicators.

| Prop | Type | Default | Description |
|---|---|---|---|
| `color` | `string` | `'var(--af-success)'` | Dot and ring colour |
| `size` | `number` | `8` | Diameter in pixels |
| `ring` | `boolean` | `true` | Show the pulsing ring (1.6s ease-out) |

```svelte
<PulseDot color="var(--af-purple)" size={6} />
```

---

## AnimNum

Counts up to a target value on mount with 600ms cubic-out easing.

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `number` | `0` | Target value to animate to |
| `decimals` | `number` | `0` | Decimal places |
| `duration` | `number` | `600` | Animation duration in ms |
| `prefix` | `string` | `''` | Text before the number |
| `suffix` | `string` | `''` | Text after the number |
| `mono` | `boolean` | `true` | Apply monospace font |

```svelte
<AnimNum value={1248} prefix="$" decimals={2} />
```

---

## KpiTile

Compact KPI card with optional delta badge, sub-label, live dot, and sparkline.

| Prop | Type | Default | Description |
|---|---|---|---|
| `label` | `string` | `''` | Uppercase label above value |
| `value` | `string \| number` | `''` | Primary metric display |
| `sub` | `string` | — | Secondary line below value |
| `delta` | `string` | — | Delta string (e.g. `'+12%'`); `+` → green, `-` → red |
| `color` | `string` | `'var(--af-text)'` | Value colour |
| `live` | `boolean` | `false` | Shows a purple PulseDot |
| `sparkline` | `number[]` | — | Optional mini sparkline at bottom |

```svelte
<KpiTile label="Running" value={3} color="var(--af-purple)" live delta="+1" />
```
