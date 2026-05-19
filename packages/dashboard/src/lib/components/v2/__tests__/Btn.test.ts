import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Btn from '../Btn.svelte';

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
  it('invokes onClick when the rendered button is clicked', async () => {
    const onClick = vi.fn();
    const { getByRole } = render(Btn, { props: { onClick } });

    await fireEvent.click(getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('invokes lowercase onclick from Svelte page markup', async () => {
    const onclick = vi.fn();
    const { getByRole } = render(Btn, { props: { onclick } });

    await fireEvent.click(getByRole('button'));

    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('exposes a non-reserved onClick prop and wires it to the native button', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).toContain('onClick?: (e: MouseEvent) => void;');
    expect(source).toContain('onclick?: (e: MouseEvent) => void;');
    expect(source).toContain('const clickHandler = $derived(onClick ?? onclick);');
    expect(source).toContain("buttonEl.addEventListener('click', clickHandler);");
    expect(source).toContain('bind:this={buttonEl}');
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
