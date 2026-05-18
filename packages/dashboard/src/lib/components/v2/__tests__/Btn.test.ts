import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentPath = resolve(import.meta.dirname, '../Btn.svelte');
const sourceRoot = resolve(import.meta.dirname, '../../../..');

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...svelteFiles(full));
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out;
}

describe('Btn', () => {
  it('exposes a non-reserved onClick prop and wires it to the native button', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).toContain('onClick?: (e: MouseEvent) => void;');
    expect(source).toContain("buttonEl.addEventListener('click', onClick);");
    expect(source).toContain('bind:this={buttonEl}');
    expect(source).not.toContain('onclick?: (e: MouseEvent) => void;');
  });

  it('uses onClick on Btn call sites instead of the reserved lowercase event name', () => {
    for (const file of svelteFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8');
      const btnTags = source.match(/<Btn\b[\s\S]*?>/g) ?? [];
      for (const tag of btnTags) {
        expect(tag, file).not.toMatch(/\bonclick=/);
      }
    }
  });
});
