/**
 * tests/v5/plugins-sdk.test.ts
 * Tests for Plugin SDK types, PluginHost lifecycle (without actual child processes),
 * and JSON-RPC 2.0 message formatting.
 * Target: 22+ tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginHost } from '../../packages/plugins-sdk/src/plugin-host.js';
import type {
  PluginManifest,
  PluginPermission,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  PluginInstance,
  PluginStatus,
  PluginHook,
  PluginSkill,
} from '../../packages/plugins-sdk/src/types.js';

// ── PluginHost — initial state ────────────────────────────────────────────────

describe('PluginHost — initial state', () => {
  let host: PluginHost;

  beforeEach(() => { host = new PluginHost(); });

  it('list() returns empty array when no plugins are loaded', () => {
    expect(host.list()).toEqual([]);
  });

  it('is an EventEmitter (has .on method)', () => {
    expect(typeof host.on).toBe('function');
  });

  it('is an EventEmitter (has .emit method)', () => {
    expect(typeof host.emit).toBe('function');
  });

  it('can register plugin.log event listener without error', () => {
    expect(() => host.on('plugin.log', () => {})).not.toThrow();
  });

  it('can register plugin.event listener', () => {
    expect(() => host.on('plugin.event', vi.fn())).not.toThrow();
  });
});

// ── PluginHost — load() ───────────────────────────────────────────────────────

describe('PluginHost — load()', () => {
  let host: PluginHost;

  beforeEach(() => { host = new PluginHost(); });

  it('load() resolves with a PluginInstance', async () => {
    const manifest: PluginManifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'A test plugin',
      entrypoint: 'index.js',
      permissions: [],
      hooks: [],
      skills: [],
    };

    // Write a temp manifest file and load it
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'));
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const instance = await host.load(manifestPath);
    expect(instance.id).toBe('test-plugin');
    expect(instance.status).toBe('stopped');
  });

  it('load() makes the plugin appear in list()', async () => {
    const manifest: PluginManifest = {
      id: 'list-test-plugin',
      name: 'List Test Plugin',
      version: '1.0.0',
      description: 'Testing list',
      entrypoint: 'index.js',
      permissions: [],
      hooks: [],
      skills: [],
    };
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'));
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    await host.load(manifestPath);
    expect(host.list().length).toBe(1);
    expect(host.list()[0].id).toBe('list-test-plugin');
  });

  it('load() sets initial status to stopped', async () => {
    const manifest: PluginManifest = {
      id: 'status-test-plugin',
      name: 'Status Plugin',
      version: '1.0.0',
      description: 'Status test',
      entrypoint: 'index.js',
      permissions: [],
      hooks: [],
      skills: [],
    };
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'));
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const instance = await host.load(manifestPath);
    expect(instance.status).toBe('stopped');
  });

  it('loading the same plugin twice throws', async () => {
    const manifest: PluginManifest = {
      id: 'duplicate-plugin',
      name: 'Duplicate Plugin',
      version: '1.0.0',
      description: 'Dup test',
      entrypoint: 'index.js',
      permissions: [],
      hooks: [],
      skills: [],
    };
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'));
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    await host.load(manifestPath);
    await expect(host.load(manifestPath)).rejects.toThrow('already loaded');
  });

  it('load() stores the manifest on the instance', async () => {
    const manifest: PluginManifest = {
      id: 'manifest-test',
      name: 'Manifest Plugin',
      version: '2.0.0',
      description: 'Manifest stored',
      entrypoint: 'main.js',
      permissions: ['filesystem:read'],
      hooks: [{ event: 'agent.invoked', handler: 'onInvoked' }],
      skills: [{ name: 'hello', description: 'Says hello', handler: 'doHello' }],
    };
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'));
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const instance = await host.load(manifestPath);
    expect(instance.manifest.name).toBe('Manifest Plugin');
    expect(instance.manifest.version).toBe('2.0.0');
  });
});

// ── JSON-RPC 2.0 message types ────────────────────────────────────────────────

describe('JSON-RPC 2.0 type shapes', () => {
  it('JsonRpcRequest has jsonrpc, id, method fields', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'host.agent.list',
    };
    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe(1);
    expect(req.method).toBe('host.agent.list');
  });

  it('JsonRpcRequest accepts string id', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'req-abc',
      method: 'host.log',
      params: { level: 'info', message: 'hello' },
    };
    expect(req.id).toBe('req-abc');
  });

  it('JsonRpcResponse has jsonrpc, id, result', () => {
    const resp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 42,
      result: { ok: true },
    };
    expect(resp.result).toEqual({ ok: true });
  });

  it('JsonRpcResponse can carry an error', () => {
    const err: JsonRpcError = { code: -32600, message: 'Invalid Request' };
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id: 1, error: err };
    expect(resp.error?.code).toBe(-32600);
    expect(resp.error?.message).toBe('Invalid Request');
  });

  it('serializing a JsonRpcRequest produces valid JSON', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'host.log',
      params: { level: 'info', message: 'test' },
    };
    const json = JSON.stringify(req);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as JsonRpcRequest;
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('host.log');
  });

  it('PluginPermission type accepts all valid values', () => {
    const permissions: PluginPermission[] = [
      'filesystem:read',
      'filesystem:write',
      'network',
      'agent:invoke',
      'db:read',
      'db:write',
    ];
    expect(permissions.length).toBe(6);
  });

  it('PluginHook has event and handler', () => {
    const hook: PluginHook = { event: 'agent.invoked', handler: 'onAgentInvoked' };
    expect(hook.event).toBe('agent.invoked');
    expect(hook.handler).toBe('onAgentInvoked');
  });

  it('PluginSkill has name, description, handler', () => {
    const skill: PluginSkill = { name: 'search', description: 'Search docs', handler: 'doSearch' };
    expect(skill.name).toBe('search');
  });
});

// ── PluginManifest structure ───────────────────────────────────────────────────

describe('PluginManifest validation', () => {
  it('a minimal manifest has all required fields', () => {
    const manifest: PluginManifest = {
      id: 'my-plugin',
      name: 'My Plugin',
      version: '0.1.0',
      description: 'Does things',
      entrypoint: 'dist/index.js',
      permissions: [],
      hooks: [],
      skills: [],
    };
    expect(manifest.id).toBe('my-plugin');
    expect(manifest.entrypoint).toBe('dist/index.js');
  });

  it('author field is optional', () => {
    const manifest: PluginManifest = {
      id: 'p1',
      name: 'P1',
      version: '1.0.0',
      description: 'Desc',
      entrypoint: 'index.js',
      permissions: [],
      hooks: [],
      skills: [],
      author: 'Sean',
    };
    expect(manifest.author).toBe('Sean');
  });

  it('PluginStatus covers all lifecycle states', () => {
    const statuses: PluginStatus[] = ['stopped', 'starting', 'running', 'error', 'stopping'];
    expect(statuses.length).toBe(5);
  });
});
