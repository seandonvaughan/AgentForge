import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import type { MarketplaceEntry, EntryMetadata, InstallResult, MarketplaceStats } from './types.js';

function loadYamlRecord(content: string): Record<string, unknown> {
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('YAML content must be a mapping');
  }
  return parsed as Record<string, unknown>;
}

function dumpYaml(value: unknown): string {
  return yaml.dump(value, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function writeYamlAtomicSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original write/rename error.
    }
    throw error;
  }
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
          const parsed = loadYamlRecord(content);
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
        const parsed = loadYamlRecord(content);
        const installedPath = join(dest, `${id}.yaml`);
        writeYamlAtomicSync(installedPath, dumpYaml(parsed));
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
        const parsed = loadYamlRecord(agentConfig.yamlContent);
        writeYamlAtomicSync(yamlPath, dumpYaml(parsed));
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
