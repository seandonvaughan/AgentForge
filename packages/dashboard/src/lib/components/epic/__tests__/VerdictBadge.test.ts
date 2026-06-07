import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  VERDICT_MAP,
  variantColors,
  verdictToLabel,
  verdictToVariant,
} from '../VerdictBadge.svelte';

const componentPath = resolve(import.meta.dirname, '../VerdictBadge.svelte');

describe('VerdictBadge verdict -> variant mapping', () => {
  it('maps approval verdicts to the success variant', () => {
    expect(verdictToVariant('approve')).toBe('success');
    expect(verdictToVariant('approved')).toBe('success');
  });

  it('maps rejection verdicts to the danger variant', () => {
    expect(verdictToVariant('reject')).toBe('danger');
    expect(verdictToVariant('rejected')).toBe('danger');
  });

  it('maps revision verdicts to the warning variant', () => {
    expect(verdictToVariant('revise')).toBe('warning');
    expect(verdictToVariant('changes_requested')).toBe('warning');
  });

  it('maps escalation to the purple variant and pending to muted', () => {
    expect(verdictToVariant('escalate')).toBe('purple');
    expect(verdictToVariant('pending')).toBe('muted');
  });

  it('falls back to the muted variant for unknown verdicts', () => {
    expect(verdictToVariant('totally-unknown')).toBe('muted');
  });

  it('produces human-friendly labels and echoes unknown verdicts verbatim', () => {
    expect(verdictToLabel('approve')).toBe('Approved');
    expect(verdictToLabel('changes_requested')).toBe('Changes Requested');
    expect(verdictToLabel('mystery')).toBe('mystery');
  });

  it('keeps every mapped variant within the v2 Badge variant set', () => {
    const allowed = new Set(['success', 'warning', 'danger', 'info', 'purple', 'muted']);
    for (const [, [variant]] of Object.entries(VERDICT_MAP)) {
      expect(allowed.has(variant)).toBe(true);
    }
  });

  it('resolves each variant to a token-based [text,bg,border] triple', () => {
    const [text, bg, border] = variantColors('success');
    expect(text).toBe('var(--af-success)');
    expect(bg).toContain('color-mix(');
    expect(border).toContain('color-mix(');
  });
});

describe('VerdictBadge atom contract', () => {
  const source = readFileSync(componentPath, 'utf8');

  it('accepts an external class override', () => {
    expect(source).toContain("class: className = ''");
    expect(source).toContain('class={className}');
  });

  it('does no data fetching and imports no workspace packages (pure atom)', () => {
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('@agentforge/');
  });
});
