import { describe, it, expect, beforeEach } from 'vitest';
import { MarketplaceRegistry } from '../../packages/core/src/marketplace/marketplace-registry.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marketplace-test-'));
  return dir;
}

function writeAgent(dir: string, id: string, content: string): void {
  writeFileSync(join(dir, `${id}.yaml`), content, 'utf-8');
}

const AGENT_YAML = (name: string, model = 'sonnet') =>
  `name: ${name}\nmodel: ${model}\nversion: '1.0'\ndescription: A test agent for ${name}\n`;

describe('MarketplaceRegistry', () => {
  let registry: MarketplaceRegistry;
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = makeTestDir();
    writeAgent(agentsDir, 'architect', AGENT_YAML('Architect', 'opus'));
    writeAgent(agentsDir, 'coder', AGENT_YAML('Coder', 'sonnet'));
    writeAgent(agentsDir, 'researcher', AGENT_YAML('Researcher', 'sonnet'));
    registry = new MarketplaceRegistry(agentsDir);
  });

  it('loads agents from directory on construction', () => {
    const entries = registry.list();
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  it('list() returns all entries', () => {
    const entries = registry.list();
    const ids = entries.map(e => e.id);
    expect(ids).toContain('architect');
    expect(ids).toContain('coder');
    expect(ids).toContain('researcher');
  });

  it('get() returns entry by id', () => {
    const entry = registry.get('architect');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('Architect');
  });

  it('get() returns null for unknown id', () => {
    expect(registry.get('nonexistent-agent')).toBeNull();
  });

  it('search() finds by name substring', () => {
    const results = registry.search('arch');
    expect(results.some(e => e.id === 'architect')).toBe(true);
  });

  it('search() finds by description', () => {
    const results = registry.search('test agent for Coder');
    expect(results.some(e => e.id === 'coder')).toBe(true);
  });

  it('search() returns empty array for no match', () => {
    const results = registry.search('xyzzy-impossible-match');
    expect(results).toHaveLength(0);
  });

  it('publish() adds a new entry', () => {
    const entry = registry.publish({
      id: 'new-agent',
      name: 'New Agent',
      description: 'A brand new agent',
      agentType: 'haiku',
    });
    expect(entry.id).toBe('new-agent');
    expect(registry.get('new-agent')).not.toBeNull();
  });

  it('publish() stores yaml content when provided', () => {
    const entry = registry.publish({
      id: 'yaml-agent',
      name: 'YAML Agent',
      description: 'Stores yaml',
      yamlContent: 'name: YAML Agent\nmodel: haiku\n',
    });
    expect(entry.id).toBe('yaml-agent');
  });

  it('install() returns success for known entry', () => {
    const targetDir = makeTestDir();
    const result = registry.install('coder', targetDir);
    expect(result.success).toBe(true);
    expect(result.entryId).toBe('coder');
    expect(result.installedPath).toBeTruthy();
  });

  it('install() returns failure for unknown id', () => {
    const result = registry.install('ghost-agent');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('install() increments download count', () => {
    const targetDir = makeTestDir();
    registry.install('researcher', targetDir);
    const entry = registry.get('researcher');
    expect(entry!.downloadCount).toBeGreaterThan(0);
  });

  it('stats() returns correct totals', () => {
    const stats = registry.stats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(3);
    expect(stats.categories).toBeDefined();
    expect(stats.topRated.length).toBeGreaterThan(0);
  });

  it('stats() topRated is sorted by rating', () => {
    const stats = registry.stats();
    for (let i = 0; i < stats.topRated.length - 1; i++) {
      expect(stats.topRated[i].rating).toBeGreaterThanOrEqual(stats.topRated[i + 1].rating);
    }
  });

  it('works with empty agents directory', () => {
    const emptyDir = makeTestDir();
    const emptyRegistry = new MarketplaceRegistry(emptyDir);
    expect(emptyRegistry.list()).toHaveLength(0);
  });

  it('works with non-existent agents directory', () => {
    const noRegistry = new MarketplaceRegistry('/tmp/does-not-exist-xyzzy-12345');
    expect(noRegistry.list()).toHaveLength(0);
  });

  it('each entry has required fields', () => {
    const entries = registry.list();
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.publishedAt).toBeTruthy();
      expect(typeof entry.downloadCount).toBe('number');
      expect(typeof entry.rating).toBe('number');
    }
  });
});
