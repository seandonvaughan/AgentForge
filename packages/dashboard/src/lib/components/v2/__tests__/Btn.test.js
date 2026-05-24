import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const componentPath = resolve(import.meta.dirname, '../Btn.svelte');
describe('Btn', () => {
    it('exposes a non-reserved onClick prop and wires it to the native button', () => {
        const source = readFileSync(componentPath, 'utf8');
        expect(source).toContain('onClick?: (e: MouseEvent) => void;');
        expect(source).toContain('onclick?: (e: MouseEvent) => void;');
        expect(source).toContain('const clickHandler = $derived(onClick ?? onclick);');
        expect(source).toContain('onclick={clickHandler}');
    });
    it('renders button and anchor branches declaratively', () => {
        const source = readFileSync(componentPath, 'utf8');
        expect(source).toContain('{#if href}');
        expect(source).toContain('<a {href}');
        expect(source).toContain('<button {type} {disabled}');
    });
    it('does not install click listeners imperatively after render', () => {
        const source = readFileSync(componentPath, 'utf8');
        expect(source).not.toContain("addEventListener('click'");
        expect(source).not.toContain('bind:this=');
    });
});
