/**
 * Coverage for loadCycleConfig() — modelCap, effortCap, and fallbackEnabled
 * field handling in autonomous.yaml.
 *
 * These fields are primitive values (not nested objects) that require
 * special-case handling in mergeConfig(). Invalid values must be silently
 * rejected rather than propagated to prevent runtime type confusion.
 *
 * Test scenarios:
 *   1. valid-modelCap: all three ModelTier values merge correctly
 *   2. invalid-modelCap: non-tier values are silently rejected
 *   3. valid-effortCap: all five effort levels merge correctly
 *   4. invalid-effortCap: unknown effort strings are silently rejected
 *   5. fallbackEnabled: boolean field merges correctly
 *   6. combined: modelCap + effortCap + fallbackEnabled applied together
 *   7. missing-file: returns DEFAULT_CYCLE_CONFIG with no modelCap/effortCap
 *   8. empty-file: returns DEFAULT_CYCLE_CONFIG when autonomous.yaml is blank
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCycleConfig, DEFAULT_CYCLE_CONFIG } from '../config-loader.js';

let tmpDir: string;
let agentforgeDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-config-loader-'));
  agentforgeDir = join(tmpDir, '.agentforge');
  mkdirSync(agentforgeDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAutonomousYaml(content: string): void {
  writeFileSync(join(agentforgeDir, 'autonomous.yaml'), content, 'utf8');
}

describe('loadCycleConfig() — modelCap field', () => {
  describe('valid-modelCap: all three ModelTier values are accepted', () => {
    it('loads modelCap: opus', () => {
      writeAutonomousYaml('modelCap: opus\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBe('opus');
    });

    it('loads modelCap: sonnet', () => {
      writeAutonomousYaml('modelCap: sonnet\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBe('sonnet');
    });

    it('loads modelCap: haiku', () => {
      writeAutonomousYaml('modelCap: haiku\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBe('haiku');
    });
  });

  describe('invalid-modelCap: unrecognised values are silently rejected', () => {
    it('rejects an unknown tier string', () => {
      writeAutonomousYaml('modelCap: turbo\n');
      const config = loadCycleConfig(tmpDir);
      // Invalid value must be dropped — modelCap should remain undefined
      expect(config.modelCap).toBeUndefined();
    });

    it('rejects an empty string', () => {
      writeAutonomousYaml("modelCap: ''\n");
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBeUndefined();
    });

    it('rejects a numeric value', () => {
      writeAutonomousYaml('modelCap: 3\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBeUndefined();
    });

    it('does not upward-coerce: "gpt-4" is not a valid ModelTier', () => {
      writeAutonomousYaml('modelCap: gpt-4\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.modelCap).toBeUndefined();
    });
  });
});

describe('loadCycleConfig() — effortCap field', () => {
  describe('valid-effortCap: all five effort levels are accepted', () => {
    const validLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

    for (const level of validLevels) {
      it(`loads effortCap: ${level}`, () => {
        writeAutonomousYaml(`effortCap: ${level}\n`);
        const config = loadCycleConfig(tmpDir);
        expect(config.effortCap).toBe(level);
      });
    }
  });

  describe('invalid-effortCap: unrecognised values are silently rejected', () => {
    it('rejects an unknown effort string', () => {
      writeAutonomousYaml('effortCap: ultra\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.effortCap).toBeUndefined();
    });

    it('rejects a numeric value', () => {
      writeAutonomousYaml('effortCap: 5\n');
      const config = loadCycleConfig(tmpDir);
      expect(config.effortCap).toBeUndefined();
    });

    it('rejects an empty string', () => {
      writeAutonomousYaml("effortCap: ''\n");
      const config = loadCycleConfig(tmpDir);
      expect(config.effortCap).toBeUndefined();
    });
  });
});

describe('loadCycleConfig() — fallbackEnabled field', () => {
  it('loads fallbackEnabled: true', () => {
    writeAutonomousYaml('fallbackEnabled: true\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.fallbackEnabled).toBe(true);
  });

  it('loads fallbackEnabled: false', () => {
    writeAutonomousYaml('fallbackEnabled: false\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.fallbackEnabled).toBe(false);
  });
});

describe('loadCycleConfig() — combined caps', () => {
  it('loads modelCap + effortCap + fallbackEnabled together', () => {
    writeAutonomousYaml([
      'modelCap: sonnet',
      'effortCap: high',
      'fallbackEnabled: false',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBe('sonnet');
    expect(config.effortCap).toBe('high');
    expect(config.fallbackEnabled).toBe(false);
  });

  it('applies caps alongside nested budget overrides without conflict', () => {
    writeAutonomousYaml([
      'modelCap: haiku',
      'effortCap: low',
      'budget:',
      '  perCycleUsd: 10',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBe('haiku');
    expect(config.effortCap).toBe('low');
    // Nested budget override still applied
    expect(config.budget.perCycleUsd).toBe(10);
    // Other budget fields retain defaults
    expect(config.budget.perItemUsd).toBe(DEFAULT_CYCLE_CONFIG.budget.perItemUsd);
  });

  it('invalid modelCap does not corrupt valid effortCap in same file', () => {
    writeAutonomousYaml([
      'modelCap: invalid-tier',
      'effortCap: max',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBeUndefined();
    expect(config.effortCap).toBe('max');
  });
});

describe('loadCycleConfig() — missing / empty file', () => {
  it('returns DEFAULT_CYCLE_CONFIG when autonomous.yaml does not exist', () => {
    // No file written — parent dir exists but no autonomous.yaml
    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBeUndefined();
    expect(config.effortCap).toBeUndefined();
    expect(config.budget.perCycleUsd).toBe(DEFAULT_CYCLE_CONFIG.budget.perCycleUsd);
  });

  it('returns DEFAULT_CYCLE_CONFIG when autonomous.yaml is blank', () => {
    writeAutonomousYaml('');
    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBeUndefined();
    expect(config.effortCap).toBeUndefined();
  });

  it('returns DEFAULT_CYCLE_CONFIG when autonomous.yaml is all comments', () => {
    writeAutonomousYaml('# just a comment\n# no actual fields\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBeUndefined();
    expect(config.effortCap).toBeUndefined();
  });
});
