import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package scripts', () => {
  it('keeps verify:product type-safe before product tests run', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const verifyProduct = pkg.scripts?.['verify:product'] ?? '';
    expect(verifyProduct).toContain('check:types');
    expect(verifyProduct.indexOf('check:types')).toBeLessThan(
      verifyProduct.indexOf('test:run'),
    );
  });
});
