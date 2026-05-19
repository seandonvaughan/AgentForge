import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Btn from '../Btn.svelte';

const componentPath = resolve(import.meta.dirname, '../Btn.svelte');

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
    expect(source).toContain('onclick={clickHandler}');
  });

  it('does not install click listeners imperatively after render', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).not.toContain("addEventListener('click'");
    expect(source).not.toContain('bind:this=');
  });
});
