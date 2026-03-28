import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';

export abstract class PluginBase {
  private pendingRequests = new Map<string | number, { resolve: Function; reject: Function }>();
  private requestCounter = 0;

  constructor() {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => this._handleIncoming(chunk));
    process.on('uncaughtException', (err) => this._sendError('uncaughtException', err.message));
  }

  /** Override to handle hook events from the host. */
  abstract onEvent(event: string, data: unknown): void | Promise<void>;

  /** Call a host API method via JSON-RPC 2.0. */
  protected async callHost<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestCounter;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      process.stdout.write(JSON.stringify(request) + '\n');
    });
  }

  /** Send a notification (no response expected). */
  protected notify(method: string, params?: unknown): void {
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    process.stdout.write(JSON.stringify(notif) + '\n');
  }

  private _handleIncoming(chunk: string): void {
    for (const line of chunk.split('\n').filter(l => l.trim())) {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcRequest;
        if ('result' in msg || 'error' in msg) {
          // Response to our request
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        } else if ('method' in msg) {
          // Incoming notification/request from host
          void this.onEvent(msg.method, (msg as JsonRpcRequest).params);
        }
      } catch { /* skip malformed */ }
    }
  }

  private _sendError(type: string, message: string): void {
    this.notify('plugin.error', { type, message });
  }
}
