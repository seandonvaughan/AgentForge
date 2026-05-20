import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PluginManifest,
  PluginInstance,
  PluginStatus,
  JsonRpcRequest,
  JsonRpcResponse,
  PluginPermission,
  PluginHook,
  PluginSkill,
  PluginMarketplaceMetadata,
  PluginSandboxPolicy,
} from './types.js';

const VALID_PERMISSIONS = new Set<PluginPermission>([
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

function expectNonEmptyString(obj: Record<string, unknown>, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid plugin manifest: ${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid plugin manifest: ${label} must be an array of strings`);
  }

  const deduped = new Set<string>();
  for (const entry of value) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new Error(`Invalid plugin manifest: ${label} cannot contain empty values`);
    }
    deduped.add(trimmed);
  }
  return [...deduped];
}

function parsePermissions(value: unknown): PluginPermission[] {
  const values = parseStringArray(value, 'permissions');
  for (const permission of values) {
    if (!VALID_PERMISSIONS.has(permission as PluginPermission)) {
      throw new Error(`Invalid plugin manifest: unsupported permission '${permission}'`);
    }
  }
  return values as PluginPermission[];
}

function parseHooks(value: unknown): PluginHook[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid plugin manifest: hooks must be an array');
  }

  return value.map((hook, index) => {
    if (!isRecord(hook)) {
      throw new Error(`Invalid plugin manifest: hooks[${index}] must be an object`);
    }
    return {
      event: expectNonEmptyString(hook, 'event', `hooks[${index}].event`),
      handler: expectNonEmptyString(hook, 'handler', `hooks[${index}].handler`),
    };
  });
}

function parseSkills(value: unknown): PluginSkill[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid plugin manifest: skills must be an array');
  }

  return value.map((skill, index) => {
    if (!isRecord(skill)) {
      throw new Error(`Invalid plugin manifest: skills[${index}] must be an object`);
    }
    return {
      name: expectNonEmptyString(skill, 'name', `skills[${index}].name`),
      description: expectNonEmptyString(skill, 'description', `skills[${index}].description`),
      handler: expectNonEmptyString(skill, 'handler', `skills[${index}].handler`),
    };
  });
}

function parseMarketplaceMetadata(value: unknown): PluginMarketplaceMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid plugin manifest: marketplace must be an object');
  }

  const metadata: PluginMarketplaceMetadata = {};

  if (value['license'] !== undefined) {
    metadata.license = expectNonEmptyString(value, 'license', 'marketplace.license');
  }
  if (value['homepage'] !== undefined) {
    metadata.homepage = expectNonEmptyString(value, 'homepage', 'marketplace.homepage');
  }
  if (value['repository'] !== undefined) {
    metadata.repository = expectNonEmptyString(value, 'repository', 'marketplace.repository');
  }
  if (value['category'] !== undefined) {
    metadata.category = expectNonEmptyString(value, 'category', 'marketplace.category');
  }
  if (value['tags'] !== undefined) {
    metadata.tags = parseStringArray(value['tags'], 'marketplace.tags');
  }
  if (value['keywords'] !== undefined) {
    metadata.keywords = parseStringArray(value['keywords'], 'marketplace.keywords');
  }
  if (value['visibility'] !== undefined) {
    const visibility = expectNonEmptyString(value, 'visibility', 'marketplace.visibility');
    if (visibility !== 'public' && visibility !== 'private' && visibility !== 'unlisted') {
      throw new Error("Invalid plugin manifest: marketplace.visibility must be 'public', 'private', or 'unlisted'");
    }
    metadata.visibility = visibility;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function parseSandboxPolicy(value: unknown): PluginSandboxPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid plugin manifest: sandbox must be an object');
  }

  const mode = expectNonEmptyString(value, 'mode', 'sandbox.mode');
  if (mode !== 'process' && mode !== 'inherit') {
    throw new Error("Invalid plugin manifest: sandbox.mode must be 'process' or 'inherit'");
  }

  const policy: PluginSandboxPolicy = { mode };

  if (value['allowedHosts'] !== undefined) {
    policy.allowedHosts = parseStringArray(value['allowedHosts'], 'sandbox.allowedHosts');
  }
  if (value['allowedEnv'] !== undefined) {
    policy.allowedEnv = parseStringArray(value['allowedEnv'], 'sandbox.allowedEnv');
  }
  if (value['workspaceWriteOnly'] !== undefined) {
    if (typeof value['workspaceWriteOnly'] !== 'boolean') {
      throw new Error('Invalid plugin manifest: sandbox.workspaceWriteOnly must be a boolean');
    }
    policy.workspaceWriteOnly = value['workspaceWriteOnly'];
  }

  return policy;
}

function validatePluginManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) {
    throw new Error('Invalid plugin manifest: root must be an object');
  }

  const manifest: PluginManifest = {
    id: expectNonEmptyString(raw, 'id', 'id'),
    name: expectNonEmptyString(raw, 'name', 'name'),
    version: expectNonEmptyString(raw, 'version', 'version'),
    description: expectNonEmptyString(raw, 'description', 'description'),
    entrypoint: expectNonEmptyString(raw, 'entrypoint', 'entrypoint'),
    permissions: parsePermissions(raw['permissions']),
    hooks: parseHooks(raw['hooks']),
    skills: parseSkills(raw['skills']),
  };

  if (raw['author'] !== undefined) {
    manifest.author = expectNonEmptyString(raw, 'author', 'author');
  }

  const marketplace = parseMarketplaceMetadata(raw['marketplace']);
  if (marketplace !== undefined) {
    manifest.marketplace = marketplace;
  }

  const sandbox = parseSandboxPolicy(raw['sandbox']);
  if (sandbox !== undefined) {
    manifest.sandbox = sandbox;
  }

  return manifest;
}

export class PluginHost extends EventEmitter {
  private instances = new Map<string, PluginInstance & { process?: ChildProcess; buffer: string }>();
  private requestCounter = 0;
  private pendingCalls = new Map<string, Map<number, { resolve: Function; reject: Function }>>();

  async load(manifestPath: string): Promise<PluginInstance> {
    const raw = await readFile(manifestPath, 'utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid plugin manifest JSON: ${manifestPath}`);
    }

    const manifest = validatePluginManifest(parsed);

    if (this.instances.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} already loaded`);
    }

    const instance: PluginInstance & { process?: ChildProcess; buffer: string } = {
      id: manifest.id,
      manifest,
      status: 'stopped',
      buffer: '',
      manifestPath,
      loadedAt: new Date().toISOString(),
    };
    this.instances.set(manifest.id, instance);
    return instance;
  }

  async start(pluginId: string, entrypointDir: string): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance) throw new Error(`Plugin ${pluginId} not found`);

    instance.status = 'starting';
    const entryPath = join(entrypointDir, instance.manifest.entrypoint);

    const child = fork(entryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, AGENTFORGE_PLUGIN: '1', PLUGIN_ID: pluginId },
    });

    instance.process = child;
    if (child.pid !== undefined) {
      instance.pid = child.pid;
    }
    this.pendingCalls.set(pluginId, new Map());

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => this._handlePluginOutput(pluginId, chunk));

    child.stderr!.on('data', (data: Buffer) => {
      this.emit('plugin.log', { pluginId, level: 'error', message: data.toString() });
    });

    child.on('exit', (code) => {
      this._setStatus(pluginId, code === 0 ? 'stopped' : 'error');
      if (code !== 0) instance.errorMessage = `Exited with code ${code}`;
      this.emit('plugin.exit', { pluginId, code });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Plugin start timeout')), 10_000);
      this.once(`${pluginId}.ready`, () => { clearTimeout(timeout); resolve(); });
      child.send({ jsonrpc: '2.0', method: 'plugin.init', params: { id: pluginId } });
    });

    this._setStatus(pluginId, 'running');
    instance.startedAt = new Date().toISOString();
  }

  async stop(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance?.process) return;
    instance.status = 'stopping';
    instance.process.kill('SIGTERM');
    await new Promise<void>((resolve) => instance.process!.once('exit', () => resolve()));
  }

  async call<T = unknown>(pluginId: string, method: string, params?: unknown): Promise<T> {
    const instance = this.instances.get(pluginId);
    if (!instance?.process || instance.status !== 'running') {
      throw new Error(`Plugin ${pluginId} is not running`);
    }
    const id = ++this.requestCounter;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const pending = this.pendingCalls.get(pluginId)!;
      pending.set(id, { resolve, reject });
      instance.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  async emit_to_plugin(pluginId: string, event: string, data: unknown): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance?.process || instance.status !== 'running') return;
    const notif = { jsonrpc: '2.0', method: event, params: data };
    instance.process.stdin!.write(JSON.stringify(notif) + '\n');
  }

  list(): PluginInstance[] {
    return [...this.instances.values()].map(({ buffer: _b, process: _p, ...inst }) => inst);
  }

  private _handlePluginOutput(pluginId: string, chunk: string): void {
    const instance = this.instances.get(pluginId);
    if (!instance) return;
    instance.buffer += chunk;
    const lines = instance.buffer.split('\n');
    instance.buffer = lines.pop() ?? '';

    for (const line of lines.filter((l) => l.trim())) {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | { jsonrpc: '2.0'; method: string; params?: unknown };
        if ('result' in msg || 'error' in msg) {
          const rpc = msg as JsonRpcResponse;
          const pending = this.pendingCalls.get(pluginId)?.get(rpc.id as number);
          if (pending) {
            this.pendingCalls.get(pluginId)!.delete(rpc.id as number);
            if (rpc.error) pending.reject(new Error(rpc.error.message));
            else pending.resolve(rpc.result);
          }
        } else if ('method' in msg) {
          if (msg.method === 'plugin.ready') {
            this.emit(`${pluginId}.ready`);
          } else if (msg.method === 'plugin.error') {
            this.emit('plugin.error', { pluginId, ...(msg.params as object) });
          } else if (msg.method === 'plugin.log') {
            this.emit('plugin.log', { pluginId, ...(msg.params as object) });
          } else {
            this.emit('plugin.event', { pluginId, event: msg.method, data: msg.params });
          }
        }
      } catch {
        // skip malformed
      }
    }
  }

  private _setStatus(pluginId: string, status: PluginStatus): void {
    const instance = this.instances.get(pluginId);
    if (instance) instance.status = status;
    this.emit('plugin.status', { pluginId, status });
  }
}
