import { describe, it, expect } from 'vitest';
import { bumpVersion } from '../../../packages/core/src/autonomous/version-bumper.js';

describe('bumpVersion', () => {
  it.each([
    // [currentVersion, itemTags, expectedNext]
    ['6.4.0', ['fix'], '6.4.1'],
    ['6.4.0', ['bug'], '6.4.1'],
    ['6.4.0', ['security'], '6.4.1'],
    ['6.4.0', ['chore'], '6.4.1'],
    ['6.4.0', ['docs'], '6.4.1'],
    ['6.4.0', ['refactor'], '6.4.1'],
    ['6.4.0', ['feature'], '6.5.0'],
    ['6.4.0', ['capability'], '6.5.0'],
    ['6.4.0', ['enhancement'], '6.5.0'],
    ['6.4.0', ['new'], '6.5.0'],
    ['6.4.0', ['breaking'], '7.0.0'],
    ['6.4.0', ['architecture'], '7.0.0'],
    ['6.4.0', ['platform'], '7.0.0'],
    ['6.4.0', ['major-ui'], '7.0.0'],
    ['6.4.0', ['rewrite'], '7.0.0'],
    ['6.4.0', ['fix', 'feature'], '6.5.0'],              // highest tier wins
    ['6.4.0', ['fix', 'feature', 'breaking'], '7.0.0'],  // major beats minor beats patch
    ['6.4.0', [], '6.5.0'],                              // default = minor
    ['6.4.9', ['fix'], '6.4.10'],
    ['6.9.9', ['feature'], '6.10.0'],
  ] as const)('bumps %s with tags %o → %s', (current, tags, expected) => {
    expect(bumpVersion(current, [...tags])).toBe(expected);
  });

  it('respects explicit override to major', () => {
    expect(bumpVersion('6.4.0', ['fix'], 'major')).toBe('7.0.0');
  });

  it('respects explicit override to minor', () => {
    expect(bumpVersion('6.4.0', ['fix'], 'minor')).toBe('6.5.0');
  });

  it('respects explicit override to patch', () => {
    expect(bumpVersion('6.4.0', ['breaking'], 'patch')).toBe('6.4.1');
  });

  it('pads legacy 2-segment versions to semver', () => {
    expect(bumpVersion('6.3', ['fix'])).toBe('6.3.1');
    expect(bumpVersion('6.3', ['feature'])).toBe('6.4.0');
  });

  it('strips leading v prefix', () => {
    expect(bumpVersion('v6.4.0', ['fix'])).toBe('6.4.1');
  });

  it('throws on malformed version', () => {
    expect(() => bumpVersion('not-a-version', ['fix'])).toThrow();
  });
});
