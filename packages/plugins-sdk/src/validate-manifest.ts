import type { PluginManifest, PluginPermission } from './types.js';

const PERMISSIONS = new Set<string>([
  'filesystem:read',
  'filesystem:write',
  'network',
  'agent:invoke',
  'db:read',
  'db:write',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringField(manifest: Record<string, unknown>, field: string): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid plugin manifest: ${field} is required`);
  }
  return value;
}

/**
 * Validates an untrusted plugin manifest object and returns the typed manifest.
 *
 * @param raw - Parsed manifest JSON to validate.
 * @returns The validated plugin manifest.
 * @throws Error when required fields are missing or invalid.
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) {
    throw new Error('Invalid plugin manifest: manifest must be an object');
  }

  const id = validateStringField(raw, 'id');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('Invalid plugin manifest: id must be kebab-case');
  }

  const name = validateStringField(raw, 'name');
  const version = validateStringField(raw, 'version');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('Invalid plugin manifest: version must be SemVer');
  }

  const description = validateStringField(raw, 'description');
  const entrypoint = validateStringField(raw, 'entrypoint');

  if (!Array.isArray(raw.permissions)) {
    throw new Error('Invalid plugin manifest: permissions must be an array');
  }
  for (const permission of raw.permissions) {
    if (typeof permission !== 'string' || !PERMISSIONS.has(permission)) {
      throw new Error(`Invalid plugin manifest: permission ${String(permission)} is not supported`);
    }
  }

  if (!Array.isArray(raw.hooks)) {
    throw new Error('Invalid plugin manifest: hooks must be an array');
  }
  if (!Array.isArray(raw.skills)) {
    throw new Error('Invalid plugin manifest: skills must be an array');
  }
  if ('author' in raw && typeof raw.author !== 'string') {
    throw new Error('Invalid plugin manifest: author must be a string');
  }

  return {
    id,
    name,
    version,
    description,
    entrypoint,
    permissions: raw.permissions as PluginPermission[],
    hooks: raw.hooks as PluginManifest['hooks'],
    skills: raw.skills as PluginManifest['skills'],
    ...('author' in raw ? { author: raw.author as string } : {}),
  };
}
