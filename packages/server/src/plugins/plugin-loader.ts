import { watch, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PluginHost } from '@agentforge/plugins-sdk';

export class PluginLoader {
  private host: PluginHost;
  private pluginsDir: string;
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir;
    this.host = new PluginHost();
  }

  /** Load all plugins from the plugins directory. */
  async loadAll(): Promise<{ loaded: string[]; failed: Array<{ id: string; error: string }> }> {
    const loaded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    if (!existsSync(this.pluginsDir)) return { loaded, failed };

    const entries = readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(this.pluginsDir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const instance = await this.host.load(manifestPath);
        loaded.push(instance.id);
        console.log(`  Plugin loaded: ${instance.id} (${instance.manifest.name})`);
      } catch (err) {
        const id = entry.name;
        const error = err instanceof Error ? err.message : String(err);
        failed.push({ id, error });
        console.warn(`  Plugin failed: ${id} — ${error}`);
      }
    }

    return { loaded, failed };
  }

  /** Watch a plugin directory for plugin.json changes and reload. */
  watch(pluginId: string, pluginDir: string): void {
    if (this.watchers.has(pluginId)) return;

    const watcher = watch(join(pluginDir, 'plugin.json'), async (eventType) => {
      if (eventType !== 'change') return;
      console.log(`  Plugin changed: ${pluginId} — reloading...`);
      try {
        await this.host.stop(pluginId);
        await this.host.load(join(pluginDir, 'plugin.json'));
        console.log(`  Plugin reloaded: ${pluginId}`);
      } catch (err) {
        console.error(`  Plugin reload failed: ${pluginId} — ${err}`);
      }
    });

    this.watchers.set(pluginId, watcher);
  }

  getHost(): PluginHost {
    return this.host;
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.host.list()) {
      if (plugin.status === 'running') {
        await this.host.stop(plugin.id).catch(() => {});
      }
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
