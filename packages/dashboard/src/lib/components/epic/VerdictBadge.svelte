<script lang="ts" module>
  // Epic-review verdict vocabulary. Kept in module scope so the
  // verdict->variant mapping is unit-testable without mounting the component.
  export type Verdict =
    | 'approve'
    | 'approved'
    | 'reject'
    | 'rejected'
    | 'revise'
    | 'changes_requested'
    | 'escalate'
    | 'pending';

  export type Variant = 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'muted';

  // verdict -> [variant, display label]
  export const VERDICT_MAP: Record<Verdict, [Variant, string]> = {
    approve:           ['success', 'Approved'],
    approved:          ['success', 'Approved'],
    reject:            ['danger',  'Rejected'],
    rejected:          ['danger',  'Rejected'],
    revise:            ['warning', 'Revise'],
    changes_requested: ['warning', 'Changes Requested'],
    escalate:          ['purple',  'Escalated'],
    pending:           ['muted',   'Pending'],
  };

  // variant -> [text, bg, border] using v2 tokens + color-mix alpha helpers
  const VARIANT_COLORS: Record<Variant, [string, string, string]> = {
    success: ['var(--af-success)', 'color-mix(in srgb,var(--af-success) 8%,transparent)', 'color-mix(in srgb,var(--af-success) 20%,transparent)'],
    warning: ['var(--af-warning)', 'color-mix(in srgb,var(--af-warning) 8%,transparent)', 'color-mix(in srgb,var(--af-warning) 20%,transparent)'],
    danger:  ['var(--af-danger)',  'color-mix(in srgb,var(--af-danger) 8%,transparent)',  'color-mix(in srgb,var(--af-danger) 20%,transparent)'],
    info:    ['var(--af-accent2)', 'color-mix(in srgb,var(--af-accent2) 8%,transparent)', 'color-mix(in srgb,var(--af-accent2) 20%,transparent)'],
    purple:  ['var(--af-purple)',  'color-mix(in srgb,var(--af-purple) 8%,transparent)',  'color-mix(in srgb,var(--af-purple) 20%,transparent)'],
    muted:   ['var(--af-dim)',     'transparent',                                          'var(--af-border3)'],
  };

  export function verdictToVariant(verdict: string): Variant {
    return VERDICT_MAP[verdict as Verdict]?.[0] ?? 'muted';
  }

  export function verdictToLabel(verdict: string): string {
    return VERDICT_MAP[verdict as Verdict]?.[1] ?? verdict;
  }

  export function variantColors(variant: Variant): [string, string, string] {
    return VARIANT_COLORS[variant] ?? VARIANT_COLORS.muted;
  }
</script>

<script lang="ts">
  interface Props {
    verdict: string;
    /** External style override appended last so callers win. */
    style?: string;
    /** External class override (design-system atom contract). */
    class?: string;
  }

  let { verdict, style = '', class: className = '' }: Props = $props();

  const variant = $derived(verdictToVariant(verdict));
  const label = $derived(verdictToLabel(verdict));

  const inlineStyle = $derived.by(() => {
    const [c, bg, border] = variantColors(variant);
    return (
      `font-size:10px;font-weight:600;letter-spacing:0.05em;` +
      `padding:2px 7px;border-radius:4px;` +
      `color:${c};background:${bg};border:1px solid ${border};` +
      `text-transform:uppercase;display:inline-flex;align-items:center;` +
      style
    );
  });
</script>

<span class={className} data-verdict={verdict} style={inlineStyle}>{label}</span>
