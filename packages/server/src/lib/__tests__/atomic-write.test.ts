import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeAtomicTempPath, writeFileAtomicSync } from '../atomic-write.js';

describe('server writeFileAtomicSync', () => {
  it('creates the temporary path beside the destination', () => {
    const target = join('C:', 'workspace', '.agentforge', 'config', 'settings.yaml');
    const tempPath = makeAtomicTempPath(target);

    expect(dirname(tempPath)).toBe(dirname(target));
    expect(basename(tempPath)).toContain('settings.yaml');
  });

  it('writes the final file without leaving sibling temp files', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentforge-atomic-server-'));
    try {
      const dir = join(root, '.agentforge', 'config');
      mkdirSync(dir, { recursive: true });
      const target = join(dir, 'settings.yaml');

      writeFileAtomicSync(target, 'workspace:\n  name: AgentForge\n');

      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe('workspace:\n  name: AgentForge\n');
      const siblings = readdirSync(dir);
      expect(siblings.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
