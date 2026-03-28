/**
 * tests/v5/shared.test.ts
 * Tests for @agentforge/shared — types, constants, and utilities
 * Target: 35+ tests
 */

import { describe, it, expect } from 'vitest';
import {
  generateId,
  nowIso,
  truncate,
  slugify,
  MODEL_IDS,
  API_VERSION,
  API_BASE,
  DEFAULT_PAGINATION,
  WEBSOCKET_EVENTS,
  AUTONOMY_TIERS,
} from '../../packages/shared/src/index.js';

// ── generateId ────────────────────────────────────────────────────────────────

describe('generateId()', () => {
  it('returns a non-empty string', () => {
    expect(typeof generateId()).toBe('string');
    expect(generateId().length).toBeGreaterThan(0);
  });

  it('produces unique ids on repeated calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('contains a hyphen separator', () => {
    expect(generateId()).toMatch(/-/);
  });

  it('uses only alphanumeric and hyphen characters', () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});

// ── nowIso ────────────────────────────────────────────────────────────────────

describe('nowIso()', () => {
  it('returns a valid ISO 8601 date string', () => {
    const ts = nowIso();
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('returns a timestamp close to the current time', () => {
    const before = Date.now();
    const ts = nowIso();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 5);
  });
});

// ── truncate ──────────────────────────────────────────────────────────────────

describe('truncate()', () => {
  it('returns the string unchanged when shorter than max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly at max', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when over max', () => {
    const result = truncate('hello world', 8);
    expect(result.length).toBe(8);
    expect(result.endsWith('…')).toBe(true);
  });

  it('truncates long strings correctly', () => {
    const long = 'a'.repeat(500);
    const result = truncate(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

// ── slugify ───────────────────────────────────────────────────────────────────

describe('slugify()', () => {
  it('converts spaces to hyphens', () => {
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('collapses multiple separators into one hyphen', () => {
    expect(slugify('hello   world')).toBe('hello-world');
  });

  it('removes special characters', () => {
    expect(slugify('AgentForge v5!')).toBe('agentforge-v5');
  });

  it('handles already-slugified strings', () => {
    expect(slugify('my-workspace')).toBe('my-workspace');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

// ── MODEL_IDS ─────────────────────────────────────────────────────────────────

describe('MODEL_IDS', () => {
  it('has an opus entry', () => {
    expect(MODEL_IDS.opus).toBeTruthy();
    expect(typeof MODEL_IDS.opus).toBe('string');
  });

  it('has a sonnet entry', () => {
    expect(MODEL_IDS.sonnet).toBeTruthy();
    expect(typeof MODEL_IDS.sonnet).toBe('string');
  });

  it('has a haiku entry', () => {
    expect(MODEL_IDS.haiku).toBeTruthy();
    expect(typeof MODEL_IDS.haiku).toBe('string');
  });

  it('model IDs contain the model family name', () => {
    expect(MODEL_IDS.opus).toContain('opus');
    expect(MODEL_IDS.sonnet).toContain('sonnet');
    expect(MODEL_IDS.haiku).toContain('haiku');
  });

  it('all three models are distinct', () => {
    const ids = new Set([MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.haiku]);
    expect(ids.size).toBe(3);
  });
});

// ── API constants ─────────────────────────────────────────────────────────────

describe('API_VERSION and API_BASE', () => {
  it('API_VERSION is v5', () => {
    expect(API_VERSION).toBe('v5');
  });

  it('API_BASE includes API_VERSION', () => {
    expect(API_BASE).toContain('v5');
  });

  it('API_BASE starts with /api/', () => {
    expect(API_BASE.startsWith('/api/')).toBe(true);
  });
});

// ── DEFAULT_PAGINATION ────────────────────────────────────────────────────────

describe('DEFAULT_PAGINATION', () => {
  it('has a limit', () => {
    expect(typeof DEFAULT_PAGINATION.limit).toBe('number');
    expect(DEFAULT_PAGINATION.limit).toBeGreaterThan(0);
  });

  it('has a maxLimit greater than limit', () => {
    expect(DEFAULT_PAGINATION.maxLimit).toBeGreaterThan(DEFAULT_PAGINATION.limit);
  });

  it('has a zero offset', () => {
    expect(DEFAULT_PAGINATION.offset).toBe(0);
  });
});

// ── WEBSOCKET_EVENTS ──────────────────────────────────────────────────────────

describe('WEBSOCKET_EVENTS', () => {
  it('SESSION_STARTED is defined', () => {
    expect(WEBSOCKET_EVENTS.SESSION_STARTED).toBeTruthy();
  });

  it('SESSION_COMPLETED is defined', () => {
    expect(WEBSOCKET_EVENTS.SESSION_COMPLETED).toBeTruthy();
  });

  it('SESSION_FAILED is defined', () => {
    expect(WEBSOCKET_EVENTS.SESSION_FAILED).toBeTruthy();
  });

  it('AGENT_MESSAGE is defined', () => {
    expect(WEBSOCKET_EVENTS.AGENT_MESSAGE).toBeTruthy();
  });

  it('COST_UPDATE is defined', () => {
    expect(WEBSOCKET_EVENTS.COST_UPDATE).toBeTruthy();
  });

  it('ANOMALY_DETECTED is defined', () => {
    expect(WEBSOCKET_EVENTS.ANOMALY_DETECTED).toBeTruthy();
  });

  it('PLUGIN_EVENT is defined', () => {
    expect(WEBSOCKET_EVENTS.PLUGIN_EVENT).toBeTruthy();
  });

  it('BUS_EVENT is defined', () => {
    expect(WEBSOCKET_EVENTS.BUS_EVENT).toBeTruthy();
  });

  it('all event values follow name:action pattern', () => {
    for (const v of Object.values(WEBSOCKET_EVENTS)) {
      expect(v).toMatch(/^[a-z]+:[a-z_]+$/);
    }
  });
});

// ── AUTONOMY_TIERS ────────────────────────────────────────────────────────────

describe('AUTONOMY_TIERS', () => {
  it('tier 1 is supervised', () => {
    expect(AUTONOMY_TIERS[1]).toBe('supervised');
  });

  it('tier 3 is autonomous', () => {
    expect(AUTONOMY_TIERS[3]).toBe('autonomous');
  });

  it('tier 5 is principal', () => {
    expect(AUTONOMY_TIERS[5]).toBe('principal');
  });

  it('has exactly 5 tiers', () => {
    expect(Object.keys(AUTONOMY_TIERS).length).toBe(5);
  });

  it('tier names are all strings', () => {
    for (const v of Object.values(AUTONOMY_TIERS)) {
      expect(typeof v).toBe('string');
    }
  });
});
