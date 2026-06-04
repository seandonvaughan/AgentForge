import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManifest } from '../../packages/plugins-sdk/src/index.js';
import { PluginHost } from '../../packages/plugins-sdk/src/plugin-host.js';

const manifestFields = {
  name: 'P',
  version: '1.0.0',
  description: 'd',
  entrypoint: 'x.js',
  permissions: [],
  hooks: [],
  skills: [],
};

async function writeManifest(raw: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugins-sdk-manifest-validation-'));
  const manifestPath = join(dir, 'plugin.json');
  await writeFile(manifestPath, JSON.stringify(raw), 'utf-8');
  return manifestPath;
}

describe('validateManifest', () => {
  it('rejects required invalid manifest fields with field-specific messages', () => {
    expect(() => validateManifest({ name: 'P', version: '1.0.0', description: 'd', entrypoint: 'x.js', permissions: [], hooks: [], skills: [] })).toThrow('id');
    expect(() => validateManifest({ id: 'My Plugin', ...manifestFields })).toThrow('kebab');
    expect(() => validateManifest({ id: 'p', ...manifestFields, entrypoint: '' })).toThrow('entrypoint');
    expect(() => validateManifest({ id: 'p', ...manifestFields, permissions: ['admin:all'] })).toThrow('permission');
    expect(() => validateManifest({ id: 'p', ...manifestFields, version: '1' })).toThrow('version');
    expect(validateManifest({ id: 'my-plugin', ...manifestFields, permissions: ['db:read'] }).id).toBe('my-plugin');
  });
});

describe('PluginHost.load manifest validation', () => {
  it('rejects an invalid manifest file with the validation error message', async () => {
    const host = new PluginHost();
    const manifestPath = await writeManifest({ id: 'My Plugin', ...manifestFields });

    await expect(host.load(manifestPath)).rejects.toThrow('kebab');
  });

  it('resolves successfully for a valid manifest file', async () => {
    const host = new PluginHost();
    const manifestPath = await writeManifest({ id: 'my-plugin', ...manifestFields });

    const instance = await host.load(manifestPath);

    expect(instance.id).toBe('my-plugin');
    expect(instance.status).toBe('stopped');
  });
});
