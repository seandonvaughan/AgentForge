import type {
  PluginCompatibility,
  PluginHook,
  PluginManifest,
  PluginMarketplaceMetadata,
  PluginPermission,
  PluginRepositoryMetadata,
  PluginSkill,
} from './types.js';

const PLUGIN_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'filesystem:read',
  'filesystem:write',
  'network',
  'agent:invoke',
  'db:read',
  'db:write',
]);

/**
 * Runtime validator for plugin manifests loaded from untrusted JSON.
 * Returns a typed manifest clone and throws when required fields are invalid.
 */
export function validatePluginManifest(input: unknown): PluginManifest {
  const obj = requireObject(input, 'manifest');

  const manifest: PluginManifest = {
    id: requireNonEmptyString(obj.id, 'manifest.id'),
    name: requireNonEmptyString(obj.name, 'manifest.name'),
    version: requireNonEmptyString(obj.version, 'manifest.version'),
    description: requireNonEmptyString(obj.description, 'manifest.description'),
    entrypoint: requireNonEmptyString(obj.entrypoint, 'manifest.entrypoint'),
    permissions: parsePermissions(obj.permissions),
    hooks: parseHooks(obj.hooks),
    skills: parseSkills(obj.skills),
  };

  if (obj.author !== undefined) manifest.author = requireNonEmptyString(obj.author, 'manifest.author');
  if (obj.compatibility !== undefined) manifest.compatibility = parseCompatibility(obj.compatibility);
  if (obj.marketplace !== undefined) manifest.marketplace = parseMarketplaceMetadata(obj.marketplace);

  return manifest;
}

function parsePermissions(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) throw new Error('manifest.permissions must be an array');
  return value.map((permission, index) => {
    if (typeof permission !== 'string') {
      throw new Error(`manifest.permissions[${index}] must be a string`);
    }
    if (!PLUGIN_PERMISSIONS.has(permission as PluginPermission)) {
      throw new Error(`manifest.permissions[${index}] is not a supported permission`);
    }
    return permission as PluginPermission;
  });
}

function parseHooks(value: unknown): PluginHook[] {
  if (!Array.isArray(value)) throw new Error('manifest.hooks must be an array');
  return value.map((hook, index) => {
    const obj = requireObject(hook, `manifest.hooks[${index}]`);
    return {
      event: requireNonEmptyString(obj.event, `manifest.hooks[${index}].event`),
      handler: requireNonEmptyString(obj.handler, `manifest.hooks[${index}].handler`),
    };
  });
}

function parseSkills(value: unknown): PluginSkill[] {
  if (!Array.isArray(value)) throw new Error('manifest.skills must be an array');
  return value.map((skill, index) => {
    const obj = requireObject(skill, `manifest.skills[${index}]`);
    return {
      name: requireNonEmptyString(obj.name, `manifest.skills[${index}].name`),
      description: requireNonEmptyString(obj.description, `manifest.skills[${index}].description`),
      handler: requireNonEmptyString(obj.handler, `manifest.skills[${index}].handler`),
    };
  });
}

function parseCompatibility(value: unknown): PluginCompatibility {
  const obj = requireObject(value, 'manifest.compatibility');
  const compatibility: PluginCompatibility = {};
  if (obj.minAgentforgeVersion !== undefined) {
    compatibility.minAgentforgeVersion = requireNonEmptyString(
      obj.minAgentforgeVersion,
      'manifest.compatibility.minAgentforgeVersion',
    );
  }
  if (obj.maxAgentforgeVersion !== undefined) {
    compatibility.maxAgentforgeVersion = requireNonEmptyString(
      obj.maxAgentforgeVersion,
      'manifest.compatibility.maxAgentforgeVersion',
    );
  }
  if (obj.node !== undefined) {
    compatibility.node = requireNonEmptyString(obj.node, 'manifest.compatibility.node');
  }
  return compatibility;
}

function parseMarketplaceMetadata(value: unknown): PluginMarketplaceMetadata {
  const obj = requireObject(value, 'manifest.marketplace');
  const metadata: PluginMarketplaceMetadata = {};

  if (obj.tags !== undefined) metadata.tags = parseStringArray(obj.tags, 'manifest.marketplace.tags');
  if (obj.category !== undefined) metadata.category = requireNonEmptyString(obj.category, 'manifest.marketplace.category');
  if (obj.license !== undefined) metadata.license = requireNonEmptyString(obj.license, 'manifest.marketplace.license');
  if (obj.homepage !== undefined) metadata.homepage = requireNonEmptyString(obj.homepage, 'manifest.marketplace.homepage');
  if (obj.keywords !== undefined) metadata.keywords = parseStringArray(obj.keywords, 'manifest.marketplace.keywords');
  if (obj.checksumSha256 !== undefined) {
    metadata.checksumSha256 = requireNonEmptyString(obj.checksumSha256, 'manifest.marketplace.checksumSha256');
  }
  if (obj.repository !== undefined) metadata.repository = parseRepositoryMetadata(obj.repository);

  return metadata;
}

function parseRepositoryMetadata(value: unknown): PluginRepositoryMetadata {
  const obj = requireObject(value, 'manifest.marketplace.repository');
  const repository: PluginRepositoryMetadata = {
    type: requireNonEmptyString(obj.type, 'manifest.marketplace.repository.type'),
    url: requireNonEmptyString(obj.url, 'manifest.marketplace.repository.url'),
  };
  if (obj.directory !== undefined) {
    repository.directory = requireNonEmptyString(obj.directory, 'manifest.marketplace.repository.directory');
  }
  return repository;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}
