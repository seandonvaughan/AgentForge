import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CYCLE_DETAIL = resolve(import.meta.dirname, '../routes/cycles/[id]/+page.svelte');

function source(): string {
  return readFileSync(CYCLE_DETAIL, 'utf-8');
}

describe('cycle detail epic live cost polling', () => {
  it('starts decomposition polling for a running visible browser cycle', () => {
    const s = source();

    expect(s).toContain('let epicPollTimer: ReturnType<typeof setInterval> | null = null;');
    expect(s).toMatch(/function startEpicPoll\(\): void \{\s*stopEpicPoll\(\);\s*if \(!browser \|\| document\.visibilityState === 'hidden' \|\| isTerminal\) return;\s*epicPollTimer = setInterval\(\(\) => \{ void loadEpic\(\); \}, 3000\);/);
    expect(s).toMatch(/if \(!epicPollTimer\) startEpicPoll\(\);\s*\}/);
  });

  it('stops decomposition polling when the cycle is hidden, terminal, or destroyed', () => {
    const s = source();

    expect(s).toContain('function stopEpicPoll(): void {');
    expect(s).toContain("if (document.visibilityState === 'hidden') {");
    expect(s).toMatch(/if \(document\.visibilityState === 'hidden'\) \{[\s\S]*?stopEpicPoll\(\);[\s\S]*?return;/);
    expect(s).toMatch(/if \(isTerminal\) \{[\s\S]*?stopEpicPoll\(\);[\s\S]*?return;/);
    expect(s).toMatch(/onDestroy\(\(\) => \{[\s\S]*?stopEpicPoll\(\);/);
  });
});
