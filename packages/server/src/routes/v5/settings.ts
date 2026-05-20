import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { globalStream } from './stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = join(__dirname, '../../../../../');
const settingsPath = join(PROJECT_ROOT, '.agentforge/config/settings.yaml');

// ---------------------------------------------------------------------------
// Default settings
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
// Utilities
// ---------------------------------------------------------------------------

/**
 * Prototype-pollution-safe deep merge.
 *
 * Skips the well-known prototype-pollution keys (__proto__, constructor,
 * prototype) so a crafted request body cannot modify Object.prototype or
 * Function.prototype.  The guard matters even when the body arrives through
 * JSON.parse — some JSON parsers (including older V8 versions) surface __proto__
 * as an own enumerable property that Object.keys() will enumerate, and
 * subsequent bracket-notation assignments on a plain-object target reach the
 * prototype chain accessors rather than setting own properties.
 */
const PROTOTYPE_POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (PROTOTYPE_POISON_KEYS.has(key)) continue;  // prevent prototype pollution
    const srcVal = source[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      const tgtVal = target[key];
      target[key] = deepMerge(
        (tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
          ? tgtVal
          : {}) as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}

function loadSettings(): typeof DEFAULT_SETTINGS {
  if (!existsSync(settingsPath)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    return deepMerge(structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>, parsed ?? {}) as typeof DEFAULT_SETTINGS;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  const configDir = join(PROJECT_ROOT, '.agentforge/config');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const dumped = yaml.dump(settings, { indent: 2, sortKeys: false, noRefs: true });
  const tmpPath = join(
    tmpdir(),
    `agentforge-${randomBytes(8).toString('hex')}.tmp`,
  );
  writeFileSync(tmpPath, dumped, 'utf-8');
  renameSync(tmpPath, settingsPath);
}

function validateSettingsShape(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/settings — load settings, returning defaults if file absent
  app.get('/api/v5/settings', async (_req, reply) => {
    const settings = loadSettings();
    return reply.send({ data: settings });
  });

  // PUT /api/v5/settings — deep-merge partial settings and persist
  app.put('/api/v5/settings', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!validateSettingsShape(body)) {
      return reply.status(400).send({ error: 'Request body must be a settings object' });
    }

    const current = loadSettings();
    const merged = deepMerge(current as Record<string, unknown>, body);
    saveSettings(merged);

    globalStream.emit({
      type: 'system',
      category: 'settings',
      message: 'Settings updated',
      data: { type: 'settings_updated' },
    });

    return reply.send({ data: merged });
  });

  // GET /api/v5/settings/autonomous — read autonomous.yaml retry config
  app.get('/api/v5/settings/autonomous', async (_req, reply) => {
    const autoPath = join(PROJECT_ROOT, '.agentforge/autonomous.yaml');
    try {
      const raw = readFileSync(autoPath, 'utf-8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      const retry = (parsed?.retry ?? {}) as Record<string, unknown>;
      return reply.send({ data: { retry } });
    } catch {
      return reply.send({ data: { retry: { maxAutoRetries: 1, requireApprovalAfter: 1, reExecuteOnRetry: true } } });
    }
  });

  // PUT /api/v5/settings/autonomous — update autonomous.yaml retry config
  app.put('/api/v5/settings/autonomous', async (req, reply) => {
    const body = req.body as { retry?: Record<string, unknown> } | undefined;
    if (!body?.retry) {
      return reply.status(400).send({ error: 'Request body must include { retry: { ... } }' });
    }
    const autoPath = join(PROJECT_ROOT, '.agentforge/autonomous.yaml');
    try {
      const raw = readFileSync(autoPath, 'utf-8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      (parsed as any).retry = { ...((parsed as any).retry ?? {}), ...body.retry };
      const dumped = yaml.dump(parsed, { indent: 2, sortKeys: false, noRefs: true });
      const tmpPath = join(
        tmpdir(),
        `agentforge-${randomBytes(8).toString('hex')}.tmp`,
      );
      writeFileSync(tmpPath, dumped, 'utf-8');
      renameSync(tmpPath, autoPath);
      return reply.send({ data: { retry: (parsed as any).retry } });
    } catch (e) {
      return reply.status(500).send({ error: String(e) });
    }
  });

  // POST /api/v5/settings/export — return settings as a downloadable JSON file
  app.post('/api/v5/settings/export', async (_req, reply) => {
    const settings = loadSettings();
    const json = JSON.stringify(settings, null, 2);
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', 'attachment; filename="agentforge-settings.json"');
    return reply.send(json);
  });

  // POST /api/v5/settings/import — replace settings from a JSON body
  app.post('/api/v5/settings/import', async (req, reply) => {
    interface ImportBody {
      settings: Record<string, unknown>;
    }

    const body = req.body as Partial<ImportBody> | undefined;
    if (!body || !validateSettingsShape(body.settings)) {
      return reply.status(400).send({
        error: 'Request body must be { settings: Record<string, unknown> }',
      });
    }

    // Merge imported settings on top of defaults so unknown keys are preserved
    // but missing keys fall back to defaults.
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>, body.settings);
    saveSettings(merged);

    globalStream.emit({
      type: 'system',
      category: 'settings',
      message: 'Settings imported',
      data: { type: 'settings_updated' },
    });

    return reply.send({ data: merged });
  });
}
