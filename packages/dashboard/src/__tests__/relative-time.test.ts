import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDuration, relativeTime } from '../lib/util/relative-time.js';

describe('relative-time utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats relative timestamps across display buckets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    expect(relativeTime(null)).toBe('—');
    expect(relativeTime('not-a-date')).toBe('—');
    expect(relativeTime(new Date(Date.now() - 3000).toISOString())).toBe('just now');
    expect(relativeTime(new Date(Date.now() - 30000).toISOString())).toBe('30s ago');
    expect(relativeTime(new Date(Date.now() - 90000).toISOString())).toBe('2m ago');
    expect(relativeTime(new Date(Date.now() - 3600000).toISOString())).toBe('1h ago');
    expect(relativeTime(new Date(Date.now() - 23.5 * 60 * 60 * 1000).toISOString())).toBe('24h ago');
    expect(relativeTime(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())).toBe('yesterday');
    expect(relativeTime(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())).toBe('2d ago');
    expect(relativeTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())).toBe('1mo ago');
    expect(relativeTime(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())).toBe('1y ago');
    expect(relativeTime(new Date(Date.now() + 30000).toISOString())).toBe('in 30s');
    expect(relativeTime(new Date(Date.now() + 90000).toISOString())).toBe('in 2m');
  });

  it('formats millisecond durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(3660000)).toBe('1h 1m');
    expect(formatDuration(-1)).toBe('—');
  });
});
