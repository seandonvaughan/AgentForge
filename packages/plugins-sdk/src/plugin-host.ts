import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest, PluginInstance, PluginStatus, JsonRpcRequest, JsonRpcResponse } from './types.js';

export class PluginHost extends EventEmitter {
  private instances = new Map<string, PluginInstance & { process?: ChildProcess; buffer: string }>();
  private requestCounter = 0;
  private pendingCalls = new Map<string, Map<number, { resolve: Function; reject: Function }>>();

  async load(manifestPath: string): Promise<PluginInstance> {
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest: PluginManifest = JSON.parse(raw);

    if (this.instances.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} already loaded`);
    }

    const instance: PluginInstance & { process?: ChildProcess; buffer: string } = {
      id: manifest.id,
      manifest,
      status: 'stopped',
      buffer: '',
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
    instance.pid = child.pid;
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
    await new Promise<void>(resolve => instance.process!.once('exit', () => resolve()));
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

    for (const line of lines.filter(l => l.trim())) {
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
      } catch { /* skip malformed */ }
    }
  }

  private _setStatus(pluginId: string, status: PluginStatus): void {
    const instance = this.instances.get(pluginId);
    if (instance) instance.status = status;
    this.emit('plugin.status', { pluginId, status });
  }
}
