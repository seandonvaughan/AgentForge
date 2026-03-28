import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { MarketplaceEntry, EntryMetadata, InstallResult, MarketplaceStats } from './types.js';

function parseYamlSimple(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) {
      const val = m[2].trim().replace(/^['"]|['"]$/g, '');
      result[m[1]] = val;
    }
  }
  return result;
}

export class MarketplaceRegistry {
  private entries: Map<string, MarketplaceEntry> = new Map();
  private agentsDir: string;

  constructor(agentsDir?: string) {
    this.agentsDir = agentsDir ?? join(process.cwd(), '.agentforge/agents');
    this.loadFromDir();
  }

  private loadFromDir(): void {
    if (!existsSync(this.agentsDir)) return;

    try {
      const files = readdirSync(this.agentsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        try {
          const content = readFileSync(join(this.agentsDir, file), 'utf-8');
          const parsed = parseYamlSimple(content);
          const id = basename(file, '.yaml').replace('.yml', '');
          const entry: MarketplaceEntry = {
            id,
            name: String(parsed.name ?? id),
            description: String(parsed.description ?? ''),
            agentType: String(parsed.model ?? 'sonnet'),
            metadata: {
              version: String(parsed.version ?? '1.0'),
              tags: [],
              category: 'agent',
            },
            yamlPath: join(this.agentsDir, file),
            publishedAt: new Date().toISOString(),
            downloadCount: 0,
            rating: 4.0,
          };
          this.entries.set(id, entry);
        } catch {
          // skip unparseable files
        }
      }
    } catch {
      // agents dir not accessible
    }
  }

  list(): MarketplaceEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): MarketplaceEntry | null {
    return this.entries.get(id) ?? null;
  }

  search(query: string): MarketplaceEntry[] {
    const lower = query.toLowerCase();
    return [...this.entries.values()].filter(e =>
      e.name.toLowerCase().includes(lower) ||
      e.description.toLowerCase().includes(lower) ||
      e.id.toLowerCase().includes(lower) ||
      (e.metadata.tags ?? []).some(t => t.toLowerCase().includes(lower)),
    );
  }

  install(id: string, targetDir?: string): InstallResult {
    const entry = this.entries.get(id);
    if (!entry) {
      return { success: false, entryId: id, error: `Entry '${id}' not found in registry` };
    }

    const dest = targetDir ?? this.agentsDir;
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    try {
      if (entry.yamlPath && existsSync(entry.yamlPath)) {
        const content = readFileSync(entry.yamlPath, 'utf-8');
        const installedPath = join(dest, `${id}.yaml`);
        writeFileSync(installedPath, content, 'utf-8');
        entry.downloadCount++;
        entry.installedAt = new Date().toISOString();
        return { success: true, entryId: id, installedPath };
      }
      return { success: false, entryId: id, error: 'Source YAML not found' };
    } catch (err) {
      return { success: false, entryId: id, error: String(err) };
    }
  }

  publish(agentConfig: {
    id: string;
    name: string;
    description: string;
    agentType?: string;
    metadata?: EntryMetadata;
    yamlContent?: string;
  }): MarketplaceEntry {
    const entry: MarketplaceEntry = {
      id: agentConfig.id,
      name: agentConfig.name,
      description: agentConfig.description,
      agentType: agentConfig.agentType ?? 'sonnet',
      metadata: agentConfig.metadata ?? { version: '1.0', tags: [], category: 'agent' },
      publishedAt: new Date().toISOString(),
      downloadCount: 0,
      rating: 0,
    };

    if (agentConfig.yamlContent) {
      const yamlPath = join(this.agentsDir, `${agentConfig.id}.yaml`);
      if (existsSync(this.agentsDir)) {
        writeFileSync(yamlPath, agentConfig.yamlContent, 'utf-8');
        entry.yamlPath = yamlPath;
      }
    }

    this.entries.set(entry.id, entry);
    return entry;
  }

  stats(): MarketplaceStats {
    const all = [...this.entries.values()];
    const categories: Record<string, number> = {};
    for (const e of all) {
      const cat = e.metadata.category ?? 'agent';
      categories[cat] = (categories[cat] ?? 0) + 1;
    }

    const topRated = [...all].sort((a, b) => b.rating - a.rating).slice(0, 5);
    const totalInstalls = all.reduce((s, e) => s + e.downloadCount, 0);

    return {
      totalEntries: all.length,
      totalInstalls,
      categories,
      topRated,
    };
  }
}
