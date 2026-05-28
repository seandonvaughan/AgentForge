import { describe, expect, it } from 'vitest';
import { shouldReuseExistingServer } from '../../playwright.config';

describe('shouldReuseExistingServer', () => {
  it('defaults to reusing servers for local runs', () => {
    expect(shouldReuseExistingServer({})).toBe(true);
  });

  it('disables reuse locally when PLAYWRIGHT_REUSE_SERVER opts out', () => {
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: '0' })).toBe(false);
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: 'false' })).toBe(false);
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: 'no' })).toBe(false);
  });

  it('keeps positive local override behavior', () => {
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: '1' })).toBe(true);
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: 'true' })).toBe(true);
    expect(shouldReuseExistingServer({ PLAYWRIGHT_REUSE_SERVER: 'yes' })).toBe(true);
  });

  it('never reuses servers on CI', () => {
    expect(shouldReuseExistingServer({ CI: '1' })).toBe(false);
    expect(shouldReuseExistingServer({ CI: 'true', PLAYWRIGHT_REUSE_SERVER: '1' })).toBe(false);
  });
});
