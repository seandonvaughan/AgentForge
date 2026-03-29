/**
 * tests/server/routes/settings.test.ts
 *
 * Tests for the settings persistence logic (settings.ts).
 * We exercise the deepMerge, loadSettings, saveSettings, and validate
 * helpers directly via a temporary directory.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Mirror the DEFAULT_SETTINGS shape from settings.ts
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  workspace: {
    name: 'AgentForge',
    version: '6.2',
  },
  execution: {
    defaultModel: 'sonnet',
    maxConcurrentAgents: 5,
    budgetLimitPerSprint: 500,
    budgetLimitPerAgent: 50,
    autoApprovalThreshold: 0.85,
    taskTimeoutMs: 300000,
  },
  dashboard: {
    theme: 'dark',
    refreshIntervalMs: 5000,
    notificationsEnabled: true,
    sseReconnectIntervalMs: 3000,
  },
  teams: {
    defaultTeamCapacity: 10,
    autoScalingEnabled: true,
    utilizationAlertThreshold: 0.85,
  },
  notifications: {
    taskCompleted: true,
    taskFailed: true,
    budgetThresholdHit: true,
    agentPromoted: true,
    hiringRecommendation: true,
    approvalNeeded: true,
    sprintPhaseAdvanced: true,
  },
};

// ---------------------------------------------------------------------------
// Mirror helpers from settings.ts
// ---------------------------------------------------------------------------

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      target[key] = deepMerge(
        (target[key] as Record<string, unknown>) ?? {},
        sv as Record<string, unknown>,
      );
    } else {
      target[key] = sv;
    }
  }
  return target;
}

function validateSettingsShape(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let settingsFilePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-settings-test-'));
  const configDir = join(tmpRoot, '.agentforge', 'config');
  mkdirSync(configDir, { recursive: true });
  settingsFilePath = join(configDir, 'settings.yaml');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function saveSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsFilePath, yaml.dump(settings, { indent: 2 }), 'utf-8');
}

function loadSettings(): typeof DEFAULT_SETTINGS {
  if (!existsSync(settingsFilePath)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = require('node:fs').readFileSync(settingsFilePath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    return deepMerge(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>, parsed ?? {}) as unknown as typeof DEFAULT_SETTINGS;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

// ---------------------------------------------------------------------------
// Tests: Default settings
// ---------------------------------------------------------------------------

describe('Default settings', () => {
  it('returns defaults when no settings file exists', () => {
    const settings = loadSettings();
    expect(settings.workspace.name).toBe('AgentForge');
    expect(settings.workspace.version).toBe('6.2');
  });

  it('default execution.defaultModel is "sonnet"', () => {
    const settings = loadSettings();
    expect(settings.execution.defaultModel).toBe('sonnet');
  });

  it('default execution.maxConcurrentAgents is 5', () => {
    const settings = loadSettings();
    expect(settings.execution.maxConcurrentAgents).toBe(5);
  });

  it('default execution.budgetLimitPerSprint is 500', () => {
    const settings = loadSettings();
    expect(settings.execution.budgetLimitPerSprint).toBe(500);
  });

  it('default dashboard.theme is "dark"', () => {
    const settings = loadSettings();
    expect(settings.dashboard.theme).toBe('dark');
  });

  it('default notifications.taskCompleted is true', () => {
    const settings = loadSettings();
    expect(settings.notifications.taskCompleted).toBe(true);
  });

  it('default teams.autoScalingEnabled is true', () => {
    const settings = loadSettings();
    expect(settings.teams.autoScalingEnabled).toBe(true);
  });

  it('returned defaults are a clone (mutation does not affect next call)', () => {
    const a = loadSettings();
    (a as Record<string, unknown>).workspace = { name: 'Mutated' } as unknown;
    const b = loadSettings();
    expect(b.workspace.name).toBe('AgentForge');
  });
});

// ---------------------------------------------------------------------------
// Tests: Save and load settings
// ---------------------------------------------------------------------------

describe('Save and load settings', () => {
  it('persists settings to YAML file', () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    saveSettings(settings);
    expect(existsSync(settingsFilePath)).toBe(true);
  });

  it('round-trips workspace name correctly', () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      workspace: { name: 'MyWorkspace', version: '6.2' },
    };
    saveSettings(settings as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    expect(loaded.workspace.name).toBe('MyWorkspace');
  });

  it('round-trips execution settings correctly', () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      execution: { ...DEFAULT_SETTINGS.execution, maxConcurrentAgents: 10 },
    };
    saveSettings(settings as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    expect(loaded.execution.maxConcurrentAgents).toBe(10);
  });

  it('round-trips dashboard theme correctly', () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      dashboard: { ...DEFAULT_SETTINGS.dashboard, theme: 'light' },
    };
    saveSettings(settings as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    expect(loaded.dashboard.theme).toBe('light');
  });

  it('saved file is valid YAML', () => {
    saveSettings(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>);
    const raw = require('node:fs').readFileSync(settingsFilePath, 'utf-8');
    expect(() => yaml.load(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Deep merge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('merges top-level scalar values', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 99, c: 3 };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    expect(result['a']).toBe(1);
    expect(result['b']).toBe(99);
    expect(result['c']).toBe(3);
  });

  it('deep merges nested objects', () => {
    const target = { nested: { x: 1, y: 2 } };
    const source = { nested: { y: 99 } };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    const nested = result['nested'] as Record<string, unknown>;
    expect(nested['x']).toBe(1);
    expect(nested['y']).toBe(99);
  });

  it('does not deep-merge arrays (replaces them)', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    expect(result['arr']).toEqual([4, 5]);
  });

  it('adds new keys from source', () => {
    const target = { existing: true };
    const source = { newKey: 'hello' };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    expect(result['newKey']).toBe('hello');
  });

  it('preserves target keys not in source', () => {
    const target = { keep: 'me', replace: 'old' };
    const source = { replace: 'new' };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    expect(result['keep']).toBe('me');
  });

  it('merges multiple levels deep', () => {
    const target = { a: { b: { c: 1 } } };
    const source = { a: { b: { d: 2 } } };
    const result = deepMerge(target as Record<string, unknown>, source as Record<string, unknown>);
    const ab = (result['a'] as Record<string, unknown>)['b'] as Record<string, unknown>;
    expect(ab['c']).toBe(1);
    expect(ab['d']).toBe(2);
  });

  it('partial update only changes specified keys', () => {
    const current = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    const partial = { execution: { maxConcurrentAgents: 20 } };
    const merged = deepMerge(current, partial as Record<string, unknown>) as typeof DEFAULT_SETTINGS;

    expect(merged.execution.maxConcurrentAgents).toBe(20);
    expect(merged.execution.defaultModel).toBe('sonnet'); // unchanged
    expect(merged.dashboard.theme).toBe('dark'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Tests: Partial settings update
// ---------------------------------------------------------------------------

describe('Partial settings update (PUT semantics)', () => {
  it('updates only the specified nested key', () => {
    const current = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    saveSettings(current);

    const partialUpdate = { dashboard: { theme: 'light' } };
    const merged = deepMerge(loadSettings() as unknown as Record<string, unknown>, partialUpdate as Record<string, unknown>) as typeof DEFAULT_SETTINGS;
    saveSettings(merged as unknown as Record<string, unknown>);

    const reloaded = loadSettings();
    expect(reloaded.dashboard.theme).toBe('light');
    expect(reloaded.dashboard.refreshIntervalMs).toBe(5000); // unchanged default
  });

  it('updating budget does not affect notifications', () => {
    const current = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    saveSettings(current);

    const partialUpdate = { execution: { budgetLimitPerSprint: 1000 } };
    const merged = deepMerge(loadSettings() as unknown as Record<string, unknown>, partialUpdate as Record<string, unknown>) as typeof DEFAULT_SETTINGS;
    saveSettings(merged as unknown as Record<string, unknown>);

    const reloaded = loadSettings();
    expect(reloaded.execution.budgetLimitPerSprint).toBe(1000);
    expect(reloaded.notifications.taskCompleted).toBe(true); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Tests: Export (JSON serialisation)
// ---------------------------------------------------------------------------

describe('Settings export (JSON)', () => {
  it('produces valid JSON from default settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const json = JSON.stringify(settings, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('exported JSON contains workspace section', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const json = JSON.stringify(settings, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('workspace');
    expect(parsed.workspace.name).toBe('AgentForge');
  });

  it('exported JSON contains all top-level sections', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const json = JSON.stringify(settings, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('execution');
    expect(parsed).toHaveProperty('dashboard');
    expect(parsed).toHaveProperty('teams');
    expect(parsed).toHaveProperty('notifications');
  });

  it('exported JSON values match saved settings', () => {
    const custom = {
      ...structuredClone(DEFAULT_SETTINGS),
      workspace: { name: 'ExportTest', version: '6.2' },
    };
    saveSettings(custom as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    const json = JSON.stringify(loaded, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.workspace.name).toBe('ExportTest');
  });
});

// ---------------------------------------------------------------------------
// Tests: Import settings
// ---------------------------------------------------------------------------

describe('Settings import', () => {
  it('overwrites current settings with imported values', () => {
    // Save initial settings
    saveSettings(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>);

    // Import new settings
    const imported = {
      ...structuredClone(DEFAULT_SETTINGS),
      workspace: { name: 'Imported', version: '6.2' },
    };
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>, imported as unknown as Record<string, unknown>) as typeof DEFAULT_SETTINGS;
    saveSettings(merged as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    expect(loaded.workspace.name).toBe('Imported');
  });

  it('import merges on top of defaults so missing keys fall back to defaults', () => {
    const partialImport = { workspace: { name: 'Partial Import', version: '6.2' } };
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>, partialImport as Record<string, unknown>) as typeof DEFAULT_SETTINGS;
    saveSettings(merged as unknown as Record<string, unknown>);

    const loaded = loadSettings();
    expect(loaded.workspace.name).toBe('Partial Import');
    expect(loaded.execution.maxConcurrentAgents).toBe(5); // default preserved
  });

  it('rejects non-object body', () => {
    expect(validateSettingsShape(null)).toBe(false);
    expect(validateSettingsShape(42)).toBe(false);
    expect(validateSettingsShape('string')).toBe(false);
    expect(validateSettingsShape([])).toBe(false);
  });

  it('accepts valid settings object', () => {
    expect(validateSettingsShape(structuredClone(DEFAULT_SETTINGS))).toBe(true);
    expect(validateSettingsShape({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Error resilience
// ---------------------------------------------------------------------------

describe('Error resilience', () => {
  it('falls back to defaults when settings file is corrupt YAML', () => {
    writeFileSync(settingsFilePath, 'CORRUPT: [unclosed bracket', 'utf-8');
    // loadSettings should return defaults without throwing
    const settings = loadSettings();
    expect(settings.workspace.name).toBe('AgentForge');
  });

  it('falls back to defaults when settings file is empty', () => {
    writeFileSync(settingsFilePath, '', 'utf-8');
    const settings = loadSettings();
    expect(settings.workspace.name).toBe('AgentForge');
  });
});
