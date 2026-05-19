/**
 * Coverage for loadCycleConfig() root primitive field handling in
 * autonomous.yaml.
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
 *   5. fallbackEnabled / autoReforge: boolean fields merge correctly
 *   6. prMode / autoMergePRs: multi-PR fields merge correctly
 *   7. combined: primitive fields apply alongside nested object overrides
 *   8. unknown primitive roots are ignored, not coerced to {}
 *   9. missing-file: returns DEFAULT_CYCLE_CONFIG with no modelCap/effortCap
 *  10. empty-file: returns DEFAULT_CYCLE_CONFIG when autonomous.yaml is blank
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

  it('rejects non-boolean fallbackEnabled without corrupting the config', () => {
    writeAutonomousYaml('fallbackEnabled: no-thanks\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.fallbackEnabled).toBeUndefined();
  });
});

describe('loadCycleConfig() — autoReforge field', () => {
  it('loads autoReforge: false', () => {
    writeAutonomousYaml('autoReforge: false\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.autoReforge).toBe(false);
  });

  it('rejects non-boolean autoReforge', () => {
    writeAutonomousYaml('autoReforge: sometimes\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.autoReforge).toBeUndefined();
  });
});

describe('loadCycleConfig() — autoReforgeCanary field', () => {
  it('loads valid canary settings', () => {
    writeAutonomousYaml([
      'autoReforgeCanary:',
      '  enabled: true',
      '  rolloutPercent: 35',
      '  minCanaryAgents: 2',
      '  autoPromote: false',
      '  rollbackCostMultiplier: 2.5',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.autoReforgeCanary?.enabled).toBe(true);
    expect(config.autoReforgeCanary?.rolloutPercent).toBe(35);
    expect(config.autoReforgeCanary?.minCanaryAgents).toBe(2);
    expect(config.autoReforgeCanary?.autoPromote).toBe(false);
    expect(config.autoReforgeCanary?.rollbackCostMultiplier).toBe(2.5);
  });

  it('rejects non-positive rollbackCostMultiplier', () => {
    writeAutonomousYaml([
      'autoReforgeCanary:',
      '  rollbackCostMultiplier: 0',
    ].join('\n') + '\n');

    expect(() => loadCycleConfig(tmpDir)).toThrow(
      'autoReforgeCanary.rollbackCostMultiplier must be a positive finite number',
    );
  });
});

describe('loadCycleConfig() — multi-PR primitive fields', () => {
  it('loads prMode: multi', () => {
    writeAutonomousYaml('prMode: multi\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.prMode).toBe('multi');
  });

  it('loads prMode: single', () => {
    writeAutonomousYaml('prMode: single\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.prMode).toBe('single');
  });

  it('rejects invalid prMode values', () => {
    writeAutonomousYaml('prMode: aggregate\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.prMode).toBeUndefined();
  });

  it('loads autoMergePRs: false without coercing it to an object', () => {
    writeAutonomousYaml('autoMergePRs: false\n');
    const config = loadCycleConfig(tmpDir);
    expect(config.autoMergePRs).toBe(false);
  });

  it('loads prMode and autoMergePRs together', () => {
    writeAutonomousYaml([
      'prMode: multi',
      'autoMergePRs: false',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.prMode).toBe('multi');
    expect(config.autoMergePRs).toBe(false);
  });
});

describe('loadCycleConfig() — combined caps', () => {
  it('loads modelCap + effortCap + fallbackEnabled together', () => {
    writeAutonomousYaml([
      'modelCap: sonnet',
      'effortCap: high',
      'fallbackEnabled: false',
      'prMode: multi',
      'autoMergePRs: false',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir);
    expect(config.modelCap).toBe('sonnet');
    expect(config.effortCap).toBe('high');
    expect(config.fallbackEnabled).toBe(false);
    expect(config.prMode).toBe('multi');
    expect(config.autoMergePRs).toBe(false);
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

  it('ignores unknown primitive root fields instead of coercing them to empty objects', () => {
    writeAutonomousYaml([
      'runtime: codex-cli',
      'modelCap: opus',
    ].join('\n') + '\n');

    const config = loadCycleConfig(tmpDir) as typeof DEFAULT_CYCLE_CONFIG & { runtime?: unknown };
    expect(config.modelCap).toBe('opus');
    expect(config.runtime).toBeUndefined();
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
